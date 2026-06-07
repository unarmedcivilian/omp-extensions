import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { WidgetSession, type WidgetSurfaceLike } from "../src/session.js";
import type { HostToPage } from "../src/protocol.js";

class FakeSurface extends EventEmitter implements WidgetSurfaceLike {
  sent: HostToPage[] = [];
  closed = false;

  send(msg: HostToPage): void {
    this.sent.push(msg);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.emit("closed");
  }
}

function contentMessages(surface: FakeSurface): Array<{ html: string; final: boolean }> {
  return surface.sent
    .filter((msg): msg is Extract<HostToPage, { type: "content" }> => msg.type === "content")
    .map(({ html, final }) => ({ html, final }));
}

async function waitForDebounce(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, 170);
  await promise;
  await Promise.resolve();
}

describe("WidgetSession", () => {
  test("waits for browser ready before flushing debounced chunks", async () => {
    const surface = new FakeSurface();
    const session = new WidgetSession(surface);

    session.onChunk("<div>".padEnd(40, "."));
    await waitForDebounce();

    expect(contentMessages(surface)).toEqual([]);

    surface.emit("ready");
    await Promise.resolve();

    expect(contentMessages(surface)).toEqual([{ html: "<div>".padEnd(40, "."), final: false }]);
  });

  test("keeps one pending pre-ready partial flush", async () => {
    const surface = new FakeSurface();
    const session = new WidgetSession(surface);

    session.onChunk("<p>first</p>".padEnd(40, "."));
    await waitForDebounce();
    session.onChunk("<p>second</p>".padEnd(40, "."));
    await waitForDebounce();
    session.onChunk("<p>third</p>".padEnd(40, "."));
    await waitForDebounce();

    expect(contentMessages(surface)).toEqual([]);

    surface.emit("ready");
    await Promise.resolve();

    expect(contentMessages(surface)).toEqual([{ html: "<p>third</p>".padEnd(40, "."), final: false }]);
  });


  test("closing before ready settles a pending final flush", async () => {
    const surface = new FakeSurface();
    const session = new WidgetSession(surface);
    const completed = Promise.withResolvers<boolean>();

    void session.onComplete("<p>final</p>").then(() => completed.resolve(true));
    await Promise.resolve();

    session.close();

    const result = await Promise.race([
      completed.promise,
      new Promise<boolean>(resolve => setTimeout(() => resolve(false), 20)),
    ]);

    expect(result).toBe(true);
    expect(contentMessages(surface)).toEqual([]);
  });
  test("coalesces rapid chunks and sends only the latest partial", async () => {
    const surface = new FakeSurface();
    const session = new WidgetSession(surface);
    surface.emit("ready");

    session.onChunk("<p>first</p>".padEnd(40, "."));
    session.onChunk("<p>second</p>".padEnd(40, "."));
    await waitForDebounce();

    expect(contentMessages(surface)).toEqual([{ html: "<p>second</p>".padEnd(40, "."), final: false }]);
  });

  test("final content cancels pending debounce and can update again", async () => {
    const surface = new FakeSurface();
    const session = new WidgetSession(surface);
    surface.emit("ready");

    session.onChunk("<div>partial</div>".padEnd(40, "."));
    await session.onComplete("<div>final</div>");
    await session.onComplete("<div>second final</div>");
    await waitForDebounce();

    expect(contentMessages(surface)).toEqual([
      { html: "<div>final</div>", final: true },
      { html: "<div>second final</div>", final: true },
    ]);
  });

  test("routes RPC calls to registered handlers", () => {
    const surface = new FakeSurface();
    const session = new WidgetSession(surface);
    session.rpc.handle("echo", params => ({ params }));

    surface.emit("message", { type: "rpc-call", id: "r1", method: "echo", params: { ok: true } });

    expect(surface.sent).toContainEqual({ type: "rpc-result", id: "r1", ok: true, value: { params: { ok: true } } });
  });
});
