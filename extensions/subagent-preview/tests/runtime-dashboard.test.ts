import { describe, expect, test } from "bun:test";
import { filterSnapshot, renderDashboard } from "../src/runtime/dashboard.js";
import type { PreviewSnapshot } from "../src/model.js";

const snapshot: PreviewSnapshot = {
  updatedAt: 1,
  counts: { pending: 0, running: 1, completed: 1, failed: 0, aborted: 0 },
  subagents: [
    { id: "A", index: 0, agent: "task", agentSource: "bundled", status: "running", description: "Active", recentTools: [], recentOutput: ["line"], toolCount: 1, tokens: 10, cost: 0.01, durationMs: 1000, nestedTaskCount: 0, transcript: [{ kind: "assistant", text: "hello", truncated: false }], updatedAt: 2 },
    { id: "B", index: 1, agent: "task", agentSource: "bundled", status: "completed", description: "Done", recentTools: [], recentOutput: [], toolCount: 0, tokens: 0, cost: 0, durationMs: 1, nestedTaskCount: 0, transcript: [], updatedAt: 1 },
  ],
};

describe("dashboard rendering", () => {
  test("renders running and completed states", () => {
    const html = renderDashboard(snapshot, { filter: "all", expanded: new Set(["A"]) });
    expect(html).toContain("Active");
    expect(html).toContain("running");
    expect(html).toContain("hello");
    expect(html).toContain("Done");
  });

  test("filters by status", () => {
    expect(filterSnapshot(snapshot, "running").subagents.map(item => item.id)).toEqual(["A"]);
    expect(filterSnapshot(snapshot, "completed").subagents.map(item => item.id)).toEqual(["B"]);
  });
});
