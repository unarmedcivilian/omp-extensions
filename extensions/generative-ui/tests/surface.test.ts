import { describe, expect, test } from "bun:test";
import { CmuxWidgetSurface, createCmuxWidgetOpener, LocalWidgetServer, type WidgetServerLike } from "../src/surface.js";
import type { HostToPage } from "../src/protocol.js";
import type { CmuxRunner } from "../src/cmux.js";

class FakeSocket {
  sent: string[] = [];
  closed = false;

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
  }
}

class FakeServer implements WidgetServerLike {
  registered: CmuxWidgetSurface[] = [];
  unregistered: string[] = [];

  register(surface: CmuxWidgetSurface): URL {
    this.registered.push(surface);
    return new URL(`http://127.0.0.1:4311/widget/${surface.token}`);
  }

  unregister(token: string): void {
    this.unregistered.push(token);
  }
}

describe("CmuxWidgetSurface", () => {
  test("queues host messages until a browser WebSocket attaches", () => {
    const surface = new CmuxWidgetSurface("t1", () => {});
    const msg: HostToPage = { type: "content", html: "<p>Hello</p>", final: true };

    surface.send(msg);
    const socket = new FakeSocket();
    surface.attachSocket(socket);

    expect(socket.sent.map(JSON.parse)).toEqual([msg]);
  });

  test("emits ready and routes browser messages", () => {
    const surface = new CmuxWidgetSurface("t1", () => {});
    const seen: unknown[] = [];
    let ready = false;
    surface.on("ready", () => { ready = true; });
    surface.on("message", msg => seen.push(msg));

    surface.receiveFromBrowser(JSON.stringify({ type: "ready" }));
    surface.receiveFromBrowser(JSON.stringify({ type: "rpc-call", id: "r1", method: "m", params: null }));

    expect(ready).toBe(true);
    expect(seen).toEqual([{ type: "rpc-call", id: "r1", method: "m", params: null }]);
  });
});

describe("createCmuxWidgetOpener", () => {
  test("registers a widget surface and opens its URL in cmux", async () => {
    const calls: string[][] = [];
    const runner: CmuxRunner = async args => {
      calls.push([...args]);
      return { stdout: JSON.stringify({ surface: "surface:5" }), stderr: "", exitCode: 0 };
    };
    const server = new FakeServer();
    const opener = createCmuxWidgetOpener({ server, runner, tokenFactory: () => "fixed" });

    const surface = await opener({ title: "demo", width: 800, height: 600 });

    expect(surface).toBe(server.registered[0]);
    expect(surface.surfaceRef).toBe("surface:5");
    expect(server.registered[0].title).toBe("demo");
    expect(calls).toEqual([["--json", "browser", "open", "http://127.0.0.1:4311/widget/fixed"]]);
  });

  test("unregisters and closes the cmux surface on close", async () => {
    const calls: string[][] = [];
    const runner: CmuxRunner = async args => {
      calls.push([...args]);
      if (args[0] === "--json") return { stdout: JSON.stringify({ surface: "surface:5" }), stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "", exitCode: 0 };
    };
    const server = new FakeServer();
    const opener = createCmuxWidgetOpener({ server, runner, tokenFactory: () => "fixed" });
    const surface = await opener({ title: "demo", width: 800, height: 600 });

    surface.close();
    await Promise.resolve();

    expect(server.unregistered).toEqual(["fixed"]);
    expect(calls.at(-1)).toEqual(["close-surface", "--surface", "surface:5"]);
  });

  test("does not ask cmux to close a surface after the browser websocket closes", async () => {
    const calls: string[][] = [];
    const runner: CmuxRunner = async args => {
      calls.push([...args]);
      return { stdout: JSON.stringify({ surface: "surface:5" }), stderr: "", exitCode: 0 };
    };
    const server = new LocalWidgetServer("runtime");
    const opener = createCmuxWidgetOpener({ server, runner, tokenFactory: () => "fixed" });

    try {
      const surface = await opener({ title: "demo", width: 800, height: 600 });
      const closed = Promise.withResolvers<void>();
      surface.once("closed", () => closed.resolve());
      const ws = new WebSocket(new URL("/ws/fixed", server.baseUrl));
      await new Promise<void>(resolve => ws.addEventListener("open", () => resolve(), { once: true }));

      ws.close();
      await closed.promise;

      expect(calls).toHaveLength(1);
      expect(calls[0]?.slice(0, 3)).toEqual(["--json", "browser", "open"]);
      expect(calls[0]?.[3]).toEndWith("/widget/fixed");
    } finally {
      server.close();
    }
  });
});
