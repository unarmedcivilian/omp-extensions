import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export function createChatGptProConsultExtension(): (pi: ExtensionAPI) => void {
  return function chatGptProConsultExtension(pi: ExtensionAPI): void {
    pi.setLabel("ChatGPT Pro Consult");
  };
}

export default createChatGptProConsultExtension();
