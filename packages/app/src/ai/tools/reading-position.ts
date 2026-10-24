import { getDocumentToolMode } from "@/ai/tools/document/mode";
import {
  formatPositionForPrompt,
  formatPositionForTool,
  readPositionWindow,
  resolveLiveReadingPosition,
} from "@/services/reading-position/position-service";
import { tool } from "ai";
import { z } from "zod";

/**
 * 阅读位置工具（2026-10-20）——书籍/论文两 scope 共用同一套实现。
 *
 * 设计口径（用户拍板）：
 * - 提示词每轮只注入【当前阅读位置】坐标（不注入小节正文），位置取自活注册表、以本轮为准；
 * - 需要原文时按当前文档模式调用 readDocument(position=true) 或 Legacy readAtReadingPosition，避免整篇正文灌入；
 * - 工具返回的坐标与注入段同源（同一 ReadingPositionSnapshot），保证口径一致。
 */

type PositionScope = "reader" | "paper";

const scopeLabel = (scope: PositionScope) => (scope === "reader" ? "书籍" : "论文");

/** 获取当前阅读位置（精确坐标） */
export function createGetReadingPositionTool(scope: PositionScope, docId: string | undefined) {
  return tool({
    description: `获取用户当前在${scopeLabel(scope)}中的阅读位置（精确坐标）。

📖 **使用场景**：
• 需要确认"用户读到哪 / 这一段属于哪里"（尤其是目录不可用、或对话历史里位置已过时）
• 准备按位置读取原文前，先拿坐标（字符偏移、mdbook 文件、分块区间）
• 用户问"我现在读到第几章/第几块/进度多少"时直接用它回答

📌 **口径**：系统提示词尾部的【当前阅读位置】每轮刷新、以此为准；本工具返回的是同一位置的完整结构化字段，含历史消息中不存在的精确信息（字符偏移、估算分块区间、spine/CFI）。

返回：scope / label / md_file / char_offset / md_length / percent_in_file / chunk_range / chunk_total / overall_percent / spine / cfi。`,
    inputSchema: z.object({
      reasoning: z.string().min(1).describe("调用此工具的原因，例如：'用户问现在读到哪一段了'"),
    }),
    execute: async ({ reasoning }: { reasoning: string }) => {
      if (!docId) {
        return {
          ok: false,
          error: scope === "reader" ? "当前没有打开的书，无法获取阅读位置" : "当前没有打开的论文，无法获取阅读位置",
          meta: { reasoning },
        };
      }
      const snapshot = await resolveLiveReadingPosition(scope, docId);
      if (!snapshot) {
        return {
          ok: false,
          error:
            "暂时取不到精确位置（阅读视图可能刚打开或尚未加载完成）。可先看系统提示词尾部的【当前阅读位置】；若用户需要原文，请让用户翻动一下页面后重试。",
          meta: { reasoning },
        };
      }
      return {
        ok: true,
        position: formatPositionForTool(snapshot),
        position_text: formatPositionForPrompt(snapshot, getDocumentToolMode()),
        meta: { reasoning },
      };
    },
  });
}

/** 按当前阅读位置读取原文窗口（mdbook 文本层） */
export function createReadAtReadingPositionTool(scope: PositionScope, docId: string | undefined) {
  return tool({
    description: `按用户当前阅读位置读取原文窗口（${scopeLabel(scope)}，mdbook 文本层）。

📖 **使用场景**：
• 用户说"这一节 / 这里 / 当前部分 / 我读到的地方"且需要原文回答
• 需要接着当前阅读位置读一段、或分次扩窗读完当前章节
• 目录不可用、readBookSection 按标题匹配不到时，这是唯一可靠的正文通道

📌 **用法**：
• 默认从当前位置向后读 6000 字符（before=0）；需要回看上下文时给 before（≤8000）
• 返回 total_length 与 next_offset：内容被截断时用 next_offset 继续读下一页
• 返回的 read_range 是 mdbook 文本层的字符区间，与【当前阅读位置】坐标同源

⚠️ 只用于"当前位置附近"；要读其它章节请用 readBookSection / readPaperSection / ragToc。`,
    inputSchema: z.object({
      reasoning: z.string().min(1).describe("调用此工具的原因，例如：'用户问当前这小节讲了什么，需要读原文'"),
      before: z.number().int().min(0).max(8000).optional().describe("当前位置之前回看的字符数（默认 0，最多 8000）"),
      after: z
        .number()
        .int()
        .min(500)
        .max(32000)
        .optional()
        .describe("当前位置之后读取的字符数（默认 6000，最多 32000）"),
    }),
    execute: async ({ reasoning, before, after }: { reasoning: string; before?: number; after?: number }) => {
      if (!docId) {
        return {
          ok: false,
          error: scope === "reader" ? "当前没有打开的书" : "当前没有打开的论文",
          meta: { reasoning },
        };
      }
      const snapshot = await resolveLiveReadingPosition(scope, docId);
      if (!snapshot) {
        return {
          ok: false,
          error: "暂时取不到精确阅读位置，无法按位置读原文；请提示用户翻动页面后重试，或改用按标题读取工具。",
          meta: { reasoning },
        };
      }
      try {
        const win = await readPositionWindow(snapshot, { before, after });
        return {
          ok: true,
          position: formatPositionForTool(snapshot),
          md_file: win.mdRelPath,
          read_range: [win.start, win.end],
          total_length: win.totalLength,
          next_offset: win.nextOffset,
          text: win.text,
          meta: { reasoning },
        };
      } catch (error) {
        return {
          ok: false,
          error: `按位置读取原文失败：${error instanceof Error ? error.message : String(error)}`,
          meta: { reasoning },
        };
      }
    },
  });
}
