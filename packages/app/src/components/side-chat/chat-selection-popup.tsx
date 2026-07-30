import { Check, Copy, Quote } from "lucide-react";
import { useCallback, useState } from "react";

interface ChatSelectionPopupProps {
  selectedText: string;
  position: { x: number; y: number };
  onClose: () => void;
  onAskAi: (text: string) => void;
  popupRef?: React.RefObject<HTMLDivElement | null>;
}

export const ChatSelectionPopup = ({ selectedText, position, onClose, onAskAi, popupRef }: ChatSelectionPopupProps) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(
    async (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();

      if (!selectedText.trim()) return;

      try {
        await navigator.clipboard.writeText(selectedText.trim());
        setCopied(true);
        setTimeout(() => {
          setCopied(false);
        }, 2000);
      } catch (error) {
        console.error("复制失败:", error);
      }
    },
    [selectedText],
  );

  const handleAskAi = useCallback(() => {
    const text = selectedText.trim();
    if (!text) return;
    onAskAi(text);
    onClose();
  }, [selectedText, onAskAi, onClose]);

  return (
    <div
      ref={popupRef}
      className="fixed"
      style={{
        left: `${position.x}px`,
        top: `${position.y}px`,
        transform: "translate(-50%, calc(-100% - 8px))",
      }}
    >
      <div className="rounded-md border bg-popover p-1 text-popover-foreground shadow-md">
        <div className="flex flex-nowrap items-center p-2 py-0.5">
          <div
            className="flex cursor-pointer items-center gap-1 border-r pr-2 hover:text-neutral-900 dark:hover:text-neutral-100"
            onClick={handleCopy}
          >
            {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
          </div>

          <div
            className="flex cursor-pointer items-center gap-1 pl-2 hover:text-neutral-900 dark:hover:text-neutral-100"
            onClick={handleAskAi}
          >
            <Quote className="size-4" />
            <span className="whitespace-nowrap text-sm">Ask AI</span>
          </div>
        </div>
      </div>
    </div>
  );
};
