/**
 * 论文正文 quote 定位总线：聊天侧引用标跳转 → PaperReaderView 内 PaperReaderHandle.scrollToQuote。
 *
 * 目标论文 tab 可能未挂载/正文未就绪（openPaper 后 markdown 异步加载、P2 休眠卸载）：
 * 请求按 paperId 挂起（pendingQuotes），定位器注册/重注册时自动冲刷一次；
 * PaperReaderView 在就绪态变化（markdown 加载完成/休眠恢复）时重注册，触发滞留请求重放。
 */
type PaperQuoteLocator = (quote: string) => boolean;

const locators = new Map<string, PaperQuoteLocator>();
const pendingQuotes = new Map<string, string>();

/** 注册定位器（返回解注册函数）；注册即尝试冲刷该论文的滞留请求 */
export function registerPaperQuoteLocator(paperId: string, locator: PaperQuoteLocator): () => void {
  locators.set(paperId, locator);
  const pending = pendingQuotes.get(paperId);
  if (pending && locator(pending)) pendingQuotes.delete(paperId);
  return () => {
    if (locators.get(paperId) === locator) locators.delete(paperId);
  };
}

/** 请求定位：定位器就绪则立即执行，否则挂起等待冲刷 */
export function requestPaperQuoteLocate(paperId: string, quote: string): void {
  if (locators.get(paperId)?.(quote)) return;
  pendingQuotes.set(paperId, quote);
}
