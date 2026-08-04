/**
 * 全局书籍拖入导入的临时抑制标记。
 * 论文「导入 PDF」选择弹窗开启期间置 true：home-layout 的书籍拖入导入静默忽略，
 * 防止 PDF 同时被论文导入流程与书籍导入流程各消费一次（双重导入）。
 */
let suppressed = false;

export function setBookDropSuppressed(value: boolean): void {
  suppressed = value;
}

export function isBookDropSuppressed(): boolean {
  return suppressed;
}
