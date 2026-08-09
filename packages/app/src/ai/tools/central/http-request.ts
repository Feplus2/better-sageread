/**
 * 全局助手工具：通用 HTTP 请求
 *
 * 基础设施级工具——使中央 Agent 能与任意外部 API 交互。
 * 用户通过 Skill（SOP）描述目标服务的 endpoint / headers / body 格式，
 * Agent 即可按指引调用，无需为每个服务写专用工具。
 *
 * 批次 A：请求由 Rust 侧 agent_http_request 发射，URL/headers/body 中的
 * {{secret:NAME}} 在执行边界替换为保管箱真值——模型只见占位符，真值不进上下文。
 */
import { invoke } from "@tauri-apps/api/core";
import { tool } from "ai";
import { z } from "zod";

interface AgentHttpResult {
  status: number;
  statusText: string;
  body: string;
}

export const httpRequestTool = tool({
  description: `发送通用 HTTP 请求，用于对接任意第三方 API（IMA、Notion、Obsidian 等）。

🎯 **核心功能**：
• 支持 GET / POST / PUT / PATCH / DELETE
• 自定义 headers（如 Authorization）和 body
• 走 Tauri 原生网络栈，无 CORS 限制
• url/headers/body 中可写 {{secret:名称}} 引用密钥保管箱的真值（模型上下文不会出现真实密钥）

⚠️ **使用前提**：
• 用户需在 Skill 或对话中提供目标 API 的地址、鉴权方式和请求格式
• 敏感凭据建议用户存入 设置 → 密钥保管箱，并在 Skill 中以 {{secret:名称}} 引用

📊 **返回内容**：
HTTP 状态码 + 响应体（截断至 8000 字符）`,

  inputSchema: z.object({
    reasoning: z.string().min(1).describe("调用此工具的原因"),
    url: z.string().min(1).describe("完整的请求 URL（支持 {{secret:名称}} 引用）"),
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("GET").describe("HTTP 方法"),
    headers: z
      .record(z.string())
      .optional()
      .describe("请求头（如 Authorization、Content-Type；值支持 {{secret:名称}}）"),
    body: z.string().optional().describe("请求体（JSON 字符串或其他文本；支持 {{secret:名称}}）"),
  }),

  execute: async ({
    reasoning,
    url,
    method,
    headers,
    body,
  }: {
    reasoning: string;
    url: string;
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    headers?: Record<string, string>;
    body?: string;
  }) => {
    try {
      const res = await invoke<AgentHttpResult>("agent_http_request", {
        method,
        url,
        headers: { "Content-Type": "application/json", ...headers },
        body: method !== "GET" ? body : null,
      });
      return {
        results: {
          success: res.status >= 200 && res.status < 300,
          status: res.status,
          statusText: res.statusText,
          body: res.body,
        },
        meta: { reasoning, url, method },
      };
    } catch (error) {
      return {
        results: {
          success: false,
          status: 0,
          statusText: "Network Error",
          body: error instanceof Error ? error.message : String(error),
        },
        meta: { reasoning, url, method },
      };
    }
  },
});
