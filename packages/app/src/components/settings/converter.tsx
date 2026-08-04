import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { type BookConvertEngine, type PaperConvertEngine, useConverterStore } from "@/store/converter-store";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ExternalLink, TriangleAlert } from "lucide-react";

const ENGINE_OPTIONS: { value: BookConvertEngine; label: string; hint: string }[] = [
  { value: "mineru", label: "MinerU", hint: "表格密集书籍更稳（跨页表合并），免费 1000 页/日" },
  { value: "paddleocr", label: "PaddleOCR", hint: "速度更快、图注绑定准，免费 3000 页/日" },
];

const PAPER_ENGINE_OPTIONS: { value: PaperConvertEngine; label: string; hint: string }[] = [
  { value: "paddleocr", label: "PaddleOCR", hint: "论文基线：段落顺序/图注绑定/引文保留最优" },
  { value: "mineru", label: "MinerU", hint: "表格密集论文备选（跨页表合并最稳）" },
  { value: "glm", label: "GLM（智谱）", hint: "第二备选，需智谱 API Key" },
];

const ENGINE_LABELS: Record<string, string> = { mineru: "MinerU", paddleocr: "PaddleOCR", glm: "GLM（智谱）" };

/** 选中引擎但未配置对应 Token 的提示条 */
function TokenWarning({ engine, tokens }: { engine: string; tokens: Record<string, string> }) {
  if (tokens[engine]) return null;
  return (
    <p className="flex items-center gap-1.5 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-amber-700 text-xs dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-400">
      <TriangleAlert className="size-3.5 shrink-0" />
      当前选择的 {ENGINE_LABELS[engine]} 尚未配置 Token，请先在上方「解析引擎配置」中填写。
    </p>
  );
}

export default function ConverterSettings() {
  const {
    mineruToken,
    paddleocrToken,
    glmApiKey,
    engine,
    paperEngine,
    setMineruToken,
    setPaddleocrToken,
    setGlmApiKey,
    setEngine,
    setPaperEngine,
  } = useConverterStore();
  const tokens = { mineru: mineruToken, paddleocr: paddleocrToken, glm: glmApiKey };

  return (
    <div className="space-y-6 p-4">
      <div className="space-y-2">
        <h2 className="font-semibold text-lg dark:text-neutral-100">PDF 转换</h2>
        <p className="text-neutral-600 text-sm dark:text-neutral-400">
          书籍转换（PDF→EPUB）与论文解析（PDF→Markdown 论文）由各自引擎驱动，Token 配置两侧共享。
        </p>
      </div>

      {/* 区域一：解析引擎配置（Token，常驻，与选择解耦） */}
      <section className="space-y-3">
        <h3 className="font-medium text-base dark:text-neutral-100">解析引擎配置</h3>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="mineru-token" className="text-sm">
              MinerU Token
            </Label>
            <div className="flex items-center gap-2">
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
                className="inline-flex shrink-0 cursor-pointer items-center gap-1 text-primary text-xs hover:underline"
              >
                <ExternalLink className="size-3" />申请
              </button>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="paddleocr-token" className="text-sm">
              PaddleOCR Token
            </Label>
            <div className="flex items-center gap-2">
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
                className="inline-flex shrink-0 cursor-pointer items-center gap-1 text-primary text-xs hover:underline"
              >
                <ExternalLink className="size-3" />申请
              </button>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="glm-api-key" className="text-sm">
              GLM API Key
            </Label>
            <div className="flex items-center gap-2">
              <Input
                id="glm-api-key"
                type="password"
                value={glmApiKey}
                onChange={(e) => setGlmApiKey(e.target.value)}
                placeholder="在 bigmodel.cn 申请（仅论文 GLM 引擎需要）"
              />
              <button
                type="button"
                onClick={() => openUrl("https://open.bigmodel.cn")}
                className="inline-flex shrink-0 cursor-pointer items-center gap-1 text-primary text-xs hover:underline"
              >
                <ExternalLink className="size-3" />申请
              </button>
            </div>
          </div>
        </div>
      </section>

      {/* 区域二：书籍转换引擎选择 */}
      <section className="space-y-3 border-t pt-4 dark:border-neutral-700">
        <div className="space-y-1">
          <h3 className="font-medium text-base dark:text-neutral-100">书籍转换</h3>
          <p className="text-neutral-600 text-sm dark:text-neutral-400">
            「PDF 转换」页把 PDF 书籍转为 EPUB 入库（Books_Converter 驱动）。
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
          <p className="text-neutral-500 text-xs dark:text-neutral-500">
            {ENGINE_OPTIONS.find((o) => o.value === engine)?.hint}
          </p>
          <TokenWarning engine={engine} tokens={tokens} />
        </div>
      </section>

      {/* 区域三：论文解析引擎选择 */}
      <section className="space-y-3 border-t pt-4 dark:border-neutral-700">
        <div className="space-y-1">
          <h3 className="font-medium text-base dark:text-neutral-100">论文解析</h3>
          <p className="text-neutral-600 text-sm dark:text-neutral-400">
            文献库「导入 PDF」把单篇论文解析为 Markdown 论文（Papers_Converter 驱动）。
          </p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="paper-engine">解析引擎</Label>
          <Select value={paperEngine} onValueChange={(value) => setPaperEngine(value as PaperConvertEngine)}>
            <SelectTrigger id="paper-engine" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PAPER_ENGINE_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-neutral-500 text-xs dark:text-neutral-500">
            {PAPER_ENGINE_OPTIONS.find((o) => o.value === paperEngine)?.hint}
          </p>
          <TokenWarning engine={paperEngine} tokens={tokens} />
        </div>
      </section>

      <p className="text-neutral-500 text-xs dark:text-neutral-500">
        Token 仅保存在本机（converter-store.json），不会随备份/同步上传。 转换所需的 LLM
        配置自动复用「模型提供商」中的辅助模型（需为 OpenAI 兼容端点，如 DeepSeek / OpenAI / OpenRouter）。
      </p>
    </div>
  );
}
