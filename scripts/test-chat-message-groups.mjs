import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";

const root = fileURLToPath(new URL("../", import.meta.url));
const src = join(root, "packages/app/src");
const pnpmDir = join(root, "node_modules", ".pnpm");
const esbuildPkg = readdirSync(pnpmDir).find((d) => d.startsWith("esbuild@"));
assert.ok(esbuildPkg, "未找到 esbuild");
const esbuild = await import(
  pathToFileURL(join(pnpmDir, esbuildPkg, "node_modules", "esbuild", "lib", "main.js")).href
);

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
const { window } = dom;
for (const key of [
  "document",
  "navigator",
  "HTMLElement",
  "Element",
  "Node",
  "Text",
  "Range",
  "MutationObserver",
  "CustomEvent",
  "KeyboardEvent",
  "MouseEvent",
]) {
  Object.defineProperty(globalThis, key, { value: window[key], configurable: true, writable: true });
}
globalThis.window = window;
globalThis.localStorage = window.localStorage;
globalThis.sessionStorage = window.sessionStorage;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.requestAnimationFrame = (callback) => setTimeout(() => callback(Date.now()), 16);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
window.requestAnimationFrame = globalThis.requestAnimationFrame;
window.cancelAnimationFrame = globalThis.cancelAnimationFrame;
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
window.getComputedStyle = window.getComputedStyle.bind(window);
globalThis.getComputedStyle = window.getComputedStyle;
class Observer {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = Observer;
globalThis.IntersectionObserver = Observer;
window.ResizeObserver = Observer;
window.IntersectionObserver = Observer;
window.HTMLElement.prototype.scrollIntoView = () => {};
window.HTMLElement.prototype.scrollTo = () => {};
globalThis.CSS = { highlights: new Map(), escape: (value) => value };
window.CSS = globalThis.CSS;
globalThis.Highlight = class {
  constructor(...ranges) {
    this.ranges = ranges;
  }
};
window.Highlight = globalThis.Highlight;
window.__TAURI_INTERNALS__ = {
  invoke: async (command) => {
    if (String(command).includes("app_config_dir")) return join(tmpdir(), "chat-message-groups-config");
    return null;
  },
};

const outDir = mkdtempSync(join(tmpdir(), "chat-message-groups-"));
const entry = join(outDir, "entry.ts");
const posix = (path) => path.replace(/\\/g, "/");
writeFileSync(
  entry,
  [
    `export { ChatMessages } from "${posix(join(src, "components/side-chat/chat-messages.tsx"))}";`,
    `export { ChatContainerRoot } from "${posix(join(src, "components/prompt-kit/chat-container.tsx"))}";`,
    `export { SHARED_HOUSE_RULES } from "${posix(join(src, "constants/shared-policy.ts"))}";`,
    `export { default as React, act } from "react";`,
    `export { createRoot } from "react-dom/client";`,
  ].join("\n"),
);
const outfile = join(outDir, "chat-groups.mjs");
await esbuild.build({
  entryPoints: [entry],
  bundle: true,
  format: "esm",
  platform: "node",
  jsx: "automatic",
  outfile,
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  alias: { "@": src },
  nodePaths: [join(root, "packages/app/node_modules")],
  loader: { ".css": "empty", ".svg": "dataurl", ".png": "dataurl", ".woff": "dataurl", ".woff2": "dataurl" },
  logLevel: "silent",
});
const { ChatContainerRoot, ChatMessages, React, SHARED_HOUSE_RULES, act, createRoot } = await import(
  pathToFileURL(outfile).href
);

let passed = 0;
let failed = 0;
async function test(name, run) {
  try {
    await run();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${name} — ${error instanceof Error ? error.stack : String(error)}`);
  }
}

const tool = (type, id, input = {}) => ({
  type: `tool-${type}`,
  toolCallId: id,
  state: "output-available",
  input,
  output: { results: { success: true } },
});
const text = (value) => ({ type: "text", text: value });
const reasoning = (value) => ({ type: "reasoning", text: value });

async function render(parts, options = {}) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      React.createElement(
        ChatContainerRoot,
        { autoScroll: false, resize: "instant" },
        React.createElement(ChatMessages, {
          messages: options.messages ?? [{ id: "m1", role: "assistant", parts }],
          status: "ready",
          error: null,
          onRetry: options.onRetry,
          canRetry: options.canRetry,
          onOpenFile: options.onOpenFile,
        }),
      ),
    );
  });
  return {
    host,
    async cleanup() {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

function groupButton(host) {
  return Array.from(host.querySelectorAll("button")).find((button) => button.textContent.includes("已调用"));
}

console.log("[1] 工具分组与原始顺序");
await test("reasoning、step-start 和短评论不打断两个工具的折叠组", async () => {
  const view = await render([
    tool("readDocument", "a", { doc: "book:a" }),
    reasoning("思考插段"),
    text("简短评论"),
    { type: "step-start" },
    { type: "custom" },
    tool("useTool", "b", { tool: "readDocument", args: { doc: "book:b" } }),
    text("正式回答"),
  ]);
  try {
    assert.ok(groupButton(view.host)?.textContent.includes("已调用 2 个工具"), view.host.textContent);
  } finally {
    await view.cleanup();
  }
});

await test("折叠组展开后保持插段顺序且末段回答在组外", async () => {
  const view = await render([
    tool("readDocument", "a"),
    reasoning("思考插段"),
    text("简短评论"),
    { type: "step-start" },
    { type: "custom" },
    tool("useTool", "b"),
    text("正式回答"),
  ]);
  try {
    const button = groupButton(view.host);
    assert.ok(button, view.host.textContent);
    await act(async () => button.dispatchEvent(new window.MouseEvent("click", { bubbles: true })));
    const group = button.parentElement;
    const content = group.textContent;
    for (const marker of ["思考插段", "简短评论", "readDocument", "useTool"]) {
      assert.ok(content.includes(marker), `${marker} 未出现在展开组内：${content}`);
    }
    assert.ok(content.indexOf("readDocument") < content.indexOf("思考插段"), content);
    assert.ok(content.indexOf("思考插段") < content.indexOf("简短评论"), content);
    assert.ok(content.indexOf("简短评论") < content.lastIndexOf("useTool"), content);
    assert.ok(!content.includes("正式回答"), content);
    assert.ok(view.host.textContent.includes("正式回答"));
  } finally {
    await view.cleanup();
  }
});

await test("两个工具执行中显示数量且默认折叠", async () => {
  const view = await render([
    { ...tool("writeFile", "a", { path: "a.txt" }), state: "input-available" },
    reasoning("执行中思考"),
    { ...tool("runCommand", "b", { command: "python main.py" }), state: "input-available" },
  ]);
  try {
    const button = Array.from(view.host.querySelectorAll("button")).find((item) =>
      item.textContent.includes("正在调用"),
    );
    assert.ok(button?.textContent.includes("2 个工具"), view.host.textContent);
    assert.equal(button.getAttribute("aria-expanded"), "false");
  } finally {
    await view.cleanup();
  }
});

await test("单独一个工具不折叠且时间戳形状文本不被隐藏", async () => {
  const view = await render([
    tool("readDocument", "a"),
    reasoning("保留思考"),
    text("[2026-10-25 04:28] 用户要求的原文"),
  ]);
  try {
    assert.equal(groupButton(view.host), undefined);
    const content = view.host.textContent;
    assert.ok(content.indexOf("保留思考") < content.indexOf("[2026-10-25 04:28] 用户要求的原文"), content);
  } finally {
    await view.cleanup();
  }
});

await test("text 与 reasoning 不被渲染层交换", async () => {
  const view = await render([text("话语在前"), reasoning("思考在后")]);
  try {
    const content = view.host.textContent;
    assert.ok(content.indexOf("话语在前") < content.indexOf("思考在后"), content);
  } finally {
    await view.cleanup();
  }
});

await test("聊天只保留一个滚动容器且短内容仍填满", async () => {
  const view = await render([text("短回答")]);
  try {
    const content = view.host.querySelector(".select-auto");
    const root = view.host.querySelector('[role="log"]');
    assert.ok(content, "缺少消息内容容器");
    assert.ok(root, "缺少外层尺寸容器");
    assert.doesNotMatch(
      root.className,
      /overflow-y-auto|overflow-x-hidden/,
      "外层只定尺寸，不能再与库的 scrollRef 抢滚动",
    );
    assert.equal(content.style.overflow, "visible", "内容不能再独立滚动");
    assert.equal(content.style.height, "auto", "长内容应自然增高");
    assert.equal(content.style.minHeight, "100%", "短内容仍应填满视口");
  } finally {
    await view.cleanup();
  }
});

await test("交付卡整卡共享 hover，而非只有标题行变色", async () => {
  const view = await render(
    [
      text("交付"),
      {
        ...tool("present", "present-hover"),
        output: { results: { success: true, deliverable: { path: "F:/ws/README.md", description: "使用说明" } } },
      },
    ],
    { onOpenFile: () => {} },
  );
  try {
    const card = view.host.querySelector("article");
    const button = card?.querySelector("button");
    assert.ok(card, "缺少交付卡");
    assert.match(card.className, /hover:bg-accent/);
    assert.doesNotMatch(button?.className ?? "", /hover:bg-accent/);
  } finally {
    await view.cleanup();
  }
});

await test("编辑文件与显式交付跟在各自回答尾部，不跨轮也不冒充新建产物", async () => {
  const firstParts = [
    text("第一轮回答"),
    {
      ...tool("writeFile", "first-write"),
      output: { results: { success: true, path: "F:/ws/first-probe.mjs", created: true } },
    },
    {
      ...tool("present", "first-present"),
      output: { results: { success: true, deliverable: { path: "F:/ws/README.md", description: "最终说明" } } },
    },
  ];
  const secondParts = [
    text("第二轮回答"),
    { ...tool("editFile", "second-edit"), output: { results: { success: true, path: "F:/ws/second.md" } } },
  ];
  const view = await render([], {
    messages: [
      { id: "turn-one", role: "assistant", parts: firstParts },
      { id: "turn-two", role: "assistant", parts: secondParts },
    ],
    onOpenFile: () => {},
  });
  try {
    const first = view.host.querySelector('[data-message-files="turn-one"]');
    const second = view.host.querySelector('[data-message-files="turn-two"]');
    assert.ok(first, view.host.textContent);
    assert.ok(second, view.host.textContent);
    assert.match(first.textContent, /README\.md/);
    assert.doesNotMatch(first.textContent, /second\.md/);
    assert.doesNotMatch(first.textContent, /本次新建/);
    const disclosure = first.querySelector("[aria-expanded]");
    assert.equal(disclosure?.getAttribute("aria-expanded"), "false");
    await act(async () => disclosure.dispatchEvent(new window.MouseEvent("click", { bubbles: true })));
    assert.match(first.textContent, /first-probe\.mjs/);
    const firstContent = view.host.querySelector('[data-message-id="turn-one"]');
    assert.ok(firstContent.compareDocumentPosition(first) & window.Node.DOCUMENT_POSITION_FOLLOWING);
    assert.doesNotMatch(second.textContent, /README\.md/);
  } finally {
    await view.cleanup();
  }
});

await test("长度截断的回答提供继续生成，普通回答保留重新生成", async () => {
  const view = await render([], {
    messages: [
      {
        id: "length-reply",
        role: "assistant",
        parts: [reasoning("已有的思考"), text("未完成的正文")],
        metadata: { finishReason: "length", interrupted: true },
      },
    ],
    onRetry: () => {},
    canRetry: true,
  });
  try {
    const button = view.host.querySelector("button:has(svg.lucide-refresh-cw)");
    assert.ok(button, "末条回答应有重试按钮");
    await act(async () => {
      button.focus();
      await new Promise((resolve) => setTimeout(resolve, 180));
    });
    const tooltip = Array.from(document.querySelectorAll('[role="tooltip"]'))
      .map((item) => item.textContent)
      .join(" ");
    assert.ok(tooltip.includes("继续生成"), tooltip);
    assert.ok(!tooltip.includes("重新生成"), tooltip);
  } finally {
    await view.cleanup();
  }

  const normal = await render([text("完整回答")], { onRetry: () => {}, canRetry: true });
  try {
    const button = normal.host.querySelector("button:has(svg.lucide-refresh-cw)");
    await act(async () => {
      button.focus();
      await new Promise((resolve) => setTimeout(resolve, 180));
    });
    const tooltip = Array.from(document.querySelectorAll('[role="tooltip"]'))
      .map((item) => item.textContent)
      .join(" ");
    assert.ok(tooltip.includes("重新生成"), tooltip);
    assert.ok(!tooltip.includes("继续生成"), tooltip);
  } finally {
    await normal.cleanup();
  }
});

await test("历史时间前缀是只读元数据且不允许无请求回声", () => {
  assert.match(SHARED_HOUSE_RULES, /只读元数据/);
  assert.match(SHARED_HOUSE_RULES, /除非用户明确要求/);
  assert.match(SHARED_HOUSE_RULES, /Thought/);
});

console.log(`\n结果：${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
