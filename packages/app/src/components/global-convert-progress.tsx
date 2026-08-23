/**
 * 全局转换进度层（右下角浮层，挂在 ReaderLayout——独立于任何路由页面）。
 *
 * 两张卡纵向堆叠（互不重叠）：
 * - 论文 PDF 解析进度卡：状态在 convert-progress-store，跨页面持续呈现；
 * - 图书 PDF→EPUB 转换小卡：转换大窗口被最小化时出现，点击还原大窗口。
 *
 * 豁免视图（不渲染任何卡，避免遮挡正文）：全局助手聊天页（/chat）、
 * 书籍阅读器 tab、论文阅读器 tab——即任何阅读器 tab 激活期间。
 * 豁免只影响可见性：进度状态与事件接收在 store，退出豁免视图即恢复呈现。
 */

import { BottomRightPortal } from "@/components/ui/bottom-right-stack";
import { Progress } from "@/components/ui/progress";
import {
  type BookConvertState,
  type PaperImportState,
  dismissPaperImport,
  useConvertProgressStore,
} from "@/store/convert-progress-store";
import { useLayoutStore } from "@/store/layout-store";
import clsx from "clsx";
import { BookText, Check, FileText, X } from "lucide-react";
import { useEffect } from "react";
import { useLocation, useNavigate } from "react-router";

