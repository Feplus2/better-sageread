import { buildCentralPrompt } from "@/constants/central-prompt";
import { buildPaperPrompt } from "@/constants/paper-prompt";
import type { ChatContext } from "@/hooks/use-chat-state";
import { getActivePresetContent } from "@/services/prompt-preset-service";
import { getSkills, skillAppliesTo } from "@/services/skill-service";
import { useLlamaStore } from "@/store/llama-store";
import { appDataDir } from "@tauri-apps/api/path";
import { exists, readTextFile } from "@tauri-apps/plugin-fs";

/**
 * 根据 Agent 角色路由到对应的提示词构建器
 */
export async function buildPrompt(chatContext: ChatContext | undefined): Promise<string> {
  const agentScope = chatContext?.agentScope ?? "reader";

  if (agentScope === "central") {
    return await buildCentralPrompt();
  }

  if (agentScope === "paper") {
    return await buildPaperPrompt(chatContext);
  }

  return await buildReadingPrompt(chatContext);
}

export async function buildReadingPrompt(chatContext: ChatContext | undefined): Promise<string> {
  const activeBookId = chatContext?.activeBookId;
  const semanticContext = chatContext?.activeContext;
  const sectionLabel = chatContext?.activeSectionLabel;
  let systemPromptBase = "";
  let activeSkillNames: string[] = [];

  try {
    const allSkills = await getSkills();
    const systemPromptSkill = allSkills.find((skill) => skill.isSystem && skill.isActive);
    systemPromptBase = systemPromptSkill?.content || "";
    activeSkillNames = allSkills
      .filter((skill) => skill.isActive && !skill.isSystem && skillAppliesTo(skill.scope, "reader"))
      .map((skill) => skill.name);
  } catch (error) {
    console.warn("获取技能列表失败:", error);
  }

  // 提示词预设（B 批）：有激活预设时替换内置默认基词（即 DB 系统技能的内容，不改库），
  // 其余组装照旧——下方 RAG 裁剪只匹配内置基词的固定小节标记，对自定义预设自然不生效（no-op）。
  const presetContent = await getActivePresetContent("reader");
  if (presetContent && presetContent.trim().length > 0) {
    systemPromptBase = presetContent;
  }

  const hasVectorCapability = useLlamaStore.getState().hasVectorCapability();

  let metadataMd: string | null = null;
  try {
    if (activeBookId) {
      const base = await appDataDir();
      const activeBookBaseDir = `${base}/books/${activeBookId}`;
      const metaPath = `${activeBookBaseDir}/metadata.md`;
      if (await exists(metaPath)) {
        metadataMd = await readTextFile(metaPath);
      } else {
        // 回落：metadata.md 仅在向量化索引时生成，未索引的书只有导入时写入的 metadata.json
        const jsonPath = `${activeBookBaseDir}/metadata.json`;
        if (await exists(jsonPath)) {
          metadataMd = formatMetadataJson(await readTextFile(jsonPath));
        }
      }
    }
  } catch (e) {
    console.warn("加载书籍元数据失败：", e);
  }

  let base = systemPromptBase;

  if (hasVectorCapability === false) {
    base = base.replace(/—— RAG 工具使用策略 ——[\s\S]*?—— 引用标注规范 ——/m, "");
    base = base.replace(/—— 引用标注规范 ——[\s\S]*?—— 图片输出规范 ——/m, "");
    base = base.replace(/—— 图片输出规范 ——[\s\S]*?—— 书籍与笔记管理工具 ——/m, "—— 书籍与笔记管理工具 ——");
    // P3 兜底：无向量能力时注入原文直读通道说明（readBookSection 对 reader 常驻注册）
    base +=
      "\n\n—— 章节原文直读（当前书未建立索引） ——\n当前书籍未建立向量索引，RAG 检索不可用。回答书中内容问题前，用 readBookSection 按目录章节标题读取小节原文（目录见【当前阅读图书元信息与目录】，标题支持模糊匹配）；未读到原文前不得凭印象编造书中内容。元数据问题（书名/作者/目录）直接回答，不调用工具。";
  } else {
    // 有向量能力 ≠ 本书已建索引：补充直读兜底的使用时机（工具常驻注册）
    base +=
      "\n\n—— 补充工具：章节原文直读 ——\nreadBookSection：按目录章节标题直读小节原文。RAG 检索命中为空时（通常是本书未建索引），立即改用它读取原文再作答，不要凭印象编造。";
  }

  // 笔记面板（manageNotes 对 reader 常驻注册；静态追加说明，不动 DB 基词/预设）
  base +=
    "\n\n—— 笔记面板 ——\nmanageNotes：当前书的笔记面板管理（list 列出 / read 读取 / create 新建 / update 修改 / toggleStar 星标 / export 导出单篇 Markdown）。笔记是长文 Markdown 产出（章节总结/读书灵感/人话版解读），与划线标注（notes 工具查询的是后者）是两套概念，不要混写。讨论产出值得留存时，先把整理稿展示给用户讨论，再用 create/update 落笔（会自动弹确认卡由用户过目）；可按当前章节名填 locationTag。";

  let prompt = base;

  if (activeSkillNames && activeSkillNames.length > 0) {
    prompt += "\n\n—— 可用技能库 ——\n";
    prompt += "当前系统已配置以下技能，当用户需求匹配时，请先调用 getSkills 工具获取详细执行步骤：\n";
    prompt += activeSkillNames.map((name) => `• ${name}`).join("\n");
  }

  if (semanticContext && semanticContext.trim().length > 0) {
    prompt += `\n\n【语义上下文】\n${semanticContext}`;
  }

  if (sectionLabel && sectionLabel.trim().length > 0) {
    prompt += `\n\n【当前阅读章节】\n${sectionLabel}`;
  }

  if (metadataMd && metadataMd.trim().length > 0) {
    prompt += `\n\n【当前阅读图书元信息与目录】\n${metadataMd}`;
  }

  return prompt;
}

/** 把 metadata.json 格式化为提示词可用的元信息块（无目录部分，仅书名/作者/出版信息） */
function formatMetadataJson(raw: string): string | null {
  try {
    const meta = JSON.parse(raw) as {
      title?: string;
      author?: string | { name?: string } | Array<{ name?: string }>;
      language?: string;
      published?: string;
      publisher?: string;
    };

    let author = "";
    if (typeof meta.author === "string") {
      author = meta.author;
    } else if (Array.isArray(meta.author)) {
      author = meta.author
        .map((a) => a?.name ?? "")
        .filter(Boolean)
        .join("、");
    } else if (meta.author?.name) {
      author = meta.author.name;
    }

    if (!meta.title && !author) return null;

    const lines = ["书籍元信息", ""];
    if (meta.title) lines.push(`- 标题: ${meta.title}`);
    if (author) lines.push(`- 作者: ${author}`);
    if (meta.publisher) lines.push(`- 出版社: ${meta.publisher}`);
    if (meta.published) lines.push(`- 出版日期: ${meta.published}`);
    if (meta.language) lines.push(`- 语言: ${meta.language}`);
    return lines.join("\n");
  } catch {
    return null;
  }
}
