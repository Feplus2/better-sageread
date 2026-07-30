import { HIGHLIGHT_COLOR_HEX } from "@/services/constants";
import { useAppSettingsStore } from "@/store/app-settings-store";
import type { BookNote } from "@/types/book";
import { Overlayer } from "foliate-js/overlayer.js";
import { MessageSquarePlus, Quote } from "lucide-react";
import type React from "react";
import { useEffect } from "react";
import { FiCopy } from "react-icons/fi";
import { PiHighlighterFill } from "react-icons/pi";
import { RiDeleteBinLine } from "react-icons/ri";
import { useAnnotator } from "../../hooks/use-annotator";
import { useFoliateEvents } from "../../hooks/use-foliate-events";
import { useTextSelector } from "../../hooks/use-text-selector";
import { useReaderStore, useReaderStoreApi } from "../reader-provider";
import AnnotationPopup from "./annotation-popup";

const Annotator: React.FC = () => {
  const { settings } = useAppSettingsStore();
  const store = useReaderStoreApi();

  const bookId = useReaderStore((state) => state.bookId)!;
  const view = useReaderStore((state) => state.view);
  const globalViewSettings = settings.globalViewSettings;

  // 使用 use-annotator hook
  const {
    selection,
    setSelection,
    showAnnotPopup,
    trianglePosition,
    annotPopupPosition,
    highlightOptionsVisible,
    selectedStyle,
    setSelectedStyle,
    selectedColor,
    setSelectedColor,
    annotPopupWidth,
    annotPopupHeight,
    commentOpen,
    commentDraft,
    setCommentDraft,
    handleDismissPopup,
    handleCopy,
    handleHighlight,
    handleQuoteToChat,
    handleToggleComment,
    handleSaveComment,
  } = useAnnotator({ bookId });

  const { handleScroll, handleMouseUp, handleShowPopup } = useTextSelector(bookId, setSelection, handleDismissPopup);

  const onLoad = (event: Event) => {
    const detail = (event as CustomEvent).detail;
    const { doc, index } = detail;

    view?.renderer?.addEventListener("scroll", handleScroll);

    if (detail.doc) {
      detail.doc.addEventListener("mouseup", () => {
        handleMouseUp(doc, index);
      });
    }
  };

  const onDrawAnnotation = (event: Event) => {
    const detail = (event as CustomEvent).detail;
    const { draw, annotation, doc, range } = detail;
    const { style, color } = annotation as BookNote;
    const hexColor = color ? HIGHLIGHT_COLOR_HEX[color] : color;
    if (style === "highlight") {
      draw(Overlayer.highlight, { color: hexColor });
    } else if (["underline", "squiggly"].includes(style as string)) {
      const { defaultView } = doc;
      const node = range.startContainer;
      const el = node.nodeType === 1 ? node : node.parentElement;
      const { writingMode, lineHeight, fontSize } = defaultView.getComputedStyle(el);
      const lineHeightValue =
        Number.parseFloat(lineHeight) || globalViewSettings?.lineHeight! * globalViewSettings?.defaultFontSize!;
      const fontSizeValue = Number.parseFloat(fontSize) || globalViewSettings?.defaultFontSize;
      const strokeWidth = 2;
      const padding = globalViewSettings?.vertical ? (lineHeightValue - fontSizeValue! - strokeWidth) / 2 : strokeWidth;
      draw(Overlayer[style as keyof typeof Overlayer], { writingMode, color: hexColor, padding });
    }
  };

  const onShowAnnotation = (event: Event) => {
    const detail = (event as CustomEvent).detail;
    const { value: cfi, index, range } = detail;
    const currentConfig = store.getState().config;

    const { booknotes = [] } = currentConfig!;
    const annotations = booknotes.filter((booknote) => booknote.type === "annotation" && !booknote.deletedAt);
    const annotation = annotations.find((annotation) => annotation.cfi === cfi);

    if (!annotation) return;

    const newSelection = { key: bookId, annotated: true, text: annotation.text ?? "", range, index };

    setSelectedStyle(annotation.style!);
    setSelectedColor(annotation.color!);
    setSelection(newSelection);
  };

  useFoliateEvents(view, { onLoad, onDrawAnnotation, onShowAnnotation });

  // 同步 popup 显示状态到 text selector
  // biome-ignore lint/correctness/useExhaustiveDependencies: <explanation>
  useEffect(() => {
    handleShowPopup(showAnnotPopup);
  }, [showAnnotPopup]);

  const selectionAnnotated = selection?.annotated;
  const buttons = [
    { label: "复制", Icon: FiCopy, onClick: handleCopy },
    { label: "Ask AI", Icon: Quote, onClick: handleQuoteToChat },
    {
      label: undefined,
      Icon: selectionAnnotated ? RiDeleteBinLine : PiHighlighterFill,
      onClick: handleHighlight,
    },
    // 评论（标注-笔记二合一，落 book_notes.note）：仅"已有标注"回显态开放，新建选区不设独立评论按钮；
    // 竖排模式下弹窗为窄列，不开放内嵌输入
    ...(selectionAnnotated && !globalViewSettings?.vertical
      ? [{ label: undefined as string | undefined, Icon: MessageSquarePlus, onClick: handleToggleComment }]
      : []),
  ];

  return (
    <div>
      {showAnnotPopup && trianglePosition && annotPopupPosition && (
        <AnnotationPopup
          dir={globalViewSettings?.rtl ? "rtl" : "ltr"}
          isVertical={globalViewSettings?.vertical ?? false}
          buttons={buttons}
          position={annotPopupPosition}
          trianglePosition={trianglePosition}
          highlightOptionsVisible={highlightOptionsVisible}
          selectedStyle={selectedStyle}
          selectedColor={selectedColor}
          popupWidth={annotPopupWidth}
          popupHeight={annotPopupHeight}
          onHighlight={handleHighlight}
          commentOpen={commentOpen}
          commentDraft={commentDraft}
          onCommentDraftChange={setCommentDraft}
          onSaveComment={handleSaveComment}
          onToggleComment={handleToggleComment}
        />
      )}
    </div>
  );
};

export default Annotator;
