import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import SecretInput from "./secret-input";

interface ApiConfigSectionProps {
  provider: ModelProvider;
  onFieldChange: (field: string, value: any) => void;
}

export default function ApiConfigSection({ provider, onFieldChange }: ApiConfigSectionProps) {
  const providerName = provider.name;

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
        </div>
        {/* 批次 A：key 由 OS 凭据管理器保管，不回显真值 */}
        <SecretInput
          category="model-provider"
          secretKey={provider.provider}
          id="apiKey"
          placeholder="输入 API Key..."
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
    </div>
  );
}
