import { describe, expect, test } from "bun:test";
import {
  CmuxSocketUnavailableError,
  createCmuxBrowserAutomation,
  createCmuxCliBrowserAutomation,
  createCmuxSocketBrowserAutomation,
  createCmuxSocketRequester,
  parseCmuxSurfaceRef,
  type BrowserRpcRequester,
  type CmuxRunner,
  type CmuxBrowserAutomation,
} from "../src/cmux.js";

describe("cmux browser socket automation", () => {
  test("sends newline-delimited socket requests", async () => {
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

  test("opens browser surfaces through browser.open_split with caller anchors", async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const request: BrowserRpcRequester = async (method, params) => {
      calls.push({ method, params: params ?? {} });
      return { surface_ref: "surface:7" };
    };
    const browser = createCmuxSocketBrowserAutomation(request, {
      env: { CMUX_WORKSPACE_ID: "workspace-uuid", CMUX_SURFACE_ID: "surface-uuid" },
    });

    const surface = await browser.open("https://chatgpt.com/c/demo");

    expect(surface).toBe("surface:7");
    expect(calls).toEqual([{
      method: "browser.open_split",
      params: {
        url: "https://chatgpt.com/c/demo",
        focus: false,
        workspace_id: "workspace-uuid",
        surface_id: "surface-uuid",
      },
    }]);
  });

  test("does not use heavy socket snapshots for text extraction", async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const request: BrowserRpcRequester = async (method, params) => {
      calls.push({ method, params: params ?? {} });
      return {};
    };
    const browser = createCmuxSocketBrowserAutomation(request, { env: { CMUX_WORKSPACE_ID: "workspace-uuid" } });

    await browser.waitForLoad("surface:7", 1234);
    await expect(browser.getText("surface:7", "body")).rejects.toBeInstanceOf(CmuxSocketUnavailableError);

    expect(calls).toEqual([
      { method: "browser.wait", params: { surface_id: "surface:7", workspace_id: "workspace-uuid", load_state: "complete", timeout_ms: 1234 } },
    ]);
  });

  test("closes through surface.close", async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const request: BrowserRpcRequester = async (method, params) => {
      calls.push({ method, params: params ?? {} });
      return {};
    };
    const browser = createCmuxSocketBrowserAutomation(request, { env: { CMUX_WORKSPACE_ID: "workspace-uuid" } });

    await browser.close("surface:7");

    expect(calls).toEqual([{ method: "surface.close", params: { surface_id: "surface:7", workspace_id: "workspace-uuid" } }]);
  });

  test("falls back to CLI when socket is unavailable", async () => {
    const calls: string[] = [];
    const socket: CmuxBrowserAutomation = {
      async open() { calls.push("socket.open"); throw new CmuxSocketUnavailableError("missing socket"); },
      async waitForLoad() { calls.push("socket.wait"); throw new CmuxSocketUnavailableError("missing socket"); },
      async getText() { calls.push("socket.getText"); throw new CmuxSocketUnavailableError("missing socket"); },
      async close() { calls.push("socket.close"); throw new CmuxSocketUnavailableError("missing socket"); },
    };
    const cli: CmuxBrowserAutomation = {
      async open() { calls.push("cli.open"); return "surface:7"; },
      async waitForLoad() { calls.push("cli.wait"); },
      async getText() { calls.push("cli.getText"); return "text"; },
      async close() { calls.push("cli.close"); },
    };
    const browser = createCmuxBrowserAutomation({ socket, cli });

    expect(await browser.open("https://chatgpt.com/c/demo")).toBe("surface:7");
    await browser.waitForLoad("surface:7", 1000);
    expect(await browser.getText("surface:7", "body")).toBe("text");
    await browser.close("surface:7");

    expect(calls).toEqual(["socket.open", "cli.open", "socket.wait", "cli.wait", "socket.getText", "cli.getText", "socket.close", "cli.close"]);
  });
});

describe("cmux browser CLI fallback", () => {
  test("uses open-split instead of replacing the caller surface", async () => {
    const calls: string[][] = [];
    const runner: CmuxRunner = async args => {
      calls.push([...args]);
      return { stdout: JSON.stringify({ surface_ref: "surface:7" }), stderr: "", exitCode: 0 };
    };
    const browser = createCmuxCliBrowserAutomation(runner, { CMUX_WORKSPACE_ID: "workspace-uuid" });

    expect(await browser.open("https://chatgpt.com/c/demo")).toBe("surface:7");

    expect(calls).toEqual([["--json", "browser", "open-split", "https://chatgpt.com/c/demo", "--workspace", "workspace-uuid", "--focus", "false"]]);
  });
});

describe("cmux surface parsing", () => {
  test("parses common surface response shapes", () => {
    expect(parseCmuxSurfaceRef("surface:3")).toBe("surface:3");
    expect(parseCmuxSurfaceRef({ surface_ref: "surface:4" })).toBe("surface:4");
    expect(parseCmuxSurfaceRef({ surface: "surface:5" })).toBe("surface:5");
  });
});
