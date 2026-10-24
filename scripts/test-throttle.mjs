// throttle 假时间回归 + Provider 设置端点原子提交回归。
// 运行：node scripts/test-throttle.mjs
import { existsSync, mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

const root = fileURLToPath(new URL("../", import.meta.url));
const src = join(root, "packages/app/src");
const pnpmDir = join(root, "node_modules", ".pnpm");
const esbuildPkg = readdirSync(pnpmDir).find((d) => d.startsWith("esbuild@"));
if (!esbuildPkg) {
  console.error("FAIL 未找到 esbuild");
  process.exit(1);
}
const esbuild = await import(
  pathToFileURL(join(pnpmDir, esbuildPkg, "node_modules", "esbuild", "lib", "main.js")).href
);

const outDir = mkdtempSync(join(tmpdir(), "throttle-settings-"));
const entry = join(outDir, "entry.ts");
const posix = (p) => p.replace(/\\/g, "/");
writeFileSync(
  entry,
  [
    `export { throttle } from "${posix(join(src, "utils/throttle.ts"))}";`,
    `export { default as ApiConfigSection } from "${posix(join(src, "components/settings/api-config-section.tsx"))}";`,
    `export { default as ProviderDetailSettings } from "${posix(join(src, "components/settings/provider-detail.tsx"))}";`,
    `export { createElement } from "react";`,
    `export { renderToStaticMarkup } from "react-dom/server";`,
  ].join("\n"),
);

const nullComponent = (name) => `export function ${name}() { return null; }`;
const stubs = new Map([
  ["@/components/ui/button", nullComponent("Button")],
  ["@/components/ui/input", nullComponent("Input")],
  ["@/components/ui/label", nullComponent("Label")],
  ["@/components/ui/switch", nullComponent("Switch")],
  [
    "@/components/ui/select",
    ["Select", "SelectContent", "SelectItem", "SelectTrigger", "SelectValue"]
      .map((name) => nullComponent(name))
      .join("\n"),
  ],
  ["./secret-input", "export default function SecretInput() { return null; }"],
  [
    "./api-config-section",
    "export default function ApiConfigSection(props) { globalThis.__apiConfigProps = props; return null; }",
  ],
  ["./models-management", "export default function ModelsManagement(props) { globalThis.__modelsManagementProps = props; return null; }"],
  ["./settings-dialog", nullComponent("ProviderIcons")],
  ["@/store/provider-store", "export const useProviderStore = () => globalThis.__providerStoreState;"],
  [
    "@/services/provider-service",
    "export async function fetchModelCatalog(...args) { globalThis.__catalogArgs = args; return []; } export async function filterChatModels() { return []; }",
  ],
  ["@tauri-apps/plugin-dialog", "export async function ask() { return false; }"],
  ["sonner", "export const toast = { info() {} };"],
  ["lucide-react", `${nullComponent("Pencil")}\n${nullComponent("Trash2")}`],
]);
const stubPlugin = {
  name: "throttle-settings-stubs",
  setup(build) {
    build.onResolve({ filter: /^@\/(.*)/ }, (args) => {
      if (stubs.has(args.path)) return { path: args.path, namespace: "settings-stub" };
      const base = join(src, args.path.slice(2));
      for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}.mjs`, join(base, "index.ts")]) {
        if (existsSync(candidate) && statSync(candidate).isFile()) return { path: candidate };
      }
      return { path: `${base}.ts` };
    });
    build.onResolve(
      { filter: /^\.\/(?:secret-input|api-config-section|models-management|settings-dialog)$/ },
      (args) => (stubs.has(args.path) ? { path: args.path, namespace: "settings-stub" } : undefined),
    );
    build.onResolve({ filter: /^(?:@tauri-apps\/plugin-dialog|sonner|lucide-react)$/ }, (args) =>
      stubs.has(args.path) ? { path: args.path, namespace: "settings-stub" } : undefined,
    );
    build.onLoad({ filter: /.*/, namespace: "settings-stub" }, (args) => ({
      contents: stubs.get(args.path),
      loader: "js",
    }));
  },
};

const outfile = join(outDir, "throttle-settings.mjs");
await esbuild.build({
  entryPoints: [entry],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile,
  jsx: "automatic",
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  nodePaths: [join(root, "packages/app/node_modules")],
  plugins: [stubPlugin],
});
const lib = await import(pathToFileURL(outfile).href);

let passed = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  PASS ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}

function runWithFakeClock(start, run) {
  const originalNow = Date.now;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  let now = start;
  let nextId = 1;
  const timers = new Map();
  Date.now = () => now;
  globalThis.setTimeout = (callback, delay = 0, ...args) => {
    const id = nextId++;
    timers.set(id, { id, at: now + Number(delay), callback, args });
    return id;
  };
  globalThis.clearTimeout = (id) => timers.delete(id);
  const advance = (milliseconds) => {
    const target = now + milliseconds;
    while (true) {
      const next = [...timers.values()]
        .filter((timer) => timer.at <= target)
        .sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!next) break;
      now = next.at;
      timers.delete(next.id);
      next.callback(...next.args);
    }
    now = target;
  };
  try {
    run({ advance });
  } finally {
    Date.now = originalNow;
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
}

console.log("[1] throttle leading / trailing");
runWithFakeClock(1_000, (clock) => {
  const calls = [];
  const throttled = lib.throttle((channel, value) => calls.push({ channel, value, at: Date.now() }), 100);
  throttled("leading", "A0");
  clock.advance(50);
  throttled("middle", "A1");
  clock.advance(40);
  throttled("latest", "A2");
  clock.advance(9);
  check("冷却期未到 trailing 时刻时不提前调用", calls.length === 1, calls);
  clock.advance(1);
  check(
    "trailing 只执行最后一组参数",
    isDeepStrictEqual(calls, [
      { channel: "leading", value: "A0", at: 1_000 },
      { channel: "latest", value: "A2", at: 1_100 },
    ]),
    calls,
  );
  throttled("after", "A3");
  check("trailing 后不背靠背立即执行", calls.length === 2, calls);
  clock.advance(99);
  check("新的冷却期内仍不提前调用", calls.length === 2, calls);
  clock.advance(1);
  check(
    "后续 trailing 从上一次实际调用重新计时",
    isDeepStrictEqual(calls.at(-1), { channel: "after", value: "A3", at: 1_200 }),
    calls,
  );
});

runWithFakeClock(5_000, (clock) => {
  const calls = [];
  const throttled = lib.throttle((value) => calls.push({ value, at: Date.now() }), 100, { emitLast: false });
  throttled("first");
  clock.advance(25);
  throttled("stale");
  clock.advance(200);
  check("emitLast:false 不补发冷却期参数", isDeepStrictEqual(calls, [{ value: "first", at: 5_000 }]), calls);
  throttled("fresh");
  clock.advance(25);
  throttled("also-suppressed");
  clock.advance(200);
  check(
    "emitLast:false 后续窗口也无陈旧调用",
    isDeepStrictEqual(calls, [
      { value: "first", at: 5_000 },
      { value: "fresh", at: 5_225 },
    ]),
    calls,
  );
});

runWithFakeClock(8_000, (clock) => {
  const calls = [];
  const throttled = lib.throttle((updates) => calls.push({ updates, at: Date.now() }), 100, {
    emitLast: true,
    mergeArgs: (previous, next) => [{ ...previous[0], ...next[0] }],
  });
  throttled({ baseUrl: "https://first.example/v1" });
  clock.advance(25);
  throttled({ apiStyle: "anthropic-messages" });
  clock.advance(25);
  throttled({ baseUrl: "https://latest.example/v1" });
  clock.advance(50);
  check(
    "opt-in merge 合并同 cooldown 不同字段且同字段取最新",
    isDeepStrictEqual(calls.at(-1), {
      updates: { apiStyle: "anthropic-messages", baseUrl: "https://latest.example/v1" },
      at: 8_100,
    }),
    calls,
  );
});

const ZHIPU_CHAT = "https://open.bigmodel.cn/api/paas/v4";
const ZHIPU_ANTHROPIC = "https://open.bigmodel.cn/api/anthropic/v1";
const makeProvider = (baseUrl = ZHIPU_CHAT) => ({
  name: "智谱 GLM",
  active: true,
  provider: "zhipu",
  apiKey: "",
  apiStyle: "openai-chat",
  baseUrl,
  endpoints: {
    "openai-chat": ZHIPU_CHAT,
    "anthropic-messages": ZHIPU_ANTHROPIC,
  },
  models: [],
});
function findElement(node, predicate) {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElement(child, predicate);
      if (found) return found;
    }
    return null;
  }
  if (!node || typeof node !== "object") return null;
  if (predicate(node)) return node;
  return findElement(node.props?.children, predicate);
}
function captureApiConfig(provider) {
  const updates = [];
  const tree = lib.ApiConfigSection({
    provider,
    onFieldsChange: (partial) => updates.push(partial),
    onFieldChange: (field, value) => updates.push({ [field]: value }),
  });
  return { tree, updates };
}

console.log("[2] 端点协议与地址原子提交");
const switched = captureApiConfig(makeProvider());
const endpointSelect = findElement(
  switched.tree,
  (node) => node.props?.value === "openai-chat" && typeof node.props?.onValueChange === "function",
);
if (endpointSelect) endpointSelect.props.onValueChange("anthropic-messages");
check(
  "切换端点一次提交 apiStyle + baseUrl",
  isDeepStrictEqual(switched.updates, [{ apiStyle: "anthropic-messages", baseUrl: ZHIPU_ANTHROPIC }]),
  switched.updates,
);

const reset = captureApiConfig(makeProvider("https://relay.example.com/v1"));
const resetButton = findElement(
  reset.tree,
  (node) => node.props?.children === "恢复预置端点" && typeof node.props?.onClick === "function",
);
if (resetButton) resetButton.props.onClick();
check(
  "恢复预置端点一次提交 apiStyle + baseUrl",
  isDeepStrictEqual(reset.updates, [{ apiStyle: "openai-chat", baseUrl: ZHIPU_CHAT }]),
  reset.updates,
);

console.log("[3] ProviderDetail 单字段与端点共用节流队列");
runWithFakeClock(20_000, (clock) => {
  const writes = [];
  globalThis.__providerStoreState = {
    modelProviders: [makeProvider()],
    updateProvider: (providerId, updates) => writes.push({ providerId, updates, at: Date.now() }),
    removeProvider: () => {},
  };
  globalThis.__apiConfigProps = null;
  try {
    lib.renderToStaticMarkup(lib.createElement(lib.ProviderDetailSettings, { providerId: "zhipu", onBack() {} }));
    const props = globalThis.__apiConfigProps;
    const changeFields = (updates) => {
      if (props?.onFieldsChange) {
        props.onFieldsChange(updates);
      } else if (props?.onFieldChange) {
        for (const [field, value] of Object.entries(updates)) props.onFieldChange(field, value);
      }
    };
    changeFields({ baseUrl: "https://relay.example.com/v1" });
    check(
      "单字段编辑包装为 partial 并立即写入首个调用",
      isDeepStrictEqual(writes, [
        { providerId: "zhipu", updates: { baseUrl: "https://relay.example.com/v1" }, at: 20_000 },
      ]),
      writes,
    );
    clock.advance(50);
    changeFields({ apiStyle: "anthropic-messages", baseUrl: ZHIPU_ANTHROPIC });
    check("端点更新不绕过节流立即另写", writes.length === 1, writes);
    clock.advance(149);
    check("同一队列的 trailing 尚未到点", writes.length === 1, writes);
    clock.advance(1);
    check(
      "同一队列 trailing 原子保存端点 partial",
      isDeepStrictEqual(writes.at(-1), {
        providerId: "zhipu",
        updates: { apiStyle: "anthropic-messages", baseUrl: ZHIPU_ANTHROPIC },
        at: 20_200,
      }),
      writes,
    );
  } finally {
    globalThis.__providerStoreState = undefined;
    globalThis.__apiConfigProps = undefined;
  }
});

console.log("[4] ProviderDetail 同 cooldown partial 合并");
runWithFakeClock(40_000, (clock) => {
  const writes = [];
  globalThis.__providerStoreState = {
    modelProviders: [makeProvider()],
    updateProvider: (providerId, updates) => writes.push({ providerId, updates, at: Date.now() }),
    removeProvider: () => {},
  };
  globalThis.__apiConfigProps = null;
  try {
    lib.renderToStaticMarkup(lib.createElement(lib.ProviderDetailSettings, { providerId: "zhipu", onBack() {} }));
    const props = globalThis.__apiConfigProps;
    props.onFieldsChange({ baseUrl: "https://first.example/v1" });
    clock.advance(50);
    props.onFieldsChange({ apiStyle: "anthropic-messages" });
    clock.advance(50);
    props.onFieldsChange({ baseUrl: ZHIPU_ANTHROPIC });
    clock.advance(100);
    check(
      "生产 ProviderDetail trailing 合并不同字段且保留端点原子性",
      isDeepStrictEqual(writes.at(-1), {
        providerId: "zhipu",
        updates: { apiStyle: "anthropic-messages", baseUrl: ZHIPU_ANTHROPIC },
        at: 40_200,
      }),
      writes,
    );
  } finally {
    globalThis.__providerStoreState = undefined;
    globalThis.__apiConfigProps = undefined;
  }
});

console.log("[5] ProviderDetail refresh 传递适用的 selected modelId");
{
  const custom = {
    ...makeProvider("https://open.cherryin.net/v1beta"),
    provider: "custom-1",
    apiStyle: "auto",
    apiKey: "test-key",
    models: [{ id: "google/gemini-3-pro", name: "Gemini", active: true }],
  };
  const selectedForProvider = { providerId: "custom-1", providerName: "Custom", modelId: "google/gemini-3-pro", modelName: "Gemini" };
  const selectedOther = { providerId: "deepseek", providerName: "DeepSeek", modelId: "deepseek-flash", modelName: "deepseek-flash" };
  const writes = [];
  globalThis.__providerStoreState = {
    modelProviders: [custom],
    selectedModel: selectedForProvider,
    updateProvider: (providerId, updates) => writes.push({ providerId, updates }),
    removeProvider: () => {},
  };
  try {
    lib.renderToStaticMarkup(lib.createElement(lib.ProviderDetailSettings, { providerId: "custom-1", onBack() {} }));
    globalThis.__catalogArgs = null;
    await globalThis.__modelsManagementProps.onRefreshModels();
    check(
      "刷新所选 provider 时 fetchModelCatalog 第二 arg 为该 provider 的 modelId",
      globalThis.__catalogArgs?.[1] === "google/gemini-3-pro",
      globalThis.__catalogArgs,
    );
    globalThis.__providerStoreState.selectedModel = selectedOther;
    lib.renderToStaticMarkup(lib.createElement(lib.ProviderDetailSettings, { providerId: "custom-1", onBack() {} }));
    globalThis.__catalogArgs = null;
    await globalThis.__modelsManagementProps.onRefreshModels();
    check(
      "选中其他 provider 时不串用 modelId，交由服务回退",
      globalThis.__catalogArgs?.[1] === undefined,
      globalThis.__catalogArgs,
    );
  } finally {
    globalThis.__providerStoreState = undefined;
    globalThis.__modelsManagementProps = undefined;
    globalThis.__catalogArgs = undefined;
  }
}

console.log(`\n结果：${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log("PASS throttle + endpoint updates");
