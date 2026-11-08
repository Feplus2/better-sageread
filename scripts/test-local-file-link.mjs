import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";

const root = fileURLToPath(new URL("../", import.meta.url));
const src = join(root, "packages/app/src");
const esbuildPkg = readdirSync(join(root, "node_modules", ".pnpm")).find((name) => name.startsWith("esbuild@"));
assert.ok(esbuildPkg);
const esbuild = await import(
  pathToFileURL(join(root, "node_modules", ".pnpm", esbuildPkg, "node_modules", "esbuild", "lib", "main.js")).href
);
const outDir = mkdtempSync(join(tmpdir(), "local-file-link-"));
const posix = (path) => path.replace(/\\/g, "/");
let failed = 0;
async function test(name, run) {
  try {
    await run();
    console.log(`PASS ${name}`);
  } catch (error) {
    failed++;
    console.error(`FAIL ${name} — ${error instanceof Error ? error.message : String(error)}`);
  }
}
async function bundle(name, source) {
  const entry = join(outDir, `${name}.tsx`);
  const outfile = join(outDir, `${name}.mjs`);
  writeFileSync(entry, source);
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
  return import(pathToFileURL(outfile).href);
}

await test("本地链接按协议分类且不让路径前缀冒充目录内文件", async () => {
  const { links } = await bundle(
    "parser",
    `export * as links from "${posix(join(src, "ai/utils/local-file-link.ts"))}";`,
  );
  assert.deepEqual(links.classifyFileLink("file:///F:/%E8%B5%84%E6%96%99/final%20report.md"), {
    kind: "local",
    path: "F:/资料/final report.md",
    absolute: true,
  });
  assert.deepEqual(links.classifyFileLink("note.txt"), { kind: "local", path: "note.txt", absolute: false });
  assert.equal(links.classifyFileLink("../outside.md").absolute, false);
  assert.equal(links.classifyFileLink("file://server/share/report.md").path, "//server/share/report.md");
  assert.equal(links.classifyFileLink("file:///F:/ws/%252e%252e%252fsecret").path, "F:/ws/%2e%2e%2fsecret");
  assert.deepEqual(links.classifyFileLink("F:/ws/100% done.md"), {
    kind: "local",
    path: "F:/ws/100% done.md",
    absolute: true,
  });
  assert.equal(links.classifyFileLink("file:///F:/ws/50%.csv").kind, "local");
  assert.equal(links.classifyFileLink("file:///C:/bad%ZZ").kind, "local");
  assert.equal(links.classifyFileLink("file:///C:/bad%0Aname").kind, "blocked");
  for (const href of ["javascript:alert(1)", "data:text/html,attack", "vbscript:attack", "file:///C:/x\u0000y"])
    assert.equal(links.classifyFileLink(href).kind, "blocked", href);
  assert.equal(links.classifyFileLink("https://example.com/report").kind, "external");
  assert.equal(links.classifyFileLink("#section").kind, "other");
  assert.equal(links.classifyFileLink("mailto:user@example.com").kind, "other");
  assert.equal(links.isLocalPathWithinRoot("F:/ws", "F:/ws/nested/report.md"), true);
  assert.equal(links.isLocalPathWithinRoot("F:/ws", "f:/WS/report.md"), true);
  assert.equal(links.isLocalPathWithinRoot("F:/ws", "F:/ws-other/report.md"), false);
  assert.equal(links.isLocalPathWithinRoot("F:/ws", "F:/outside/report.md"), false);
});

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
const { window } = dom;
for (const key of [
  "document",
  "navigator",
  "HTMLElement",
  "Element",
  "Node",
  "Text",
  "Event",
  "MouseEvent",
  "MutationObserver",
]) {
  Object.defineProperty(globalThis, key, { value: window[key], configurable: true, writable: true });
}
globalThis.window = window;
window.__TAURI_INTERNALS__ = {
  invoke: async (command) => {
    if (command === "plugin:path|resolve_directory" || command.startsWith("plugin:store|")) return null;
    if (command === "plugin:fs|exists") return false;
    return null;
  },
};
globalThis.localStorage = window.localStorage;
globalThis.sessionStorage = window.sessionStorage;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
class Observer {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = Observer;
globalThis.IntersectionObserver = Observer;
window.ResizeObserver = Observer;
window.IntersectionObserver = Observer;

await test("真实消息 Markdown 渲染可点击文件链接且保留 HTTP、拦截恶意协议", async () => {
  const { MessageContent, LocalFileLinkContext, React, act, createRoot } = await bundle(
    "markdown",
    `export { MessageContent } from "${posix(join(src, "components/prompt-kit/message.tsx"))}";
     export { LocalFileLinkContext } from "${posix(join(src, "components/prompt-kit/local-file-anchor.tsx"))}";
     export { default as React, act } from "react";
     export { createRoot } from "react-dom/client";`,
  );
  const host = document.createElement("div");
  document.body.appendChild(host);
  const view = createRoot(host);
  const opened = [];
  const content = [
    "[打开报告](<file:///F:/%E8%B5%84%E6%96%99/final%20report.md>)",
    "[相对文件](note.txt)",
    "[百分比](<file:///F:/default/100%.md>)",
    '<a href="file:///F:/default/100%.md">原始百分比</a>',
    "[网页](https://example.com/report)",
    "[危险协议](javascript:alert(1))",
    "[数据协议](data:text/html,attack)",
  ].join("\n\n");
  try {
    await act(async () => {
      view.render(
        React.createElement(
          LocalFileLinkContext.Provider,
          { value: (path) => opened.push(path) },
          React.createElement(MessageContent, { markdown: true }, content),
        ),
      );
    });
    const report = Array.from(host.querySelectorAll("button[data-local-file-path]")).find((item) =>
      item.textContent.includes("打开报告"),
    );
    assert.ok(report, "file:// 链接不能在被默认 URL 清洗后静默消失");
    assert.equal(report.dataset.localFilePath, "F:/资料/final report.md");
    await act(async () => report.dispatchEvent(new window.MouseEvent("click", { bubbles: true })));
    assert.deepEqual(opened, ["F:/资料/final report.md"]);
    const relative = Array.from(host.querySelectorAll("button[data-local-file-path]")).find((item) =>
      item.textContent.includes("相对文件"),
    );
    assert.equal(relative?.dataset.localFilePath, "note.txt");
    const percent = Array.from(host.querySelectorAll("button[data-local-file-path]")).find((item) =>
      item.textContent.includes("百分比"),
    );
    assert.equal(percent?.dataset.localFilePath, "F:/default/100%.md");
    assert.equal(
      Array.from(host.querySelectorAll("a")).some((item) => item.textContent === "原始百分比"),
      false,
      "原始 HTML 不应绕过 Markdown 的安全渲染",
    );
    assert.equal(host.querySelector('a[href="https://example.com/report"]')?.textContent, "网页");
    assert.equal(host.querySelector('a[href^="javascript:"], a[href^="data:"]'), null);
    assert.equal(host.querySelectorAll("button[data-local-file-path]").length, 3);
  } finally {
    await act(async () => view.unmount());
    host.remove();
  }
});

window.close();
process.exit(failed ? 1 : 0);
