import type { CmuxTransport } from "./cmux.js";
import type { PreviewSnapshot } from "./model.js";
import { isPageToHost } from "./protocol.js";

export interface PreviewServerLike {
  register(surface: PreviewBrowserSurface): URL;
  unregister(token: string): void;
}

export interface SurfaceSocketLike {
  send(data: string): void;
  close(): void;
}

export type PreviewBrowserCloseSource = "host" | "browser";

export class PreviewBrowserSurface {
  surfaceRef: string | undefined;
  onBrowserClose: (() => void) | undefined;
  #socket: SurfaceSocketLike | undefined;
  #latestSnapshot: PreviewSnapshot | undefined;
  #closed = false;

  constructor(readonly token: string, readonly onClose: (surface: PreviewBrowserSurface, source: PreviewBrowserCloseSource) => void) {}

  send(snapshot: PreviewSnapshot): void {
    if (this.#closed) return;
    this.#latestSnapshot = snapshot;
    this.#socket?.send(JSON.stringify({ type: "snapshot", snapshot }));
  }

  attachSocket(socket: SurfaceSocketLike): void {
    if (this.#closed) {
      socket.close();
      return;
    }
    this.#socket = socket;
  }

  detachSocket(socket: SurfaceSocketLike): void {
    if (this.#socket === socket) this.#socket = undefined;
  }

  receiveFromBrowser(data: string): void {
    let raw: unknown;
    try {
      raw = JSON.parse(data);
    } catch {
      return;
    }
    if (!isPageToHost(raw)) return;
    if (raw.type === "ready" && this.#latestSnapshot) this.send(this.#latestSnapshot);
  }

  close(): void {
    this.#close("host");
  }

  browserClosed(): void {
    this.#close("browser");
  }

  #close(source: PreviewBrowserCloseSource): void {
    if (this.#closed) return;
    this.#closed = true;
    const socket = this.#socket;
    this.#socket = undefined;
    if (source === "host") socket?.close();
    if (source === "browser") this.onBrowserClose?.();
    this.onClose(this, source);
  }
}

export interface CreatePreviewSurfaceOpenerOptions {
  server: PreviewServerLike;
  transport: CmuxTransport;
  tokenFactory?: () => string;
}

export type PreviewSurfaceOpener = (signal?: AbortSignal) => Promise<PreviewBrowserSurface>;

export function createPreviewSurfaceOpener(options: CreatePreviewSurfaceOpenerOptions): PreviewSurfaceOpener {
  return async (signal?: AbortSignal): Promise<PreviewBrowserSurface> => {
    const token = options.tokenFactory?.() ?? crypto.randomUUID();
    const surface = new PreviewBrowserSurface(token, (closed, source) => {
      options.server.unregister(closed.token);
      if (source === "host" && closed.surfaceRef) void options.transport.closeSurface(closed.surfaceRef);
    });
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
