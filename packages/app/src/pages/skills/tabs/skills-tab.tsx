import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Loader2, Plus } from "lucide-react";
import { useState } from "react";
import SkillEditorDialog from "../components/skill-editor-dialog";
import SkillItem from "../components/skill-item";
import { type Skill, useSkills } from "../hooks/use-skills";

type ScopeFilter = "all" | "reader" | "central" | "both";

export default function SkillsTab() {
  const [isEditorOpen, setIsEditorOpen] = useState(false);
  const [editingSkill, setEditingSkill] = useState<Skill | null>(null);
  const [scopeFilter, setScopeFilter] = useState<ScopeFilter>("all");
  const { data: skills, isLoading, error } = useSkills();

  const handleCreate = () => {
    setEditingSkill(null);
    setIsEditorOpen(true);
  };

  const handleEdit = (skill: Skill) => {
    setEditingSkill(skill);
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
          <p className="text-destructive">加载技能列表失败</p>
          <p className="text-muted-foreground text-sm">{error.message}</p>
        </div>
      </div>
    );
  }

  const nonSystemSkills = (skills ?? []).filter((s) => !s.isSystem);
  const filteredSkills =
    scopeFilter === "all" ? nonSystemSkills : nonSystemSkills.filter((s) => s.scope === scopeFilter);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-muted-foreground text-sm">技能为标准操作流程（SOP），AI 在匹配场景时自动调用</p>
        <div className="flex items-center gap-2">
          <Select value={scopeFilter} onValueChange={(v) => setScopeFilter(v as ScopeFilter)}>
            <SelectTrigger className="h-8 w-28 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部</SelectItem>
              <SelectItem value="reader">阅读助手</SelectItem>
              <SelectItem value="central">全局助手</SelectItem>
              <SelectItem value="both">共享</SelectItem>
            </SelectContent>
          </Select>
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
    </div>
  );
}
