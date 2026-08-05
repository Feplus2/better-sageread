import { resolveWorkspaceRootForScope } from "@/store/agent-settings-store";
import { invoke } from "@tauri-apps/api/core";
import { appDataDir } from "@tauri-apps/api/path";

/** 记忆注入上限：记忆应保持精炼，超了说明该瘦身了 */
const MEMORY_MAX_CHARS = 4000;

interface AgentReadResponse {
  content: string;
}

type Scope = "central" | "reader" | "paper";

/** 当前生效的工作区根（按助手覆盖 > 共享根 > 默认 {appData}/agent-workspace） */
async function effectiveWorkspaceRoot(scope: Scope): Promise<string> {
  const override = resolveWorkspaceRootForScope(scope);
  if (override) return override;
  const base = (await appDataDir()).replace(/[\\/]+$/, "");
  return `${base}/agent-workspace`;
}

/**
 * 工作区段（三 scope 统一在 transport 注入）：根路径 + 相对路径基准 + 确认卡说明 + 记忆指引。
 * 构建失败（理论不会）返回空串，不阻断对话。
 */
export async function loadWorkspaceSection(scope: Scope): Promise<string> {
  try {
    const root = await effectiveWorkspaceRoot(scope);
    return `\n\n—— 当前工作区 ——\nAgent 工作区根目录：${root}\nwriteFile/editFile/runCommand/searchFiles 的相对路径以此目录为基准；界内操作静默执行，界外写入与命令执行会弹确认卡由用户裁决。\n长期记忆：本目录下的 memory.md 是你的持久记忆（内容见【长期记忆】段，如有）；用户分享偏好/做出决定/要求“记住”时，用 writeFile/editFile 更新它（不存在则创建），按主题分节、保持精炼（200 行内）。`;
  } catch (e) {
    console.warn("获取 Agent 工作区配置失败:", e);
    return "";
  }
}

/**
 * 文件即记忆（P1 既定方向）：读取该 scope 生效工作区根的 memory.md，拼成 system prompt 段。
 * 记忆随根走：scope 覆盖了根即独立记忆，否则共享。文件不存在/读取失败静默返回空串。
 */
export async function loadMemorySection(scope: Scope): Promise<string> {
  try {
    const res = await invoke<AgentReadResponse>("agent_read_file", {
      root: resolveWorkspaceRootForScope(scope),
      path: "memory.md",
      offset: null,
      limit: null,
    });
    // agent_read_file 返回带行号前缀（"N\t内容"），注入前剥掉
    const text = (res.content ?? "").replace(/^\d+\t/gm, "").trim();
    if (!text) return "";
    const capped =
      text.length > MEMORY_MAX_CHARS ? `${text.slice(0, MEMORY_MAX_CHARS)}\n…[记忆过长已截断，请精简 memory.md]` : text;
    return `\n\n【长期记忆 memory.md】\n${capped}\n（以上是你的持久记忆。用户分享偏好/做出决定/给出长期事实，或明确要求"记住"时，用 writeFile/editFile 更新工作区根目录下的 memory.md，不存在则创建；按主题分节、保持精炼，只记跨对话有价值的信息）`;
  } catch {
    return "";
  }
}
