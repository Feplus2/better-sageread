import { mkdirSync, writeFileSync } from "node:fs";

const cdpPort = process.env.CDP_PORT ?? "9224";
const appPort = process.env.APP_PORT ?? "1421";
const rounds = Number(process.env.BOUNDARY_ROUNDS ?? 3);
const outFile = process.env.VERIFY_OUT ?? ".superpowers/sdd/2026-11-06-user-acceptance-followup/stream-boundaries.json";
mkdirSync(new URL(`file://${process.cwd().replace(/\\/g, "/")}/${outFile.split("/").slice(0, -1).join("/")}/`), {
  recursive: true,
});
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
    }, 90000);
    pending.set(id, (message) => {
      clearTimeout(timer);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolve(message);
    });
    ws.send(JSON.stringify({ id, method, params }));
  });
await call("Runtime.enable");
const response = await call("Runtime.evaluate", {
  expression: `(async () => {
    const hook = await import("/src/hooks/use-stream-reveal.ts?boundaries=" + Date.now());
    const message = await import("/src/components/prompt-kit/message.tsx");
    const settings = (await import("/src/store/app-settings-store.ts")).useAppSettingsStore;
    const resources = performance.getEntriesByType("resource").map((entry) => entry.name);
    const reactModule = await import(resources.filter((name) => name.includes("deps/react.js")).at(-1));
    const domModule = await import(resources.filter((name) => name.includes("deps/react-dom_client.js")).at(-1));
    const React = reactModule.default ?? reactModule;
    const createRoot = (domModule.default ?? domModule).createRoot;
    const previous = settings.getState().settings;
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    settings.getState().setSettings({ ...previous, streamReveal: "mist", motionMode: "full" });
    const textNodes = (root) => {
      const nodes = [];
      const walk = (node) => {
        if (node.nodeType === Node.TEXT_NODE) {
          if (/\\S/.test(node.data)) nodes.push(node);
          return;
        }
        for (const child of node.childNodes) walk(child);
      };
      walk(root);
      return nodes;
    };
    const coverage = (root) => {
      if (!CSS.highlights) return { first: false, last: false, wetNames: [] };
      const wetNames = Array.from(CSS.highlights.keys()).filter((name) => name.startsWith("rv-mw"));
      const ranges = wetNames.flatMap((name) => Array.from(CSS.highlights.get(name) ?? []));
      const nodes = textNodes(root);
      const covered = (node, offset) => ranges.some((range) => {
        try { return range.isPointInRange(node, offset); } catch { return false; }
      });
      return {
        first: nodes.length > 0 && covered(nodes[0], nodes[0].data.search(/\\S/)),
        last: nodes.length > 0 && covered(nodes.at(-1), nodes.at(-1).data.length - 1),
        wetNames,
      };
    };
    const results = [];
    const warnings = [];
    const nativeWarn = console.warn;
    console.warn = (...args) => {
      warnings.push(args.map(String).join(" "));
      nativeWarn(...args);
    };
    try {
      for (let round = 0; round < ${rounds}; round += 1) {
        const host = document.createElement("div");
        host.style.cssText = "position:fixed;inset:40px;z-index:99999;overflow:auto;background:var(--background);color:var(--foreground);padding:24px;font-size:16px;line-height:1.8";
        document.body.appendChild(host);
        const root = createRoot(host);
        const Harness = ({ text, streaming }) => {
          const { wrapRef, display } = hook.useStreamReveal(text, streaming, true);
          return React.createElement("div", { ref: wrapRef }, React.createElement(message.MessageContent, { markdown: true }, display));
        };
        const render = (text, streaming) => root.render(React.createElement(Harness, { text, streaming }));
        const text = "开头这段文字必须先染上主题色，接着是跨批次内容。中间分批到达的句子逐段接续，最后这句也要先染色再恢复正文。";
        const lengths = [5, 13, 2, 17, 4, 7, 1, 22, 8, 3, 14];
        const delays = [140, 50, 210, 40, 180, 80, 230, 60, 120, 40, 150];
        let cursor = 0;
        render("", true);
        await sleep(60);
        let firstWet = false;
        let lastWet = false;
        const misses = [];
        for (let index = 0; index < lengths.length; index += 1) {
          cursor += lengths[index];
          render(text.slice(0, cursor), true);
          await sleep(delays[(index + round) % delays.length]);
          const current = coverage(host);
          firstWet ||= current.first;
          lastWet ||= current.last;
          if (index === 0 && !current.first) misses.push({ stage: "first", current });
          if (index === lengths.length - 1 && !current.last) misses.push({ stage: "last", current });
        }
        render(text, false);
        for (let index = 0; index < 30; index += 1) {
          await sleep(50);
          const current = coverage(host);
          firstWet ||= current.first;
          lastWet ||= current.last;
        }
        const finalCoverage = coverage(host);
        const cleaned = Array.from(CSS.highlights?.keys() ?? []).filter((name) => name.startsWith("rv-m")).length === 0 && document.querySelectorAll("style[data-rv-highlights]").length === 0;
        results.push({ round, firstWet, lastWet, cleaned, complete: host.textContent === text, misses, finalCoverage, warnings: [...warnings] });
        root.unmount();
        await sleep(40);
        host.remove();
      }
      {
        const host = document.createElement("div");
        host.style.cssText = "position:fixed;inset:40px;z-index:99999;overflow:auto;background:var(--background);color:var(--foreground);padding:24px;font-size:16px;line-height:1.8";
        document.body.appendChild(host);
        const root = createRoot(host);
        const Harness = ({ text, streaming }) => {
          const { wrapRef, display } = hook.useStreamReveal(text, streaming, true);
          return React.createElement("div", { ref: wrapRef }, React.createElement(message.MessageContent, { markdown: true }, display));
        };
        const text = "雨后傍晚，云层先松了口，铅灰的天裂开几道浅浅的橘色，慢慢洇成大片淡紫与湿润的蓝。树叶还挂着水，风一来便洒下一阵细小的雨。路灯逐盏亮起，杆子上的水珠先是一点白，接着被暖光染成细小而柔软的金色。";
        const render = (next, streaming) => root.render(React.createElement(Harness, { text: next, streaming }));
        const trace = (label) => {
          const wrap = host.firstElementChild;
          let fiber = wrap?.[Object.keys(wrap ?? {}).find((key) => key.startsWith("__reactFiber$"))];
          let state = null;
          while (fiber && !state) {
            let link = fiber.memoizedState;
            while (link) {
              if (link.memoizedState?.current?.hlHeld !== undefined) {
                state = link.memoizedState.current;
                break;
              }
              link = link.next;
            }
            fiber = fiber.return;
          }
          return {
            label,
            coverage: coverage(host),
            text: host.textContent,
            state: state ? { text: state.text, shown: state.shown, disp: state.disp, edge: state.edge, sweep: state.sweep, crossEnd: state.crossEnd, domLength: state.domLength, sourceLength: state.sourceLength, finished: state.finished, cross: state.cross, tail: state.tailNodes.slice(0, 3).map((node) => node.data) } : null,
            ranges: Array.from(CSS.highlights?.entries() ?? []).filter(([name]) => name.startsWith("rv-m")).map(([name, highlight]) => ({ name, text: Array.from(highlight).map((range) => range.toString()).join("") })).filter((entry) => entry.text),
          };
        };
        const traces = [];
        render(text.slice(0, 64), true);
        let firstWet = false;
        let lastWet = false;
        for (let index = 0; index < 12; index += 1) {
          await sleep(60);
          const current = coverage(host);
          firstWet ||= current.first;
          lastWet ||= current.last;
          if (index === 0 || index === 11) traces.push(trace("initial-" + index));
        }
        render(text, false);
        for (let index = 0; index < 50; index += 1) {
          await sleep(50);
          const current = coverage(host);
          firstWet ||= current.first;
          lastWet ||= current.last;
          if (index < 4 || index % 10 === 0) traces.push(trace("appended-" + index));
        }
        const cleaned = Array.from(CSS.highlights?.keys() ?? []).filter((name) => name.startsWith("rv-m")).length === 0 && document.querySelectorAll("style[data-rv-highlights]").length === 0;
        results.push({ case: "mount-with-first-received-batch", firstWet, lastWet, cleaned, complete: host.textContent === text, traces });
        root.unmount();
        await sleep(40);
        host.remove();
      }
    } finally {
      console.warn = nativeWarn;
      settings.getState().setSettings(previous);
    }
    return results;
  })()`,
  awaitPromise: true,
  returnByValue: true,
});
const result = response.result?.exceptionDetails
  ? { error: response.result.exceptionDetails.exception?.description ?? response.result.exceptionDetails.text }
  : response.result?.result?.value;
writeFileSync(outFile, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result?.map?.(({ traces, ...item }) => item) ?? result, null, 2));
ws.close();
if (!Array.isArray(result) || result.some((item) => !item.firstWet || !item.lastWet || !item.cleaned || !item.complete))
  process.exit(1);
console.log("PASS 多批次中文首尾着色与最终清理");
