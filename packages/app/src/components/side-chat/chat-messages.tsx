import { CitationMapContext, buildCitationMap } from "@/components/markdown/citation-source";
import { ChatContainerContent, ChatContainerScrollAnchor } from "@/components/prompt-kit/chat-container";
import { Message, MessageAction, MessageActions, MessageContent } from "@/components/prompt-kit/message";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/components/prompt-kit/reasoning";
import { Tool } from "@/components/prompt-kit/tool";
import { Button } from "@/components/ui/button";
import { useIsChatPage } from "@/hooks/use-is-chat-page";
import { type ReasoningTimes, useReasoningTimer } from "@/hooks/use-reasoning-timer";
import { useTextSelection } from "@/hooks/use-text-selection";
import { exportMessagesToImage } from "@/lib/export-thread-image";
import { exportMessageToMarkdown } from "@/lib/export-thread-markdown";
import { cn } from "@/lib/utils";
import { attachmentToAssetUrl } from "@/services/attachment-service";
import { createNote } from "@/services/note-service";
import { audioPlayerManager, synthesizeSpeechChunked } from "@/services/tts-service";
import { useChatSettingsStore } from "@/store/chat-settings-store";
import { useThreadStore } from "@/store/thread-store";
import { useTTSStore } from "@/store/tts-store";
import { getReasoningTimes } from "@/types/message";
import type { UIMessage, UIMessagePart } from "ai";
import dayjs from "dayjs";
import {
  Brain,
  Check,
  ChevronDown,
  Copy,
  Download,
  Image as ImageIcon,
  Loader2,
  NotebookPen,
  Pause,
  Quote,
  RefreshCw,
  Volume2,
} from "lucide-react";
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useStickToBottomContext } from "use-stick-to-bottom";
import { ChatSelectionPopup } from "./chat-selection-popup";

export const TOOL_NAME_MAP: Record<string, string> = {
  ragSearch: "智能搜索",
  ragToc: "章节内容",
  ragContext: "扩展上下文",
  ragRange: "范围检索",
  readBookSection: "章节原文",
  notes: "笔记查询",
  getBooks: "书籍列表",
  getReadingStats: "阅读统计",
  mindmap: "思维导图",
  getSkills: "技能查询",
  webSearch: "网络搜索",
  getPaperToc: "论文目录",
  readPaperSection: "阅读小节",
  readPaperFull: "阅读全文",
  getPaperInfo: "论文信息",
  paperSearch: "文献检索",
  paperContext: "上下文扩展",
  getCitations: "参考文献",
  getFigures: "图片清单",
  managePaperFolders: "文件夹管理",
  manageBook: "书籍管理",
  manageSync: "备份同步",
  managePreferences: "偏好设置",
  manageThreads: "对话管理",
  manageNotes: "笔记管理",
  manageSkill: "技能管理",
  writeFile: "写入文件",
  editFile: "编辑文件",
  runCommand: "执行命令",
  searchFiles: "搜索文件",
};

/** P3 聊天消息尾部窗口（性能优化，2026-08-08；2026-08-09 收窄+视口填充）：
 * 初始只渲染最近 6 条（长消息时可视区连一条都放不下，原 30 条纯浪费）；
 * 短消息填不满可视区时自动续加直到填满（视口填充 effect），上滑渐进加载依旧。
 * 仅裁渲染层，messages 数据层全量保留（AI 上下文/导出不受影响） */
const INITIAL_WINDOW = 6;
const EXPAND_STEP = 6;

/** D4 图片附件渲染：attachment:// 引用 → asset 协议 URL（文件在 {appData}/attachments，UI 不再吃 base64） */
function AttachmentImg({ url, alt }: { url: string; alt: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void attachmentToAssetUrl(url).then((resolved) => {
      if (alive) setSrc(resolved);
    });
    return () => {
      alive = false;
    };
  }, [url]);
  if (!src) {
    return (
      <div className="max-h-72 max-w-full rounded-lg border border-neutral-200 p-4 text-neutral-400 text-xs dark:border-neutral-700 dark:text-neutral-500">
        图片加载中…
      </div>
    );
  }
  return (
    <img
      src={src}
      alt={alt}
      className="max-h-72 max-w-full rounded-lg border border-neutral-200 object-contain dark:border-neutral-700"
    />
  );
}

/** 向上找最近的可滚动祖先（全局聊天与书籍侧栏各自有自己的滚动容器） */
function findScrollableAncestor(el: HTMLElement | null): HTMLElement | null {
  let cur = el?.parentElement ?? null;
  while (cur) {
    const { overflowY } = getComputedStyle(cur);
    if ((overflowY === "auto" || overflowY === "scroll") && cur.scrollHeight > cur.clientHeight) return cur;
    cur = cur.parentElement;
  }
  return null;
}

