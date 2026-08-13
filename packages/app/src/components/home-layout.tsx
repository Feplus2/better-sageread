import SettingsDialog from "@/components/settings/settings-dialog";
import { useBookUpload } from "@/hooks/use-book-upload";
import { useSafeAreaInsets } from "@/hooks/use-safe-areaInsets";
import ChatPage from "@/pages/chat";
import ConverterPage from "@/pages/converter";
import LibraryPage from "@/pages/library";
import TrashPage from "@/pages/library/trash";
import ManualPage from "@/pages/manual";
import PapersPage from "@/pages/papers";
import SkillsPage from "@/pages/skills";
import StatisticsPage from "@/pages/statistics";
import { useAppSettingsStore } from "@/store/app-settings-store";
import { useLibraryStore } from "@/store/library-store";
import { useLlamaStore } from "@/store/llama-store";
import clsx from "clsx";
import { Upload as UploadIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Route, Routes, useLocation } from "react-router";
import Sidebar from "./sidebar";

const HomeLayout = () => {
  const { refreshBooks } = useLibraryStore();
  const { isSettingsDialogOpen, toggleSettingsDialog } = useAppSettingsStore();
  const insets = useSafeAreaInsets();
  const { isDragOver, handleDragOver, handleDragLeave, handleDrop } = useBookUpload();
  // 书籍拖入导入只在图书馆相关页生效（其他页面各自接管拖放，如文献库的 PDF 解析导入）
  const location = useLocation();
  const bookDropEnabled = location.pathname === "/" || location.pathname === "/trash";

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
      onDragOver={bookDropEnabled ? handleDragOver : undefined}
      onDragLeave={bookDropEnabled ? handleDragLeave : undefined}
      onDrop={bookDropEnabled ? handleDrop : undefined}
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
              path="/manual"
              element={
                <div className="flex h-full flex-1 flex-col rounded-xl border bg-background shadow-around">
                  <ManualPage />
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
