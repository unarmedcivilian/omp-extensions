import { describe, expect, test } from "bun:test";
import { DEFAULT_SMOKE_PROMPT, parseLiveSmokeArgs } from "../scripts/live-smoke.js";

interface PackageManifest {
  files?: string[];
  scripts?: Record<string, string>;
}

describe("live smoke script", () => {
  test("manifest exposes smoke as a manual script outside check", async () => {
    const manifest = await Bun.file(new URL("../package.json", import.meta.url)).json() as PackageManifest;

    expect(manifest.scripts?.smoke).toBe("bun run scripts/live-smoke.ts");
    expect(manifest.scripts?.check).not.toContain("smoke");
    expect(manifest.scripts?.check).not.toContain("live-smoke");
    expect(manifest.files).toContain("scripts");
  });

  test("parseLiveSmokeArgs uses the default prompt with no optional flags", () => {
    expect(parseLiveSmokeArgs([])).toEqual({ prompt: DEFAULT_SMOKE_PROMPT });
  });

  test("parseLiveSmokeArgs maps live smoke flags to runner params", () => {
    expect(parseLiveSmokeArgs([
      "--prompt",
      "Explain the tradeoff.",
      "--thread",
      "current",
      "--timeout-ms",
      "45000",
      "--keep-surface",
    ])).toEqual({
      prompt: "Explain the tradeoff.",
      thread: "current",
      timeoutMs: 45_000,
      keepSurface: true,
    });
  });
});
