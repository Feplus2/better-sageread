import { appDataDir } from "@tauri-apps/api/path";
import { exists, readTextFile } from "@tauri-apps/plugin-fs";

/** 读取当前论文的 paper.md 原文（{appDataDir}/books/{paperId}/paper.md） */
export async function readPaperMarkdown(paperId: string): Promise<string> {
  const base = await appDataDir();
  return await readTextFile(`${base}/books/${paperId}/paper.md`);
}

/** 读取当前论文的 metadata.json（frontmatter JSON），不存在时返回 null */
export async function readPaperMetadataJson(paperId: string): Promise<string | null> {
  const base = await appDataDir();
  const metaPath = `${base}/books/${paperId}/metadata.json`;
  if (!(await exists(metaPath))) {
    return null;
  }
  return await readTextFile(metaPath);
}
