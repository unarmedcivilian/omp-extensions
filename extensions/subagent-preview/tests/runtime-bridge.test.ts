import { describe, expect, test } from "bun:test";
import { computeWebSocketUrl, installRuntime, type RuntimeSocketLike } from "../src/runtime/main.js";
import { RUNTIME_HTML } from "../src/runtime.bundle.js";

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

class ScrollResettingRoot {
  private html = "";
  listeners = new Map<string, Array<(event: unknown) => void>>();
  listenerOptions = new Map<string, unknown[]>();
  renderCount = 0;
  activeScrolls = 0;
  followPressed = "false";
  focusedKey: string | undefined;
  activeElement = { getAttribute: (name: string) => name === "data-focus-key" ? "copy:A" : null };
  focusTarget = { getAttribute: (name: string) => name === "data-focus-key" ? "copy:A" : null, focus: () => { this.focusedKey = "copy:A"; } };
  followState = { textContent: "Off" };
  followToggle = {
    setAttribute: (name: string, value: string) => {
      if (name === "aria-pressed") this.followPressed = value;
    },
    classList: { toggle: () => {} },
    querySelector: (selector: string) => selector === ".follow-state" ? this.followState : null,
  };
  activeCard = { scrollIntoView: () => { this.activeScrolls += 1; } };
  nextScrollHeight = 400;
  ownerDocument = { activeElement: this.activeElement };
  transcript = {
    scrollTop: 0,
    scrollHeight: 400,
    getAttribute: (name: string) => name === "data-scroll-key" ? "transcript:A" : null,
    closest: (selector: string) => selector === "[data-scroll-key]" ? this.transcript : null,
  };
  get innerHTML(): string { return this.html; }
  set innerHTML(value: string) {
    this.renderCount += 1;
    this.html = value;
    this.transcript.scrollTop = 0;
    this.transcript.scrollHeight = this.nextScrollHeight;
  }
  addEventListener(type: string, fn: (event: unknown) => void, options?: unknown): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
    this.listenerOptions.set(type, [...(this.listenerOptions.get(type) ?? []), options]);
  }
  click(dataset: Record<string, string>): void {
    const target = { closest: () => ({ dataset }) };
    for (const fn of this.listeners.get("click") ?? []) fn({ target });
  }
  dispatch(type: string, target: unknown = this.transcript): void {
    for (const fn of this.listeners.get(type) ?? []) fn({ target });
  }
  querySelector(selector: string): typeof this.followToggle | typeof this.activeCard | null {
    if (selector === '[data-action="follow-active"]') return this.followToggle;
    if (selector.includes(".agent")) return this.activeCard;
    return null;
  }
  querySelectorAll(selector: string): Array<typeof this.transcript | typeof this.focusTarget> {
    if (selector === "[data-scroll-key]") return [this.transcript];
    if (selector === "[data-focus-key]") return [this.focusTarget];
    return [];
  }
}

