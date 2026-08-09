import { InlineMathText } from "@/components/markdown/inline-math-text";
import { ChatContainerRoot } from "@/components/prompt-kit/chat-container";
import { ScrollButton } from "@/components/prompt-kit/scroll-button";
import { AgentConfirmCard } from "@/components/side-chat/agent-confirm-card";
import { ChatInputArea } from "@/components/side-chat/chat-input-area";
import { ChatMessages } from "@/components/side-chat/chat-messages";
import { ChatThreads } from "@/components/side-chat/chat-threads";
import ModelSelector from "@/components/side-chat/model-selector";
import { SelectionExportBar } from "@/components/side-chat/selection-export-bar";
import { useMessageSelection } from "@/components/side-chat/use-message-selection";
import { MindmapDialog } from "@/components/tools/mindmap-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useChatState } from "@/hooks/use-chat-state";
import { exportMessagesToHtml } from "@/lib/export-thread-html";
import { exportMessagesToImage } from "@/lib/export-thread-image";
import { exportMessagesToMarkdown } from "@/lib/export-thread-markdown";
import { findSectionHeading, getSectionContent, parsePaperSections } from "@/pages/paper-reader/markdown-sections";
import { type Folder, type FolderTreeNode, type PaperFolderEntry, buildFolderTree } from "@/services/paper-service";
import { useThemeStore } from "@/store/theme-store";
import type { Thread } from "@/types/thread";
import { FileText, Folder as FolderIcon, History, ListChecks, MessageCirclePlus } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

/** 注入提示词的"当前小节正文"上限（字符），超出截断 */
const MAX_ACTIVE_SECTION_CHARS = 3000;

/** 聊天检索作用域：本篇论文 / 某个所属文件夹（含子文件夹）/ 全部文献 / 自定义文件夹集合 */
type PaperChatScope =
  | { kind: "paper" }
  | { kind: "folder"; folderId: string }
  | { kind: "all" }
  | { kind: "custom"; folderIds: string[] };

/** 收集文件夹及其全部后代 id（父链防御环：每个 id 只入集合一次，循环必然收敛） */
function collectFolderTreeIds(rootId: string, folders: Folder[]): Set<string> {
  const ids = new Set<string>([rootId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const folder of folders) {
      if (folder.parentId && ids.has(folder.parentId) && !ids.has(folder.id)) {
        ids.add(folder.id);
        grew = true;
      }
    }
  }
  return ids;
}

/** 挂在给定文件夹集合内的全部论文 id（去重） */
function paperIdsInFolders(folderIds: Set<string>, members: PaperFolderEntry[]): string[] {
  const result = new Set<string>();
  for (const member of members) {
    if (folderIds.has(member.folderId)) {
      result.add(member.paperId);
    }
  }
  return [...result];
}

/** 树形铺平（自定义文件夹对话框用，全部展开，带缩进深度） */
const flattenTree = (nodes: FolderTreeNode[], depth = 0): { node: FolderTreeNode; depth: number }[] =>
  nodes.flatMap((node) => [{ node, depth }, ...flattenTree(node.children, depth + 1)]);

const PAPER_PROMPT_SUGGESTIONS = ["这篇论文讲了什么？", "总结当前这一节", "论文的创新点和局限是什么？"] as const;

interface PaperChatPanelProps {
  paperId: string;
  paperTitle: string;
  /** paper.md 原文（提取"当前小节"正文用） */
  markdown: string;
  /** PaperReader 上报的当前阅读标题 */
  currentHeading: { id: string; text: string } | null;
  folders: Folder[];
  members: PaperFolderEntry[];
}

