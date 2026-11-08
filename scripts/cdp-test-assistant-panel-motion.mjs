import { mkdirSync, writeFileSync } from "node:fs";

const cdpPort = process.env.CDP_PORT ?? "9224";
const appPort = process.env.APP_PORT ?? "1421";
const outDir = process.env.VERIFY_OUT ?? ".superpowers/sdd/devil-dinosaur-aquaman-riri-williams/motion";
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
    }, 20000);
    pending.set(id, (message) => {
      clearTimeout(timer);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolve(message);
    });
    ws.send(JSON.stringify({ id, method, params }));
  });
await call("Runtime.enable");
const evalJs = async (expression) => {
  const response = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (response.result?.exceptionDetails)
    throw new Error(response.result.exceptionDetails.exception?.description ?? response.result.exceptionDetails.text);
  return response.result?.result?.value;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (expression, label) => {
  for (let i = 0; i < 100; i++) {
    if (await evalJs(`Boolean(${expression})`)) return;
    await sleep(50);
  }
  throw new Error(`等待超时：${label}`);
};
const checks = [];
const check = (name, pass, detail = "") => checks.push({ name, pass: !!pass, detail: String(detail) });
const evidence = {};
const selectors = {
  file: '[data-region="file-workspace"]',
  history: '[data-panel-side="left"]',
};
let previous;

function verifyFrames(frames, side, entering, mode) {
  const valid = frames.filter((frame) => frame.present && frame.width > 1);
  if (mode === "reduced" && !entering) {
    if (valid.some((frame) => Math.abs(frame.x) > 1)) throw new Error("reduced 退出仍有几何位移");
    return { frames: valid.length, peakPanelWidthsPerSecond: 0 };
  }
  if (valid.length < 2) throw new Error(`没有足够面板帧：${JSON.stringify(frames.slice(0, 6))}`);
  const xs = valid.map((frame) => frame.x);
  const width = Math.max(...valid.map((frame) => frame.width));
  const tolerance = 1;
  const min = side === "history" ? -width - tolerance : -tolerance;
  const max = side === "history" ? tolerance : width + tolerance;
  if (Math.min(...xs) < min || Math.max(...xs) > max)
    throw new Error(`几何越界：${JSON.stringify({ min: Math.min(...xs), max: Math.max(...xs), width })}`);
  if (mode !== "full") {
    if (xs.some((x) => Math.abs(x) > tolerance)) throw new Error(`${mode} 仍有几何位移`);
    if (mode === "fade-only" && Math.min(...valid.map((frame) => frame.opacity)) > 0.8)
      throw new Error("fade-only 没有真实淡入淡出");
    return { frames: valid.length, peakPanelWidthsPerSecond: 0 };
  }
  const travel = Math.abs(valid.at(-1).x - valid[0].x);
  if (travel < width * 0.75)
    throw new Error(`没有完整滑动：${JSON.stringify({ first: valid[0], last: valid.at(-1), width })}`);
  const expectedDirection = side === "history" ? (entering ? 1 : -1) : entering ? -1 : 1;
  const reversals = [];
  const intervals = [];
  for (let i = 1; i < valid.length; i++) {
    const delta = valid[i].x - valid[i - 1].x;
    if (Math.sign(delta) === -expectedDirection && Math.abs(delta) > tolerance)
      reversals.push({ before: valid[i - 1], after: valid[i] });
    const dt = valid[i].time - valid[i - 1].time;
    if (dt >= 1) intervals.push({ delta: Math.abs(delta), dt });
  }
  let peak = 0;
  // 用三个间隔评估持续速度，避免把一次渲染批处理误当成动画持续超速。
  for (let end = 0; end < intervals.length; end += 1) {
    if (intervals.length >= 3 && end < 2) continue;
    const window = intervals.slice(Math.max(0, end - 2), end + 1);
    const delta = window.reduce((sum, item) => sum + item.delta, 0);
    const dt = window.reduce((sum, item) => sum + item.dt, 0);
    peak = Math.max(peak, (delta / dt / width) * 1000);
  }
  if (reversals.length) throw new Error(`过冲/反向：${JSON.stringify(reversals[0])}`);
  if (peak > 11) throw new Error(`峰值速度过高：${peak.toFixed(2)} 面板宽/秒`);
  return { frames: valid.length, peakPanelWidthsPerSecond: peak };
}

async function record(side, entering, mode) {
  const frames = await evalJs(`(async () => {
    const frames = [];
    const selector = ${JSON.stringify(selectors[side])};
    if (${JSON.stringify(side)} === "history") {
      const existing = document.querySelector(selector);
      const isOpen = !!existing && !existing.closest("[inert]");
      if (${JSON.stringify(entering)} && isOpen) throw new Error("进入测量前历史面板未关闭");
      if (!${JSON.stringify(entering)} && !isOpen) throw new Error("退出测量前历史面板未打开");
    }
    const button = ${JSON.stringify(side)} === "history"
      ? document.querySelector("button:has(svg.lucide-history)")
      : document.querySelector(${JSON.stringify(entering ? '[aria-label="打开文件工作区"]' : '[aria-label="收起文件工作区，返回对话"]')});
    if (!button) throw new Error("找不到面板开关：" + ${JSON.stringify(`${side}/${entering}`)});
    const effectiveOpacity = (panel) => {
      let opacity = 1;
      for (let element = panel; element; element = element.parentElement) {
        opacity *= Number.parseFloat(getComputedStyle(element).opacity);
      }
      return opacity;
    };
    const start = performance.now();
    const recording = new Promise((resolve) => {
      const sample = (time) => {
        const panel = document.querySelector(selector);
        if (panel) {
          const rect = panel.getBoundingClientRect();
          const viewport = panel.closest("[data-panel-viewport], main") ?? panel.offsetParent;
          const base = viewport?.getBoundingClientRect();
          frames.push({ time, wallTime: performance.now(), present: true, x: rect.left - (base?.left ?? 0), width: rect.width, opacity: effectiveOpacity(panel) });
        }
        const fileToggle = document.querySelector('[aria-label="打开文件工作区"], [aria-label="收起文件工作区，返回对话"]');
        const toolbar = fileToggle?.closest(".relative.flex.h-10");
        const controls = Array.from(toolbar?.querySelectorAll("button") ?? []).filter((button) =>
          button === fileToggle || button.querySelector("svg.lucide-stretch-horizontal, svg.lucide-message-circle-plus")
        );
        for (const button of controls) {
          if (button.disabled) {
            window.__motionHitDisabledSamples = (window.__motionHitDisabledSamples ?? 0) + 1;
            continue;
          }
          const rect = button.getBoundingClientRect();
          const x = rect.left + rect.width / 2;
          const y = rect.top + rect.height / 2;
          const hit = document.elementFromPoint(x, y);
          if (!hit || (hit !== button && !button.contains(hit))) {
            window.__motionHitMisses.push({ side: ${JSON.stringify(side)}, entering: ${JSON.stringify(entering)}, mode: ${JSON.stringify(mode)}, button: button.getAttribute("aria-label") ?? button.textContent, disabled: button.disabled, inert: Boolean(button.closest("[inert]")), pointerEvents: getComputedStyle(button).pointerEvents, rect: rect.toJSON(), hit: hit?.outerHTML?.slice(0, 180) ?? null });
          }
        }
        if (!panel) {
          frames.push({ time, present: false });
        }
        if (time - start < 1500) requestAnimationFrame(sample);
        else resolve(frames);
      };
      requestAnimationFrame(sample);
    });
    button.click();
    return recording;
  })()`);
  evidence[`${mode}-${side}-${entering ? "enter" : "exit"}`] = frames;
  if (!entering)
    await waitFor(`!document.querySelector(${JSON.stringify(selectors[side])})`, `${mode} ${side} 退出后移除`);
  return verifyFrames(frames, side, entering, mode);
}

try {
  previous = await evalJs(`(async () => {
    const settings = (await import("/src/store/app-settings-store.ts")).useAppSettingsStore.getState().settings;
    const files = (await import("/src/store/file-workspace-store.ts")).useFileWorkspaceStore.getState();
    return { settings, hosts: files.hosts, recentRoots: files.recentRoots, input: document.querySelector("textarea")?.value ?? "" };
  })()`);
  await evalJs(`(async () => {
    (await import("/src/store/layout-store.ts")).useLayoutStore.getState().navigateToHome();
    (await import("/src/store/file-workspace-store.ts")).useFileWorkspaceStore.setState({ hosts: {} });
    location.hash = "#/chat";
    document.querySelector('[data-panel-viewport] [data-region="assistant-history-panel"] button:has(svg.lucide-arrow-left)')?.click();
    return true;
  })()`);
  await waitFor(
    `!document.querySelector('[data-panel-viewport] [data-region="assistant-history-panel"]')`,
    "历史面板初始关闭",
  );
  await waitFor(
    `(() => {
      const button = document.querySelector('[aria-label="打开文件工作区"]');
      return !!button && !button.closest("[inert]") && getComputedStyle(button).visibility === "visible";
    })()`,
    "可见的工作区入口",
  );
  await evalJs(`(() => {
    const textarea = document.querySelector("textarea");
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
    setter.call(textarea, "motion-draft-preserved");
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    window.__motionOriginalInput = textarea;
    window.__motionHitMisses = [];
    const toolbar = document.querySelector('[data-panel-viewport] button:has(svg.lucide-history)')?.closest(".relative.flex.h-10");
    window.__motionHeader = Array.from(toolbar?.querySelectorAll('button:has(svg.lucide-history), [aria-label="打开文件工作区"], button:has(svg.lucide-message-circle-plus)') ?? []).map((button) => ({ label: button.getAttribute("aria-label"), rect: button.getBoundingClientRect().toJSON() }));
  })()`);

  await evalJs(`document.querySelector('[aria-label="打开文件工作区"]').click(); true`);
  await waitFor(
    `document.querySelector('[data-region="file-workspace"]') && document.querySelector('[data-region="file-explorer"]')`,
    "文件面板首次内容加载完成",
  );
  await evalJs(`document.querySelector('[aria-label="收起文件工作区，返回对话"]').click(); true`);
  await waitFor(`!document.querySelector('[data-region="file-workspace"]')`, "文件面板预热后关闭");
  await evalJs(`document.querySelector('[data-panel-viewport] button:has(svg.lucide-history)').click(); true`);
  await waitFor(
    `(() => {
      const panel = document.querySelector('[data-panel-viewport] [data-region="assistant-history-panel"]');
      return panel && !panel.textContent.includes("加载中");
    })()`,
    "历史列表首次内容加载完成",
  );
  await evalJs(
    `document.querySelector('[data-panel-viewport] [data-region="assistant-history-panel"] button:has(svg.lucide-arrow-left)').click(); true`,
  );
  await waitFor(
    `!document.querySelector('[data-panel-viewport] [data-region="assistant-history-panel"]')`,
    "历史面板预热后关闭",
  );

  for (const mode of ["full", "fade-only", "reduced"]) {
    if (mode === "reduced") {
      await call("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
      await evalJs(`(async () => {
        const store = (await import("/src/store/app-settings-store.ts")).useAppSettingsStore.getState();
        store.setSettings({ ...store.settings, motionMode: "system" });
      })()`);
    } else {
      await evalJs(`(async () => {
        const store = (await import("/src/store/app-settings-store.ts")).useAppSettingsStore.getState();
        store.setSettings({ ...store.settings, motionMode: ${JSON.stringify(mode)} });
      })()`);
    }
    await waitFor(`document.documentElement.dataset.motion === ${JSON.stringify(mode)}`, `${mode} 动效档`);
    for (const side of ["file", "history"]) {
      try {
        const entering = await record(side, true, mode);
        const exiting = await record(side, false, mode);
        check(`${mode} ${side} 进入/退出无过冲、无反弹且速度有界`, true, JSON.stringify({ entering, exiting }));
      } catch (error) {
        check(
          `${mode} ${side} 进入/退出无过冲、无反弹且速度有界`,
          false,
          error instanceof Error ? error.stack : String(error),
        );
        await evalJs(`(async () => {
          (await import("/src/store/file-workspace-store.ts")).useFileWorkspaceStore.getState().closeWorkspace("central");
          const heading = Array.from(document.querySelectorAll("h2")).find((item) => item.textContent === "历史对话" && item.getBoundingClientRect().left >= 0);
          heading?.closest(".flex.h-full.flex-col")?.querySelector("button")?.click();
        })()`);
      }
    }
  }
  check(
    "切换后面板、草稿和输入 DOM 保留",
    await evalJs(
      `document.querySelector("textarea") === window.__motionOriginalInput && document.querySelector("textarea")?.value === "motion-draft-preserved"`,
    ),
  );
  const headerPositionMeasurement = await evalJs(`(() => {
    const toolbar = document.querySelector('[data-panel-viewport] button:has(svg.lucide-history)')?.closest(".relative.flex.h-10");
    const buttons = Array.from(toolbar?.querySelectorAll('button:has(svg.lucide-history), [aria-label="打开文件工作区"], button:has(svg.lucide-message-circle-plus)') ?? []);
    const current = buttons.map((button) => ({ label: button.getAttribute("aria-label"), rect: button.getBoundingClientRect().toJSON() }));
    const before = window.__motionHeader;
    return {
      pass: current.length === before.length && current.every((item, index) => Math.abs(item.rect.left - before[index].rect.left) < 1 && Math.abs(item.rect.top - before[index].rect.top) < 1),
      before,
      current,
    };
  })()`);
  check(
    "历史、工作区、新对话的既有位置不变",
    headerPositionMeasurement.pass,
    JSON.stringify(headerPositionMeasurement),
  );
  check(
    "关闭历史后其按钮可真实命中",
    await evalJs(`(() => {
      const button = document.querySelector("button:has(svg.lucide-history)");
      const rect = button.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return hit && (hit === button || button.contains(hit));
    })()`),
  );
  check(
    "三档动效过渡中启用顶栏按钮保持真实命中",
    await evalJs(
      `window.__motionHitMisses.length === 0 && window.__motionHitDisabledSamples > 0 && !document.querySelector('[aria-label="打开文件工作区"], [aria-label="收起文件工作区，返回对话"]')?.disabled`,
    ),
    await evalJs(
      "JSON.stringify({ misses: window.__motionHitMisses.slice(0, 5), temporarilyDisabledSamples: window.__motionHitDisabledSamples ?? 0 })",
    ),
  );
} catch (error) {
  check("真实面板动效执行异常", false, error instanceof Error ? error.stack : String(error));
} finally {
  await call("Emulation.setEmulatedMedia", { features: [] }).catch(() => {});
  await evalJs(`(async () => {
    const previous = ${JSON.stringify(previous)};
    if (previous) {
      (await import("/src/store/app-settings-store.ts")).useAppSettingsStore.getState().setSettings(previous.settings);
      (await import("/src/store/file-workspace-store.ts")).useFileWorkspaceStore.setState({ hosts: previous.hosts, recentRoots: previous.recentRoots });
      const textarea = document.querySelector("textarea");
      if (textarea) {
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
        setter.call(textarea, previous.input);
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
      }
    }
    delete window.__motionOriginalInput;
    delete window.__motionHitMisses;
    delete window.__motionHitDisabledSamples;
    delete window.__motionHeader;
  })()`).catch(() => {});
  ws.close();
}
writeFileSync(`${outDir}/assistant-panel-motion.json`, JSON.stringify({ checks, evidence, exceptions }, null, 2));
for (const item of checks)
  console.log(`${item.pass ? "PASS" : "FAIL"} ${item.name}${item.detail ? ` | ${item.detail}` : ""}`);
if (checks.some((item) => !item.pass) || exceptions.length) process.exit(1);
console.log(`\n${checks.filter((item) => item.pass).length}/${checks.length} PASS`);
