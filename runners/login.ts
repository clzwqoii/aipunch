import { loginWithSms, sendSmsCode } from '../providers/workbuddy.ts';
import { runLoginFlow } from './login-flow.ts';

// 交互式/参数化登录：手机号 + 短信验证码 → 保存 refreshToken 到 .env
// 用法：npm run login [-- --print | -- --send-sms <手机号> | -- --phone <手机号> --code <验证码>]
process.exitCode = await runLoginFlow(
  'WORKBUDDY_REFRESH_TOKEN',
  { sendSmsCode, loginWithSms },
  { hint: '配置方法见 README「快速开始」。' },
);
