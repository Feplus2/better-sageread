import {
  getMaxBudget,
  getReasoningOptions,
  getReasoningTransport,
  reasoningLevelLabel,
} from "@/ai/providers/reasoning-map";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Slider } from "@/components/ui/slider";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useProviderStore } from "@/store/provider-store";
import { useChatSettingsStore } from "@/store/chat-settings-store";
import { Check, Gauge } from "lucide-react";
import { useMemo } from "react";

/**
 * 思考强度选择器（枚举制 + 三形态，2026-08-28）：
 * 按当前模型的 transport 类型自动适配 UI——
 *   effort → 下拉菜单（模型原生档位：grok-4.6 五档含 xhigh）
 *   budget → 滑块（Qwen/MiMo thinking_budget，0-32768 连续可调）
 *   switch → 开/关两项（GLM-4.x 等仅开关型）
 *   auto   → 显示"自动"（不在表内，不下发参数）
 * 数据源：MODEL_REASONING 表（ai/providers/reasoning-map.ts）
 */
export function ReasoningLevelSelector() {
  const { reasoningLevel, setReasoningLevel } = useChatSettingsStore();
  const selectedModel = useProviderStore((s) => s.selectedModel);

  const transport = getReasoningTransport(selectedModel?.modelId);
  const options = useMemo(
    () => getReasoningOptions(selectedModel?.modelId),
    [selectedModel?.modelId],
  );
  const maxBudget = getMaxBudget(selectedModel?.modelId);

  // auto：只显示"自动"标记，不可选（不下发参数 = 模型默认行为）
  if (transport === "auto") {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className="flex h-8 items-center gap-1 rounded-full border border-neutral-200 px-2 text-neutral-400 dark:border-neutral-600 dark:text-neutral-500"
            aria-label="思考强度：自动（模型默认）"
          >
            <Gauge className="size-4" />
            <span className="text-xs">思考·自动</span>
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">此模型未收录思考档位信息，使用模型默认行为</TooltipContent>
      </Tooltip>
    );
  }

  // budget：滑块（0 = 关闭，maxBudget = 最大）
  if (transport === "budget") {
    const budgetValue = Number.parseInt(reasoningLevel, 10);
    const current = Number.isFinite(budgetValue) ? budgetValue : 4000;
    return (
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="flex h-8 cursor-pointer items-center gap-1 rounded-full border border-neutral-200 px-2 text-neutral-600 transition-colors hover:bg-neutral-100 dark:border-neutral-600 dark:text-neutral-300 dark:hover:bg-neutral-700"
              >
                <Gauge className="size-4" />
                <span className="text-xs">
                  {current === 0 ? "思考·关闭" : `思考·${current}`}
                </span>
              </button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom">思考 Token 预算（0 = 关闭，滑块连续可调）</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="start" className="min-w-64 p-4">
          <div className="mb-2 flex items-center justify-between text-xs text-neutral-500">
            <span>{current === 0 ? "关闭" : `${current} tokens`}</span>
            <span className="text-neutral-400">max {maxBudget}</span>
          </div>
          <Slider
            value={[current]}
            min={0}
            max={maxBudget}
            step={512}
            onValueChange={(v) => setReasoningLevel(String(v[0]))}
          />
          <div className="mt-2 flex justify-between text-[10px] text-neutral-400">
            <span>0（关）</span>
            <span>1024</span>
            <span>8192</span>
            <span>{maxBudget}</span>
          </div>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  // effort / switch：下拉菜单
  if (options.length === 0) return null;

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="flex h-8 cursor-pointer items-center gap-1 rounded-full border border-neutral-200 px-2 text-neutral-600 transition-colors hover:bg-neutral-100 dark:border-neutral-600 dark:text-neutral-300 dark:hover:bg-neutral-700"
            >
              <Gauge className="size-4" />
              <span className="text-xs">思考·{reasoningLevelLabel(reasoningLevel)}</span>
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">思考强度（{options.length} 档可选）</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="start" className="min-w-28">
        {options.map((level) => (
          <DropdownMenuItem key={level} onClick={() => setReasoningLevel(level)}>
            <span className="flex-1">{reasoningLevelLabel(level)}</span>
            {reasoningLevel === level && <Check className="size-4" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
