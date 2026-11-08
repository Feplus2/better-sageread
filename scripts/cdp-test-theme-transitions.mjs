import { mkdirSync, writeFileSync } from "node:fs";
import { appModuleExpression } from "./cdp-app-module.mjs";

const cdpPort = process.env.CDP_PORT ?? "9224";
const appPort = process.env.APP_PORT ?? "1421";
const outDir = process.env.VERIFY_OUT ?? ".superpowers/sdd/2026-11-06-user-acceptance-followup/theme";
mkdirSync(outDir, { recursive: true });
const bookId = "c6207a35b9b8e0b5396d0b2ffc4f42b9";
const pages = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
const page = pages.find((target) => target.type === "page" && target.url?.includes(`localhost:${appPort}`));
if (!page) throw new Error("找不到隔离 Preview");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});
let seq = 0;
const pending = new Map();
ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    pending.get(message.id)(message);
    pending.delete(message.id);
  }
};
const call = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP 超时：${method}`));
    }, 20000);
    pending.set(id, (message) => {
      clearTimeout(timer);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolve(message);
    });
    ws.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (expression) => {
  const result = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.result?.exceptionDetails)
    throw new Error(result.result.exceptionDetails.exception?.description ?? result.result.exceptionDetails.text);
  return result.result?.result?.value;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (expression, label, attempts = 120) => {
  for (let index = 0; index < attempts; index += 1) {
    if (await evaluate(`(async () => Boolean(await (${expression})))()`)) return;
    await sleep(100);
  }
  throw new Error(`等待超时：${label}`);
};
const checks = [];
const check = (name, pass, detail = "") => {
  checks.push({ name, pass: Boolean(pass), detail });
  console.log(`${pass ? "PASS" : "FAIL"} ${name}${detail ? ` | ${detail}` : ""}`);
};
const shot = async (name) => {
  const image = await call("Page.captureScreenshot", { format: "png" });
  writeFileSync(`${outDir}/${name}.png`, Buffer.from(image.result.data, "base64"));
};
let previous;
let lianyan;
let history;
let workspace;
try {
  previous = await evaluate(`(async () => {
    const layout = (await import("/src/store/layout-store.ts")).useLayoutStore.getState();
    const theme = (await import(${appModuleExpression("/src/store/theme-store.ts")})).useThemeStore.getState();
    const workspace = (await import("/src/store/file-workspace-store.ts")).useFileWorkspaceStore.getState();
    return {
      layout: { tabs: layout.tabs, activeTabId: layout.activeTabId, isHomeActive: layout.isHomeActive, isChatVisible: layout.isChatVisible, isNotepadVisible: layout.isNotepadVisible, tabOrientation: layout.tabOrientation, isVerticalTabCollapsed: layout.isVerticalTabCollapsed },
      theme: Object.fromEntries(Object.entries(theme).filter(([, value]) => typeof value !== "function")),
      workspace: { hosts: workspace.hosts, recentRoots: workspace.recentRoots },
    };
  })()`);
  await evaluate(`(async () => {
    const layout = (await import("/src/store/layout-store.ts")).useLayoutStore.getState();
    await layout.openBook(${JSON.stringify(bookId)}, "秦汉史讲义");
    return true;
  })()`);
  await waitFor(
    `(async () => {
    const layout = (await import("/src/store/layout-store.ts"))?.useLayoutStore;
    return layout?.getState().readerStores?.get("reader-${bookId}")?.getState().view?.renderer?.getContents?.()?.[0]?.doc?.querySelector("p");
  })()`,
    "书籍正文与渲染器就绪",
  );
  await evaluate(`(async () => {
    const layout = (await import("/src/store/layout-store.ts")).useLayoutStore.getState();
    const renderer = layout.readerStores.get("reader-${bookId}").getState().view.renderer;
    const original = renderer.setStyles;
    window.__themeStyleProbe = { count: 0, latest: "", restore: () => { renderer.setStyles = original; delete window.__themeStyleProbe; } };
    renderer.setStyles = function (css) {
      window.__themeStyleProbe.count += 1;
      window.__themeStyleProbe.latest = css;
      return original.call(this, css);
    };
    return true;
  })()`);
  await evaluate(`(async () => {
    const store = (await import(${appModuleExpression("/src/store/theme-store.ts")})).useThemeStore;
    store.setState({ themeCode: { ...store.getState().themeCode, palette: { ...store.getState().themeCode.palette } } });
    return true;
  })()`);
  await waitFor("window.__themeStyleProbe?.count > 0", "阅读器样式监测通道就绪");
  const styleBaseline = await evaluate("window.__themeStyleProbe.count");
  await evaluate(`(async () => {
    const store = (await import(${appModuleExpression("/src/store/theme-store.ts")})).useThemeStore;
    await store.getState().setGlobalTheme("lianyan");
    return true;
  })()`);
  await waitFor(`window.__themeStyleProbe?.count > ${styleBaseline}`, "怜烟切换立即重注入样式");
  lianyan = await evaluate(`(() => {
    const probe = window.__themeStyleProbe;
    return { count: probe.count, css: probe.latest, popover: getComputedStyle(document.documentElement).getPropertyValue("--popover").trim() };
  })()`);
  check("不刷新页面，怜烟字段改变会立即重注入阅读样式", lianyan.count > 0, `setStyles ${lianyan.count} 次`);
  check(
    "怜烟动态媒体正文不叠加额外色层",
    lianyan.css.match(/--theme-bg-color:\s*([^;]+)/)?.[1]?.trim() === "rgba(26, 19, 22, 0)",
    lianyan.css.match(/--theme-bg-color:[^;]+;/)?.[0] ?? "缺少背景变量",
  );
  check("没有通过页面刷新掩盖主题更新", await evaluate("window.__themeStyleProbe?.count > 0"));
  await shot("lianyan-reader");

  await evaluate(`document.querySelector('#chat-sidebar button:has(svg.lucide-history)')?.click(); true`);
  await waitFor(`document.querySelector('[data-region="assistant-history-panel"]')`, "历史面板打开");
  history = await evaluate(`(() => {
    const panel = document.querySelector('[data-region="assistant-history-panel"]');
    const style = getComputedStyle(panel);
    return { background: style.backgroundColor, color: style.color, text: panel.textContent, opacity: style.opacity };
  })()`);
  check(
    "历史面板使用不透明度的有色承力面",
    !history.background.startsWith("rgba(0, 0, 0") && !history.background.endsWith(", 0)") && history.opacity === "1",
    JSON.stringify(history),
  );
  check("历史面板保留可读文本", history.text.includes("历史对话"), history.text.slice(0, 100));
  await shot("lianyan-history");
  await evaluate(`document.querySelector('[data-panel-side="left"] button:has(svg.lucide-arrow-left)')?.click(); true`);
  await evaluate(`document.querySelector('[aria-label="打开文件工作区"]').click(); true`);
  await waitFor(`document.querySelector('[data-region="file-workspace"]')`, "文件工作区打开");
  workspace = await evaluate(`(() => {
    const panel = document.querySelector('[data-region="file-workspace"]');
    const style = getComputedStyle(panel);
    return { background: style.backgroundColor, color: style.color, text: panel.textContent, opacity: style.opacity };
  })()`);
  check(
    "文件面板使用 popover 承力面而非纯黑或透明画布",
    !workspace.background.startsWith("rgba(0, 0, 0") &&
      !workspace.background.endsWith(", 0)") &&
      workspace.opacity === "1",
    JSON.stringify(workspace),
  );
  check(
    "文件面板保留可读操作与文本",
    workspace.text.includes("浏览目录") || workspace.text.includes("文件"),
    workspace.text.slice(0, 100),
  );
  await shot("lianyan-files");

  const beforeRestore = await evaluate("window.__themeStyleProbe.count");
  await evaluate(`(async () => {
    const previous = ${JSON.stringify(previous.theme)};
    const store = (await import(${appModuleExpression("/src/store/theme-store.ts")})).useThemeStore;
    await store.getState().setGlobalTheme(previous.globalTheme);
    store.setState(previous);
    return true;
  })()`);
  await waitFor(`window.__themeStyleProbe.count > ${beforeRestore}`, "切回原主题同样即时重注入");
  check("默认与怜烟往返切换都不需要刷新", true);
} catch (error) {
  check("主题验收执行异常", false, error instanceof Error ? error.stack : String(error));
} finally {
  await evaluate(`(async () => {
    const previous = ${JSON.stringify(previous ?? {})};
    if (previous.theme) {
      const store = (await import(${appModuleExpression("/src/store/theme-store.ts")})).useThemeStore;
      await store.getState().setGlobalTheme(previous.theme.globalTheme);
      store.setState(previous.theme);
    }
    if (previous.workspace) (await import("/src/store/file-workspace-store.ts")).useFileWorkspaceStore.setState(previous.workspace);
    if (previous.layout) (await import("/src/store/layout-store.ts")).useLayoutStore.setState(previous.layout);
    window.__themeStyleProbe?.restore?.();
    return true;
  })()`).catch(() => {});
  ws.close();
}
writeFileSync(`${outDir}/report.json`, JSON.stringify({ checks, lianyan, history, workspace }, null, 2));
if (checks.some((item) => !item.pass)) process.exit(1);
console.log(`${checks.length}/${checks.length} PASS`);
