import type { LocatorLike, PageLike } from "codex-chatgpt-control";
import type { CmuxTransport } from "./cmux.js";
import type { ConsultDeadline, ConsultLifecycle } from "./consult.js";

export type CmuxPage = PageLike & {
  id: string;
  tabId: string;
  surface: string;
};

export interface CreateCmuxPageOptions {
  surface: string;
  tabId?: string;
  transport: CmuxTransport;
  signal?: AbortSignal;
  deadline?: ConsultDeadline;
  lifecycle?: ConsultLifecycle;
  interactionSettleMs?: number;
  owned?: boolean;
  onClose?: () => void;
}

type SerializedMatcher =
  | { kind: "string"; value: string }
  | { kind: "regexp"; source: string; flags: string };

type LocatorDescriptor =
  | { type: "css"; selector: string }
  | { type: "role"; role: string; name?: SerializedMatcher; exact?: boolean }
  | { type: "text"; text: SerializedMatcher; exact?: boolean }
  | { type: "placeholder"; text: SerializedMatcher; exact?: boolean }
  | { type: "descendant"; base: LocatorDescriptor; selector: string }
  | { type: "filter"; base: LocatorDescriptor; hasText?: SerializedMatcher }
  | { type: "nth"; base: LocatorDescriptor; index: number };

const RESULT_UNDEFINED = "__cmux_page_undefined__";
const RESULT_VALUE = "__cmux_page_value__";
const LOCATOR_DESCRIPTOR_MARKER = "CMUX_LOCATOR_DESCRIPTOR";
const LOCATOR_OPERATION_MARKER = "CMUX_LOCATOR_OPERATION";

export function createCmuxPage(options: CreateCmuxPageOptions): CmuxPage {
  const tabId = options.tabId ?? options.surface;

  async function race<T>(operation: string, promise: Promise<T>): Promise<T> {
    return options.deadline ? options.deadline.race(operation, promise) : promise;
  }

  async function evalJson<T>(operation: string, code: string): Promise<T> {
    const raw = await race(operation, options.transport.eval(options.surface, code, options.signal));
    return parseCmuxJsonResult<T>(raw);
  }

  async function settleAfterInteraction(): Promise<void> {
    if (!isPositiveMs(options.interactionSettleMs)) return;
    await race("cmux.browser.interaction_settle", sleep(options.interactionSettleMs, options.signal));
  }

  const page: CmuxPage = {
    id: tabId,
    tabId,
    surface: options.surface,
    url: async () => race("cmux.browser.get_url", options.transport.getUrl(options.surface, options.signal)),
    title: async () => race("cmux.browser.get_title", options.transport.getTitle(options.surface, options.signal)),
    content: async () => race("cmux.browser.get_html", options.transport.getHtml(options.surface, "html", options.signal)),
    evaluate: async <T, A = unknown>(fn: (arg: A) => T | Promise<T>, arg?: A) => {
      const result = await evalJson<T>("cmux.browser.eval", pageEvaluateCode(fn, arg));
      if (isInteractionEvaluate(fn)) await settleAfterInteraction();
      return result;
    },
    waitForTimeout: async (ms: number) => {
      await race("cmux.browser.wait_for_timeout", sleep(ms, options.signal));
    },
    keyboard: {
      press: async (key: string) => {
        if (key === "Enter") options.lifecycle?.markPromptSubmitted();
        await race("cmux.browser.press", options.transport.press(options.surface, key, options.signal));
      },
    },
    locator: (selector: string) => createLocator({ type: "css", selector }, evalJson, options.lifecycle, settleAfterInteraction),
    getByRole: (role: string, locatorOptions: Record<string, unknown> = {}) => createLocator({
      type: "role",
      role,
      name: serializeOptionalMatcher(locatorOptions.name),
      exact: locatorOptions.exact === true,
    }, evalJson, options.lifecycle, settleAfterInteraction),
    getByText: (text: string | RegExp, locatorOptions: Record<string, unknown> = {}) => createLocator({
      type: "text",
      text: serializeMatcher(text),
      exact: locatorOptions.exact === true,
    }, evalJson, options.lifecycle, settleAfterInteraction),
    getByPlaceholder: (text: string | RegExp, locatorOptions: Record<string, unknown> = {}) => createLocator({
      type: "placeholder",
      text: serializeMatcher(text),
      exact: locatorOptions.exact === true,
    }, evalJson, options.lifecycle, settleAfterInteraction),
    goto: async (url: string) => {
      await race("cmux.browser.goto", options.transport.goto(options.surface, url, options.signal));
    },
    close: async () => {
      if (options.owned !== true) return;
      await race("cmux.browser.close", options.transport.close(options.surface, options.signal));
      options.onClose?.();
    },
  };

  return page;
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted === true) return Promise.reject(new DOMException("Aborted", "AbortError"));
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function createLocator(
  descriptor: LocatorDescriptor,
  evalJson: <T>(operation: string, code: string) => Promise<T>,
  lifecycle: ConsultLifecycle | undefined,
  settleAfterInteraction: () => Promise<void>,
): LocatorLike {
  const locator: LocatorLike = {
    count: () => evalLocator<number>(descriptor, "count", evalJson),
    nth: (index: number) => createLocator({ type: "nth", base: descriptor, index }, evalJson, lifecycle, settleAfterInteraction),
    first: () => createLocator({ type: "nth", base: descriptor, index: 0 }, evalJson, lifecycle, settleAfterInteraction),
    last: () => createLocator({ type: "nth", base: descriptor, index: -1 }, evalJson, lifecycle, settleAfterInteraction),
    filter: (options: Record<string, unknown>) => {
      const hasText = serializeOptionalMatcher(options.hasText);
      return createLocator({ type: "filter", base: descriptor, hasText }, evalJson, lifecycle, settleAfterInteraction);
    },
    locator: (selector: string) => createLocator({ type: "descendant", base: descriptor, selector }, evalJson, lifecycle, settleAfterInteraction),
    click: async () => {
      if (isSendControlDescriptor(descriptor)) lifecycle?.markPromptSubmitted();
      await evalLocator<void>(descriptor, "click", evalJson);
      await settleAfterInteraction();
    },
    fill: (value: string) => evalLocator<void>(descriptor, "fill", evalJson, value),
    textContent: () => evalLocator<string | null>(descriptor, "textContent", evalJson),
    innerText: () => evalLocator<string>(descriptor, "innerText", evalJson),
    innerHTML: () => evalLocator<string>(descriptor, "innerHTML", evalJson),
    isVisible: () => evalLocator<boolean>(descriptor, "isVisible", evalJson),
    evaluate: <T>(fn: (element: Element) => T) => evalJson<T>("cmux.browser.eval", locatorEvaluateCode(descriptor, fn)),
  };
  return locator;
}

