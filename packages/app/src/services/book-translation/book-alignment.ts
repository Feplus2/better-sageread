/**
 * 书籍译本对齐服务（T2 句级 + T3 词级，docs/book-translation-plan.md 批次 3）。
 *
 * 与论文侧 paper-alignment-service 同构，但两级相位**拆开独立触发**（08-29 用户裁定，
 * 书籍篇幅大、词级嵌入贵，成本须可见可控行）：
 * - mode="sentence"：句级相位。force=全量重算并**作废全部词级缓存**（词对区间以句对为
 *   计算域，句对变了词对必错——幂等键感知不到，须显式作废）；非 force=幂等补齐
 *   （翻译一条龙用此档，不动词级）。
 * - mode="words"：先句级幂等补齐（缓存命中的段跳过、缺失的补算，绝不 force），
 *   再词级相位（force=全量重算 / 非 force=幂等补齐）。依赖方向单向：词依赖句、
 *   词重建不碰句缓存。
 *
 * 句级：段源文本与译文各自 segmentSentences 切句 → 全书句子汇总分批 embed → 余弦矩阵
 * → 单调 DP（alignSentenceDP）→ 句对换算字符偏移写回 blocks[i].align/alignHash。
 * 词级：遍历句级表产生的每个句对，句对内分词（源 tokenizeWords / 译 jieba 批量）→
 * token 汇总分片 embed（条数+字符双上限，单片失败仅牵连其覆盖的段）→ 句对内 DP
 * （alignWordDP）→ 词对换算偏移写回 alignW/alignWHash（幂等键=译文 hash#分词器版本）。
 *
 * 幂等键与论文侧一致：(段源文本 hash, 译文 hash)。源已变的段不对齐（译文陈旧）。
 * 降级：无嵌入能力 → 涉及章 alignStatus/alignWStatus="skipped"；embed 失败 → "partial"。
 * 均不抛错（翻译本体不受影响）。
 */

import {
  type PaperAlignPair,
  alignSentenceDP,
  alignWordDP,
  tokenizeWords,
} from "@/pages/paper-reader/paper-cross-anchor";
import { segmentSentences } from "@/pages/paper-reader/paper-sentences";
import {
  ALIGN_LOW_CONFIDENCE,
  ALIGN_W_LOW_CONFIDENCE,
  EMBED_BATCH_SIZE,
  EMBED_W_BATCH_CHARS,
  EMBED_W_BATCH_SIZE,
  clipSentence,
  cosineMatrix,
  embedBatchAdaptive,
  wordCacheKey,
} from "@/services/paper-alignment-service";
import { hashBlockText } from "@/services/paper-translation-service";
import { tokenizeZhBatch } from "@/services/zh-tokenizer";
import { useLlamaStore } from "@/store/llama-store";
import { type VectorModelConfig, getCurrentVectorModelConfig } from "@/utils/model";
import {
  type BookTranslationBlock,
  type BookTranslationSectionFile,
  collectBookSections,
  listBookTranslationSectionIndexes,
  loadBookTranslationSection,
  openBookDocument,
  saveBookTranslationSection,
} from "./book-translation-service";

export interface BookAlignProgress {
  done: number;
  total: number;
  phase: "sentence" | "words";
}

/** 单相位（句级/词级）对齐统计（口径与论文侧 AlignPhaseStats 一致） */
export interface BookAlignPhaseStats {
  status: "done" | "skipped" | "partial";
  total: number;
  reused: number;
  computed: number;
  failed: number;
}

export interface BookAlignResult {
  status: "done" | "skipped" | "partial";
  /** 可对齐段总数（有译文且源文本未变） */
  total: number;
  /** 句级缓存有效跳过重算的段数 */
  reused: number;
  /** 句级本次新计算的段数 */
  computed: number;
  /** 句级计算失败的段数 */
  failed: number;
  reason?: "no-translation" | "no-vector-capability" | "embed-failed";
  /** 词级相位统计（mode="sentence" 时无词级活动，恒 skipped 空表） */
  words: BookAlignPhaseStats;
}

