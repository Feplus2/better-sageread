import { mkdirSync, writeFileSync } from "node:fs";

const cdpPort = process.env.CDP_PORT ?? "9224";
const appPort = process.env.APP_PORT ?? "1421";
const outFile = process.env.VERIFY_OUT ?? ".tmp-agent-followup/stream-reveal-verify.json";
const pages = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
const page = pages.find((target) => target.type === "page" && target.url?.includes(`localhost:${appPort}`));
if (!page) throw new Error(`找不到 SageRead 页面（${cdpPort}/${appPort}）`);
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});
let seq = 0;
const pending = new Map();
const exceptions = [];
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
  if (msg.method === "Runtime.exceptionThrown") exceptions.push(msg.params.exceptionDetails);
};
const call = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP 超时: ${method}`));
    }, 120000);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
    ws.send(JSON.stringify({ id, method, params }));
  });
await call("Runtime.enable");
await call("Page.enable");
const result = await call("Runtime.evaluate", {
  expression: `
(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const hookModule = await import("/src/hooks/use-stream-reveal.ts?verify=" + Date.now());
  const messageModule = await import("/src/components/prompt-kit/message.tsx");
  const settingsModule = await import("/src/store/app-settings-store.ts");
  const names = performance.getEntriesByType("resource").map((entry) => entry.name);
  const reactMod = await import(names.filter((name) => name.includes("deps/react.js")).at(-1));
  const domMod = await import(names.filter((name) => name.includes("deps/react-dom_client.js")).at(-1));
  const React = reactMod.default ?? reactMod;
  const createRoot = (domMod.default ?? domMod).createRoot;
  const settingsStore = settingsModule.useAppSettingsStore;
  const exceptions = [];
  const onRuntimeError = (event) => exceptions.push({ text: String(event.error ?? event.reason ?? event.message) });
  window.addEventListener("error", onRuntimeError);
  window.addEventListener("unhandledrejection", onRuntimeError);
  const previousSettings = settingsStore.getState().settings;
  settingsStore.getState().setSettings({ ...previousSettings, streamReveal: "mist", motionMode: "full" });

  const nativeRaf = window.requestAnimationFrame.bind(window);
  const nativeCancel = window.cancelAnimationFrame.bind(window);
  const pendingLoops = new Set();
  window.requestAnimationFrame = (callback) => {
    let id = 0;
    const wrapped = (time) => {
      pendingLoops.delete(id);
      callback(time);
    };
    id = nativeRaf(wrapped);
    if (callback.name === "loop") pendingLoops.add(id);
    return id;
  };
  window.cancelAnimationFrame = (id) => {
    pendingLoops.delete(id);
    nativeCancel(id);
  };
  const NativeObserver = window.MutationObserver;
  let observerBalance = 0;
  window.MutationObserver = class extends NativeObserver {
    constructor(callback) {
      super(callback);
      const source = String(callback);
      this.streamReveal = source.includes("indexDirty") || source.includes("setupMistVars");
      this.observing = false;
    }
    observe(...args) {
      if (this.streamReveal && !this.observing) {
        this.observing = true;
        observerBalance++;
      }
      return super.observe(...args);
    }
    disconnect() {
      if (this.streamReveal && this.observing) {
        this.observing = false;
        observerBalance--;
      }
      return super.disconnect();
    }
  };
  const initialLoops = pendingLoops.size;
  const results = [];
  const mistNames = () => CSS.highlights ? Array.from(CSS.highlights.keys()).filter((name) => name.startsWith("rv-m")) : [];
  const mistRanges = () => {
    if (!CSS.highlights) return [];
    return mistNames().flatMap((name) => Array.from(CSS.highlights.get(name) ?? []));
  };
  const graphemeOffsets = (text) => {
    if (typeof Intl.Segmenter !== "function") return new Set(Array.from({ length: text.length + 1 }, (_, i) => i));
    const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    const offsets = new Set();
    for (const item of segmenter.segment(text)) offsets.add(item.index);
    offsets.add(text.length);
    return offsets;
  };
  const textNodes = (root) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => node.parentElement?.closest("[data-rv-overlay]") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
    });
    const nodes = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) if (/\\S/.test(node.data)) nodes.push(node);
    return nodes;
  };
  const firstLastCovered = (root) => {
    const nodes = textNodes(root);
    if (!nodes.length) return { first: false, last: false, boundariesValid: true };
    const ranges = mistRanges();
    const visibleRanges = mistNames()
      .filter((name) => name !== "rv-mf0-0")
      .flatMap((name) => Array.from(CSS.highlights.get(name) ?? []));
    const firstNode = nodes[0];
    const lastNode = nodes.at(-1);
    const firstOffset = firstNode.data.search(/\\S/);
    const lastOffset = lastNode.data.length - 1 - (lastNode.data.match(/\\s*$/)[0].length);
    const covered = (node, offset) => visibleRanges.some((range) => {
      try { return range.isPointInRange(node, offset); } catch { return false; }
    });
    const boundariesValid = ranges.every((range) => {
      const startOffsets = graphemeOffsets(range.startContainer.data ?? "");
      const endOffsets = graphemeOffsets(range.endContainer.data ?? "");
      return startOffsets.has(range.startOffset) && endOffsets.has(range.endOffset);
    });
    return { first: covered(firstNode, firstOffset), last: covered(lastNode, lastOffset), boundariesValid };
  };
  const snapshot = (host) => ({
    text: host.textContent,
    names: mistNames().length,
    ranges: mistRanges().length,
    styles: document.querySelectorAll("style[data-rv-highlights]").length,
    loops: Math.max(0, pendingLoops.size - initialLoops),
    observers: observerBalance,
    accent: host.style.getPropertyValue("--rv-accent"),
    fg: host.style.getPropertyValue("--rv-fg"),
    coverage: CSS.highlights ? firstLastCovered(host) : null,
  });

  function Harness({ text, streaming, enabled = true }) {
    const { wrapRef, display } = hookModule.useStreamReveal(text, streaming, enabled);
    return React.createElement("div", { ref: wrapRef, "data-testid": "stream-harness" },
      React.createElement(messageModule.MessageContent, { markdown: true }, display));
  }

  async function mount() {
    const host = document.createElement("div");
    host.style.cssText = "position:fixed;inset:40px;z-index:99999;overflow:auto;background:var(--background,#fff);color:var(--foreground,#222);padding:24px;font-size:16px;line-height:1.8;";
    document.body.appendChild(host);
    const root = createRoot(host);
    const render = (text, streaming, enabled = true) => {
      root.render(React.createElement(Harness, { text, streaming, enabled }));
    };
    render("", true);
    await sleep(60);
    return {
      host,
      root,
      render,
      async unmount() {
        root.unmount();
        await sleep(60);
        host.remove();
      },
    };
  }

  async function scenario(name, run) {
    const startedExceptions = exceptions.length;
    try {
      const detail = await run();
      results.push({ name, pass: detail.pass !== false, ...detail });
    } catch (error) {
      results.push({ name, pass: false, error: String(error?.stack ?? error) });
    }
    if (exceptions.length > startedExceptions) {
      results.at(-1).pass = false;
      results.at(-1).exceptions = exceptions.slice(startedExceptions).map((item) => item.exception?.description ?? item.text);
    }
  }

  await scenario("quiet-and-final-cleanup", async () => {
    const view = await mount();
    const text = "这是一段用于验证暂停收尾和最终清理的文字。";
    view.render(text, true);
    await sleep(4500);
    const quiet = snapshot(view.host);
    view.render(text + "新到达的内容继续揭示。", true);
    await sleep(150);
    const resumed = snapshot(view.host);
    view.render(text + "新到达的内容继续揭示。", false);
    await sleep(3600);
    const finished = snapshot(view.host);
    const unmountedLoops = pendingLoops.size - initialLoops;
    await view.unmount();
    return {
      pass: quiet.names === 0 && quiet.ranges === 0 && quiet.styles === 0 && quiet.loops === 0 && quiet.observers === 0 && !quiet.accent && !quiet.fg && resumed.text.includes("新到达") && finished.names === 0 && finished.ranges === 0 && finished.styles === 0 && finished.loops === 0 && finished.observers === 0 && !finished.accent && !finished.fg && unmountedLoops === 0,
      quiet,
      resumed,
      finished,
      unmountedLoops,
    };
  });

  await scenario("long-markdown-emoji-coverage", async () => {
    const view = await mount();
    const text = "**开头加粗**与[链接文字](https://example.com)👨‍👩‍👧‍👦🇨🇳é" + "长文".repeat(900) + "末尾🙂";
    view.render(text, true);
    let firstEver = false;
    let lastEver = false;
    let coverageAt600 = null;
    let boundariesValid = true;
    let firstAt = -1;
    let lastAt = -1;
    const started = performance.now();
    for (let i = 0; i < 70; i++) {
      await sleep(50);
      const coverage = firstLastCovered(view.host);
      if (i === 11) coverageAt600 = { ...coverage };
      firstEver ||= coverage.first;
      lastEver ||= coverage.last;
      if (coverage.first && firstAt < 0) firstAt = performance.now() - started;
      if (coverage.last && lastAt < 0) lastAt = performance.now() - started;
      boundariesValid &&= coverage.boundariesValid;
    }
    view.render(text, false);
    await sleep(3600);
    const finished = snapshot(view.host);
    const contentComplete = view.host.textContent.includes("开头加粗") && view.host.textContent.includes("链接文字") && view.host.textContent.includes("👨‍👩‍👧‍👦") && view.host.textContent.includes("末尾🙂");
    await view.unmount();
    return {
      pass: firstEver && lastEver && coverageAt600?.first && boundariesValid && firstAt >= 0 && lastAt >= 0 && firstAt <= lastAt && contentComplete && finished.names === 0 && finished.loops === 0,
      firstEver,
      lastEver,
      coverageAt600,
      firstAt,
      lastAt,
      boundariesValid,
      contentComplete,
      finished,
    };
  });

  await scenario("markdown-source-dom-order", async () => {
    const view = await mount();
    const text = "[开头](u)" + "中间".repeat(40) + "末尾";
    view.render(text, true);
    let firstAt = -1;
    let lastAt = -1;
    const started = performance.now();
    for (let i = 0; i < 50; i++) {
      await sleep(40);
      const coverage = firstLastCovered(view.host);
      if (coverage.first && firstAt < 0) firstAt = performance.now() - started;
      if (coverage.last && lastAt < 0) lastAt = performance.now() - started;
    }
    view.render(text, false);
    await sleep(3600);
    const finished = snapshot(view.host);
    const contentComplete = view.host.textContent.includes("开头") && view.host.textContent.includes("中间".repeat(40)) && view.host.textContent.includes("末尾");
    await view.unmount();
    return {
      pass: firstAt >= 0 && lastAt >= 0 && firstAt * 3 <= lastAt && contentComplete && finished.names === 0 && finished.loops === 0,
      firstAt,
      lastAt,
      contentComplete,
      finished,
    };
  });

  await scenario("async-markdown-dom-mutation", async () => {
    const view = await mount();
    const text = "~~~ts\\nconst answer = 42;\\n~~~\\n末尾";
    view.render(text, true);
    let firstEver = false;
    let lastEver = false;
    let activeObservers = 0;
    for (let i = 0; i < 40; i++) {
      await sleep(50);
      const coverage = firstLastCovered(view.host);
      firstEver ||= coverage.first;
      lastEver ||= coverage.last;
      activeObservers = Math.max(activeObservers, observerBalance);
    }
    view.render(text, false);
    await sleep(3600);
    const finished = snapshot(view.host);
    await view.unmount();
    return {
      pass: firstEver && lastEver && activeObservers > 0 && finished.names === 0 && finished.loops === 0 && finished.observers === 0,
      firstEver,
      lastEver,
      activeObservers,
      finished,
    };
  });

  await scenario("highlight-registration-exception", async () => {
    const originalSet = CSS.highlights.set;
    let thrown = false;
    CSS.highlights.set = function (name, highlight) {
      if (!thrown) {
        thrown = true;
        throw new Error("probe Highlight registration failure");
      }
      return originalSet.call(this, name, highlight);
    };
    try {
      const view = await mount();
      const text = "Highlight 注册异常时也必须完整显示正文".repeat(10);
      view.render(text, true);
      await sleep(200);
      view.render(text, false);
      await sleep(3600);
      const finished = snapshot(view.host);
      await view.unmount();
      return {
        pass: finished.text.includes("完整显示正文") && finished.names === 0 && finished.loops === 0 && finished.observers === 0,
        finished,
      };
    } finally {
      CSS.highlights.set = originalSet;
    }
  });

  await scenario("sustained-slow-frames-degrade", async () => {
    const fastRaf = window.requestAnimationFrame;
    window.requestAnimationFrame = (callback) => fastRaf(() => setTimeout(() => callback(performance.now()), 90));
    try {
      const view = await mount();
      const text = "低性能 WebView 连续慢帧后仍保留完整正文".repeat(20);
      view.render(text, true);
      await sleep(1600);
      const degraded = snapshot(view.host);
      view.render(text, false);
      await sleep(1800);
      const finished = snapshot(view.host);
      await view.unmount();
      return {
        pass: degraded.names === 0 && degraded.ranges === 0 && degraded.observers === 0 && degraded.text.includes("完整正文") && finished.names === 0 && finished.loops === 0,
        degraded,
        finished,
      };
    } finally {
      window.requestAnimationFrame = fastRaf;
    }
  });

  await scenario("switch-unmount-and-reduced-motion", async () => {
    const view = await mount();
    const text = "切换效果和卸载时必须清理的文本".repeat(30);
    view.render(text, true);
    await sleep(200);
    settingsStore.getState().setSettings({ ...settingsStore.getState().settings, streamReveal: "baseline" });
    await sleep(150);
    const switched = snapshot(view.host);
    settingsStore.getState().setSettings({ ...settingsStore.getState().settings, streamReveal: "mist" });
    view.render(text, true, false);
    await sleep(100);
    const reduced = snapshot(view.host);
    view.render(text, true, true);
    await sleep(150);
    await view.unmount();
    const unmounted = { names: mistNames().length, styles: document.querySelectorAll("style[data-rv-highlights]").length, loops: pendingLoops.size - initialLoops, observers: observerBalance };
    return {
      pass: switched.names === 0 && switched.loops === 0 && reduced.names === 0 && reduced.loops === 0 && reduced.text.includes("切换效果") && unmounted.names === 0 && unmounted.styles === 0 && unmounted.loops === 0 && unmounted.observers === 0,
      switched,
      reduced,
      unmounted,
    };
  });

  await scenario("highlight-api-unsupported", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(CSS, "highlights");
    Object.defineProperty(CSS, "highlights", { value: undefined, configurable: true });
    const view = await mount();
    const text = "不支持 Highlight API 时正文仍完整".repeat(20);
    view.render(text, true);
    await sleep(250);
    view.render(text, false);
    await sleep(1200);
    const finished = snapshot(view.host);
    await view.unmount();
    if (descriptor) Object.defineProperty(CSS, "highlights", descriptor);
    else delete CSS.highlights;
    return { pass: finished.text.includes("不支持 Highlight API") && finished.loops === 0 && finished.observers === 0, finished };
  });

  window.requestAnimationFrame = nativeRaf;
  window.cancelAnimationFrame = nativeCancel;
  window.MutationObserver = NativeObserver;
  window.removeEventListener("error", onRuntimeError);
  window.removeEventListener("unhandledrejection", onRuntimeError);
  settingsStore.getState().setSettings(previousSettings);
  return results;
})()
`,
  awaitPromise: true,
  returnByValue: true,
});
const report = result.result?.exceptionDetails
  ? { error: result.result.exceptionDetails.exception?.description ?? result.result.exceptionDetails.text }
  : {
      results: result.result?.result?.value,
      exceptions: exceptions.map((item) => item.exception?.description ?? item.text).filter(Boolean),
    };
mkdirSync(new URL(`file://${process.cwd().replace(/\\/g, "/")}/`), { recursive: true });
mkdirSync(new URL(`file://${process.cwd().replace(/\\/g, "/")}/${outFile.split("/").slice(0, -1).join("/")}/`), {
  recursive: true,
});
writeFileSync(outFile, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
ws.close();
if (!report.results || report.results.some((item) => !item.pass) || report.exceptions?.length) process.exit(1);
