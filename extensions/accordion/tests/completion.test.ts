import { describe, expect, test } from "bun:test";
import { runCompletionRequest } from "../src/completion.js";
import { makeCtx } from "./helpers.js";

interface CompletionTextPart {
  type: "text";
  text: string;
}

interface FakeCompletionOutput {
  content: CompletionTextPart[];
  usage?: Record<string, number>;
}

interface CompleteRequest {
  type: "completeRequest";
  reqId: string;
  prompt?: string;
  systemPrompt?: string;
  maxOutputTokens?: number;
}

interface CompleteResult {
  type?: string;
  reqId?: string;
  ok?: boolean;
  text?: string;
  usage?: Record<string, number>;
  error?: string;
}

function request(overrides: Partial<CompleteRequest> = {}): CompleteRequest {
  return { type: "completeRequest", reqId: "complete-1", prompt: "Write a concise summary", ...overrides };
}

describe("completion relay", () => {
  test("completeRequest without a prompt returns an in-band error", async () => {
    const result: CompleteResult = await runCompletionRequest(request({ prompt: "" }), makeCtx(), null, {});

    expect(result).toMatchObject({ type: "completeResult", reqId: "complete-1", ok: false });
    expect(result.error).toContain("prompt");
  });

  test("completeRequest without a current model returns an in-band error", async () => {
    const result: CompleteResult = await runCompletionRequest(request(), makeCtx({ model: null }), null, {});

    expect(result).toMatchObject({ type: "completeResult", reqId: "complete-1", ok: false });
    expect(result.error).toContain("model");
  });

  test("completeRequest without an API key returns an in-band error", async () => {
    const result: CompleteResult = await runCompletionRequest(request(), makeCtx({ apiKey: null }), null, {});

    expect(result).toMatchObject({ type: "completeResult", reqId: "complete-1", ok: false });
    expect(result.error).toContain("API key");
  });

  test("successful completion concatenates text parts and returns usage", async () => {
    const calls: unknown[] = [];
    const complete = async (input: unknown): Promise<FakeCompletionOutput> => {
      calls.push(input);
      return {
        content: [
          { type: "text", text: "Hello " },
          { type: "text", text: "world" },
        ],
        usage: { inputTokens: 7, outputTokens: 2 },
      };
    };

    const result: CompleteResult = await runCompletionRequest(
      request({ systemPrompt: "You are brief." }),
      makeCtx({ apiKey: "key-1" }),
      null,
      { complete },
    );

    expect(result).toEqual({
      type: "completeResult",
      reqId: "complete-1",
      ok: true,
      text: "Hello world",
      usage: { inputTokens: 7, outputTokens: 2 },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ apiKey: "key-1" });
  });

  test("latest model overrides ctx.model and requested maxOutputTokens clamps to model maxTokens", async () => {
    const calls: unknown[] = [];
    const latestModel = { id: "override-model", provider: "test", maxTokens: 128 };
    const complete = async (input: unknown): Promise<FakeCompletionOutput> => {
      calls.push(input);
      return { content: [{ type: "text", text: "ok" }], usage: { inputTokens: 1, outputTokens: 1 } };
    };

    const result: CompleteResult = await runCompletionRequest(
      request({ maxOutputTokens: 4096 }),
      makeCtx({ model: { id: "ctx-model", maxTokens: 2048 }, apiKey: "key-2" }),
      latestModel,
      { complete },
    );

    expect(result.ok).toBe(true);
    expect(calls[0]).toMatchObject({ model: latestModel, maxOutputTokens: 128 });
  });

  test("completion dependency failures are surfaced as completeResult errors instead of escaping the WebSocket handler", async () => {
    const complete = async (): Promise<FakeCompletionOutput> => {
      throw new Error("provider exploded");
    };

    const result: CompleteResult = await runCompletionRequest(request(), makeCtx(), null, { complete });

    expect(result).toMatchObject({ type: "completeResult", reqId: "complete-1", ok: false });
    expect(result.error).toContain("provider exploded");
  });
});