/** 译本对齐覆盖汇总（翻译下拉"句 n/m · 词 n/m 已对齐"状态行）；无译本返回 null。
 *  口径与幂等键一致：align/alignW 存在且键与当前译文 hash 相符（词级分母同 total——
 *  句对齐缺失的段天然无词级） */
export async function summarizeBookAlignment(
  bookId: string,
): Promise<{ aligned: number; alignedW: number; total: number } | null> {
  const indexes = await listBookTranslationSectionIndexes(bookId);
  if (indexes.length === 0) return null;
  let aligned = 0;
  let alignedW = 0;
  let total = 0;
  for (const index of indexes) {
    const file = await loadBookTranslationSection(bookId, index);
    if (!file) continue;
    for (const entry of Object.values(file.blocks)) {
      if (!entry?.text?.trim()) continue;
      total += 1;
      const tgtHash = await hashBlockText(entry.text);
      if (entry.align && entry.alignHash === tgtHash) aligned += 1;
      if (entry.alignW && entry.alignWHash === wordCacheKey(tgtHash)) alignedW += 1;
    }
  }
  return { aligned, alignedW, total };
}

interface AlignJob {
  spineIndex: number;
  index: number;
  entry: BookTranslationBlock;
  file: BookTranslationSectionFile;
  tgtHash: string;
  sourceText: string;
}

const emptyWords = (status: BookAlignPhaseStats["status"]): BookAlignPhaseStats => ({
  status,
  total: 0,
  reused: 0,
  computed: 0,
  failed: 0,
});

