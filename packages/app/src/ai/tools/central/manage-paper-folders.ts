import {
  buildFolderTree,
  createFolder,
  deleteFolder,
  getPaperFolderMap,
  listFolders,
  listPapers,
  moveFolder,
  renameFolder,
  setPaperFolders,
} from "@/services/paper-service";
/**
 * 全局助手工具：文献库文件夹管理
 *
 * 数据源：folders 树表 + paper_folders 多对多关系（services/paper-service.ts）
 * delete 为软删除（进回收站，可恢复，论文不删）；assign 为整体替换语义
 */
import { tool } from "ai";
import { z } from "zod";

/** papers 清单截断上限，防止大库撑爆上下文 */
const MAX_PAPERS = 200;

export const managePaperFoldersTool = tool({
  description: `管理文献库的文件夹（分组）：查看树、看论文清单、创建、重命名、删除、移动、归档论文。

🎯 **核心功能**：
• list：查看文件夹树（含每个文件夹的直接篇数）
• papers：查看论文清单（id+标题+所属文件夹名，最多返回 ${MAX_PAPERS} 篇）
• create：创建文件夹（可指定父文件夹）
• rename：重命名文件夹
• delete：删除文件夹（软删除进回收站，可恢复；论文不删除，仅失去归属）
• move：移动文件夹到新父节点（parentId 传 null 移到根级）
• assign：设置论文的文件夹归属（**整体替换语义**：传入的 folderIds 会替换该论文现有的全部归属；空数组 = 移出所有文件夹成为"未归档"。只想增删一个文件夹时，先 papers 查清现有归属再传入合并后的完整列表，防止误清空）

📋 **前提条件**：folderId/paperId 可通过 list / papers 动作获取

📊 **返回内容**：
结构化操作结果 + 一句话 message

⚠️ **什么时候别用**：
• 删除论文本身——请用 manageBook(action=delete)；本工具只管文件夹与归属关系
• 书籍（EPUB）没有文件夹概念，本工具仅适用于文献库`,

  inputSchema: z.object({
    reasoning: z.string().min(1).describe("调用此工具的原因"),
    action: z.enum(["list", "papers", "create", "rename", "delete", "move", "assign"]).describe("操作类型"),
    name: z.string().optional().describe("文件夹名称（create/rename 时需要）"),
    folderId: z.string().optional().describe("文件夹 ID（rename/delete/move 时需要）"),
    parentId: z.string().nullable().optional().describe("父文件夹 ID（create 可选；move 时传 null 表示移到根级）"),
    paperId: z.string().optional().describe("论文 ID（assign 时需要）"),
    folderIds: z
      .array(z.string())
      .optional()
      .describe("目标文件夹 ID 列表（assign 时需要；整体替换，空数组=移出所有文件夹）"),
  }),

  execute: async ({
    reasoning,
    action,
    name,
    folderId,
    parentId,
    paperId,
    folderIds,
  }: {
    reasoning: string;
    action: "list" | "papers" | "create" | "rename" | "delete" | "move" | "assign";
    name?: string;
    folderId?: string;
    parentId?: string | null;
    paperId?: string;
    folderIds?: string[];
  }) => {
    try {
      // ==================== 文件夹树 ====================
      if (action === "list") {
        const [folders, memberMap] = await Promise.all([listFolders(), getPaperFolderMap()]);
        const directCount = new Map<string, number>();
        for (const entry of memberMap) {
          directCount.set(entry.folderId, (directCount.get(entry.folderId) ?? 0) + 1);
        }
        const tree = buildFolderTree(folders);
        const serialize = (nodes: typeof tree): unknown[] =>
          nodes.map((n) => ({
            id: n.id,
            name: n.name,
            paperCount: directCount.get(n.id) ?? 0,
            children: serialize(n.children),
          }));
        return {
          results: {
            success: true,
            message: `共 ${folders.length} 个文件夹`,
            folders: serialize(tree),
          },
          meta: { reasoning, action },
        };
      }

      // ==================== 论文清单 ====================
      if (action === "papers") {
        const [papers, folders, memberMap] = await Promise.all([listPapers(), listFolders(), getPaperFolderMap()]);
        const folderName = new Map(folders.map((f) => [f.id, f.name]));
        const folderIdsByPaper = new Map<string, string[]>();
        for (const entry of memberMap) {
          const list = folderIdsByPaper.get(entry.paperId) ?? [];
          list.push(entry.folderId);
          folderIdsByPaper.set(entry.paperId, list);
        }
        const truncated = papers.length > MAX_PAPERS;
        const items = papers.slice(0, MAX_PAPERS).map((p) => ({
          id: p.id,
          title: p.title,
          folders: (folderIdsByPaper.get(p.id) ?? []).map((fid) => folderName.get(fid) ?? fid),
        }));
        return {
          results: {
            success: true,
            message: truncated
              ? `共 ${papers.length} 篇论文，已截断为前 ${MAX_PAPERS} 篇`
              : `共 ${papers.length} 篇论文`,
            total: papers.length,
            truncated,
            papers: items,
          },
          meta: { reasoning, action },
        };
      }

      // ==================== 创建 ====================
      if (action === "create") {
        if (!name?.trim()) {
          return { results: { success: false, message: "创建文件夹需要提供 name 参数" }, meta: { reasoning, action } };
        }
        const folder = await createFolder(name.trim(), parentId ?? null);
        return {
          results: {
            success: true,
            message: `文件夹「${folder.name}」创建成功`,
            folder: { id: folder.id, name: folder.name, parentId: folder.parentId },
          },
          meta: { reasoning, action },
        };
      }

      // ==================== 重命名 ====================
      if (action === "rename") {
        if (!folderId || !name?.trim()) {
          return {
            results: { success: false, message: "重命名文件夹需要同时提供 folderId 和 name 参数" },
            meta: { reasoning, action },
          };
        }
        await renameFolder(folderId, name.trim());
        return {
          results: { success: true, message: `文件夹已重命名为「${name.trim()}」` },
          meta: { reasoning, action, folderId },
        };
      }

      // ==================== 删除（软删除） ====================
      if (action === "delete") {
        if (!folderId) {
          return {
            results: { success: false, message: "删除文件夹需要提供 folderId 参数" },
            meta: { reasoning, action },
          };
        }
        await deleteFolder(folderId);
        return {
          results: { success: true, message: "文件夹已移入回收站（可恢复；论文未删除，仅失去归属）" },
          meta: { reasoning, action, folderId },
        };
      }

      // ==================== 移动 ====================
      if (action === "move") {
        if (!folderId) {
          return {
            results: { success: false, message: "移动文件夹需要提供 folderId 参数" },
            meta: { reasoning, action },
          };
        }
        await moveFolder(folderId, parentId ?? null);
        return {
          results: { success: true, message: parentId ? "文件夹已移动" : "文件夹已移到根级" },
          meta: { reasoning, action, folderId, parentId: parentId ?? null },
        };
      }

      // ==================== 归档论文（整体替换） ====================
      if (action === "assign") {
        if (!paperId || !folderIds) {
          return {
            results: {
              success: false,
              message: "归档论文需要同时提供 paperId 和 folderIds 参数（folderIds 传空数组表示移出所有文件夹）",
            },
            meta: { reasoning, action },
          };
        }
        await setPaperFolders(paperId, folderIds);
        return {
          results: {
            success: true,
            message:
              folderIds.length === 0
                ? "论文已移出所有文件夹（未归档）"
                : `论文归属已整体替换为 ${folderIds.length} 个文件夹`,
          },
          meta: { reasoning, action, paperId, folderIds },
        };
      }

      return { results: { success: false, message: `未知操作: ${action}` }, meta: { reasoning, action } };
    } catch (error) {
      throw new Error(`文献库文件夹操作失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  },
});
