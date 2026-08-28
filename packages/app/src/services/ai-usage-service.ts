import { invoke } from "@tauri-apps/api/core";

/**
 * AI 用量流水（统计面板数据源）：每条 AI 回复 finish 时落一行，
 * 时间窗聚合与模型占比全部前端做（行级数据小，前端切片零成本）。
 */

export interface AiUsageRecordInput {
  threadId: string | null;
  scope: string; // reader | paper | central
  providerId: string;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
}

export interface AiUsageEntry {
  id: number;
  threadId: string | null;
  scope: string;
  providerId: string;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  createdAt: number; // ms epoch
}

export async function recordAiUsage(input: AiUsageRecordInput): Promise<void> {
  await invoke("record_ai_usage", { entry: input });
}

export async function getAiUsageEntries(startDate?: number, endDate?: number): Promise<AiUsageEntry[]> {
  return invoke<AiUsageEntry[]>("get_ai_usage_entries", { startDate, endDate });
}
