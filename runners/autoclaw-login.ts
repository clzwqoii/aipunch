import { loginWithSms, sendSmsCode } from '../providers/autoclaw.ts';
import { runLoginFlow } from './login-flow.ts';

// AutoClaw CN 短信登录：与 `npm run login`（WorkBuddy）共用流程。
// 契约来自 autoclaw2api（单来源，待真实 token 验证）；登录响应无 expiresAt，
// 客户端按 28 天估算，故 refreshToken 需在约 28 天内自然续期（每次签到自动刷新）。
const code = await runLoginFlow(
  'AUTOCLAW_REFRESH_TOKEN',
  { sendSmsCode, loginWithSms },
  {
    hint: 'config.json 加账号：{ "provider": "autoclaw", "name": "main", "refreshTokenEnv": "AUTOCLAW_REFRESH_TOKEN", "enabled": true }',
  },
);
process.exitCode = code;
