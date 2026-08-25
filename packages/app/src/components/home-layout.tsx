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
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useLocation } from "react-router";
import { toast } from "sonner";
import Sidebar from "./sidebar";

/** 路由表（批次 3 数据驱动）：path → 页面元素，外包装 div 类名与原 <Route> 内逐字一致 */
const ROUTE_ELEMENTS: Record<string, ReactNode> = {
  "/": (
    <div className="flex h-full flex-1 flex-col rounded-xl border bg-background shadow-around">
      <LibraryPage />
    </div>
  ),
  "/statistics": (
    <div className="flex h-full flex-1 flex-col rounded-xl border bg-background shadow-around">
      <StatisticsPage />
    </div>
  ),
  "/trash": (
    <div className="flex h-full flex-1 flex-col rounded-xl border bg-background shadow-around">
      <TrashPage />
    </div>
  ),
  "/skills": (
    <div className="flex h-full flex-1 flex-col rounded-xl border bg-background shadow-around">
      <SkillsPage />
    </div>
  ),
  "/converter": (
    <div className="flex h-full flex-1 flex-col rounded-xl border bg-background shadow-around">
      <ConverterPage />
    </div>
  ),
  "/manual": (
    <div className="flex h-full flex-1 flex-col rounded-xl border bg-background shadow-around">
      <ManualPage />
    </div>
  ),
  "/papers": (
    <div className="flex h-full flex-1 flex-col rounded-xl border bg-background shadow-around">
      <PapersPage />
    </div>
  ),
};

/** 读 --motion-dur-slow 计算值（ms）；解析不到按 300ms 兜底 */
const readMotionSlowMs = (): number => {
  const raw = getComputedStyle(document.documentElement).getPropertyValue("--motion-dur-slow").trim();
  const m = /^([\d.]+)(ms|s)$/.exec(raw);
  if (!m) return 300;
  const v = Number.parseFloat(m[1]);
  return m[2] === "s" ? v * 1000 : v;
};

/**
 * 自绘 AnimatedRoutes（动效批次 3）：两槽 keepalive 交叉淡入，替代原 react-router <Routes> 硬切。
 * - 当前 path 淡入（.tab-layer data-active），旧层保留挂载播离场（opacity 1→0，aria-hidden）；
 * - 离场计时（--motion-dur-slow 读值 + 缓冲）到点卸载旧层；reduced 档 token 为 0.01ms 即卸，等同硬切；
 * - 快速连切 A→B→C 时未播完的更旧层立即卸载（slice(-2)），不叠三层；
 * - key=path 保持实例跨位移不 remount（[A,B]→[B,C] 时 B 被保留移动，同节点 reparent 保滚动位置）；
 * - 未知 path（map 无匹配）：与原 <Routes> 一致最终渲染空（旧层播完离场即空）。
 */
const AnimatedRouteLayers = () => {
  const { pathname } = useLocation();
  const activePath = pathname in ROUTE_ELEMENTS ? pathname : null;
  const [layers, setLayers] = useState<string[]>(() => (activePath ? [activePath] : []));

  // 路径变化：新 path 入列置顶（已存在则上移复用），尾部截断保两层
  useEffect(() => {
    setLayers((prev) => {
      const last = prev[prev.length - 1];
      if (last === activePath) return prev;
      if (activePath === null) return prev.slice(-1); // 未知 path：最近一层播离场后到点卸载
      return [...prev.filter((p) => p !== activePath), activePath].slice(-2);
    });
  }, [activePath]);

  // 离场计时：到点卸载所有非活跃层
  useEffect(() => {
    if (layers.every((p) => p === activePath)) return;
    const timer = setTimeout(
      () => setLayers((prev) => prev.filter((p) => p === activePath)),
      readMotionSlowMs() + 50, // 50ms 缓冲等最后一帧落地
    );
    return () => clearTimeout(timer);
  }, [layers, activePath]);

  return layers.map((path) => (
    <div
      key={path}
      data-active={path === activePath}
      inert={path !== activePath}
      aria-hidden={path !== activePath || undefined}
      className="tab-layer absolute inset-0 p-1"
    >
      {ROUTE_ELEMENTS[path]}
    </div>
  ));
};

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
          if ("paths" in payload && payload.paths.some((p) => /\.(epub|pdf)$/i.test(p))) setDragOver(true);
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

        <div data-region="app-main" className="relative h-full flex-1 overflow-hidden">
          {/* 批次 3：p-1 由容器移到各层（单层时与现状逐像素一致），容器相对定位承载绝对层 */}
          {/* 全局助手常驻挂载（仅可见性切换），与阅读 tab"侧栏与聊天保活（护流式任务）"同哲学：
              此前 /chat 随 Routes 卸载——卸载清理清空仍在流式的 Chat 实例消息表，孤儿流 finish 以
              残缺 [assistant] 覆盖落库（2026-08-24 消息丢失根修）。常驻后切页不断流、回页即续接。
              批次 3 仅把 display 硬切换成 .tab-layer data-active 交叉淡入，常驻挂载语义不变 */}
          <div
            data-region="chat-layer"
            data-active={location.pathname === "/chat"}
            inert={location.pathname !== "/chat"}
            aria-hidden={location.pathname !== "/chat" || undefined}
            className="tab-layer absolute inset-0 p-1"
          >
            {/* 嵌套结构：层管定位+p-1，内层原样保留硬切时代的卡片类（rounded/shadow 在 4px 净空内，
                若把 p-1 与 shadow-around 压在同一层，阴影会贴 app-main 边被 overflow-hidden 裁掉） */}
            <div className="flex h-full flex-1 flex-col overflow-hidden rounded-xl shadow-around">
              <ChatPage />
            </div>
          </div>
          <AnimatedRouteLayers />
        </div>
      </div>

      <SettingsDialog open={isSettingsDialogOpen} onOpenChange={toggleSettingsDialog} />
    </div>
  );
};

export default HomeLayout;
