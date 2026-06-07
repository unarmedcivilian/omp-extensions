const FADE_IN = "_ompGenerativeUiFadeIn 0.3s ease both";

export function applyHTML(root: HTMLElement, html: string): void {
  root.innerHTML = html;
  for (const node of root.querySelectorAll<HTMLElement>("*:not(style):not(script)")) {
    node.style.animation = FADE_IN;
  }
}

export async function runScripts(root: HTMLElement): Promise<void> {
  const scripts = Array.from(root.querySelectorAll("script"));
  for (const old of scripts) {
    const script = document.createElement("script");
    for (const attr of Array.from(old.attributes)) {
      script.setAttribute(attr.name, attr.value);
    }
    if (old.src) {
      const loaded = Promise.withResolvers<void>();
      script.addEventListener("load", () => loaded.resolve(), { once: true });
      script.addEventListener("error", () => loaded.reject(new Error(`Failed to load ${old.src}`)), { once: true });
      old.parentNode?.replaceChild(script, old);
      await loaded.promise;
    } else {
      script.textContent = old.textContent ?? "";
      old.parentNode?.replaceChild(script, old);
    }
  }
}
