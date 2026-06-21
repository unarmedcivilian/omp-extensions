import vm from "node:vm";
import type { TSchema } from "@oh-my-pi/pi-ai";
import { WorkflowAgent, type AgentRunOptions, type AgentRunResult, type WorkflowAgentOptions } from "./agent.js";

export interface WorkflowMetaPhase {
  title: string;
  detail?: string;
  model?: string;
}

export interface WorkflowMeta {
  name: string;
  description: string;
  whenToUse?: string;
  phases?: WorkflowMetaPhase[];
}

export interface WorkflowAgentRunner {
  run<TSchemaDef extends TSchema | undefined = undefined>(
    prompt: string,
    options?: AgentRunOptions<TSchemaDef>,
  ): Promise<AgentRunResult<TSchemaDef>>;
}

export interface WorkflowRunOptions extends WorkflowAgentOptions {
  args?: unknown;
  agent?: WorkflowAgentRunner;
  concurrency?: number;
  tokenBudget?: number | null;
  signal?: AbortSignal;
  onLog?: (message: string) => void;
  onPhase?: (title: string) => void;
  onAgentStart?: (event: { label: string; phase?: string; prompt: string }) => void;
  onAgentEnd?: (event: { label: string; phase?: string; result: unknown }) => void;
}

export interface WorkflowRunResult<T = unknown> {
  meta: WorkflowMeta;
  result: T;
  logs: string[];
  phases: string[];
  agentCount: number;
  durationMs: number;
}

export interface AgentOptions<TSchemaDef extends TSchema | undefined = TSchema | undefined> {
  label?: string;
  phase?: string;
  schema?: TSchemaDef;
  model?: string;
  isolation?: "worktree";
  agentType?: string;
}

interface RuntimeState {
  currentPhase?: string;
  logs: string[];
  phases: string[];
  agentCount: number;
  spent: number;
}

const NONDETERMINISM_ERROR =
  "Workflow scripts must be deterministic: Date.now()/Math.random()/new Date() are unavailable";

