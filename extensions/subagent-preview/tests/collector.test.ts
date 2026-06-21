import { describe, expect, test } from "bun:test";
import { SubagentPreviewCollector, TASK_SUBAGENT_LIFECYCLE_CHANNEL, TASK_SUBAGENT_PROGRESS_CHANNEL } from "../src/collector.js";

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
    emit(channel: string, data: unknown) {
      for (const handler of handlers.get(channel) ?? []) handler(data);
    },
  };
}

describe("SubagentPreviewCollector", () => {
  test("subscribes to lifecycle and progress and emits snapshots", () => {
    const bus = makeEventBus();
    const snapshots: unknown[] = [];
    const collector = new SubagentPreviewCollector(bus, snapshot => snapshots.push(snapshot), { debounceMs: 0 });

    collector.start();
    bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, { id: "A", agent: "task", agentSource: "bundled", status: "started", index: 0 });
    bus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, {
      index: 0,
      agent: "task",
      agentSource: "bundled",
      task: "Inspect",
      progress: { id: "A", index: 0, agent: "task", agentSource: "bundled", status: "running", task: "Inspect", recentTools: [], recentOutput: ["hi"], toolCount: 0, tokens: 1, cost: 0, durationMs: 1 },
    });

    expect(snapshots).toHaveLength(2);
    expect((snapshots.at(-1) as { subagents: Array<{ id: string; recentOutput: string[] }> }).subagents[0]).toMatchObject({ id: "A", recentOutput: ["hi"] });
    collector.stop();
  });

  test("stop unsubscribes from event bus", () => {
    const bus = makeEventBus();
    const collector = new SubagentPreviewCollector(bus, () => {}, { debounceMs: 0 });
    collector.start();
    collector.stop();
    expect(bus.handlers.get(TASK_SUBAGENT_LIFECYCLE_CHANNEL)).toEqual([]);
    expect(bus.handlers.get(TASK_SUBAGENT_PROGRESS_CHANNEL)).toEqual([]);
  });
});
