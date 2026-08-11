import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  PAPER_EXPORT_MODE_LABELS,
  type PaperExportFormat,
  type PaperExportMode,
  exportPaperDocument,
} from "@/lib/export-paper";
import { cn } from "@/lib/utils";
import type { PaperTranslatedMeta, PaperTranslationFile } from "@/services/paper-translation-service";
import type { BookNote } from "@/types/book";
import type { PaperViewModeType } from "@/types/settings";
import {
  Bookmark,
  Check,
  Columns3,
  Download,
  FileCode,
  FileText,
  FileType2,
  Globe,
  Image as ImageIcon,
  Languages,
  Loader2,
} from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";

interface PaperExportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  paperId: string;
  /** 论文标题（保存默认名/文档头回退） */
  title: string;
  /** paper.md 原文（已加载完成才允许打开） */
  markdown: string;
  /** 译本块文本；null = 无译本（译文/对照选项禁用） */
  translationMap: ReadonlyMap<number, string> | null;
  /** 译本文件本体（含句/词对齐表；译文/对照模式标注内联的跨语言映射） */
  translationFile: PaperTranslationFile | null;
  translatedMeta: PaperTranslatedMeta | null;
  annotations: BookNote[];
  /** 阅读区当前显示模式（作为导出内容的默认选中项） */
  currentViewMode: PaperViewModeType;
}

const MODE_OPTIONS: { value: PaperExportMode; desc: string; icon: typeof FileText; needTranslation?: boolean }[] = [
  { value: "original", desc: "未经翻译的原始文档", icon: FileText },
  { value: "translated", desc: "仅中文译文", icon: Languages, needTranslation: true },
  { value: "bilingual", desc: "原文段落 + 中文译文", icon: Columns3, needTranslation: true },
];

const FORMAT_OPTIONS: { value: PaperExportFormat; label: string; hint: string; icon: typeof FileCode }[] = [
  { value: "markdown", label: "Markdown", hint: "纯文本可编辑", icon: FileCode },
  { value: "html", label: "HTML", hint: "自包含网页", icon: Globe },
  { value: "pdf", label: "PDF", hint: "打印页另存", icon: FileType2 },
];

/** 选中指示圈：选中为主色填充 + 对勾，未选中为细环 */
function SelectionCircle({ selected }: { selected: boolean }) {
  return selected ? (
    <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground">
      <Check className="size-3" strokeWidth={3} />
    </span>
  ) : (
    <span className="size-5 shrink-0 rounded-full border border-muted-foreground/30" />
  );
}

/** 选项卡片：图标块 + 标题/描述双行 + 尾部指示（radio 语义） */
function OptionCard({
  selected,
  disabled,
  onSelect,
  icon: Icon,
  title,
  desc,
  trailing,
}: {
  selected: boolean;
  disabled?: boolean;
  onSelect: () => void;
  icon: typeof FileText;
  title: ReactNode;
  desc: ReactNode;
  trailing?: ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        "group flex w-full items-center gap-3 rounded-xl border px-3 py-3 text-left transition-all",
        selected
          ? "border-primary/60 bg-primary/[0.04] shadow-[0_1px_2px_oklch(0_0_0/0.04)]"
          : "border-border/70 hover:border-primary/30 hover:bg-muted/40",
        disabled && "cursor-not-allowed opacity-45 hover:border-border/70 hover:bg-transparent",
      )}
    >
      <span
        className={cn(
          "flex size-9 shrink-0 items-center justify-center rounded-lg transition-colors",
          selected ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground group-hover:text-foreground",
        )}
      >
        <Icon className="size-4" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="font-medium text-sm leading-tight">{title}</span>
        <span className="truncate text-muted-foreground text-xs">{desc}</span>
      </span>
      {trailing ?? <SelectionCircle selected={selected} />}
    </button>
  );
}

/** 区块标题（内容/附加/格式）：小字距标签，与卡片拉开层级 */
function SectionLabel({ children }: { children: ReactNode }) {
  return <div className="font-medium text-muted-foreground text-xs tracking-wider">{children}</div>;
}

