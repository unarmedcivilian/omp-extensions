import { describe, expect, test } from "bun:test";
import type { AgentToolResult, ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import chatGptProConsultExtension, { createChatGptProConsultExtension } from "../src/index.js";
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
  thread?: "new" | "current";
  timeout_ms?: number;
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
  ): Promise<AgentToolResult<ChatGptProConsultDetails>>;
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
    expect(tool.parameters.shape?.thread).toMatchObject({
      kind: "enum",
      values: ["new", "current"],
      isOptional: true,
    });
    expect(tool.parameters.shape?.thread?.description).toContain("fresh ChatGPT thread");
    expect(tool.parameters.shape?.thread?.defaultValue).toBeUndefined();
    expect(tool.parameters.shape?.timeout_ms).toMatchObject({
      kind: "number",
      isOptional: true,
    });
    expect(tool.parameters.shape?.timeout_ms?.description).toContain("milliseconds");
    expect(tool.parameters.shape?.keep_surface).toMatchObject({
      kind: "boolean",
      isOptional: true,
    });
    expect(tool.parameters.shape?.keep_surface?.description).toContain("cmux browser surface");
  });

  test("execute maps tool params and signal into the injected consult dependency", async () => {
    const fake = makeFakePi();
    const calls: ChatGptProConsultParams[] = [];
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
        return successfulResult(details);
      },
    });
    const signal = new AbortController().signal;

    extension(fake.api);
    const response = await fake.tools[0]!.execute(
      "tool-call-1",
      {
        prompt: "Explain the tradeoff.",
        thread: "current",
        timeout_ms: 45_000,
        keep_surface: true,
      },
      signal,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      prompt: "Explain the tradeoff.",
      thread: "current",
      timeoutMs: 45_000,
      keepSurface: true,
    });
    expect(calls[0]?.signal).toBe(signal);
    expect(response.content).toEqual([{ type: "text", text: "Answer text" }]);
    expect(response.details).toBe(details);
    expect(response.details).not.toHaveProperty("contentText");
    expect(response.isError).toBeUndefined();
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
