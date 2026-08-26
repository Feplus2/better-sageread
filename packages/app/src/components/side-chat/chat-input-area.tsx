import { PromptInput, PromptInputAction, PromptInputTextarea } from "@/components/prompt-kit/prompt-input";
import { Button } from "@/components/ui/button";
import { useChatSettingsStore } from "@/store/chat-settings-store";
import { type AgentScope, useQuickCommandStore } from "@/store/quick-command-store";
import type { ChatReference, ImageAttachment } from "@/types/message";
import { ArrowUp, Paperclip, Quote, X } from "lucide-react";
import { useEffect, useRef } from "react";
import { getCommandIcon } from "./command-icons";
import { ContextPopover } from "./context-popover";
import { ReasoningLevelSelector } from "./reasoning-level-selector";
import { SearchEngineSelector } from "./search-engine-selector";
import { WorkspaceChip } from "./workspace-chip";

interface ChatInputAreaProps {
  references: ChatReference[];
  input: string;
  status: string;
  activeBookId: string | undefined;
  showToolDetail?: boolean;
  /** 是否全局对话页实例（影响快捷指令行/作用域缺省/宽版开关显隐）。
   * 由调用点静态传入（ChatPage=true，阅读/论文侧栏缺省 false）——实例级语义本就恒定；
   * 曾用 useIsChatPage() 响应式订阅：home↔tab 每次切换 isHomeActive 翻转都把输入区拖入重渲，
   * 且侧栏隐藏实例在用户坐 /chat 时会算出 true（2026-08-26 切 tab 墙治理） */
  isChatPage?: boolean;
  /** 快捷指令过滤用的 Agent 作用域；缺省按页面启发式（聊天页=central，其余=reader） */
  agentScope?: AgentScope;
  /** J2/K2：图片附件与输入框注册（光标处插入占位标记） */
  images?: ImageAttachment[];
  onRemoveImage?: (id: string) => void;
  onAddImageFiles?: (files: File[]) => void;
  onInputEl?: (el: HTMLTextAreaElement | null) => void;

  setInput: (value: string) => void;
  onRemoveReference: (id: string) => void;
  onSubmit: (promptOverride?: string) => Promise<void>;
  onStop: () => void;
  setActiveBookId: (bookId: string | undefined) => void;
}