export async function runWorkflow<T = unknown>(
  script: string,
  options: WorkflowRunOptions = {},
): Promise<WorkflowRunResult<T>> {
  const started = Date.now();
  const { meta, body } = parseWorkflowScript(script);
  const state: RuntimeState = { logs: [], phases: [], agentCount: 0, spent: 0 };
  const agentRunner = options.agent ?? new WorkflowAgent(options);
  const concurrency = Math.max(
    1,
    Math.min(options.concurrency ?? Math.max(1, (globalThis.navigator?.hardwareConcurrency ?? 8) - 2), 16),
  );
  const limiter = createLimiter(concurrency);
  const pendingAgentRuns = new Set<Promise<unknown>>();

  const log = (message: string) => {
    const text = String(message);
    state.logs.push(text);
    options.onLog?.(text);
  };

  const phase = (title: unknown) => {
    const text = requireString(title, "phase title");
    state.currentPhase = text;
    if (!state.phases.includes(text)) state.phases.push(text);
    options.onPhase?.(text);
  };

  const budget = Object.freeze({
    total: options.tokenBudget ?? null,
    spent: () => state.spent,
    remaining: () => (options.tokenBudget == null ? Infinity : Math.max(0, options.tokenBudget - state.spent)),
  });

  const throwIfAborted = () => {
    if (options.signal?.aborted) throw new Error("workflow aborted");
  };

  const agent = async (prompt: unknown, agentOptions: unknown = {}) => {
    throwIfAborted();
    if (budget.total !== null && budget.remaining() <= 0) throw new Error("workflow token budget exhausted");
    const taskPrompt = requireString(prompt, "agent prompt");
    const normalizedOptions = normalizeAgentOptions(agentOptions);
    const assignedPhase = normalizedOptions.phase ?? state.currentPhase;
    const requestedLabel = normalizedOptions.label?.trim();
    const run = limiter(async () => {
      state.agentCount++;
      const label = requestedLabel || defaultAgentLabel(assignedPhase, state.agentCount);
      options.onAgentStart?.({ label, phase: assignedPhase, prompt: taskPrompt });
      try {
        throwIfAborted();
        const runOptions: AgentRunOptions<TSchema | undefined> = {
          label,
          schema: normalizedOptions.schema,
          signal: options.signal,
          instructions: buildAgentInstructions(assignedPhase, normalizedOptions),
        };
        const result = await agentRunner.run(taskPrompt, runOptions);
        throwIfAborted();
        state.spent += estimateTokens(result);
        options.onAgentEnd?.({ label, phase: assignedPhase, result });
        return result;
      } catch (error) {
        if (options.signal?.aborted) throw error;
        log(`agent ${label} failed: ${error instanceof Error ? error.message : String(error)}`);
        options.onAgentEnd?.({ label, phase: assignedPhase, result: null });
        return null;
      }
    });
    pendingAgentRuns.add(run);
    run.then(
      () => pendingAgentRuns.delete(run),
      () => pendingAgentRuns.delete(run),
    );
    return run;
  };

  const parallel = async (thunks: Array<() => Promise<unknown>>) => {
    throwIfAborted();
    if (!Array.isArray(thunks)) throw new TypeError("parallel() expects an array of functions");
    if (thunks.some(thunk => typeof thunk !== "function")) {
      throw new TypeError("parallel() expects an array of functions, not promises. Wrap each call: () => agent(...)");
    }
    return Promise.all(
      thunks.map(async (thunk, index) => {
        try {
          return await thunk();
        } catch (error) {
          if (options.signal?.aborted) throw error;
          log(`parallel[${index}] failed: ${error instanceof Error ? error.message : String(error)}`);
          return null;
        }
      }),
    );
  };

  const pipeline = async (
    items: unknown[],
    ...stages: Array<(prev: unknown, original: unknown, index: number) => unknown>
  ) => {
    throwIfAborted();
    if (!Array.isArray(items)) throw new TypeError("pipeline() expects an array as the first argument");
    if (stages.some(stage => typeof stage !== "function")) {
      throw new TypeError("pipeline() stages must be functions: pipeline(items, item => ..., result => ...)");
    }
    return Promise.all(
      items.map(async (item, index) => {
        let value: unknown = item;
        for (const stage of stages) {
          try {
            throwIfAborted();
            value = await stage(value, item, index);
            throwIfAborted();
          } catch (error) {
            if (options.signal?.aborted) throw error;
            log(`pipeline[${index}] failed: ${error instanceof Error ? error.message : String(error)}`);
            return null;
          }
        }
        return value;
      }),
    );
  };

  const context = vm.createContext({
    agent,
    parallel,
    pipeline,
    log,
    phase,
    args: options.args,
    cwd: options.cwd ?? process.cwd(),
    process: Object.freeze({ cwd: () => options.cwd ?? process.cwd() }),
    budget,
    console: {
      log,
      info: log,
      warn: (message: unknown) => log(`[warn] ${String(message)}`),
      error: (message: unknown) => log(`[error] ${String(message)}`),
    },
    JSON,
    Math,
    Array,
    Object,
    String,
    Number,
    Boolean,
    Set,
    Map,
    Promise,
  });

  const wrapped = `(async () => {\n${body}\n})()`;
  const result = await new vm.Script(wrapped, { filename: `${meta.name || "workflow"}.js` }).runInContext(context);
  await Promise.allSettled([...pendingAgentRuns]);
  assertStructuredCloneable(result, "workflow result");
  return {
    meta,
    result: result as T,
    logs: state.logs,
    phases: state.phases,
    agentCount: state.agentCount,
    durationMs: Date.now() - started,
  };
}

