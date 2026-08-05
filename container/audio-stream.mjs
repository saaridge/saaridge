#!/usr/bin/env node
/**
 * Stream container PulseAudio monitor → WebSocket (PCM s16le stereo 48kHz).
 * Host viewer plays it with Web Audio. Listens on 0.0.0.0:6082.
 */
import http from "node:http";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

const PORT = Number(process.env.AUDIO_WS_PORT || 6082);
const RATE = 48000;
const CHANNELS = 2;
const clients = new Set();

let capture = null;
let restartTimer = null;

const wsAccept = (key) =>
  createHash("sha1")
    .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
    .digest("base64");

const frame = (payload) => {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x82; // binary, fin
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x82;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x82;
    header[1] = 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(len, 6);
  }
  return Buffer.concat([header, payload]);
};

const broadcast = (chunk) => {
  if (!clients.size) return;
  const msg = frame(chunk);
  for (const socket of clients) {
    try {
      socket.write(msg);
    } catch {
      clients.delete(socket);
    }
  }
};

const stopCapture = () => {
  if (capture) {
    try {
      capture.kill("SIGTERM");
    } catch (_) {}
    capture = null;
  }
};

const startCapture = () => {
  stopCapture();
  // Prefer Pulse monitor; fall back to default source
  const device =
    process.env.PULSE_MONITOR || "saaridge.monitor";
  const args = [
    "-f",
    "pulse",
    "-i",
    device,
    "-ac",
    String(CHANNELS),
    "-ar",
    String(RATE),
    "-f",
    "s16le",
    "-acodec",
    "pcm_s16le",
    "pipe:1",
  ];
  capture = spawn("ffmpeg", args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
  capture.stdout.on("data", broadcast);
  let errBuf = "";
  capture.stderr.on("data", (chunk) => {
    errBuf += chunk.toString();
    if (errBuf.length > 4000) errBuf = errBuf.slice(-2000);
  });
  capture.on("exit", (code) => {
    capture = null;
    if (clients.size && !restartTimer) {
      restartTimer = setTimeout(() => {
        restartTimer = null;
        startCapture();
      }, 800);
    }
    if (code && code !== 0) {
      console.error(`[audio-stream] ffmpeg exited ${code}`);
      if (errBuf.trim()) {
        console.error(`[audio-stream] ffmpeg stderr:\n${errBuf.trim().slice(-1500)}`);
      }
    }
  });
  console.error(`[audio-stream] capturing ${device} → ws clients=${clients.size}`);
};

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        ok: true,
        clients: clients.size,
        rate: RATE,
        channels: CHANNELS,
        format: "s16le",
      }),
    );
    return;
  }
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Saaridge audio WebSocket — connect via ws://host:6082/\n");
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
  // Send a tiny JSON hello as text frame so the client can configure AudioContext
  const hello = Buffer.from(
    JSON.stringify({ type: "hello", rate: RATE, channels: CHANNELS, format: "s16le" }),
  );
  const tHeader = Buffer.alloc(2);
  tHeader[0] = 0x81;
  tHeader[1] = hello.length;
  socket.write(Buffer.concat([tHeader, hello]));

  clients.add(socket);
  if (!capture) startCapture();

  socket.on("close", () => {
    clients.delete(socket);
    if (!clients.size) stopCapture();
  });
  socket.on("error", () => {
    clients.delete(socket);
  });
  // Ignore inbound frames (client→server); drain to avoid backpressure
  socket.on("data", () => {});
});

server.listen(PORT, "0.0.0.0", () => {
  console.error(`[audio-stream] listening 0.0.0.0:${PORT}`);
});

process.on("SIGTERM", () => {
  stopCapture();
  server.close();
  process.exit(0);
});
