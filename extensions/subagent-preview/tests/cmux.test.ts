import { describe, expect, test } from "bun:test";
import { CmuxSocketUnavailableError, createCmuxCliTransport, createCmuxSocketTransport, createCmuxTransport, parseCmuxSurfaceRef, type CmuxRunner, type CmuxTransport } from "../src/cmux.js";

describe("subagent preview cmux transport", () => {
  test("parses cmux surface refs", () => {
    expect(parseCmuxSurfaceRef({ surface_ref: "surface:42" })).toBe("surface:42");
    expect(parseCmuxSurfaceRef({ surface: "surface:7" })).toBe("surface:7");
    expect(parseCmuxSurfaceRef("surface:8")).toBe("surface:8");
    expect(() => parseCmuxSurfaceRef({ pane: "pane:1" })).toThrow("cmux browser open did not return a surface ref");
  });

  test("opens browser split through socket", async () => {
    const calls: unknown[] = [];
    const transport = createCmuxSocketTransport(async (method, params) => {
      calls.push({ method, params });
      return { surface_ref: "surface:7" };
    }, { env: { CMUX_WORKSPACE_ID: "workspace:1", CMUX_SURFACE_ID: "surface:1" } });

    await expect(transport.openBrowserSurface("http://127.0.0.1:1234/subagent-preview/t")).resolves.toBe("surface:7");
    expect(calls).toEqual([{ method: "browser.open_split", params: { url: "http://127.0.0.1:1234/subagent-preview/t", focus: false, workspace_id: "workspace:1", surface_id: "surface:1" } }]);
  });

  test("opens browser split through CLI", async () => {
    const calls: string[][] = [];
    const runner: CmuxRunner = async args => {
      calls.push([...args]);
      return { stdout: JSON.stringify({ surface_ref: "surface:9" }), stderr: "", exitCode: 0 };
    };
    const transport = createCmuxCliTransport(runner, { env: { CMUX_WORKSPACE_ID: "workspace:1" } });

    await expect(transport.openBrowserSurface("http://example.test")).resolves.toBe("surface:9");
    expect(calls).toEqual([["--json", "browser", "open-split", "http://example.test", "--focus", "false", "--workspace", "workspace:1"]]);
  });

  test("falls back to CLI when socket is unavailable", async () => {
    const calls: string[] = [];
    const socket: CmuxTransport = { async openBrowserSurface() { calls.push("socket.open"); throw new CmuxSocketUnavailableError("missing"); }, async closeSurface() { calls.push("socket.close"); throw new CmuxSocketUnavailableError("missing"); } };
    const cli: CmuxTransport = { async openBrowserSurface() { calls.push("cli.open"); return "surface:8"; }, async closeSurface() { calls.push("cli.close"); } };
    const transport = createCmuxTransport({ socket, cli });

    await expect(transport.openBrowserSurface("http://example.test")).resolves.toBe("surface:8");
    await expect(transport.closeSurface("surface:8")).resolves.toBeUndefined();
    expect(calls).toEqual(["socket.open", "cli.open", "socket.close", "cli.close"]);
  });
});
