import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";

const root = fileURLToPath(new URL("../", import.meta.url));
const src = join(root, "packages/app/src");
const esbuildPkg = readdirSync(join(root, "node_modules", ".pnpm")).find((name) => name.startsWith("esbuild@"));
assert.ok(esbuildPkg);
const esbuild = await import(
  pathToFileURL(join(root, "node_modules", ".pnpm", esbuildPkg, "node_modules", "esbuild", "lib", "main.js")).href
);
const outDir = mkdtempSync(join(tmpdir(), "transport-workspace-root-"));
const tauriStub = join(outDir, "tauri.ts");
const mcpStub = join(outDir, "mcp.ts");
const aiStub = join(outDir, "ai.ts");
const registryStub = join(outDir, "registry.ts");
const utilsStub = join(outDir, "utils.ts");
const promptStub = join(outDir, "prompt.ts");
const lazyStub = join(outDir, "lazy.ts");
const fsStub = join(outDir, "fs.ts");
const entry = join(outDir, "entry.ts");
const outfile = join(outDir, "bundle.mjs");
globalThis.__workspaceCalls = [];
globalThis.__workspaceInstructions = [];
globalThis.__workspaceToolErrors = [];
const calls = globalThis.__workspaceCalls;
const instructions = globalThis.__workspaceInstructions;
const toolErrors = globalThis.__workspaceToolErrors;

writeFileSync(
  tauriStub,
  `export class Channel {}
  export const invoke = async (command, args) => {
    globalThis.__workspaceCalls.push({ command, args });
    if (command === "agent_resolve_path") return { verdict: "in", resolved: args.root + "/first.txt", exists: false, isDir: false };
    if (command === "agent_preview_resolve_path") return { verdict: "in", resolved: args.path === "." ? args.root : args.root + "/first.txt", exists: true, isDir: args.path === "." };
    if (command === "agent_write_file") return { resolved: args.root + "/first.txt", bytes: 5, created: true };
    if (command === "agent_read_file") return { content: "1\\t" + args.root };
    if (command === "app_config_dir") return ${JSON.stringify(outDir.replace(/\\/g, "/"))};
    throw new Error("unexpected native command: " + command);
  };
  export const appDataDir = async () => ${JSON.stringify(outDir.replace(/\\/g, "/"))};
  export const appConfigDir = appDataDir;`,
);
writeFileSync(
  mcpStub,
  `export const getMcpToolsForScope = async () => {
    globalThis.__workspaceTaskStore.getState().setTaskWorkspaceRoot("central", null, "F:/later-b");
    globalThis.__workspaceAgentSettings.getState().setWorkspaceRoot("F:/later-b");
    return { tools: {}, failures: [], closeAll: async () => {} };
  };
  export const parseMcpToolName = (name) => name.startsWith("mcp_")
    ? { serverKey: name.slice(4).split("_")[0], originalTool: name.slice(4).split("_").slice(1).join("_") }
    : null;`,
);
writeFileSync(
  aiStub,
  `export const tool = (definition) => definition;
  export const convertToModelMessages = async (messages) => messages;
  export const isStepCount = () => () => false;
  export const streamText = (options) => {
    globalThis.__workspaceInstructions.push(options.instructions);
    return {
      toUIMessageStream: () => {
        void options.tools.writeFile.execute(
          { path: "first.txt", content: "first", reasoning: "验证请求根" },
          { toolCallId: "workspace-fixture", messages: [] },
        ).catch((error) => globalThis.__workspaceToolErrors.push(String(error)));
        return new ReadableStream({ start(controller) { controller.close(); } });
      },
    };
  };`,
);
writeFileSync(
  fsStub,
  `export const BaseDirectory = {};
  export class Resource {}
  export class Channel {}
  export const readTextFile = async () => null;
  export const writeTextFile = async () => {};
  export const readFile = async () => new Uint8Array();
  export const writeFile = async () => {};
  export const exists = async () => false;
  export const mkdir = async () => {};
  export const readDir = async () => [];`,
);
writeFileSync(
  registryStub,
  `import { writeFileTool } from "@/ai/tools/central/write-file"; export const getToolsForScope = () => ({ writeFile: writeFileTool });`,
);
writeFileSync(
  utilsStub,
  `export { loadWorkspaceSection, loadMemorySection } from "@/ai/utils/workspace-context";
  export const adaptToolHistoryForRequest = (messages) => messages;
  export const processQuoteMessages = (messages) => messages;
  export const resolveImageAttachmentsForRequest = async (messages) => messages;
  export const sanitizeLegacyMcpHistoryImages = (messages) => messages;
  export const sanitizeMessageParts = (messages) => messages;
  export const selectMessagesWithinBudget = (messages) => ({ kept: messages, dropped: [] });
  export const stripFileParts = (messages) => messages;
  export const withUnavailableDynamicHistoryStubs = (messages) => messages;`,
);
writeFileSync(
  promptStub,
  `export const buildPrompt = async () => "base"; export const compressDroppedIntoSummary = async () => null;`,
);
writeFileSync(
  lazyStub,
  `export const buildLazyToolset = (tools) => tools; export const buildToolDirectoryBoard = () => ""; export const shouldUseDirectoryMode = () => false;`,
);
writeFileSync(
  entry,
  [
    `export { CustomChatTransport } from "${join(src, "ai/custom-chat-transport.ts").replace(/\\/g, "/")}";`,
    `export { useTaskWorkspaceStore } from "${join(src, "store/task-workspace-store.ts").replace(/\\/g, "/")}";`,
    `export { useAgentSettingsStore } from "${join(src, "store/agent-settings-store.ts").replace(/\\/g, "/")}";`,
  ].join("\n"),
);
await esbuild.build({
  entryPoints: [entry],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile,
  logLevel: "silent",
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  alias: { "@": src },
  plugins: [
    {
      name: "transport-boundaries",
      setup(build) {
        build.onResolve({ filter: /^@tauri-apps\/api\/(core|path)$/ }, () => ({ path: tauriStub }));
        build.onResolve({ filter: /^@tauri-apps\/plugin-fs$/ }, () => ({ path: fsStub }));
        build.onResolve({ filter: /mcp-manager$/ }, () => ({ path: mcpStub }));
        build.onResolve({ filter: /^ai$/ }, () => ({ path: aiStub }));
        build.onResolve({ filter: /tools\/registry$/ }, () => ({ path: registryStub }));
        build.onResolve({ filter: /^\.\/utils$/ }, () => ({ path: utilsStub }));
        build.onResolve({ filter: /constants\/prompt$/ }, () => ({ path: promptStub }));
        build.onResolve({ filter: /conversation-summary-service$/ }, () => ({ path: promptStub }));
        build.onResolve({ filter: /lazy-toolset$/ }, () => ({ path: lazyStub }));
      },
    },
  ],
});

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
for (const key of [
  "window",
  "document",
  "navigator",
  "localStorage",
  "sessionStorage",
  "Node",
  "Element",
  "HTMLElement",
  "Text",
  "MutationObserver",
  "CustomEvent",
]) {
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true, writable: true });
}
globalThis.__SAGEREAD_DISABLE_DIRECTORY__ = true;
const { CustomChatTransport, useTaskWorkspaceStore, useAgentSettingsStore } = await import(pathToFileURL(outfile).href);
globalThis.__workspaceTaskStore = useTaskWorkspaceStore;
globalThis.__workspaceAgentSettings = useAgentSettingsStore;

