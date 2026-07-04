import { randomBytes } from "node:crypto";
import { runCompletionRequest, type CompletionRelayDeps } from "./completion.js";
import { applyPlan, linearize, type PiMessage, type PlanOp } from "./live/mapping.js";
import { PROTOCOL_VERSION, type CompleteRequestMessage, type GroupOp, type RecallContent, type ServerMessage, type UnfoldRequestMessage, type UnfoldRestored, type WireBlock } from "./live/protocol.js";
import { createStaticHandler } from "./static.js";

export interface AccordionSessionOptions {
  clientRoot: string;
  ctx?: unknown;
  requestTimeoutMs?: number;
  unfoldTimeoutMs?: number;
  recallTimeoutMs?: number;
  completion?: CompletionRelayDeps;
}

export interface ContextEventLike {
  messages: unknown[];
}

export interface ContextResult {
  messages?: unknown[];
}

interface Plan {
  ops: PlanOp[];
  groups: GroupOp[];
}

interface ContextLike {
  cwd?: string;
  model?: unknown;
  modelRegistry?: { getApiKey?: (model: unknown) => string | null | Promise<string | null> };
  sessionManager?: {
    getSessionId?: () => string;
    getMessages?: () => unknown[] | Promise<unknown[]>;
    buildSessionContext?: () => { messages?: unknown };
    getBranch?: () => Array<{ type: string; message?: unknown }>;
  };
  getContextUsage?: () => unknown;
}

interface SocketData {
  authorized: boolean;
}

interface BrowserSocket {
  data: SocketData;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

interface BrowserServer {
  port: number;
  upgrade(req: Request, options: { data: SocketData }): boolean;
  stop(force?: boolean): void;
}

function isObject(value: unknown): value is object {
  return !!value && typeof value === "object";
}

function toRecord(value: object): Record<PropertyKey, unknown> {
  return value as Record<PropertyKey, unknown>;
}

function readString(value: unknown, key: string): string | undefined {
  if (!isObject(value)) return undefined;
  const record = toRecord(value);
  const found = record[key];
  return typeof found === "string" ? found : undefined;
}

function readNumber(value: unknown, key: string): number | undefined {
  if (!isObject(value)) return undefined;
  const record = toRecord(value);
  const found = record[key];
  return typeof found === "number" ? found : undefined;
}

function contextFromUnknown(value: unknown): ContextLike | null {
  return isObject(value) ? value as ContextLike : null;
}

function sessionIdFromCtx(ctx: unknown): string | undefined {
  const context = contextFromUnknown(ctx);
  try {
    return context?.sessionManager?.getSessionId?.();
  } catch {
    return undefined;
  }
}

function cwdFromCtx(ctx: unknown): string {
  const context = contextFromUnknown(ctx);
  if (typeof context?.cwd === "string") return context.cwd;
  try {
    return process.cwd();
  } catch {
    return "";
  }
}

function modelName(model: unknown): string {
  return readString(model, "id") ?? "";
}

function usageWindow(usage: unknown): number | null {
  return readNumber(usage, "contextWindow") ?? readNumber(usage, "maxTokens") ?? null;
}

function usageTokens(usage: unknown): number | null {
  return readNumber(usage, "tokens") ?? readNumber(usage, "usedTokens") ?? null;
}

function parseCookie(cookie: string | null, name: string): string | null {
  if (!cookie) return null;
  for (const part of cookie.split(";")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    if (trimmed.slice(0, eq) === name) return trimmed.slice(eq + 1);
  }
  return null;
}

function requestToken(req: Request): string | null {
  try {
    const url = new URL(req.url);
    return url.searchParams.get("token") ?? parseCookie(req.headers.get("cookie"), "accordion_token");
  } catch {
    return parseCookie(req.headers.get("cookie"), "accordion_token");
  }
}

function parseJsonMessage(data: string | Buffer | ArrayBuffer | Uint8Array): Record<PropertyKey, unknown> | null {
  try {
    const text = typeof data === "string" ? data : Buffer.from(data).toString("utf8");
    const parsed: unknown = JSON.parse(text);
    return isObject(parsed) ? toRecord(parsed) : null;
  } catch {
    return null;
  }
}

function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(item => String(item)).filter(item => item.length > 0) : [];
}

