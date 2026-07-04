import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = path.resolve(here, "..");
const src = path.join(pkg, "src", "client");
const dest = path.join(pkg, "dist", "client");

if (!fs.existsSync(src) || !fs.statSync(src).isDirectory()) {
  console.error(`Accordion browser client source not found at ${src}`);
  process.exit(1);
}

fs.rmSync(dest, { recursive: true, force: true });
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.cpSync(src, dest, { recursive: true });
const indexPath = path.join(dest, "index.html");
if (fs.existsSync(indexPath)) {
  const html = fs.readFileSync(indexPath, "utf8");
  if (!html.includes("__accordion")) {
    fs.writeFileSync(indexPath, html.replace("</title>", "</title>\n    <!-- __accordion runtime metadata is served from /__accordion/meta -->"));
  }
}
console.log(`Copied ${src} -> ${dest}`);
