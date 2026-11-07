import assert from "node:assert/strict";
import { connectPreview } from "../.superpowers/sdd/2026-11-07-user-feedback/cdp-client.mjs";

const { ws, call, evaluate } = await connectPreview();
const waitFor = async (expression, label) => {
  for (let index = 0; index < 100; index += 1) {
    if (await evaluate(`(async () => Boolean(await (${expression})))()`)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`等待超时：${label}`);
};
try {
  await evaluate(`(() => {
    const button = Array.from(document.querySelectorAll("button")).find((button) =>
      button.querySelector("svg.lucide-settings") && !button.closest("[inert]") && button.getBoundingClientRect().width > 0);
    if (!button) throw new Error("找不到设置入口");
    button.click();
  })()`);
  await waitFor(`document.querySelector('[data-region="settings-panel"]')`, "设置面板");
  await evaluate(`(() => {
    const button = Array.from(document.querySelectorAll('[data-region="settings-panel"] nav button'))
      .find((button) => button.textContent.includes("模型提供商"));
    if (!button) throw new Error("找不到模型提供商设置");
    button.click();
  })()`);
  await waitFor(
    `Array.from(document.querySelectorAll('[data-region="settings-panel"] span'))
    .some((span) => span.textContent.trim() === "腾讯混元")`,
    "腾讯混元入口",
  );
  const evidence = await evaluate(`(() => {
    const label = Array.from(document.querySelectorAll('[data-region="settings-panel"] span'))
      .find((span) => span.textContent.trim() === "腾讯混元");
    const icon = label?.closest(".pt-2")?.querySelector("svg");
    return {
      title: icon?.querySelector("title")?.textContent,
      paths: icon?.querySelectorAll("path").length,
      genericServer: Boolean(icon?.classList.contains("lucide-server")),
      color: icon ? getComputedStyle(icon).color : null,
      fills: Array.from(icon?.querySelectorAll("path") ?? []).map((path) => getComputedStyle(path).fill),
    };
  })()`);
  assert.equal(evidence.title, "腾讯混元", JSON.stringify(evidence));
  assert.equal(evidence.paths, 3, JSON.stringify(evidence));
  assert.equal(evidence.genericServer, false);
  assert.ok(evidence.color && evidence.fills.every((fill) => fill === evidence.color), JSON.stringify(evidence));
  console.log("PASS 实际提供商设置页显示腾讯云 SVG", JSON.stringify(evidence));
} finally {
  await call("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await call("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Escape",
    code: "Escape",
    windowsVirtualKeyCode: 27,
  }).catch(() => {});
  ws.close();
}