interface ChatMessagesProps {
  messages: any[];
  status: string;
  error: any;
  autoScroll?: boolean;
  scrollKey?: string | number;
  bookId?: string | null;
  onReasoningTimesUpdate?: (messageId: string, reasoningTimes: ReasoningTimes) => void;
  onRetry?: () => void | Promise<void>;
  canRetry?: boolean;
  onAskSelection?: (text: string) => void;
  onViewToolDetail?: (toolPart: any) => void;
  /** 多选导出模式：显示勾选框、隐藏单条操作、整行点击切换选中 */
  selectionMode?: boolean;
  selectedIds?: Set<string>;
  onToggleSelect?: (messageId: string) => void;
}

export function reorderTextAndReasoning(message: UIMessage): UIMessage {
  const srcParts = Array.isArray(message?.parts) ? message.parts : [];
  const cloned = srcParts.map((p) => ({ ...p }));
  const reordered: UIMessagePart<any, any>[] = [];

  for (let i = 0; i < cloned.length; i++) {
    const a = cloned[i];
    const b = cloned[i + 1];

    if (a?.type === "text" && b?.type === "reasoning") {
      reordered.push(b, a);
      i++;
    } else {
      reordered.push(a);
    }
  }

  return { ...message, parts: reordered };
}

// ---- 渲染单元 memo 化（卡顿修复 2026-08-07）----
// 流式更新每 50ms 触发一次全列表重渲染；历史消息的文本与 tool part 对象引用不变，
// memo 命中即跳过最贵的 react-markdown 全量重解析与 Tool 子树重建，只重渲最后一条消息。
const MemoizedMarkdownContent = memo(
  function MemoizedMarkdownContent({
    text,
    className,
    markdown,
  }: {
    text: string;
    className: string;
    markdown: boolean;
  }) {
    return (
      <MessageContent className={className} markdown={markdown}>
        {text}
      </MessageContent>
    );
  },
  (prev, next) => prev.text === next.text && prev.className === next.className && prev.markdown === next.markdown,
);

const MemoizedReasoningContent = memo(
  function MemoizedReasoningContent({ text }: { text: string }) {
    return (
      <ReasoningContent className="ml-2 border-l-2 border-l-neutral-300 px-2 pl-4 dark:border-l-neutral-600" markdown>
        {text}
      </ReasoningContent>
    );
  },
  (prev, next) => prev.text === next.text,
);

const MemoizedTool = memo(
  function MemoizedTool({
    part,
    toolName,
    onViewDetail,
    isChatPage,
  }: {
    part: any;
    toolName: string;
    onViewDetail?: (toolPart: any) => void;
    isChatPage: boolean;
  }) {
    return (
      <Tool
        className="w-full"
        toolPart={{
          type: toolName,
          state: part.state ?? "output-available",
          input: part.input,
          output: part.output,
          toolCallId: part.toolCallId,
          errorText: part.errorText,
        }}
        onViewDetail={onViewDetail}
        isChatPage={isChatPage}
      />
    );
  },
  (prev, next) =>
    prev.part === next.part &&
    prev.toolName === next.toolName &&
    prev.onViewDetail === next.onViewDetail &&
    prev.isChatPage === next.isChatPage,
);

/**
 * T6 工具调用折叠组（2026-08-22，业界惯例：Claude Code/Cursor 均把连续工具调用收拢为状态行）：
 * 目录牌模式下工具调用翻倍（describeTool→useTool 两步），逐卡平铺视觉噪音大。
 * 连续 ≥2 个工具 part 收拢为一条摘要行（工具名清单 + 进行中状态），点击展开原卡片区。
 */
