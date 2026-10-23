import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { ReadingSessionStats } from "@/services/reading-session-service";
import HeatMap from "@uiw/react-heat-map";
import dayjs from "dayjs";
import { useEffect, useMemo, useRef, useState } from "react";

interface ReadingHeatMapProps {
  data: ReadingSessionStats[];
  /** 热力图年份（父级年份选择器控制；data 须为该年切片） */
  year: number;
}

interface HeatMapValue {
  date: string;
  count: number;
}

/** 一年 53 列（含首尾跨年补齐列）。 */
const COLS = 53;
const DAYS_IN_WEEK = 7;
const RECT_GAP = 2;
const MIN_RECT = 8;
const MAX_RECT = 18;

/** 月份/星期标签提成模块常量：引用稳定，避免 @uiw/react-heat-map 内部 effect 因数组换新反复 setState。 */
const MONTH_LABELS = ["1月", "2月", "3月", "4月", "5月", "6月", "7月", "8月", "9月", "10月", "11月", "12月"];
const WEEK_LABELS = ["日", "一", "二", "三", "四", "五", "六"];

/**
 * 色阶完全从主题语义变量派生（默认明暗 + 羊皮纸/蛋糕/怜烟/蒙德里安/莫兰迪共 12 个变体都自适应）：
 * - 0 档 = 前景色 12% 半透明，只是淡淡底格（怜烟这类半透明主题也不会糊成一片）；
 * - 1..5 档 = primary 与 muted 混合（而不是混 transparent）：浅色主题里越深越暗、深色主题里越深越亮，
 *   半透明主题下仍有足够不透明度，不会随背景视频一起发虚。
 * 档位阈值沿用原「按 maxCount 百分比分 5 档」逻辑（由下方 panelColors useMemo 计算）。
 */
const EMPTY_CELL_COLOR = "color-mix(in oklab, var(--muted-foreground) 18%, transparent)";
const LEVEL_PRIMARY_PERCENT = [20, 36, 52, 68, 86];

/**
 * 单元格交互样式（组件内联，只作用于本热力图，不往全局 index.css 加规则）：
 * - hover：主色 2px 描边 + 主色荧光（纯 CSS，全图共 370 个 rect 也只有一条规则，无逐帧 JS）；
 * - 今天：常驻主色环 + 柔光；
 * - 选择器带上 .sage-heatmap-shell / rect.sage-heatmap-cell 提高优先级，压过
 *   @uiw/react-heat-map 自带的 svg.w-heatmap rect:hover（写死 rgba 黑描边）；
 * - 所有颜色 color-mix 自 --primary，时长/缓动只引用动效 token。
 */
const CELL_CSS = `
.sage-heatmap-shell svg.w-heatmap rect.sage-heatmap-cell {
  stroke: transparent;
  stroke-width: 2px;
  shape-rendering: geometricPrecision;
  transition:
    stroke var(--motion-dur-fast) var(--motion-ease),
    filter var(--motion-dur-base) var(--motion-ease);
}
.sage-heatmap-shell svg.w-heatmap rect.sage-heatmap-cell[data-today="true"] {
  stroke: var(--primary);
  filter: drop-shadow(0 0 4px color-mix(in oklab, var(--primary) 60%, transparent));
}
.sage-heatmap-shell svg.w-heatmap rect.sage-heatmap-cell:hover {
  stroke: var(--primary);
  filter: drop-shadow(0 1px 3px color-mix(in oklab, var(--primary) 55%, transparent));
}
.sage-heatmap-shell svg.w-heatmap text {
  font-variant-numeric: tabular-nums;
}
/* 热力图 Tooltip 与图表 Tooltip 同一视觉语言：popover 承力面 + 主题边框/文字，
 * 不复用全局 TooltipContent 的 bg-primary——莫兰迪等主题 primary/primary-foreground
 * 这对色只有 3.66:1，浅色 primary 主题下小字会看不清。 */
.sage-heatmap-tooltip[data-slot="tooltip-content"] {
  border: 1px solid var(--stats-border);
  border-radius: 0.5rem;
  background-color: var(--popover);
  color: var(--popover-foreground);
  box-shadow: 0 10px 28px -16px color-mix(in oklab, var(--foreground) 45%, transparent);
}
/* Radix Arrow 的 DOM 是 <span><svg class="bg-primary fill-primary">…</svg></span>，
 * svg 并非 content 的直接子节点，必须用后代选择器才能压掉全局 primary 箭头色 */
.sage-heatmap-tooltip svg {
  fill: var(--popover);
  background-color: var(--popover);
}
`;

