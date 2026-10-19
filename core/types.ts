// 核心领域类型，与 UI 无关；CI 与桌面壳共用。

export interface Account {
  provider: string; // Provider id，如 'workbuddy'
  name: string; // 账号备注名，如 'main'
  token: string; // 登录凭证（accessToken；仅配 refreshTokenEnv 时为空串）
  refreshToken?: string; // 长期凭证，存在时由 Provider 先刷新再签到
  refreshTokenEnv?: string; // 配置元数据：refreshToken 来源的环境变量名（轮换回写用）
  enabled?: boolean; // 默认 true
}

// 配置文件中的账号声明：token 只写环境变量名，不写值
export interface AccountSpec {
  provider: string;
  name: string;
  tokenEnv?: string;
  refreshTokenEnv?: string;
  enabled?: boolean;
}

export interface CheckinResult {
  ok: boolean;
  message: string;
  detail?: unknown; // 原始响应，便于排查
  rotatedRefreshToken?: string; // 服务端轮换后的新 refreshToken（需要时回写 Secret）
}

export interface RunContext {
  now: Date;
  fetch: typeof fetch; // 注入便于测试
}

export interface Provider {
  id: string;
  name: string;
  checkin(account: Account, ctx: RunContext): Promise<CheckinResult>;
}

export interface AccountResult {
  account: string;
  provider: string;
  ok: boolean;
  message: string;
  durationMs: number;
  detail?: unknown;
  rotatedRefreshToken?: string;
  refreshTokenEnv?: string;
}

export interface RunResult {
  startedAt: string;
  finishedAt: string;
  total: number;
  succeeded: number;
  results: AccountResult[];
}
