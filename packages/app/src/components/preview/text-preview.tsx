/**
 * 纯文本预览（E5 扩展）：txt/log 等纯文本产物，保留原始换行（不走 Markdown，避免单换行被折叠）。
 */
interface TextPreviewProps {
  content: string;
}

export function TextPreview({ content }: TextPreviewProps) {
  return (
    <div className="h-full w-full overflow-auto p-4">
      <pre className="whitespace-pre-wrap font-sans text-foreground text-sm leading-relaxed">{content}</pre>
    </div>
  );
}
