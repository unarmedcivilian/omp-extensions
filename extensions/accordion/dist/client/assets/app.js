const state = {
  ws: null,
  meta: null,
  blocks: new Map(),
  foldedById: new Map(),
  entriesByCode: new Map(),
  connected: false,
};

const els = {
  status: document.querySelector("#status"),
  sessionId: document.querySelector("#session-id"),
  model: document.querySelector("#model"),
  contextWindow: document.querySelector("#context-window"),
  blockCount: document.querySelector("#block-count"),
  blocks: document.querySelector("#blocks"),
  reconnect: document.querySelector("#reconnect"),
};

function setStatus(text) {
  els.status.textContent = text;
}

function codeFor(block) {
  let hash = 2166136261;
  const input = `${block.id}\n${block.text}`;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0").slice(0, 6);
}

function labelFor(block) {
  const tool = block.toolName ? ` ${block.toolName}` : "";
  return `${block.kind}${tool} · turn ${block.turn}`;
}

function summaryFor(block, code) {
  const first = block.text.replace(/\s+/g, " ").trim().slice(0, 160) || labelFor(block);
  return `{#${code} FOLDED} ${labelFor(block)} — ${first}`;
}

function ensureEntry(block) {
  const existingCode = state.foldedById.get(block.id);
  if (existingCode && state.entriesByCode.has(existingCode)) return state.entriesByCode.get(existingCode);
  const code = codeFor(block);
  const entry = {
    code,
    ids: [block.id],
    kind: block.kind,
    label: labelFor(block),
    title: labelFor(block),
    text: block.text,
    digestText: summaryFor(block, code),
  };
  state.entriesByCode.set(code, entry);
  return entry;
}

