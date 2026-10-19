import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { candidateDbPaths, findIntlAccount } from '../core/autoclaw-intl-import.ts';
import { setEnvValue } from '../core/dotenv.ts';

// AutoClaw 国际版凭证导入（国际版登录是 Zai/Google OAuth + 阿里云验证码，纯 CLI 不可自动化）。
// 三条来源路径（优先级从高到低）：
//   A1. --token <refreshToken>    从抓包/客户端复制的值（tools/mitm_autoclaw_intl.py 可自动抓）
//   A2. 交互粘贴（stdin）
//   B.  --from-agent2api          从 Agent2API 的账号库（{config}/agent2api.db, 表 accounts,
//                                  provider=autoclaw-intl，明文 refreshToken）只读导入
// 写入 .env 的 AUTOCLAW_INTL_REFRESH_TOKEN；--print 只打印不落盘。
// 用法：npm run autoclaw-intl-login [-- --token <rt> | --from-agent2api [--db <path>] | --print]
function mask(value: string): string {
  return value.length <= 8 ? '****' : `${value.slice(0, 6)}…${value.slice(-4)} (len=${value.length})`;
}

function findDbRecursively(roots: string[], depth = 3): string | null {
  for (const root of roots) {
    if (!existsSync(root)) continue;
    const stack: Array<{ dir: string; level: number }> = [{ dir: root, level: 0 }];
    while (stack.length > 0) {
      const { dir, level } = stack.pop()!;
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        continue;
      }
      if (entries.includes('agent2api.db')) return join(dir, 'agent2api.db');
      if (level + 1 <= depth) {
        for (const entry of entries) {
          if (entry.startsWith('.')) continue;
          stack.push({ dir: join(dir, entry), level: level + 1 });
        }
      }
    }
  }
  return null;
}

async function readFromAgent2Api(dbPath?: string): Promise<string> {
  let dbFile = dbPath ?? '';
  if (!dbFile) {
    const candidates = candidateDbPaths(homedir(), process.platform, process.env.APPDATA);
    dbFile = candidates.find((p) => existsSync(p)) ?? '';
    if (!dbFile) {
      const roots =
        process.platform === 'darwin'
          ? [join(homedir(), 'Library', 'Application Support')]
          : process.platform === 'win32'
            ? [process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')]
            : [join(homedir(), '.config')];
      dbFile = findDbRecursively(roots) ?? '';
    }
  }
  if (!dbFile) {
    throw new Error('未找到 Agent2API 数据库（agent2api.db）；请先用 Agent2API 登录国际版，或用 --db 指定路径');
  }
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(dbFile, { readOnly: true });
  let rows: Array<Record<string, unknown>>;
  try {
    rows = (db.prepare('SELECT * FROM accounts').all() as unknown[]).map((row) => row as Record<string, unknown>);
  } finally {
    db.close();
  }
  const account = findIntlAccount(rows);
  if (!account) {
    throw new Error(
      '库中没有带 refreshToken 的 autoclaw-intl 账号：请用 Agent2API 的登录窗口完成国际版授权（「导入桌面客户端」的记录不含 token）',
    );
  }
  console.log(`从 ${dbFile} 读取到国际版账号${account.name ? `「${account.name}」` : ''}`);
  return account.refreshToken;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const argValue = (flag: string): string | undefined => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
  };

  let refreshToken = argValue('--token') ?? '';
  if (!refreshToken && args.includes('--from-agent2api')) {
    refreshToken = await readFromAgent2Api(argValue('--db'));
  }
  if (!refreshToken) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    refreshToken = await new Promise<string>((resolve) => {
      rl.question('粘贴 AutoClaw 国际版 refreshToken（登录响应 data.refresh_token）: ', (answer) => {
        rl.close();
        resolve(answer.trim());
      });
    });
  }
  if (!refreshToken) {
    console.error('未提供 refreshToken。三条来源：--token / --from-agent2api / 交互粘贴');
    process.exitCode = 1;
    return;
  }

  if (args.includes('--print')) {
    console.log(`AUTOCLAW_INTL_REFRESH_TOKEN=${refreshToken}`);
    return;
  }
  const envFile = join(process.cwd(), '.env');
  setEnvValue(envFile, 'AUTOCLAW_INTL_REFRESH_TOKEN', refreshToken);
  console.log(`AUTOCLAW_INTL_REFRESH_TOKEN=${mask(refreshToken)} 已写入 ${envFile}（token 不明文显示）`);
  console.log('config.json 加账号：{ "provider": "autoclaw-intl", "name": "main", "refreshTokenEnv": "AUTOCLAW_INTL_REFRESH_TOKEN", "enabled": true }');
}

main().catch((err: unknown) => {
  console.error(`导入失败: ${(err as Error).message}`);
  process.exitCode = 1;
});
