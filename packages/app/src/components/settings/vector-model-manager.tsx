import { AlibabaCloud, ChatGLM, LMStudio, Ollama, OpenAI } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { getBooksWithStatus } from "@/services/book-service";
import { secretDelete, secretHas, secretSet } from "@/services/secret-service";
import { type VectorModelConfig, useLlamaStore } from "@/store/llama-store";
import { useTaskCenterStore } from "@/store/task-center-store";
import { normalizeEmbeddingsUrl } from "@/utils/model";
import { ask } from "@tauri-apps/plugin-dialog";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { openUrl } from "@tauri-apps/plugin-opener";
import { type as getOsType } from "@tauri-apps/plugin-os";
import { ChevronRight, CircuitBoard, Cloud, Pencil, Plus, Server, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

type VectorProviderBrand =
  | "openai"
  | "bailian"
  | "zhipu"
  | "siliconflow"
  | "ollama"
  | "lmstudio"
  | "xinference"
  | "custom";

interface VectorProviderPreset {
  id: string;
  name: string;
  desc: string;
  brand: VectorProviderBrand;
  kind: "cloud" | "local";
  url: string;
  modelId: string;
  needKey: boolean;
  applyUrl?: string;
  commonModels?: string[];
  badge: string;
}

/** 云端 API 预设（推荐路径；移动端只能走云端） */
const CLOUD_PRESETS: VectorProviderPreset[] = [
  {
    id: "siliconflow",
    name: "硅基流动",
    desc: "国内直连、速度较快，有免费额度，适合先试用语义检索。",
    brand: "siliconflow",
    kind: "cloud",
    url: "https://api.siliconflow.cn/v1/embeddings",
    modelId: "BAAI/bge-m3",
    needKey: true,
    applyUrl: "https://cloud.siliconflow.cn",
    commonModels: ["BAAI/bge-m3", "Qwen/Qwen3-Embedding-0.6B", "BAAI/bge-large-zh-v1.5"],
    badge: "有免费额度",
  },
  {
    id: "openai",
    name: "OpenAI",
    desc: "text-embedding 系列，英文与多语检索稳定，按量计费。",
    brand: "openai",
    kind: "cloud",
    url: "https://api.openai.com/v1/embeddings",
    modelId: "text-embedding-3-large",
    needKey: true,
    applyUrl: "https://platform.openai.com/api-keys",
    commonModels: ["text-embedding-3-large", "text-embedding-3-small", "text-embedding-ada-002"],
    badge: "云端 API",
  },
  {
    id: "bailian",
    name: "阿里云百炼",
    desc: "qwen3-embedding / text-embedding 系列，中文检索表现好，有免费额度。",
    brand: "bailian",
    kind: "cloud",
    url: "https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings",
    modelId: "text-embedding-v4",
    needKey: true,
    applyUrl: "https://bailian.console.aliyun.com",
    commonModels: ["text-embedding-v4", "text-embedding-v3", "qwen3-embedding-0.6b"],
    badge: "云端 API",
  },
  {
    id: "zhipu",
    name: "智谱 BigModel",
    desc: "embedding-3（2048 维），国内直连，按量计费。",
    brand: "zhipu",
    kind: "cloud",
    url: "https://open.bigmodel.cn/api/paas/v4/embeddings",
    modelId: "embedding-3",
    needKey: true,
    applyUrl: "https://open.bigmodel.cn/usercenter/apikeys",
    commonModels: ["embedding-3"],
    badge: "云端 API",
  },
];

/** 本地部署预设（进阶，折叠在云端之后；不推荐给普通用户——移动端无法本地部署） */
const LOCAL_PRESETS: VectorProviderPreset[] = [
  {
    id: "ollama",
    name: "Ollama 本地",
    desc: "完全离线、免 Key、隐私最好；桌面端进阶用户可用。",
    brand: "ollama",
    kind: "local",
    url: "http://127.0.0.1:11434/api/embed",
    modelId: "embeddinggemma-2:440m",
    needKey: false,
    commonModels: ["embeddinggemma-2:440m", "bge-m3", "qwen3-embedding:0.6b"],
    badge: "本地部署",
  },
  {
    id: "lmstudio",
    name: "LM Studio",
    desc: "OpenAI 兼容端点，免 Key；模型名按 LM Studio 里下载的填。",
    brand: "lmstudio",
    kind: "local",
    url: "http://127.0.0.1:1234/v1/embeddings",
    modelId: "",
    needKey: false,
    commonModels: ["nomic-embed-text-v2-moe", "qwen3-embedding-0.6b"],
    badge: "本地部署",
  },
  {
    id: "xinference",
    name: "Xinference",
    desc: "自托管推理服务，OpenAI 兼容端点，适合多模型统一管理。",
    brand: "xinference",
    kind: "local",
    url: "http://127.0.0.1:9997/v1/embeddings",
    modelId: "BAAI/bge-m3",
    needKey: false,
    commonModels: ["BAAI/bge-m3"],
    badge: "本地部署",
  },
];

const ALL_PRESETS = [...CLOUD_PRESETS, ...LOCAL_PRESETS];

/** URL host 口径判断配置属于哪个预设（用户可能改过端点路径，仍归到同 host） */
const hostOf = (url?: string) => {
  try {
    return new URL((url ?? "").trim()).host.toLowerCase();
  } catch {
    return "";
  }
};
const belongsToPreset = (preset: VectorProviderPreset, model: VectorModelConfig) =>
  !!hostOf(preset.url) && hostOf(preset.url) === hostOf(model.url);

function BrandIcon({ brand, className = "size-4" }: { brand: VectorProviderBrand; className?: string }) {
  switch (brand) {
    case "openai":
      return <OpenAI className={className} />;
    case "bailian":
      return <AlibabaCloud className={className} />;
    case "zhipu":
      return <ChatGLM className={className} />;
    case "ollama":
      return <Ollama className={className} />;
    case "lmstudio":
      return <LMStudio className={className} />;
    case "siliconflow":
      return <Cloud className={className} />;
    case "xinference":
      return <Server className={className} />;
    default:
      return <Plus className={className} />;
  }
}

/** 统计已向量化条目数（书籍+论文同表；换模警示与状态卡复用） */
async function countVectorized(): Promise<number> {
  const books = await getBooksWithStatus({ limit: 1000 });
  return books.filter((b) => b.status?.metadata?.vectorization?.status === "success").length;
}

const badgeClass =
  "rounded-full border border-neutral-300 bg-neutral-100 px-2 py-0.5 text-[10px] text-neutral-600 dark:border-neutral-600 dark:bg-neutral-700 dark:text-neutral-300";
const mutedText = "text-neutral-500 text-[11px] dark:text-neutral-400";
const borderClass = "border-neutral-200 dark:border-neutral-700";

export default function VectorModelManager() {
  const {
    vectorModelEnabled,
    vectorModels,
    selectedVectorModelId,
    testText,
    setVectorModelEnabled,
    addVectorModel,
    updateVectorModel,
    deleteVectorModel,
    setSelectedVectorModelId,
  } = useLlamaStore();

  const [isMacOS, setIsMacOS] = useState(false);
  const [cloudOpen, setCloudOpen] = useState(true);
  // 当前展开的 provider 行（云端默认展开第一个）
  const [expandedId, setExpandedId] = useState<string | null>("siliconflow");
  // 本地部署分区默认折叠（不推荐路径）
  const [localOpen, setLocalOpen] = useState(false);
  // 表单目标：预设配置 / 编辑已有配置 / 自定义端点
  const [formTarget, setFormTarget] = useState<
    { kind: "preset"; presetId: string } | { kind: "edit"; id: string } | { kind: "custom" } | null
  >(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, string>>({});
  const [vectorizedCount, setVectorizedCount] = useState(0);
  const [revectorizeProgress, setRevectorizeProgress] = useState<{ done: number; total: number } | null>(null);
  const revectorizeTaskIdsRef = useRef<Set<string>>(new Set());
  const [editingKeySaved, setEditingKeySaved] = useState(false);
  const cloudSectionRef = useRef<HTMLDivElement | null>(null);

  const [formData, setFormData] = useState<Omit<VectorModelConfig, "id">>({
    name: "",
    url: "",
    modelId: "",
    apiKey: "",
    description: "",
  });

  useEffect(() => {
    const osType = getOsType();
    const isMac = osType === "macos";
    setIsMacOS(isMac);
    if (!isMac && !vectorModelEnabled) setVectorModelEnabled(true);
  }, [vectorModelEnabled, setVectorModelEnabled]);

  useEffect(() => {
    countVectorized()
      .then(setVectorizedCount)
      .catch(() => {});
  }, []);

  const selectedModel = vectorModels.find((m) => m.id === selectedVectorModelId);
  const customConfigs = vectorModels.filter((model) => !ALL_PRESETS.some((preset) => belongsToPreset(preset, model)));

  const resetForm = () => {
    setFormData({ name: "", url: "", modelId: "", apiKey: "", description: "" });
    setFormTarget(null);
    setEditingKeySaved(false);
  };

  /** 打开预设配置表单（自动展开对应 provider 行） */
  const openPresetForm = (preset: VectorProviderPreset) => {
    setFormData({
      name: preset.name,
      url: preset.url,
      modelId: preset.modelId,
      apiKey: "",
      description: preset.desc,
    });
    setFormTarget({ kind: "preset", presetId: preset.id });
    setEditingKeySaved(false);
    setExpandedId(preset.id);
    if (preset.kind === "local") setLocalOpen(true);
  };

  const openCustomForm = () => {
    setFormData({ name: "", url: "", modelId: "", apiKey: "", description: "" });
    setFormTarget({ kind: "custom" });
    setEditingKeySaved(false);
  };

  const startEdit = (model: VectorModelConfig) => {
    setFormData({
      name: model.name,
      url: model.url,
      modelId: model.modelId,
      apiKey: "",
      description: model.description || "",
    });
    setFormTarget({ kind: "edit", id: model.id });
    setEditingKeySaved(false);
    const preset = ALL_PRESETS.find((p) => belongsToPreset(p, model));
    if (preset) {
      setExpandedId(preset.id);
      if (preset.kind === "local") setLocalOpen(true);
    }
    secretHas("vector-model", model.id)
      .then(setEditingKeySaved)
      .catch(() => {});
  };

  /** 保存新配置（预设/自定义共用），返回新配置 */
  const saveNewModel = async (): Promise<VectorModelConfig | null> => {
    if (!formData.name.trim() || !formData.url.trim() || !formData.modelId.trim()) {
      toast.error("请填写必填字段：名称、URL、模型ID");
      return null;
    }
    const newModel: VectorModelConfig = { id: `model-${Date.now()}`, ...formData };
    if (formData.apiKey.trim()) {
      try {
        await secretSet("vector-model", newModel.id, formData.apiKey.trim());
      } catch (error) {
        toast.error(`密钥保存失败：${error instanceof Error ? error.message : String(error)}`);
        return null;
      }
    }
    addVectorModel(newModel);
    return newModel;
  };

  /** 启用（单选）——换模型且有存量向量库时强警示 */
  const enableModel = async (model: VectorModelConfig) => {
    const switching = selectedVectorModelId && selectedVectorModelId !== model.id;
    if (switching && vectorizedCount > 0) {
      const confirmed = await ask(
        `切换到「${model.name}」后，已向量化的 ${vectorizedCount} 本书/论文将全部失效，需要用新模型重新向量化后才能继续语义检索。\n\n确定切换吗？`,
        { title: "切换向量模型", kind: "warning" },
      );
      if (!confirmed) return;
    }
    setSelectedVectorModelId(model.id);
    if (!model.dimension) await detectModelDimension(model, "检测维度中...");
  };

  /** 预设保存并启用：保存 → 探测维度 → 启用 */
  const savePresetAndEnable = async () => {
    const created = await saveNewModel();
    if (!created) return;
    resetForm();
    toast.success(`已保存配置：${created.name}，正在测试连通性…`);
    await detectModelDimension(created, "测试中...");
    const latest = useLlamaStore.getState().vectorModels.find((m) => m.id === created.id) ?? created;
    await enableModel(latest);
  };

  const handleEdit = async () => {
    if (formTarget?.kind !== "edit") return;
    if (!formData.name.trim() || !formData.url.trim() || !formData.modelId.trim()) {
      toast.error("请填写必填字段");
      return;
    }
    const editingId = formTarget.id;
    if (formData.apiKey.trim()) {
      try {
        await secretSet("vector-model", editingId, formData.apiKey.trim());
      } catch (error) {
        toast.error(`密钥保存失败：${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      updateVectorModel(editingId, formData);
    } else {
      const { apiKey: _apiKey, ...rest } = formData;
      updateVectorModel(editingId, rest);
    }
    toast.success(`已更新模型配置：${formData.name}`);
    resetForm();
  };

  const handleCustomSave = async () => {
    const created = await saveNewModel();
    if (!created) return;
    resetForm();
    toast.success(`已添加模型配置：${created.name}，可在下方启用`);
  };

  const handleDelete = async (id: string, name: string) => {
    try {
      const confirmed = await ask(`确定删除模型配置"${name}"吗？\n\n此操作无法撤销。`, {
        title: "确认删除",
        kind: "warning",
      });
      if (confirmed) {
        deleteVectorModel(id);
        await secretDelete("vector-model", id).catch(() => {});
        toast.success(`已删除模型配置：${name}`);
      }
    } catch (error) {
      console.error("删除模型配置失败:", error);
    }
  };

  const detectModelDimension = async (model: VectorModelConfig, statusMessage: string) => {
    setTestingId(model.id);
    setTestResults((prev) => ({ ...prev, [model.id]: statusMessage }));
    const testUrl = normalizeEmbeddingsUrl(model.url);
    try {
      const isOllama = testUrl.endsWith("/api/embed");
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (model.apiKey.trim()) headers.Authorization = `Bearer ${model.apiKey}`;
      const requestBody = isOllama
        ? { model: model.modelId, input: testText || "测试文本" }
        : { input: [testText || "测试文本"], model: model.modelId, encoding_format: "float" };
      const res = await tauriFetch(testUrl, { method: "POST", headers, body: JSON.stringify(requestBody) });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      const json = await res.json();
      const len = isOllama ? (json?.embeddings?.[0]?.length ?? 0) : (json?.data?.[0]?.embedding?.length ?? 0);
      const prevDimension = model.dimension;
      updateVectorModel(model.id, { dimension: len });
      let msg = `连接成功 | 维度: ${len}`;
      if (prevDimension && prevDimension !== len) {
        msg += `（⚠️ 原记录维度 ${prevDimension} 已变化，已有向量库需重新向量化）`;
      }
      setTestResults((prev) => ({ ...prev, [model.id]: msg }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const isLocalTarget = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/)/i.test(testUrl);
      const connectionFailed =
        /failed to fetch|error sending request|connection refused|ECONNREFUSED|actively refused/i.test(message);
      const hint =
        connectionFailed && isLocalTarget
          ? `（无法连接本地服务：请确认服务已启动且端口正确——Ollama 可运行 "ollama serve" 或看托盘图标）`
          : "";
      setTestResults((prev) => ({ ...prev, [model.id]: `连接失败: ${message}${hint}` }));
    } finally {
      setTestingId(null);
    }
  };

  const handleRevectorizeAll = async () => {
    if (revectorizeProgress) return;
    const all = await getBooksWithStatus({ limit: 1000 }).catch(() => []);
    const targets = all.filter((b) => b.format === "EPUB" || b.format === "MARKDOWN");
    if (targets.length === 0) {
      toast.info("没有可向量化的书籍/论文（仅支持 EPUB 书籍与 MARKDOWN 论文）");
      return;
    }
    const confirmed = await ask(
      `将用当前模型「${selectedModel?.name ?? "内置模型"}」对全部 ${targets.length} 本书籍/论文重新向量化，旧向量随之废弃。条目较多时耗时较长，期间请保持应用运行。\n\n确定开始吗？`,
      { title: "全量重新向量化", kind: "warning" },
    );
    if (!confirmed) return;
    const { enqueueBookVectorize } = await import("@/services/task-executors/book-vectorize");
    const { enqueuePaperVectorize } = await import("@/services/task-executors/paper-vectorize");
    const taskIds = new Set<string>();
    let skipped = 0;
    for (const t of targets) {
      const res =
        t.format === "MARKDOWN"
          ? enqueuePaperVectorize({ id: t.id, title: t.title, author: t.author ?? "" })
          : enqueueBookVectorize({ id: t.id, title: t.title });
      if (res.ok) taskIds.add(res.taskId);
      else skipped += 1;
    }
    if (taskIds.size === 0) {
      toast.info(`没有新条目可入队${skipped > 0 ? `（${skipped} 个已在队列中或冲突跳过）` : ""}`);
      return;
    }
    if (skipped > 0) toast.info(`跳过 ${skipped} 个已在队列中或冲突的条目，其余 ${taskIds.size} 个已入队`);
    revectorizeTaskIdsRef.current = taskIds;
    setRevectorizeProgress({ done: 0, total: taskIds.size });
  };

  const taskCenterTasks = useTaskCenterStore((s) => s.tasks);
  useEffect(() => {
    if (!revectorizeProgress) return;
    const ids = revectorizeTaskIdsRef.current;
    if (ids.size === 0) return;
    const settled = [...ids]
      .map((id) => taskCenterTasks[id])
      .filter((t) => t !== undefined && t.status !== "queued" && t.status !== "running");
    if (settled.length < ids.size) {
      if (settled.length !== revectorizeProgress.done)
        setRevectorizeProgress({ done: settled.length, total: ids.size });
      return;
    }
    const successCount = settled.filter((t) => t.status === "success").length;
    const failCount = settled.filter((t) => t.status === "error").length;
    const cancelled = settled.some((t) => t.status === "cancelled");
    revectorizeTaskIdsRef.current = new Set();
    setRevectorizeProgress(null);
    countVectorized()
      .then(setVectorizedCount)
      .catch(() => {});
    if (cancelled) {
      toast.info(`已取消：完成 ${successCount + failCount}/${ids.size} 个（成功 ${successCount}，失败 ${failCount}）`);
    } else if (failCount > 0) {
      toast.warning(`重新向量化完成：成功 ${successCount} 个，失败 ${failCount} 个（失败条目可稍后重试）`, {
        duration: 8000,
      });
    } else {
      toast.success(`全量重新向量化完成：共 ${successCount} 个条目`);
    }
  }, [taskCenterTasks, revectorizeProgress]);

  /** 内联配置表单（预设/编辑/自定义复用） */
  const renderForm = (opts: { mode: "preset" | "edit" | "custom"; preset?: VectorProviderPreset }) => {
    const { mode, preset } = opts;
    const isEdit = mode === "edit";
    const isCustom = mode === "custom";
    return (
      <div className={`rounded-lg border ${borderClass} bg-background p-3 dark:bg-neutral-800`}>
        <div className="mb-2 flex items-center justify-between">
          <span className="font-medium text-neutral-800 text-xs dark:text-neutral-200">
            {isEdit ? "编辑模型配置" : isCustom ? "添加自定义端点" : `配置 ${preset?.name}`}
          </span>
          <button
            type="button"
            onClick={resetForm}
            className="text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300"
          >
            <X size={14} />
          </button>
        </div>
        <div className="grid gap-2.5">
          {isCustom && (
            <Input
              value={formData.name}
              onChange={(e) => setFormData((prev) => ({ ...prev, name: e.target.value }))}
              placeholder="配置名称（如 OpenAI Embedding）"
              className="h-8"
            />
          )}
          <div>
            <div className="mb-1 flex items-center justify-between">
              <span className={`text-[11px] ${mutedText}`}>服务地址（完整 embeddings 端点）</span>
              {preset?.applyUrl && !isEdit && (
                <button
                  type="button"
                  onClick={() => openUrl(preset.applyUrl!).catch(() => {})}
                  className="text-[11px] text-blue-600 underline underline-offset-2 hover:text-blue-500 dark:text-blue-400"
                >
                  获取 API Key ↗
                </button>
              )}
            </div>
            <Input
              value={formData.url}
              onChange={(e) => setFormData((prev) => ({ ...prev, url: e.target.value }))}
              placeholder="https://api.example.com/v1/embeddings"
              className="h-8"
            />
          </div>
          <div>
            <span className={`text-[11px] ${mutedText}`}>模型 ID</span>
            <Input
              value={formData.modelId}
              onChange={(e) => setFormData((prev) => ({ ...prev, modelId: e.target.value }))}
              placeholder="text-embedding-3-small"
              className="mt-1 h-8"
            />
            {preset?.commonModels && preset.commonModels.length > 0 && (
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {preset.commonModels.map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setFormData((prev) => ({ ...prev, modelId: m }))}
                    className="rounded border border-neutral-300 px-1.5 py-0.5 text-[10px] text-neutral-600 hover:border-neutral-400 dark:border-neutral-600 dark:text-neutral-300"
                  >
                    {m}
                  </button>
                ))}
              </div>
            )}
          </div>
          {preset?.needKey !== false && (
            <div>
              <span className={`text-[11px] ${mutedText}`}>API Key</span>
              <Input
                type="password"
                value={formData.apiKey}
                onChange={(e) => setFormData((prev) => ({ ...prev, apiKey: e.target.value }))}
                placeholder={
                  isEdit
                    ? editingKeySaved
                      ? "已保存 ·•••（留空保留，输入新值覆盖）"
                      : "留空保留原密钥"
                    : preset?.needKey
                      ? "填入服务商 API Key"
                      : "本地服务可留空"
                }
                className="mt-1 h-8"
                autoComplete="off"
              />
              <p className="mt-1 text-[10px] text-neutral-500 dark:text-neutral-400">
                密钥保存在系统凭据管理器，不明文落盘、不随备份上传。
              </p>
            </div>
          )}
          <div className="flex justify-end gap-2 pt-1">
            <Button size="sm" variant="outline" onClick={resetForm}>
              取消
            </Button>
            <Button
              size="sm"
              onClick={
                isEdit
                  ? handleEdit
                  : isCustom
                    ? handleCustomSave
                    : () => {
                        void savePresetAndEnable();
                      }
              }
            >
              {isEdit ? "保存" : isCustom ? "添加" : "保存并启用"}
            </Button>
          </div>
        </div>
      </div>
    );
  };

  const renderConfigRow = (model: VectorModelConfig) => {
    const selected = selectedVectorModelId === model.id;
    const result = testResults[model.id];
    const resultClass = result?.includes("⚠️")
      ? "text-amber-600 dark:text-amber-400"
      : result?.includes("成功")
        ? "text-green-600 dark:text-green-400"
        : result?.includes("失败")
          ? "text-red-600 dark:text-red-400"
          : "text-neutral-500 dark:text-neutral-400";
    return (
      <div
        key={model.id}
        className={`flex items-start gap-2 rounded-md border ${borderClass} bg-background px-3 py-2 dark:bg-neutral-800`}
      >
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-neutral-800 text-xs dark:text-neutral-200">{model.name}</span>
            <span
              className={badgeClass}
            >{`${model.modelId || "未填模型"}${model.dimension ? ` · ${model.dimension} 维` : ""}`}</span>
            {selected && (
              <span className="rounded-full bg-green-100 px-2 py-0.5 text-[10px] text-green-700 dark:bg-green-900/40 dark:text-green-300">
                已启用
              </span>
            )}
          </div>
          <div className={`mt-0.5 truncate ${mutedText}`}>{model.url}</div>
          {result && <div className={`mt-0.5 text-[10px] ${resultClass}`}>{result}</div>}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            onClick={() => void detectModelDimension(model, "测试中...")}
            disabled={testingId === model.id}
            className="rounded px-1.5 py-0.5 text-[11px] text-neutral-600 hover:bg-muted dark:text-neutral-300"
          >
            {testingId === model.id ? "测试中…" : "测试"}
          </button>
          <button
            type="button"
            onClick={() => startEdit(model)}
            className="rounded px-1 py-0.5 text-neutral-500 hover:bg-muted hover:text-blue-600 dark:text-neutral-400 dark:hover:text-blue-400"
            title="编辑"
          >
            <Pencil size={13} />
          </button>
          <button
            type="button"
            onClick={() => void handleDelete(model.id, model.name)}
            className="rounded px-1 py-0.5 text-neutral-500 hover:bg-muted hover:text-red-600 dark:text-neutral-400 dark:hover:text-red-400"
            title="删除"
          >
            <Trash2 size={13} />
          </button>
          <Switch
            checked={selected}
            onCheckedChange={(checked) => {
              if (checked) void enableModel(model);
              else setSelectedVectorModelId(null);
            }}
            className="scale-90"
          />
        </div>
      </div>
    );
  };

  const renderProviderRow = (preset: VectorProviderPreset) => {
    const configs = vectorModels.filter((model) => belongsToPreset(preset, model));
    const selectedConfig = configs.find((model) => model.id === selectedVectorModelId);
    const expanded = expandedId === preset.id;
    const isEditingHere = formTarget?.kind === "edit" && configs.some((m) => m.id === formTarget.id);
    const isPresetFormHere = formTarget?.kind === "preset" && formTarget.presetId === preset.id;
    return (
      <div
        key={preset.id}
        className={`rounded-xl border ${expanded ? "border-neutral-300 dark:border-neutral-500" : borderClass} bg-muted/80`}
      >
        <button
          type="button"
          onClick={() => setExpandedId(expanded ? null : preset.id)}
          className="flex w-full items-center gap-2.5 px-3.5 py-3 text-left"
        >
          <span
            className={`flex size-9 shrink-0 items-center justify-center rounded-lg border ${borderClass} bg-muted/60 dark:bg-neutral-700`}
          >
            <BrandIcon brand={preset.brand} className="size-4" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-center gap-1.5">
              <span className="font-medium text-neutral-800 text-sm dark:text-neutral-200">{preset.name}</span>
              <span className={badgeClass}>{preset.badge}</span>
              {selectedConfig && (
                <span className="rounded-full bg-green-100 px-2 py-0.5 text-[10px] text-green-700 dark:bg-green-900/40 dark:text-green-300">
                  已启用 · {selectedConfig.dimension ? `${selectedConfig.dimension} 维` : "维度待测"}
                </span>
              )}
            </span>
            <span className={`mt-0.5 block truncate ${mutedText}`}>{preset.desc}</span>
          </span>
          <span className={`shrink-0 text-[11px] ${mutedText}`}>
            {configs.length === 0 ? "未配置" : selectedConfig ? "" : `${configs.length} 个配置`}
          </span>
          <ChevronRight
            className={`size-4 shrink-0 text-neutral-400 transition-transform ${expanded ? "rotate-90" : ""}`}
          />
        </button>
        {expanded && (
          <div className={`space-y-2 border-t ${borderClass} px-3.5 py-3`}>
            {configs.map((model) =>
              isEditingHere && formTarget?.kind === "edit" && formTarget.id === model.id
                ? renderForm({ mode: "edit", preset })
                : renderConfigRow(model),
            )}
            {isPresetFormHere && renderForm({ mode: "preset", preset })}
            {!isPresetFormHere && !isEditingHere && (
              <button
                type="button"
                onClick={() => openPresetForm(preset)}
                className="flex w-full items-center justify-center gap-1 rounded-md border border-neutral-300 border-dashed py-1.5 text-[11px] text-neutral-500 hover:border-neutral-400 hover:text-neutral-700 dark:border-neutral-600 dark:text-neutral-400 dark:hover:text-neutral-200"
              >
                <Plus size={12} /> {configs.length === 0 ? `配置 ${preset.name}` : "再添加一个配置"}
              </button>
            )}
          </div>
        )}
      </div>
    );
  };

  const brandOfModel = (model: VectorModelConfig): VectorProviderBrand =>
    ALL_PRESETS.find((preset) => belongsToPreset(preset, model))?.brand ?? "custom";
  const selectedBrand = selectedModel ? brandOfModel(selectedModel) : "custom";
  const selectedKind =
    selectedModel && LOCAL_PRESETS.some((preset) => belongsToPreset(preset, selectedModel)) ? "本地部署" : "云端 API";

  const testSelected = () => {
    if (selectedModel) void detectModelDimension(selectedModel, "测试中...");
  };
  const focusCloudSection = () => {
    setCloudOpen(true);
    cloudSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <div className="space-y-4 text-neutral-800 dark:text-neutral-100">
      {/* 页头：标题 + 说明 + 全局动作（与模型提供商页同口径） */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2>向量模型</h2>
          <p className="mt-1.5 max-w-3xl text-neutral-500 text-xs leading-relaxed dark:text-neutral-400">
            把文字变成向量，支撑语义检索：聊书问答、论文检索、翻译句对齐都依赖它。同时只能启用一个模型，切换后需要重建已有索引。
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {revectorizeProgress ? (
            <Button
              size="sm"
              variant="outline"
              className="h-8 text-xs"
              title="当前条目完成后停止"
              onClick={() => {
                useTaskCenterStore.getState().cancelChannel("book-vectorize");
                useTaskCenterStore.getState().cancelChannel("paper-vectorize");
              }}
            >
              取消（{revectorizeProgress.done}/{revectorizeProgress.total}）
            </Button>
          ) : (
            <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => void handleRevectorizeAll()}>
              全量重建索引
            </Button>
          )}
        </div>
      </div>

      {/* 当前生效（对应 demo：描边高亮卡片） */}
      <div
        className={`rounded-xl border px-4 py-3 ${
          selectedModel
            ? "border-amber-300/70 bg-gradient-to-b from-amber-50/70 to-transparent dark:border-amber-800/50 dark:from-amber-950/20"
            : `${borderClass} bg-muted/80`
        }`}
      >
        {selectedModel ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-amber-300/60 bg-background dark:border-amber-800/50 dark:bg-neutral-800">
                <BrandIcon brand={selectedBrand} className="size-5" />
              </span>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="font-medium text-neutral-800 text-sm dark:text-neutral-100">
                    {selectedModel.name}
                  </span>
                  <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">
                    当前启用
                  </span>
                  <span className={badgeClass}>{selectedKind}</span>
                  {selectedModel.dimension ? <span className={badgeClass}>{selectedModel.dimension} 维</span> : null}
                </div>
                <div className="mt-0.5 truncate text-[11px] text-neutral-500 dark:text-neutral-400">
                  已启用 · {hostOf(selectedModel.url) || selectedModel.url}
                </div>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <span className="text-[11px] text-neutral-500 dark:text-neutral-400">已向量化 {vectorizedCount} 项</span>
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs"
                onClick={testSelected}
                disabled={testingId === selectedModel.id}
              >
                {testingId === selectedModel.id ? "测试中…" : "测试连接"}
              </Button>
              <Button size="sm" variant="outline" className="h-7 text-xs" onClick={focusCloudSection}>
                更换模型
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-2 text-neutral-500 text-sm dark:text-neutral-400">
            <CircuitBoard className="size-4" />
            尚未启用向量模型——在下方「云端 API」里选一家配置 Key 并启用即可
          </div>
        )}
      </div>

      {isMacOS && (
        <div className="flex items-start justify-between rounded-xl border border-neutral-200 bg-background px-4 py-3 dark:border-neutral-700 dark:bg-neutral-800">
          <div>
            <div className="text-neutral-800 text-xs dark:text-neutral-200">使用外部向量模型</div>
            <div className={`mt-0.5 ${mutedText}`}>关闭则使用应用内置的 Llama.cpp 本地嵌入服务（仅 macOS）</div>
          </div>
          <Switch checked={vectorModelEnabled} onCheckedChange={setVectorModelEnabled} />
        </div>
      )}

      {vectorModelEnabled && (
        <div className="space-y-5">
          {/* 云端 API（推荐；与本地部署同 level 的分区头，默认展开） */}
          <div ref={cloudSectionRef} id="vector-cloud-providers" className="space-y-2">
            <button
              type="button"
              onClick={() => setCloudOpen((v) => !v)}
              className="flex w-full items-start justify-between gap-3 text-left"
            >
              <span className="flex flex-col gap-0.5">
                <span className="font-semibold text-neutral-800 text-sm dark:text-neutral-100">云端 API</span>
                <span className={mutedText}>推荐 · 选择服务商 → 填 Key → 保存并启用；条目默认折叠，点击展开</span>
              </span>
              <ChevronRight
                className={`mt-0.5 size-4 shrink-0 text-neutral-400 transition-transform ${cloudOpen ? "rotate-90" : ""}`}
              />
            </button>
            {cloudOpen && (
              <div className="space-y-2">
                {CLOUD_PRESETS.map(renderProviderRow)}
                {/* 自定义端点与其他配置 */}
                <div
                  className={`rounded-xl border ${expandedId === "custom" ? "border-neutral-300 dark:border-neutral-500" : borderClass} bg-muted/80`}
                >
                  <button
                    type="button"
                    onClick={() => setExpandedId(expandedId === "custom" ? null : "custom")}
                    className="flex w-full items-center gap-2.5 px-3.5 py-3 text-left"
                  >
                    <span
                      className={`flex size-9 shrink-0 items-center justify-center rounded-lg border ${borderClass} bg-muted/60 dark:bg-neutral-700`}
                    >
                      <Plus className="size-4 text-neutral-500" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span className="font-medium text-neutral-800 text-sm dark:text-neutral-200">自定义端点</span>
                        <span className={badgeClass}>OpenAI 兼容</span>
                      </span>
                      <span className={`mt-0.5 block truncate ${mutedText}`}>
                        任意兼容 /v1/embeddings 的服务（llama.cpp server / TEI / 其它云厂商）
                      </span>
                    </span>
                    <ChevronRight
                      className={`size-4 shrink-0 text-neutral-400 transition-transform ${expandedId === "custom" ? "rotate-90" : ""}`}
                    />
                  </button>
                  {expandedId === "custom" && (
                    <div className={`space-y-2 border-t ${borderClass} px-3.5 py-3`}>
                      {customConfigs.map((model) =>
                        formTarget?.kind === "edit" && formTarget.id === model.id
                          ? renderForm({ mode: "edit" })
                          : renderConfigRow(model),
                      )}
                      {formTarget?.kind === "custom"
                        ? renderForm({ mode: "custom" })
                        : !(formTarget?.kind === "edit" && customConfigs.some((m) => m.id === formTarget.id)) && (
                            <button
                              type="button"
                              onClick={openCustomForm}
                              className="flex w-full items-center justify-center gap-1 rounded-lg border border-neutral-300 border-dashed py-2 text-[11px] text-neutral-500 hover:border-neutral-400 hover:text-neutral-700 dark:border-neutral-600 dark:text-neutral-400 dark:hover:text-neutral-200"
                            >
                              <Plus size={12} /> 添加自定义端点
                            </button>
                          )}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* 本地部署（与云端同 level 的分区头；默认折叠 + 不推荐说明） */}
          <div className="space-y-2">
            <button
              type="button"
              onClick={() => setLocalOpen((v) => !v)}
              className="flex w-full items-start justify-between gap-3 text-left"
            >
              <span className="flex flex-col gap-0.5">
                <span className="font-semibold text-neutral-800 text-sm dark:text-neutral-100">本地部署</span>
                <span className={mutedText}>
                  进阶（可选）· 不推荐：手机/平板无法本地部署向量模型，移动端场景请用云端 API
                </span>
              </span>
              <ChevronRight
                className={`mt-0.5 size-4 shrink-0 text-neutral-400 transition-transform ${localOpen ? "rotate-90" : ""}`}
              />
            </button>
            {localOpen && <div className="space-y-2">{LOCAL_PRESETS.map(renderProviderRow)}</div>}
          </div>

          {/* 换模警示 */}
          <div className="rounded-xl border border-red-300/50 bg-red-50/50 px-4 py-3 text-red-700 text-xs dark:border-red-900/50 dark:bg-red-950/20 dark:text-red-300">
            <b>切换向量模型后，已向量化的 {vectorizedCount} 本书/论文将全部失效</b>
            ，需要用新模型重建索引才能继续语义检索。维度以实际探测结果为准，无需手填；同时只能启用一个模型。
          </div>
        </div>
      )}
    </div>
  );
}
