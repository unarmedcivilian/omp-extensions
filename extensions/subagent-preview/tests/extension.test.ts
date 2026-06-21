import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { createSubagentPreviewExtension } from "../src/index.js";

interface FakeEventBus {
  handlers: Map<string, Array<(data: unknown) => void>>;
  on(channel: string, handler: (data: unknown) => void): () => void;
}

function makeEventBus(): FakeEventBus {
  return {
    handlers: new Map(),
    on(channel, handler) {
      const list = this.handlers.get(channel) ?? [];
      list.push(handler);
      this.handlers.set(channel, list);
      return () => this.handlers.set(channel, (this.handlers.get(channel) ?? []).filter(item => item !== handler));
    },
  };
}

function makePi() {
  const events = makeEventBus();
  const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
  const commands = new Map<string, { description?: string; handler: (args: string, ctx: unknown) => unknown }>();
  const labels: string[] = [];
  const pi = {
    events,
    logger: { warn() {}, error() {}, info() {}, debug() {} },
    setLabel(label: string) { labels.push(label); },
    on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerCommand(name: string, command: { description?: string; handler: (args: string, ctx: unknown) => unknown }) {
      commands.set(name, command);
    },
  } as unknown as ExtensionAPI;
  return { pi, events, handlers, commands, labels };
}

describe("subagent preview extension", () => {
  test("registers label, lifecycle handlers, and preview command", () => {
    const fake = makePi();

    createSubagentPreviewExtension()(fake.pi);

    expect(fake.labels).toEqual(["Subagent Preview"]);
    expect(fake.commands.has("subagent-preview")).toBe(true);
    expect(fake.handlers.has("session_start")).toBe(true);
    expect(fake.handlers.has("session_switch")).toBe(true);
    expect(fake.handlers.has("session_branch")).toBe(true);
    expect(fake.handlers.has("session_tree")).toBe(true);
    expect(fake.handlers.has("session_shutdown")).toBe(true);
  });

  test("does not double-register on the same ExtensionAPI", () => {
    const fake = makePi();
    const install = createSubagentPreviewExtension();

    install(fake.pi);
    install(fake.pi);

    expect(fake.labels).toEqual(["Subagent Preview"]);
    expect(fake.handlers.get("session_start")).toHaveLength(1);
  });
});
