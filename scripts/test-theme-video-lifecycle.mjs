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
const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", { url: "http://localhost/" });
const { window } = dom;
for (const key of [
  "document",
  "navigator",
  "HTMLElement",
  "Element",
  "Node",
  "MutationObserver",
  "CustomEvent",
  "Event",
  "HTMLMediaElement",
]) {
  Object.defineProperty(globalThis, key, { value: window[key], configurable: true, writable: true });
}
globalThis.window = window;
globalThis.localStorage = window.localStorage;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.getComputedStyle = window.getComputedStyle.bind(window);
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
window.HTMLMediaElement.prototype.play = async function () {
  this.paused = false;
};
window.HTMLMediaElement.prototype.pause = function () {
  this.paused = true;
};
localStorage.setItem("globalTheme", "lianyan");
localStorage.setItem("themeMode", "dark");
localStorage.setItem("themeColor", "default");
localStorage.setItem("readerBackground", JSON.stringify({ kind: "solid" }));

const videoCss = (src) =>
  `:root{--background:rgba(10, 20, 30, 0.15);--bg-video:url("${src}");--reader-solid-alpha:0.6;}`;
const videoSource = "dark.mp4";
const outDir = mkdtempSync(join(tmpdir(), "theme-video-lifecycle-"));
const entry = join(outDir, "entry.tsx");
const outfile = join(outDir, "bundle.mjs");
const posix = (path) => path.replace(/\\/g, "/");
writeFileSync(
  entry,
  `
  export { ThemeBackgroundVideo } from "${posix(join(src, "components/theme-background-video.tsx"))}";
  export { useThemeStore } from "${posix(join(src, "store/theme-store.ts"))}";
  export { default as React, act } from "react";
  export { createRoot } from "react-dom/client";
`,
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
  plugins: [
    {
      name: "theme-io",
      setup(build) {
        build.onResolve({ filter: /^@\/services\/global-theme-service$/ }, () => ({
          path: "theme-io",
          namespace: "fixture",
        }));
        build.onResolve({ filter: /^actual-theme-service$/ }, () => ({
          path: join(src, "services/global-theme-service.ts"),
        }));
        build.onResolve({ filter: /^@\/hooks\/use-motion-mode$/ }, () => ({ path: "motion", namespace: "fixture" }));
        build.onLoad({ filter: /^theme-io$/ }, () => ({
          contents: `
          export { injectGlobalThemeCss } from "actual-theme-service";
          export async function listGlobalThemes() { return [{name:"lianyan",source:"builtin"},{name:"cake",source:"builtin"}]; }
          export async function loadGlobalThemeCss(theme) {
            await new Promise((resolve) => setTimeout(resolve, 25));
            return theme.name === "lianyan" ? ${JSON.stringify(videoCss("__SOURCE__"))}.replace("__SOURCE__", globalThis.__videoSource) : ':root{--background:#292624;--primary:#dda18e;}';
          }
        `,
          loader: "js",
        }));
        build.onLoad({ filter: /^motion$/ }, () => ({
          contents: 'export const useEffectiveMotionMode = () => "full";',
          loader: "js",
        }));
      },
    },
  ],
  logLevel: "silent",
});
globalThis.__videoSource = videoSource;
const { ThemeBackgroundVideo, useThemeStore, React, act, createRoot } = await import(pathToFileURL(outfile).href);
const waitFor = async (expression, label) => {
  for (let index = 0; index < 100; index += 1) {
    if (await evaluate(expression)) return;
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  }
  throw new Error(`等待超时：${label}`);
};
const evaluate = (expression) => act(async () => window.eval(expression));
const host = document.createElement("div");
document.body.append(host);
const view = createRoot(host);
try {
  await act(async () => view.render(React.createElement(ThemeBackgroundVideo)));
  await act(async () => {
    const store = useThemeStore.getState();
    await store.refreshGlobalThemes();
    await store.setGlobalTheme("lianyan");
  });
  await waitFor(`document.querySelector('video')?.getAttribute("src") === "dark.mp4"`, "初始视频主题");
  await act(async () => useThemeStore.getState().setGlobalTheme("cake"));
  await waitFor(`!document.querySelector("video")`, "切换纯色主题后必须移除旧视频");
  await act(async () => useThemeStore.getState().setGlobalTheme("lianyan"));
  await waitFor(`document.querySelector('video')?.getAttribute("src") === "dark.mp4"`, "重新进入视频主题");
  globalThis.__videoSource = "custom-video.mp4";
  await act(async () => useThemeStore.getState().reloadGlobalThemes());
  await waitFor(
    `document.querySelector('video')?.getAttribute("src") === "custom-video.mp4"`,
    "同名主题重新加载新视频源",
  );
  console.log("PASS 纯色切换会移除旧视频，视频主题可恢复，同名主题刷新能接管新视频源");
} finally {
  await act(async () => view.unmount());
  host.remove();
  dom.window.close();
  esbuild.stop();
}
process.exit(0);
