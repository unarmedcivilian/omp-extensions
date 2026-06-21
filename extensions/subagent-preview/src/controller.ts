import type { PreviewSnapshot } from "./model.js";

export interface PreviewSurface {
  surfaceRef?: string;
  send(snapshot: PreviewSnapshot): void;
  close(): void;
  onBrowserClose?: (() => void) | undefined;
  onBrowserReconnect?: (() => void) | undefined;
  onBrowserClosed?: (() => void) | undefined;
}

export interface PreviewControllerOptions {
  openSurface: () => Promise<PreviewSurface>;
  notify: (message: string, level?: "info" | "warn" | "error") => void;
}

export class PreviewController {
  currentSurface: PreviewSurface | undefined;
  #latestSnapshot: PreviewSnapshot | undefined;
  #autoOpenEnabled = true;
  #opening: Promise<void> | undefined;
  #detachedSurface: PreviewSurface | undefined;
  #disposed = false;
  #generation = 0;

  constructor(readonly options: PreviewControllerOptions) {}

  async handleSnapshot(snapshot: PreviewSnapshot): Promise<void> {
    this.#latestSnapshot = snapshot;
    if (!this.currentSurface && this.#autoOpenEnabled && snapshot.subagents.length > 0) {
      await this.#ensureSurface({ sendLatest: false });
    }
    this.currentSurface?.send(snapshot);
  }

  handleBrowserClose(surface?: PreviewSurface): void {
    if (!surface) {
      this.currentSurface = undefined;
      return;
    }
    if (this.currentSurface === surface) {
      this.currentSurface = undefined;
      this.#detachedSurface = surface;
    }
  }

  handleBrowserReconnect(surface: PreviewSurface): void {
    if (this.#disposed || this.currentSurface || this.#detachedSurface !== surface) return;
    this.#detachedSurface = undefined;
    this.currentSurface = surface;
    if (this.#latestSnapshot) surface.send(this.#latestSnapshot);
  }

  handleBrowserClosed(surface: PreviewSurface): void {
    const wasDetached = this.#detachedSurface === surface;
    if (this.currentSurface === surface) this.currentSurface = undefined;
    if (wasDetached) this.#detachedSurface = undefined;
    if (wasDetached && !this.#disposed && this.#autoOpenEnabled && this.#latestSnapshot?.subagents.length) {
      void this.handleSnapshot(this.#latestSnapshot);
    }
  }

  async runCommand(rawArgs: string): Promise<void> {
    const command = rawArgs.trim().toLowerCase();
    if (command === "close") {
      this.#autoOpenEnabled = false;
      this.#closeOwnedSurfaces();
      return;
    }
    if (command === "disable") {
      this.#autoOpenEnabled = false;
      return;
    }
    if (command === "enable") {
      this.#autoOpenEnabled = true;
      if (this.#latestSnapshot?.subagents.length) await this.#ensureSurface();
      return;
    }
    if (command === "" || command === "open") {
      await this.#ensureSurface();
      return;
    }
    this.options.notify("Usage: /subagent-preview [open|close|enable|disable]", "warn");
  }

  async dispose(): Promise<void> {
    this.#generation++;
    this.#disposed = true;
    this.#closeOwnedSurfaces();
    await this.#opening;
  }

  #closeOwnedSurfaces(): void {
    const surface = this.currentSurface;
    const detachedSurface = this.#detachedSurface;
    this.currentSurface = undefined;
    this.#detachedSurface = undefined;
    surface?.close();
    if (detachedSurface && detachedSurface !== surface) detachedSurface.close();
  }

  async #ensureSurface(options: { sendLatest?: boolean } = {}): Promise<void> {
    const sendLatest = options.sendLatest ?? true;
    if (this.currentSurface) {
      if (sendLatest && this.#latestSnapshot) this.currentSurface.send(this.#latestSnapshot);
      return;
    }
    if (this.#detachedSurface) return;
    if (this.#opening) return this.#opening;
    const generation = this.#generation;
    const opening = (async () => {
      try {
        const surface = await this.options.openSurface();
        if (generation !== this.#generation) {
          surface.close();
          return;
        }
        this.#disposed = false;
        surface.onBrowserClose = () => this.handleBrowserClose(surface);
        surface.onBrowserReconnect = () => this.handleBrowserReconnect(surface);
        surface.onBrowserClosed = () => this.handleBrowserClosed(surface);
        this.currentSurface = surface;
        if (sendLatest && this.#latestSnapshot) surface.send(this.#latestSnapshot);
      } catch (error) {
        if (generation === this.#generation) this.options.notify(`Subagent preview unavailable: ${String(error)}`, "warn");
      } finally {
        if (this.#opening === opening) this.#opening = undefined;
      }
    })();
    this.#opening = opening;
    return opening;
  }
}
