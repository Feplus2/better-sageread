/**
 * MCP 运行时连接管理器（批次 B3）：按 Agent scope 连接启用的远程 MCP server，
 * 拉取工具集并以 `mcp_{serverKey}_{toolName}` 键合并进聊天工具集。
 *
 * B1 开工验证结论（ai@5.0.44）：
 * - `createMCPClient` / `MCPTransport` / `MCPClientError` / `JSONRPCMessage`
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
import { type ToolImageBytes, sanitizeMcpToolResultImages } from "@/ai/utils/tool-result-slimming";
import { secretResolveBatch } from "@/services/secret-service";
import { useAgentConfirmStore } from "@/store/agent-confirm-store";
import { useAgentSettingsStore } from "@/store/agent-settings-store";
import { type McpServer, useMcpStore } from "@/store/mcp-store";
import type { AgentScope } from "@/store/quick-command-store";
import { createMCPClient } from "@ai-sdk/mcp";
import { appDataDir } from "@tauri-apps/api/path";
import { BaseDirectory, mkdir, writeFile } from "@tauri-apps/plugin-fs";
import type { Tool } from "ai";
import { SseLegacyMcpTransport, StreamableHttpMcpTransport } from "./mcp-transport";
import { TauriStdioMcpTransport } from "./tauri-stdio-transport";

type McpClient = Awaited<ReturnType<typeof createMCPClient>>;

export interface McpScopeResult {
  /** 已合并的工具（键带 mcp_ 前缀，可直接并入 streamText tools） */
  tools: Record<string, Tool>;
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
    return createMCPClient({
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
  return createMCPClient({
    transport,
    name: "sageread-mcp-client",
    // 吞掉未捕获错误（连接失败已在 failures 汇总，避免污染控制台）
    onUncaughtError: () => {},
  });
}

/** MCP 图片落盘目录（相对 {appData}）：重启后 readImage 仍可按绝对路径重看 */
const MCP_IMAGE_DIR = "image-cache/mcp";
/** MIME → 文件扩展名（readImage 按魔数识别，扩展名只影响可读性） */
const MCP_IMAGE_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};
/** 目录创建/绝对根缓存：成功一次后复用；失败不缓存（下轮可重试） */
let mcpImageDirReady: Promise<void> | null = null;
let mcpImageAbsBase: Promise<string> | null = null;

function ensureMcpImageDir(): Promise<void> {
  if (!mcpImageDirReady) {
    mcpImageDirReady = mkdir(MCP_IMAGE_DIR, { baseDir: BaseDirectory.AppData, recursive: true }).catch((error) => {
      mcpImageDirReady = null;
      throw error;
    });
  }
  return mcpImageDirReady;
}

function mcpImageCacheAbsDir(): Promise<string> {
  if (!mcpImageAbsBase) {
    mcpImageAbsBase = appDataDir()
      .then((base) => `${base.replace(/\\/g, "/").replace(/\/+$/, "")}/${MCP_IMAGE_DIR}`)
      .catch((error) => {
        mcpImageAbsBase = null;
        throw error;
      });
  }
  return mcpImageAbsBase;
}

