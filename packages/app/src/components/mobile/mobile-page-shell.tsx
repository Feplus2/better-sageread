import { ChevronLeft } from "lucide-react";
import type { ReactNode } from "react";
import { useNavigate } from "react-router";

/** 移动端二级页通用壳：顶部返回栏（回首页）+ 内容区。
 *  桌面的侧边栏导航在移动端不存在，二级页一律全屏 + 左上返回。 */
export default function MobilePageShell({ title, children }: { title: string; children: ReactNode }) {
  const navigate = useNavigate();
  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex shrink-0 items-center gap-1 border-neutral-200 border-b px-2 py-2.5 dark:border-neutral-700">
        <button
          type="button"
          onClick={() => navigate("/")}
          className="flex h-8 w-8 items-center justify-center rounded-full text-neutral-600 active:bg-neutral-100 dark:text-neutral-300 dark:active:bg-neutral-800"
          aria-label="返回首页"
        >
          <ChevronLeft size={22} />
        </button>
        <h1 className="font-semibold text-base text-neutral-900 dark:text-neutral-100">{title}</h1>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
    </div>
  );
}
