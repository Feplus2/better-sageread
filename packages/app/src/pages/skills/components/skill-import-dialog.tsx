/**
 * SKILL.md 导入对话框（批次 C2）：支持 ① SKILL.md 直链 URL；② GitHub 仓库/目录 URL
 * （自动转 raw.githubusercontent.com，默认 main 失败试 master）；③ 粘贴文本。
 */
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { secretListUser } from "@/services/secret-service";
import { extractSecretRefNames, importSkillFromText, importSkillFromUrl } from "@/services/skill-import-service";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

interface SkillImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function SkillImportDialog({ open, onOpenChange }: SkillImportDialogProps) {
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<"url" | "text">("url");
  const [url, setUrl] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  const canImport = mode === "url" ? url.trim().length > 0 : text.trim().length > 0;

  const handleImport = async () => {
    if (!canImport || busy) return;
    setBusy(true);
    try {
      const skill = mode === "url" ? await importSkillFromUrl(url.trim()) : await importSkillFromText(text);
      await queryClient.invalidateQueries({ queryKey: ["skills"] });
      toast.success(`技能「${skill.name}」导入成功并已启用`);
      // 批次 C2 补充：内容含 {{secret:NAME}} 占位而保管箱缺同名密钥时引导补齐，避免运行时才报「密钥引用未找到」
      const refNames = extractSecretRefNames(skill.content);
      if (refNames.length > 0) {
        const existing = await secretListUser().catch(() => [] as string[]);
        const missing = refNames.filter((n) => !existing.includes(n));
        if (missing.length > 0) {
          toast.warning(
            `该技能引用了密钥 ${missing.map((n) => `「${n}」`).join("、")}，密钥保管箱中尚未添加。请到「设置 → 密钥保管箱」补齐同名密钥，否则运行时无法解析`,
            { duration: 8000 },
          );
        }
      }
      setUrl("");
      setText("");
      onOpenChange(false);
    } catch (error) {
      toast.error(`导入失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[540px]">
        <DialogHeader>
          <DialogTitle>导入技能（SKILL.md）</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 px-3 py-4">
          <div className="flex gap-2">
            <Button
              type="button"
              variant={mode === "url" ? "default" : "outline"}
              size="sm"
              onClick={() => setMode("url")}
            >
              从 URL 导入
            </Button>
            <Button
              type="button"
              variant={mode === "text" ? "default" : "outline"}
              size="sm"
              onClick={() => setMode("text")}
            >
              粘贴文本
            </Button>
          </div>

          {mode === "url" ? (
            <div className="space-y-2">
              <Label>SKILL.md 链接</Label>
              <Input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="SKILL.md 直链，或 GitHub 仓库/目录 URL"
              />
              <p className="text-muted-foreground text-xs">
                支持 GitHub 仓库链接（自动找根目录 SKILL.md）与目录链接（自动定位其中的 SKILL.md）， 兼容 Claude Code
                skills 生态
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              <Label>SKILL.md 内容</Label>
              <Textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={10}
                placeholder={"---\nname: 技能名称\ndescription: 一句话描述\n---\n\n技能正文（SOP）…"}
                className="font-mono text-xs"
              />
            </div>
          )}

          <p className="text-muted-foreground text-xs">
            格式要求：开头 --- 包围的 YAML frontmatter 需含 name（必填）、description、scope（可选，
            reader/central/paper，缺省全部生效）。附带脚本/资源文件不处理，SOP 中引用的脚本需 Agent 自行下载执行。
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button size="sm" onClick={handleImport} disabled={!canImport || busy}>
            {busy && <Loader2 className="size-4 animate-spin" />}
            导入
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
