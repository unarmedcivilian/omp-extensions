export interface CmuxExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type CmuxRunner = (args: readonly string[], signal?: AbortSignal) => Promise<CmuxExecResult>;
export type CmuxSpawn = (command: string, args: readonly string[], signal?: AbortSignal) => Promise<CmuxExecResult>;

export function createCmuxRunner(spawn: CmuxSpawn = spawnCmuxProcess): CmuxRunner {
  return (args, signal) => spawn("cmux", args, signal);
}

async function spawnCmuxProcess(command: string, args: readonly string[], signal?: AbortSignal): Promise<CmuxExecResult> {
  const proc = Bun.spawn([command, ...args], { stdout: "pipe", stderr: "pipe", signal });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

const SURFACE_REF = /^surface:\d+$/;

export function parseCmuxSurfaceRef(value: unknown): string {
  if (typeof value === "string" && SURFACE_REF.test(value)) return value;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["surface", "surface_ref", "ref", "id"]) {
      const candidate = record[key];
      if (typeof candidate === "string" && SURFACE_REF.test(candidate)) return candidate;
    }
  }
  throw new Error("cmux browser open did not return a surface ref");
}

export async function openCmuxSurface(url: string, runner: CmuxRunner, signal?: AbortSignal): Promise<string> {
  const result = await runner(["--json", "browser", "open", url], signal);
  if (result.exitCode !== 0) {
    const detail = result.stderr || result.stdout || `exit ${result.exitCode}`;
    throw new Error(`cmux browser open failed: ${detail}`);
  }
  try {
    return parseCmuxSurfaceRef(JSON.parse(result.stdout));
  } catch (error) {
    if (error instanceof SyntaxError) return parseCmuxSurfaceRef(result.stdout.trim());
    throw error;
  }
}

export async function closeCmuxSurface(surface: string, runner: CmuxRunner): Promise<void> {
  const result = await runner(["close-surface", "--surface", surface]);
  if (result.exitCode !== 0) {
    const detail = result.stderr || result.stdout || `exit ${result.exitCode}`;
    throw new Error(`cmux close-surface failed: ${detail}`);
  }
}
