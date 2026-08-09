/**
 * 全局助手工具：管理 MCP 服务器配置（批次 B5）
 *
 * 使 Agent 能够按用户指令自助注册/维护 MCP server（写 mcp-store，配置即时生效）。
 * 安全：全部动作经 tool-guard Tier 2 确认卡；create/delete 恒确认（不受「不再询问」影响）。
 * 密钥规范：env/headers 中的密钥一律引导 {{secret:NAME}} 占位（执行边界替换，模型不见真值）。
 */
import { type McpServer, useMcpStore } from "@/store/mcp-store";
import type { AgentScope } from "@/store/quick-command-store";
import { tool } from "ai";
import { z } from "zod";

const ALL_SCOPES: AgentScope[] = ["central", "reader", "paper"];

/** 接受数组或逗号分隔串；非法/空输入回退全选 */
function normalizeScopes(input: ("reader" | "central" | "paper")[] | string | undefined): AgentScope[] {
  const list = Array.isArray(input) ? input : String(input ?? "").split(/[,\s]+/);
  const parsed = list.filter((s): s is AgentScope => s === "reader" || s === "central" || s === "paper");
  return parsed.length > 0 ? parsed : ALL_SCOPES;
}

/** 按名称模糊匹配现有 server（精确优先） */
function findServer(nameOrId: string) {
  const servers = useMcpStore.getState().servers;
  const q = nameOrId.trim().toLowerCase();
  return (
    servers.find((s) => s.id === nameOrId || s.name.toLowerCase() === q) ??
    servers.find((s) => s.name.toLowerCase().includes(q))
  );
}

function serverSummary(s: { id: string; name: string; transport: string; enabled: boolean; scope: AgentScope[] }) {
  return { id: s.id, name: s.name, transport: s.transport, enabled: s.enabled, scope: s.scope };
}

