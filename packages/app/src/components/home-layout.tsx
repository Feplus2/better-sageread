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
import { useConvertProgressStore } from "@/store/convert-progress-store";
import { useLibraryStore } from "@/store/library-store";
import { useLlamaStore } from "@/store/llama-store";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import clsx from "clsx";
import { Upload as UploadIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Route, Routes, useLocation } from "react-router";
import { toast } from "sonner";
import Sidebar from "./sidebar";

const HomeLayout = () => {
  const { refreshBooks } = useLibraryStore();
  const { isSettingsDialogOpen, toggleSettingsDialog } = useAppSettingsStore();
  const insets = useSafeAreaInsets();
  const { importBookPaths } = useBookUpload();
  // 书籍拖入导入只在图书馆相关页生效（其他页面各自接管拖放，如文献库的 PDF 解析导入）
  const location = useLocation();
  const bookDropEnabled = location.pathname === "/" || location.pathname === "/trash";
  // 转换器入口：拖入 PDF 时预填文件并打开弹层
  const setBookConvertConfig = useConvertProgressStore((s) => s.setBookConvertConfig);
  const openBookConvertDialog = useConvertProgressStore((s) => s.openBookConvertDialog);

  const [dragOver, setDragOver] = useState(false);

  // 书籍拖入导入（原生拖放事件）：dragDropEnabled=true 时 HTML5 drop 收不到文件，
  // 旧 HTML5 处理对真实系统拖放无效（弹罩出现但放下后无反应）——与文献库页同走
  // onDragDropEvent。EPUB 直接入库；PDF 引导进转换器（预填文件并打开弹层，不自动烧配额）。
  // 回调经 ref 间接引用：监听只挂一次，路径分发逻辑始终取最新
  const dropHandlerRef = useRef<(paths: string[]) => void>(() => {});
  dropHandlerRef.current = (paths: string[]) => {
    const epubs = paths.filter((p) => p.toLowerCase().endsWith(".epub"));
    const pdfs = paths.filter((p) => p.toLowerCase().endsWith(".pdf"));
    const ignored = paths.length - epubs.length - pdfs.length;
    if (epubs.length === 0 && pdfs.length === 0) {
      if (paths.length > 0) {
        toast.error("未找到支持的文件。支持的格式：.epub / .pdf（书籍请去图书馆页拖入）");
      }
      return;
    }
    if (ignored > 0) toast.info(`已忽略 ${ignored} 个不支持的文件`);
    if (pdfs.length > 0) {
      const { bookConvert, resetBookConvert } = useConvertProgressStore.getState();
      if (bookConvert.status === "converting") {
        toast.info("已有转换进行中，请等它结束后再拖入新的 PDF");
      } else {
        // 丢弃上一轮结果并预填首个 PDF（转换器一次处理一个文件）
        resetBookConvert();
        setBookConvertConfig({ pdfPath: pdfs[0] });
        openBookConvertDialog();
        toast.info(
          pdfs.length > 1
            ? `已填入「${pdfs[0].split(/[\\/]/).pop()}」（共 ${pdfs.length} 个 PDF，一次转换一个）`
            : "已填入转换器，点击「开始转换」",
        );
      }
    }
    if (epubs.length > 0) {
      void importBookPaths(epubs);
    }
  };
  useEffect(() => {
    if (!bookDropEnabled) return;
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    getCurrentWebviewWindow()
      .onDragDropEvent((event) => {
        const payload = event.payload;
        if (payload.type === "enter" || payload.type === "over") {
          if (payload.paths.some((p) => /\.(epub|pdf)$/i.test(p))) setDragOver(true);
        } else if (payload.type === "leave") {
          setDragOver(false);
        } else if (payload.type === "drop") {
          setDragOver(false);
          dropHandlerRef.current(payload.paths);
        }
      })
      .then((off) => {
        if (cancelled) off();
        else unlisten = off;
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [bookDropEnabled]);

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
        dragOver && "bg-neutral-50 dark:bg-neutral-900/20",
      )}
    >
      <div className="flex h-[calc(100vh-40px)] w-full rounded-xl border bg-background shadow-around">
        {dragOver && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-neutral-50/80 backdrop-blur-sm dark:bg-neutral-900/40">
            <div className="flex flex-col items-center gap-4 rounded-2xl border-2 border-neutral-400 border-dashed bg-white/90 px-30 py-16 shadow-lg dark:border-neutral-500 dark:bg-neutral-800/90">
              <UploadIcon className="h-12 w-12 text-neutral-600 dark:text-neutral-400" />
              <div className="text-center">
                <h3 className="font-semibold text-lg text-neutral-900 dark:text-neutral-100">拖放文件以上传</h3>
                <p className="text-neutral-600 text-sm dark:text-neutral-400">EPUB 直接入库 · PDF 进入转换器</p>
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
