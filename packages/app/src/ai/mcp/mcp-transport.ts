import type { JSONRPCMessage, MCPTransport } from "@ai-sdk/mcp";
/**
 * MCP 远程传输（批次 B）：Streamable HTTP 与 SSE 两类远程 MCP server 的传输实现。
 *
 * 关键取舍：webview 内置 fetch 受 CORS 限制，多数远程 MCP server 不下发 CORS 头，
 * 因此两类传输统一使用 @tauri-apps/plugin-http 的 fetch（Rust 侧出网，绕 CORS）。
 * 均实现 ai 包的 MCPTransport 接口（start/send/close + onmessage/onerror/onclose），
 * 直接传给 experimental_createMCPClient 的 transport 参数。
 */
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";

/** v7 起 @ai-sdk/mcp 不再导出 MCPClientError；本地等价类（MCPTransport.onerror 契约只要求 Error） */
class MCPClientError extends Error {
  constructor(options: { message: string }) {
    super(options.message);
    this.name = "MCPClientError";
  }
}

// ==================== SSE 流解析 ====================

interface SseEvent {
  event: string;
  data: string;
}

/**
 * 极简 SSE 事件解析器：按空行分事件，提取 event:/data: 字段。
 * 返回的 async generator 随流推进，流结束即终止。
 */
