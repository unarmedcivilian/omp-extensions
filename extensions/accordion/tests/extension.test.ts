import { describe, expect, test } from "bun:test";
import accordionExtension, { createAccordionExtension } from "../src/index.js";
import { detailsFromResult, getSingleHandler, makeCtx, makeFakePi, textFromResult } from "./helpers.js";

interface OpenResult {
  ok: boolean;
  surface?: string;
  error?: string;
}

interface FakeSession {
  url(): string;
  close(): Promise<void>;
  onSessionStart?(ctx: unknown): unknown;
  onBeforeAgentStart?(ctx: unknown): unknown;
  onContext?(event: unknown, ctx: unknown): unknown;
  onMessageUpdate?(event: unknown, ctx: unknown): unknown;
  onMessageEnd?(event: unknown, ctx: unknown): unknown;
  onAgentEnd?(event: unknown, ctx: unknown): unknown;
  onBeforeCompact?(event: unknown, ctx: unknown): unknown;
  requestUnfold?(codes: string[], signal?: AbortSignal): Promise<unknown>;
  requestRecall?(codes: string[], signal?: AbortSignal): Promise<unknown>;
}

function makeSession(overrides: Partial<FakeSession> = {}): FakeSession {
  return {
    url() { return "http://127.0.0.1:49152/?token=session-token"; },
    async close() {},
    onSessionStart() {},
    onBeforeAgentStart() {},
    onContext() { return undefined; },
    onMessageUpdate() {},
    onMessageEnd() {},
    onAgentEnd() {},
    onBeforeCompact() { return undefined; },
    ...overrides,
  };
}

describe("accordion extension factory", () => {
  test("default export is the installable factory", () => {
    expect(typeof accordionExtension).toBe("function");
  });

  test("registers browser-only command, tools, and lifecycle handlers", () => {
    const fake = makeFakePi();

    createAccordionExtension({ clientRoot: "tests/fixtures/client" })(fake.pi);

    expect(fake.labels).toEqual(["Accordion"]);
    expect(fake.commands.has("accordion")).toBe(true);
    expect(fake.flags.has("accordion-app")).toBe(false);
    expect(fake.tools.has("accordion_unfold")).toBe(true);
    expect(fake.tools.has("accordion_recall")).toBe(true);
    expect(fake.tools.get("accordion_unfold")?.description).toContain("{#<code> FOLDED}");
    expect(fake.tools.get("accordion_recall")?.description).toContain("{#<code> FOLDED}");

    for (const event of [
      "session_start",
      "before_agent_start",
      "context",
      "message_update",
      "message_end",
      "agent_end",
      "session_before_compact",
      "session_shutdown",
      "resources_discover",
    ]) {
      expect(fake.handlers.has(event)).toBe(true);
      expect(fake.handlers.get(event)).toHaveLength(1);
    }
  });

  test("does not double-register on the same ExtensionAPI instance", () => {
    const fake = makeFakePi();
    const install = createAccordionExtension({ clientRoot: "tests/fixtures/client" });

    install(fake.pi);
    install(fake.pi);

    expect(fake.labels).toEqual(["Accordion"]);
    expect(fake.commands.size).toBe(1);
    expect(fake.tools.size).toBe(2);
    expect(fake.handlers.get("context")).toHaveLength(1);
    expect(fake.warnings.join("\n")).toContain("already installed");
  });

  test("/accordion opens a tokenized browser URL without desktop flags or app launch", async () => {
    const opened: string[] = [];
    const session = makeSession();
    const fake = makeFakePi();

    createAccordionExtension({
      clientRoot: "tests/fixtures/client",
      createSession: async () => session,
      openBrowser: async (url: string): Promise<OpenResult> => {
        opened.push(url);
        return { ok: true, surface: "surface-1" };
      },
    })(fake.pi);

    const command = fake.commands.get("accordion");
    expect(command).toBeDefined();
    await command?.handler("", makeCtx());

    expect(opened).toEqual(["http://127.0.0.1:49152/?token=session-token"]);
    expect(fake.flags.has("accordion-app")).toBe(false);
    expect(fake.messages.join("\n")).toContain("Accordion ready");
    expect(fake.messages.join("\n")).toContain("http://127.0.0.1:49152/?token=session-token");
  });

  test("lifecycle handlers delegate to the session object and shutdown closes it", async () => {
    const calls: string[] = [];
    const session = makeSession({
      onSessionStart() { calls.push("session_start"); },
      onBeforeAgentStart() { calls.push("before_agent_start"); },
      onContext() { calls.push("context"); return { messages: [] }; },
      onMessageUpdate() { calls.push("message_update"); },
      onMessageEnd() { calls.push("message_end"); },
      onAgentEnd() { calls.push("agent_end"); },
      onBeforeCompact() { calls.push("session_before_compact"); return { cancel: false }; },
      async close() { calls.push("session_shutdown"); },
    });
    const fake = makeFakePi();

    createAccordionExtension({ clientRoot: "tests/fixtures/client", createSession: async () => session })(fake.pi);
    await fake.commands.get("accordion")?.handler("", makeCtx());

    for (const event of ["session_start", "before_agent_start", "context", "message_update", "message_end", "agent_end", "session_before_compact"]) {
      await getSingleHandler(fake, event)({}, makeCtx());
    }
    await getSingleHandler(fake, "session_shutdown")({}, makeCtx());

    expect(calls).toEqual([
      "session_start",
      "before_agent_start",
      "context",
      "message_update",
      "message_end",
      "agent_end",
      "session_before_compact",
      "session_shutdown",
    ]);
  });
});

