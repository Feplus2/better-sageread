/**
 * 全局助手工具（2026-08-06）：管理用户密钥保管箱（user:* 命名空间）。
 *
 * 安全边界（用户拍板）：
 * - 可写入、可列名、可删除；**永不提供读出真值的通道**（Rust 侧 secret_get_for_runtime
 *   仅前端代码调用，本工具只暴露 list/set/delete）
 * - 用户把 key 贴进聊天后，Agent 代为存入保管箱——让 key 尽快离开明文配置进入凭据管理器
 * - set/delete 由 tool-guard 恒确认（唯一 key 使「不再询问」失效）
 */
import { secretListUser, secretUserDelete, secretUserSet } from "@/services/secret-service";
import { tool } from "ai";
import { z } from "zod";

const NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

export const manageSecretsTool = tool({
  description: `管理用户的密钥保管箱（设置 → 密钥保管箱）。

🔒 **安全边界**：本工具只能写入/列名/删除密钥，**没有任何读出密钥真值的能力**；
用户把 key 发给你时，用本工具存入保管箱，之后在配置中以 {{secret:名称}} 引用。

🎯 **核心功能**：
• list：列出保管箱中已有的密钥名称（仅名称，不含真值）
• set：保存/覆盖一个密钥（name 限字母/数字/_/-，最长 64）
• delete：删除一个密钥

📋 **使用时机**：
• 用户在聊天里直接贴了 API Key/Token 并希望你配置 MCP、技能或集成时：
  先 set 存入保管箱（建议命名如 GITHUB_TOKEN），再把配置中的密钥位置写成 {{secret:名称}}
• 用户问"保管箱里有什么密钥"时用 list（只报名称，绝不要求或尝试获取真值）

⚠️ **纪律**：
• 不要把密钥真值复述到回复里；存入后只提名称
• 密钥真值永不写入 memory.md、工作区文件或任何配置明文`,

  inputSchema: z.object({
    reasoning: z.string().min(1).describe("调用此工具的原因"),
    action: z.enum(["list", "set", "delete"]).describe("动作：list 列名 / set 保存 / delete 删除"),
    name: z.string().optional().describe("密钥名称（set/delete 必填；限字母/数字/下划线/连字符，1-64 位）"),
    value: z.string().optional().describe("密钥真值（仅 set 必填；来自用户消息，存入后不要复述）"),
  }),

  execute: async ({
    reasoning,
    action,
    name,
    value,
  }: {
    reasoning: string;
    action: "list" | "set" | "delete";
    name?: string;
    value?: string;
  }) => {
    const meta = { reasoning, action };
    try {
      if (action === "list") {
        const names = await secretListUser();
        return {
          results: {
            success: true,
            names,
            message:
              names.length > 0 ? `保管箱中有 ${names.length} 个密钥（仅名称）：${names.join("、")}` : "保管箱为空",
          },
          meta,
        };
      }

      const trimmedName = name?.trim() ?? "";
      if (!NAME_RE.test(trimmedName)) {
        return {
          results: {
            success: false,
            message: "密钥名称不合法：需 1-64 位，仅限字母/数字/下划线/连字符（如 GITHUB_TOKEN）",
          },
          meta,
        };
      }

      if (action === "set") {
        const trimmedValue = value?.trim() ?? "";
        if (!trimmedValue) {
          return { results: { success: false, message: "set 需要提供 value" }, meta };
        }
        if (trimmedValue.startsWith("{{secret:")) {
          return {
            results: { success: false, message: "value 不能是 {{secret:...}} 占位符，必须是真实密钥" },
            meta,
          };
        }
        await secretUserSet(trimmedName, trimmedValue);
        return {
          results: {
            success: true,
            message: `密钥「${trimmedName}」已存入保管箱。后续配置请写 {{secret:${trimmedName}}}（请勿在回复中复述密钥真值）`,
          },
          meta: { ...meta, name: trimmedName },
        };
      }

      // delete
      await secretUserDelete(trimmedName);
      return {
        results: { success: true, message: `密钥「${trimmedName}」已从保管箱删除` },
        meta: { ...meta, name: trimmedName },
      };
    } catch (error) {
      return {
        results: { success: false, message: `操作失败：${error instanceof Error ? error.message : String(error)}` },
        meta,
      };
    }
  },
});
