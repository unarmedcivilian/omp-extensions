import { describe, expect, test } from "bun:test";
import { createChatGPT } from "codex-chatgpt-control";
import { createCmuxBrowserAdapter } from "../src/cmux-browser.js";
import { createCmuxPage } from "../src/cmux-page.js";
import { runChatGptProConsult } from "../src/consult.js";
import type { CmuxTransport } from "../src/cmux.js";

const RESULT_UNDEFINED = "__cmux_page_undefined__";
const RESULT_VALUE = "__cmux_page_value__";

type FakeElement = {
  id: string;
  role?: string;
  text?: string;
  ariaLabel?: string;
  placeholder?: string;
  selector?: string;
  kind?: "button" | "input" | "textarea" | "contenteditable" | "menuitem";
  value?: string;
  visible?: boolean;
};

type SerializedMatcher =
  | { kind: "string"; value: string }
  | { kind: "regexp"; source: string; flags: string };

type Descriptor =
  | { type: "css"; selector: string }
  | { type: "role"; role: string; name?: SerializedMatcher; exact?: boolean }
  | { type: "text"; text: SerializedMatcher; exact?: boolean }
  | { type: "placeholder"; text: SerializedMatcher; exact?: boolean }
  | { type: "descendant"; base: Descriptor; selector: string }
  | { type: "filter"; base: Descriptor; hasText?: SerializedMatcher }
  | { type: "nth"; base: Descriptor; index: number };

class ScriptAwareFakeTransport implements CmuxTransport {
  readonly operations: string[] = [];
  readonly closedSurfaces: string[] = [];
  readonly openedUrls: string[] = [];
  readonly surfaces = new Map<string, { url: string; title: string }>();
  readonly elements: FakeElement[] = [
    { id: "mode-thinking", role: "button", text: "Thinking", kind: "button" },
    { id: "composer", role: "textbox", ariaLabel: "Chat with ChatGPT", kind: "contenteditable", value: "" },
    { id: "send", role: "button", ariaLabel: "Send prompt", kind: "button" },
    { id: "submit", role: "button", text: "Submit", kind: "button" },
  ];
  modeMenuOpen = false;
  selectedMode = "Thinking";
  composerValue = "";
  messages: Array<{ role: "user" | "assistant"; text: string; html: string }> = [];
  currentSurface: string | undefined;

  async open(url: string): Promise<string> {
    this.operations.push("open");
    this.openedUrls.push(url);
    const surface = `surface:${this.openedUrls.length}`;
    this.currentSurface = surface;
    this.surfaces.set(surface, { url, title: "ChatGPT" });
    return surface;
  }

  async goto(surface: string, url: string): Promise<void> {
    this.operations.push(`goto:${url}`);
    this.state(surface).url = url;
  }

  async waitForLoad(): Promise<void> {}

  async getUrl(surface: string): Promise<string> {
    return this.state(surface).url;
  }

  async getTitle(surface: string): Promise<string> {
    return this.state(surface).title;
  }

  async getText(): Promise<string> {
    return this.visibleText();
  }

  async getHtml(): Promise<string> {
    return this.html();
  }

  async eval(_surface: string, code: string): Promise<string> {
    if (code.includes("CMUX_LOCATOR_DESCRIPTOR")) return this.handleLocatorEval(code);
    return this.handlePageEval(code);
  }

  async press(_surface: string, key: string): Promise<void> {
    this.operations.push(`press:${key}`);
  }

  async close(surface: string): Promise<void> {
    this.operations.push(`close:${surface}`);
    this.closedSurfaces.push(surface);
  }

  async resolveCurrentSurface(): Promise<string | undefined> {
    return this.currentSurface;
  }

  private state(surface: string): { url: string; title: string } {
    let state = this.surfaces.get(surface);
    if (state === undefined) {
      state = { url: "https://chatgpt.com/", title: "ChatGPT" };
      this.surfaces.set(surface, state);
    }
    return state;
  }

