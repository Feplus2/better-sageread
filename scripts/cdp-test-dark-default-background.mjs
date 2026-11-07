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
  const currentView = window.__readerViewForTest();
  const docs = currentView?.renderer?.getContents().map(({ doc }) => doc) ?? [];
  return {
    globalTheme: theme?.globalTheme,
    themeMode: theme?.themeMode,
    readerTheme: theme?.themeColor,
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
const expectedGlobalBackground = () =>
  evaluate(`(() => {
    const value = getComputedStyle(document.documentElement).getPropertyValue("--background").trim();
    const probe = document.createElement("span");
    probe.style.color = value;
    document.body.append(probe);
    const rgb = getComputedStyle(probe).color;
    probe.remove();
    return { value, rgb };
  })()`);
const apply = async (mode, readerBackground, readerTheme = "default") => {
  await evaluate(`(async () => {
    const theme = window.__readerThemeForTest();
    theme.setThemeColor(${JSON.stringify(readerTheme)});
    theme.setThemeMode(${JSON.stringify(mode)});
    theme.setReaderBackground(${JSON.stringify(readerBackground)});
  })()`);
  await pause();
};
try {
  await evaluate(`(() => {
    const host = document.querySelector('.tab-layer[data-active="true"] [data-book-id]');
    if (!host) throw new Error("请在隔离 Preview 中打开一本 EPUB，再运行背景验收");
    const key = Object.keys(host).find((key) => key.startsWith("__reactFiber$"));
    let fiber = host[key];
    while (fiber && fiber.type?.name !== "ReaderViewerContent") fiber = fiber.return;
    if (!fiber) throw new Error("找不到实际书页组件");
    window.__readerViewForTest = () => {
      const host = document.querySelector('.tab-layer[data-active="true"] [data-book-id]');
      let fiber = host?.[Object.keys(host ?? {}).find((key) => key.startsWith("__reactFiber$"))];
      while (fiber && fiber.type?.name !== "ReaderProvider") fiber = fiber.return;
      return fiber?.memoizedProps.store.getState().view;
    };
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
    const { globalTheme, readerBackground, themeMode, themeColor } = window.__readerThemeForTest();
    return { globalTheme, readerBackground, themeMode, themeColor };
  })()`);
  await evaluate(`(async () => {
    const theme = window.__readerThemeForTest();
    theme.setThemeColor("default");
    await theme.refreshGlobalThemes();
    await theme.setGlobalTheme("cake");
    await theme.setGlobalTheme("morandi");
  })()`);
  await waitFor(
    `window.__readerViewForTest()?.renderer?.getContents().some(({ doc }) =>
    doc.readyState === "complete" && getComputedStyle(doc.documentElement).getPropertyValue("--theme-bg-color").trim()
  )`,
    "真实书页与主题样式加载",
  );

  await apply("dark", { kind: "solid" });
  const expectedDark = await expectedGlobalBackground();
  await waitFor(
    `window.__readerThemeForTest()?.themeCode?.bg === ${JSON.stringify(expectedDark.value)}
    && window.__readerThemeForTest()?.isDarkMode`,
    "当前主题的暗色快照",
  );
  const dark = await readEvidence();
  assert.equal(dark.globalTheme, "morandi");
  assert.equal(dark.themeMode, "dark");
  assert.equal(dark.readerTheme, "default");
  assert.ok(dark.documents.length > 0, "应读取到真实书籍文档");
  for (const doc of dark.documents) {
    assert.equal(doc.themeColor, expectedDark.value);
    assert.equal(doc.backgroundColor, expectedDark.rgb, JSON.stringify(dark));
    assert.equal(doc.scheme, "dark");
  }
  console.log("PASS 暗色默认背景：真实书页与当前全局主题底色一致", JSON.stringify(dark));

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
  const expectedLight = await expectedGlobalBackground();
  await waitFor(
    `window.__readerThemeForTest()?.themeCode?.bg === ${JSON.stringify(expectedLight.value)}
    && !window.__readerThemeForTest()?.isDarkMode`,
    "当前主题的浅色快照",
  );
  const light = await readEvidence();
  for (const doc of light.documents) {
    assert.equal(doc.themeColor, expectedLight.value);
    assert.equal(doc.backgroundColor, expectedLight.rgb, JSON.stringify(light));
  }
  console.log("PASS 浅色默认背景：真实书页与当前全局主题底色一致", JSON.stringify(light));

  await apply("light", { kind: "solid" }, "parchment");
  await waitFor(
    `window.__readerViewForTest()?.renderer?.getContents().every(({ doc }) =>
    getComputedStyle(doc.documentElement).getPropertyValue("--theme-bg-color").trim() === "#f4e7c8"
  )`,
    "显式羊皮纸浅色",
  );
  const parchmentLight = await readEvidence();
  assert.equal(parchmentLight.readerTheme, "parchment");
  assert.equal(parchmentLight.themeCodeBg, "#f4e7c8");
  for (const doc of parchmentLight.documents) assert.equal(doc.backgroundColor, "rgb(244, 231, 200)");

  await apply("dark", { kind: "solid" }, "parchment");
  await waitFor(
    `window.__readerViewForTest()?.renderer?.getContents().every(({ doc }) =>
    getComputedStyle(doc.documentElement).getPropertyValue("--theme-bg-color").trim() === "#2b251c"
  )`,
    "显式羊皮纸暗色",
  );
  const parchmentDark = await readEvidence();
  assert.equal(parchmentDark.readerTheme, "parchment");
  assert.equal(parchmentDark.themeCodeBg, "#2b251c");
  for (const doc of parchmentDark.documents) assert.equal(doc.backgroundColor, "rgb(43, 37, 28)");
  console.log("PASS 用户显式选择羊皮纸时保留自己的阅读配色，不被全局底色覆盖");
} finally {
  await evaluate(`(async () => {
    const previous = ${JSON.stringify(previous ?? {})};
    const theme = window.__readerThemeForTest?.();
    if (theme && previous.globalTheme !== undefined) {
      await theme.setGlobalTheme(previous.globalTheme);
      theme.setThemeColor(previous.themeColor);
      theme.setReaderBackground(previous.readerBackground);
      theme.setThemeMode(previous.themeMode);
    }
    delete window.__readerThemeForTest;
    delete window.__readerViewForTest;
  })()`).catch(() => {});
  ws.close();
}
