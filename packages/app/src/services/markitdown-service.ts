import { invoke } from "@tauri-apps/api/core";

export interface MarkitdownOutcome {
  ok: boolean;
  output?: string | null;
  chars?: number | null;
  warnings: string[];
  error?: string | null;
}

/** 交给 MarkItDown 转换的扩展名（文本类直读不走这里；图片走 J2 原链路） */
const MARKITDOWN_EXTS = new Set([
  "pdf",
  "docx",
  "doc",
  "pptx",
  "ppt",
  "xlsx",
  "xls",
  "epub",
  "html",
  "htm",
  "eml",
  "msg",
]);

export function isMarkitdownCandidate(name: string): boolean {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return MARKITDOWN_EXTS.has(ext);
}

/** 一次性转换（sidecar 进程恒 0 退出，成败看 outcome.ok；空产出看 warnings 含 empty-output） */
export async function convertWithMarkitdown(inputPath: string, outputPath: string): Promise<MarkitdownOutcome> {
  return await invoke<MarkitdownOutcome>("convert_file_markitdown", { inputPath, outputPath });
}