function normalizePlan(record: Record<PropertyKey, unknown>): Plan {
  return {
    ops: Array.isArray(record.ops) ? record.ops as PlanOp[] : [],
    groups: Array.isArray(record.groups) ? record.groups as GroupOp[] : [],
  };
}

function normalizeUnfold(record: Record<PropertyKey, unknown>): { restored: UnfoldRestored[]; missing: string[] } {
  return {
    restored: Array.isArray(record.restored) ? record.restored as UnfoldRestored[] : [],
    missing: normalizeStringArray(record.missing),
  };
}

function normalizeRecall(record: Record<PropertyKey, unknown>): { restored: RecallContent[]; missing: string[] } {
  return {
    restored: Array.isArray(record.restored) ? record.restored as RecallContent[] : [],
    missing: normalizeStringArray(record.missing),
  };
}

function browserServer(value: unknown): BrowserServer {
  return value as BrowserServer;
}

export class AccordionSession {
  readonly webToken = randomBytes(16).toString("hex");
  readonly requestTimeoutMs: number;
  readonly unfoldTimeoutMs: number;
  readonly recallTimeoutMs: number;

  #clientRoot: string;
  #sessionId: string;
  #server: BrowserServer;
  #client: BrowserSocket | null = null;
  #sentCount = 0;
  #reqSeq = 0;
  #unfoldSeq = 0;
  #recallSeq = 0;
  #epoch = 0;
  #latestCtx: unknown = null;
  #latestModel: unknown = null;
  #contextWindow: number | null = null;
  #tokens: number | null = null;
  #lastMessages: PiMessage[] = [];
  #pendingSince: PiMessage[] = [];
  #pendingPlans = new Map<number, (plan: Plan) => void>();
  #pendingUnfold = new Map<number, (value: { restored: UnfoldRestored[]; missing: string[] } | null) => void>();
  #pendingRecall = new Map<number, (value: { restored: RecallContent[]; missing: string[] } | null) => void>();
  #completion: CompletionRelayDeps;

  private constructor(options: AccordionSessionOptions, server: BrowserServer, sessionId: string) {
    this.#clientRoot = options.clientRoot;
    this.#server = server;
    this.#sessionId = sessionId;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 250;
    this.unfoldTimeoutMs = options.unfoldTimeoutMs ?? 2000;
    this.recallTimeoutMs = options.recallTimeoutMs ?? 2000;
    this.#completion = options.completion ?? {};
    this.#latestCtx = options.ctx ?? null;
    this.#refreshFromCtx(options.ctx);
  }

