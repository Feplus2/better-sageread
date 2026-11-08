import { ChangedFilesDisclosure } from "@/components/file-workspace/changed-files-disclosure";
import { CitationMapContext, getStableCitationMap } from "@/components/markdown/citation-source";
import { ImagePreviewOverlay } from "@/components/media/image-interactions";
import { ChatContainerContent, ChatContainerScrollAnchor } from "@/components/prompt-kit/chat-container";
import { ChatNavBridgeContext } from "@/components/prompt-kit/chat-nav-bridge";
import { LocalFileLinkContext } from "@/components/prompt-kit/local-file-anchor";
import { Message, MessageAction, MessageActions, MessageContent } from "@/components/prompt-kit/message";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/components/prompt-kit/reasoning";
import { Tool } from "@/components/prompt-kit/tool";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useEffectiveMotionMode } from "@/hooks/use-motion-mode";
import { type ReasoningTimes, useReasoningTimer } from "@/hooks/use-reasoning-timer";
import { useStreamReveal } from "@/hooks/use-stream-reveal";
import { useTextSelection } from "@/hooks/use-text-selection";
import { exportMessagesToImage } from "@/lib/export-thread-image";
import { exportMessageToMarkdown } from "@/lib/export-thread-markdown";
import { cn } from "@/lib/utils";
import { attachmentToAssetUrl } from "@/services/attachment-service";
import { createNote } from "@/services/note-service";
import { useChatSettingsStore } from "@/store/chat-settings-store";
import { useThreadStore } from "@/store/thread-store";
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
  Maximize2,
  NotebookPen,
  Quote,
  RefreshCw,
} from "lucide-react";
import { memo, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { StickToBottomContext } from "use-stick-to-bottom";
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
  sciverseSearch: "科研搜索",
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
  translateBook: "书籍翻译",
};

/** P3 聊天消息尾部窗口（性能优化，2026-08-08；2026-08-09 收窄+视口填充）：
 * 初始只渲染最近 6 条（长消息时可视区连一条都放不下，原 30 条纯浪费）；
 * 短消息填不满可视区时自动续加直到填满（视口填充 effect），上滑渐进加载依旧。
 * 仅裁渲染层，messages 数据层全量保留（AI 上下文/导出不受影响） */
const INITIAL_WINDOW = 6;
const EXPAND_STEP = 6;
/** 导航跳转后目标之下保留渲染的消息数 / 区间浏览下滑每次补齐的消息数 */
const JUMP_AHEAD = 24;
const EXPAND_NEWER = 12;

/** D4 图片附件渲染：attachment:// 引用 → asset 协议 URL（文件在 {appData}/attachments，UI 不再吃 base64）。
 *  渲染组件 = MessageImagePart（限高折叠 + 大图预览，见 MessageQuotePart 之后） */
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

