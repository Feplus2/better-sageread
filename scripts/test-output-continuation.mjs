import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";

const root = fileURLToPath(new URL("../", import.meta.url));
const src = join(root, "packages/app/src");
const pnpmDir = join(root, "node_modules", ".pnpm");
const esbuildPkg = readdirSync(pnpmDir).find((name) => name.startsWith("esbuild@"));
assert.ok(esbuildPkg);
const esbuild = await import(pathToFileURL(join(pnpmDir, esbuildPkg, "node_modules", "esbuild", "lib", "main.js")).href);
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
const { window } = dom;
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
window.getComputedStyle = window.getComputedStyle.bind(window);
globalThis.getComputedStyle = window.getComputedStyle;
globalThis.localStorage = window.localStorage;
globalThis.sessionStorage = window.sessionStorage;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.fetch = async (input) => {
  if (String(input).startsWith("/themes/")) return new Response("");
  throw new Error("本测试不应发起网络请求");
};
window.__TAURI_INTERNALS__ = {
  invoke: async (command, args = {}) => {
    if (command.includes("app_data_dir") || command === "plugin:path|resolve_directory") return "F:/default";
    if (command === "get_skills" || command === "list_prompt_presets") return [];
    if (command === "agent_read_file") return { content: "", totalLines: 0 };
    if (command === "edit_thread") {
      return {
        id: args.payload.id,
        title: args.payload.title ?? "fixture",
        messages: args.payload.messages_json ?? "[]",
      };
    }
    return null;
  },
};
globalThis.__TAURI_INTERNALS__ = window.__TAURI_INTERNALS__;
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
window.requestAnimationFrame = (callback) => setTimeout(() => callback(Date.now()), 16);
window.cancelAnimationFrame = (id) => clearTimeout(id);
globalThis.requestAnimationFrame = window.requestAnimationFrame;
globalThis.cancelAnimationFrame = window.cancelAnimationFrame;
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

const requests = [];
let finishReason = "length";
const streamTextStub = `export function streamText(options) {
  globalThis.__outputStreamOptions.push(options);
  return {
    toUIMessageStream({ messageMetadata }) {
      const finish = { type: "finish", finishReason: globalThis.__outputFinishReason, totalUsage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 } };
      return new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "start" });
          controller.enqueue({ type: "start-step" });
          controller.enqueue({ type: "reasoning-start", id: "reasoning-1" });
          controller.enqueue({ type: "reasoning-delta", id: "reasoning-1", delta: "已有的思考" });
          controller.enqueue({ type: "reasoning-end", id: "reasoning-1" });
          controller.enqueue({ type: "finish-step" });
          controller.enqueue({ type: "finish", ...finish, ...(messageMetadata ? { messageMetadata: messageMetadata({ part: finish }) } : {}) });
          controller.close();
        },
      });
    },
  };
}`;
globalThis.__outputStreamOptions = requests;
globalThis.__outputFinishReason = finishReason;

const aiPackage = readdirSync(pnpmDir).find((name) => name.startsWith("ai@"));
const fsPackage = readdirSync(pnpmDir).find((name) => name.startsWith("@tauri-apps+plugin-fs@"));
assert.ok(aiPackage);
assert.ok(fsPackage);
const actualAiEntry = join(pnpmDir, aiPackage, "node_modules", "ai", "dist", "index.js").replace(/\\/g, "/");
const actualFsEntry = join(pnpmDir, fsPackage, "node_modules", "@tauri-apps", "plugin-fs", "dist-js", "index.js").replace(/\\/g, "/");
const mcpManagerPath = join(src, "ai/mcp/mcp-manager.ts").replace(/\\/g, "/");

