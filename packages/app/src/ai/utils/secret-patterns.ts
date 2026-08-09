/**
 * 密钥模式检测（批次 S2，批次 A 的审计脱敏复用）
 * containsSecret 返回命中的模式名（首个命中），未命中返回 null。
 */

interface SecretPattern {
  name: string;
  pattern: RegExp;
}

const SECRET_PATTERNS: SecretPattern[] = [
  { name: "OpenAI 系 API Key (sk-)", pattern: /sk-[A-Za-z0-9_-]{20,}/ },
  { name: "Google API Key", pattern: /AIza[0-9A-Za-z_-]{35}/ },
  { name: "GitHub Token (ghp_)", pattern: /ghp_[A-Za-z0-9]{36}/ },
  { name: "GitHub Fine-grained Token", pattern: /github_pat_[A-Za-z0-9_]{22,}/ },
  { name: "Slack Token", pattern: /xox[baprs]-[A-Za-z0-9-]{10,}/ },
  { name: "JWT", pattern: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { name: "私钥文件块", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  {
    name: "键值对形式的密钥",
    pattern: /(api[_-]?key|token|secret|password)\s*[:=]\s*["']?[A-Za-z0-9_-]{16,}/i,
  },
];

/**
 * 检测文本中是否含常见密钥模式。
 * @returns 命中的模式名；未命中返回 null
 */
export function containsSecret(text: string): string | null {
  for (const { name, pattern } of SECRET_PATTERNS) {
    if (pattern.test(text)) return name;
  }
  return null;
}

/** 目标路径是否为工作区根下的 memory.md（相对路径或文件名判定） */
export function isMemoryFile(path: string): boolean {
  const normalized = path.replace(/\\/g, "/").trim();
  return normalized === "memory.md" || normalized === "./memory.md";
}

/** 命中密钥时的统一拒绝文案（供工具层返回给模型） */
export const SECRET_WRITE_REJECTION = (patternName: string) =>
  `写入被拒绝：内容命中密钥模式「${patternName}」。安全策略禁止将 API Key、Token、密码、私钥写入 memory.md 或工作区任何文件。` +
  `请引导用户通过 设置 → 密钥保管箱 保存密钥，并在 SOP/配置中以 {{secret:名称}} 引用，不要在记忆或文件中记录真实密钥。`;