export function parseWorkflowScript(script: string): { meta: WorkflowMeta; body: string } {
  assertDeterministicSource(script);

  const start = skipWhitespaceAndComments(script, 0);
  const header = /^export\s+const\s+meta\s*=\s*/.exec(script.slice(start));
  if (!header) {
    throw new Error("`export const meta = { name, description }` must be the first statement in the script");
  }

  const valueStart = start + header[0].length;
  const valueEnd = findMetaExpressionEnd(script, valueStart);
  const literalSource = script.slice(valueStart, valueEnd).trim();
  const meta = new LiteralMetaParser(literalSource).parse();
  validateMeta(meta);

  const afterMeta = skipWhitespaceAndComments(script, valueEnd);
  if (script[afterMeta] === ",") throw new Error("meta export must declare only `meta`");

  const bodyStart = skipStatementSeparator(script, valueEnd);
  return {
    meta,
    body: script.slice(0, start) + script.slice(bodyStart),
  };
}

function findMetaExpressionEnd(script: string, start: number): number {
  const first = script[start];
  if (first === "{" || first === "[" || first === "(") return findBalancedEnd(script, start);

  let index = start;
  while (index < script.length && script[index] !== ";" && script[index] !== "\n") index++;
  return index;
}

function findBalancedEnd(script: string, start: number): number {
  const stack: string[] = [];
  let quote: "'" | '"' | "`" | undefined;
  let escaped = false;
  for (let index = start; index < script.length; index++) {
    const char = script[index];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = undefined;
      }
      continue;
    }

    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }
    if (char === "{" || char === "[" || char === "(") {
      stack.push(char);
      continue;
    }
    if (char === "}" || char === "]" || char === ")") {
      const open = stack.pop();
      if (!open || !bracketsMatch(open, char)) throw new Error("meta contains unbalanced delimiters");
      if (stack.length === 0) return index + 1;
    }
  }
  throw new Error("meta contains an unterminated literal");
}

function bracketsMatch(open: string, close: string): boolean {
  return (open === "{" && close === "}") || (open === "[" && close === "]") || (open === "(" && close === ")");
}

class LiteralMetaParser {
  #index = 0;

  constructor(private readonly source: string) {}

  parse(): unknown {
    const value = this.#parseValue("meta");
    this.#skipWhitespace();
    if (this.#index !== this.source.length) {
      throw new Error(`non-literal trailing syntax in meta near: ${this.source.slice(this.#index, this.#index + 16)}`);
    }
    return value;
  }

