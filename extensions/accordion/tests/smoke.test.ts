import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import accordionExtension, { createAccordionExtension } from "../src/index.js";
import { getSingleHandler, makeCtx, makeFakePi } from "./helpers.js";

interface WireMessage {
  type?: string;
  reqId?: number | string;
  blocks?: unknown[];
}

interface ResourceDiscovery {
  skillPaths?: unknown[];
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
  if ("blocks" in raw && Array.isArray(raw.blocks)) message.blocks = raw.blocks;
  return message;
}

function connectWebSocket(url: string): Promise<WebSocket> {
  const { promise, resolve, reject } = Promise.withResolvers<WebSocket>();
  const ws = new WebSocket(url);
  ws.once("open", () => resolve(ws));
  ws.once("error", reject);
  return promise;
}

function nextJson(ws: WebSocket, type: string): Promise<WireMessage> {
  const { promise, resolve, reject } = Promise.withResolvers<WireMessage>();
  const onMessage = (data: WebSocket.RawData) => {
    try {
      const parsed = parseWireMessage(JSON.parse(data.toString()));
      if (parsed.type === type) {
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

function resourceDiscovery(value: unknown): ResourceDiscovery {
  const result: ResourceDiscovery = {};
  if (!value || typeof value !== "object") return result;
  if ("skillPaths" in value && Array.isArray(value.skillPaths)) result.skillPaths = value.skillPaths;
  return result;
}

describe("Accordion browser-only smoke coverage", () => {
  test("factory registers the browser port surface without desktop flags", () => {
    const fake = makeFakePi();

    accordionExtension(fake.pi);

    expect(fake.commands.has("accordion")).toBe(true);
    expect(fake.tools.has("accordion_unfold")).toBe(true);
    expect(fake.tools.has("accordion_recall")).toBe(true);
    expect(fake.flags.has("accordion-app")).toBe(false);
  });

  test("resources_discover exposes packaged folding and recall skills", async () => {
    const fake = makeFakePi();
    createAccordionExtension({ clientRoot: "tests/fixtures/client" })(fake.pi);

    const raw = await getSingleHandler(fake, "resources_discover")({}, makeCtx());
    const discovered = resourceDiscovery(raw);

    expect(discovered.skillPaths).toEqual(expect.arrayContaining([
      expect.stringContaining("accordion-context-folding"),
      expect.stringContaining("accordion-context-recall"),
    ]));
  });

  test("/accordion starts a tokenized browser session with static auth, WebSocket hello, plan apply, and no legacy files", async () => {
    const home = await makeTempDir("accordion-smoke-home-");
    const oldHome = process.env.HOME;
    const oldAccordionHome = process.env.ACCORDION_HOME;
    const oldAccordionAppPath = process.env.ACCORDION_APP_PATH;
    process.env.HOME = home;
    delete process.env.ACCORDION_HOME;
    delete process.env.ACCORDION_APP_PATH;

    const opened: string[] = [];
    const fake = makeFakePi();

    try {
      createAccordionExtension({
        clientRoot: "tests/fixtures/client",
        openBrowser: async (url: string) => {
          opened.push(url);
          return { ok: true, surface: "surface-1" };
        },
        requestTimeoutMs: 200,
      })(fake.pi);

      await fake.commands.get("accordion")?.handler("", makeCtx({ sessionId: "smoke-session" }));
      expect(opened).toHaveLength(1);
      expect(opened[0]).toContain("token=");

      const url = opened[0];
      const unauthenticated = await fetch(new URL("/", url));
      const meta = await fetch(new URL("/__accordion/meta", url));
      const index = await fetch(url);
      const ws = await connectWebSocket(url.replace("http://", "ws://"));
      const hello = await nextJson(ws, "hello");
      const sync = nextJson(ws, "sync");
      const context = getSingleHandler(fake, "context")(
        { messages: [{ role: "assistant", responseId: "resp-1", content: [{ type: "text", text: "FULL CONTENT" }] }] },
        makeCtx({ sessionId: "smoke-session" }),
      );
      const syncMessage = await sync;
      ws.send(JSON.stringify({
        type: "plan",
        reqId: syncMessage.reqId,
        ops: [{ id: "a:resp-1:p0", digestText: "{#smoke FOLDED} summary" }],
      }));

      expect(unauthenticated.status).toBe(403);
      expect(meta.status).toBe(200);
      expect(await meta.json()).toMatchObject({ served: true, sessionId: "smoke-session" });
      expect(index.status).toBe(200);
      expect(hello.type).toBe("hello");
      expect(syncMessage.blocks).toHaveLength(1);
      await expect(context).resolves.toEqual({
        messages: [{ role: "assistant", responseId: "resp-1", content: [{ type: "text", text: "{#smoke FOLDED} summary" }] }],
      });

      await getSingleHandler(fake, "session_shutdown")({}, makeCtx({ sessionId: "smoke-session" }));
      expect(existsSync(join(home, ".accordion", "sessions"))).toBe(false);
      expect(existsSync(join(home, ".accordion", "focus.json"))).toBe(false);
      expect(fake.flags.has("accordion-app")).toBe(false);
      ws.close();
    } finally {
      if (oldHome === undefined) delete process.env.HOME;
      else process.env.HOME = oldHome;
      if (oldAccordionHome === undefined) delete process.env.ACCORDION_HOME;
      else process.env.ACCORDION_HOME = oldAccordionHome;
      if (oldAccordionAppPath === undefined) delete process.env.ACCORDION_APP_PATH;
      else process.env.ACCORDION_APP_PATH = oldAccordionAppPath;
    }
  });
});
