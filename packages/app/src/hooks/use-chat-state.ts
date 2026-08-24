import { useChat } from "@/ai/hooks/use-chat";
import { modelSupportsVision } from "@/ai/providers/vision-map";
import { repairImageDataUrl, sniffImageMediaType } from "@/ai/utils/media-sniff";
import { truncateToolResultsForStorage } from "@/ai/utils/tool-result-slimming";
import { useForceUpdate } from "@/hooks/use-force-update";
import { useModelSelector } from "@/hooks/use-model-selector";
import type { ReasoningTimes } from "@/hooks/use-reasoning-timer";
import { useTextEventHandler } from "@/hooks/use-text-event";
import { saveImageAttachment } from "@/services/attachment-service";
import { createThread, editThread, getLatestThreadBybookId, getThreadById } from "@/services/thread-service";
import { generateThreadTitleWithAI } from "@/services/thread-title-service";
import { type SelectedModel, useProviderStore } from "@/store/provider-store";
import { useThreadStore } from "@/store/thread-store";
import type { ChatReference, ImageAttachment, MessageMetadata } from "@/types/message";
import type { Thread, ThreadSummary } from "@/types/thread";
import { useQueryClient } from "@tanstack/react-query";
import type { UIMessage } from "ai";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

export interface UseChatStateReturn {
  // 基础状态
  input: string;
  setInput: (value: string) => void;
  references: ChatReference[];
  displayError: Error | null;
  showThreads: boolean;
  threadsKey: number;
  isInit: React.RefObject<boolean>;
  currentThread: any;

  // Chat 相关
  messages: UIMessage[];
  status: string;
  error: any;
  stop: () => void;

  // 模型相关
  selectedModel: SelectedModel | null;
  setSelectedModel: (model: SelectedModel) => void;

  // 引用管理
  handleAskSelection: (text: string) => void;
  handleRemoveReference: (id: string) => void;

  // J2/K2：图片附件与内联标记
  images: ImageAttachment[];
  handleRemoveImage: (id: string) => void;
  handleAddImageFiles: (files: File[]) => Promise<void>;
  registerInputEl: (el: HTMLTextAreaElement | null) => void;

  // 消息处理
  handleSubmit: (promptOverride?: string) => Promise<void>;
  handleRetry: () => Promise<void>;

  // 线程管理
  handleNewThread: () => void;
  handleShowThreads: () => void;
  handleSelectThread: (thread: ThreadSummary) => Promise<void>;
  handleBackFromThreads: () => void;

  // 其他
  handleReasoningTimesUpdate: (messageId: string, reasoningTimes: ReasoningTimes) => void;
  canRetry: boolean;
}

/** 归一化流错误为可读中文（AI SDK 的 APICallError 的 message 常为空，需取 statusCode/responseBody） */
function normalizeChatError(error: unknown): Error {
  const e = error as { statusCode?: number; responseBody?: string; message?: string } | null;
  if (e?.statusCode === 401) {
    return new Error("模型认证失败（401）：请检查该提供商的 API Key 是否正确，可到 设置 → 模型提供商 重新填写");
  }
  if (e?.statusCode) {
    const body = typeof e.responseBody === "string" ? e.responseBody.slice(0, 160) : "";
    return new Error(`模型请求失败（HTTP ${e.statusCode}）${body ? `：${body}` : ""}`);
  }
  const msg = e?.message?.trim() || (typeof error === "string" ? error.trim() : "");
  return new Error(msg || "模型请求失败，请稍后重试");
}

export interface ChatContext {
  activeBookId?: string;
  /** paper 专用：当前阅读小节正文（页面按 heading 从 paper.md 规则提取）；reader/central 不使用 */
  activeContext?: string;
  activeSectionLabel?: string;
  agentScope?: "central" | "reader" | "paper";
  /** 论文助手：paperSearch 的检索范围（null = 全部文献；数组 = 限定论文集合；仅 agentScope="paper" 时有效） */
  paperScopeIds?: string[] | null;
  /** 当前对话 id（滚动压缩摘要按对话持久化用，useChatState 注入，调用方无需传） */
  threadId?: string;
}

