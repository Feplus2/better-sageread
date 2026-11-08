import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAutoPreview } from "@/hooks/use-auto-preview";
import { useChatState } from "@/hooks/use-chat-state";
import { exportMessagesToHtml } from "@/lib/export-thread-html";
import { exportMessagesToImage } from "@/lib/export-thread-image";
import { exportMessagesToMarkdown } from "@/lib/export-thread-markdown";
import { useReaderStore } from "@/pages/reader/components/reader-provider";
import { clearLiveReadingPosition, setLiveReadingPosition } from "@/services/reading-position/live-position";
import { useRetrievalScopeFor } from "@/store/retrieval-scope-store";
import { useThemeStore } from "@/store/theme-store";
import {
  CircleQuestionMark,
  History,
  Lightbulb,
  ListChecks,
  MessageCirclePlus,
  ScrollText,
  Search,
  UserSearch,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AssistantPanelTransition } from "../file-workspace/assistant-panel-transition";
import { FileWorkspace } from "../file-workspace/file-workspace";
import { useFileWorkspaceChat } from "../file-workspace/use-file-workspace-chat";
import { WorkspaceOpenButton } from "../file-workspace/workspace-open-button";
import { ChatContainerRoot } from "../prompt-kit/chat-container";
import { ScrollButton } from "../prompt-kit/scroll-button";
import { MindmapDialog } from "../tools/mindmap-dialog";
import { AgentConfirmCard } from "./agent-confirm-card";
import { ChatInputArea } from "./chat-input-area";
import { ChatMessages } from "./chat-messages";
import { ChatThreads } from "./chat-threads";
import ModelSelector from "./model-selector";
import { RetrievalScopeSelect } from "./retrieval-scope-select";
import { SelectionExportBar } from "./selection-export-bar";
import { useMessageSelection } from "./use-message-selection";

interface ChatContentProps {
  bookId?: string;
}