const ToolCallGroup = memo(function ToolCallGroup({
  parts,
  onViewDetail,
  isChatPage,
}: {
  parts: any[];
  onViewDetail?: (toolPart: any) => void;
  isChatPage: boolean;
}) {
  const running = parts.some((p) => p.state === "input-streaming" || p.state === "input-available");
  const [open, setOpen] = useState(running);
  const names = Array.from(
    new Set(
      parts.map((p) => TOOL_NAME_MAP[String(p.type).replace(/^tool-/, "")] ?? String(p.type).replace(/^tool-/, "")),
    ),
  );
  // 摘要参数：首个工具的首个字符串入参截断（query/command/path 类）
  const firstInput = parts[0]?.input;
  const digestEntry = firstInput
    ? (Object.values(firstInput).find((v) => typeof v === "string" && v.trim()) ?? "")
    : "";
  const digest = String(digestEntry).replace(/\s+/g, " ").slice(0, 40);

  return (
    <div className="w-full">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 rounded-lg border border-neutral-200 bg-neutral-50/60 px-3 py-1.5 text-left text-neutral-600 text-xs transition-colors hover:bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-800/40 dark:text-neutral-300 dark:hover:bg-neutral-800"
      >
        {running ? (
          <Loader2 className="size-3.5 shrink-0 animate-spin text-neutral-400" />
        ) : (
          <Check className="size-3.5 shrink-0 text-neutral-400" />
        )}
        <span className="shrink-0">
          {running ? `正在调用工具（${names.join("、")}…）` : `已调用 ${parts.length} 个工具（${names.join("、")}）`}
        </span>
        {digest && <span className="min-w-0 flex-1 truncate text-neutral-400">{digest}</span>}
        <ChevronDown className={cn("size-3.5 shrink-0 text-neutral-400 transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div className="mt-1 flex flex-col gap-1">
          {parts.map((part, idx) => {
            const toolType = String(part.type).replace(/^tool-/, "");
            return (
              <MemoizedTool
                key={part.toolCallId ?? `tg-${idx}`}
                part={part}
                toolName={TOOL_NAME_MAP[toolType] || toolType}
                onViewDetail={onViewDetail}
                isChatPage={isChatPage}
              />
            );
          })}
        </div>
      )}
    </div>
  );
});

