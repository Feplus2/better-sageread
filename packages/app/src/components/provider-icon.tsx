import {
  AlibabaCloud,
  Anthropic,
  ChatGLM,
  DeepSeek,
  Doubao,
  Gemini,
  Grok,
  LMStudio,
  MiniMax,
  Moonshot,
  Ollama,
  OpenAI,
  OpenRouter,
  StepFun,
  TencentCloud,
  XiaomiMiMo,
} from "@/components/icons";
import { isLMStudioEndpoint, isOllamaEndpoint } from "@/utils/provider-url";
import { Server } from "lucide-react";

interface ProviderIconProps {
  providerId: string;
  /** 自定义 provider 需要传入对象，用于按名称/端点识别 Ollama / LM Studio 等品牌图标 */
  provider?: ModelProvider;
  className?: string;
}

/**
 * 提供商图标：预置厂商走品牌 SVG；自定义 provider 按 icon 字段 / 名称 / 默认端口
 * 识别 Ollama、LM Studio，识别不出的回退服务器图标（避免下拉框里出现"没有图标"）。
 */
export function ProviderIcon({ providerId, provider, className = "h-4 w-4" }: ProviderIconProps): React.ReactNode {
  switch (providerId) {
    case "openai":
      return <OpenAI className={className} />;
    case "anthropic":
      return <Anthropic className={className} />;
    case "openrouter":
      return <OpenRouter className={className} />;
    case "gemini":
      return <Gemini className={className} />;
    case "grok":
      return <Grok className={className} />;
    case "deepseek":
      return <DeepSeek className={className} />;
    case "zhipu":
      return <ChatGLM className={className} />;
    case "kimi":
      return <Moonshot className={className} />;
    case "minimax":
      return <MiniMax className={className} />;
    case "stepfun":
      return <StepFun className={className} />;
    case "tencent":
      return <TencentCloud className={className} />;
    case "xiaomi":
      return <XiaomiMiMo className={className} />;
    case "qwen":
      // 阿里云百炼（DashScope OpenAI 兼容端点）→ 阿里云平台图标
      return <AlibabaCloud className={className} />;
    case "ollama":
      return <Ollama className={className} />;
    case "lmstudio":
      return <LMStudio className={className} />;
    case "doubao":
      return <Doubao className={className} />;
    default:
      if (provider?.icon === "ollama" || isOllamaEndpoint(provider?.baseUrl) || /ollama/i.test(provider?.name ?? "")) {
        return <Ollama className={className} />;
      }
      if (
        provider?.icon === "lmstudio" ||
        isLMStudioEndpoint(provider?.baseUrl) ||
        /lm\s*studio/i.test(provider?.name ?? "")
      ) {
        return <LMStudio className={className} />;
      }
      return <Server className={className} />;
  }
}