  #parseValue(path: string): unknown {
    this.#skipWhitespace();
    const char = this.source[this.#index];
    if (char === "{") return this.#parseObject(path);
    if (char === "[") return this.#parseArray(path);
    if (char === "'" || char === '"') return this.#parseQuotedString(char);
    if (char === "`") return this.#parseTemplateString(path);
    if (char === "-" || isDigit(char)) return this.#parseNumber(path);
    if (this.#consumeKeyword("true")) return true;
    if (this.#consumeKeyword("false")) return false;
    if (this.#consumeKeyword("null")) return null;
    if (char === ".") throw new Error(`spread not allowed in ${path}`);
    if (char === "(") throw new Error(`non-literal node type in ${path}: ParenthesizedExpression`);
    throw new Error(`non-literal node type in ${path}: ${char ? "Identifier" : "EOF"}`);
  }

  #parseObject(path: string): Record<string, unknown> {
    this.#expect("{");
    const out: Record<string, unknown> = {};
    this.#skipWhitespace();
    if (this.#peek("}")) {
      this.#index++;
      return out;
    }

    while (this.#index < this.source.length) {
      if (this.#peek("...")) throw new Error(`spread not allowed in ${path}`);
      const key = this.#parsePropertyKey(path);
      if (key === "__proto__" || key === "constructor" || key === "prototype") {
        throw new Error(`reserved key name not allowed in ${path}: ${key}`);
      }
      this.#skipWhitespace();
      if (this.#peek("(")) throw new Error(`methods/accessors not allowed in ${path}`);
      this.#expect(":");
      out[key] = this.#parseValue(`${path}.${key}`);
      this.#skipWhitespace();
      if (this.#peek("}")) {
        this.#index++;
        return out;
      }
      this.#expect(",");
      this.#skipWhitespace();
      if (this.#peek("}")) {
        this.#index++;
        return out;
      }
    }

    throw new Error(`unterminated object literal in ${path}`);
  }

  #parseArray(path: string): unknown[] {
    this.#expect("[");
    const out: unknown[] = [];
    this.#skipWhitespace();
    if (this.#peek("]")) {
      this.#index++;
      return out;
    }
    if (this.#peek(",")) throw new Error(`sparse arrays not allowed in ${path}`);

    while (this.#index < this.source.length) {
      if (this.#peek("...")) throw new Error(`spread not allowed in ${path}`);
      out.push(this.#parseValue(`${path}[${out.length}]`));
      this.#skipWhitespace();
      if (this.#peek("]")) {
        this.#index++;
        return out;
      }
      this.#expect(",");
      this.#skipWhitespace();
      if (this.#peek(",")) throw new Error(`sparse arrays not allowed in ${path}`);
      if (this.#peek("]")) {
        this.#index++;
        return out;
      }
    }

    throw new Error(`unterminated array literal in ${path}`);
  }

  #parsePropertyKey(path: string): string {
    this.#skipWhitespace();
    const char = this.source[this.#index];
    if (char === "'" || char === '"') return this.#parseQuotedString(char);
    if (char === "`") return this.#parseTemplateString(path);
    if (isDigit(char)) return String(this.#parseNumber(path));
    if (isIdentifierStart(char)) return this.#parseIdentifier();
    if (char === "[") throw new Error(`computed keys not allowed in ${path}`);
    throw new Error(`unsupported key type in ${path}: ${char ?? "EOF"}`);
  }

  #parseIdentifier(): string {
    const start = this.#index;
    this.#index++;
    while (isIdentifierPart(this.source[this.#index])) this.#index++;
    return this.source.slice(start, this.#index);
  }

  #parseQuotedString(quote: "'" | '"'): string {
    this.#expect(quote);
    let value = "";
    while (this.#index < this.source.length) {
      const char = this.source[this.#index++];
      if (char === "\\") {
        value += this.#readEscape();
        continue;
      }
      if (char === quote) return value;
      value += char;
    }
    throw new Error("unterminated string literal in meta");
  }

  #parseTemplateString(path: string): string {
    this.#expect("`");
    let value = "";
    while (this.#index < this.source.length) {
      const char = this.source[this.#index++];
      if (char === "\\") {
        value += this.#readEscape();
        continue;
      }
      if (char === "$" && this.source[this.#index] === "{") {
        throw new Error(`template interpolation not allowed in ${path}`);
      }
      if (char === "`") return value;
      value += char;
    }
    throw new Error("unterminated template literal in meta");
  }

  #readEscape(): string {
    const marker = this.source[this.#index++];
    if (marker === "x") return this.#readFixedCodePoint(2, "hex");
    if (marker === "u") {
      if (this.source[this.#index] === "{") {
        this.#index++;
        const start = this.#index;
        while (this.#index < this.source.length && this.source[this.#index] !== "}") this.#index++;
        if (this.source[this.#index] !== "}") throw new Error("unterminated unicode escape in meta");
        const hex = this.source.slice(start, this.#index);
        this.#index++;
        return codePointFromHex(hex);
      }
      return this.#readFixedCodePoint(4, "unicode");
    }
    return decodeSimpleEscape(marker);
  }

  #readFixedCodePoint(length: number, label: string): string {
    const hex = this.source.slice(this.#index, this.#index + length);
    if (hex.length !== length || !/^[0-9a-fA-F]+$/.test(hex)) throw new Error(`invalid ${label} escape in meta`);
    this.#index += length;
    return codePointFromHex(hex);
  }

  #parseNumber(path: string): number {
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(this.source.slice(this.#index));
    if (!match) throw new Error(`invalid number literal in ${path}`);
    this.#index += match[0].length;
    return Number(match[0]);
  }

  #consumeKeyword(keyword: "true" | "false" | "null"): boolean {
    if (!this.source.startsWith(keyword, this.#index)) return false;
    const next = this.source[this.#index + keyword.length];
    if (isIdentifierPart(next)) return false;
    this.#index += keyword.length;
    return true;
  }

  #expect(value: string): void {
    if (!this.#peek(value)) throw new Error(`expected ${value} in meta`);
    this.#index += value.length;
  }

  #peek(value: string): boolean {
    return this.source.startsWith(value, this.#index);
  }

  #skipWhitespace(): void {
    while (/\s/.test(this.source[this.#index] ?? "")) this.#index++;
  }
}

function isDigit(value: string | undefined): boolean {
  return value !== undefined && value >= "0" && value <= "9";
}

function isIdentifierStart(value: string | undefined): boolean {
  return value !== undefined && /[A-Za-z_$]/.test(value);
}

function isIdentifierPart(value: string | undefined): boolean {
  return value !== undefined && /[A-Za-z0-9_$]/.test(value);
}

function decodeSimpleEscape(value: string): string {
  switch (value) {
    case "n":
      return "\n";
    case "r":
      return "\r";
    case "t":
      return "\t";
    default:
      return value;
  }
}

function codePointFromHex(hex: string): string {
  const codePoint = Number.parseInt(hex, 16);
  if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff) {
    throw new Error("invalid unicode code point in meta");
  }
  return String.fromCodePoint(codePoint);
}

function assertDeterministicSource(script: string): void {
  const stripped = stripStringsAndComments(script);
  if (/\bDate\s*\.\s*now\s*\(/.test(stripped) || /\bMath\s*\.\s*random\s*\(/.test(stripped) || /\bnew\s+Date\s*\(/.test(stripped)) {
    throw new Error(NONDETERMINISM_ERROR);
  }
}

function stripStringsAndComments(source: string): string {
  let output = "";
  let index = 0;
  let quote: "'" | '"' | "`" | undefined;
  let escaped = false;
  let templateExpressionDepth = 0;

  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];

    if (!quote && char === "/" && next === "/") {
      output += "  ";
      index += 2;
      while (index < source.length && source[index] !== "\n") {
        output += " ";
        index++;
      }
      continue;
    }
    if (!quote && char === "/" && next === "*") {
      output += "  ";
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) {
        output += source[index] === "\n" ? "\n" : " ";
        index++;
      }
      if (index < source.length) {
        output += "  ";
        index += 2;
      }
      continue;
    }
    if (!quote && char === "/" && next !== "/" && next !== "*" && canStartRegexLiteral(output)) {
      output += " ";
      index++;
      let inClass = false;
      let regexEscaped = false;
      while (index < source.length) {
        const regexChar = source[index++];
        output += regexChar === "\n" ? "\n" : " ";
        if (regexEscaped) {
          regexEscaped = false;
        } else if (regexChar === "\\") {
          regexEscaped = true;
        } else if (regexChar === "[") {
          inClass = true;
        } else if (regexChar === "]") {
          inClass = false;
        } else if (regexChar === "/" && !inClass) {
          while (/[A-Za-z]/.test(source[index] ?? "")) {
            output += " ";
            index++;
          }
          break;
        }
      }
      continue;
    }


    if (quote) {
      if (quote === "`" && !escaped && char === "$" && next === "{") {
        output += "${";
        index += 2;
        quote = undefined;
        templateExpressionDepth = 1;
        continue;
      }
      output += char === "\n" ? "\n" : " ";
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = undefined;
      index++;
      continue;
    }

    if (templateExpressionDepth > 0) {
      output += char;
      if (char === "'" || char === '"' || char === "`") quote = char;
      else if (char === "{") templateExpressionDepth++;
      else if (char === "}") {
        templateExpressionDepth--;
        if (templateExpressionDepth === 0) quote = "`";
      }
      index++;
      continue;
    }

    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      output += " ";
      index++;
      continue;
    }

    output += char;
    index++;
  }

  return output;
}

function canStartRegexLiteral(output: string): boolean {
  const trimmed = output.trimEnd();
  if (!trimmed) return true;
  if (/\breturn$/.test(trimmed)) return true;
  const previous = trimmed[trimmed.length - 1];
  return previous === "=" || previous === "(" || previous === "{" || previous === "[" || previous === "," || previous === ";" || previous === ":" || previous === "!" || previous === "?" || previous === "\n";
}

function skipWhitespaceAndComments(source: string, start: number): number {
  let index = start;
  while (index < source.length) {
    const char = source[index];
    if (/\s/.test(char)) {
      index++;
      continue;
    }
    if (char === "/" && source[index + 1] === "/") {
      index += 2;
      while (index < source.length && source[index] !== "\n") index++;
      continue;
    }
    if (char === "/" && source[index + 1] === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) index++;
      index = Math.min(source.length, index + 2);
      continue;
    }
    break;
  }
  return index;
}

function skipStatementSeparator(source: string, start: number): number {
  let index = start;
  while (index < source.length && /[\s;]/.test(source[index])) index++;
  return index;
}

function validateMeta(meta: unknown): asserts meta is WorkflowMeta {
  if (!isRecord(meta)) throw new Error("meta must be an object");
  if (!Object.hasOwn(meta, "name") || typeof meta.name !== "string" || !meta.name.trim()) {
    throw new Error("meta.name must be a non-empty string");
  }
  if (!Object.hasOwn(meta, "description") || typeof meta.description !== "string" || !meta.description.trim()) {
    throw new Error("meta.description must be a non-empty string");
  }
  if (Object.hasOwn(meta, "whenToUse") && meta.whenToUse !== undefined && typeof meta.whenToUse !== "string") {
    throw new Error("meta.whenToUse must be a string");
  }
  if (Object.hasOwn(meta, "phases") && meta.phases !== undefined) {
    if (!Array.isArray(meta.phases)) throw new Error("meta.phases must be an array");
    for (const phase of meta.phases) {
      if (!isRecord(phase) || !Object.hasOwn(phase, "title") || typeof phase.title !== "string") {
        throw new Error("each meta phase must have a title string");
      }
    }
  }
}

function createLimiter(limit: number) {
  let active = 0;
  const queue: Array<() => void> = [];
  const next = () => {
    active--;
    queue.shift()?.();
  };
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= limit) await new Promise<void>(resolve => queue.push(resolve));
    active++;
    try {
      return await fn();
    } finally {
      next();
    }
  };
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string") throw new TypeError(`${name} must be a string`);
  return value;
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  return requireString(value, name);
}

function normalizeAgentOptions(value: unknown): AgentOptions {
  if (!isRecord(value)) throw new TypeError("agent options must be an object");
  const schema = value.schema as TSchema | undefined;
  return {
    label: optionalString(value.label, "agent label"),
    phase: optionalString(value.phase, "agent phase"),
    schema,
    model: optionalString(value.model, "agent model"),
    isolation: value.isolation === "worktree" ? "worktree" : undefined,
    agentType: optionalString(value.agentType, "agent type"),
  };
}

function assertStructuredCloneable(value: unknown, name: string): void {
  try {
    structuredClone(value);
  } catch (error) {
    const promised = containsPromise(value) ? " Promise" : "";
    const detail = error instanceof Error ? ` ${promised}${error.message}` : promised;
    throw new Error(
      `${name} must be structured-cloneable; did you forget to await agent(), parallel(), or pipeline()?${detail}`,
    );
  }
}

function containsPromise(value: unknown, seen = new Set<object>()): boolean {
  if (!value || typeof value !== "object") return false;
  if (value instanceof Promise) return true;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some(item => containsPromise(item, seen));
  for (const item of Object.values(value)) {
    if (containsPromise(item, seen)) return true;
  }
  return false;
}

function defaultAgentLabel(phase: string | undefined, index: number): string {
  return phase ? `${phase} agent ${index}` : `agent ${index}`;
}

function buildAgentInstructions(phase: string | undefined, options: AgentOptions): string | undefined {
  const lines = [];
  if (phase) lines.push(`Workflow phase: ${phase}`);
  if (options.agentType) lines.push(`Act as workflow subagent type: ${options.agentType}`);
  if (options.isolation) lines.push(`Requested isolation: ${options.isolation}`);
  if (options.model) lines.push(`Requested model: ${options.model}`);
  return lines.length ? lines.join("\n") : undefined;
}

function estimateTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value ?? "").length / 4);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}
