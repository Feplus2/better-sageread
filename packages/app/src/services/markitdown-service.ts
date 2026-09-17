import { resolveLlmParams } from "@/services/converter-service";
import { useConverterStore } from "@/store/converter-store";
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

// ─── Phase C：扫描件引擎兜底（复用 papers_converter）───

export interface OcrOutcome {
  ok: boolean;
  md_path?: string | null;
  chars?: number | null;
  error?: string | null;
}

/** 引擎选择（用户 2026-09-17 拍板："有哪个用哪个，优先 MinerU"）；未配置 token 返回 null */
export function pickAttachmentOcrEngine(): "mineru" | "paddleocr" | null {
  const { mineruToken, paddleocrToken } = useConverterStore.getState();
  if (mineruToken) return "mineru";
  if (paddleocrToken) return "paddleocr";
  return null;
}

/** papers_converter 一次性引擎解析（输出 {outputDir}/{slug}/paper.md；不走论文导入流） */
export async function ocrPdfForAttachment(
  pdfPath: string,
  outputDir: string,
  engine: "mineru" | "paddleocr",
): Promise<OcrOutcome> {
  const { mineruToken, paddleocrToken } = useConverterStore.getState();
  const llm = resolveLlmParams();
  return await invoke<OcrOutcome>("ocr_pdf_for_attachment", {
    pdfPath,
    outputDir,
    engine,
    mineruToken: mineruToken || undefined,
    paddleocrToken: paddleocrToken || undefined,
    llmBaseUrl: llm.llmBaseUrl,
    llmApiKey: llm.llmApiKey,
    llmModel: llm.llmModel,
  });
}
