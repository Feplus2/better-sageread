import { buildPrompt } from "@/constants/prompt";
import type { ChatContext } from "@/hooks/use-chat-state";
import { compressDroppedIntoSummary } from "@/services/conversation-summary-service";
import { getLiveReadingPosition } from "@/services/reading-position/live-position";
import {
  formatFallbackPosition,
  formatPositionForPrompt,
  resolveLiveReadingPosition,
} from "@/services/reading-position/position-service";
import { buildTimestampLookup, composeDynamicTail, withMessageTimestamps } from "@/services/time-awareness";
import { useChatSettingsStore } from "@/store/chat-settings-store";
import { wrapToolsForNativeImages } from "./providers/native-tool-output";
import { resolveProviderProtocol, supportsNativeToolImages } from "./providers/protocol";
import { useProviderStore } from "@/store/provider-store";
import type { UIMessage } from "@ai-sdk/react";
import {
  type ChatRequestOptions,
  type ChatTransport,
  type LanguageModel,
  type PrepareSendMessagesRequest,
  type Tool,
  type UIMessageChunk,
  convertToModelMessages,
  isStepCount,
  streamText,
} from "ai";
import { toast } from "sonner";
import { getMcpToolsForScope } from "./mcp/mcp-manager";
import { chatReasoningProviderOptions } from "./providers/reasoning-map";
import { modelSupportsVision } from "./providers/vision-map";
import { buildLazyToolset, buildToolDirectoryBoard, shouldUseDirectoryMode } from "./tools/lazy-toolset";
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
 * D3 动态状态段：每轮可能变化的【当前阅读位置】统一放 system prompt 尾部动态区
 * （其后的最末尾是每轮必变的【当前时间】，见 services/time-awareness），
 * 保证其前面的全部注入段（基词/工具/目录/工作区/记忆）前缀稳定，最大化提示缓存命中。
 *
 * 2026-10-20 阅读位置桥改造（用户拍板）：
 * - 书籍与论文统一注入"精确坐标"（mdbook 文件 + 字符偏移 + 估算分块区间 + 进度），
 *   位置来自活位置注册表（渲染层实时写入），以本轮为准；目录不可用时按 spine 兜底；
 * - 不再注入论文当前小节正文（目录崩坏时会退化成整篇灌入；改为模型按需调用
 *   readAtReadingPosition 扩窗读取）；
 * - 坐标换算失败时降级为章节/小节名，不阻塞聊天。
 */
async function buildDynamicStateSection(chatContext: ChatContext | undefined): Promise<string> {
  const agentScope = chatContext?.agentScope ?? "reader";
  const docId = chatContext?.activeBookId;
  if (!docId) return "";

  if (agentScope === "reader") {
    // 分支调用而非传联合 scope：getLiveReadingPosition/resolveLiveReadingPosition 的重载按 scope 收窄
    const snapshot = await resolveLiveReadingPosition("reader", docId);
    if (snapshot) return formatPositionForPrompt(snapshot);
    // 坐标暂不可用：至少给出章节/小节名（并在文案里声明历史位置可能过时）
    return formatFallbackPosition(getLiveReadingPosition("reader", docId));
  }
  if (agentScope === "paper") {
    const snapshot = await resolveLiveReadingPosition("paper", docId);
    if (snapshot) return formatPositionForPrompt(snapshot);
    return formatFallbackPosition(getLiveReadingPosition("paper", docId));
  }
  return "";
}
export class CustomChatTransport implements ChatTransport<UIMessage> {
  private model: LanguageModel | null;
  private prepareSendMessagesRequest?: PrepareSendMessagesRequest<UIMessage>;

  constructor(
    model: LanguageModel | null,
    options?: {
      prepareSendMessagesRequest?: PrepareSendMessagesRequest<UIMessage>;
      /** 面板的 agent scope：body 未携带 chatContext 时按此从活注册表兜底（G 修复） */
      scopeHint?: string;
    },
  ) {
    this.model = model;
    this.prepareSendMessagesRequest = options?.prepareSendMessagesRequest;
    this.scopeHint = options?.scopeHint;
  }
  private scopeHint?: string;

