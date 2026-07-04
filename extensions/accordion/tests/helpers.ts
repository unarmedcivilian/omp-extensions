export interface Chain {
  describe(_text?: string): Chain;
  optional(): Chain;
  nullable(): Chain;
  default(_value: unknown): Chain;
  min(_value: number): Chain;
  max(_value: number): Chain;
  int(): Chain;
  positive(): Chain;
  nonempty(): Chain;
  array(): Chain;
}

export interface FakeZ {
  object(shape: Record<string, unknown>): Chain;
  array(value: unknown): Chain;
  enum(values: readonly string[]): Chain;
  literal(value: unknown): Chain;
  union(values: readonly unknown[]): Chain;
  record(key: unknown, value?: unknown): Chain;
  string(): Chain;
  boolean(): Chain;
  number(): Chain;
  unknown(): Chain;
  any(): Chain;
}

export interface RegisteredCommand {
  description?: string;
  handler(args: string, ctx: unknown): unknown;
}

export interface RegisteredTool {
  name: string;
  label?: string;
  description?: string;
  parameters?: unknown;
  execute?: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: (update: unknown) => void,
    ctx?: unknown,
  ) => Promise<unknown> | unknown;
}

export interface FakePiHarness {
  pi: unknown;
  handlers: Map<string, Array<(event: unknown, ctx: unknown) => unknown>>;
  commands: Map<string, RegisteredCommand>;
  tools: Map<string, RegisteredTool>;
  flags: Map<string, unknown>;
  labels: string[];
  warnings: string[];
  errors: string[];
  messages: string[];
  userMessages: Array<{ text: string; deliverAs?: string }>;
}

export interface FakePiOptions {
  now?: () => number;
}

export interface FakeContextOptions {
  sessionId?: string;
  model?: FakeModel | null;
  apiKey?: string | null;
  contextUsage?: { usedTokens?: number; maxTokens?: number } | null;
}

export interface FakeModel {
  id: string;
  provider?: string;
  maxTokens?: number;
  [key: string]: unknown;
}

export interface FakeContext {
  cwd: string;
  model?: FakeModel | null;
  modelRegistry: {
    getApiKey(model: unknown): string | null | Promise<string | null>;
  };
  sessionManager: {
    getSessionId(): string;
    getMessages(): Promise<unknown[]>;
  };
  getContextUsage(): { usedTokens?: number; maxTokens?: number } | null;
}

export interface TextContent {
  type: "text";
  text: string;
}

export interface ToolResult {
  content?: TextContent[];
  details?: unknown;
}

export function makeZ(): FakeZ {
  const chain: Chain = {
    describe() { return this; },
    optional() { return this; },
    nullable() { return this; },
    default() { return this; },
    min() { return this; },
    max() { return this; },
    int() { return this; },
    positive() { return this; },
    nonempty() { return this; },
    array() { return this; },
  };

  return {
    object() { return chain; },
    array() { return chain; },
    enum() { return chain; },
    literal() { return chain; },
    union() { return chain; },
    record() { return chain; },
    string() { return chain; },
    boolean() { return chain; },
    number() { return chain; },
    unknown() { return chain; },
    any() { return chain; },
  };
}

export function makeFakePi(_options: FakePiOptions = {}): FakePiHarness {
  const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
  const commands = new Map<string, RegisteredCommand>();
  const tools = new Map<string, RegisteredTool>();
  const flags = new Map<string, unknown>();
  const labels: string[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];
  const messages: string[] = [];
  const userMessages: Array<{ text: string; deliverAs?: string }> = [];

  const pi = {
    zod: { z: makeZ() },
    logger: {
      warn(message: string) { warnings.push(message); },
      error(message: string) { errors.push(message); },
      info() {},
      debug() {},
    },
    setLabel(label: string) { labels.push(label); },
    on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerCommand(name: string, command: RegisteredCommand) {
      commands.set(name, command);
    },
    registerTool(tool: RegisteredTool) {
      tools.set(tool.name, tool);
    },
    registerFlag(name: string, flag: unknown) {
      flags.set(name, flag);
    },
    sendMessage(text: string) {
      messages.push(text);
    },
    sendUserMessage(text: string, options?: { deliverAs?: string }) {
      userMessages.push({ text, deliverAs: options?.deliverAs });
    },
  };

  return { pi, handlers, commands, tools, flags, labels, warnings, errors, messages, userMessages };
}

export function makeCtx(options: FakeContextOptions = {}): FakeContext {
  const model = options.model === undefined ? { id: "claude-sonnet", provider: "anthropic", maxTokens: 4096 } : options.model;
  const apiKey = options.apiKey === undefined ? "test-api-key" : options.apiKey;
  const contextUsage = options.contextUsage === undefined ? { usedTokens: 12, maxTokens: 4096 } : options.contextUsage;

  return {
    cwd: "/tmp/accordion-test-workspace",
    model,
    modelRegistry: {
      getApiKey() { return apiKey; },
    },
    sessionManager: {
      getSessionId() { return options.sessionId ?? "session-1"; },
      async getMessages() { return []; },
    },
    getContextUsage() { return contextUsage; },
  };
}

export function textFromResult(result: unknown): string {
  if (!result || typeof result !== "object" || !("content" in result)) return "";
  const content = result.content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is TextContent => Boolean(part) && typeof part === "object" && "type" in part && part.type === "text" && "text" in part && typeof part.text === "string")
    .map(part => part.text)
    .join("\n");
}

export function detailsFromResult(result: unknown): unknown {
  if (!result || typeof result !== "object" || !("details" in result)) return undefined;
  return result.details;
}

export function getSingleHandler(fake: FakePiHarness, event: string): (event: unknown, ctx: unknown) => unknown {
  const list = fake.handlers.get(event) ?? [];
  if (list.length !== 1) throw new Error(`expected one ${event} handler, got ${list.length}`);
  return list[0];
}

export function deferred<T>() {
  return Promise.withResolvers<T>();
}
