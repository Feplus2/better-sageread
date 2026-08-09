import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { type SearchProvider, useWebSearchStore } from "@/store/web-search-store";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ExternalLink } from "lucide-react";
import SecretInput from "./secret-input";

interface ProviderMeta {
  id: SearchProvider;
  label: string;
  desc: string;
  link?: string;
  linkLabel?: string;
  keyField?: "bochaKey" | "zhipuKey" | "tavilyKey" | "serperKey";
  placeholder?: string;
}

const PROVIDERS: ProviderMeta[] = [
  {
    id: "bocha",
    label: "博查（推荐）",
    desc: "国内 AI 搜索事实标准，DeepSeek 等 60%+ 应用采用。中文效果好，数据合规。有免费额度。",
    link: "https://open.bochaai.com",
    linkLabel: "注册获取 API Key",
    keyField: "bochaKey",
    placeholder: "sk-...",
  },
  {
    id: "zhipu",
    label: "智谱",
    desc: "智谱开放平台联网搜索，支持多引擎（基础/高阶/搜狗/夸克）。国内可靠，有免费额度。",
    link: "https://open.bigmodel.cn/apikeys",
    linkLabel: "注册获取 API Key",
    keyField: "zhipuKey",
    placeholder: "输入智谱 API Key",
  },
  {
    id: "tavily",
    label: "Tavily",
    desc: "专为 AI Agent 设计的搜索 API，英文搜索质量高。免费 1000 次/月。国外服务，多数地区可直连。",
    link: "https://app.tavily.com/sign-in",
    linkLabel: "注册获取 API Key",
    keyField: "tavilyKey",
    placeholder: "tvly-...",
  },
  {
    id: "serper",
    label: "Serper",
    desc: "封装 Google 搜索结果，免费 2500 次。国外服务，多数地区可直连。",
    link: "https://serper.dev",
    linkLabel: "注册获取 API Key",
    keyField: "serperKey",
    placeholder: "输入 Serper API Key",
  },
  {
    id: "searxng",
    label: "SearXNG（自托管）",
    desc: "开源元搜索引擎，需 Docker 自行部署。完全免费、无限制、隐私安全。",
    link: "https://docs.searxng.org/admin/installation-docker.html",
    linkLabel: "部署教程",
  },
];

export default function WebSearchSettings() {
  const {
    bochaKey,
    zhipuKey,
    tavilyKey,
    serperKey,
    searxngUrl,
    enabledProviders,
    setBochaKey,
    setZhipuKey,
    setTavilyKey,
    setSerperKey,
    setSearxngUrl,
    toggleProvider,
  } = useWebSearchStore();

  const keyValues: Record<string, string> = { bochaKey, zhipuKey, tavilyKey, serperKey };
  const keySetters: Record<string, (v: string) => void> = {
    bochaKey: setBochaKey,
    zhipuKey: setZhipuKey,
    tavilyKey: setTavilyKey,
    serperKey: setSerperKey,
  };

  return (
    <div className="space-y-6 p-4">
      <div>
        <h2 className="font-medium text-lg dark:text-neutral-100">网络搜索</h2>
        <p className="mt-1 text-neutral-500 text-sm dark:text-neutral-400">
          配置 AI 对话的联网搜索能力。填写 API Key 并启用后，即可在聊天输入框旁的搜索选择器中使用。
        </p>
      </div>

      {/* 内置引擎说明 */}
      <section className="rounded-lg border border-neutral-200 p-3 dark:border-neutral-700">
        <p className="text-neutral-500 text-xs dark:text-neutral-400">
          内置引擎（必应/百度/DuckDuckGo 爬取）始终可用，无需配置。但不稳定，可能被反爬拦截。配置以下任一 API
          服务可获得更好体验。
        </p>
      </section>

      {/* Provider 列表 */}
      <div className="space-y-3">
        {PROVIDERS.map((meta) => {
          const isEnabled = enabledProviders.includes(meta.id);
          const isSearxng = meta.id === "searxng";
          const keyValue = meta.keyField ? (keyValues[meta.keyField] ?? "") : "";
          const hasConfig = isSearxng ? searxngUrl.trim().length > 0 : keyValue.trim().length > 0;

          return (
            <section key={meta.id} className="rounded-lg bg-muted/80 p-4">
              {/* 标题行：名称 + 启用开关 */}
              <div className="flex items-center justify-between">
                <span className="font-medium text-sm dark:text-neutral-200">{meta.label}</span>
                {!hasConfig ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="inline-flex">
                        <Switch
                          checked={isEnabled}
                          onCheckedChange={() => toggleProvider(meta.id)}
                          disabled={!hasConfig}
                        />
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">请先填写配置</TooltipContent>
                  </Tooltip>
                ) : (
                  <Switch checked={isEnabled} onCheckedChange={() => toggleProvider(meta.id)} disabled={!hasConfig} />
                )}
              </div>
              <p className="mt-1.5 text-neutral-500 text-xs dark:text-neutral-400">{meta.desc}</p>

              {/* 配置输入 */}
              <div className="mt-3 space-y-2">
                {isSearxng ? (
                  <div className="space-y-1.5">
                    <Label className="text-xs">服务地址</Label>
                    <Input
                      type="text"
                      value={searxngUrl}
                      onChange={(e) => setSearxngUrl(e.target.value)}
                      placeholder="http://localhost:8080"
                      className="h-8"
                    />
                    <p className="text-neutral-500 text-xs dark:text-neutral-400">
                      需开启 JSON 输出（settings.yml 中
                      <code className="mx-1 rounded bg-background px-1 dark:bg-neutral-700">formats: [html, json]</code>
                      ）
                    </p>
                  </div>
                ) : (
                  <div className="space-y-1.5">
                    <Label className="text-xs">API Key</Label>
                    {/* 批次 A：key 由 keyring 保管，不回显真值 */}
                    <SecretInput
                      category="web-search"
                      secretKey={meta.id}
                      placeholder={meta.placeholder}
                      className="h-8"
                      onSaved={(value) => keySetters[meta.keyField!]?.(value)}
                      onCleared={() => keySetters[meta.keyField!]?.("")}
                    />
                  </div>
                )}

                {/* 注册链接 */}
                {meta.link && (
                  <button
                    type="button"
                    onClick={() => openUrl(meta.link!)}
                    className="inline-flex cursor-pointer items-center gap-1 text-primary text-xs hover:underline"
                  >
                    <ExternalLink className="size-3" />
                    {meta.linkLabel}
                  </button>
                )}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