export async function alignBookTranslation(options: {
  bookId: string;
  /** sentence=仅句级相位（force 时作废词级）；words=句级补齐+词级相位。默认 sentence */
  mode?: "sentence" | "words";
  force?: boolean;
  signal?: AbortSignal;
  onProgress?: (progress: BookAlignProgress) => void;
}): Promise<BookAlignResult> {
  const { bookId, mode = "sentence", force = false, signal, onProgress } = options;

  const { bookDoc } = await openBookDocument(bookId);
  const sectionTexts = await collectBookSections(bookDoc);

  // 收集全部可对齐段（源 hash 一致的译文才有效）——句级待算与词级待算都从这里筛
  const alignable: AlignJob[] = [];
  const filesBySpine = new Map<number, BookTranslationSectionFile>();
  const translatedIndexes = new Set(await listBookTranslationSectionIndexes(bookId));
  for (const { spineIndex, sourceTexts } of sectionTexts) {
    if (!translatedIndexes.has(spineIndex)) continue;
    let file = filesBySpine.get(spineIndex);
    if (!file) {
      file = (await loadBookTranslationSection(bookId, spineIndex)) ?? undefined;
      if (!file) continue;
      filesBySpine.set(spineIndex, file);
    }
    for (const [i, text] of sourceTexts.entries()) {
      const entry = file.blocks[String(i)];
      if (!entry?.text?.trim()) continue;
      if (entry.hash !== (await hashBlockText(text))) continue; // 源已变，译文陈旧不对齐
      alignable.push({ spineIndex, index: i, entry, file, tgtHash: await hashBlockText(entry.text), sourceText: text });
    }
  }
  const total = alignable.length;
  if (total === 0) {
    return { status: "done", total: 0, reused: 0, computed: 0, failed: 0, words: emptyWords("done") };
  }

  const hasValidAlign = (job: AlignJob) => Boolean(job.entry.align && job.entry.alignHash === job.tgtHash);
  const hasValidAlignW = (job: AlignJob) =>
    Boolean(job.entry.alignW && job.entry.alignWHash === wordCacheKey(job.tgtHash));

  // 按章分组落盘（blocks 内的 entry 引用即最新计算结果）
  const saveAll = async (
    sentenceStatus: BookAlignPhaseStats["status"],
    wordsStatus?: BookAlignPhaseStats["status"],
  ) => {
    for (const [spineIndex, file] of filesBySpine) {
      file.alignStatus = sentenceStatus;
      if (wordsStatus) file.alignWStatus = wordsStatus;
      await saveBookTranslationSection(bookId, spineIndex, file).catch(() => {});
    }
  };

  // 句级实际待算集合：mode=sentence 且 force=全量；mode=words 恒幂等补齐（词重建不碰句缓存）
  const sentPendingNow = () =>
    mode === "sentence" && force ? alignable : alignable.filter((job) => !hasValidAlign(job));

  // 无嵌入能力：两相位一并跳过（翻译本体不受影响），状态落章文件
  const wordPending = () => alignable.filter((job) => hasValidAlign(job) && (force || !hasValidAlignW(job)));
  const needEmbed = () => sentPendingNow().length > 0 || (mode === "words" && wordPending().length > 0);
  if (needEmbed() && !useLlamaStore.getState().hasVectorCapability()) {
    const sentSkippedCount = sentPendingNow().length;
    const skipped: BookAlignPhaseStats = {
      status: "skipped",
      total: mode === "words" ? wordPending().length : 0,
      reused: 0,
      computed: 0,
      failed: 0,
    };
    await saveAll("skipped", mode === "words" ? "skipped" : undefined);
    return {
      status: "skipped",
      total,
      reused: total - sentSkippedCount,
      computed: 0,
      failed: sentSkippedCount,
      reason: "no-vector-capability",
      words: skipped,
    };
  }
  const embedLimit = { limit: EMBED_BATCH_SIZE };
  let config: VectorModelConfig | null = null;
  if (needEmbed()) {
    await useLlamaStore.getState().initializeEmbeddingService();
    config = await getCurrentVectorModelConfig();
  }

  // ── 句级相位：mode=sentence 时按 force；mode=words 时恒幂等补齐（不 force，词重建不碰句） ──
  const sentenceForce = mode === "sentence" && force;
  // sentence force 重建：先作废全部词级缓存（词对区间以句对为计算域，句对重算则词对必错）
  if (sentenceForce) {
    for (const job of alignable) {
      delete job.entry.alignW;
      delete job.entry.alignWHash;
    }
  }
  const sentPending = sentPendingNow();
  const reused = total - sentPending.length;
  let computed = 0;
  let failed = 0;

  if (sentPending.length > 0 && config) {
    // 切句 → 全书句子汇总分批 embed（一次或少量 HTTP 调用）
    const segmented = sentPending.map((job) => ({
      job,
      srcSpans: segmentSentences(job.sourceText),
      tgtSpans: segmentSentences(job.entry.text),
    }));
    const texts: string[] = [];
    for (const { job, srcSpans, tgtSpans } of segmented) {
      for (const span of srcSpans) texts.push(clipSentence(job.sourceText.slice(span.start, span.end)));
      for (const span of tgtSpans) texts.push(clipSentence(job.entry.text.slice(span.start, span.end)));
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
      console.warn("书籍句对齐 embed 调用失败:", error);
      await saveAll("partial", sentenceForce ? "partial" : undefined);
      return {
        status: "partial",
        total,
        reused,
        computed: 0,
        failed: sentPending.length,
        reason: "embed-failed",
        words: emptyWords(sentenceForce ? "partial" : "skipped"),
      };
    }

    // 逐段：相似度矩阵 → 单调 DP → 句对换算字符偏移（与论文侧同款换算与兜底）
    let cursor = 0;
    for (const { job, srcSpans, tgtSpans } of segmented) {
      const n = srcSpans.length;
      const m = tgtSpans.length;
      const srcVecs = vectors.slice(cursor, cursor + n);
      const tgtVecs = vectors.slice(cursor + n, cursor + n + m);
      cursor += n + m;
      try {
        // 任一侧无句子：对齐为空表（缓存键照写，避免每次重试）
        let pairs: PaperAlignPair[] =
          n === 0 || m === 0
            ? []
            : alignSentenceDP(cosineMatrix(srcVecs, tgtVecs)).map((pair) => ({
                ss: srcSpans[pair.si].start,
                se: srcSpans[pair.si + pair.srcCount - 1].end,
                ts: tgtSpans[pair.ti].start,
                te: tgtSpans[pair.ti + pair.tgtCount - 1].end,
                ...(pair.score < ALIGN_LOW_CONFIDENCE ? { low: true } : {}),
              }));
        // DP 无解兜底：退化为整段单对（标 low），保住段级映射而不是零对齐
        if (pairs.length === 0 && n > 0 && m > 0) {
          pairs = [
            {
              ss: srcSpans[0].start,
              se: srcSpans[n - 1].end,
              ts: tgtSpans[0].start,
              te: tgtSpans[m - 1].end,
              low: true,
            },
          ];
        }
        job.entry.align = pairs;
        job.entry.alignHash = job.tgtHash;
        computed += 1;
      } catch (error) {
        console.warn(`书籍句对齐段 ${job.spineIndex}:${job.index} 计算失败:`, error);
        failed += 1;
      }
      onProgress?.({ done: reused + computed + failed, total, phase: "sentence" });
    }
  }

  // ── 词级相位（mode=words）：句级缓存有效的段，句对内分词 → 分片 embed → 句对内 DP ──
  let wReused = 0;
  let wComputed = 0;
  let wFailed = 0;
  let wordsTotal = 0;
  if (mode === "words") {
    const wordJobs = wordPending();
    wReused = alignable.filter((job) => hasValidAlign(job)).length - wordJobs.length;
    wordsTotal = wReused + wordJobs.length;
    if (wordJobs.length > 0 && config) {
      // 句对内分词（偏移加句对基址换算回段坐标系），全部待算段的 token 汇总统一分片 embed。
      // 中文侧走 jieba 批量分词（一次 IPC；不可用时 zh-tokenizer 内部回退单字，不中断对齐）
      const tgtTexts: string[] = [];
      for (const job of wordJobs) {
        for (const pair of job.entry.align ?? []) tgtTexts.push(job.entry.text.slice(pair.ts, pair.te));
      }
      const tgtTokenLists = await tokenizeZhBatch(tgtTexts);
      let tgtCursor = 0;
      const tokenized = wordJobs.map((job) => ({
        job,
        vecStart: 0,
        pairs: (job.entry.align ?? []).flatMap((pair) => {
          const src = tokenizeWords(job.sourceText.slice(pair.ss, pair.se)).map((t) => ({
            start: t.start + pair.ss,
            end: t.end + pair.ss,
          }));
          const tgt = (tgtTokenLists[tgtCursor++] ?? []).map((t) => ({
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

      // 分片 embed（条数 + 字符双上限）；单片失败仅牵连该片覆盖的段（标 partial，不影响整体）
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
          console.warn(`书籍词对齐 embed 分片 [${shardStart}, ${shardEnd}) 失败:`, error);
          for (let i = shardStart; i < shardEnd; i++) tainted.add(flatOwner[i]);
        }
        shardStart = shardEnd;
      }

      // 逐段：句对内 余弦矩阵 → 单调 DP → 词对换算字符偏移写回
      for (const [owner, entry] of tokenized.entries()) {
        if (tainted.has(owner)) {
          wFailed += 1;
          continue;
        }
        try {
          let cursor = entry.vecStart;
          const wordPairs: PaperAlignPair[] = [];
          for (const { src, tgt } of entry.pairs) {
            // 未被污染的段其 token 向量必然齐备（污染以片为单位、段按片整体跳过）
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
          entry.job.entry.alignWHash = wordCacheKey(entry.job.tgtHash);
          wComputed += 1;
        } catch (error) {
          console.warn(`书籍词对齐段 ${entry.job.spineIndex}:${entry.job.index} 计算失败:`, error);
          wFailed += 1;
        }
        onProgress?.({ done: wReused + wComputed + wFailed, total: wReused + wordJobs.length, phase: "words" });
      }
    }
  }

  const sentenceStatus: BookAlignPhaseStats["status"] = failed > 0 ? "partial" : "done";
  const wordsStatus: BookAlignPhaseStats["status"] = mode !== "words" ? "skipped" : wFailed > 0 ? "partial" : "done";
  await saveAll(sentenceStatus, mode === "words" ? wordsStatus : undefined);
  return {
    status: failed > 0 ? "partial" : "done",
    total,
    reused,
    computed,
    failed,
    words: {
      status: wordsStatus,
      total: wordsTotal,
      reused: wReused,
      computed: wComputed,
      failed: wFailed,
    },
  };
}
