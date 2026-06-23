import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { createChatGptProConsultExtension } from "../src/index.js";

function makeFakePi(): { labels: string[]; api: ExtensionAPI } {
  const labels: string[] = [];
  const api = {
    setLabel(label: string) {
      labels.push(label);
    },
  } as unknown as ExtensionAPI;

  return { labels, api };
}

describe("ChatGPT Pro consult extension", () => {
  test("sets the OMP label during factory execution", () => {
    const fake = makeFakePi();

    createChatGptProConsultExtension()(fake.api);

    expect(fake.labels).toEqual(["ChatGPT Pro Consult"]);
  });
});
