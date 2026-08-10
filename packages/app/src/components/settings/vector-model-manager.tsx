import { vectorizeItem } from "@/ai/tools/central/vectorize-book";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { getBooksWithStatus } from "@/services/book-service";
import { secretDelete, secretHas, secretSet } from "@/services/secret-service";
import { type VectorModelConfig, useLlamaStore } from "@/store/llama-store";
import { getCurrentVectorModelConfig, normalizeEmbeddingsUrl } from "@/utils/model";
import { ask } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { type as getOsType } from "@tauri-apps/plugin-os";
import { ChevronDown, CircuitBoard, Cloud, Edit2, Info, Plus, Server, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

/** G2：接入方式预设——点击自动填充添加表单（本地部署免 Key，云端需 Key） */
const PRESETS: {
  id: string;
  label: string;
  badge: string;
  name: string;
  url: string;
  modelId: string;
  needKey: boolean;
  desc: string;
}[] = [
  {
    id: "ollama",
    label: "Ollama",
    badge: "本地部署",
    name: "Ollama 本地模型",
    url: "http://127.0.0.1:11434/api/embed",
    modelId: "bge-m3",
    needKey: false,
    desc: "完全离线，免申请，隐私最好",
  },
  {
    id: "xinference",
    label: "Xinference",
    badge: "本地部署",
    name: "Xinference 本地模型",
    url: "http://127.0.0.1:9997/v1/embeddings",
    modelId: "BAAI/bge-m3",
    needKey: false,
    desc: "本地服务，OpenAI 兼容端点",
  },
  {
    id: "siliconflow",
    label: "硅基流动",
    badge: "云端",
    name: "硅基流动 bge-m3",
    url: "https://api.siliconflow.cn/v1/embeddings",
    modelId: "BAAI/bge-m3",
    needKey: true,
    desc: "有免费额度，速度快",
  },
  {
    id: "openai-compatible",
    label: "自定义端点",
    badge: "云端/本地",
    name: "",
    url: "",
    modelId: "",
    needKey: true,
    desc: "任意 OpenAI 兼容 /v1/embeddings",
  },
];

/** G1：云端 Key 申请入口（外链走 plugin-opener） */
const APPLY_LINKS: { label: string; url: string; note: string }[] = [
  { label: "硅基流动", url: "https://cloud.siliconflow.cn", note: "有免费额度" },
  { label: "OpenAI", url: "https://platform.openai.com/api-keys", note: "text-embedding 系列" },
  { label: "阿里云百炼", url: "https://bailian.console.aliyun.com", note: "qwen3-embedding 系列" },
];

/** 统计已向量化条目数（书籍+论文同表；G3 现状展示与 G1-3 重建后刷新复用） */
async function countVectorized(): Promise<number> {
  const books = await getBooksWithStatus({ limit: 1000 });
  return books.filter((b) => b.status?.metadata?.vectorization?.status === "success").length;
}

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
  const [showAddForm, setShowAddForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, string>>({});
  // G1：介绍区折叠（默认展开一次引导，用户可收起）
  const [introOpen, setIntroOpen] = useState(true);
  // G2：本地部署指引折叠
  const [localGuideOpen, setLocalGuideOpen] = useState(false);
  // G3：已向量化条目数（换模型警示用）
  const [vectorizedCount, setVectorizedCount] = useState(0);
  // G1-3：全量重新向量化进度（null = 空闲）
  const [revectorizeProgress, setRevectorizeProgress] = useState<{ done: number; total: number } | null>(null);
  // G1-3 取消标记：条目间检查（单条不可中断，靠 embedding 超时兜底不悬死）
  const revectorizeCancelRef = useRef(false);

  const [formData, setFormData] = useState<Omit<VectorModelConfig, "id">>({
    name: "",
    url: "",
    modelId: "",
    apiKey: "",
    description: "",
  });
  // 编辑态：keyring 中是否已有该模型的密钥（用于「已保存 ·•••」提示，与其他设置项文案一致）
  const [editingKeySaved, setEditingKeySaved] = useState(false);

  useEffect(() => {
    const osType = getOsType();
    const isMac = osType === "macos";
    setIsMacOS(isMac);
    if (!isMac && !vectorModelEnabled) {
      setVectorModelEnabled(true);
    }
  }, [vectorModelEnabled, setVectorModelEnabled]);

  // G3：统计已向量化条目数（书籍+论文同表）
  useEffect(() => {
    countVectorized()
      .then(setVectorizedCount)
      .catch(() => {});
  }, []);

  const labelClass = "block mb-2 text-sm text-neutral-800 dark:text-neutral-200";

  const resetForm = () => {
    setFormData({
      name: "",
      url: "",
      modelId: "",
      apiKey: "",
      description: "",
    });
    setShowAddForm(false);
    setEditingId(null);
    setEditingKeySaved(false);
  };

  // G2：预设填充——打开添加表单并预填字段
  const applyPreset = (presetId: string) => {
    const preset = PRESETS.find((p) => p.id === presetId);
    if (!preset) return;
    setEditingId(null);
    setEditingKeySaved(false);
    setFormData({
      name: preset.name,
      url: preset.url,
      modelId: preset.modelId,
      apiKey: "",
      description: preset.desc,
    });
    setShowAddForm(true);
  };

  const handleAdd = async () => {
    if (!formData.name.trim() || !formData.url.trim() || !formData.modelId.trim()) {
      toast.error("请填写必填字段：名称、URL、模型ID");
      return;
    }

    const newModel: VectorModelConfig = {
      id: `model-${Date.now()}`,
      ...formData,
    };

    // 批次 A：apiKey 存入 keyring（vector-model:{id}），内存保留真值供请求
    if (formData.apiKey.trim()) {
      try {
        await secretSet("vector-model", newModel.id, formData.apiKey.trim());
      } catch (error) {
        toast.error(`密钥保存失败：${error instanceof Error ? error.message : String(error)}`);
        return;
      }
    }

    addVectorModel(newModel);
    toast.success(`已添加模型配置：${formData.name}，建议点「测试」验证连通性`);
    resetForm();
  };

  const startEdit = (model: VectorModelConfig) => {
    // 批次 A：不回显已保存的 key，留空表示保留原密钥
    setFormData({
      name: model.name,
      url: model.url,
      modelId: model.modelId,
      apiKey: "",
      description: model.description || "",
    });
    setEditingId(model.id);
    setEditingKeySaved(false);
    secretHas("vector-model", model.id)
      .then((has) => setEditingKeySaved(has))
      .catch(() => {});
  };

  const handleEdit = async () => {
    if (!editingId || !formData.name.trim() || !formData.url.trim() || !formData.modelId.trim()) {
      toast.error("请填写必填字段");
      return;
    }

    if (formData.apiKey.trim()) {
      // 填了新 key：更新 keyring + 内存
      try {
        await secretSet("vector-model", editingId, formData.apiKey.trim());
      } catch (error) {
        toast.error(`密钥保存失败：${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      updateVectorModel(editingId, formData);
    } else {
      // 留空：保留原密钥（内存中的值不动）
      const { apiKey: _apiKey, ...rest } = formData;
      updateVectorModel(editingId, rest);
    }
    toast.success(`已更新模型配置：${formData.name}`);
    resetForm();
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

    try {
      const testUrl = normalizeEmbeddingsUrl(model.url);
      const isOllama = testUrl.endsWith("/api/embed");

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };

      if (model.apiKey.trim()) {
        headers.Authorization = `Bearer ${model.apiKey}`;
      }

      const requestBody = isOllama
        ? {
            model: model.modelId,
            input: testText || "测试文本",
          }
        : {
            input: [testText || "测试文本"],
            model: model.modelId,
            encoding_format: "float",
          };

      const res = await fetch(testUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(requestBody),
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }

      const json = await res.json();

      const len = isOllama ? (json?.embeddings?.[0]?.length ?? 0) : (json?.data?.[0]?.embedding?.length ?? 0);

      // G3：维度变化警示（硅基流动维度变更事件防御）
      const prevDimension = model.dimension;
      updateVectorModel(model.id, { dimension: len });
      let msg = `连接成功 | 维度: ${len}`;
      if (prevDimension && prevDimension !== len) {
        msg += `（⚠️ 原记录维度 ${prevDimension} 已变化，已有向量库需重新向量化）`;
      }
      setTestResults((prev) => ({ ...prev, [model.id]: msg }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setTestResults((prev) => ({ ...prev, [model.id]: `连接失败: ${message}` }));
    } finally {
      setTestingId(null);
    }
  };

  const testModel = async (model: VectorModelConfig) => {
    await detectModelDimension(model, "测试中...");
  };

  const handleModelSelect = async (model: VectorModelConfig, checked: boolean) => {
    if (checked) {
      // G3：换模型且有存量向量库 → 强警示（向量与模型绑定，换模型即全部失效）
      const switching = selectedVectorModelId && selectedVectorModelId !== model.id;
      if (switching && vectorizedCount > 0) {
        const confirmed = await ask(
          `切换到「${model.name}」后，已向量化的 ${vectorizedCount} 本书/论文将全部失效，需要用新模型重新向量化后才能继续语义检索。\n\n确定切换吗？`,
          { title: "切换向量模型", kind: "warning" },
        );
        if (!confirmed) return;
      }
      setSelectedVectorModelId(model.id);
      if (!model.dimension) {
        await detectModelDimension(model, "检测维度中...");
      }
    } else {
      setSelectedVectorModelId(null);
    }
  };

  /**
   * G1-3：全量重新向量化——换模型/维度变化后旧向量全部失效，用当前模型逐条重建。
   * 复用全局助手的单条向量化路径（书籍重索引删库重建、论文按 paper_id 先删后插，均幂等），
   * 不另造「清空索引」后端命令；单条失败不中断，结束后统一汇报。
   */
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
    revectorizeCancelRef.current = false;
    setRevectorizeProgress({ done: 0, total: targets.length });
    let successCount = 0;
    let failCount = 0;
    let cancelled = false;
    try {
      const config = await getCurrentVectorModelConfig();
      for (let i = 0; i < targets.length; i++) {
        // 条目间检查取消标记（单条不可中断，靠 embedding 超时 60s 兜底不悬死）
        if (revectorizeCancelRef.current) {
          cancelled = true;
          break;
        }
        // vectorizeItem 内部已兜底异常（返回 success:false），不会因单条失败中断整批
        const result = await vectorizeItem(targets[i], config);
        if (result.success) successCount++;
        else failCount++;
        setRevectorizeProgress({ done: i + 1, total: targets.length });
      }
    } finally {
      setRevectorizeProgress(null);
    }
    countVectorized()
      .then(setVectorizedCount)
      .catch(() => {});
    if (cancelled) {
      toast.info(
        `已取消：完成 ${successCount + failCount}/${targets.length} 个（成功 ${successCount}，失败 ${failCount}）`,
      );
    } else if (failCount > 0) {
      toast.warning(`重新向量化完成：成功 ${successCount} 个，失败 ${failCount} 个（失败条目可稍后重试）`, {
        duration: 8000,
      });
    } else {
      toast.success(`全量重新向量化完成：共 ${successCount} 个条目`);
    }
  };

  const selectedModel = vectorModels.find((m) => m.id === selectedVectorModelId);

  return (
    <section className="rounded-lg bg-muted/80 p-4 pt-3">
      <div className="mb-3 flex items-center justify-between">
        <h2>向量模型</h2>
      </div>

      {/* G1：面向零基础用户的介绍区（可折叠） */}
      <div className="mb-4 rounded-lg border border-neutral-200 bg-background dark:border-neutral-700 dark:bg-neutral-800">
        <button
          type="button"
          onClick={() => setIntroOpen((v) => !v)}
          className="flex w-full items-center justify-between px-4 py-2.5 text-left"
        >
          <span className="flex items-center gap-2 font-medium text-neutral-800 text-sm dark:text-neutral-200">
            <Info className="size-4 text-neutral-500 dark:text-neutral-400" />
            什么是向量模型？
          </span>
          <ChevronDown className={`size-4 text-neutral-400 transition-transform ${introOpen ? "rotate-180" : ""}`} />
        </button>
        {introOpen && (
          <div className="space-y-3 border-neutral-200 border-t px-4 py-3 text-neutral-600 text-xs dark:border-neutral-700 dark:text-neutral-400">
            <p>
              向量模型把文字转成数字向量，让 AI 能按<b className="text-neutral-800 dark:text-neutral-200">语义</b>
              检索内容。SageRead 用它支撑：<b className="text-neutral-800 dark:text-neutral-200">聊书问答</b>
              （AI 基于全书内容回答）、<b className="text-neutral-800 dark:text-neutral-200">论文语义检索</b>、
              <b className="text-neutral-800 dark:text-neutral-200">翻译句词对齐</b>
              。不配置也能正常使用阅读功能，只是没有语义检索能力。
            </p>
            <p>
              <b className="text-neutral-800 dark:text-neutral-200">云端申请</b>
              （需要 API Key，有免费额度）：
              {APPLY_LINKS.map((link, i) => (
                <span key={link.url}>
                  {i > 0 && " · "}
                  <button
                    type="button"
                    className="cursor-pointer text-blue-600 underline underline-offset-2 hover:text-blue-500 dark:text-blue-400"
                    onClick={() => openUrl(link.url).catch(() => {})}
                  >
                    {link.label}
                  </button>
                  <span className="no-underline">（{link.note}）</span>
                </span>
              ))}
            </p>
            <p>
              <b className="text-neutral-800 dark:text-neutral-200">本地部署</b>
              （完全离线、免 Key、隐私最好）：见下方「快速接入」中的 Ollama / Xinference 预设与部署指引。
            </p>
            <p className="rounded bg-amber-50 px-2 py-1.5 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
              ⚠️ 重要：向量结果与模型绑定。<b>更换模型或维度变化后，已向量化的书库/文献库会全部失效</b>
              ，需要用新模型重新向量化。
            </p>
          </div>
        )}
      </div>

      {/* G3：当前状态卡片（含 G1-3「全量重新向量化」入口） */}
      <div className="mb-4 rounded-lg border border-neutral-200 bg-background px-4 py-3 dark:border-neutral-700 dark:bg-neutral-800">
        {selectedModel ? (
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm">
              <CircuitBoard className="size-4 text-green-600 dark:text-green-400" />
              <span className="text-neutral-800 dark:text-neutral-200">当前模型：{selectedModel.name}</span>
              {selectedModel.dimension ? (
                <span className="text-neutral-500 text-xs dark:text-neutral-400">维度 {selectedModel.dimension}</span>
              ) : null}
            </div>
            <div className="flex items-center gap-3">
              <span className="text-neutral-500 text-xs dark:text-neutral-400">已向量化 {vectorizedCount} 本/篇</span>
              {revectorizeProgress ? (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs"
                  title="当前条目完成后停止"
                  onClick={() => {
                    revectorizeCancelRef.current = true;
                  }}
                >
                  取消（{revectorizeProgress.done}/{revectorizeProgress.total}）
                </Button>
              ) : (
                <Button size="sm" variant="outline" className="h-7 text-xs" onClick={handleRevectorizeAll}>
                  全量重新向量化
                </Button>
              )}
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-2 text-neutral-500 text-sm dark:text-neutral-400">
            <CircuitBoard className="size-4" />
            尚未选择向量模型——语义检索暂不可用，配置一个即可解锁
          </div>
        )}
      </div>

      <div className="space-y-4">
        {isMacOS && (
          <div className="flex items-start justify-between">
            <div>
              <div className={labelClass}>使用外部向量模型</div>
              <div className="text-neutral-500 text-xs dark:text-neutral-400">
                启用后将使用下方配置的外部模型（云端或本地部署），而非应用内置的 Llama.cpp 本地服务
              </div>
            </div>
            <Switch checked={vectorModelEnabled} onCheckedChange={setVectorModelEnabled} />
          </div>
        )}

        {!isMacOS && (
          <div className="mb-4">
            <div className={labelClass}>外部向量模型</div>
            <div className="text-neutral-500 text-xs dark:text-neutral-400">
              Windows 不提供应用内置的本地模型（仅 macOS 可用），请自行配置外部向量模型——云端 API 或本地部署（如
              Ollama）均可
            </div>
          </div>
        )}

        {vectorModelEnabled && (
          <>
            {/* G2：快速接入预设 */}
            <div>
              <div className={labelClass}>快速接入</div>
              <div className="grid grid-cols-2 gap-2">
                {PRESETS.map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    onClick={() => applyPreset(preset.id)}
                    className="flex flex-col items-start gap-1 rounded-lg border border-neutral-200 bg-background px-3 py-2 text-left transition-colors hover:border-neutral-400 hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-800 dark:hover:border-neutral-500 dark:hover:bg-neutral-700/60"
                  >
                    <span className="flex w-full items-center gap-1.5">
                      {preset.needKey ? (
                        <Cloud className="size-3.5 shrink-0 text-neutral-500 dark:text-neutral-400" />
                      ) : (
                        <Server className="size-3.5 shrink-0 text-neutral-500 dark:text-neutral-400" />
                      )}
                      <span className="font-medium text-neutral-800 text-xs dark:text-neutral-200">{preset.label}</span>
                      <span className="ml-auto rounded bg-muted px-1.5 py-0.5 text-[10px] text-neutral-500 dark:text-neutral-400">
                        {preset.badge}
                      </span>
                    </span>
                    <span className="text-[11px] text-neutral-500 dark:text-neutral-400">{preset.desc}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* 模型列表 */}
            <div className="space-y-3">
              {vectorModels.length === 0 ? (
                <div className="space-y-1 rounded-lg border p-4 text-center">
                  <p className="text-neutral-600 dark:text-neutral-200">暂无配置的模型</p>
                  <p className="text-neutral-600 text-xs dark:text-neutral-200">
                    点击上方「快速接入」预设，或点击下方「添加模型」手动配置
                  </p>
                </div>
              ) : (
                vectorModels.map((model) => (
                  <div key={model.id} className="flex items-start justify-between gap-3 border-b p-3 px-0">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-3">
                        <span className="font-medium text-neutral-900 text-sm dark:text-neutral-100">{model.name}</span>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button
                              onClick={() => handleDelete(model.id, model.name)}
                              className="p-0 text-neutral-500 hover:text-red-600 dark:text-neutral-400 dark:hover:text-red-400"
                            >
                              <Trash2 className="size-3" />
                            </button>
                          </TooltipTrigger>
                          <TooltipContent side="bottom">删除模型</TooltipContent>
                        </Tooltip>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button
                              onClick={() => startEdit(model)}
                              className="p-0 text-neutral-500 hover:text-blue-600 dark:text-neutral-400 dark:hover:text-blue-400"
                            >
                              <Edit2 className="size-3" />
                            </button>
                          </TooltipTrigger>
                          <TooltipContent side="bottom">编辑模型</TooltipContent>
                        </Tooltip>
                        <button
                          onClick={() => testModel(model)}
                          disabled={testingId === model.id}
                          className="cursor-pointer text-xs"
                        >
                          {testingId === model.id ? "测试中…" : "测试"}
                        </button>
                      </div>
                      <p className="mt-1 text-neutral-600 text-xs dark:text-neutral-400">
                        {model.url} • {model.dimension && `维度: ${model.dimension}`}
                        {testResults[model.id] && (
                          <span
                            className={`mt-1 ml-1 text-xs ${
                              testResults[model.id].includes("⚠️")
                                ? "text-amber-600 dark:text-amber-400"
                                : testResults[model.id].includes("成功")
                                  ? "text-green-600 dark:text-green-400"
                                  : testResults[model.id].includes("失败")
                                    ? "text-red-600 dark:text-red-400"
                                    : "text-neutral-600 dark:text-neutral-400"
                            }`}
                          >
                            {testResults[model.id]}
                          </span>
                        )}
                      </p>
                      <p className="mt-1 text-neutral-600 text-xs dark:text-neutral-400">{model.description}</p>
                    </div>
                    <Switch
                      checked={selectedVectorModelId === model.id}
                      onCheckedChange={(checked) => handleModelSelect(model, checked)}
                      className="shrink-0"
                    />
                  </div>
                ))
              )}
            </div>

            {(showAddForm || editingId) && (
              <div className="rounded-lg border border-neutral-200 bg-background p-4 dark:border-neutral-700 dark:bg-neutral-800">
                <div className="mb-3 flex items-center justify-between">
                  <h4 className="font-medium text-neutral-900 dark:text-neutral-100">
                    {editingId ? "编辑模型配置" : "添加新模型"}
                  </h4>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button size="sm" variant="ghost" onClick={resetForm} className="h-8 px-2">
                        <X size={14} />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">关闭</TooltipContent>
                  </Tooltip>
                </div>

                <div className="grid gap-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className={labelClass}>名称 *</label>
                      <Input
                        value={formData.name}
                        onChange={(e) => setFormData((prev) => ({ ...prev, name: e.target.value }))}
                        placeholder="OpenAI Embedding"
                        className="h-8"
                      />
                    </div>
                    <div>
                      <label className={labelClass}>模型ID *</label>
                      <Input
                        value={formData.modelId}
                        onChange={(e) => setFormData((prev) => ({ ...prev, modelId: e.target.value }))}
                        placeholder="text-embedding-3-small"
                        className="h-8"
                      />
                    </div>
                  </div>
                  <div>
                    <label className={labelClass}>API端点（完整URL）*</label>
                    <Input
                      value={formData.url}
                      onChange={(e) => setFormData((prev) => ({ ...prev, url: e.target.value }))}
                      placeholder="https://api.openai.com/v1/embeddings（必须包含完整路径）"
                      className="h-8"
                    />
                    <p className="mt-1 text-neutral-500 text-xs dark:text-neutral-400">
                      云端填完整 embeddings 端点（含 /v1/embeddings 路径）；本地 Ollama 填
                      http://127.0.0.1:11434/api/embed
                    </p>
                  </div>
                  <div>
                    <label className={labelClass}>
                      API Key{formData.url.includes("127.0.0.1") ? "（本地模型可留空）" : ""}
                    </label>
                    <Input
                      type="password"
                      value={formData.apiKey}
                      onChange={(e) => setFormData((prev) => ({ ...prev, apiKey: e.target.value }))}
                      placeholder={
                        editingId
                          ? editingKeySaved
                            ? "已保存 ·•••（留空保留，输入新值可覆盖）"
                            : "留空保留原密钥，输入新值可覆盖"
                          : "sk-..."
                      }
                      className="h-8"
                      autoComplete="off"
                    />
                    <p className="mt-1 text-neutral-500 text-xs dark:text-neutral-400">
                      密钥保存在系统凭据管理器，不会明文落盘或随备份上传。
                    </p>
                  </div>
                  <div>
                    <label className={labelClass}>描述</label>
                    <Input
                      value={formData.description}
                      onChange={(e) => setFormData((prev) => ({ ...prev, description: e.target.value }))}
                      placeholder="模型描述信息"
                      className="h-8"
                    />
                  </div>
                </div>

                <div className="mt-4 flex justify-end gap-2">
                  <Button size="sm" variant="outline" onClick={resetForm}>
                    取消
                  </Button>
                  <Button size="sm" onClick={editingId ? handleEdit : handleAdd}>
                    {editingId ? "保存" : "添加"}
                  </Button>
                </div>
              </div>
            )}

            {!showAddForm && !editingId && (
              <Button variant="outline" onClick={() => setShowAddForm(true)} className="flex w-full items-center gap-2">
                <Plus size={16} />
                添加模型配置
              </Button>
            )}

            {/* G2：本地部署指引（折叠） */}
            <div className="rounded-lg border border-neutral-200 bg-background dark:border-neutral-700 dark:bg-neutral-800">
              <button
                type="button"
                onClick={() => setLocalGuideOpen((v) => !v)}
                className="flex w-full items-center justify-between px-4 py-2.5 text-left"
              >
                <span className="flex items-center gap-2 font-medium text-neutral-800 text-sm dark:text-neutral-200">
                  <Server className="size-4 text-neutral-500 dark:text-neutral-400" />
                  本地部署指引（Ollama）
                </span>
                <ChevronDown
                  className={`size-4 text-neutral-400 transition-transform ${localGuideOpen ? "rotate-180" : ""}`}
                />
              </button>
              {localGuideOpen && (
                <div className="space-y-2 border-neutral-200 border-t px-4 py-3 text-neutral-600 text-xs dark:border-neutral-700 dark:text-neutral-400">
                  <p>本地模型完全离线运行：数据不出本机、免 API Key、无调用费用，适合注重隐私或网络受限的场景。</p>
                  <ol className="list-decimal space-y-1.5 pl-4">
                    <li>
                      安装 Ollama：
                      <button
                        type="button"
                        className="mx-1 cursor-pointer text-blue-600 underline underline-offset-2 hover:text-blue-500 dark:text-blue-400"
                        onClick={() => openUrl("https://ollama.com").catch(() => {})}
                      >
                        ollama.com
                      </button>
                      下载安装包（Windows/macOS/Linux 均支持）
                    </li>
                    <li>
                      终端执行 <code className="rounded bg-muted px-1 py-0.5 font-mono">ollama pull bge-m3</code>
                      下载嵌入模型（约 1.2GB，中英双语效果好）
                    </li>
                    <li>保持 Ollama 在后台运行（安装后默认随系统启动）</li>
                    <li>点击上方「快速接入 → Ollama」预设自动填好配置，保存后点「测试」验证</li>
                  </ol>
                  <p>
                    进阶：也可用 Xinference / llama.cpp server / TEI 等提供 OpenAI 兼容的 /v1/embeddings
                    端点，选「自定义端点」预设填写即可。
                  </p>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
