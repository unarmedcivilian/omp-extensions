import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { AccordionSession } from "../src/session.js";
import { makeCtx } from "./helpers.js";

interface WireMessage {
  type?: string;
  reqId?: number | string;
  sessionId?: string;
  protocolVersion?: number;
  blocks?: unknown[];
}

interface TextPart {
  type: "text";
  text: string;
}

interface PiMessage {
  role: "user" | "assistant" | "tool";
  responseId?: string;
  content: string | TextPart[];
}

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map(dir => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

async function makeTempDir(prefix: string) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function parseWireMessage(raw: unknown): WireMessage {
  const message: WireMessage = {};
  if (!raw || typeof raw !== "object") return message;
  if ("type" in raw && typeof raw.type === "string") message.type = raw.type;
  if ("reqId" in raw && (typeof raw.reqId === "number" || typeof raw.reqId === "string")) message.reqId = raw.reqId;
  if ("sessionId" in raw && typeof raw.sessionId === "string") message.sessionId = raw.sessionId;
  if ("protocolVersion" in raw && typeof raw.protocolVersion === "number") message.protocolVersion = raw.protocolVersion;
  if ("blocks" in raw && Array.isArray(raw.blocks)) message.blocks = raw.blocks;
  return message;
}

function connectWebSocket(url: string, cookie?: string): Promise<WebSocket> {
  const { promise, resolve, reject } = Promise.withResolvers<WebSocket>();
  const options = cookie ? { headers: { cookie } } : undefined;
  const ws = new WebSocket(url, options);
  ws.once("open", () => resolve(ws));
  ws.once("error", reject);
  return promise;
}

function nextJson(ws: WebSocket, type?: string): Promise<WireMessage> {
  const { promise, resolve, reject } = Promise.withResolvers<WireMessage>();
  const onMessage = (data: WebSocket.RawData) => {
    try {
      const parsed = parseWireMessage(JSON.parse(data.toString()));
      if (!type || parsed.type === type) {
        ws.off("message", onMessage);
        ws.off("error", onError);
        resolve(parsed);
      }
    } catch (error) {
      ws.off("message", onMessage);
      ws.off("error", onError);
      reject(error);
    }
  };
  const onError = (error: Error) => {
    ws.off("message", onMessage);
    ws.off("error", onError);
    reject(error);
  };
  ws.on("message", onMessage);
  ws.once("error", onError);
  return promise;
}

function closeEvent(ws: WebSocket): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  ws.once("close", () => resolve());
  return promise;
}

function assistantText(id: string, text: string): PiMessage {
  return { role: "assistant", responseId: id, content: [{ type: "text", text }] };
}

function firstText(messages: PiMessage[]): string | undefined {
  const content = messages[0]?.content;
  if (!Array.isArray(content)) return undefined;
  const [part] = content;
  return part?.text;
}

