import { describe, expect, test } from "bun:test";
import {
  CmuxSocketUnavailableError,
  closeCmuxSurface,
  createCmuxCliTransport,
  createCmuxRunner,
  createCmuxSocketRequester,
  createCmuxSocketTransport,
  createCmuxTransport,
  openCmuxSurface,
  parseCmuxSurfaceRef,
  type CmuxRunner,
  type CmuxTransport,
} from "../src/cmux.js";

describe("parseCmuxSurfaceRef", () => {
  test("accepts common cmux JSON shapes", () => {
    expect(parseCmuxSurfaceRef({ surface: "surface:7" })).toBe("surface:7");
    expect(parseCmuxSurfaceRef({ surface_ref: "surface:11" })).toBe("surface:11");
    expect(parseCmuxSurfaceRef({ ref: "surface:8" })).toBe("surface:8");
    expect(parseCmuxSurfaceRef({ id: "surface:9" })).toBe("surface:9");
    expect(parseCmuxSurfaceRef("surface:10")).toBe("surface:10");
  });

  test("rejects JSON without a surface ref", () => {
    expect(() => parseCmuxSurfaceRef({ pane: "pane:1" })).toThrow("cmux browser open did not return a surface ref");
  });
});

describe("cmux surface commands", () => {
  test("opens the widget URL through cmux browser open", async () => {
    const calls: string[][] = [];
    const runner: CmuxRunner = async args => {
      calls.push([...args]);
      return { stdout: JSON.stringify({ surface_ref: "surface:42" }), stderr: "", exitCode: 0 };
    };

    const surface = await openCmuxSurface("http://127.0.0.1:1234/widget/t", runner);

    expect(surface).toBe("surface:42");
    expect(calls).toEqual([["--json", "browser", "open", "http://127.0.0.1:1234/widget/t"]]);
  });

  test("closes a cmux browser surface", async () => {
    const calls: string[][] = [];
    const runner: CmuxRunner = async args => {
      calls.push([...args]);
      return { stdout: "", stderr: "", exitCode: 0 };
    };

    await closeCmuxSurface("surface:42", runner);

    expect(calls).toEqual([["close-surface", "--surface", "surface:42"]]);
  });
});


describe("cmux socket requester", () => {
  test("sends newline-delimited JSON requests to the configured socket path", async () => {
    const payloads: Array<{ payload: string; socketPath: string }> = [];
    const request = createCmuxSocketRequester(
      async (payload, socketPath) => {
        payloads.push({ payload, socketPath });
        return JSON.stringify({ id: "fixed", ok: true, result: { pong: true } });
      },
      { env: { CMUX_SOCKET_PATH: "/tmp/custom.sock" }, idFactory: () => "fixed" },
    );

    const result = await request("system.ping", {});

    expect(result).toEqual({ pong: true });
    expect(payloads).toEqual([{
      socketPath: "/tmp/custom.sock",
      payload: JSON.stringify({ id: "fixed", method: "system.ping", params: {} }) + "\n",
    }]);
  });

  test("treats socket connection failures as fallback-eligible", async () => {
    const request = createCmuxSocketRequester(
      async () => {
        const error = new Error("connect ENOENT") as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      },
      { env: { CMUX_SOCKET_PATH: "/tmp/missing.sock" }, idFactory: () => "fixed" },
    );

    await expect(request("system.ping", {})).rejects.toBeInstanceOf(CmuxSocketUnavailableError);
  });

  test("preserves application-level socket errors", async () => {
    const request = createCmuxSocketRequester(
      async () => JSON.stringify({ id: "fixed", ok: false, error: "method_not_found: Unknown method" }),
      { env: { CMUX_SOCKET_PATH: "/tmp/cmux.sock" }, idFactory: () => "fixed" },
    );

    await expect(request("browser.open", {})).rejects.toThrow("method_not_found: Unknown method");
  });
});

describe("cmux socket transport", () => {
  test("opens browser surfaces through browser.open_split", async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const transport = createCmuxSocketTransport(async (method, params) => {
      calls.push({ method, params: params ?? {} });
      return { surface_ref: "surface:42" };
    }, { env: { CMUX_WORKSPACE_ID: "workspace-uuid", CMUX_SURFACE_ID: "surface-uuid" } });

    const surface = await transport.openBrowserSurface("http://127.0.0.1:1234/widget/t");

    expect(surface).toBe("surface:42");
    expect(calls).toEqual([{
      method: "browser.open_split",
      params: {
        url: "http://127.0.0.1:1234/widget/t",
        focus: false,
        workspace_id: "workspace-uuid",
        surface_id: "surface-uuid",
      },
    }]);
  });

  test("closes surfaces through surface.close", async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const transport = createCmuxSocketTransport(async (method, params) => {
      calls.push({ method, params: params ?? {} });
      return {};
    }, { env: { CMUX_WORKSPACE_ID: "workspace-uuid" } });

    await transport.closeSurface("surface:42");

    expect(calls).toEqual([{
      method: "surface.close",
      params: { surface_id: "surface:42", workspace_id: "workspace-uuid" },
    }]);
  });
});

describe("cmux transport fallback", () => {
  test("falls back to CLI when the socket is unavailable", async () => {
    const calls: string[] = [];
    const socket: CmuxTransport = {
      async openBrowserSurface() {
        calls.push("socket.open");
        throw new CmuxSocketUnavailableError("missing socket");
      },
      async closeSurface() {
        calls.push("socket.close");
        throw new CmuxSocketUnavailableError("missing socket");
      },
    };
    const cli: CmuxTransport = {
      async openBrowserSurface() {
        calls.push("cli.open");
        return "surface:7";
      },
      async closeSurface() {
        calls.push("cli.close");
      },
    };
    const transport = createCmuxTransport({ socket, cli });

    await expect(transport.openBrowserSurface("http://127.0.0.1:1234/widget/t")).resolves.toBe("surface:7");
    await expect(transport.closeSurface("surface:7")).resolves.toBeUndefined();

    expect(calls).toEqual(["socket.open", "cli.open", "socket.close", "cli.close"]);
  });

  test("does not fall back when the socket returns an application error", async () => {
    const calls: string[] = [];
    const socket: CmuxTransport = {
      async openBrowserSurface() {
        calls.push("socket.open");
        throw new Error("method_not_found");
      },
      async closeSurface() {
        calls.push("socket.close");
      },
    };
    const cli: CmuxTransport = {
      async openBrowserSurface() {
        calls.push("cli.open");
        return "surface:7";
      },
      async closeSurface() {
        calls.push("cli.close");
      },
    };
    const transport = createCmuxTransport({ socket, cli });

    await expect(transport.openBrowserSurface("http://127.0.0.1:1234/widget/t")).rejects.toThrow("method_not_found");

    expect(calls).toEqual(["socket.open"]);
  });
});

describe("createCmuxRunner", () => {
  test("spawns cmux with provided args and captures output", async () => {
    const spawned: string[][] = [];
    const runner = createCmuxRunner(async (cmd, args) => {
      spawned.push([cmd, ...args]);
      return { stdout: "out", stderr: "err", exitCode: 3 };
    });

    const result = await runner(["browser", "open", "https://example.test"]);

    expect(spawned).toEqual([["cmux", "browser", "open", "https://example.test"]]);
    expect(result).toEqual({ stdout: "out", stderr: "err", exitCode: 3 });
  });
});
