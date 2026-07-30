import { PromptInput, PromptInputAction, PromptInputTextarea } from "@/components/prompt-kit/prompt-input";
import { Button } from "@/components/ui/button";
import { useIsChatPage } from "@/hooks/use-is-chat-page";
import { type AgentScope, useQuickCommandStore } from "@/store/quick-command-store";
import type { ChatReference } from "@/types/message";
import { ArrowUp, Paperclip, Quote, X } from "lucide-react";
import { useRef } from "react";
import { getCommandIcon } from "./command-icons";
import { ContextPopover } from "./context-popover";
import { SearchEngineSelector } from "./search-engine-selector";

interface ChatInputAreaProps {
  references: ChatReference[];
  input: string;
  status: string;
  activeBookId: string | undefined;
  showToolDetail?: boolean;
  /** 快捷指令过滤用的 Agent 作用域；缺省按页面启发式（聊天页=central，其余=reader） */
  agentScope?: AgentScope;

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
  agentScope: agentScopeProp,

  setActiveBookId,
  onRemoveReference,
  onSubmit,
  onStop,
  setInput,
}: ChatInputAreaProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const isChatPage = useIsChatPage();
  const commands = useQuickCommandStore((s) => s.commands);
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
      <div className="mx-auto max-w-3xl">
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
              <ContextPopover activeBookId={activeBookId} setActiveBookId={setActiveBookId} />
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
          <PromptInputTextarea
            placeholder="问我任何问题..."
            className="flex-1 py-2 pl-2 text-sm leading-[1.3] placeholder:font-light dark:bg-neutral-800 dark:text-neutral-100 dark:placeholder:text-neutral-400"
          />
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5">
              <input ref={fileInputRef} type="file" multiple className="hidden" />
              <PromptInputAction tooltip="上传文件">
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
