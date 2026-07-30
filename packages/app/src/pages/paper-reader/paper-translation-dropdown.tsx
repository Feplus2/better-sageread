import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { PaperAlignmentInfo } from "@/services/paper-alignment-service";
import type { TranslateProgress } from "@/services/paper-translation-service";
import type { PaperViewModeType } from "@/types/settings";
import { AlignLeft, Columns3, FileText, Languages, Loader2, Play, RefreshCw, RotateCcw, X } from "lucide-react";

interface PaperTranslationDropdownProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 当前显示模式（受控，持久化在 app-settings-store） */
  viewMode: PaperViewModeType;
  onViewModeChange: (mode: PaperViewModeType) => void;
  /** 是否已有译本（决定"重新翻译"项与"句词对齐"区的显隐、模式切换引导） */
  hasTranslation: boolean;
  /** 翻译进度；非 null 表示翻译中 */
  translating: TranslateProgress | null;
  /** force=false 幂等续翻 / force=true 全部重翻 */
  onTranslate: (force: boolean) => void;
  onCancelTranslate: () => void;
  /** 句/词对齐覆盖情况（状态行"句 n/m · 词 n/m 已对齐"；null = 检查中） */
  alignInfo: PaperAlignmentInfo | null;
  /** 对齐计算中（句词两级同一标志；计算中"重建对齐"禁用） */
  aligning: boolean;
  /** 手动重建对齐（force 全量重算句词两级，服务侧幂等；无嵌入模型时给配置引导 toast） */
  onRebuildAlign: () => void;
}

const MODE_ITEMS: { value: PaperViewModeType; label: string; icon: typeof FileText }[] = [
  { value: "original", label: "原文", icon: FileText },
  { value: "translated", label: "译文", icon: Languages },
  { value: "bilingual", label: "逐段对照", icon: Columns3 },
];

/** 论文翻译下拉（三区结构）：显示模式（radio）+ 翻译入口/进度 + 句词对齐状态与重建 */
export default function PaperTranslationDropdown({
  open,
  onOpenChange,
  viewMode,
  onViewModeChange,
  hasTranslation,
  translating,
  onTranslate,
  onCancelTranslate,
  alignInfo,
  aligning,
  onRebuildAlign,
}: PaperTranslationDropdownProps) {
  const busy = translating !== null;
  const percent = busy && translating.total > 0 ? Math.round((translating.done / translating.total) * 100) : 0;

  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <button className="btn btn-ghost flex h-6 w-6 items-center justify-center rounded-full p-0 outline-none focus:outline-none focus-visible:ring-0">
              {busy ? (
                <Loader2 size={16} className="animate-spin text-base-content" />
              ) : (
                <Languages size={18} className="text-base-content" />
              )}
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">翻译</TooltipContent>
      </Tooltip>
      <DropdownMenuContent className="w-60 p-2" align="end" side="bottom" sideOffset={4}>
        {/* 区 1：显示模式（radio 语义，指示点 + 图标 + 当前选中态） */}
        <DropdownMenuLabel className="px-2 py-1 text-neutral-500 text-xs dark:text-neutral-400">
          显示模式
        </DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={viewMode}
          onValueChange={(value) => onViewModeChange(value as PaperViewModeType)}
        >
          {MODE_ITEMS.map((item) => (
            <DropdownMenuRadioItem key={item.value} value={item.value} className="text-sm">
              <item.icon className="size-4 text-neutral-500 dark:text-neutral-400" />
              {item.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>

        <DropdownMenuSeparator className="my-2" />

        {/* 区 2：翻译（按译本状态显示可用项；翻译中为主题色进度条 + 百分比 + 取消） */}
        <DropdownMenuLabel className="px-2 py-1 text-neutral-500 text-xs dark:text-neutral-400">翻译</DropdownMenuLabel>
        {busy ? (
          <div className="px-2 py-1.5">
            <div className="mb-1.5 flex items-center justify-between text-neutral-600 text-xs dark:text-neutral-400">
              <span>
                翻译中 {translating.done}/{translating.total}（{percent}%）
              </span>
              <button
                type="button"
                className="flex items-center gap-0.5 text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200"
                onClick={onCancelTranslate}
              >
                <X className="size-3.5" />
                取消
              </button>
            </div>
            {/* 进度条颜色跟随全局主题主色 --primary（轨道用 color-mix 调浓度，明暗主题自动适配，
                与 index.css 的 .paper-sentence-hover-rect 同一主题跟随写法） */}
            <div
              className="h-1.5 w-full overflow-hidden rounded-full"
              style={{ backgroundColor: "color-mix(in oklab, var(--primary) 15%, transparent)" }}
            >
              <div
                className="h-full rounded-full transition-all duration-300"
                style={{ width: `${percent}%`, backgroundColor: "var(--primary)" }}
              />
            </div>
          </div>
        ) : (
          <>
            <DropdownMenuItem className="text-sm" onSelect={() => onTranslate(false)}>
              <Play className="size-4" />
              {hasTranslation ? "继续翻译（跳过已翻）" : "翻译本文"}
            </DropdownMenuItem>
            {hasTranslation && (
              <DropdownMenuItem className="text-sm" onSelect={() => onTranslate(true)}>
                <RotateCcw className="size-4" />
                重新翻译（全部重翻）
              </DropdownMenuItem>
            )}
          </>
        )}

        {/* 区 3：句词对齐（有译本时始终可见；仅计算中禁用；无嵌入模型点击给引导 toast） */}
        {hasTranslation && !busy && (
          <>
            <DropdownMenuSeparator className="my-2" />
            <DropdownMenuLabel className="px-2 py-1 text-neutral-500 text-xs dark:text-neutral-400">
              句词对齐
            </DropdownMenuLabel>
            <div className="flex items-center gap-1.5 px-2 py-1 text-neutral-500 text-xs dark:text-neutral-400">
              <AlignLeft className="size-3.5" />
              {alignInfo
                ? `句 ${alignInfo.aligned}/${alignInfo.total} · 词 ${alignInfo.alignedW}/${alignInfo.total} 已对齐`
                : "对齐状态检查中…"}
            </div>
            <DropdownMenuItem className="text-sm" disabled={aligning} onSelect={onRebuildAlign}>
              {aligning ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
              {aligning ? "对齐计算中…" : "重建对齐"}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
