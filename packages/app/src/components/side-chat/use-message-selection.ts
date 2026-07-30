import { useEffect, useState } from "react";

/**
 * 消息多选导出状态：进入/退出选择模式、勾选切换。
 * 切换对话自动退出；选择模式下 Esc 退出。
 */
export function useMessageSelection(threadId: string | undefined) {
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const exitSelectionMode = () => {
    setSelectionMode(false);
    setSelectedIds(new Set());
  };

  const toggleSelectionMode = () => {
    if (selectionMode) {
      exitSelectionMode();
    } else {
      setSelectionMode(true);
    }
  };

  const handleToggleSelect = (messageId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(messageId)) {
        next.delete(messageId);
      } else {
        next.add(messageId);
      }
      return next;
    });
  };

  // 切换对话时退出选择模式
  // biome-ignore lint/correctness/useExhaustiveDependencies: 仅按对话 id 重置
  useEffect(() => {
    exitSelectionMode();
  }, [threadId]);

  // Esc 退出选择模式
  useEffect(() => {
    if (!selectionMode) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setSelectionMode(false);
        setSelectedIds(new Set());
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [selectionMode]);

  return { selectionMode, selectedIds, toggleSelectionMode, exitSelectionMode, handleToggleSelect };
}