describe("AccordionSession browser loop", () => {
  test("passes context through when no browser is attached", async () => {
    const session = await AccordionSession.create({ clientRoot: "tests/fixtures/client" });
    try {
      const result = await session.onContext({ messages: [assistantText("resp-1", "hello")] }, makeCtx());

      expect(result).toBeUndefined();
    } finally {
      await session.close();
    }
  });

  test("rejects unauthenticated WebSocket connections before they become active", async () => {
    const session = await AccordionSession.create({ clientRoot: "tests/fixtures/client" });
    try {
      const url = new URL(session.url());
      url.search = "";
      const ws = new WebSocket(url.toString());

      await closeEvent(ws);
      const result = await session.onContext({ messages: [assistantText("resp-1", "hello")] }, makeCtx());

      expect(result).toBeUndefined();
    } finally {
      await session.close();
    }
  });

  test("accepts WebSocket authentication by query token", async () => {
    const session = await AccordionSession.create({ clientRoot: "tests/fixtures/client" });
    try {
      const ws = await connectWebSocket(session.url());
      const hello = await nextJson(ws, "hello");

      expect(hello.type).toBe("hello");
      expect(hello.sessionId).toBeTruthy();
      expect(hello.protocolVersion).toBeGreaterThan(0);
      ws.close();
    } finally {
      await session.close();
    }
  });

  test("accepts WebSocket authentication by accordion_token cookie", async () => {
    const session = await AccordionSession.create({ clientRoot: "tests/fixtures/client" });
    try {
      const url = new URL(session.url());
      const token = url.searchParams.get("token");
      url.search = "";
      const ws = await connectWebSocket(url.toString(), `accordion_token=${token}`);
      const hello = await nextJson(ws, "hello");

      expect(hello.type).toBe("hello");
      ws.close();
    } finally {
      await session.close();
    }
  });

  test("session_before_compact cancellation is scoped to an attached browser", async () => {
    const session = await AccordionSession.create({ clientRoot: "tests/fixtures/client" });
    try {
      expect(session.onBeforeCompact()).toBeUndefined();

      const ws = await connectWebSocket(session.url());
      await nextJson(ws, "hello");
      expect(session.onBeforeCompact()).toEqual({ cancel: true });

      await session.close();
      expect(session.onBeforeCompact()).toBeUndefined();
    } finally {
      await session.close();
    }
  });

  test("sends fresh context blocks and applies a non-empty returned plan", async () => {
    const session = await AccordionSession.create({ clientRoot: "tests/fixtures/client", requestTimeoutMs: 200 });
    try {
      const ws = await connectWebSocket(session.url());
      await nextJson(ws, "hello");
      const sync = nextJson(ws, "sync");
      const context = session.onContext({ messages: [assistantText("resp-1", "FULL CONTENT")] }, makeCtx());
      const syncMessage = await sync;

      expect(syncMessage.blocks).toHaveLength(1);
      ws.send(JSON.stringify({
        type: "plan",
        reqId: syncMessage.reqId,
        ops: [{ id: "a:resp-1:p0", digestText: "{#abc123 FOLDED} summary" }],
      }));

      const result = await context;

      expect(result).toEqual({ messages: [{ role: "assistant", responseId: "resp-1", content: [{ type: "text", text: "{#abc123 FOLDED} summary" }] }] });
      ws.close();
    } finally {
      await session.close();
    }
  });

  test("times out to passthrough when a browser does not answer the context plan request", async () => {
    const session = await AccordionSession.create({ clientRoot: "tests/fixtures/client", requestTimeoutMs: 1 });
    try {
      const ws = await connectWebSocket(session.url());
      await nextJson(ws, "hello");
      const result = await session.onContext({ messages: [assistantText("resp-1", "FULL CONTENT")] }, makeCtx());

      expect(result).toBeUndefined();
      ws.close();
    } finally {
      await session.close();
    }
  });

  test("cleanup resolves a pending context request as passthrough", async () => {
    const session = await AccordionSession.create({ clientRoot: "tests/fixtures/client", requestTimeoutMs: 60_000 });
    const ws = await connectWebSocket(session.url());
    await nextJson(ws, "hello");
    const pending = session.onContext({ messages: [assistantText("resp-1", "FULL CONTENT")] }, makeCtx());

    await session.close();
    const result = await pending;

    expect(result).toBeUndefined();
    expect(ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING).toBe(true);
  });

  test("does not write legacy registry or focus files while serving a browser session", async () => {
    const home = await makeTempDir("accordion-home-");
    const oldHome = process.env.HOME;
    const oldAccordionHome = process.env.ACCORDION_HOME;
    const oldAccordionAppPath = process.env.ACCORDION_APP_PATH;
    process.env.HOME = home;
    delete process.env.ACCORDION_HOME;
    delete process.env.ACCORDION_APP_PATH;

    try {
      const session = await AccordionSession.create({ clientRoot: "tests/fixtures/client" });
      try {
        const meta = await fetch(new URL("/__accordion/meta", session.url()));
        await session.onContext({ messages: [assistantText("resp-1", "hello")] }, makeCtx());
        expect(meta.status).toBe(200);
      } finally {
        await session.close();
      }

      expect(existsSync(join(home, ".accordion", "sessions"))).toBe(false);
      expect(existsSync(join(home, ".accordion", "focus.json"))).toBe(false);
    } finally {
      if (oldHome === undefined) delete process.env.HOME;
      else process.env.HOME = oldHome;
      if (oldAccordionHome === undefined) delete process.env.ACCORDION_HOME;
      else process.env.ACCORDION_HOME = oldAccordionHome;
      if (oldAccordionAppPath === undefined) delete process.env.ACCORDION_APP_PATH;
      else process.env.ACCORDION_APP_PATH = oldAccordionAppPath;
    }
  });

  test("request helpers clean up pending unfold and recall requests on abort", async () => {
    const session = await AccordionSession.create({ clientRoot: "tests/fixtures/client", unfoldTimeoutMs: 60_000, recallTimeoutMs: 60_000 });
    try {
      const ws = await connectWebSocket(session.url());
      await nextJson(ws, "hello");
      const unfoldController = new AbortController();
      const recallController = new AbortController();
      const unfold = session.requestUnfold(["abc123"], unfoldController.signal);
      const recall = session.requestRecall(["abc123"], recallController.signal);

      unfoldController.abort();
      recallController.abort();

      expect(await unfold).toBeNull();
      expect(await recall).toBeNull();
      ws.close();
    } finally {
      await session.close();
    }
  });
});
