import { describe, expect, test } from "bun:test";
import type { AgentToolResult, ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import chatGptProConsultExtension, {
  createChatGptProConsultExtension,
  type ChatGptProConsultToolDetails,
} from "../src/index.js";
import type {
  ChatGptProConsultDetails,
  ChatGptProConsultParams,
  ChatGptProConsultResult,
} from "../src/consult.js";

interface Chain {
  kind: string;
  description?: string;
  isOptional?: boolean;
  defaultValue?: unknown;
  shape?: Record<string, Chain>;
  values?: readonly string[];
  describe(text: string): Chain;
  optional(): Chain;
  default(value: unknown): Chain;
}

interface ZLike {
  object(shape: Record<string, Chain>): Chain;
  string(): Chain;
  number(): Chain;
  boolean(): Chain;
  enum(values: readonly string[]): Chain;
}

interface ConsultToolParams {
  prompt: string;
  zip_path?: string;
  thread?: "new" | "current";
  keep_surface?: boolean;
}

interface TestTool {
  name: string;
  label: string;
  description: string;
  parameters: Chain;
  execute(
    toolCallId: string,
    params: ConsultToolParams,
    signal?: AbortSignal,
    onUpdate?: (update: AgentToolResult<ChatGptProConsultToolDetails>) => void,
  ): Promise<AgentToolResult<ChatGptProConsultToolDetails>>;
}

interface FakePi {
  labels: string[];
  tools: TestTool[];
  api: ExtensionAPI;
}

function chain(kind: string, extra: Partial<Chain> = {}): Chain {
  return {
    kind,
    ...extra,
    describe(text: string) {
      this.description = text;
      return this;
    },
    optional() {
      this.isOptional = true;
      return this;
    },
    default(value: unknown) {
      this.defaultValue = value;
      return this;
    },
  };
}

function makeZ(): ZLike {
  return {
    object(shape) {
      return chain("object", { shape });
    },
    string() {
      return chain("string");
    },
    number() {
      return chain("number");
    },
    boolean() {
      return chain("boolean");
    },
    enum(values) {
      return chain("enum", { values });
    },
  };
}

function makeFakePi(): FakePi {
  const labels: string[] = [];
  const tools: TestTool[] = [];
  const api = {
    zod: makeZ(),
    logger: { error() {}, warn() {}, info() {}, debug() {} },
    setLabel(label: string) {
      labels.push(label);
    },
    registerTool(tool: TestTool) {
      tools.push(tool);
    },
    on() {},
  } as unknown as ExtensionAPI;

  return { labels, tools, api };
}

function successfulResult(details: ChatGptProConsultDetails): ChatGptProConsultResult {
  return {
    ok: true,
    markdown: "## Answer",
    contentText: "Answer text",
    details,
  };
}

describe("ChatGPT Pro consult extension", () => {
  test("sets the label and registers the tool once per ExtensionAPI instance", () => {
    const fake = makeFakePi();
    const extension = createChatGptProConsultExtension();

    extension(fake.api);
    extension(fake.api);
    createChatGptProConsultExtension()(fake.api);

    expect(fake.labels).toEqual(["ChatGPT Pro Consult"]);
    expect(fake.tools.map(tool => tool.name)).toEqual(["chatgpt_pro_consult"]);
  });

  test("installs independently on distinct ExtensionAPI instances", () => {
    const first = makeFakePi();
    const second = makeFakePi();
    const extension = createChatGptProConsultExtension();

    extension(first.api);
    extension(second.api);

    expect(first.labels).toEqual(["ChatGPT Pro Consult"]);
    expect(second.labels).toEqual(["ChatGPT Pro Consult"]);
    expect(first.tools.map(tool => tool.name)).toEqual(["chatgpt_pro_consult"]);
    expect(second.tools.map(tool => tool.name)).toEqual(["chatgpt_pro_consult"]);
  });

  test("registers tool metadata and parameter schema", () => {
    const fake = makeFakePi();

    chatGptProConsultExtension(fake.api);

    expect(fake.tools).toHaveLength(1);
    const tool = fake.tools[0]!;
    expect(tool.name).toBe("chatgpt_pro_consult");
    expect(tool.label).toBe("ChatGPT Pro Consult");
    expect(tool.description).toBe(
      "Submit one explicit prompt to ChatGPT Pro through a visible cmux browser session and return the Markdown response.",
    );
    expect(tool.parameters.kind).toBe("object");
    expect(tool.parameters.shape?.prompt).toMatchObject({
      kind: "string",
      description: "Prompt to submit to ChatGPT Pro.",
    });
    expect(tool.parameters.shape?.zip_path).toMatchObject({
      kind: "string",
      isOptional: true,
    });
    expect(tool.parameters.shape?.zip_path?.description).toContain("ZIP");
    expect(tool.parameters.shape?.thread).toMatchObject({
      kind: "enum",
      values: ["new", "current"],
      isOptional: true,
    });
    expect(tool.parameters.shape?.thread?.description).toContain("fresh ChatGPT thread");
    expect(tool.parameters.shape?.thread?.defaultValue).toBeUndefined();
    expect(tool.parameters.shape).not.toHaveProperty("timeout_ms");
    expect(tool.parameters.shape?.keep_surface).toMatchObject({
      kind: "boolean",
      isOptional: true,
    });
    expect(tool.parameters.shape?.keep_surface?.description).toContain("cmux browser surface");
  });

  test("execute maps tool params, progress updates, and the final result", async () => {
    const fake = makeFakePi();
    const calls: ChatGptProConsultParams[] = [];
    const updates: AgentToolResult<ChatGptProConsultToolDetails>[] = [];
    const progress = {
      phase: "waiting",
      message: "Prompt submission initiated; waiting for ChatGPT Pro…",
      elapsedMs: 75_000,
      timeoutMs: 7_200_000,
      thread: "new",
      hasZip: false,
      surfaceRef: "surface:7",
    } as const;
    const details: ChatGptProConsultDetails = {
      ok: true,
      status: "ok",
      warnings: [],
      thread: "current",
      keptSurface: false,
      raw: { id: "details-only" },
    };
    const extension = createChatGptProConsultExtension({
      consult: async params => {
        calls.push(params);
        params.onProgress?.(progress);
        return successfulResult(details);
      },
    });
    const signal = new AbortController().signal;

    extension(fake.api);
    const response = await fake.tools[0]!.execute(
      "tool-call-1",
      {
        prompt: "Explain the tradeoff.",
        zip_path: "/tmp/context.zip",
        thread: "current",
        keep_surface: true,
      },
      signal,
      update => {
        updates.push(update);
      },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      prompt: "Explain the tradeoff.",
      thread: "current",
      keepSurface: true,
      zipPath: "/tmp/context.zip",
    });
    expect(calls[0]).not.toHaveProperty("timeoutMs");
    expect(calls[0]?.signal).toBe(signal);
    expect(updates).toEqual([
      {
        content: [
          {
            type: "text",
            text: "Prompt submission initiated; waiting for ChatGPT Pro… (1m 15s elapsed)",
          },
        ],
        details: { kind: "progress", progress },
      },
    ]);
    expect(response.content).toEqual([{ type: "text", text: "Answer text" }]);
    expect(response.details).toBe(details);
    expect(response.details).not.toHaveProperty("contentText");
    expect(response.isError).toBeUndefined();
  });

  test("formats elapsed hours as total minutes in progress text", async () => {
    const fake = makeFakePi();
    const updates: AgentToolResult<ChatGptProConsultToolDetails>[] = [];
    const progress = {
      phase: "waiting",
      message: "Prompt submission initiated; waiting for ChatGPT Pro…",
      elapsedMs: 3_600_000,
      timeoutMs: 7_200_000,
      thread: "new",
      hasZip: false,
    } as const;
    const details: ChatGptProConsultDetails = {
      ok: true,
      status: "ok",
      warnings: [],
      thread: "new",
      keptSurface: false,
    };
    const extension = createChatGptProConsultExtension({
      consult: async params => {
        params.onProgress?.(progress);
        return successfulResult(details);
      },
    });

    extension(fake.api);
    await fake.tools[0]!.execute(
      "tool-call-hour-boundary",
      { prompt: "Explain the boundary." },
      undefined,
      update => {
        updates.push(update);
      },
    );

    expect(updates).toEqual([
      {
        content: [
          {
            type: "text",
            text: "Prompt submission initiated; waiting for ChatGPT Pro… (60m 0s elapsed)",
          },
        ],
        details: { kind: "progress", progress },
      },
    ]);
  });

  test("execute omits consult progress when no update callback is provided", async () => {
    const fake = makeFakePi();
    const calls: ChatGptProConsultParams[] = [];
    const details: ChatGptProConsultDetails = {
      ok: true,
      status: "ok",
      warnings: [],
      thread: "new",
      keptSurface: false,
    };
    const extension = createChatGptProConsultExtension({
      consult: async params => {
        calls.push(params);
        return successfulResult(details);
      },
    });

    extension(fake.api);
    const response = await fake.tools[0]!.execute("tool-call-without-updates", {
      prompt: "Explain without progress.",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toHaveProperty("onProgress");
    expect(calls[0]?.onProgress).toBeUndefined();
    expect(response.content).toEqual([{ type: "text", text: "Answer text" }]);
    expect(response.details).toBe(details);
    expect(response.isError).toBeUndefined();
  });

  test("execute rejects a stale own timeout_ms input before invoking consult", async () => {
    const fake = makeFakePi();
    const calls: ChatGptProConsultParams[] = [];
    const extension = createChatGptProConsultExtension({
      consult: async params => {
        calls.push(params);
        throw new Error("consult fake should not be called");
      },
    });
    const staleInput = {
      prompt: "Use the obsolete timeout.",
      timeout_ms: 45_000,
    } as unknown as ConsultToolParams;

    extension(fake.api);

    await expect(fake.tools[0]!.execute("tool-call-stale-timeout", staleInput)).rejects.toThrow(
      "timeout_ms is not supported; ChatGPT Pro consults use a fixed 120-minute limit.",
    );
    expect(calls).toHaveLength(0);
  });

  test("execute maps failed consults to tool errors and preserves blocker details", async () => {
    const fake = makeFakePi();
    const blocker = {
      kind: "login_required",
      code: "chatgpt_login_required",
      message: "Log in to ChatGPT",
      surfaceRef: "surface:7",
      visibleText: "Sign in",
    };
    const details: ChatGptProConsultDetails = {
      ok: false,
      status: "blocked",
      warnings: ["manual action required"],
      thread: "new",
      surfaceRef: "surface:7",
      keptSurface: true,
      blocker,
      context: { turnCount: 0 },
    };
    const failedResult: ChatGptProConsultResult = {
      ok: false,
      markdown: "",
      contentText: "Log in to ChatGPT Surface left open at surface:7.",
      details,
    };
    const extension = createChatGptProConsultExtension({
      consult: async () => failedResult,
    });

    extension(fake.api);
    const response = await fake.tools[0]!.execute("tool-call-2", {
      prompt: "Ask ChatGPT Pro.",
    });

    expect(response.content).toEqual([{ type: "text", text: failedResult.contentText }]);
    expect(response.details).toBe(details);
    expect(response.details.blocker).toBe(blocker);
    expect(response.isError).toBe(true);
  });
});