async function* parseSseStream(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += value;
      // 事件以空行分隔（兼容 \r\n）
      for (;;) {
        const sepIndex = buffer.search(/\r?\n\r?\n/);
        if (sepIndex === -1) break;
        const rawEvent = buffer.slice(0, sepIndex);
        buffer = buffer.slice(sepIndex).replace(/^\r?\n\r?\n/, "");
        let event = "message";
        const dataLines: string[] = [];
        for (const line of rawEvent.split(/\r?\n/)) {
          if (line.startsWith("event:")) {
            event = line.slice(6).trim();
          } else if (line.startsWith("data:")) {
            dataLines.push(line.slice(5).replace(/^ /, ""));
          }
        }
        if (dataLines.length > 0) {
          yield { event, data: dataLines.join("\n") };
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function parseJsonRpc(data: string): JSONRPCMessage | null {
  try {
    return JSON.parse(data) as JSONRPCMessage;
  } catch {
    return null;
  }
}

// ==================== Streamable HTTP 传输 ====================

/**
 * Streamable HTTP 传输（MCP 规范 2025-03-26）：
 * - 所有 JSON-RPC 消息 POST 到同一 endpoint；
 * - 响应可能是 application/json（单条消息）或 text/event-stream（消息流）；
 * - initialize 响应头 Mcp-Session-Id 需在后续请求携带；
 * - 通知类消息服务端可能返回 202 Accepted（无响应体）。
 */
export class StreamableHttpMcpTransport implements MCPTransport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  private sessionId: string | null = null;
  private abortController = new AbortController();
  private closed = false;

  constructor(
    private url: string,
    private headers: Record<string, string> = {},
  ) {}

  async start(): Promise<void> {
    // Streamable HTTP 无连接建立阶段，首条 initialize 即握手
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (this.closed) {
      throw new MCPClientError({ message: "MCP Streamable HTTP Transport: 连接已关闭" });
    }
    const headers: Record<string, string> = {
      ...this.headers,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    if (this.sessionId) {
      headers["Mcp-Session-Id"] = this.sessionId;
    }

    let response: Response;
    try {
      response = await tauriFetch(this.url, {
        method: "POST",
        headers,
        body: JSON.stringify(message),
        signal: this.abortController.signal,
      });
    } catch (error) {
      const e = error instanceof Error ? error : new Error(String(error));
      this.onerror?.(new MCPClientError({ message: `MCP Streamable HTTP Transport: 请求失败（${e.message}）` }));
      throw e;
    }

    // 会话 ID（initialize 响应下发）
    const sid = response.headers.get("mcp-session-id");
    if (sid) {
      this.sessionId = sid;
    }

    // 通知类消息：服务端可返回 202 Accepted 无响应体
    if (response.status === 202) {
      return;
    }
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      const error = new MCPClientError({
        message: `MCP Streamable HTTP Transport: HTTP ${response.status} ${text.slice(0, 200)}`,
      });
      this.onerror?.(error);
      throw error;
    }
    if (!response.body) {
      return;
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("text/event-stream")) {
      // 后台消费事件流，逐条分发消息（不阻塞 send 返回）
      this.consumeSse(response.body);
    } else {
      const text = await response.text();
      if (text.trim()) {
        const parsed = parseJsonRpc(text);
        if (parsed) {
          this.onmessage?.(parsed);
        }
      }
    }
  }

  private consumeSse(body: ReadableStream<Uint8Array>): void {
    (async () => {
      try {
        for await (const ev of parseSseStream(body)) {
          if (ev.event === "message") {
            const parsed = parseJsonRpc(ev.data);
            if (parsed) {
              this.onmessage?.(parsed);
            }
          }
        }
      } catch (error) {
        if (!this.closed) {
          this.onerror?.(
            new MCPClientError({
              message: `MCP Streamable HTTP Transport: SSE 流读取失败（${error instanceof Error ? error.message : String(error)}）`,
            }),
          );
        }
      }
    })();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.abortController.abort();
    // 尽力通知服务端终止会话（失败不影响本地关闭）
    if (this.sessionId) {
      tauriFetch(this.url, {
        method: "DELETE",
        headers: { ...this.headers, "Mcp-Session-Id": this.sessionId },
      }).catch(() => {});
    }
    this.onclose?.();
  }
}

// ==================== SSE 传输（legacy，兼容保留） ====================

/**
 * HTTP+SSE 传输（旧版 MCP 传输，已弃用但生态仍有 server 在用）：
 * - GET endpoint 建立 SSE 长连接，服务端先下发 event: endpoint 指定 POST 地址；
 * - 客户端向该地址 POST JSON-RPC，响应经 SSE 流的 event: message 回传。
 */
export class SseLegacyMcpTransport implements MCPTransport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  private postUrl: string | null = null;
  private abortController = new AbortController();
  private connected = false;

  constructor(
    private url: string,
    private headers: Record<string, string> = {},
  ) {}

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      (async () => {
        try {
          const response = await tauriFetch(this.url, {
            method: "GET",
            headers: { ...this.headers, Accept: "text/event-stream" },
            signal: this.abortController.signal,
          });
          if (!response.ok || !response.body) {
            const error = new MCPClientError({
              message: `MCP SSE Transport: HTTP ${response.status} ${response.statusText}`,
            });
            this.onerror?.(error);
            reject(error);
            return;
          }
          // 后台消费 SSE 流
          (async () => {
            try {
              for await (const ev of parseSseStream(response.body!)) {
                if (ev.event === "endpoint") {
                  // endpoint 可能是相对路径
                  this.postUrl = new URL(ev.data, this.url).href;
                  this.connected = true;
                  resolve();
                } else if (ev.event === "message") {
                  const parsed = parseJsonRpc(ev.data);
                  if (parsed) {
                    this.onmessage?.(parsed);
                  }
                }
              }
              if (this.connected && !this.abortController.signal.aborted) {
                this.onerror?.(new MCPClientError({ message: "MCP SSE Transport: 连接被服务端关闭" }));
              }
            } catch (error) {
              if (this.abortController.signal.aborted) return;
              const e = error instanceof Error ? error : new Error(String(error));
              this.onerror?.(new MCPClientError({ message: `MCP SSE Transport: ${e.message}` }));
              if (!this.connected) reject(e);
            }
          })();
        } catch (error) {
          if (this.abortController.signal.aborted) return;
          const e = error instanceof Error ? error : new Error(String(error));
          this.onerror?.(new MCPClientError({ message: `MCP SSE Transport: ${e.message}` }));
          reject(e);
        }
      })();
    });
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (!this.postUrl || !this.connected) {
      throw new MCPClientError({ message: "MCP SSE Transport: 尚未连接" });
    }
    // 失败必须抛错：SSE 模式下响应经事件流回传，POST 失败即永不会有响应，
    // 静默返回会让 await 响应的工具调用永久挂起
    const fail = (error: MCPClientError): never => {
      this.onerror?.(error);
      throw error;
    };
    let response: Response;
    try {
      response = await tauriFetch(this.postUrl, {
        method: "POST",
        headers: { ...this.headers, "Content-Type": "application/json" },
        body: JSON.stringify(message),
        signal: this.abortController.signal,
      });
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        fail(
          new MCPClientError({
            message: `MCP SSE Transport: POST 失败（HTTP ${response.status}）${text.slice(0, 200)}`,
          }),
        );
      }
    } catch (error) {
      fail(
        new MCPClientError({
          message: `MCP SSE Transport: ${error instanceof Error ? error.message : String(error)}`,
        }),
      );
    }
  }

  async close(): Promise<void> {
    this.connected = false;
    this.abortController.abort();
    this.onclose?.();
  }
}
