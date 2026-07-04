import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";

const packageRoot = join(import.meta.dir, "..");
const sourceRoot = join(packageRoot, "src");

async function collectFiles(root: string, dir = ""): Promise<string[]> {
  const entries = await readdir(join(root, dir), { withFileTypes: true });
  const files = await Promise.all(entries.map(async entry => {
    const rel = dir ? `${dir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return collectFiles(root, rel);
    return [rel];
  }));
  return files.flat().sort();
}

describe("Accordion source-preserved package", () => {
  test("includes copied app, live UI, and conductor engine source under the packaged src tree", async () => {
    const files = await collectFiles(sourceRoot);
    const requiredSourceSuffixes = [
      "routes/+page.svelte",
      "routes/conductor/+page.svelte",
      "routes/conductor/[sessionId]/+page.svelte",
      "lib/ui/live/SessionsSidebar.svelte",
      "lib/ui/map/ContextMap.svelte",
      "lib/ui/conductor/ConductorDashboard.svelte",
      "lib/live/conductorClient.svelte.ts",
      "lib/engine/store.svelte.ts",
      "lib/engine/conductor.test.ts",
    ];
    const foundSourcePaths = Object.fromEntries(requiredSourceSuffixes.map(suffix => [
      suffix,
      files.find(file => file.endsWith(suffix)) ?? null,
    ]));

    expect(foundSourcePaths).toEqual(Object.fromEntries(requiredSourceSuffixes.map(suffix => [
      suffix,
      expect.any(String),
    ])));
  });

  test("copied browser app source keeps the OMP browser-served auto-connect contract", async () => {
    const files = await collectFiles(sourceRoot);
    const route = files.find(file => file.endsWith("routes/+page.svelte"));
    if (!route) throw new Error("source-preserved Accordion route source was not packaged under src");

    const routeText = await Bun.file(join(sourceRoot, route)).text();
    const autoConnectMarkers = [
      "fetch(\"/__accordion/meta\"",
      "credentials: \"same-origin\"",
      "body.served !== true",
      "servedSessionId = body.sessionId",
      "connectLive(port)",
    ];
    const foundMarkers = autoConnectMarkers.filter(marker => routeText.includes(marker));

    expect({ route: relative(packageRoot, join(sourceRoot, route)), foundMarkers }).toEqual({
      route: expect.any(String),
      foundMarkers: autoConnectMarkers,
    });
  });
});
