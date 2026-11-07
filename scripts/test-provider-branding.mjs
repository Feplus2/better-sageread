import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const src = join(root, "packages/app/src");
const esbuildPkg = readdirSync(join(root, "node_modules", ".pnpm")).find((name) => name.startsWith("esbuild@"));
assert.ok(esbuildPkg);
const esbuild = await import(
  pathToFileURL(join(root, "node_modules", ".pnpm", esbuildPkg, "node_modules", "esbuild", "lib", "main.js")).href
);
const outDir = mkdtempSync(join(tmpdir(), "provider-branding-"));
const posix = (path) => path.replace(/\\/g, "/");
let failed = 0;
async function test(name, run) {
  try {
    await run();
    console.log(`PASS ${name}`);
  } catch (error) {
    failed++;
    console.error(`FAIL ${name} — ${error instanceof Error ? error.message : String(error)}`);
  }
}
async function bundle(name, source) {
  const entry = join(outDir, `${name}.tsx`);
  const outfile = join(outDir, `${name}.mjs`);
  writeFileSync(entry, source);
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
    logLevel: "silent",
  });
  return import(pathToFileURL(outfile).href);
}

await test("Ollama 与 LM Studio 固定在列表末尾且不改变其他顺序", async () => {
  const { orderModelProviders } = await bundle(
    "order",
    `export { orderModelProviders } from "${posix(join(src, "utils/provider-order.ts"))}";`,
  );
  const providers = ["ollama", "custom-a", "lmstudio", "minimax", "stepfun"].map((provider) => ({ provider }));
  const result = orderModelProviders(providers);
  assert.deepEqual(
    result.map((provider) => provider.provider),
    ["custom-a", "minimax", "stepfun", "ollama", "lmstudio"],
  );
  assert.deepEqual(
    providers.map((provider) => provider.provider),
    ["ollama", "custom-a", "lmstudio", "minimax", "stepfun"],
  );
});

await test("MiniMax 与 Step 使用真实品牌 SVG，不再回退通用服务器图标", async () => {
  const { ProviderIcon, React, renderToStaticMarkup } = await bundle(
    "icons",
    `export { ProviderIcon } from "${posix(join(src, "components/provider-icon.tsx"))}";
     export { default as React } from "react";
     export { renderToStaticMarkup } from "react-dom/server";`,
  );
  const minimax = renderToStaticMarkup(React.createElement(ProviderIcon, { providerId: "minimax" }));
  const step = renderToStaticMarkup(React.createElement(ProviderIcon, { providerId: "stepfun" }));
  assert.ok(minimax.includes("<title>MiniMax</title>"), minimax);
  assert.ok(minimax.includes("M11.43 3.92"), "MiniMax 应使用已核对的官方品牌矢量形状");
  assert.ok(step.includes("<title>阶跃星辰 StepFun</title>"), step);
  assert.ok(step.includes("M10,0C4.48"), "Step 应使用官网 step_favicon.svg 的形状");
  assert.ok(!minimax.includes("lucide-server") && !step.includes("lucide-server"));
});

await test("腾讯混元使用真实云品牌 SVG，不再回退通用服务器图标", async () => {
  const { ProviderIcon, React, renderToStaticMarkup } = await bundle(
    "tencent-icon",
    `export { ProviderIcon } from "${posix(join(src, "components/provider-icon.tsx"))}";
     export { default as React } from "react";
     export { renderToStaticMarkup } from "react-dom/server";`,
  );
  const tencent = renderToStaticMarkup(React.createElement(ProviderIcon, { providerId: "tencent" }));
  assert.ok(tencent.includes("<title>腾讯混元</title>"), tencent);
  assert.ok(tencent.includes("M685.3,188.5"), "应使用已核对的腾讯云 SVG 图形，而非通用轮廓");
  assert.ok(tencent.includes('fill="#006EFF"'));
  assert.ok(!tencent.includes("lucide-server"));
});

await test("预置使用国内开放平台与现代协议，Step 不预置订阅专用地址", async () => {
  const { predefinedProviders } = await bundle(
    "presets",
    `export { predefinedProviders } from "${posix(join(src, "constants/predefined-providers.ts"))}";`,
  );
  const minimax = predefinedProviders.find((provider) => provider.provider === "minimax");
  assert.equal(minimax.apiStyle, "anthropic-messages");
  assert.equal(minimax.baseUrl, "https://api.minimax.cn/anthropic/v1");
  assert.equal(minimax.endpoints["openai-responses"], "https://api.minimax.cn/v1");
  const step = predefinedProviders.find((provider) => provider.provider === "stepfun");
  assert.equal(step.apiStyle, "openai-responses");
  assert.equal(step.baseUrl, "https://api.stepfun.com/v1");
  assert.equal(step.endpoints["anthropic-messages"], "https://api.stepfun.com/v1");
  assert.ok(!JSON.stringify(step).includes("step_plan"));
  assert.deepEqual(
    predefinedProviders.slice(-2).map((provider) => provider.provider),
    ["ollama", "lmstudio"],
  );
});

process.exit(failed ? 1 : 0);