  private handlePageEval(code: string): string {
    const arg = this.pageEvalArg(code);
    if (code.includes("value + 1")) return this.wrap(42);
    if (code.includes("document.body?.innerText")) return this.wrap(this.visibleText());
    if (code.includes("normalizedModeLabels") && code.includes("button, [role='button']")) return this.wrap([this.selectedMode]);
    if (code.includes("[role='menuitem']") && code.includes("roleItems")) {
      const items = this.modeMenuOpen ? [{ label: "Pro", role: "menuitemradio" }] : [];
      return this.wrap({ items, labels: [], split: false });
    }
    if (code.includes("data-testid^='model-switcher-'")) return this.wrap(undefined);
    if (code.includes("target.roles") && code.includes("getBoundingClientRect")) return this.wrap(undefined);
    if (code.includes("matches[0].click()") && code.includes("normalizedWanted")) {
      this.selectedMode = String(arg ?? "Pro");
      this.modeMenuOpen = false;
      this.operations.push(`mode:${this.selectedMode}`);
      return this.wrap(true);
    }
    if (code.includes("activeSignals") && code.includes("stoppedSignals")) {
      return this.wrap({ active: false, stopped: false, signals: [] });
    }
    if (code.includes("latestTurn") && code.includes("actionText")) return this.wrap(true);
    if (code.includes("data-message-author-role")) return this.handleMessageEval(code, arg);
    return this.wrap(undefined);
  }

  private handleMessageEval(code: string, arg: unknown): string {
    const role = arg === "assistant" || arg === "user" ? arg : undefined;
    const messages = role === undefined ? this.messages : this.messages.filter(message => message.role === role);
    if (code.includes("assistantNodes") && code.includes("latestAssistantTurnIndex")) {
      const assistantMessages = this.messages.filter(message => message.role === "assistant");
      const latestAssistant = assistantMessages.at(-1);
      const latestAssistantTurnIndex = latestAssistant === undefined ? undefined : this.messages.lastIndexOf(latestAssistant) + 1;
      return this.wrap({
        turnCount: this.messages.length,
        assistantTurnCount: assistantMessages.length,
        latestText: latestAssistant?.text,
        latestAssistantTurnIndex,
      });
    }
    if (code.includes("document.querySelectorAll(selector).length")) return this.wrap(messages.length);
    if (code.includes(".at(-1)") && code.includes("metadataHtml")) {
      const message = messages.at(-1);
      if (message?.role === "assistant") this.operations.push("read:assistant:markdown");
      return this.wrap(message === undefined ? undefined : { role: message.role, html: message.html, metadataHtml: `<div>${message.html}</div>` });
    }
    if (code.includes("map(node") && code.includes("metadataHtml")) {
      return this.wrap(messages.map(message => ({ role: message.role, html: message.html, metadataHtml: `<div>${message.html}</div>` })));
    }
    if (code.includes("latestText")) return this.wrap({ turnCount: this.messages.length, latestText: messages.at(-1)?.text });
    return this.wrap(messages.length);
  }

  private handleLocatorEval(code: string): string {
    const descriptor = this.locatorDescriptor(code);
    const operation = this.locatorOperation(code);
    const elements = this.resolve(descriptor);
    const requireOne = () => {
      if (elements.length !== 1) throw new Error(`expected exactly one element, found ${elements.length}`);
      return elements[0]!;
    };
    if (operation === "count") return this.wrap(elements.length);
    if (operation === "isVisible") return this.wrap(elements.some(element => element.visible !== false));
    const element = requireOne();
    if (operation === "click") {
      this.operations.push(`click:${element.id}`);
      if (element.id === "mode-thinking") this.modeMenuOpen = true;
      if (element.id === "pro") {
        this.selectedMode = "Pro";
        this.modeMenuOpen = false;
        this.operations.push("mode:Pro");
      }
      if (element.id === "send") this.submitComposer();
      return this.wrap(undefined);
    }
    if (operation === "fill") {
      const value = this.locatorFillValue(code);
      if (element.id === "composer") this.composerValue = value;
      element.value = value;
      this.operations.push(`fill:${element.id}:${value}`);
      this.operations.push(`event:${element.id}:input`);
      this.operations.push(`event:${element.id}:change`);
      return this.wrap(undefined);
    }
    if (operation === "textContent" || operation === "innerText") return this.wrap(element.id === "composer" ? this.composerValue : this.label(element));
    if (operation === "innerHTML") return this.wrap(element.id === "composer" ? this.composerValue : this.label(element));
    return this.wrap(undefined);
  }

