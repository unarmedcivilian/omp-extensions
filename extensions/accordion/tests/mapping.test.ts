import { describe, expect, test } from "bun:test";
import { applyPlan, linearize } from "../src/app/src/lib/live/mapping.js";

interface TextPart {
  type: "text";
  text: string;
}

interface ToolCallPart {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

interface PiMessage {
  role: string;
  responseId?: string;
  toolCallId?: string;
  content: string | Array<TextPart | ToolCallPart>;
}

function assistantText(id: string, text = "hello"): PiMessage {
  return {
    role: "assistant",
    responseId: id,
    content: [{ type: "text", text }],
  };
}

function firstText(messages: PiMessage[]): string | undefined {
  const content = messages[0]?.content;
  if (!Array.isArray(content)) return undefined;
  const [part] = content;
  if (!part || part.type !== "text") return undefined;
  return part.text;
}

describe("Accordion live mapping", () => {
  test("linearize creates durable assistant text block ids", () => {
    const blocks = linearize([assistantText("resp-1", "hello")]);

    expect(blocks).toHaveLength(1);
    expect(blocks[0].id).toBe("a:resp-1:p0");
    expect(blocks[0].kind).toBe("text");
    expect(blocks[0].text).toBe("hello");
  });

  test("linearize never emits positional ids for assistant text with response ids", () => {
    const blocks = linearize([assistantText("resp-2", "first"), assistantText("resp-3", "second")]);

    expect(blocks.map(block => block.id)).toEqual(["a:resp-2:p0", "a:resp-3:p0"]);
    expect(blocks.every(block => !block.id.startsWith("m"))).toBe(true);
  });

  test("applyPlan refuses positional ids so stale browser plans cannot rewrite unrelated messages", () => {
    const messages: PiMessage[] = [{ role: "assistant", content: [{ type: "text", text: "ORIGINAL" }] }];

    const output = applyPlan(messages, [{ id: "m0:p0", digestText: "{#abc FOLDED} summary" }]);

    expect(output).toBe(messages);
    expect(firstText(output)).toBe("ORIGINAL");
  });

  test("applyPlan replaces only the targeted durable text part with the digest", () => {
    const messages = [assistantText("resp-1", "FULL CONTENT"), assistantText("resp-2", "UNCHANGED")];

    const output = applyPlan(messages, [{ id: "a:resp-1:p0", digestText: "{#abc FOLDED} summary" }]);

    expect(output).not.toBe(messages);
    expect(firstText(output)).toBe("{#abc FOLDED} summary");
    expect(firstText(output.slice(1))).toBe("UNCHANGED");
    expect(firstText(messages)).toBe("FULL CONTENT");
  });

  test("applyPlan refuses a group fold that would orphan a tool result from its tool call", () => {
    const messages: PiMessage[] = [
      {
        role: "assistant",
        responseId: "resp-tools",
        content: [{ type: "toolCall", id: "call-1", name: "read", arguments: {} }],
      },
      {
        role: "toolResult",
        toolCallId: "call-1",
        content: [{ type: "text", text: "tool output" }],
      },
      assistantText("resp-after", "safe text"),
    ];

    const output = applyPlan(messages, [], [{ id: "group-1", memberIds: ["r:call-1"], summaryText: "{#tool FOLDED} tool result only" }]);

    expect(output).toBe(messages);
  });

  test("applyPlan accepts a group fold only when the tool call and result stay together", () => {
    const messages: PiMessage[] = [
      {
        role: "assistant",
        responseId: "resp-tools",
        content: [{ type: "toolCall", id: "call-1", name: "read", arguments: {} }],
      },
      {
        role: "toolResult",
        toolCallId: "call-1",
        content: [{ type: "text", text: "tool output" }],
      },
    ];

    const output = applyPlan(messages, [], [{ id: "group-1", memberIds: ["a:resp-tools:p0", "r:call-1"], summaryText: "{#tool FOLDED} read output" }]);

    expect(output).not.toBe(messages);
    expect(linearize(output).map(block => block.text).join("\n")).toContain("{#tool FOLDED} read output");
  });
});
