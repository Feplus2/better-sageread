import { mkdirSync, writeFileSync } from "node:fs";
import { connectPreview } from "../.superpowers/sdd/2026-11-07-user-feedback/cdp-client.mjs";
import { appModuleExpression } from "../.superpowers/sdd/2026-11-07-user-feedback/cdp-app-module.mjs";

const outDir = ".superpowers/sdd/2026-11-07-user-feedback/tencent-ui";
mkdirSync(outDir, { recursive: true });
const { ws, call, evaluate } = await connectPreview();
const waitFor = async (expression, label) => {
  for (let index = 0; index < 100; index += 1) {
    if (await evaluate(`(async () => Boolean(await (${expression})))()`)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const detail = await evaluate(`({ panel: document.querySelector('[data-region="settings-panel"]')?.textContent.slice(0, 3200), nav: document.querySelector('[data-region="settings-panel"] nav')?.textContent })`);
  console.log(JSON.stringify({ label, detail }, null, 2));
  throw new Error(`等待超时：${label}`);
};
const click = async (expression, label) => {
  const clicked = await evaluate(`(() => {
    const element = ${expression};
    if (!element) return false;
    element.scrollIntoView({ block: "center" });
    if (element instanceof SVGElement) element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    else element.click();
    return true;
  })()`);
  if (!clicked) throw new Error(`找不到可点击元素：${label}`);
};
try {
  await click(`Array.from(document.querySelectorAll("button")).find((button) => button.querySelector("svg.lucide-settings") && !button.closest("[inert]") && button.getBoundingClientRect().width > 0)`, "设置");
  await waitFor(`document.querySelector('[data-region="settings-panel"]')`, "设置面板");
  await click(`Array.from(document.querySelectorAll('[data-region="settings-panel"] nav button')).find((button) => button.textContent.includes("模型提供商"))`, "模型提供商");
  await waitFor(`document.querySelector('[data-region="settings-panel"]')?.textContent.includes("腾讯混元")`, "腾讯混元入口");
  await click(`Array.from(document.querySelectorAll('[data-region="settings-panel"] span')).find((span) => span.textContent.trim() === "腾讯混元" && !span.closest("nav"))?.closest(".pt-2")?.querySelector("button")`, "腾讯混元详情");
  await waitFor(`document.querySelector('[data-region="settings-panel"]')?.textContent.includes("hy4")`, "Hy4 模型");
  await click(`document.querySelector('[data-region="settings-panel"] svg.lucide-refresh-ccw')?.closest("button")`, "刷新模型目录");
  await waitFor(`(async () => {
    const provider = (await import(${appModuleExpression("/src/store/provider-store.ts")})).useProviderStore.getState().modelProviders.find((item) => item.provider === "tencent");
    const model = provider?.models.find((item) => item.id === "hy4");
    return model?.contextWindow === 1024000 && model?.maxOutputTokens === 64000;
  })()`, "真实目录预算");
  const evidence = await evaluate(`(async () => {
    const provider = (await import(${appModuleExpression("/src/store/provider-store.ts")})).useProviderStore.getState().modelProviders.find((item) => item.provider === "tencent");
    return { hasTencent: document.querySelector('[data-region="settings-panel"]')?.textContent.includes("腾讯混元"), hasHy4: document.querySelector('[data-region="settings-panel"]')?.textContent.includes("hy4"), active: provider?.active, contextWindow: provider?.models.find((model) => model.id === "hy4")?.contextWindow, maxOutputTokens: provider?.models.find((model) => model.id === "hy4")?.maxOutputTokens, catalogRefreshed: true };
  })()`);
  writeFileSync(`${outDir}/report.json`, JSON.stringify({ ...evidence, action: "展开设置并刷新模型目录；未切换启用状态或主模型，未编辑凭据" }, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
  if (!evidence.hasTencent || !evidence.hasHy4 || evidence.active !== false || evidence.contextWindow !== 1024000 || evidence.maxOutputTokens !== 64000) throw new Error("腾讯 UI、启用状态或模型预算不符合预期");
} finally {
  await call("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await call("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }).catch(() => {});
  ws.close();
}
console.log("PASS 腾讯混元与 Hy4 在实际设置页可见，未改动启用状态或模型选择");