/** 论文助手聊天面板：头部（模型/作用域选择器 + 对话操作）+ 对话区 + 输入区（agentScope="paper"） */
export function PaperChatPanel({
  paperId,
  paperTitle,
  markdown,
  currentHeading,
  folders,
  members,
}: PaperChatPanelProps) {
  const { autoScroll } = useThemeStore();
  const [currentThread, setCurrentThread] = useState<Thread | null>(null);
  const [scope, setScope] = useState<PaperChatScope>({ kind: "paper" });
  const [customDialogOpen, setCustomDialogOpen] = useState(false);
  const [customChecked, setCustomChecked] = useState<Set<string>>(new Set());
  // 工具详情弹窗（思维导图/webSearch 结构化结果，与书籍侧栏同款 MindmapDialog）
  const [toolDetail, setToolDetail] = useState<any>(null);
  const [showToolDetailDialog, setShowToolDetailDialog] = useState(false);
  // 多选导出：切换对话自动退出
  const { selectionMode, selectedIds, toggleSelectionMode, exitSelectionMode, handleToggleSelect } =
    useMessageSelection(currentThread?.id);

  // 引用稳定（useCallback）：ChatMessages 内的 MemoizedTool 按引用比较跳过重渲染，
  // 内联函数每次重建会使 memo 全部失效（卡顿修复同款约束）
  const handleViewToolDetail = useCallback((toolPart: any) => {
    setToolDetail(toolPart);
    setShowToolDetailDialog(true);
  }, []);

  /** 当前论文直接所属的文件夹（"所在文件夹"选项；一篇论文可属多个文件夹） */
  const containingFolders = useMemo(() => {
    const ids = new Set(members.filter((m) => m.paperId === paperId).map((m) => m.folderId));
    return folders.filter((f) => ids.has(f.id));
  }, [members, folders, paperId]);

  const folderTree = useMemo(() => buildFolderTree(folders), [folders]);

  /** 作用域 → paperSearch 的 paper_ids：本篇=[paperId]；文件夹/自定义=含后代的全部成员；全部=null */
  const paperScopeIds = useMemo((): string[] | null => {
    switch (scope.kind) {
      case "paper":
        return [paperId];
      case "all":
        return null;
      case "folder":
        return paperIdsInFolders(collectFolderTreeIds(scope.folderId, folders), members);
      case "custom": {
        const all = new Set<string>();
        for (const folderId of scope.folderIds) {
          for (const id of collectFolderTreeIds(folderId, folders)) {
            all.add(id);
          }
        }
        return paperIdsInFolders(all, members);
      }
    }
  }, [scope, paperId, folders, members]);

  /** 当前阅读小节正文（按 heading 从 paper.md 提取，截断 ~3000 字符），随阅读位置上报变化 */
  const activeSectionContext = useMemo(() => {
    if (!currentHeading) return undefined;
    const parsed = parsePaperSections(markdown);
    const heading =
      (currentHeading.id ? parsed.headings.find((h) => h.id && h.id === currentHeading.id) : undefined) ??
      findSectionHeading(parsed, currentHeading.text);
    if (!heading) return undefined;
    const content = getSectionContent(parsed, heading);
    if (!content) return undefined;
    return content.length > MAX_ACTIVE_SECTION_CHARS
      ? `${content.slice(0, MAX_ACTIVE_SECTION_CHARS)}\n……（小节较长，已截断）`
      : content;
  }, [markdown, currentHeading]);

  const {
    input,
    references,
    displayError,
    showThreads,
    threadsKey,
    isInit,
    messages,
    status,
    selectedModel,

    stop,
    setInput,
    setSelectedModel,
    handleAskSelection,
    handleRemoveReference,
    images,
    handleRemoveImage,
    handleAddImageFiles,
    registerInputEl,
    handleSubmit,
    handleRetry,
    handleNewThread,
    canRetry,
    handleShowThreads,
    handleSelectThread,
    handleBackFromThreads,
    handleReasoningTimesUpdate,
  } = useChatState({
    chatContext: {
      activeBookId: paperId,
      activeContext: activeSectionContext,
      activeSectionLabel: currentHeading?.text,
      agentScope: "paper",
      paperScopeIds,
    },
    setActiveBookId: () => {},
    // 语义上下文由当前小节派生，不使用线程存储的语义上下文
    setActiveContext: () => {},
    currentThread,
    setCurrentThread,
  });

  // 多选导出
  const getSelectedMessages = () => messages.filter((m) => selectedIds.has(m.id));

  const buildSelectionMeta = () => ({
    title: `${currentThread?.title || paperTitle || "未命名对话"}-节选`,
    bookId: currentThread?.book_id ?? paperId ?? null,
  });

  const scopeValue = scope.kind === "folder" ? `folder:${scope.folderId}` : scope.kind;

  const handleScopeChange = (value: string) => {
    if (value === "custom") {
      setCustomChecked(new Set(scope.kind === "custom" ? scope.folderIds : []));
      setCustomDialogOpen(true);
      return;
    }
    if (value.startsWith("folder:")) {
      setScope({ kind: "folder", folderId: value.slice("folder:".length) });
    } else if (value === "all") {
      setScope({ kind: "all" });
    } else {
      setScope({ kind: "paper" });
    }
  };

  const handleCustomConfirm = () => {
    if (customChecked.size === 0) return;
    setScope({ kind: "custom", folderIds: [...customChecked] });
    setCustomDialogOpen(false);
  };

  const EmptyState = () => (
    <div className="flex h-full w-full flex-col overflow-y-auto overflow-x-hidden p-2 pb-8">
      <div className="flex flex-1 flex-col justify-center gap-3">
        <div className="flex flex-col items-start gap-4 pl-2">
          <div className="rounded-full bg-muted/70 p-3 shadow-md dark:bg-neutral-800/90">
            <FileText className="size-8 text-neutral-500 dark:text-neutral-400" />
          </div>
          <div className="space-y-2">
            <h3 className="font-semibold text-neutral-900 text-xl dark:text-neutral-50">论文助手</h3>
            {/* max-w-md(448px) 会超出面板宽度引起横向滑块；标题公式经 InlineMathText 渲染 */}
            <p className="max-w-full text-sm dark:text-neutral-400">
              正在共读《
              <InlineMathText text={paperTitle} />
              》。可以问我论文的任何细节，我看到的"当前小节"会随你的阅读位置更新。
            </p>
          </div>
        </div>
        <div className="space-y-1">
          {PAPER_PROMPT_SUGGESTIONS.map((text) => (
            <div
              key={text}
              onClick={() => {
                setInput(text);
                void handleSubmit(text);
              }}
              className="flex w-full cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 transition-colors hover:bg-muted/70 focus:outline-none focus:ring-2 focus:ring-primary/30 dark:hover:bg-neutral-800/80"
            >
              <span className="flex items-center gap-3 text-neutral-800 text-sm dark:text-neutral-200">{text}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );

  return (
    <main id="paper-chat-panel" data-region="chat-panel" className="relative flex h-full flex-col overflow-hidden">
      {/* 头部：模型/检索作用域选择器 + 对话操作（结构与书籍 SideChat 头部一致；
          面板折叠开关由 PaperHeaderBar 统一负责，书籍同款） */}
      <div className="ml-1 flex-shrink-0 border-neutral-300 dark:border-neutral-700">
        <div className="flex h-8 items-center justify-between">
          <div className="flex min-w-0 items-center gap-2 pl-0.5">
            <ModelSelector
              selectedModel={selectedModel}
              onModelSelect={setSelectedModel}
              className="z-40 w-[10rem] min-w-0 flex-shrink"
            />
            <Select value={scopeValue} onValueChange={handleScopeChange}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <SelectTrigger className="h-7 w-[9.5rem] min-w-0 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                </TooltipTrigger>
                <TooltipContent side="bottom">paperSearch 的检索范围（需已向量化）</TooltipContent>
              </Tooltip>
              <SelectContent>
                <SelectItem value="paper">本篇论文</SelectItem>
                {containingFolders.map((folder) => (
                  <SelectItem key={folder.id} value={`folder:${folder.id}`}>
                    文件夹：{folder.name}（含子文件夹）
                  </SelectItem>
                ))}
                <SelectItem value="all">全部文献</SelectItem>
                <SelectItem value="custom">
                  自定义文件夹…{scope.kind === "custom" ? `（已选 ${scope.folderIds.length}）` : ""}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-shrink-0 items-center gap-0">
            {messages.length > 0 && !showThreads && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className={`z-40 size-7 shrink-0 rounded-full hover:bg-accent dark:hover:bg-accent ${
                      selectionMode ? "bg-accent dark:bg-accent" : ""
                    }`}
                    onClick={toggleSelectionMode}
                  >
                    <ListChecks className="h-5 w-5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">选择导出</TooltipContent>
              </Tooltip>
            )}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="z-40 size-7 shrink-0 rounded-full hover:bg-accent dark:hover:bg-accent"
                  onClick={handleNewThread}
                >
                  <MessageCirclePlus className="h-5 w-5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">新对话</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="z-40 size-7 shrink-0 rounded-full hover:bg-accent dark:hover:bg-accent"
                  onClick={handleShowThreads}
                >
                  <History className="h-5 w-5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">历史对话</TooltipContent>
            </Tooltip>
          </div>
        </div>
      </div>

      {showThreads ? (
        <div className="min-h-0 flex-1">
          <ChatThreads
            key={`threads-${threadsKey}`}
            bookId={paperId}
            onBack={handleBackFromThreads}
            onSelectThread={handleSelectThread}
          />
        </div>
      ) : messages.length === 0 && isInit.current ? (
        <EmptyState />
      ) : (
        <ChatContainerRoot className="relative flex-1" autoScroll={autoScroll}>
          <ChatMessages
            messages={messages}
            status={status}
            error={displayError}
            autoScroll={autoScroll}
            scrollKey={currentThread?.id ?? "__init__"}
            onReasoningTimesUpdate={handleReasoningTimesUpdate}
            onRetry={handleRetry}
            canRetry={canRetry}
            onAskSelection={handleAskSelection}
            onViewToolDetail={handleViewToolDetail}
            selectionMode={selectionMode}
            selectedIds={selectedIds}
            onToggleSelect={handleToggleSelect}
          />
          <div className="-translate-x-1/2 pointer-events-none absolute bottom-4 left-1/2 flex w-full max-w-3xl justify-end px-5">
            <div className="pointer-events-auto">
              <ScrollButton />
            </div>
          </div>
        </ChatContainerRoot>
      )}

      {selectionMode && !showThreads && (
        <SelectionExportBar
          selectedCount={selectedIds.size}
          onExportMarkdown={() => void exportMessagesToMarkdown(getSelectedMessages(), buildSelectionMeta())}
          onExportHtml={() => void exportMessagesToHtml(getSelectedMessages(), buildSelectionMeta())}
          onExportImage={() => void exportMessagesToImage(getSelectedMessages(), buildSelectionMeta())}
          onCancel={exitSelectionMode}
        />
      )}

      {!showThreads && (
        <>
          <AgentConfirmCard />
          <ChatInputArea
            input={input}
            setInput={setInput}
            references={references}
            onRemoveReference={handleRemoveReference}
            images={images}
            onRemoveImage={handleRemoveImage}
            onAddImageFiles={handleAddImageFiles}
            onInputEl={registerInputEl}
            onSubmit={handleSubmit}
            onStop={stop}
            status={status}
            activeBookId={paperId}
            setActiveBookId={() => {}}
            agentScope="paper"
          />
        </>
      )}

      {/* 工具详情弹窗（思维导图/webSearch 结构化结果，与书籍侧栏同款） */}
      <MindmapDialog open={showToolDetailDialog} onOpenChange={setShowToolDetailDialog} toolPart={toolDetail} />

      {/* 自定义文件夹对话框（复选，含后代文件夹） */}
      <Dialog open={customDialogOpen} onOpenChange={setCustomDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>自定义检索范围</DialogTitle>
          </DialogHeader>
          <p className="px-4 pt-2 text-neutral-500 text-xs dark:text-neutral-400">
            勾选一个或多个文件夹，检索范围为其中全部论文（含子文件夹）
          </p>
          <div className="max-h-72 overflow-y-auto px-2 py-2">
            {folderTree.length === 0 ? (
              <p className="py-6 text-center text-neutral-400 text-sm">还没有文件夹，请先在文献库列表页创建</p>
            ) : (
              flattenTree(folderTree).map(({ node, depth }) => (
                <label
                  key={node.id}
                  className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-neutral-100 dark:hover:bg-neutral-800/60"
                  style={{ marginInlineStart: `${depth * 16}px` }}
                >
                  <Checkbox
                    checked={customChecked.has(node.id)}
                    onCheckedChange={(checked) => {
                      setCustomChecked((prev) => {
                        const next = new Set(prev);
                        if (checked === true) {
                          next.add(node.id);
                        } else {
                          next.delete(node.id);
                        }
                        return next;
                      });
                    }}
                  />
                  <FolderIcon className="size-3.5 shrink-0 text-neutral-400" />
                  <span className="truncate">{node.name}</span>
                </label>
              ))
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCustomDialogOpen(false)}>
              取消
            </Button>
            <Button onClick={handleCustomConfirm} disabled={customChecked.size === 0}>
              确定
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  );
}
