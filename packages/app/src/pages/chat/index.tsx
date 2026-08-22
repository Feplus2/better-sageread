import { PreviewPanel } from "@/components/preview/preview-panel";
import { ChatContainerRoot } from "@/components/prompt-kit/chat-container";
import { PromptInput, PromptInputAction, PromptInputTextarea } from "@/components/prompt-kit/prompt-input";
import { ScrollButton } from "@/components/prompt-kit/scroll-button";
import { AgentConfirmCard } from "@/components/side-chat/agent-confirm-card";
import { ChatInputArea } from "@/components/side-chat/chat-input-area";
import { ChatMessages, TOOL_NAME_MAP } from "@/components/side-chat/chat-messages";
import { ChatThreads } from "@/components/side-chat/chat-threads";
import { getCommandIcon } from "@/components/side-chat/command-icons";
import ModelSelector from "@/components/side-chat/model-selector";
import { SearchEngineSelector } from "@/components/side-chat/search-engine-selector";
import { MindmapViewer } from "@/components/tools/mindmap-viewer";
import { RagResultViewer } from "@/components/tools/rag-result-viewer";
import { WebSearchViewer } from "@/components/tools/web-search-viewer";
import { Button } from "@/components/ui/button";
import { useAutoPreview } from "@/hooks/use-auto-preview";
import { useChatState } from "@/hooks/use-chat-state";
import { useChatReaderStore } from "@/store/chat-reader-store";
import { useChatSettingsStore } from "@/store/chat-settings-store";
import { usePreviewStore } from "@/store/preview-store";
import { useQuickCommandStore } from "@/store/quick-command-store";
import { useThemeStore } from "@/store/theme-store";
import { Brain, History, MessageCirclePlus, Paperclip, StretchHorizontal, X } from "lucide-react";
import { ArrowUp } from "lucide-react";
import { Resizable } from "re-resizable";
import { memo, useCallback, useEffect, useRef, useState } from "react";

interface EmptyStateProps {
  input: string;
  setInput: (value: string) => void;
  handleSubmit: (promptOverride?: string) => Promise<void>;
  stop: () => void;
  status: string;
  /** J2/K2：空状态输入框也参与标记插入与图片附件 */
  onInputEl?: (el: HTMLTextAreaElement | null) => void;
  onAddImageFiles?: (files: File[]) => void;
}

