import { invoke } from "@tauri-apps/api/core";

/** 技能可生效的 Agent 作用域 */
export type SkillScope = "reader" | "central" | "paper";

/** 全部作用域（规范顺序：序列化时按此排序，保证落库字符串稳定） */
export const SKILL_SCOPES: SkillScope[] = ["reader", "central", "paper"];

export const SKILL_SCOPE_LABELS: Record<SkillScope, string> = {
  reader: "阅读助手",
  central: "全局助手",
  paper: "论文助手",
};

/**
 * 解析技能 scope（DB 存逗号分隔集合，如 "reader,central,paper" 的子集）。
 * 兼容旧数据："both" → ["reader", "central"]；单值 → 单元素集合；非法片段忽略。
 */
export function parseSkillScopes(raw: string | null | undefined): SkillScope[] {
  if (!raw) return [];
  const result = new Set<SkillScope>();
  for (const part of raw.split(",")) {
    const value = part.trim();
    if (value === "both") {
      result.add("reader");
      result.add("central");
    } else if ((SKILL_SCOPES as string[]).includes(value)) {
      result.add(value as SkillScope);
    }
  }
  return SKILL_SCOPES.filter((s) => result.has(s));
}

/** 序列化作用域集合为逗号分隔串（按规范顺序） */
export function serializeSkillScopes(scopes: readonly SkillScope[]): string {
  const set = new Set(scopes);
  return SKILL_SCOPES.filter((s) => set.has(s)).join(",");
}

/** 技能是否对指定 Agent 生效（集合包含判断） */
export function skillAppliesTo(raw: string | null | undefined, scope: SkillScope): boolean {
  return parseSkillScopes(raw).includes(scope);
}

export interface Skill {
  id: string;
  name: string;
  content: string;
  isActive: boolean;
  isSystem: boolean;
  /** 逗号分隔的作用域集合（"reader,central,paper" 子集；旧值 "both" 读取时按 reader+central 解析） */
  scope: string;
  createdAt: number;
  updatedAt: number;
}

export interface SkillCreateData {
  name: string;
  content: string;
  isActive?: boolean;
  isSystem?: boolean;
  scope?: string;
}

export interface SkillUpdateData {
  name?: string;
  content?: string;
  isActive?: boolean;
  scope?: string;
  updatedAt?: number;
}

export async function createSkill(data: SkillCreateData): Promise<Skill> {
  try {
    const result = await invoke<Skill>("create_skill", { data });
    return result;
  } catch (error) {
    console.error("创建技能失败:", error);
    throw new Error(`创建技能失败: ${error instanceof Error ? error.message : "未知错误"}`);
  }
}

export async function getSkills(): Promise<Skill[]> {
  try {
    const result = await invoke<Skill[]>("get_skills");
    return result;
  } catch (error) {
    console.error("获取技能列表失败:", error);
    throw new Error(`获取技能列表失败: ${error instanceof Error ? error.message : "未知错误"}`);
  }
}

export async function getSkillById(id: string): Promise<Skill | null> {
  try {
    const result = await invoke<Skill | null>("get_skill_by_id", { id });
    return result;
  } catch (error) {
    console.error("获取技能详情失败:", error);
    throw new Error(`获取技能详情失败: ${error instanceof Error ? error.message : "未知错误"}`);
  }
}

export async function updateSkill(id: string, updateData: SkillUpdateData): Promise<Skill> {
  try {
    const result = await invoke<Skill>("update_skill", {
      id,
      updateData: {
        ...updateData,
        updatedAt: Date.now(),
      },
    });
    return result;
  } catch (error) {
    console.error("更新技能失败:", error);
    throw new Error(`更新技能失败: ${error instanceof Error ? error.message : "未知错误"}`);
  }
}

export async function deleteSkill(id: string): Promise<void> {
  try {
    await invoke("delete_skill", { id });
  } catch (error) {
    console.error("删除技能失败:", error);
    throw new Error(`删除技能失败: ${error instanceof Error ? error.message : "未知错误"}`);
  }
}

export async function toggleSkillActive(id: string): Promise<Skill> {
  try {
    const result = await invoke<Skill>("toggle_skill_active", { id });
    return result;
  } catch (error) {
    console.error("切换技能状态失败:", error);
    throw new Error(`切换技能状态失败: ${error instanceof Error ? error.message : "未知错误"}`);
  }
}
