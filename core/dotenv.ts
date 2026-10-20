import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// 加载本地 .env（已在 .gitignore，仅存本地凭证）；文件不存在或运行时不支持时静默跳过。
// 已有环境变量优先（shell/CI > .env），与 process.loadEnvFile 语义一致
export function loadDotEnv(cwd: string = process.cwd()): void {
  const file = join(cwd, '.env');
  if (!existsSync(file) || typeof process.loadEnvFile !== 'function') {
    return;
  }
  process.loadEnvFile(file);
}

function escapeName(name: string): string {
  return name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 更新 .env 内容中的某个变量：已存在则替换该行（保留注释与其他行），不存在则追加。
// 返回规范化后的内容（以单个换行结尾）
export function updateEnvValue(content: string, name: string, value: string): string {
  const line = `${name}=${value}`;
  const lines = content.split('\n');
  while (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  const pattern = new RegExp(`^\\s*${escapeName(name)}\\s*=`);
  let replaced = false;
  const out = lines.map((existing) => {
    if (!replaced && pattern.test(existing)) {
      replaced = true;
      return line;
    }
    return existing;
  });
  if (!replaced) {
    out.push(line);
  }
  return `${out.join('\n')}\n`;
}

// 把变量写回 .env 文件（不存在则创建）——用于 refreshToken 轮换后的自动持久化，
// 与桌面客户端把新登录态写回本地文件的思路一致
export function setEnvValue(filePath: string, name: string, value: string): void {
  // 同目录临时文件 + rename：避免轮换回写期间读到写了一半的 .env（跨进程并发仍是后写覆盖）
  const content = existsSync(filePath) ? readFileSync(filePath, 'utf-8') : '';
  const tmpPath = `${filePath}.tmp`;
  writeFileSync(tmpPath, updateEnvValue(content, name, value));
  // 文件里有 token，一律 0600：已有 .env 常是 0644，残留的 .env.tmp 也会让 writeFileSync 的 mode 失效
  chmodSync(tmpPath, 0o600);
  renameSync(tmpPath, filePath);
}
