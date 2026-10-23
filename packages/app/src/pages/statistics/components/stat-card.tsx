import type { ReactNode } from "react";

interface StatCardProps {
  title: string;
  value: string;
  icon: ReactNode;
  description?: string;
  trend?: {
    value: number;
    isPositive: boolean;
  };
}

/**
 * 统计数字卡片：主题化承力面 + hover 荧光（.stats-card），图标底座在卡片 hover 时轻亮、
 * 指到图标本身再加重（.stats-icon-tile，口径对齐 AI 消息 Markdown 表格的单元格 hover）。
 */
const StatCard = ({ title, value, icon, description }: StatCardProps) => {
  return (
    <div data-region="stat-card" className="stats-card group/stat p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate font-medium text-[13px] text-muted-foreground">{title}</p>
          <p className="mt-1.5 font-bold text-2xl text-foreground tabular-nums tracking-tight">{value}</p>
        </div>
        <span aria-hidden="true" className="stats-icon-tile">
          {icon}
        </span>
      </div>
      {description && <p className="mt-2 text-muted-foreground text-xs">{description}</p>}
    </div>
  );
};

export default StatCard;
