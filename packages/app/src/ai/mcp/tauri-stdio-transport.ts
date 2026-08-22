import type { JSONRPCMessage, MCPTransport } from "@ai-sdk/mcp";
/**
 * MCP stdio 传输（批次 D2）：本地 npm/uvx 类 MCP server 经 Rust 子进程桥通信。
 *
 * Rust 侧命令（core/mcp）：mcp_stdio_start（spawn + 读管道）/ mcp_stdio_write / mcp_stdio_close。
 * stdout 每行一条 JSON-RPC，经 `mcp-stdio://{sessionId}` 事件推达；进程退出经
 * `mcp-stdio-exit://{sessionId}` 通知。env 中 `{{secret:NAME}}` 在 Rust 侧替换，真值不进 JS。
 */
import { invoke } from "@tauri-apps/api/core";
import { type UnlistenFn, listen } from "@tauri-apps/api/event";

/** v7 起 @ai-sdk/mcp 不再导出 MCPClientError；本地等价类（MCPTransport.onerror 契约只要求 Error） */
class MCPClientError extends Error {
  constructor(options: { message: string }) {
    super(options.message);
    this.name = "MCPClientError";
  }
}

export interface TauriStdioTransportConfig {
  /** mcp-store 中的 server id（审计标识） */
  serverId: string;
  command: string;
  args: string[];
  /** 值可为 {{secret:NAME}} 占位符（Rust 侧替换） */
  env: Record<string, string>;
}

function parseJsonRpc(data: string): JSONRPCMessage | null {
  try {
    return JSON.parse(data) as JSONRPCMessage;
  } catch {
    return null;
  }
}

export class TauriStdioMcpTransport implements MCPTransport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  private sessionId: string | null = null;
  private unlisteners: UnlistenFn[] = [];
  private closed = false;

  constructor(private config: TauriStdioTransportConfig) {}

  async start(): Promise<void> {
    this.sessionId = await invoke<string>("mcp_stdio_start", {
      serverId: this.config.serverId,
      command: this.config.command,
      args: this.config.args,
      env: this.config.env,
    });

    const unlistenMessage = await listen<string>(`mcp-stdio://${this.sessionId}`, (event) => {
      const parsed = parseJsonRpc(event.payload);
      if (parsed) {
        this.onmessage?.(parsed);
      }
    });
    const unlistenExit = await listen<{ code: number | null }>(`mcp-stdio-exit://${this.sessionId}`, (event) => {
      if (this.closed) return;
      const code = event.payload?.code;
      this.onerror?.(
        new MCPClientError({
          message: `MCP stdio Transport: 子进程异常退出（code ${code ?? "unknown"}）`,
        }),
      );
      this.onclose?.();
    });
    this.unlisteners.push(unlistenMessage, unlistenExit);
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (this.closed || !this.sessionId) {
      throw new MCPClientError({ message: "MCP stdio Transport: 连接已关闭" });
    }
    try {
      await invoke("mcp_stdio_write", {
        sessionId: this.sessionId,
        message: JSON.stringify(message),
      });
    } catch (error) {
      const e = error instanceof Error ? error : new Error(String(error));
      this.onerror?.(new MCPClientError({ message: `MCP stdio Transport: ${e.message}` }));
      throw e;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.sessionId) {
      await invoke("mcp_stdio_close", { sessionId: this.sessionId }).catch(() => {});
    }
    for (const unlisten of this.unlisteners) {
      unlisten();
    }
    this.unlisteners = [];
    this.onclose?.();
  }
}
