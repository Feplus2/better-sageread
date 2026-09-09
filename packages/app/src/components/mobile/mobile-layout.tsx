import MobileHome from "@/components/mobile/mobile-home";
import MobilePageShell from "@/components/mobile/mobile-page-shell";
import MobileReaderBars from "@/components/mobile/mobile-reader-bars";
import ChatPage from "@/pages/chat";
import LibraryPage from "@/pages/library";
import TrashPage from "@/pages/library/trash";
import PaperReaderView from "@/pages/paper-reader/paper-reader-view";
import PapersPage from "@/pages/papers";
import ReaderViewer from "@/pages/reader";
import { ReaderProvider } from "@/pages/reader/components/reader-provider";
import type { ReaderStore } from "@/pages/reader/store/create-reader-store";
import StatisticsPage from "@/pages/statistics";
import { useLayoutStore, type Tab } from "@/store/layout-store";
import { ChevronLeft } from "lucide-react";
import { useEffect, useState } from "react";
import { useLocation } from "react-router";

/** 移动端二级页路由表（桌面 "/" 是图书馆；移动端 "/" 让给首页，图书馆挪到 "/library"） */
const MOBILE_PAGES: Record<string, { title: string; element: React.ReactNode }> = {
  "/library": { title: "图书馆", element: <LibraryPage /> },
  "/papers": { title: "论文库", element: <PapersPage /> },
  "/statistics": { title: "阅读统计", element: <StatisticsPage /> },
  "/trash": { title: "回收站", element: <TrashPage /> },
};

/** 主页区：首页 + 二级页（/chat 全局助手常驻保活——护流式对话，与桌面同哲学；其余页随路由卸载） */
function MobileHomeArea() {
  const { pathname } = useLocation();
  const [chatVisited, setChatVisited] = useState(false);
  useEffect(() => {
    if (pathname === "/chat") setChatVisited(true);
  }, [pathname]);

  const page = MOBILE_PAGES[pathname];
  return (
    <div className="relative h-full">
      {pathname === "/" || (!page && pathname !== "/chat") ? <MobileHome /> : null}
      {page ? (
        <MobilePageShell title={page.title}>{page.element}</MobilePageShell>
      ) : null}
      {chatVisited && (
        <div className="absolute inset-0" style={{ display: pathname === "/chat" ? undefined : "none" }}>
          <MobilePageShell title="全局助手">
            <ChatPage />
          </MobilePageShell>
        </div>
      )}
    </div>
  );
}

/** 移动端书籍阅读层：无桌面侧栏/标签栏——foliate 全幅 + 上下栏/抽屉（MobileReaderBars）。
 *  store 缺失即补建（移动端 dispose 后重开的情形），卸载不毁 store——回收由 MobileLayout 统一调度 */
function MobileBookLayer({ tab }: { tab: Tab }) {
  const { ensureReaderStore } = useLayoutStore();
  const [store, setStore] = useState<ReaderStore | null>(null);

  useEffect(() => {
    setStore(ensureReaderStore(tab.id, tab.bookId));
  }, [tab.id, tab.bookId, ensureReaderStore]);

  if (!store) return null;
  return (
    <ReaderProvider store={store}>
      <div className="relative h-full bg-background">
        <ReaderViewer />
        <MobileReaderBars bookId={tab.bookId} />
      </div>
    </ReaderProvider>
  );
}

/** 移动端顶层壳：无标签栏、单栏、单书存活（非激活书籍 store 立即释放，重开从 DB 恢复） */
export default function MobileLayout() {
  const { tabs, activeTabId, isHomeActive, disposeReaderStoresExcept } = useLayoutStore();
  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null;

  // 单书存活策略（M3 裁定 1）：标签页无关闭语义，但非激活书籍只留 DB 记录，store 即释放
  useEffect(() => {
    disposeReaderStoresExcept(isHomeActive ? null : activeTabId);
  }, [activeTabId, isHomeActive, disposeReaderStoresExcept]);

  return (
    <div
      className="h-dvh w-full bg-muted"
      style={{
        paddingTop: "var(--safe-area-inset-top)",
        paddingBottom: "var(--safe-area-inset-bottom)",
        paddingLeft: "var(--safe-area-inset-left)",
        paddingRight: "var(--safe-area-inset-right)",
      }}
    >
      {isHomeActive || !activeTab ? (
        <MobileHomeArea />
      ) : (activeTab.type ?? "book") === "paper" ? (
        // 论文阅读器自带桌面 header（无返回语义），移动端外包一层返回栏
        <div className="flex h-full flex-col bg-background">
          <div className="flex shrink-0 items-center gap-1 border-neutral-200 border-b px-2 py-2 dark:border-neutral-700">
            <button
              type="button"
              onClick={() => useLayoutStore.getState().navigateToHome()}
              className="flex h-8 w-8 items-center justify-center rounded-full text-neutral-600 active:bg-neutral-100 dark:text-neutral-300 dark:active:bg-neutral-800"
              aria-label="返回首页"
            >
              <ChevronLeft size={22} />
            </button>
            <h1 className="min-w-0 flex-1 truncate font-medium text-sm">{activeTab.title}</h1>
          </div>
          <div className="min-h-0 flex-1 overflow-hidden">
            <PaperReaderView paperId={activeTab.bookId} title={activeTab.title} viewSleeping={false} />
          </div>
        </div>
      ) : (
        <MobileBookLayer tab={activeTab} />
      )}
    </div>
  );
}
