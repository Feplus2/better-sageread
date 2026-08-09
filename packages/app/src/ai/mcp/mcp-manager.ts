/**
 * MCP 运行时连接管理器（批次 B3）：按 Agent scope 连接启用的远程 MCP server，
 * 拉取工具集并以 `mcp_{serverKey}_{toolName}` 键合并进聊天工具集。
 *
 * B1 开工验证结论（ai@5.0.44）：
 * - `experimental_createMCPClient` / `MCPTransport` / `MCPClientError` / `JSONRPCMessage`
 *   均直接从 `ai` 包导出，无需 `@ai-sdk/mcp`；
 * - 配置式 transport 仅支持 `{ type: 'sse' }`，Streamable HTTP 必须传自定义 MCPTransport
 *   对象（见 mcp-transport.ts）；
 * - `client.tools()` 返回 ToolSet（Record<string, Tool>），可直接并入 streamText 的 tools；
 * - webview 内置 fetch 受 CORS 限制而多数远程 MCP server 不下发 CORS 头，
 *   故传输层统一走 @tauri-apps/plugin-http 的 fetch（Rust 侧出网），
 *   不新增 @modelcontextprotocol/sdk 依赖，也无需 Rust 代理兜底。
 *
 * 生命周期（v1 简单方案）：跟随单次聊天请求创建，streamText 结束后 closeAll 关闭；
 * TODO（后续批次）：常驻连接缓存 + 断线重连，避免每次请求重复握手。
 *
 * 批次 D：stdio 传输经 Rust 子进程桥（TauriStdioMcpTransport），启动前按安全模式弹确认卡。
 */
import { secretResolveBatch } from "@/services/secret-service";
import { useAgentConfirmStore } from "@/store/agent-confirm-store";
import { useAgentSettingsStore } from "@/store/agent-settings-store";
import { type McpServer, useMcpStore } from "@/store/mcp-store";
import type { AgentScope } from "@/store/quick-command-store";
import { type CoreTool, experimental_createMCPClient } from "ai";
import { SseLegacyMcpTransport, StreamableHttpMcpTransport } from "./mcp-transport";
import { TauriStdioMcpTransport } from "./tauri-stdio-transport";

type McpClient = Awaited<ReturnType<typeof experimental_createMCPClient>>;

export interface McpScopeResult {
  /** 已合并的工具（键带 mcp_ 前缀，可直接并入 streamText tools） */
  tools: Record<string, CoreTool>;
  /** 连接/拉取失败的 server（不阻塞其他 server，由调用方提示用户） */
  failures: Array<{ server: string; error: string }>;
  /** 关闭本次请求创建的全部客户端（streamText onFinish 调用） */
  closeAll: () => Promise<void>;
}

/** 单 server 连接 + 拉工具列表的超时上限 */
const CONNECT_TIMEOUT_MS = 10_000;

/** server 名 → 工具键片段：非字母数字一律转下划线（模型工具名仅允许 [A-Za-z0-9_-]） */
export function sanitizeServerKey(name: string): string {
  return name.replace(/[^A-Za-z0-9]/g, "_") || "server";
}

/**
 * 超时包装：超时即 reject。若底层 promise 超时后仍成功（慢连接/慢握手），
 * 由 onLateResolve 兜底回收（关闭客户端、杀子进程），防句柄/进程泄漏。
 */
