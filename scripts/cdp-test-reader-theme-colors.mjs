import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(new URL("../packages/app/package.json", import.meta.url));
const tinycolor = require("tinycolor2");

const outDir = process.env.VERIFY_OUT ?? ".superpowers/sdd/2026-11-07-user-feedback/theme";
mkdirSync(outDir, { recursive: true });
const pages = await (await fetch("http://127.0.0.1:9224/json/list")).json();
const page = pages.find((target) => target.type === "page" && target.url?.includes("localhost:1421"));
if (!page) throw new Error("找不到隔离 Preview");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});
let sequence = 0;
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
    const id = ++sequence;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP 超时：${method}`));
    }, 20000);
    pending.set(id, (message) => {
      clearTimeout(timer);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolve(message.result);
    });
    ws.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (expression) => {
  const response = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (response.exceptionDetails)
    throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
  return response.result?.value;
};
const waitFor = async (expression, label) => {
  for (let index = 0; index < 120; index += 1) {
    if (await evaluate(`(async () => Boolean(await (${expression})))()`)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`等待超时：${label}`);
};
const themeModuleUrl = await evaluate(`(() => {
  const path = "/src/store/theme-store.ts";
  const loaded = performance.getEntriesByType("resource").map((entry) => entry.name).filter((url) => {
    const parsed = new URL(url);
    return parsed.pathname === path;
  }).at(-1);
  return loaded ?? path;
})()`);
const bookId = "c6207a35b9b8e0b5396d0b2ffc4f42b9";
const palette = {
  cake: { card: "#35302b", popover: "#40372f", fg: "#f1e7dc", primary: "#dda18e", muted: "#c5b5a7" },
  parchment: { card: "#3d2f23", popover: "#493928", fg: "#f2e3c4", primary: "#e3ae76", muted: "#c9b492" },
  morandi: { card: "#33414a", popover: "#3c4c55", fg: "#e4e9e7", primary: "#a6c8c0", muted: "#b0bfbb" },
};
const checks = [];
const check = (name, pass, detail = "") => {
  checks.push({ name, pass: Boolean(pass), detail });
  console.log(`${pass ? "PASS" : "FAIL"} ${name}${detail ? ` | ${detail}` : ""}`);
};
let previous;
try {
  previous = await evaluate(`(async () => {
    const theme = (await import(${JSON.stringify(themeModuleUrl)})).useThemeStore.getState();
    const layout = (await import("/src/store/layout-store.ts")).useLayoutStore.getState();
    return {
      theme: Object.fromEntries(Object.entries(theme).filter(([, value]) => typeof value !== "function")),
      layout: { tabs: layout.tabs, activeTabId: layout.activeTabId, isHomeActive: layout.isHomeActive, isChatVisible: layout.isChatVisible, isNotepadVisible: layout.isNotepadVisible, tabOrientation: layout.tabOrientation, isVerticalTabCollapsed: layout.isVerticalTabCollapsed },
    };
  })()`);
  await evaluate(`(async () => {
    const theme = (await import(${JSON.stringify(themeModuleUrl)})).useThemeStore.getState();
    await theme.refreshGlobalThemes();
    theme.setReaderBackground({ kind: "solid" });
    const layout = (await import("/src/store/layout-store.ts")).useLayoutStore.getState();
    await layout.openBook(${JSON.stringify(bookId)}, "A Modern Introduction to Quantum Field Theory");
    return true;
  })()`);
  await waitFor(
    `(async () => {
    const renderer = (await import("/src/store/layout-store.ts")).useLayoutStore.getState().readerStores?.get("reader-${bookId}")?.getState().view?.renderer;
    if (!renderer || renderer.getContents().length === 0 || renderer.getContents().some(({ doc }) => doc.readyState !== "complete")) { delete window.__readerRendererCandidate; return false; }
    if (window.__readerRendererCandidate === renderer) return true;
    window.__readerRendererCandidate = renderer;
    return false;
  })()`,
    "书籍渲染器连续两轮保持稳定",
  );
  const backgrounds = { cake: "#292624", parchment: "#30251c", morandi: "#28323a", lianyan: "#1a1316" };
  const themeNames = Object.keys(backgrounds);
  for (const name of themeNames) {
    await evaluate(
      `(async () => { await (await import(${JSON.stringify(themeModuleUrl)})).useThemeStore.getState().setGlobalTheme(${JSON.stringify(name)}); return true; })()`,
    );
    const selected = await evaluate(`(async () => {
      const theme = (await import(${JSON.stringify(themeModuleUrl)})).useThemeStore.getState();
      return { global: theme.globalTheme, bg: theme.themeCode.bg, available: theme.availableGlobalThemes.map((item) => item.name), rootBg: getComputedStyle(document.documentElement).getPropertyValue("--background") };
    })()`);
    check(`${name} 被实际选中且主题 CSS 已加载`, selected.global === name, JSON.stringify(selected));
    const expectedReaderBg = name === "lianyan" ? "rgba(26, 19, 22, 0)" : backgrounds[name];
    await waitFor(
      `(async () => {
      const renderer = (await import("/src/store/layout-store.ts")).useLayoutStore.getState().readerStores?.get("reader-${bookId}")?.getState().view?.renderer;
      return renderer?.getContents().some(({ doc }) => getComputedStyle(doc.documentElement).getPropertyValue("--theme-bg-color").trim() === ${JSON.stringify(expectedReaderBg)});
    })()`,
      `${name} 书页内最终背景变量即时更新；${JSON.stringify(selected)}`,
    );
    const current = await evaluate(`(async () => {
      const root = getComputedStyle(document.documentElement);
      const { getThemeCode } = await import("/src/utils/style.ts");
      const renderer = (await import("/src/store/layout-store.ts")).useLayoutStore.getState().readerStores?.get("reader-${bookId}")?.getState().view?.renderer;
      return {
        bg: getThemeCode().bg,
        rootBg: root.getPropertyValue("--background").trim(),
        card: root.getPropertyValue("--card").trim(),
        popover: root.getPropertyValue("--popover").trim(),
        fg: root.getPropertyValue("--foreground").trim(),
        primary: root.getPropertyValue("--primary").trim(),
        muted: root.getPropertyValue("--muted-foreground").trim(),
        readerBgs: renderer?.getContents().map(({ doc }) => getComputedStyle(doc.documentElement).getPropertyValue("--theme-bg-color").trim()) ?? [],
      };
    })()`);
    if (name === "lianyan") {
      check(
        "怜烟默认背景取全局色相，正文全透明透出动态媒体",
        current.bg === "#1a1316" &&
          current.readerBgs.length > 0 &&
          current.readerBgs.every((bg) => bg === expectedReaderBg),
        JSON.stringify({ bg: current.bg, rootBg: current.rootBg, readerBgs: current.readerBgs }),
      );
    } else {
      check(
        `${name} 默认阅读背景跟随全局主题并进入书页`,
        current.bg === current.rootBg &&
          current.bg !== "#222222" &&
          current.readerBgs.length > 0 &&
          current.readerBgs.every((bg) => bg === backgrounds[name]),
        JSON.stringify({ bg: current.bg, rootBg: current.rootBg, readerBgs: current.readerBgs }),
      );
      const expected = palette[name];
      const { readerBgs: _readerBgs, ...colors } = current;
      check(
        `${name} 使用协调的暗色候选`,
        current.card === expected.card &&
          current.popover === expected.popover &&
          current.fg === expected.fg &&
          current.primary === expected.primary &&
          current.muted === expected.muted,
        JSON.stringify(colors),
      );
      const fgRatio = tinycolor.readability(current.popover, current.fg);
      const primaryRatio = tinycolor.readability(current.popover, current.primary);
      check(
        `${name} 浮层正文与主色清晰可读`,
        fgRatio >= 4.5 && primaryRatio >= 4.5,
        JSON.stringify({ fgRatio, primaryRatio }),
      );
    }
    const point = await evaluate(`(() => {
      const element = Array.from(document.querySelectorAll('[data-book-id]')).find((item) => item.dataset.bookId === ${JSON.stringify(bookId)} && !item.closest("[inert]") && getComputedStyle(item).pointerEvents !== "none");
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      const renderer = window.__readerRendererCandidate;
      const doc = renderer?.getContents()[0]?.doc;
      return { x: Math.round(rect.left + 24), y: Math.round(rect.top + 24), surface: doc ? { html: getComputedStyle(doc.documentElement).backgroundColor, body: getComputedStyle(doc.body).backgroundColor, hasBackground: doc.documentElement.hasAttribute("has-background") } : null };
    })()`);
    await evaluate("new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
    await new Promise((resolve) => setTimeout(resolve, 250));
    const image = await call("Page.captureScreenshot", { format: "png" });
    const imagePath = `${outDir}/${name}.png`;
    writeFileSync(imagePath, Buffer.from(image.data, "base64"));
    if (name !== "lianyan") {
      if (!point) throw new Error(`${name} 没有可采样的书页空白位置`);
      const actual = JSON.parse(
        execFileSync(
          "python",
          [
            "-c",
            `from PIL import Image\nim=Image.open(${JSON.stringify(imagePath)})\nprint(list(im.getpixel((${point.x},${point.y})))[:3])`,
          ],
          { encoding: "utf8" },
        ).trim(),
      );
      const rgb = tinycolor(expectedReaderBg).toRgb();
      const expected = [rgb.r, rgb.g, rgb.b];
      const order = (rgb) =>
        rgb
          .map((value, index) => ({ value, index }))
          .sort((a, b) => a.value - b.value)
          .map((item) => item.index)
          .join(",");
      const expectedChroma = Math.max(...expected) - Math.min(...expected);
      const actualChroma = Math.max(...actual) - Math.min(...actual);
      check(
        `${name} 透明窗口中的书页保留主题色相而非灰色`,
        order(actual) === order(expected) && actualChroma >= expectedChroma * 0.5,
        JSON.stringify({
          expected,
          actual,
          point,
          compositing: "transparent + Mica 窗口会与桌面混合；CSS 变量已另行精确断言",
        }),
      );
    }
  }
} catch (error) {
  check("主题与默认背景验收执行异常", false, error instanceof Error ? error.stack : String(error));
} finally {
  await evaluate(`(async () => {
    const previous = ${JSON.stringify(previous ?? {})};
    if (previous.theme) {
      const store = (await import(${JSON.stringify(themeModuleUrl)})).useThemeStore;
      await store.getState().setGlobalTheme(previous.theme.globalTheme);
      store.setState(previous.theme);
    }
    if (previous.layout) (await import("/src/store/layout-store.ts")).useLayoutStore.setState(previous.layout);
    window.__readerColorProbe?.restore?.();
    delete window.__readerRendererCandidate;
    return true;
  })()`).catch(() => {});
  ws.close();
}
writeFileSync(`${outDir}/report.json`, JSON.stringify({ checks }, null, 2));
if (checks.some((item) => !item.pass)) process.exit(1);
console.log(`${checks.length}/${checks.length} PASS`);
