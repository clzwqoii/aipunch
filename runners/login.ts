import { createInterface } from 'node:readline';
import { loginWithSms, sendSmsCode } from '../providers/workbuddy.ts';

// 交互式登录：手机号 + 短信验证码 → 打印 refreshToken（存为 GitHub Secret / 环境变量）
async function main(): Promise<void> {
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

    console.log('\n登录成功。\n');
    console.log('请把下面这行设为 GitHub Secret 或环境变量，名称 WORKBUDDY_REFRESH_TOKEN：\n');
    console.log(refreshToken);
    console.log(`\n（accessToken 短期有效，仅本地调试用: ${accessToken.slice(0, 12)}...）`);
    console.log('配置方法见 README「快速开始」。');
  } catch (err) {
    rl.close();
    console.error(`登录失败: ${(err as Error).message}`);
    process.exitCode = 1;
  }
}

main();