/** 落盘文件名 ID：优先 crypto.randomUUID；老 WebView 不支持时退回时间戳+随机数（仍唯一可用） */
function newMcpImageId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 10)}`;
  }
}

/** dataUrl → 字节（base64）；解析失败返回 null（上层降级纯占位） */
function dataUrlToBytes(dataUrl: string): Uint8Array | null {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) return null;
  try {
    const binary = atob(dataUrl.slice(comma + 1));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return null;
  }
}

/**
 * MCP 图片落盘（2026-10-23 用户拍板口径）：当前轮模型看原图，跨轮/重启只留路径。
 * 成功返回绝对路径（放进占位文案，readImage 可直接读）；任何一步失败返回 null —
 * 上层会降级为"落盘失败已省略"纯占位，绝不把 base64 交给 UI/线程/模型历史。
 */
async function saveMcpImageToDisk(image: ToolImageBytes): Promise<string | null> {
  try {
    const bytes = dataUrlToBytes(image.dataUrl);
    if (!bytes) return null;
    await ensureMcpImageDir();
    const ext = MCP_IMAGE_EXT[image.mediaType.toLowerCase()] ?? "png";
    const filename = `${newMcpImageId()}.${ext}`;
    await writeFile(`${MCP_IMAGE_DIR}/${filename}`, bytes, { baseDir: BaseDirectory.AppData });
    return `${await mcpImageCacheAbsDir()}/${filename}`;
  } catch (error) {
    console.warn("[mcp-image] 图片落盘失败，已降级为纯文本占位:", error);
    return null;
  }
}

/**
 * MCP 工具结果图片收口（2026-10-23 口径）：MCP server 的图片 content 是 @ai-sdk/mcp 的原始形状
 * { type:"image", data:"<裸base64>", mimeType }。execute 返回时：
 * ① 逐张落盘到 {appData}/image-cache/mcp/<uuid>.<ext>，输出里的图片 part 换成带绝对路径的占位；
 * ② 落盘成功的图片按 toolCallId 进内存缓存（origin=mcp）——当轮 native / chat 桥仍能让模型看到图，
 *    跨轮/历史按 origin 跳过回灌，只留路径占位（重启后 readImage 按路径重看）。
 * 文本型 MCP 结果原样返回（引用相等=零改动）。
 */
function wrapMcpToolImageOutput(tool: Tool): Tool {
  const originalExecute = tool.execute;
  if (typeof originalExecute !== "function") return tool;
  return {
    ...tool,
    execute: async (args: any, options: any) => {
      const result = await originalExecute(args, options);
      // 参数校验失败/服务端 isError 结果等非图片输出原样返回（引用相等=零拷贝）
      return sanitizeMcpToolResultImages(
        result,
        typeof options?.toolCallId === "string" ? options.toolCallId : undefined,
        { saveImage: saveMcpImageToDisk },
      );
    },
  } as Tool;
}

/**
 * 连接当前 scope 下全部启用的 MCP server，聚合工具集。
 * 单个 server 失败不阻塞其他 server（降级进 failures，由调用方提示）。
 */
export async function getMcpToolsForScope(scope: AgentScope): Promise<McpScopeResult> {
  const tools: Record<string, Tool> = {};
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
          // 先包图片收口（保留 MCP Tool 的 toModelOutput，native 通道文本型结果行为不变）
          const wrapped = wrapMcpToolImageOutput(tool as Tool);
          tools[`${prefix}${toolName}`] = {
            ...wrapped,
            description: `[${server.name}] ${tool.description ?? ""}`,
          } as Tool;
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

/** 找已配置且启用的 Zotero Brain server（按名字含 zotero 判定，P2 参考文献卡片「获取 PDF」用） */
export function findZoteroBrainServer(): McpServer | undefined {
  return useMcpStore.getState().servers.find((s) => s.enabled && s.name.toLowerCase().includes("zotero"));
}

/**
 * 非聊天场景直调 MCP 工具（最小封装）：单 server 连接 → 拉工具 → 执行 → 关闭。
 * 聊天链路（getMcpToolsForScope）不变；stdio server 沿用同款启动确认卡。
 * execute 带独立超时（默认 3 分钟，覆盖多源下载瀑布），防 server 中途死亡导致悬挂。
 */
export async function callMcpServerTool(
  server: McpServer,
  toolName: string,
  args: Record<string, unknown>,
  executeTimeoutMs = 180_000,
): Promise<unknown> {
  if (server.transport === "stdio") await confirmStdioLaunch(server);
  const client = await withTimeout(connectServer(server), CONNECT_TIMEOUT_MS, `连接「${server.name}」`);
  try {
    const toolSet = await withTimeout(client.tools(), CONNECT_TIMEOUT_MS, `拉取「${server.name}」工具列表`);
    const tool = toolSet[toolName] as Tool | undefined;
    if (!tool || typeof tool.execute !== "function") {
      throw new Error(`「${server.name}」未提供工具 ${toolName}`);
    }
    return await withTimeout(
      tool.execute(args, { toolCallId: `direct-${Date.now()}`, messages: [] } as any),
      executeTimeoutMs,
      `执行「${server.name}」的 ${toolName}`,
    );
  } finally {
    await client.close().catch(() => {});
  }
}

/** MCP 工具返回值（TextContent 数组）→ 解析 JSON 负载；非 JSON 原样返回文本 */
export function parseMcpToolJson(result: unknown): any {
  const content = (result as any)?.content;
  const text = Array.isArray(content) ? content.find((c) => c?.type === "text")?.text : undefined;
  if (typeof text !== "string") return result;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
