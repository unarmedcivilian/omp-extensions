import { describe, expect, test } from "bun:test";
import { attachAgentPrompt } from "../src/features/agent-prompt.js";
import type { RpcHandler, RpcHost } from "../src/rpc.js";
import type { HostToPage } from "../src/protocol.js";

class FakeRpc implements RpcHost {
  handlers = new Map<string, RpcHandler>();
  pushed: HostToPage[] = [];

  handle(method: string, fn: RpcHandler): void {
    this.handlers.set(method, fn);
  }

  push(msg: HostToPage): void {
    this.pushed.push(msg);
  }

  call(method: string, params: unknown): Promise<unknown> | unknown {
    const handler = this.handlers.get(method);
    if (!handler) throw new Error(`missing handler ${method}`);
    return handler(params);
  }
}

describe("attachAgentPrompt", () => {
  test("queues visible follow-up messages with widget provenance", async () => {
    const rpc = new FakeRpc();
    const sent: Array<{ text: string; deliverAs?: string }> = [];
    attachAgentPrompt(rpc, {
      title: "pricing comparison",
      sendUserMessage(text, options) {
        sent.push({ text, deliverAs: options?.deliverAs });
      },
    });

    const result = await rpc.call("agent.prompt", { text: " Tell me more about Pro. " });

    expect(result).toEqual({ queued: true });
    expect(sent).toEqual([{ text: 'From widget "pricing comparison":\nTell me more about Pro.', deliverAs: "followUp" }]);
  });

  test("uses the latest widget title", async () => {
    const rpc = new FakeRpc();
    const sent: string[] = [];
    let title = "Widget";
    attachAgentPrompt(rpc, { title: () => title, sendUserMessage(text) { sent.push(text); } });
    title = "extension smoke test";

    await rpc.call("agent.prompt", { text: "Confirm the prompt path." });

    expect(sent).toEqual(['From widget "extension smoke test":\nConfirm the prompt path.']);
  });

  test("rejects empty and oversized prompts", () => {
    const rpc = new FakeRpc();
    attachAgentPrompt(rpc, { title: "w", sendUserMessage() {} });

    expect(() => rpc.call("agent.prompt", { text: "   " })).toThrow("agent.prompt requires non-empty text");
    expect(() => rpc.call("agent.prompt", { text: "x".repeat(4001) })).toThrow("agent.prompt text exceeds 4000 characters");
  });

  test("limits prompt count per widget", async () => {
    const rpc = new FakeRpc();
    attachAgentPrompt(rpc, { title: "w", maxPrompts: 1, sendUserMessage() {} });

    await rpc.call("agent.prompt", { text: "first" });

    expect(() => rpc.call("agent.prompt", { text: "second" })).toThrow("agent.prompt limit reached for this widget");
  });
});