/** 发送后消息里的引用卡：默认折叠三行（公式引用是 LaTeX 源码，不限高会刷屏），点击展开/收起 */
const MessageQuotePart = memo(function MessageQuotePart({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const needClamp = text.length > 120 || text.includes("\n");
  const clamped = needClamp && !expanded;
  return (
    <div className="flex max-w-full items-start gap-1 rounded-lg text-muted-foreground text-sm leading-4.5">
      <span className="mt-0.5 flex-nowrap">
        <Quote className="size-3" />
      </span>
      <span
        title={needClamp ? (clamped ? "点击展开全文" : "点击收起") : undefined}
        onClick={needClamp ? () => setExpanded((v) => !v) : undefined}
        className={cn(
          "flex-1 whitespace-pre-wrap break-words text-left",
          needClamp && "cursor-pointer",
          clamped && "line-clamp-3",
        )}
      >
        {text}
      </span>
    </div>
  );
});

/** 折叠态限高（与 max-h-40 对应；图片渲染到此高度即视为"想更高"，给出展开交互） */
const COLLAPSED_IMG_PX = 160;

/** 消息图片附件：默认限高折叠（与引用卡同口径的"点击就地展开"），
 *  右上角悬浮「放大」开 ImagePreviewOverlay——复制/缩放/保存/引用与正文图片同机制。
 *  attachment:// 引用先解析为 asset URL（文件在 {appData}/attachments，UI 不吃 base64） */
function MessageImagePart({ url, alt, bookId }: { url: string; alt: string; bookId?: string | null }) {
  const isAttachment = url.startsWith("attachment://");
  const [src, setSrc] = useState<string | null>(isAttachment ? null : url);
  useEffect(() => {
    if (!isAttachment) {
      setSrc(url);
      return;
    }
    let alive = true;
    void attachmentToAssetUrl(url).then((resolved) => {
      if (alive) setSrc(resolved);
    });
    return () => {
      alive = false;
    };
  }, [url, isAttachment]);

  const [expanded, setExpanded] = useState(false);
  const [preview, setPreview] = useState(false);
  const [clippable, setClippable] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: src 变化（换图）时重置折叠状态，src 仅作触发器
  useEffect(() => {
    setExpanded(false);
    setClippable(false);
  }, [src]);

  if (!src) {
    return (
      <div className="max-h-72 max-w-full rounded-lg border border-neutral-200 p-4 text-neutral-400 text-xs dark:border-neutral-700 dark:text-neutral-500">
        图片加载中…
      </div>
    );
  }

  const collapsed = clippable && !expanded;
  return (
    <div className="group/img relative w-fit max-w-full">
      <img
        src={src}
        alt={alt}
        onLoad={(e) => setClippable(e.currentTarget.clientHeight >= COLLAPSED_IMG_PX)}
        onClick={() => (clippable ? setExpanded((v) => !v) : setPreview(true))}
        title={clippable ? (expanded ? "点击收起" : "点击展开全图") : "点击查看大图"}
        className={cn(
          "max-w-full rounded-lg border border-neutral-200 object-contain dark:border-neutral-700",
          expanded ? "max-h-[70vh]" : "max-h-40",
          "cursor-zoom-in",
          expanded && "cursor-zoom-out",
        )}
      />
      {/* 折叠态底部渐隐（视觉提示"还有内容"） */}
      {collapsed && (
        <div
          className="pointer-events-none absolute inset-x-0 bottom-0 h-10 rounded-b-lg bg-gradient-to-t from-black/25 to-transparent"
          role="presentation"
        />
      )}
      <button
        type="button"
        title="大图预览（复制/缩放/保存/引用）"
        onClick={(e) => {
          e.stopPropagation();
          setPreview(true);
        }}
        className="absolute top-1.5 right-1.5 flex size-6 items-center justify-center rounded-full bg-black/55 text-white opacity-0 transition-opacity hover:bg-black/75 group-hover/img:opacity-100"
      >
        <Maximize2 className="size-3.5" />
      </button>
      {preview && (
        <ImagePreviewOverlay
          image={{ src, alt }}
          onClose={() => setPreview(false)}
          onQuote={(image) => {
            window.dispatchEvent(new CustomEvent("imageToChat", { detail: { ...image, bookId: bookId ?? undefined } }));
          }}
        />
      )}
    </div>
  );
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
  onOpenLocalFile?: (path: string) => void;
  onOpenFile?: (file: { path: string; title?: string }) => void;
  /** 多选导出模式：显示勾选框、隐藏单条操作、整行点击切换选中 */
  selectionMode?: boolean;
  selectedIds?: Set<string>;
  onToggleSelect?: (messageId: string) => void;
  /** 是否全局对话页实例（宽度类名/工具卡引用语义）。由调用点静态传入（ChatPage=true，
   * 阅读/论文侧栏缺省 false）——实例级语义本就恒定；曾用 useIsChatPage() 响应式订阅，
   * home↔tab 每次切换 isHomeActive 翻转都把整条消息列表拖入重渲（2026-08-26 切 tab 墙治理） */
  isChatPage?: boolean;
  /** StickToBottom 上下文 ref（由 ChatContainerRoot contextRef 下发）：命令式读 scrollToBottom。
   * 不用 useStickToBottomContext 订阅——lib 内部状态冲刷会重建 context 值对象（布尔语义不变），
   * 每次切 tab 引发的容器重排都把整条消息列表（数百未 memo 叶组件）拖入重渲（2026-08-26 切 tab 墙溯源） */
  stickContextRef?: React.RefObject<StickToBottomContext | null>;
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

/**
 * 流式文本揭示盒（2026-10-10 流式动效施工）：use-stream-reveal 把"到达"与"显示"解耦，
 * 非 baseline 效果下 display = 追赶位切片 + 自管 overlay 雾带/水痕/光标；baseline 直通零开销。
 * 三个聊天面（侧栏/AI 中心/论文聊天）共用 ChatMessages，单点集成。
 * enabled=false（用户消息 / 动效模式非完整档）等价 baseline；streaming 仅在"正在接收本段文本"时为 true。
 */
function StreamRevealBox({
  text,
  streaming,
  enabled,
  className,
  markdown,
  onMouseUp,
}: {
  text: string;
  streaming: boolean;
  enabled: boolean;
  className: string;
  markdown: boolean;
  onMouseUp?: () => void;
}) {
  const { wrapRef, display } = useStreamReveal(text, streaming, enabled);
  return (
    <div ref={wrapRef} className="relative min-w-0" onMouseUp={onMouseUp}>
      <MemoizedMarkdownContent text={display} className={className} markdown={markdown} />
    </div>
  );
}

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
  startIndex,
  active,
  textStreaming,
  lastTextPartIndex,
  revealAllowed,
  onTextMouseUp,
  onViewDetail,
  isChatPage,
}: {
  parts: any[];
  startIndex: number;
  /** 所属消息仍在生成；执行中与结束后都默认折叠，只有用户显式展开才显示卡片 */
  active: boolean;
  textStreaming: boolean;
  lastTextPartIndex: number;
  revealAllowed: boolean;
  onTextMouseUp?: () => void;
  onViewDetail?: (toolPart: any) => void;
  isChatPage: boolean;
}) {
  const toolParts = parts.filter((p) => String(p.type).startsWith("tool-"));
  const running = toolParts.some((p) => p.state === "input-streaming" || p.state === "input-available");
  const [open, setOpen] = useState(false);
  const userToggled = useRef(false);
  useEffect(() => {
    if (!active && !userToggled.current) setOpen(false);
  }, [active]);
  const names = Array.from(
    new Set(
      toolParts.map((p) => TOOL_NAME_MAP[String(p.type).replace(/^tool-/, "")] ?? String(p.type).replace(/^tool-/, "")),
    ),
  );
  // 摘要参数：首个工具的首个字符串入参截断（query/command/path 类）
  const firstInput = toolParts[0]?.input;
  const digestEntry = firstInput
    ? (Object.values(firstInput).find((v) => typeof v === "string" && v.trim()) ?? "")
    : "";
  const digest = String(digestEntry).replace(/\s+/g, " ").slice(0, 40);

  return (
    <div className="w-full">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => {
          userToggled.current = true;
          setOpen(!open);
        }}
        className="hover-glow flex w-full items-center gap-2 rounded-lg border border-neutral-200 bg-neutral-50/60 px-3 py-1.5 text-left text-neutral-600 text-xs transition-colors dark:border-neutral-700 dark:bg-neutral-800/40 dark:text-neutral-300"
      >
        {running ? (
          <Loader2 className="size-3.5 shrink-0 animate-spin text-neutral-400" />
        ) : (
          <Check className="size-3.5 shrink-0 text-neutral-400" />
        )}
        <span className="shrink-0">
          {running
            ? `正在调用 ${toolParts.length} 个工具（${names.join("、")}…）`
            : `已调用 ${toolParts.length} 个工具（${names.join("、")}）`}
        </span>
        {digest && <span className="min-w-0 flex-1 truncate text-neutral-400">{digest}</span>}
        <ChevronDown className={cn("size-3.5 shrink-0 text-neutral-400 transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div className="mt-1 flex flex-col gap-1">
          {parts.map((part, offset) => {
            const partIndex = startIndex + offset;
            if (part.type === "text") {
              return (
                <StreamRevealBox
                  key={`group-text-${partIndex}`}
                  text={part.text ?? ""}
                  streaming={textStreaming && partIndex === lastTextPartIndex}
                  enabled={revealAllowed}
                  className="prose prose-neutral min-w-0 flex-1 rounded bg-transparent p-0 text-foreground"
                  markdown
                  onMouseUp={onTextMouseUp}
                />
              );
            }
            if (part.type === "reasoning") {
              return (
                <Reasoning key={part.toolCallId ?? `tr-${partIndex}`}>
                  <ReasoningTrigger className="flex items-center gap-1 text-muted-foreground">
                    <div className="flex items-center gap-1 text-muted-foreground">
                      <Brain className="h-4 w-4" />
                      <span className="text-sm">Thought</span>
                    </div>
                  </ReasoningTrigger>
                  <MemoizedReasoningContent text={part.text || ""} />
                </Reasoning>
              );
            }
            if (part.type === "step-start") return null;
            if (!String(part.type).startsWith("tool-")) return null;
            const toolType = String(part.type).replace(/^tool-/, "");
            return (
              <MemoizedTool
                key={part.toolCallId ?? `tg-${partIndex}`}
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

function ChatMessagesComponent({
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
  onOpenLocalFile,
  onOpenFile,
  selectionMode = false,
  selectedIds,
  onToggleSelect,
  isChatPage = false,
  stickContextRef,
}: ChatMessagesProps) {
  // 「存为笔记」的目标书/论文：优先侧栏绑定的 bookId（reader/paper scope 经 props 下发），
  // 全局对话页回退全局 currentThread 的 book_id；两者皆空则按钮不渲染
  const globalThreadBookId = useThreadStore((s) => s.currentThread?.book_id);
  const noteBookId = bookId ?? globalThreadBookId ?? null;
  // H3：宽版聊天布局（放宽消息列 max-w 约束）
  const wideChatLayout = useChatSettingsStore((s) => s.wideChatLayout);
  const lastMessage = messages[messages.length - 1] as UIMessage;
  const reasoningPart = lastMessage?.parts?.findLast((part: UIMessagePart<any, any>) => part.type === "reasoning");
  const isStreaming = status === "streaming";
  // 流式揭示动效仅在"完整动效"档生效（性能档 / 系统减少动态效果时回退到达即渲染）
  const revealAllowed = useEffectiveMotionMode() === "full";
  const reasoningActive = isStreaming && !!reasoningPart && reasoningPart?.state === "streaming";
  const existingReasoningTimes = getReasoningTimes(lastMessage);

  const [copiedMessageIds, setCopiedMessageIds] = useState<Set<string>>(new Set());
  const { selectionState, handleTextSelection, handleClosePopup, handleAskSelection, popupRef } = useTextSelection({
    onAskSelection,
  });

  const hasInitialScrolled = useRef(false);
  const prevScrollKey = useRef(scrollKey);

  // ─── P3 尾部窗口：默认只渲染最近 N 条，上滑渐进加载（切换对话重置；多选模式全量渲染）───
  // 导航条跳转到窗口外的旧消息时进入"区间浏览"：tailCap 非空 = 只渲染到该下标（不含），底部出现"较新消息"占位，
  // 下滑渐进补齐；不能直接把尾部窗口扩到目标处——数百条消息一次挂载会卡住数秒
  const [visibleCount, setVisibleCount] = useState(INITIAL_WINDOW);
  const [tailCap, setTailCap] = useState<number | null>(null);
  const firstMessageId = messages[0]?.id;
  const prevFirstIdRef = useRef(firstMessageId);
  const prevLengthRef = useRef(messages.length);
  useEffect(() => {
    if (prevFirstIdRef.current !== firstMessageId) {
      prevFirstIdRef.current = firstMessageId;
      setVisibleCount(INITIAL_WINDOW);
      setTailCap(null);
    }
  }, [firstMessageId]);
  // 新增消息（用户发送新问题）：退出区间浏览，回到尾部窗口
  useEffect(() => {
    if (messages.length > prevLengthRef.current && tailCap !== null) {
      setTailCap(null);
      setVisibleCount(INITIAL_WINDOW);
    }
    prevLengthRef.current = messages.length;
  }, [messages.length, tailCap]);

  const windowActive = !selectionMode && messages.length > visibleCount;
  const windowStartIndex = windowActive ? messages.length - visibleCount : 0;
  const windowEndIndex = selectionMode || tailCap === null ? messages.length : Math.min(tailCap, messages.length);
  const visibleMessages = messages.slice(windowStartIndex, windowEndIndex);

  const loadMoreRef = useRef<HTMLDivElement | null>(null);
  const loadNewerRef = useRef<HTMLDivElement | null>(null);
  const expandAdjustRef = useRef<{
    scroller: HTMLElement;
    prevHeight: number;
    /** 锚点：扩展前视口内第一条消息的 id 与相对滚动容器顶部的偏移（抗原生锚定叠加与异步增高） */
    anchorId: string | null;
    anchorTop: number;
  } | null>(null);

  const expandWindow = useCallback(() => {
    const scroller = findScrollableAncestor(loadMoreRef.current);
    if (scroller) {
      // 先脱离底部跟随：内容在视口上方长高时，StickToBottom 的 ResizeObserver 可能把视图拽回底部
      stickContextRef?.current?.stopScroll?.();
      const scrollerTop = scroller.getBoundingClientRect().top;
      const anchor = Array.from(scroller.querySelectorAll<HTMLElement>("[data-message-id]")).find((el) => {
        const rect = el.getBoundingClientRect();
        return rect.bottom > scrollerTop; // 第一条仍在视口内的消息
      });
      expandAdjustRef.current = {
        scroller,
        prevHeight: scroller.scrollHeight,
        anchorId: anchor?.getAttribute("data-message-id") ?? null,
        anchorTop: anchor ? anchor.getBoundingClientRect().top - scrollerTop : 0,
      };
    }
    setVisibleCount((c) => Math.min(messages.length, c + EXPAND_STEP));
  }, [messages.length, stickContextRef]);

  const expandNewer = useCallback(() => {
    // 先脱离底部跟随：内容在下方增长时，跟随锁会把视图拽到新的底部，读到一半被跳过
    stickContextRef?.current?.stopScroll?.();
    setTailCap((cap) => (cap === null || cap + EXPAND_NEWER >= messages.length ? null : cap + EXPAND_NEWER));
  }, [messages.length, stickContextRef]);

  // 导航条跳转：目标不在已渲染区间时，以目标为中心重设区间（前留 1 条保证上下文，后取 JUMP_AHEAD 条）
  const navBridge = useContext(ChatNavBridgeContext);
  useLayoutEffect(() => {
    if (!navBridge) return;
    navBridge.current.ensureVisible = (id: string) => {
      const idx = messages.findIndex((m) => m.id === id);
      if (idx < 0 || (idx >= windowStartIndex && idx < windowEndIndex)) return;
      const start = Math.max(0, idx - 1);
      setVisibleCount(messages.length - start);
      setTailCap(idx + JUMP_AHEAD >= messages.length ? null : idx + JUMP_AHEAD);
    };
    return () => {
      if (navBridge.current.ensureVisible) navBridge.current.ensureVisible = undefined;
    };
  });

  // 扩展后保持视口内容不跳：优先用「锚点元素法」——记录扩展前视口内第一条消息的
  // id 与相对位置，扩展后按同一元素的新位置反算 scrollTop（免疫原生 overflow-anchor
  // 双重补偿与异步增高内容）；锚点元素缺失时回退到旧的 scrollHeight 差补偿。
  // biome-ignore lint/correctness/useExhaustiveDependencies: visibleCount 是刻意的触发依赖（effect 体只读 ref），等扩展渲染提交后再补偿
  useLayoutEffect(() => {
    const st = expandAdjustRef.current;
    if (!st) return;
    expandAdjustRef.current = null;
    const anchorOffset = () => st.scroller.getBoundingClientRect().top;
    const adjustByAnchor = () => {
      if (!st.anchorId) return false;
      const el = st.scroller.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(st.anchorId)}"]`);
      if (!el) return false;
      const delta = el.getBoundingClientRect().top - anchorOffset() - st.anchorTop;
      if (Math.abs(delta) > 0.5) st.scroller.scrollTop += delta;
      return true;
    };
    if (adjustByAnchor()) {
      // 异步增高内容（代码高亮/公式/图片/折叠区）在补偿后再落地时，下一帧用同一锚点再校一次
      requestAnimationFrame(() => {
        adjustByAnchor();
      });
    } else {
      const delta = st.scroller.scrollHeight - st.prevHeight;
      if (delta > 0) st.scroller.scrollTop += delta;
    }
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

  // 区间浏览的底部占位：下滑接近时渐进补齐较新的消息
  const newerPending = windowEndIndex < messages.length;
  useEffect(() => {
    const el = loadNewerRef.current;
    if (!el || !newerPending) return;
    const root = findScrollableAncestor(el);
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) expandNewer();
      },
      { root, rootMargin: "0px 0px 200px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [newerPending, expandNewer]);

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
      stickContextRef?.current?.scrollToBottom("instant");
      hasInitialScrolled.current = true;
    }
  }, [messages.length, stickContextRef]);

  useEffect(() => {
    if (scrollKey !== undefined && prevScrollKey.current !== scrollKey) {
      stickContextRef?.current?.scrollToBottom("instant");
      prevScrollKey.current = scrollKey;
      hasInitialScrolled.current = true;
    }
  }, [scrollKey, stickContextRef]);

  const renderMessageParts = (parts: any[], isLastMessage: boolean, isAssistant = true, messageId?: string) => {
    const elements: any[] = [];
    let textBuffer = "";
    let bufferLastPartIndex = -1;
    const lastTextPartIndex = parts.findLastIndex((p) => p?.type === "text");

    const flushText = () => {
      if (!textBuffer) return;
      const className = isAssistant
        ? "prose prose-neutral min-w-0 flex-1 rounded bg-transparent p-0 text-foreground"
        : "rounded-xl bg-muted p-2 text-base leading-5";

      elements.push(
        <StreamRevealBox
          key={`text-${elements.length}`}
          text={textBuffer}
          // 仅"最后一条消息的最后一段文本"且会话正在流式时才是接收中——历史消息/工具调用前的已完结段落不挂光标雾带
          streaming={isAssistant && isLastMessage && isStreaming && bufferLastPartIndex === lastTextPartIndex}
          enabled={isAssistant && revealAllowed}
          className={className}
          markdown={isAssistant}
          onMouseUp={handleTextSelection}
        />,
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
        bufferLastPartIndex = i;
        continue;
      }

      if (type === "quote") {
        flushText();
        elements.push(<MessageQuotePart key={`quote-${i}`} text={part.text ?? ""} />);
        continue;
      }

      // J2 图片附件（D4：新消息存 attachment:// 引用按需解析；存量消息仍是 base64 dataUrl）
      if (type === "file") {
        flushText();
        const url = (part as any).url;
        const mediaType = (part as any).mediaType ?? "";
        if (typeof url === "string" && mediaType.startsWith("image/")) {
          elements.push(
            <MessageImagePart key={`file-${i}`} url={url} alt={(part as any).filename ?? "图片"} bookId={bookId} />,
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
          <Reasoning key={`reasoning-${i}`}>
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
        // text 只有在后面确实还有工具时才属于组内插段；最后一个工具后的正文始终交还主流程。
        let toolCount = 1;
        let j = i + 1;
        let firstTextAfterLastTool = -1;
        while (j < parts.length) {
          const nextType = parts[j]?.type as string | undefined;
          if (nextType === "step-start" || nextType === "reasoning" || nextType === "custom") {
            j += 1;
            continue;
          }
          if (nextType === "text") {
            if (firstTextAfterLastTool < 0) firstTextAfterLastTool = j;
            j += 1;
            continue;
          }
          if (typeof nextType === "string" && nextType.startsWith("tool-")) {
            toolCount += 1;
            firstTextAfterLastTool = -1;
            j += 1;
            continue;
          }
          break;
        }
        if (toolCount >= 2) {
          const groupEnd = firstTextAfterLastTool >= 0 ? firstTextAfterLastTool : j;
          elements.push(
            <ToolCallGroup
              key={`toolgroup-${i}`}
              parts={parts.slice(i, groupEnd)}
              startIndex={i}
              active={isLastMessage && (status === "submitted" || status === "streaming")}
              textStreaming={isLastMessage && isStreaming}
              lastTextPartIndex={lastTextPartIndex}
              revealAllowed={revealAllowed}
              onTextMouseUp={handleTextSelection}
              onViewDetail={onViewToolDetail}
              isChatPage={isChatPage}
            />,
          );
          i = groupEnd - 1;
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
          // 未成团：不消费后续插段，交还主循环各自渲染。
        }
        continue;
      }

      flushText();
    }

    flushText();

    // 引用标来源映射：从本消息持久化的工具结果重建（paperSearch/ragSearch 等 output），
    // 随 React context 下发给正文里的 [N] 引用标弹窗；无工具结果为 null（弹窗走面板/store 兜底）
    const citationMap = getStableCitationMap(messageId, parts);
    return (
      <CitationMapContext.Provider value={citationMap}>
        <div className="flex flex-col gap-1" data-message-id={messageId}>
          {elements}
          {isAssistant && messageId && onOpenFile && !selectionMode && (
            <ChangedFilesDisclosure message={{ id: messageId, parts }} onOpenFile={onOpenFile} />
          )}
        </div>
      </CitationMapContext.Provider>
    );
  };

  const content = (
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
        // 只有达到输出长度上限才提供续问；用户主动停止仍走普通重新生成。
        const interruptedMark =
          isAssistant &&
          isLastMessage &&
          !isStreaming &&
          !!((message.metadata as { interrupted?: boolean } | undefined)?.interrupted ?? false);
        const lengthInterrupted =
          interruptedMark && (message.metadata as { finishReason?: string } | undefined)?.finishReason === "length";
        const retryLabel = lengthInterrupted ? "继续生成" : "重新生成";
        const canShowRetry = (showError || interruptedMark) && !!onRetry;

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
                    {renderMessageParts(message.parts, isLastMessage, true, message.id)}
                    {((!isStreaming && isLastMessage) || !isLastMessage) && !selectionMode && (
                      <div className="flex items-center justify-between">
                        <MessageActions className="-ml-2.5 flex transform-gpu gap-0">
                          {/* 末条 assistant 恒提供重试；只有长度截断时改为续问文案。 */}
                          {isLastMessage && !!onRetry && (
                            <MessageAction tooltip={retryLabel} delayDuration={100}>
                              <Button
                                variant="ghost"
                                size="icon"
                                aria-label={retryLabel}
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

                          <DropdownMenu>
                            <MessageAction tooltip="导出" delayDuration={100}>
                              <DropdownMenuTrigger asChild>
                                <Button variant="ghost" size="icon" aria-label="导出" className="size-7 rounded-full">
                                  <Download size={10} />
                                </Button>
                              </DropdownMenuTrigger>
                            </MessageAction>
                            <DropdownMenuContent side="top" align="start">
                              <DropdownMenuItem
                                aria-label="导出为图片"
                                onSelect={() => {
                                  const { currentThread } = useThreadStore.getState();
                                  void exportMessagesToImage([message], {
                                    title: `${currentThread?.title || "未命名对话"}-第${index + 1}条`,
                                    bookId: currentThread?.book_id,
                                    successText: "消息导出成功",
                                  });
                                }}
                              >
                                <ImageIcon size={10} />
                                导出为图片
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                aria-label="导出为 Markdown"
                                onSelect={() => {
                                  void exportMessageToMarkdown(message, {
                                    threadTitle: useThreadStore.getState().currentThread?.title,
                                    index,
                                  });
                                }}
                              >
                                导出为 Markdown
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>

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
                    {renderMessageParts(message.parts, isLastMessage, false, message.id)}

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
                        {/* TODO: 实现编辑功能
                  <MessageAction tooltip="编辑" delayDuration={100}>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-7 rounded-full"
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
                      className="size-7 rounded-full"
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
                            className="size-7 rounded-full"
                            onClick={() => {
                              const textContent = message.parts
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
                            className="size-7 rounded-full"
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
                            <ImageIcon size={12} />
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
      {newerPending && (
        <div
          ref={loadNewerRef}
          className={cn("mx-auto w-full", wideChatLayout ? "max-w-5xl" : "max-w-3xl", isChatPage ? "px-4" : "px-2")}
        >
          <button
            type="button"
            onClick={expandNewer}
            className="w-full rounded-lg border border-neutral-300 border-dashed py-1.5 text-neutral-500 text-xs hover:bg-muted dark:border-neutral-700 dark:text-neutral-400"
          >
            还有 {messages.length - windowEndIndex} 条较新的消息，点击或下滑加载
          </button>
        </div>
      )}
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
  return <LocalFileLinkContext.Provider value={onOpenLocalFile ?? null}>{content}</LocalFileLinkContext.Provider>;
}

// React.memo：切 tab 时 StickToBottom 内部状态冲刷会重渲 ChatContainerRoot（provider），
// 未 memo 的 ChatMessages 会被父级重渲连带整棵消息树（数百 PaperLink/Tooltip 叶组件）；
// 此时三个面板父组件并不重渲（props 引用全稳定），memo 即跳过——流式/操作等父组件真重渲路径
// 的 props 必变（messages 引用/回调重建），语义逐字等价。（2026-08-26 切 tab 墙溯源根修）
export const ChatMessages = memo(ChatMessagesComponent);
