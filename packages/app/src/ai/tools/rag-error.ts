/** 未向量化书的 Rust 侧原始报错 → 可行动文案（E4：报错不再误导 Agent）
 *  触发面：rag* 工具 invoke 的 vectors.sqlite 打开失败（数据库文件不存在/路径报错） */
export function ragErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  if (/vectors(\.sqlite)?|数据库文件不存在|不存在|no such file|not exist/i.test(raw))
    return "本书未建立向量索引，RAG 检索不可用。请改用 readBookSection 按目录章节标题直读原文（标题支持模糊匹配）。";
  return raw;
}

/** 包一层 rag 调用的错误翻译：未建索引的原始路径报错统一为可行动文案 */
export async function withRagErrorTranslation<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw new Error(ragErrorMessage(error));
  }
}
