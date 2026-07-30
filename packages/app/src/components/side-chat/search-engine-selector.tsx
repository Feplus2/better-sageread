import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { type SearchEngine, type SearchProvider, useWebSearchStore } from "@/store/web-search-store";
import { Check, Globe } from "lucide-react";

const PROVIDER_LABELS: Record<string, string> = {
  builtin: "内置引擎",
  bocha: "博查",
  zhipu: "智谱",
  tavily: "Tavily",
  serper: "Serper",
  searxng: "SearXNG",
};

const ENGINE_OPTIONS: { value: SearchEngine; label: string }[] = [
  { value: "auto", label: "自动" },
  { value: "bing", label: "必应" },
  { value: "baidu", label: "百度" },
  { value: "duckduckgo", label: "DuckDuckGo" },
];

/** 网络搜索引擎选择器：只显示已配置且启用的 provider */
export function SearchEngineSelector() {
  const { activeProvider, engine, enabledProviders, setActiveProvider, setEngine } = useWebSearchStore();

  const displayLabel =
    activeProvider === "builtin"
      ? (ENGINE_OPTIONS.find((o) => o.value === engine)?.label ?? "自动")
      : (PROVIDER_LABELS[activeProvider] ?? activeProvider);

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="flex h-8 cursor-pointer items-center gap-1 rounded-full border border-neutral-200 px-2 text-neutral-600 transition-colors hover:bg-neutral-100 dark:border-neutral-600 dark:text-neutral-300 dark:hover:bg-neutral-700"
            >
              <Globe className="size-4" />
              <span className="text-xs">{displayLabel}</span>
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">选择网络搜索引擎</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="start" className="min-w-32">
        {/* 内置引擎（始终可用） */}
        <DropdownMenuItem onClick={() => setActiveProvider("builtin")}>
          <span className="flex-1">内置引擎</span>
          {activeProvider === "builtin" && <Check className="size-4" />}
        </DropdownMenuItem>

        {/* 已启用的 API provider */}
        {enabledProviders.length > 0 && (
          <>
            <DropdownMenuSeparator />
            {enabledProviders.map((p) => (
              <DropdownMenuItem key={p} onClick={() => setActiveProvider(p)}>
                <span className="flex-1">{PROVIDER_LABELS[p] ?? p}</span>
                {activeProvider === p && <Check className="size-4" />}
              </DropdownMenuItem>
            ))}
          </>
        )}

        {/* 内置引擎子选项 */}
        {activeProvider === "builtin" && (
          <>
            <DropdownMenuSeparator />
            {ENGINE_OPTIONS.map((option) => (
              <DropdownMenuItem key={option.value} onClick={() => setEngine(option.value)}>
                <span className="flex-1 pl-2 text-xs">{option.label}</span>
                {engine === option.value && <Check className="size-3.5" />}
              </DropdownMenuItem>
            ))}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