describe("runtime bridge", () => {
  test("serves a browser-executable inline runtime script", () => {
    const script = RUNTIME_HTML.match(/<script>([\s\S]*)<\/script>/)?.[1] ?? "";
    expect(script.length).toBeGreaterThan(0);
    expect(() => new Function(script)).not.toThrow();
  });
  test("uses system color fallbacks for dark surfaces", () => {
    const style = RUNTIME_HTML.match(/<style>([\s\S]*)<\/style>/)?.[1] ?? "";
    expect(style).toContain("CanvasText");
    expect(style).not.toContain("#111");
    expect(style).not.toContain("#666");
  });


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

    expect(root.innerHTML).toContain("hello");

    root.click({ action: "filter", status: "completed" });
    expect(root.innerHTML).toContain("Done");
    expect(root.innerHTML).not.toContain("Active");
    root.click({ action: "toggle", agentId: "B" });
    root.click({ action: "copy", agentId: "B" });
    root.click({ action: "follow-active" });

    expect(copied[0]).toContain("Done");
    expect(socket.sent.map(JSON.parse)).toEqual([{ type: "ready" }]);
  });

  test("pending agents expand without forcing scroll by default", () => {
    const socket = new FakeSocket();
    const queried: string[] = [];
    const root = {
      innerHTML: "",
      querySelector(selector: string) {
        queried.push(selector);
        return { scrollIntoView() {} };
      },
    };
    installRuntime({ socket, root });
    queried.length = 0;
    socket.message({
      type: "snapshot",
      snapshot: {
        updatedAt: 1,
        counts: { pending: 1, running: 0, completed: 0, failed: 0, aborted: 0 },
        subagents: [
          { id: "P", index: 0, agent: "task", agentSource: "bundled", status: "pending", description: "Queued", recentTools: [], recentOutput: [], toolCount: 0, tokens: 0, cost: 0, durationMs: 0, nestedTaskCount: 0, transcript: [{ kind: "assistant", text: "queued details", truncated: false }], updatedAt: 1 },
        ],
      },
    });

    expect(root.innerHTML).toContain("queued details");
    expect(queried).toEqual([]);
  });

  test("follow active scrolls to active agent cards only", () => {
    const socket = new FakeSocket();
    const queried: string[] = [];
    const root = new FakeRoot() as FakeRoot & { querySelector(selector: string): { scrollIntoView(): void } };
    root.querySelector = (selector: string) => {
      queried.push(selector);
      return { scrollIntoView() {} };
    };
    installRuntime({ socket, root });
    root.click({ action: "follow-active" });
    queried.length = 0;
    socket.message({
      type: "snapshot",
      snapshot: {
        updatedAt: 1,
        counts: { pending: 1, running: 0, completed: 0, failed: 0, aborted: 0 },
        subagents: [
          { id: "P", index: 0, agent: "task", agentSource: "bundled", status: "pending", description: "Queued", recentTools: [], recentOutput: [], toolCount: 0, tokens: 0, cost: 0, durationMs: 0, nestedTaskCount: 0, transcript: [{ kind: "assistant", text: "queued details", truncated: false }], updatedAt: 1 },
        ],
      },
    });

    expect(queried.at(-1)).toBe('.agent[data-status="pending"],.agent[data-status="running"]');
  });

  test("does not auto-scroll when no active agent card is rendered", () => {
    const socket = new FakeSocket();
    const queried: string[] = [];
    let scrolled = 0;
    const root = {
      innerHTML: "",
      querySelector(selector: string) {
        queried.push(selector);
        return selector.includes(".agent") ? null : { scrollIntoView() { scrolled += 1; } };
      },
    };
    installRuntime({ socket, root });
    queried.length = 0;
    scrolled = 0;
    socket.message({
      type: "snapshot",
      snapshot: {
        updatedAt: 1,
        counts: { pending: 0, running: 0, completed: 1, failed: 0, aborted: 0 },
        subagents: [
          { id: "C", index: 0, agent: "task", agentSource: "bundled", status: "completed", description: "Done", recentTools: [], recentOutput: [], toolCount: 0, tokens: 0, cost: 0, durationMs: 1, nestedTaskCount: 0, transcript: [{ kind: "assistant", text: "done details", truncated: false }], updatedAt: 1 },
        ],
      },
    });

    expect(root.innerHTML).toContain("Done");
    expect(queried).toEqual([]);
    expect(scrolled).toBe(0);
  });
  test("keeps an auto-expanded transcript visible after completion", () => {
    const socket = new FakeSocket();
    const root = { innerHTML: "" };
    installRuntime({ socket, root });
    socket.message({
      type: "snapshot",
      snapshot: {
        updatedAt: 1,
        counts: { pending: 0, running: 1, completed: 0, failed: 0, aborted: 0 },
        subagents: [
          { id: "A", index: 0, agent: "task", agentSource: "bundled", status: "running", description: "Active", recentTools: [], recentOutput: [], toolCount: 0, tokens: 1, cost: 0, durationMs: 1, nestedTaskCount: 0, transcript: [{ kind: "assistant", text: "running details", truncated: false }], updatedAt: 1 },
        ],
      },
    });
    expect(root.innerHTML).toContain("running details");

    socket.message({
      type: "snapshot",
      snapshot: {
        updatedAt: 2,
        counts: { pending: 0, running: 0, completed: 1, failed: 0, aborted: 0 },
        subagents: [
          { id: "A", index: 0, agent: "task", agentSource: "bundled", status: "completed", description: "Active", recentTools: [], recentOutput: [], toolCount: 0, tokens: 1, cost: 0, durationMs: 2, nestedTaskCount: 0, transcript: [{ kind: "assistant", text: "final details", truncated: false }], updatedAt: 2 },
        ],
      },
    });
    expect(root.innerHTML).toContain("final details");
  });

  test("preserves transcript scroll position across live snapshot renders", () => {
    const socket = new FakeSocket();
    const root = new ScrollResettingRoot();
    installRuntime({ socket, root });
    socket.message({
      type: "snapshot",
      snapshot: {
        updatedAt: 1,
        counts: { pending: 0, running: 1, completed: 0, failed: 0, aborted: 0 },
        subagents: [
          { id: "A", index: 0, agent: "task", agentSource: "bundled", status: "running", description: "Active", recentTools: [], recentOutput: [], toolCount: 0, tokens: 1, cost: 0, durationMs: 1, nestedTaskCount: 0, transcript: [{ kind: "assistant", text: "line one", truncated: false }], updatedAt: 1 },
        ],
      },
    });
    root.transcript.scrollTop = 137;

    socket.message({
      type: "snapshot",
      snapshot: {
        updatedAt: 2,
        counts: { pending: 0, running: 1, completed: 0, failed: 0, aborted: 0 },
        subagents: [
          { id: "A", index: 0, agent: "task", agentSource: "bundled", status: "running", description: "Active", recentTools: [], recentOutput: [], toolCount: 0, tokens: 1, cost: 0, durationMs: 2, nestedTaskCount: 0, transcript: [{ kind: "assistant", text: "line one\nline two", truncated: false }], updatedAt: 2 },
        ],
      },
    });

    expect(root.transcript.scrollTop).toBe(137);
  });

  test("keeps transcript viewport anchored when newest content prepends", () => {
    const socket = new FakeSocket();
    const root = new ScrollResettingRoot();
    installRuntime({ socket, root });
    socket.message({
      type: "snapshot",
      snapshot: {
        updatedAt: 1,
        counts: { pending: 0, running: 1, completed: 0, failed: 0, aborted: 0 },
        subagents: [
          { id: "A", index: 0, agent: "task", agentSource: "bundled", status: "running", description: "Active", recentTools: [], recentOutput: [], toolCount: 0, tokens: 1, cost: 0, durationMs: 1, nestedTaskCount: 0, transcript: [{ kind: "assistant", text: "older", truncated: false }], updatedAt: 1 },
        ],
      },
    });
    root.transcript.scrollTop = 120;
    root.transcript.scrollHeight = 500;
    root.nextScrollHeight = 560;

    socket.message({
      type: "snapshot",
      snapshot: {
        updatedAt: 2,
        counts: { pending: 0, running: 1, completed: 0, failed: 0, aborted: 0 },
        subagents: [
          { id: "A", index: 0, agent: "task", agentSource: "bundled", status: "running", description: "Active", recentTools: [], recentOutput: [], toolCount: 0, tokens: 1, cost: 0, durationMs: 2, nestedTaskCount: 0, transcript: [{ kind: "assistant", text: "newer\nolder", truncated: false }], updatedAt: 2 },
        ],
      },
    });

    expect(root.transcript.scrollTop).toBe(180);
  });

  test("manual transcript scroll disables follow active auto-jumps", () => {
    const socket = new FakeSocket();
    const root = new ScrollResettingRoot();
    installRuntime({ socket, root });
    root.click({ action: "follow-active" });
    socket.message({
      type: "snapshot",
      snapshot: {
        updatedAt: 1,
        counts: { pending: 0, running: 1, completed: 0, failed: 0, aborted: 0 },
        subagents: [
          { id: "A", index: 0, agent: "task", agentSource: "bundled", status: "running", description: "Active", recentTools: [], recentOutput: [], toolCount: 0, tokens: 1, cost: 0, durationMs: 1, nestedTaskCount: 0, transcript: [{ kind: "assistant", text: "line one", truncated: false }], updatedAt: 1 },
        ],
      },
    });
    expect(root.activeScrolls).toBe(1);

    root.activeScrolls = 0;
    root.followPressed = "true";
    root.followState.textContent = "On";
    const renderCount = root.renderCount;
    root.dispatch("wheel");
    expect(root.renderCount).toBe(renderCount);
    expect(root.followPressed).toBe("false");
    expect(root.followState.textContent).toBe("Off");
    socket.message({
      type: "snapshot",
      snapshot: {
        updatedAt: 2,
        counts: { pending: 0, running: 1, completed: 0, failed: 0, aborted: 0 },
        subagents: [
          { id: "A", index: 0, agent: "task", agentSource: "bundled", status: "running", description: "Active", recentTools: [], recentOutput: [], toolCount: 0, tokens: 1, cost: 0, durationMs: 2, nestedTaskCount: 0, transcript: [{ kind: "assistant", text: "line one\nline two", truncated: false }], updatedAt: 2 },
        ],
      },
    });

    expect(root.activeScrolls).toBe(0);
  });

  test("all manual transcript intent events disable follow active in capture", () => {
    for (const eventType of ["touchstart", "pointerdown", "keydown"]) {
      const socket = new FakeSocket();
      const root = new ScrollResettingRoot();
      installRuntime({ socket, root });
      expect(root.listenerOptions.get(eventType)).toContain(true);
      root.click({ action: "follow-active" });
      socket.message({
        type: "snapshot",
        snapshot: {
          updatedAt: 1,
          counts: { pending: 0, running: 1, completed: 0, failed: 0, aborted: 0 },
          subagents: [
            { id: "A", index: 0, agent: "task", agentSource: "bundled", status: "running", description: "Active", recentTools: [], recentOutput: [], toolCount: 0, tokens: 1, cost: 0, durationMs: 1, nestedTaskCount: 0, transcript: [{ kind: "assistant", text: "line one", truncated: false }], updatedAt: 1 },
          ],
        },
      });
      expect(root.activeScrolls).toBe(1);
      const renderCount = root.renderCount;
      root.activeScrolls = 0;
      root.followPressed = "true";
      root.followState.textContent = "On";

      root.dispatch(eventType);
      expect(root.renderCount).toBe(renderCount);
      expect(root.followPressed).toBe("false");
      expect(root.followState.textContent).toBe("Off");
      socket.message({
        type: "snapshot",
        snapshot: {
          updatedAt: 2,
          counts: { pending: 0, running: 1, completed: 0, failed: 0, aborted: 0 },
          subagents: [
            { id: "A", index: 0, agent: "task", agentSource: "bundled", status: "running", description: "Active", recentTools: [], recentOutput: [], toolCount: 0, tokens: 1, cost: 0, durationMs: 2, nestedTaskCount: 0, transcript: [{ kind: "assistant", text: "line two", truncated: false }], updatedAt: 2 },
          ],
        },
      });
      expect(root.activeScrolls).toBe(0);
    }
  });


  test("restores focused controls across live snapshot renders", () => {
    const socket = new FakeSocket();
    const root = new ScrollResettingRoot();
    installRuntime({ socket, root });
    socket.message({
      type: "snapshot",
      snapshot: {
        updatedAt: 1,
        counts: { pending: 0, running: 1, completed: 0, failed: 0, aborted: 0 },
        subagents: [
          { id: "A", index: 0, agent: "task", agentSource: "bundled", status: "running", description: "Active", recentTools: [], recentOutput: [], toolCount: 0, tokens: 1, cost: 0, durationMs: 1, nestedTaskCount: 0, transcript: [{ kind: "assistant", text: "line one", truncated: false }], updatedAt: 1 },
        ],
      },
    });
    root.focusedKey = undefined;

    socket.message({
      type: "snapshot",
      snapshot: {
        updatedAt: 2,
        counts: { pending: 0, running: 1, completed: 0, failed: 0, aborted: 0 },
        subagents: [
          { id: "A", index: 0, agent: "task", agentSource: "bundled", status: "running", description: "Active", recentTools: [], recentOutput: [], toolCount: 0, tokens: 1, cost: 0, durationMs: 2, nestedTaskCount: 0, transcript: [{ kind: "assistant", text: "line two", truncated: false }], updatedAt: 2 },
        ],
      },
    });

    expect(root.focusedKey).toBe("copy:A");
  });
});