const EmptyState = memo(
  ({ input, setInput, handleSubmit, stop, status, onInputEl, onAddImageFiles }: EmptyStateProps) => {
    const fileInputRef = useRef<HTMLInputElement>(null);
    const promptBoxRef = useRef<HTMLDivElement>(null);
    const commands = useQuickCommandStore((s) => s.commands);
    // H3：宽版布局与输入区高度（与消息列/输入区同口径）
    const wideChatLayout = useChatSettingsStore((s) => s.wideChatLayout);
    const inputHeight = useChatSettingsStore((s) => s.inputHeight);
    useEffect(() => {
      const ta = promptBoxRef.current?.querySelector("textarea") ?? null;
      onInputEl?.(ta);
      return () => onInputEl?.(null);
    }, [onInputEl]);
    const promptSuggestions = (commands ?? [])
      .filter((c) => c.visible && c.scope.includes("central"))
      .sort((a, b) => a.sortOrder - b.sortOrder);

    return (
      <div className="flex h-full w-full select-none flex-col items-center justify-center overflow-y-auto p-6">
        <div className={wideChatLayout ? "mx-auto w-full space-y-6" : "mx-auto w-full max-w-3xl space-y-6"}>
          <div className="flex flex-col items-center gap-2">
            <div className="rounded-full">
              <Brain className="size-12 text-primary" />
            </div>
            <h1 className="font-semibold text-3xl text-neutral-900 dark:text-neutral-50">How can I help you today?</h1>
          </div>

          <div className="w-full" ref={promptBoxRef}>
            <PromptInput
              isLoading={status !== "ready"}
              value={input}
              onValueChange={setInput}
              onSubmit={handleSubmit}
              className="relative z-10 w-full rounded-2xl border bg-background shadow-around dark:bg-neutral-800"
            >
              <PromptInputTextarea
                placeholder="问我任何问题，或让我帮你执行操作..."
                style={{ minHeight: inputHeight }}
                className="flex-1 py-2 pl-1 text-base leading-[1.5] placeholder:font-normal dark:bg-neutral-800 dark:text-neutral-100 dark:placeholder:text-neutral-400"
              />
              <div className="flex items-center justify-between gap-2 pb-1">
                <div className="flex items-center gap-1.5">
                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    accept="image/*"
                    className="hidden"
                    onChange={(e) => {
                      const files = Array.from(e.target.files ?? []);
                      if (files.length > 0) onAddImageFiles?.(files);
                      e.target.value = "";
                    }}
                  />
                  <PromptInputAction tooltip="上传图片">
                    <Button
                      variant="outline"
                      size="icon"
                      onClick={(e) => {
                        e.stopPropagation();
                        fileInputRef.current?.click();
                      }}
                      className="size-8 rounded-full dark:border-neutral-600 dark:hover:bg-neutral-700"
                    >
                      <Paperclip className="size-4" />
                    </Button>
                  </PromptInputAction>
                  <SearchEngineSelector />
                </div>

                <Button
                  type="button"
                  size="icon"
                  disabled={status === "ready" ? !input.trim() : status !== "submitted" && status !== "streaming"}
                  onClick={(e) => {
                    e.preventDefault();
                    if (status === "ready") {
                      handleSubmit();
                    } else {
                      stop();
                    }
                  }}
                  className="size-8 rounded-full"
                >
                  {status === "ready" ? (
                    <ArrowUp size={18} />
                  ) : (
                    <span className="size-2 rounded-xs bg-white dark:bg-neutral-900" />
                  )}
                </Button>
              </div>
            </PromptInput>
          </div>

          <div>
            <h2 className="font-medium text-muted-foreground text-sm">Get started</h2>
            <div className="mt-2 flex flex-wrap gap-3">
              {promptSuggestions.map(({ id, label, prompt, icon }) => {
                const Icon = getCommandIcon(icon);
                return (
                  <div
                    key={id}
                    onClick={() => {
                      setInput(prompt);
                      handleSubmit(prompt);
                    }}
                    className="flex cursor-pointer items-center gap-2 rounded-xl bg-muted px-4 py-3 transition-all hover:bg-muted/80"
                  >
                    <Icon className="size-4 flex-shrink-0 text-muted-foreground" />
                    <span className="text-foreground text-sm">{label}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    );
  },
);

EmptyState.displayName = "EmptyState";

function ChatPage() {
  const { autoScroll } = useThemeStore();
  // 宽版布局快捷开关（仅全局助手；设置页不再提供）
  const wideChatLayout = useChatSettingsStore((s) => s.wideChatLayout);
  const setWideChatLayout = useChatSettingsStore((s) => s.setWideChatLayout);
  // E5：预览面板打开时同步放开聊天列宽度约束（否则 minWidth:100% 会把预览面板挤出容器被裁掉）
  const previewOpen = usePreviewStore((s) => s.isOpen);
  const [toolDetail, setToolDetail] = useState<any>(null);
  const [showToolDetail, setShowToolDetail] = useState(false);
  const scrollContextRef = useRef<any>(null);
  const { activeBookId, setActiveBookId, currentThread, setCurrentThread } = useChatReaderStore();

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
      activeBookId,
      agentScope: "central",
    },
    setActiveBookId,
    currentThread: currentThread,
    setCurrentThread: setCurrentThread,
  });

  // AI 回复完成后自动打开可预览代码块的预览面板
  useAutoPreview(messages, status);

  // 引用稳定（useCallback）：ChatMessages 内的 MemoizedTool 按引用比较跳过重渲染，
  // 内联函数每次重建会使 memo 全部失效（卡顿修复 2026-08-07）
  const handleViewToolDetail = useCallback((toolPart: any) => {
    scrollContextRef.current?.stopScroll?.();
    setToolDetail(toolPart);
    setShowToolDetail((wasOpen) => {
      if (toolPart?.toolCallId && !wasOpen) {
        setTimeout(() => {
          const toolElement = document.querySelector(`[data-tool-id="${toolPart.toolCallId}"]`);
          if (toolElement) {
            toolElement.scrollIntoView({ behavior: "instant", block: "center" });
          }
        }, 300);
      }
      return true;
    });
  }, []);

  const handleCloseToolDetail = useCallback(() => {
    setShowToolDetail(false);
    setToolDetail(null);
  }, []);

  const renderToolContent = () => {
    if (!toolDetail?.output?.results) return null;

    const toolType = toolDetail.type;

    if (toolType === TOOL_NAME_MAP.mindmap) {
      return <MindmapViewer markdown={toolDetail.output.results.markdown} />;
    }

    const isRagTool =
      toolType === TOOL_NAME_MAP.ragSearch ||
      toolType === TOOL_NAME_MAP.ragContext ||
      toolType === TOOL_NAME_MAP.ragToc;

    if (isRagTool) {
      return <RagResultViewer results={toolDetail.output.results} />;
    }

    if (toolType === TOOL_NAME_MAP.webSearch) {
      return <WebSearchViewer results={toolDetail.output.results} />;
    }

    return null;
  };

  return (
    <div className="relative flex h-full rounded-xl border bg-background">
      <div className={`absolute inset-0 z-50 ${showThreads ? "pointer-events-auto" : "pointer-events-none"}`}>
        <div
          className={`absolute inset-0 transition-opacity duration-300 ${showThreads ? "bg-transparent opacity-100" : "bg-transparent opacity-0"}`}
          onClick={showThreads ? handleBackFromThreads : undefined}
        />
        <div
          className={`absolute top-0 left-0 h-full w-80 transform rounded-2xl border-border border-r bg-background px-2 shadow-md transition-all duration-300 ease-out ${showThreads ? "translate-x-0 opacity-100" : "-translate-x-full opacity-0"}`}
        >
          <ChatThreads
            key={`threads-${threadsKey}`}
            bookId={undefined}
            scope="global"
            onBack={handleBackFromThreads}
            onSelectThread={handleSelectThread}
          />
        </div>
      </div>

      <div className="flex h-full w-full overflow-hidden">
        <Resizable
          defaultSize={{
            width: "40%",
            height: "100%",
          }}
          minWidth={showToolDetail || previewOpen ? "30%" : "100%"}
          maxWidth={showToolDetail || previewOpen ? "70%" : "100%"}
          enable={{
            top: false,
            right: showToolDetail || previewOpen,
            bottom: false,
            left: false,
            topRight: false,
            bottomRight: false,
            bottomLeft: false,
            topLeft: false,
          }}
          handleComponent={{
            right: <div className="custom-resize-handle custom-resize-handle-left" />,
          }}
          // 手柄感应区收回面板内（默认跨界 10px 会盖住邻居阅读区右缘的滚动条）
          handleStyles={{ right: { right: "0px" } }}
          // 仅预览打开（工具详情关闭）时填满剩余空间，避免与 420px 预览面板之间留白
          className={`flex h-full flex-col pr-2 ${previewOpen && !showToolDetail ? "flex-1" : ""}`}
        >
          <div className="relative flex h-10 flex-shrink-0 items-center justify-between px-2 pt-2">
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="icon"
                className="size-8 rounded-full text-neutral-600 hover:bg-neutral-100 dark:text-neutral-100 dark:hover:bg-neutral-800"
                onClick={handleShowThreads}
              >
                <History className="size-5" />
              </Button>
              <ModelSelector selectedModel={selectedModel} onModelSelect={setSelectedModel} className="max-w-60" />
            </div>
            <div className="flex items-center gap-2">
              {/* 宽版布局快捷切换：消息列/输入区放宽至自适应版面宽度（用户 2026-08-09 拍板：仅全局助手提供） */}
              <Button
                variant="ghost"
                size="icon"
                title={wideChatLayout ? "切换到标准布局" : "切换到宽版布局"}
                className={`size-8 rounded-full hover:bg-neutral-100 dark:hover:bg-neutral-800 ${
                  wideChatLayout ? "text-primary" : "text-neutral-600 dark:text-neutral-100"
                }`}
                onClick={() => setWideChatLayout(!wideChatLayout)}
              >
                <StretchHorizontal className="size-5" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="size-8 rounded-full text-neutral-600 hover:bg-neutral-100 dark:text-neutral-100 dark:hover:bg-neutral-800"
                onClick={handleNewThread}
              >
                <MessageCirclePlus className="size-5" />
              </Button>
            </div>
            {messages.length > 0 && (
              <div className="absolute inset-x-0 bottom-0 z-10 h-6 translate-y-full bg-gradient-to-b from-background to-background/30 blur-sm" />
            )}
          </div>

          <div className="flex flex-1 flex-col overflow-hidden">
            {messages.length === 0 && isInit.current ? (
              <EmptyState
                input={input}
                setInput={setInput}
                handleSubmit={handleSubmit}
                stop={stop}
                status={status}
                onInputEl={registerInputEl}
                onAddImageFiles={handleAddImageFiles}
              />
            ) : (
              <>
                <ChatContainerRoot className="relative flex-1" autoScroll={autoScroll} contextRef={scrollContextRef}>
                  <ChatMessages
                    messages={messages}
                    status={status}
                    error={displayError}
                    autoScroll={autoScroll}
                    scrollKey={currentThread?.id ?? "__global__"}
                    onReasoningTimesUpdate={handleReasoningTimesUpdate}
                    onRetry={handleRetry}
                    canRetry={canRetry}
                    onAskSelection={handleAskSelection}
                    onViewToolDetail={handleViewToolDetail}
                  />
                  <div
                    className={`-translate-x-1/2 pointer-events-none absolute bottom-4 left-1/2 flex w-full justify-end px-5 ${wideChatLayout ? "" : "max-w-3xl"}`}
                  >
                    <div className="pointer-events-auto">
                      <ScrollButton />
                    </div>
                  </div>
                </ChatContainerRoot>

                <div className="py-2">
                  <div id="chat-sidebar" className={wideChatLayout ? "mx-auto w-full" : "mx-auto max-w-4xl"}>
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
                      activeBookId={activeBookId}
                      setActiveBookId={setActiveBookId}
                      showToolDetail={showToolDetail}
                    />
                  </div>
                </div>
              </>
            )}
          </div>
        </Resizable>

        {/* 工具详情列：关闭时 hidden 不占布局（此前靠聊天列 minWidth:100% 压零宽，
            预览面板打开后约束放开会被它撑出空白，故改为条件性移出布局） */}
        <div
          className={`${showToolDetail ? "flex flex-1" : "hidden"} h-full flex-col rounded-r-2xl border-neutral-200 border-l bg-background dark:border-neutral-700`}
        >
          <div className="flex items-center justify-between border-neutral-200 border-b p-2 py-2 pl-3 dark:border-neutral-700">
            <h2 className="font-semibold text-lg text-neutral-900 dark:text-neutral-50">
              {toolDetail?.type || "工具详情"}
            </h2>
            <Button variant="ghost" size="icon" className="size-8 rounded-full" onClick={handleCloseToolDetail}>
              <X className="h-5 w-5" />
            </Button>
          </div>
          <div className="flex-1 overflow-hidden">{renderToolContent()}</div>
        </div>

        {/* E5 补挂：全局助手的 writeFile 产物/代码块预览（与阅读页同款侧边面板，未打开时自动隐藏） */}
        <PreviewPanel />
      </div>
    </div>
  );
}

export default ChatPage;
