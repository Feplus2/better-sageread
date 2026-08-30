import { ImageInteractions, quoteImageToChat } from "@/components/media/image-interactions";
import { useReadingSession } from "@/hooks/use-reading-session";
import { useSafeAreaInsets } from "@/hooks/use-safe-areaInsets";
import { useAppSettingsStore } from "@/store/app-settings-store";
import { useLayoutStore } from "@/store/layout-store";
import { useLibraryStore } from "@/store/library-store";
import { useThemeStore } from "@/store/theme-store";
import { getInsetEdges } from "@/utils/grid";
import { getViewInsets } from "@/utils/insets";
import { getReaderBackgroundLayers, resolveBookViewMode } from "@/utils/style";
import { useCallback, useEffect, useMemo } from "react";
import useBookShortcuts from "../hooks/use-book-shortcuts";
import { useAnnotationMirror } from "../hooks/use-annotation-mirror";
import { useFoliateViewer } from "../hooks/use-foliate-viewer";
import { useTranslationLink } from "../hooks/use-translation-link";
import Annotator from "./annotator";
import FooterBar from "./footer-bar";
import HeaderBar from "./header-bar";
import { useReaderStore, useReaderStoreApi } from "./reader-provider";

const ReaderViewerContent: React.FC = () => {
  const bookId = useReaderStore((state) => state.bookId);
  const bookData = useReaderStore((state) => state.bookData);
  const config = useReaderStore((state) => state.config);
  const { settings } = useAppSettingsStore();
  const { themeCode } = useThemeStore();

  // 应用侧阅读背景：场景图+遮罩渲染在 foliate-view 外层容器上（书籍文档已透明化）
  const backgroundLayers = getReaderBackgroundLayers(themeCode);

  const screenInsets = useSafeAreaInsets();
  const aspectRatio = window.innerWidth / window.innerHeight;
  const globalViewSettings = settings.globalViewSettings;

  const contentInsets = useMemo(() => {
    if (!screenInsets || !globalViewSettings) {
      return { top: 0, right: 0, bottom: 0, left: 0 };
    }

    const { top, right, bottom, left } = getInsetEdges(0, 1, aspectRatio);
    const gridInsets = {
      top: top ? screenInsets.top : 0,
      right: right ? screenInsets.right : 0,
      bottom: bottom ? screenInsets.bottom : 0,
      left: left ? screenInsets.left : 0,
    };

    const viewInsets = getViewInsets(globalViewSettings);

    return {
      top: gridInsets.top + viewInsets.top,
      right: gridInsets.right + viewInsets.right,
      bottom: gridInsets.bottom + viewInsets.bottom,
      left: gridInsets.left + viewInsets.left,
    };
  }, [screenInsets, globalViewSettings, aspectRatio]);

  if (!bookId || !bookData?.bookDoc || !config || !contentInsets) {
    return null;
  }

  const foliateViewer = useFoliateViewer(bookId, bookData.bookDoc, config, contentInsets);

  // 二期批次 4b+：对照翻译交互层——hover 句词联动 + 右键句选。常驻启用（2026-08-30 用户裁定）：
  // 有对齐数据时双侧联动；未翻译书/未对齐段落单侧句级高亮与右键句选——句子级交互是
  // 通用阅读增强，不依赖翻译（划词对照卡 08-29 用户裁定撤销，hover 已覆盖该需求）
  const viewMode = resolveBookViewMode(globalViewSettings);
  useTranslationLink(true);
  // 二期批次 4d：标注镜像——原文标注 ↔ 译文常驻镜像高亮（需要译本存在，仍按模式启停）
  useAnnotationMirror(viewMode !== "original");

  // T3+T4：书籍图片交互——点击大图预览 + 右键主题菜单（复制/另存为/引用）。
  // 引用走 imageToChat 事件（reader 侧输入区接收，与划词引用同链路）；面板未展开先展开再派发
  // selector 订阅：整店订阅会被 activateTab 翻动拖出每次切 tab 的重渲（2026-08-26 切 tab 墙治理）
  const isChatVisible = useLayoutStore((s) => s.isChatVisible);
  const toggleChatSidebar = useLayoutStore((s) => s.toggleChatSidebar);
  const handleQuoteImage = useCallback(
    (image: { dataUrl: string; mediaType: string; name: string }) => {
      if (!isChatVisible) toggleChatSidebar();
      window.setTimeout(() => quoteImageToChat(bookId)(image), 50);
    },
    [bookId, isChatVisible, toggleChatSidebar],
  );

  return (
    <div
      ref={foliateViewer.containerRef}
      className="flex-1"
      data-book-id={bookId}
      {...foliateViewer.mouseHandlers}
      style={
        backgroundLayers
          ? {
              backgroundImage: backgroundLayers,
              backgroundSize: "cover",
              backgroundPosition: "center",
              backgroundRepeat: "no-repeat",
            }
          : undefined
      }
    >
      {/* 书籍内容在 foliate iframe 里：经 postMessage 通道接收图片事件（见 iframeEventHandlers） */}
      <ImageInteractions viaPostMessage onQuote={handleQuoteImage} />
    </div>
  );
};

