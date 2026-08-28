import type { AiUsageEntry } from "@/services/ai-usage-service";
import dayjs from "dayjs";
import { useMemo } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

export type StatUnit = "day" | "week" | "month" | "year" | "all";

const MODEL_COLORS = [
  "#3b82f6",
  "#22c55e",
  "#f59e0b",
  "#ef4444",
  "#a855f7",
  "#06b6d4",
  "#ec4899",
  "#84cc16",
  "#f97316",
  "#14b8a6",
  "#6366f1",
  "#eab308",
];

export function formatTokens(n: number): string {
  if (n >= 1e8) return `${(n / 1e8).toFixed(2)} 亿`;
  if (n >= 1e4) return `${(n / 1e4).toFixed(1)} 万`;
  return n.toLocaleString();
}

interface AiUsageChartsProps {
  usage: AiUsageEntry[];
  unit: StatUnit;
}

interface Bucket {
  key: number;
  label: string;
}

const tooltipStyle = {
  backgroundColor: "var(--popover, #fff)",
  border: "1px solid var(--border, #e5e5e5)",
  borderRadius: 8,
  fontSize: 12,
  color: "var(--popover-foreground, inherit)",
} as const;

/**
 * AI 用量图表组：按全局时间单位分桶的堆叠柱状图（按模型着色）+ 模型占比饼图 + 明细表。
 * 桶粒度随单位：日→小时 / 周·月→天 / 年→月 / 全部→年。
 */
const AiUsageCharts = ({ usage, unit }: AiUsageChartsProps) => {
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

  const models = useMemo(() => {
    const m = new Map<string, { key: string; name: string; total: number; input: number; output: number }>();
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
  const chartData = useMemo(() => {
    const rows = buckets.map((b) => ({
      bucket: b.label,
      ...Object.fromEntries(models.map((m) => [m.key, 0])),
    })) as Array<Record<string, number | string>>;
    for (const u of usage) {
      const idx = bucketIndexOf(u.createdAt);
      if (idx < 0 || idx >= rows.length) continue;
      const key = `${u.providerId}::${u.modelId}`;
      rows[idx][key] = ((rows[idx][key] as number) ?? 0) + u.inputTokens + u.outputTokens;
    }
    return rows;
  }, [usage, buckets, models]);

  const grandTotal = models.reduce((s, m) => s + m.total, 0);
  const pieData = models.map((m) => ({ name: m.name, value: m.total }));

  if (usage.length === 0) {
    return (
      <div className="flex h-40 items-center justify-center text-neutral-500 text-sm dark:text-neutral-400">
        暂无 AI 用量数据——开始对话后，这里会随每次回复累积统计
      </div>
    );
  }

  return (
    <div className="space-y-6 text-neutral-500 dark:text-neutral-400">
      <div>
        <p className="mb-2 font-medium text-neutral-900 dark:text-neutral-100">用量分布（输入 + 输出）</p>
        <ResponsiveContainer width="100%" height={260}>
          <BarChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="currentColor" opacity={0.15} vertical={false} />
            <XAxis
              dataKey="bucket"
              tick={{ fontSize: 11, fill: "currentColor" }}
              tickLine={false}
              axisLine={false}
              interval="preserveStartEnd"
            />
            <YAxis
              tick={{ fontSize: 11, fill: "currentColor" }}
              tickLine={false}
              axisLine={false}
              width={56}
              tickFormatter={(v: number) => formatTokens(v)}
            />
            <Tooltip
              contentStyle={tooltipStyle}
              formatter={(value: any, name: any) => [`${formatTokens(Number(value) || 0)} tokens`, name]}
            />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            {models.map((m, i) => (
              <Bar
                key={m.key}
                dataKey={m.key}
                name={m.name}
                stackId="tokens"
                fill={MODEL_COLORS[i % MODEL_COLORS.length]}
              />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div>
          <p className="mb-2 font-medium text-neutral-900 dark:text-neutral-100">模型用量占比</p>
          <ResponsiveContainer width="100%" height={260}>
            <PieChart>
              <Pie data={pieData} dataKey="value" nameKey="name" innerRadius={55} outerRadius={90} paddingAngle={2}>
                {pieData.map((_, i) => (
                  <Cell key={`cell-${i}`} fill={MODEL_COLORS[i % MODEL_COLORS.length]} />
                ))}
              </Pie>
              <Tooltip
                contentStyle={tooltipStyle}
                formatter={(value: any, name: any) => [`${formatTokens(Number(value) || 0)} tokens`, name]}
              />
            </PieChart>
          </ResponsiveContainer>
        </div>

        <div>
          <p className="mb-2 font-medium text-neutral-900 dark:text-neutral-100">模型明细</p>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-neutral-200 border-b text-left font-medium dark:border-neutral-800">
                <th className="py-1.5 pr-2">模型</th>
                <th className="pr-2">输入</th>
                <th className="pr-2">输出</th>
                <th className="pr-2">合计</th>
                <th>占比</th>
              </tr>
            </thead>
            <tbody>
              {models.map((m) => (
                <tr key={m.key} className="border-neutral-100 border-b last:border-0 dark:border-neutral-900">
                  <td className="max-w-40 truncate py-1.5 pr-2" title={m.name}>
                    {m.name}
                  </td>
                  <td className="pr-2">{formatTokens(m.input)}</td>
                  <td className="pr-2">{formatTokens(m.output)}</td>
                  <td className="pr-2 font-medium text-neutral-900 dark:text-neutral-100">{formatTokens(m.total)}</td>
                  <td>{grandTotal > 0 ? `${((m.total / grandTotal) * 100).toFixed(1)}%` : "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};

export default AiUsageCharts;
