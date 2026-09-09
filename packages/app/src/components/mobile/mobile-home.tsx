import { applySyncResult } from "@/services/apply-sync-result";
import { syncGetL2Status, syncRunNow } from "@/services/sync-service";
import { syncUiConfigNow } from "@/services/ui-config-sync";
import { useAppSettingsStore } from "@/store/app-settings-store";
import { useLayoutStore } from "@/store/layout-store";
import { useLibraryStore } from "@/store/library-store";
import type { BookWithStatusAndUrls } from "@/types/simple-book";
import { useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import {
  BarChart3,
  BookOpenText,
  GraduationCap,
  MessagesSquare,
  RefreshCw,
  Settings,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import appIconUrl from "../../../src-tauri/icons/32x32.png";

/** 最近阅读封顶：书 3 本、论文 3 篇（再多是书库的事，首页只管"接着读"） */
const RECENT_LIMIT = 3;

/** 下拉触发刷新的位移阈值（px，阻尼折算后） */
const PULL_TRIGGER = 72;
const PULL_MAX = 110;

function progressPercent(b: BookWithStatusAndUrls): number {
  const s = b.status;
  if (!s || !s.progressTotal) return 0;
  return Math.round((s.progressCurrent / s.progressTotal) * 100);
}

/** 封面图（加载失败回退占位图，防止裂图标） */
function BookCover({ book }: { book: BookWithStatusAndUrls }) {
  const [broken, setBroken] = useState(false);
  if (book.coverUrl && !broken) {
    return (
      <img
        src={book.coverUrl}
        alt=""
        className="h-36 w-full rounded-lg object-cover"
        draggable={false}
        onError={() => setBroken(true)}
      />
    );
  }
  return (
    <div className="flex h-36 w-full items-center justify-center rounded-lg bg-neutral-100 dark:bg-neutral-800">
      <BookOpenText size={28} className="text-neutral-400" />
    </div>
  );
}

/** 移动端首页 = 继续页（M3-b 裁定）：继续阅读（书轮播+论文列表，无历史整块隐藏）+ 主选项。
 *  下拉 = 同步刷新（收敛桌面顶栏刷新按钮为一个手势）。 */
export default function MobileHome() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { booksWithStatus, refreshBooks } = useLibraryStore();
  const { openBook, openPaper } = useLayoutStore();
  const { toggleSettingsDialog } = useAppSettingsStore();

  useEffect(() => {
    void refreshBooks();
  }, [refreshBooks]);

  const recentBooks = useMemo(
    () =>
      booksWithStatus
        .filter((b) => b.format === "EPUB" && b.status?.lastReadAt)
        .sort((a, b) => (b.status?.lastReadAt ?? 0) - (a.status?.lastReadAt ?? 0))
        .slice(0, RECENT_LIMIT),
    [booksWithStatus],
  );
  const recentPapers = useMemo(
    () =>
      booksWithStatus
        .filter((b) => b.format === "MARKDOWN" && b.status?.lastReadAt)
        .sort((a, b) => (b.status?.lastReadAt ?? 0) - (a.status?.lastReadAt ?? 0))
        .slice(0, RECENT_LIMIT),
    [booksWithStatus],
  );

  // ---- 下拉刷新（仅在滚动容器顶部时生效） ----
  const scrollRef = useRef<HTMLDivElement>(null);
  const pullStartY = useRef<number | null>(null);
  const [pullDistance, setPullDistance] = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  const triggerRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const status = await syncGetL2Status().catch(() => null);
      if (status?.enabled) {
        const result = await syncRunNow();
        await applySyncResult(result, queryClient);
        await syncUiConfigNow();
        toast.success("同步完成", { description: result.message });
      }
      await refreshBooks();
    } catch (error) {
      console.error("下拉刷新失败:", error);
      toast.error("刷新失败", { description: String(error) });
    } finally {
      setRefreshing(false);
      setPullDistance(0);
    }
  }, [queryClient, refreshBooks]);

  const onTouchStart = (e: React.TouchEvent) => {
    if (scrollRef.current?.scrollTop === 0 && !refreshing) {
      pullStartY.current = e.touches[0].clientY;
    } else {
      pullStartY.current = null;
    }
  };
  const onTouchMove = (e: React.TouchEvent) => {
    if (pullStartY.current === null) return;
    const dy = e.touches[0].clientY - pullStartY.current;
    if (dy > 0) {
      // 阻尼：位移减半，超阈值后更难拉
      setPullDistance(Math.min(dy * 0.45, PULL_MAX));
      e.preventDefault();
    }
  };
  const onTouchEnd = () => {
    if (pullStartY.current === null) return;
    pullStartY.current = null;
    if (pullDistance >= PULL_TRIGGER && !refreshing) {
      void triggerRefresh();
    } else {
      setPullDistance(0);
    }
  };

  const mainOptions: { icon: React.ReactNode; label: string; onClick: () => void }[] = [
    { icon: <BookOpenText size={20} />, label: "图书馆", onClick: () => navigate("/library") },
    { icon: <GraduationCap size={20} />, label: "论文库", onClick: () => navigate("/papers") },
    { icon: <MessagesSquare size={20} />, label: "全局助手", onClick: () => navigate("/chat") },
    { icon: <BarChart3 size={20} />, label: "阅读统计", onClick: () => navigate("/statistics") },
  ];
  const bottomOptions: typeof mainOptions = [
    { icon: <Trash2 size={20} />, label: "回收站", onClick: () => navigate("/trash") },
    { icon: <Settings size={20} />, label: "设置", onClick: toggleSettingsDialog },
  ];

  const showPullIndicator = pullDistance > 0 || refreshing;

  return (
    <div
      ref={scrollRef}
      className="h-full overflow-y-auto overscroll-contain"
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
    >
      {/* 下拉指示器：跟随位移下探；刷新中驻留 */}
      <div
        className="pointer-events-none flex items-center justify-center overflow-hidden transition-[height] duration-150"
        style={{ height: showPullIndicator ? (refreshing ? 44 : pullDistance) : 0 }}
      >
        <RefreshCw
          size={18}
          className={clsx(
            "text-neutral-400",
            refreshing && "animate-spin",
            !refreshing && pullDistance >= PULL_TRIGGER && "text-primary",
          )}
        />
      </div>

      {/* 品牌头：icon + 字样 */}
      <div className="flex items-center gap-2 px-5 pt-4 pb-2">
        <img src={appIconUrl} alt="" className="size-7" />
        <span className="font-semibold text-lg text-neutral-800 dark:text-neutral-200">Better SageRead</span>
      </div>

      {/* 继续阅读：书籍大卡横向轮播（无历史整块隐藏） */}
      {recentBooks.length > 0 && (
        <section className="pt-2">
          <h2 className="px-5 pb-2 text-neutral-500 text-xs dark:text-neutral-400">继续阅读</h2>
          <div className="flex snap-x snap-mandatory gap-3 overflow-x-auto px-5 pb-2">
            {recentBooks.map((b) => (
              <button
                key={b.id}
                type="button"
                onClick={() => openBook(b.id, b.title)}
                className="flex w-40 shrink-0 snap-center flex-col items-start gap-2 rounded-2xl border bg-card p-3 text-left shadow-sm active:scale-[0.98] dark:border-neutral-700"
              >
                <BookCover book={b} />
                <div className="w-full">
                  <div className="line-clamp-2 font-medium text-sm leading-5">{b.title}</div>
                  <div className="mt-1 text-neutral-400 text-xs">{progressPercent(b)}%</div>
                  <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-700">
                    <div className="h-full rounded-full bg-primary" style={{ width: `${progressPercent(b)}%` }} />
                  </div>
                </div>
              </button>
            ))}
          </div>
        </section>
      )}

      {/* 最近论文：列表式（无历史整块隐藏） */}
      {recentPapers.length > 0 && (
        <section className="pt-2">
          <h2 className="px-5 pb-1 text-neutral-500 text-xs dark:text-neutral-400">最近论文</h2>
          <div className="mx-4 overflow-hidden rounded-2xl border bg-card dark:border-neutral-700">
            {recentPapers.map((p, i) => (
              <button
                key={p.id}
                type="button"
                onClick={() => openPaper(p.id, p.title)}
                className={clsx(
                  "flex w-full items-center gap-3 px-4 py-3 text-left active:bg-neutral-50 dark:active:bg-neutral-800",
                  i > 0 && "border-neutral-100 border-t dark:border-neutral-800",
                )}
              >
                <GraduationCap size={18} className="shrink-0 text-neutral-400" />
                <span className="line-clamp-1 flex-1 text-sm">{p.title}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      {/* 主选项 */}
      <section className="mt-4">
        <div className="mx-4 overflow-hidden rounded-2xl border bg-card dark:border-neutral-700">
          {mainOptions.map((opt, i) => (
            <button
              key={opt.label}
              type="button"
              onClick={opt.onClick}
              className={clsx(
                "flex w-full items-center gap-3 px-4 py-3.5 text-left active:bg-neutral-50 dark:active:bg-neutral-800",
                i > 0 && "border-neutral-100 border-t dark:border-neutral-800",
              )}
            >
              <span className="text-neutral-500 dark:text-neutral-400">{opt.icon}</span>
              <span className="flex-1 text-[15px]">{opt.label}</span>
              <span className="text-neutral-300 dark:text-neutral-600">›</span>
            </button>
          ))}
        </div>
        <div className="mx-4 mt-3 overflow-hidden rounded-2xl border bg-card dark:border-neutral-700">
          {bottomOptions.map((opt, i) => (
            <button
              key={opt.label}
              type="button"
              onClick={opt.onClick}
              className={clsx(
                "flex w-full items-center gap-3 px-4 py-3.5 text-left active:bg-neutral-50 dark:active:bg-neutral-800",
                i > 0 && "border-neutral-100 border-t dark:border-neutral-800",
              )}
            >
              <span className="text-neutral-500 dark:text-neutral-400">{opt.icon}</span>
              <span className="flex-1 text-[15px]">{opt.label}</span>
              <span className="text-neutral-300 dark:text-neutral-600">›</span>
            </button>
          ))}
        </div>
      </section>

      <div className="h-6" />
    </div>
  );
}
