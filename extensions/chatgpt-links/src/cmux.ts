import type { BrowserAutomation } from "./importer.js";

export interface CmuxRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type CmuxRunner = (args: string[], signal?: AbortSignal) => Promise<CmuxRunResult>;

export function createCmuxRunner(command = "cmux"): CmuxRunner {
  return async (args, signal) => {
    const proc = Bun.spawn([command, ...args], { stdout: "pipe", stderr: "pipe", signal });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { stdout, stderr, exitCode };
  };
}

export function createCmuxBrowserAutomation(runner: CmuxRunner = createCmuxRunner(), env: Record<string, string | undefined> = process.env): BrowserAutomation {
  return {
    async open(url, signal) {
      const result = await runner(["--json", "browser", "open", url, "--focus", "false"], signal);
      if (result.exitCode !== 0) throw new Error(`cmux browser open failed: ${result.stderr || result.stdout || `exit ${result.exitCode}`}`);
      return parseCmuxSurfaceRef(JSON.parse(result.stdout));
    },
    async waitForLoad(surface, timeoutMs, signal) {
      await runChecked(runner, ["browser", surface, "wait", "--load-state", "complete", "--timeout-ms", String(timeoutMs)], "cmux browser wait", signal);
    },
    async getText(surface, selector, signal) {
      const result = await runner(["browser", surface, "get", "text", selector], signal);
      if (result.exitCode !== 0) throw new Error(`cmux browser get text failed: ${result.stderr || result.stdout || `exit ${result.exitCode}`}`);
      return result.stdout;
    },
    async close(surface, signal) {
      const args = ["close-surface", "--surface", surface];
      if (env.CMUX_WORKSPACE_ID) args.push("--workspace", env.CMUX_WORKSPACE_ID);
      await runChecked(runner, args, "cmux close-surface", signal);
    },
  };
}

export function parseCmuxSurfaceRef(raw: unknown): string {
  if (typeof raw === "string" && raw.startsWith("surface:")) return raw;
  if (raw && typeof raw === "object") {
    const record = raw as Record<string, unknown>;
    for (const key of ["surface", "surface_ref", "surfaceRef", "ref"]) {
      const value = record[key];
      if (typeof value === "string" && value.startsWith("surface:")) return value;
    }
  }
  throw new Error(`Unable to parse cmux surface ref from ${JSON.stringify(raw)}`);
}

async function runChecked(runner: CmuxRunner, args: string[], label: string, signal: AbortSignal | undefined): Promise<void> {
  const result = await runner(args, signal);
  if (result.exitCode !== 0) throw new Error(`${label} failed: ${result.stderr || result.stdout || `exit ${result.exitCode}`}`);
}

