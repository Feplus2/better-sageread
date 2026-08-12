import { Textarea } from "@/components/ui/textarea";
import { HIGHLIGHT_COLOR_HEX } from "@/services/constants";
import { useAppSettingsStore } from "@/store/app-settings-store";
import type { BookNote, HighlightColor, HighlightStyle } from "@/types/book";
import { ask } from "@tauri-apps/plugin-dialog";
import clsx from "clsx";
import { Check, MessageSquarePlus, Quote } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FaCheckCircle } from "react-icons/fa";
import { FiCopy } from "react-icons/fi";
import { PiHighlighterFill } from "react-icons/pi";
import { RiDeleteBinLine } from "react-icons/ri";

/** 弹窗尺寸（位置计算用；宽度按状态自适应：选区态只有三个按钮，已有标注态才需容纳笔触+颜色行约 260px） */
export const PAPER_ANNO_POPUP_WIDTH = 272;
export const PAPER_ANNO_POPUP_WIDTH_COMPACT = 224;
export const PAPER_ANNO_POPUP_HEIGHT = 44;

const STYLES: HighlightStyle[] = ["highlight", "underline", "squiggly"];
const COLORS: HighlightColor[] = ["red", "violet", "blue", "green", "yellow"];

export interface PaperAnnotationPopupProps {
  /** 视口坐标（已做避让，fixed 定位） */
  x: number;
  y: number;
  /** 已有标注（回显/改笔触改色/写评论/删除）；null = 新建模式 */
  annotation: BookNote | null;
  /** 标亮按钮禁用（译文划词且该段无句对齐映射） */
  highlightDisabled?: boolean;
  /** 标亮禁用原因（按钮 tooltip） */
  highlightDisabledReason?: string;
  onCopy: () => void;
  /** Ask AI：文本作为 quote 注入论文助手输入框 */
  onQuoteToChat: () => void;
  /** 新建模式点高亮：以当前默认笔触/颜色创建（随后弹窗切到已有模式） */
  onHighlight: () => void;
  /** 已有模式改笔触/颜色（立即落库） */
  onChangeStyleColor: (style: HighlightStyle, color: HighlightColor) => void;
  /** 保存评论（仅已有模式可写，更新 book_notes.note） */
  onSaveNote: (note: string) => void;
  /** 删除已有标注 */
  onDelete?: () => void;
  onClose: () => void;
}

/**
 * 论文标注弹窗（复刻书籍 annotator 的 popup-container 交互）：
 * 新建选区只有 复制 / Ask AI / 高亮 三个按钮；已有标注时按钮为 复制 / Ask AI | 删除 / 评论，
 * 并展开笔触选择（highlight/underline/squiggly）+ 5 色圆点（rounded-3xl 胶囊行）；
 * 评论为内嵌输入框（标注-笔记二合一，落 book_notes.note，仅已有标注态可展开）。
 * 译文区划词（T2）：按钮同新建模式；标亮经句对齐映射创建英文锚点标注，该段无句对齐时
 * 标亮禁用并提示（highlightDisabled/Reason）。复制/Ask AI 始终用中文选中文本。
 * 通过 portal 挂到 body，fixed 定位，不受阅读区 overflow 容器裁剪。
 */
