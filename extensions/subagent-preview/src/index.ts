import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

const installedApis = new WeakSet<object>();

export function createSubagentPreviewExtension(): (pi: ExtensionAPI) => void {
  return function subagentPreviewExtension(pi: ExtensionAPI): void {
    if (installedApis.has(pi as object)) {
      pi.logger.warn("subagent-preview extension already installed; skipping duplicate registration");
      return;
    }
    installedApis.add(pi as object);
    pi.setLabel("Subagent Preview");

    pi.on("session_start", async () => undefined);
    pi.on("session_switch", async () => undefined);
    pi.on("session_branch", async () => undefined);
    pi.on("session_tree", async () => undefined);
    pi.on("session_shutdown", async () => undefined);

    pi.registerCommand("subagent-preview", {
      description: "Open, close, enable, or disable the subagent preview dashboard",
      handler: async () => undefined,
    });
  };
}

const subagentPreviewExtension = createSubagentPreviewExtension();
export default subagentPreviewExtension;
