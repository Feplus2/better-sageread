import type { BookNote } from "@/types/book";
import { appDataDir, join } from "@tauri-apps/api/path";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import { openPath } from "@tauri-apps/plugin-opener";
import { toast } from "sonner";
import { buildAnnotationsHtml } from "./export-annotations-html";
import type { AnnotationExportMeta } from "./export-annotations-markdown";

/**
 * PDF 导出：项目无 jsPDF/html2canvas 依赖（thread 导出三件套也无 PDF 先例），
 * 走"生成打印版 HTML → 系统浏览器打开 → 打印另存为 PDF"路线：
 * 把自包含 HTML 写到 appDataDir（fs/opener 权限均已授权该目录），
 * openPath 交给默认浏览器打开，页面加载后自动唤起打印对话框，目标选"另存为 PDF"。
 * 文件名固定，每次导出覆盖同一临时文件。
 */
export async function exportAnnotationsToPdf(annotations: BookNote[], meta: AnnotationExportMeta): Promise<boolean> {
  try {
    if (annotations.length === 0) {
      toast.error("没有可导出的内容");
      return false;
    }

    const html = buildAnnotationsHtml(annotations, meta, { autoPrint: true });
    const path = await join(await appDataDir(), "annotations-print.html");
    await writeTextFile(path, html);
    await openPath(path);
    toast.success("已在浏览器打开打印页，打印机选“另存为 PDF”即可", { duration: 6000 });
    return true;
  } catch (error) {
    console.error("导出 PDF 失败:", error);
    toast.error("导出 PDF 失败");
    return false;
  }
}
