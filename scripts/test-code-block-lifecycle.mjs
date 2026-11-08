import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";

const root = fileURLToPath(new URL("../", import.meta.url));
const esbuildPkg = readdirSync(join(root, "node_modules", ".pnpm")).find((entry) => entry.startsWith("esbuild@"));
assert.ok(esbuildPkg);
const esbuild = await import(
  pathToFileURL(join(root, "node_modules", ".pnpm", esbuildPkg, "node_modules", "esbuild", "lib", "main.js")).href
);
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
for (const key of ["document", "navigator", "HTMLElement", "Element", "Node", "Text", "Event", "MutationObserver"]) {
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
}
globalThis.window = dom.window;
globalThis.localStorage = dom.window.localStorage;
globalThis.sessionStorage = dom.window.sessionStorage;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
window.__TAURI_INTERNALS__ = {
  invoke: async (command) => {
    if (command === "plugin:path|resolve_directory") return tmpdir();
    if (command.startsWith("plugin:store|")) return null;
    if (command === "plugin:fs|exists") return false;
    throw new Error(`未预期的 Tauri 调用：${command}`);
  },
};
const channels = [];
const NativeMessageChannel = globalThis.MessageChannel;
globalThis.MessageChannel = class extends NativeMessageChannel {
  constructor() {
    super();
    channels.push(this);
  }
};

const outDir = mkdtempSync(join(tmpdir(), "code-block-lifecycle-"));
const entry = join(outDir, "entry.tsx");
const outfile = join(outDir, "bundle.mjs");
writeFileSync(
  entry,
  `export { CodeBlockCode } from "${join(root, "packages/app/src/components/prompt-kit/code-block.tsx").replace(/\\/g, "/")}";
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
  nodePaths: [join(root, "packages/app/node_modules")],
  loader: { ".css": "empty", ".svg": "dataurl", ".png": "dataurl" },
  plugins: [
    {
      name: "controlled-highlight",
      setup(build) {
        build.onResolve({ filter: /^shiki$/ }, () => ({ path: "controlled-highlight", namespace: "test" }));
        build.onLoad({ filter: /.*/, namespace: "test" }, () => ({
          loader: "js",
          contents: "export function codeToHtml(...args) { return globalThis.__codeToHtml(...args); }",
        }));
      },
    },
  ],
  logLevel: "silent",
});
const { CodeBlockCode, React, act, createRoot } = await import(pathToFileURL(outfile).href);
const unhandled = [];
const onUnhandled = (reason) => unhandled.push(String(reason));
process.on("unhandledRejection", onUnhandled);
let failed = 0;

async function test(name, run) {
  try {
    await run();
    console.log(`PASS ${name}`);
  } catch (error) {
    failed++;
    console.error(`FAIL ${name} — ${error instanceof Error ? error.stack : String(error)}`);
  }
}

await test("高亮Promise在卸载后失败不会产生未处理拒绝", async () => {
  const requests = [];
  globalThis.__codeToHtml = (code) => new Promise((resolve, reject) => requests.push({ code, resolve, reject }));
  const host = document.createElement("div");
  document.body.appendChild(host);
  const view = createRoot(host);
  await act(async () => {
    view.render(React.createElement(CodeBlockCode, { code: "const first = 1;", language: "unknown-language" }));
  });
  assert.equal(requests.length, 1);
  await act(async () => {
    view.unmount();
    requests[0].reject(new Error("unsupported language"));
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
  assert.deepEqual(unhandled, []);
  host.remove();
});

await test("较早的高亮结果不能覆盖较新的代码", async () => {
  const requests = [];
  globalThis.__codeToHtml = (code) => new Promise((resolve, reject) => requests.push({ code, resolve, reject }));
  const host = document.createElement("div");
  document.body.appendChild(host);
  const view = createRoot(host);
  await act(async () => {
    view.render(React.createElement(CodeBlockCode, { code: "old-code", language: "ts" }));
  });
  await act(async () => {
    view.render(React.createElement(CodeBlockCode, { code: "new-code", language: "ts" }));
  });
  assert.equal(requests.length, 2);
  await act(async () => {
    requests[1].resolve("<pre><code>new-code</code></pre>");
  });
  assert.equal(host.textContent, "new-code");
  await act(async () => {
    requests[0].resolve("<pre><code>old-code</code></pre>");
  });
  assert.equal(host.textContent, "new-code");
  await act(async () => view.unmount());
  host.remove();
});

process.removeListener("unhandledRejection", onUnhandled);
for (const channel of channels) {
  for (const port of [channel.port1, channel.port2]) {
    port.unref();
    port.close();
  }
}
globalThis.MessageChannel = NativeMessageChannel;
window.close();
console.log(`\n结果：${2 - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
