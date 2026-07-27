import SettingsDialog from "@/components/settings/settings-dialog";
import { useBookUpload } from "@/hooks/use-book-upload";
import { useSafeAreaInsets } from "@/hooks/use-safe-areaInsets";
import ChatPage from "@/pages/chat";
import ConverterPage from "@/pages/converter";
import LibraryPage from "@/pages/library";
import TrashPage from "@/pages/library/trash";
import SkillsPage from "@/pages/skills";
import StatisticsPage from "@/pages/statistics";
import { useAppSettingsStore } from "@/store/app-settings-store";
import { useLibraryStore } from "@/store/library-store";
import { useLlamaStore } from "@/store/llama-store";
import clsx from "clsx";
import { Upload as UploadIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Route, Routes } from "react-router";
import Sidebar from "./sidebar";

const NotesPage = () => (
  <div className="flex-1 space-y-6 p-4">
    <div className="space-y-2">
      <h1 className="font-bold text-3xl text-neutral-900 dark:text-neutral-100">笔记</h1>
      <p className="text-neutral-600 dark:text-neutral-400">笔记功能开发中...</p>
    </div>
  </div>
);

const PapersPage = () => (
  <div className="flex h-full flex-col items-center justify-center gap-6 p-8">
    <div className="flex h-20 w-20 items-center justify-center rounded-3xl bg-gradient-to-br from-blue-50 to-indigo-100 dark:from-blue-950/40 dark:to-indigo-900/30">
      <svg className="h-10 w-10 text-blue-500 dark:text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={1.5}
          d="M4.26 10.147a60.438 60.438 0 0 0-.491 6.347A48.62 48.62 0 0 1 12 20.904a48.62 48.62 0 0 1 8.232-4.41 60.46 60.46 0 0 0-.491-6.347m-15.482 0a50.636 50.636 0 0 0-2.658-.813A59.906 59.906 0 0 1 12 3.493a59.903 59.903 0 0 1 10.399 5.84c-.896.248-1.783.52-2.658.814m-15.482 0A50.717 50.717 0 0 1 12 13.489a50.702 50.702 0 0 1 7.74-3.342M6.75 15a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm0 0v-3.675A55.378 55.378 0 0 1 12 8.443m-7.007 11.55A5.981 5.981 0 0 0 6.75 15.75v-1.5"
        />
      </svg>
    </div>
    <div className="max-w-lg space-y-3 text-center">
      <h1 className="font-bold text-2xl text-neutral-900 dark:text-neutral-100">文献库</h1>
      <p className="text-muted-foreground text-sm leading-relaxed">
        专为学术论文打造的 AI 助读模块，正在规划中。
      </p>
      <div className="mx-auto max-w-md rounded-xl border bg-muted/30 p-4 text-left text-sm text-muted-foreground">
        <p className="mb-2 font-medium text-foreground">规划功能：</p>
        <ul className="list-inside list-disc space-y-1">
          <li>导入论文 PDF，自动解析为结构化 Markdown</li>
          <li>KaTeX 公式渲染、引文标注、章节导航</li>
          <li>以研究方向为单位的跨论文 AI 问答</li>
          <li>Zotero 文献库联动导入</li>
          <li>独立的论文助手 Agent（引文推荐、对比分析）</li>
        </ul>
      </div>
      <p className="text-xs text-muted-foreground/70">敬请期待 · 详见 docs/format-strategy-and-paper-module.md</p>
    </div>
  </div>
);

const HomeLayout = () => {
  const { refreshBooks } = useLibraryStore();
  const { isSettingsDialogOpen, toggleSettingsDialog } = useAppSettingsStore();
  const insets = useSafeAreaInsets();
  const { isDragOver, handleDragOver, handleDragLeave, handleDrop } = useBookUpload();

  const isInitiating = useRef(false);
  const [libraryLoaded, setLibraryLoaded] = useState(false);

  const { hasHydrated, initializeEmbeddingService } = useLlamaStore();

  // 初始化 Embedding 服务器
  // biome-ignore lint/correctness/useExhaustiveDependencies: <explanation>
  useEffect(() => {
    if (!hasHydrated) {
      console.log("等待持久化数据恢复...");
      return;
    }

    initializeEmbeddingService();
  }, [hasHydrated]);

  useEffect(() => {
    if (isInitiating.current) return;

    const initializeLibrary = async () => {
      isInitiating.current = true;
      try {
        await refreshBooks();
      } finally {
        setLibraryLoaded(true);
        isInitiating.current = false;
      }
    };

    initializeLibrary();
  }, [refreshBooks]);

  if (!insets || !libraryLoaded) {
    return null;
  }

  return (
    <div
      className={clsx(
        "flex h-dvh w-full rounded-xl bg-transparent p-1 py-0 transition-all duration-200",
        isDragOver && "bg-neutral-50 dark:bg-neutral-900/20",
      )}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className="flex h-[calc(100vh-40px)] w-full rounded-xl border bg-background shadow-around">
        {isDragOver && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-neutral-50/80 backdrop-blur-sm dark:bg-neutral-900/40">
            <div className="flex flex-col items-center gap-4 rounded-2xl border-2 border-neutral-400 border-dashed bg-white/90 px-30 py-16 shadow-lg dark:border-neutral-500 dark:bg-neutral-800/90">
              <UploadIcon className="h-12 w-12 text-neutral-600 dark:text-neutral-400" />
              <div className="text-center">
                <h3 className="font-semibold text-lg text-neutral-900 dark:text-neutral-100">拖放文件以上传</h3>
                <p className="text-neutral-600 text-sm dark:text-neutral-400">松开以上传您的书籍</p>
              </div>
            </div>
          </div>
        )}

        <Sidebar />

        <div data-region="app-main" className="h-full flex-1 overflow-hidden p-1">
          <Routes>
            <Route
              path="/"
              element={
                <div className="flex h-full flex-1 flex-col rounded-xl border bg-background shadow-around">
                  <LibraryPage />
                </div>
              }
            />
            <Route
              path="/statistics"
              element={
                <div className="flex h-full flex-1 flex-col rounded-xl border bg-background shadow-around">
                  <StatisticsPage />
                </div>
              }
            />
            <Route
              path="/chat"
              element={
                <div className="flex h-full flex-1 flex-col overflow-hidden rounded-xl shadow-around">
                  <ChatPage />
                </div>
              }
            />
            <Route
              path="/trash"
              element={
                <div className="flex h-full flex-1 flex-col rounded-xl border bg-background shadow-around">
                  <TrashPage />
                </div>
              }
            />
            <Route
              path="/notes"
              element={
                <div className="flex h-full flex-1 flex-col rounded-xl border bg-background shadow-around">
                  <NotesPage />
                </div>
              }
            />
            <Route
              path="/skills"
              element={
                <div className="flex h-full flex-1 flex-col rounded-xl border bg-background shadow-around">
                  <SkillsPage />
                </div>
              }
            />
            <Route
              path="/converter"
              element={
                <div className="flex h-full flex-1 flex-col rounded-xl border bg-background shadow-around">
                  <ConverterPage />
                </div>
              }
            />
            <Route
              path="/papers"
              element={
                <div className="flex h-full flex-1 flex-col rounded-xl border bg-background shadow-around">
                  <PapersPage />
                </div>
              }
            />
          </Routes>
        </div>
      </div>

      <SettingsDialog open={isSettingsDialogOpen} onOpenChange={toggleSettingsDialog} />
    </div>
  );
};

export default HomeLayout;
