import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { CENTRAL_AGENT_PROMPT } from "@/constants/central-prompt";
import { PAPER_AGENT_PROMPT_BASE } from "@/constants/paper-prompt";
import type { PromptPresetScope } from "@/services/prompt-preset-service";
import { getSkills } from "@/services/skill-service";
import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useState } from "react";
import PresetEditorDialog from "../components/preset-editor-dialog";
import PromptScopeSection from "../components/prompt-scope-section";
import { type PromptPreset, usePromptPresets } from "../hooks/use-prompt-presets";

export default function PromptsTab() {
  const [isEditorOpen, setIsEditorOpen] = useState(false);
  const [editorScope, setEditorScope] = useState<PromptPresetScope>("reader");
  const [editingPreset, setEditingPreset] = useState<PromptPreset | null>(null);

  const { data: presets, isLoading, error } = usePromptPresets();

  // 阅读助手的内置默认提示词 = DB 中 isSystem && isActive 的系统技能内容（用户可能自定义过，只读展示）
  const { data: skills } = useQuery({
    queryKey: ["skills"],
    queryFn: getSkills,
  });
  const readerDefaultPrompt = skills?.find((s) => s.isSystem && s.isActive)?.content ?? "";

  const handleCreate = (scope: PromptPresetScope) => {
    setEditorScope(scope);
    setEditingPreset(null);
    setIsEditorOpen(true);
  };

  const handleEdit = (preset: PromptPreset) => {
    setEditorScope(preset.scope as PromptPresetScope);
    setEditingPreset(preset);
    setIsEditorOpen(true);
  };

  if (isLoading) {
    return (
      <div className="flex h-40 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-40 items-center justify-center">
        <div className="text-center">
          <p className="text-destructive">加载提示词预设失败</p>
          <p className="text-muted-foreground text-sm">{error.message}</p>
        </div>
      </div>
    );
  }

  const allPresets = presets ?? [];
  const editorDefaultContent = editorScope === "reader" ? readerDefaultPrompt : PAPER_AGENT_PROMPT_BASE;

  return (
    <div className="space-y-8">
      <PromptScopeSection
        scope="reader"
        defaultContent={readerDefaultPrompt}
        presets={allPresets.filter((p) => p.scope === "reader")}
        onCreatePreset={handleCreate}
        onEditPreset={handleEdit}
      />

      <PromptScopeSection
        scope="paper"
        defaultContent={PAPER_AGENT_PROMPT_BASE}
        presets={allPresets.filter((p) => p.scope === "paper")}
        onCreatePreset={handleCreate}
        onEditPreset={handleEdit}
      />

      {/* 全局助手提示词（本批不支持预设，只读） */}
      <section className="space-y-3">
        <div>
          <h3 className="font-medium text-foreground">全局助手系统提示词</h3>
          <p className="text-muted-foreground text-xs">
            主页全能助手的行为定义（只读，暂不支持预设；如需修改请编辑 central-prompt.ts）
          </p>
        </div>
        <div className="space-y-2">
          <Label className="sr-only">全局助手系统提示词</Label>
          <Textarea
            value={CENTRAL_AGENT_PROMPT}
            readOnly
            className="h-[300px] resize-none bg-muted/50 font-mono text-xs leading-5 opacity-80"
          />
        </div>
      </section>

      <PresetEditorDialog
        isOpen={isEditorOpen}
        onClose={() => setIsEditorOpen(false)}
        scope={editorScope}
        preset={editingPreset}
        defaultContent={editorDefaultContent}
      />
    </div>
  );
}
