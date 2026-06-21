import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile, appendFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { summarizeSessionEntry, TranscriptTailer } from "../src/transcript.js";

describe("transcript summarizer", () => {
  test("summarizes assistant text and hides thinking", () => {
    const entry = { type: "message", timestamp: "t", message: { role: "assistant", content: [{ type: "thinking", thinking: "secret" }, { type: "text", text: "Visible answer" }] } };
    expect(summarizeSessionEntry(entry)).toEqual([{ kind: "assistant", timestamp: "t", text: "Visible answer", truncated: false }]);
  });

  test("summarizes tool calls and truncates large results", () => {
    const call = { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "x".repeat(1000) } }] } };
    const result = { type: "message", message: { role: "toolResult", toolName: "bash", isError: true, content: [{ type: "text", text: "y".repeat(1000) }] } };
    expect(summarizeSessionEntry(call)[0]).toMatchObject({ kind: "tool_call", text: expect.stringContaining("bash"), truncated: true });
    expect(summarizeSessionEntry(result)[0]).toMatchObject({ kind: "tool_result", isError: true, truncated: true });
  });
});

describe("TranscriptTailer", () => {
  test("parses appended JSONL incrementally and tolerates partial lines", async () => {
    const dir = await mkdtemp(join(tmpdir(), "subagent-preview-"));
    const file = join(dir, "session.jsonl");
    try {
      await writeFile(file, `${JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "one" }] } })}\n`);
      const tailer = new TranscriptTailer(file);
      expect(await tailer.readNew()).toEqual([{ kind: "assistant", text: "one", truncated: false }]);
      await appendFile(file, `${JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "two" }] } })}`);
      expect(await tailer.readNew()).toEqual([]);
      await appendFile(file, "\n");
      expect(await tailer.readNew()).toEqual([{ kind: "assistant", text: "two", truncated: false }]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
