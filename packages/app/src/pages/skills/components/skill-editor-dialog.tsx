import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { SKILL_SCOPES, type SkillScope, parseSkillScopes, serializeSkillScopes } from "@/services/skill-service";
import { useEffect, useState } from "react";
import { type Skill, useCreateSkill, useUpdateSkill } from "../hooks/use-skills";
import { ScopeCheckboxes } from "./scope-checkboxes";

interface SkillEditorDialogProps {
  isOpen: boolean;
  onClose: () => void;
  skill?: Skill | null;
}

export default function SkillEditorDialog({ isOpen, onClose, skill }: SkillEditorDialogProps) {
  const [name, setName] = useState("");
  const [content, setContent] = useState("");
  const [isActive, setIsActive] = useState(true);
  const [scopes, setScopes] = useState<SkillScope[]>([...SKILL_SCOPES]);

  const createSkillMutation = useCreateSkill();
  const updateSkillMutation = useUpdateSkill();

  const isEditing = !!skill;
  const isSystemSkill = !!skill?.isSystem;
  const isLoading = createSkillMutation.isPending || updateSkillMutation.isPending;

  useEffect(() => {
    if (isOpen) {
      if (skill) {
        setName(skill.name);
        setContent(skill.content);
        setIsActive(skill.isActive);
        setScopes(parseSkillScopes(skill.scope));
      } else {
        setName("");
        setContent("");
        setIsActive(true);
        // 新建默认全勾（沿用旧默认值 "both" 的"全部生效"意图）
        setScopes([...SKILL_SCOPES]);
      }
    }
  }, [isOpen, skill]);

  const handleSave = async () => {
    if (!name.trim() || !content.trim()) return;

    try {
      if (isEditing) {
        await updateSkillMutation.mutateAsync({
          id: skill.id,
          data: {
            name: isSystemSkill ? skill.name : name.trim(),
            content: content.trim(),
            isActive: isSystemSkill ? skill.isActive : isActive,
            scope: isSystemSkill ? undefined : serializeSkillScopes(scopes),
          },
        });
      } else {
        await createSkillMutation.mutateAsync({
          name: name.trim(),
          content: content.trim(),
          isActive,
          scope: serializeSkillScopes(scopes),
        });
      }
      onClose();
    } catch (error) {
      console.error("保存技能失败:", error);
    }
  };

  const handleCancel = () => {
    onClose();
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-h-[80vh] select-none sm:max-w-[700px]">
        <DialogHeader>
          <DialogTitle>
            <div className="flex items-center space-x-2">
              <span>{isEditing ? (isSystemSkill ? "编辑系统技能" : "编辑技能") : "新建技能"}</span>
              {!isSystemSkill && (
                <div className="flex items-center space-x-2">
                  <Switch id="skill-active" checked={isActive} onCheckedChange={setIsActive} disabled={isLoading} />
                  <Label htmlFor="skill-active" className="cursor-pointer">
                    启用此技能
                  </Label>
                </div>
              )}
            </div>
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 px-3 py-4">
          <div className="space-y-2">
            <Label htmlFor="skill-name">技能名称</Label>
            <Input
              id="skill-name"
              placeholder="例如：生成思维导图"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={isLoading || isSystemSkill}
              autoFocus={!isSystemSkill}
              className={isSystemSkill ? "cursor-not-allowed opacity-60" : ""}
            />
            {isSystemSkill && <p className="text-muted-foreground text-xs">系统技能名称不可修改</p>}
          </div>

          <div className="space-y-2">
            <Label htmlFor="skill-content">技能内容</Label>
            <Textarea
              id="skill-content"
              placeholder="技能的详细说明（支持 Markdown）"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              disabled={isLoading}
              className="h-[400px] resize-none font-mono text-sm"
            />
          </div>

          {!isSystemSkill && (
            <div className="space-y-2">
              <Label>生效范围</Label>
              <ScopeCheckboxes value={scopes} onChange={setScopes} disabled={isLoading} />
              {scopes.length === 0 && <p className="text-destructive text-xs">至少勾选一个生效范围</p>}
            </div>
          )}
        </div>

        <DialogFooter className="gap-2">
          <Button size="sm" variant="outline" onClick={handleCancel} disabled={isLoading}>
            取消
          </Button>
          <Button
            size="sm"
            onClick={handleSave}
            disabled={!name.trim() || !content.trim() || (!isSystemSkill && scopes.length === 0) || isLoading}
          >
            {isLoading ? "保存中..." : "保存"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