/** 论文导出对话框：内容（原文/译文/对照）+ 附加（标注/图片）+ 格式（Markdown/HTML/PDF） */
export default function PaperExportDialog({
  open,
  onOpenChange,
  paperId,
  title,
  markdown,
  translationMap,
  translationFile,
  translatedMeta,
  annotations,
  currentViewMode,
}: PaperExportDialogProps) {
  const hasTranslation = translationMap !== null;
  const [mode, setMode] = useState<PaperExportMode>("original");
  const [includeAnnotations, setIncludeAnnotations] = useState(true);
  const [includeImages, setIncludeImages] = useState(true);
  const [format, setFormat] = useState<PaperExportFormat>("markdown");
  const [exporting, setExporting] = useState(false);

  // 每次打开重置：内容默认跟随阅读区当前显示模式（无译本回退原文）
  useEffect(() => {
    if (open) {
      setMode(hasTranslation ? currentViewMode : "original");
      setIncludeAnnotations(annotations.length > 0);
      setIncludeImages(true);
      setFormat("markdown");
      setExporting(false);
    }
  }, [open, hasTranslation, currentViewMode, annotations.length]);

  const handleExport = async () => {
    setExporting(true);
    try {
      const done = await exportPaperDocument({
        paperId,
        title,
        markdown,
        translationMap,
        translationFile,
        translatedMeta,
        annotations,
        mode,
        includeAnnotations,
        includeImages,
        format,
      });
      if (done) onOpenChange(false);
    } finally {
      setExporting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 sm:max-w-md">
        {/* DialogHeader 自带 px-3 py-4 + border-b + 关闭按钮行；px-5 与内容区对齐。
            DialogDescription 自带 px-4（组件预设），此处归零与标题对齐 */}
        <DialogHeader className="px-5">
          <DialogTitle>导出论文</DialogTitle>
          <DialogDescription className="px-0">正文、标注与图片将合并为一份文档</DialogDescription>
        </DialogHeader>

        <div className="space-y-5 px-5 py-4">
          {/* 内容：原文/译文/对照（无译本禁用后两项） */}
          <section className="space-y-2">
            <SectionLabel>内容</SectionLabel>
            <div className="space-y-1.5">
              {MODE_OPTIONS.map((option) => {
                const disabled = option.needTranslation && !hasTranslation;
                return (
                  <OptionCard
                    key={option.value}
                    selected={mode === option.value}
                    disabled={disabled}
                    onSelect={() => setMode(option.value)}
                    icon={option.icon}
                    title={PAPER_EXPORT_MODE_LABELS[option.value]}
                    desc={disabled ? "本文尚无译本" : option.desc}
                  />
                );
              })}
            </div>
          </section>

          {/* 附加：标注/图片（整行可点，Checkbox 置 pointer-events-none 防双触发） */}
          <section className="space-y-2">
            <SectionLabel>附加</SectionLabel>
            <div className="space-y-1.5">
              <OptionCard
                selected={includeAnnotations && annotations.length > 0}
                disabled={annotations.length === 0}
                onSelect={() => annotations.length > 0 && setIncludeAnnotations((v) => !v)}
                icon={Bookmark}
                title="附标注"
                desc={
                  annotations.length > 0
                    ? `${annotations.length} 条，含评论；HTML 内联高亮，文末附列表`
                    : "本文暂无标注"
                }
                trailing={
                  <Checkbox
                    className="pointer-events-none shrink-0"
                    tabIndex={-1}
                    checked={includeAnnotations && annotations.length > 0}
                  />
                }
              />
              <OptionCard
                selected={includeImages}
                onSelect={() => setIncludeImages((v) => !v)}
                icon={ImageIcon}
                title="嵌入图片"
                desc="内联为 data URI，单文件自包含"
                trailing={<Checkbox className="pointer-events-none shrink-0" tabIndex={-1} checked={includeImages} />}
              />
            </div>
          </section>

          {/* 格式：三列紧凑卡片 */}
          <section className="space-y-2">
            <SectionLabel>格式</SectionLabel>
            <div className="grid grid-cols-3 gap-1.5">
              {FORMAT_OPTIONS.map((option) => {
                const selected = format === option.value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => setFormat(option.value)}
                    className={cn(
                      "flex flex-col items-center gap-1.5 rounded-xl border px-2 py-3 transition-all",
                      selected
                        ? "border-primary/60 bg-primary/[0.04] text-foreground"
                        : "border-border/70 text-muted-foreground hover:border-primary/30 hover:bg-muted/40",
                    )}
                  >
                    <option.icon className={cn("size-4", selected && "text-primary")} />
                    <span className="font-medium text-sm leading-none">{option.label}</span>
                    <span className="text-[11px] text-muted-foreground leading-none">{option.hint}</span>
                  </button>
                );
              })}
            </div>
          </section>
        </div>

        <DialogFooter className="border-t px-5 pt-4">
          <Button variant="outline" disabled={exporting} onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button disabled={exporting} onClick={handleExport}>
            {exporting ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
            导出
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
