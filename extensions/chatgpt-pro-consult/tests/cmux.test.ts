import { describe, expect, test } from "bun:test";
import {
  CmuxSocketUnavailableError,
  createCmuxTransport,
  parseCmuxSurfaceRef,
  type CmuxRunner,
  type CmuxSocketRequester,
} from "../src/cmux.js";

describe("cmux transport", () => {
  test("falls back to CLI open-split when socket open is unavailable", async () => {
    const socketCalls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const runnerCalls: string[][] = [];
    const socket: CmuxSocketRequester = async (method, params) => {
      socketCalls.push({ method, params: params ?? {} });
      throw new CmuxSocketUnavailableError("missing socket");
    };
    const runner: CmuxRunner = async args => {
      runnerCalls.push([...args]);
      return { stdout: JSON.stringify({ surface: "surface:7" }), stderr: "", exitCode: 0 };
    };

    const transport = createCmuxTransport({ socket, runner, env: {} });

    await expect(transport.open("https://chatgpt.com/")).resolves.toBe("surface:7");
    expect(socketCalls).toEqual([{ method: "browser.open_split", params: { url: "https://chatgpt.com/", focus: false } }]);
    expect(runnerCalls).toEqual([["--json", "browser", "open-split", "https://chatgpt.com/", "--focus", "false"]]);
  });

  test("runs browser eval through CLI and returns stdout", async () => {
    const calls: string[][] = [];
    const runner: CmuxRunner = async args => {
      calls.push([...args]);
      return { stdout: "{\"ok\":true}", stderr: "", exitCode: 0 };
    };
    const transport = createCmuxTransport({ runner, env: {} });

    const result = await transport.eval("surface:7", "JSON.stringify({ ok: true })");

    expect(result).toBe("{\"ok\":true}");
    expect(calls).toEqual([["browser", "surface:7", "eval", "JSON.stringify({ ok: true })"]]);
  });

  test("resolves current ChatGPT surface from explicit environment", async () => {
    const transport = createCmuxTransport({ env: { CHATGPT_PRO_CONSULT_SURFACE: "surface:99" } });

    await expect(transport.resolveCurrentSurface()).resolves.toBe("surface:99");
  });

  test("explicit current-surface environment overrides the remembered surface store", async () => {
    const transport = createCmuxTransport({
      env: { CHATGPT_PRO_CONSULT_SURFACE: "surface:99" },
      surfaceStore: { lastChatGptSurface: "surface:7" },
    });

    await expect(transport.resolveCurrentSurface()).resolves.toBe("surface:99");
  });

  test("current cmux identify result overrides stale remembered surface store", async () => {
    const runner: CmuxRunner = async args => {
      if (args[0] === "identify") return { stdout: JSON.stringify({ surface: "surface:8" }), stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "", exitCode: 1 };
    };
    const transport = createCmuxTransport({
      runner,
      env: {},
      surfaceStore: { lastChatGptSurface: "surface:7" },
    });

    await expect(transport.resolveCurrentSurface()).resolves.toBe("surface:8");
  });

  test("parses supported cmux surface reference shapes and rejects invalid values", () => {
    expect(parseCmuxSurfaceRef("surface:7")).toBe("surface:7");
    expect(parseCmuxSurfaceRef({ surface: "surface:8" })).toBe("surface:8");
    expect(parseCmuxSurfaceRef({ surface_ref: "surface:9" })).toBe("surface:9");
    expect(parseCmuxSurfaceRef({ surfaceRef: "surface:10" })).toBe("surface:10");
    expect(parseCmuxSurfaceRef({ ref: "surface:11" })).toBe("surface:11");
    expect(parseCmuxSurfaceRef({ id: "surface:12" })).toBe("surface:12");

    expect(() => parseCmuxSurfaceRef("surface:abc")).toThrow("Unable to parse cmux surface ref");
    expect(() => parseCmuxSurfaceRef({ surface: "pane:7" })).toThrow("Unable to parse cmux surface ref");
    expect(() => parseCmuxSurfaceRef({ id: 12 })).toThrow("Unable to parse cmux surface ref");
    expect(() => parseCmuxSurfaceRef({ surface_id: "surface:13" })).toThrow("Unable to parse cmux surface ref");
  });

  test("checked CLI failures include stderr and stdout in error messages", async () => {
    const runner: CmuxRunner = async () => ({ stdout: "partial stdout", stderr: "failure stderr", exitCode: 42 });
    const transport = createCmuxTransport({ runner, env: {} });

    let error: unknown;
    try {
      await transport.eval("surface:7", "document.title");
    } catch (caught) {
      error = caught;
    }

    if (!(error instanceof Error)) throw new Error("expected eval to reject with an Error");
    const message = error.message;
    expect(message).toContain("cmux browser eval failed");
    expect(message).toContain("exit 42");
    expect(message).toContain("stdout: partial stdout");
    expect(message).toContain("stderr: failure stderr");
  });
});
