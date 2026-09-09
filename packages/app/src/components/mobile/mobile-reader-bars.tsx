import SideChat from "@/components/side-chat";
import { NotepadContainer } from "@/components/notepad";
import TOCView from "@/pages/reader/components/toc-view";
import { useReaderStore } from "@/pages/reader/components/reader-provider";
import { useAppSettingsStore } from "@/store/app-settings-store";
import { useLayoutStore } from "@/store/layout-store";
import clsx from "clsx";
import { ChevronLeft, List, NotebookPen, Settings, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { Drawer } from "vaul";

type SheetKind = "toc" | "notes" | "ai" | null;

/** 移动端阅读页上下栏 + 底部抽屉群（M3-c/d 裁定）：
 *  - 单击阅读区中央 = 弹出/收回上下栏（use-pagination 发 mobile-reader-toggle-bars）；
 *    抽屉开着时同一击 = 收抽屉
 *  - 上栏：←返回 + 书名 + ⋮溢出菜单（阅读设置）；下栏：进度滑条 + 目录/笔记/AI
 *  - AI 抽屉两档 snap（55%/全屏），forceMount 常驻——收起绝不清未发送草稿（裁定 3） */
export default function MobileReaderBars({ bookId }: { bookId: string }) {
  const [barsVisible, setBarsVisible] = useState(false);
  const [sheet, setSheet] = useState<SheetKind>(null);
  const [aiEverOpened, setAiEverOpened] = useState(false);
  const [aiFull, setAiFull] = useState(false);

  const navigateToHome = useLayoutStore((s) => s.navigateToHome);
  const toggleSettingsDialog = useAppSettingsStore((s) => s.toggleSettingsDialog);

  const bookData = useReaderStore((s) => s.bookData);
  const progress = useReaderStore((s) => s.progress);
  const view = useReaderStore((s) => s.view);

  // 中央单击：抽屉开着收抽屉，否则翻栏显隐
  useEffect(() => {
    const handler = (e: Event) => {
      if ((e as CustomEvent).detail?.bookId !== bookId) return;
      if (sheet) {
        setSheet(null);
      } else {
        setBarsVisible((v) => !v);
      }
    };
    window.addEventListener("mobile-reader-toggle-bars", handler);
    return () => window.removeEventListener("mobile-reader-toggle-bars", handler);
  }, [bookId, sheet]);

  // 长按句子 → Ask AI（quoteToChat）：抽屉未开时事件无人听（SideChat 未挂载），
  // 先拉起抽屉再延迟重放——新挂载的 SideChat 完成订阅后接住引用（M3 丝滑链路）
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.bookId && detail.bookId !== bookId) return;
      if (sheet === "ai") return; // 抽屉已开：SideChat 在听，原事件直达
      setAiEverOpened(true);
      setSheet("ai");
      window.setTimeout(() => {
        window.dispatchEvent(new CustomEvent("quoteToChat", { detail }));
      }, 400);
    };
    window.addEventListener("quoteToChat", handler);
    return () => window.removeEventListener("quoteToChat", handler);
  }, [bookId, sheet]);

  // 安卓返回键：抽屉开着 → 收抽屉（消费）；栏显隐不消费（返回即回书架，与微信读书一致）
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.handled) return;
      if (sheet) {
        detail.handled = true;
        setSheet(null);
        setAiFull(false);
      }
    };
    window.addEventListener("android-back", handler);
    return () => window.removeEventListener("android-back", handler);
  }, [sheet]);

  const openSheet = (kind: Exclude<SheetKind, null>) => {
    if (kind === "ai") setAiEverOpened(true);
    setSheet(kind);
  };

  const pageinfo = progress?.pageinfo;
  const hasPage = pageinfo && pageinfo.current >= 0 && pageinfo.total > 0;
  const pageText = hasPage ? `第 ${pageinfo.current + 1} / ${pageinfo.total} 页` : "";
  const fraction = hasPage ? (pageinfo.current + 1) / pageinfo.total : 0;
  const [dragFraction, setDragFraction] = useState<number | null>(null);

  const toc = bookData?.bookDoc?.toc ?? [];

  return (
    <>
      {/* 上栏（overlay，不推 foliate 重排） */}
      <div
        className={clsx(
          "absolute inset-x-0 top-0 z-30 transition-transform duration-200",
          barsVisible ? "translate-y-0" : "-translate-y-full",
        )}
        style={{ paddingTop: "var(--safe-area-inset-top)" }}
      >
        <div className="flex items-center gap-2 border-neutral-200 border-b bg-background/95 px-2 py-2 backdrop-blur-sm dark:border-neutral-700">
          <button
            type="button"
            onClick={navigateToHome}
            aria-label="返回"
            className="flex h-9 w-9 items-center justify-center rounded-full text-neutral-700 active:bg-neutral-100 dark:text-neutral-200 dark:active:bg-neutral-800"
          >
            <ChevronLeft size={22} />
          </button>
          <div className="min-w-0 flex-1 truncate text-center font-medium text-sm">{bookData?.book?.title ?? ""}</div>
          <button
            type="button"
            onClick={toggleSettingsDialog}
            aria-label="阅读设置"
            className="flex h-9 w-9 items-center justify-center rounded-full text-neutral-700 active:bg-neutral-100 dark:text-neutral-200 dark:active:bg-neutral-800"
          >
            <Settings size={19} />
          </button>
        </div>
      </div>

      {/* 下栏：进度滑条 + 操作行 */}
      <div
        className={clsx(
          "absolute inset-x-0 bottom-0 z-30 transition-transform duration-200",
          barsVisible ? "translate-y-0" : "translate-y-full",
        )}
        style={{ paddingBottom: "var(--safe-area-inset-bottom)" }}
      >
        <div className="border-neutral-200 border-t bg-background/95 px-4 pt-2 pb-1 backdrop-blur-sm dark:border-neutral-700">
          <div className="flex items-center gap-3">
            <span className="w-20 shrink-0 text-neutral-500 text-xs dark:text-neutral-400">
              {dragFraction !== null ? `${Math.round(dragFraction * 100)}%` : pageText}
            </span>
            <input
              type="range"
              min={0}
              max={1000}
              value={Math.round((dragFraction ?? fraction) * 1000)}
              onChange={(e) => setDragFraction(Number(e.target.value) / 1000)}
              onPointerUp={() => {
                if (dragFraction !== null) {
                  view?.goToFraction(dragFraction);
                  setDragFraction(null);
                }
              }}
              onTouchEnd={() => {
                if (dragFraction !== null) {
                  view?.goToFraction(dragFraction);
                  setDragFraction(null);
                }
              }}
              className="h-1.5 flex-1 accent-current"
              aria-label="阅读进度"
            />
          </div>
          <div className="flex items-center justify-around py-1">
            <button
              type="button"
              onClick={() => openSheet("toc")}
              className="flex flex-col items-center gap-0.5 px-4 py-1.5 text-neutral-600 active:opacity-60 dark:text-neutral-300"
            >
              <List size={21} />
              <span className="text-[11px]">目录</span>
            </button>
            <button
              type="button"
              onClick={() => openSheet("notes")}
              className="flex flex-col items-center gap-0.5 px-4 py-1.5 text-neutral-600 active:opacity-60 dark:text-neutral-300"
            >
              <NotebookPen size={21} />
              <span className="text-[11px]">笔记</span>
            </button>
            <button
              type="button"
              onClick={() => openSheet("ai")}
              className="-mt-5 flex h-12 w-12 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg active:scale-95"
              aria-label="AI 对话"
            >
              <Sparkles size={22} />
            </button>
            {/* 右侧占位保持 AI 居中（后续可放更多操作） */}
            <div className="w-[53px]" />
            <div className="w-[53px]" />
          </div>
        </div>
      </div>

      {/* 目录抽屉（55% 高，下拉即关） */}
      <Drawer.Root open={sheet === "toc"} onOpenChange={(o) => !o && setSheet(null)} modal>
        <Drawer.Portal>
          <Drawer.Overlay className="fixed inset-0 z-40 bg-black/40" />
          <Drawer.Content className="fixed inset-x-0 bottom-0 z-50 flex h-[55dvh] flex-col rounded-t-2xl bg-background outline-none">
            <div className="mx-auto my-2 h-1 w-10 rounded-full bg-neutral-300 dark:bg-neutral-600" />
            <div className="min-h-0 flex-1 px-2 pb-2">
              <TOCView bookId={bookId} toc={toc} autoExpand onItemSelect={() => setSheet(null)} isVisible={sheet === "toc"} />
            </div>
          </Drawer.Content>
        </Drawer.Portal>
      </Drawer.Root>

      {/* 笔记抽屉（55% 高，复用桌面 NotepadContainer） */}
      <Drawer.Root open={sheet === "notes"} onOpenChange={(o) => !o && setSheet(null)} modal>
        <Drawer.Portal>
          <Drawer.Overlay className="fixed inset-0 z-40 bg-black/40" />
          <Drawer.Content className="fixed inset-x-0 bottom-0 z-50 flex h-[55dvh] flex-col rounded-t-2xl bg-background outline-none">
            <div className="mx-auto my-2 h-1 w-10 rounded-full bg-neutral-300 dark:bg-neutral-600" />
            <div className="min-h-0 flex-1 overflow-hidden">
              <NotepadContainer bookId={bookId} />
            </div>
          </Drawer.Content>
        </Drawer.Portal>
      </Drawer.Root>

      {/* AI 抽屉（半屏 55dvh / 全屏两档）。草稿在 chat-draft-store（裁定 3），收起即卸载也不丢内容。
          档位切换：把手上推过头（onDrag 负位移）→ 全屏；全屏时点把手 → 收半屏；下拉/点遮罩/点阅读区 = 收起 */}
      {aiEverOpened && (
        <Drawer.Root
          open={sheet === "ai"}
          onOpenChange={(o) => {
            if (!o) {
              setSheet(null);
              setAiFull(false); // 收起即复位到半屏档位，下次从半屏拉起
            }
          }}
          onDrag={(_, pct) => {
            if (!aiFull && pct < -0.03) setAiFull(true);
          }}
          modal
        >
          <Drawer.Portal>
            <Drawer.Overlay className="fixed inset-0 z-40 bg-black/40" />
            <Drawer.Content
              className={clsx(
                "fixed inset-x-0 bottom-0 z-50 flex flex-col bg-background outline-none transition-[height] duration-200",
                aiFull ? "h-dvh rounded-none" : "h-[55dvh] rounded-t-2xl",
              )}
            >
              <button
                type="button"
                onClick={() => aiFull && setAiFull(false)}
                aria-label={aiFull ? "收回半屏" : "拖动上推全屏"}
                className="flex w-full shrink-0 items-center justify-center py-2"
              >
                <span className="h-1 w-10 rounded-full bg-neutral-300 dark:bg-neutral-600" />
              </button>
              <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                <SideChat bookId={bookId} />
              </div>
            </Drawer.Content>
          </Drawer.Portal>
        </Drawer.Root>
      )}
    </>
  );
}
