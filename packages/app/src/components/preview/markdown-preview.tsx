/**
 * Markdown 预览（E5）：复用聊天消息的 react-markdown 渲染管线。
 */
import { Markdown } from "@/components/prompt-kit/markdown";

interface MarkdownPreviewProps {
  content: string;
}

export function MarkdownPreview({ content }: MarkdownPreviewProps) {
  return (
    <div className="h-full w-full overflow-auto p-4">
      <div className="text-foreground text-sm">
        <Markdown>{content}</Markdown>
      </div>
    </div>
  );
}