function useResizeObserver<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    if (!ref.current) return;
    let raf = 0;
    const ro = new ResizeObserver((entries) => {
      const cr = entries[0]?.contentRect;
      if (!cr) return;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => setWidth(cr.width));
    });
    ro.observe(ref.current);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, []);

  return { ref, width };
}

/** 把 @uiw/react-heat-map 归一化后的 "YYYY/M/D" 补零成 "YYYY-MM-DD"（tooltip 展示 + 今天判定）。 */
function toIsoDate(date: string) {
  const [y, m, d] = date.split("/");
  if (!y || !m || !d) return date;
  return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
}

const ReadingHeatMap = ({ data, year }: ReadingHeatMapProps) => {
  const { ref, width } = useResizeObserver<HTMLDivElement>();

  const today = useMemo(() => dayjs().format("YYYY-MM-DD"), []);

  const { startDate, endDate } = useMemo(() => {
    return { startDate: new Date(year, 0, 1), endDate: new Date(year, 11, 31) };
  }, [year]);

  /**
   * 布局：rect 尺寸按容器宽度反推（53 列 + 标签列 + 列间距都要装下），
   * 并给库内部 gridNum = floor((svg 宽 - leftPad) / (rect + gap)) 留够格子，
   * 避免最后一周被 floor 抹掉（旧实现少减 leftPad，宽窗口下会丢最后一列）。
   * 高度只留标签 + 7 行格子 + 少量底部余量，去掉库自带的无用留白，让图例行贴近热力图。
   */
  const { rectSize, containerHeight, showLabels } = useMemo(() => {
    const shouldShowLabels = width > 350;
    const leftPad = shouldShowLabels ? 28 : 5;
    const topPad = shouldShowLabels ? 20 : 5;
    const bottomPad = 8;

    let size = MIN_RECT;
    if (width > 0) {
      const usable = width - leftPad - COLS * RECT_GAP;
      size = Math.max(MIN_RECT, Math.min(MAX_RECT, Math.floor(usable / COLS)));
    }

    const height = topPad + DAYS_IN_WEEK * size + (DAYS_IN_WEEK - 1) * RECT_GAP + bottomPad;

    return { rectSize: size, containerHeight: Math.floor(height), showLabels: shouldShowLabels };
  }, [width]);

  const heatMapValue = useMemo<HeatMapValue[]>(() => {
    return data.map((item) => {
      const minutes = Math.max(0, Math.round(item.totalDuration / 60));
      return { date: item.date.replace(/-/g, "/"), count: minutes };
    });
  }, [data]);

  const maxCount = useMemo(() => {
    return data.reduce((max, item) => Math.max(max, Math.max(0, Math.round(item.totalDuration / 60))), 0);
  }, [data]);

  const panelColors = useMemo<Record<number, string>>(() => {
    const colors: Record<number, string> = { 0: EMPTY_CELL_COLOR };
    if (maxCount <= 0) return colors;

    const s1 = Math.max(1, Math.round(maxCount * 0.2));
    const s2 = Math.max(s1 + 1, Math.round(maxCount * 0.4));
    const s3 = Math.max(s2 + 1, Math.round(maxCount * 0.6));
    const s4 = Math.max(s3 + 1, Math.round(maxCount * 0.8));
    const s5 = Math.max(s4 + 1, maxCount);

    [s1, s2, s3, s4, s5].forEach((threshold, index) => {
      colors[threshold] = `color-mix(in oklab, var(--primary) ${LEVEL_PRIMARY_PERCENT[index]}%, var(--muted))`;
    });

    return colors;
  }, [maxCount]);

  /** 图例色块：0 档 + 5 个强度档全展示（旧实现只画到第 4 档，最高档缺一格）。 */
  const legendKeys = useMemo(
    () =>
      Object.keys(panelColors)
        .map(Number)
        .sort((a, b) => a - b),
    [panelColors],
  );

  /** 底部统计：阅读天数（有实际时长的天数）+ 该年总时长。 */
  const summary = useMemo(() => {
    let seconds = 0;
    let activeDays = 0;
    for (const item of data) {
      const value = Math.max(0, item.totalDuration);
      seconds += value;
      if (value > 0) activeDays += 1;
    }
    const hours = seconds / 3600;
    const durationText =
      hours >= 1
        ? `${hours >= 10 ? Math.round(hours) : Number(hours.toFixed(1))} 小时`
        : `${Math.round(seconds / 60)} 分钟`;
    return { activeDays, durationText };
  }, [data]);

  return (
    <div className="sage-heatmap-shell w-full overflow-hidden">
      <style>{CELL_CSS}</style>
      <div ref={ref} className="w-full">
        <HeatMap
          value={heatMapValue}
          startDate={startDate}
          endDate={endDate}
          panelColors={panelColors}
          rectSize={rectSize}
          legendCellSize={0}
          space={RECT_GAP}
          width={width > 0 ? Math.floor(width) : undefined}
          height={containerHeight}
          style={{ color: "var(--muted-foreground)" }}
          monthLabels={showLabels ? MONTH_LABELS : false}
          weekLabels={showLabels ? WEEK_LABELS : false}
          rectRender={(props, value) => {
            const isoDate = toIsoDate(value.date);
            const isToday = isoDate === today;
            const minutes = Math.max(0, Math.round(Number(value.count) || 0));
            const hasData = minutes > 0;
            const fill = typeof props.fill === "string" ? props.fill : undefined;

            return (
              <Tooltip key={`${value.column}-${value.row}`}>
                <TooltipTrigger asChild>
                  <rect
                    {...props}
                    rx={2}
                    ry={2}
                    className="sage-heatmap-cell"
                    data-today={isToday ? "true" : undefined}
                    // 内联 fill：同时压掉库自带的 rect:active 写死绿色（#196127），保持主题色阶
                    style={{ ...props.style, fill }}
                  />
                </TooltipTrigger>
                <TooltipContent className="sage-heatmap-tooltip" side="top" sideOffset={6}>
                  {/* 次要信息不再降透明度：Tooltip 底是 var(--primary)，parchment/cake 等
                      浅 primary 主题下 primary-foreground/80 只有 ~2.9:1；改用同色 + 字重区分 */}
                  <div className="font-medium tabular-nums">
                    {isoDate}
                    <span className="font-normal">
                      {" · "}
                      {hasData ? `${minutes} 分钟` : "无阅读记录"}
                    </span>
                  </div>
                </TooltipContent>
              </Tooltip>
            );
          }}
        />

        <div className="mt-3 flex flex-wrap items-center justify-between gap-x-6 gap-y-2 text-xs">
          <div className="flex items-center gap-2 text-muted-foreground">
            <span>少</span>
            <div className="flex items-center gap-1">
              {legendKeys.map((key) => (
                <span
                  key={key}
                  aria-hidden="true"
                  className="size-3 rounded-[3px] ring-1 ring-border"
                  style={{ backgroundColor: panelColors[key] }}
                />
              ))}
            </div>
            <span>多</span>
          </div>

          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground tabular-nums">
            <span>
              共 <span className="font-semibold text-foreground">{summary.activeDays}</span> 天
            </span>
            <span aria-hidden="true">·</span>
            <span>
              总时长 <span className="font-semibold text-foreground">{summary.durationText}</span>
            </span>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ReadingHeatMap;
