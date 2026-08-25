import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { MotionSidebarCollapse } from "@/components/motion/sidebar-motion";
import CreateTagDialog from "@/pages/library/components/create-tag-dialog";
import EditTagDialog from "@/pages/library/components/edit-tag-dialog";
import SearchToggle from "@/pages/library/components/search-toggle";
import TagList from "@/pages/library/components/tag-list";
import { useBooksOperations } from "@/pages/library/hooks/use-books-operations";
import { useLibraryUI } from "@/pages/library/hooks/use-library-ui";
import { useTagsManagement } from "@/pages/library/hooks/use-tags-management";
import { useTagsOperations } from "@/pages/library/hooks/use-tags-operations";
import { getTrashedBooks } from "@/services/book-service";
import { useLibraryStore } from "@/store/library-store";
import clsx from "clsx";
import {
  BarChart3,
  Brain,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  GraduationCap,
  Library,
  Lightbulb,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router";

interface NavigationItem {
  path: string;
  label: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
}

export default function Sidebar() {
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { searchQuery, booksWithStatus, refreshBooks, setSearchQuery } = useLibraryStore();
  const selectedTagFromUrl = searchParams.get("tag") || "all";
  const { tags, filteredBooksByTag } = useTagsManagement(booksWithStatus, selectedTagFromUrl);
  const { isLibraryExpanded, toggleLibraryExpanded, handleNewTagClick, showNewTagDialog, handleCloseNewTagDialog } =
    useLibraryUI();
  const { handleBookUpdate } = useBooksOperations(refreshBooks);

  const [selectedTagsForDelete, setSelectedTagsForDelete] = useState<string[]>([]);
  const [trashCount, setTrashCount] = useState(0);
  const sidebarRef = useRef<HTMLElement>(null);

  // 回收站计数徽标（路由变化时刷新）
  // biome-ignore lint/correctness/useExhaustiveDependencies: 仅作刷新触发，effect 内不直接引用
  useEffect(() => {
    getTrashedBooks()
      .then((books) => setTrashCount(books.length))
      .catch(() => setTrashCount(0));
  }, [location.pathname]);

  const clearSelectedTags = useCallback(() => {
    setSelectedTagsForDelete([]);
  }, []);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        selectedTagsForDelete.length > 0 &&
        sidebarRef.current &&
        !sidebarRef.current.contains(event.target as Node)
      ) {
        setSelectedTagsForDelete([]);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [selectedTagsForDelete]);

  const { handleEditTagCancel, editingTag, handleEditTag, handleDeleteTag, handleBatchDeleteTags } = useTagsOperations({
    booksWithStatus,
    handleBookUpdate,
    refreshBooks,
    selectedTag: selectedTagFromUrl,
    handleTagSelect: (tagId: string) => {
      if (tagId === "all") {
        navigate("/");
      } else {
        navigate(`/?tag=${tagId}`);
      }
    },
    selectedTagsForDelete,
    tags,
    clearSelectedTags,
  });

  const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const query = e.target.value;
    setSearchQuery(query);
    if (query && location.pathname !== "/") {
      navigate("/");
    }
  };

  const handleTagClick = (tagId: string, event: React.MouseEvent) => {
    if (event.shiftKey) {
      setSelectedTagsForDelete((prev) => {
        if (prev.includes(tagId)) {
          return prev.filter((id) => id !== tagId);
        }
        return [...prev, tagId];
      });
    } else {
      setSelectedTagsForDelete([]);
      if (tagId === "all") {
        navigate("/");
      } else {
        navigate(`/?tag=${tagId}`);
      }
    }
  };

  const navigationItems: NavigationItem[] = [
    {
      path: "/",
      label: "图书馆",
      icon: Library,
    },
    {
      path: "/papers",
      label: "文献库",
      icon: GraduationCap,
    },
    {
      path: "/chat",
      label: "全局助手",
      icon: Brain,
    },
    {
      path: "/skills",
      label: "AI 中心",
      icon: Lightbulb,
    },
    {
      path: "/statistics",
      label: "阅读统计",
      icon: BarChart3,
    },
  ];

  return (
    <>
      <aside
        ref={sidebarRef}
        data-region="app-sidebar"
        className="z-40 flex h-full w-48 select-none flex-col overflow-hidden border-neutral-200"
      >
        <div className="p-1 pt-2 pl-2">
          <SearchToggle searchQuery={searchQuery} onSearchChange={handleSearchChange} />
        </div>

        <nav
          className="flex flex-1 flex-col space-y-1 overflow-y-auto px-1 py-4 pt-2 pl-2"
          onClick={(e) => {
            if (e.target === e.currentTarget && selectedTagsForDelete.length > 0) {
              setSelectedTagsForDelete([]);
            }
          }}
        >
          {navigationItems.map((item) => {
            const isActive = location.pathname === item.path;
            const Icon = item.icon;

            return (
              <div key={item.path}>
                {item.path === "/" ? (
                  <div className="flex w-full items-center">
                    <Link
                      to={item.path}
                      className={clsx(
                        "flex flex-1 items-center gap-2 rounded-md p-1 py-1 text-left text-sm transition-colors hover:bg-muted",
                        isActive ? "text-neutral-900 dark:text-neutral-100" : "text-neutral-700 dark:text-neutral-300",
                      )}
                    >
                      <div className="flex flex-1 items-center gap-2">
                        <Icon size={16} className="flex-shrink-0" />
                        <span className="font-medium text-sm">{item.label}</span>
                      </div>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button
                            onClick={toggleLibraryExpanded}
                            className="flex size-5 items-center justify-center rounded-full text-neutral-700 transition-colors hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-700"
                          >
                            {isLibraryExpanded ? (
                              <ChevronDown size={16} className="flex-shrink-0" />
                            ) : (
                              <ChevronRight size={16} className="flex-shrink-0" />
                            )}
                          </button>
                        </TooltipTrigger>
                        <TooltipContent side="right">
                          {isLibraryExpanded ? "收起标签列表" : "展开标签列表"}
                        </TooltipContent>
                      </Tooltip>
                    </Link>
                  </div>
                ) : (
                  <Link
                    to={item.path}
                    className={clsx(
                      "flex w-full items-center gap-2 rounded-md p-1 py-1 text-left text-sm transition-colors hover:bg-muted",
                      isActive ? "text-neutral-900 dark:text-neutral-100" : "text-neutral-700 dark:text-neutral-300",
                    )}
                  >
                    <Icon size={16} className="flex-shrink-0" />
                    <span className="font-medium text-sm">{item.label}</span>
                  </Link>
                )}

                {/* 批次 4 场景 2：标签列表宽度推移开合（无 iframe/大 DOM，受控例外见 index.css）；
                    closing 态保持挂载播离场，触发语义（Chevron 按钮）不变 */}
                {item.path === "/" && (
                  <MotionSidebarCollapse open={isLibraryExpanded}>
                    <TagList
                      tags={tags}
                      selectedTag={selectedTagFromUrl}
                      selectedTagsForDelete={selectedTagsForDelete}
                      handleTagClick={handleTagClick}
                      handleEditTag={handleEditTag}
                      handleDeleteTag={handleDeleteTag}
                      handleBatchDeleteTags={handleBatchDeleteTags}
                      handleNewTagClick={handleNewTagClick}
                      books={booksWithStatus}
                      onBookUpdate={handleBookUpdate}
                      onRefresh={refreshBooks}
                    />
                  </MotionSidebarCollapse>
                )}
              </div>
            );
          })}
        </nav>
        <div className="space-y-1 px-2 py-3">
          <Link
            to="/manual"
            className={clsx(
              "flex w-full items-center gap-2 rounded-md p-1 py-1 text-left text-sm transition-colors hover:bg-muted",
              location.pathname === "/manual"
                ? "text-neutral-900 dark:text-neutral-100"
                : "text-neutral-600 dark:text-neutral-300",
            )}
          >
            <CircleHelp size={16} className="flex-shrink-0" />
            <span className="text-sm">使用手册</span>
          </Link>
          <Link
            to="/trash"
            className={clsx(
              "flex w-full items-center gap-2 rounded-md p-1 py-1 text-left text-sm transition-colors hover:bg-muted",
              location.pathname === "/trash"
                ? "text-neutral-900 dark:text-neutral-100"
                : "text-neutral-600 dark:text-neutral-300",
            )}
          >
            <Trash2 size={16} className="flex-shrink-0" />
            <span className="text-sm">回收站</span>
            {trashCount > 0 && (
              <span className="ml-auto rounded-full bg-neutral-200 px-1.5 text-neutral-600 text-xs dark:bg-neutral-700 dark:text-neutral-300">
                {trashCount}
              </span>
            )}
          </Link>
        </div>
      </aside>

      <CreateTagDialog
        isOpen={showNewTagDialog}
        onClose={handleCloseNewTagDialog}
        books={booksWithStatus}
        selectedTag={selectedTagFromUrl}
        filteredBooksByTag={filteredBooksByTag}
        onBookUpdate={handleBookUpdate}
        onRefreshBooks={refreshBooks}
      />

      <EditTagDialog
        isOpen={!!editingTag}
        onClose={handleEditTagCancel}
        tag={editingTag}
        books={booksWithStatus}
        onBookUpdate={handleBookUpdate}
        onRefreshBooks={refreshBooks}
      />
    </>
  );
}
