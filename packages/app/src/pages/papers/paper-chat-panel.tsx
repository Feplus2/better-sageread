import { CitationFallbackContext, type CitationSource } from "@/components/markdown/citation-source";
import { InlineMathText } from "@/components/markdown/inline-math-text";
import { ChatContainerRoot } from "@/components/prompt-kit/chat-container";
import { ScrollButton } from "@/components/prompt-kit/scroll-button";
import { AgentConfirmCard } from "@/components/side-chat/agent-confirm-card";
import { ChatInputArea } from "@/components/side-chat/chat-input-area";
import { ChatMessages } from "@/components/side-chat/chat-messages";
import { ChatThreads } from "@/components/side-chat/chat-threads";
import ModelSelector from "@/components/side-chat/model-selector";
import { RetrievalScopeSelect } from "@/components/side-chat/retrieval-scope-select";
import { SelectionExportBar } from "@/components/side-chat/selection-export-bar";
import { useMessageSelection } from "@/components/side-chat/use-message-selection";
import { MindmapDialog } from "@/components/tools/mindmap-dialog";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { legacyPaperScopeIds } from "@/constants/retrieval-scope";
import { useChatState } from "@/hooks/use-chat-state";
import { exportMessagesToHtml } from "@/lib/export-thread-html";
import { exportMessagesToImage } from "@/lib/export-thread-image";
import { exportMessagesToMarkdown } from "@/lib/export-thread-markdown";
import { useRetrievalScopeFor } from "@/store/retrieval-scope-store";
import { useThemeStore } from "@/store/theme-store";
import type { Thread } from "@/types/thread";
import { FileText, History, ListChecks, MessageCirclePlus } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";

const PAPER_PROMPT_SUGGESTIONS = ["这篇论文讲了什么？", "总结当前这一节", "论文的创新点和局限是什么？"] as const;

interface PaperChatPanelProps {
  paperId: string;
  paperTitle: string;
}

/** 论文助手聊天面板：头部（模型/检索范围选择器 + 对话操作）+ 对话区 + 输入区（agentScope="paper"） */
export function PaperChatPanel({ paperId, paperTitle }: PaperChatPanelProps) {
  const { autoScroll } = useThemeStore();
  const [currentThread, setCurrentThread] = useState<Thread | null>(null);
  // 用户划定的检索范围（按论文持久化；仅缺失记录时默认论文库，显式保存的选择不变）。同时约束向量检索与文档直读。
  const retrievalScope = useRetrievalScopeFor("paper", paperId);
  // StickToBottom 上下文 ref：随 ChatContainerRoot contextRef 下发并透传 ChatMessages（命令式读
  // scrollToBottom，避免 context 值对象重建把整条消息列表拖入切 tab 重渲，见 chat-messages.tsx 注释）
  const stickContextRef = useRef<any>(null);
  // 引用标兜底来源：本面板内未被消息映射命中的 [N] 一律按当前论文取数/跳转
  const citationFallback = useMemo<CitationSource>(
    () => ({ kind: "paper", paperId, title: paperTitle }),
    [paperId, paperTitle],
  );
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

  /** 旧版论文工具 paperSearch 的范围映射：本篇=[paperId]；论文库/论文库+图书馆=null（全部论文）。
   *  旧工具集无法表达"论文库+图书馆"里的书籍部分，故旧模式只部分生效（该模式下下拉隐藏）。 */
  const paperScopeIds = useMemo((): string[] | null => {
    return legacyPaperScopeIds(retrievalScope, paperId);
  }, [retrievalScope, paperId]);

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
      activeBookId: paperId,
      // 阅读位置改由活位置注册表注入提示词（PaperReader 写 setLiveReadingPosition），
      // 不再随 chatContext 传"当前小节正文/标题"——避免每滚一次就整面板重渲 + 正文重复注入
      agentScope: "paper",
      retrievalScope,
      paperScopeIds,
    },
    setActiveBookId: () => {},
    currentThread,
    setCurrentThread,
  });

  // 多选导出
  const getSelectedMessages = () => messages.filter((m) => selectedIds.has(m.id));

  const buildSelectionMeta = () => ({
    title: `${currentThread?.title || paperTitle || "未命名对话"}-节选`,
    bookId: currentThread?.book_id ?? paperId ?? null,
  });

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
              className="flex w-full cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 transition-colors hover:bg-accent hover:text-accent-foreground focus:outline-none focus:ring-2 focus:ring-primary/30"
            >
              <span className="flex items-center gap-3 text-neutral-800 text-sm dark:text-neutral-200">{text}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );

  return (
    <CitationFallbackContext.Provider value={citationFallback}>
      <main id="paper-chat-panel" data-region="chat-panel" className="relative flex h-full flex-col overflow-hidden">
        {/* 头部：模型/检索范围选择器 + 对话操作（结构与书籍 SideChat 头部一致；
          面板折叠开关由 PaperHeaderBar 统一负责，书籍同款；旧版文档工具模式下范围下拉自动隐藏） */}
        <div className="ml-1 flex-shrink-0 border-neutral-300 dark:border-neutral-700">
          <div className="flex h-8 items-center justify-between">
            <div className="flex min-w-0 items-center gap-2 pl-0.5">
              <ModelSelector
                selectedModel={selectedModel}
                onModelSelect={setSelectedModel}
                className="z-40 w-[10rem] min-w-0 flex-shrink"
              />
              <RetrievalScopeSelect role="paper" docId={paperId} />
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
              currentThreadId={currentThread?.id ?? null}
              onBack={handleBackFromThreads}
              onSelectThread={handleSelectThread}
            />
          </div>
        ) : messages.length === 0 && isInit.current ? (
          <EmptyState />
        ) : (
          <ChatContainerRoot
            className="relative flex-1"
            autoScroll={autoScroll}
            contextRef={stickContextRef}
            navMessages={messages}
          >
            <ChatMessages
              messages={messages}
              status={status}
              error={displayError}
              autoScroll={autoScroll}
              scrollKey={currentThread?.id ?? "__init__"}
              bookId={currentThread?.book_id ?? paperId ?? null}
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
              files={files}
              onRemoveFile={handleRemoveFile}
              onAddFiles={handleAddFiles}
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
      </main>
    </CitationFallbackContext.Provider>
  );
}
