import { type Tool, asSchema, tool as defineTool } from "ai";
import { z } from "zod";

/**
 * D8 工具目录牌 + 按需说明书（2026-08-21，业界对照 Anthropic Tool Search Tool / RAG-MCP）：
 * 工具池超预算（>30 个或 schema >12k 字符）时切换"目录牌模式"——
 * 全量注入的只剩一张目录牌（名字 + 一句话），模型经 describeTool 取完整参数说明、
 * 经 useTool 执行（转发到已过安全守卫的真实工具，确认卡语义不变）。
 * 机制对齐 MCP 官方渐进式披露；预算守门保证用户乱挂连接器也不失控（目录牌随连接器数近似线性、
 * 不再随 schema 总量膨胀）。
 */

export const DIRECTORY_BUDGET_TOOLS = 30;
export const DIRECTORY_BUDGET_CHARS = 12_000;

/** 估算工具集 schema 常驻体积（与 cdp-context-audit 同口径） */
export function estimateToolsChars(tools: Record<string, Tool>): number {
  let total = 0;
  for (const t of Object.values(tools)) {
    total += JSON.stringify({ d: (t as any).description, p: (t as any).inputSchema }).length;
  }
  return total;
}

/** 预算守门：数量或体积任一超线 → 目录牌模式 */
export function shouldUseDirectoryMode(tools: Record<string, Tool>): boolean {
  const count = Object.keys(tools).length;
  if (count > DIRECTORY_BUDGET_TOOLS) return true;
  return estimateToolsChars(tools) > DIRECTORY_BUDGET_CHARS;
}

/** 描述压成一句话（首个换行/句号前，最长 60 字） */
function oneLiner(description: string | undefined): string {
  if (!description) return "";
  const firstLine = description.split("\n")[0] ?? "";
  const cut = firstLine.replace(/[。；;．.]\s*$/, "");
  return cut.length > 60 ? `${cut.slice(0, 60)}…` : cut;
}

/** 把 FlexibleSchema（zod/jsonSchema 包装）序列化为干净 JSON Schema 文本 */
function serializeSchema(schema: unknown): string {
  if (schema == null) return "{}";
  try {
    return JSON.stringify(asSchema(schema as any).jsonSchema ?? {});
  } catch {
    try {
      return JSON.stringify(schema);
    } catch {
      return "{}";
    }
  }
}

/** 目录牌文本：内置工具 + 连接器（mcp_* 按服务器分组），每行一条一句话 */ export function buildToolDirectoryBoard(
  tools: Record<string, Tool>,
): string {
  const builtin: string[] = [];
  const mcpByServer = new Map<string, string[]>();
  for (const [name, t] of Object.entries(tools)) {
    if (name === "describeTool" || name === "useTool") continue;
    const line = `${name}：${oneLiner((t as any).description)}`;
    if (name.startsWith("mcp_")) {
      const serverKey = name.split("_")[1] ?? "未知";
      if (!mcpByServer.has(serverKey)) mcpByServer.set(serverKey, []);
      mcpByServer.get(serverKey)!.push(line);
    } else {
      builtin.push(line);
    }
  }
  const parts: string[] = ["—— 工具目录牌（按需取说明书） ——"];
  parts.push("调用任何工具前：① 先用 describeTool 查该工具的完整参数说明；② 再用 useTool 以 {tool, args} 执行。");
  parts.push("说明：参数说明每次会话按需获取即可；执行任何工具都走 useTool。当前可用工具：");
  if (builtin.length) parts.push(`【内置】\n${builtin.join("\n")}`);
  for (const [serverKey, lines] of mcpByServer) {
    parts.push(`【连接器 ${serverKey}】\n${lines.join("\n")}`);
  }
  return parts.join("\n\n");
}

/**
 * 构建惰性工具集（目录牌模式下的请求工具面）：
 * - describeTool(name)：返回完整 description + 参数 schema（JSON）
 * - useTool(tool, args)：转发到真实工具的 execute（真实工具已过安全守卫包装，确认卡语义不变）
 */
export function buildLazyToolset(tools: Record<string, Tool>): Record<string, Tool> {
  const available = Object.keys(tools).filter((n) => n !== "describeTool" && n !== "useTool");

  const describeTool = defineTool({
    description: `查工具的完整参数说明书。输入工具名（见工具目录牌），返回该工具的用途详述与参数 JSON Schema。
第一次使用任何工具前必查；参数校验失败时也应重查确认字段名。`,
    inputSchema: z.object({
      tool: z.string().min(1).describe("工具名，如 ragSearch / getBooks / mcp_xxx_yyy"),
    }),
    execute: async ({ tool: name }: { tool: string }) => {
      const real = tools[name];
      if (!real) {
        return {
          success: false,
          error: `未找到工具「${name}」`,
          available_tools: available,
        };
      }
      return {
        success: true,
        name,
        description: (real as any).description ?? "",
        // v7 的 inputSchema 是 FlexibleSchema（zod 等）——经 asSchema 转成干净 JSON Schema 再序列化
        input_schema: serializeSchema((real as any).inputSchema),
        usage: "把参数按此 schema 组装为 useTool 的 args 后执行",
      };
    },
  });

  const useTool = defineTool({
    description: `执行工具（统一入口）。args 为该工具的参数对象——先用 describeTool 查参数说明，不要凭猜测传参。
写入/执行/外发类操作会弹确认卡由用户裁决，属正常流程。`,
    inputSchema: z.object({
      tool: z.string().min(1).describe("工具名（见工具目录牌）"),
      args: z.record(z.string(), z.any()).describe("该工具的参数对象（结构以 describeTool 返回的 schema 为准）"),
    }),
    execute: async ({ tool: name, args }: { tool: string; args: Record<string, unknown> }, options: any) => {
      const real = tools[name];
      if (!real) {
        return {
          success: false,
          error: `未找到工具「${name}」`,
          available_tools: available,
        };
      }
      if (typeof real.execute !== "function") {
        return { success: false, error: `工具「${name}」不可执行` };
      }
      try {
        return await real.execute(args, options);
      } catch (error) {
        return {
          success: false,
          error: `执行失败：${error instanceof Error ? error.message : String(error)}`,
          hint: "参数不符时先用 describeTool 重查参数说明",
        };
      }
    },
  });

  return { describeTool, useTool };
}
