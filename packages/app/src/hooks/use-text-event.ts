import type { ExplainTextEventDetail, ImageToChatEventDetail, QuoteToChatEventDetail } from "@/services/iframe-service";
import { useCallback, useEffect } from "react";

interface UseTextEventHandlerOptions {
  sendMessage: any;
  onTextReceived?: (text: string) => void;
  /** "Ask AI"：把选中文本注入输入框引用区（不自动发送） */
  onQuoteReference?: (text: string) => void;
  /** 阅读区图片引用：以附件注入输入区（不自动发送） */
  onImageReference?: (image: { dataUrl: string; mediaType: string; name: string }) => void;
  activeBookId?: string;
}

export const useTextEventHandler = (options: UseTextEventHandlerOptions) => {
  const { sendMessage, onTextReceived, onQuoteReference, onImageReference, activeBookId } = options;

  const handleTextEvent = useCallback(
    (event: CustomEvent<ExplainTextEventDetail>) => {
      const { selectedText, question, bookId } = event.detail;

      if (bookId && bookId !== activeBookId) {
        return;
      }

      if (selectedText && question) {
        onTextReceived?.(selectedText);

        const parts = [
          {
            type: "quote",
            text: selectedText,
            source: "引用",
          },
          {
            type: "text",
            text: question,
          },
        ];

        sendMessage({ parts });
      }
    },
    [sendMessage, onTextReceived, activeBookId],
  );

  const handleQuoteToChatEvent = useCallback(
    (event: CustomEvent<QuoteToChatEventDetail>) => {
      const { selectedText, bookId } = event.detail;

      if (bookId && bookId !== activeBookId) {
        return;
      }

      if (selectedText) {
        onQuoteReference?.(selectedText);
      }
    },
    [onQuoteReference, activeBookId],
  );

  const handleImageToChatEvent = useCallback(
    (event: CustomEvent<ImageToChatEventDetail>) => {
      const { dataUrl, mediaType, name, bookId } = event.detail;

      if (bookId && bookId !== activeBookId) {
        return;
      }

      if (dataUrl) {
        onImageReference?.({ dataUrl, mediaType, name });
      }
    },
    [onImageReference, activeBookId],
  );

  useEffect(() => {
    window.addEventListener("explainText", handleTextEvent as EventListener);

    return () => {
      window.removeEventListener("explainText", handleTextEvent as EventListener);
    };
  }, [handleTextEvent]);

  useEffect(() => {
    window.addEventListener("quoteToChat", handleQuoteToChatEvent as EventListener);

    return () => {
      window.removeEventListener("quoteToChat", handleQuoteToChatEvent as EventListener);
    };
  }, [handleQuoteToChatEvent]);

  useEffect(() => {
    window.addEventListener("imageToChat", handleImageToChatEvent as EventListener);

    return () => {
      window.removeEventListener("imageToChat", handleImageToChatEvent as EventListener);
    };
  }, [handleImageToChatEvent]);
};
