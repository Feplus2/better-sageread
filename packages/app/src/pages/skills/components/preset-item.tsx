import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ask } from "@tauri-apps/plugin-dialog";
import { Check, Pencil, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { type PromptPreset, useDeletePromptPreset, useSetActivePromptPreset } from "../hooks/use-prompt-presets";

interface PresetItemProps {
  preset: PromptPreset;
  onEdit: (preset: PromptPreset) => void;
}

export default function PresetItem({ preset, onEdit }: PresetItemProps) {
  const setActiveMutation = useSetActivePromptPreset();
  const deleteMutation = useDeletePromptPreset();

  const handleActivate = async () => {
    try {
      await setActiveMutation.mutateAsync(preset.id);
      toast.success(`已切换到预设「${preset.name}」，下条消息生效`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "切换预设失败");
    }
  };

  const handleDelete = async () => {
    try {
      const confirmed = await ask(
        preset.isActive
          ? `确定要删除预设 "${preset.name}" 吗？\n\n它是当前使用中的预设，删除后将恢复默认提示词。\n此操作无法撤销。`
          : `确定要删除预设 "${preset.name}" 吗？\n\n此操作无法撤销。`,
        { title: "确认删除", kind: "warning" },
      );

      if (confirmed) {
        await deleteMutation.mutateAsync(preset.id);
        toast.success(`预设「${preset.name}」已删除`);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "删除预设失败");
    }
  };

  const formatDate = (timestamp: number) => {
    return new Date(timestamp).toLocaleDateString("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  return (
    <div className="group relative select-auto rounded-xl bg-muted p-3 shadow-around">
      <div className="mb-3 flex items-center justify-between gap-2">
        <span className="flex-1 truncate text-lg">{preset.name}</span>
        <div className="flex items-center gap-2">
          {!preset.isActive && (
            <Button variant="outline" size="sm" onClick={handleActivate} disabled={setActiveMutation.isPending}>
              <Check className="size-3.5" />
              激活
            </Button>
          )}
          <Button variant="ghost" size="icon" onClick={() => onEdit(preset)} className="size-5">
            <Pencil className="size-4" />
          </Button>
          <Button variant="ghost" size="icon" onClick={handleDelete} className="size-5 hover:text-destructive/80">
            <Trash2 className="size-4" />
          </Button>
        </div>
      </div>

      <p className="mb-3 line-clamp-2 text-muted-foreground text-sm">{preset.content}</p>

      <div className="flex items-center justify-between text-xs">
        <div className="flex items-center gap-2">{preset.isActive && <Badge variant="default">使用中</Badge>}</div>
        <span className="text-muted-foreground">更新于 {formatDate(preset.updatedAt)}</span>
      </div>
    </div>
  );
}
