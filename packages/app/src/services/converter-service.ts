import { getUtilityModel } from "@/ai/providers/factory";
import { predefinedProviders } from "@/constants/predefined-providers";
import { uploadBook } from "@/services/book-service";
import { useConverterStore } from "@/store/converter-store";
import { useProviderStore } from "@/store/provider-store";
import { invoke } from "@tauri-apps/api/core";
import { type UnlistenFn, listen } from "@tauri-apps/api/event";
import { readFile } from "@tauri-apps/plugin-fs";

/** 转换进度事件（对应 Books_Converter headless JSON 协议 + Rust 补发的 terminated） */
export interface ConvertProgress {
  type: "start" | "progress" | "stage_done" | "done" | "error" | "terminated";
  title?: string;
  engine?: string;
  translate?: boolean;
  stage?: number;
  stage_name?: string;
  detail?: string;
  fraction?: number | null;
  percent?: number;
  elapsed?: number;
  epub_path?: string;
  message?: string;
  success?: boolean;
}

interface ConvertParams {
  pdfPath: string;
  ocr: boolean;
  translate?: string;
  engine?: string;
  mineruToken: string;
  paddleocrToken?: string;
  llmBaseUrl: string;
  llmApiKey: string;
  llmModel: string;
}

/** 从辅助模型解析 OpenAI 兼容端点参数（转换引擎只讲 OpenAI 兼容协议） */
export function resolveLlmParams(): { llmBaseUrl: string; llmApiKey: string; llmModel: string } {
  const selected = getUtilityModel();
  if (!selected) {
    throw new Error("尚未配置辅助模型，请先在 设置 → 模型提供商 中选择辅助模型");
  }
  const { modelProviders } = useProviderStore.getState();
  const provider = modelProviders.find((p) => p.provider === selected.providerId);
  if (!provider) {
    throw new Error(`未找到模型提供商: ${selected.providerId}`);
  }
  if (!provider.apiKey) {
    throw new Error(`模型提供商「${provider.name}」未配置 API Key`);
  }
  // 转换引擎只讲 OpenAI 兼容协议：优先用预置的 openai-chat 端点。
  // 2026-10-22 教训：DeepSeek 默认 baseUrl 改成 .../anthropic/v1 后，直接把 baseUrl 传给 sidecar
  // 会发出 /anthropic/v1/chat/completions → 404，PDF 转换/翻译对新老用户都会坏。
  const preset = predefinedProviders.find((p) => p.provider === provider.provider);
  const endpoints = provider.endpoints ?? preset?.endpoints ?? {};
  const chatBaseUrl =
    endpoints["openai-chat"] ??
    (provider.apiStyle === "openai-chat" || provider.apiStyle === "openai-responses" || !provider.apiStyle
      ? provider.baseUrl
      : undefined);
  if (!chatBaseUrl) {
    throw new Error(
      `「${provider.name}」没有 OpenAI 兼容端点，PDF 转换/翻译暂不可用；请在 设置 → 模型提供商 里把辅助模型换成 OpenAI 兼容的提供商`,
    );
  }
  return {
    llmBaseUrl: chatBaseUrl,
    llmApiKey: provider.apiKey,
    llmModel: selected.modelId,
  };
}

/** 启动转换（异步；进度经 listenConvertProgress 回传） */
export async function startConvert(pdfPath: string, ocr: boolean, translate?: string): Promise<void> {
  const { mineruToken, paddleocrToken, engine } = useConverterStore.getState();
  if (engine === "mineru" && !mineruToken) {
    throw new Error("尚未配置 MinerU Token，请先在 设置 → PDF 转换 中填写");
  }
  if (engine === "paddleocr" && !paddleocrToken) {
    throw new Error("尚未配置 PaddleOCR Token，请先在 设置 → PDF 转换 中填写");
  }
  const params: ConvertParams = {
    pdfPath,
    ocr,
    translate: translate || undefined,
    engine,
    mineruToken,
    paddleocrToken: paddleocrToken || undefined,
    ...resolveLlmParams(),
  };
  await invoke("convert_pdf_to_epub", { params });
}

export async function cancelConvert(): Promise<void> {
  await invoke("cancel_convert");
}

export async function listenConvertProgress(callback: (progress: ConvertProgress) => void): Promise<UnlistenFn> {
  return listen<string>("convert://progress", (event) => {
    try {
      callback(JSON.parse(event.payload) as ConvertProgress);
    } catch (e) {
      console.warn("无法解析转换进度事件:", event.payload, e);
    }
  });
}

/** 转换完成后把生成的 EPUB 读入并复用 uploadBook 入库 */
export async function importConvertedEpub(epubPath: string): Promise<void> {
  const bytes = await readFile(epubPath);
  const fileName = epubPath.split(/[\\/]/).pop() ?? "converted.epub";
  const file = new File([bytes.buffer as ArrayBuffer], fileName, { type: "application/epub+zip" });
  await uploadBook(file);
}
