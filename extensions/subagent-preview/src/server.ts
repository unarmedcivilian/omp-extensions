import type { PreviewBrowserSurface, SurfaceSocketLike, PreviewServerLike } from "./surface.js";

type WebSocketData = { token: string; socket?: SurfaceSocketLike };

export interface LocalPreviewServerOptions {
  browserCloseGraceMs?: number;
}

export class LocalPreviewServer implements PreviewServerLike {
  readonly #runtimeHtml: string;
  readonly #surfaces = new Map<string, PreviewBrowserSurface>();
  readonly #browserCloseGraceMs: number;
  readonly #browserCloseTimers = new Map<string, ReturnType<typeof setTimeout>>();
  #server: Bun.Server | undefined;

  constructor(runtimeHtml: string, options: LocalPreviewServerOptions = {}) {
    this.#runtimeHtml = runtimeHtml;
    this.#browserCloseGraceMs = options.browserCloseGraceMs ?? 1_000;
  }

  get baseUrl(): URL {
    this.#ensureStarted();
    return new URL("/", this.#server!.url);
  }

  register(surface: PreviewBrowserSurface): URL {
    this.#ensureStarted();
    this.#surfaces.set(surface.token, surface);
    return new URL(`/subagent-preview/${encodeURIComponent(surface.token)}`, this.baseUrl);
  }

  unregister(token: string): void {
    this.#surfaces.delete(token);
    const timer = this.#browserCloseTimers.get(token);
    if (timer) {
      clearTimeout(timer);
      this.#browserCloseTimers.delete(token);
    }
  }

  close(): void {
    for (const timer of this.#browserCloseTimers.values()) clearTimeout(timer);
    this.#browserCloseTimers.clear();
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
          const data = ws.data as WebSocketData;
          const pendingBrowserClose = this.#browserCloseTimers.get(data.token);
          if (pendingBrowserClose) {
            clearTimeout(pendingBrowserClose);
            this.#browserCloseTimers.delete(data.token);
          }
          const socket: SurfaceSocketLike = {
            send: payload => { ws.send(payload); },
            close: () => { ws.close(); },
          };
          data.socket = socket;
          this.#surfaces.get(data.token)?.attachSocket(socket);
        },
        message: (ws, message) => {
          const token = (ws.data as WebSocketData).token;
          const surface = this.#surfaces.get(token);
          if (!surface) return;
          surface.receiveFromBrowser(typeof message === "string" ? message : Buffer.from(message).toString("utf8"));
        },
        close: ws => {
          const { token, socket } = ws.data as WebSocketData;
          const surface = this.#surfaces.get(token);
          if (!surface || !socket) return;
          surface.detachForBrowserDisconnect(socket);
          this.#scheduleBrowserClose(token, surface);
        },
      },
    });
  }

  #handleRequest(request: Request, server: Bun.Server): Response | undefined {
    const url = new URL(request.url);
    const previewToken = tokenFromPath(url.pathname, "/subagent-preview/");
    const wsToken = tokenFromPath(url.pathname, "/ws/");
    const token = previewToken ?? wsToken;
    if (!token) return new Response("not found", { status: 404 });

    const surface = this.#surfaces.get(token);
    if (!surface) return new Response("not found", { status: 404 });

    if (wsToken) {
      if (server.upgrade(request, { data: { token } satisfies WebSocketData })) return undefined;
      return new Response("websocket upgrade failed", { status: 400 });
    }

    return new Response(this.#runtimeHtml, {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }

  #scheduleBrowserClose(token: string, surface: PreviewBrowserSurface): void {
    const closeIfStillDetached = () => {
      this.#browserCloseTimers.delete(token);
      if (this.#surfaces.get(token) === surface) surface.browserClosed();
    };
    if (this.#browserCloseGraceMs <= 0) {
      queueMicrotask(closeIfStillDetached);
      return;
    }
    const timer = setTimeout(closeIfStillDetached, this.#browserCloseGraceMs);
    this.#browserCloseTimers.set(token, timer);
  }
}

function tokenFromPath(pathname: string, prefix: string): string | undefined {
  if (!pathname.startsWith(prefix)) return undefined;
  const encoded = pathname.slice(prefix.length);
  if (!encoded || encoded.includes("/")) return undefined;
  return decodeURIComponent(encoded);
}
