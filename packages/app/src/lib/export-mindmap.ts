import { save } from "@tauri-apps/plugin-dialog";
import { writeFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { globalCSS } from "markmap-view";
import { toast } from "sonner";

const PNG_SCALE = 2; // 2x 渲染提升清晰度
const MAX_CANVAS_EDGE = 16000; // Chromium 画布边长上限 16384，留余量
const EXPORT_PADDING = 24;

/**
 * 序列化 markmap SVG 为独立文件文本：
 * - 去掉当前缩放/平移，导出完整导图而非视口截图（viewBox 取内容 bbox）；
 * - 内联 markmap 全局样式（独立 SVG 脱离文档后丢失页面里的 globalCSS）；
 * - globalCSS 内含 prefers-color-scheme 暗色媒体查询（随查看者系统漂移），
 *   追加同优先级规则按导出时主题钉死变量终值（口径同 mindmap-viewer 的暗色覆盖）。
 */
function buildStandaloneSvg(
  svg: SVGSVGElement,
  isDark: boolean,
): { text: string; width: number; height: number } | null {
  const inner = svg.querySelector("g");
  if (!inner) return null;
  let bbox: DOMRect;
  try {
    // getBBox 不受元素自身 transform 影响，拿到的是全图未缩放坐标
    bbox = inner.getBBox();
  } catch {
    return null;
  }
  if (!bbox.width || !bbox.height) return null;

  const x = Math.floor(bbox.x - EXPORT_PADDING);
  const y = Math.floor(bbox.y - EXPORT_PADDING);
  const width = Math.ceil(bbox.width + EXPORT_PADDING * 2);
  const height = Math.ceil(bbox.height + EXPORT_PADDING * 2);

  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.querySelector("g")?.removeAttribute("transform");
  clone.setAttribute("viewBox", `${x} ${y} ${width} ${height}`);
  clone.setAttribute("width", String(width));
  clone.setAttribute("height", String(height));
  // 只保留 markmap 类（globalCSS 的选择器是 svg.markmap）；去掉布局类与内联背景
  clone.setAttribute("class", "markmap");
  clone.removeAttribute("style");

  const style = document.createElementNS("http://www.w3.org/2000/svg", "style");
  style.textContent = `${globalCSS}\nsvg.markmap {\n  --markmap-text-color: ${isDark ? "#e8e6e3" : "#333"};\n  --markmap-circle-open-bg: ${isDark ? "#262626" : "#fff"};\n}`;
  clone.insertBefore(style, clone.firstChild);

  return { text: new XMLSerializer().serializeToString(clone), width, height };
}

/** SVG 文本 → PNG Blob（data: URL 加载——blob: URL 的 foreignObject SVG 会被 Chromium 标记污染，无法 toBlob） */
async function svgTextToPngBlob(text: string, width: number, height: number, isDark: boolean): Promise<Blob> {
  const scale = Math.max(0.25, Math.min(PNG_SCALE, MAX_CANVAS_EDGE / width, MAX_CANVAS_EDGE / height));
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}`;
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error("SVG 图像加载失败"));
    el.src = url;
  });

  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(width * scale);
  canvas.height = Math.ceil(height * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("无法创建画布上下文");
  // PNG 填底（SVG 本身透明底）：暗色主题深底、浅色主题白底，保证文字可读
  ctx.fillStyle = isDark ? "#171717" : "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.scale(scale, scale);
  ctx.drawImage(img, 0, 0);

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("图片生成失败");
  return blob;
}

/** 导出思维导图为 SVG（完整内容、内联样式、按当前主题配色） */
export async function exportMindmapSvg(svg: SVGSVGElement | null, isDark: boolean): Promise<boolean> {
  const built = svg ? buildStandaloneSvg(svg, isDark) : null;
  if (!built) {
    toast.error("导出失败：无法读取导图内容");
    return false;
  }
  try {
    const path = await save({
      defaultPath: "思维导图.svg",
      filters: [{ name: "SVG 矢量图", extensions: ["svg"] }],
    });
    if (!path) return false;
    await writeTextFile(path, built.text);
    toast.success("思维导图已导出 SVG");
    return true;
  } catch (error) {
    console.error("导出思维导图 SVG 失败:", error);
    toast.error("导出思维导图失败");
    return false;
  }
}

/** 导出思维导图为 PNG（2x 清晰度，按当前主题填底） */
export async function exportMindmapPng(svg: SVGSVGElement | null, isDark: boolean): Promise<boolean> {
  const built = svg ? buildStandaloneSvg(svg, isDark) : null;
  if (!built) {
    toast.error("导出失败：无法读取导图内容");
    return false;
  }
  try {
    const blob = await svgTextToPngBlob(built.text, built.width, built.height, isDark);
    const path = await save({
      defaultPath: "思维导图.png",
      filters: [{ name: "PNG 图片", extensions: ["png"] }],
    });
    if (!path) return false;
    await writeFile(path, new Uint8Array(await blob.arrayBuffer()));
    toast.success("思维导图已导出 PNG");
    return true;
  } catch (error) {
    console.error("导出思维导图 PNG 失败:", error);
    toast.error("导出思维导图失败");
    return false;
  }
}

/** 导出思维导图源 Markdown（markmap 输入文本，可再次生成/编辑） */
export async function exportMindmapMarkdown(markdown: string): Promise<boolean> {
  try {
    const path = await save({
      defaultPath: "思维导图.md",
      filters: [{ name: "Markdown", extensions: ["md"] }],
    });
    if (!path) return false;
    await writeTextFile(path, markdown);
    toast.success("思维导图已导出 Markdown");
    return true;
  } catch (error) {
    console.error("导出思维导图 Markdown 失败:", error);
    toast.error("导出思维导图失败");
    return false;
  }
}
