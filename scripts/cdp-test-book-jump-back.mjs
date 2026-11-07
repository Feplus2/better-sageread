import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { connectPreview } from "../.superpowers/sdd/2026-11-07-user-feedback/cdp-client.mjs";

const outDir = ".superpowers/sdd/2026-11-08-reader-followup";
mkdirSync(outDir, { recursive: true });
const { ws, call, evaluate } = await connectPreview();
await evaluate(`(() => {
  const host = document.querySelector("main");
  let fiber = host?.[Object.keys(host ?? {}).find((key) => key.startsWith("__reactFiber$"))];
  while (fiber && fiber.type?.name !== "ReaderLayout") fiber = fiber.return;
  if (!fiber) throw new Error("找不到实际阅读布局");
  window.__readerLayoutForTest = () => {
    let hook = fiber.memoizedState;
    while (hook) {
      if (hook.memoizedState?.openBook && hook.memoizedState?.activateTab) return hook.memoizedState;
      hook = hook.next;
    }
    return null;
  };
  window.__bookViewForTest = () => {
    const host = document.querySelector('.tab-layer[data-active="true"] [data-book-id]');
    let fiber = host?.[Object.keys(host ?? {}).find((key) => key.startsWith("__reactFiber$"))];
    while (fiber && fiber.type?.name !== "ReaderProvider") fiber = fiber.return;
    return fiber?.memoizedProps.store.getState().view;
  };
})()`);
const waitFor = async (expression, label) => {
  for (let index = 0; index < 150; index += 1) {
    if (await evaluate(`(async () => Boolean(await (${expression})))()`)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const detail = await evaluate(`(() => {
    const view = window.__bookViewForTest();
    return {
      cfi: view?.lastLocation?.cfi,
      expected: ${JSON.stringify(original?.cfi)},
      canGoBack: view?.history.canGoBack,
      button: Boolean(document.querySelector('[data-book-id] button[aria-label="返回转跳前位置"]')),
      active: document.activeElement?.getAttribute("aria-label") || document.activeElement?.tagName,
    };
  })()`);
  throw new Error(`等待超时：${label} ${JSON.stringify(detail)}`);
};
const click = async (expression, label) => {
  const point = await evaluate(`(async () => {
    const element = ${expression};
    if (!element) return null;
    element.scrollIntoView({ block: "center" });
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const rect = element.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  assert.ok(point, `找不到可点击元素：${label}`);
  await call("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
  await call("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...point });
  await call("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...point });
};
const openToc = async () => {
  await click(
    `document.querySelector('.tab-layer[data-active="true"] .header-bar svg.lucide-table-of-contents')?.closest("button")`,
    "目录",
  );
  await waitFor(`document.querySelector('[role="treeitem"]')`, "目录树");
};
const button = `document.querySelector('.tab-layer[data-active="true"] [data-book-id] button[aria-label="返回转跳前位置"]')`;
let original;
let originalTab;
try {
  originalTab = await evaluate("window.__readerLayoutForTest().activeTabId");
  await evaluate(
    `window.__readerLayoutForTest().openBook("c6207a35b9b8e0b5396d0b2ffc4f42b9", "A Modern Introduction to Quantum Field Theory")`,
  );
  await waitFor("window.__bookViewForTest()?.lastLocation?.cfi", "书页当前位置初始化");
  original = await evaluate(`(() => {
    const view = window.__bookViewForTest();
    return {
      cfi: view?.lastLocation?.cfi,
      sectionHref: view?.lastLocation?.sectionHref,
      start: view?.renderer.start,
      canGoBack: view?.history.canGoBack,
    };
  })()`);
  assert.ok(original?.cfi, "请先在隔离 Preview 打开一本 EPUB");
  await evaluate(`(async () => {
    const view = window.__bookViewForTest();
    view.history.clear();
    await view.goTo("EPUB/chapter_000.xhtml");
  })()`);
  const returnStart = await evaluate("window.__bookViewForTest().renderer.start");
  assert.equal(await evaluate("window.__bookViewForTest().history.canGoBack"), false);
  await openToc();
  await click(
    `Array.from(document.querySelectorAll('[role="treeitem"]')).find((item) =>
    item.textContent.includes("Lorentz and Poincaré"))`,
    "不同章节",
  );
  await waitFor(
    `${button} && window.__bookViewForTest().lastLocation.cfi !== ${JSON.stringify(original.cfi)}`,
    "目录转跳与返回按钮",
  );
  const layout = await evaluate(`(() => {
    const button = ${button};
    const host = document.querySelector("[data-book-id]");
    const b = button.getBoundingClientRect();
    const h = host.getBoundingClientRect();
    return {
      shape: { width: b.width, height: b.height, radius: getComputedStyle(button).borderRadius },
      inside: b.right <= h.right && b.bottom <= h.bottom && b.left >= h.left && b.top >= h.top,
      label: button.getAttribute("aria-label"),
    };
  })()`);
  assert.equal(layout.shape.width, 36);
  assert.equal(layout.shape.height, 36);
  assert.equal(layout.inside, true, JSON.stringify(layout));
  await evaluate(`(() => {
    const rect = ${button}.getBoundingClientRect();
    window.__jumpBackTooltipPoint = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  const point = await evaluate("window.__jumpBackTooltipPoint");
  await call("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
  await waitFor(`document.querySelector('[role="tooltip"]')?.textContent.includes("返回转跳前位置")`, "悬浮 Tooltip");
  const screenshot = await call("Page.captureScreenshot", { format: "png" });
  writeFileSync(`${outDir}/jump-back-tooltip.png`, Buffer.from(screenshot.data, "base64"));
  await evaluate(`${button}.focus()`);
  const focused = await evaluate(`({
    label: ${button}.getAttribute("aria-label"),
    describedBy: ${button}.getAttribute("aria-describedby"),
  })`);
  assert.equal(focused.label, "返回转跳前位置");
  assert.ok(focused.describedBy, JSON.stringify(focused));
  await call("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Enter",
    code: "Enter",
    text: "\r",
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
  });
  await call("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
  });
  await waitFor(
    `!${button} && (() => {
      const view = window.__bookViewForTest();
      return !view.history.canGoBack
        && view.lastLocation.sectionHref === "EPUB/chapter_000.xhtml"
        && Math.abs(view.renderer.start - ${JSON.stringify(returnStart)}) < 2;
    })()`,
    "键盘返回起点并隐藏",
  );
  console.log("PASS 实际目录点击、圆形按钮、悬浮 Tooltip、键盘返回与起点隐藏", JSON.stringify({ layout, focused }));

  await openToc();
  await click(
    `Array.from(document.querySelectorAll('[role="treeitem"]')).find((item) =>
    item.textContent.includes("Lorentz and Poincaré"))`,
    "再次目录转跳",
  );
  await waitFor(button, "再次转跳后出现按钮");
  const readerSize = await evaluate("window.__bookViewForTest().renderer.size");
  await call("Emulation.setDeviceMetricsOverride", { width: 1800, height: 1100, deviceScaleFactor: 1, mobile: false });
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.ok(await evaluate(`Boolean(${button})`), "视口尺寸变化不应误隐藏返回按钮");
  await call("Emulation.clearDeviceMetricsOverride");
  await waitFor(
    `Math.abs(window.__bookViewForTest().renderer.size - ${JSON.stringify(readerSize)}) < 1`,
    "视口尺寸恢复与布局稳定",
  );
  console.log("PASS 真实视口变化不会误隐藏返回按钮");
  await evaluate("window.__bookViewForTest().next()");
  await waitFor(`!${button}`, "继续阅读后自动隐藏");
  console.log("PASS 真实翻页继续阅读后按钮自动隐藏");
  await evaluate(`(async () => {
    const paths = [...new Set(performance.getEntriesByType("resource").map((entry) => entry.name)
      .filter((name) => name.includes("/src/pages/reader/hooks/navigation-tracker.ts")))];
    let tracker;
    for (const path of paths) {
      const module = await import(path);
      if (typeof module.hasPendingProgrammaticNavigation === "function") tracker = module;
    }
    if (!tracker) throw new Error("找不到当前导航标记模块");
    tracker.markProgrammaticNavigation("c6207a35b9b8e0b5396d0b2ffc4f42b9");
    await window.__bookViewForTest().goTo("EPUB/chapter_002.xhtml");
  })()`);
  await waitFor(`!${button}`, "后台同步转跳不得显示按钮");
  console.log("PASS 程序化同步转跳不会冒充用户转跳");
} finally {
  await call("Emulation.clearDeviceMetricsOverride").catch(() => {});
  await evaluate(`(async () => {
    delete window.__jumpBackTooltipPoint;
    const view = window.__bookViewForTest();
    const original = ${JSON.stringify(original ?? {})};
    if (view && original.cfi) {
      view.history.clear();
      await view.goTo(original.cfi);
    }
  })()`).catch(() => {});
  if (originalTab) {
    await evaluate(`window.__readerLayoutForTest().activateTab(${JSON.stringify(originalTab)})`).catch(() => {});
  }
  await evaluate("delete window.__readerLayoutForTest; delete window.__bookViewForTest").catch(() => {});
  ws.close();
}
