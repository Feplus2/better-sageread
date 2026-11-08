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
assert.ok(esbuildPkg);
const esbuild = await import(
  pathToFileURL(join(pnpmDir, esbuildPkg, "node_modules", "esbuild", "lib", "main.js")).href
);
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
const { window } = dom;
const channels = [];
const NativeMessageChannel = globalThis.MessageChannel;
globalThis.MessageChannel = class extends NativeMessageChannel {
  constructor() {
    super();
    channels.push(this);
  }
};
for (const key of [
  "document",
  "navigator",
  "HTMLElement",
  "Element",
  "Node",
  "Text",
  "NodeFilter",
  "Event",
  "DOMParser",
  "MutationObserver",
  "CustomEvent",
  "KeyboardEvent",
  "MouseEvent",
]) {
  Object.defineProperty(globalThis, key, { value: window[key], configurable: true, writable: true });
}
globalThis.window = window;
window.__TAURI_INTERNALS__ = {
  invoke: async (command) => {
    if (command === "plugin:path|resolve_directory") return tmpdir();
    if (command.startsWith("plugin:store|")) return null;
    if (command === "plugin:fs|exists") return false;
    throw new Error(`测试环境未预期的 Tauri 调用：${command}`);
  },
};
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

const outDir = mkdtempSync(join(tmpdir(), "workspace-preview-formats-"));
const entry = join(outDir, "entry.tsx");
const outfile = join(outDir, "bundle.mjs");
writeFileSync(
  entry,
  `export { parseCsvPreview } from "${join(src, "lib/csv.ts").replace(/\\/g, "/")}";
   export { FilePreview } from "${join(src, "components/file-workspace/file-preview.tsx").replace(/\\/g, "/")}";
   export { SafeHtmlPreview, buildSafeHtmlSrcdoc } from "${join(src, "components/file-workspace/safe-html-preview.tsx").replace(/\\/g, "/")}";
   export { MarkdownPreview } from "${join(src, "components/preview/markdown-preview.tsx").replace(/\\/g, "/")}";
   export { CodeBlockCode } from "${join(src, "components/prompt-kit/code-block.tsx").replace(/\\/g, "/")}";
   export { FileExplorer } from "${join(src, "components/file-workspace/file-explorer.tsx").replace(/\\/g, "/")}";
   export { useFileWorkspaceStore } from "${join(src, "store/file-workspace-store.ts").replace(/\\/g, "/")}";
   export { default as React, act } from "react";
   export { createRoot } from "react-dom/client";
   export { renderToStaticMarkup } from "react-dom/server";`,
);
await esbuild.build({
  entryPoints: [entry],
  bundle: true,
  format: "esm",
  platform: "node",
  jsx: "automatic",
  outfile,
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  nodePaths: [join(root, "packages/app/node_modules")],
  loader: { ".css": "empty", ".svg": "dataurl", ".png": "dataurl", ".woff": "dataurl", ".woff2": "dataurl" },
  logLevel: "silent",
});
const api = await import(pathToFileURL(outfile).href);
const {
  parseCsvPreview,
  FilePreview,
  SafeHtmlPreview,
  buildSafeHtmlSrcdoc,
  MarkdownPreview,
  CodeBlockCode,
  React,
  act,
  createRoot,
  renderToStaticMarkup,
} = api;
let passed = 0;
let failed = 0;
async function test(name, run) {
  try {
    await run();
    passed++;
    console.log(`PASS ${name}`);
  } catch (error) {
    failed++;
    console.error(`FAIL ${name} — ${error instanceof Error ? (error.stack ?? error) : String(error)}`);
  }
}

await test("CSV 正确处理逗号、引号、CRLF、换行和不齐列", () => {
  const result = parseCsvPreview('name,value,note\r\nA-01,"x,y","said ""hi"""\r\nA-02,7,"第一行\n第二行",extra\r\n');
  assert.deepEqual(result.headers, ["name", "value", "note", "列4"]);
  assert.deepEqual(result.rows[0], ["A-01", "x,y", 'said "hi"', ""]);
  assert.deepEqual(result.rows[1], ["A-02", "7", "第一行\n第二行", "extra"]);
});

await test("CSV 有界行数与分段末行不会伪装成完整表格", () => {
  const limited = parseCsvPreview("a,b\n1,2\n3,4\n5,6", { maxRows: 2 });
  assert.equal(limited.rows.length, 2);
  assert.equal(limited.truncated, true);
  assert.throws(() => parseCsvPreview('a,b\n1,"unterminated'), /未闭合/);
  const partial = parseCsvPreview('a,b\n1,2\n3,"unfinished', { allowPartial: true });
  assert.deepEqual(partial.rows, [["1", "2"]]);
  assert.equal(partial.truncated, true);
});

