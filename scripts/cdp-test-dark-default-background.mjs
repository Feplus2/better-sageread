import assert from "node:assert/strict";
import { connectPreview } from "../.superpowers/sdd/2026-11-07-user-feedback/cdp-client.mjs";

const { ws, evaluate } = await connectPreview();
let previous;
const pause = () => new Promise((resolve) => setTimeout(resolve, 100));
const waitFor = async (expression, label) => {
  for (let index = 0; index < 150; index += 1) {
    if (await evaluate(`(async () => Boolean(await (${expression})))()`)) return;
    await pause();
  }
  throw new Error(`等待超时：${label}`);
};
const readEvidence = () =>
  evaluate(`(() => {
  const theme = window.__readerThemeForTest?.();
  const docs = Array.from(document.querySelectorAll("foliate-view"))
    .flatMap((view) => view.renderer?.getContents().map(({ doc }) => doc) ?? []);
  return {
    globalTheme: theme?.globalTheme,
    themeMode: theme?.themeMode,
    themeCodeBg: theme?.themeCode?.bg,
    themeCodeImage: theme?.themeCode?.backgroundImage?.image,
    documents: docs.map((doc) => ({
      backgroundColor: getComputedStyle(doc.documentElement).backgroundColor,
      backgroundImage: getComputedStyle(doc.documentElement).backgroundImage,
      themeColor: getComputedStyle(doc.documentElement).getPropertyValue("--theme-bg-color").trim(),
      scheme: getComputedStyle(doc.documentElement).colorScheme,
    })),
  };
})()`);
const apply = async (mode, readerBackground) => {
  await evaluate(`(async () => {
    const theme = window.__readerThemeForTest();
    theme.setThemeMode(${JSON.stringify(mode)});
    theme.setReaderBackground(${JSON.stringify(readerBackground)});
  })()`);
  await pause();
};
try {
  await evaluate(`(() => {
    const host = document.querySelector("[data-book-id]");
    if (!host) throw new Error("请在隔离 Preview 中打开一本 EPUB，再运行背景验收");
    const key = Object.keys(host).find((key) => key.startsWith("__reactFiber$"));
    let fiber = host[key];
    while (fiber && fiber.type?.name !== "ReaderViewerContent") fiber = fiber.return;
    if (!fiber) throw new Error("找不到实际书页组件");
    window.__readerThemeForTest = () => {
      let hook = fiber.memoizedState;
      while (hook) {
        if (hook.memoizedState?.themeCode) return hook.memoizedState;
        hook = hook.next;
      }
      return null;
    };
  })()`);
  previous = await evaluate(`(() => {
    const { globalTheme, readerBackground, themeMode } = window.__readerThemeForTest();
    return { globalTheme, readerBackground, themeMode };
  })()`);
  await evaluate(`(async () => {
    const theme = window.__readerThemeForTest();
    await theme.refreshGlobalThemes();
    await theme.setGlobalTheme("morandi");
  })()`);
  await waitFor(
    `document.querySelector("foliate-view")?.renderer?.getContents().some(({ doc }) =>
    doc.readyState === "complete" && getComputedStyle(doc.documentElement).getPropertyValue("--theme-bg-color").trim()
  )`,
    "真实书页与主题样式加载",
  );

  await apply("dark", { kind: "solid" });
  await waitFor(
    `window.__readerThemeForTest()?.themeCode?.bg === "#28323a"
    && window.__readerThemeForTest()?.isDarkMode`,
    "莫兰迪暗色快照",
  );
  const dark = await readEvidence();
  assert.equal(dark.globalTheme, "morandi");
  assert.equal(dark.themeMode, "dark");
  assert.ok(dark.documents.length > 0, "应读取到真实书籍文档");
  for (const doc of dark.documents) {
    assert.equal(doc.themeColor, "#28323a");
    assert.equal(doc.backgroundColor, "rgb(40, 50, 58)", JSON.stringify(dark));
    assert.equal(doc.scheme, "dark");
  }
  console.log("PASS 暗色默认背景：真实书页使用莫兰迪深蓝绿，而非透明露黑", JSON.stringify(dark));

  await apply("dark", { kind: "scene", sceneId: "mountains" });
  await waitFor(
    `window.__readerThemeForTest()?.themeCode?.backgroundImage?.image?.includes("mountains.webp")`,
    "山脉场景",
  );
  const scene = await readEvidence();
  for (const doc of scene.documents) {
    assert.equal(doc.backgroundColor, "rgba(0, 0, 0, 0)", JSON.stringify(scene));
    assert.equal(doc.backgroundImage, "none", JSON.stringify(scene));
    assert.equal(doc.scheme, "light");
  }
  assert.ok(scene.themeCodeImage.includes("mountains.webp"));
  console.log("PASS 场景背景：文档透明，场景图仍由应用侧显示", JSON.stringify(scene));

  await apply("light", { kind: "solid" });
  await waitFor(
    `window.__readerThemeForTest()?.themeCode?.bg === "#e9ecea"
    && !window.__readerThemeForTest()?.isDarkMode`,
    "莫兰迪浅色快照",
  );
  const light = await readEvidence();
  for (const doc of light.documents) {
    assert.equal(doc.themeColor, "#e9ecea");
    assert.equal(doc.backgroundColor, "rgb(233, 236, 234)", JSON.stringify(light));
  }
  console.log("PASS 浅色默认背景：仍跟随浅色主题", JSON.stringify(light));
} finally {
  await evaluate(`(async () => {
    const previous = ${JSON.stringify(previous ?? {})};
    const theme = window.__readerThemeForTest?.();
    if (theme && previous.globalTheme !== undefined) {
      await theme.setGlobalTheme(previous.globalTheme);
      theme.setReaderBackground(previous.readerBackground);
      theme.setThemeMode(previous.themeMode);
    }
    delete window.__readerThemeForTest;
  })()`).catch(() => {});
  ws.close();
}
