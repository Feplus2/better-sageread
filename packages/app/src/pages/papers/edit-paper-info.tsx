import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { type PaperMetadata, normalizeAuthors } from "@/pages/paper-reader/paper-metadata";
import type { PaperMetadataUpdate } from "@/services/paper-service";
import type { BookWithStatus } from "@/types/simple-book";
import { useCallback, useMemo, useState } from "react";

interface EditPaperInfoProps {
  paper: BookWithStatus;
  /** metadata.json 内容（列表页 metaMap 缓存）；作者/年份/期刊/DOI 的当前值来源 */
  meta?: PaperMetadata;
  onClose: () => void;
  onSave: (updates: PaperMetadataUpdate) => Promise<boolean>;
}

/** 作者输入 ↔ 列表：分号分隔（中英文分号都认），空项丢弃 */
const splitAuthors = (text: string): string[] =>
  text
    .split(/[;；]/)
    .map((s) => s.trim())
    .filter(Boolean);

export default function EditPaperInfo({ paper, meta, onClose, onSave }: EditPaperInfoProps) {
  // 当前值快照：diff 以它为准（title 取 books 表口径——与 frontmatter 入库时一致）
  const initial = useMemo(
    () => ({
      title: paper.title,
      authors: normalizeAuthors(meta?.author).join("; ") || paper.author,
      date: meta?.date != null ? String(meta.date) : "",
      containerTitle: meta?.["container-title"] ?? "",
      doi: meta?.doi ?? "",
    }),
    [paper, meta],
  );

  const [title, setTitle] = useState(initial.title);
  const [authorsText, setAuthorsText] = useState(initial.authors);
  const [date, setDate] = useState(initial.date);
  const [containerTitle, setContainerTitle] = useState(initial.containerTitle);
  const [doi, setDoi] = useState(initial.doi);
  const [isLoading, setIsLoading] = useState(false);

  const isTitleValid = title.trim().length > 0;

  const handleSave = useCallback(async () => {
    const updates: PaperMetadataUpdate = {};
    if (title.trim() !== initial.title) updates.title = title.trim();
    const authors = splitAuthors(authorsText);
    if (authors.join("; ") !== splitAuthors(initial.authors).join("; ")) updates.authors = authors;
    if (date.trim() !== initial.date) updates.date = date.trim();
    if (containerTitle.trim() !== initial.containerTitle) updates.containerTitle = containerTitle.trim();
    if (doi.trim() !== initial.doi) updates.doi = doi.trim();

    if (Object.keys(updates).length === 0) {
      onClose();
      return;
    }
    setIsLoading(true);
    try {
      if (await onSave(updates)) {
        onClose();
      }
    } finally {
      setIsLoading(false);
    }
  }, [title, authorsText, date, containerTitle, doi, initial, onSave, onClose]);

  const handleCancel = useCallback(() => {
    onClose();
  }, [onClose]);

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>编辑论文信息</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 p-4">
          <div className="space-y-2">
            <Label htmlFor="paper-title">标题</Label>
            <Input
              id="paper-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="请输入论文标题"
              maxLength={512}
              className={`w-full ${!isTitleValid ? "border-red-500 focus:border-red-500" : ""}`}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="paper-authors">作者</Label>
            <Input
              id="paper-authors"
              value={authorsText}
              onChange={(e) => setAuthorsText(e.target.value)}
              placeholder="多名作者用分号分隔，如 Alice; Bob"
              maxLength={512}
              className="w-full"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="paper-date">年份 / 日期</Label>
              <Input
                id="paper-date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                placeholder="如 2023 或 2023-05"
                maxLength={32}
                className="w-full"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="paper-doi">DOI</Label>
              <Input
                id="paper-doi"
                value={doi}
                onChange={(e) => setDoi(e.target.value)}
                placeholder="如 10.1000/xyz123"
                maxLength={128}
                className="w-full"
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="paper-venue">期刊 / 会议</Label>
            <Input
              id="paper-venue"
              value={containerTitle}
              onChange={(e) => setContainerTitle(e.target.value)}
              placeholder="如 Nature、CVPR"
              maxLength={256}
              className="w-full"
            />
          </div>

          <p className="text-neutral-500 text-xs dark:text-neutral-400">
            保存后同步更新 paper.md frontmatter
            与元数据缓存；正文、译文与向量化结果不受影响。留空的字段将从元数据中移除。
          </p>
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={handleCancel} disabled={isLoading}>
            取消
          </Button>
          <Button onClick={handleSave} disabled={isLoading || !isTitleValid}>
            {isLoading ? "保存中..." : "保存更改"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
