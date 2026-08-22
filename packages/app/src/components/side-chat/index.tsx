import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAutoPreview } from "@/hooks/use-auto-preview";
import { useChatState } from "@/hooks/use-chat-state";
import { exportMessagesToHtml } from "@/lib/export-thread-html";
import { exportMessagesToImage } from "@/lib/export-thread-image";
import { exportMessagesToMarkdown } from "@/lib/export-thread-markdown";
import { useReaderStore } from "@/pages/reader/components/reader-provider";
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
import { useCallback, useState } from "react";
import { ChatContainerRoot } from "../prompt-kit/chat-container";
import { ScrollButton } from "../prompt-kit/scroll-button";
import { MindmapDialog } from "../tools/mindmap-dialog";
import { AgentConfirmCard } from "./agent-confirm-card";
import { ChatInputArea } from "./chat-input-area";
import { ChatMessages } from "./chat-messages";
import { ChatThreads } from "./chat-threads";
import ModelSelector from "./model-selector";
import { SelectionExportBar } from "./selection-export-bar";
import { useMessageSelection } from "./use-message-selection";

interface ChatContentProps {
  bookId?: string;
}

function ChatContent({ bookId }: ChatContentProps) {
  const { autoScroll } = useThemeStore();
  const [toolDetail, setToolDetail] = useState<any>(null);
  const [showMindmapDialog, setShowMindmapDialog] = useState(false);

  const progress = useReaderStore((state) => state.progress);
  const currentThread = useReaderStore((state) => state.currentThread);
  const setCurrentThread = useReaderStore((state) => state.setCurrentThread)!;

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
      agentScope: "reader",
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
    <div className="flex h-full w-full flex-col overflow-y-auto overflow-x-hidden p-2 pb-8">
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
              className="flex w-full cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 transition-colors hover:bg-muted/70 focus:outline-none focus:ring-2 focus:ring-primary/30 dark:hover:bg-neutral-800/80"
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
      {showThreads && bookId ? (
        <div className="min-h-0 flex-1">
          <ChatThreads
            key={`threads-${threadsKey}`}
            bookId={bookId}
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
            bookId={currentThread?.book_id ?? bookId ?? null}
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

      {!showThreads && bookId && (
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
            activeBookId={bookId}
            setActiveBookId={() => {}}
          />
        </>
      )}

      <MindmapDialog open={showMindmapDialog} onOpenChange={setShowMindmapDialog} toolPart={toolDetail} />
    </main>
  );
}

export default ChatContent;