  private resolve(descriptor: Descriptor): FakeElement[] {
    if (descriptor.type === "css") return this.resolveCss(descriptor.selector);
    if (descriptor.type === "role") {
      return this.allElements().filter(element => element.role === descriptor.role && this.matches(this.label(element), descriptor.name, descriptor.exact));
    }
    if (descriptor.type === "text") return this.allElements().filter(element => this.matches(this.label(element), descriptor.text, descriptor.exact));
    if (descriptor.type === "placeholder") return this.allElements().filter(element => this.matches(element.placeholder ?? "", descriptor.text, descriptor.exact));
    if (descriptor.type === "filter") return this.resolve(descriptor.base).filter(element => descriptor.hasText === undefined || this.matches(this.label(element), descriptor.hasText, false));
    if (descriptor.type === "descendant") return this.resolveCss(descriptor.selector);
    if (descriptor.type === "nth") {
      const elements = this.resolve(descriptor.base);
      const index = descriptor.index < 0 ? elements.length + descriptor.index : descriptor.index;
      return elements[index] === undefined ? [] : [elements[index]!];
    }
    return [];
  }

  private resolveCss(selector: string): FakeElement[] {
    if (selector === "button, [role='button']") return this.allElements().filter(element => element.role === "button");
    if (selector.includes("aria-label") && /send/i.test(selector)) return this.allElements().filter(element => element.id === "send");
    if (selector.includes("contenteditable") || selector.includes("textarea")) return this.allElements().filter(element => element.id === "composer");
    if (selector.includes("menuitem") || selector.includes("option")) return this.allElements().filter(element => element.role === "menuitemradio");
    return this.allElements().filter(element => element.selector === selector);
  }

  private allElements(): FakeElement[] {
    return this.modeMenuOpen
      ? [...this.elements, { id: "pro", role: "menuitemradio", text: "Pro", kind: "menuitem" }]
      : [...this.elements];
  }

  private label(element: FakeElement): string {
    if (element.id === "composer") return element.ariaLabel ?? "";
    return element.ariaLabel ?? element.placeholder ?? element.text ?? element.value ?? "";
  }

  private matches(value: string, matcher: SerializedMatcher | undefined, exact: boolean | undefined): boolean {
    if (matcher === undefined) return true;
    if (matcher.kind === "regexp") return new RegExp(matcher.source, matcher.flags).test(value);
    return exact === true ? value === matcher.value : value.toLowerCase().includes(matcher.value.toLowerCase());
  }

  private submitComposer(): void {
    this.operations.push("submit");
    this.messages.push({ role: "user", text: this.composerValue, html: this.composerValue });
    this.messages.push({ role: "assistant", text: "omp smoke ok", html: "omp smoke ok" });
  }

  private visibleText(): string {
    const messageText = this.messages.map(message => message.text).join(" ");
    const menuText = this.modeMenuOpen ? " Pro" : "";
    return `New chat Search chats Chat with ChatGPT Recents Projects Thinking Send prompt Copy response${menuText} ${messageText}`;
  }

  private html(): string {
    return [
      "<main>",
      ...this.messages.map(message => `<div data-message-author-role=\"${message.role}\">${message.html}</div>`),
      "</main>",
    ].join("");
  }

  private wrap(value: unknown): string {
    return JSON.stringify(value === undefined ? { [RESULT_UNDEFINED]: true } : { [RESULT_VALUE]: value });
  }

