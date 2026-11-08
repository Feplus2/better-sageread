import { mkdirSync, writeFileSync } from "node:fs";

const cdpPort = process.env.CDP_PORT ?? "9224";
const appPort = process.env.APP_PORT ?? "1421";
const outDir = process.env.PIXEL_OUT ?? ".superpowers/sdd/devil-dinosaur-aquaman-riri-williams/stream-reveal-pixels";
mkdirSync(outDir, { recursive: true });
const pages = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
const page = pages.find((target) => target.type === "page" && target.url?.includes(`localhost:${appPort}`));
if (!page) throw new Error("找不到隔离 SageRead 页面");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});
let seq = 0;
const pending = new Map();
const exceptions = [];
ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    pending.get(message.id)(message);
    pending.delete(message.id);
  }
  if (message.method === "Runtime.exceptionThrown") exceptions.push(message.params.exceptionDetails);
};
const call = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP 超时：${method}`));
    }, 30000);
    pending.set(id, (message) => {
      clearTimeout(timer);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolve(message);
    });
    ws.send(JSON.stringify({ id, method, params }));
  });
await call("Runtime.enable");
await call("Page.enable");
await call("Emulation.setDeviceMetricsOverride", { width: 1000, height: 800, deviceScaleFactor: 1, mobile: false });
const evalJs = async (expression) => {
  const result = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.result?.exceptionDetails)
    throw new Error(result.result.exceptionDetails.exception?.description ?? result.result.exceptionDetails.text);
  return result.result?.result?.value;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const scenes = [];
const errors = [];
let report;
async function capture(kind, label) {
  let scene;
  for (let i = 0; i < 25; i++) {
    scene = await evalJs(
      `window.__streamPixelFixture?.prepare(${JSON.stringify(label)}, ${JSON.stringify(kind)}) ?? null`,
    );
    if (scene && (kind !== "wet" || scene.covered)) break;
    await sleep(40);
  }
  if (!scene) throw new Error(`找不到可见目标：${kind}/${label}`);
  const file = `${kind}-${label}.png`;
  const shot = await call("Page.captureScreenshot", { format: "png", clip: scene.clip });
  writeFileSync(`${outDir}/${file}`, Buffer.from(shot.result.data, "base64"));
  scenes.push({ ...scene, kind, file });
}
try {
  await evalJs(`(async () => {
    const hookModule = await import("/src/hooks/use-stream-reveal.ts?pixel=" + Date.now());
    const messageModule = await import("/src/components/prompt-kit/message.tsx");
    const settingsStore = (await import("/src/store/app-settings-store.ts")).useAppSettingsStore;
    const hookSource = await (await fetch("/src/hooks/use-stream-reveal.ts")).text();
    const mainSource = await (await fetch("/src/main.tsx")).text();
    const moduleUrl = (source, marker) => {
      const start = source.indexOf('"' + marker);
      if (start < 0) throw new Error("找不到模块 " + marker);
      const end = source.indexOf('"', start + 1);
      return source.slice(start + 1, end);
    };
    const reactMod = await import(moduleUrl(hookSource, "/node_modules/.vite/deps/react.js"));
    const domMod = await import(moduleUrl(mainSource, "/node_modules/.vite/deps/react-dom_client.js"));
    const React = reactMod.default ?? reactMod;
    const createRoot = (domMod.default ?? domMod).createRoot;
    const previousSettings = settingsStore.getState().settings;
    const previousPrimary = document.documentElement.style.getPropertyValue("--primary");
    const host = document.createElement("div");
    const root = createRoot(host);
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      root.unmount();
      host.remove();
      if (previousPrimary) document.documentElement.style.setProperty("--primary", previousPrimary);
      else document.documentElement.style.removeProperty("--primary");
      settingsStore.getState().setSettings(previousSettings);
    };
    function Harness({ text, streaming }) {
      const { wrapRef, display } = hookModule.useStreamReveal(text, streaming, true);
      return React.createElement("div", { ref: wrapRef }, React.createElement(messageModule.MessageContent, { markdown: true }, display));
    }
    const render = (text, streaming) => root.render(React.createElement(Harness, { text, streaming }));
    const markers = { first: "第一段开头", middle: "中段水迹标记", last: "末尾🙂" };
    const state = () => {
      const wrap = host.firstElementChild;
      return {
        complete: host.textContent.includes(markers.first) && host.textContent.includes(markers.middle) && host.textContent.includes(markers.last) && host.textContent.includes("👨‍👩‍👧‍👦"),
        highlightNames: CSS.highlights ? Array.from(CSS.highlights.keys()).filter((name) => name.startsWith("rv-m")).length : 0,
        accent: wrap?.style.getPropertyValue("--rv-accent") ?? "",
        foreground: wrap?.style.getPropertyValue("--rv-fg") ?? "",
      };
    };
    const prepare = async (label, kind) => {
      const marker = markers[label];
      if (!marker) throw new Error("未知目标 " + label);
      const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
      let range = null;
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const index = node.data.indexOf(marker);
        if (index < 0) continue;
        range = document.createRange();
        range.setStart(node, index);
        range.setEnd(node, index + marker.length);
        break;
      }
      if (!range) return null;
      let rect = range.getBoundingClientRect();
      const hostRect = host.getBoundingClientRect();
      const desired = host.scrollTop + rect.top - (hostRect.top + host.clientHeight / 2);
      host.scrollTop = Math.max(0, Math.min(host.scrollHeight - host.clientHeight, desired));
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      rect = range.getBoundingClientRect();
      const visible = {
        left: hostRect.left + host.clientLeft,
        top: hostRect.top + host.clientTop,
        right: hostRect.left + host.clientLeft + host.clientWidth,
        bottom: hostRect.top + host.clientTop + host.clientHeight,
      };
      const left = Math.max(0, visible.left, Math.floor(rect.left) - 6);
      const top = Math.max(0, visible.top, Math.floor(rect.top) - 6);
      const right = Math.min(window.innerWidth, visible.right, Math.ceil(rect.right) + 6);
      const bottom = Math.min(window.innerHeight, visible.bottom, Math.ceil(rect.bottom) + 6);
      if (right <= left || bottom <= top) throw new Error("目标截图区域不可见：" + label + " " + JSON.stringify({ rect: rect.toJSON(), visible, scrollTop: host.scrollTop, scrollHeight: host.scrollHeight }));
      const covered = kind === "wet" && CSS.highlights && Array.from(CSS.highlights.entries()).some(([name, highlight]) => {
        if (name === "rv-mf0-0") return false;
        return Array.from(highlight).some((candidate) =>
          candidate.compareBoundaryPoints(Range.START_TO_START, range) <= 0 &&
          candidate.compareBoundaryPoints(Range.END_TO_END, range) >= 0
        );
      });
      const ancestors = [];
      for (let element = range.startContainer.parentElement; element && element !== host; element = element.parentElement) {
        const style = getComputedStyle(element);
        ancestors.push({ tag: element.tagName, className: String(element.className).slice(0, 180), color: style.color, transition: style.transition });
      }
      return {
        key: kind + ":" + label,
        label,
        text: range.toString(),
        covered: Boolean(covered),
        clip: { x: left, y: top, width: right - left, height: bottom - top, scale: 1 },
        computedColor: getComputedStyle(range.startContainer.parentElement).color,
        ancestors,
        registeredHighlights: CSS.highlights ? Array.from(CSS.highlights.keys()) : [],
        scrollTop: host.scrollTop,
        scrollHeight: host.scrollHeight,
        state: state(),
      };
    };
    window.__streamPixelFixture = { render, prepare, state, cleanup };
    try {
      settingsStore.getState().setSettings({ ...previousSettings, streamReveal: "mist", motionMode: "full" });
      document.documentElement.style.setProperty("--primary", "#ff0000");
      host.style.cssText = "position:fixed;inset:20px;z-index:99999;overflow:auto;background:#ffffff;color:#202020;padding:24px;font-size:16px;line-height:1.8;--foreground:#202020;--background:#ffffff;--secondary:#ffffff;";
      document.body.appendChild(host);
      render("", true);
      await new Promise((resolve) => setTimeout(resolve, 60));
    } catch (error) {
      cleanup();
      throw error;
    }
  })()`);
  const prefix = "第一段开头**加粗**与[链接文字](https://example.com)👨‍👩‍👧‍👦🇨🇳é";
  const firstHalf = "长文".repeat(900);
  const middle = "中段水迹标记";
  const last = "末尾🙂";
  for (const [label, text] of [
    ["first", prefix],
    ["middle", prefix + firstHalf + middle],
    ["last", prefix + firstHalf + middle + firstHalf + last],
  ]) {
    await evalJs(`window.__streamPixelFixture.render(${JSON.stringify(text)}, true); true`);
    await capture("wet", label);
  }
  await evalJs(
    `window.__streamPixelFixture.render(${JSON.stringify(prefix + firstHalf + middle + firstHalf + last)}, false); true`,
  );
  for (let i = 0; i < 100; i++) {
    const state = await evalJs("window.__streamPixelFixture.state()");
    if (state.complete && state.highlightNames === 0 && !state.accent && !state.foreground) break;
    await sleep(60);
  }
  for (const label of ["first", "middle", "last"]) await capture("dry", label);
  await sleep(500);
  for (const label of ["first", "middle", "last"]) await capture("dry-settled", label);
  report = await evalJs("window.__streamPixelFixture.state()");
  if (process.env.PIXEL_HOLD_MS) {
    await evalJs("window.__streamPixelCaptureComplete = true; true");
    await sleep(Number(process.env.PIXEL_HOLD_MS));
  }
} catch (error) {
  errors.push(String(error?.stack ?? error));
} finally {
  await evalJs(
    "window.__streamPixelFixture?.cleanup(); delete window.__streamPixelFixture; delete window.__streamPixelCaptureComplete; true",
  ).catch(() => {});
  await call("Emulation.clearDeviceMetricsOverride").catch(() => {});
  ws.close();
}
writeFileSync(`${outDir}/pixel-scenes.json`, JSON.stringify({ report, scenes, errors, exceptions }, null, 2));
console.log(
  JSON.stringify(
    {
      report,
      scenes: scenes.map(({ kind, label, covered, computedColor, clip, file }) => ({
        kind,
        label,
        covered,
        computedColor,
        clip,
        file,
      })),
      errors,
    },
    null,
    2,
  ),
);
if (
  errors.length ||
  exceptions.length ||
  !report?.complete ||
  report.highlightNames !== 0 ||
  report.accent ||
  report.foreground
)
  process.exit(1);
