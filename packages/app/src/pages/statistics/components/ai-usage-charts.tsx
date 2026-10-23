import type { AiUsageEntry } from "@/services/ai-usage-service";
import dayjs from "dayjs";
import { BarChart3, BotIcon, ChartLine } from "lucide-react";
import { useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { TooltipContentProps } from "recharts";

export type StatUnit = "day" | "week" | "month" | "year" | "all";

/** 主图类型：柱状（按模型堆叠的总量） / 折线（每模型一条 token 曲线） */
type ChartMode = "bar" | "line";

const CHART_MODE_STORAGE_KEY = "statistics.chartMode";
const CHART_HEIGHT = 280;
const PIE_HEIGHT = 340;
const MODEL_COLOR_COUNT = 12;
const STACKED_BAR_RADIUS: [number, number, number, number] = [3, 3, 0, 0];

/** 精确数值（每 3 位一个逗号），用于宽位：卡片/悬浮提示 */
export function formatTokens(n: number): string {
  return n.toLocaleString("en-US");
}

/** 紧凑缩写（k/M/G，SI 阶梯；G 封顶——个人 token 用量到 T 属理论值），用于窄位：
 *  明细表列与 Y 轴刻度——精确逗号值此处放不下 */
function formatTokensCompact(n: number): string {
  const UNITS: Array<[number, string]> = [
    [1e9, "G"],
    [1e6, "M"],
    [1e3, "k"],
  ];
  for (const [size, unit] of UNITS) {
    if (n >= size) {
      const v = n / size;
      return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)}${unit}`;
    }
  }
  return String(n);
}

/** 模型色：主题变量 --stats-chart-1..12（由 index.css 按主题 primary 轻混），模型多于 12 个时循环 */
const chartColor = (index: number): string => `var(--stats-chart-${(index % MODEL_COLOR_COUNT) + 1})`;

const readChartMode = (): ChartMode => {
  try {
    return localStorage.getItem(CHART_MODE_STORAGE_KEY) === "line" ? "line" : "bar";
  } catch {
    // 隐私模式/存储被禁用时退回默认柱状图
    return "bar";
  }
};

interface AiUsageChartsProps {
  usage: AiUsageEntry[];
  unit: StatUnit;
}

interface Bucket {
  key: number;
  label: string;
}

interface ModelStats {
  key: string;
  name: string;
  total: number;
  input: number;
  output: number;
}

/** 图表行：bucket 为分桶标签，其余键为模型 key 的 token 数值 */
type ChartRow = Record<string, number | string>;

/** Tooltip payload 的结构收敛（recharts 3 的 payload 为内部宽泛类型） */
interface TooltipEntry {
  dataKey?: string | number;
  name?: string | number;
  value?: number | string;
  color?: string;
  payload?: { modelKey?: string; name?: string; value?: number };
}

interface UsageTooltipProps {
  active?: boolean;
  label?: string | number | null;
  payload?: ReadonlyArray<TooltipEntry>;
  modelIndexByKey: ReadonlyMap<string, number>;
}

/**
 * 柱状/折线/饼图共用的主题化 Tooltip：桶标签 + 非零模型按用量降序 + 合计行。
 * 颜色一律从模型下标重算 --stats-chart-N（不信任 recharts 传回的颜色，保证与图例/饼图一致）。
 */
const UsageTooltip = ({ active, label, payload, modelIndexByKey }: UsageTooltipProps) => {
  if (!active || !payload || payload.length === 0) return null;

  const rows = payload
    .map((entry) => {
      const payloadModelKey = typeof entry.payload?.modelKey === "string" ? entry.payload.modelKey : undefined;
      const dataKey = typeof entry.dataKey === "string" ? entry.dataKey : undefined;
      const byPayload = payloadModelKey == null ? undefined : modelIndexByKey.get(payloadModelKey);
      const byDataKey = dataKey == null ? undefined : modelIndexByKey.get(dataKey);
      const colorIndex = byPayload ?? byDataKey;
      const name = entry.name ?? entry.payload?.name;
      return {
        name: name == null || name === "" ? "未知模型" : String(name),
        value: Number(entry.value) || 0,
        color: colorIndex == null ? (entry.color ?? "var(--muted-foreground)") : chartColor(colorIndex),
      };
    })
    .filter((row) => row.value > 0)
    .sort((a, b) => b.value - a.value);

  if (rows.length === 0) return null;
  const total = payload.reduce((sum, entry) => sum + (Number(entry.value) || 0), 0);

  return (
    <div
      className="pointer-events-none min-w-44 rounded-lg border p-2.5 text-xs shadow-lg"
      style={{
        backgroundColor: "var(--popover)",
        color: "var(--popover-foreground)",
        borderColor: "var(--stats-border)",
        boxShadow: "0 10px 28px -16px color-mix(in oklab, var(--foreground) 45%, transparent)",
      }}
    >
      {label != null && label !== "" && (
        <p className="mb-1.5 font-medium" style={{ color: "var(--muted-foreground)" }}>
          {String(label)}
        </p>
      )}
      <ul className="space-y-1">
        {rows.map((row, i) => (
          <li className="flex items-center justify-between gap-5 tabular-nums" key={`${row.name}-${i}`}>
            <span className="flex min-w-0 items-center gap-1.5">
              <span
                aria-hidden="true"
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ backgroundColor: row.color }}
              />
              <span className="max-w-40 truncate">{row.name}</span>
            </span>
            <span>{formatTokens(row.value)}</span>
          </li>
        ))}
      </ul>
      <div
        className="mt-1.5 flex items-center justify-between gap-5 border-t pt-1.5"
        style={{ borderColor: "var(--stats-border)" }}
      >
        <span style={{ color: "var(--muted-foreground)" }}>合计</span>
        <span className="font-medium tabular-nums" style={{ color: "var(--foreground)" }}>
          {formatTokens(total)}
        </span>
      </div>
    </div>
  );
};

/**
 * AI 用量图表组：标题行（+ 图表类型切换）→ 主图（柱状/折线，固定 280px）→ 自定义图例 →
 * 分隔线 → 模型占比饼图 + 模型明细表。
 * 桶粒度随单位：日→小时 / 周·月→天 / 年→月 / 全部→年；全部配色走 --stats-* 主题变量。
 */
const AiUsageCharts = ({ usage, unit }: AiUsageChartsProps) => {
  const [chartMode, setChartMode] = useState<ChartMode>(readChartMode);
  /** 饼图悬停/点选中的模型下标：详情显示在圆心，不再用浮动 tooltip 卡片遮挡饼图本体 */
  const [activePieIndex, setActivePieIndex] = useState<number | null>(null);

  const buckets = useMemo<Bucket[]>(() => {
    const now = dayjs();
    switch (unit) {
      case "day":
        return Array.from({ length: 24 }, (_, h) => ({
          key: h,
          label: `${String(h).padStart(2, "0")}时`,
        }));
      case "week": {
        const monday = now.subtract((now.day() + 6) % 7, "day").startOf("day");
        return Array.from({ length: 7 }, (_, i) => {
          const d = monday.add(i, "day");
          return { key: d.valueOf(), label: d.format("M/D") };
        });
      }
      case "month":
        return Array.from({ length: now.daysInMonth() }, (_, i) => ({
          key: i + 1,
          label: `${i + 1}日`,
        }));
      case "year":
        return Array.from({ length: 12 }, (_, m) => ({ key: m, label: `${m + 1}月` }));
      case "all": {
        const years = usage.map((u) => dayjs(u.createdAt).year());
        const minY = years.length > 0 ? Math.min(...years) : now.year();
        return Array.from({ length: now.year() - minY + 1 }, (_, i) => ({
          key: minY + i,
          label: `${minY + i}`,
        }));
      }
      default:
        return [];
    }
  }, [unit, usage]);

  const bucketIndexOf = (ts: number): number => {
    const d = dayjs(ts);
    switch (unit) {
      case "day":
        return d.hour();
      case "week":
        return buckets.findIndex((b) => b.key === d.startOf("day").valueOf());
      case "month":
        return d.date() - 1;
      case "year":
        return d.month();
      case "all":
        return d.year() - (buckets[0]?.key ?? d.year());
      default:
        return -1;
    }
  };

  const models = useMemo<ModelStats[]>(() => {
    const m = new Map<string, ModelStats>();
    for (const u of usage) {
      const key = `${u.providerId}::${u.modelId}`;
      const cur = m.get(key) ?? {
        key,
        name: u.modelId || u.providerId || "未知模型",
        total: 0,
        input: 0,
        output: 0,
      };
      cur.input += u.inputTokens;
      cur.output += u.outputTokens;
      cur.total += u.inputTokens + u.outputTokens;
      m.set(key, cur);
    }
    return Array.from(m.values()).sort((a, b) => b.total - a.total);
  }, [usage]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: bucketIndexOf 由 unit/buckets 派生，随两者重算
  const chartData = useMemo<ChartRow[]>(() => {
    const rows = buckets.map((b) => ({
      bucket: b.label,
      ...Object.fromEntries(models.map((m) => [m.key, 0])),
    })) as ChartRow[];
    for (const u of usage) {
      const idx = bucketIndexOf(u.createdAt);
      if (idx < 0 || idx >= rows.length) continue;
      const key = `${u.providerId}::${u.modelId}`;
      rows[idx][key] = ((rows[idx][key] as number) ?? 0) + u.inputTokens + u.outputTokens;
    }
    return rows;
  }, [usage, buckets, models]);

  const modelIndexByKey = useMemo(() => {
    const map = new Map<string, number>();
    models.forEach((m, i) => map.set(m.key, i));
    return map;
  }, [models]);

  const grandTotal = models.reduce((sum, m) => sum + m.total, 0);
  const pieData = models.map((m) => ({ modelKey: m.key, name: m.name, value: m.total }));
  const activePie = activePieIndex == null ? null : (pieData[activePieIndex] ?? null);
  const activePiePercent = activePie && grandTotal > 0 ? (activePie.value / grandTotal) * 100 : 0;

  const changeChartMode = (mode: ChartMode) => {
    setChartMode(mode);
    try {
      localStorage.setItem(CHART_MODE_STORAGE_KEY, mode);
    } catch {
      // 写失败不影响本次会话内的切换
    }
  };

  const renderTooltip = (props: TooltipContentProps<number, string>) => (
    <UsageTooltip
      active={props.active}
      label={props.label}
      modelIndexByKey={modelIndexByKey}
      payload={props.payload as unknown as ReadonlyArray<TooltipEntry>}
    />
  );

  if (usage.length === 0 || grandTotal === 0) {
    return (
      <div className="flex min-h-[280px] flex-col items-center justify-center gap-2 text-center">
        <span className="flex h-11 w-11 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <BotIcon aria-hidden="true" className="h-5 w-5" />
        </span>
        <p className="font-medium text-foreground text-sm">暂无 AI 用量数据</p>
        <p className="max-w-sm text-muted-foreground text-xs leading-relaxed">
          开始对话后，这里会随每次回复累积 token 统计；切换右上角的时间范围可查看不同区间。
        </p>
      </div>
    );
  }

  return (
    <div className="min-w-0 text-foreground">
      {/* 标题行：左标题 + 右侧图表类型分段切换 */}
      <div className="flex flex-wrap items-center justify-between gap-3 pb-3">
        <h3 className="font-medium text-foreground text-sm">用量分布（输入 + 输出）</h3>
        <div aria-label="图表类型" className="stats-segmented" role="group">
          <button
            aria-pressed={chartMode === "bar"}
            className="stats-segmented-item cursor-pointer"
            data-active={chartMode === "bar"}
            onClick={() => changeChartMode("bar")}
            type="button"
          >
            <BarChart3 aria-hidden="true" className="h-3.5 w-3.5" />
            柱状图
          </button>
          <button
            aria-pressed={chartMode === "line"}
            className="stats-segmented-item cursor-pointer"
            data-active={chartMode === "line"}
            onClick={() => changeChartMode("line")}
            type="button"
          >
            <ChartLine aria-hidden="true" className="h-3.5 w-3.5" />
            折线图
          </button>
        </div>
      </div>

      {/* 主图：容器固定 280px；key 随模式变化触发 .motion-enter-fade 淡入，高度不跳动 */}
      <div className="motion-enter-fade w-full" key={chartMode} style={{ height: CHART_HEIGHT }}>
        <ResponsiveContainer height="100%" width="100%">
          {chartMode === "bar" ? (
            <BarChart barCategoryGap="16%" data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid stroke="var(--stats-border)" strokeDasharray="3 3" vertical={false} />
              <XAxis
                axisLine={false}
                dataKey="bucket"
                interval="preserveStartEnd"
                minTickGap={8}
                tick={{ fill: "var(--muted-foreground)", fontSize: 11 }}
                tickLine={false}
              />
              <YAxis
                allowDecimals={false}
                axisLine={false}
                tick={{ fill: "var(--muted-foreground)", fontSize: 11 }}
                tickFormatter={(v: number) => formatTokensCompact(v)}
                tickLine={false}
                width={56}
              />
              <Tooltip<number, string>
                content={renderTooltip}
                cursor={{ fill: "color-mix(in oklab, var(--muted-foreground) 8%, transparent)" }}
              />
              {models.map((m, i) => (
                <Bar
                  dataKey={m.key}
                  fill={chartColor(i)}
                  isAnimationActive={false}
                  key={m.key}
                  maxBarSize={32}
                  name={m.name}
                  radius={i === models.length - 1 ? STACKED_BAR_RADIUS : undefined}
                  stackId="tokens"
                />
              ))}
            </BarChart>
          ) : (
            <LineChart data={chartData} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
              <CartesianGrid stroke="var(--stats-border)" strokeDasharray="3 3" vertical={false} />
              <XAxis
                axisLine={false}
                dataKey="bucket"
                interval="preserveStartEnd"
                minTickGap={8}
                tick={{ fill: "var(--muted-foreground)", fontSize: 11 }}
                tickLine={false}
              />
              <YAxis
                allowDecimals={false}
                axisLine={false}
                tick={{ fill: "var(--muted-foreground)", fontSize: 11 }}
                tickFormatter={(v: number) => formatTokensCompact(v)}
                tickLine={false}
                width={56}
              />
              <Tooltip<number, string>
                content={renderTooltip}
                cursor={{
                  stroke: "color-mix(in oklab, var(--muted-foreground) 30%, transparent)",
                  strokeDasharray: "3 3",
                  strokeWidth: 1,
                }}
              />
              {models.map((m, i) => (
                <Line
                  activeDot={{ fill: chartColor(i), r: 4, stroke: "var(--primary)", strokeWidth: 2 }}
                  dataKey={m.key}
                  dot={false}
                  isAnimationActive={false}
                  key={m.key}
                  name={m.name}
                  stroke={chartColor(i)}
                  strokeWidth={2}
                  type="monotone"
                />
              ))}
            </LineChart>
          )}
        </ResponsiveContainer>
      </div>

      {/* 自定义图例：与 recharts Legend 解耦，柱/折切换时内容与高度完全一致 */}
      <ul className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
        {models.map((m, i) => (
          <li
            className="flex min-w-0 items-center gap-1.5"
            key={m.key}
            title={`${m.name} · ${formatTokens(m.total)} tokens`}
          >
            <span
              aria-hidden="true"
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ backgroundColor: chartColor(i) }}
            />
            <span className="max-w-40 truncate text-muted-foreground">{m.name}</span>
            <span className="text-muted-foreground tabular-nums">{formatTokensCompact(m.total)}</span>
          </li>
        ))}
      </ul>

      <div aria-hidden="true" className="stats-rule my-5" />

      <div className="grid gap-6 lg:grid-cols-2 lg:items-center lg:gap-8">
        {/* 饼图：详情直接显示在圆心（悬停/点选扇区），不再弹浮动卡片遮挡饼图本体 */}
        <section aria-label="模型用量占比" className="min-w-0">
          <h4 className="font-medium text-foreground text-sm">模型用量占比</h4>
          <div className="relative mt-1" onMouseLeave={() => setActivePieIndex(null)} style={{ height: PIE_HEIGHT }}>
            <ResponsiveContainer height="100%" width="100%">
              <PieChart>
                <Pie
                  data={pieData}
                  dataKey="value"
                  innerRadius="50%"
                  isAnimationActive={false}
                  nameKey="name"
                  onClick={(_, index) => setActivePieIndex((cur) => (cur === index ? null : index))}
                  onMouseEnter={(_, index) => setActivePieIndex(index)}
                  outerRadius="88%"
                  paddingAngle={2}
                  stroke="var(--stats-surface)"
                  strokeWidth={2}
                >
                  {pieData.map((entry, i) => (
                    <Cell
                      className="cursor-pointer"
                      fill={chartColor(i)}
                      key={entry.modelKey}
                      style={{
                        opacity: activePieIndex != null && activePieIndex !== i ? 0.4 : 1,
                        transition: "opacity var(--motion-dur-fast) var(--motion-ease)",
                      }}
                    />
                  ))}
                </Pie>
              </PieChart>
            </ResponsiveContainer>
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center px-6 text-center">
              {activePie ? (
                <>
                  <span className="flex max-w-full items-center gap-1.5 text-muted-foreground text-xs">
                    <span
                      aria-hidden="true"
                      className="h-2 w-2 shrink-0 rounded-full"
                      style={{ backgroundColor: chartColor(activePieIndex ?? 0) }}
                    />
                    <span className="truncate" title={activePie.name}>
                      {activePie.name}
                    </span>
                  </span>
                  <span
                    className="mt-1 font-semibold text-2xl text-foreground tabular-nums leading-tight"
                    title={`${formatTokens(activePie.value)} tokens`}
                  >
                    {formatTokensCompact(activePie.value)}
                  </span>
                  <span className="text-[11px] text-muted-foreground tabular-nums">
                    占比 {activePiePercent >= 10 ? activePiePercent.toFixed(1) : activePiePercent.toFixed(2)}%
                  </span>
                </>
              ) : (
                <>
                  <span
                    className="font-semibold text-3xl text-foreground tabular-nums leading-tight"
                    title={`${formatTokens(grandTotal)} tokens`}
                  >
                    {formatTokensCompact(grandTotal)}
                  </span>
                  <span className="mt-0.5 text-muted-foreground text-xs">tokens 总量</span>
                </>
              )}
            </div>
          </div>
        </section>

        {/* 明细表 */}
        <section aria-label="模型明细" className="min-w-0">
          <h4 className="font-medium text-foreground text-sm">模型明细</h4>
          <div className="mt-1 overflow-x-auto">
            <table className="stats-table">
              <thead>
                <tr>
                  <th className="pr-3 pb-2">模型</th>
                  <th className="px-2 pb-2 text-right">输入</th>
                  <th className="px-2 pb-2 text-right">输出</th>
                  <th className="px-2 pb-2 text-right">合计</th>
                  <th className="pb-2 pl-2 text-right">占比</th>
                </tr>
              </thead>
              <tbody>
                {models.map((m, i) => (
                  <tr key={m.key}>
                    <td className="max-w-40 py-2 pr-3" title={m.name}>
                      <span className="flex min-w-0 items-center gap-2">
                        <span
                          aria-hidden="true"
                          className="h-2 w-2 shrink-0 rounded-full"
                          style={{ backgroundColor: chartColor(i) }}
                        />
                        <span className="truncate">{m.name}</span>
                      </span>
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums">{formatTokensCompact(m.input)}</td>
                    <td className="px-2 py-2 text-right tabular-nums">{formatTokensCompact(m.output)}</td>
                    <td className="px-2 py-2 text-right font-medium tabular-nums">{formatTokensCompact(m.total)}</td>
                    <td className="py-2 pl-2 text-right tabular-nums">
                      {grandTotal > 0 ? `${((m.total / grandTotal) * 100).toFixed(1)}%` : "-"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
  );
};

export default AiUsageCharts;
