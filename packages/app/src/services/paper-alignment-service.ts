/**
 * 论文对齐服务（T2 句级 + T3 词级）：翻译完成后对有译文的块计算 源文 ↔ 译文 对齐表，
 * 结果写回译本 JSON（blocks[idx].align / alignHash / alignW / alignWHash，
 * 顶层 alignStatus / alignWStatus）。
 *
 * 句级流程：块源文本与译文各自 segmentSentences 切句 → 句子批量 embed（OpenAI 格式，
 * Ollama /api/embed 按 URL 结尾自动切换，思路同 Rust 侧 vectorizer.rs）→ 余弦相似度
 * 矩阵 → 单调 DP 对齐（paper-cross-anchor.ts）→ 句对换算为字符偏移落库。
 *
 * 词级流程（句级之后的第二相位，同一"翻译 → 句对齐 → 词对齐"一条龙）：在每个句对内部
 * 分词（英文按词、中文按单字）→ 全部待算块的句对 token 汇总分片批量 embed（条数/字符
 * 双上限；单片失败仅牵连该片覆盖的块）→ 句对内余弦矩阵 + 单调 DP（(1,1)/(1,k)/(k,1)，
 * k≤4）→ 词对换算字符偏移落库。词级失败不影响句级（alignWStatus 独立标记）。
 *
 * 幂等：缓存键 = (块源文本 hash, 译文 text hash)——块 entry.hash 与当前源文本 hash
 * 一致（源未变）且 entry.alignHash / alignWHash 与当前译文 hash 一致（译文未变）的块
 * 跳过重算；任一变化（重翻/改源）则该块重算。force=true 全部重算（句词两级同时重建）。
 *
 * 降级：无嵌入能力（hasVectorCapability=false）时跳过对齐并写 alignStatus="skipped"，
 * 翻译本体不受影响；embed 调用失败写 "partial"。
 */

import { cutPaperBlocks } from "@/pages/paper-reader/paper-blocks";
import {
  type PaperAlignPair,
  alignSentenceDP,
  alignWordDP,
  tokenizeWords,
} from "@/pages/paper-reader/paper-cross-anchor";
import { segmentSentences } from "@/pages/paper-reader/paper-sentences";
import { useLlamaStore } from "@/store/llama-store";
import { type VectorModelConfig, getCurrentVectorModelConfig } from "@/utils/model";
import {
  type PaperTranslationBlock,
  type PaperTranslationFile,
  hashBlockText,
  loadPaperTranslation,
  savePaperTranslation,
} from "./paper-translation-service";

/** 句对平均相似度低于该阈值标 low: true（UI 可降级） */
export const ALIGN_LOW_CONFIDENCE = 0.5;
/** 词对平均相似度低于该阈值标 low: true（词/字向量噪声大于句向量，阈值略低于句级） */
export const ALIGN_W_LOW_CONFIDENCE = 0.45;
/** 单次 embed HTTP 调用的最大句数（一次或少量调用，避免逐句请求） */
const EMBED_BATCH_SIZE = 64;
/** 嵌入前截断的句长上限（字符）：嵌入模型上下文有限（jina/bge 约 512 token），长句截断保底 */
const EMBED_MAX_CHARS = 1200;
/** 词级 embed 分片上限：单批最大 token 条数 / 单批最大总字符（token 短，双上限防超大请求）。
 *  条数取 64：智谱等供应商硬性限制单请求 ≤64 条（超限 HTTP 400），256 会导致整片失败 */
const EMBED_W_BATCH_SIZE = 64;
const EMBED_W_BATCH_CHARS = 6000;

export interface AlignProgress {
  /** 已处理（含复用/失败）的块数 */
  done: number;
  /** 需对齐的块总数（有译文且源文本未变） */
  total: number;
}

/** 单相位（句级/词级）对齐统计 */
export interface AlignPhaseStats {
  /** done=全部就绪（含复用）；partial=部分失败；skipped=未执行（无嵌入能力/上游失败） */
  status: "done" | "skipped" | "partial";
  /** 该相位可处理的块总数 */
  total: number;
  /** 缓存有效跳过重算的块数 */
  reused: number;
  /** 本次新计算的块数 */
  computed: number;
  /** 计算失败的块数 */
  failed: number;
}

