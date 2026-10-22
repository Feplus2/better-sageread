import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { isLocalEndpoint } from "@/utils/provider-url";
import {
  buildRequestPathPreview,
  findCurrentEndpoint,
  getEndpointOptions,
  getPresetDefaultEndpoint,
  nativeImageHint,
} from "@/utils/provider-endpoint";
import SecretInput from "./secret-input";

interface ApiConfigSectionProps {
  provider: ModelProvider;
  onFieldChange: (field: string, value: any) => void;
}

export default function ApiConfigSection({ provider, onFieldChange }: ApiConfigSectionProps) {
  const providerName = provider.name;
  const isCustomProvider = provider.provider.startsWith("custom-");
  const isLocal = isLocalEndpoint(provider.baseUrl);
  const endpointOptions = getEndpointOptions(provider);
  const currentEndpoint = findCurrentEndpoint(provider);
  const hasPresetEndpoints = endpointOptions.length > 0;
  const preview = buildRequestPathPreview(provider.baseUrl, provider.apiStyle ?? "auto");
  // 预置 provider 只列出它确实预填了地址的协议，避免选到 factory 不支持的组合；
  // 自定义 provider 无预置端点时仍给出全部协议（用户自建代理可能支持任意格式）
  const allowedProtocols = hasPresetEndpoints ? new Set(endpointOptions.map((option) => option.protocol)) : null;
  const protocolItems: Array<{ value: string; label: string }> = [
    { value: "auto", label: "自动（按提供商/已知网关推断）" },
    { value: "openai-chat", label: "OpenAI Chat Completions" },
    { value: "openai-responses", label: "OpenAI Responses API" },
    { value: "anthropic-messages", label: "Anthropic Messages（含兼容端点）" },
    { value: "gemini", label: "Gemini 原生（v1beta）" },
  ].filter((item) => !allowedProtocols || item.value === "auto" || allowedProtocols.has(item.value as ChatProtocol));
  // 预置端点命中时不再让用户选协议（端点即协议）；手改地址/自定义 provider 才显示协议选择
  const showProtocolSelect = !hasPresetEndpoints || !currentEndpoint;

  const applyEndpoint = (protocol: ChatProtocol) => {
    const option = endpointOptions.find((item) => item.protocol === protocol);
    if (!option) return;
    onFieldChange("apiStyle", option.protocol);
    onFieldChange("baseUrl", option.baseUrl);
  };

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

      {hasPresetEndpoints && (
        <div className="space-y-2">
          <Label className="text-sm dark:text-neutral-200">接口端点</Label>
          <p className="text-neutral-500 text-xs dark:text-neutral-400">
            地址已按 {providerName} 的官方端点预填好，通常只需填写 API Key；改用代理或其它协议时再切换。
          </p>
          <Select
            value={currentEndpoint?.protocol ?? "custom"}
            onValueChange={(value) => value !== "custom" && applyEndpoint(value as ChatProtocol)}
          >
            <SelectTrigger className="h-8">
              <SelectValue placeholder="选择端点" />
            </SelectTrigger>
            <SelectContent>
              {endpointOptions.map((option) => (
                <SelectItem key={option.protocol} value={option.protocol}>
                  {option.label}
                  {option.isDefault ? "（推荐）" : ""}
                </SelectItem>
              ))}
              {/* 手动改过 Base URL 后显示为"自定义"状态（不可选；切回预置用下方"恢复预置端点"） */}
              <SelectItem value="custom" disabled>
                自定义（手动填写）
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
      )}

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
        {preview && (
          <p className="break-all font-mono text-neutral-500 text-xs dark:text-neutral-400">请求路径：{preview}</p>
        )}
      </div>

      {showProtocolSelect && (
        <div className="space-y-2">
          <Label className="text-sm dark:text-neutral-200">API 格式（协议）</Label>
          <p className="text-neutral-500 text-xs dark:text-neutral-400">
            Base URL 只决定端点；协议决定用哪一代 API。自定义代理/中转站请按实际支持的格式选择。
          </p>
          <Select value={provider.apiStyle ?? "auto"} onValueChange={(value) => onFieldChange("apiStyle", value)}>
            <SelectTrigger className="h-8">
              <SelectValue placeholder="自动" />
            </SelectTrigger>
            <SelectContent>
              {protocolItems.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {nativeImageHint(provider.apiStyle ?? "auto") && (
            <p className="text-neutral-500 text-xs dark:text-neutral-400">
              {nativeImageHint(provider.apiStyle ?? "auto")}
            </p>
          )}
        </div>
      )}

      {hasPresetEndpoints && !currentEndpoint && (
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs"
          onClick={() => {
            const option = getPresetDefaultEndpoint(provider);
            if (option) {
              onFieldChange("apiStyle", option.protocol);
              onFieldChange("baseUrl", option.baseUrl);
            }
          }}
        >
          恢复预置端点
        </Button>
      )}
    </div>
  );
}
