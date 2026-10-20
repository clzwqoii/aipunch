import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { setEnvValue } from '../core/dotenv.ts';
import type { RunContext } from '../core/types.ts';
import { chooseCredential, parseLoginArgs, type LoginArgs } from './login-args.ts';

export interface LoginApi {
  sendSmsCode(phone: string, ctx: RunContext): Promise<void>;
  loginWithSms(
    phone: string,
    code: string,
    ctx: RunContext,
  ): Promise<{ accessToken: string; refreshToken: string }>;
}

export function mask(value: string): string {
  return value.length <= 8 ? '****' : `${value.slice(0, 6)}…${value.slice(-4)} (len=${value.length})`;
}

function maskPhone(phone: string): string {
  return /^\d{11}$/.test(phone) ? `${phone.slice(0, 3)}****${phone.slice(7)}` : '****';
}

// 交互式与参数化（桌面壳调用）短信登录共用同一流程，参数模式见 parseLoginArgs。
// 返回退出码，由调用方写入 process.exitCode。
export async function runLoginFlow(
  envName: string,
  api: LoginApi,
  opts: { argv?: string[]; cwd?: string; hint?: string } = {},
): Promise<number> {
  const cwd = opts.cwd ?? process.cwd();
  let args: LoginArgs;
  try {
    args = parseLoginArgs(opts.argv ?? process.argv.slice(2));
  } catch (err) {
    console.error((err as Error).message);
    return 1;
  }

  const ctx: RunContext = { now: new Date(), fetch: globalThis.fetch };

  if (args.mode === 'send-sms') {
    try {
      await api.sendSmsCode(args.phone, ctx);
      console.log(`[OK] 验证码已成功发送至 ${maskPhone(args.phone)}`);
      return 0;
    } catch (err) {
      console.error(`发送失败: ${(err as Error).message}`);
      return 1;
    }
  }

  if (args.mode === 'login') {
    try {
      const { accessToken, refreshToken } = await api.loginWithSms(args.phone, args.code, ctx);
      const { value, warning } = chooseCredential(refreshToken, accessToken);
      if (warning) console.warn(warning);
      if (args.print) {
        console.log(value);
        return 0;
      }
      const envFile = join(cwd, '.env');
      setEnvValue(envFile, envName, value);
      console.log(`\n登录成功！${envName}=${mask(value)} 已保存至 ${envFile}`);
      return 0;
    } catch (err) {
      console.error(`登录失败: ${(err as Error).message}`);
      return 1;
    }
  }

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
    await api.sendSmsCode(phone, ctx);
    const code = (await ask('验证码（5 分钟内有效）: ')).trim();
    if (!/^\d{4,8}$/.test(code)) {
      throw new Error('验证码格式不正确');
    }
    const { accessToken, refreshToken } = await api.loginWithSms(phone, code, ctx);
    const { value, warning } = chooseCredential(refreshToken, accessToken);
    rl.close();

    console.log('\n登录成功。');
    if (warning) console.warn(warning);
    if (args.print) {
      console.log(value);
      return 0;
    }
    const envFile = join(cwd, '.env');
    setEnvValue(envFile, envName, value);
    console.log(`${envName}=${mask(value)} 已写入 ${envFile}（token 不明文显示）`);
    console.log(`accessToken 短期有效，仅本地调试用: ${accessToken.slice(0, 12)}...`);
    if (opts.hint) console.log(opts.hint);
    return 0;
  } catch (err) {
    rl.close();
    console.error(`登录失败: ${(err as Error).message}`);
    return 1;
  }
}
