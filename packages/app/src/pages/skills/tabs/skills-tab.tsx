import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SKILL_SCOPES, SKILL_SCOPE_LABELS, type SkillScope, parseSkillScopes } from "@/services/skill-service";
import { ListFilter, Loader2, Plus, Upload } from "lucide-react";
import { useState } from "react";
import SkillEditorDialog from "../components/skill-editor-dialog";
import { SkillImportDialog } from "../components/skill-import-dialog";
import SkillItem from "../components/skill-item";
import { type Skill, useSkills } from "../hooks/use-skills";

export default function SkillsTab() {
  const [isEditorOpen, setIsEditorOpen] = useState(false);
  const [editingSkill, setEditingSkill] = useState<Skill | null>(null);
  const [isImportOpen, setIsImportOpen] = useState(false);
  // 作用域筛选（集合包含匹配；空集合 = 全部）
  const [scopeFilter, setScopeFilter] = useState<Set<SkillScope>>(new Set());
  const { data: skills, isLoading, error } = useSkills();

  const handleCreate = () => {
    setEditingSkill(null);
    setIsEditorOpen(true);
  };

  const handleEdit = (skill: Skill) => {
    setEditingSkill(skill);
    setIsEditorOpen(true);
  };

  const toggleScopeFilter = (scope: SkillScope, checked: boolean) => {
    setScopeFilter((prev) => {
      const next = new Set(prev);
      if (checked) {
        next.add(scope);
      } else {
        next.delete(scope);
      }
      return next;
    });
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
          <p className="text-destructive">加载技能列表失败</p>
          <p className="text-muted-foreground text-sm">{error.message}</p>
        </div>
      </div>
    );
  }

  const nonSystemSkills = (skills ?? []).filter((s) => !s.isSystem);
  const filteredSkills =
    scopeFilter.size === 0
      ? nonSystemSkills
      : nonSystemSkills.filter((s) => parseSkillScopes(s.scope).some((scope) => scopeFilter.has(scope)));

  const filterLabel =
    scopeFilter.size === 0
      ? "全部范围"
      : SKILL_SCOPES.filter((s) => scopeFilter.has(s))
          .map((s) => SKILL_SCOPE_LABELS[s])
          .join("、");

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-muted-foreground text-sm">技能为标准操作流程（SOP），AI 在匹配场景时自动调用</p>
        <div className="flex items-center gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="h-8 max-w-56 gap-1.5 text-xs">
                <ListFilter className="size-3.5 shrink-0" />
                <span className="truncate">{filterLabel}</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-32">
              {SKILL_SCOPES.map((scope) => (
                <DropdownMenuCheckboxItem
                  key={scope}
                  checked={scopeFilter.has(scope)}
                  onCheckedChange={(checked) => toggleScopeFilter(scope, checked === true)}
                  onSelect={(e) => e.preventDefault()}
                >
                  {SKILL_SCOPE_LABELS[scope]}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <Button variant="outline" size="sm" onClick={() => setIsImportOpen(true)}>
            <Upload className="size-4" />
            导入
          </Button>
          <Button variant="outline" size="sm" onClick={handleCreate}>
            <Plus className="size-4" />
            新建技能
          </Button>
        </div>
      </div>

      {filteredSkills.length === 0 ? (
        <div className="flex h-40 items-center justify-center">
          <div className="text-center">
            <p className="mb-3 text-muted-foreground">还没有任何技能</p>
            <Button size="sm" onClick={handleCreate}>
              <Plus className="mr-1 size-4" />
              创建第一个技能
            </Button>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          {filteredSkills.map((skill) => (
            <SkillItem key={skill.id} skill={skill} onEdit={handleEdit} />
          ))}
        </div>
      )}

      <SkillEditorDialog isOpen={isEditorOpen} onClose={() => setIsEditorOpen(false)} skill={editingSkill} />
      <SkillImportDialog open={isImportOpen} onOpenChange={setIsImportOpen} />
    </div>
  );
}