function evalLocator<T>(
  descriptor: LocatorDescriptor,
  operation: string,
  evalJson: <T>(operation: string, code: string) => Promise<T>,
  value?: string,
): Promise<T> {
  return evalJson<T>("cmux.browser.eval", locatorOperationCode(descriptor, operation, value));
}

function pageEvaluateCode<T, A>(fn: (arg: A) => T | Promise<T>, arg: A | undefined): string {
  const argJson = JSON.stringify(arg === undefined ? { [RESULT_UNDEFINED]: true } : { [RESULT_VALUE]: arg });
  return `/* CMUX_PAGE_EVALUATE */ (async () => {
    const __cmuxPageFn = (${fn.toString()});
    const __cmuxPageArgEnvelope = ${argJson};
    const __cmuxPageArg = __cmuxPageArgEnvelope.${RESULT_UNDEFINED} === true ? undefined : __cmuxPageArgEnvelope.${RESULT_VALUE};
    const __cmuxPageValue = await __cmuxPageFn(__cmuxPageArg);
    return JSON.stringify(__cmuxPageValue === undefined ? { ${JSON.stringify(RESULT_UNDEFINED)}: true } : { ${JSON.stringify(RESULT_VALUE)}: __cmuxPageValue });
  })()`;
}

function isInteractionEvaluate<T, A>(fn: (arg: A) => T | Promise<T>): boolean {
  return /\.click\s*\(/.test(fn.toString());
}

function isPositiveMs(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function locatorOperationCode(descriptor: LocatorDescriptor, operation: string, value: string | undefined): string {
  const descriptorJson = JSON.stringify(descriptor);
  const valueJson = JSON.stringify(value);
  return `/* ${LOCATOR_DESCRIPTOR_MARKER} ${encodeURIComponent(descriptorJson)} */
/* ${LOCATOR_OPERATION_MARKER} ${operation} */
(() => {
  ${locatorRuntimeSource()}
  const descriptor = ${descriptorJson};
  const operation = ${JSON.stringify(operation)};
  const value = ${valueJson};
  const elements = resolveLocator(descriptor);
  const one = () => requireOne(elements, operation);
  let result;
  if (operation === "count") result = elements.length;
  else if (operation === "click") { clickElement(one()); result = undefined; }
  else if (operation === "fill") { fillElement(one(), value ?? ""); result = undefined; }
  else if (operation === "textContent") result = one().textContent;
  else if (operation === "innerText") result = one().innerText ?? one().textContent ?? "";
  else if (operation === "innerHTML") result = one().innerHTML;
  else if (operation === "isVisible") result = elements.some(isVisible);
  else throw new Error("Unsupported cmux locator operation: " + operation);
  return JSON.stringify(result === undefined ? { ${JSON.stringify(RESULT_UNDEFINED)}: true } : { ${JSON.stringify(RESULT_VALUE)}: result });
})()`;
}

function locatorEvaluateCode<T>(descriptor: LocatorDescriptor, fn: (element: Element) => T): string {
  const descriptorJson = JSON.stringify(descriptor);
  return `/* ${LOCATOR_DESCRIPTOR_MARKER} ${encodeURIComponent(descriptorJson)} */
/* ${LOCATOR_OPERATION_MARKER} evaluate */
(async () => {
  ${locatorRuntimeSource()}
  const descriptor = ${descriptorJson};
  const elements = resolveLocator(descriptor);
  const __cmuxLocatorFn = (${fn.toString()});
  const result = await __cmuxLocatorFn(requireOne(elements, "evaluate"));
  return JSON.stringify(result === undefined ? { ${JSON.stringify(RESULT_UNDEFINED)}: true } : { ${JSON.stringify(RESULT_VALUE)}: result });
})()`;
}

function locatorRuntimeSource(): string {
  return `
  const elementMatches = typeof Element === "undefined" ? undefined : Element.prototype.matches;
  function resolveLocator(descriptor, roots = [document]) {
    if (descriptor.type === "css") return queryAll(roots, descriptor.selector);
    if (descriptor.type === "role") return allElements(roots).filter(element => isLocatorCandidateVisible(element) && roleOf(element) === descriptor.role && matchesName(accessibleName(element, descriptor.role), descriptor.name, descriptor.exact));
    if (descriptor.type === "text") return leafTextElements(roots).filter(element => matchesName(visibleText(element), descriptor.text, descriptor.exact));
    if (descriptor.type === "placeholder") return allElements(roots).filter(element => isLocatorCandidateVisible(element) && matchesName(element.getAttribute("placeholder") ?? "", descriptor.text, descriptor.exact));
    if (descriptor.type === "descendant") return queryAll(resolveLocator(descriptor.base, roots), descriptor.selector);
    if (descriptor.type === "filter") return resolveLocator(descriptor.base, roots).filter(element => descriptor.hasText === undefined || matchesName(visibleText(element), descriptor.hasText, false));
    if (descriptor.type === "nth") {
      const elements = resolveLocator(descriptor.base, roots);
      const index = descriptor.index < 0 ? elements.length + descriptor.index : descriptor.index;
      return elements[index] === undefined ? [] : [elements[index]];
    }
    throw new Error("Unsupported cmux locator descriptor: " + descriptor.type);
  }
  function queryAll(roots, selector) {
    const found = [];
    for (const root of roots) found.push(...Array.from(root.querySelectorAll(selector)));
    return unique(found);
  }
  function allElements(roots) {
    const found = [];
    for (const root of roots) {
      if (root.nodeType === 1) found.push(root);
      found.push(...Array.from(root.querySelectorAll("*")));
    }
    return unique(found);
  }
  function leafTextElements(roots) {
    return allElements(roots).filter(element => isLocatorCandidateVisible(element) && visibleText(element).length > 0 && !Array.from(element.children).some(child => isLocatorCandidateVisible(child) && visibleText(child).length > 0 && matchesName(visibleText(child), { kind: "string", value: visibleText(element) }, false)));
  }
  function unique(elements) { return Array.from(new Set(elements)); }
  function roleOf(element) {
    const explicit = element.getAttribute("role");
    if (explicit !== null && explicit.trim().length > 0) return explicit.trim().split(/\\s+/)[0];
    const tag = element.tagName.toLowerCase();
    const type = (element.getAttribute("type") ?? "").toLowerCase();
    if (tag === "button") return "button";
    if (tag === "a" && element.hasAttribute("href")) return "link";
    if (tag === "textarea") return "textbox";
    if (tag === "input") {
      if (["button", "submit", "reset"].includes(type)) return "button";
      if (["checkbox"].includes(type)) return "checkbox";
      if (["radio"].includes(type)) return "radio";
      if (["search", "text", "email", "url", "tel", "password", "number", ""].includes(type)) return "textbox";
    }
    if (tag === "select") return "combobox";
    if (tag === "option") return "option";
    if (element.isContentEditable) return "textbox";
    return "";
  }
  function accessibleName(element, role) {
    const aria = element.getAttribute("aria-label");
    if (aria !== null && aria.trim().length > 0) return aria;
    const labelledBy = element.getAttribute("aria-labelledby");
    if (labelledBy !== null) {
      const text = labelledBy.split(/\\s+/).map(id => document.getElementById(id)?.textContent ?? "").join(" ").trim();
      if (text.length > 0) return text;
    }
    if (role === "textbox") {
      const placeholder = element.getAttribute("placeholder");
      if (placeholder !== null && placeholder.trim().length > 0) return placeholder;
    }
    return accessibleText(element);
  }
  function accessibleText(element) { return (element.textContent ?? "").replace(/\\s+/g, " ").trim(); }
  function visibleText(element) { return (element.innerText ?? element.textContent ?? "").replace(/\\s+/g, " ").trim(); }
  function matchesName(value, matcher, exact) {
    if (matcher === undefined) return true;
    const text = value.replace(/\\s+/g, " ").trim();
    if (matcher.kind === "regexp") return new RegExp(matcher.source, matcher.flags).test(text);
    const wanted = matcher.value.replace(/\\s+/g, " ").trim();
    return exact === true ? text === wanted : text.toLocaleLowerCase().includes(wanted.toLocaleLowerCase());
  }
  function isVisible(element) {
    return isLocatorCandidateVisible(element);
  }
  function isLocatorCandidateVisible(element) {
    if (element.hasAttribute("hidden") || element.getAttribute("aria-hidden") === "true") return false;
    if (typeof element.closest === "function" && element.closest("[hidden],[aria-hidden='true']") !== null) return false;
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none" && style.opacity !== "0";
  }
  function isTextEntryElement(element) {
    const tag = element.tagName.toLowerCase();
    const type = (element.getAttribute("type") ?? "").toLowerCase();
    return element.isContentEditable
      || tag === "textarea"
      || tag === "input" && ["search", "text", "email", "url", "tel", "password", "number", ""].includes(type);
  }
  function focusElement(element) {
    if (typeof element.focus === "function") {
      element.focus({ preventScroll: true });
      return;
    }
    element.dispatchEvent(new Event("focus", { bubbles: false }));
    element.dispatchEvent(new Event("focusin", { bubbles: true }));
  }
  function clickElement(element) {
    if (isTextEntryElement(element)) {
      focusElement(element);
      return;
    }
    const rect = element.getBoundingClientRect();
    const clientX = Math.round(rect.left + rect.width / 2);
    const clientY = Math.round(rect.top + rect.height / 2);
    const MouseCtor = window.MouseEvent;
    const PointerCtor = window.PointerEvent ?? MouseCtor;
    const base = { bubbles: true, cancelable: true, view: window, clientX, clientY, button: 0 };
    const pointerBase = { ...base, pointerType: "mouse", pointerId: 1, isPrimary: true };
    element.dispatchEvent(new PointerCtor("pointerdown", { ...pointerBase, buttons: 1 }));
    element.dispatchEvent(new MouseCtor("mousedown", { ...base, buttons: 1 }));
    element.dispatchEvent(new PointerCtor("pointerup", { ...pointerBase, buttons: 0 }));
    element.dispatchEvent(new MouseCtor("mouseup", { ...base, buttons: 0 }));
    element.dispatchEvent(new PointerCtor("click", { ...pointerBase, buttons: 0, detail: 1 }));
  }
  function requireOne(elements, operation) {
    if (elements.length !== 1) throw new Error("cmux locator " + operation + " expected exactly one element, found " + elements.length);
    return elements[0];
  }
  function fillElement(element, value) {
    const tag = element.tagName.toLowerCase();
    if (tag === "input" || tag === "textarea") element.value = value;
    else if (element.isContentEditable) element.textContent = value;
    else throw new Error("cmux locator fill only supports input, textarea, and contenteditable elements");
    element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }
  `;
}

function parseCmuxJsonResult<T>(raw: string): T {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed[RESULT_UNDEFINED] === true) return undefined as T;
    return parsed[RESULT_VALUE] as T;
  } catch {
    return raw as T;
  }
}

function serializeOptionalMatcher(value: unknown): SerializedMatcher | undefined {
  if (typeof value === "string" || value instanceof RegExp) return serializeMatcher(value);
  return undefined;
}

function serializeMatcher(value: string | RegExp): SerializedMatcher {
  return typeof value === "string"
    ? { kind: "string", value }
    : { kind: "regexp", source: value.source, flags: value.flags };
}

function isSendControlDescriptor(descriptor: LocatorDescriptor): boolean {
  if (descriptor.type === "role") return descriptor.role === "button" && matcherMentionsSend(descriptor.name);
  if (descriptor.type === "css") return selectorLooksLikeSdkSendButton(descriptor.selector);
  if (descriptor.type === "filter" || descriptor.type === "descendant" || descriptor.type === "nth") return isSendControlDescriptor(descriptor.base);
  return false;
}

function matcherMentionsSend(matcher: SerializedMatcher | undefined): boolean {
  if (matcher === undefined) return false;
  const source = matcher.kind === "string" ? matcher.value : matcher.source;
  return /send(?:\\s|\\W|$)|send prompt/i.test(source);
}

function selectorLooksLikeSdkSendButton(selector: string): boolean {
  return /button\s*\[\s*aria-label\*?=.*send/i.test(selector);
}
