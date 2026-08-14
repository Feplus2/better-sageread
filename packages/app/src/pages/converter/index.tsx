import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useConvertProgressStore } from "@/store/convert-progress-store";
import { useConverterStore } from "@/store/converter-store";
import { open } from "@tauri-apps/plugin-dialog";
import { BookUp, Check, FileDown, FileText, Loader2, X } from "lucide-react";
import { useEffect } from "react";

/** 运行状态与事件监听都在 convert-progress-store（视图卸载不中断接收）；
 *  本组件只是表单视图：大页面（/converter）与图书馆弹层共用同一份状态 */
type StageStatus = "pending" | "active" | "done" | "error";

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

function StageCircle({ status, n }: { status: StageStatus; n: number }) {
  if (status === "done") {
    return (
      <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground">
        <Check className="size-3.5" />
      </span>
    );
  }
  if (status === "active") {
    return (
      <span className="relative flex h-6 w-6 flex-shrink-0">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary/30" />
        <span className="relative inline-flex h-6 w-6 items-center justify-center rounded-full border border-primary bg-background text-primary text-xs">
          {n}
        </span>
      </span>
    );
  }
  if (status === "error") {
    return (
      <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-destructive text-destructive-foreground">
        <X className="size-3.5" />
      </span>
    );
  }
  return (
    <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full border text-muted-foreground text-xs">
      {n}
    </span>
  );
}