const stubs = new Map([
  ["@/lib/tauri-storage", `export const tauriStorage = { getItem: () => null, setItem() {}, removeItem() {} };`],
  [mcpManagerPath, `export async function getMcpToolsForScope() { return { tools: {}, failures: [], closeAll: async () => {} }; }
   export function parseMcpToolName() { return null; }`],
  ["@tauri-apps/api/event", `export async function listen() { return () => {}; }`],
  [
    "@tauri-apps/plugin-fs",
    `export { BaseDirectory } from "actual-tauri-fs";
     export async function exists() { return false; }
     export async function readTextFile() { return ""; }
     export async function readFile() { return new Uint8Array(); }
     export async function mkdir() {}
     export async function readDir() { return []; }
     export async function writeFile() {}
     export async function writeTextFile() {}
     export async function remove() {}
     export async function rename() {}
     export async function copyFile() {}
     export async function stat() { throw new Error("测试环境无此文件"); }
     export async function lstat() { throw new Error("测试环境无此文件"); }`,
  ],
  [
    "@tauri-apps/api/core",
    `export class Resource { constructor(rid) { this.rid = rid; } }
     export class Channel { constructor(onmessage) { this.onmessage = onmessage; } }
     export function convertFileSrc(path) { return path; }
     export function parseMcpToolName() { return null; }
     export async function invoke(command, args = {}) {
      if (command.includes("app_data_dir") || command === "plugin:path|resolve_directory") return "F:/default";
    if (command === "get_skills" || command === "list_prompt_presets") return [];
      if (command === "agent_read_file") return { content: "", totalLines: 0 };
      if (command === "edit_thread") {
        return { id: args.payload.id, title: args.payload.title ?? "fixture", messages: args.payload.messages_json ?? "[]" };
      }
      return null;
    }`,
  ],
  [
    "@tauri-apps/plugin-http",
    `export async function fetch() { throw new Error("本测试不应发起网络请求"); }`,
  ],
]);
const stubPlugin = {
  name: "output-continuation-stubs",
  setup(build) {
    build.onResolve({ filter: /^@\/(.*)/ }, (args) => {
      if (stubs.has(args.path)) return { path: args.path, namespace: "output-stub" };
      const base = join(src, args.path.slice(2));
      for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) {
        if (existsSync(candidate) && statSync(candidate).isFile()) return { path: candidate };
      }
      return { path: `${base}.ts` };
    });
    build.onResolve({ filter: /mcp-manager$/ }, () => ({ path: mcpManagerPath, namespace: "output-stub" }));
    build.onResolve({ filter: /^@tauri-apps\// }, (args) =>
      stubs.has(args.path) ? { path: args.path, namespace: "output-stub" } : undefined,
    );
    build.onResolve({ filter: /^actual-tauri-fs$/ }, () => ({ path: actualFsEntry }));
    build.onResolve({ filter: /^actual-ai$/ }, () => ({ path: actualAiEntry }));
    build.onResolve({ filter: /^ai$/ }, () => ({ path: "ai-stream-stub", namespace: "output-stub" }));
    build.onLoad({ filter: /.*/, namespace: "output-stub" }, (args) => {
      if (args.path === "ai-stream-stub") return { contents: `export * from "actual-ai";\n${streamTextStub}`, loader: "js" };
      return { contents: stubs.get(args.path), loader: "js" };
    });
  },
};