  updateModel(model: LanguageModel | null) {
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
    // 未配置/未启用模型时直接给引导提示（原先兜底字符串 "deepseek-chat" 会被 AI SDK v7
    // 路由到默认 provider —— Vercel AI Gateway，报出与用户配置完全无关的网关错误）
    const model = this.model;
    if (model == null) {
      throw new Error("还没有可用模型：请先到 设置 → 模型提供商 填写 API Key 并启用一个模型，选中后再发送消息");
    }
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

    let chatContext = (requestBody as any)?.chatContext as ChatContext | undefined;
    if (!chatContext) {
      // 活注册表兜底：body 未带（prepare 链任何一环断裂）时按 scopeHint 读最新快照
      const { getLiveChatContext } = await import("./utils/live-chat-context");
      chatContext = getLiveChatContext(this.scopeHint);
    }
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
        summaryText = await compressDroppedIntoSummary({ threadId: chatContext.threadId, dropped, agentScope });
      }
      console.log("🗜️ [上下文预算] 裁剪历史消息:", {
        droppedCount: dropped.length,
        keptCount: selectedMessages.length,
        hasSummary: !!summaryText,
      });
    }

    // 根据 Agent 角色动态组装工具集（paper scope 时 activeBookId 即论文 id；retrievalScope 为用户划定的检索范围，
    // paperScopeIds 仅作旧版 paperSearch 的映射）
    // 批次 B3/D：并入当前 scope 启用的 MCP server 工具（连接失败逐个提示，不阻塞本条消息）
    const mcp = await getMcpToolsForScope(agentScope);
    for (const failure of mcp.failures) {
      toast.warning(`MCP 服务器「${failure.server}」连接失败：${failure.error}，已跳过`);
    }

    // P1：包装安全守卫——写/执行/外发类工具按安全模式弹确认卡（界外判定在 Rust 侧；mcp_ 前缀工具同样受门控）
    const guardedTools = wrapToolsWithGuard(
      {
        ...getToolsForScope(agentScope, {
          bookId: activeBookId,
          paperId: activeBookId,
          retrievalScope: chatContext?.retrievalScope,
          paperScopeIds: chatContext?.paperScopeIds,
          threadId: chatContext?.threadId,
        }),
        ...mcp.tools,
      },
      agentScope,
    );

    // D8 目录牌模式（预算守门：工具池 >30 个或 schema >12k 字符自动启用）：
    // 请求工具面换 describeTool/useTool 惰性入口，真实工具（含守卫包装）经 useTool 转发执行；
    // 目录牌文本进 system 静态区（随 scope/连接器集稳定，缓存友好）。
    // P1-4：new 模式强制轻量目录牌（只发名字+一句话），把每步 ~2.4k token 的完整 schema 换成一个 describeTool 调用
    const { getDocumentToolMode } = await import("./tools/document/mode");
    const forceDirectoryForNewMode = agentScope !== "central" && getDocumentToolMode() === "new";
    const debugDisableDirectory =
      (globalThis as { __SAGEREAD_DISABLE_DIRECTORY__?: boolean }).__SAGEREAD_DISABLE_DIRECTORY__ === true;
    const directoryMode = debugDisableDirectory
      ? false
      : forceDirectoryForNewMode || shouldUseDirectoryMode(guardedTools);
    const tools: Record<string, Tool> = directoryMode ? buildLazyToolset(guardedTools) : guardedTools;

    // 协议现代化（2026-10-22）：原生 provider 的工具结果可以按官方格式回传图片；
    // chat 通道继续走 fetch 层图片桥（factory 已按协议挂桥）。
    const selectedProvider = sel
      ? useProviderStore.getState().modelProviders.find((provider) => provider.provider === sel.providerId)
      : undefined;
    const providerProtocol = sel
      ? resolveProviderProtocol({
          providerId: sel.providerId,
          baseUrl: selectedProvider?.baseUrl,
          modelId: sel.modelId,
        })
      : "chat";
    const toolsForModel = supportsNativeToolImages(providerProtocol)
      ? wrapToolsForNativeImages(tools)
      : tools;

    // MCP 连接生命周期跟随本次请求：流结束或用户中止时关闭（closeAll 幂等，双保险）
    options.abortSignal?.addEventListener("abort", () => void mcp.closeAll(), { once: true });

    // sanitizeMessageParts：中断残留的 undefined text part 归一（否则 convert 后 zod 校验报 Invalid prompt）
    // v6 起 convertToModelMessages 为异步（v3 规范），必须 await
    const modelInputMessages = stripUnknownToolParts(sanitizeMessageParts(selectedMessages), toolsForModel);
    const convertedMessages = await convertToModelMessages(modelInputMessages, {
      tools: toolsForModel,
      ignoreIncompleteToolCalls: true,
    });

    // 时间感知（2026-10-20）：历史 user/assistant 消息内容前缀 [YYYY-MM-DD HH:mm]（写死、无相对时间，
    // 保证同一对话历史逐字节稳定）；只给有 metadata.createdAt 的消息加，缺时间的绝不猜测，
    // 仅本轮新发的末条 user 消息用发送时刻兜底（下一轮该前缀消失，一次性变化，可接受）。
    const timestampedMessages = withMessageTimestamps(
      convertedMessages,
      buildTimestampLookup(modelInputMessages, convertedMessages, { now: Date.now() }),
    );

    // D3 静态优先布局：buildPrompt（基词+静态段+技能+metadata，按书稳定）在前，
    // 工作区/记忆段（准静态）居中，前情摘要（稀有）次之，每轮可能变化的动态状态殿后。
    const dynamicSection = await buildDynamicStateSection(chatContext);
    // 动态段顺序：前情摘要（稀有）→【当前阅读位置】（翻页变）→【当前时间】（每轮必变）。
    // 当前时间必须压在 system prompt 最尾部：这样它前面的所有段（含阅读位置）保持逐字节稳定，
    // 每轮只击穿这一段，前缀缓存命中最大化；位置段为空/降级时也仍要注入当前时间。
    const dynamicTail = composeDynamicTail(dynamicSection);
    const directoryBoard = directoryMode ? `\n\n${buildToolDirectoryBoard(guardedTools)}` : "";
    const systemPrompt =
      (await buildPrompt(chatContext)) +
      directoryBoard +
      // 工作区根 + 文件即记忆（memory.md）：三 scope 统一在此注入，按 scope 解析生效根
      (await loadWorkspaceSection(agentScope)) +
      (await loadMemorySection(agentScope)) +
      // 前情摘要变化频率低（触发压缩才换），放在动态段之前，避免翻页/时间更新时被连带击穿
      (summaryText ? `\n\n【前情摘要】\n${summaryText}\n（以上为早期对话的压缩摘要，非原始记录）` : "") +
      (dynamicTail ? `\n\n${dynamicTail}` : "");

    // P3 思考强度档位：AI SDK 原生参数族（openai/google/openrouter/grok）在此下发；
    // DeepSeek/GLM/Qwen/Kimi 等自定义端点由 factory 的动态 fetch 包装打请求体补丁
    const reasoningLevel = useChatSettingsStore.getState().reasoningLevel;
    const providerOptions = sel ? chatReasoningProviderOptions(sel.providerId, sel.modelId, reasoningLevel) : undefined;

    // P0 可靠性：步数预算临近上限时强制收口，避免 20 步截断导致空答案（G1 跨文献 rep1）
    const STEP_LIMIT = 20;
    const FORCE_FINAL_ANSWER_AT = STEP_LIMIT - 2;
    const forcedFinalInstructions = `${systemPrompt}\n\n【步骤预算】已接近本轮工具调用上限，不要再调用任何工具；请立即基于已获得的信息给出最终答案，并明确说明还有哪些信息没拿到。`;
    const result = streamText({
      model,
      messages: timestampedMessages,
      abortSignal: options.abortSignal,
      toolChoice: "auto",
      stopWhen: isStepCount(STEP_LIMIT),
      tools: toolsForModel,
      prepareStep: ({ stepNumber }) =>
        stepNumber >= FORCE_FINAL_ANSWER_AT
          ? { toolChoice: "none" as const, instructions: forcedFinalInstructions }
          : undefined,
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
