import { readFile, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";

export interface StaticHandlerOptions {
  clientRoot: string;
  token: string;
  sessionId: string;
  protocolVersion: number;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json",
};

function isAuthed(req: Request, url: URL, token: string): boolean {
  if (!token) return false;
  if (url.searchParams.get("token") === token) return true;
  const cookie = req.headers.get("cookie") ?? "";
  return cookie.split(";").some(item => item.trim() === `accordion_token=${token}`);
}

function isUnsafeDecodedPath(pathname: string): boolean {
  if (pathname.includes("\0") || pathname.includes("\\")) return true;
  return pathname.split("/").includes("..");
}

export function createStaticHandler(options: StaticHandlerOptions): (req: Request) => Promise<Response> {
  const root = resolve(options.clientRoot);

  return async function handle(req: Request): Promise<Response> {
    try {
      const url = new URL(req.url);

      if (url.pathname === "/__accordion/meta") {
        return Response.json({ served: true, sessionId: options.sessionId, protocolVersion: options.protocolVersion });
      }

      if (!isAuthed(req, url, options.token)) {
        return new Response("Forbidden — open Accordion via /accordion.", { status: 403, headers: { "Content-Type": "text/plain; charset=utf-8" } });
      }

      const headers = new Headers();
      if (url.searchParams.get("token") === options.token) {
        headers.set("Set-Cookie", `accordion_token=${options.token}; HttpOnly; SameSite=Strict; Path=/`);
      }

      let rel = decodeURIComponent(url.pathname);
      if (isUnsafeDecodedPath(rel)) return new Response("Forbidden", { status: 403, headers });
      if (rel === "/") rel = "/index.html";

      let filePath = resolve(root, `.${rel}`);
      const resolvedPath = filePath;
      if (resolvedPath !== root && !resolvedPath.startsWith(root + sep)) {
        return new Response("Forbidden", { status: 403, headers });
      }

      try {
        const info = await stat(resolvedPath);
        if (!info.isFile()) throw new Error("not a file");
      } catch {
        if (extname(rel) === "") {
          filePath = resolve(root, "index.html");
        } else {
          return new Response("Not found", { status: 404, headers });
        }
      }

      const body = await readFile(filePath);
      headers.set("Content-Type", MIME[extname(filePath).toLowerCase()] ?? "application/octet-stream");
      return new Response(body, { status: 200, headers });
    } catch {
      return new Response("Internal error", { status: 500, headers: { "Content-Type": "text/plain; charset=utf-8" } });
    }
  };
}
