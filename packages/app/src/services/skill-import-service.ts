import { type Skill, type SkillScope, createSkill, serializeSkillScopes } from "@/services/skill-service";
/**
 * SKILL.md 兼容导入（批次 C2）：与 Claude Code skills 生态兼容——
 * 解析 SKILL.md 的 YAML frontmatter（name 必填 / description / scope 可选），body 作技能内容，
 * 走 skill-service 现有 create 落库。附带脚本/资源文件不处理（SOP 中引用的脚本需 Agent 自行下载执行）。
 */
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { load as yamlLoad } from "js-yaml";

const ALL_SCOPES: SkillScope[] = ["central", "reader", "paper"];

export interface ParsedSkillMd {
  name: string;
  description?: string;
  scopes: SkillScope[];
  /** frontmatter 之后的正文（技能 SOP 内容） */
  body: string;
}

/** 解析 scope 字段：字符串 / 数组 / 逗号串；缺省或全非法 → 全选 */
function parseScopes(raw: unknown): SkillScope[] {
  const isScope = (v: unknown): v is SkillScope => v === "reader" || v === "central" || v === "paper";
  let items: unknown[] = [];
  if (Array.isArray(raw)) items = raw;
  else if (typeof raw === "string") items = raw.split(/[,\s]+/);
  const parsed = items.filter(isScope);
  return parsed.length > 0 ? parsed : ALL_SCOPES;
}

/**
 * 解析 SKILL.md 文本：开头 `---` 包围的 YAML frontmatter + 正文。
 * name 缺失时抛错（由调用方提示用户）。
 */
export function parseSkillMd(text: string): ParsedSkillMd {
  const trimmed = text.replace(/^\uFEFF/, "").trim();
  let meta: Record<string, unknown> = {};
  let body = trimmed;

  const match = trimmed.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (match) {
    const loaded = yamlLoad(match[1]);
    if (loaded && typeof loaded === "object") {
      meta = loaded as Record<string, unknown>;
    }
    body = trimmed.slice(match[0].length).trim();
  }

  const name = typeof meta.name === "string" ? meta.name.trim() : "";
  if (!name) {
    throw new Error("SKILL.md 缺少 frontmatter 的 name 字段（格式：开头 --- 包围的 YAML，含 name/description）");
  }
  if (!body) {
    throw new Error("SKILL.md 正文为空，无可导入的技能内容");
  }

  return {
    name,
    description: typeof meta.description === "string" ? meta.description.trim() : undefined,
    scopes: parseScopes(meta.scope ?? meta.scopes),
    body,
  };
}

/** 拉取远程文本（走 Tauri 网络栈绕 CORS） */
async function fetchText(url: string): Promise<string> {
  const response = await tauriFetch(url, { method: "GET", headers: { Accept: "text/plain, text/markdown, */*" } });
  if (!response.ok) {
    throw new Error(`下载失败（HTTP ${response.status}）：${url}`);
  }
  return await response.text();
}

/**
 * GitHub URL → raw.githubusercontent.com 的 SKILL.md 直链；非 GitHub 链接返回 null。
 * 支持：仓库根 / tree/{branch}/{path} / blob/{branch}/{path}（path 末尾是 SKILL.md 或目录）。
 */
export function resolveGithubSkillUrl(
  url: string,
): { rawUrl: string; branch: string; defaultedBranch: boolean } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.hostname !== "github.com" && parsed.hostname !== "www.github.com") return null;

  const segments = parsed.pathname.split("/").filter(Boolean); // [owner, repo, ...]
  if (segments.length < 2) return null;
  const [owner, repo] = segments;

  if (segments.length >= 4 && (segments[2] === "tree" || segments[2] === "blob")) {
    const branch = segments[3];
    const rest = segments.slice(4).join("/");
    const isBlob = segments[2] === "blob";
    const filePath = isBlob && rest ? rest : rest ? `${rest}/SKILL.md` : "SKILL.md";
    return {
      rawUrl: `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${filePath}`,
      branch,
      defaultedBranch: false,
    };
  }

  // 仓库根：默认 main 分支（失败后由调用方试 master）
  return {
    rawUrl: `https://raw.githubusercontent.com/${owner}/${repo}/main/SKILL.md`,
    branch: "main",
    defaultedBranch: true,
  };
}

/** 落库：解析结果 → createSkill */
async function saveParsedSkill(parsed: ParsedSkillMd): Promise<Skill> {
  return createSkill({
    name: parsed.name,
    content: parsed.body,
    isActive: true,
    isSystem: false,
    scope: serializeSkillScopes(parsed.scopes),
  });
}

/** 从 URL 导入：GitHub 链接自动转 raw 直链（默认 main，失败试 master）；其他 URL 直接拉文本 */
export async function importSkillFromUrl(url: string): Promise<Skill> {
  const github = resolveGithubSkillUrl(url.trim());
  let text: string;
  if (github) {
    try {
      text = await fetchText(github.rawUrl);
    } catch (error) {
      if (github.defaultedBranch) {
        // 默认 main 失败 → 试 master
        const masterUrl = github.rawUrl.replace("/main/", "/master/");
        try {
          text = await fetchText(masterUrl);
        } catch {
          throw error;
        }
      } else {
        throw error;
      }
    }
  } else {
    text = await fetchText(url.trim());
  }
  return saveParsedSkill(parseSkillMd(text));
}

/** 从粘贴文本导入 */
export async function importSkillFromText(text: string): Promise<Skill> {
  return saveParsedSkill(parseSkillMd(text));
}

/** {{secret:NAME}} 占位正则：与 Rust 侧 resolve_secret_refs（core/secrets/mod.rs）口径一致 */
const SECRET_REF_RE = /\{\{secret:([A-Za-z0-9_-]{1,64})\}\}/g;

/** 提取技能内容引用的保管箱密钥名（去重，保持出现顺序） */
export function extractSecretRefNames(text: string): string[] {
  return [...new Set(Array.from(text.matchAll(SECRET_REF_RE), (m) => m[1]))];
}