/** 论文解析进度卡（markup 自 PapersPage 迁入；成功 6s 自动消失逻辑一并迁移） */
function PaperImportCard({ paperImport }: { paperImport: PaperImportState }) {
  // 成功态 6 秒后自动消失（批量有失败、失败/取消态保留待手动关闭）
  useEffect(() => {
    if (paperImport.status !== "success") return;
    if (paperImport.failedCount > 0) return;
    const timer = setTimeout(() => {
      // 定时器到期时状态可能已被接续的下一篇换成 running——dismiss 对 running 等于取消，
      // 必须只在仍是 success 时执行（队列化后接续间隔可能超过 6s，2026-08-20 实测误杀下一篇）
      const current = useConvertProgressStore.getState().paperImport;
      if (current?.status === "success") dismissPaperImport();
    }, 6000);
    return () => clearTimeout(timer);
  }, [paperImport.status, paperImport.failedCount]);

  return (
    <div className="pointer-events-auto w-80 rounded-xl border bg-background p-3.5 shadow-lg">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="min-w-0 flex-1 truncate font-medium text-sm">{paperImport.fileName}</span>
        {(paperImport.total > 1 || paperImport.queuedCount > 0) && (
          <span className="shrink-0 text-muted-foreground text-xs">
            第 {paperImport.index}/{paperImport.total} 篇
            {paperImport.queuedCount > 0 && `（待 ${paperImport.queuedCount} 篇）`}
          </span>
        )}
        <button
          type="button"
          className="shrink-0 rounded p-0.5 text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200"
          onClick={dismissPaperImport}
        >
          <X className="size-3.5" />
        </button>
      </div>

      {/* 阶段行（紧凑：4 个状态点 + 当前阶段名） */}
      <div className="mb-2.5 flex items-center gap-1.5">
        {paperImport.stages.map((stage) => (
          <span
            key={stage.n}
            className={clsx(
              "flex size-4 items-center justify-center rounded-full text-[9px]",
              stage.status === "done" && "bg-primary text-primary-foreground",
              stage.status === "active" && "border border-primary text-primary",
              stage.status === "pending" && "border text-muted-foreground",
              stage.status === "error" && "bg-destructive text-destructive-foreground",
            )}
          >
            {stage.status === "done" ? <Check className="size-2.5" /> : stage.n}
          </span>
        ))}
        <span className="ml-1 truncate text-muted-foreground text-xs">
          {paperImport.stages.find((s) => s.status === "active")?.name ??
            (paperImport.status === "success" ? "完成" : paperImport.status === "error" ? "失败" : "准备中")}
        </span>
      </div>

      {paperImport.status === "running" && (
        <>
          <Progress value={paperImport.percent} className="h-1.5" />
          <div className="mt-1.5 flex items-center justify-between gap-2 text-muted-foreground text-xs">
            <span className="min-w-0 flex-1 truncate">{paperImport.detail}</span>
            <span className="shrink-0">{paperImport.percent}%</span>
          </div>
        </>
      )}
      {paperImport.status === "success" && (
        <p className="truncate text-green-600 text-xs dark:text-green-400">{paperImport.detail}</p>
      )}
      {paperImport.status === "error" && <p className="text-red-600 text-xs dark:text-red-400">{paperImport.error}</p>}
      {paperImport.failedNames.length > 0 && (
        <ul className="mt-1 space-y-0.5 text-red-600 text-xs dark:text-red-400">
          {paperImport.failedNames.map((name) => (
            <li key={name} className="truncate" title={name}>
              {name}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** 图书转换小卡（大窗口最小化时呈现；点击卡片还原大窗口，X 丢弃状态） */
function BookConvertMiniCard({ bookConvert }: { bookConvert: BookConvertState }) {
  const navigate = useNavigate();
  const openBookConvertDialog = useConvertProgressStore((s) => s.openBookConvertDialog);
  const resetBookConvert = useConvertProgressStore((s) => s.resetBookConvert);
  const fileName = bookConvert.pdfPath?.split(/[\\/]/).pop() ?? "";
  const active = bookConvert.stages.find((s) => s.status === "active");

  const restore = () => {
    // 大窗口挂在图书馆页弹层：不在图书馆页时先回图书馆再开窗
    openBookConvertDialog();
    navigate("/");
  };

  return (
    <div
      role="button"
      tabIndex={0}
      className="pointer-events-auto w-80 cursor-pointer rounded-xl border bg-background p-3.5 shadow-lg transition-colors hover:border-primary/40"
      onClick={restore}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") restore();
      }}
      title="点击还原转换窗口"
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="flex min-w-0 flex-1 items-center gap-1.5 truncate font-medium text-sm">
          <BookText className="size-3.5 shrink-0 text-primary" />
          <span className="truncate">PDF 转 EPUB · {fileName}</span>
        </span>
        <button
          type="button"
          className="shrink-0 rounded p-0.5 text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200"
          onClick={(e) => {
            e.stopPropagation();
            resetBookConvert();
          }}
        >
          <X className="size-3.5" />
        </button>
      </div>

      {/* 阶段行（与论文卡同款紧凑样式） */}
      <div className="mb-2.5 flex items-center gap-1.5">
        {bookConvert.stages.map((stage) => (
          <span
            key={stage.n}
            className={clsx(
              "flex size-4 items-center justify-center rounded-full text-[9px]",
              stage.status === "done" && "bg-primary text-primary-foreground",
              stage.status === "active" && "border border-primary text-primary",
              stage.status === "pending" && "border text-muted-foreground",
              stage.status === "error" && "bg-destructive text-destructive-foreground",
            )}
          >
            {stage.status === "done" ? <Check className="size-2.5" /> : stage.n}
          </span>
        ))}
        <span className="ml-1 truncate text-muted-foreground text-xs">
          {active?.name ??
            (bookConvert.status === "done" ? "完成" : bookConvert.status === "error" ? "失败" : "准备中")}
        </span>
      </div>

      {bookConvert.status === "converting" && (
        <>
          <Progress value={bookConvert.percent} className="h-1.5" />
          <div className="mt-1.5 flex items-center justify-between gap-2 text-muted-foreground text-xs">
            <span className="min-w-0 flex-1 truncate">{bookConvert.detail}</span>
            <span className="shrink-0">{bookConvert.percent}%</span>
          </div>
        </>
      )}
      {bookConvert.status === "done" && (
        <p className="flex items-center gap-1.5 truncate text-green-600 text-xs dark:text-green-400">
          <FileText className="size-3 shrink-0" />
          转换完成，点击查看并导入图书馆
        </p>
      )}
      {bookConvert.status === "error" && (
        <p className="truncate text-red-600 text-xs dark:text-red-400">{bookConvert.errorMessage}</p>
      )}
    </div>
  );
}

export default function GlobalConvertProgress() {
  const isHomeActive = useLayoutStore((s) => s.isHomeActive);
  const location = useLocation();
  const paperImport = useConvertProgressStore((s) => s.paperImport);
  const bookConvert = useConvertProgressStore((s) => s.bookConvert);
  const bookConvertMinimized = useConvertProgressStore((s) => s.bookConvertMinimized);

  // 豁免视图：阅读器 tab 激活（书籍/论文）或全局助手聊天页
  const exempt = !isHomeActive || location.pathname === "/chat";
  if (exempt) return null;
  if (!paperImport && !bookConvertMinimized) return null;

  return (
    <>
      {paperImport && (
        <BottomRightPortal>
          <PaperImportCard paperImport={paperImport} />
        </BottomRightPortal>
      )}
      {bookConvertMinimized && bookConvert.status !== "idle" && (
        <BottomRightPortal>
          <BookConvertMiniCard bookConvert={bookConvert} />
        </BottomRightPortal>
      )}
    </>
  );
}