export function PaperAnnotationPopup({
  x,
  y,
  annotation,
  highlightDisabled = false,
  highlightDisabledReason,
  onCopy,
  onQuoteToChat,
  onHighlight,
  onChangeStyleColor,
  onSaveNote,
  onDelete,
  onClose,
}: PaperAnnotationPopupProps) {
  const { settings, setSettings } = useAppSettingsStore();
  const globalReadSettings = settings.globalReadSettings;
  const defaultStyle = globalReadSettings.highlightStyle;
  const defaultColor = globalReadSettings.highlightStyles[defaultStyle];

  const [selectedStyle, setSelectedStyle] = useState<HighlightStyle>(annotation?.style ?? defaultStyle);
  const [selectedColor, setSelectedColor] = useState<HighlightColor>(annotation?.color ?? defaultColor);
  const [noteOpen, setNoteOpen] = useState(false);
  const [noteValue, setNoteValue] = useState(annotation?.note ?? "");
  const rootRef = useRef<HTMLDivElement>(null);

  // 新建 → 已有 模式切换（同一组件实例）或标注对象更新后，以标注内容回显笔触/颜色；
  // 评论草稿只在切换到另一条标注时重置（避免改笔触/颜色时清空正在输入的评论）
  const annotationId = annotation?.id ?? null;
  const prevAnnotationIdRef = useRef<string | null>(annotationId);
  // biome-ignore lint/correctness/useExhaustiveDependencies: 默认值取标注变化瞬间的设置即可
  useEffect(() => {
    setSelectedStyle(annotation?.style ?? defaultStyle);
    setSelectedColor(annotation?.color ?? defaultColor);
    if (prevAnnotationIdRef.current !== annotationId) {
      prevAnnotationIdRef.current = annotationId;
      setNoteValue(annotation?.note ?? "");
    }
  }, [annotation, annotationId]);

  // 点击弹窗外 / Escape 关闭（弹窗在 body portal 内，自行监听 document）
  useEffect(() => {
    const handleMouseDown = (event: MouseEvent) => {
      if (rootRef.current && event.target instanceof Node && !rootRef.current.contains(event.target)) {
        onClose();
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", handleMouseDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleMouseDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

  // 笔触/颜色选择与书籍 HighlightOptions 同款：写入 globalReadSettings 持久化，并立即应用到当前标注
  const handleSelectStyle = (style: HighlightStyle) => {
    const color = globalReadSettings.highlightStyles[style];
    globalReadSettings.highlightStyle = style;
    setSettings(settings);
    setSelectedStyle(style);
    setSelectedColor(color);
    if (annotation) onChangeStyleColor(style, color);
  };

  const handleSelectColor = (color: HighlightColor) => {
    globalReadSettings.highlightStyle = selectedStyle;
    globalReadSettings.highlightStyles[selectedStyle] = color;
    setSettings(settings);
    setSelectedColor(color);
    if (annotation) onChangeStyleColor(selectedStyle, color);
  };

  const handleSaveNote = () => {
    onSaveNote(noteValue.trim());
  };

  const handleDelete = async () => {
    if (!onDelete) return;
    try {
      const confirmed = await ask(`确定要删除这条标注吗？\n\n"${annotation?.text || ""}"\n\n此操作无法撤销。`, {
        title: "确认删除",
        kind: "warning",
      });
      if (confirmed) onDelete();
    } catch (error) {
      console.error("删除标注失败:", error);
    }
  };

  // 与书籍 PopupButton 同款按钮样式
  const buttonClass =
    "flex h-6 min-w-6 cursor-pointer items-center justify-center gap-1 rounded p-0 px-1 transition-colors duration-200 hover:bg-neutral-100 dark:hover:bg-neutral-700";

  return createPortal(
    <div
      ref={rootRef}
      className="fixed z-9999 rounded-lg border border-neutral-200 bg-white text-neutral-800 shadow-xl dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-200"
      style={{
        left: x,
        top: y,
        width: annotation ? PAPER_ANNO_POPUP_WIDTH : PAPER_ANNO_POPUP_WIDTH_COMPACT,
      }}
    >
      {/* 按钮行（对齐书籍 selection-buttons）：新建/译文划词 = 复制 / Ask AI | 高亮；已有 = 复制 / Ask AI | 删除 / 评论；
          译文划词且该段无句对齐时高亮禁用（title 说明原因） */}
      <div className="selection-buttons flex h-11 items-center gap-1 whitespace-nowrap px-2">
        <button type="button" className={buttonClass} onClick={onCopy}>
          <FiCopy size={16} />
          <span className="text-sm">复制</span>
        </button>
        <button type="button" className={buttonClass} onClick={onQuoteToChat}>
          <Quote size={16} />
          <span className="text-sm">Ask AI</span>
        </button>
        <div className="mx-1 h-5 w-px bg-neutral-200 dark:bg-neutral-700" />
        <button
          type="button"
          title={annotation ? "删除标注" : highlightDisabled ? highlightDisabledReason : "高亮"}
          className={clsx(buttonClass, highlightDisabled && !annotation && "cursor-not-allowed opacity-40")}
          disabled={highlightDisabled && !annotation}
          onClick={annotation ? handleDelete : onHighlight}
        >
          {annotation ? <RiDeleteBinLine size={16} /> : <PiHighlighterFill size={16} />}
        </button>
        {annotation && (
          <button
            type="button"
            title="评论"
            className={clsx(buttonClass, (noteOpen || annotation.note) && "text-blue-600 dark:text-blue-400")}
            onClick={() => setNoteOpen((v) => !v)}
          >
            <MessageSquarePlus size={16} />
          </button>
        )}
      </div>

      {/* 笔触 + 颜色行（复刻书籍 HighlightOptions：已有标注时展开，点选立即生效） */}
      {annotation && (
        <div className="flex items-center justify-between gap-2 border-neutral-200 border-t px-3 py-2 dark:border-neutral-700">
          <div className="flex gap-2" style={{ height: 28 }}>
            {STYLES.map((styleType) => {
              const isSelected = selectedStyle === styleType;
              const colorHex = HIGHLIGHT_COLOR_HEX[selectedColor];
              return (
                <button
                  key={styleType}
                  type="button"
                  onClick={() => handleSelectStyle(styleType)}
                  className="flex items-center justify-center rounded-full bg-gray-700 p-0 dark:bg-neutral-600"
                  style={{ width: 28, height: 28, minHeight: 28 }}
                >
                  <div
                    style={{
                      width: 16,
                      height: styleType === "squiggly" ? 18 : 16,
                      ...(styleType === "highlight" && isSelected ? { backgroundColor: colorHex } : {}),
                      ...(styleType !== "highlight" && isSelected ? { textDecorationColor: colorHex } : {}),
                    }}
                    className={clsx(
                      "w-4 p-0 text-center leading-none",
                      styleType === "highlight" && (isSelected ? "pt-[2px]" : "bg-gray-300 pt-[2px]"),
                      (styleType === "underline" || styleType === "squiggly") && "text-gray-300 underline decoration-2",
                      styleType === "underline" && !isSelected && "decoration-gray-300",
                      styleType === "squiggly" &&
                        (isSelected ? "decoration-wavy" : "decoration-gray-300 decoration-wavy"),
                    )}
                  >
                    A
                  </div>
                </button>
              );
            })}
          </div>

          <div
            className="flex flex-row items-center justify-center gap-2 rounded-3xl bg-gray-700 px-2 dark:bg-neutral-600"
            style={{ height: 28 }}
          >
            {COLORS.map((color) => {
              const isSelected = selectedColor === color;
              const colorHex = HIGHLIGHT_COLOR_HEX[color];
              return (
                <button
                  key={color}
                  type="button"
                  onClick={() => handleSelectColor(color)}
                  style={{
                    width: 16,
                    height: 16,
                    backgroundColor: !isSelected ? colorHex : "transparent",
                  }}
                  className="rounded-full p-0"
                >
                  {isSelected && <FaCheckCircle size={16} style={{ color: colorHex }} />}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* 评论输入区（标注-笔记二合一：仅已有标注态可展开，保存 = 更新评论） */}
      {noteOpen && (
        <div className="border-neutral-200 border-t p-3 dark:border-neutral-700">
          <Textarea
            value={noteValue}
            onChange={(event) => setNoteValue(event.target.value)}
            placeholder="写下你的想法…"
            rows={3}
            autoFocus
            className="mb-2 resize-none text-sm"
          />
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setNoteOpen(false)}
              className="rounded-md px-2.5 py-1 text-neutral-500 text-xs hover:bg-neutral-100 dark:hover:bg-neutral-700"
            >
              取消
            </button>
            <button
              type="button"
              onClick={handleSaveNote}
              className="flex items-center gap-1 rounded-md bg-primary px-2.5 py-1 text-primary-foreground text-xs hover:bg-primary/90"
            >
              <Check className="size-3.5" />
              保存
            </button>
          </div>
        </div>
      )}
    </div>,
    document.body,
  );
}