await test("HTML 预览移除活动内容、事件、外链与 CSS 资源，并保留正文", () => {
  const result = buildSafeHtmlSrcdoc(
    '<h1>标题</h1><table><tr><td>数据</td></tr></table><script>window.__attack = true</script><img src="https://example.com/x" onerror="window.__attack = true"><a href="file:///etc/passwd">链接</a><iframe srcdoc="<script>alert(1)</script>"></iframe><style>body{background:url(https://example.com/x)}</style>',
    {
      background: "#ffffff",
      foreground: "#111111",
      border: "#dddddd",
    },
  );
  assert.ok(result.includes("标题"));
  assert.ok(result.includes("数据"));
  assert.ok(!result.includes("<script"));
  assert.ok(!result.includes("onerror"));
  assert.ok(!result.includes("src="));
  assert.ok(!result.includes("href="));
  assert.ok(!result.includes("url("));
  assert.ok(result.includes("default-src 'none'"));
  const rendered = renderToStaticMarkup(
    React.createElement(SafeHtmlPreview, { content: "<h1>标题</h1>", title: "报告" }),
  );
  const frame = new DOMParser().parseFromString(rendered, "text/html").querySelector("iframe");
  assert.equal(frame.getAttribute("sandbox"), "");
  assert.equal(frame.getAttribute("referrerpolicy"), "no-referrer");
});

await test("受限 HTML 仅保留内联脚本、内联样式和本地数据资源", () => {
  const result = buildSafeHtmlSrcdoc(
    '<style>button{color:red}</style><style>@import "https://example.com/a.css"</style><button id="score" onclick="attack()">0</button><script>document.querySelector("#score").addEventListener("click",()=>document.querySelector("#score").textContent="1")</script><script src="https://example.com/a.js"></script><script type="module">import "https://example.com/a.js"</script><img src="data:image/png;base64,AA=="><img src="https://example.com/a.png"><iframe srcdoc="attack"></iframe><object data="https://example.com/a"></object>',
    { background: "#ffffff", foreground: "#111111", border: "#dddddd" },
    { allowScripts: true },
  );
  const parsed = new DOMParser().parseFromString(result, "text/html");
  assert.equal(parsed.querySelectorAll("script").length, 1);
  assert.match(parsed.querySelector("script")?.textContent ?? "", /addEventListener/);
  assert.equal(parsed.querySelector("iframe"), null);
  assert.equal(parsed.querySelector("object"), null);
  assert.equal(parsed.querySelector("button")?.hasAttribute("onclick"), false);
  assert.equal(parsed.querySelector("img")?.getAttribute("src"), "data:image/png;base64,AA==");
  assert.ok(!result.includes("url(") && !result.includes("@import"));
  const policy = parsed.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute("content") ?? "";
  for (const directive of [
    "connect-src 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "script-src 'unsafe-inline'",
  ]) {
    assert.ok(policy.includes(directive), policy);
  }
  const rendered = renderToStaticMarkup(
    React.createElement(SafeHtmlPreview, { content: "<h1>游戏</h1>", title: "游戏", allowScripts: true }),
  );
  const frame = new DOMParser().parseFromString(rendered, "text/html").querySelector("iframe");
  assert.equal(frame.getAttribute("sandbox"), "allow-scripts");
  assert.ok(!frame.getAttribute("sandbox").includes("allow-same-origin"));
});

await test("隔离壳禁止新导航并保留内层本地 DOM 行为", () => {
  const rendered = renderToStaticMarkup(
    React.createElement(SafeHtmlPreview, {
      content: '<body><script>document.body.dataset.scriptRan = "true"</script></body>',
      title: "游戏",
      allowScripts: true,
    }),
  );
  const outer = new DOMParser().parseFromString(rendered, "text/html").querySelector("iframe");
  const shell = new DOMParser().parseFromString(outer.getAttribute("srcdoc"), "text/html");
  const policy = shell.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute("content") ?? "";
  assert.ok(policy.includes("frame-src 'none'"), policy);
  assert.ok(policy.includes("default-src 'none'"), policy);
  const inner = shell.querySelector("iframe");
  assert.equal(inner?.getAttribute("sandbox"), "allow-scripts");
  assert.ok(!inner?.getAttribute("sandbox").includes("allow-same-origin"));
  const game = new JSDOM(inner.getAttribute("srcdoc"), { runScripts: "dangerously" });
  try {
    assert.equal(game.window.document.body.dataset.scriptRan, "true");
  } finally {
    game.window.close();
  }
});

