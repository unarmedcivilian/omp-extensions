import { describe, expect, test } from "bun:test";
import { TASK_SUBAGENT_LIFECYCLE_CHANNEL } from "../src/collector.js";
import { createSubagentPreviewRuntime } from "../src/index.js";

function makeEventBus() {
  const handlers = new Map<string, Array<(data: unknown) => void>>();
  return {
    handlers,
    on(channel: string, handler: (data: unknown) => void) {
      const list = handlers.get(channel) ?? [];
      list.push(handler);
      handlers.set(channel, list);
      return () => handlers.set(channel, (handlers.get(channel) ?? []).filter(item => item !== handler));
    },
    emit(channel: string, data: unknown) { for (const handler of handlers.get(channel) ?? []) handler(data); },
  };
}

describe("subagent preview runtime wiring", () => {
  test("lifecycle event opens dashboard and shutdown disposes it", async () => {
    const eventBus = makeEventBus();
    const calls: string[] = [];
    const runtime = createSubagentPreviewRuntime({
      eventBus,
      debounceMs: 0,
      openSurface: async () => ({ surfaceRef: "surface:1", send() {}, close() { calls.push("close"); } }),
      notify: message => calls.push(`notify:${message}`),
    });

    runtime.start();
    eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, { id: "A", agent: "task", agentSource: "bundled", status: "started", sessionFile: "/tmp/a.jsonl", index: 0 });
    await runtime.flush();
    await runtime.shutdown();

    expect(calls).toContain("close");
  });

  test("session reset closes an open surface and keeps one active subscription", async () => {
    const eventBus = makeEventBus();
    const calls: string[] = [];
    const runtime = createSubagentPreviewRuntime({ eventBus, debounceMs: 0, transcriptPollMs: 0, openSurface: async () => ({ send() {}, close() { calls.push("close"); } }), notify: () => {} });

    runtime.start();
    eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, { id: "A", agent: "task", agentSource: "bundled", status: "started", index: 0 });
    await runtime.flush();
    await runtime.resetSession();

    expect(calls).toEqual(["close"]);
    expect(eventBus.handlers.get(TASK_SUBAGENT_LIFECYCLE_CHANNEL)).toHaveLength(1);
    await runtime.shutdown();
  });

  test("session reset restores auto-open defaults after disable", async () => {
    const eventBus = makeEventBus();
    const calls: string[] = [];
    const runtime = createSubagentPreviewRuntime({ eventBus, debounceMs: 0, transcriptPollMs: 0, openSurface: async () => { calls.push("open"); return { send() {}, close() { calls.push("close"); } }; }, notify: () => {} });

    runtime.start();
    await runtime.runCommand("disable");
    eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, { id: "A", agent: "task", agentSource: "bundled", status: "started", index: 0 });
    await runtime.flush();
    expect(calls).toEqual([]);

    await runtime.resetSession();
    eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, { id: "B", agent: "task", agentSource: "bundled", status: "started", index: 0 });
    await runtime.flush();

    expect(calls).toEqual(["open"]);
    await runtime.shutdown();
  });

  test("runtime polling starts transcript tailers and merges bounded summaries", async () => {
    const eventBus = makeEventBus();
    const sent: unknown[] = [];
    const runtime = createSubagentPreviewRuntime({
      eventBus,
      debounceMs: 0,
      transcriptPollMs: 0,
      openSurface: async () => ({ send(snapshot) { sent.push(snapshot); }, close() {} }),
      notify: () => {},
      createTranscriptTailer: path => ({
        readNew: async () => [{ kind: "assistant", text: `summary from ${path}`, truncated: false }],
        stop: () => {},
      }),
    });

    runtime.start();
    eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, { id: "A", agent: "task", agentSource: "bundled", status: "started", sessionFile: "/tmp/a.jsonl", index: 0 });
    await Promise.resolve();
    await runtime.flush();

    expect(JSON.stringify(sent.at(-1))).toContain("summary from /tmp/a.jsonl");
    await runtime.shutdown();
  });

  test("terminal first lifecycle event still drains transcript summaries", async () => {
    const eventBus = makeEventBus();
    const sent: unknown[] = [];
    const runtime = createSubagentPreviewRuntime({
      eventBus,
      debounceMs: 0,
      transcriptPollMs: 0,
      openSurface: async () => ({ send(snapshot) { sent.push(snapshot); }, close() {} }),
      notify: () => {},
      createTranscriptTailer: path => ({
        readNew: async () => [{ kind: "assistant", text: `terminal summary from ${path}`, truncated: false }],
        stop: () => {},
      }),
    });

    runtime.start();
    eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, { id: "A", agent: "task", agentSource: "bundled", status: "completed", sessionFile: "/tmp/a.jsonl", index: 0 });
    await Promise.resolve();
    await runtime.flush();

    expect(JSON.stringify(sent.at(-1))).toContain("terminal summary from /tmp/a.jsonl");
    await runtime.shutdown();
  });
});
