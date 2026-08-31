import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  type BookConvertPayload,
  type BookConvertResult,
  enqueueBookConvertBatch,
  retryBookConvertTask,
} from "@/services/task-executors/book-convert";
import { useConvertProgressStore } from "@/store/convert-progress-store";
import { useConverterStore } from "@/store/converter-store";
import { type TaskItem, selectChannelAggregate, useTaskCenterStore } from "@/store/task-center-store";
import { open } from "@tauri-apps/plugin-dialog";
import { Ban, CheckCircle2, Clock, FileDown, FileText, Loader2, RotateCcw, X, XCircle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

/**
 * 图书转换任务台（卡 1，docs/plans/book-convert-queue-plan.md）：
 * 窗口内容模型 = book-convert 通道队列——拖入/选入多份 PDF 即逐本入队（通道串行连转，
 * 完成自动导入书库 + toast + 自动出队）；队列每行 = 文件名 + 状态 + 操作（取消/重试/删除），
 * 失败行滞留带错误原因。「更换」语义已删除（删除→新拖入替代，用户拍板）。
 *
 * 大页面（/converter）与图书馆弹层共用本组件；窗口态 ⇄ 右下角通道卡状态机与
 * 在跑任务详情数据源在 convert-progress-store，队列现场读 task-center 通道聚合
 * （窗口开关/最小化不丢现场）。拖放悬停遮罩只盖窗口本体（bookConvertDragOver，
 * 由 home-layout 的全局 Tauri 拖放监听按窗口可见性写入——不再盖全主页）。
 */

const TRANSLATE_OPTIONS = [
  { value: "none", label: "不翻译" },
  { value: "zh", label: "译为中文" },
  { value: "en", label: "译为英文" },
  { value: "ja", label: "译为日文" },
  { value: "fr", label: "译为法文" },
  { value: "de", label: "译为德文" },
  { value: "es", label: "译为西班牙文" },
  { value: "ko", label: "译为韩文" },
];

/** 队列行状态图标 */
function RowStatusIcon({ status }: { status: TaskItem["status"] }) {
  switch (status) {
    case "running":
      return <Loader2 className="size-4 animate-spin text-primary" />;
    case "queued":
      return <Clock className="size-4 text-muted-foreground" />;
    case "success":
      return <CheckCircle2 className="size-4 text-emerald-600 dark:text-emerald-400" />;
    case "error":
      return <XCircle className="size-4 text-red-600 dark:text-red-400" />;
    case "cancelled":
      return <Ban className="size-4 text-muted-foreground" />;
  }
}

const translateOptionLabel = (value: string) =>
  TRANSLATE_OPTIONS.find((o) => o.value === value)?.label ?? TRANSLATE_OPTIONS[0].label;

/** 行上选项徽标：展示该行入队时的 ocr/translate 快照（payload）。
 *  排队中（queued）可点——弹出小编辑改两个选项，保存经 updateQueuedTaskPayload 热更新 payload；
 *  running/已结算只读（仅显示开启的项）。排队行两枚徽标常显（含关态），否则关着的选项没有改入的入口 */
function QueueRowOptions({ task }: { task: TaskItem }) {
  const payload = task.payload as BookConvertPayload | undefined;
  const editable = task.status === "queued";
  const [open, setOpen] = useState(false);
  const ocr = payload?.ocr === true;
  const translate = payload?.translate || "none";
  const [editOcr, setEditOcr] = useState(ocr);
  const [editTranslate, setEditTranslate] = useState(translate);

  // 打开编辑时同步该行当前快照（别带上一轮编辑残值）
  useEffect(() => {
    if (open) {
      setEditOcr(ocr);
      setEditTranslate(translate);
    }
  }, [open, ocr, translate]);

  if (!payload) return null;

  const handleSave = () => {
    const ok = useTaskCenterStore
      .getState()
      .updateQueuedTaskPayload(task.taskId, { ocr: editOcr, translate: editTranslate });
    // 竞态：编辑期间任务起跑 → 拒改，提示后按只读口径收尾
    if (ok) toast.success(`已更新排队任务选项：${task.title}`);
    else toast.info("任务已开始运行，选项不可再改");
    setOpen(false);
  };

  const badges = (
    <>
      <Badge variant={ocr ? "secondary" : "outline"} className={ocr ? undefined : "text-muted-foreground"}>
        {ocr ? "强制 OCR" : "OCR 关"}
      </Badge>
      <Badge
        variant={translate !== "none" ? "secondary" : "outline"}
        className={translate !== "none" ? undefined : "text-muted-foreground"}
      >
        {translateOptionLabel(translate)}
      </Badge>
    </>
  );

  if (!editable) {
    // running/已结算：只读，且只列开启的项（全关即不占位）
    if (!ocr && translate === "none") return null;
    return (
      <div className="mt-1.5 flex flex-wrap items-center gap-1">
        {ocr && <Badge variant="secondary">强制 OCR</Badge>}
        {translate !== "none" && <Badge variant="secondary">{translateOptionLabel(translate)}</Badge>}
      </div>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <span
          className="mt-1.5 flex w-fit cursor-pointer flex-wrap items-center gap-1"
          title="排队中——点击调整本任务的转换选项"
        >
          {badges}
        </span>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72">
        <div className="space-y-3">
          <p className="text-muted-foreground text-xs">本任务选项（仅排队中可改，不影响其他行与默认选项）</p>
          <div className="flex items-center justify-between gap-3">
            <Label htmlFor={`row-ocr-${task.taskId}`} className="text-sm">
              强制 OCR
            </Label>
            <Switch id={`row-ocr-${task.taskId}`} checked={editOcr} onCheckedChange={setEditOcr} />
          </div>
          <div className="flex items-center justify-between gap-3">
            <Label className="text-sm">全书翻译</Label>
            <Select value={editTranslate} onValueChange={setEditTranslate}>
              <SelectTrigger className="h-8 w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TRANSLATE_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" className="h-7 px-2.5 text-xs" onClick={() => setOpen(false)}>
              取消
            </Button>
            <Button size="sm" className="h-7 px-2.5 text-xs" onClick={handleSave}>
              保存
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** 队列行：文件名 + 状态（排队/转换中带进度/完成/失败/已取消）+ 行操作 */
function QueueRow({ task }: { task: TaskItem }) {
  const cancelTask = () => useTaskCenterStore.getState().cancelTask(task.taskId);
  const removeTask = () => useTaskCenterStore.getState().removeTask(task.taskId);
  const result = task.result as BookConvertResult | undefined;

  return (
    <li className="flex items-start gap-3 px-4 py-3">
      <span className="mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
        <FileText className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <p className="truncate font-medium text-sm dark:text-neutral-100">{task.title}</p>
            </TooltipTrigger>
            <TooltipContent side="bottom">{task.targetId}</TooltipContent>
          </Tooltip>
          <span className="flex flex-shrink-0 items-center gap-1.5 text-muted-foreground text-xs">
            <RowStatusIcon status={task.status} />
            {task.status === "queued" && "排队中"}
            {task.status === "running" && `${task.percent}%`}
            {task.status === "success" && (result?.imported === false ? "完成（自动导入失败）" : "已导入图书馆")}
            {task.status === "error" && "失败"}
            {task.status === "cancelled" && "已取消"}
          </span>
        </div>

        {/* 选项徽标：该行入队时快照；queued 可点改，running/已结算只读 */}
        <QueueRowOptions task={task} />

        {task.status === "running" && (
          <>
            <Progress value={task.percent} className="mt-2 h-1.5" />
            <Tooltip>
              <TooltipTrigger asChild>
                <p className="mt-1 truncate text-muted-foreground text-xs">{task.detail || "处理中…"}</p>
              </TooltipTrigger>
              <TooltipContent side="bottom">{task.detail}</TooltipContent>
            </Tooltip>
          </>
        )}
        {task.status === "error" && (
          <p className="mt-1 break-all text-red-600 text-xs dark:text-red-400">{task.error || "转换失败"}</p>
        )}
      </div>

      {/* 行操作：运行中=取消；失败/已取消=重试+删除；排队/成功=删除 */}
      <div className="flex flex-shrink-0 items-center gap-1">
        {task.status === "running" && (
          <Button variant="outline" size="sm" className="h-7 px-2.5 text-xs" onClick={cancelTask}>
            取消
          </Button>
        )}
        {(task.status === "error" || task.status === "cancelled") && (
          <Button
            variant="outline"
            size="sm"
            className="h-7 px-2.5 text-xs"
            onClick={() => retryBookConvertTask(task.taskId)}
          >
            <RotateCcw className="size-3.5" />
            重试
          </Button>
        )}
        {task.status !== "running" && (
          <button
            type="button"
            title="从队列移除"
            className="rounded p-1 text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200"
            onClick={removeTask}
          >
            <X className="size-3.5" />
          </button>
        )}
      </div>
    </li>
  );
}

export default function ConverterPage() {
  const ocr = useConvertProgressStore((s) => s.bookConvert.ocr);
  const translate = useConvertProgressStore((s) => s.bookConvert.translate);
  const setBookConvertConfig = useConvertProgressStore((s) => s.setBookConvertConfig);
  const dragOver = useConvertProgressStore((s) => s.bookConvertDragOver);
  const { mineruToken, paddleocrToken, engine } = useConverterStore();
  const hasEngineToken = engine === "paddleocr" ? !!paddleocrToken : !!mineruToken;

  // 队列现场：book-convert 通道聚合（selectChannelAggregate 每次返回新对象，不能直接作
  // zustand 选择器——订阅稳定的 tasks/order 引用再 useMemo 聚合，global-convert-progress 同款）
  const taskCenterTasks = useTaskCenterStore((s) => s.tasks);
  const taskCenterOrder = useTaskCenterStore((s) => s.order);
  const queueRows = useMemo(() => {
    const rows: TaskItem[] = [];
    for (const id of taskCenterOrder) {
      const task = taskCenterTasks[id];
      if (task && task.channel === "book-convert" && !task.mirror) rows.push(task);
    }
    return rows;
  }, [taskCenterTasks, taskCenterOrder]);

  // 视图卸载兜底（弹层被异常卸载等）：通道还有任务且窗口逻辑上仍开着 → 转通道卡跟踪
  // （正常关窗走 closeBookConvertDialog 已落定 minimized，这里 dialogOpen 已 false 不会重复写）
  useEffect(() => {
    return () => {
      const s = useConvertProgressStore.getState();
      if (!s.bookConvertDialogOpen) return;
      const agg = selectChannelAggregate(useTaskCenterStore.getState(), "book-convert");
      const hasTasks = agg.current !== null || agg.queuedCount > 0 || agg.settled.some((t) => t.status !== "cancelled");
      if (hasTasks) useConvertProgressStore.setState({ bookConvertMinimized: true });
    };
  }, []);

  const handleSelectPdfs = async () => {
    try {
      const selected = await open({
        filters: [{ name: "PDF", extensions: ["pdf"] }],
        multiple: true,
      });
      if (!selected) return;
      const paths = Array.isArray(selected) ? selected : [selected];
      enqueueBookConvertBatch(paths, { ocr, translate });
    } catch (e) {
      console.warn("选择 PDF 失败:", e);
    }
  };

  return (
    <div data-region="converter-page" className="relative flex h-full flex-col overflow-y-auto">
      {/* 拖放悬停遮罩：只盖窗口本体（home-layout 判定窗口可见时置旗标；盖全主页是卡 1 修正前的错位） */}
      {dragOver && (
        <div className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-3 rounded-2xl border-2 border-primary border-dashed bg-background/90 px-16 py-10 shadow-lg">
            <FileDown className="size-10 text-primary" />
            <p className="font-medium text-sm">松开将 PDF 加入转换队列</p>
          </div>
        </div>
      )}

      <div className="mx-auto w-full max-w-2xl space-y-6 p-6 py-8">
        {/* 页眉 */}
        <header className="space-y-3 border-b pb-6 dark:border-neutral-700">
          <p className="font-medium text-[11px] text-muted-foreground uppercase tracking-[0.25em]">
            Books_Converter · Hybrid 引擎
          </p>
          <h1 className="font-bold font-serif text-3xl dark:text-neutral-100">PDF 转 EPUB</h1>
          <p className="text-muted-foreground text-sm">
            多份 PDF 拖入即排队，串行连转；完成自动导入书库并出队。窗口可最小化为右下角任务卡，点卡还原
          </p>
        </header>

        {!hasEngineToken && (
          <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-amber-700 text-sm dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-400">
            尚未配置 {engine === "paddleocr" ? "PaddleOCR" : "MinerU"} Token，请前往 设置 → PDF 转换 填写后再开始转换。
          </p>
        )}

        {/* 拖放/选入区 */}
        <button
          type="button"
          onClick={handleSelectPdfs}
          className="flex w-full flex-col items-center gap-2 rounded-xl border border-dashed px-4 py-8 text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground dark:border-neutral-700"
        >
          <FileDown className="size-6" />
          <span className="text-sm">拖入 PDF 到本窗口，或点击选择（可多选）</span>
          <span className="text-xs">仅支持 .pdf 格式 · 入队即转，完成自动导入书库</span>
        </button>

        {/* 新入队默认选项（作用于此后入队的任务；已入队行持入队时快照，排队中可点行上徽标单独改） */}
        <section className="rounded-xl border dark:border-neutral-700">
          <div className="divide-y dark:divide-neutral-800">
            <div className="px-4 py-2.5">
              <p className="font-medium text-sm">新入队默认选项</p>
              <p className="text-muted-foreground text-xs">
                只作用于此后拖入/选入的 PDF；已入队任务各持入队时快照，排队中的行可点行上徽标单独调整
              </p>
            </div>
            <div className="flex items-center justify-between gap-4 px-4 py-3.5">
              <div className="space-y-0.5">
                <Label htmlFor="ocr-switch" className="text-sm">
                  强制 OCR
                </Label>
                <p className="text-muted-foreground text-xs">扫描版建议开启；文字版可关闭以提速</p>
              </div>
              <Switch
                id="ocr-switch"
                checked={ocr}
                onCheckedChange={(checked) => setBookConvertConfig({ ocr: checked })}
              />
            </div>

            <div className="flex items-center justify-between gap-4 px-4 py-3.5">
              <div className="space-y-0.5">
                <Label className="text-sm">全书翻译</Label>
                <p className="text-muted-foreground text-xs">使用辅助模型分批翻译（显著增加耗时）</p>
              </div>
              <Select value={translate} onValueChange={(v) => setBookConvertConfig({ translate: v })}>
                <SelectTrigger className="w-36">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TRANSLATE_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </section>

        {/* 转换队列 */}
        {queueRows.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed py-10 text-muted-foreground dark:border-neutral-700">
            <FileDown className="size-5" />
            <p className="text-sm">转换队列空——拖入或选入 PDF 即开始</p>
          </div>
        ) : (
          <section className="fade-in slide-in-from-bottom-2 animate-in rounded-xl border duration-300 dark:border-neutral-700">
            <div className="flex items-baseline justify-between gap-4 border-b px-4 py-3 dark:border-neutral-700">
              <p className="font-medium text-[11px] text-muted-foreground uppercase tracking-[0.25em]">转换队列</p>
              <span className="text-muted-foreground text-xs">
                {queueRows.filter((t) => t.status === "running" || t.status === "queued").length} 项进行中/排队 · 共{" "}
                {queueRows.length} 行
              </span>
            </div>
            <ul className="divide-y dark:divide-neutral-800">
              {queueRows.map((task) => (
                <QueueRow key={task.taskId} task={task} />
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}
