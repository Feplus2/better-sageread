import { getReasoningOptions, reasoningLevelLabel } from "@/ai/providers/reasoning-map";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useProviderStore } from "@/store/provider-store";
import { useChatSettingsStore } from "@/store/chat-settings-store";
import { Check, Gauge } from "lucide-react";
import { useMemo } from "react";

/**
 * 思考强度档位选择器（枚举制 2026-08-28）：选项 = 当前模型的原生档位，
 * 由 MODEL_REASONING 表驱动（ai/providers/reasoning-map.ts）。
 * - grok-4.6 → none / low / medium / high / xhigh 五项
 * - GLM-5.3 → low / high / max 三项（无 off，思考不可关）
 * - Gemini 3-Pro → low / medium / high（同上）
 * - Qwen 系 → off / low / medium / high（内部映射 budget）
 * - 不认识的模型 → 隐藏选择器
 */
export function ReasoningLevelSelector() {
  const { reasoningLevel, setReasoningLevel } = useChatSettingsStore();
  const selectedModel = useProviderStore((s) => s.selectedModel);

  const options = useMemo(
    () => getReasoningOptions(selectedModel?.modelId),
    [selectedModel?.modelId],
  );

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