interface UseChatStateOptions {
  chatContext: ChatContext;
  setActiveBookId: (bookId: string) => void;
  currentThread?: Thread | null;
  setCurrentThread?: (thread: Thread | null) => void;
}

export function useChatState(options: UseChatStateOptions): UseChatStateReturn {
  const { chatContext, setActiveBookId } = options;
  const { activeBookId, agentScope } = chatContext;
  // 根据 Agent 角色确定线程 scope
  const threadScope = agentScope === "central" ? "global" : "book";
  const [input, setInput] = useState("");
  const [showThreads, setShowThreads] = useState(false);
  const [threadsKey, setThreadsKey] = useState(0);
  const [displayError, setDisplayError] = useState<Error | null>(null);
  const [references, setReferences] = useState<ChatReference[]>([]);
  // J2/K2：图片附件与内联标记体系（⟦引用N⟧/⟦图片N⟧ 占位插在输入区，提交时按位置展开）
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const markerSeqRef = useRef(0);
  const inputElRef = useRef<HTMLTextAreaElement | null>(null);

  const registerInputEl = useCallback((el: HTMLTextAreaElement | null) => {
    inputElRef.current = el;
  }, []);

  /** 在输入区光标处插入占位标记；未聚焦时追加到末尾（可多选替换选区） */
  const insertMarkerIntoInput = useCallback((marker: string) => {
    const el = inputElRef.current;
    setInput((prev) => {
      if (el && document.activeElement === el) {
        const start = el.selectionStart ?? prev.length;
        const end = el.selectionEnd ?? start;
        return prev.slice(0, start) + marker + prev.slice(end);
      }
      return prev ? `${prev}${marker}` : marker;
    });
  }, []);
  const isInit = useRef(false);
  const globalThreadStore = useThreadStore();
  const currentThread = options.currentThread !== undefined ? options.currentThread : globalThreadStore.currentThread;
  const setCurrentThread = options.setCurrentThread || globalThreadStore.setCurrentThread;
  const forceUpdate = useForceUpdate();
  const queryClient = useQueryClient();

  const messagesRef = useRef<UIMessage[]>([]);
  const reasoningTimesRef = useRef<{ [messageId: string]: ReasoningTimes }>({});

  // H1 断点续传：落库统一走 persistMessagesNow（submit/finish/abort/error 事件触发，无流式周期写）。
  // 在飞期间到达的请求不再丢弃——只记最新一份，当前写完后补写（尾沿合并），
  // 保证落盘内容单调变新、不被在飞的旧快照覆盖。
  const persistingRef = useRef(false);
  const pendingPersistRef = useRef<{ threadId: string; msgs: UIMessage[] } | null>(null);
  const persistMessagesNow = useCallback(async (threadId: string, msgs: UIMessage[]) => {
    if (persistingRef.current) {
      pendingPersistRef.current = { threadId, msgs };
      return;
    }
    persistingRef.current = true;
    try {
      let current: { threadId: string; msgs: UIMessage[] } | null = { threadId, msgs };
      while (current) {
        try {
          // D6 L1 出生截断：落库内容换预览（内存态保持全量供 UI/当轮使用；当轮在飞链不经过落库）
          await editThread(current.threadId, { messages: truncateToolResultsForStorage(current.msgs) });
        } catch (error) {
          console.warn("对话增量落库失败:", error);
        }
        current = pendingPersistRef.current;
        pendingPersistRef.current = null;
      }
    } finally {
      persistingRef.current = false;
    }
  }, []);

  // 异步回调（onFinish 等）里要读最新的 currentThread，且来源必须与调用方一致（options 优先）
  const currentThreadRef = useRef(currentThread);
  useEffect(() => {
    currentThreadRef.current = currentThread;
  }, [currentThread]);

  // 卸载标记（2026-08-24 消息丢失根修）：在飞流的 onFinish 在组件卸载后仍会触发——
  // 落库必须照常（保住响应），但共享 store 回写必须停，否则重挂载时 initializeThread
  // 见到非空 currentThread 会跳过 DB 续接、新 Chat 实例 messages 恒为 [] → 用户看到"新开对话"页
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const handleReasoningTimesUpdate = (messageId: string, reasoningTimes: ReasoningTimes) => {
    reasoningTimesRef.current[messageId] = reasoningTimes;
  };

  const { selectedModel, setSelectedModel, currentModelInstance } = useModelSelector("deepseek", "deepseek-chat");

  const { messages, status, error, stop, setMessages, sendMessage, clearError, regenerate } = useChat(
    currentModelInstance || "deepseek-chat",
    {
      experimental_throttle: 50,
      messages: [],
      chatContext: { ...chatContext, threadId: currentThread?.id },
      onError: (error) => {
        console.error("Error:", error);
        // 直接把错误送到展示层，避免“thinking 后无下文”的沉默（不依赖 useChat error 状态的传播路径）
        setDisplayError(normalizeChatError(error));
      },
      onFinish: ({ message, messages: finishedMessages, isError, isAbort }: any) => {
        // H1：abort 也走 onFinish（SDK finally 块，isAbort=true）——只记录相位并早退；
        // 打标/落库统一由 streamPhase effect 延迟 200ms 执行（避开 SDK 50ms 节流丢尾通知与排队 job 冲刷）
        streamPhaseRef.current = isAbort && !isError ? "aborted" : "settled";
        if (isAbort && !isError) return;
        const currentThread = currentThreadRef.current;
        const { selectedModel } = useProviderStore.getState();
        const resolvedMessages = finishedMessages ?? messagesRef.current;

        let nextMessages = resolvedMessages;

        if (isError) {
          const lastMessage = resolvedMessages[resolvedMessages.length - 1];
          if (lastMessage?.role === "assistant") {
            const assistantHasContent = Array.isArray(lastMessage.parts)
              ? lastMessage.parts.some((part: any) => part?.type === "text" && part?.text?.trim())
              : false;
            if (!assistantHasContent) {
              nextMessages = resolvedMessages.slice(0, -1);
            }
          }
        } else if (message) {
          const reasoningTimes = reasoningTimesRef.current[message.id] || {};
          const messageIndex = resolvedMessages.findIndex((item: any) => item.id === message.id);

          if (messageIndex !== -1) {
            const prevMeta = (message.metadata as MessageMetadata) || {};
            // H1：正常完成时清除中断标记（若是续生成/重试补完的）
            const { interrupted: _interrupted, ...restMeta } = prevMeta as MessageMetadata & {
              interrupted?: boolean;
            };
            const messageWithMetadata = {
              ...message,
              metadata: {
                ...restMeta,
                provider: selectedModel,
                selectedModel,
                createdAt: Math.floor(Date.now() / 1000),
                updatedAt: Math.floor(Date.now() / 1000),
                reasoningTimes,
              } as MessageMetadata,
            };

            nextMessages = [
              ...resolvedMessages.slice(0, messageIndex),
              messageWithMetadata,
              ...resolvedMessages.slice(messageIndex + 1),
            ];
          }
        }

        const normalizedMessages = Array.isArray(nextMessages) ? [...nextMessages] : [...messagesRef.current];
        messagesRef.current = normalizedMessages;
        setMessages(normalizedMessages);

        if (isError) {
          // H1：错误中断也落库，保留已产出的思考/正文/工具卡（重进可见中断现场）
          const thread = currentThreadRef.current;
          if (thread?.id) {
            void persistMessagesNow(thread.id, normalizedMessages);
          }
          return;
        }

        // 首轮问答完成后，若标题仍是占位标题（首条消息截断或"新对话"），用 AI 异步生成简短标题
        const autoNameFirstRound = (thread: Thread) => {
          const userMessages = normalizedMessages.filter((m) => m.role === "user");
          const assistantMessages = normalizedMessages.filter((m) => m.role === "assistant");
          if (userMessages.length !== 1 || assistantMessages.length !== 1) return;

          const firstUserParts = userMessages[0]?.parts ?? [];
          const firstUserText = firstUserParts.map((p: any) => (p.type === "text" ? p.text : "")).join("");
          const firstQuoteText = (firstUserParts.find((p: any) => p.type === "quote") as any)?.text || "";
          const placeholderTitle = (firstUserText || firstQuoteText || "新对话").slice(0, 50);
          const isPlaceholderTitle = !thread.title || thread.title === "新对话" || thread.title === placeholderTitle;
          if (!isPlaceholderTitle) return;

          generateThreadTitleWithAI(normalizedMessages, selectedModel ?? undefined)
            .then(async (title) => {
              if (!title) return;
              const renamedThread = await editThread(thread.id, { title });
              // 卸载后不回写共享 store（理由见 mountedRef）；改名落库与缓存刷新照常
              if (mountedRef.current) setCurrentThread(renamedThread);
              queryClient.invalidateQueries({ queryKey: ["threads"] });
            })
            .catch((error) => {
              // 自动命名失败静默处理，保留占位标题
              console.warn("AI 自动命名失败，保留占位标题:", error);
            });
        };

        // H1：落库统一走 persistMessagesNow 队列（尾沿合并），与 submit 时刻的落库保序，
        // 不再另起 editThread 直写通道（旧版双通道并发，旧快照可能覆盖新快照）
        const persistMessages = (thread: Thread) => {
          void persistMessagesNow(thread.id, normalizedMessages);
          // 卸载（切页/关 tab）后不回写共享 store——落库照常，UI 侧状态随组件消亡（理由见 mountedRef）
          if (mountedRef.current) setCurrentThread({ ...thread, messages: normalizedMessages });
          autoNameFirstRound(thread);
        };

        if (currentThread?.id) {
          persistMessages(currentThread);
        } else {
          const firstUserText =
            normalizedMessages
              .find((m) => m.role === "user")
              ?.parts?.map((p: any) => (p.type === "text" ? p.text : ""))
              .join("") || "新对话";
          createThread(activeBookId, firstUserText.slice(0, 50), normalizedMessages, threadScope)
            .then((thread) => {
              console.log("Created thread on finish:", thread.id);
              persistMessages(thread);
            })
            .catch((error) => {
              console.error("Failed to create thread on finish:", error);
            });
        }
      },
    },
  );

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  // H1 断点续传：流式阶段跟踪（submitted/streaming → active）；onFinish 结算（settled/aborted）。
  // abort 打标延迟执行：等 SDK 节流通知窗口（50ms）与排队 update job 平息后再写，
  // 否则注入的 metadata 会被最后一次 replaceMessage 冲掉或通知被节流丢弃（UI 不刷新）。
  const streamPhaseRef = useRef<"idle" | "active" | "aborted" | "settled">("idle");
  useEffect(() => {
    if (status === "submitted" || status === "streaming") {
      streamPhaseRef.current = "active";
      return;
    }
    if (status === "error") {
      streamPhaseRef.current = "settled";
      return;
    }
    if (status === "ready" && streamPhaseRef.current === "aborted") {
      streamPhaseRef.current = "settled";
      // 快照调度时刻的线程与消息：200ms 窗口内用户切换对话时，
      // 打标仍落到被中止的那场对话（而不是误标新对话并覆盖其落库内容）
      const threadSnapshot = currentThreadRef.current;
      const msgsSnapshot = messagesRef.current;
      const timer = window.setTimeout(() => {
        if (!threadSnapshot?.id || msgsSnapshot.length === 0) return;
        const last = msgsSnapshot[msgsSnapshot.length - 1];
        if (last?.role !== "assistant" || !Array.isArray(last.parts) || last.parts.length === 0) return;
        // 中止收尾：未完成的工具部件（还在 input-streaming/input-available）统一标记为已中止，
        // 否则"Processing"转圈状态会永久留在消息与落库数据里
        const closedParts = last.parts.map((part: any) =>
          typeof part?.type === "string" &&
          part.type.startsWith("tool-") &&
          (part.state === "input-streaming" || part.state === "input-available")
            ? { ...part, state: "output-error", errorText: "已被用户中止" }
            : part,
        );
        const marked = [
          ...msgsSnapshot.slice(0, -1),
          {
            ...last,
            parts: closedParts,
            metadata: { ...((last.metadata as MessageMetadata) || {}), interrupted: true },
          },
        ];
        // 仅当 UI 仍停留在该对话时才刷新界面与共享 ref；落库始终按快照线程执行
        if (currentThreadRef.current?.id === threadSnapshot.id) {
          messagesRef.current = marked;
          setMessages(marked);
        }
        void persistMessagesNow(threadSnapshot.id, marked);
      }, 200);
      return () => window.clearTimeout(timer);
    }
  }, [status, setMessages, persistMessagesNow]);

  // H1 断点续传（2026-08-09 修正）：仅发送时刻（submitted）落库用户消息。
  // 教训：旧版流式期间每 2s 节流落库，每次都是全量对话 JSON 序列化（跑在 JS 主线程）；
  // 工具密集长对话几十 MB 后每次序列化卡几秒到几十秒，主线程周期性冻结
  // （探针实证：50 分钟工具轮后半段周期性卡死几分钟的真凶）。
  // assistant 产出改由 finish/abort/error 时刻一次性落库（onFinish + streamPhase effect），
  // 中断现场恢复能力不变；代价仅"流式途中 app 崩溃"丢部分输出（罕见，可接受）
  useEffect(() => {
    if (status !== "submitted") return;
    const thread = currentThreadRef.current;
    if (!thread?.id || messages.length === 0) return;
    void persistMessagesNow(thread.id, messages);
  }, [status, messages, persistMessagesNow]);

  useEffect(() => {
    if (!error) return;

    if (error instanceof Error) {
      setDisplayError(error);
    } else {
      let fallbackMessage = "未知错误";
      if (typeof error === "string" && (error as string).trim()) {
        fallbackMessage = error;
      } else {
        try {
          const serialized = JSON.stringify(error);
          if (serialized) {
            fallbackMessage = serialized;
          }
        } catch {
          fallbackMessage = String(error);
        }
      }
      setDisplayError(new Error(fallbackMessage));
    }

    clearError();
  }, [error, clearError]);

  useEffect(() => {
    if (status === "submitted" || status === "streaming") {
      setDisplayError(null);
    }
  }, [status]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: <explanation>
  useEffect(() => {
    const initializeThread = async () => {
      if (isInit.current) return;
      // 重挂载时 store 已有线程（HMR、卸载期在飞流 finish 回写等竞态）：把其消息水合进新 Chat 实例——
      // 新实例 messages 恒为 []，不水合会落到"新开对话"页（2026-08-24 消息丢失根修配套）。
      // 仅此首启分支做水合：之后 currentThread 变化（发消息/改名/选线程）走正常事件流，绝不回读覆盖在飞内容
      if (currentThread) {
        setMessages(currentThread.messages ?? []);
        isInit.current = true;
        forceUpdate();
        return;
      }
      // H2 切页续接：重挂载时续接最近一次对话（书籍按 bookId+scope='book'，全局助手按 scope='global'）；
      // 仅「新对话」按钮（handleNewThread）才显式新开——handleNewThread 后 isInit 已为 true，不会回读。
      // central scope 不按 bookId 查（activeBookId 可能被钉书污染），由后端按 scope='global' 续接
      const lookupBookId = agentScope === "central" ? undefined : activeBookId;
      try {
        const latestThread = await getLatestThreadBybookId(lookupBookId, threadScope);
        if (latestThread) {
          setCurrentThread(latestThread);
          setMessages(latestThread.messages);
        }
        isInit.current = true;
        forceUpdate();
      } catch (error) {
        console.error("Failed to load existing thread:", error);
      }
    };

    initializeThread();
  }, [activeBookId, currentThread, setCurrentThread, setMessages]);

  // 卸载红线（2026-08-24 消息丢失根修）：绝不能 setMessages([])——本 hook 的 Chat 实例在组件
  // 卸载后仍随在飞流式任务继续跑（流由 transport/孤儿实例持有），清空消息表会让孤儿流 finish 时
  // 以残缺的 [assistant] 全量覆盖落库，user 消息与历史全没（实测产出孤 assistant 线程）。
  // 卸载只需松开 store 指针（重挂载走 initializeThread 续接）；局部 state 随组件消亡，无需清。
  // biome-ignore lint/correctness/useExhaustiveDependencies: <explanation>
  useEffect(() => {
    return () => {
      setCurrentThread(null);
    };
  }, []);

  const createReferenceId = useCallback(() => {
    const cryptoObj = typeof globalThis !== "undefined" ? (globalThis as any).crypto : undefined;
    if (cryptoObj && typeof cryptoObj.randomUUID === "function") {
      return cryptoObj.randomUUID() as string;
    }
    return `ref-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }, []);

  const handleAskSelection = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) {
        return;
      }

      // K2：先判重再分配标记号/插占位——已在列表中的文本直接忽略，
      // 否则占位已插而引用未增，留下无 chip 对应的孤儿 ⟦引用N⟧
      if (references.some((reference) => reference.text === trimmed)) {
        return;
      }
      const markerNum = ++markerSeqRef.current;
      setReferences((prev) => [...prev, { id: createReferenceId(), text: trimmed, markerNum }]);
      insertMarkerIntoInput(`⟦引用${markerNum}⟧`);

      // 论文面板的输入区在 #paper-chat-panel 下，书籍/全局在 #chat-sidebar 下
      const panelSelector = agentScope === "paper" ? "#paper-chat-panel" : "#chat-sidebar";
      setTimeout(() => {
        const textarea = document.querySelector(`${panelSelector} textarea`) as HTMLTextAreaElement;
        if (textarea) {
          textarea.focus();
        }
      }, 200);
    },
    [createReferenceId, agentScope, insertMarkerIntoInput, references],
  );

  const handleRemoveReference = useCallback(
    (id: string) => {
      // K2：删引用 chip 同步清除输入区里的占位标记
      const target = references.find((r) => r.id === id);
      if (target?.markerNum != null) {
        setInput((prev) => prev.replaceAll(`⟦引用${target.markerNum}⟧`, ""));
      }
      setReferences((prev) => prev.filter((reference) => reference.id !== id));
    },
    [references],
  );

  const handleRemoveImage = useCallback(
    (id: string) => {
      const target = images.find((img) => img.id === id);
      if (target) {
        setInput((prev) => prev.replaceAll(`⟦图片${target.markerNum}⟧`, ""));
      }
      setImages((prev) => prev.filter((img) => img.id !== id));
    },
    [images],
  );

  // 图片附件核心追加（本地文件选择器 / 阅读区图片引用共用）：分配标记号 + 光标处插占位
  const addImageAttachment = useCallback(
    (dataUrl: string, mediaType: string, name: string) => {
      // asset 协议/本地服务器 fetch 出的 blob.type 可能是空串或 text/plain：
      // 嗅探修正 mediaType 字段 + dataUrl MIME 前缀（部分提供商按 URL 头判类型）
      const repairedUrl = repairImageDataUrl(dataUrl);
      const realType = sniffImageMediaType(repairedUrl) || mediaType || "image/png";
      const markerNum = ++markerSeqRef.current;
      setImages((prev) => [
        ...prev,
        {
          id: `img-${Date.now()}-${markerNum}`,
          markerNum,
          dataUrl: repairedUrl,
          mediaType: realType,
          name,
        },
      ]);
      insertMarkerIntoInput(`⟦图片${markerNum}⟧`);
    },
    [insertMarkerIntoInput],
  );

  // J2：添加图片附件——已知纯文本模型当场拒绝并提示；通过则读为 base64 并插入光标处占位标记
  const handleAddImageFiles = useCallback(
    async (files: File[]) => {
      const imageFiles = files.filter((f) => f.type.startsWith("image/"));
      if (imageFiles.length === 0) return;
      const sel = useProviderStore.getState().selectedModel;
      if (sel && !modelSupportsVision(sel.providerId, sel.modelId)) {
        toast.error(`当前模型（${sel.modelId}）不支持图片输入，请切换到支持多模态的模型`);
        return;
      }
      for (const file of imageFiles) {
        const dataUrl = await new Promise<string | null>((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = () => resolve(null);
          reader.readAsDataURL(file);
        });
        if (!dataUrl) continue;
        addImageAttachment(dataUrl, file.type, file.name);
      }
    },
    [addImageAttachment],
  );

  // J2 补环：阅读区图片引用（imageToChat 事件）——已是 dataUrl，免去 FileReader；同样过视觉闸
  const handleAddImageDataUrl = useCallback(
    (image: { dataUrl: string; mediaType: string; name: string }) => {
      const sel = useProviderStore.getState().selectedModel;
      if (sel && !modelSupportsVision(sel.providerId, sel.modelId)) {
        toast.error(`当前模型（${sel.modelId}）不支持图片输入，请切换到支持多模态的模型`);
        return;
      }
      addImageAttachment(image.dataUrl, image.mediaType || "image/png", image.name || "图片");
    },
    [addImageAttachment],
  );

  useTextEventHandler({
    sendMessage,
    activeBookId,
    // "Ask AI"（引用）事件 → 注入输入框引用区（与划词引用同一链路）
    onQuoteReference: handleAskSelection,
    // 阅读区图片引用 → 输入区图片附件（同一视觉闸）
    onImageReference: handleAddImageDataUrl,
  });

  // K2/J2：按输入区标记位置把正文/引用/图片交织成有序 parts（⟦引用N⟧/⟦图片N⟧ 占位）；
  // 无标记的旧式引用兼容前置，未定位的图片后置
  const buildMessageParts = useCallback((rawInput: string, refs: ChatReference[], imgs: ImageAttachment[]) => {
    const parts: any[] = [];
    const usedRefNums = new Set<number>();
    const usedImgNums = new Set<number>();
    const pushText = (segment: string) => {
      const trimmed = segment.trim();
      if (trimmed) parts.push({ type: "text", text: trimmed });
    };
    const markerRe = /⟦(引用|图片)(\d+)⟧/g;
    let last = 0;
    for (let match = markerRe.exec(rawInput); match; match = markerRe.exec(rawInput)) {
      pushText(rawInput.slice(last, match.index));
      const num = Number(match[2]);
      if (match[1] === "引用") {
        const ref = refs.find((r) => r.markerNum === num);
        if (ref) {
          usedRefNums.add(num);
          parts.push({ type: "quote", text: ref.text, source: `引用${num}`, id: ref.id });
        }
      } else {
        const img = imgs.find((i) => i.markerNum === num);
        if (img) {
          usedImgNums.add(num);
          parts.push({ type: "file", mediaType: img.mediaType, url: img.dataUrl, filename: img.name });
        }
      }
      last = match.index + match[0].length;
    }
    pushText(rawInput.slice(last));
    // 兼容层：未插标记的引用（旧链路/弹窗直发）前置；未定位的图片后置
    refs
      .filter((r) => r.markerNum == null || !usedRefNums.has(r.markerNum))
      .forEach((ref, index) => {
        parts.unshift({ type: "quote", text: ref.text, source: `引用${index + 1}`, id: ref.id });
      });
    imgs
      .filter((img) => !usedImgNums.has(img.markerNum))
      .forEach((img) => parts.push({ type: "file", mediaType: img.mediaType, url: img.dataUrl, filename: img.name }));
    return parts;
  }, []);

  const handleSubmit = useCallback(
    async (overrideInput?: string) => {
      if (status !== "ready") return;

      const sourceInput = overrideInput ?? input;
      const trimmedInput = sourceInput.trim();
      if (!trimmedInput) return;

      setDisplayError(null);

      const referenceSnapshot = references.map((reference) => ({ ...reference }));
      const imageSnapshot = images.map((img) => ({ ...img }));
      // D4 图片一次性：附件先落盘，消息里只存 attachment:// 引用（threads/L2/备份不再携带 base64；
      // 首轮流内真图由 transport 按需物化，落盘失败回退 dataUrl 直存保可用）
      await Promise.all(
        imageSnapshot.map(async (img) => {
          try {
            img.dataUrl = await saveImageAttachment(img.id, img.dataUrl, img.mediaType);
          } catch (e) {
            console.warn("附件落盘失败，回退 dataUrl 直存:", e);
          }
        }),
      );
      const messageParts = buildMessageParts(trimmedInput, referenceSnapshot, imageSnapshot);
      // 纯文本 + 无附件的提交不成立（只有标记占位也算空）
      if (messageParts.length === 0) return;

      if (messages.length === 0 && !currentThread) {
        try {
          const titleSource = trimmedInput || referenceSnapshot[0]?.text || "新对话";
          const thread = await createThread(activeBookId, titleSource.substring(0, 50), [], threadScope);
          setCurrentThread(thread);
          // H1：同步赋值 ref，让随后的流式落库立即能读到 thread id
          currentThreadRef.current = thread;
          console.log("Created new thread:", thread.id);
        } catch (error) {
          console.error("Failed to create thread:", error);
        }
      }

      setInput("");
      setReferences([]);
      setImages([]);

      try {
        await sendMessage({ parts: messageParts });
        setMessages((prev) => {
          if (!Array.isArray(prev) || prev.length === 0) {
            return prev;
          }

          const nextMessages = [...prev];

          for (let i = nextMessages.length - 1; i >= 0; i--) {
            const message = nextMessages[i];
            if (message?.role !== "user") {
              continue;
            }
            const existingMetadata = (message.metadata as MessageMetadata) || {};
            nextMessages[i] = {
              ...message,
              parts: messageParts,
              metadata: {
                ...existingMetadata,
                references: referenceSnapshot,
              } as MessageMetadata,
            };
            break;
          }

          messagesRef.current = nextMessages;
          return nextMessages;
        });
      } catch (error) {
        console.error("Failed to send message:", error);
      }
    },
    [
      status,
      input,
      references,
      images,
      messages,
      activeBookId,
      currentThread,
      threadScope,
      buildMessageParts,
      sendMessage,
      setMessages,
      setCurrentThread,
    ],
  );

  const handleNewThread = useCallback(() => {
    setCurrentThread(null);
    setMessages([]);
    setDisplayError(null);
    setReferences([]);
  }, [setCurrentThread, setMessages]);

  const handleShowThreads = useCallback(() => {
    if (!showThreads) {
      setThreadsKey((prev) => prev + 1);
    }
    setShowThreads(!showThreads);
  }, [showThreads]);

  const handleSelectThread = useCallback(
    async (threadSummary: ThreadSummary) => {
      try {
        const fullThread = await getThreadById(threadSummary.id);
        if (fullThread.book_id) {
          setActiveBookId(fullThread.book_id);
        }

        setCurrentThread(fullThread);
        setMessages(fullThread.messages);
        setReferences([]);
        setShowThreads(false);
        console.log("Selected thread:", fullThread.id);
      } catch (error) {
        console.error("Failed to load thread:", error);
      }
    },
    [setCurrentThread, setMessages, setActiveBookId],
  );

  const handleBackFromThreads = useCallback(() => {
    setShowThreads(false);
  }, []);

  const handleRetry = useCallback(async () => {
    if (status !== "ready" && status !== "error") return;
    const currentMessages = messagesRef.current;
    if (currentMessages.length === 0) return;

    const lastMessage = currentMessages[currentMessages.length - 1];

    setDisplayError(null);

    try {
      if (lastMessage?.role === "assistant") {
        await regenerate({ messageId: lastMessage.id });
      } else {
        await sendMessage();
      }
    } catch (retryError) {
      console.error("Retry failed:", retryError);
    }
  }, [regenerate, sendMessage, status]);

  // 「重新生成」为恒存在能力（用户 2026-08-08）：ready/error 均可重跑末条，不再依赖错误/中断条件
  const canRetry = status === "ready" || status === "error";

  return {
    // 基础状态
    input,
    setInput,
    references,

    // J2/K2
    images,
    handleRemoveImage,
    handleAddImageFiles,
    registerInputEl,
    displayError,
    showThreads,
    threadsKey,
    isInit,
    currentThread,

    // Chat 相关
    messages,
    status,
    error,
    stop,

    // 模型相关
    selectedModel,
    setSelectedModel,

    // 引用管理
    handleAskSelection,
    handleRemoveReference,

    // 消息处理
    handleSubmit,
    handleRetry,

    // 线程管理
    handleNewThread,
    handleShowThreads,
    handleSelectThread,
    handleBackFromThreads,

    // 其他
    handleReasoningTimesUpdate,
    canRetry,
  };
}
