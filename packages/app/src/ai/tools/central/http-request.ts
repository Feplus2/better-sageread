/**
 * 全局助手工具：通用 HTTP 请求
 *
 * 基础设施级工具——使中央 Agent 能与任意外部 API 交互。
 * 用户通过 Skill（SOP）描述目标服务的 endpoint / headers / body 格式，
 * Agent 即可按指引调用，无需为每个服务写专用工具。
 */
import { fetch as fetchTauri } from "@tauri-apps/plugin-http";
import { tool } from "ai";
import { z } from "zod";

export const httpRequestTool = tool({
  description: `发送通用 HTTP 请求，用于对接任意第三方 API（IMA、Notion、Obsidian 等）。

🎯 **核心功能**：
• 支持 GET / POST / PUT / PATCH / DELETE
• 自定义 headers（如 Authorization）和 body
• 走 Tauri 原生网络栈，无 CORS 限制

⚠️ **使用前提**：
• 用户需在 Skill 或对话中提供目标 API 的地址、鉴权方式和请求格式
• 敏感凭据（API Key / Token）由用户在对话或 Skill 中给出

📊 **返回内容**：
HTTP 状态码 + 响应体（截断至 8000 字符）`,

  inputSchema: z.object({
    reasoning: z.string().min(1).describe("调用此工具的原因"),
    url: z.string().url().describe("完整的请求 URL"),
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("GET").describe("HTTP 方法"),
    headers: z.record(z.string()).optional().describe("请求头（如 Authorization、Content-Type）"),
    body: z.string().optional().describe("请求体（JSON 字符串或其他文本）"),
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
      const response = await fetchTauri(url, {
        method,
        headers: {
          "Content-Type": "application/json",
          ...headers,
        },
        body: method !== "GET" ? body : undefined,
      });

      const text = await response.text();
      const truncated = text.length > 8000 ? `${text.slice(0, 8000)}\n...[截断，共 ${text.length} 字符]` : text;

      return {
        results: {
          success: response.ok,
          status: response.status,
          statusText: response.statusText,
          body: truncated,
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
