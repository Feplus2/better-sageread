import { useConverterStore } from "@/store/converter-store";
import { useLlamaStore } from "@/store/llama-store";
import { useProviderStore } from "@/store/provider-store";
import { useSciverseStore } from "@/store/sciverse-store";
import { useTTSStore } from "@/store/tts-store";
import { useWebSearchStore } from "@/store/web-search-store";
import { secretGetForRuntime, secretSet } from "./secret-service";

/**
 * 密钥启动初始化（批次 A）：
 * 1. localStorage 两类 key（网络搜索 `web-search-engine`、TTS `tts-config-storage`）迁入 keyring
 *    （读 → secretSet → 字段置空写回；幂等，字段已空即跳过）。
 *    各 JSON 文件（model-provider/llama-store/converter-store/webdav-config/mcp-servers）
 *    由 Rust 侧迁移器在应用启动时处理，此处只负责 localStorage。
 * 2. 从 keyring 把 key 载入内存 store（仅内存，供前端发请求；不写盘、不进日志）。
 *
 * 注：各 store 的 partialize 已置空 key 字段，内存中的 key 不会被再次落盘。
 */
export async function initSecrets(): Promise<void> {
  await migrateLocalStorageSecrets();
  await loadKeyringIntoMemory();
}

// ---- 第 1 步：localStorage 存量迁移 ----

const WEB_SEARCH_STORAGE_KEY = "web-search-engine";
const TTS_STORAGE_KEY = "tts-config-storage";

/** web-search-store 字段 → keyring web-search:{provider} */
const WEB_SEARCH_FIELDS: Record<string, string> = {
  bochaKey: "bocha",
  zhipuKey: "zhipu",
  tavilyKey: "tavily",
  serperKey: "serper",
};

async function migrateLocalStorageSecrets(): Promise<void> {
  // 网络搜索
  try {
    const raw = localStorage.getItem(WEB_SEARCH_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      const state = parsed?.state;
      if (state && typeof state === "object") {
        let dirty = false;
        for (const [field, provider] of Object.entries(WEB_SEARCH_FIELDS)) {
          const value = typeof state[field] === "string" ? state[field] : "";
          if (value.trim()) {
            await secretSet("web-search", provider, value);
            state[field] = "";
            dirty = true;
          }
        }
        if (dirty) localStorage.setItem(WEB_SEARCH_STORAGE_KEY, JSON.stringify(parsed));
      }
    }
  } catch (error) {
    console.error("迁移网络搜索密钥失败:", error);
  }

  // TTS（DashScope）
  try {
    const raw = localStorage.getItem(TTS_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      const apiKey = typeof parsed?.state?.config?.apiKey === "string" ? parsed.state.config.apiKey : "";
      if (apiKey.trim()) {
        await secretSet("tts", "dashscope", apiKey);
        parsed.state.config.apiKey = "";
        localStorage.setItem(TTS_STORAGE_KEY, JSON.stringify(parsed));
      }
    }
  } catch (error) {
    console.error("迁移 TTS 密钥失败:", error);
  }
}

// ---- 第 2 步：keyring → 内存 store ----

/**
 * 等待 zustand persist 完成 hydrate（tauriStorage 为异步存储）。
 * 若在 hydrate 前写入内存，hydrate 完成时会用落盘值（key 已置空）覆盖，导致内存 key 丢失。
 */
async function whenHydrated(store: {
  persist: { hasHydrated: () => boolean; onFinishHydration: (cb: () => void) => () => void };
}): Promise<void> {
  if (store.persist.hasHydrated()) return;
  await new Promise<void>((resolve) => {
    const unsubscribe = store.persist.onFinishHydration(() => {
      unsubscribe();
      resolve();
    });
    // 双重保险：若注册时 hydrate 已悄悄完成，避免永久挂起
    if (store.persist.hasHydrated()) {
      unsubscribe();
      resolve();
    }
  });
}

/** keyring 读取（失败视为无值，不抛错打断启动） */
async function readSecret(category: string, key: string): Promise<string> {
  try {
    return await secretGetForRuntime(category, key);
  } catch {
    return "";
  }
}

async function loadKeyringIntoMemory(): Promise<void> {
  // 先等异步存储 hydrate 完成，再注入 keyring 中的 key（否则会被 hydrate 覆盖）
  await Promise.all([whenHydrated(useProviderStore), whenHydrated(useLlamaStore), whenHydrated(useConverterStore)]);

  // 模型提供商
  const providerStore = useProviderStore.getState();
  await Promise.all(
    providerStore.modelProviders.map(async (provider) => {
      const apiKey = await readSecret("model-provider", provider.provider);
      if (apiKey) useProviderStore.getState().updateProvider(provider.provider, { apiKey });
    }),
  );

  // 远程向量模型
  const llamaStore = useLlamaStore.getState();
  await Promise.all(
    llamaStore.vectorModels.map(async (model) => {
      const apiKey = await readSecret("vector-model", model.id);
      if (apiKey) useLlamaStore.getState().updateVectorModel(model.id, { apiKey });
    }),
  );

  // PDF 转换 Token
  const converterStore = useConverterStore.getState();
  const [mineru, paddleocr, glm] = await Promise.all([
    readSecret("converter", "mineru"),
    readSecret("converter", "paddleocr"),
    readSecret("converter", "glm"),
  ]);
  if (mineru) converterStore.setMineruToken(mineru);
  if (paddleocr) converterStore.setPaddleocrToken(paddleocr);
  if (glm) converterStore.setGlmApiKey(glm);

  // 网络搜索
  const webSearchStore = useWebSearchStore.getState();
  const [bocha, zhipu, tavily, serper] = await Promise.all([
    readSecret("web-search", "bocha"),
    readSecret("web-search", "zhipu"),
    readSecret("web-search", "tavily"),
    readSecret("web-search", "serper"),
  ]);
  if (bocha) webSearchStore.setBochaKey(bocha);
  if (zhipu) webSearchStore.setZhipuKey(zhipu);
  if (tavily) webSearchStore.setTavilyKey(tavily);
  if (serper) webSearchStore.setSerperKey(serper);

  // 科研搜索（Sciverse）
  const sciverseToken = await readSecret("sciverse", "token");
  if (sciverseToken) useSciverseStore.getState().setToken(sciverseToken);

  // TTS（DashScope）
  const ttsKey = await readSecret("tts", "dashscope");
  if (ttsKey) useTTSStore.getState().setApiKey(ttsKey);
}