await test("静态 HTML 保持无脚本单层预览", () => {
  const rendered = renderToStaticMarkup(
    React.createElement(SafeHtmlPreview, {
      content: '<h1>保留静态正文</h1><script>document.body.dataset.scriptRan = "true"</script>',
      title: "报告",
    }),
  );
  const frame = new DOMParser().parseFromString(rendered, "text/html").querySelector("iframe");
  assert.equal(frame.getAttribute("sandbox"), "");
  assert.ok(!frame.getAttribute("srcdoc").includes("<script"));
  assert.ok(!frame.getAttribute("srcdoc").includes("<iframe"));
  assert.ok(frame.getAttribute("srcdoc").includes("保留静态正文"));
  assert.ok(frame.getAttribute("srcdoc").includes("script-src 'none'"));
});

await test("HTML 预览尊重作者颜色且未声明样式时使用中立白底黑字", () => {
  const darkTheme = { background: "#111111", foreground: "#eeeeee", border: "#333333" };
  const lightTheme = { background: "#ffffff", foreground: "#111111", border: "#dddddd" };
  const source = "<style>body{background:#10263f;color:#f2d16b}</style><p>作者深色页面</p>";
  for (const theme of [darkTheme, lightTheme]) {
    const rendered = new JSDOM(buildSafeHtmlSrcdoc(source, theme, { allowScripts: true }));
    const body = rendered.window.getComputedStyle(rendered.window.document.body);
    assert.equal(body.backgroundColor, "rgb(16, 38, 63)");
    assert.equal(body.color, "rgb(242, 209, 107)");
    const styles = rendered.window.document.querySelectorAll("style");
    assert.ok(styles[0].textContent.includes("#ffffff"), "中立基础规则应先于作者规则");
    assert.ok(styles[styles.length - 1].textContent.includes("#10263f"), "作者规则应最后生效");
    rendered.window.close();
  }
  const plain = new JSDOM(buildSafeHtmlSrcdoc("<p>未声明样式的正文</p>", darkTheme));
  const body = plain.window.getComputedStyle(plain.window.document.body);
  assert.equal(body.backgroundColor, "rgb(255, 255, 255)");
  assert.equal(body.color, "rgb(17, 17, 17)");
  plain.window.close();
});

await test("HTML 文件可以切换代码和受限预览且不重新读文件", async () => {
  const originalInvoke = window.__TAURI_INTERNALS__.invoke;
  const source =
    '<!doctype html><html><body><button id="score">0</button><script>document.querySelector("#score").addEventListener("click",()=>document.querySelector("#score").textContent="1")</script></body></html>';
  let chunkReads = 0;
  window.__TAURI_INTERNALS__.invoke = async (command, args = {}) => {
    if (command === "agent_preview_resolve_path")
      return { verdict: "in", resolved: "F:/ws/game.html", exists: true, isDir: false };
    if (command === "agent_workspace_stat")
      return { resolved: "F:/ws/game.html", exists: true, isDirectory: false, size: source.length, modifiedMs: 1 };
    if (command === "agent_workspace_read_chunk") {
      chunkReads += 1;
      return {
        resolved: "F:/ws/game.html",
        content: source,
        nextOffset: source.length,
        truncated: false,
        binary: false,
        totalSize: source.length,
        modifiedMs: 1,
      };
    }
    return originalInvoke(command, args);
  };
  const host = document.createElement("div");
  document.body.appendChild(host);
  const view = createRoot(host);
  try {
    await act(async () => {
      view.render(
        React.createElement(FilePreview, {
          tab: { path: "F:/ws/game.html", rootResolved: "F:/ws", scope: "reader", title: "game.html" },
          refreshToken: 0,
          onRefresh: () => {},
        }),
      );
    });
    for (
      let attempt = 0;
      attempt < 100 && host.querySelector('[data-region="file-preview"]')?.dataset.status !== "ready";
      attempt += 1
    ) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    }
    assert.equal(host.querySelector('[data-region="file-preview"]')?.dataset.status, "ready", host.textContent);
    const codeButton = host.querySelector('[aria-label="查看 HTML 代码"]');
    assert.ok(codeButton, host.textContent);
    await act(async () => codeButton.dispatchEvent(new window.MouseEvent("click", { bubbles: true })));
    assert.equal(host.querySelector("iframe"), null);
    assert.match(host.textContent, /addEventListener/);
    const previewButton = host.querySelector('[aria-label="预览 HTML"]');
    await act(async () => previewButton.dispatchEvent(new window.MouseEvent("click", { bubbles: true })));
    assert.equal(host.querySelector("iframe")?.getAttribute("sandbox"), "allow-scripts");
    assert.equal(chunkReads, 1, "切换不能重新读取源文件");
  } finally {
    window.__TAURI_INTERNALS__.invoke = originalInvoke;
    await act(async () => view.unmount());
    host.remove();
  }
});

