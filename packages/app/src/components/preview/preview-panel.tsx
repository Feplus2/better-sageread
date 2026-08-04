import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { exportCodeBlock } from "@/lib/export-code-block";
import { usePreviewStore } from "@/store/preview-store";
import { Download, X } from "lucide-react";
import { Resizable } from "re-resizable";
import { HtmlPreview } from "./html-preview";
import { MermaidPreview } from "./mermaid-preview";
import { ReactPreview } from "./react-preview";
import { SvgPreview } from "./svg-preview";

const FORMAT_LABELS: Record<string, string> = {
  html: "HTML",
  svg: "SVG",
  mermaid: "Mermaid",
  react: "React",
};

export function PreviewPanel() {
  const { item, isOpen, closePreview } = usePreviewStore();

  if (!isOpen || !item) return null;

  const renderContent = () => {
    switch (item.format) {
      case "html":
        return <HtmlPreview content={item.content} />;
      case "svg":
        return <SvgPreview content={item.content} />;
      case "mermaid":
        return <MermaidPreview content={item.content} />;
      case "react":
        return <ReactPreview content={item.content} language={item.language} />;
      default:
        return null;
    }
  };

  return (
    <Resizable
      defaultSize={{ width: 420, height: "100%" }}
      minWidth={300}
      maxWidth={680}
      enable={{
        top: false,
        right: false,
        bottom: false,
        left: true,
        topRight: false,
        bottomRight: false,
        bottomLeft: false,
        topLeft: false,
      }}
      handleComponent={{
        left: <div className="custom-resize-handle" />,
      }}
      // 手柄感应区收回面板内（默认跨界 10px 会盖住邻居阅读区右缘的滚动条）
      handleStyles={{ left: { left: "0px" } }}
      className="h-full"
    >
      <div className="flex h-full flex-col rounded-md border border-neutral-200 bg-background shadow-around dark:border-neutral-700">
        <div className="flex items-center justify-between border-neutral-200 border-b px-3 py-2 dark:border-neutral-700">
          <div className="flex items-center gap-2">
            <h2 className="font-semibold text-neutral-900 text-sm dark:text-neutral-50">{item.title}</h2>
            <span className="rounded-full bg-muted px-2 py-0.5 font-mono text-muted-foreground text-xs">
              {FORMAT_LABELS[item.format] || item.language}
            </span>
          </div>
          <div className="flex items-center gap-1">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7 rounded-full"
                  onClick={() => void exportCodeBlock(item.content, item.language)}
                >
                  <Download className="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">导出文件</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" className="size-7 rounded-full" onClick={closePreview}>
                  <X className="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">关闭</TooltipContent>
            </Tooltip>
          </div>
        </div>
        <div className="flex-1 overflow-hidden">{renderContent()}</div>
      </div>
    </Resizable>
  );
}
