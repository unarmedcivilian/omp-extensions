import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import chatGptLinksExtension, { createChatGptLinksExtension } from "../src/index.js";
import type { ImportChatGptConversationResult } from "../src/importer.js";

interface Chain {
  default(value: unknown): Chain;
  describe(): Chain;
  optional(): Chain;
}

interface ZLike {
  object(shape: Record<string, unknown>): Chain;
  string(): Chain;
  number(): Chain;
  boolean(): Chain;
}

interface TestTool {
  name: string;
  description: string;
  execute?: (toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>;
}

interface FakePi {
  tools: TestTool[];
  labels: string[];
  api: ExtensionAPI;
}

function makeZ(): ZLike {
  const chain: Chain = {
    default() { return this; },
    describe() { return this; },
    optional() { return this; },
  };
  return {
    object() { return chain; },
    string() { return chain; },
    number() { return chain; },
    boolean() { return chain; },
  };
}

function makeFakePi(): FakePi {
  const tools: TestTool[] = [];
  const labels: string[] = [];
  const api = {
    zod: { z: makeZ() },
    logger: { error() {}, warn() {}, info() {}, debug() {} },
    setLabel(label: string) { labels.push(label); },
    registerTool(tool: TestTool) { tools.push(tool); },
    on() {},
  } as unknown as ExtensionAPI;
  return { tools, labels, api };
}

describe("chatGptLinksExtension", () => {
  test("registers a ChatGPT import tool", () => {
    const pi = makeFakePi();

    chatGptLinksExtension(pi.api);

    expect(pi.labels).toEqual(["ChatGPT Links"]);
    expect(pi.tools.map(tool => tool.name)).toEqual(["chatgpt_import_conversation"]);
    expect(pi.tools[0]?.description).toContain("ChatGPT conversation");
  });

  test("imports through the registered tool", async () => {
    const pi = makeFakePi();
    const imported: Array<Record<string, unknown>> = [];
    const result: ImportChatGptConversationResult = {
      conversationId: "6a216a0f-58f4-83a8-9811-4cab2782a84f",
      url: "https://chatgpt.com/c/6a216a0f-58f4-83a8-9811-4cab2782a84f",
      path: "artifacts/chatgpt/6a216a0f-58f4-83a8-9811-4cab2782a84f.txt",
      bytes: 42,
      surface: "surface:7",
    };
    const extension = createChatGptLinksExtension({
      importConversation: async params => {
        imported.push(params as Record<string, unknown>);
        return result;
      },
    });
    extension(pi.api);

    const response = await pi.tools[0]?.execute?.("call-1", {
      conversation: "https://chatgpt.com/c/6a216a0f-58f4-83a8-9811-4cab2782a84f",
      output_path: "out/chat.txt",
      wait_timeout_ms: 1000,
      keep_surface: true,
    }) as { content: Array<{ text: string }>; details: ImportChatGptConversationResult };

    expect(imported).toEqual([{
      conversation: "https://chatgpt.com/c/6a216a0f-58f4-83a8-9811-4cab2782a84f",
      outputPath: "out/chat.txt",
      waitTimeoutMs: 1000,
      keepSurface: true,
    }]);
    expect(response.details).toEqual(result);
    expect(response.content[0]?.text).toContain("artifacts/chatgpt/6a216a0f-58f4-83a8-9811-4cab2782a84f.txt");
  });
});
