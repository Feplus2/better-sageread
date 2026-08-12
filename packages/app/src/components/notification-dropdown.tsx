import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useNotificationStore } from "@/store/notification-store";
import dayjs from "dayjs";
import { Bell, CheckCheck, Info, Trash2, X } from "lucide-react";
import { useState } from "react";

export default function NotificationDropdown() {
  const [isOpen, setIsOpen] = useState(false);
  const { notifications, markAllAsRead, removeNotification, clearAll, getUnreadCount } = useNotificationStore();
  const unreadCount = getUnreadCount();

  return (
    <DropdownMenu open={isOpen} onOpenChange={setIsOpen}>
      <DropdownMenuTrigger asChild>
        {/* 静默通知（用户 2026-08-10 拍板）：铃铛不显示数字红点——重要提示都有 toast 打底，
            错过的去通知列表找回即可；未读在列表内用高亮底色标注（bell 不催促） */}
        <button className="relative flex h-6 w-6 items-center justify-center rounded-full outline-none hover:bg-accent focus:outline-none focus-visible:ring-0 dark:hover:bg-accent">
          <Bell size={18} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side="bottom" sideOffset={4} alignOffset={-3} className="w-80 rounded-2xl p-0!">
        <div className="flex items-center justify-between border-b px-3 py-2">
          <span className="font-semibold">
            通知 {unreadCount > 0 && <span className="text-muted-foreground">({unreadCount})</span>}
          </span>
          <div className="flex items-center gap-2">
            {unreadCount > 0 && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span onClick={markAllAsRead}>
                    <CheckCheck size={14} />
                  </span>
                </TooltipTrigger>
                <TooltipContent side="left">标记已读</TooltipContent>
              </Tooltip>
            )}
            {notifications.length > 0 && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span onClick={clearAll}>
                    <Trash2 size={14} />
                  </span>
                </TooltipTrigger>
                <TooltipContent side="left">清空通知</TooltipContent>
              </Tooltip>
            )}
          </div>
        </div>

        <div className="h-80 overflow-y-auto">
          {notifications.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-24">
              <Bell size={32} />
              <p className="mt-2">暂无通知</p>
            </div>
          ) : (
            <div className="space-y-2 p-2">
              {notifications.map((notification) => (
                <div
                  key={notification.id}
                  className={cn(
                    "group relative rounded-lg border p-2 transition-all hover:shadow-sm",
                    !notification.read && "border-primary/30 bg-primary/5 dark:border-primary/40 dark:bg-primary/10",
                  )}
                >
                  <button
                    onClick={() => removeNotification(notification.id)}
                    className="absolute top-2 right-2 rounded-full p-1 opacity-0 transition-opacity hover:bg-accent group-hover:opacity-100 dark:hover:bg-accent"
                  >
                    <X size={14} className="text-neutral-500 dark:text-neutral-400" />
                  </button>
                  <div className="flex items-start gap-2 pr-6">
                    <Info size={16} className="mt-0.5 shrink-0 text-neutral-500 dark:text-neutral-400" />
                    <div className="flex-1">
                      <p className="break-all text-sm">{notification.content}</p>
                      <p className="mt-1 text-muted-foreground text-xs">
                        {dayjs(notification.timestamp).format("YYYY-MM-DD HH:mm:ss")}
                      </p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