const outDir = mkdtempSync(join(tmpdir(), "output-continuation-"));
const entry = join(outDir, "entry.tsx");
const outfile = join(outDir, "bundle.mjs");
const posix = (path) => path.replace(/\\/g, "/");
writeFileSync(
  entry,
  `export { CustomChatTransport } from "${posix(join(src, "ai/custom-chat-transport.ts"))}";
   export { createModelInstance } from "${posix(join(src, "ai/providers/factory.ts"))}";
   export { useProviderStore } from "${posix(join(src, "store/provider-store.ts"))}";
   export { useChatState } from "${posix(join(src, "hooks/use-chat-state.ts"))}";
   export { default as React, act } from "react";
   export { createRoot } from "react-dom/client";
   export { QueryClient, QueryClientProvider } from "@tanstack/react-query";`,
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
  plugins: [stubPlugin],
  logLevel: "silent",
});
const api = await import(pathToFileURL(outfile).href);
const {
  CustomChatTransport,
  createModelInstance,
  useProviderStore,
  useChatState,
  React,
  act,
  createRoot,
  QueryClient,
  QueryClientProvider,
} = api;
const queryClient = new QueryClient();
const transportTriggers = [];
const originalSendMessages = CustomChatTransport.prototype.sendMessages;
CustomChatTransport.prototype.sendMessages = function (options) {
  transportTriggers.push(options.trigger);
  return originalSendMessages.call(this, options);
};
const model = { providerId: "deepseek", modelId: "deepseek-flash", providerName: "DeepSeek", modelName: "deepseek-flash" };
const provider = {
  provider: "deepseek",
  name: "DeepSeek",
  active: true,
  baseUrl: "https://api.deepseek.com/anthropic/v1",
  apiStyle: "anthropic-messages",
  apiKey: "fixture-not-a-key",
  models: [{ id: "deepseek-flash", name: "deepseek-flash", active: true }],
};
useProviderStore.setState({ selectedModel: model, modelProviders: [provider] });
const transportOptions = {
  chatId: "output-test",
  messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "写一个本地小游戏" }] }],
  abortSignal: undefined,
  trigger: "submit-message",
};
let passed = 0;
let failed = 0;
async function test(name, run) {
  try {
    await run();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${name} — ${error instanceof Error ? (error.stack ?? error) : String(error)}`);
  }
}
const send = async () => {
  const selected = useProviderStore.getState().selectedModel;
  assert.ok(selected);
  const transport = new CustomChatTransport(createModelInstance(selected.providerId, selected.modelId));
  const stream = await transport.sendMessages(transportOptions);
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
};
const waitForReady = async (readState) => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const current = readState();
    const last = current.messages.at(-1);
    if (current.status === "ready" && last?.role === "assistant" && typeof last.metadata?.createdAt === "number") return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  throw new Error(`聊天未在预期时间内完成：${readState().status}`);
};

await test("DeepSeek 未声明输出预算时使用 16384，并保留 length 结束原因", async () => {
  requests.length = 0;
  globalThis.__outputFinishReason = "length";
  const chunks = await send();
  assert.equal(requests[0]?.maxOutputTokens, 16384);
  assert.equal(transportTriggers[0], "submit-message");
  assert.equal(chunks.find((chunk) => chunk.type === "finish")?.messageMetadata?.finishReason, "length");
});

await test("显式输出预算优先，其他提供商不扩大默认行为", async () => {
  useProviderStore.setState({
    selectedModel: model,
    modelProviders: [{ ...provider, models: [{ ...provider.models[0], maxOutputTokens: 8192 }] }],
  });
  requests.length = 0;
  await send();
  assert.equal(requests[0]?.maxOutputTokens, 8192);
  useProviderStore.setState({
    selectedModel: { providerId: "kimi", modelId: "kimi-k3.1-pro" },
    modelProviders: [{ ...provider, provider: "kimi", models: [{ id: "kimi-k3.1-pro", active: true }] }],
  });
  requests.length = 0;
  await send();
  assert.equal(requests[0]?.maxOutputTokens, undefined);
});

await test("length 截断保留原思考，继续生成走新续问而非重跑", async () => {
  useProviderStore.setState({ selectedModel: model, modelProviders: [provider] });
  requests.length = 0;
  globalThis.__outputFinishReason = "length";
  let currentThread = { id: "thread-output", title: "fixture", messages: [] };
  let state;
  function Harness() {
    state = useChatState({
      chatContext: { agentScope: "central", activeBookId: undefined },
      setActiveBookId: () => {},
      currentThread,
      setCurrentThread: (next) => {
        currentThread = next;
      },
    });
    return null;
  }
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(React.createElement(QueryClientProvider, { client: queryClient }, React.createElement(Harness)));
  });
  await act(async () => {
    await state.handleSubmit("写一个本地小游戏");
  });
  await waitForReady(() => state);
  const assistant = state.messages.find((message) => message.role === "assistant");
  assert.equal(assistant?.metadata?.finishReason, "length");
  assert.equal(assistant?.metadata?.interrupted, true, JSON.stringify({ id: assistant?.id, metadata: assistant?.metadata }));
  assert.ok(assistant.parts.some((part) => part.type === "reasoning" && part.text.includes("已有的思考")));
  const previousCount = state.messages.length;
  await act(async () => {
    await state.handleRetry();
  });
  await waitForReady(() => state);
  assert.equal(transportTriggers.at(-1), "submit-message");
  const continuedUser = state.messages.at(-2);
  assert.equal(continuedUser?.role, "user");
  assert.ok(continuedUser.parts.some((part) => part.type === "text" && part.text.includes("继续")));
  assert.ok(state.messages.length > previousCount);
  await act(async () => root.unmount());
  host.remove();
});

await test("普通重试仍走 regenerate，不被续问逻辑改变", async () => {
  useProviderStore.setState({ selectedModel: model, modelProviders: [provider] });
  requests.length = 0;
  globalThis.__outputFinishReason = "stop";
  let currentThread = { id: "thread-normal-retry", title: "fixture", messages: [] };
  let state;
  function Harness() {
    state = useChatState({
      chatContext: { agentScope: "central", activeBookId: undefined },
      setActiveBookId: () => {},
      currentThread,
      setCurrentThread: (next) => {
        currentThread = next;
      },
    });
    return null;
  }
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(React.createElement(QueryClientProvider, { client: queryClient }, React.createElement(Harness))));
  await act(async () => {
    await state.handleSubmit("写一个本地小游戏");
  });
  await waitForReady(() => state);
  await act(async () => {
    await state.handleRetry();
  });
  await waitForReady(() => state);
  assert.equal(transportTriggers.at(-1), "regenerate-message");
  await act(async () => root.unmount());
  host.remove();
});

console.log(`\n结果：${passed} passed, ${failed} failed`);
window.close();
process.exit(failed === 0 ? 0 : 1);
