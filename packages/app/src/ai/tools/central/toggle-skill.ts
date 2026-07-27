/**
 * 全局助手工具：启用/停用 AI 技能
 */
import { getSkills, toggleSkillActive } from "@/services/skill-service";
import { tool } from "ai";
import { z } from "zod";

export const toggleSkillTool = tool({
  description: `启用或停用某个 AI 技能。

🎯 **核心功能**：
• 按技能名称启用/停用技能（模糊匹配）
• 不传 skillName 时列出全部技能及其启用状态

📊 **返回内容**：
切换后的技能状态，或技能清单`,

  inputSchema: z.object({
    reasoning: z.string().min(1).describe("调用此工具的原因"),
    skillName: z.string().optional().describe("技能名称（模糊匹配；不传则列出全部技能）"),
  }),

  execute: async ({ reasoning, skillName }: { reasoning: string; skillName?: string }) => {
    try {
      const skills = await getSkills();

      if (!skillName?.trim()) {
        return {
          results: {
            success: true,
            skills: skills.map((s) => ({ id: s.id, name: s.name, active: s.isActive, scope: s.scope })),
          },
          meta: { reasoning },
        };
      }

      const q = skillName.trim().toLowerCase();
      const hit =
        skills.find((s) => s.name.toLowerCase() === q) ?? skills.find((s) => s.name.toLowerCase().includes(q));
      if (!hit) {
        return {
          results: {
            success: false,
            message: `没有找到技能「${skillName}」。现有技能：${skills.map((s) => s.name).join("、") || "无"}`,
          },
          meta: { reasoning },
        };
      }

      const updated = await toggleSkillActive(hit.id);
      return {
        results: {
          success: true,
          message: `技能「${updated.name}」已${updated.isActive ? "启用" : "停用"}`,
          skill: { id: updated.id, name: updated.name, active: updated.isActive },
        },
        meta: { reasoning },
      };
    } catch (error) {
      throw new Error(`切换技能状态失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  },
});
