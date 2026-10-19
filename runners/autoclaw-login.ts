import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { loginWithSms, sendSmsCode } from '../providers/autoclaw.ts';
import { setEnvValue } from '../core/dotenv.ts';

// 交互式登录（AutoClaw CN，短信验证码）：与 `npm run login`（WorkBuddy）同用途。
// 契约来自 autoclaw2api（单来源，待真实 token 验证）；登录响应无 expiresAt，
// 客户端按 28 天估算，故 refreshToken 需在约 28 天内自然续期（每次签到自动刷新）。
// 用法：npm run autoclaw-login [-- --print]（--print 只输出到终端，不写 .env）
function mask(value: string): string {
  return value.length <= 8 ? '****' : `${value.slice(0, 6)}…${value.slice(-4)} (len=${value.length})`;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (question: string): Promise<string> =>
    new Promise((resolve) => {
      rl.question(question, resolve);
    });

  try {
    const phone = (await ask('手机号（11 位，不带 +86）: ')).trim();
    if (!/^\d{11}$/.test(phone)) {
      throw new Error('手机号格式不正确');
    }
    await sendSmsCode(phone, { now: new Date(), fetch: globalThis.fetch });
    const code = (await ask('验证码（5 分钟内有效）: ')).trim();
    if (!/^\d{4,8}$/.test(code)) {
      throw new Error('验证码格式不正确');
    }
    const { accessToken, refreshToken } = await loginWithSms(phone, code, {
      now: new Date(),
      fetch: globalThis.fetch,
    });
    rl.close();

    console.log('\n登录成功。');
    if (!refreshToken) {
      console.log('警告：登录响应没有 refreshToken，只能使用短期 accessToken（约 28 天），到期需重新登录。');
    }
    if (args.includes('--print')) {
      console.log(`AUTOCLAW_REFRESH_TOKEN=${refreshToken || accessToken}`);
      return;
    }
    const envFile = join(process.cwd(), '.env');
    setEnvValue(envFile, 'AUTOCLAW_REFRESH_TOKEN', refreshToken || accessToken);
    console.log(`AUTOCLAW_REFRESH_TOKEN=${mask(refreshToken || accessToken)} 已写入 ${envFile}（token 不明文显示）`);
    console.log('config.json 加账号：{ "provider": "autoclaw", "name": "main", "refreshTokenEnv": "AUTOCLAW_REFRESH_TOKEN", "enabled": true }');
  } catch (err) {
    rl.close();
    console.error(`登录失败: ${(err as Error).message}`);
    process.exitCode = 1;
  }
}

main();
