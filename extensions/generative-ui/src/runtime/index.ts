import { installBridge, on } from "./bridge.js";
import { applyHTML, runScripts } from "./morph.js";
import { installSvgSaver } from "./features/svg-saver.js";

installBridge();
installSvgSaver();

const root = document.getElementById("root");

if (!root) {
  console.error("[omp-generative-ui] #root missing; aborting boot");
} else {
  on("content", msg => {
    applyHTML(root, msg.html);
    if (msg.final) {
      runScripts(root).catch(error => console.error("[omp-generative-ui] runScripts failed:", error));
    }
  });
}
