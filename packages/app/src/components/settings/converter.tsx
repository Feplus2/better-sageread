import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { type BookConvertEngine, useConverterStore } from "@/store/converter-store";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ExternalLink } from "lucide-react";

const ENGINE_OPTIONS: { value: BookConvertEngine; label: string; hint: string }[] = [
  { value: "mineru", label: "MinerU", hint: "表格密集书籍更稳（跨页表合并），免费 1000 页/日" },
  { value: "paddleocr", label: "PaddleOCR", hint: "速度更快、图注绑定准，免费 3000 页/日" },
];

export default function ConverterSettings() {
  const { mineruToken, paddleocrToken, engine, setMineruToken, setPaddleocrToken, setEngine } = useConverterStore();
  const activeEngine = ENGINE_OPTIONS.find((o) => o.value === engine) ?? ENGINE_OPTIONS[0];

  return (
    <div className="space-y-6 p-4">
      <div className="space-y-2">
        <h2 className="font-semibold text-lg dark:text-neutral-100">PDF 转换</h2>
        <p className="text-neutral-600 text-sm dark:text-neutral-400">
          PDF 转 EPUB 由 Books_Converter 引擎驱动（云端解析 + 辅助模型结构重建）。
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="convert-engine">解析引擎</Label>
        <Select value={engine} onValueChange={(value) => setEngine(value as BookConvertEngine)}>
          <SelectTrigger id="convert-engine" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ENGINE_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-neutral-500 text-xs dark:text-neutral-500">{activeEngine.hint}</p>
      </div>

      {engine === "mineru" && (
        <div className="space-y-2">
          <Label htmlFor="mineru-token">MinerU Token</Label>
          <Input
            id="mineru-token"
            type="password"
            value={mineruToken}
            onChange={(e) => setMineruToken(e.target.value)}
            placeholder="在 mineru.net 申请"
          />
          <button
            type="button"
            onClick={() => openUrl("https://mineru.net/apiManage/token")}
            className="inline-flex cursor-pointer items-center gap-1 text-primary text-xs hover:underline"
          >
            <ExternalLink className="size-3" />去 MinerU 官网申请 Token
          </button>
        </div>
      )}

      {engine === "paddleocr" && (
        <div className="space-y-2">
          <Label htmlFor="paddleocr-token">PaddleOCR Token</Label>
          <Input
            id="paddleocr-token"
            type="password"
            value={paddleocrToken}
            onChange={(e) => setPaddleocrToken(e.target.value)}
            placeholder="在百度 AI Studio 申请"
          />
          <button
            type="button"
            onClick={() => openUrl("https://aistudio.baidu.com")}
            className="inline-flex cursor-pointer items-center gap-1 text-primary text-xs hover:underline"
          >
            <ExternalLink className="size-3" />去百度 AI Studio 申请 Token
          </button>
        </div>
      )}

      <p className="text-neutral-500 text-xs dark:text-neutral-500">
        Token 仅保存在本机（converter-store.json），不会随备份/同步上传。 转换所需的 LLM
        配置自动复用「模型提供商」中的辅助模型（需为 OpenAI 兼容端点，如 DeepSeek / OpenAI / OpenRouter）。
      </p>
    </div>
  );
}