describe("accordion tools", () => {
  test("detached unfold and recall give guidance instead of pretending content changed", async () => {
    const fake = makeFakePi();

    createAccordionExtension({ clientRoot: "tests/fixtures/client" })(fake.pi);

    const unfold = fake.tools.get("accordion_unfold");
    const recall = fake.tools.get("accordion_recall");
    const unfoldResult = await unfold?.execute?.("tool-1", { codes: ["abc123"] }, new AbortController().signal, undefined, makeCtx());
    const recallResult = await recall?.execute?.("tool-2", { codes: ["abc123"] }, new AbortController().signal, undefined, makeCtx());

    expect(textFromResult(unfoldResult)).toContain("/accordion");
    expect(textFromResult(unfoldResult)).toContain("abc123");
    expect(textFromResult(recallResult)).toContain("/accordion");
    expect(textFromResult(recallResult)).toContain("abc123");
  });

  test("attached accordion_unfold sends a browser request and reports restored and missing codes without echoing full content", async () => {
    const requested: string[][] = [];
    const session = makeSession({
      async requestUnfold(codes: string[]) {
        requested.push(codes);
        return { restored: [{ code: "abc123", title: "restored block", text: "SECRET FULL TEXT" }], missing: ["missing"] };
      },
    });
    const fake = makeFakePi();

    createAccordionExtension({ clientRoot: "tests/fixtures/client", createSession: async () => session })(fake.pi);
    await fake.commands.get("accordion")?.handler("", makeCtx());

    const result = await fake.tools.get("accordion_unfold")?.execute?.(
      "tool-1",
      { codes: ["abc123", "missing"] },
      new AbortController().signal,
      undefined,
      makeCtx(),
    );

    expect(requested).toEqual([["abc123", "missing"]]);
    expect(textFromResult(result)).toContain("restored block");
    expect(textFromResult(result)).toContain("missing");
    expect(textFromResult(result)).not.toContain("SECRET FULL TEXT");
    expect(detailsFromResult(result)).toEqual({ restored: [{ code: "abc123", title: "restored block", text: "SECRET FULL TEXT" }], missing: ["missing"] });
  });

  test("attached accordion_recall returns recalled content in the current tool result", async () => {
    const requested: string[][] = [];
    const session = makeSession({
      async requestRecall(codes: string[]) {
        requested.push(codes);
        return { restored: [{ code: "abc123", title: "block", text: "FULL RECALLED TEXT" }], missing: [] };
      },
    });
    const fake = makeFakePi();

    createAccordionExtension({ clientRoot: "tests/fixtures/client", createSession: async () => session })(fake.pi);
    await fake.commands.get("accordion")?.handler("", makeCtx());

    const result = await fake.tools.get("accordion_recall")?.execute?.(
      "tool-2",
      { codes: ["abc123"] },
      new AbortController().signal,
      undefined,
      makeCtx(),
    );

    expect(requested).toEqual([["abc123"]]);
    expect(textFromResult(result)).toContain("FULL RECALLED TEXT");
    expect(detailsFromResult(result)).toEqual({ restored: [{ code: "abc123", title: "block", text: "FULL RECALLED TEXT" }], missing: [] });
  });

  test("aborted tool calls do not leave pending browser requests", async () => {
    const signals: AbortSignal[] = [];
    const session = makeSession({
      async requestUnfold(_codes: string[], signal?: AbortSignal) {
        if (signal) signals.push(signal);
        return null;
      },
    });
    const fake = makeFakePi();
    const controller = new AbortController();

    createAccordionExtension({ clientRoot: "tests/fixtures/client", createSession: async () => session })(fake.pi);
    await fake.commands.get("accordion")?.handler("", makeCtx());
    controller.abort();

    const result = await fake.tools.get("accordion_unfold")?.execute?.(
      "tool-3",
      { codes: ["abc123"] },
      controller.signal,
      undefined,
      makeCtx(),
    );

    expect(signals).toEqual([controller.signal]);
    expect(textFromResult(result).toLowerCase()).toContain("cancel");
  });
});
