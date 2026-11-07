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
      if (hook.memoizedState?.openPaper && hook.memoizedState?.removeTab) return hook.memoizedState;
      hook = hook.next;
    }
    return null;
  };
})()`);
const pause = (ms = 150) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (expression, label) => {
  for (let index = 0; index < 100; index += 1) {
    if (await evaluate(`(async () => Boolean(await (${expression})))()`)) return;
    await pause(100);
  }
  const detail = await evaluate(`Array.from(document.querySelectorAll(".paper-content")).map((content) => {
    const scroller = content.closest(".overflow-y-auto");
    return {
      visible: scroller?.checkVisibility(),
      top: scroller?.scrollTop,
      button: Boolean(scroller?.querySelector('button[aria-label="返回转跳前位置"]')),
      anchor: (() => {
        const element = content.querySelector("#ref-6");
        if (!element) return null;
        const rect = element.getBoundingClientRect();
        const host = element.closest("p, li")?.getBoundingClientRect();
        return { top: rect.top, hostTop: host?.top, viewportTop: scroller.getBoundingClientRect().top, viewportBottom: scroller.getBoundingClientRect().bottom };
      })(),
      active: document.activeElement?.getAttribute("aria-label") || document.activeElement?.tagName,
    };
  })`);
  throw new Error(`等待超时：${label} ${JSON.stringify(detail)}`);
};
const scroller = `document.querySelector('.tab-layer[data-active="true"] .paper-content')?.closest(".overflow-y-auto")`;
const button = `${scroller}?.querySelector('button[aria-label="返回转跳前位置"]')`;
const clickLink = (href) =>
  evaluate(`(() => {
  const link = ${scroller}?.querySelector('a[href="${href}"]');
  if (!link) return false;
  link.click();
  return true;
})()`);
const scrollTop = () => evaluate(`Math.round(${scroller}?.scrollTop ?? -1)`);
let originalTab;
try {
  originalTab = await evaluate("window.__readerLayoutForTest().activeTabId");
  if (originalTab === "paper-57ae0a5f29feecb6") originalTab = "reader-c6207a35b9b8e0b5396d0b2ffc4f42b9";
  await evaluate(`window.__readerLayoutForTest().removeTab("paper-57ae0a5f29feecb6")`);
  await evaluate(`window.__readerLayoutForTest().openPaper("57ae0a5f29feecb6", "Forecast constraints")`);
  await waitFor(`${scroller}?.querySelector('a[href^="#ref-"]')`, "论文正文与引用链接");
  await evaluate(`${scroller}.scrollTo({ top: 0, behavior: "instant" })`);
  await pause(500);
  const origin = await scrollTop();
  console.log("引用转跳前的真实 scrollTop:", origin);
  assert.equal(await evaluate(`Boolean(${button})`), false, "初始论文不应有返回按钮");
  assert.equal(await clickLink("#ref-6"), true);
  await waitFor(button, "文内引用转跳后的返回按钮");
  const layout = await evaluate(`(() => {
    const button = ${button};
    const rect = button.getBoundingClientRect();
    return { width: rect.width, height: rect.height, visible: button.checkVisibility() };
  })()`);
  assert.equal(layout.visible, true);
  assert.equal(layout.width, 36);
  assert.equal(layout.height, 36);
  await evaluate(`(() => {
    const button = ${button};
    button.blur();
    button.focus();
  })()`);
  assert.equal(await evaluate(`document.activeElement === ${button}`), true, "论文按钮应可由键盘聚焦");
  const shot = await call("Page.captureScreenshot", { format: "png" });
  writeFileSync(`${outDir}/paper-jump-back-tooltip.png`, Buffer.from(shot.data, "base64"));
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
  await waitFor(`!${button} && Math.abs(${scroller}.scrollTop - ${origin}) < 3`, "论文返回转跳前位置并隐藏");
  console.log("PASS 论文引用转跳、36px 圆形按钮、键盘聚焦与返回", JSON.stringify({ ...layout, origin }));

  await clickLink("#ref-6");
  await waitFor(button, "第二次论文转跳");
  await pause(3400);
  const wheelPoint = await evaluate(`(() => {
    const rect = ${scroller}.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  await call("Input.dispatchMouseEvent", { type: "mouseWheel", ...wheelPoint, deltaX: 0, deltaY: 240 });
  await waitFor(`!${button}`, "论文用户滚动后的驻留隐藏");
  console.log("PASS 论文原有驻留隐藏逻辑未退化");

  await evaluate(`${scroller}.scrollTo({ top: 0, behavior: "instant" })`);
  await pause(500);
  const figureOrigin = await scrollTop();
  const figure = await evaluate(`${scroller}?.querySelector('a[href^="#fig-"]')?.getAttribute("href")`);
  assert.ok(figure, "测试论文应有图表链接");
  await clickLink(figure);
  await waitFor(button, "图表转跳");
  await pause(1500);
  const figurePosition = await scrollTop();
  assert.ok(Math.abs(figurePosition - figureOrigin) > 20, "应先成功转跳到图表位置");
  await evaluate(`${button}.click()`);
  await waitFor(`!${button} && Math.abs(${scroller}.scrollTop - ${figureOrigin}) < 3`, "图表返回转跳前位置");
  console.log("PASS 论文图表转跳与返回", JSON.stringify({ figureOrigin, figurePosition }));

  await evaluate(`${scroller}.scrollTo({ top: 0, behavior: "instant" })`);
  await clickLink("#ref-6");
  await waitFor(button, "连续转跳的引用位置");
  await pause(3400);
  await clickLink(figure);
  await waitFor(button, "连续转跳的图表位置");
  await pause(3400);
  await evaluate(`${button}.click()`);
  const referenceVisible = `(() => {
    const root = ${scroller};
    const anchor = root.querySelector("#ref-6");
    const viewport = root.getBoundingClientRect();
    const rect = anchor.getBoundingClientRect();
    return rect.top >= viewport.top && rect.top <= viewport.bottom;
  })()`;
  await waitFor(`Boolean(${button}) && (${referenceVisible})`, "第一次返回后引用锚点重新进入视口");
  await evaluate(`${button}.click()`);
  await waitFor(`!${button} && Math.abs(${scroller}.scrollTop - ${figureOrigin}) < 3`, "第二次返回最初位置");
  console.log("PASS 论文连续两次转跳后逐级返回");
} finally {
  await evaluate(`window.__readerLayoutForTest().removeTab("paper-57ae0a5f29feecb6")`).catch(() => {});
  if (originalTab) {
    await evaluate(`window.__readerLayoutForTest().activateTab(${JSON.stringify(originalTab)})`).catch(() => {});
  }
  await evaluate("delete window.__readerLayoutForTest").catch(() => {});
  ws.close();
}
