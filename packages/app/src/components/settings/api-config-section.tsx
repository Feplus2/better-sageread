import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { isLocalEndpoint } from "@/utils/provider-url";
import SecretInput from "./secret-input";

interface ApiConfigSectionProps {
  provider: ModelProvider;
  onFieldChange: (field: string, value: any) => void;
}

export default function ApiConfigSection({ provider, onFieldChange }: ApiConfigSectionProps) {
  const providerName = provider.name;
  const isCustomProvider = provider.provider.startsWith("custom-");
  const isLocal = isLocalEndpoint(provider.baseUrl);

  return (
    <div className="space-y-4 rounded-lg bg-muted/80 p-4">
      <div className="space-y-2">
        <div>
          <Label htmlFor="apiKey" className="text-sm dark:text-neutral-200">
            API Key
          </Label>
          {provider.apiKeyHelpUrl && (
            <p className="mt-2 text-xs dark:text-neutral-400">
              {providerName} 使用 API Key 进行身份验证。前往{" "}
              <a
                href={provider.apiKeyHelpUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-500 underline dark:text-blue-400"
              >
                API Key 管理页
              </a>{" "}
              获取你的密钥。
            </p>
          )}
          {isLocal && (
            <p className="mt-2 text-neutral-500 text-xs dark:text-neutral-400">
              本地服务（Ollama / LM Studio 等）默认不需要 API Key，留空即可。
            </p>
          )}
          {!isLocal && isCustomProvider && (
            <p className="mt-2 text-neutral-500 text-xs dark:text-neutral-400">
              云端服务商请填写 API Key；使用本地 / 免鉴权服务时可留空。
            </p>
          )}
        </div>
        {/* 批次 A：key 由 OS 凭据管理器保管，不回显真值 */}
        <SecretInput
          category="model-provider"
          secretKey={provider.provider}
          id="apiKey"
          placeholder={isLocal ? "本地服务可留空" : "输入 API Key..."}
          className="h-8"
          onSaved={(value) => onFieldChange("apiKey", value)}
          onCleared={() => onFieldChange("apiKey", "")}
        />
      </div>

      <div className="space-y-2">
        <div>
          <Label htmlFor="baseUrl" className="text-sm dark:text-neutral-200">
            Base URL
          </Label>
          {provider.baseUrlHelpUrl && (
            <p className="mt-2 text-xs dark:text-neutral-400">
              接口基础地址。详见{" "}
              <a
                href={provider.baseUrlHelpUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-500 underline dark:text-blue-400"
              >
                {providerName} API 文档
              </a>{" "}
              。
            </p>
          )}
        </div>
        <Input
          id="baseUrl"
          type="text"
          className="h-8"
          value={provider?.baseUrl ?? ""}
          onChange={(e) => onFieldChange("baseUrl", e.target.value)}
          placeholder="https://api.example.com/v1"
        />
      </div>

      <div className="space-y-2">
        <Label className="text-sm dark:text-neutral-200">API 格式（协议）</Label>
        <p className="text-neutral-500 text-xs dark:text-neutral-400">
          Base URL 只决定端点；协议决定用哪一代 API。预置提供商有推荐默认值，自定义代理/中转站请按实际支持的格式选择。
        </p>
        <Select value={provider.apiStyle ?? "auto"} onValueChange={(value) => onFieldChange("apiStyle", value)}>
          <SelectTrigger className="h-8">
            <SelectValue placeholder="自动" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="auto">自动（按提供商/已知网关推断）</SelectItem>
            <SelectItem value="openai-chat">OpenAI Chat Completions</SelectItem>
            <SelectItem value="openai-responses">OpenAI Responses API</SelectItem>
            <SelectItem value="anthropic-messages">Anthropic Messages（含 DeepSeek/Kimi/智谱兼容端点）</SelectItem>
            <SelectItem value="gemini">Gemini 原生（v1beta）</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
