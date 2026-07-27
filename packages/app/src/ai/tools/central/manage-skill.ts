/**
 * 全局助手工具：创建/更新技能
 *
 * 使 Agent 能够自主安装技能（如从下载的 skill 包中读取内容并注册）。
 */
import { createSkill, getSkills, updateSkill } from "@/services/skill-service";
import { tool } from "ai";
import { z } from "zod";

export const manageSkillTool = tool({
  description: `创建或更新 AI 技能（Skill）。

🎯 **核心功能**：
• create：注册新技能（名称 + 内容 + 生效范围）
• update：更新已有技能的内容或名称
• 技能 = 标准操作流程（SOP），Agent 在匹配场景时按技能内容执行

📋 **典型场景**：
• 用户发来 skill 文件内容 → 读取后调用 create 注册
• 用户要求修改某个技能 → 调用 update

📊 **返回内容**：
操作结果（技能 ID、名称）`,

  inputSchema: z.object({
    reasoning: z.string().min(1).describe("调用此工具的原因"),
    action: z.enum(["create", "update"]).describe("create=新建技能, update=更新已有技能"),
    name: z.string().min(1).describe("技能名称"),
    content: z.string().min(1).describe("技能内容（Markdown 格式的 SOP）"),
    scope: z.enum(["reader", "central", "both"]).default("both").describe("生效范围"),
    skillId: z.string().optional().describe("update 时必填：要更新的技能 ID"),
  }),

  execute: async ({
    reasoning,
    action,
    name,
    content,
    scope,
    skillId,
  }: {
    reasoning: string;
    action: "create" | "update";
    name: string;
    content: string;
    scope: "reader" | "central" | "both";
    skillId?: string;
  }) => {
    try {
      if (action === "create") {
        // 检查同名技能是否已存在
        const existing = await getSkills();
        const duplicate = existing.find((s) => s.name === name);
        if (duplicate) {
          // 同名已存在 → 自动转为更新
          const updated = await updateSkill(duplicate.id, { name, content, scope, updatedAt: Date.now() });
          return {
            results: {
              success: true,
              message: `技能「${name}」已存在，已更新其内容（ID: ${updated.id}）`,
              skillId: updated.id,
              action: "updated_existing",
            },
            meta: { reasoning, name },
          };
        }

        const created = await createSkill({ name, content, isActive: true, isSystem: false, scope });
        return {
          results: {
            success: true,
            message: `技能「${name}」创建成功（ID: ${created.id}，scope: ${scope}）`,
            skillId: created.id,
            action: "created",
          },
          meta: { reasoning, name },
        };
      }

      // update
      if (!skillId) {
        // 尝试按名称查找
        const existing = await getSkills();
        const found = existing.find((s) => s.name === name);
        if (!found) {
          return {
            results: { success: false, message: `未找到名为「${name}」的技能，无法更新` },
            meta: { reasoning, name },
          };
        }
        skillId = found.id;
      }

      const updated = await updateSkill(skillId, { name, content, scope, updatedAt: Date.now() });
      return {
        results: {
          success: true,
          message: `技能「${updated.name}」已更新（ID: ${updated.id}）`,
          skillId: updated.id,
          action: "updated",
        },
        meta: { reasoning, name, skillId },
      };
    } catch (error) {
      return {
        results: { success: false, message: `操作失败：${error instanceof Error ? error.message : String(error)}` },
        meta: { reasoning, name, action },
      };
    }
  },
});