export interface AlignResult {
  status: "done" | "skipped" | "partial";
  /** 需对齐的块总数（有译文且源文本 hash 未变） */
  total: number;
  /** 缓存有效跳过重算的块数 */
  reused: number;
  /** 本次新计算的块数 */
  computed: number;
  /** 计算失败的块数（embed 全局失败时 = 待算块数） */
  failed: number;
  /** status=skipped/partial 的原因（供提示文案） */
  reason?: "no-translation" | "no-vector-capability" | "embed-failed";
  /** T3 词级相位统计 */
  words: AlignPhaseStats;
}

/** 译本对齐覆盖情况（翻译下拉"句词对齐"状态行依据） */
export interface PaperAlignmentInfo {
  /** 有译文且源文本未变的块数 */
  total: number;
  /** 句对齐缓存有效的块数 */
  aligned: number;
  /** T3 词对齐缓存有效的块数（分母同 total；句对齐缺失的块天然无词级） */
  alignedW: number;
}

const clipSentence = (text: string) => (text.length > EMBED_MAX_CHARS ? text.slice(0, EMBED_MAX_CHARS) : text);

/** 批量 embed：OpenAI 格式（input 数组）；URL 以 /api/embed 结尾按 Ollama 协议（响应 embeddings 数组） */
async function embedBatch(texts: string[], config: VectorModelConfig, signal?: AbortSignal): Promise<number[][]> {
  const isOllama = config.embeddingsUrl.endsWith("/api/embed");
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
  const body = isOllama
    ? { model: config.model, input: texts }
    : { input: texts, model: config.model, encoding_format: "float" };
  const res = await fetch(config.embeddingsUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: signal ?? null,
  });
  if (!res.ok) throw new Error(`嵌入服务 HTTP ${res.status}`);
  const json = (await res.json()) as {
    data?: { embedding?: number[]; index?: number }[];
    embeddings?: number[][];
  };
  if (isOllama) {
    if (!Array.isArray(json.embeddings) || json.embeddings.length !== texts.length) {
      throw new Error("Ollama 嵌入响应格式异常");
    }
    return json.embeddings;
  }
  if (!Array.isArray(json.data) || json.data.length !== texts.length) {
    throw new Error("嵌入响应格式异常");
  }
  // OpenAI 协议不保证 data 顺序，按 index 归位
  return [...json.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).map((item) => item.embedding ?? []);
}

/**
 * 自适应批量 embed：各家供应商 input 数组上限差异巨大（OpenAI 2048 / Voyage 128 / Cohere 96 /
 * 智谱 64 / DashScope 10），无法预设安全值——遇批量类错误（HTTP 400/413/422）即减半重试，
 * 并把收敛后的上限记入 state.limit（本次运行内后续分片直接使用，不再试错）。
 * 非批量类错误（401/500 等）直接上抛，走既有分片失败降级。
 */
async function embedBatchAdaptive(
  texts: string[],
  config: VectorModelConfig,
  state: { limit: number },
  signal?: AbortSignal,
): Promise<number[][]> {
  if (texts.length <= state.limit) {
    try {
      return await embedBatch(texts, config, signal);
    } catch (error) {
      const msg = error instanceof Error ? error.message : "";
      if (!/HTTP (400|413|422)/.test(msg) || texts.length <= 1) throw error;
      state.limit = Math.max(1, Math.floor(Math.min(state.limit, texts.length) / 2));
      console.warn(`嵌入批量超限，上限收敛为 ${state.limit} 条后重试`);
    }
  }
  const mid = Math.ceil(texts.length / 2);
  const first = await embedBatchAdaptive(texts.slice(0, mid), config, state, signal);
  const second = await embedBatchAdaptive(texts.slice(mid), config, state, signal);
  return [...first, ...second];
}

/** 余弦相似度矩阵（行=源句，列=译文句） */
function cosineMatrix(srcVecs: number[][], tgtVecs: number[][]): number[][] {
  const norm = (v: number[]) => Math.sqrt(v.reduce((sum, x) => sum + x * x, 0)) || 1;
  const srcNorms = srcVecs.map(norm);
  const tgtNorms = tgtVecs.map(norm);
  return srcVecs.map((sv, i) =>
    tgtVecs.map((tv, j) => {
      let dot = 0;
      const len = Math.min(sv.length, tv.length);
      for (let k = 0; k < len; k++) dot += sv[k] * tv[k];
      return dot / (srcNorms[i] * tgtNorms[j]);
    }),
  );
}

interface AlignJob {
  index: number;
  entry: PaperTranslationBlock;
  tgtHash: string;
  sourceText: string;
}

