import { getSkills } from "@/services/skill-service";
import { tool } from "ai";
import { z } from "zod";

/**
 * 技能查询工具：从数据库中检索执行任务所需的标准操作流程（SOP）
 */
export const getSkillsTool = tool({
  description: `查询执行任务的标准操作流程（SOP）和规范指南。
  
🎯 **核心功能**：
• 从技能库数据库中检索特定任务的执行步骤和规范
• 提供标准化的操作流程和约束条件
• 确保任务执行的一致性和准确性

💡 **使用场景**：
• 用户要求生成思维导图时，查询 "生成思维导图" 技能
• 需要特定格式输出时，查询对应的格式规范
• 遇到不熟悉的任务时，查询相关 SOP

📝 **重要提示**：
• 查询到技能后，必须严格按照返回的步骤执行
• 遵守技能中定义的约束条件和设计原则
• 如果找不到匹配的技能，返回错误信息`,
  inputSchema: z.object({
    task: z.string().min(1).describe("任务类型或关键词，如：'生成思维导图'"),
    reasoning: z.string().min(1).describe("为什么需要查询这个技能，例如：'用户要求生成思维导图，需要了解标准流程'"),
  }),
  execute: async ({ task, reasoning }: { task: string; reasoning: string }) => {
    console.log(`查询技能 - 任务: ${task}, 原因: ${reasoning}`);

    try {
      // 从数据库获取所有启用的技能
      const allSkills = await getSkills();
      const activeSkills = allSkills.filter((skill) => skill.isActive);

      // 查找匹配的技能（通过任务名称）
      const matched = activeSkills.find(
        (skill) =>
          skill.name.toLowerCase().includes(task.toLowerCase()) ||
          task.toLowerCase().includes(skill.name.toLowerCase()),
      );

      if (!matched) {
        return {
          success: false,
          error: `未找到匹配的技能条目，查询任务: "${task}"`,
          available_skills: activeSkills.map((s) => ({ id: s.id, name: s.name })),
          meta: {
            reasoning,
            query: task,
          },
        };
      }

      return {
        success: true,
        skill: matched.content,
        skill_id: matched.id,
        skill_name: matched.name,
        meta: {
          reasoning,
          query: task,
        },
      };
    } catch (error) {
      console.error("查询技能失败:", error);
      return {
        success: false,
        error: `查询技能失败: ${error instanceof Error ? error.message : "未知错误"}`,
        meta: {
          reasoning,
          query: task,
        },
      };
    }
  },
});

export default getSkillsTool;
