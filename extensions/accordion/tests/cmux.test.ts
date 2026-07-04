import { describe, expect, test } from "bun:test";
import { createAccordionBrowserOpener } from "../src/cmux.js";

describe("Accordion cmux browser opener", () => {
  test("pre-aborted signal returns a soft failure without invoking socket exchange", async () => {
    const controller = new AbortController();
    controller.abort();
    let exchangeCalls = 0;
    const open = createAccordionBrowserOpener(async () => {
      exchangeCalls++;
      return JSON.stringify({ surface: "should-not-open" });
    });

    const result = await open("http://127.0.0.1:37123/accordion", controller.signal);

    expect(exchangeCalls).toBe(0);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("aborted");
  });

  test("mid-flight abort reaches the socket exchange signal and returns a soft failure", async () => {
    const exchangeStarted = Promise.withResolvers<void>();
    const abortObserved = Promise.withResolvers<void>();
    const controller = new AbortController();
    const open = createAccordionBrowserOpener((_payload, _socketPath, signal) => {
      const exchange = Promise.withResolvers<string>();
      exchangeStarted.resolve();
      signal?.addEventListener("abort", () => {
        abortObserved.resolve();
        exchange.reject(new Error("exchange observed abort"));
      }, { once: true });
      return exchange.promise;
    });

    const resultPromise = open("http://127.0.0.1:37123/accordion", controller.signal);
    await exchangeStarted.promise;
    controller.abort();
    await abortObserved.promise;

    await expect(resultPromise).resolves.toEqual({ ok: false, error: "exchange observed abort" });
  });
});