  private pageEvalArg(code: string): unknown {
    const match = /const __cmuxPageArgEnvelope = (.*?);/.exec(code);
    if (match === null) return undefined;
    const envelope = JSON.parse(match[1]!) as Record<string, unknown>;
    return envelope[RESULT_UNDEFINED] === true ? undefined : envelope[RESULT_VALUE];
  }

  private locatorDescriptor(code: string): Descriptor {
    const match = /CMUX_LOCATOR_DESCRIPTOR ([^ ]+) \*\//.exec(code);
    if (match === null) throw new Error("missing locator descriptor");
    return JSON.parse(decodeURIComponent(match[1]!)) as Descriptor;
  }

  private locatorOperation(code: string): string {
    const match = /CMUX_LOCATOR_OPERATION ([^ ]+) \*\//.exec(code);
    if (match === null) throw new Error("missing locator operation");
    return match[1]!;
  }

  private locatorFillValue(code: string): string {
    const match = /const value = (.*?);/.exec(code);
    return match === null ? "" : JSON.parse(match[1]!);
  }
}

class RuntimeDomElement {
  readonly nodeType = 1;
  readonly children: RuntimeDomElement[] = [];
  readonly style = { visibility: "visible", display: "block", opacity: "1" };
  readonly tagName: string;
  value = "";
  textContent: string;
  innerText: string;
  dispatched: Array<Record<string, unknown>> = [];

  constructor(
    tagName: string,
    private readonly attrs: Record<string, string> = {},
    text = "",
    private readonly visible = true,
  ) {
    this.tagName = tagName.toUpperCase();
    this.textContent = text;
    this.innerText = text;
    if (!visible) this.style.display = "none";
  }

  get isContentEditable(): boolean {
    return this.attrs.contenteditable === "true";
  }

  getAttribute(name: string): string | null {
    return this.attrs[name] ?? null;
  }

  hasAttribute(name: string): boolean {
    return Object.hasOwn(this.attrs, name);
  }

  getBoundingClientRect(): DOMRect {
    const rect = this.visible
      ? { x: 0, y: 0, width: 120, height: 24, top: 0, right: 120, bottom: 24, left: 0 }
      : { x: 0, y: 0, width: 0, height: 0, top: 0, right: 0, bottom: 0, left: 0 };
    return { ...rect, toJSON: () => rect } as DOMRect;
  }

  querySelectorAll(selector: string): RuntimeDomElement[] {
    return queryRuntimeElements(this.children, selector);
  }

  click(): void {
    this.dispatched.push({ type: "clickMethod" });
  }

  focus(): void {
    this.dispatched.push({ type: "focusMethod" });
  }

  dispatchEvent(event: Event): boolean {
    const record = event as Event & Record<string, unknown>;
    this.dispatched.push(Object.fromEntries(
      [
        ["type", event.type],
        ["ctor", event.constructor.name],
        ["button", record.button],
        ["buttons", record.buttons],
        ["pointerType", record.pointerType],
        ["isPrimary", record.isPrimary],
        ["clientX", record.clientX],
        ["clientY", record.clientY],
      ].filter((entry): entry is [string, unknown] => entry[1] !== undefined),
    ));
    return true;
  }
}

class RuntimeDomTransport implements CmuxTransport {
  readonly hiddenComposer = new RuntimeDomElement("textarea", { "aria-label": "Chat with ChatGPT" }, "", false);
  readonly visibleComposer = new RuntimeDomElement("div", {
    role: "textbox",
    "aria-label": "Chat with ChatGPT",
    contenteditable: "true",
  });
  readonly modeButton = new RuntimeDomElement("button", {}, "Pro Extended");
  readonly extraElements: RuntimeDomElement[] = [];

  async open(): Promise<string> { return "surface:1"; }
  async goto(): Promise<void> {}
  async waitForLoad(): Promise<void> {}
  async getUrl(): Promise<string> { return "https://chatgpt.com/"; }
  async getTitle(): Promise<string> { return "ChatGPT"; }
  async getText(): Promise<string> { return ""; }
  async getHtml(): Promise<string> { return ""; }
  async press(): Promise<void> {}
  async close(): Promise<void> {}
  async resolveCurrentSurface(): Promise<string | undefined> { return "surface:1"; }

