const SAMPLE_RATE = 24000;
const WS_URL = "wss://agents.assemblyai.com/v1/ws";

const els = {
  talk: document.getElementById("talk"),
  status: document.getElementById("status"),
  transcript: document.getElementById("transcript"),
  calls: document.getElementById("calls"),
  agentId: document.getElementById("agent-id"),
};

let ws = null;
let audioCtx = null;
let micStream = null;
let workletNode = null;
let live = false;

// Playback scheduling. Keeping references lets barge-in cut the agent off.
let playHead = 0;
let scheduled = [];

// Cursor into the booking API's event log.
let eventCursor = 0;
let pollTimer = null;

// ---------------------------------------------------------------- helpers

function setStatus(text, state) {
  els.status.textContent = text;
  els.status.dataset.state = state;
}

function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function fromBase64(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Int16Array(bytes.buffer);
}

function addLine(who, text) {
  const empty = els.transcript.querySelector(".empty");
  if (empty) empty.remove();

  const row = document.createElement("div");
  row.className = `line ${who}`;
  const label = document.createElement("span");
  label.className = "who";
  label.textContent = who === "agent" ? "Agent" : "You";
  const body = document.createElement("p");
  body.textContent = text;
  row.append(label, body);
  els.transcript.append(row);
  els.transcript.scrollTop = els.transcript.scrollHeight;
}

// ---------------------------------------------------------------- playback

function playChunk(int16) {
  const buffer = audioCtx.createBuffer(1, int16.length, SAMPLE_RATE);
  const channel = buffer.getChannelData(0);
  for (let i = 0; i < int16.length; i++) channel[i] = int16[i] / 32768;

  const source = audioCtx.createBufferSource();
  source.buffer = buffer;
  source.connect(audioCtx.destination);

  const now = audioCtx.currentTime;
  if (playHead < now) playHead = now + 0.04;
  source.start(playHead);
  playHead += buffer.duration;

  scheduled.push(source);
  source.onended = () => {
    const i = scheduled.indexOf(source);
    if (i >= 0) scheduled.splice(i, 1);
  };
}

function stopPlayback() {
  for (const source of scheduled) {
    try {
      source.stop();
    } catch (_) {
      /* already finished */
    }
  }
  scheduled = [];
  playHead = 0;
}

// ------------------------------------------------- server-side tool calls

function renderCall(event) {
  const empty = els.calls.querySelector(".empty");
  if (empty) empty.remove();

  const ok = event.result && event.result.ok !== false;
  const card = document.createElement("article");
  card.className = `call ${ok ? "ok" : "warn"}`;

  const head = document.createElement("header");
  const name = document.createElement("span");
  name.className = "call-name";
  name.textContent = event.tool;
  const time = document.createElement("span");
  time.className = "call-time";
  time.textContent = event.at;
  head.append(name, time);

  const args = document.createElement("pre");
  args.textContent = JSON.stringify(event.arguments, null, 1).replace(/\n\s*/g, " ");

  const msg = document.createElement("p");
  msg.className = "call-msg";
  msg.textContent = (event.result && event.result.message) || "(no message)";

  card.append(head, args, msg);
  els.calls.append(card);
  els.calls.scrollTop = els.calls.scrollHeight;
}

async function pollEvents() {
  try {
    const res = await fetch(`/api/events?since=${eventCursor}`);
    const data = await res.json();
    eventCursor = data.cursor;
    data.events.forEach(renderCall);
  } catch (_) {
    /* transient; next tick retries */
  }
}

// ---------------------------------------------------------------- session

async function start() {
  setStatus("Connecting", "busy");
  els.talk.disabled = true;

  let token;
  try {
    const res = await fetch("/api/token");
    if (!res.ok) throw new Error(await res.text());
    token = (await res.json()).token;
  } catch (err) {
    setStatus("Could not get a token", "error");
    addLine("agent", `Token request failed: ${err.message}`);
    els.talk.disabled = false;
    return;
  }

  const config = await fetch("/api/config").then((r) => r.json());
  if (!config.agent_id) {
    setStatus("No agent published", "error");
    addLine("agent", "Run scripts/create_agent.py first, then reload.");
    els.talk.disabled = false;
    return;
  }
  els.agentId.textContent = config.agent_id;

  micStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: false,
      autoGainControl: true,
      sampleRate: SAMPLE_RATE,
    },
  });

  audioCtx = new AudioContext({ sampleRate: SAMPLE_RATE });
  await audioCtx.audioWorklet.addModule("/worklet.js");

  ws = new WebSocket(`${WS_URL}?token=${encodeURIComponent(token)}`);

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: "session.update", session: { agent_id: config.agent_id } }));
  };

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);

    switch (msg.type) {
      case "session.ready":
        live = true;
        setStatus("Listening", "live");
        els.talk.disabled = false;
        els.talk.textContent = "End call";
        pollTimer = setInterval(pollEvents, 900);
        break;

      case "input.speech.started":
        // The caller cut in. Drop whatever the agent still had queued.
        stopPlayback();
        break;

      case "transcript.user":
        addLine("user", msg.text);
        break;

      case "transcript.agent":
        addLine("agent", msg.text);
        break;

      case "reply.audio":
        playChunk(fromBase64(msg.data));
        break;

      case "reply.done":
        if (msg.status === "interrupted") stopPlayback();
        break;

      case "session.error":
        setStatus(msg.code || "Error", "error");
        addLine("agent", msg.message || "Session error");
        break;

      case "session.ended":
        cleanup();
        break;
    }
  };

  ws.onerror = () => setStatus("Connection error", "error");
  ws.onclose = () => cleanup();

  workletNode = new AudioWorkletNode(audioCtx, "pcm-processor");
  workletNode.port.onmessage = ({ data }) => {
    if (ws && ws.readyState === WebSocket.OPEN && live) {
      ws.send(JSON.stringify({ type: "input.audio", audio: toBase64(data) }));
    }
  };
  audioCtx.createMediaStreamSource(micStream).connect(workletNode);
  workletNode.connect(audioCtx.destination); // keeps the graph pulling
}

function stop() {
  // Closing the socket bare leaves a 30s resume window that still bills.
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "session.end" }));
    setStatus("Ending", "busy");
    setTimeout(() => ws && ws.close(), 1200);
  } else {
    cleanup();
  }
}

function cleanup() {
  if (!live && !micStream) return;
  live = false;

  clearInterval(pollTimer);
  pollTimer = null;
  stopPlayback();

  if (micStream) micStream.getTracks().forEach((t) => t.stop());
  micStream = null;

  if (workletNode) workletNode.disconnect();
  workletNode = null;

  if (audioCtx) audioCtx.close();
  audioCtx = null;

  ws = null;
  els.talk.disabled = false;
  els.talk.textContent = "Start call";
  setStatus("Idle", "idle");
  pollEvents();
}

els.talk.addEventListener("click", () => (live ? stop() : start()));

fetch("/api/config")
  .then((r) => r.json())
  .then((c) => {
    els.agentId.textContent = c.agent_id || "not published yet";
  })
  .catch(() => {});
