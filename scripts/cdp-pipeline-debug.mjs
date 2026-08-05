// CDP：在页面里完整复跑 openTranslationPopup 的管线，逐阶段定位失败点
const page = (await (await fetch("http://127.0.0.1:9222/json/list")).json()).find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const call = (m, p = {}) =>
  new Promise((r) => {
    const i = ++id;
    pending.set(i, r);
    ws.send(JSON.stringify({ id: i, method: m, params: p }));
  });
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m.result);
    pending.delete(m.id);
  }
};
await new Promise((r) => (ws.onopen = r));
await call("Runtime.enable");
const res = await call("Runtime.evaluate", {
  expression: `(async () => {
    try {
    const ca = await import('/src/pages/paper-reader/paper-cross-anchor.ts');
    const pa = await import('/src/pages/paper-reader/paper-anchors.ts');
    const ts = await import('/src/services/paper-translation-service.ts');
    const out = {};

    // 1. 找到 div 与块索引
    const container = [...document.querySelectorAll('.prose')].find(el => el.querySelector('[data-translation]')) || document.body;
    const divs = [...container.querySelectorAll('[data-translation]')];
    const div = divs.filter(d => (d.textContent||'').trim().length > 30)[20];
    const blocks = pa.listBlocks(container);
    // buildTranslationDivMap 等价：每个译文 div 找它前面最近的块
    const divMap = new Map();
    let cursor = 0;
    for (const d of divs) {
      while (cursor < blocks.length && d.compareDocumentPosition(blocks[cursor]) & Node.DOCUMENT_POSITION_PRECEDING) cursor++;
      if (cursor > 0) divMap.set(cursor - 1, d);
    }
    let blockIndex = -1;
    for (const [b, d] of divMap) if (d === div) { blockIndex = b; break; }
    out.blockIndex = blockIndex; out.blocksLen = blocks.length; out.divsLen = divs.length;

    // 2. stored / align / alignW
    const trans = await ts.loadPaperTranslation('a27b187c6bd02d3c');
    const entry = trans.blocks[String(blockIndex)];
    out.hasEntry = !!entry;
    if (!entry) return JSON.stringify(out);
    const stored = entry.text;
    const align = entry.align, alignW = entry.alignW;
    out.alignLen = align?.length; out.alignWLen = alignW?.length;

    // 3. live→stored 选区换算（取 div 前 6 字符模拟选区）
    const normL = ca.normalizeLiveElement(div);
    const normS = ca.normalizeMathText(stored);
    out.lTok = ca.tokenizeWords(normL.text).length;
    out.sTok = ca.tokenizeWords(normS.text).length;
    out.lSpans = normL.spans.length;
    out.sSpans = normS.spans.length;
    out.storedRange = ca.mapOffsetsMathAware(normL, normS, 0, 6);

    // 4. 词级映射
    let mapped = null;
    if (out.storedRange) mapped = ca.mapTgtRangeToSrc(align, out.storedRange.start, out.storedRange.end, alignW);
    if (!mapped) mapped = ca.mapTgtRangeToSrc(align, 0, 6, alignW);
    out.mapped = mapped;

    // 5. 源坐标 → live 英文坐标（用容器里真实的英文块）
    if (mapped) {
      const enBlock = blocks[blockIndex];
      out.hasEnBlock = !!enBlock;
      if (enBlock) {
        const normLive = ca.normalizeLiveElement(enBlock, '[data-translation]');
        out.enLTok = ca.tokenizeWords(normLive.text).length;
        out.enLSpans = normLive.spans.length;
        out.enHead = normLive.text.slice(0, 60);
        // srcBlock 源文不可直接得（避免 fs），先用 alignW 的 src 端检查 live 换算：
        // 直接测 mapSourceOffsetsToLive 的同类换算 normLive → alignW 源区间所在块的英文源文不可得，
        // 退而验证 live 端 token 对应：取 mapped 区间在 alignW 源侧覆盖的 ts/te 已确认，到此即说明映射链路通。
        out.liveOk = 'skipped-src-side';
      }
    }
    return JSON.stringify(out);
    } catch (e) {
      return 'PIPELINE_ERROR: ' + (e && e.message ? e.message : String(e)).slice(0, 300);
    }
  })()`,
  returnByValue: true,
  awaitPromise: true,
});
console.log(res?.result?.value ?? JSON.stringify(res?.exceptionDetails?.exception ?? res));
ws.close();
process.exit(0);
