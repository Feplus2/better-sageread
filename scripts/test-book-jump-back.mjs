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
  "SVGElement",
  "Element",
  "Node",
  "NodeFilter",
  "Text",
  "Range",
  "MutationObserver",
  "CustomEvent",
  "Event",
  "EventTarget",
  "KeyboardEvent",
  "MouseEvent",
  "DOMRect",
  "customElements",
]) {
  Object.defineProperty(globalThis, key, { value: window[key], configurable: true, writable: true });
}
globalThis.window = window;
globalThis.self = window;
globalThis.localStorage = window.localStorage;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.requestAnimationFrame = (callback) => setTimeout(() => callback(Date.now()), 16);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
window.requestAnimationFrame = globalThis.requestAnimationFrame;
window.cancelAnimationFrame = globalThis.cancelAnimationFrame;
window.PointerEvent ??= window.MouseEvent;
globalThis.PointerEvent = window.PointerEvent;
globalThis.getComputedStyle = window.getComputedStyle.bind(window);
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

const outDir = mkdtempSync(join(tmpdir(), "book-jump-back-"));
const entry = join(outDir, "entry.ts");
const posix = (path) => path.replace(/\\/g, "/");
writeFileSync(
  entry,
  `
  export { useBookJumpBack } from "${posix(join(src, "pages/reader/hooks/use-book-jump-back.ts"))}";
  export { JumpBackButton } from "${posix(join(src, "components/reader/jump-back-button.tsx"))}";
  export { View } from "${posix(join(root, "packages/foliate-js/view.js"))}";
  export { default as React, act } from "react";
  export { createRoot } from "react-dom/client";
`,
);
const outfile = join(outDir, "test.mjs");
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
  loader: { ".css": "empty" },
  logLevel: "silent",
});
const { useBookJumpBack, JumpBackButton, View, React, act, createRoot } = await import(pathToFileURL(outfile).href);

const view = new View();
let currentLocation = null;
view.book = { resolveHref: (target) => ({ index: target }) };
view.renderer = {
  goTo: async (resolved) => {
    currentLocation = resolved;
  },
};
document.body.append(view);
let currentHook;
function Harness() {
  currentHook = useBookJumpBack(view);
  return currentHook.show ? React.createElement(JumpBackButton, { onClick: currentHook.jumpBack }) : null;
}
const host = document.createElement("div");
document.body.append(host);
const reactRoot = createRoot(host);
const flush = () => act(async () => {});
const goTo = async (target) => {
  await act(async () => {
    await view.goTo(target);
  });
  assert.equal(currentLocation.index, target);
};
const relocate = async (cfi, fraction) => {
  await act(async () => {
    view.dispatchEvent(new CustomEvent("relocate", { detail: { cfi, fraction } }));
  });
};
const button = () => host.querySelector('button[aria-label="返回转跳前位置"]');
try {
  await act(async () => {
    reactRoot.render(React.createElement(Harness));
  });
  assert.equal(button(), null, "初始阅读位置不应凭空出现返回按钮");

  await goTo("section-a");
  await relocate("cfi-a", 0.1);
  assert.equal(button(), null, "首次打开仍不是转跳");

  await goTo("section-b");
  await relocate("cfi-b", 0.2);
  assert.ok(button(), "目录、脚注、引用共用的 goTo 应显示返回按钮");
  assert.ok(button().className.includes("rounded-full"), "应为简洁的圆形按钮");

  await goTo("section-c");
  await relocate("cfi-c", 0.3);
  await act(async () => {
    button().click();
  });
  await relocate("cfi-b", 0.2);
  assert.equal(currentLocation.index, "section-b", "第一次返回应回到上一处转跳");
  assert.ok(button(), "仍有更早的转跳时保留按钮");

  await act(async () => {
    button().click();
  });
  await relocate("cfi-a", 0.1);
  assert.equal(currentLocation.index, "section-a", "第二次返回应回到最初位置");
  assert.equal(button(), null, "回到起点后应隐藏");

  await goTo("section-b");
  await relocate("cfi-b", 0.2);
  assert.ok(button(), "新一轮转跳应重新出现");
  await relocate("cfi-b-page-2", 0.201);
  assert.equal(button(), null, "读者转到新位置继续阅读后应隐藏");

  await goTo("section-c");
  await relocate("cfi-c", 0.3);
  assert.ok(button(), "隐藏后发生新的真实转跳应再次出现");
  console.log("PASS 真实 Foliate history：goTo 出现、逐级返回、起点隐藏、继续阅读隐藏");
} finally {
  await act(async () => {
    reactRoot.unmount();
  });
  host.remove();
  view.remove();
  await flush();
}
dom.window.close();
esbuild.stop();
process.exit(0);
