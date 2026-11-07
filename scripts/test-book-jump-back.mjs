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
  export { markProgrammaticNavigation } from "${posix(join(src, "pages/reader/hooks/navigation-tracker.ts"))}";
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
const { useBookJumpBack, JumpBackButton, View, markProgrammaticNavigation, React, act, createRoot } = await import(
  pathToFileURL(outfile).href
);

const view = new View();
view.id = "foliate-view-test-book";
let currentLocation = null;
view.book = { resolveHref: (target) => ({ index: target }) };
view.renderer = {
  scrolled: true,
  viewSize: 10000,
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
const relocate = async (cfi, sectionFraction, size) => {
  await act(async () => {
    view.dispatchEvent(new CustomEvent("relocate", { detail: { cfi, fraction: 0.04, sectionFraction, size } }));
  });
};
const button = () => host.querySelector('button[aria-label="返回转跳前位置"]');
try {
  await act(async () => {
    reactRoot.render(React.createElement(Harness));
  });
  assert.equal(Boolean(button()), false, "初始阅读位置不应凭空出现返回按钮");

  await goTo("section-a");
  await relocate("cfi-a", 0.1);
  assert.equal(Boolean(button()), false, "首次打开仍不是转跳");

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
  assert.equal(Boolean(button()), false, "回到起点后应隐藏");

  await goTo("section-b");
  await relocate("cfi-b", 0.2);
  assert.ok(button(), "新一轮转跳应重新出现");
  await relocate("cfi-b-page-2", 0.2001);
  assert.ok(button(), "滚动模式下 1px 的位置变化不应误隐藏");
  await relocate("cfi-b-page-3", 0.23);
  assert.equal(Boolean(button()), false, "滚动模式下实际位移达到 300px 应隐藏");

  await goTo("section-c");
  await relocate("cfi-c", 0.3);
  assert.ok(button(), "隐藏后发生新的真实转跳应再次出现");
  view.renderer.scrolled = false;
  await relocate("cfi-c", 0.301, 0.009);
  assert.ok(button(), "重排但不足一页时不应误隐藏");
  await relocate("cfi-c-next-page", 0.311, 0.01);
  assert.equal(Boolean(button()), false, "分页模式下继续读一页后应隐藏");

  markProgrammaticNavigation("test-book");
  await new Promise((resolve) => setTimeout(resolve, 2100));
  await goTo("synced-location");
  await relocate("cfi-synced", 0.4);
  assert.equal(Boolean(button()), false, "慢书页中的后台同步也不得冒充用户转跳");
  await goTo("user-location");
  await relocate("cfi-user", 0.5);
  assert.ok(button(), "同步标记只消费一次，后续真实转跳仍应显示");
  console.log("PASS 真实 Foliate history：goTo、逐级返回、位移阈值与同步转跳边界");
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