let passed = 0;
let failed = 0;
async function test(name, snapshot) {
  try {
    calls.length = 0;
    instructions.length = 0;
    toolErrors.length = 0;
    const task = useTaskWorkspaceStore.getState();
    const agent = useAgentSettingsStore.getState();
    useTaskWorkspaceStore.setState({ pendingRoots: {}, threadRoots: {} });
    agent.setWorkspaceRoot("F:/default-a");
    agent.setPerAgentRoot("central", null);
    agent.setSafetyMode("full");
    if (snapshot !== null) task.setTaskWorkspaceRoot("central", null, "F:/initial-c");
    const transport = new CustomChatTransport({}, { scopeHint: "central" });
    await transport.sendMessages({
      chatId: "request-root-fixture",
      messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "hello" }] }],
      abortSignal: undefined,
      trigger: "submit-message",
      messageId: undefined,
      body: { chatContext: { agentScope: "central", workspaceHostId: "central", workspaceRootOverride: snapshot } },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const expected = snapshot ?? "F:/default-a";
    assert.ok(
      instructions.every((text) => text.includes(expected)),
      JSON.stringify({ expected, instructions }),
    );
    for (const command of ["agent_resolve_path", "agent_write_file", "agent_read_file"]) {
      assert.ok(
        calls.some((call) => call.command === command && call.args.root === expected),
        JSON.stringify({ command, expected, calls }),
      );
    }
    assert.ok(
      calls.every((call) => call.args.root !== "F:/later-b"),
      JSON.stringify(calls),
    );
    assert.deepEqual(toolErrors, []);
    passed++;
    console.log(`PASS ${name}`);
  } catch (error) {
    failed++;
    console.error(`FAIL ${name} — ${error instanceof Error ? error.stack : String(error)}`);
  }
}

await test("显式任务根快照不被后续 pending 或共享根变化覆盖", "F:/once-a");
await test("空快照只使用请求开始时的默认根，不吸收后续 pending", null);
console.log(`\n结果：${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
