import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { secretListUser, secretUserDelete, secretUserSet } from "@/services/secret-service";
import { KeyRound, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

/**
 * 密钥保管箱（批次 A3）：用户级 secret 的增/删，永不明文回显。
 * 保存后可在面向 Agent 的文本配置（httpRequest 的 url/headers/body、MCP env/headers、
 * skill content）中以 {{secret:名称}} 引用，执行边界替换为真值，模型永远只见占位符。
 */
export default function SecretVault() {
  const [names, setNames] = useState<string[]>([]);
  const [newName, setNewName] = useState("");
  const [newValue, setNewValue] = useState("");

  const refresh = useCallback(async () => {
    try {
      setNames(await secretListUser());
    } catch (error) {
      console.error("读取密钥列表失败:", error);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleAdd = async () => {
    const name = newName.trim();
    const value = newValue.trim();
    if (!name || !value) {
      toast.error("请填写密钥名称和值");
      return;
    }
    try {
      await secretUserSet(name, value);
      toast.success(names.includes(name) ? `已更新密钥：${name}` : `已保存密钥：${name}`);
      setNewName("");
      setNewValue("");
      await refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  };

  const handleDelete = async (name: string) => {
    try {
      await secretUserDelete(name);
      toast.success(`已删除密钥：${name}`);
      await refresh();
    } catch (error) {
      toast.error(`删除失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  return (
    <div className="space-y-6 p-4">
      <div className="space-y-2">
        <h2 className="font-semibold text-lg dark:text-neutral-100">密钥保管箱</h2>
        <p className="text-neutral-600 text-sm dark:text-neutral-400">
          统一管理供 Agent 引用的自定义密钥。密钥保存在系统凭据管理器，永不明文回显； 在面向 Agent 的配置中用{" "}
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">{"{{secret:名称}}"}</code>{" "}
          引用，执行时自动替换为真值，模型只见到占位符。
        </p>
        <p className="text-neutral-500 text-xs dark:text-neutral-500">
          注：模型提供商 / PDF 转换 / 网络搜索等专属密钥不在这里显示，它们同样存在系统凭据管理器（可在 Windows
          凭据管理器中按 com.xincmm.sageread 查看），在各自设置项内显示为「已保存 ·•••」。本保管箱仅管理供 技能 / MCP
          以占位符引用的通用密钥。
        </p>
      </div>

      {/* 已保存列表 */}
      <section className="space-y-2">
        <h3 className="font-medium text-base dark:text-neutral-100">已保存的密钥</h3>
        {names.length === 0 ? (
          <div className="rounded-lg border p-4 text-center">
            <p className="text-neutral-500 text-sm dark:text-neutral-400">暂无密钥，可在下方添加</p>
          </div>
        ) : (
          <div className="space-y-1.5">
            {names.map((name) => (
              <div key={name} className="flex items-center justify-between rounded-lg bg-muted/80 px-3 py-2">
                <div className="flex items-center gap-2">
                  <KeyRound className="size-3.5 text-neutral-500 dark:text-neutral-400" />
                  <span className="font-mono text-sm dark:text-neutral-200">{name}</span>
                  <span className="text-neutral-500 text-xs dark:text-neutral-500">已保存 ·•••</span>
                </div>
                <button
                  type="button"
                  onClick={() => handleDelete(name)}
                  className="cursor-pointer p-1 text-neutral-500 hover:text-red-600 dark:text-neutral-400 dark:hover:text-red-400"
                  title="删除密钥"
                >
                  <Trash2 className="size-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* 添加/更新 */}
      <section className="space-y-3 border-t pt-4 dark:border-neutral-700">
        <h3 className="font-medium text-base dark:text-neutral-100">添加密钥</h3>
        <div className="space-y-2">
          <Label htmlFor="vault-name" className="text-sm">
            名称
          </Label>
          <Input
            id="vault-name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="仅限字母、数字、下划线与连字符，如 notion-token"
            className="h-8 font-mono"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="vault-value" className="text-sm">
            密钥值
          </Label>
          <Input
            id="vault-value"
            type="password"
            value={newValue}
            onChange={(e) => setNewValue(e.target.value)}
            placeholder="输入密钥值（同名将覆盖）"
            className="h-8"
            autoComplete="off"
          />
        </div>
        <Button size="sm" onClick={handleAdd} className="gap-1.5">
          <Plus className="size-3.5" />
          保存密钥
        </Button>
      </section>
    </div>
  );
}
