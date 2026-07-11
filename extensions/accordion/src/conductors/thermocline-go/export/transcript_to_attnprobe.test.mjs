import { describe, expect, test } from "bun:test";

import {
  convertToProbeInput,
  extractRequestMessages,
  parseTranscriptInput,
} from "./transcript_to_attnprobe.mjs";

const sampleRequest = {
  model: { id: "test-model" },
  systemPrompt: ["do not include this giant system prompt"],
  tools: [{ name: "read", description: "also not transcript content" }],
  messages: [
    {
      role: "user",
      content: [
        { type: "text", text: "Please inspect src/app.ts" },
        { type: "image", mimeType: "image/png", detail: "original", data: "A".repeat(128) },
      ],
      timestamp: 1,
    },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Need to read the file first." },
        { type: "toolCall", id: "call_read_1", name: "read", arguments: { path: "src/app.ts" } },
      ],
      model: "test-model",
      timestamp: 2,
    },
    {
      role: "toolResult",
      toolCallId: "call_read_1",
      toolName: "read",
      content: [{ type: "text", text: "export function boot() { return true; }" }],
      isError: false,
      timestamp: 3,
    },
    {
      role: "developer",
      content: [{ type: "text", text: "<system-notice>keep this runtime notice</system-notice>" }],
      timestamp: 4,
    },
    {
      role: "assistant",
      content: [{ type: "text", text: "The current answer should use boot()." }],
      model: "test-model",
      timestamp: 5,
    },
  ],
};

describe("transcript_to_attnprobe", () => {
  test("extracts OMP request messages instead of system prompt/tool definitions", () => {
    const parsed = parseTranscriptInput(JSON.stringify(sampleRequest));
    const messages = extractRequestMessages(parsed);

    expect(messages).toHaveLength(sampleRequest.messages.length);
    expect(JSON.stringify(messages)).not.toContain("giant system prompt");
    expect(JSON.stringify(messages)).not.toContain("also not transcript content");
  });

  test("converts OMP request JSON to attnprobe tail and thermocline-style candidates", () => {
    const out = convertToProbeInput(sampleRequest, { protectTokens: 1 });

    expect(out.tail).toContain("The current answer should use boot().");
    expect(out.blocks.length).toBeGreaterThanOrEqual(3);

    const toolPair = out.blocks.find((b) => b.id === "r:call_read_1");
    expect(toolPair).toBeDefined();
    expect(toolPair.text).toContain('read {"path":"src/app.ts"}');
    expect(toolPair.text).toContain("export function boot() { return true; }");

    const allText = JSON.stringify(out);
    expect(allText).toContain("[image image/png detail=original bytes=128]");
    expect(allText).not.toContain("AAAA");
    expect(allText).toContain("<system-notice>keep this runtime notice</system-notice>");
  });

  test("parses newline-delimited message JSON as a transcript", () => {
    const raw = sampleRequest.messages.map((m) => JSON.stringify(m)).join("\n");
    const parsed = parseTranscriptInput(raw);
    const out = convertToProbeInput(parsed, { protectTokens: 1 });

    expect(out.tail).toContain("The current answer should use boot().");
    expect(out.meta.inputFormat).toBe("jsonl-messages");
  });
});
