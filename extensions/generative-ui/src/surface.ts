import { EventEmitter } from "node:events";
import type { CmuxTransport } from "./cmux.js";
import type { HostToPage } from "./protocol.js";
import { isPageToHost } from "./protocol.js";
import type { WidgetOpenOptions, WidgetSurfaceLike, WidgetSurfaceOpener } from "./session.js";

export interface WidgetServerLike {
  register(surface: CmuxWidgetSurface): URL;
  unregister(token: string): void;
}

export interface SurfaceSocketLike {
  send(data: string): void;
  close(): void;
}

export type CmuxWidgetCloseSource = "host" | "browser";

export class CmuxWidgetSurface extends EventEmitter implements WidgetSurfaceLike {
  surfaceRef: string | undefined;
  #socket: SurfaceSocketLike | undefined;
  #queue: HostToPage[] = [];
  #closed = false;

  constructor(readonly token: string, readonly onClose: (surface: CmuxWidgetSurface, source: CmuxWidgetCloseSource) => void, readonly title = "Widget") {
    super();
  }

  send(msg: HostToPage): void {
    if (this.#closed) return;
    if (!this.#socket) {
      this.#queue.push(msg);
      return;
    }
    this.#socket.send(JSON.stringify(msg));
  }

  attachSocket(socket: SurfaceSocketLike): void {
    if (this.#closed) {
      socket.close();
      return;
    }
    this.#socket = socket;
    while (this.#queue.length > 0) {
      const msg = this.#queue.shift();
      if (msg) socket.send(JSON.stringify(msg));
    }
  }

  receiveFromBrowser(data: string): void {
    let raw: unknown;
    try {
      raw = JSON.parse(data);
    } catch {
      return;
    }
    if (!isPageToHost(raw)) return;
    if (raw.type === "ready") {
      this.emit("ready");
      return;
    }
    this.emit("message", raw);
  }

  close(): void {
    this.#close("host");
  }

  browserClosed(): void {
    this.#close("browser");
  }

  #close(source: CmuxWidgetCloseSource): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#queue = [];
    const socket = this.#socket;
    this.#socket = undefined;
    if (source === "host") socket?.close();
    this.onClose(this, source);
    this.emit("closed");
  }
}

export class LocalWidgetServer implements WidgetServerLike {
  readonly #runtimeHtml: string;
  readonly #surfaces = new Map<string, CmuxWidgetSurface>();
  #server: Bun.Server | undefined;

  constructor(runtimeHtml: string) {
    this.#runtimeHtml = runtimeHtml;
  }

  get baseUrl(): URL {
    this.#ensureStarted();
    return new URL("/", this.#server!.url);
  }

  register(surface: CmuxWidgetSurface): URL {
    this.#ensureStarted();
    this.#surfaces.set(surface.token, surface);
    return new URL(`/widget/${encodeURIComponent(surface.token)}`, this.baseUrl);
  }

  unregister(token: string): void {
    this.#surfaces.delete(token);
  }

  close(): void {
    this.#surfaces.clear();
    this.#server?.stop(true);
    this.#server = undefined;
  }

  #ensureStarted(): void {
    if (this.#server) return;
    this.#server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request, server) => this.#handleRequest(request, server),
      websocket: {
        open: ws => {
          const token = (ws.data as { token: string }).token;
          this.#surfaces.get(token)?.attachSocket({
            send: data => { ws.send(data); },
            close: () => { ws.close(); },
          });
        },
        message: (ws, message) => {
          const token = (ws.data as { token: string }).token;
          const surface = this.#surfaces.get(token);
          if (!surface) return;
          surface.receiveFromBrowser(typeof message === "string" ? message : Buffer.from(message).toString("utf8"));
        },
        close: ws => {
          const token = (ws.data as { token: string }).token;
          this.#surfaces.get(token)?.browserClosed();
        },
      },
    });
  }

  #handleRequest(request: Request, server: Bun.Server): Response | undefined {
    const url = new URL(request.url);
    const token = tokenFromPath(url.pathname, "/widget/") ?? tokenFromPath(url.pathname, "/ws/");
    if (!token) return new Response("not found", { status: 404 });

    const surface = this.#surfaces.get(token);
    if (!surface) return new Response("not found", { status: 404 });

    if (url.pathname.startsWith("/ws/")) {
      if (server.upgrade(request, { data: { token } })) return undefined;
      return new Response("websocket upgrade failed", { status: 400 });
    }

    return new Response(this.#htmlFor(surface), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }

  #htmlFor(surface: CmuxWidgetSurface): string {
    return this.#runtimeHtml.replace("<title>Widget</title>", `<title>${escapeHtml(surface.title)}</title>`);
  }
}

function tokenFromPath(pathname: string, prefix: string): string | undefined {
  if (!pathname.startsWith(prefix)) return undefined;
  const encoded = pathname.slice(prefix.length);
  if (!encoded || encoded.includes("/")) return undefined;
  return decodeURIComponent(encoded);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export interface CreateCmuxWidgetOpenerOptions {
  server: WidgetServerLike;
  transport: CmuxTransport;
  tokenFactory?: () => string;
}

export function createCmuxWidgetOpener(options: CreateCmuxWidgetOpenerOptions): WidgetSurfaceOpener {
  return async (opts: WidgetOpenOptions, signal?: AbortSignal): Promise<WidgetSurfaceLike> => {
    const token = options.tokenFactory?.() ?? crypto.randomUUID();
    const surface = new CmuxWidgetSurface(token, (s, source) => {
      options.server.unregister(s.token);
      if (source === "host" && s.surfaceRef) void options.transport.closeSurface(s.surfaceRef);
    }, opts.title);
    const url = options.server.register(surface);
    try {
      surface.surfaceRef = await options.transport.openBrowserSurface(url.toString(), signal);
      return surface;
    } catch (error) {
      options.server.unregister(token);
      throw error;
    }
  };
}
