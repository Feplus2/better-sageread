/**
 * Markdown 预览（E5）：复用聊天消息的 react-markdown 渲染管线。
 */
import { Markdown } from "@/components/prompt-kit/markdown";
import type { Components } from "react-markdown";

interface MarkdownPreviewProps {
  content: string;
  components?: Partial<Components>;
}

export function MarkdownPreview({ content, components }: MarkdownPreviewProps) {
  return (
    <div className="h-full w-full overflow-auto p-4">
      <div className="text-foreground text-sm">
        <Markdown className="chat-md" components={components}>
          {content}
        </Markdown>
      </div>
    </div>
  );
}
