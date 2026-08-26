import { ThemeBackgroundVideo } from "@/components/theme-background-video";
import { Toaster } from "@/components/ui/sonner";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router";
import ReaderLayout from "./components/reader-layout.tsx";
import { flushAllWrites } from "./lib/tauri-storage.ts";
import { initSecrets } from "./services/secret-init.ts";
import { mountFontsToMainApp } from "./utils/font.ts";

const queryClient = new QueryClient();

import "./index.css";

mountFontsToMainApp();

// 保活层隐藏模型开关（index.css 批次 3 双轨）：默认 opacity 模型（2026-08-27 转正：
// keepalive 大层 visibility 翻转触发全量 raster——图书馆↔文献库 620ms 墙实测 65ms，详见
// index.css 批次 3 注释）。运行期翻 documentElement.dataset.tabHide = "visibility"
// 即切旧模型（AT 全隐藏/省纹理内存，低端机逃生门）。??= 保留外部预置值（HMR 幂等）
document.documentElement.dataset.tabHide ??= "opacity";

// 批次 A：localStorage 存量密钥迁入 keyring，并把 keyring 中的 key 载入内存 store
initSecrets().catch((error) => {
  console.error("密钥初始化失败:", error);
});

// I2：拉起 sageread-mcp 本地通道（localhost-only HTTP + token 写入 mcp-local.json）；
// 失败不阻塞 app 启动（只影响外部 MCP 的执行类工具）
invoke<number>("start_local_api")
  .then((port) => console.log(`[I2] 本地通道已启动: 127.0.0.1:${port}`))
  .catch((error) => {
    console.warn("[I2] 本地通道启动失败（外部 MCP 执行类工具不可用）:", error);
  });

window.addEventListener("beforeunload", () => {
  flushAllWrites().catch((error) => {
    console.error("Failed to flush writes on app close:", error);
  });
});

// Tauri webview 中 <a target="_blank"> 不会唤起默认浏览器：
// 捕获阶段全局拦截 http(s) 链接点击，统一委托 plugin-opener（覆盖设置页/来源角标/Markdown 链接等所有入口）
document.addEventListener(
  "click",
  (event) => {
    const anchor = (event.target as Element | null)?.closest?.('a[href^="http://"], a[href^="https://"]');
    if (!anchor) return;
    const href = anchor.getAttribute("href");
    if (!href) return;
    event.preventDefault();
    openUrl(href).catch((error) => {
      console.error("打开外部链接失败:", error);
    });
  },
  true,
);

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <HashRouter>
      <ThemeBackgroundVideo />
      <ReaderLayout />
    </HashRouter>
    <Toaster position="top-center" />
  </QueryClientProvider>,
);
