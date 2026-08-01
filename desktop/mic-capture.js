(() => {
  const RATE = 48000;
  const WS_URL = "ws://127.0.0.1:6083/";

  let mediaStream = null;
  let audioCtx = null;
  let processor = null;
  let sourceNode = null;
  let ws = null;
  let running = false;
  let reconnectTimer = 0;

  const post = (payload) => {
    try {
      window.onebridge?.micStatus?.(payload);
    } catch (_) {}
  };

  const floatTo16Mono = (input) => {
    const out = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) {
      const s = Math.max(-1, Math.min(1, input[i]));
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return out;
  };

  const downsampleTo48k = (input, inRate) => {
    if (inRate === RATE) return input;
    const ratio = inRate / RATE;
    const outLen = Math.floor(input.length / ratio);
    const out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      out[i] = input[Math.floor(i * ratio)] || 0;
    }
    return out;
  };

  const connectWs = () => {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    try {
      ws = new WebSocket(WS_URL);
    } catch (err) {
      post({ state: "error", message: String(err?.message || err) });
      scheduleReconnect();
      return;
    }
    ws.binaryType = "arraybuffer";
    ws.onopen = () => {
      post({ state: "sharing", message: "Sharing microphone with workspace" });
    };
    ws.onclose = () => {
      ws = null;
      if (running) {
        post({ state: "waiting", message: "Reconnecting to workspace mic…" });
        scheduleReconnect();
      }
    };
    ws.onerror = () => {};
  };

  const scheduleReconnect = () => {
    clearTimeout(reconnectTimer);
    if (!running) return;
    reconnectTimer = setTimeout(connectWs, 1200);
  };

  const stopCapture = () => {
    running = false;
    clearTimeout(reconnectTimer);
    try {
      processor?.disconnect();
    } catch (_) {}
    try {
      sourceNode?.disconnect();
    } catch (_) {}
    processor = null;
    sourceNode = null;
    if (audioCtx) {
      try {
        audioCtx.close();
      } catch (_) {}
      audioCtx = null;
    }
    if (mediaStream) {
      for (const t of mediaStream.getTracks()) {
        try {
          t.stop();
        } catch (_) {}
      }
      mediaStream = null;
    }
    if (ws) {
      try {
        ws.close();
      } catch (_) {}
      ws = null;
    }
  };

  const startCapture = async () => {
    stopCapture();
    running = true;
    post({ state: "waiting", message: "Waiting for microphone permission…" });
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          channelCount: 1,
        },
        video: false,
      });
    } catch (err) {
      running = false;
      post({
        state: "denied",
        message: String(err?.message || "Microphone permission denied"),
      });
      return;
    }

    audioCtx = new AudioContext();
    const inRate = audioCtx.sampleRate;
    sourceNode = audioCtx.createMediaStreamSource(mediaStream);
    // ScriptProcessor is deprecated but widely available in Electron without worklet path setup.
    const bufferSize = 4096;
    processor = audioCtx.createScriptProcessor(bufferSize, 1, 1);
    processor.onaudioprocess = (ev) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      const input = ev.inputBuffer.getChannelData(0);
      const at48 = downsampleTo48k(input, inRate);
      const pcm = floatTo16Mono(at48);
      try {
        ws.send(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength));
      } catch (_) {}
    };
    const gain = audioCtx.createGain();
    gain.gain.value = 0;
    sourceNode.connect(processor);
    processor.connect(gain);
    gain.connect(audioCtx.destination);

    connectWs();
    post({ state: "sharing", message: "Sharing microphone with workspace" });
  };

  window.onebridge?.onMicCommand?.((cmd) => {
    if (cmd === "start") void startCapture();
    else if (cmd === "stop") {
      stopCapture();
      post({ state: "off", message: "Microphone sharing is off" });
    }
  });

  // Auto-start if main opened us because sharing is enabled.
  void startCapture();
})();
