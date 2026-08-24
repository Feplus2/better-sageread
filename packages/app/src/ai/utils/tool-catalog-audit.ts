/**
 * 目录牌模式观测（P4-4）：describeTool/useTool 调用序列审计。
 * 落盘 {appData}/agent-audit/tool-catalog.jsonl（与 Rust 侧 local-api.jsonl / commands.jsonl 同目录同款 JSONL）。
 * 脱敏红线：只记工具名与参数键名，绝不记参数值（防秘钥/内容进日志）；
 * 写盘失败静默（console.warn 级），绝不影响主流程。
 */
import { BaseDirectory, mkdir, writeTextFile } from "@tauri-apps/plugin-fs";

const AUDIT_DIR = "agent-audit";
const AUDIT_FILE = `${AUDIT_DIR}/tool-catalog.jsonl`;

/** 进程内单调调用序列号（describeTool/useTool 共用一条序列，供复盘「查牌 → 执行」链路） */
let seq = 0;
let dirReady = false;

export interface ToolCatalogAuditEntry {
  kind: "describeTool" | "useTool";
  /** 目标工具名（被查询/被执行的真实工具） */
  tool: string;
  /** 参数键名清单（useTool 为 args 内层键名；describeTool 固定 ["tool"]），绝不含参数值 */
  argKeys: string[];
}

export function auditToolCatalogCall(entry: ToolCatalogAuditEntry): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    seq: ++seq,
    kind: entry.kind,
    tool: entry.tool,
    argKeys: entry.argKeys,
  });
  void append(line);
}

async function append(line: string): Promise<void> {
  try {
    if (!dirReady) {
      await mkdir(AUDIT_DIR, { baseDir: BaseDirectory.AppData, recursive: true });
      dirReady = true;
    }
    await writeTextFile(AUDIT_FILE, `${line}\n`, { baseDir: BaseDirectory.AppData, append: true });
  } catch (e) {
    console.warn("[tool-catalog-audit] 写审计日志失败:", e);
  }
}
