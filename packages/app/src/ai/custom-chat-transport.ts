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
  stepCountIs,
  streamText,
} from "ai";
import { chatReasoningProviderOptions } from "./providers/reasoning-map";
import { getToolsForScope } from "./tools/registry";
import {
  loadMemorySection,
  loadWorkspaceSection,
  processQuoteMessages,
  selectMessagesWithinBudget,
  stripUnknownToolParts,
} from "./utils";
import { wrapToolsWithGuard } from "./utils/tool-guard";

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

    const processedMessages = processQuoteMessages(options.messages);
    // token 预算制选择（256k 预算 + 40 条保底），替代原固定 8 条硬截断
    const { kept: selectedMessages, dropped } = selectMessagesWithinBudget(processedMessages);

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
    // P1：包装安全守卫——写/执行/外发类工具按安全模式弹确认卡（界外判定在 Rust 侧）
    const tools = wrapToolsWithGuard(
      getToolsForScope(agentScope, {
        bookId: activeBookId,
        paperId: activeBookId,
        paperScopeIds: chatContext?.paperScopeIds,
      }),
      agentScope,
    );

    const convertedMessages = convertToModelMessages(stripUnknownToolParts(selectedMessages, tools), {
      tools,
      ignoreIncompleteToolCalls: true,
    });

    const systemPrompt =
      (await buildPrompt(chatContext)) +
      // 工作区根 + 文件即记忆（memory.md）：三 scope 统一在此注入，按 scope 解析生效根
      (await loadWorkspaceSection(agentScope)) +
      (await loadMemorySection(agentScope)) +
      (summaryText ? `\n\n【前情摘要】\n${summaryText}\n（以上为早期对话的压缩摘要，非原始记录）` : "");

    // P3 思考强度档位：AI SDK 原生参数族（openai/google/openrouter/grok）在此下发；
    // DeepSeek/GLM/Qwen/Kimi 等自定义端点由 factory 的动态 fetch 包装打请求体补丁
    const sel = useProviderStore.getState().selectedModel;
    const reasoningLevel = useChatSettingsStore.getState().reasoningLevel;
    const providerOptions = sel ? chatReasoningProviderOptions(sel.providerId, sel.modelId, reasoningLevel) : undefined;

    const result = streamText({
      model: this.model,
      messages: convertedMessages,
      abortSignal: options.abortSignal,
      toolChoice: "auto",
      stopWhen: stepCountIs(20),
      tools,
      system: systemPrompt,
      ...(providerOptions ? { providerOptions } : {}),
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
