import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { PROMPT_PRESET_SCOPE_LABELS, type PromptPresetScope } from "@/services/prompt-preset-service";
import { Plus, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { type PromptPreset, useClearActivePromptPreset } from "../hooks/use-prompt-presets";
import PresetItem from "./preset-item";

interface PromptScopeSectionProps {
  scope: PromptPresetScope;
  /** 该 scope 的内置默认提示词全文（只读预览；"从默认复制"的起点） */
  defaultContent: string;
  presets: PromptPreset[];
  onCreatePreset: (scope: PromptPresetScope) => void;
  onEditPreset: (preset: PromptPreset) => void;
}

/**
 * 单个 Agent 作用域（阅读/论文助手）的提示词管理分组：
 * 默认提示词卡片（只读预览 + 使用中/恢复默认）+ 命名预设列表（同组互斥激活）。
 */
export default function PromptScopeSection({
  scope,
  defaultContent,
  presets,
  onCreatePreset,
  onEditPreset,
}: PromptScopeSectionProps) {
  const clearActiveMutation = useClearActivePromptPreset();
  const activePreset = presets.find((p) => p.isActive);

  const handleRestoreDefault = async () => {
    try {
      await clearActiveMutation.mutateAsync(scope);
      toast.success(`已恢复${PROMPT_PRESET_SCOPE_LABELS[scope]}默认提示词，下条消息生效`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "恢复默认提示词失败");
    }
  };

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="font-medium text-foreground">{PROMPT_PRESET_SCOPE_LABELS[scope]}系统提示词</h3>
          <p className="text-muted-foreground text-xs">新建命名预设可一键切换，切换后下条消息立即生效</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => onCreatePreset(scope)}>
          <Plus className="size-4" />
          新建预设
        </Button>
      </div>

      {/* 默认提示词卡片（内置全文只读预览） */}
      <div className="space-y-2 rounded-xl border border-border p-3">
        <div className="flex items-center justify-between">
          <span className="text-sm">默认提示词（内置）</span>
          {activePreset ? (
            <div className="flex items-center gap-2">
              <Badge variant="secondary">未使用</Badge>
              <Button
                variant="outline"
                size="sm"
                onClick={handleRestoreDefault}
                disabled={clearActiveMutation.isPending}
              >
                <RotateCcw className="size-3.5" />
                恢复默认
              </Button>
            </div>
          ) : (
            <Badge variant="default">使用中</Badge>
          )}
        </div>
        <Textarea
          value={defaultContent}
          readOnly
          className="h-[180px] resize-none bg-muted/50 font-mono text-xs leading-5 opacity-80"
        />
      </div>

      {/* 命名预设列表（同组互斥激活） */}
      {presets.length > 0 && (
        <div className="grid grid-cols-2 gap-3">
          {presets.map((preset) => (
            <PresetItem key={preset.id} preset={preset} onEdit={onEditPreset} />
          ))}
        </div>
      )}
    </section>
  );
}
