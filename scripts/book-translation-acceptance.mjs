export async function validateBookTranslationSection(file, hashText) {
  if (!file) throw new Error("缺少章译本，不能进入双向 hover 验收");
  const blocks = Object.values(file.blocks ?? {});
  const translated = blocks.filter((block) => /[\u4e00-\u9fff]/.test(block?.text ?? ""));
  if (translated.length === 0) throw new Error("缺少可读中文译文，不能进入双向 hover 验收");
  if (file.alignStatus !== "done") {
    throw new Error(`句对齐未完成：alignStatus=${file.alignStatus ?? "missing"}，不能用翻译成功冒充双向联动`);
  }
  for (const block of translated) {
    if (!Array.isArray(block.align) || block.align.length === 0) {
      throw new Error("存在译文块缺少句对齐，不能用翻译成功冒充双向联动");
    }
    if (block.alignHash !== (await hashText(block.text))) {
      throw new Error("句对齐对应的译文已经变化，必须重新对齐后再验收");
    }
    for (const pair of block.align) {
      if (
        ![pair.ss, pair.se, pair.ts, pair.te].every(Number.isFinite) ||
        pair.ss < 0 ||
        pair.ts < 0 ||
        pair.ss >= pair.se ||
        pair.ts >= pair.te
      ) {
        throw new Error("句对齐包含无效字符区间");
      }
    }
  }
  return {
    totalBlocks: blocks.length,
    translatedBlocks: translated.length,
    alignedBlocks: translated.length,
    firstPair: translated[0].align[0],
  };
}
