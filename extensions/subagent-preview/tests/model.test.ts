import { describe, expect, test } from "bun:test";
import { applyLifecycle, applyProgress, createPreviewState, replaceTranscript, snapshotPreview } from "../src/model.js";

describe("preview model", () => {
  test("creates subagents from lifecycle and updates terminal state", () => {
    const state = createPreviewState();
    applyLifecycle(state, {
      id: "AgentA",
      agent: "task",
      agentSource: "bundled",
      description: "Inspect API",
      status: "started",
      sessionFile: "/tmp/a.jsonl",
      index: 0,
    });
    applyLifecycle(state, {
      id: "AgentA",
      agent: "task",
      agentSource: "bundled",
      description: "Inspect API",
      status: "completed",
      sessionFile: "/tmp/a.jsonl",
      index: 0,
    });

    const snapshot = snapshotPreview(state);
    expect(snapshot.counts.completed).toBe(1);
    expect(snapshot.subagents[0]).toMatchObject({ id: "AgentA", status: "completed", sessionFile: "/tmp/a.jsonl" });
  });

  test("progress updates live fields while keeping newest launches first", () => {
    const state = createPreviewState();
    applyLifecycle(state, { id: "Done", agent: "task", agentSource: "bundled", status: "completed", index: 0 });
    applyProgress(state, {
      index: 1,
      agent: "task",
      agentSource: "bundled",
      task: "Run tests",
      assignment: "Run tests",
      progress: {
        index: 1,
        id: "Active",
        agent: "task",
        agentSource: "bundled",
        status: "running",
        task: "Run tests",
        assignment: "Run tests",
        description: "Test runner",
        currentTool: "bash",
        currentToolArgs: "bun test",
        recentTools: [],
        recentOutput: ["running"],
        toolCount: 1,
        tokens: 12,
        cost: 0.001,
        durationMs: 500,
      },
      sessionFile: "/tmp/b.jsonl",
    });

    const snapshot = snapshotPreview(state);
    expect(snapshot.subagents.map(item => item.id)).toEqual(["Active", "Done"]);
    expect(snapshot.subagents[0]).toMatchObject({ currentTool: "bash", recentOutput: ["running"], tokens: 12 });

    applyProgress(state, {
      index: 0,
      agent: "task",
      agentSource: "bundled",
      task: "Late old update",
      progress: {
        index: 0,
        id: "Done",
        agent: "task",
        agentSource: "bundled",
        status: "completed",
        task: "Late old update",
        recentTools: [],
        recentOutput: ["late old update"],
        toolCount: 2,
        tokens: 20,
        cost: 0,
        durationMs: 1000,
      },
    });
    expect(snapshotPreview(state).subagents.map(item => item.id)).toEqual(["Active", "Done"]);
  });

  test("stores transcript entries newest timestamp first", () => {
    const state = createPreviewState();
    applyLifecycle(state, { id: "A", agent: "task", agentSource: "bundled", status: "started", index: 0 });
    replaceTranscript(state, "A", [
      { kind: "assistant", text: "older", timestamp: "2026-06-22T10:00:00.000Z" },
      { kind: "assistant", text: "untimed" },
      { kind: "assistant", text: "newer", timestamp: "2026-06-22T10:01:00.000Z" },
    ]);

    expect(snapshotPreview(state).subagents[0].transcript.map(entry => entry.text)).toEqual(["newer", "untimed", "older"]);
  });

  test("stores untimed transcript entries newest appended first", () => {
    const state = createPreviewState();
    applyLifecycle(state, { id: "A", agent: "task", agentSource: "bundled", status: "started", index: 0 });
    replaceTranscript(state, "A", [
      { kind: "assistant", text: "oldest" },
      { kind: "assistant", text: "middle" },
      { kind: "assistant", text: "newest" },
    ]);

    expect(snapshotPreview(state).subagents[0].transcript.map(entry => entry.text)).toEqual(["newest", "middle", "oldest"]);
  });
  test("terminal lifecycle state is not reverted by stale progress", () => {
    const state = createPreviewState();
    applyLifecycle(state, { id: "A", agent: "task", agentSource: "bundled", status: "completed", index: 0 });
    applyProgress(state, {
      index: 0,
      agent: "task",
      agentSource: "bundled",
      task: "Old progress",
      progress: {
        index: 0,
        id: "A",
        agent: "task",
        agentSource: "bundled",
        status: "running",
        task: "Old progress",
        recentTools: [],
        recentOutput: ["late"],
        toolCount: 1,
        tokens: 2,
        cost: 0,
        durationMs: 10,
      },
    });

    expect(snapshotPreview(state).subagents[0].status).toBe("completed");
    expect(snapshotPreview(state).counts.completed).toBe(1);
  });
});
