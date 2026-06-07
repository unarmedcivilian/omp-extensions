import { rpc } from "../bridge.js";

interface SvgActionResult {
  ok: boolean;
  path?: string;
}

export function installSvgSaver(): void {
  document.addEventListener("click", event => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const action = target.dataset.svgAction;
    if (!action) return;
    const svg = target.closest(".svg-actions")?.previousElementSibling;
    if (!(svg instanceof SVGElement)) return;
    const source = new XMLSerializer().serializeToString(svg);
    if (action === "copy") {
      void rpc<SvgActionResult>("svg.copy", { svg: source }).catch(error => console.error("[omp-generative-ui] svg copy failed:", error));
    }
    if (action === "save") {
      void rpc<SvgActionResult>("svg.save", { svg: source }).catch(error => console.error("[omp-generative-ui] svg save failed:", error));
    }
  });
}