  async eval(_surface: string, code: string): Promise<string> {
    const document = {
      querySelectorAll: (selector: string) => queryRuntimeElements([this.hiddenComposer, this.visibleComposer, this.modeButton, ...this.extraElements], selector),
      getElementById: () => null,
    };
    const FakeEvent = class Event {
      constructor(readonly type: string, init: Record<string, unknown> = {}) {
        Object.assign(this, init);
      }
    };
    const FakeInputEvent = class InputEvent extends FakeEvent {};
    const FakeMouseEvent = class MouseEvent extends FakeEvent {};
    const FakePointerEvent = class PointerEvent extends FakeMouseEvent {};
    const window = {
      getComputedStyle: (element: RuntimeDomElement) => element.style,
      MouseEvent: FakeMouseEvent,
      PointerEvent: FakePointerEvent,
    };
    return new Function("document", "Element", "window", "InputEvent", "Event", "MouseEvent", "PointerEvent", `return (${code})`)(
      document,
      RuntimeDomElement,
      window,
      FakeInputEvent,
      FakeEvent,
      FakeMouseEvent,
      FakePointerEvent,
    ) as string;
  }
}

function queryRuntimeElements(elements: RuntimeDomElement[], selector: string): RuntimeDomElement[] {
  return elements.filter(element => matchesRuntimeSelector(element, selector));
}

function matchesRuntimeSelector(element: RuntimeDomElement, selector: string): boolean {
  return selector.split(",").some(part => {
    const trimmed = part.trim();
    if (trimmed === "*") return true;
    if (trimmed === "textarea") return element.tagName === "TEXTAREA";
    if (trimmed === "[contenteditable='true']" || trimmed === "[contenteditable=\"true\"]") {
      return element.getAttribute("contenteditable") === "true";
    }
    return false;
  });
}