export function ChatMessages({
  messages,
  status,
  error,
  scrollKey,
  bookId,
  onReasoningTimesUpdate,
  onRetry,
  canRetry = true,
  onAskSelection,
  onViewToolDetail,
  selectionMode = false,
  selectedIds,
  onToggleSelect,
}: ChatMessagesProps) {
  const { scrollToBottom } = useStickToBottomContext();
  const isChatPage = useIsChatPage();
  // 「存为笔记」的目标书/论文：优先侧栏绑定的 bookId（reader/paper scope 经 props 下发），
  // 全局对话页回退全局 currentThread 的 book_id；两者皆空则按钮不渲染
  const globalThreadBookId = useThreadStore((s) => s.currentThread?.book_id);
  const noteBookId = bookId ?? globalThreadBookId ?? null;
  // H3：宽版聊天布局（放宽消息列 max-w 约束）
  const wideChatLayout = useChatSettingsStore((s) => s.wideChatLayout);
  const lastMessage = reorderTextAndReasoning(messages[messages.length - 1]);
  const reasoningPart = lastMessage?.parts?.findLast((part: UIMessagePart<any, any>) => part.type === "reasoning");
  const isStreaming = status === "streaming";
  const reasoningActive = isStreaming && !!reasoningPart && reasoningPart?.state === "streaming";
  const existingReasoningTimes = getReasoningTimes(lastMessage);

  const [copiedMessageIds, setCopiedMessageIds] = useState<Set<string>>(new Set());
  const [audioStates, setAudioStates] = useState<Map<string, "idle" | "loading" | "playing" | "paused">>(new Map());
  const [audioUrls, setAudioUrls] = useState<Map<string, string>>(new Map());

  const { config: ttsConfig } = useTTSStore();

  const { selectionState, handleTextSelection, handleClosePopup, handleAskSelection, popupRef } = useTextSelection({
    onAskSelection,
  });

  const hasInitialScrolled = useRef(false);
  const prevScrollKey = useRef(scrollKey);

  // ─── P3 尾部窗口：默认只渲染最近 N 条，上滑渐进加载（切换对话重置；多选模式全量渲染）───
  const [visibleCount, setVisibleCount] = useState(INITIAL_WINDOW);
  const firstMessageId = messages[0]?.id;
  const prevFirstIdRef = useRef(firstMessageId);
  useEffect(() => {
    if (prevFirstIdRef.current !== firstMessageId) {
      prevFirstIdRef.current = firstMessageId;
      setVisibleCount(INITIAL_WINDOW);
    }
  }, [firstMessageId]);

  const windowActive = !selectionMode && messages.length > visibleCount;
  const windowStartIndex = windowActive ? messages.length - visibleCount : 0;
  const visibleMessages = windowActive ? messages.slice(windowStartIndex) : messages;

  const loadMoreRef = useRef<HTMLDivElement | null>(null);
  const expandAdjustRef = useRef<{ scroller: HTMLElement; prevHeight: number } | null>(null);

  const expandWindow = useCallback(() => {
    const scroller = findScrollableAncestor(loadMoreRef.current);
    if (scroller) expandAdjustRef.current = { scroller, prevHeight: scroller.scrollHeight };
    setVisibleCount((c) => Math.min(messages.length, c + EXPAND_STEP));
  }, [messages.length]);

  // 扩展后用新增高度差补偿 scrollTop，保持视口内容不跳
  // biome-ignore lint/correctness/useExhaustiveDependencies: visibleCount 是刻意的触发依赖（effect 体只读 ref），等扩展渲染提交后再补偿
  useLayoutEffect(() => {
    const st = expandAdjustRef.current;
    if (!st) return;
    expandAdjustRef.current = null;
    const delta = st.scroller.scrollHeight - st.prevHeight;
    if (delta > 0) st.scroller.scrollTop += delta;
  }, [visibleCount]);

  // 上滑接近占位行（提前 200px）自动扩展；短消息填不满视口时占位行本就可见，
  // 观察器会连续触发扩展直至全量渲染（原"视口填充 effect"因 findScrollableAncestor
  // 要求容器已溢出才返回，在短消息场景恒为死代码，已移除）
  useEffect(() => {
    const el = loadMoreRef.current;
    if (!el || !windowActive) return;
    const root = findScrollableAncestor(el);
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) expandWindow();
      },
      { root, rootMargin: "200px 0px 0px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [windowActive, expandWindow]);

  const getFilteredTextFromDOM = (messageId: string): string => {
    const messageElement = document.querySelector(`[data-message-id="${messageId}"]`);
    if (!messageElement) return "";

    const textDivs = messageElement.querySelectorAll(".prose");
    if (textDivs.length === 0) return "";

    const lastTextDiv = textDivs[textDivs.length - 1];
    const cloned = lastTextDiv.cloneNode(true) as HTMLElement;
    const pageNumElements = cloned.querySelectorAll("span.rounded-full.bg-muted");
    pageNumElements.forEach((el) => el.remove());

    return cloned.textContent?.trim() || "";
  };

  const errorMessage = typeof error === "string" ? error : error?.message;

  const { getDisplayTime, onReasoningStreamingChange } = useReasoningTimer({
    messageId: lastMessage?.id,
    existingTimes: existingReasoningTimes,
    onTimesChange: onReasoningTimesUpdate,
  });

  const handleCopy = (messageId: string, text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedMessageIds((prev) => new Set(prev).add(messageId));
    setTimeout(() => {
      setCopiedMessageIds((prev) => {
        const newSet = new Set(prev);
        newSet.delete(messageId);
        return newSet;
      });
    }, 2000);
  };

  const handlePlayAudio = async (messageId: string, text: string) => {
    if (!ttsConfig.apiKey || ttsConfig.apiKey.trim() === "") {
      toast.error("请先在设置中配置 DashScope API Key");
      return;
    }

    const currentState = audioStates.get(messageId) || "idle";

    if (currentState === "playing") {
      audioPlayerManager.pause();
      setAudioStates((prev) => new Map(prev).set(messageId, "paused"));
      return;
    }

    if (currentState === "paused") {
      await audioPlayerManager.resume();
      setAudioStates((prev) => new Map(prev).set(messageId, "playing"));
      return;
    }

    try {
      setAudioStates((prev) => new Map(prev).set(messageId, "loading"));

      const cachedUrls = audioUrls.get(messageId);
      if (cachedUrls) {
        const urlArray = cachedUrls.split(",");
        const wasResumed = await audioPlayerManager.startPlayback(messageId);
        if (!wasResumed) {
          for (const url of urlArray) {
            audioPlayerManager.addToQueue(url);
          }
          audioPlayerManager.markAllChunksAdded();
        }
        setAudioStates((prev) => new Map(prev).set(messageId, "playing"));
      } else {
        const wasResumed = await audioPlayerManager.startPlayback(messageId);
        if (!wasResumed) {
          let isFirstChunk = true;
          const audioUrlArray = await synthesizeSpeechChunked({
            text,
            onChunkReady: (url) => {
              audioPlayerManager.addToQueue(url);
              if (isFirstChunk) {
                isFirstChunk = false;
                setAudioStates((prev) => new Map(prev).set(messageId, "playing"));
              }
            },
          });

          audioPlayerManager.markAllChunksAdded();
          setAudioUrls((prev) => new Map(prev).set(messageId, audioUrlArray.join(",")));
        } else {
          setAudioStates((prev) => new Map(prev).set(messageId, "playing"));
        }
      }

      audioPlayerManager.onEnded(() => {
        setAudioStates((prev) => new Map(prev).set(messageId, "idle"));
      });
    } catch (error) {
      console.error("语音播放失败:", error);
      setAudioStates((prev) => new Map(prev).set(messageId, "idle"));
    }
  };

  useEffect(() => {
    if (!lastMessage?.parts) return;
    const lastReasoningIndex = lastMessage.parts.reduce((lastIndex, part, index) => {
      return part?.type === "reasoning" ? index : lastIndex;
    }, -1);

    lastMessage.parts.forEach((part, index) => {
      if (part?.type === "reasoning") {
        const isCurrentlyStreaming = reasoningActive && index === lastReasoningIndex;
        onReasoningStreamingChange(index, isCurrentlyStreaming);
      }
    });
  }, [lastMessage?.parts, reasoningActive, onReasoningStreamingChange]);

  useEffect(() => {
    if (messages.length === 0) return;
    if (!hasInitialScrolled.current && messages.length > 0) {
      scrollToBottom("instant");
      hasInitialScrolled.current = true;
    }
  }, [messages.length, scrollToBottom]);

  useEffect(() => {
    if (scrollKey !== undefined && prevScrollKey.current !== scrollKey) {
      scrollToBottom("instant");
      prevScrollKey.current = scrollKey;
      hasInitialScrolled.current = true;
    }
  }, [scrollKey, scrollToBottom]);

  const renderMessageParts = (parts: any[], isLastMessage: boolean, isAssistant = true, messageId?: string) => {
    const elements: any[] = [];
    let textBuffer = "";

    const flushText = () => {
      if (!textBuffer) return;
      const className = isAssistant
        ? "prose prose-neutral min-w-0 flex-1 rounded bg-transparent p-0 text-foreground"
        : "rounded-xl bg-muted p-2 text-base leading-5";

      elements.push(
        <div key={`text-${elements.length}`} className="min-w-0" onMouseUp={handleTextSelection}>
          <MemoizedMarkdownContent text={textBuffer} className={className} markdown={isAssistant} />
        </div>,
      );
      textBuffer = "";
    };

    const reasoningStreaming = isLastMessage && reasoningActive;
    const lastReasoningIndex = parts.reduce((lastIndex, part, index) => {
      return part?.type === "reasoning" ? index : lastIndex;
    }, -1);

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const type = part?.type as string | undefined;

      if (type === "text") {
        textBuffer += part.text ?? "";
        continue;
      }

      if (type === "quote") {
        flushText();
        elements.push(
          <div
            key={`quote-${i}`}
            className="flex max-w-full items-start gap-1 rounded-lg text-muted-foreground text-sm leading-4.5"
          >
            <span className="mt-0.5 flex-nowrap">
              <Quote className="size-3" />
            </span>
            <span className="flex-1 whitespace-pre-wrap break-words text-left">{part.text}</span>
          </div>,
        );
        continue;
      }

      // J2 图片附件（D4：新消息存 attachment:// 引用按需解析；存量消息仍是 base64 dataUrl）
      if (type === "file") {
        flushText();
        const url = (part as any).url;
        const mediaType = (part as any).mediaType ?? "";
        if (typeof url === "string" && mediaType.startsWith("image/")) {
          elements.push(
            url.startsWith("attachment://") ? (
              <AttachmentImg key={`file-${i}`} url={url} alt={(part as any).filename ?? "图片"} />
            ) : (
              <img
                key={`file-${i}`}
                src={url}
                alt={(part as any).filename ?? "图片"}
                className="max-h-72 max-w-full rounded-lg border border-neutral-200 object-contain dark:border-neutral-700"
              />
            ),
          );
        }
        continue;
      }

      if (type === "reasoning") {
        flushText();
        const isCurrentlyStreaming = reasoningStreaming && i === lastReasoningIndex;
        const displayTime = getDisplayTime(i, isCurrentlyStreaming);
        const showTimer = displayTime !== undefined && displayTime >= 0;

        elements.push(
          <Reasoning key={`reasoning-${i}`} isStreaming={isCurrentlyStreaming}>
            <ReasoningTrigger className="flex items-center gap-1 text-muted-foreground">
              <div className="flex items-center gap-1 text-muted-foreground">
                <Brain className="h-4 w-4" />
                <span className="text-sm">{isCurrentlyStreaming ? "Thinking..." : ""}</span>
                {showTimer && (
                  <div className="flex items-center gap-1 text-muted-foreground text-sm">
                    <span>
                      {isCurrentlyStreaming
                        ? `${displayTime}s`
                        : `Thought for ${displayTime} second${displayTime === 1 ? "" : "s"}`}
                    </span>
                  </div>
                )}
              </div>
            </ReasoningTrigger>
            <MemoizedReasoningContent text={part.text || ""} />
          </Reasoning>,
        );
        continue;
      }

      if (typeof type === "string" && type.startsWith("tool-")) {
        flushText();
        // T6：向后收拢连续工具 part（≥2 个进折叠组，单个保持原卡）
        const groupParts: any[] = [part];
        let j = i + 1;
        while (j < parts.length) {
          const next = parts[j];
          if (typeof next?.type !== "string" || !next.type.startsWith("tool-")) break;
          groupParts.push(next);
          j += 1;
        }
        if (groupParts.length >= 2) {
          elements.push(
            <ToolCallGroup
              key={`toolgroup-${i}`}
              parts={groupParts}
              onViewDetail={onViewToolDetail}
              isChatPage={isChatPage}
            />,
          );
        } else {
          const toolType = type.replace(/^tool-/, "");
          const toolName = TOOL_NAME_MAP[toolType] || toolType;
          elements.push(
            <MemoizedTool
              key={`tool-${i}`}
              part={part}
              toolName={toolName}
              onViewDetail={onViewToolDetail}
              isChatPage={isChatPage}
            />,
          );
        }
        i = j - 1;
        continue;
      }

      flushText();
    }

    flushText();

    // 引用标来源映射：从本消息持久化的工具结果重建（paperSearch/ragSearch 等 output），
    // 随 React context 下发给正文里的 [N] 引用标弹窗；无工具结果为 null（弹窗走面板/store 兜底）
    const citationMap = buildCitationMap(parts);
    return (
      <CitationMapContext.Provider value={citationMap}>
        <div className="flex flex-col gap-1" data-message-id={messageId}>
          {elements}
        </div>
      </CitationMapContext.Provider>
    );
  };

  return (
    <ChatContainerContent className="select-auto py-6 first:mt-0">
      {windowActive && (
        <div
          ref={loadMoreRef}
          className={cn("mx-auto w-full", wideChatLayout ? "max-w-5xl" : "max-w-3xl", isChatPage ? "px-4" : "px-2")}
        >
          <button
            type="button"
            onClick={expandWindow}
            className="w-full rounded-lg border border-neutral-300 border-dashed py-1.5 text-neutral-500 text-xs hover:bg-muted dark:border-neutral-700 dark:text-neutral-400"
          >
            还有 {windowStartIndex} 条更早的消息，点击或上滑加载
          </button>
        </div>
      )}
      {visibleMessages.map((message, localIndex) => {
        const index = windowStartIndex + localIndex;
        const isAssistant = message.role === "assistant";
        const isLastMessage = index === messages.length - 1;
        const isFirstMessage = index === 0;
        const isStreaming = status === "streaming";
        const showError = !!errorMessage && isLastMessage;
        // H1：中断标记（用户停止/异常中断后落库的 assistant 消息）→ 显示「继续生成」
        const interruptedMark =
          isAssistant &&
          isLastMessage &&
          !isStreaming &&
          !!((message.metadata as { interrupted?: boolean } | undefined)?.interrupted ?? false);
        const canShowRetry = (showError || interruptedMark) && !!onRetry;
        const reorderedMessage = reorderTextAndReasoning(message);

        return (
          <Message
            key={message.id}
            className={cn(
              "mx-auto flex w-full flex-col items-start gap-2",
              // 宽版（仅全局助手提供开关）：去掉宽度上限，自适应版面宽度，与输入区同口径
              wideChatLayout ? "max-w-none" : "max-w-3xl",
              isChatPage ? "px-4" : "px-2",
            )}
          >
            <div
              className={cn("w-full", selectionMode && "flex cursor-pointer items-start gap-2")}
              onClick={selectionMode ? () => onToggleSelect?.(message.id) : undefined}
            >
              {selectionMode && (
                <div
                  className={cn(
                    "mt-1 flex size-4 flex-shrink-0 items-center justify-center rounded border transition-colors",
                    selectedIds?.has(message.id)
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-neutral-400 dark:border-neutral-500",
                  )}
                >
                  {selectedIds?.has(message.id) && <Check size={12} />}
                </div>
              )}
              <div className={selectionMode ? "min-w-0 flex-1" : undefined}>
                {isAssistant ? (
                  <div data-region="chat-message-assistant" className="group flex w-full flex-col gap-0">
                    {renderMessageParts(reorderedMessage.parts, isLastMessage, true, message.id)}
                    {((!isStreaming && isLastMessage) || !isLastMessage) && !selectionMode && (
                      <div className="flex items-center justify-between">
                        <MessageActions className="-ml-2.5 flex transform-gpu gap-0">
                          {/* 重新生成：末条 assistant 恒存在（不依赖错误/中断；用户 2026-08-08 拍板） */}
                          {isLastMessage && !!onRetry && (
                            <MessageAction tooltip="重新生成" delayDuration={100}>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="size-7 rounded-full"
                                disabled={!canRetry}
                                onClick={() => {
                                  onRetry?.();
                                }}
                              >
                                <RefreshCw size={12} />
                              </Button>
                            </MessageAction>
                          )}
                          <MessageAction
                            tooltip={copiedMessageIds.has(message.id) ? "已复制" : "复制"}
                            delayDuration={100}
                          >
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-7 rounded-full"
                              onClick={() => {
                                const textContent = message.parts
                                  .map((part: any) => (part.type === "text" ? part.text : ""))
                                  .join("");
                                handleCopy(message.id, textContent);
                              }}
                            >
                              {copiedMessageIds.has(message.id) ? <Check size={10} /> : <Copy size={10} />}
                            </Button>
                          </MessageAction>

                          <MessageAction tooltip="导出为 Markdown" delayDuration={100}>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-7 rounded-full"
                              onClick={() => {
                                void exportMessageToMarkdown(message, {
                                  threadTitle: useThreadStore.getState().currentThread?.title,
                                  index,
                                });
                              }}
                            >
                              <Download size={10} />
                            </Button>
                          </MessageAction>

                          <MessageAction tooltip="导出为图片" delayDuration={100}>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-7 rounded-full"
                              onClick={() => {
                                const { currentThread } = useThreadStore.getState();
                                void exportMessagesToImage([message], {
                                  title: `${currentThread?.title || "未命名对话"}-第${index + 1}条`,
                                  bookId: currentThread?.book_id,
                                  successText: "消息导出成功",
                                });
                              }}
                            >
                              <ImageIcon size={10} />
                            </Button>
                          </MessageAction>

                          {/* 存为笔记：助手消息正文 → 当前书籍/论文的笔记面板（仅绑书对话显示） */}
                          {noteBookId && (
                            <MessageAction tooltip="存为笔记" delayDuration={100}>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="size-7 rounded-full"
                                onClick={() => {
                                  const textContent = message.parts
                                    .map((part: any) => (part.type === "text" ? part.text : ""))
                                    .join("")
                                    .trim();
                                  if (!textContent || !noteBookId) return;
                                  void createNote({ bookId: noteBookId, content: textContent })
                                    .then(() => toast.success("已存为笔记（左侧「笔记」tab 可查看/整理）"))
                                    .catch((error) => {
                                      console.error("存为笔记失败:", error);
                                      toast.error("存为笔记失败");
                                    });
                                }}
                              >
                                <NotebookPen size={10} />
                              </Button>
                            </MessageAction>
                          )}

                          <MessageAction
                            tooltip={
                              audioStates.get(message.id) === "playing"
                                ? "暂停"
                                : audioStates.get(message.id) === "paused"
                                  ? "继续"
                                  : "播放语音"
                            }
                            delayDuration={100}
                          >
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-7 rounded-full"
                              disabled={audioStates.get(message.id) === "loading"}
                              onClick={() => {
                                const textContent = getFilteredTextFromDOM(message.id);
                                handlePlayAudio(message.id, textContent);
                              }}
                            >
                              {audioStates.get(message.id) === "loading" ? (
                                <Loader2 size={10} className="animate-spin" />
                              ) : audioStates.get(message.id) === "playing" ? (
                                <Pause size={10} />
                              ) : (
                                <Volume2 size={10} />
                              )}
                            </Button>
                          </MessageAction>
                        </MessageActions>
                        {message.metadata && (
                          <div className="flex items-center gap-2 text-neutral-500 text-xs dark:text-neutral-400">
                            {message.metadata.totalUsage && (
                              <span className="text-xs">{message.metadata.totalUsage.totalTokens} tokens</span>
                            )}
                            {message.metadata.updatedAt && (
                              <span className="text-xs">
                                {dayjs(message.metadata.updatedAt * 1000).format("YYYY-MM-DD HH:mm:ss")}
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                    {showError && (
                      <div className="mt-2 w-full rounded-lg border border-red-200 bg-red-50 p-3 text-red-800 text-xs dark:border-red-800 dark:bg-red-900/20 dark:text-red-200">
                        错误: {errorMessage}
                      </div>
                    )}
                    {interruptedMark && !showError && (
                      <div className="mt-1 w-full rounded-lg border border-amber-200 bg-amber-50 px-2 py-1 text-amber-700 text-xs dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300">
                        回复已中断
                      </div>
                    )}
                  </div>
                ) : (
                  <div
                    data-region="chat-message-user"
                    className={cn("group mt-7 flex max-w-full flex-col", isFirstMessage && "mt-0")}
                  >
                    {renderMessageParts(reorderedMessage.parts, isLastMessage, false, message.id)}

                    {!selectionMode && (
                      <MessageActions
                        className={cn(
                          "flex transform-gpu justify-end gap-0 opacity-0 transition-opacity duration-150 group-hover:opacity-100",
                        )}
                      >
                        {canShowRetry && (
                          <MessageAction tooltip="刷新重试" delayDuration={100}>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-7 rounded-full hover:bg-white dark:hover:bg-neutral-600"
                              disabled={!canRetry}
                              onClick={() => {
                                onRetry?.();
                              }}
                            >
                              <RefreshCw size={12} />
                            </Button>
                          </MessageAction>
                        )}
                        {/* TODO: 实现编辑功能
                  <MessageAction tooltip="编辑" delayDuration={100}>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-7 rounded-full hover:bg-white dark:hover:bg-neutral-600"
                    >
                      <Pencil size={12} />
                    </Button>
                  </MessageAction>
                  */}
                        {/* TODO: 实现删除功能
                  <MessageAction tooltip="删除" delayDuration={100}>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-7 rounded-full hover:bg-white dark:hover:bg-neutral-600"
                    >
                      <Trash size={12} />
                    </Button>
                  </MessageAction>
                  */}
                        <MessageAction
                          tooltip={copiedMessageIds.has(message.id) ? "已复制" : "复制"}
                          delayDuration={100}
                        >
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-7 rounded-full hover:bg-white dark:hover:bg-neutral-600"
                            onClick={() => {
                              const textContent = reorderedMessage.parts
                                .map((part: any) => (part.type === "text" ? part.text : ""))
                                .join("");
                              handleCopy(message.id, textContent);
                            }}
                          >
                            {copiedMessageIds.has(message.id) ? <Check size={12} /> : <Copy size={12} />}
                          </Button>
                        </MessageAction>
                        <MessageAction tooltip="导出为 Markdown" delayDuration={100}>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-7 rounded-full hover:bg-white dark:hover:bg-neutral-600"
                            onClick={() => {
                              void exportMessageToMarkdown(message, {
                                threadTitle: useThreadStore.getState().currentThread?.title,
                                index,
                              });
                            }}
                          >
                            <Download size={12} />
                          </Button>
                        </MessageAction>
                        <MessageAction tooltip="导出为图片" delayDuration={100}>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-7 rounded-full hover:bg-white dark:hover:bg-neutral-600"
                            onClick={() => {
                              const { currentThread } = useThreadStore.getState();
                              void exportMessagesToImage([message], {
                                title: `${currentThread?.title || "未命名对话"}-第${index + 1}条`,
                                bookId: currentThread?.book_id,
                                successText: "消息导出成功",
                              });
                            }}
                          >
                            <ImageIcon size={12} />
                          </Button>
                        </MessageAction>
                        {/* 存为笔记：助手消息正文 → 当前书籍/论文的笔记面板（仅绑书对话显示） */}
                        {noteBookId && (
                          <MessageAction tooltip="存为笔记" delayDuration={100}>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-7 rounded-full hover:bg-white dark:hover:bg-neutral-600"
                              onClick={() => {
                                const textContent = reorderedMessage.parts
                                  .map((part: any) => (part.type === "text" ? part.text : ""))
                                  .join("")
                                  .trim();
                                if (!textContent || !noteBookId) return;
                                void createNote({ bookId: noteBookId, content: textContent })
                                  .then(() => toast.success("已存为笔记（左侧「笔记」tab 可查看/整理）"))
                                  .catch((error) => {
                                    console.error("存为笔记失败:", error);
                                    toast.error("存为笔记失败");
                                  });
                              }}
                            >
                              <NotebookPen size={12} />
                            </Button>
                          </MessageAction>
                        )}
                      </MessageActions>
                    )}
                    {showError && (
                      <div className="mt-2 max-w-full rounded-lg border border-red-200 bg-red-50 px-1.5 py-1 text-red-800 text-sm dark:border-red-800 dark:bg-red-900/20 dark:text-red-200">
                        {errorMessage}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </Message>
        );
      })}

      {(status === "submitted" || status === "streaming") && (
        <div className={cn("mx-auto flex w-full max-w-3xl flex-col items-start gap-2", isChatPage && "px-6")}>
          <div className="group flex w-full flex-col gap-0 px-2">
            <div className="flex items-center gap-2">Thinking...</div>
          </div>
        </div>
      )}
      <ChatContainerScrollAnchor />
      {selectionState?.showPopup && (
        <ChatSelectionPopup
          selectedText={selectionState.selectedText}
          onClose={handleClosePopup}
          onAskAi={handleAskSelection}
          position={selectionState.position}
          popupRef={popupRef}
        />
      )}
    </ChatContainerContent>
  );
}
