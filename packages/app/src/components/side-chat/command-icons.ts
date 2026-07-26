/**
 * 快捷指令可选图标映射
 * 从 lucide-react 预定义一组适合快捷指令场景的图标
 */
import {
  BookOpen,
  Brain,
  Brush,
  Database,
  Download,
  FileText,
  Globe,
  Highlighter,
  Languages,
  Lightbulb,
  ListChecks,
  MessageSquare,
  Moon,
  Music,
  Notebook,
  Palette,
  Pencil,
  Quote,
  RefreshCw,
  Search,
  Sparkles,
  Star,
  Tag,
  Trash2,
  Upload,
  Zap,
  type LucideIcon,
} from "lucide-react";

export const COMMAND_ICONS: Record<string, LucideIcon> = {
  Zap,
  BookOpen,
  Brain,
  Brush,
  Database,
  Download,
  FileText,
  Globe,
  Highlighter,
  Languages,
  Lightbulb,
  ListChecks,
  MessageSquare,
  Moon,
  Music,
  Notebook,
  Palette,
  Pencil,
  Quote,
  RefreshCw,
  Search,
  Sparkles,
  Star,
  Tag,
  Trash2,
  Upload,
};

export const ICON_NAMES = Object.keys(COMMAND_ICONS);

/** 根据图标名称获取组件，未匹配时回退到 Zap */
export function getCommandIcon(name?: string): LucideIcon {
  if (!name) return Zap;
  return COMMAND_ICONS[name] ?? Zap;
}
