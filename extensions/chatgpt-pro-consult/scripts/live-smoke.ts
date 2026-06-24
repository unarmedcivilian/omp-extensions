import {
  runChatGptProConsult,
  type ChatGptProConsultDetails,
  type ChatGptProConsultParams,
  type ChatGptProConsultResult,
  type ChatGptProThread,
} from "../src/consult.js";

export const DEFAULT_SMOKE_PROMPT = "Reply with exactly: omp smoke ok";

export interface LiveSmokeArgs {
  prompt: string;
  thread?: ChatGptProThread;
  timeoutMs?: number;
  zipPath?: string;
  keepSurface?: boolean;
}

interface FlagReadResult {
  value: string;
  nextIndex: number;
}

export function parseLiveSmokeArgs(argv: readonly string[]): LiveSmokeArgs {
  let prompt = DEFAULT_SMOKE_PROMPT;
  let thread: ChatGptProThread | undefined;
  let timeoutMs: number | undefined;
  let keepSurface: boolean | undefined;
  let zipPath: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;
    if (arg === "--") continue;

    if (arg === "--keep-surface") {
      keepSurface = true;
      continue;
    }

    if (arg.startsWith("--prompt=")) {
      prompt = arg.slice("--prompt=".length);
      continue;
    }

    if (arg === "--prompt") {
      const read = readFlagValue(argv, index, "--prompt");
      prompt = read.value;
      index = read.nextIndex;
      continue;
    }

    if (arg.startsWith("--thread=")) {
      thread = parseThread(arg.slice("--thread=".length));
      continue;
    }

    if (arg === "--thread") {
      const read = readFlagValue(argv, index, "--thread");
      thread = parseThread(read.value);
      index = read.nextIndex;
      continue;
    }

    if (arg.startsWith("--zip-path=")) {
      zipPath = arg.slice("--zip-path=".length);
      continue;
    }

    if (arg === "--zip-path") {
      const read = readFlagValue(argv, index, "--zip-path");
      zipPath = read.value;
      index = read.nextIndex;
      continue;
    }

    if (arg.startsWith("--timeout-ms=")) {
      timeoutMs = parseTimeoutMs(arg.slice("--timeout-ms=".length));
      continue;
    }

    if (arg === "--timeout-ms") {
      const read = readFlagValue(argv, index, "--timeout-ms");
      timeoutMs = parseTimeoutMs(read.value);
      index = read.nextIndex;
      continue;
    }

    throw new Error(`Unknown live smoke argument: ${arg ?? "<missing>"}`);
  }

  if (!prompt.trim()) throw new Error("--prompt must not be empty");

  const parsed: LiveSmokeArgs = { prompt };
  if (thread) parsed.thread = thread;
  if (timeoutMs !== undefined) parsed.timeoutMs = timeoutMs;
  if (zipPath !== undefined) parsed.zipPath = zipPath;
  if (keepSurface !== undefined) parsed.keepSurface = keepSurface;
  return parsed;
}

async function runLiveSmoke(argv: readonly string[]): Promise<number> {
  let params: ChatGptProConsultParams | undefined;

  try {
    params = parseLiveSmokeArgs(argv);
    const result = await runChatGptProConsult(params);
    writeSmokeOutput(result);
    return result.ok ? 0 : 1;
  } catch (error) {
    const details: ChatGptProConsultDetails = {
      ok: false,
      status: "error",
      warnings: [],
      thread: params?.thread ?? "new",
      keptSurface: params?.keepSurface === true,
      error: error instanceof Error
        ? { name: error.name, message: error.message, stack: error.stack }
        : error,
    };
    const contentText = error instanceof Error
      ? error.message
      : "ChatGPT Pro live smoke failed.";
    writeSmokeOutput({ ok: false, markdown: "", contentText, details });
    return 1;
  }
}

function readFlagValue(argv: readonly string[], index: number, flag: string): FlagReadResult {
  const value = argv[index + 1];
  if (value === undefined) {
    throw new Error(`${flag} requires a value`);
  }

  return { value, nextIndex: index + 1 };
}

function parseThread(value: string): ChatGptProThread {
  if (value === "new" || value === "current") return value;
  throw new Error(`--thread must be "new" or "current", got ${JSON.stringify(value)}`);
}

function parseTimeoutMs(value: string): number {
  const timeoutMs = Number(value);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`--timeout-ms must be a positive number, got ${JSON.stringify(value)}`);
  }

  return timeoutMs;
}

function writeSmokeOutput(result: ChatGptProConsultResult): void {
  process.stdout.write(`${stringifyCompact({
    details: result.details,
    contentText: result.contentText,
  })}\n`);

  if (result.contentText.length > 0) {
    process.stdout.write(result.contentText);
    if (!result.contentText.endsWith("\n")) process.stdout.write("\n");
  }
}

function stringifyCompact(value: unknown): string {
  const seen = new WeakSet<object>();
  const json = JSON.stringify(value, (_key, item) => {
    if (item instanceof Error) {
      return {
        name: item.name,
        message: item.message,
        stack: item.stack,
      };
    }

    if (typeof item === "object" && item !== null) {
      if (seen.has(item)) return "[Circular]";
      seen.add(item);
    }

    return item;
  });
  return json ?? "null";
}

if (import.meta.main) {
  process.exitCode = await runLiveSmoke(process.argv.slice(2));
}