describe("cmux page adapter", () => {
  test("page.evaluate sends eval code through transport and returns the parsed result", async () => {
    const transport = new ScriptAwareFakeTransport();
    const page = createCmuxPage({ surface: "surface:1", transport });

    await expect(page.evaluate?.((value: number) => value + 1, 41)).resolves.toBe(42);
  });

  test("evaluate, content, and sleep are raced against the deadline", async () => {
    const transport = new ScriptAwareFakeTransport();
    const raced: string[] = [];
    const deadline = {
      race: <T>(operation: string, _promise: Promise<T>): Promise<T> => {
        raced.push(operation);
        return Promise.reject(new Error(operation));
      },
    };
    const page = createCmuxPage({ surface: "surface:1", transport, deadline });

    await expect(page.evaluate?.(() => 1)).rejects.toThrow("cmux.browser.eval");
    await expect(page.content?.()).rejects.toThrow("cmux.browser.get_html");
    await expect(page.waitForTimeout?.(1)).rejects.toThrow("cmux.browser.wait_for_timeout");
    expect(raced).toEqual(["cmux.browser.eval", "cmux.browser.get_html", "cmux.browser.wait_for_timeout"]);
  });

  test("waitForTimeout rejects promptly when the page signal aborts", async () => {
    const transport = new ScriptAwareFakeTransport();
    const controller = new AbortController();
    const page = createCmuxPage({ surface: "surface:1", transport, signal: controller.signal });
    const sleep = page.waitForTimeout?.(50);

    controller.abort();

    const result = await Promise.race([
      sleep?.then(
        () => "resolved",
        error => error,
      ),
      new Promise(resolve => setTimeout(() => resolve("still pending"), 5)),
    ]);
    expect(result).toBeInstanceOf(DOMException);
    expect((result as DOMException).name).toBe("AbortError");
  });

  test("role locator count and click work through transport eval", async () => {
    const transport = new ScriptAwareFakeTransport();
    const page = createCmuxPage({ surface: "surface:1", transport });
    const locator = page.getByRole?.("button", { name: "Submit", exact: true });
    if (locator === undefined) throw new Error("missing role locator");

    await expect(locator.count?.()).resolves.toBe(1);
    await locator.click?.();

    expect(transport.operations).toContain("click:submit");
  });

  test("keyboard Enter presses through cmux and marks lifecycle submitted", async () => {
    const transport = new ScriptAwareFakeTransport();
    let submitted = 0;
    const page = createCmuxPage({
      surface: "surface:1",
      transport,
      lifecycle: { markPromptSubmitted: () => { submitted += 1; } },
    });

    await page.keyboard?.press?.("Enter");

    expect(submitted).toBe(1);
    expect(transport.operations).toContain("press:Enter");
  });

  test("claimed close is a no-op and owned close closes the transport", async () => {
    const transport = new ScriptAwareFakeTransport();
    const claimed = createCmuxPage({ surface: "surface:claimed", transport, owned: false });
    const owned = createCmuxPage({ surface: "surface:owned", transport, owned: true });

    await claimed.close?.();
    await owned.close?.();

    expect(transport.closedSurfaces).toEqual(["surface:owned"]);
  });

  test("fill sets composer value via eval and dispatches input and change events", async () => {
    const transport = new ScriptAwareFakeTransport();
    const page = createCmuxPage({ surface: "surface:1", transport });
    const composer = page.getByRole?.("textbox", { name: /Chat with ChatGPT/i });
    if (composer === undefined) throw new Error("missing composer locator");

    await composer.fill?.("hello composer");

    expect(transport.composerValue).toBe("hello composer");
    expect(transport.operations).toEqual(["fill:composer:hello composer", "event:composer:input", "event:composer:change"]);
  });

  test("runtime role locators ignore hidden duplicate textboxes before filling composer", async () => {
    const transport = new RuntimeDomTransport();
    const page = createCmuxPage({ surface: "surface:1", transport });
    const composer = page.getByRole?.("textbox", { name: /Chat with ChatGPT/i });
    if (composer === undefined) throw new Error("missing composer locator");

    await expect(composer.fill?.("visible composer text")).resolves.toBeUndefined();

    expect(transport.visibleComposer.textContent).toBe("visible composer text");
    expect(transport.hiddenComposer.value).toBe("");
    expect(transport.visibleComposer.dispatched.map(event => event.type)).toEqual(["input", "change"]);
  });

  test("runtime role accessible names avoid expensive innerText layout reads", async () => {
    const transport = new RuntimeDomTransport();
    const sendButton = new RuntimeDomElement("button", {}, "Send prompt");
    Object.defineProperty(sendButton, "innerText", {
      configurable: true,
      get() {
        throw new Error("innerText forced layout");
      },
    });
    transport.extraElements.push(sendButton);
    const page = createCmuxPage({ surface: "surface:1", transport });
    const locator = page.getByRole?.("button", { name: /Send prompt/i });
    if (locator === undefined) throw new Error("missing send button locator");

    await expect(locator.count?.()).resolves.toBe(1);
  });

  test("runtime textbox clicks focus without pointer dispatch", async () => {
    const transport = new RuntimeDomTransport();
    const page = createCmuxPage({ surface: "surface:1", transport });
    const composer = page.getByRole?.("textbox", { name: /Chat with ChatGPT/i });
    if (composer === undefined) throw new Error("missing composer locator");

    await expect(composer.click?.()).resolves.toBeUndefined();

    expect(transport.visibleComposer.dispatched).toEqual([{ type: "focusMethod" }]);
  });

  test("runtime click dispatches pointer and mouse events at the element center", async () => {
    const transport = new RuntimeDomTransport();
    const page = createCmuxPage({ surface: "surface:1", transport });
    const modeButton = page.getByRole?.("button", { name: "Pro Extended", exact: true });
    if (modeButton === undefined) throw new Error("missing mode button locator");

    await expect(modeButton.click?.()).resolves.toBeUndefined();

    expect(transport.modeButton.dispatched).toEqual([
      { type: "pointerdown", ctor: "PointerEvent", button: 0, buttons: 1, pointerType: "mouse", isPrimary: true, clientX: 60, clientY: 12 },
      { type: "mousedown", ctor: "MouseEvent", button: 0, buttons: 1, clientX: 60, clientY: 12 },
      { type: "pointerup", ctor: "PointerEvent", button: 0, buttons: 0, pointerType: "mouse", isPrimary: true, clientX: 60, clientY: 12 },
      { type: "mouseup", ctor: "MouseEvent", button: 0, buttons: 0, clientX: 60, clientY: 12 },
      { type: "click", ctor: "PointerEvent", button: 0, buttons: 0, pointerType: "mouse", isPrimary: true, clientX: 60, clientY: 12 },
    ]);
  });

  test("page evaluate interactions settle before the SDK continues", async () => {
    const transport = new RuntimeDomTransport();
    const raced: string[] = [];
    const deadline = {
      remainingMs: () => 1_000,
      throwIfExpired: () => {},
      race: async <T>(operation: string, promise: Promise<T>) => {
        raced.push(operation);
        return promise;
      },
    };
    const page = createCmuxPage({
      surface: "surface:1",
      transport,
      deadline,
      interactionSettleMs: 1,
    } as Parameters<typeof createCmuxPage>[0] & { interactionSettleMs: number });

    await expect(page.evaluate(() => {
      document.querySelectorAll("button")[0]?.click();
      return true;
    })).resolves.toBe(true);

    expect(raced).toContain("cmux.browser.interaction_settle");
  });

  test("SDK adapter opens, selects mode, fills composer, submits, and reads assistant markdown", async () => {
    const transport = new ScriptAwareFakeTransport();
    let submitted = 0;
    const browser = createCmuxBrowserAdapter({
      transport,
      lifecycle: { markPromptSubmitted: () => { submitted += 1; } },
    });
    const chatgpt = createChatGPT({ browser });

    const bootstrap = await chatgpt.session.bootstrap({ preferExistingTab: false });
    const mode = await chatgpt.modes.set({ intelligence: "pro", timeoutMs: 1000 });
    const ask = await chatgpt.messages.ask({
      text: "Reply with exactly: omp smoke ok",
      wait: { timeoutMs: 1000, stableMs: 1, pollMs: 1 },
      read: { format: "markdown" },
    });

    expect(bootstrap.ok).toBe(true);
    expect(mode.ok).toBe(true);
    expect(ask.ok).toBe(true);
    expect(ask.data?.responseText).toBe("omp smoke ok");
    expect(submitted).toBe(1);
    expect(transport.operations).toContain("open");
    expect(transport.operations).toContain("mode:Pro");
    expect(transport.operations).toContain("fill:composer:Reply with exactly: omp smoke ok");
    expect(transport.operations).toContain("submit");
    expect(transport.operations).toContain("read:assistant:markdown");
    expect(transport.messages.at(-1)).toMatchObject({ role: "assistant", text: "omp smoke ok" });
  });

  test("consult runner retries Pro Extended mode through the real SDK before submitting once", async () => {
    const transport = new ScriptAwareFakeTransport();
    let submitted = 0;

    const result = await runChatGptProConsult({
      prompt: "Reply with exactly: omp smoke ok",
      timeoutMs: 20_000,
    }, {
      createBrowser: ({ signal, deadline, lifecycle }) => createCmuxBrowserAdapter({
        transport,
        signal,
        deadline,
        lifecycle: {
          markPromptSubmitted() {
            submitted += 1;
            lifecycle.markPromptSubmitted();
          },
        },
      }),
    });

    expect(result.ok).toBe(true);
    expect(result.markdown).toBe("omp smoke ok");
    expect(submitted).toBe(1);
    expect(transport.operations.filter(operation => operation === "submit")).toHaveLength(1);
    expect(transport.operations).toContain("mode:Pro");
    expect(transport.operations).toContain("fill:composer:Reply with exactly: omp smoke ok");
    expect(result.details.keptSurface).toBe(false);
    expect(transport.closedSurfaces).toContain("surface:1");
  });
});
