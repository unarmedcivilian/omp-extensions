import { EventEmitter } from "node:events";
import type { HostToPage } from "./protocol.js";
import { attachRpc, type RpcHost } from "./rpc.js";

const FLUSH_DEBOUNCE_MS = 150;
const MIN_CHUNK_BYTES = 20;

export interface WidgetSurfaceLike extends EventEmitter {
  surfaceRef?: string;
  send(msg: HostToPage): void;
  close(): void;
}

export interface WidgetOpenOptions {
  title: string;
  width: number;
  height: number;
  floating?: boolean;
}

export type WidgetSurfaceOpener = (opts: WidgetOpenOptions, signal?: AbortSignal) => Promise<WidgetSurfaceLike>;

export class WidgetSession {
  readonly rpc: RpcHost;
  readonly ready: Promise<void>;

  #latestHTML = "";
  #hasContent = false;
  #flushTimer: ReturnType<typeof setTimeout> | undefined;
  #closed = false;

  static async create(open: WidgetSurfaceOpener, opts: WidgetOpenOptions, signal?: AbortSignal): Promise<WidgetSession> {
    return new WidgetSession(await open(opts, signal));
  }

  constructor(readonly surface: WidgetSurfaceLike) {
    this.rpc = attachRpc(surface);
    const ready = Promise.withResolvers<void>();
    this.ready = ready.promise;
    surface.once("ready", () => ready.resolve());
    surface.on("closed", () => {
      this.#closed = true;
      this.#clearTimer();
    });
    surface.on("error", () => {
      this.#closed = true;
      this.#clearTimer();
    });
  }

  get latestHTML(): string {
    return this.#latestHTML;
  }

  onChunk(html: string): void {
    if (this.#closed) return;
    if (!html || html.length < MIN_CHUNK_BYTES) return;
    if (html === this.#latestHTML) return;
    this.#latestHTML = html;
    this.#hasContent = true;
    if (this.#flushTimer) return;
    this.#flushTimer = setTimeout(() => {
      this.#flushTimer = undefined;
      void this.#flush(false);
    }, FLUSH_DEBOUNCE_MS);
  }

  async onComplete(html: string): Promise<void> {
    if (this.#closed) return;
    this.#clearTimer();
    if (html) {
      this.#latestHTML = html;
      this.#hasContent = true;
    }
    await this.#flush(true);
  }

  onClosed(fn: () => void): void {
    this.surface.on("closed", fn);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#clearTimer();
    this.surface.close();
  }

  async #flush(final: boolean): Promise<void> {
    if (!this.#hasContent) return;
    await this.ready;
    if (this.#closed) return;
    this.rpc.push({ type: "content", html: this.#latestHTML, final });
  }

  #clearTimer(): void {
    if (!this.#flushTimer) return;
    clearTimeout(this.#flushTimer);
    this.#flushTimer = undefined;
  }
}
