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
})()`);
const waitFor = async (expression, label) => {
  for (let index = 0; index < 150; index += 1) {
    if (await evaluate(`(async () => Boolean(await (${expression})))()`)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`等待超时：${label}`);
};
const click = async (expression, label) => {
  const point = await evaluate(`(() => {
    const element = ${expression};
    if (!element) return null;
    element.scrollIntoView({ block: "center" });
    const rect = element.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  assert.ok(point, `找不到可点击元素：${label}`);
  await call("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
  await call("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...point });
  await call("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...point });
};
const openToc = async () => {
  await click(`document.querySelector(".header-bar svg.lucide-table-of-contents")?.closest("button")`, "目录");
  await waitFor(`document.querySelector('[role="treeitem"]')`, "目录树");
};
const button = `document.querySelector('[data-book-id] button[aria-label="返回转跳前位置"]')`;
let original;
let originalTab;
try {
  originalTab = await evaluate("window.__readerLayoutForTest().activeTabId");
  await evaluate(
    `window.__readerLayoutForTest().openBook("c6207a35b9b8e0b5396d0b2ffc4f42b9", "A Modern Introduction to Quantum Field Theory")`,
  );
  await waitFor(`document.querySelector("foliate-view")?.lastLocation?.cfi`, "书页当前位置初始化");
  original = await evaluate(`(() => {
    const view = document.querySelector("foliate-view");
    return { cfi: view?.lastLocation?.cfi, canGoBack: view?.history.canGoBack };
  })()`);
  assert.ok(original?.cfi, "请先在隔离 Preview 打开一本 EPUB");
  assert.equal(original.canGoBack, false, "请从本书的初始阅读位置开始本测试");
  await openToc();
  await click(
    `Array.from(document.querySelectorAll('[role="treeitem"]')).find((item) =>
    item.textContent.includes("Lorentz and Poincaré"))`,
    "不同章节",
  );
  await waitFor(
    `${button} && document.querySelector("foliate-view").lastLocation.cfi !== ${JSON.stringify(original.cfi)}`,
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
    `!${button} && document.querySelector("foliate-view").lastLocation.cfi === ${JSON.stringify(original.cfi)}`,
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
  await evaluate(`document.querySelector("foliate-view").next()`);
  await waitFor(`!${button}`, "继续阅读后自动隐藏");
  console.log("PASS 真实翻页继续阅读后按钮自动隐藏");
} finally {
  await evaluate(`(async () => {
    delete window.__jumpBackTooltipPoint;
    const view = document.querySelector("foliate-view");
    const original = ${JSON.stringify(original ?? {})};
    if (view && original.cfi) {
      view.history.clear();
      await view.goTo(original.cfi);
    }
  })()`).catch(() => {});
  if (originalTab) {
    await evaluate(`window.__readerLayoutForTest().activateTab(${JSON.stringify(originalTab)})`).catch(() => {});
  }
  await evaluate("delete window.__readerLayoutForTest").catch(() => {});
  ws.close();
}
