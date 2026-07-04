import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { createStaticHandler } from "../src/static.js";

type StaticHandler = (req: Request) => Promise<Response> | Response;

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map(dir => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

async function makeRoot() {
  const root = await mkdtemp(join(tmpdir(), "accordion-static-"));
  tempDirs.push(root);
  await mkdir(join(root, "assets"), { recursive: true });
  await writeFile(join(root, "index.html"), "<main>Accordion</main>");
  await writeFile(join(root, "assets", "app.js"), "console.log('ok')");
  await writeFile(join(root, "assets", "style.css"), "main { color: teal }");
  return root;
}

async function call(handler: StaticHandler, path: string, cookie?: string) {
  const init = cookie ? { headers: { cookie } } : undefined;
  return handler(new Request(`http://127.0.0.1${path}`, init));
}

const packagedClientRoot = join(import.meta.dir, "..", "dist", "client");
const browserTextAssetExtensions: Record<string, true> = {
  ".css": true,
  ".html": true,
  ".js": true,
  ".json": true,
  ".jsonl": true,
  ".map": true,
  ".svg": true,
  ".txt": true,
};

async function collectPackagedClientFiles(dir = ""): Promise<string[]> {
  const entries = await readdir(join(packagedClientRoot, dir), { withFileTypes: true });
  const files = await Promise.all(entries.map(async entry => {
    const rel = dir ? `${dir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return collectPackagedClientFiles(rel);
    return [rel];
  }));
  return files.flat().sort();
}

async function collectPackagedClientTextAssets() {
  const files = await collectPackagedClientFiles();
  const textFiles = files.filter(file => browserTextAssetExtensions[extname(file)]);
  return Promise.all(textFiles.map(async file => ({
    file,
    content: await Bun.file(join(packagedClientRoot, file)).text(),
  })));
}

describe("Accordion static handler", () => {
  test("serves ungated metadata with session and protocol information", async () => {
    const root = await makeRoot();
    const handler = createStaticHandler({ clientRoot: root, token: "secret", sessionId: "s1", protocolVersion: 5 });

    const res = await call(handler, "/__accordion/meta");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ served: true, sessionId: "s1", protocolVersion: 5 });
  });

  test("rejects static files without token", async () => {
    const root = await makeRoot();
    const handler = createStaticHandler({ clientRoot: root, token: "secret", sessionId: "s1", protocolVersion: 5 });

    const res = await call(handler, "/");

    expect(res.status).toBe(403);
    expect(await res.text()).toContain("Accordion");
  });

  test("serves index with query token and sets the reusable auth cookie", async () => {
    const root = await makeRoot();
    const handler = createStaticHandler({ clientRoot: root, token: "secret", sessionId: "s1", protocolVersion: 5 });

    const res = await call(handler, "/?token=secret");

    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toContain("accordion_token=secret");
    expect(await res.text()).toContain("Accordion");
  });

  test("serves assets authenticated by cookie with stable MIME types", async () => {
    const root = await makeRoot();
    const handler = createStaticHandler({ clientRoot: root, token: "secret", sessionId: "s1", protocolVersion: 5 });

    const js = await call(handler, "/assets/app.js", "accordion_token=secret");
    const css = await call(handler, "/assets/style.css", "accordion_token=secret");

    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toContain("text/javascript");
    expect(await js.text()).toContain("console.log");
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toContain("text/css");
  });

  test("rejects encoded traversal before resolving a filesystem path", async () => {
    const root = await makeRoot();
    const handler = createStaticHandler({ clientRoot: root, token: "secret", sessionId: "s1", protocolVersion: 5 });

    const encodedSlash = await call(handler, "/%2e%2e%2fpackage.json?token=secret");
    const encodedBackslash = await call(handler, "/%2e%2e%5cpackage.json?token=secret");

    expect(encodedSlash.status).toBe(403);
    expect(encodedBackslash.status).toBe(403);
  });

  test("packaged browser client is not the handwritten rewrite and auto-connects when browser-served", async () => {
    const textAssets = await collectPackagedClientTextAssets();
    const minimalRewriteMarkers = [
      "No context blocks yet.",
      "Blocks tracked",
      "document.querySelector(\"#blocks\")",
      "Queued fold for #",
    ];
    const browserServedAutoConnectMarkers = [
      "/__accordion/meta",
      "same-origin",
      "protocolVersion",
      "sessionId",
      "served",
    ];
    const minimalRewriteHits = minimalRewriteMarkers.flatMap(marker =>
      textAssets
        .filter(asset => asset.content.includes(marker))
        .map(asset => `${asset.file}: ${marker}`)
    );
    const browserServedAutoConnectHits = browserServedAutoConnectMarkers.filter(marker =>
      textAssets.some(asset => asset.content.includes(marker))
    );

    expect({ minimalRewriteHits, browserServedAutoConnectHits }).toEqual({
      minimalRewriteHits: [],
      browserServedAutoConnectHits: browserServedAutoConnectMarkers,
    });
  });

  test("packaged browser client uses a deterministic SvelteKit app version", async () => {
    const version = await Bun.file(join(packagedClientRoot, "_app", "version.json")).json() as { version?: string };

    expect(version).toEqual({ version: "omp-accordion" });
  });


  test("serves the packaged browser index and app asset through token auth", async () => {
    const handler = createStaticHandler({ clientRoot: packagedClientRoot, token: "secret", sessionId: "s1", protocolVersion: 5 });

    const index = await call(handler, "/?token=secret");
    const indexBody = await index.text();
    const appAsset = indexBody.match(/<script[^>]+src="([^"]*\/app(?:\.[^"]+)?\.js)"/)?.[1]
      ?? indexBody.match(/import\("([^"]*\/app(?:\.[^"]+)?\.js)"\)/)?.[1]
      ?? indexBody.match(/href="([^"]*\/app(?:\.[^"]+)?\.js)"/)?.[1];

    expect(index.status).toBe(200);
    expect(index.headers.get("set-cookie")).toContain("accordion_token=secret");
    expect(indexBody).toContain("<title>Accordion</title>");
    if (!appAsset) throw new Error("packaged index did not reference an app entry asset");

    const app = await call(handler, appAsset, "accordion_token=secret");
    const expectedAppBody = await Bun.file(join(packagedClientRoot, appAsset.startsWith("/") ? appAsset.slice(1) : appAsset)).text();

    expect(app.status).toBe(200);
    expect(app.headers.get("content-type")).toContain("text/javascript");
    expect(await app.text()).toBe(expectedAppBody);
  });
});