export default function ReaderViewer() {
  const store = useReaderStoreApi();
  useBookShortcuts();

  const bookId = useReaderStore((state) => state.bookId);
  const bookData = useReaderStore((state) => state.bookData);
  const config = useReaderStore((state) => state.config);
  const isLoading = useReaderStore((state) => state.isLoading);
  const error = useReaderStore((state) => state.error);

  const { settings } = useAppSettingsStore();
  const { booksWithStatus } = useLibraryStore();

  // 判断当前 tab 是否可见（不在首页 && 当前激活的 tab）。
  // 布尔 selector：激活态只在「本 tab 被切进/切走」翻转；paper↔paper 切换值恒 false 不重渲
  //（整店/双字段订阅会被每次 activateTab 翻动——切 tab 墙治理，2026-08-26）
  const tabId = `reader-${bookId}`;
  const isTabVisible = useLayoutStore((s) => !s.isHomeActive && s.activeTabId === tabId);

  // bookId 可为 null（无书打开）——空串占位，钩子内部对空 id 自行短路
  const { sessionStats, isInitialized: isSessionInitialized } = useReadingSession(bookId ?? "", {
    saveInterval: 5 * 1000,
    isVisible: isTabVisible,
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: <explanation>
  useEffect(() => {
    const currentBookData = store.getState().bookData;
    if (!currentBookData) {
      store.getState().initBook();
    }
  }, [store, booksWithStatus, settings.globalViewSettings]);

  useEffect(() => {
    store.getState().setSessionStats(sessionStats);
    store.getState().setSessionInitialized(isSessionInitialized);
  }, [store, sessionStats, isSessionInitialized]);

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-neutral-500">loading...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-red-500">{error}</div>
      </div>
    );
  }

  if (!bookData || !config) {
    return null;
  }

  // PDF 格式：使用原生渲染（iframe）+ 转换建议横幅
  if (bookData.book?.format === "PDF" && bookData.nativeFileUrl) {
    return (
      <div id={`gridcell-${bookId}`} className="relative flex h-full w-full flex-col rounded-md bg-background">
        <div className="flex items-center gap-2 border-b bg-orange-50 px-4 py-2 text-sm dark:border-neutral-700 dark:bg-orange-950/30">
          <svg className="h-4 w-4 flex-shrink-0 text-orange-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"
            />
          </svg>
          <span className="text-orange-700 dark:text-orange-300">
            PDF 阅读模式：转换为 EPUB 可解锁 AI 问答、划线笔记、进度同步等完整体验（设置 → PDF 转换）
          </span>
        </div>
        <iframe src={bookData.nativeFileUrl} className="flex-1 border-0" title={`PDF: ${bookData.book?.title || ""}`} />
      </div>
    );
  }

  return (
    <div id={`gridcell-${bookId}`} className="relative flex h-full w-full flex-col rounded-md bg-background">
      <HeaderBar />
      <ReaderViewerContent />
      <FooterBar />
      <Annotator />
    </div>
  );
}
