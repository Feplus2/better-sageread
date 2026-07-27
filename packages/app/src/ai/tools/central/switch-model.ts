/**
 * 全局助手工具：切换聊天模型 / 辅助模型
 *
 * 安全红线：只读取与切换「选中的模型」，apiKey/baseUrl 等敏感字段绝不进入返回内容
 */
import { useProviderStore } from "@/store/provider-store";
import { tool } from "ai";
import { z } from "zod";

interface SafeModelInfo {
  modelId: string;
  modelName: string;
}

interface SafeProviderInfo {
  providerId: string;
  providerName: string;
  active: boolean;
  models: SafeModelInfo[];
}

function toSafeProviders(): SafeProviderInfo[] {
  const { modelProviders } = useProviderStore.getState();
  return modelProviders.map((p) => ({
    providerId: p.provider,
    providerName: p.name,
    active: p.active,
    models: (p.models || []).map((m) => ({ modelId: m.id, modelName: m.name || m.id })),
  }));
}

export const switchModelTool = tool({
  description: `查看可用模型并切换当前聊天模型或辅助模型。

🎯 **核心功能**：
• action=list：列出所有模型服务商及其模型（不含密钥），以及当前选中的聊天/辅助模型
• action=set：切换模型。target=chat 切换聊天模型（对话用），target=utility 切换辅助模型（标题生成/AI 标签等轻量任务用）

📋 **前提条件**：目标服务商必须已配置且拉取过模型列表；不确定有哪些模型时先 action=list

📊 **返回内容**：
切换结果与当前选中状态`,

  inputSchema: z.object({
    reasoning: z.string().min(1).describe("调用此工具的原因"),
    action: z.enum(["list", "set"]).describe("list=查看可用模型, set=切换模型"),
    target: z.enum(["chat", "utility"]).optional().describe("set 时必填：chat=聊天模型, utility=辅助模型"),
    provider: z.string().optional().describe("服务商名称或 ID（模糊匹配，如 'openai'、' deepseek'、'智谱'）"),
    model: z.string().optional().describe("模型名称或 ID（模糊匹配，如 'gpt-4o'、'glm-4'）"),
  }),

  execute: async ({
    reasoning,
    action,
    target,
    provider,
    model,
  }: {
    reasoning: string;
    action: "list" | "set";
    target?: "chat" | "utility";
    provider?: string;
    model?: string;
  }) => {
    try {
      const store = useProviderStore.getState();

      if (action === "list") {
        return {
          results: {
            success: true,
            providers: toSafeProviders(),
            currentChatModel: store.selectedModel,
            currentUtilityModel: store.utilityModel ?? "跟随聊天模型",
          },
          meta: { reasoning },
        };
      }

      // action=set
      if (!target || !provider || !model) {
        return {
          results: { success: false, message: "切换模型需要同时提供 target、provider、model 三个参数" },
          meta: { reasoning },
        };
      }

      const pq = provider.trim().toLowerCase();
      const providerHit = store.modelProviders.find(
        (p) => p.provider.toLowerCase() === pq || p.name.toLowerCase().includes(pq),
      );
      if (!providerHit) {
        return {
          results: {
            success: false,
            message: `没有找到服务商「${provider}」。可用服务商：${store.modelProviders.map((p) => p.name).join("、")}`,
          },
          meta: { reasoning },
        };
      }
      if (!providerHit.active) {
        return {
          results: { success: false, message: `服务商「${providerHit.name}」未启用，请先在 设置 → 模型提供商 中启用` },
          meta: { reasoning },
        };
      }

      const mq = model.trim().toLowerCase();
      const modelHit = (providerHit.models || []).find(
        (m) =>
          m.id.toLowerCase() === mq || (m.name || "").toLowerCase().includes(mq) || m.id.toLowerCase().includes(mq),
      );
      if (!modelHit) {
        const available = (providerHit.models || []).map((m) => m.name || m.id).join("、");
        return {
          results: {
            success: false,
            message:
              (providerHit.models || []).length === 0
                ? `服务商「${providerHit.name}」还没有拉取模型列表，请先在 设置 → 模型提供商 中刷新模型`
                : `服务商「${providerHit.name}」下没有找到模型「${model}」。可用：${available}`,
          },
          meta: { reasoning },
        };
      }

      const selected = {
        modelId: modelHit.id,
        providerId: providerHit.provider,
        providerName: providerHit.name,
        modelName: modelHit.name || modelHit.id,
      };
      if (target === "chat") {
        store.setSelectedModel(selected);
      } else {
        store.setUtilityModel(selected);
      }

      return {
        results: {
          success: true,
          message: `已将${target === "chat" ? "聊天模型" : "辅助模型"}切换为 ${providerHit.name} / ${modelHit.name || modelHit.id}`,
          currentChatModel: useProviderStore.getState().selectedModel,
          currentUtilityModel: useProviderStore.getState().utilityModel ?? "跟随聊天模型",
        },
        meta: { reasoning },
      };
    } catch (error) {
      throw new Error(`切换模型失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  },
});