await test("Markdown 复用 chat-md 主题与表格渲染", () => {
  const html = renderToStaticMarkup(
    React.createElement(MarkdownPreview, { content: "# 标题\n\n**粗体**\n\n| A | B |\n| --- | --- |\n| 1 | 2 |" }),
  );
  const rendered = new DOMParser().parseFromString(html, "text/html");
  assert.ok(rendered.querySelector(".chat-md"));
  assert.equal(rendered.querySelector("strong")?.textContent, "粗体", html);
  assert.ok(rendered.querySelector("table"), html);
});

await test("Shiki 实际输出着色节点而非单色 pre", async () => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const view = createRoot(host);
  await act(async () => {
    view.render(
      React.createElement(CodeBlockCode, { code: "const answer = 42;", language: "ts", theme: "github-light" }),
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 200));
  });
  assert.ok(host.querySelector("code").innerHTML.includes("style="));
  assert.ok(host.textContent.includes("const answer = 42;"));
  assert.ok(
    host.querySelector("div").className.includes("leading-[1.45]"),
    "代码行高必须被约束为紧凑的 1.45，不能继承过宽的正文行高",
  );
  await act(async () => view.unmount());
  host.remove();
});

await test("不支持的语言回退纯文本且不产生未处理拒绝", async () => {
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(String(reason));
  process.on("unhandledRejection", onUnhandled);
  const host = document.createElement("div");
  document.body.appendChild(host);
  const view = createRoot(host);
  try {
    await act(async () => {
      view.render(
        React.createElement(CodeBlockCode, {
          code: "plain fallback",
          language: "sageread-unsupported",
          theme: "github-light",
        }),
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
    });
    assert.equal(host.querySelector("code")?.textContent, "plain fallback");
    assert.deepEqual(unhandled, []);
  } finally {
    process.removeListener("unhandledRejection", onUnhandled);
    await act(async () => view.unmount());
    host.remove();
  }
});

await test("目录首次渲染没有最近记录时不会循环更新", async () => {
  const { FileExplorer, useFileWorkspaceStore } = api;
  const originalInvoke = window.__TAURI_INTERNALS__.invoke;
  const originalError = console.error;
  const consoleErrors = [];
  window.__TAURI_INTERNALS__.invoke = async (command) => {
    if (command === "plugin:path|resolve_directory") return tmpdir();
    if (command.startsWith("plugin:store|")) return null;
    if (command === "plugin:fs|exists") return false;
    return new Promise(() => {});
  };
  console.error = (...args) => consoleErrors.push(args.map(String).join(" "));
  useFileWorkspaceStore.setState({ hosts: {}, recentRoots: {} });
  class Boundary extends React.Component {
    state = { error: null };
    static getDerivedStateFromError(error) {
      return { error };
    }
    render() {
      return this.state.error ? React.createElement("output", null, this.state.error.message) : this.props.children;
    }
  }
  const host = document.createElement("div");
  document.body.appendChild(host);
  const view = createRoot(host);
  let boundary;
  try {
    await act(async () => {
      view.render(
        React.createElement(
          Boundary,
          {
            ref: (value) => {
              boundary = value;
            },
          },
          React.createElement(FileExplorer, {
            scope: "reader",
            root: { configured: "C:/workspace-test", resolved: "C:/workspace-test" },
            currentPath: "C:/workspace-test",
            refreshToken: 0,
            onOpenFile: () => {},
            onNavigate: () => {},
            onChangeRoot: async () => {},
            onResetRoot: async () => {},
          }),
        ),
      );
    });
    assert.ok(boundary);
    assert.equal(boundary.state.error, null, boundary.state.error?.stack ?? consoleErrors[0]);
    assert.deepEqual(consoleErrors, []);
  } finally {
    console.error = originalError;
    window.__TAURI_INTERNALS__.invoke = originalInvoke;
    await act(async () => view.unmount());
    host.remove();
  }
});

console.log(`\n结果：${passed} passed, ${failed} failed`);
window.close();
for (const channel of channels) {
  for (const port of [channel.port1, channel.port2]) {
    port.unref();
    port.close();
  }
}
globalThis.MessageChannel = NativeMessageChannel;
process.exit(failed === 0 ? 0 : 1);