  static async create(options: AccordionSessionOptions): Promise<AccordionSession> {
    const sessionId = sessionIdFromCtx(options.ctx) ?? `s-${process.pid}-${Date.now()}`;
    let session: AccordionSession | null = null;
    const server = browserServer(Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req, bunServer) {
        const active = session;
        if (!active) return new Response("Accordion session is starting", { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } });
        if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
          const authorized = requestToken(req) === active.webToken;
          const upgraded = bunServer.upgrade(req, { data: { authorized } });
          return upgraded ? undefined : new Response("WebSocket upgrade failed", { status: 400 });
        }
        const handler = createStaticHandler({ clientRoot: active.#clientRoot, token: active.webToken, sessionId: active.#sessionId, protocolVersion: PROTOCOL_VERSION });
        return handler(req);
      },
      websocket: {
        open(ws) {
          session?.#attachClient(ws as BrowserSocket);
        },
        message(ws, message) {
          session?.#handleClientMessage(ws as BrowserSocket, message as string | Buffer | ArrayBuffer | Uint8Array);
        },
        close(ws) {
          session?.#dropClient(ws as BrowserSocket);
        },
      },
    }));
    session = new AccordionSession(options, server, sessionId);
    return session;
  }

  url(): string {
    return `http://127.0.0.1:${this.#server.port}/?token=${this.webToken}`;
  }

  get attached(): boolean {
    return this.#client !== null;
  }

  #attachClient(ws: BrowserSocket): void {
    if (!ws.data.authorized) {
      ws.close();
      return;
    }

    this.#flushPending();
    if (this.#client && this.#client !== ws) {
      try { this.#client.close(); } catch { /* detached */ }
    }
    this.#client = ws;
    this.#epoch += 1;
    this.#sentCount = 0;
    this.#reqSeq = 0;
    this.#send(ws, {
      type: "hello",
      protocolVersion: PROTOCOL_VERSION,
      sessionId: this.#sessionId,
      meta: this.#meta(),
    });

    const live = this.#readSessionMessages(this.#latestCtx);
    if (live.length) this.#lastMessages = live;
    const backlog = linearize(this.#lastMessages);
    if (backlog.length) {
      this.#send(ws, { type: "sync", reqId: ++this.#reqSeq, full: true, blocks: backlog, contextWindow: this.#contextWindow });
      this.#sentCount = backlog.length;
    }
  }

  #dropClient(ws: BrowserSocket): void {
    if (this.#client === ws) this.#client = null;
  }

  #meta(): { title: string; cwd: string; model: string; contextWindow: number | null; format: "pi" } {
    return {
      title: "OMP session",
      cwd: cwdFromCtx(this.#latestCtx),
      model: modelName(this.#latestModel),
      contextWindow: this.#contextWindow,
      format: "pi",
    };
  }

  #refreshFromCtx(ctx: unknown): void {
    const context = contextFromUnknown(ctx);
    if (!context) return;
    this.#latestCtx = ctx;
    if (context.model) this.#latestModel = context.model;
    const usage = context.getContextUsage?.();
    this.#tokens = usageTokens(usage);
    const window = usageWindow(usage) ?? readNumber(this.#latestModel, "contextWindow") ?? readNumber(this.#latestModel, "maxTokens") ?? null;
    this.#contextWindow = window;
    const id = sessionIdFromCtx(ctx);
    if (id) this.#sessionId = id;
  }

  #readSessionMessages(ctx: unknown): PiMessage[] {
    const context = contextFromUnknown(ctx);
    if (!context?.sessionManager) return [];
    try {
      const built = context.sessionManager.buildSessionContext?.();
      if (built && Array.isArray(built.messages)) return built.messages as PiMessage[];
    } catch {
      // fallback below
    }
    try {
      const branch = context.sessionManager.getBranch?.() ?? [];
      const messages = branch.filter(entry => entry.type === "message" && entry.message).map(entry => entry.message as PiMessage);
      messages.reverse();
      return messages;
    } catch {
      return [];
    }
  }

  #send(ws: BrowserSocket, message: ServerMessage): void {
    try {
      ws.send(JSON.stringify(message));
    } catch {
      this.#dropClient(ws);
    }
  }

  #sendToClient(message: ServerMessage): void {
    const ws = this.#client;
    if (!ws) return;
    this.#send(ws, message);
  }

  #handleClientMessage(ws: BrowserSocket, data: string | Buffer | ArrayBuffer | Uint8Array): void {
    if (ws !== this.#client) return;
    const record = parseJsonMessage(data);
    if (!record) return;
    const type = record.type;
    const reqId = record.reqId;

    if (type === "plan" && typeof reqId === "number") {
      const resolve = this.#pendingPlans.get(reqId);
      if (resolve) {
        this.#pendingPlans.delete(reqId);
        resolve(normalizePlan(record));
      }
      return;
    }

    if (type === "unfoldResult" && typeof reqId === "number") {
      const resolve = this.#pendingUnfold.get(reqId);
      if (resolve) {
        this.#pendingUnfold.delete(reqId);
        resolve(normalizeUnfold(record));
      }
      return;
    }

    if (type === "recallResult" && typeof reqId === "number") {
      const resolve = this.#pendingRecall.get(reqId);
      if (resolve) {
        this.#pendingRecall.delete(reqId);
        resolve(normalizeRecall(record));
      }
      return;
    }

    if (type === "completeRequest") {
      const request = record as unknown as CompleteRequestMessage;
      const captured = ws;
      void runCompletionRequest(request, contextFromUnknown(this.#latestCtx), this.#latestModel, this.#completion).then(result => {
        if (captured === this.#client) this.#send(captured, result);
      });
    }
  }

  #flushPending(): void {
    for (const resolve of this.#pendingPlans.values()) resolve({ ops: [], groups: [] });
    this.#pendingPlans.clear();
    for (const resolve of this.#pendingUnfold.values()) resolve(null);
    this.#pendingUnfold.clear();
    for (const resolve of this.#pendingRecall.values()) resolve(null);
    this.#pendingRecall.clear();
  }

  #requestPlan(reqId: number, full: boolean, blocks: WireBlock[]): Promise<Plan | null> {
    const ws = this.#client;
    if (!ws) return Promise.resolve(null);
    const gate = Promise.withResolvers<Plan | null>();
    const timer = setTimeout(() => {
      if (this.#pendingPlans.delete(reqId)) gate.resolve({ ops: [], groups: [] });
    }, this.requestTimeoutMs);
    this.#pendingPlans.set(reqId, plan => {
      clearTimeout(timer);
      gate.resolve(plan);
    });
    this.#send(ws, { type: "sync", reqId, full, blocks, contextWindow: this.#contextWindow });
    return gate.promise;
  }

  async requestUnfold(codes: string[], signal?: AbortSignal): Promise<{ restored: UnfoldRestored[]; missing: string[] } | null> {
    return this.#requestBrowserResult("unfold", codes, signal);
  }

  async requestRecall(codes: string[], signal?: AbortSignal): Promise<{ restored: RecallContent[]; missing: string[] } | null> {
    return this.#requestBrowserResult("recall", codes, signal);
  }

  #requestBrowserResult(kind: "unfold", codes: string[], signal?: AbortSignal): Promise<{ restored: UnfoldRestored[]; missing: string[] } | null>;
  #requestBrowserResult(kind: "recall", codes: string[], signal?: AbortSignal): Promise<{ restored: RecallContent[]; missing: string[] } | null>;
  #requestBrowserResult(kind: "unfold" | "recall", codes: string[], signal?: AbortSignal): Promise<unknown | null> {
    const ws = this.#client;
    if (!ws) return Promise.resolve(null);
    if (signal?.aborted) return Promise.resolve(null);

    const reqId = kind === "unfold" ? ++this.#unfoldSeq : ++this.#recallSeq;
    const gate = Promise.withResolvers<unknown | null>();
    const pending = kind === "unfold" ? this.#pendingUnfold : this.#pendingRecall;
    const timeout = kind === "unfold" ? this.unfoldTimeoutMs : this.recallTimeoutMs;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      pending.delete(reqId);
    };
    const onAbort = () => {
      cleanup();
      gate.resolve(null);
    };
    const timer = setTimeout(() => {
      cleanup();
      gate.resolve(null);
    }, timeout);

    pending.set(reqId, value => {
      cleanup();
      gate.resolve(value);
    });
    signal?.addEventListener("abort", onAbort, { once: true });
    if (kind === "unfold") this.#send(ws, { type: "unfoldRequest", reqId, codes } as UnfoldRequestMessage);
    else this.#send(ws, { type: "recallRequest", reqId, codes });
    return gate.promise;
  }

  onSessionStart(ctx: unknown): void {
    this.#refreshFromCtx(ctx);
    this.#lastMessages = this.#readSessionMessages(ctx);
    this.#pendingSince = [];
  }

  onBeforeAgentStart(ctx: unknown): void {
    const previousWindow = this.#contextWindow;
    this.#refreshFromCtx(ctx);
    if (this.attached && previousWindow !== this.#contextWindow) {
      this.#sendToClient({ type: "sync", reqId: ++this.#reqSeq, full: false, blocks: [], contextWindow: this.#contextWindow });
    }
  }

  async onContext(event: ContextEventLike, ctx: unknown): Promise<ContextResult | undefined> {
    this.#refreshFromCtx(ctx);
    const myEpoch = this.#epoch;
    this.#lastMessages = event.messages as PiMessage[];
    this.#pendingSince = [];
    const all = linearize(this.#lastMessages);
    if (!this.attached) return undefined;

    const fresh = all.slice(this.#sentCount);
    const reqId = ++this.#reqSeq;
    const full = this.#sentCount === 0;
    const plan = await this.#requestPlan(reqId, full, fresh);
    if (!plan) return undefined;
    if (this.#epoch !== myEpoch) return undefined;
    this.#sentCount = Math.max(this.#sentCount, all.length);
    if (plan.ops.length === 0 && plan.groups.length === 0) return undefined;
    return { messages: applyPlan(event.messages as PiMessage[], plan.ops, plan.groups) };
  }

  onMessageUpdate(event: unknown): void {
    const record = isObject(event) ? toRecord(event) : null;
    const assistantEvent = record && isObject(record.assistantMessageEvent) ? toRecord(record.assistantMessageEvent) : null;
    const type = assistantEvent?.type;
    const contentIndex = typeof assistantEvent?.contentIndex === "number" ? assistantEvent.contentIndex : 0;
    if (type === "text_start") this.#sendToClient({ type: "stream", phase: "start", kind: "text", contentIndex });
    else if (type === "thinking_start") this.#sendToClient({ type: "stream", phase: "start", kind: "thinking", contentIndex });
    else if (type === "toolcall_start") this.#sendToClient({ type: "stream", phase: "start", kind: "tool_call", contentIndex });
    else if (type === "text_end") this.#sendToClient({ type: "stream", phase: "end", kind: "text", contentIndex });
    else if (type === "thinking_end") this.#sendToClient({ type: "stream", phase: "end", kind: "thinking", contentIndex });
    else if (type === "toolcall_end") this.#sendToClient({ type: "stream", phase: "end", kind: "tool_call", contentIndex });
    else if (type === "error" || type === "aborted") this.#sendToClient({ type: "stream", phase: "abort", kind: "text", contentIndex: -1 });
  }

  onMessageEnd(event: unknown): void {
    const record = isObject(event) ? toRecord(event) : null;
    const message = record?.message as PiMessage | undefined;
    if (!message || !this.attached) return;
    this.#sendToClient({ type: "stream", phase: "abort", kind: "text", contentIndex: -1 });
    const msgIds = new Set(linearize([message]).map(block => block.id));
    const baseIds = new Set(linearize(this.#lastMessages).map(block => block.id));
    const pendIds = new Set(linearize(this.#pendingSince).map(block => block.id));
    const alreadySeen = [...msgIds].some(id => baseIds.has(id) || pendIds.has(id));
    if (msgIds.size > 0 && !alreadySeen) this.#pendingSince.push(message);
    const all = linearize([...this.#lastMessages, ...this.#pendingSince]);
    if (all.length <= this.#sentCount) return;
    const full = this.#sentCount === 0;
    this.#sendToClient({ type: "sync", reqId: ++this.#reqSeq, full, blocks: all.slice(this.#sentCount), contextWindow: this.#contextWindow });
    this.#sentCount = all.length;
  }

  onAgentEnd(event: unknown, ctx: unknown): void {
    this.#refreshFromCtx(ctx);
    const record = isObject(event) ? toRecord(event) : null;
    this.#lastMessages = Array.isArray(record?.messages) ? record.messages as PiMessage[] : this.#lastMessages;
    this.#pendingSince = [];
    if (!this.attached) return;
    this.#sendToClient({ type: "stream", phase: "abort", kind: "text", contentIndex: -1 });
    const all = linearize(this.#lastMessages);
    if (all.length <= this.#sentCount) return;
    const full = this.#sentCount === 0;
    this.#sendToClient({ type: "sync", reqId: ++this.#reqSeq, full, blocks: all.slice(this.#sentCount), contextWindow: this.#contextWindow });
    this.#sentCount = all.length;
  }

  onBeforeCompact(): { cancel?: boolean } | undefined {
    return this.attached ? { cancel: true } : undefined;
  }

  async close(): Promise<void> {
    this.#flushPending();
    try { this.#client?.close(); } catch { /* ignore */ }
    this.#client = null;
    try { this.#server.stop(true); } catch { /* ignore */ }
    const closed = Promise.withResolvers<void>();
    setTimeout(() => closed.resolve(), 10);
    await closed.promise;
  }
}