export default function ConverterPage() {
  const bookConvert = useConvertProgressStore((s) => s.bookConvert);
  const setBookConvertConfig = useConvertProgressStore((s) => s.setBookConvertConfig);
  const resetBookConvert = useConvertProgressStore((s) => s.resetBookConvert);
  const startBookConvert = useConvertProgressStore((s) => s.startBookConvert);
  const cancelBookConvert = useConvertProgressStore((s) => s.cancelBookConvert);
  const importBookConvertResult = useConvertProgressStore((s) => s.importBookConvertResult);
  const { mineruToken, paddleocrToken, engine } = useConverterStore();
  const hasEngineToken = engine === "paddleocr" ? !!paddleocrToken : !!mineruToken;

  const { pdfPath, ocr, translate, status, percent, detail, stages, errorMessage, epubPath, importing } = bookConvert;

  // 视图卸载（弹层关闭/路由切走）时若转换仍在进行或有结果未处理 → 最小化为全局右下角小卡
  // （进度接收在 store 不受影响；小卡点击可回到大窗口，见 global-convert-progress）
  useEffect(() => {
    return () => {
      const s = useConvertProgressStore.getState();
      if (s.bookConvert.status !== "idle") {
        useConvertProgressStore.setState({ bookConvertMinimized: true });
      }
    };
  }, []);

  const handleSelectPdf = async () => {
    try {
      const selected = await open({
        filters: [{ name: "PDF", extensions: ["pdf"] }],
        multiple: false,
      });
      if (typeof selected === "string") {
        // 换文件 = 丢弃上一轮结果（含解除旧监听）
        resetBookConvert();
        setBookConvertConfig({ pdfPath: selected });
      }
    } catch (e) {
      console.warn("选择 PDF 失败:", e);
    }
  };

  const pdfName = pdfPath?.split(/[\\/]/).pop() ?? "";
  const epubName = epubPath?.split(/[\\/]/).pop() ?? "";
  const converting = status === "converting";

  return (
    <div data-region="converter-page" className="flex h-full flex-col overflow-y-auto">
      <div className="mx-auto w-full max-w-2xl space-y-6 p-6 py-8">
        {/* 页眉 */}
        <header className="space-y-3 border-b pb-6 dark:border-neutral-700">
          <p className="font-medium text-[11px] text-muted-foreground uppercase tracking-[0.25em]">
            Books_Converter · Hybrid 引擎
          </p>
          <h1 className="font-bold font-serif text-3xl dark:text-neutral-100">PDF 转 EPUB</h1>
          <p className="text-muted-foreground text-sm">
            MinerU 云端解析 + 辅助模型结构重建，转换为排版精良的 EPUB 并一键入库
          </p>
        </header>

        {/* 设置卡片 */}
        <section className="rounded-xl border dark:border-neutral-700">
          <div className="p-4">
            {pdfPath ? (
              <div className="flex items-center gap-3 rounded-lg bg-muted/40 px-3 py-2.5">
                <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                  <FileText className="size-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium text-sm dark:text-neutral-100">{pdfName}</p>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <p className="truncate text-muted-foreground text-xs">{pdfPath}</p>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">{pdfPath}</TooltipContent>
                  </Tooltip>
                </div>
                {!converting && (
                  <Button variant="ghost" size="sm" onClick={handleSelectPdf}>
                    更换
                  </Button>
                )}
              </div>
            ) : (
              <button
                type="button"
                onClick={handleSelectPdf}
                className="flex w-full flex-col items-center gap-2 rounded-lg border border-dashed px-4 py-8 text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground dark:border-neutral-700"
              >
                <FileText className="size-6" />
                <span className="text-sm">选择 PDF 文件</span>
                <span className="text-xs">仅支持 .pdf 格式</span>
              </button>
            )}
          </div>

          <div className="divide-y border-t dark:divide-neutral-800 dark:border-neutral-700">
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
                disabled={converting}
              />
            </div>

            <div className="flex items-center justify-between gap-4 px-4 py-3.5">
              <div className="space-y-0.5">
                <Label className="text-sm">全书翻译</Label>
                <p className="text-muted-foreground text-xs">使用辅助模型分批翻译（显著增加耗时）</p>
              </div>
              <Select
                value={translate}
                onValueChange={(v) => setBookConvertConfig({ translate: v })}
                disabled={converting}
              >
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

          <div className="border-t px-4 py-4 dark:border-neutral-700">
            {!hasEngineToken && (
              <p className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-amber-700 text-sm dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-400">
                尚未配置 {engine === "paddleocr" ? "PaddleOCR" : "MinerU"} Token，请前往 设置 → PDF 转换
                填写后再开始转换。
              </p>
            )}
            {converting ? (
              <Button variant="outline" onClick={() => void cancelBookConvert()} className="w-full">
                取消转换
              </Button>
            ) : (
              <Button onClick={() => void startBookConvert()} disabled={!pdfPath || !hasEngineToken} className="w-full">
                <FileDown className="size-4" />
                开始转换
              </Button>
            )}
          </div>
        </section>

        {/* 进度 / 结果 */}
        {status === "idle" ? (
          <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed py-10 text-muted-foreground dark:border-neutral-700">
            <FileDown className="size-5" />
            <p className="text-sm">转换进度与结果将显示在这里</p>
          </div>
        ) : (
          <section className="fade-in slide-in-from-bottom-2 animate-in rounded-xl border duration-300 dark:border-neutral-700">
            <div className="flex items-baseline justify-between gap-4 px-5 pt-4">
              <div className="min-w-0">
                <p className="font-medium text-[11px] text-muted-foreground uppercase tracking-[0.25em]">转换进度</p>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <p className="truncate font-medium dark:text-neutral-100">{pdfName}</p>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">{pdfName}</TooltipContent>
                </Tooltip>
              </div>
              <span className="flex-shrink-0 font-serif text-3xl tabular-nums dark:text-neutral-100">
                {Math.round(percent)}
                <span className="text-base text-muted-foreground">%</span>
              </span>
            </div>

            <div className="px-5 pt-3">
              <Progress value={percent} className="h-1.5" />
            </div>

            <ol className="px-5 py-5">
              {stages.map((s, i) => (
                <li key={s.n} className="relative flex gap-3 pb-5 last:pb-0">
                  {i < stages.length - 1 && (
                    <span
                      className={cn(
                        "absolute top-6 left-[11px] h-[calc(100%-24px)] w-px",
                        s.status === "done" ? "bg-primary/40" : "bg-border",
                      )}
                    />
                  )}
                  <StageCircle status={s.status} n={s.n} />
                  <div className="min-w-0 flex-1 pt-0.5">
                    <div className="flex items-baseline justify-between gap-2">
                      <span
                        className={cn(
                          "text-sm",
                          s.status === "pending" ? "text-muted-foreground" : "font-medium dark:text-neutral-100",
                        )}
                      >
                        {s.name}
                      </span>
                      {s.status === "done" && s.elapsed !== undefined && (
                        <span className="text-muted-foreground text-xs tabular-nums">{Math.round(s.elapsed)}s</span>
                      )}
                    </div>
                    {s.status === "active" && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <p className="mt-0.5 truncate text-muted-foreground text-xs">{detail || "处理中..."}</p>
                        </TooltipTrigger>
                        <TooltipContent side="bottom">{detail}</TooltipContent>
                      </Tooltip>
                    )}
                  </div>
                </li>
              ))}
            </ol>

            {status === "done" && (
              <div className="mx-5 mb-5 flex items-center gap-3 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 dark:border-emerald-900 dark:bg-emerald-950/40">
                <Check className="size-4 flex-shrink-0 text-emerald-600 dark:text-emerald-400" />
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-emerald-800 text-sm dark:text-emerald-300">转换完成</p>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <p className="truncate text-emerald-600 text-xs dark:text-emerald-500">{epubName}</p>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">{epubPath ?? ""}</TooltipContent>
                  </Tooltip>
                </div>
                <Button size="sm" onClick={() => void importBookConvertResult()} disabled={importing}>
                  {importing ? <Loader2 className="size-4 animate-spin" /> : <BookUp className="size-4" />}
                  导入图书馆
                </Button>
              </div>
            )}

            {status === "error" && (
              <div className="mx-5 mb-5 rounded-lg border border-red-200 bg-red-50 px-4 py-3 dark:border-red-900 dark:bg-red-950/40">
                <p className="font-medium text-red-700 text-sm dark:text-red-400">转换失败</p>
                <p className="mt-0.5 break-all text-red-600 text-xs dark:text-red-500">{errorMessage}</p>
              </div>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
