import { getAiUsageEntries } from "@/services/ai-usage-service";
import type { AiUsageEntry } from "@/services/ai-usage-service";
import { getAllReadingSessions } from "@/services/reading-session-service";
import type { ReadingSession } from "@/types/reading-session";
import dayjs from "dayjs";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  BookIcon,
  BotIcon,
  CalendarIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ClockIcon,
  DatabaseIcon,
  TrendingUpIcon,
  TriangleAlert,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import AiUsageCharts, { formatTokens, type StatUnit } from "./components/ai-usage-charts";
import ReadingHeatMap from "./components/reading-heat-map";
import StatCard from "./components/stat-card";

const UNIT_OPTIONS: { value: StatUnit; label: string }[] = [
  { value: "day", label: "今日" },
  { value: "week", label: "本周" },
  { value: "month", label: "本月" },
  { value: "year", label: "今年" },
  { value: "all", label: "全部" },
];

/** 窗口起点：今日 0 点 / 本周周一 / 本月 1 日 / 今年 1 月 1 日；全部 = null 不过滤 */
function windowStartMs(unit: StatUnit): number | null {
  const now = dayjs();
  switch (unit) {
    case "day":
      return now.startOf("day").valueOf();
    case "week":
      return now
        .subtract((now.day() + 6) % 7, "day")
        .startOf("day")
        .valueOf();
    case "month":
      return now.startOf("month").valueOf();
    case "year":
      return now.startOf("year").valueOf();
    case "all":
      return null;
  }
}

/** 阅读时长：小时 + 分钟的中文紧凑写法（0 小时时只显示分钟，避免 "0h 23m" 的噪音） */
const formatDuration = (seconds: number) => {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours > 0 ? `${hours} 小时 ${minutes} 分` : `${minutes} 分`;
};

