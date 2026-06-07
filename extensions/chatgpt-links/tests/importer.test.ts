import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ChatGptExtractionError,
  ChatGptLoginRequiredError,
  defaultConversationPath,
  importChatGptConversation,
  normalizeConversation,
  type BrowserAutomation,
} from "../src/importer.js";

class FakeBrowser implements BrowserAutomation {
  calls: string[] = [];
  surface = "surface:7";

  #texts: Array<string | Error>;

  constructor(text: string | Error | Array<string | Error>) {
    this.#texts = Array.isArray(text) ? [...text] : [text];
  }

  async open(url: string): Promise<string> {
    this.calls.push(`open:${url}`);
    return this.surface;
  }

  async waitForLoad(surface: string, timeoutMs: number): Promise<void> {
    this.calls.push(`wait:${surface}:${timeoutMs}`);
  }

  async getText(surface: string, selector: string): Promise<string> {
    this.calls.push(`getText:${surface}:${selector}`);
    const next = this.#texts.length > 1 ? this.#texts.shift()! : this.#texts[0];
    if (next instanceof Error) throw next;
    return next ?? "";
  }

  async close(surface: string): Promise<void> {
    this.calls.push(`close:${surface}`);
  }
}

describe("ChatGPT conversation importer", () => {
  test("normalizes bare conversation ids and ChatGPT links", () => {
    expect(normalizeConversation("6a216a0f-58f4-83a8-9811-4cab2782a84f")).toEqual({
      id: "6a216a0f-58f4-83a8-9811-4cab2782a84f",
      url: "https://chatgpt.com/c/6a216a0f-58f4-83a8-9811-4cab2782a84f",
    });
    expect(normalizeConversation("https://chatgpt.com/c/6a216a0f-58f4-83a8-9811-4cab2782a84f?model=gpt-5#bottom")).toEqual({
      id: "6a216a0f-58f4-83a8-9811-4cab2782a84f",
      url: "https://chatgpt.com/c/6a216a0f-58f4-83a8-9811-4cab2782a84f",
    });
  });

  test("builds default artifact paths from conversation ids", () => {
    expect(defaultConversationPath("6a216a0f-58f4-83a8-9811-4cab2782a84f", "tmp/chatgpt")).toBe("tmp/chatgpt/6a216a0f-58f4-83a8-9811-4cab2782a84f.txt");
  });

  test("opens, extracts, saves, and closes successful imports", async () => {
    const artifactsDir = await mkdtemp(join(tmpdir(), "omp-chatgpt-import-"));
    const text = "Arrow Flight DuckDB worker prototype\n\nSaved as chat\nUser\nHow do I test an extension?\nChatGPT\nUse a fake browser runner and assert saved output.";
    const browser = new FakeBrowser(text);

    try {
      const result = await importChatGptConversation({
        conversation: "6a216a0f-58f4-83a8-9811-4cab2782a84f",
        artifactsDir,
        browser,
      });

      const expectedPath = join(artifactsDir, "6a216a0f-58f4-83a8-9811-4cab2782a84f.txt");
      expect(await readFile(expectedPath, "utf8")).toBe(text);
      expect(browser.calls).toEqual([
        "open:https://chatgpt.com/c/6a216a0f-58f4-83a8-9811-4cab2782a84f",
        "wait:surface:7:30000",
        "getText:surface:7:main",
        "close:surface:7",
      ]);
      expect(result).toEqual({
        conversationId: "6a216a0f-58f4-83a8-9811-4cab2782a84f",
        url: "https://chatgpt.com/c/6a216a0f-58f4-83a8-9811-4cab2782a84f",
        path: expectedPath,
        bytes: Buffer.byteLength(text),
        surface: "surface:7",
      });
    } finally {
      await rm(artifactsDir, { recursive: true, force: true });
    }
  });

  test("waits for ChatGPT to hydrate conversation text after load", async () => {
    const artifactsDir = await mkdtemp(join(tmpdir(), "omp-chatgpt-delayed-text-"));
    const text = "Arrow Flight DuckDB worker prototype\n\nSaved as chat\nUser\nSketch the concrete Go interfaces.\nChatGPT\nHere are the server and supervisor interfaces.";
    const browser = new FakeBrowser([new Error('not_found: Element "main" not found or not visible'), "", "   ", text]);
    try {
      const result = await importChatGptConversation({
        conversation: "6a216a0f-58f4-83a8-9811-4cab2782a84f",
        artifactsDir,
        browser,
        waitTimeoutMs: 1000,
      });

      expect(await readFile(result.path, "utf8")).toBe(text);
      expect(browser.calls).toEqual([
        "open:https://chatgpt.com/c/6a216a0f-58f4-83a8-9811-4cab2782a84f",
        "wait:surface:7:1000",
        "getText:surface:7:main",
        "getText:surface:7:main",
        "getText:surface:7:main",
        "getText:surface:7:main",
        "close:surface:7",
      ]);
    } finally {
      await rm(artifactsDir, { recursive: true, force: true });
    }
  });

  test("leaves the surface open when login is required", async () => {
    const browser = new FakeBrowser("ChatGPT\nLog in\nSign up to continue");

    await expect(importChatGptConversation({
      conversation: "6a216a0f-58f4-83a8-9811-4cab2782a84f",
      browser,
    })).rejects.toBeInstanceOf(ChatGptLoginRequiredError);

    expect(browser.calls).not.toContain("close:surface:7");
  });

  test("leaves the surface open when extraction is empty", async () => {
    const browser = new FakeBrowser("   ");

    await expect(importChatGptConversation({
      conversation: "6a216a0f-58f4-83a8-9811-4cab2782a84f",
      browser,
      waitTimeoutMs: 1,
    })).rejects.toBeInstanceOf(ChatGptExtractionError);

    expect(browser.calls).not.toContain("close:surface:7");
  });
});