export const manageMcpTool = tool({
  description: `管理 MCP 服务器配置（注册/更新/启停/删除，配置即时生效）。

🎯 **核心功能**：
• list：列出已配置的 MCP 服务器及其状态
• create：新增 MCP 服务器（远程传输 http/sse 需 url；stdio 需 command）
• update：按名称修改已有服务器配置（url/headers/env/scope 等，只传需要改的字段）
• toggle：启用/停用某个服务器
• delete：删除某个服务器

📋 **典型场景**：
• 用户说"帮我装/加一个 XX MCP" → 询问齐 url 等必要信息后 create
• 用户给出 MCP 的 endpoint/认证头 → create 或 update
• 用户问"配了哪些 MCP" → list

⚠️ **密钥规范**：headers/env 中的密钥绝不写明文，一律使用 {{secret:NAME}} 占位
（NAME 为用户在密钥保管箱中保存的名称），执行时自动替换。

📊 **返回内容**：操作结果与服务器配置摘要（不含密钥真值）`,

  inputSchema: z.object({
    reasoning: z.string().min(1).describe("调用此工具的原因"),
    action: z
      .enum(["list", "create", "update", "toggle", "delete"])
      .describe("list=列出, create=新增, update=修改, toggle=启停, delete=删除"),
    name: z.string().optional().describe("服务器名称（create 必填；update/toggle/delete 用于定位）"),
    transport: z
      .enum(["http", "sse", "stdio"])
      .optional()
      .describe("传输方式：http=Streamable HTTP（推荐）, sse=旧版 SSE, stdio=本地命令（npx/uvx 等）"),
    url: z.string().optional().describe("远程服务器地址（http/sse 必填）"),
    command: z.string().optional().describe("stdio 启动命令（如 npx / uvx）"),
    args: z.array(z.string()).optional().describe("stdio 命令参数列表"),
    headers: z
      .record(z.string(), z.string())
      .optional()
      .describe("远程请求头（如 Authorization）；密钥值一律写 {{secret:NAME}}"),
    env: z.record(z.string(), z.string()).optional().describe("stdio 环境变量；密钥值一律写 {{secret:NAME}}"),
    // Gemini 兼容：不用 z.union（anyOf 在 Gemini 系端点/中转器上会被拒或捏造成坏 schema），
    // 收敛为逗号分隔串（normalizeScopes 运行期兼容数组输入）
    scope: z
      .string()
      .optional()
      .describe("生效 Agent 范围：逗号分隔串（如 'reader,central'），可选值 reader/central/paper，缺省全选"),
    enabled: z.boolean().optional().describe("create 时是否启用（缺省 true）"),
  }),

  execute: async ({
    reasoning,
    action,
    name,
    transport,
    url,
    command,
    args,
    headers,
    env,
    scope,
    enabled,
  }: {
    reasoning: string;
    action: "list" | "create" | "update" | "toggle" | "delete";
    name?: string;
    transport?: "http" | "sse" | "stdio";
    url?: string;
    command?: string;
    args?: string[];
    headers?: Record<string, string>;
    env?: Record<string, string>;
    scope?: ("reader" | "central" | "paper")[] | string;
    enabled?: boolean;
  }) => {
    const store = useMcpStore.getState();

    try {
      if (action === "list") {
        return {
          results: {
            success: true,
            servers: store.servers.map(serverSummary),
            message: store.servers.length === 0 ? "尚未配置 MCP 服务器" : `共 ${store.servers.length} 个服务器`,
          },
          meta: { reasoning },
        };
      }

      if (action === "create") {
        if (!name?.trim()) {
          return { results: { success: false, message: "create 需要提供 name" }, meta: { reasoning } };
        }
        const t = transport ?? "http";
        if ((t === "http" || t === "sse") && !url?.trim()) {
          return {
            results: { success: false, message: `传输方式 ${t} 需要提供 url` },
            meta: { reasoning },
          };
        }
        if (t === "stdio" && !command?.trim()) {
          return { results: { success: false, message: "stdio 传输需要提供 command" }, meta: { reasoning } };
        }
        if (store.servers.some((s) => s.name === name.trim())) {
          return {
            results: { success: false, message: `已存在同名服务器「${name}」，请改用 update` },
            meta: { reasoning },
          };
        }
        store.addServer({
          name: name.trim(),
          transport: t,
          url: t === "stdio" ? undefined : url?.trim(),
          command: t === "stdio" ? command?.trim() : undefined,
          args: t === "stdio" ? args : undefined,
          headers: t === "stdio" ? undefined : headers,
          env: t === "stdio" ? env : undefined,
          scope: normalizeScopes(scope),
          enabled: enabled ?? true,
          source: "manual",
        });
        const created = useMcpStore.getState().servers.at(-1);
        return {
          results: {
            success: true,
            message: `MCP 服务器「${name}」已创建${t === "stdio" ? "（stdio 首次启动会弹确认卡）" : ""}`,
            server: created ? serverSummary(created) : undefined,
          },
          meta: { reasoning },
        };
      }

      // update / toggle / delete 均需先定位目标
      if (!name?.trim()) {
        return { results: { success: false, message: `${action} 需要提供 name 定位服务器` }, meta: { reasoning } };
      }
      const target = findServer(name);
      if (!target) {
        return {
          results: {
            success: false,
            message: `没有找到服务器「${name}」。现有：${store.servers.map((s) => s.name).join("、") || "无"}`,
          },
          meta: { reasoning },
        };
      }

      if (action === "toggle") {
        store.toggleEnabled(target.id);
        const now = useMcpStore.getState().servers.find((s) => s.id === target.id);
        return {
          results: {
            success: true,
            message: `服务器「${target.name}」已${now?.enabled ? "启用" : "停用"}`,
            server: now ? serverSummary(now) : undefined,
          },
          meta: { reasoning },
        };
      }

      if (action === "delete") {
        store.removeServer(target.id);
        return {
          results: { success: true, message: `服务器「${target.name}」已删除` },
          meta: { reasoning },
        };
      }

      // update：只合并传入字段
      const updates: Partial<Omit<McpServer, "id">> = {};
      if (transport) updates.transport = transport;
      if (url !== undefined) updates.url = url.trim() || undefined;
      if (command !== undefined) updates.command = command.trim() || undefined;
      if (args !== undefined) updates.args = args;
      if (headers !== undefined) updates.headers = headers;
      if (env !== undefined) updates.env = env;
      if (scope !== undefined) updates.scope = normalizeScopes(scope);
      if (enabled !== undefined) updates.enabled = enabled;
      if (Object.keys(updates).length === 0) {
        return {
          results: { success: false, message: "update 没有提供任何需要修改的字段" },
          meta: { reasoning },
        };
      }
      store.updateServer(target.id, updates);
      const updated = useMcpStore.getState().servers.find((s) => s.id === target.id);
      return {
        results: {
          success: true,
          message: `服务器「${target.name}」已更新`,
          server: updated ? serverSummary(updated) : undefined,
        },
        meta: { reasoning },
      };
    } catch (error) {
      return {
        results: { success: false, message: `操作失败：${error instanceof Error ? error.message : String(error)}` },
        meta: { reasoning, action },
      };
    }
  },
});
