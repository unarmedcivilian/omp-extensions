import type { SubagentLifecyclePayload, SubagentProgressPayload } from "@oh-my-pi/pi-coding-agent/task";
import { applyLifecycle, applyProgress, createPreviewState, snapshotPreview, type PreviewSnapshot, type PreviewState } from "./model.js";

export const TASK_SUBAGENT_LIFECYCLE_CHANNEL = "task:subagent:lifecycle";
export const TASK_SUBAGENT_PROGRESS_CHANNEL = "task:subagent:progress";

export interface CollectorOptions { debounceMs?: number }
export interface CollectorEventBus { on(channel: string, handler: (data: unknown) => void): () => void }

export class SubagentPreviewCollector {
  readonly state: PreviewState = createPreviewState();
  #unsubscribers: Array<() => void> = [];
  #timer: ReturnType<typeof setTimeout> | undefined;
  #debounceMs: number;

  constructor(
    readonly eventBus: CollectorEventBus,
    readonly onSnapshot: (snapshot: PreviewSnapshot) => void,
    options: CollectorOptions = {},
  ) {
    this.#debounceMs = options.debounceMs ?? 150;
  }

  start(): void {
    if (this.#unsubscribers.length > 0) return;
    this.#unsubscribers.push(
      this.eventBus.on(TASK_SUBAGENT_LIFECYCLE_CHANNEL, data => {
        applyLifecycle(this.state, data as SubagentLifecyclePayload);
        this.#emitSoon();
      }),
      this.eventBus.on(TASK_SUBAGENT_PROGRESS_CHANNEL, data => {
        applyProgress(this.state, data as SubagentProgressPayload);
        this.#emitSoon();
      }),
    );
  }

  stop(): void {
    for (const unsubscribe of this.#unsubscribers) unsubscribe();
    this.#unsubscribers = [];
    clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  #emitSoon(): void {
    if (this.#debounceMs <= 0) {
      this.onSnapshot(snapshotPreview(this.state));
      return;
    }
    if (this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.onSnapshot(snapshotPreview(this.state));
    }, this.#debounceMs);
  }
}
