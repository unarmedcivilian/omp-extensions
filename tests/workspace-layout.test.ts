import { describe, expect, test } from "bun:test";

const GENERATIVE_UI_PACKAGE = "extensions/generative-ui/package.json";

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
});
