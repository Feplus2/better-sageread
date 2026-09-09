import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { DEFAULT_CENTRAL_STYLE, DEFAULT_PAPER_STYLE, DEFAULT_READER_STYLE } from "@/constants/agent-styles";
import type { PromptPresetScope } from "@/services/prompt-preset-service";
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
  const editorDefaultContent = editorScope === "reader" ? DEFAULT_READER_STYLE : DEFAULT_PAPER_STYLE;

  return (
    <div className="space-y-8">
      {/* 分层说明：这里只管理风格层；工具策略由系统内置 */}
      <p className="rounded-xl border border-border bg-muted/40 p-3 text-muted-foreground text-xs leading-5">
        这里管理的是助手的「风格层」——角色、语气与表达偏好，照着默认风格的结构即可写出你的专属预设。
        工具调用策略与安全规范由系统随版本内置，不在此显示，也不会被预设改动。
      </p>

      <PromptScopeSection
        scope="reader"
        defaultContent={DEFAULT_READER_STYLE}
        presets={allPresets.filter((p) => p.scope === "reader")}
        onCreatePreset={handleCreate}
        onEditPreset={handleEdit}
      />

      <PromptScopeSection
        scope="paper"
        defaultContent={DEFAULT_PAPER_STYLE}
        presets={allPresets.filter((p) => p.scope === "paper")}
        onCreatePreset={handleCreate}
        onEditPreset={handleEdit}
      />

      {/* 全局助手风格（本批不支持预设，只读） */}
      <section className="space-y-3">
        <div>
          <h3 className="font-medium text-foreground">全局助手提示词风格</h3>
          <p className="text-muted-foreground text-xs">主页全能助手的风格层（只读，暂不支持预设）</p>
        </div>
        <div className="space-y-2">
          <Label className="sr-only">全局助手提示词风格</Label>
          <Textarea
            value={DEFAULT_CENTRAL_STYLE}
            readOnly
            className="h-[180px] resize-none bg-muted/50 font-mono text-xs leading-5 opacity-80"
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