/** 枚举需对齐的块：有译文、且译文 hash 与当前块源文本一致（源未变的译文才有效） */
async function collectAlignableBlocks(markdown: string, file: PaperTranslationFile): Promise<AlignJob[]> {
  const jobs: AlignJob[] = [];
  for (const block of cutPaperBlocks(markdown)) {
    if (!block.translatable) continue;
    const entry = file.blocks[String(block.index)];
    if (!entry?.text?.trim()) continue;
    if (entry.hash !== (await hashBlockText(block.sourceText))) continue; // 源文本已变，译文陈旧
    jobs.push({ index: block.index, entry, tgtHash: "", sourceText: block.sourceText });
  }
  return jobs;
}

/**
 * 计算（或复用）句级 + 词级对齐并写回译本（同一一条龙：句级相位之后接词级相位）。
 * force=false 时缓存有效（源 hash + 译文 hash 均未变）的块跳过重算；force=true 两级全部重算。
 * 无嵌入能力时跳过（alignStatus/alignWStatus="skipped"），不抛错——翻译本体不受影响。
 * 词级相位失败不影响句级结果（failed 计入 words.failed，alignWStatus="partial"）。
 */
export async function alignPaperTranslation(options: {
  paperId: string;
  markdown: string;
  force?: boolean;
  signal?: AbortSignal;
  onProgress?: (progress: AlignProgress) => void;
}): Promise<AlignResult> {
  const { paperId, markdown, force = false, signal, onProgress } = options;

  const emptyWords = (status: AlignPhaseStats["status"]): AlignPhaseStats => ({
    status,
    total: 0,
    reused: 0,
    computed: 0,
    failed: 0,
  });

  const file = await loadPaperTranslation(paperId);
  if (!file) {
    return {
      status: "skipped",
      total: 0,
      reused: 0,
      computed: 0,
      failed: 0,
      reason: "no-translation",
      words: emptyWords("skipped"),
    };
  }

  const jobs = await collectAlignableBlocks(markdown, file);
  const total = jobs.length;
  for (const job of jobs) job.tgtHash = await hashBlockText(job.entry.text);

  const hasValidAlign = (job: AlignJob) => Boolean(job.entry.align && job.entry.alignHash === job.tgtHash);
  const hasValidAlignW = (job: AlignJob) => Boolean(job.entry.alignW && job.entry.alignWHash === job.tgtHash);
  const sentPending = jobs.filter((job) => force || !hasValidAlign(job));
  const reused = total - sentPending.length;
  /** 词级可处理的块（句对齐缓存有效）；词级待算 = 其中词级缓存无效者（句级新算的块相位后自然并入） */
  const wordPending = () => jobs.filter((job) => hasValidAlign(job) && (force || !hasValidAlignW(job)));
  const needEmbed = () => sentPending.length > 0 || wordPending().length > 0;

  // 无嵌入能力：两相位一并跳过（翻译本体不受影响），明确状态供 UI 提示
  if (needEmbed() && !useLlamaStore.getState().hasVectorCapability()) {
    if (sentPending.length > 0) file.alignStatus = "skipped";
    if (wordPending().length > 0) file.alignWStatus = "skipped";
    await savePaperTranslation(paperId, file);
    return {
      status: sentPending.length > 0 ? "skipped" : "done",
      total,
      reused,
      computed: 0,
      failed: sentPending.length,
      reason: "no-vector-capability",
      words: { status: "skipped", total: wordPending().length, reused: 0, computed: 0, failed: 0 },
    };
  }
  let config: VectorModelConfig | null = null;
  if (needEmbed()) {
    // 本地嵌入服务按需自启（远程模型/已有会话时 no-op，与向量化入口同一语义）
    await useLlamaStore.getState().initializeEmbeddingService();
    config = await getCurrentVectorModelConfig();
  }

  // ── T2 句级相位：切句 → 汇总批量 embed（一次或少量 HTTP 调用）→ 余弦矩阵 → 单调 DP ──
  // embedLimit：批量上限的运行期状态（遇供应商限流自动收敛，句词两相位共享）
  const embedLimit = { limit: EMBED_BATCH_SIZE };
  let computed = 0;
  let failed = 0;
  if (sentPending.length > 0 && config) {
    const segmented = sentPending.map((job) => ({
      ...job,
      srcSpans: segmentSentences(job.sourceText),
      tgtSpans: segmentSentences(job.entry.text),
    }));
    const texts: string[] = [];
    for (const job of segmented) {
      for (const span of job.srcSpans) texts.push(clipSentence(job.sourceText.slice(span.start, span.end)));
      for (const span of job.tgtSpans) texts.push(clipSentence(job.entry.text.slice(span.start, span.end)));
    }

    let vectors: number[][];
    try {
      vectors = [];
      for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
        if (signal?.aborted) throw new DOMException("已取消", "AbortError");
        vectors.push(...(await embedBatchAdaptive(texts.slice(i, i + EMBED_BATCH_SIZE), config, embedLimit, signal)));
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      console.warn("论文句对齐 embed 调用失败:", error);
      // 句级 embed 失败则词级无从算起（同一嵌入服务），直接收尾
      file.alignStatus = "partial";
      file.alignWStatus = "partial";
      await savePaperTranslation(paperId, file);
      return {
        status: "partial",
        total,
        reused,
        computed: 0,
        failed: sentPending.length,
        reason: "embed-failed",
        words: emptyWords("partial"),
      };
    }

    // 逐块：相似度矩阵 → 单调 DP → 句对换算字符偏移
    let cursor = 0;
    for (const job of segmented) {
      const n = job.srcSpans.length;
      const m = job.tgtSpans.length;
      const srcVecs = vectors.slice(cursor, cursor + n);
      const tgtVecs = vectors.slice(cursor + n, cursor + n + m);
      cursor += n + m;
      try {
        // 任一侧无句子：对齐为空表（缓存键照写，避免每次重试）
        let pairs: PaperAlignPair[] =
          n === 0 || m === 0
            ? []
            : alignSentenceDP(cosineMatrix(srcVecs, tgtVecs)).map((pair) => ({
                ss: job.srcSpans[pair.si].start,
                se: job.srcSpans[pair.si + pair.srcCount - 1].end,
                ts: job.tgtSpans[pair.ti].start,
                te: job.tgtSpans[pair.ti + pair.tgtCount - 1].end,
                ...(pair.score < ALIGN_LOW_CONFIDENCE ? { low: true } : {}),
              }));
        // DP 无解兜底：两侧句数比超 maxGroup 时 DP 返回空表（结构无解，重算亦然）——
        // 退化为整块单对（标 low），保住块级 hover/标亮映射，而不是整块零对齐
        if (pairs.length === 0 && n > 0 && m > 0) {
          pairs = [
            {
              ss: job.srcSpans[0].start,
              se: job.srcSpans[n - 1].end,
              ts: job.tgtSpans[0].start,
              te: job.tgtSpans[m - 1].end,
              low: true,
            },
          ];
        }
        job.entry.align = pairs;
        job.entry.alignHash = job.tgtHash;
        computed += 1;
      } catch (error) {
        console.warn(`论文句对齐块 ${job.index} 计算失败:`, error);
        failed += 1;
      }
      onProgress?.({ done: reused + computed + failed, total });
    }
  }

  // ── T3 词级相位：句对齐有效但词级缓存无效的块（失败降级：不影响已完成的句级） ──
  const wordJobs = wordPending();
  const wReused = jobs.filter((job) => hasValidAlign(job)).length - wordJobs.length;
  let wComputed = 0;
  let wFailed = 0;
  if (wordJobs.length > 0 && config) {
    // 句对内分词（偏移加句对基址换算回块坐标系），全部待算块的 token 汇总统一分片 embed
    const tokenized = wordJobs.map((job) => ({
      job,
      vecStart: 0,
      pairs: (job.entry.align ?? []).flatMap((pair) => {
        const src = tokenizeWords(job.sourceText.slice(pair.ss, pair.se)).map((t) => ({
          start: t.start + pair.ss,
          end: t.end + pair.ss,
        }));
        const tgt = tokenizeWords(job.entry.text.slice(pair.ts, pair.te)).map((t) => ({
          start: t.start + pair.ts,
          end: t.end + pair.ts,
        }));
        // 任一侧无词可对（纯标点/公式句对）：该句对词级为空
        return src.length === 0 || tgt.length === 0 ? [] : [{ src, tgt }];
      }),
    }));
    const flatTexts: string[] = [];
    const flatOwner: number[] = [];
    tokenized.forEach((entry, owner) => {
      entry.vecStart = flatTexts.length;
      for (const { src, tgt } of entry.pairs) {
        for (const t of src) {
          flatTexts.push(entry.job.sourceText.slice(t.start, t.end));
          flatOwner.push(owner);
        }
        for (const t of tgt) {
          flatTexts.push(entry.job.entry.text.slice(t.start, t.end));
          flatOwner.push(owner);
        }
      }
    });

    // 分片 embed（条数 + 字符双上限）；单片失败仅牵连该片覆盖的块（标 partial，不影响整体）
    const vectors: (number[] | undefined)[] = Array.from({ length: flatTexts.length });
    const tainted = new Set<number>();
    let shardStart = 0;
    while (shardStart < flatTexts.length) {
      let shardEnd = shardStart;
      let chars = 0;
      while (
        shardEnd < flatTexts.length &&
        shardEnd - shardStart < EMBED_W_BATCH_SIZE &&
        chars + flatTexts[shardEnd].length <= EMBED_W_BATCH_CHARS
      ) {
        chars += flatTexts[shardEnd].length;
        shardEnd += 1;
      }
      if (shardEnd === shardStart) shardEnd += 1; // 兜底：单 token 超字符上限也自成一片（理论不存在）
      if (signal?.aborted) throw new DOMException("已取消", "AbortError");
      try {
        const vecs = await embedBatchAdaptive(flatTexts.slice(shardStart, shardEnd), config, embedLimit, signal);
        for (let i = shardStart; i < shardEnd; i++) vectors[i] = vecs[i - shardStart];
      } catch (error) {
        if (signal?.aborted) throw error;
        console.warn(`论文词对齐 embed 分片 [${shardStart}, ${shardEnd}) 失败:`, error);
        for (let i = shardStart; i < shardEnd; i++) tainted.add(flatOwner[i]);
      }
      shardStart = shardEnd;
    }

    // 逐块：句对内 余弦矩阵 → 单调 DP → 词对换算字符偏移写回
    for (const [owner, entry] of tokenized.entries()) {
      if (tainted.has(owner)) {
        wFailed += 1;
        continue;
      }
      try {
        let cursor = entry.vecStart;
        const wordPairs: PaperAlignPair[] = [];
        for (const { src, tgt } of entry.pairs) {
          // 未被污染的块其 token 向量必然齐备（污染以片为单位、块按片整体跳过）
          const srcVecs = vectors.slice(cursor, cursor + src.length) as number[][];
          const tgtVecs = vectors.slice(cursor + src.length, cursor + src.length + tgt.length) as number[][];
          cursor += src.length + tgt.length;
          for (const wp of alignWordDP(cosineMatrix(srcVecs, tgtVecs))) {
            wordPairs.push({
              ss: src[wp.si].start,
              se: src[wp.si + wp.srcCount - 1].end,
              ts: tgt[wp.ti].start,
              te: tgt[wp.ti + wp.tgtCount - 1].end,
              ...(wp.score < ALIGN_W_LOW_CONFIDENCE ? { low: true } : {}),
            });
          }
        }
        entry.job.entry.alignW = wordPairs;
        entry.job.entry.alignWHash = entry.job.tgtHash;
        wComputed += 1;
      } catch (error) {
        console.warn(`论文词对齐块 ${entry.job.index} 计算失败:`, error);
        wFailed += 1;
      }
    }
  }

  const words: AlignPhaseStats = {
    status: wFailed > 0 ? "partial" : "done",
    total: wReused + wordJobs.length,
    reused: wReused,
    computed: wComputed,
    failed: wFailed,
  };
  file.alignStatus = failed > 0 ? "partial" : "done";
  file.alignWStatus = words.status;
  await savePaperTranslation(paperId, file);
  return { status: failed > 0 ? "partial" : "done", total, reused, computed, failed, words };
}

/**
 * 译本对齐覆盖情况：total = 有译文且源文本未变的块数，aligned / alignedW = 句级 / 词级
 * 对齐缓存有效的块数。无译本返回 null；翻译下拉"句词对齐"状态行据此展示。
 */
export async function inspectPaperAlignment(
  markdown: string,
  file: PaperTranslationFile | null,
): Promise<PaperAlignmentInfo | null> {
  if (!file) return null;
  const jobs = await collectAlignableBlocks(markdown, file);
  let aligned = 0;
  let alignedW = 0;
  for (const job of jobs) {
    const tgtHash = await hashBlockText(job.entry.text);
    if (job.entry.align && job.entry.alignHash === tgtHash) aligned += 1;
    if (job.entry.alignW && job.entry.alignWHash === tgtHash) alignedW += 1;
  }
  return { total: jobs.length, aligned, alignedW };
}
