import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { SubagentPreviewCollector } from "./collector.js";
import { createCmuxTransport } from "./cmux.js";
import { PreviewController, type PreviewSurface } from "./controller.js";
import { replaceTranscript, snapshotPreview, type PreviewSnapshot, type PreviewStatus, type TranscriptEntry } from "./model.js";
import { LocalPreviewServer } from "./server.js";
import { createPreviewSurfaceOpener } from "./surface.js";
import { TranscriptTailer } from "./transcript.js";
import { RUNTIME_HTML } from "./runtime.bundle.js";

const installedApis = new WeakSet<object>();
const TERMINAL = new Set<PreviewStatus>(["completed", "failed", "aborted"]);

export interface RuntimeTranscriptTailer {
  readNew(): Promise<TranscriptEntry[]>;
  stop?(): void;
}

export interface RuntimeOptions {
  eventBus: { on(channel: string, handler: (data: unknown) => void): () => void };
  openSurface: () => Promise<PreviewSurface>;
  notify: (message: string, level?: "info" | "warn" | "error") => void;
  debounceMs?: number;
  createTranscriptTailer?: (path: string) => RuntimeTranscriptTailer;
  transcriptPollMs?: number;
}

export function createSubagentPreviewRuntime(options: RuntimeOptions) {
  const createController = () => new PreviewController({ openSurface: options.openSurface, notify: options.notify });
  let controller = createController();
  const createTailer = options.createTranscriptTailer ?? (path => new TranscriptTailer(path));
  const tailers = new Map<string, RuntimeTranscriptTailer>();
  let collector: SubagentPreviewCollector | undefined;
  let transcriptTimer: ReturnType<typeof setInterval> | undefined;
  let lastSnapshot: PreviewSnapshot | undefined;

  const handleSnapshot = (snapshot: PreviewSnapshot) => {
    lastSnapshot = snapshot;
    for (const subagent of snapshot.subagents) {
      if (subagent.sessionFile && !tailers.has(subagent.id) && !TERMINAL.has(subagent.status)) {
        tailers.set(subagent.id, createTailer(subagent.sessionFile));
        if (options.transcriptPollMs === 0) queueMicrotask(() => { void flushTranscripts(); });
      }
      if (TERMINAL.has(subagent.status) && tailers.has(subagent.id)) {
        const tailer = tailers.get(subagent.id)!;
        void flushTailer(subagent.id, tailer).finally(() => {
          tailer.stop?.();
          tailers.delete(subagent.id);
        });
      }
    }
    void controller.handleSnapshot(snapshot);
  };

  async function flushTailer(id: string, tailer: RuntimeTranscriptTailer): Promise<void> {
    if (!collector) return;
    const entries = await tailer.readNew();
    if (entries.length === 0) return;
    const existing = collector.state.subagents.get(id)?.transcript ?? [];
    replaceTranscript(collector.state, id, [...existing, ...entries].slice(-50));
  }

  async function flushTranscripts(): Promise<void> {
    if (!collector) return;
    for (const [id, tailer] of tailers) await flushTailer(id, tailer);
    handleSnapshot(snapshotPreview(collector.state));
  }

  function startTranscriptPolling(): void {
    if (options.transcriptPollMs === 0) return;
    const interval = options.transcriptPollMs ?? 500;
    transcriptTimer = setInterval(() => { void flushTranscripts(); }, interval);
  }

  function stopTranscriptPolling(): void {
    clearInterval(transcriptTimer);
    transcriptTimer = undefined;
  }

  return {
    get controller() { return controller; },
    start() {
      collector?.stop();
      stopTranscriptPolling();
      collector = new SubagentPreviewCollector(options.eventBus, handleSnapshot, { debounceMs: options.debounceMs });
      collector.start();
      startTranscriptPolling();
    },
    async runCommand(args: string) {
      await controller.runCommand(args);
    },
    async flush() {
      if (lastSnapshot) await controller.handleSnapshot(lastSnapshot);
    },
    async resetSession() {
      collector?.stop();
      stopTranscriptPolling();
      for (const tailer of tailers.values()) tailer.stop?.();
      tailers.clear();
      await controller.dispose();
      controller = createController();
      lastSnapshot = undefined;
      collector = new SubagentPreviewCollector(options.eventBus, handleSnapshot, { debounceMs: options.debounceMs });
      collector.start();
      startTranscriptPolling();
    },
    async shutdown() {
      collector?.stop();
      collector = undefined;
      stopTranscriptPolling();
      for (const tailer of tailers.values()) tailer.stop?.();
      tailers.clear();
      await controller.dispose();
    },
  };
}

export function createSubagentPreviewExtension(): (pi: ExtensionAPI) => void {
  return function subagentPreviewExtension(pi: ExtensionAPI): void {
    if (installedApis.has(pi as object)) {
      pi.logger.warn("subagent-preview extension already installed; skipping duplicate registration");
      return;
    }
    installedApis.add(pi as object);
    pi.setLabel("Subagent Preview");

    let runtime: ReturnType<typeof createSubagentPreviewRuntime> | undefined;
    let server: LocalPreviewServer | undefined;

    const shutdown = async () => {
      await runtime?.shutdown();
      runtime = undefined;
      server?.close();
      server = undefined;
    };

    const makeNotify = (ctx: unknown) => (message: string, level?: "info" | "warn" | "error") => {
      const notify = (ctx as { ui?: { notify?: (message: string, level?: "info" | "warn" | "error") => void } } | undefined)?.ui?.notify;
      if (notify) notify(message, level);
      else pi.logger.warn(message);
    };

    pi.on("session_start", async (_event, ctx) => {
      await shutdown();
      server = new LocalPreviewServer(RUNTIME_HTML);
      const opener = createPreviewSurfaceOpener({ server, transport: createCmuxTransport() });
      runtime = createSubagentPreviewRuntime({ eventBus: pi.events, openSurface: opener, notify: makeNotify(ctx) });
      runtime.start();
    });
    pi.on("session_switch", async () => { await runtime?.resetSession(); });
    pi.on("session_branch", async () => { await runtime?.resetSession(); });
    pi.on("session_tree", async () => { await runtime?.resetSession(); });
    pi.on("session_shutdown", async () => { await shutdown(); });

    pi.registerCommand("subagent-preview", {
      description: "Open, close, enable, or disable the subagent preview dashboard",
      handler: async (args: string) => {
        if (!runtime) {
          pi.logger.warn("subagent-preview runtime is not active yet");
          return;
        }
        await runtime.runCommand(args ?? "");
      },
    });
  };
}

const subagentPreviewExtension = createSubagentPreviewExtension();
export default subagentPreviewExtension;
