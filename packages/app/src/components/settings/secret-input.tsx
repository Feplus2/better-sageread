import { Input } from "@/components/ui/input";
import { secretDelete, secretHas, secretSet } from "@/services/secret-service";
import { useEffect, useState } from "react";
import { toast } from "sonner";

interface SecretInputProps {
  /** keyring 分类（如 model-provider / converter / web-search / tts） */
  category: string;
  /** keyring 键（如 providerId / 引擎名） */
  secretKey: string;
  id?: string;
  placeholder?: string;
  className?: string;
  /** 保存成功回调：把真值同步进内存状态（供前端发请求用，不落盘） */
  onSaved?: (value: string) => void;
  /** 清除成功回调：清空内存状态 */
  onCleared?: () => void;
}

/**
 * 密钥输入框（批次 A）：永不明文回显。
 * - 已保存：显示「已保存 ·•••」占位 + 「清除」按钮（调 secret_delete）；
 * - 输入新值后失焦或回车 → secret_set 写入 keyring，并清空输入框。
 */
export default function SecretInput({
  category,
  secretKey,
  id,
  placeholder,
  className,
  onSaved,
  onCleared,
}: SecretInputProps) {
  const [draft, setDraft] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    secretHas(category, secretKey)
      .then((has) => {
        if (!cancelled) setSaved(has);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [category, secretKey]);

  const commit = async () => {
    const value = draft.trim();
    if (!value) return;
    try {
      await secretSet(category, secretKey, value);
      setSaved(true);
      setDraft("");
      onSaved?.(value);
    } catch (error) {
      toast.error(`密钥保存失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const clear = async () => {
    try {
      await secretDelete(category, secretKey);
      setSaved(false);
      setDraft("");
      onCleared?.();
    } catch (error) {
      toast.error(`密钥清除失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  return (
    <div className="flex items-center gap-2">
      <Input
        id={id}
        type="password"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
        }}
        placeholder={saved ? "已保存 ·•••（输入新值可覆盖）" : placeholder}
        className={className}
        autoComplete="off"
      />
      {saved && (
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={clear}
          className="shrink-0 cursor-pointer text-neutral-500 text-xs hover:text-red-600 dark:text-neutral-400 dark:hover:text-red-400"
        >
          清除
        </button>
      )}
    </div>
  );
}
