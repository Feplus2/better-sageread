import { invoke } from "@tauri-apps/api/core";

/** 提示词预设可生效的 Agent 作用域（全局助手 central 暂不支持预设） */
export type PromptPresetScope = "reader" | "paper";

export const PROMPT_PRESET_SCOPES: PromptPresetScope[] = ["reader", "paper"];

export const PROMPT_PRESET_SCOPE_LABELS: Record<PromptPresetScope, string> = {
  reader: "阅读助手",
  paper: "论文助手",
};

export interface PromptPreset {
  id: string;
  scope: string;
  name: string;
  content: string;
  isActive: boolean;
  createdAt: number;
  updatedAt: number;
}

export async function listPromptPresets(scope?: PromptPresetScope): Promise<PromptPreset[]> {
  try {
    return await invoke<PromptPreset[]>("list_prompt_presets", { scope: scope ?? null });
  } catch (error) {
    console.error("获取提示词预设列表失败:", error);
    throw new Error(`获取提示词预设列表失败: ${error instanceof Error ? error.message : "未知错误"}`);
  }
}

export async function createPromptPreset(
  scope: PromptPresetScope,
  name: string,
  content: string,
): Promise<PromptPreset> {
  try {
    const result = await invoke<PromptPreset>("create_prompt_preset", { scope, name, content });
    invalidatePromptPresetCache();
    return result;
  } catch (error) {
    console.error("创建提示词预设失败:", error);
    throw new Error(`创建提示词预设失败: ${error instanceof Error ? error.message : "未知错误"}`);
  }
}

export async function updatePromptPreset(id: string, name: string, content: string): Promise<PromptPreset> {
  try {
    const result = await invoke<PromptPreset>("update_prompt_preset", { id, name, content });
    invalidatePromptPresetCache();
    return result;
  } catch (error) {
    console.error("更新提示词预设失败:", error);
    throw new Error(`更新提示词预设失败: ${error instanceof Error ? error.message : "未知错误"}`);
  }
}

export async function deletePromptPreset(id: string): Promise<void> {
  try {
    await invoke("delete_prompt_preset", { id });
    invalidatePromptPresetCache();
  } catch (error) {
    console.error("删除提示词预设失败:", error);
    throw new Error(`删除提示词预设失败: ${error instanceof Error ? error.message : "未知错误"}`);
  }
}

export async function setActivePromptPreset(id: string): Promise<PromptPreset> {
  try {
    const result = await invoke<PromptPreset>("set_active_prompt_preset", { id });
    invalidatePromptPresetCache();
    return result;
  } catch (error) {
    console.error("激活提示词预设失败:", error);
    throw new Error(`激活提示词预设失败: ${error instanceof Error ? error.message : "未知错误"}`);
  }
}

/** 恢复内置默认提示词（清除该 scope 的激活预设） */
export async function clearActivePromptPreset(scope: PromptPresetScope): Promise<void> {
  try {
    await invoke("clear_active_prompt_preset", { scope });
    invalidatePromptPresetCache();
  } catch (error) {
    console.error("恢复默认提示词失败:", error);
    throw new Error(`恢复默认提示词失败: ${error instanceof Error ? error.message : "未知错误"}`);
  }
}

export async function getActivePromptPreset(scope: PromptPresetScope): Promise<PromptPreset | null> {
  try {
    return await invoke<PromptPreset | null>("get_active_prompt_preset", { scope });
  } catch (error) {
    console.error("获取激活提示词预设失败:", error);
    throw new Error(`获取激活提示词预设失败: ${error instanceof Error ? error.message : "未知错误"}`);
  }
}

// ---- 激活预设内容缓存 ----
// buildPrompt 每发一条消息都会调用；预设管理操作（上方各 mutation）已主动失效缓存，
// TTL 仅作为跨窗口/外部变更的兜底，取短值保证"下条消息立即生效"。

const ACTIVE_PRESET_CACHE_TTL_MS = 5000;

interface ActivePresetCacheEntry {
  content: string | null;
  expiresAt: number;
}

const activePresetCache = new Map<PromptPresetScope, ActivePresetCacheEntry>();

export function invalidatePromptPresetCache(scope?: PromptPresetScope): void {
  if (scope) {
    activePresetCache.delete(scope);
  } else {
    activePresetCache.clear();
  }
}

/**
 * 获取某 scope 当前激活预设的内容（无激活预设或查询失败时返回 null = 用内置默认风格）。
 * 带 5s 短缓存；失败不缓存，下轮重试，且绝不向 prompt 装配链抛错。
 */
export async function getActivePresetContent(scope: PromptPresetScope): Promise<string | null> {
  const cached = activePresetCache.get(scope);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.content;
  }

  try {
    const preset = await getActivePromptPreset(scope);
    const content = preset?.content ?? null;
    activePresetCache.set(scope, { content, expiresAt: Date.now() + ACTIVE_PRESET_CACHE_TTL_MS });
    return content;
  } catch (error) {
    console.warn(`获取${PROMPT_PRESET_SCOPE_LABELS[scope]}激活提示词预设失败，回退内置默认:`, error);
    return null;
  }
}

// ---- 旧版阅读助手基词保全迁移（2026-09 提示词分层重构） ----
// 重构前阅读助手基词存于 skills 表的 is_system 行（早期版本用户可编辑）；
// 重构后内置基词代码化（constants/agent-styles.ts），DB 行不再作为提示词来源。
// 若 DB 内容不是任何一代官方文案（真·用户自定义），搬家为未激活的 reader 预设保留，
// 不静默销毁用户文字；官方文案（各迁移版本）以固定开场白开头，据此判定无需保全。

const LEGACY_READER_BASE_PRESET_NAME = "旧版自定义提示词（迁移保留）";

const OFFICIAL_READER_BASE_PREFIXES = ["你是 Better SageRead 的**阅读助手**", "你是一位**亲切、耐心的阅读向导**"];

let legacyReaderBaseMigrationAttempted = false;

/** 幂等：每会话最多执行一次；同名预设已存在时跳过（防重复创建） */
export async function migrateLegacyReaderBaseIfNeeded(): Promise<void> {
  if (legacyReaderBaseMigrationAttempted) return;
  legacyReaderBaseMigrationAttempted = true;
  try {
    const { getSkills } = await import("@/services/skill-service");
    const skills = await getSkills();
    const content = skills.find((s) => s.isSystem)?.content?.trim();
    if (!content) return;
    if (OFFICIAL_READER_BASE_PREFIXES.some((prefix) => content.startsWith(prefix))) return;
    const existing = await listPromptPresets("reader");
    if (existing.some((p) => p.name === LEGACY_READER_BASE_PRESET_NAME)) return;
    await createPromptPreset("reader", LEGACY_READER_BASE_PRESET_NAME, content);
    console.info("旧版阅读助手自定义基词已保全为未激活预设（不影响当前对话）");
  } catch (error) {
    console.warn("旧版阅读助手基词保全迁移失败:", error);
  }
}
