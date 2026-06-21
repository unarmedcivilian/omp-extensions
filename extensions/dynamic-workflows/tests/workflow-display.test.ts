import { describe, expect, test } from "bun:test";
import {
  createWorkflowSnapshot,
  recomputeWorkflowSnapshot,
  renderWorkflowLines,
  renderWorkflowText,
  type WorkflowAgentSnapshot,
  type WorkflowSnapshot,
} from "../src/display.js";

function makeSnapshot(overrides: Partial<WorkflowSnapshot> = {}): WorkflowSnapshot {
  const base: WorkflowSnapshot = {
    name: "demo",
    description: "Demo workflow",
    phases: [],
    agents: [],
    logs: [],
    done: 0,
    total: 0,
    status: "running",
  };
  return recomputeWorkflowSnapshot({ ...base, ...overrides });
}

function makeAgent(overrides: Partial<WorkflowAgentSnapshot> = {}): WorkflowAgentSnapshot {
  return {
    id: 1,
    label: "repo scan",
    prompt: "scan",
    status: "done",
    phase: "Scan",
    ...overrides,
  };
}

describe("workflow display", () => {
  test("createWorkflowSnapshot does not pre-render declared phases", () => {
    const value = createWorkflowSnapshot({
      name: "demo",
      description: "Demo workflow",
      phases: [{ title: "Scan" }],
    });

    expect(value.phases).toEqual([]);
  });

  test("renderWorkflowLines hides empty phase rows", () => {
    const lines = renderWorkflowLines(
      makeSnapshot({ phases: ["Scan", "Review"], agents: [makeAgent({ phase: "Scan" })] }),
    );

    expect(lines.some(line => line.includes("Scan 1/1"))).toBe(true);
    expect(lines.some(line => line.includes("Review 0/0"))).toBe(false);
  });

  test("renderWorkflowLines keeps the current empty phase visible", () => {
    const lines = renderWorkflowLines(makeSnapshot({ phases: ["Scan"], currentPhase: "Scan" }));

    expect(lines.some(line => line.includes("Scan 0/0"))).toBe(true);
  });

  test("renderWorkflowLines groups agents by phase even when phase was not pre-recorded", () => {
    const lines = renderWorkflowLines(makeSnapshot({ agents: [makeAgent({ phase: "Analyze" })] }));

    expect(lines.some(line => line.includes("Analyze 1/1"))).toBe(true);
  });

  test("renderWorkflowText respects log limits", () => {
    const text = renderWorkflowText(
      makeSnapshot({ logs: ["one", "two", "three"], agents: [makeAgent()] }),
      false,
      { maxLogs: 2 },
    );

    expect(text).toContain("two");
    expect(text).toContain("three");
    expect(text).not.toContain("log: one");
  });
});