function ChatContent({ bookId }: ChatContentProps) {
  const { autoScroll } = useThemeStore();
  const [toolDetail, setToolDetail] = useState<any>(null);
  const [showMindmapDialog, setShowMindmapDialog] = useState(false);
  // StickToBottom 上下文 ref（同 paper-chat-panel）：命令式读 scrollToBottom，免 context 订阅级联重渲
  const stickContextRef = useRef<any>(null);

  const progress = useReaderStore((state) => state.progress);
  const currentThread = useReaderStore((state) => state.currentThread);
  const setCurrentThread = useReaderStore((state) => state.setCurrentThread)!;
  const hostId = `reader:${bookId ?? "unknown"}`;
  const { isFileMode, openChangedFile, openLocalFile } = useFileWorkspaceChat(hostId, "reader", currentThread?.id);

  // 书籍数据（含 bookDoc.toc）：判定 TOC 是否可用，供阅读位置注册表标记 tocAvailable
  const bookData = useReaderStore((state) => state.bookData);
  // 用户划定的检索范围（按书持久化；默认本书）。同时约束向量检索与文档直读。
  const retrievalScope = useRetrievalScopeFor("reader", bookId);

  // EPUB 原生 TOC → Markdown 列表（注入提示词替换转换器生成的损坏目录，见 ChatContext.bookTocMd）
  const bookToc = useReaderStore((state) => state.bookData?.bookDoc?.toc);
  const bookTocMd = useMemo(() => {
    const walk = (items: readonly any[] | null | undefined, depth: number): string =>
      (items ?? [])
        .map((it) => {
          const line = `${"  ".repeat(depth)}- ${it?.label ?? ""}`;
          const children = it?.subitems?.length ? `\n${walk(it.subitems, depth + 1)}` : "";
          return line + children;
        })
        .join("\n");
    const md = walk(bookToc, 0);
    return md.trim().length > 0 ? md : undefined;
  }, [bookToc]);

  // 阅读位置桥（2026-10-20）：foliate relocate 的实时位置写入活位置注册表，
  // 供提示词动态段 / getReadingPosition / readAtReadingPosition 读取。
  // progress 由 relocate 每页更新，这里只写模块级 Map（不触发渲染）；
  // 切换书 / 卸载时清理本书记录，避免残留旧位置。
  useEffect(() => {
    if (!bookId || !progress) return;
    const id = bookId;
    setLiveReadingPosition({
      scope: "reader",
      bookId: id,
      sectionIndex: progress.sectionIndex ?? progress.section?.current ?? 0,
      sectionHref: progress.sectionHref ?? "",
      sectionFraction: progress.sectionFraction ?? 0,
      locCurrent: progress.pageinfo?.current ?? 0,
      locTotal: progress.pageinfo?.total ?? 0,
      label: progress.sectionLabel ?? "",
      tocAvailable: (bookData?.bookDoc?.toc?.length ?? 0) > 0,
      cfi: progress.location ?? "",
    });
    return () => clearLiveReadingPosition("reader", id);
  }, [bookId, progress, bookData]);

  // 多选导出：切换对话自动退出
  const { selectionMode, selectedIds, toggleSelectionMode, exitSelectionMode, handleToggleSelect } =
    useMessageSelection(currentThread?.id);

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
    files,
    handleRemoveFile,
    handleAddFiles,
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
      activeBookId: bookId,
      activeSectionLabel: progress?.sectionLabel,
      bookTocMd,
      agentScope: "reader",
      workspaceHostId: hostId,
      retrievalScope,
    },
    setActiveBookId: () => {},
    currentThread: currentThread,
    setCurrentThread: setCurrentThread,
  });

  // AI 回复完成后自动打开可预览代码块的预览面板
  useAutoPreview(messages, status);

  // 引用稳定（useCallback）：ChatMessages 内的 MemoizedTool 按引用比较跳过重渲染，
  // 内联函数每次重建会使 memo 全部失效（卡顿修复 2026-08-07）
  const handleViewToolDetail = useCallback((toolPart: any) => {
    setToolDetail(toolPart);
    setShowMindmapDialog(true);
  }, []);

  // 多选导出
  const getSelectedMessages = () => messages.filter((m) => selectedIds.has(m.id));

  const buildSelectionMeta = () => ({
    title: `${currentThread?.title || "未命名对话"}-节选`,
    bookId: currentThread?.book_id ?? bookId ?? null,
  });

  const promptSuggestions = [
    { text: "总结这一页的内容", icon: ScrollText },
    { text: "解释这个概念", icon: Lightbulb },
    { text: "分析作者的观点", icon: UserSearch },
    { text: "找出关键信息", icon: Search },
    { text: "提出相关问题", icon: CircleQuestionMark },
  ] as const;

  const EmptyState = () => (
    <div className="flex h-full w-full flex-col overflow-y-auto overflow-x-hidden p-2">
      <div className="flex flex-1 flex-col justify-center gap-3">
        <div className="flex flex-col items-start gap-4 pl-2">
          <div className="rounded-full bg-muted/70 p-3 shadow-md dark:bg-neutral-800/90">
            <img className="size-8" src="https://www.notion.so/_assets/9ade71d75a1c0e93.png" alt="" />
          </div>
          <div className="space-y-2">
            <h3 className="font-semibold text-neutral-900 text-xl dark:text-neutral-50">AI 阅读助手</h3>
            {/* max-w-md(448px) 会超出窄面板宽度引起横向滑块 */}
            <p className="max-w-full text-sm dark:text-neutral-400">
              智能分析文本内容，提供深度理解和个性化解答，帮助你快速掌握书籍要点。你可以：
            </p>
          </div>
        </div>
        <div className="space-y-1">
          {promptSuggestions.map(({ text, icon: Icon }) => (
            <div
              key={text}
              onClick={() => {
                setInput(text);
                void handleSubmit(text);
              }}
              className="flex w-full cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 transition-colors hover:bg-accent hover:text-accent-foreground focus:outline-none focus:ring-2 focus:ring-primary/30"
            >
              <span className="flex items-center gap-3 text-neutral-800 text-sm dark:text-neutral-200">
                <Icon className="size-4" />
                {text}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );

  return (
    <main id="chat-sidebar" data-region="chat-panel" className="relative flex h-full flex-col overflow-hidden ">
      <div className="ml-1 flex-shrink-0 border-neutral-300 dark:border-neutral-700">
        <div className="flex h-8 items-center justify-between">
          <div className="flex min-w-0 items-center gap-2 pl-0.5">
            <ModelSelector
              selectedModel={selectedModel}
              onModelSelect={setSelectedModel}
              className="z-40 w-[10rem] min-w-0 flex-shrink"
            />
            <RetrievalScopeSelect role="reader" docId={bookId} />
            <WorkspaceOpenButton hostId={hostId} scope="reader" />
          </div>
          <div className="flex flex-shrink-0 items-center gap-0">
            {messages.length > 0 && !showThreads && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className={`z-40 size-7 rounded-full hover:bg-accent dark:hover:bg-accent ${
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
                  className="z-40 size-7 rounded-full hover:bg-accent dark:hover:bg-accent"
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
                  className="z-40 size-7 rounded-full hover:bg-accent dark:hover:bg-accent"
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
      <AssistantPanelTransition present={isFileMode} className="top-8">
        <FileWorkspace hostId={hostId} scope="reader" />
      </AssistantPanelTransition>
      <div className="relative min-h-0 flex-1">
        <AssistantPanelTransition
          present={showThreads && !!bookId && !isFileMode}
          side="left"
          onBackdropClick={handleBackFromThreads}
        >
          <div className="h-full min-h-0 bg-popover" data-region="assistant-history-panel">
            <ChatThreads
              key={`threads-${threadsKey}`}
              bookId={bookId}
              currentThreadId={currentThread?.id ?? null}
              onBack={handleBackFromThreads}
              onSelectThread={handleSelectThread}
            />
          </div>
        </AssistantPanelTransition>
        <div className="h-full" inert={isFileMode || showThreads} aria-hidden={isFileMode || showThreads}>
          {messages.length === 0 && isInit.current ? (
            <div className="h-full">
              <EmptyState />
            </div>
          ) : (
            <ChatContainerRoot
              className="relative h-full"
              autoScroll={autoScroll}
              contextRef={stickContextRef}
              navMessages={messages}
            >
              <ChatMessages
                messages={messages}
                onOpenLocalFile={openLocalFile}
                onOpenFile={(file) => void openChangedFile(file)}
                status={status}
                error={displayError}
                autoScroll={autoScroll}
                scrollKey={currentThread?.id ?? "__init__"}
                bookId={currentThread?.book_id ?? bookId ?? null}
                onReasoningTimesUpdate={handleReasoningTimesUpdate}
                onRetry={handleRetry}
                canRetry={canRetry}
                onAskSelection={handleAskSelection}
                onViewToolDetail={handleViewToolDetail}
                selectionMode={selectionMode}
                selectedIds={selectedIds}
                onToggleSelect={handleToggleSelect}
                stickContextRef={stickContextRef}
              />
              <div className="-translate-x-1/2 pointer-events-none absolute bottom-4 left-1/2 flex w-full max-w-3xl justify-end px-5">
                <div className="pointer-events-auto">
                  <ScrollButton />
                </div>
              </div>
            </ChatContainerRoot>
          )}
        </div>
      </div>

      {selectionMode && !showThreads && !isFileMode && (
        <SelectionExportBar
          selectedCount={selectedIds.size}
          onExportMarkdown={() => void exportMessagesToMarkdown(getSelectedMessages(), buildSelectionMeta())}
          onExportHtml={() => void exportMessagesToHtml(getSelectedMessages(), buildSelectionMeta())}
          onExportImage={() => void exportMessagesToImage(getSelectedMessages(), buildSelectionMeta())}
          onCancel={exitSelectionMode}
        />
      )}

      {bookId && (
        <div className="pointer-events-none absolute inset-x-0 bottom-2 z-[60] px-2">
          <div className="pointer-events-auto">
            <AgentConfirmCard />
          </div>
        </div>
      )}
      {bookId && (
        <div className={showThreads || isFileMode ? "hidden" : undefined}>
          <ChatInputArea
            workspace={{ hostId, scope: "reader", threadId: currentThread?.id }}
            input={input}
            setInput={setInput}
            references={references}
            onRemoveReference={handleRemoveReference}
            images={images}
            onRemoveImage={handleRemoveImage}
            onAddImageFiles={handleAddImageFiles}
            files={files}
            onRemoveFile={handleRemoveFile}
            onAddFiles={handleAddFiles}
            onInputEl={registerInputEl}
            onSubmit={handleSubmit}
            onStop={stop}
            status={status}
            activeBookId={bookId}
            setActiveBookId={() => {}}
          />
        </div>
      )}

      <MindmapDialog open={showMindmapDialog} onOpenChange={setShowMindmapDialog} toolPart={toolDetail} />
    </main>
  );
}

export default ChatContent;
