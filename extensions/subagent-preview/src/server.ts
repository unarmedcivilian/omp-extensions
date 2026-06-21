import type { PreviewBrowserSurface, SurfaceSocketLike, PreviewServerLike } from "./surface.js";

type WebSocketData = { token: string; socket?: SurfaceSocketLike };

export class LocalPreviewServer implements PreviewServerLike {
  readonly #runtimeHtml: string;
  readonly #surfaces = new Map<string, PreviewBrowserSurface>();
  #server: Bun.Server | undefined;

  constructor(runtimeHtml: string) {
    this.#runtimeHtml = runtimeHtml;
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
          const data = ws.data as WebSocketData;
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
          if (surface && socket) surface.detachSocket(socket);
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
}

function tokenFromPath(pathname: string, prefix: string): string | undefined {
  if (!pathname.startsWith(prefix)) return undefined;
  const encoded = pathname.slice(prefix.length);
  if (!encoded || encoded.includes("/")) return undefined;
  return decodeURIComponent(encoded);
}
