import { invoke } from "@tauri-apps/api/core";

/**
 * 密钥服务（批次 A）：前端唯一的 keyring 访问入口。
 *
 * 威胁模型：key 可存在于 app 进程内存（经 secretGetForRuntime 取入内存用于发请求），
 * 但绝不进模型消息、磁盘明文、日志、备份。前端 store 落盘一律经 partialize 置空 key 字段。
 */

/** 写入密钥（keyring；后端不可用时 Rust 侧降级并告警） */
export async function secretSet(category: string, key: string, value: string): Promise<void> {
  await invoke("secret_set", { category, key, value });
}

/** 删除密钥 */
export async function secretDelete(category: string, key: string): Promise<void> {
  await invoke("secret_delete", { category, key });
}

/** 是否存在密钥（不回显真值，供 UI 显示「已保存 ·•••」状态） */
export async function secretHas(category: string, key: string): Promise<boolean> {
  return invoke<boolean>("secret_has", { category, key });
}

/**
 * 执行边界内部取值：启动时把 key 载入内存 store 供前端发请求。
 * 仅前端代码 invoke，不暴露给 Agent 工具。返回值只进内存，不进日志。
 */
export async function secretGetForRuntime(category: string, key: string): Promise<string> {
  return invoke<string>("secret_get_for_runtime", { category, key });
}

/** 批量替换 {{secret:NAME}}（MCP http/sse headers 前端创建 transport 前调用） */
export async function secretResolveBatch(texts: string[]): Promise<string[]> {
  return invoke<string[]>("secret_resolve_batch", { texts });
}

/** 用户保管箱名称列表（仅名称，不含真值） */
export async function secretListUser(): Promise<string[]> {
  return invoke<string[]>("secret_list_user");
}

/** 用户保管箱写入（名称限 [A-Za-z0-9_-]{1,64}） */
export async function secretUserSet(name: string, value: string): Promise<void> {
  await invoke("secret_user_set", { name, value });
}

/** 用户保管箱删除 */
export async function secretUserDelete(name: string): Promise<void> {
  await invoke("secret_user_delete", { name });
}
