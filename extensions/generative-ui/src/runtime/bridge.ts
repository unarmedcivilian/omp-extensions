import type { HostToPage, PageToHost } from "../protocol.js";
import { isHostToPage } from "../protocol.js";

const SOCKET_OPEN = 1;
const RPC_DEFAULT_TIMEOUT_MS = 30_000;

export interface RuntimeSocketLike {
  readyState: number;
  send(data: string): void;
  addEventListener(type: string, fn: (event: unknown) => void): void;
}

export interface BridgeInstallOptions {
  socket?: RuntimeSocketLike;
  globals?: Record<string, unknown>;
  location?: URL;
}

type Handler<T extends HostToPage["type"]> = (msg: Extract<HostToPage, { type: T }>) => void;
type AnyHandler = (msg: HostToPage) => void;

interface PendingRpc {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export interface BridgeApi {
  deliver(raw: unknown): void;
  on<T extends HostToPage["type"]>(type: T, fn: Handler<T>): () => void;
  rpc<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T>;
  sendPrompt(text: string): Promise<unknown>;
}

let activeBridge: BridgeApi | undefined;

export function computeWebSocketUrl(url: URL): string {
  const token = url.pathname.split("/").filter(Boolean).at(-1);
  if (!token) throw new Error("widget URL does not include a session token");
  const ws = new URL(url);
  ws.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  ws.pathname = `/ws/${token}`;
  ws.search = "";
  ws.hash = "";
  return ws.toString();
}

export function installBridge(options: BridgeInstallOptions = {}): BridgeApi {
  const globals = options.globals ?? globalThis as unknown as Record<string, unknown>;
  const socket = options.socket ?? createBrowserSocket(options.location);
  const bridge = createBridge(socket);
  const publicApi = { deliver: bridge.deliver, rpc: bridge.rpc };
  globals.__ompGenerativeUI = publicApi;
  globals.__glimpseUI = publicApi;
  globals.sendPrompt = bridge.sendPrompt;
  activeBridge = bridge;
  return bridge;
}

export function on<T extends HostToPage["type"]>(type: T, fn: Handler<T>): () => void {
  if (!activeBridge) throw new Error("runtime bridge is not installed");
  return activeBridge.on(type, fn);
}

export function rpc<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
  if (!activeBridge) throw new Error("runtime bridge is not installed");
  return activeBridge.rpc<T>(method, params, timeoutMs);
}

function createBridge(socket: RuntimeSocketLike): BridgeApi {
  const handlers = new Map<string, Set<AnyHandler>>();
  const pending = new Map<string, PendingRpc>();
  const queued: PageToHost[] = [];
  let nextId = 0;

  function send(msg: PageToHost): void {
    if (socket.readyState === SOCKET_OPEN) {
      socket.send(JSON.stringify(msg));
      return;
    }
    queued.push(msg);
  }

  function flushQueued(): void {
    while (queued.length > 0 && socket.readyState === SOCKET_OPEN) {
      const msg = queued.shift();
      if (msg) socket.send(JSON.stringify(msg));
    }
  }

  function deliver(raw: unknown): void {
    if (!isHostToPage(raw)) return;
    if (raw.type === "rpc-result") {
      const entry = pending.get(raw.id);
      if (entry) {
        pending.delete(raw.id);
        clearTimeout(entry.timer);
        if (raw.ok) entry.resolve(raw.value);
        else entry.reject(new Error(raw.error));
      }
    }
    const bucket = handlers.get(raw.type);
    if (!bucket) return;
    for (const fn of bucket) {
      try { fn(raw); } catch (error) { console.error("[omp-generative-ui] handler threw:", error); }
    }
  }

  function onHandler<T extends HostToPage["type"]>(type: T, fn: Handler<T>): () => void {
    let bucket = handlers.get(type);
    if (!bucket) {
      bucket = new Set<AnyHandler>();
      handlers.set(type, bucket);
    }
    const wrapped = fn as unknown as AnyHandler;
    bucket.add(wrapped);
    return () => { bucket?.delete(wrapped); };
  }

  function callRpc<T = unknown>(method: string, params: unknown = null, timeoutMs = RPC_DEFAULT_TIMEOUT_MS): Promise<T> {
    const id = `r${++nextId}`;
    const { promise, resolve, reject } = Promise.withResolvers<T>();
    const timer = setTimeout(() => {
      if (!pending.has(id)) return;
      pending.delete(id);
      reject(new Error(`RPC ${method} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
    send({ type: "rpc-call", id, method, params });
    return promise;
  }

  socket.addEventListener("open", () => {
    socket.send(JSON.stringify({ type: "ready" satisfies PageToHost["type"] }));
    flushQueued();
  });
  socket.addEventListener("message", event => {
    const data = (event as { data?: unknown }).data;
    if (typeof data !== "string") return;
    try { deliver(JSON.parse(data)); } catch (error) { console.error("[omp-generative-ui] invalid host message:", error); }
  });

  return {
    deliver,
    on: onHandler,
    rpc: callRpc,
    sendPrompt(text: string): Promise<unknown> { return callRpc("agent.prompt", { text }); },
  };
}

function createBrowserSocket(locationOverride?: URL): RuntimeSocketLike {
  const location = locationOverride ?? new URL(globalThis.location.href);
  return new WebSocket(computeWebSocketUrl(location));
}
