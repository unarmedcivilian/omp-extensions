import { describe, expect, test } from "bun:test";

const GENERATIVE_UI_PACKAGE = "extensions/generative-ui/package.json";
const CHATGPT_PRO_PACKAGE = "extensions/chatgpt-pro-consult/package.json";
const ACCORDION_PACKAGE = "extensions/accordion/package.json";

interface RootPackage {
  private?: boolean;
  workspaces?: string[];
  omp?: unknown;
  scripts?: Record<string, string>;
}

interface ExtensionPackage {
  name?: string;
  omp?: { extensions?: string[] };
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

describe("workspace layout", () => {
  test("root package is a private workspace host", async () => {
    const rootPackage = await Bun.file("package.json").json() as RootPackage;
    expect(rootPackage.private).toBe(true);
    expect(rootPackage.workspaces).toContain("extensions/*");
    expect(rootPackage.omp).toBeUndefined();
  });

  test("generative UI extension lives in its own workspace package", async () => {
    const extensionPackage = await Bun.file(GENERATIVE_UI_PACKAGE).json() as ExtensionPackage;
    expect(extensionPackage.name).toBe("omp-generative-ui");
    expect(extensionPackage.omp?.extensions).toEqual(["./src/index.ts"]);
    expect(extensionPackage.scripts?.check).toContain("bun test tests/*.test.ts");
  });

  test("ChatGPT Pro consult extension lives in its own workspace package and root checks include it", async () => {
    const rootPackage = await Bun.file("package.json").json() as RootPackage;
    const extensionPackage = await Bun.file(CHATGPT_PRO_PACKAGE).json() as ExtensionPackage;

    expect(extensionPackage.name).toBe("omp-chatgpt-pro-consult");
    expect(extensionPackage.omp?.extensions).toEqual(["./src/index.ts"]);
    expect(extensionPackage.dependencies?.["codex-chatgpt-control"]).toBeDefined();
    expect(extensionPackage.peerDependencies?.["@oh-my-pi/pi-coding-agent"]).toBe("^15");
    expect(extensionPackage.scripts?.check).toContain("bun test tests/*.test.ts");
    expect(rootPackage.scripts?.test).toContain("bun --cwd extensions/chatgpt-pro-consult test");
    expect(rootPackage.scripts?.check).toContain("bun --cwd extensions/chatgpt-pro-consult check");
  });

  test("Accordion extension lives in its own browser-only workspace package and root checks include it", async () => {
    const rootPackage = await Bun.file("package.json").json() as RootPackage;
    const extensionPackage = await Bun.file(ACCORDION_PACKAGE).json() as ExtensionPackage;

    expect(extensionPackage.name).toBe("omp-accordion");
    expect(extensionPackage.omp?.extensions).toEqual(["./src/index.ts"]);
    expect(extensionPackage.devDependencies?.ws).toBeDefined();
    expect(extensionPackage.peerDependencies?.["@oh-my-pi/pi-coding-agent"]).toBe("^15");
    expect(extensionPackage.peerDependencies?.["@oh-my-pi/pi-agent-core"]).toBe("^15");
    expect(extensionPackage.peerDependencies?.["@oh-my-pi/pi-ai"]).toBe("^15");
    expect(extensionPackage.scripts?.check).toContain("bun test tests/*.test.ts");
    expect(rootPackage.scripts?.test).toContain("bun --cwd extensions/accordion test");
    expect(rootPackage.scripts?.check).toContain("bun --cwd extensions/accordion check");
  });
});
