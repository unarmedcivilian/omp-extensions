import type { RpcHost } from "../rpc.js";

export interface SvgActionParams {
  svg?: unknown;
  filename?: unknown;
}

export function attach(rpc: RpcHost): void {
  rpc.handle("svg.copy", async params => {
    const svg = readSvg(params);
    await copyText(svg);
    return { ok: true };
  });

  rpc.handle("svg.save", async params => {
    const svg = readSvg(params);
    const filename = readFilename(params) ?? `widget-${Date.now()}.svg`;
    await Bun.write(filename, svg);
    return { ok: true, path: filename };
  });
}

function readSvg(params: unknown): string {
  const svg = (params as SvgActionParams | undefined)?.svg;
  if (typeof svg !== "string" || !svg.trimStart().startsWith("<svg")) {
    throw new Error("Expected SVG source");
  }
  return svg;
}

function readFilename(params: unknown): string | undefined {
  const filename = (params as SvgActionParams | undefined)?.filename;
  if (typeof filename !== "string") return undefined;
  const trimmed = filename.trim();
  return trimmed ? trimmed : undefined;
}

async function copyText(text: string): Promise<void> {
  const command = process.platform === "darwin" ? "pbcopy" : process.platform === "win32" ? "clip" : "xclip";
  const args = process.platform === "linux" ? ["-selection", "clipboard"] : [];
  const proc = Bun.spawn([command, ...args], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  proc.stdin.write(text);
  proc.stdin.end();
  const exitCode = await proc.exited;
  if (exitCode !== 0) throw new Error(`${command} exited with ${exitCode}`);
}
