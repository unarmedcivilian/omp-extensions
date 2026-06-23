import type { PageLike } from "codex-chatgpt-control";
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
  owned?: boolean;
  onClose?: () => void;
}

export function createCmuxPage(options: CreateCmuxPageOptions): CmuxPage {
  const tabId = options.tabId ?? options.surface;

  async function raceTransport<T>(operation: string, promise: Promise<T>): Promise<T> {
    return options.deadline ? options.deadline.race(operation, promise) : promise;
  }

  return {
    id: tabId,
    tabId,
    surface: options.surface,
    url: async () => raceTransport("cmux.browser.get_url", options.transport.getUrl(options.surface, options.signal)),
    title: async () => raceTransport("cmux.browser.get_title", options.transport.getTitle(options.surface, options.signal)),
    content: async () => raceTransport("cmux.browser.get_html", options.transport.getHtml(options.surface, "html", options.signal)),
    evaluate: async <T, A = unknown>(fn: (arg: A) => T | Promise<T>, arg?: A) => {
      const serializedArg = arg === undefined ? "undefined" : JSON.stringify(arg);
      const code = `(${fn.toString()})(${serializedArg})`;
      return await raceTransport("cmux.browser.eval", options.transport.eval(options.surface, code, options.signal)) as T;
    },
    goto: async (url: string) => {
      await raceTransport("cmux.browser.goto", options.transport.goto(options.surface, url, options.signal));
    },
    close: async () => {
      if (options.owned !== true) return;
      await raceTransport("cmux.browser.close", options.transport.close(options.surface, options.signal));
      options.onClose?.();
    },
  };
}
