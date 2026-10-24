import DOMPurify from "dompurify";
import { marked } from "marked";
import type { BackgroundRequest, BackgroundResponse } from "./messages";

DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const el = Object.assign(document.createElement(tag), props);
  el.append(...children);
  return el;
}

export function request(req: BackgroundRequest): Promise<BackgroundResponse> {
  return browser.runtime.sendMessage(req) as Promise<BackgroundResponse>;
}

export function renderMarkdown(text: string): HTMLElement {
  const el = h("div");
  el.innerHTML = DOMPurify.sanitize(marked.parse(text, { async: false }));
  return el;
}

// Events from inside a shadow root reach GitHub retargeted to its host, so
// GitHub's keyboard shortcuts and click handlers would act on them.
export function isolateEvents(root: ShadowRoot, types: string[]): void {
  for (const type of types) root.addEventListener(type, (e) => e.stopPropagation());
}
