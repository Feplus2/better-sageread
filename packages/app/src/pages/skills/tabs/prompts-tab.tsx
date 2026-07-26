import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { CENTRAL_AGENT_PROMPT } from "@/constants/central-prompt";
import { getSkills, updateSkill } from "@/services/skill-service";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { RotateCcw, Save } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

export default function PromptsTab() {
  const queryClient = useQueryClient();
  const [readerPrompt, setReaderPrompt] = useState("");
  const [systemSkillId, setSystemSkillId] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [originalContent, setOriginalContent] = useState("");

  const { data: skills } = useQuery({
    queryKey: ["skills"],
    queryFn: getSkills,
  });

  useEffect(() => {
    if (skills) {
      const systemSkill = skills.find((s) => s.isSystem && s.isActive);
      if (systemSkill) {
        setSystemSkillId(systemSkill.id);
        setReaderPrompt(systemSkill.content);
        setOriginalContent(systemSkill.content);
      }
    }
  }, [skills]);

  const handleSaveReaderPrompt = async () => {
    if (!systemSkillId) return;
    setIsSaving(true);
    try {
      await updateSkill(systemSkillId, { content: readerPrompt });
      queryClient.invalidateQueries({ queryKey: ["skills"] });
      setOriginalContent(readerPrompt);
      toast.success("阅读助手提示词已保存");
    } catch (e) {
      toast.error("保存失败");
      console.error(e);
    } finally {
      setIsSaving(false);
    }
  };

  const handleReset = () => {
    setReaderPrompt(originalContent);
    toast.info("已恢复到上次保存的内容");
  };

  return (
    <div className="space-y-8">
      {/* 阅读助手提示词 */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="font-medium text-foreground">阅读助手系统提示词</h3>
            <p className="text-muted-foreground text-xs">侧边栏阅读助手的核心行为定义，可自由编辑</p>
          </div>
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={handleReset} disabled={readerPrompt === originalContent}>
              <RotateCcw className="size-3.5" />
              恢复
            </Button>
            <Button size="sm" onClick={handleSaveReaderPrompt} disabled={isSaving || readerPrompt === originalContent}>
              <Save className="size-3.5" />
              {isSaving ? "保存中..." : "保存"}
            </Button>
          </div>
        </div>
        <Textarea
          value={readerPrompt}
          onChange={(e) => setReaderPrompt(e.target.value)}
          className="h-[300px] resize-none font-mono text-xs leading-5"
          placeholder="加载中..."
        />
      </section>

      {/* 中央 Agent 提示词 */}
      <section className="space-y-3">
        <div>
          <h3 className="font-medium text-foreground">中央 Agent 系统提示词</h3>
          <p className="text-muted-foreground text-xs">
            主页全能助手的行为定义（只读，如需修改请编辑 central-prompt.ts）
          </p>
        </div>
        <Textarea
          value={CENTRAL_AGENT_PROMPT}
          readOnly
          className="h-[300px] resize-none bg-muted/50 font-mono text-xs leading-5 opacity-80"
        />
      </section>
    </div>
  );
}
