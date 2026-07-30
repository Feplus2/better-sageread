/**
 * 句子悬浮覆盖层的 rect 几何求并（纯函数，无 DOM 依赖，可用 node 断言自测）。
 *
 * Range.getClientRects() 对 inline 组件会返回多个互相重叠的 rect：
 * KaTeX 可见 span 与隐藏 MathML 副本同位叠加、vlist 内部多层 span、sup/sub 抬升盒、
 * 列表编号的 ::marker 盒等。覆盖层 tint 是半透明色，重叠处会叠加深色（渲染 bug）。
 * 故渲染前先做几何求并：y 区间相交的 rect 归入同一视觉行带（传递闭包），行带内
 * x 区间相交或贴边的合并为外包矩形；跨行的 rect 不合并，避免拼出超大矩形。
 */

export interface HoverRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 贴边/亚像素舍入容差（px）：重叠不足 1px 不视作相交，避免相邻两行因舍入贴边被并成一行 */
const MERGE_EPS = 1;

/** 重叠 rect 几何求并：同一视觉行带内 x 相交/贴边的合并为外包矩形，跨行不合并 */
export function mergeOverlappingRects(rects: HoverRect[]): HoverRect[] {
  if (rects.length <= 1) return [...rects];

  // 1) 按 y 排序扫描：rect 的 y 区间与当前行带的 y 区间相交（> EPS）则入行带（传递闭包，sup/sub 抬升盒随所在行）
  const sorted = [...rects].sort((a, b) => a.y - b.y || a.x - b.x);
  const bands: { top: number; bottom: number; rects: HoverRect[] }[] = [];
  for (const rect of sorted) {
    const top = rect.y;
    const bottom = rect.y + rect.height;
    const band = bands[bands.length - 1];
    if (band && top < band.bottom - MERGE_EPS) {
      band.rects.push(rect);
      band.top = Math.min(band.top, top);
      band.bottom = Math.max(band.bottom, bottom);
    } else {
      bands.push({ top, bottom, rects: [rect] });
    }
  }

  // 2) 行带内按 x 排序：x 区间相交或贴边（gap ≤ EPS）的合并为外包矩形；相离的各自保留
  const merged: HoverRect[] = [];
  for (const band of bands) {
    const byX = [...band.rects].sort((a, b) => a.x - b.x);
    let left = byX[0].x;
    let top = byX[0].y;
    let right = byX[0].x + byX[0].width;
    let bottom = byX[0].y + byX[0].height;
    const flush = () => merged.push({ x: left, y: top, width: right - left, height: bottom - top });
    for (let i = 1; i < byX.length; i++) {
      const rect = byX[i];
      if (rect.x <= right + MERGE_EPS) {
        left = Math.min(left, rect.x);
        top = Math.min(top, rect.y);
        right = Math.max(right, rect.x + rect.width);
        bottom = Math.max(bottom, rect.y + rect.height);
      } else {
        flush();
        left = rect.x;
        top = rect.y;
        right = rect.x + rect.width;
        bottom = rect.y + rect.height;
      }
    }
    flush();
  }
  return merged;
}