function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
  onLateResolve?: (value: T) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      reject(new Error(`${label}：超时（${ms / 1000}s）`));
      if (onLateResolve) {
        promise.then(
          (value) => onLateResolve(value),
          () => {},
        );
      }
    }, ms);
    promise.then(
      (value) => {
        if (timedOut) return;
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        if (timedOut) return;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** 请求头值支持 {{secret:NAME}} 引用（批次 A3），创建 transport 前批量替换 */
async function resolveHeaders(headers: Record<string, string> | undefined): Promise<Record<string, string>> {
  if (!headers || Object.keys(headers).length === 0) return {};
  const keys = Object.keys(headers);
  try {
    const values = await secretResolveBatch(keys.map((k) => headers[k]));
    return Object.fromEntries(keys.map((k, i) => [k, values[i]]));
  } catch {
    // keyring 不可用时原样透传（含占位符会被服务端拒绝，failure 里可见）
    return { ...headers };
  }
}

/** stdio server 启动确认卡（批次 D，语义同 B4：strict/relaxed 确认、full 静默；
 * 「不再询问」按 server 维度记忆，仅内存）。拒绝则抛错进 failures 降级。 */
async function confirmStdioLaunch(server: McpServer): Promise<void> {
  const { safetyMode } = useAgentSettingsStore.getState();
  if (safetyMode === "full") return;
  const cmdline = [server.command?.trim() ?? "", ...(server.args ?? [])].filter(Boolean).join(" ");
  const approved = await useAgentConfirmStore.getState().requestConfirmation({
    toolName: "mcpStdioLaunch",
    title: "启动本地进程",
    detail: `MCP 服务器「${server.name}」将启动本地命令：${cmdline}`,
    dontAskKey: `mcpStdio:${sanitizeServerKey(server.name)}`,
  });
  if (!approved) {
    throw new Error("用户已取消启动本地进程");
  }
}

async function connectServer(server: McpServer): Promise<McpClient> {
  // stdio：Rust 子进程桥（env 的 {{secret:NAME}} 在 Rust 侧替换，真值不进 JS）
  if (server.transport === "stdio") {
    if (!server.command?.trim()) {
      throw new Error("缺少 command 配置");
    }
    // 注：启动确认卡（confirmStdioLaunch）由调用方在超时窗外完成
    const transport = new TauriStdioMcpTransport({
      serverId: server.id,
      command: server.command.trim(),
      args: server.args ?? [],
      env: server.env ?? {},
    });
    return experimental_createMCPClient({
      transport,
      name: "sageread-mcp-client",
      onUncaughtError: () => {},
    });
  }
  if (!server.url) {
    throw new Error("缺少 url 配置");
  }
  const headers = await resolveHeaders(server.headers);
  const transport =
    server.transport === "sse"
      ? new SseLegacyMcpTransport(server.url, headers)
      : new StreamableHttpMcpTransport(server.url, headers);
  return experimental_createMCPClient({
    transport,
    name: "sageread-mcp-client",
    // 吞掉未捕获错误（连接失败已在 failures 汇总，避免污染控制台）
    onUncaughtError: () => {},
  });
}

/**
 * 连接当前 scope 下全部启用的 MCP server，聚合工具集。
 * 单个 server 失败不阻塞其他 server（降级进 failures，由调用方提示）。
 */
export async function getMcpToolsForScope(scope: AgentScope): Promise<McpScopeResult> {
  const tools: Record<string, CoreTool> = {};
  const failures: Array<{ server: string; error: string }> = [];
  const clients: McpClient[] = [];

  const servers = useMcpStore.getState().servers.filter((s) => s.enabled && s.scope.includes(scope));

  await Promise.all(
    servers.map(async (server) => {
      try {
        // stdio 启动确认卡放在超时窗外：用户读卡耗时不受 10s 限制，
        // 也避免"超时判失败后才点同意"导致进程 spawn 出来却无人持有（泄漏）
        if (server.transport === "stdio") {
          if (!server.command?.trim()) {
            throw new Error("缺少 command 配置");
          }
          await confirmStdioLaunch(server);
        }
        const client = await withTimeout(
          connectServer(server),
          CONNECT_TIMEOUT_MS,
          `连接「${server.name}」`,
          (lateClient) => {
            // 超时后连接才成功：立即关闭，防客户端/子进程泄漏
            void lateClient.close().catch(() => {});
          },
        );
        clients.push(client);
        const toolSet = await withTimeout(client.tools(), CONNECT_TIMEOUT_MS, `拉取「${server.name}」工具列表`);
        const prefix = `mcp_${sanitizeServerKey(server.name)}_`;
        for (const [toolName, tool] of Object.entries(toolSet)) {
          tools[`${prefix}${toolName}`] = {
            ...tool,
            description: `[${server.name}] ${tool.description ?? ""}`,
          } as CoreTool;
        }
      } catch (error) {
        failures.push({
          server: server.name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }),
  );

  let closed = false;
  return {
    tools,
    failures,
    closeAll: async () => {
      // 幂等：onFinish 与 abort 监听双保险，只关一次
      if (closed) return;
      closed = true;
      await Promise.allSettled(clients.map((c) => c.close()));
    },
  };
}

/**
 * 从 mcp_ 前缀工具名反解来源 server 与原始工具名（tool-guard 确认卡用）。
 * 优先按当前 store 中 server 的 sanitize 名精确前缀匹配；server 已删除时退化为首个下划线切分。
 */
export function parseMcpToolName(
  toolName: string,
): { serverKey: string; serverName?: string; originalTool: string } | null {
  if (!toolName.startsWith("mcp_")) return null;
  const rest = toolName.slice(4);
  for (const server of useMcpStore.getState().servers) {
    const key = sanitizeServerKey(server.name);
    if (rest.startsWith(`${key}_`)) {
      return { serverKey: key, serverName: server.name, originalTool: rest.slice(key.length + 1) };
    }
  }
  const idx = rest.indexOf("_");
  if (idx <= 0) return null;
  return { serverKey: rest.slice(0, idx), originalTool: rest.slice(idx + 1) };
}