function isFoldedText(text) {
  return /\{#[A-Za-z0-9_-]+ FOLDED\}/.test(text);
}

function queueFold(block) {
  const entry = ensureEntry(block);
  state.foldedById.set(block.id, entry.code);
  setStatus(`Queued fold for #${entry.code}. It will apply on the next OMP context sync.`);
  render();
}

function queueOpen(block) {
  const code = state.foldedById.get(block.id);
  if (code) state.foldedById.delete(block.id);
  setStatus(code ? `Queued restore for #${code}.` : "Block is already open.");
  render();
}

function planFor(blocks) {
  const ops = [];
  for (const block of blocks) {
    const code = state.foldedById.get(block.id);
    if (!code) continue;
    const entry = state.entriesByCode.get(code);
    if (!entry || isFoldedText(block.text)) continue;
    entry.text = block.text;
    entry.digestText = summaryFor(block, code);
    ops.push({ id: block.id, digestText: entry.digestText });
  }
  return { ops, groups: [] };
}

function send(message) {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return false;
  state.ws.send(JSON.stringify(message));
  return true;
}

function onHello(message) {
  state.meta = message.meta || {};
  els.sessionId.textContent = message.sessionId || "—";
  els.model.textContent = state.meta.model || "—";
  els.contextWindow.textContent = state.meta.contextWindow == null ? "—" : String(state.meta.contextWindow);
  setStatus("Connected to OMP session.");
}

function onSync(message) {
  const incoming = Array.isArray(message.blocks) ? message.blocks : [];
  if (message.full) state.blocks.clear();
  for (const block of incoming) {
    state.blocks.set(block.id, block);
    const folded = state.foldedById.get(block.id);
    if (folded && state.entriesByCode.has(folded) && !isFoldedText(block.text)) {
      const entry = state.entriesByCode.get(folded);
      entry.text = block.text;
      entry.digestText = summaryFor(block, folded);
    }
  }
  if (message.contextWindow !== undefined) els.contextWindow.textContent = message.contextWindow == null ? "—" : String(message.contextWindow);
  const plan = planFor(incoming);
  send({ type: "plan", reqId: message.reqId, ops: plan.ops, groups: plan.groups });
  render();
}

function onUnfoldRequest(message) {
  const restored = [];
  const missing = [];
  for (const code of message.codes || []) {
    const entry = state.entriesByCode.get(String(code));
    if (!entry) {
      missing.push(String(code));
      continue;
    }
    for (const id of entry.ids) state.foldedById.delete(id);
    restored.push({ code: entry.code, kind: entry.kind, label: entry.label, title: entry.title, ids: entry.ids });
  }
  send({ type: "unfoldResult", reqId: message.reqId, restored, missing });
  setStatus(restored.length ? `Unfolded ${restored.map(item => `#${item.code}`).join(", ")}.` : "No matching folded blocks to unfold.");
  render();
}

function onRecallRequest(message) {
  const restored = [];
  const missing = [];
  for (const code of message.codes || []) {
    const entry = state.entriesByCode.get(String(code));
    if (!entry) {
      missing.push(String(code));
      continue;
    }
    restored.push({ code: entry.code, label: entry.label, title: entry.title, text: entry.text, ids: entry.ids });
  }
  send({ type: "recallResult", reqId: message.reqId, restored, missing });
  setStatus(restored.length ? `Recalled ${restored.map(item => `#${item.code}`).join(", ")}.` : "No matching folded blocks to recall.");
}

function onMessage(raw) {
  let message;
  try {
    message = JSON.parse(raw.data);
  } catch {
    return;
  }
  if (message.type === "hello") onHello(message);
  else if (message.type === "sync") onSync(message);
  else if (message.type === "unfoldRequest") onUnfoldRequest(message);
  else if (message.type === "recallRequest") onRecallRequest(message);
}

function connect() {
  if (state.ws) state.ws.close();
  const url = new URL(window.location.href);
  url.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  state.ws = new WebSocket(url);
  setStatus("Connecting to OMP session…");
  state.ws.addEventListener("open", () => {
    state.connected = true;
    setStatus("Connected. Waiting for session metadata…");
  });
  state.ws.addEventListener("message", onMessage);
  state.ws.addEventListener("close", () => {
    state.connected = false;
    setStatus("Disconnected. Reopen /accordion or press Reconnect.");
    render();
  });
  state.ws.addEventListener("error", () => {
    state.connected = false;
    setStatus("Connection error. Confirm this page was opened from /accordion.");
    render();
  });
}

function escapeText(text) {
  return text.replace(/[&<>"]/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" })[ch]);
}

function render() {
  const blocks = [...state.blocks.values()].sort((a, b) => a.order - b.order);
  els.blockCount.textContent = String(blocks.length);
  if (!blocks.length) {
    els.blocks.innerHTML = '<div class="empty">No context blocks yet.</div>';
    return;
  }
  els.blocks.replaceChildren(...blocks.map(block => {
    const foldedCode = state.foldedById.get(block.id);
    const article = document.createElement("article");
    article.className = "block";
    const header = document.createElement("header");
    const meta = document.createElement("div");
    meta.className = "block-meta";
    meta.innerHTML = `<span class="pill">${escapeText(block.kind)}</span><span class="pill">${block.tokens} tokens</span>${foldedCode ? `<span class="pill folded">#${escapeText(foldedCode)} queued</span>` : ""}`;
    const actions = document.createElement("div");
    const fold = document.createElement("button");
    fold.type = "button";
    fold.textContent = foldedCode ? "Queued" : "Fold";
    fold.disabled = !!foldedCode;
    fold.addEventListener("click", () => queueFold(block));
    const open = document.createElement("button");
    open.type = "button";
    open.className = "secondary";
    open.textContent = "Open";
    open.addEventListener("click", () => queueOpen(block));
    actions.append(fold, " ", open);
    header.append(meta, actions);
    const pre = document.createElement("pre");
    pre.textContent = block.text;
    article.append(header, pre);
    return article;
  }));
}

els.reconnect.addEventListener("click", connect);
connect();
