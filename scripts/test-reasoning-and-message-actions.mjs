import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";

const root = fileURLToPath(new URL("../", import.meta.url));
const src = join(root, "packages/app/src");
const pnpmDir = join(root, "node_modules", ".pnpm");
const esbuildPkg = readdirSync(pnpmDir).find((name) => name.startsWith("esbuild@"));
assert.ok(esbuildPkg);
const esbuild = await import(
  pathToFileURL(join(pnpmDir, esbuildPkg, "node_modules", "esbuild", "lib", "main.js")).href
);
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
const { window } = dom;
for (const key of [
  "document",
  "navigator",
  "HTMLElement",
  "Element",
  "Node",
  "Text",
  "Range",
  "MutationObserver",
  "CustomEvent",
  "KeyboardEvent",
  "MouseEvent",
]) {
  Object.defineProperty(globalThis, key, { value: window[key], configurable: true, writable: true });
}
globalThis.window = window;
globalThis.localStorage = window.localStorage;
globalThis.sessionStorage = window.sessionStorage;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.requestAnimationFrame = (callback) => setTimeout(() => callback(Date.now()), 16);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
window.requestAnimationFrame = globalThis.requestAnimationFrame;
window.cancelAnimationFrame = globalThis.cancelAnimationFrame;
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
window.getComputedStyle = window.getComputedStyle.bind(window);
globalThis.getComputedStyle = window.getComputedStyle;
class Observer {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = Observer;
globalThis.IntersectionObserver = Observer;
window.ResizeObserver = Observer;
window.IntersectionObserver = Observer;
window.HTMLElement.prototype.scrollIntoView = () => {};
window.HTMLElement.prototype.scrollTo = () => {};
globalThis.CSS = { highlights: new Map(), escape: (value) => value };
window.CSS = globalThis.CSS;
globalThis.Highlight = class {
  constructor(...ranges) {
    this.ranges = ranges;
  }
};
window.Highlight = globalThis.Highlight;
window.__TAURI_INTERNALS__ = { invoke: async () => null };

const outDir = mkdtempSync(join(tmpdir(), "reasoning-message-actions-"));
const entry = join(outDir, "entry.tsx");
const outfile = join(outDir, "bundle.mjs");
const posix = (path) => path.replace(/\\/g, "/");
writeFileSync(
  entry,
  `export { Reasoning, ReasoningContent, ReasoningTrigger } from "${posix(join(src, "components/prompt-kit/reasoning.tsx"))}";
   export { ChatMessages } from "${posix(join(src, "components/side-chat/chat-messages.tsx"))}";
   export { ChatContainerRoot } from "${posix(join(src, "components/prompt-kit/chat-container.tsx"))}";
   export { default as React, act } from "react";
   export { createRoot } from "react-dom/client";`,
);
await esbuild.build({
  entryPoints: [entry],
  bundle: true,
  format: "esm",
  platform: "node",
  jsx: "automatic",
  outfile,
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  alias: { "@": src },
  nodePaths: [join(root, "packages/app/node_modules")],
  loader: { ".css": "empty", ".svg": "dataurl", ".png": "dataurl", ".woff": "dataurl", ".woff2": "dataurl" },
  logLevel: "silent",
});
const { Reasoning, ReasoningContent, ReasoningTrigger, ChatMessages, ChatContainerRoot, React, act, createRoot } =
  await import(pathToFileURL(outfile).href);

function ReasoningHarness() {
  const [open, setOpen] = React.useState(true);
  return React.createElement(
    Reasoning,
    { open, onOpenChange: setOpen },
    React.createElement(ReasoningTrigger, null, "Thought"),
    React.createElement(ReasoningContent, { markdown: true }, "先思考这个结论，再看[证据](https://example.com)。"),
  );
}
const host = document.createElement("div");
document.body.appendChild(host);
const view = createRoot(host);
await act(async () => view.render(React.createElement(ReasoningHarness)));
const trigger = () =>
  Array.from(host.querySelectorAll("button")).find((button) => button.textContent.includes("Thought"));
assert.equal(trigger()?.getAttribute("aria-expanded"), "true");
await act(async () => host.querySelector("p").dispatchEvent(new window.MouseEvent("click", { bubbles: true })));
assert.equal(trigger()?.getAttribute("aria-expanded"), "false", "点击思考正文应收起");
await act(async () => trigger().click());
assert.equal(trigger()?.getAttribute("aria-expanded"), "true");
const paragraph = host.querySelector("p");
const selection = window.getSelection();
const range = document.createRange();
range.selectNodeContents(paragraph);
selection.removeAllRanges();
selection.addRange(range);
await act(async () => paragraph.dispatchEvent(new window.MouseEvent("click", { bubbles: true })));
assert.equal(trigger()?.getAttribute("aria-expanded"), "true", "选择文本时不误收起");
selection.removeAllRanges();
const anchor = host.querySelector("a");
anchor.addEventListener("click", (event) => event.preventDefault());
await act(async () => anchor.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true })));
assert.equal(trigger()?.getAttribute("aria-expanded"), "true", "点击链接不应收起或阻止原行为");
const keyboardButton = host.querySelector('button[aria-label="收起思考内容"]');
assert.ok(keyboardButton, "应提供键盘可聚焦的原生收起按钮");
assert.equal(keyboardButton.type, "button");
assert.equal(keyboardButton.tabIndex, 0);
keyboardButton.focus();
await act(async () => keyboardButton.click());
assert.equal(trigger()?.getAttribute("aria-expanded"), "false", "原生收起按钮可激活，无需把 Markdown 容器模拟成按钮");
await act(async () => view.unmount());
host.remove();
console.log("PASS 思考正文点击、文本选择、链接与原生键盘按钮");

const chatHost = document.createElement("div");
document.body.appendChild(chatHost);
const chatView = createRoot(chatHost);
await act(async () => {
  chatView.render(
    React.createElement(
      ChatContainerRoot,
      { autoScroll: false, resize: "instant" },
      React.createElement(ChatMessages, {
        messages: [{ id: "message-actions", role: "assistant", parts: [{ type: "text", text: "一份答复" }] }],
        status: "ready",
        error: null,
      }),
    ),
  );
});
assert.equal(chatHost.querySelectorAll("svg.lucide-volume-2").length, 0, "消息工具栏不再有语音按钮");
const exportButton = chatHost.querySelector('button[aria-label="导出"]');
assert.ok(exportButton, "图片和 Markdown 应合并为一个导出按钮");
await act(async () => {
  exportButton.dispatchEvent(new window.MouseEvent("pointerdown", { bubbles: true, button: 0, buttons: 1 }));
  exportButton.dispatchEvent(new window.MouseEvent("pointerup", { bubbles: true, button: 0, buttons: 0 }));
  exportButton.dispatchEvent(new window.MouseEvent("click", { bubbles: true, button: 0 }));
});
const items = Array.from(document.querySelectorAll('[role="menuitem"]')).map((item) => item.textContent);
assert.deepEqual(items, ["导出为图片", "导出为 Markdown"], "原处小菜单提供两种格式");
await act(async () => chatView.unmount());
chatHost.remove();
console.log("PASS 工具栏去除语音键，图片与 Markdown 合并为原地下拉导出");
window.close();
process.exit(0);