const StatisticsPage = () => {
  const [sessions, setSessions] = useState<ReadingSession[]>([]);
  const [usage, setUsage] = useState<AiUsageEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [unit, setUnit] = useState<StatUnit>("month");
  const [heatYear, setHeatYear] = useState(() => new Date().getFullYear());

  // 一次性取全量（会话/用量流水都是行级小数据），时间窗切片与热力图年份过滤全在前端做，
  // 切单位零请求零延迟
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        setLoading(true);
        setError(null);
        const [sessionData, usageData] = await Promise.all([getAllReadingSessions(), getAiUsageEntries()]);
        if (cancelled) return;
        setSessions(sessionData);
        setUsage(usageData);
      } catch (err) {
        setError(err instanceof Error ? err.message : "加载统计数据失败");
        console.error("加载统计数据失败:", err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  const startMs = useMemo(() => windowStartMs(unit), [unit]);

  const winSessions = useMemo(
    () => (startMs == null ? sessions : sessions.filter((s) => s.startedAt >= startMs)),
    [sessions, startMs],
  );
  const totalSessions = winSessions.length;
  const totalDuration = winSessions.reduce((sum, s) => sum + s.durationSeconds, 0);
  const activeDays = new Set(winSessions.map((s) => dayjs(s.startedAt).format("YYYY-MM-DD"))).size;
  const averageSessionsPerDay = activeDays > 0 ? totalSessions / activeDays : 0;

  // LLM 口径 = chat + aux（辅助任务已计入）；embed（向量化）单独立账，第四卡展示
  const winUsage = useMemo(
    () => usage.filter((u) => u.kind !== "embed" && (startMs == null || u.createdAt >= startMs)),
    [usage, startMs],
  );
  const inputTokens = winUsage.reduce((s, u) => s + u.inputTokens, 0);
  const outputTokens = winUsage.reduce((s, u) => s + u.outputTokens, 0);
  // 向量化用量：嵌入 token（本地 tokenizer 口径），随时间单位同窗统计
  const embedTokens = usage
    .filter((u) => u.kind === "embed" && (startMs == null || u.createdAt >= startMs))
    .reduce((s, u) => s + u.inputTokens, 0);

  const heatStats = useMemo(() => {
    const map = new Map<string, { count: number; totalDuration: number }>();
    for (const s of sessions) {
      const d = dayjs(s.startedAt);
      if (d.year() !== heatYear) continue;
      const key = d.format("YYYY-MM-DD");
      const cur = map.get(key) ?? { count: 0, totalDuration: 0 };
      map.set(key, { count: cur.count + 1, totalDuration: cur.totalDuration + s.durationSeconds });
    }
    return Array.from(map.entries())
      .map(([date, v]) => ({ date, count: v.count, totalDuration: v.totalDuration }))
      .sort((a, b) => a.date.localeCompare(b.date));
  }, [sessions, heatYear]);

  const currentYear = new Date().getFullYear();
  const minYear = useMemo(() => {
    const years = sessions.map((s) => dayjs(s.startedAt).year());
    return years.length > 0 ? Math.min(...years, currentYear) : currentYear;
  }, [sessions, currentYear]);

  const unitLabel = UNIT_OPTIONS.find((o) => o.value === unit)?.label ?? "本月";

  if (loading) {
    return (
      <div data-region="statistics" className="stats-page flex-1 overflow-auto p-3">
        <div className="relative z-10 space-y-6">
          <div className="space-y-2">
            <div className="h-8 w-36 animate-pulse rounded-md bg-muted" />
            <div className="h-4 w-56 animate-pulse rounded bg-muted" />
          </div>
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
            {Array.from({ length: 8 }, (_, i) => (
              <div key={i} className="stats-card h-[104px] animate-pulse" />
            ))}
          </div>
          <div className="stats-card h-[420px] animate-pulse" />
          <div className="stats-card h-[260px] animate-pulse" />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div data-region="statistics" className="stats-page flex-1 overflow-auto p-3">
        <div className="stats-card mx-auto mt-16 max-w-lg p-8 text-center">
          <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-destructive/10 text-destructive">
            <TriangleAlert className="h-5 w-5" />
          </div>
          <p className="font-semibold text-foreground text-lg">加载失败</p>
          <p className="mt-1 text-muted-foreground text-sm">{error}</p>
        </div>
      </div>
    );
  }

  return (
    <div data-region="statistics" className="stats-page flex-1 space-y-6 overflow-auto p-3">
      <header className="relative z-10 flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-1.5">
          <h1 className="font-bold text-3xl text-foreground tracking-tight">阅读统计</h1>
          <p className="text-muted-foreground text-sm">阅读习惯与 AI 用量的统计数据</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <div aria-label="统计时间范围" className="stats-segmented" role="group">
            {UNIT_OPTIONS.map((o) => (
              <button
                key={o.value}
                aria-pressed={unit === o.value}
                className="stats-segmented-item"
                data-active={unit === o.value}
                onClick={() => setUnit(o.value)}
                type="button"
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>
      </header>

      <section aria-label="阅读概览" className="relative z-10 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <StatCard title="阅读会话" value={totalSessions.toString()} icon={<BookIcon className="h-4 w-4" />} />
        <StatCard title="阅读时长" value={formatDuration(totalDuration)} icon={<ClockIcon className="h-4 w-4" />} />
        <StatCard title="活跃天数" value={activeDays.toString()} icon={<CalendarIcon className="h-4 w-4" />} />
        <StatCard
          title="平均每日会话"
          value={averageSessionsPerDay.toFixed(1)}
          icon={<TrendingUpIcon className="h-4 w-4" />}
        />
      </section>

      <section aria-label="AI 用量概览" className="relative z-10 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <StatCard title="输入 Token" value={formatTokens(inputTokens)} icon={<ArrowDownToLine className="h-4 w-4" />} />
        <StatCard
          title="输出 Token"
          value={formatTokens(outputTokens)}
          icon={<ArrowUpFromLine className="h-4 w-4" />}
        />
        <StatCard title="AI 请求数" value={winUsage.length.toString()} icon={<BotIcon className="h-4 w-4" />} />
        <StatCard title="向量化用量" value={formatTokens(embedTokens)} icon={<DatabaseIcon className="h-4 w-4" />} />
      </section>

      <section className="stats-card relative z-10 p-5" data-panel="ai-usage" data-region="stats-panel">
        <div className="flex flex-wrap items-start justify-between gap-3 pb-5">
          <div className="space-y-1">
            <h2 className="font-semibold text-foreground text-lg">AI 用量分布</h2>
            <p className="text-muted-foreground text-sm">
              各模型 token 消耗，按当前时间范围统计；图表悬浮或点按可查看模型与具体数值
            </p>
          </div>
          <span
            className="inline-flex shrink-0 items-center rounded-full border px-2.5 py-0.5 font-medium text-[11px] text-muted-foreground"
            style={{ borderColor: "var(--stats-border)" }}
          >
            {unitLabel}
          </span>
        </div>
        <AiUsageCharts unit={unit} usage={winUsage} />
      </section>

      <section className="stats-card relative z-10 p-5" data-panel="heatmap" data-region="stats-panel">
        <div className="flex flex-wrap items-start justify-between gap-3 pb-4">
          <div className="space-y-1">
            <h2 className="font-semibold text-foreground text-lg">阅读活动热力图</h2>
            <p className="text-muted-foreground text-sm">{heatYear} 年的阅读活动分布，颜色深浅表示当天的阅读强度</p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button
              aria-label="上一年"
              className="stats-icon-button"
              disabled={heatYear <= minYear}
              onClick={() => setHeatYear((y) => y - 1)}
              type="button"
            >
              <ChevronLeftIcon className="h-4 w-4" />
            </button>
            <span className="min-w-12 text-center font-medium text-foreground text-sm tabular-nums">{heatYear}</span>
            <button
              aria-label="下一年"
              className="stats-icon-button"
              disabled={heatYear >= currentYear}
              onClick={() => setHeatYear((y) => y + 1)}
              type="button"
            >
              <ChevronRightIcon className="h-4 w-4" />
            </button>
          </div>
        </div>
        <ReadingHeatMap data={heatStats} year={heatYear} />
      </section>
    </div>
  );
};

export default StatisticsPage;
