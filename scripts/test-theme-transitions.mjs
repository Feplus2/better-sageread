import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";

const root = fileURLToPath(new URL("../", import.meta.url));
const src = join(root, "packages/app/src");
const pnpmDir = join(root, "node_modules", ".pnpm");
const esbuildPkg = readdirSync(pnpmDir).find((name) => name.startsWith("esbuild@"));
assert.ok(esbuildPkg);
const esbuild = await import(pathToFileURL(join(pnpmDir, esbuildPkg, "node_modules", "esbuild", "lib", "main.js")).href);
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
const { window } = dom;
for (const key of ["document", "navigator", "HTMLElement", "Element", "Node", "Text", "MutationObserver", "CustomEvent", "Event"]) {
  Object.defineProperty(globalThis, key, { value: window[key], configurable: true, writable: true });
}
globalThis.window = window;
globalThis.localStorage = window.localStorage;
globalThis.sessionStorage = window.sessionStorage;
globalThis.getComputedStyle = window.getComputedStyle.bind(window);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
window.__TAURI_INTERNALS__ = { invoke: async () => null };
globalThis.__TAURI_INTERNALS__ = window.__TAURI_INTERNALS__;

const injectedStyles = [];
const fakeView = { renderer: { setStyles: (style) => injectedStyles.push(style), setAttribute() {}, getContents: () => [] } };
const fsPackage = readdirSync(pnpmDir).find((name) => name.startsWith("@tauri-apps+plugin-fs@"));
assert.ok(fsPackage);
const actualFsEntry = join(pnpmDir, fsPackage, "node_modules", "@tauri-apps", "plugin-fs", "dist-js", "index.js").replace(/\\/g, "/");
const stubs = new Map([
  ["@/lib/tauri-storage", `export const tauriStorage = { getItem: () => null, setItem() {}, removeItem() {} };`],
  ["@/services/sync-service", `export * from "actual-sync-service"; export async function syncGetConfig() { return null; } export async function syncPullNow() { return null; }`],
  ["@tauri-apps/api/event", `export async function listen() { return () => {}; }`],
  ["@tauri-apps/api/core", `export async function invoke() { return null; } export class Resource {} export class Channel {} export function convertFileSrc(path) { return path; }`],
  ["@tauri-apps/plugin-fs", `export * from "actual-tauri-fs";`],
]);
const managerStub = `export class FoliateViewerManager {
  constructor(options) { this.options = options; }
  setProgressCallback() {}
  setViewSettingsCallback() {}
  async initialize() { this.options.onViewCreated(globalThis.__themeFakeView); }
  getView() { return globalThis.__themeFakeView; }
  syncGlobalViewSettings() {}
  async refresh() {}
  destroy() {}
}`;
globalThis.__themeFakeView = fakeView;
const relativeStubs = new Map([
  ["reader-provider", `export function useReaderStoreApi() { return { getState: () => ({ setView() {}, setProgress() {}, setLocation() {} }) }; }`],
  ["foliate-viewer-manager", managerStub],
  ["use-pagination", `export function usePagination() { return { handlePageFlip: async () => {}, handleContinuousScroll: () => {} }; }`],
  ["use-ui-css", `export function useUICSS() {}`],
  ["use-progress-auto-save", `export function useProgressAutoSave() {}`],
]);
const plugin = {
  name: "theme-transition-stubs",
  setup(build) {
    build.onResolve({ filter: /^@\/(.*)/ }, (args) => {
      if (stubs.has(args.path)) return { path: args.path, namespace: "theme-stub" };
      const base = join(src, args.path.slice(2));
      for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) {
        if (existsSync(candidate) && statSync(candidate).isFile()) return { path: candidate };
      }
      return { path: `${base}.ts` };
    });
    build.onResolve({ filter: /(reader-provider|foliate-viewer-manager|use-pagination|use-ui-css|use-progress-auto-save)$/ }, (args) => {
      const name = args.path.split("/").pop();
      if (relativeStubs.has(name)) return { path: name, namespace: "theme-stub" };
    });
    build.onResolve({ filter: /^actual-sync-service$/ }, () => ({ path: join(src, "services/sync-service.ts") }));
    build.onResolve({ filter: /^actual-tauri-fs$/ }, () => ({ path: actualFsEntry }));
    build.onResolve({ filter: /^@tauri-apps\// }, (args) => stubs.has(args.path) ? { path: args.path, namespace: "theme-stub" } : undefined);
    build.onLoad({ filter: /.*/, namespace: "theme-stub" }, (args) => ({ contents: stubs.get(args.path) ?? relativeStubs.get(args.path), loader: "js" }));
  },
};
const outDir = mkdtempSync(join(tmpdir(), "theme-transitions-"));
const entry = join(outDir, "entry.tsx");
const outfile = join(outDir, "bundle.mjs");
const posix = (path) => path.replace(/\\/g, "/");
writeFileSync(
  entry,
  `export { useFoliateViewer } from "${posix(join(src, "pages/reader/hooks/use-foliate-viewer/index.ts"))}";
   export { AssistantPanelTransition } from "${posix(join(src, "components/file-workspace/assistant-panel-transition.tsx"))}";
   export { FileWorkspace } from "${posix(join(src, "components/file-workspace/file-workspace.tsx"))}";
   export { useFileWorkspaceStore } from "${posix(join(src, "store/file-workspace-store.ts"))}";
   export { useThemeStore } from "${posix(join(src, "store/theme-store.ts"))}";
   export { default as React, act } from "react";
   export { createRoot } from "react-dom/client";
   export { renderToStaticMarkup } from "react-dom/server";
   export { QueryClient, QueryClientProvider } from "@tanstack/react-query";`,
);
await esbuild.build({
  entryPoints: [entry], bundle: true, format: "esm", platform: "node", jsx: "automatic", outfile,
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  nodePaths: [join(root, "packages/app/node_modules")], loader: { ".css": "empty", ".svg": "dataurl", ".png": "dataurl" },
  plugins: [plugin], logLevel: "silent",
});
const api = await import(pathToFileURL(outfile).href);
const { useFoliateViewer, AssistantPanelTransition, FileWorkspace, useFileWorkspaceStore, useThemeStore, React, act, createRoot, renderToStaticMarkup, QueryClient, QueryClientProvider } = api;

const panelHtml = renderToStaticMarkup(React.createElement(AssistantPanelTransition, { present: true }, React.createElement("p", null, "历史对话")));
assert.match(panelHtml, /bg-popover/, "覆盖式历史面板应使用 popover 承力面");
useFileWorkspaceStore.setState({ hosts: { central: { mode: "files", scope: "central", rootResolved: "F:/ws", explorerPath: "F:/ws", tabs: [], activeTabId: null } }, recentRoots: {} });
const workspaceHost = document.createElement("div");
document.body.appendChild(workspaceHost);
const workspaceView = createRoot(workspaceHost);
await act(async () => workspaceView.render(React.createElement(FileWorkspace, { hostId: "central", scope: "central" })));
assert.match(workspaceHost.innerHTML, /bg-popover/, "文件工作区应使用 popover 承力面");
assert.doesNotMatch(workspaceHost.innerHTML, /#000000|rgb\(0, 0, 0\)/, "不写死黑色");
await act(async () => workspaceView.unmount());
workspaceHost.remove();
console.log("PASS 历史面板与文件工作区使用 popover 而非透明画布或硬编码黑色");

const queryClient = new QueryClient();
function Harness() {
  const viewer = useFoliateViewer("theme-test-book", { rendition: { layout: "reflowable" } }, {}, { top: 0, right: 0, bottom: 0, left: 0 });
  return React.createElement("div", { ref: viewer.containerRef });
}
const host = document.createElement("div");
document.body.appendChild(host);
const view = createRoot(host);
await act(async () => view.render(React.createElement(QueryClientProvider, { client: queryClient }, React.createElement(Harness))));
const initialTheme = useThemeStore.getState().themeCode;
for (const [field, value] of [["videoWallpaper", true], ["solidAlpha", 0.91], ["bg", "#30251f"], ["globalPrimary", "#d15b45"]]) {
  const before = injectedStyles.length;
  await act(async () => useThemeStore.setState({ themeCode: { ...useThemeStore.getState().themeCode, [field]: value } }));
  assert.ok(injectedStyles.length > before, `${field} 改变后必须重新注入，不能保留旧背景`);
}
assert.match(injectedStyles.at(-1), /rgba\(/, "怜烟纯色背景应保留带透明度的颜色，而非退回纯黑");
await act(async () => useThemeStore.setState({ themeCode: initialTheme }));
await act(async () => view.unmount());
host.remove();
console.log("PASS videoWallpaper、solidAlpha、bg、globalPrimary 改变都会真实重注入样式");

const themeEntry = join(outDir, "theme-entry.ts");
const themeOutfile = join(outDir, "theme-bundle.mjs");
writeFileSync(themeEntry, `export { getThemeCode } from "${posix(join(src, "utils/style.ts"))}";`);
await esbuild.build({
  entryPoints: [themeEntry], bundle: true, format: "esm", platform: "node", outfile: themeOutfile,
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  nodePaths: [join(root, "packages/app/node_modules")], plugins: [plugin], logLevel: "silent",
});
const { getThemeCode } = await import(pathToFileURL(themeOutfile).href);
localStorage.setItem("readerBackground", JSON.stringify({ kind: "solid" }));
localStorage.setItem("themeMode", "dark");
const globalStyle = document.createElement("style");
globalStyle.textContent = ":root{--background:#302128;--primary:#f18aa0;}";
document.head.appendChild(globalStyle);
localStorage.setItem("globalTheme", "cake");
assert.equal(getThemeCode().bg, "#302128", "全局蛋糕主题不应退回阅读调色板的 #222222");
localStorage.setItem("themeColor", "parchment");
assert.equal(getThemeCode().bg, "#2b251c", "显式选择羊皮纸暗色时不能被全局蛋糕底色覆盖");
localStorage.setItem("themeMode", "light");
assert.equal(getThemeCode().bg, "#f4e7c8", "显式选择羊皮纸浅色时不能被全局蛋糕底色覆盖");
localStorage.setItem("themeMode", "dark");
localStorage.setItem("themeColor", "default");
globalStyle.textContent = ':root{--background:rgba(26, 19, 22, 0.22);--bg-video:url("wallpaper.mp4");--reader-solid-alpha:0.6;}';
localStorage.setItem("globalTheme", "lianyan");
const lianyanTheme = getThemeCode();
assert.equal(lianyanTheme.bg, "#1a1316", "怜烟应先去掉主题变量自带透明度");
assert.equal(lianyanTheme.solidAlpha, 0.6);
const themedHost = document.createElement("div");
document.body.appendChild(themedHost);
const themedView = createRoot(themedHost);
await act(async () => themedView.render(React.createElement(QueryClientProvider, { client: queryClient }, React.createElement(Harness))));
await act(async () => useThemeStore.setState({ themeCode: lianyanTheme }));
assert.match(injectedStyles.at(-1), /rgba\(26, 19, 22, 0\.6\)/, "阅读背景应按设置重建遮罩");
await act(async () => themedView.unmount());
themedHost.remove();
localStorage.setItem("readerBackground", JSON.stringify({ kind: "scene", sceneId: "mountains" }));
assert.equal(getThemeCode().bg, "#222222", "场景图继续使用阅读调色板，不能误用全局底色");
localStorage.removeItem("globalTheme");
localStorage.setItem("readerBackground", JSON.stringify({ kind: "solid" }));
assert.equal(getThemeCode().bg, "#222222", "无全局主题时保留原阅读调色板");
console.log("PASS 默认纯色跟随全局主题，怜烟重建遮罩，场景与阅读调色板保持独立");
window.close();
process.exit(0);
