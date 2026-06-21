import { describe, expect, test } from "bun:test";
import { WorkflowAgent, type WorkflowAgentSdk } from "../src/agent.js";

interface CapturedSdkOptions {
  cwd?: string;
  agentDir?: string;
  sessionManager?: unknown;
  customTools?: unknown[];
  outputSchema?: unknown;
  requireYieldTool?: boolean;
}

interface FakeSession {
  messages: unknown[];
  prompts: string[];
  aborts: number;
  disposals: number;
  prompt(input: string): Promise<void>;
  abort(): Promise<void>;
  dispose(): Promise<void>;
}

function createFakeSession(messages: unknown[]): FakeSession {
  return {
    messages,
    prompts: [],
    aborts: 0,
    disposals: 0,
    async prompt(input: string) {
      this.prompts.push(input);
    },
    async abort() {
      this.aborts += 1;
    },
    async dispose() {
      this.disposals += 1;
    },
  };
}

function createFakeSdk(session: FakeSession, captured: { options?: CapturedSdkOptions; inMemoryCwd?: string }): WorkflowAgentSdk {
  return {
    getAgentDir() {
      return "/agent-dir";
    },
    SessionManager: {
      inMemory(cwd?: string) {
        captured.inMemoryCwd = cwd;
        return { kind: "in-memory", cwd } as never;
      },
    },
    async createAgentSession(options) {
      captured.options = options as CapturedSdkOptions;
      return { session } as never;
    },
  };
}

describe("WorkflowAgent", () => {
  test("wires structured output through OMP yield", async () => {
    const session = createFakeSession([
      {
        role: "toolResult",
        toolName: "yield",
        isError: false,
        details: { status: "success", data: { ok: true } },
      },
    ]);
    const captured: { options?: CapturedSdkOptions; inMemoryCwd?: string } = {};
    const schema = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] };
    const agent = new WorkflowAgent({ cwd: "/repo", sdk: createFakeSdk(session, captured) });

    const result = await agent.run("collect facts", { label: "facts", schema });

    expect(result).toEqual({ ok: true });
    expect(captured.inMemoryCwd).toBe("/repo");
    expect(captured.options).toMatchObject({
      cwd: "/repo",
      agentDir: "/agent-dir",
      outputSchema: schema,
      requireYieldTool: true,
    });
    expect(session.prompts[0]).toContain("Task label: facts");
    expect(session.prompts[0]).toContain("yield tool");
    expect(session.disposals).toBe(1);
  });

  test("fails schema mode when yield was not called", async () => {
    const session = createFakeSession([
      { role: "assistant", content: [{ type: "text", text: "done" }] },
    ]);
    const captured: { options?: CapturedSdkOptions; inMemoryCwd?: string } = {};
    const agent = new WorkflowAgent({ cwd: "/repo", sdk: createFakeSdk(session, captured) });

    await expect(agent.run("collect facts", { schema: { type: "object" } })).rejects.toThrow(/without calling yield/);
    expect(session.disposals).toBe(1);
  });

  test("surfaces aborted yield errors", async () => {
    const session = createFakeSession([
      {
        role: "toolResult",
        toolName: "yield",
        isError: false,
        details: { status: "aborted", error: "not enough data" },
      },
    ]);
    const captured: { options?: CapturedSdkOptions; inMemoryCwd?: string } = {};
    const agent = new WorkflowAgent({ cwd: "/repo", sdk: createFakeSdk(session, captured) });

    await expect(agent.run("collect facts", { schema: { type: "object" } })).rejects.toThrow("not enough data");
    expect(session.disposals).toBe(1);
  });

  test("returns the last assistant text without schema mode", async () => {
    const session = createFakeSession([
      { role: "assistant", content: [{ type: "text", text: "first" }] },
      { role: "assistant", content: [{ type: "text", text: "final" }] },
    ]);
    const captured: { options?: CapturedSdkOptions; inMemoryCwd?: string } = {};
    const agent = new WorkflowAgent({ cwd: "/repo", sdk: createFakeSdk(session, captured) });

    const result = await agent.run("summarize");

    expect(result).toBe("final");
    expect(captured.options?.requireYieldTool).toBe(false);
    expect(session.disposals).toBe(1);
  });
});
