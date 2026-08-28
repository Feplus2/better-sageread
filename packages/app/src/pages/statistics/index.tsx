import { getAiUsageEntries } from "@/services/ai-usage-service";
import type { AiUsageEntry } from "@/services/ai-usage-service";
import { getAllReadingSessions } from "@/services/reading-session-service";
import type { ReadingSession } from "@/types/reading-session";
import clsx from "clsx";
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
  LayersIcon,
  TrendingUpIcon,
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

const formatDuration = (seconds: number) => `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;

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

  const winUsage = useMemo(
    () => (startMs == null ? usage : usage.filter((u) => u.createdAt >= startMs)),
    [usage, startMs],
  );
  const inputTokens = winUsage.reduce((s, u) => s + u.inputTokens, 0);
  const outputTokens = winUsage.reduce((s, u) => s + u.outputTokens, 0);
  const modelCount = new Set(winUsage.map((u) => `${u.providerId}::${u.modelId}`)).size;

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

  if (loading) {
    return (
      <div className="container mx-auto p-4">
        <div className="flex h-[60vh] items-center justify-center">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-neutral-300 border-t-neutral-700 dark:border-neutral-600 dark:border-t-neutral-400" />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="container mx-auto p-4">
        <div className="rounded-lg border border-red-200 bg-red-50 p-6 dark:border-red-800 dark:bg-red-950">
          <div className="text-center text-red-700 dark:text-red-300">
            <p className="font-medium text-lg">加载失败</p>
            <p className="text-sm">{error}</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 space-y-6 overflow-auto p-3">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-2">
          <h1 className="font-bold text-3xl text-neutral-900 dark:text-neutral-100">阅读统计</h1>
          <p className="text-neutral-600 dark:text-neutral-400">阅读习惯与 AI 用量的统计数据</p>
        </div>
        <div className="flex shrink-0 items-center gap-1 rounded-lg border border-neutral-150 p-1 dark:border-neutral-800">
          {UNIT_OPTIONS.map((o) => (
            <button
              key={o.value}
              type="button"
              onClick={() => setUnit(o.value)}
              className={clsx(
                "rounded-md px-3 py-1 text-sm transition-colors",
                unit === o.value
                  ? "bg-primary font-medium text-primary-foreground"
                  : "text-neutral-600 hover:bg-muted dark:text-neutral-400",
              )}
            >
              {o.label}
            </button>
          ))}
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <StatCard title="阅读会话" value={totalSessions.toString()} icon={<BookIcon className="h-4 w-4" />} />
        <StatCard title="阅读时长" value={formatDuration(totalDuration)} icon={<ClockIcon className="h-4 w-4" />} />
        <StatCard title="活跃天数" value={activeDays.toString()} icon={<CalendarIcon className="h-4 w-4" />} />
        <StatCard
          title="平均每日会话"
          value={averageSessionsPerDay.toFixed(1)}
          icon={<TrendingUpIcon className="h-4 w-4" />}
        />
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <StatCard title="输入 Token" value={formatTokens(inputTokens)} icon={<ArrowDownToLine className="h-4 w-4" />} />
        <StatCard
          title="输出 Token"
          value={formatTokens(outputTokens)}
          icon={<ArrowUpFromLine className="h-4 w-4" />}
        />
        <StatCard title="AI 请求数" value={winUsage.length.toString()} icon={<BotIcon className="h-4 w-4" />} />
        <StatCard title="使用模型数" value={modelCount.toString()} icon={<LayersIcon className="h-4 w-4" />} />
      </div>

      <div className="rounded-lg border border-neutral-150 p-4 dark:border-neutral-800">
        <div className="space-y-2 pb-4">
          <h3 className="font-semibold text-lg text-neutral-900 dark:text-neutral-100">AI 用量</h3>
          <p className="text-neutral-600 text-sm dark:text-neutral-400">
            各模型 token 消耗（自功能上线起累计；图表悬浮可见模型与具体数值）
          </p>
        </div>
        <AiUsageCharts usage={winUsage} unit={unit} />
      </div>

      <div className="rounded-lg border border-neutral-150 p-4 dark:border-neutral-800">
        <div className="flex items-start justify-between pb-4">
          <div className="space-y-2">
            <h3 className="font-semibold text-lg text-neutral-900 dark:text-neutral-100">阅读活动热力图</h3>
            <p className="text-neutral-600 text-sm dark:text-neutral-400">
              {heatYear} 年的阅读活动分布，颜色深浅表示当天的阅读强度
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={() => setHeatYear((y) => y - 1)}
              disabled={heatYear <= minYear}
              className="rounded-md p-1.5 text-neutral-600 transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40 dark:text-neutral-400"
              aria-label="上一年"
            >
              <ChevronLeftIcon className="h-4 w-4" />
            </button>
            <span className="min-w-12 text-center font-medium text-sm">{heatYear}</span>
            <button
              type="button"
              onClick={() => setHeatYear((y) => y + 1)}
              disabled={heatYear >= currentYear}
              className="rounded-md p-1.5 text-neutral-600 transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40 dark:text-neutral-400"
              aria-label="下一年"
            >
              <ChevronRightIcon className="h-4 w-4" />
            </button>
          </div>
        </div>
        <ReadingHeatMap data={heatStats} year={heatYear} />
      </div>
    </div>
  );
};

export default StatisticsPage;
