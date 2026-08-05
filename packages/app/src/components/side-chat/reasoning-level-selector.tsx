import { REASONING_LEVEL_LABELS, type ReasoningLevel } from "@/ai/providers/reasoning-map";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useChatSettingsStore } from "@/store/chat-settings-store";
import { Check, Gauge } from "lucide-react";

const LEVELS: ReasoningLevel[] = ["off", "low", "medium", "high"];

/**
 * 思考强度档位选择器（P3）：关闭/低/中/高，映射表见 ai/providers/reasoning-map.ts。
 * 映射表不认识的端不下发参数（防 400），此时切换无实际效果。
 */
export function ReasoningLevelSelector() {
  const { reasoningLevel, setReasoningLevel } = useChatSettingsStore();

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
              <span className="text-xs">思考·{REASONING_LEVEL_LABELS[reasoningLevel]}</span>
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">思考强度（映射表不支持的模型不生效）</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="start" className="min-w-28">
        {LEVELS.map((level) => (
          <DropdownMenuItem key={level} onClick={() => setReasoningLevel(level)}>
            <span className="flex-1">{REASONING_LEVEL_LABELS[level]}</span>
            {reasoningLevel === level && <Check className="size-4" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