export function ChatInputArea({
  input,
  status,
  references,
  activeBookId,
  showToolDetail = false,
  isChatPage = false,
  agentScope: agentScopeProp,
  images = [],
  onRemoveImage,
  onAddImageFiles,
  onInputEl,

  setActiveBookId,
  onRemoveReference,
  onSubmit,
  onStop,
  setInput,
}: ChatInputAreaProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const promptBoxRef = useRef<HTMLDivElement>(null);
  // K2：把内部 textarea 注册给宿主 hook（引用/图片标记在光标处插入）
  useEffect(() => {
    const ta = promptBoxRef.current?.querySelector("textarea") ?? null;
    onInputEl?.(ta);
    return () => onInputEl?.(null);
  }, [onInputEl]);
  const commands = useQuickCommandStore((s) => s.commands);
  // H3：宽版布局 + 输入区高度（拖拽手柄可调，持久化）
  const wideChatLayout = useChatSettingsStore((s) => s.wideChatLayout);
  const inputHeight = useChatSettingsStore((s) => s.inputHeight);
  const setInputHeight = useChatSettingsStore((s) => s.setInputHeight);
  const dragStateRef = useRef<{ startY: number; startH: number } | null>(null);

  const handleGripPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    dragStateRef.current = { startY: e.clientY, startH: inputHeight };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const handleGripPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const st = dragStateRef.current;
    if (!st) return;
    // 向上拖（clientY 减小）= 加高；限幅 40–360px
    setInputHeight(Math.min(360, Math.max(40, st.startH + (st.startY - e.clientY))));
  };
  const handleGripPointerUp = () => {
    dragStateRef.current = null;
  };
  // 聊天页 = 全局助手（central），阅读侧边栏 = 阅读助手（reader）；宿主可用 agentScope prop 覆盖（如论文面板传 paper）
  const agentScope = agentScopeProp ?? (isChatPage ? "central" : "reader");
  const quickActions = commands
    .filter((c) => c.visible && c.scope.includes(agentScope))
    .sort((a, b) => a.sortOrder - b.sortOrder);

  const handleQuickPrompt = (prompt: string) => {
    setInput(prompt);
    if (status === "ready") {
      void onSubmit(prompt);
    }
  };

  return (
    <div className="z-10 shrink-0 px-2 pr-0 pl-1.5">
      {!isChatPage && (
        <div className="flex items-center justify-between gap-2 py-2">
          <div className="flex flex-wrap items-center gap-2">
            {quickActions.map(({ id, label, prompt, icon }) => {
              const Icon = getCommandIcon(icon);
              return (
                <PromptInputAction key={id} tooltip={label}>
                  <Button
                    variant="soft"
                    className="h-7 cursor-pointer"
                    size="sm"
                    onClick={() => handleQuickPrompt(prompt)}
                  >
                    <Icon className="size-4" />
                    {!showToolDetail && <span className="text-xs">{label}</span>}
                  </Button>
                </PromptInputAction>
              );
            })}
          </div>
        </div>
      )}
      <div ref={promptBoxRef} className={wideChatLayout ? "mx-auto w-full" : "mx-auto max-w-3xl"}>
        {/* H3：输入区顶边拖拽手柄（悬停变可调光标，向上拖放大输入区） */}
        <div
          className="group flex h-3 cursor-row-resize touch-none items-center justify-center"
          onPointerDown={handleGripPointerDown}
          onPointerMove={handleGripPointerMove}
          onPointerUp={handleGripPointerUp}
          title="拖拽调整输入区高度"
        >
          <div className="h-1 w-10 rounded-full bg-neutral-300 opacity-0 transition-opacity group-hover:opacity-100 dark:bg-neutral-600" />
        </div>
        <PromptInput
          isLoading={status !== "ready"}
          value={input}
          onValueChange={setInput}
          onSubmit={() => {
            void onSubmit();
          }}
          className="relative z-10 w-full rounded-2xl border bg-background shadow-around dark:bg-neutral-800"
        >
          {isChatPage && (
            <div className="flex items-center justify-between gap-2 py-2">
              <div className="flex items-center gap-2">
                <ContextPopover activeBookId={activeBookId} setActiveBookId={setActiveBookId} />
                <WorkspaceChip />
              </div>
              <div className="flex flex-wrap items-center gap-2 ">
                {quickActions.map(({ id, label, prompt, icon }) => {
                  const Icon = getCommandIcon(icon);
                  return (
                    <PromptInputAction key={id} tooltip={label}>
                      <Button
                        variant="soft"
                        className="h-7 cursor-pointer"
                        size="sm"
                        onClick={() => handleQuickPrompt(prompt)}
                      >
                        <Icon className="size-4" />
                        {!showToolDetail && <span className="text-xs">{label}</span>}
                      </Button>
                    </PromptInputAction>
                  );
                })}
              </div>
            </div>
          )}
          {references.length > 0 && (
            <div className="my-1 flex flex-col">
              {references.map((reference) => (
                <div
                  key={reference.id}
                  className="group flex w-full items-start gap-2 rounded-xl border border-neutral-200 bg-muted/70 p-2 text-xs dark:border-neutral-700 dark:bg-neutral-700/70"
                >
                  <Quote className="mt-[1px] size-3.5 text-neutral-600 dark:text-neutral-100" />
                  <span className="flex-1 whitespace-pre-wrap break-words text-left text-neutral-700 dark:text-neutral-100">
                    {reference.markerNum != null && (
                      <span className="mr-1 font-medium text-neutral-500 dark:text-neutral-300">
                        ⟦引用{reference.markerNum}⟧
                      </span>
                    )}
                    {reference.text}
                  </span>
                  <button
                    type="button"
                    className="mt-0.5 text-neutral-400 transition-colors hover:text-neutral-600 dark:text-neutral-300 dark:hover:text-neutral-100"
                    onClick={(event) => {
                      event.stopPropagation();
                      onRemoveReference(reference.id);
                    }}
                  >
                    <X className="size-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}
          {/* J2：图片附件缩略图（⟦图片N⟧ 标记在正文中定位；删图同步清标记） */}
          {images.length > 0 && (
            <div className="my-1 flex flex-wrap gap-2">
              {images.map((img) => (
                <div key={img.id} className="group relative">
                  <img
                    src={img.dataUrl}
                    alt={img.name}
                    className="h-16 w-16 rounded-lg border border-neutral-200 object-cover dark:border-neutral-700"
                  />
                  <span className="absolute bottom-0.5 left-0.5 rounded bg-black/60 px-1 text-[10px] text-white">
                    ⟦图片{img.markerNum}⟧
                  </span>
                  <button
                    type="button"
                    className="-top-1.5 -right-1.5 absolute flex size-4 items-center justify-center rounded-full bg-neutral-600 text-white hover:bg-red-500"
                    onClick={(event) => {
                      event.stopPropagation();
                      onRemoveImage?.(img.id);
                    }}
                  >
                    <X className="size-3" />
                  </button>
                </div>
              ))}
            </div>
          )}
          <PromptInputTextarea
            placeholder="问我任何问题..."
            style={{ minHeight: inputHeight }}
            className="flex-1 py-2 pl-2 text-sm leading-[1.3] placeholder:font-light dark:bg-neutral-800 dark:text-neutral-100 dark:placeholder:text-neutral-400"
          />
          <div className="flex items-center justify-between gap-2">
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
              <ReasoningLevelSelector />
            </div>

            <PromptInputAction tooltip={status === "ready" ? "发送" : "停止"} side="top">
              <Button
                type="submit"
                size="icon"
                disabled={status === "ready" ? !input.trim() : status !== "submitted" && status !== "streaming"}
                onClick={() => {
                  if (status === "ready") {
                    void onSubmit();
                  } else {
                    onStop();
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
            </PromptInputAction>
          </div>
        </PromptInput>
      </div>
    </div>
  );
}
