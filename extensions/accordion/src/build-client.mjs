import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = path.resolve(here, "..");
const src = path.join(pkg, "src", "app", "build");
const dest = path.join(pkg, "dist", "client");

if (!fs.existsSync(src) || !fs.statSync(src).isDirectory()) {
  console.error(`Accordion browser app build not found at ${src}`);
  console.error("Run `bun --cwd extensions/accordion/src/app build`, then retry `bun --cwd extensions/accordion build:client`.");
  process.exit(1);
}

fs.rmSync(dest, { recursive: true, force: true });
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.cpSync(src, dest, { recursive: true });
console.log(`Copied ${src} -> ${dest}`);
