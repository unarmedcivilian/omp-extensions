import { describe, expect, test } from "bun:test";

const GENERATIVE_UI_PACKAGE = "extensions/generative-ui/package.json";
const CHATGPT_PRO_PACKAGE = "extensions/chatgpt-pro-consult/package.json";

describe("workspace layout", () => {
  test("root package is a private workspace host", async () => {
    const rootPackage = await Bun.file("package.json").json() as { private?: boolean; workspaces?: string[]; omp?: unknown };
    expect(rootPackage.private).toBe(true);
    expect(rootPackage.workspaces).toContain("extensions/*");
    expect(rootPackage.omp).toBeUndefined();
  });

  test("generative UI extension lives in its own workspace package", async () => {
    const extensionPackage = await Bun.file(GENERATIVE_UI_PACKAGE).json() as { name?: string; omp?: { extensions?: string[] }; scripts?: Record<string, string> };
    expect(extensionPackage.name).toBe("omp-generative-ui");
    expect(extensionPackage.omp?.extensions).toEqual(["./src/index.ts"]);
    expect(extensionPackage.scripts?.check).toContain("bun test tests/*.test.ts");
  });

  test("ChatGPT Pro consult extension lives in its own workspace package and root checks include it", async () => {
    const rootPackage = await Bun.file("package.json").json() as { scripts?: Record<string, string> };
    const extensionPackage = await Bun.file(CHATGPT_PRO_PACKAGE).json() as {
      name?: string;
      omp?: { extensions?: string[] };
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };

    expect(extensionPackage.name).toBe("omp-chatgpt-pro-consult");
    expect(extensionPackage.omp?.extensions).toEqual(["./src/index.ts"]);
    expect(extensionPackage.dependencies?.["codex-chatgpt-control"]).toBeDefined();
    expect(extensionPackage.peerDependencies?.["@oh-my-pi/pi-coding-agent"]).toBe("^15");
    expect(extensionPackage.scripts?.check).toContain("bun test tests/*.test.ts");
    expect(rootPackage.scripts?.test).toContain("bun --cwd extensions/chatgpt-pro-consult test");
    expect(rootPackage.scripts?.check).toContain("bun --cwd extensions/chatgpt-pro-consult check");
  });
});
