import { parseCsvPreview } from "@/lib/csv";
import { useId, useMemo } from "react";

interface CsvPreviewProps {
  content: string;
  allowPartial?: boolean;
  maxRows?: number;
}

export function CsvPreview({ content, allowPartial = false, maxRows = 200 }: CsvPreviewProps) {
  const captionId = useId();
  const parsed = useMemo(() => {
    try {
      return { data: parseCsvPreview(content, { allowPartial, maxRows }), error: "" };
    } catch (error) {
      return { data: null, error: error instanceof Error ? error.message : String(error) };
    }
  }, [allowPartial, content, maxRows]);

  if (!parsed.data) {
    return (
      <div className="flex-1 overflow-auto p-4" role="alert">
        <p className="mb-3 text-red-600 text-sm dark:text-red-400">CSV 解析失败：{parsed.error}</p>
        <pre className="whitespace-pre-wrap break-words font-mono text-muted-foreground text-xs">
          {content.slice(0, 4000)}
        </pre>
      </div>
    );
  }
  const { headers, rows, truncated } = parsed.data;
  if (headers.length === 0) {
    return <div className="flex-1 p-4 text-muted-foreground text-sm">此 CSV 没有可显示的数据。</div>;
  }
  return (
    <div className="chat-md min-h-0 flex-1 overflow-auto p-3" data-region="csv-preview">
      <div className="workspace-csv-scroll" role="region" aria-labelledby={captionId} tabIndex={0}>
        <table className="workspace-csv-table">
          <caption id={captionId}>{allowPartial ? "CSV 分段预览（仅已加载内容）" : "CSV 表格预览"}</caption>
          <thead>
            <tr>
              {headers.map((header, index) => (
                <th key={`${header}-${index}`} scope="col">
                  {header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {row.map((value, columnIndex) => {
                  const numeric = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(value.trim());
                  return columnIndex === 0 ? (
                    <th key={columnIndex} scope="row">
                      {value}
                    </th>
                  ) : (
                    <td key={columnIndex} className={numeric ? "numeric" : undefined}>
                      {value}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {truncated && (
        <p className="mt-2 mb-0 text-muted-foreground text-xs">
          仅显示当前已加载的完整行，前 {maxRows} 行；未读取的内容不会伪装成完整表格。
        </p>
      )}
    </div>
  );
}
