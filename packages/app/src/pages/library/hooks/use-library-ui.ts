import { useCallback, useState } from "react";

export type ViewMode = "grid" | "list";

export const useLibraryUI = () => {
  const [viewMode, setViewMode] = useState<ViewMode>("grid");
  // 标签列表默认折叠（点开才展开），保持侧栏清爽
  const [isLibraryExpanded, setIsLibraryExpanded] = useState(false);
  const [showNewTagDialog, setShowNewTagDialog] = useState(false);

  const toggleLibraryExpanded = useCallback(() => {
    setIsLibraryExpanded((prev) => !prev);
  }, []);

  const handleNewTagClick = useCallback(() => {
    setShowNewTagDialog(true);
  }, []);

  const handleCloseNewTagDialog = useCallback(() => {
    setShowNewTagDialog(false);
  }, []);

  return {
    viewMode,
    setViewMode,
    isLibraryExpanded,
    showNewTagDialog,
    toggleLibraryExpanded,
    handleNewTagClick,
    handleCloseNewTagDialog,
  };
};
