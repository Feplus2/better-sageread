/**
 * 全局助手工具：创建/更新/启用停用/删除技能
 *
 * 使 Agent 能够自主安装技能（如从下载的 skill 包中读取内容并注册）。
 * 合并自原 toggleSkill 工具，toggle 动作执行逻辑原样搬入；
 * delete 为破坏性动作，由 tool-guard 恒确认（系统内置技能不可删）
 */
import {
  createSkill,
  deleteSkill,
  getSkills,
  parseSkillScopes,
  serializeSkillScopes,
  toggleSkillActive,
  updateSkill,
} from "@/services/skill-service";
import { tool } from "ai";
import { z } from "zod";

/** 落库统一为逗号分隔串；接受数组或逗号串输入，兼容旧值 "both"，非法/空输入回退 reader,central */
function normalizeScope(input: string[] | string | undefined): string {
  const parsed = parseSkillScopes(Array.isArray(input) ? input.join(",") : input);
  return parsed.length > 0 ? serializeSkillScopes(parsed) : "reader,central";
}

export const manageSkillTool = tool({
  description: `创建、更新、启用/停用或删除 AI 技能（Skill）。

🎯 **核心功能**：
• create：注册新技能（名称 + 内容 + 生效范围）
• update：更新已有技能的内容或名称
• toggle：启用/停用某个技能（按名称模糊匹配；不传 skillName 时列出全部技能及其启用状态）
• delete：删除技能（破坏性操作，会弹确认卡；系统内置技能不可删）
• 技能 = 标准操作流程（SOP），Agent 在匹配场景时按技能内容执行

📋 **典型场景**：
• 用户发来 skill 文件内容 → 读取后调用 create 注册
• 用户要求修改某个技能 → 调用 update
• 用户要求启用/停用某个技能 → 调用 toggle
• 用户要求删除某个技能 → 调用 delete（按 skillName 模糊匹配）

📊 **返回内容**：
操作结果（技能 ID、名称）；toggle 返回切换后的技能状态或技能清单`,

  inputSchema: z.object({
    reasoning: z.string().min(1).describe("调用此工具的原因"),
    action: z
      .enum(["create", "update", "toggle", "delete"])
      .describe("create=新建技能, update=更新已有技能, toggle=启用/停用技能, delete=删除技能"),
    name: z.string().optional().describe("技能名称（create/update 时必填）"),
    content: z.string().optional().describe("技能内容（Markdown 格式的 SOP；create/update 时必填）"),
    // Gemini 兼容：不用 z.union（anyOf 在 Gemini 系端点/中转器上会被拒或捏造成坏 schema），
    // 收敛为逗号分隔串（normalizeScope 运行期兼容数组输入）
    scope: z
      .string()
      .optional()
      .describe("生效范围：逗号分隔串（如 'reader,paper'），可选值 reader/central/paper，缺省 reader,central"),
    skillId: z.string().optional().describe("update 时必填：要更新的技能 ID"),
    skillName: z.string().optional().describe("toggle/delete 时用：技能名称（模糊匹配；toggle 不传则列出全部技能）"),
  }),

  execute: async ({
    reasoning,
    action,
    name,
    content,
    scope,
    skillId,
    skillName,
  }: {
    reasoning: string;
    action: "create" | "update" | "toggle" | "delete";
    name?: string;
    content?: string;
    scope?: ("reader" | "central" | "paper")[] | string;
    skillId?: string;
    skillName?: string;
  }) => {
    // ==================== 删除技能（破坏性，tool-guard 恒确认） ====================
    if (action === "delete") {
      try {
        const skills = await getSkills();
        const q = skillName?.trim().toLowerCase() ?? "";
        if (!q) {
          return {
            results: { success: false, message: "delete 需要提供 skillName" },
            meta: { reasoning },
          };
        }
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
        if (hit.isSystem) {
          return {
            results: { success: false, message: `技能「${hit.name}」是系统内置技能，不可删除` },
            meta: { reasoning },
          };
        }
        await deleteSkill(hit.id);
        return {
          results: { success: true, message: `技能「${hit.name}」已删除` },
          meta: { reasoning },
        };
      } catch (error) {
        throw new Error(`删除技能失败: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    // ==================== 启用/停用技能（原 toggleSkill） ====================
    if (action === "toggle") {
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
    }

    if (!name?.trim() || !content?.trim()) {
      return {
        results: { success: false, message: `action=${action} 需要提供 name 和 content` },
        meta: { reasoning, action },
      };
    }

    const scopeStr = normalizeScope(scope);
    try {
      if (action === "create") {
        // 检查同名技能是否已存在
        const existing = await getSkills();
        const duplicate = existing.find((s) => s.name === name);
        if (duplicate) {
          // 同名已存在 → 自动转为更新
          const updated = await updateSkill(duplicate.id, { name, content, scope: scopeStr, updatedAt: Date.now() });
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

        const created = await createSkill({ name, content, isActive: true, isSystem: false, scope: scopeStr });
        return {
          results: {
            success: true,
            message: `技能「${name}」创建成功（ID: ${created.id}，scope: ${scopeStr}）`,
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

      const updated = await updateSkill(skillId, { name, content, scope: scopeStr, updatedAt: Date.now() });
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
