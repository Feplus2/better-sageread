import ModelSelector from "@/components/side-chat/model-selector";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { useProviderStore } from "@/store/provider-store";
import { Plus, Settings } from "lucide-react";
import { toast } from "sonner";
import { ProviderIcons } from "./settings-dialog";

interface ProvidersSettingsProps {
  onProviderSelect?: (providerId: string) => void;
}

export default function ProvidersSettings({ onProviderSelect }: ProvidersSettingsProps) {
  const { modelProviders, utilityModel, setModelProviders, setUtilityModel, addProvider } = useProviderStore();

  const toggleProviderEnabled = (providerId: string) => {
    const provider = modelProviders.find((p) => p.provider === providerId);
    if (!provider) return;
    // 无 API key 时禁止开启
    if (!provider.active && !provider.apiKey?.trim()) {
      toast.info("请先填写 API Key", { description: `进入「${provider.name}」设置页配置 API Key 后再启用` });
      onProviderSelect?.(providerId);
      return;
    }
    const updatedProviders = modelProviders.map((p) => (p.provider === providerId ? { ...p, active: !p.active } : p));
    setModelProviders(updatedProviders);
  };

  const handleAddProvider = () => {
    const newProviderId = addProvider();
    onProviderSelect?.(newProviderId);
  };

  return (
    <div className="space-y-4 p-4 pt-3">
      <div className="rounded-lg bg-muted/80 p-4">
        <h2 className="text mb-4 dark:text-neutral-200">辅助模型</h2>
        <div className="flex items-start justify-between gap-4">
          <p className="mt-1 text-neutral-600 text-xs dark:text-neutral-400">
            用于生成对话标题、AI 标签、前情摘要压缩、PDF 转换等轻量任务，推荐选择便宜快速的模型；留空则跟随当前聊天模型
          </p>
          <div className="flex flex-shrink-0 items-center gap-2">
            <ModelSelector
              selectedModel={utilityModel}
              onModelSelect={(model) => setUtilityModel(model)}
              placeholder="跟随聊天模型"
              className="w-48"
            />
            {utilityModel && (
              <Button variant="ghost" size="sm" onClick={() => setUtilityModel(null)}>
                清除
              </Button>
            )}
          </div>
        </div>
      </div>

      <div className="rounded-lg bg-muted/80 p-4">
        <div className="flex items-center justify-between border-b pb-4">
          <h2 className="text dark:text-neutral-200">模型提供商</h2>
          <Button variant="soft" size="sm" onClick={handleAddProvider}>
            <Plus className="h-4 w-4" />
            添加提供商
          </Button>
        </div>

        <div className="space-y-2">
          {modelProviders.map((provider, index) => {
            const providerName = provider.name;
            const modelCount = provider.models.length;

            return (
              <div key={provider.provider} className={cn("pt-2", index === 0 ? "" : "border-t")}>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <ProviderIcons providerId={provider.provider} />
                    <div>
                      <span className="text-sm dark:text-neutral-200">{providerName}</span>
                      <p className="text-gray-600 text-xs dark:text-neutral-400">
                        {modelCount === 1 ? "个模型" : `${modelCount} 个模型`}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-7"
                      onClick={() => onProviderSelect?.(provider.provider)}
                    >
                      <Settings className="size-4" />
                    </Button>
                    <div
                      onClick={() => {
                        if (!provider.active && !provider.apiKey?.trim()) {
                          toast.info("请先填写 API Key", {
                            description: `进入「${provider.name}」设置页配置 API Key 后再启用`,
                          });
                          onProviderSelect?.(provider.provider);
                        }
                      }}
                    >
                      <Switch
                        checked={provider.active}
                        disabled={!provider.active && !provider.apiKey?.trim()}
                        className={!provider.active && !provider.apiKey?.trim() ? "pointer-events-none" : undefined}
                        onCheckedChange={() => toggleProviderEnabled(provider.provider)}
                      />
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
