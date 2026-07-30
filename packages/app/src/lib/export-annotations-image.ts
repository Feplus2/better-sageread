import type { BookNote } from "@/types/book";
import { save } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";
import { toast } from "sonner";
import {
  EXPORT_ANNOTATIONS_CSS,
  buildAnnotationsHeaderHtml,
  buildAnnotationsListHtml,
} from "./export-annotations-html";
import { type AnnotationExportMeta, toSafeAnnotationFileName } from "./export-annotations-markdown";

const MAX_HEIGHT = 16000; // Chromium 画布高度上限 16384，留余量
const RENDER_WIDTH = 880;
const RENDER_SCALE = 2; // 2x 渲染提升清晰度

/**
 * 渲染机制同 export-thread-image（迷你 html-to-image）：
 * 把标注导出 HTML 填进离屏隐藏容器，XMLSerializer 序列化进 SVG foreignObject，再绘制到 canvas。
 * 内容全内联无外部资源，canvas 不会被污染。
 */
export async function renderAnnotationsToPngBlob(annotations: BookNote[], meta: { title: string }): Promise<Blob> {
  // 离屏定位放在外层包装元素上；被序列化的容器自身不能有 left:-9999px，
  // 否则 SVG 视口内同样偏移 -9999px 渲染空白（thread 导出已踩坑验证）
  const offscreen = document.createElement("div");
  offscreen.style.cssText = "position:absolute;left:-9999px;top:0;";
  const container = document.createElement("div");
  // 容器内联 body 等价样式（EXPORT_ANNOTATIONS_CSS 里的 body 选择器对 div 不生效）
  container.style.cssText = `width:${RENDER_WIDTH}px;background:#f5f1e8;color:#3a3226;font-family:"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;line-height:1.7;padding:32px 16px;`;
  container.innerHTML = `<style>${EXPORT_ANNOTATIONS_CSS}</style><div class="container">${buildAnnotationsHeaderHtml({
    title: meta.title,
    count: annotations.length,
  })}<main>${buildAnnotationsListHtml(annotations)}</main></div>`;
  offscreen.appendChild(container);
  document.body.appendChild(offscreen);

  try {
    // 高度超限：从尾部移除标注卡片直到放得下，再补截断提示
    if (container.offsetHeight > MAX_HEIGHT) {
      const annotationEls = Array.from(container.querySelectorAll(".annotation"));
      for (let i = annotationEls.length - 1; i >= 0 && container.offsetHeight > MAX_HEIGHT - 60; i--) {
        annotationEls[i].remove();
      }
      const notice = document.createElement("div");
      notice.style.cssText = "text-align:center;font-size:12px;color:#8a7c60;padding:12px 0;";
      notice.textContent = "标注过多，已截断（完整内容请导出 Markdown）";
      container.querySelector("main")?.appendChild(notice);
    }

    const height = Math.min(container.offsetHeight, MAX_HEIGHT);
    const serialized = new XMLSerializer().serializeToString(container);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${RENDER_WIDTH}" height="${height}"><foreignObject width="100%" height="100%">${serialized}</foreignObject></svg>`;
    // 用 data: URL 而非 blob: URL——blob 加载的 foreignObject SVG 会被 Chromium 标记污染，无法 toBlob
    const svgUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("SVG 图像加载失败"));
      el.src = svgUrl;
    });

    const canvas = document.createElement("canvas");
    canvas.width = RENDER_WIDTH * RENDER_SCALE;
    canvas.height = height * RENDER_SCALE;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("无法创建画布上下文");
    ctx.scale(RENDER_SCALE, RENDER_SCALE);
    ctx.drawImage(img, 0, 0);

    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("图片生成失败");
    return blob;
  } finally {
    offscreen.remove();
  }
}

/**
 * 弹出保存对话框并将一组标注渲染为 PNG 长图
 */
export async function exportAnnotationsToImage(annotations: BookNote[], meta: AnnotationExportMeta): Promise<boolean> {
  if (annotations.length === 0) {
    toast.error("没有可导出的内容");
    return false;
  }

  let blob: Blob;
  try {
    blob = await renderAnnotationsToPngBlob(annotations, meta);
  } catch (error) {
    console.error("导出标注失败:", error);
    toast.error("导出标注失败");
    return false;
  }

  try {
    const path = await save({
      defaultPath: `${toSafeAnnotationFileName(meta.title)}-标注.png`,
      filters: [
        {
          name: "PNG 图片",
          extensions: ["png"],
        },
      ],
    });

    // 用户取消保存，不视为失败
    if (!path) {
      return false;
    }

    await writeFile(path, new Uint8Array(await blob.arrayBuffer()));
    toast.success(meta.successText ?? "标注导出成功");
    return true;
  } catch (error) {
    console.error("导出标注失败:", error);
    toast.error("导出标注失败");
    return false;
  }
}
