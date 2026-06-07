import { describe, expect, test } from "bun:test";
import { closeCmuxSurface, createCmuxRunner, openCmuxSurface, parseCmuxSurfaceRef, type CmuxRunner } from "../src/cmux.js";

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
