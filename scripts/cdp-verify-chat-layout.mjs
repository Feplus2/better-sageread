import { mkdirSync, writeFileSync } from "node:fs";
import { appModuleExpression } from "./cdp-app-module.mjs";
import { connectPreview } from "./cdp-client.mjs";

const outDir = process.env.VERIFY_OUT ?? ".superpowers/sdd/2026-11-07-user-feedback/chat-layout";
mkdirSync(outDir, { recursive: true });
const { ws, call, evaluate } = await connectPreview();
const checks = [];
const check = (name, pass, detail = "") => {
  checks.push({ name, pass: Boolean(pass), detail });
  console.log(`${pass ? "PASS" : "FAIL"} ${name}${detail ? ` | ${JSON.stringify(detail)}` : ""}`);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const wheel = async (x, y, deltaY) => call("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: 0, deltaY });
const move = async (x, y) => call("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
const click = async (x, y) => {
  await call("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await call("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
};
try {
  await evaluate(`(async () => {
    const layout = (await import(${appModuleExpression("/src/store/layout-store.ts")})).useLayoutStore.getState();
    window.__chatLayoutPrevious = {
      tabs: layout.tabs,
      activeTabId: layout.activeTabId,
      isHomeActive: layout.isHomeActive,
      isChatVisible: layout.isChatVisible,
      isNotepadVisible: layout.isNotepadVisible,
      tabOrientation: layout.tabOrientation,
      isVerticalTabCollapsed: layout.isVerticalTabCollapsed,
    };
    layout.activateTab("reader-c6207a35b9b8e0b5396d0b2ffc4f42b9");
  })()`);
  await sleep(500);
  const rootSelector = '#chat-sidebar [role="log"]';
  let lastHeight = -1;
  let stableFrames = 0;
  for (let index = 0; index < 120; index += 1) {
    const height = await evaluate(
      `Array.from(document.querySelectorAll(${JSON.stringify(rootSelector)})).find((element) => !element.closest("[inert]") && getComputedStyle(element).pointerEvents !== "none")?.querySelector(".select-auto")?.parentElement.scrollHeight ?? -1`,
    );
    stableFrames = height === lastHeight ? stableFrames + 1 : 0;
    if (height > 0 && stableFrames >= 5) break;
    if (index === 119) throw new Error("消息内容高度在 12 秒内未稳定");
    lastHeight = height;
    await sleep(100);
  }
  const initial = await evaluate(`(() => {
    const root = Array.from(document.querySelectorAll(${JSON.stringify(rootSelector)})).find((element) => {
      const layer = element.closest(".tab-layer");
      return (!layer || layer.dataset.active === "true") && !element.closest("[inert]") && getComputedStyle(element).pointerEvents !== "none" && element.getBoundingClientRect().width > 0;
    });
    if (!root) return null;
    const content = root.querySelector(".select-auto");
    const scroller = content?.parentElement ?? root;
    window.__chatLayout = { root, scroller };
    const scrollers = [root, ...root.querySelectorAll("*")].filter((element) => {
      const style = getComputedStyle(element);
      return ["auto", "scroll"].includes(style.overflowY) && element.scrollHeight > element.clientHeight + 1;
    }).map((element) => ({ className: element.className, style: element.getAttribute("style"), height: element.clientHeight, scrollHeight: element.scrollHeight }));
    return { scrollTop: scroller.scrollTop, scrollHeight: scroller.scrollHeight, clientHeight: scroller.clientHeight, contentStyle: content?.getAttribute("style"), scrollers, rect: scroller.getBoundingClientRect().toJSON() };
  })()`);
  if (!initial) throw new Error("找不到可见的书籍聊天滚动容器");
  check("聊天只有一个纵向滚动区域", initial.scrollers.length === 1, initial.scrollers);
  check(
    "短内容最小填满、长内容自然增长，不再内层滚动",
    initial.contentStyle?.includes("height: auto") &&
      initial.contentStyle?.includes("min-height: 100%") &&
      initial.contentStyle?.includes("overflow: visible"),
    initial.contentStyle,
  );
  const beforeUp = initial.scrollTop;
  await wheel(
    initial.rect.left + initial.rect.width * 0.6,
    initial.rect.top + Math.min(initial.rect.height * 0.5, 200),
    -500,
  );
  await sleep(300);
  const afterUp = await evaluate("window.__chatLayout.scroller.scrollTop");
  check("真实滚轮可以上翻且不会被容器截断", afterUp < beforeUp, { beforeUp, afterUp });
  const downButton = await evaluate(`(() => {
    const button = window.__chatLayout.root.querySelector('button:has(svg.lucide-arrow-down)');
    if (!button) return null;
    const rect = button.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  if (downButton) await click(downButton.x, downButton.y);
  else await wheel(initial.rect.left + initial.rect.width * 0.6, initial.rect.top + 200, 10000);
  await sleep(800);
  const bottom = await evaluate(
    "(() => { const scroller = window.__chatLayout.scroller; return { distance: scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop, height: scroller.clientHeight, scrollHeight: scroller.scrollHeight }; })()",
  );
  check("回到底部按钮仍使用唯一滚动容器", bottom.distance <= 3, bottom);
  const shot = await call("Page.captureScreenshot", { format: "png" });
  writeFileSync(`${outDir}/single-scroll.png`, Buffer.from(shot.data, "base64"));
  await evaluate("delete window.__chatLayout; true");

  await evaluate(`(async () => {
    const resources = performance.getEntriesByType("resource").map((entry) => entry.name);
    const reactModule = await import(resources.filter((name) => name.includes("deps/react.js")).at(-1));
    const domModule = await import(resources.filter((name) => name.includes("deps/react-dom_client.js")).at(-1));
    const { ChangedFilesDisclosure } = await import("/src/components/file-workspace/changed-files-disclosure.tsx");
    const React = reactModule.default ?? reactModule;
    const host = document.createElement("div");
    host.id = "hover-card-verification";
    host.style.cssText = "position:fixed;right:24px;top:24px;width:340px;z-index:99999;padding:12px;background:var(--popover);color:var(--popover-foreground)";
    document.body.appendChild(host);
    const root = (domModule.default ?? domModule).createRoot(host);
    root.render(React.createElement(ChangedFilesDisclosure, {
      message: { id: "hover-verification", parts: [{ type: "tool-present", state: "output-available", output: { results: { success: true, deliverable: { path: "F:/ws/README.md", description: "鼠标放在这段说明上，整张卡片都应变色" } } } }] },
      onOpenFile: () => {},
    }));
    window.__hoverVerification = { host, root };
  })()`);
  await sleep(250);
  await move(0, 0);
  await sleep(300);
  const hover = await evaluate(`(() => {
    const card = document.querySelector("#hover-card-verification article");
    const description = card?.querySelector("p");
    if (!card || !description) return null;
    const rect = description.getBoundingClientRect();
    return { x: rect.left + Math.min(60, rect.width / 2), y: rect.top + rect.height / 2, before: getComputedStyle(card).backgroundColor };
  })()`);
  if (!hover) throw new Error("整卡 hover 测试组件没有渲染");
  await move(hover.x, hover.y);
  await sleep(400);
  const hovered = await evaluate(`(() => {
    const card = document.querySelector("#hover-card-verification article");
    return { hover: card.matches(":hover"), background: getComputedStyle(card).backgroundColor };
  })()`);
  check("鼠标位于说明文字时整卡 hover 变色", hovered.hover && hovered.background !== hover.before, {
    before: hover.before,
    ...hovered,
  });
  const cardShot = await call("Page.captureScreenshot", { format: "png" });
  writeFileSync(`${outDir}/whole-card-hover.png`, Buffer.from(cardShot.data, "base64"));
} catch (error) {
  check("聊天布局验收执行异常", false, error instanceof Error ? error.stack : String(error));
} finally {
  await evaluate(`(async () => {
    const previous = window.__chatLayoutPrevious;
    if (previous) (await import(${appModuleExpression("/src/store/layout-store.ts")})).useLayoutStore.setState(previous);
    delete window.__chatLayoutPrevious;
    window.__hoverVerification?.root.unmount();
    window.__hoverVerification?.host.remove();
    delete window.__hoverVerification;
    delete window.__chatLayout;
    delete window.__wheelProbe;
    return true;
  })()`).catch((error) => check("聊天布局清理异常", false, String(error)));
  ws.close();
}
writeFileSync(`${outDir}/report.json`, JSON.stringify({ checks }, null, 2));
if (checks.some((item) => !item.pass)) process.exit(1);
console.log(`${checks.length}/${checks.length} PASS`);
