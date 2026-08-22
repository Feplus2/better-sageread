import { buildPrompt } from "@/constants/prompt";
import type { ChatContext } from "@/hooks/use-chat-state";
import { compressDroppedIntoSummary } from "@/services/conversation-summary-service";
import { useChatSettingsStore } from "@/store/chat-settings-store";
import { useProviderStore } from "@/store/provider-store";
import type { UIMessage } from "@ai-sdk/react";
import {
  type ChatRequestOptions,
  type ChatTransport,
  type LanguageModel,
  type PrepareSendMessagesRequest,
  type UIMessageChunk,
  convertToModelMessages,
  isStepCount,
  streamText,
} from "ai";
import { toast } from "sonner";
import { getMcpToolsForScope } from "./mcp/mcp-manager";
import { chatReasoningProviderOptions } from "./providers/reasoning-map";
import { modelSupportsVision } from "./providers/vision-map";
import { getToolsForScope } from "./tools/registry";
import {
  loadMemorySection,
  loadWorkspaceSection,
  processQuoteMessages,
  resolveImageAttachmentsForRequest,
  sanitizeMessageParts,
  selectMessagesWithinBudget,
  stripFileParts,
  stripUnknownToolParts,
} from "./utils";
import { repairImageDataUrl, sniffImageMediaType } from "./utils/media-sniff";
import { wrapToolsWithGuard } from "./utils/tool-guard";
import { compactAgedRagResults } from "./utils/tool-result-slimming";

/**
 * D3 动态状态段：每轮可能变化的位置信息（阅读章节/论文小节）统一放 system prompt 最尾部，
 * 保证其前面的全部注入段（基词/工具/目录/工作区/记忆）前缀稳定，最大化提示缓存命中。
 * 论文小节正文（chatContext.activeContext，页面按 heading 规则提取）属动态内容，同样后置。
 */
function buildDynamicStateSection(chatContext: ChatContext | undefined): string {
  const agentScope = chatContext?.agentScope ?? "reader";
  if (agentScope === "paper") {
    const label = chatContext?.activeSectionLabel?.trim();
    const body = chatContext?.activeContext?.trim();
    const parts: string[] = [];
    if (label) parts.push(`【当前阅读小节】\n${label}`);
    if (body) parts.push(`【当前小节正文】\n${body}`);
    return parts.join("\n\n");
  }
  if (agentScope === "reader") {
    const label = chatContext?.activeSectionLabel?.trim();
    if (label) return `【当前阅读章节】\n${label}`;
  }
  return "";
}

export class CustomChatTransport implements ChatTransport<UIMessage> {
  private model: LanguageModel;
  private prepareSendMessagesRequest?: PrepareSendMessagesRequest<UIMessage>;

  constructor(
    model: LanguageModel,
    options?: {
      prepareSendMessagesRequest?: PrepareSendMessagesRequest<UIMessage>;
    },
  ) {
    this.model = model;
    this.prepareSendMessagesRequest = options?.prepareSendMessagesRequest;
  }

  updateModel(model: LanguageModel) {
    this.model = model;
  }

