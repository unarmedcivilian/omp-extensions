import { describe, expect, test } from "bun:test";
import { computeWebSocketUrl, installRuntime, type RuntimeSocketLike } from "../src/runtime/main.js";

class FakeSocket implements RuntimeSocketLike {
  readyState = 0;
  sent: string[] = [];
  listeners = new Map<string, Array<(event: unknown) => void>>();
  addEventListener(type: string, fn: (event: unknown) => void): void { this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]); }
  send(data: string): void { this.sent.push(data); }
  open(): void { this.readyState = 1; for (const fn of this.listeners.get("open") ?? []) fn({}); }
  message(value: unknown): void { for (const fn of this.listeners.get("message") ?? []) fn({ data: JSON.stringify(value) }); }
}

class FakeRoot {
  innerHTML = "";
  listeners = new Map<string, Array<(event: unknown) => void>>();
  addEventListener(type: string, fn: (event: unknown) => void): void { this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]); }
  click(dataset: Record<string, string>): void {
    const target = { closest: () => ({ dataset }) };
    for (const fn of this.listeners.get("click") ?? []) fn({ target });
  }
}

describe("runtime bridge", () => {
  test("computes websocket url", () => {
    expect(computeWebSocketUrl(new URL("http://127.0.0.1:1234/subagent-preview/tok"))).toBe("ws://127.0.0.1:1234/ws/tok");
  });

  test("sends ready and renders snapshots", () => {
    const socket = new FakeSocket();
    const root = { innerHTML: "" };
    installRuntime({ socket, root });
    socket.open();
    expect(socket.sent.map(JSON.parse)).toEqual([{ type: "ready" }]);
    socket.message({ type: "snapshot", snapshot: { updatedAt: 1, counts: { pending: 0, running: 0, completed: 0, failed: 0, aborted: 0 }, subagents: [] } });
    expect(root.innerHTML).toContain("No subagents");
  });

  test("dashboard controls are local and do not send socket messages", async () => {
    const socket = new FakeSocket();
    const root = new FakeRoot();
    const copied: string[] = [];
    installRuntime({ socket, root, clipboard: { writeText: async text => { copied.push(text); } } });
    socket.open();
    socket.message({
      type: "snapshot",
      snapshot: {
        updatedAt: 1,
        counts: { pending: 0, running: 1, completed: 1, failed: 0, aborted: 0 },
        subagents: [
          { id: "A", index: 0, agent: "task", agentSource: "bundled", status: "running", description: "Active", recentTools: [], recentOutput: [], toolCount: 0, tokens: 1, cost: 0, durationMs: 1, nestedTaskCount: 0, transcript: [{ kind: "assistant", text: "hello", truncated: false }], updatedAt: 2 },
          { id: "B", index: 1, agent: "task", agentSource: "bundled", status: "completed", description: "Done", recentTools: [], recentOutput: [], toolCount: 0, tokens: 0, cost: 0, durationMs: 1, nestedTaskCount: 0, transcript: [], updatedAt: 1 },
        ],
      },
    });

    root.click({ action: "filter", status: "completed" });
    expect(root.innerHTML).toContain("Done");
    expect(root.innerHTML).not.toContain("Active");
    root.click({ action: "toggle", agentId: "B" });
    root.click({ action: "copy", agentId: "B" });
    root.click({ action: "follow-active" });

    expect(copied[0]).toContain("Done");
    expect(socket.sent.map(JSON.parse)).toEqual([{ type: "ready" }]);
  });
});
