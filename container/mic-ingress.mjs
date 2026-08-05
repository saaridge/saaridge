#!/usr/bin/env node
/**
 * Host mic uplink → Pulse null-sink (virtual mic = sink.monitor).
 * PCM is written only to saaridge-mic-sink — never the speaker sink (saaridge).
 */
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const PORT = Number(process.env.MIC_WS_PORT || 6083);
const RATE = 48000;
const CHANNELS = 1;
const SINK = process.env.MIC_PULSE_SINK || "saaridge-mic-sink";
const BYTES_PER_MS = (RATE * CHANNELS * 2) / 1000;
const SILENCE_MS = 20;
const SILENCE_CHUNK = Buffer.alloc(Math.floor(BYTES_PER_MS * SILENCE_MS));

const wsAccept = (key) =>
  createHash("sha1")
    .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
    .digest("base64");

let hostSocket = null;
let silenceTimer = null;
let readBuf = Buffer.alloc(0);
let feeder = null;

const micSinkReady = () => {
  try {
    const r = spawnSync("pactl", ["list", "short", "sinks"], {
      encoding: "utf8",
      env: process.env,
    });
    if (r.status !== 0) return false;
    return new RegExp(`(^|\\s)${SINK}(\\s|$)`).test(r.stdout || "");
  } catch {
    return false;
  }
};

const stopFeeder = () => {
  if (!feeder) return;
  try {
    feeder.stdin?.end();
  } catch (_) {}
  try {
    feeder.kill("SIGTERM");
  } catch (_) {}
  feeder = null;
};

const startFeeder = () => {
  if (feeder && !feeder.killed) return;
  if (!micSinkReady()) {
    console.error(`[mic-ingress] waiting for Pulse sink ${SINK}`);
    return;
  }
  stopFeeder();
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "s16le",
    "-ar",
    String(RATE),
    "-ac",
    String(CHANNELS),
    "-i",
    "pipe:0",
    "-f",
    "pulse",
    SINK,
  ];
  feeder = spawn("ffmpeg", args, {
    stdio: ["pipe", "ignore", "pipe"],
    env: process.env,
  });
  let err = "";
  feeder.stderr.on("data", (c) => {
    err += c.toString();
    if (err.length > 2000) err = err.slice(-1000);
  });
  feeder.on("exit", (code) => {
    feeder = null;
    if (code && code !== 0) {
      console.error(`[mic-ingress] ffmpeg exited ${code}: ${err.trim().slice(-400)}`);
    }
    setTimeout(() => {
      startFeeder();
      startSilence();
    }, 500);
  });
  console.error(`[mic-ingress] ffmpeg → pulse sink ${SINK} (input-only virtual mic)`);
};

const writePcm = (chunk) => {
  if (!chunk?.length) return;
  if (!feeder?.stdin?.writable) startFeeder();
  try {
    feeder?.stdin?.write(chunk);
  } catch (_) {}
};

const startSilence = () => {
  if (silenceTimer) return;
  silenceTimer = setInterval(() => {
    if (hostSocket) return;
    writePcm(SILENCE_CHUNK);
  }, SILENCE_MS);
};

const stopSilence = () => {
  if (!silenceTimer) return;
  clearInterval(silenceTimer);
  silenceTimer = null;
};

const parseFrames = (onBinary) => {
  while (readBuf.length >= 2) {
    const b0 = readBuf[0];
    const b1 = readBuf[1];
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let offset = 2;
    if (len === 126) {
      if (readBuf.length < 4) return;
      len = readBuf.readUInt16BE(2);
      offset = 4;
    } else if (len === 127) {
      if (readBuf.length < 10) return;
      len = Number(readBuf.readBigUInt64BE(2));
      offset = 10;
    }
    const maskLen = masked ? 4 : 0;
    if (readBuf.length < offset + maskLen + len) return;
    let payload = readBuf.subarray(offset + maskLen, offset + maskLen + len);
    if (masked) {
      const mask = readBuf.subarray(offset, offset + 4);
      const out = Buffer.alloc(payload.length);
      for (let i = 0; i < payload.length; i++) out[i] = payload[i] ^ mask[i % 4];
      payload = out;
    }
    readBuf = readBuf.subarray(offset + maskLen + len);
    if (opcode === 0x8) return "close";
    if (opcode === 0x9) {
      const pong = Buffer.alloc(2 + payload.length);
      pong[0] = 0x8a;
      pong[1] = payload.length & 0x7f;
      payload.copy(pong, 2);
      return { pong };
    }
    if (opcode === 0x1) continue;
    if (opcode === 0x2 || opcode === 0x0) onBinary(payload);
  }
  return null;
};

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        ok: true,
        rate: RATE,
        channels: CHANNELS,
        format: "s16le",
        sink: SINK,
        sinkReady: micSinkReady(),
        hostConnected: Boolean(hostSocket),
        feeder: Boolean(feeder),
      }),
    );
    return;
  }
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Saaridge mic ingress — connect via ws://host:6083/\n");
});

server.on("upgrade", (req, socket) => {
  const key = req.headers["sec-websocket-key"];
  if (!key) {
    socket.destroy();
    return;
  }
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${wsAccept(key)}\r\n` +
      "\r\n",
  );
  const hello = Buffer.from(
    JSON.stringify({
      type: "hello",
      rate: RATE,
      channels: CHANNELS,
      format: "s16le",
    }),
  );
  const tHeader = Buffer.alloc(2);
  tHeader[0] = 0x81;
  tHeader[1] = hello.length;
  socket.write(Buffer.concat([tHeader, hello]));

  if (hostSocket && hostSocket !== socket) {
    try {
      hostSocket.destroy();
    } catch (_) {}
  }
  hostSocket = socket;
  stopSilence();
  startFeeder();
  readBuf = Buffer.alloc(0);
  console.error(`[mic-ingress] host connected`);

  socket.on("data", (chunk) => {
    readBuf = Buffer.concat([readBuf, chunk]);
    for (;;) {
      const result = parseFrames((pcm) => writePcm(pcm));
      if (result === "close") {
        try {
          socket.end();
        } catch (_) {}
        return;
      }
      if (result?.pong) {
        try {
          socket.write(result.pong);
        } catch (_) {}
        continue;
      }
      break;
    }
  });
  const onGone = () => {
    if (hostSocket === socket) hostSocket = null;
    startSilence();
    console.error(`[mic-ingress] host disconnected`);
  };
  socket.on("close", onGone);
  socket.on("error", onGone);
  socket.on("end", onGone);
});

// Poll until mic sink exists (start-mic creates it before ingress listens).
const waitSink = setInterval(() => {
  if (micSinkReady()) {
    clearInterval(waitSink);
    startFeeder();
    startSilence();
  }
}, 200);

server.listen(PORT, "0.0.0.0", () => {
  console.error(`[mic-ingress] listening 0.0.0.0:${PORT} → pulse:${SINK}`);
});

process.on("SIGTERM", () => {
  clearInterval(waitSink);
  stopSilence();
  stopFeeder();
  server.close();
  process.exit(0);
});