  async sendMessages(
    options: {
      chatId: string;
      messages: UIMessage[];
      abortSignal: AbortSignal | undefined;
    } & {
      trigger: "submit-message" | "regenerate-message";
      messageId: string | undefined;
    } & ChatRequestOptions,
  ): Promise<ReadableStream<UIMessageChunk>> {
    let requestBody = options.body;

    if (this.prepareSendMessagesRequest) {
      const prepared = await this.prepareSendMessagesRequest({
        id: options.chatId,
        messages: options.messages,
        requestMetadata: options.metadata,
        body: options.body as Record<string, any> | undefined,
        credentials: undefined,
        headers: options.headers,
        api: "",
        trigger: options.trigger,
        messageId: options.messageId,
      });

      requestBody = prepared.body;
    }

    const chatContext = (requestBody as any)?.chatContext as ChatContext | undefined;
    const activeBookId = chatContext?.activeBookId;
    const agentScope = chatContext?.agentScope ?? "reader";

    const sel = useProviderStore.getState().selectedModel;

    // J2：当前模型不支持多模态时，剔除全部 file part（含历史图片）——
    // 纯文本模型只是看不到图，绝不因图片内容报 API 错误
    const visionOk = !sel || modelSupportsVision(sel.providerId, sel.modelId);
    let messagesForProcess = visionOk ? options.messages : stripFileParts(options.messages);

    // J2 补环：存量 file part 的 mediaType 可能是 text/plain（早期 blob.type 错误落库），
    // 按 base64 魔数嗅探修正 mediaType 字段与 dataUrl MIME 前缀（部分提供商按 URL 头判类型）
    if (visionOk) {
      messagesForProcess = messagesForProcess.map((message) => {
        if (!Array.isArray(message.parts)) return message;
        let touched = false;
        const parts = (message.parts as any[]).map((part: any) => {
          if (part?.type !== "file" || typeof part.url !== "string") return part;
          if (
            typeof part.mediaType === "string" &&
            part.mediaType.startsWith("image/") &&
            part.url.startsWith(`data:${part.mediaType}`)
          ) {
            return part;
          }
          const sniffed = sniffImageMediaType(part.url);
          if (!sniffed) return part;
          touched = true;
          return { ...part, mediaType: sniffed, url: repairImageDataUrl(part.url) };
        });
        return touched ? ({ ...message, parts } as typeof message) : message;
      });
    }

    const processedMessages = processQuoteMessages(await resolveImageAttachmentsForRequest(messagesForProcess));
    // token 双水位活塞：≤点火线(256k)零压缩；超过则泄压到 128k 以内，最近 10 条永不压缩
    const { kept: budgetedMessages, dropped } = selectMessagesWithinBudget(processedMessages);
    // D5 L2 存根活塞：十进位轮次块批处理降级老轮次 RAG 结果（引用位冻结 + clear_at_least）；
    // 置于水位活塞之后——已被泄压丢弃的消息无需再处理
    const selectedMessages = compactAgedRagResults(budgetedMessages);

    // 超预算裁掉的旧消息：滚动压缩为摘要（按对话持久化到 thread.metadata），注入 system prompt
    let summaryText: string | null = null;
    if (dropped.length > 0) {
      if (chatContext?.threadId) {
        summaryText = await compressDroppedIntoSummary({ threadId: chatContext.threadId, dropped });
      }
      console.log("🗜️ [上下文预算] 裁剪历史消息:", {
        droppedCount: dropped.length,
        keptCount: selectedMessages.length,
        hasSummary: !!summaryText,
      });
    }

    // 根据 Agent 角色动态组装工具集（paper scope 时 activeBookId 即论文 id，paperScopeIds 为检索范围）
    // 批次 B3/D：并入当前 scope 启用的 MCP server 工具（连接失败逐个提示，不阻塞本条消息）
    const mcp = await getMcpToolsForScope(agentScope);
    for (const failure of mcp.failures) {
      toast.warning(`MCP 服务器「${failure.server}」连接失败：${failure.error}，已跳过`);
    }

    // P1：包装安全守卫——写/执行/外发类工具按安全模式弹确认卡（界外判定在 Rust 侧；mcp_ 前缀工具同样受门控）
    const tools = wrapToolsWithGuard(
      {
        ...getToolsForScope(agentScope, {
          bookId: activeBookId,
          paperId: activeBookId,
          paperScopeIds: chatContext?.paperScopeIds,
        }),
        ...mcp.tools,
      },
      agentScope,
    );

    // MCP 连接生命周期跟随本次请求：流结束或用户中止时关闭（closeAll 幂等，双保险）
    options.abortSignal?.addEventListener("abort", () => void mcp.closeAll(), { once: true });

    // sanitizeMessageParts：中断残留的 undefined text part 归一（否则 convert 后 zod 校验报 Invalid prompt）
    // v6 起 convertToModelMessages 为异步（v3 规范），必须 await
    const convertedMessages = await convertToModelMessages(
      stripUnknownToolParts(sanitizeMessageParts(selectedMessages), tools),
      {
        tools,
        ignoreIncompleteToolCalls: true,
      },
    );

    // D3 静态优先布局：buildPrompt（基词+静态段+技能+metadata，按书稳定）在前，
    // 工作区/记忆段（准静态）居中，每轮可能变化的动态状态殿后，最后是罕见的前情摘要。
    const dynamicSection = buildDynamicStateSection(chatContext);
    const systemPrompt =
      (await buildPrompt(chatContext)) +
      // 工作区根 + 文件即记忆（memory.md）：三 scope 统一在此注入，按 scope 解析生效根
      (await loadWorkspaceSection(agentScope)) +
      (await loadMemorySection(agentScope)) +
      (dynamicSection ? `\n\n${dynamicSection}` : "") +
      (summaryText ? `\n\n【前情摘要】\n${summaryText}\n（以上为早期对话的压缩摘要，非原始记录）` : "");

    // P3 思考强度档位：AI SDK 原生参数族（openai/google/openrouter/grok）在此下发；
    // DeepSeek/GLM/Qwen/Kimi 等自定义端点由 factory 的动态 fetch 包装打请求体补丁
    const reasoningLevel = useChatSettingsStore.getState().reasoningLevel;
    const providerOptions = sel ? chatReasoningProviderOptions(sel.providerId, sel.modelId, reasoningLevel) : undefined;

    const result = streamText({
      model: this.model,
      messages: convertedMessages,
      abortSignal: options.abortSignal,
      toolChoice: "auto",
      stopWhen: isStepCount(20),
      tools,
      // v7：system 更名 instructions（语义不变，逐字节兼容缓存）
      instructions: systemPrompt,
      onEnd: () => {
        void mcp.closeAll();
      },
      // v7 providerOptions 要求 JSON 兼容值；档位映射产物即 JSON（string/number）
      ...(providerOptions ? { providerOptions: providerOptions as Record<string, any> } : {}),
    });

    return result.toUIMessageStream({
      onError: (error) => {
        console.log("error", error);
        if (error == null) {
          return "Unknown error";
        }
        if (typeof error === "string") {
          return error;
        }
        if (error instanceof Error) {
          return error.message;
        }
        return JSON.stringify(error);
      },
      messageMetadata: ({ part }) => {
        if (part.type === "finish") {
          // UI 流 finish part 的字段仍为 totalUsage（v7 弃用的是 LanguageModelUsage 层的用法）
          return {
            totalUsage: part.totalUsage,
          };
        }
      },
    });
  }

  async reconnectToStream(
    _options: {
      chatId: string;
    } & ChatRequestOptions,
  ): Promise<ReadableStream<UIMessageChunk> | null> {
    return null;
  }
}
