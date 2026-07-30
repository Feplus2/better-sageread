import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { PROMPT_PRESET_SCOPE_LABELS, type PromptPresetScope } from "@/services/prompt-preset-service";
import { Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { type PromptPreset, useCreatePromptPreset, useUpdatePromptPreset } from "../hooks/use-prompt-presets";

interface PresetEditorDialogProps {
  isOpen: boolean;
  onClose: () => void;
  scope: PromptPresetScope;
  preset?: PromptPreset | null;
  /** 该 scope 的内置默认提示词全文，供"从默认复制"作为起点 */
  defaultContent: string;
}

export default function PresetEditorDialog({
  isOpen,
  onClose,
  scope,
  preset,
  defaultContent,
}: PresetEditorDialogProps) {
  const [name, setName] = useState("");
  const [content, setContent] = useState("");

  const createMutation = useCreatePromptPreset();
  const updateMutation = useUpdatePromptPreset();

  const isEditing = !!preset;
  const isLoading = createMutation.isPending || updateMutation.isPending;

  useEffect(() => {
    if (isOpen) {
      if (preset) {
        setName(preset.name);
        setContent(preset.content);
      } else {
        setName("");
        setContent("");
      }
    }
  }, [isOpen, preset]);

  const handleCopyDefault = () => {
    setContent(defaultContent);
    toast.info("已复制默认提示词，可在此基础上修改");
  };

  const handleSave = async () => {
    if (!name.trim() || !content.trim()) return;

    try {
      if (isEditing) {
        await updateMutation.mutateAsync({ id: preset.id, name: name.trim(), content: content.trim() });
        toast.success(`预设「${name.trim()}」已保存`);
      } else {
        await createMutation.mutateAsync({ scope, name: name.trim(), content: content.trim() });
        toast.success(`预设「${name.trim()}」已创建，激活后生效`);
      }
      onClose();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "保存预设失败");
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-h-[80vh] select-none sm:max-w-[700px]">
        <DialogHeader>
          <DialogTitle>
            {isEditing ? "编辑预设" : "新建预设"} · {PROMPT_PRESET_SCOPE_LABELS[scope]}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 px-3 py-4">
          <div className="space-y-2">
            <Label htmlFor="preset-name">预设名称</Label>
            <Input
              id="preset-name"
              placeholder="例如：人文社科、小说"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={isLoading}
              autoFocus
            />
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="preset-content">提示词内容</Label>
              <Button variant="ghost" size="sm" onClick={handleCopyDefault} disabled={isLoading || !defaultContent}>
                <Copy className="size-3.5" />
                从默认复制
              </Button>
            </div>
            <Textarea
              id="preset-content"
              placeholder="该预设激活后，将整体替换内置默认提示词（技能注入与上下文注入不受影响）"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              disabled={isLoading}
              className="h-[400px] resize-none font-mono text-sm"
            />
          </div>
        </div>

        <DialogFooter className="gap-2">
          <Button size="sm" variant="outline" onClick={onClose} disabled={isLoading}>
            取消
          </Button>
          <Button size="sm" onClick={handleSave} disabled={!name.trim() || !content.trim() || isLoading}>
            {isLoading ? "保存中..." : "保存"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
