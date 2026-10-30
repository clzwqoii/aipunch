import type { Account, CheckinResult, Provider, RunContext } from '../core/types.ts';
import { sdkDate, signHeaders, type SignCredential } from '../core/codearts-sign.ts';
import { signProof, type DpopJwk } from '../core/codearts-dpop.ts';

// 华为云码道 CodeArts 每日签到（契约来源 RobbsLuo/Coding2API，2026-09-30 三账号实测；
// 官方活动页佐证：每日 1000 积分，2026-09-11~2026-12-31）：
//   POST {sts}/v1/oauth2/tokens（DPoP + form）refresh_token → STS 临时 AK/SK（一次性票，轮换）
//   GET  {snap}/v1/ops/delivery?channel=IDE  → data.data.items 找 campaignId=1
//   POST {snap}/v1/ops/claim    body {campaignId:1, idempotentKey, channel:'IDE'}
//   POST {snap}/v1/ops/confirm  body {campaignId:1}
// 状态机：ELIGIBLE+claimable=true → claim+confirm；CLAIMED（已领未确认）→ 只补 confirm；
// CONFIRMED/CONSUMED → 已签；活动不存在/过期 → 成功（非错误）。
// claim 后必须 confirm：CLAIMED 是「已领未确认」非终态，漏 confirm 积分可能不到账。
// 成功路径待真实 token 最终确认。
const SNAP_HOST = 'https://snap-access.cn-north-4.myhuaweicloud.com';
const STS_HOST = 'https://sts.cn-north-4.myhuaweicloud.com';
const TOKEN_URL = `${STS_HOST}/v1/oauth2/tokens`;
const DELIVERY_PATH = '/v1/ops/delivery';
const CLAIM_PATH = '/v1/ops/claim';
const CONFIRM_PATH = '/v1/ops/confirm';
// 积分余额（magpie 实测）：statistics 里 usageTotalPackageCredit 的剩余量即总剩余积分
const CREDIT_STATISTICS_PATH = '/snap-manager/v1/statistics/plugin';
const TOTAL_CREDIT_METRIC = 'usageTotalPackageCredit';
const CLIENT_ID = 'codearts-agent';
const OPS_CHANNEL = 'IDE';
const CAMPAIGN_DAILY_CREDIT = 1;

type JsonBody = {
  code?: number;
  message?: string;
  refresh_token?: string;
  error_code?: string;
  error_msg?: string;
  credentials?: Record<string, unknown>;
  credential?: Record<string, unknown>;
  data?: Record<string, unknown>;
};

async function parseJson(res: Response): Promise<{ data: JsonBody | null; text: string }> {
  const text = await res.text();
  try {
    return { data: JSON.parse(text), text };
  } catch {
    return { data: null, text };
  }
}

interface StsTokens {
  accessKeyId: string;
  secretAccessKey: string;
  securityToken?: string;
  refreshToken?: string;
}

// 凭证双形态：新 credentials{access_key_id,secret_access_key,security_token} /
// 旧 credential{access,secret,securitytoken}
function parseTokens(data: JsonBody | null): StsTokens | null {
  const nested = data?.credentials ?? data?.credential;
  if (!nested || typeof nested !== 'object') return null;
  const record = nested as Record<string, unknown>;
  const accessKeyId = (record.access_key_id as string | undefined) ?? (record.access as string | undefined) ?? '';
  const secretAccessKey = (record.secret_access_key as string | undefined) ?? (record.secret as string | undefined) ?? '';
  if (!accessKeyId || !secretAccessKey) return null;
  const securityToken = (record.security_token as string | undefined) ?? (record.securitytoken as string | undefined) ?? '';
  const refreshToken = (record.refresh_token as string | undefined) ?? (data?.refresh_token as string | undefined);
  return { accessKeyId, secretAccessKey, securityToken, refreshToken };
}

async function refreshCredentials(
  refreshToken: string,
  ctx: RunContext,
): Promise<{ tokens: StsTokens; rotatedRefreshToken?: string }> {
  let dpopKey: DpopJwk;
  try {
    dpopKey = JSON.parse(process.env.CODEARTS_DPOP_KEY ?? '') as DpopJwk;
    if (!dpopKey?.d) throw new Error('empty');
  } catch {
    throw new Error('缺少 CODEARTS_DPOP_KEY（DPoP 私钥 JWK，与 refreshToken 绑定，登录时生成）');
  }
  const clientId = process.env.CODEARTS_CLIENT_ID ?? CLIENT_ID;
  const codeVerifier = process.env.CODEARTS_CODE_VERIFIER ?? '';
  const form = new URLSearchParams({
    client_id: clientId,
    code_verifier: codeVerifier,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });
  const res = await ctx.fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      DPoP: signProof(dpopKey, TOKEN_URL, { htm: 'POST' }),
    },
    body: form.toString(),
  });
  const { data, text } = await parseJson(res);
  const tokens = parseTokens(data);
  if (!tokens) {
    throw new Error(`refreshToken 刷新失败: HTTP ${res.status} ${text.slice(0, 120)}`);
  }
  // 一次性票：响应带新 refresh_token 必须透出回写，否则下次刷新必失败
  return { tokens, rotatedRefreshToken: tokens.refreshToken };
}

function signedRequest(
  tokens: StsTokens,
  method: string,
  path: string,
  rawQuery: string,
  body: Buffer,
  ctx: RunContext,
): Promise<Response> {
  const credential: SignCredential = {
    accessKeyId: tokens.accessKeyId,
    secretAccessKey: tokens.secretAccessKey,
    securityToken: tokens.securityToken,
  };
  const headers = signHeaders(credential, {
    method,
    path,
    rawQuery,
    // ops 系列必带 Agent-Type: PromptCenter，漏了报 TM.00001001「请求头Agent-Type为空」
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Language': 'zh-cn', 'Agent-Type': 'PromptCenter' },
    payload: body,
    xSdkDate: sdkDate(ctx.now),
  });
  return ctx.fetch(`${SNAP_HOST}${path}${rawQuery ? `?${rawQuery}` : ''}`, {
    method,
    headers,
    body: body.length > 0 ? body.toString('utf8') : undefined,
  });
}

interface Campaign {
  campaignId: number;
  type?: string;
  status: string;
  claimable?: boolean;
  benefitAmount?: number;
  title?: string;
  endTime?: string;
}

// 活动 id 会变（2026-10-30 实测已从 1 变为 34）：优先旧 id，其次按 type=USER_LOGIN，最后按标题
export function findCampaign(data: JsonBody | null): Campaign | null {
  const items = (data?.data?.items ?? []) as unknown[];
  if (!Array.isArray(items)) return null;
  const campaigns = items.filter((item) => item && typeof item === 'object') as Campaign[];
  return (
    campaigns.find((c) => c.campaignId === CAMPAIGN_DAILY_CREDIT) ??
    campaigns.find((c) => c.type === 'USER_LOGIN') ??
    campaigns.find((c) => /每日.*签到/.test(String(c.title ?? ''))) ??
    null
  );
}

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

// 响应：{ code, data: { metrics: [{ name, package_credit_amount, package_credit_remain }], package } }
export function parseCodeartsBalance(body: unknown): { remain: number } | null {
  const root = (body ?? {}) as Record<string, unknown>;
  if (root.code !== undefined && Number(root.code) !== 0) return null;
  const data = (root.data ?? root) as Record<string, unknown>;
  const metrics = Array.isArray(data.metrics) ? data.metrics : null;
  if (!metrics) return null;
  const total = metrics.find((m) => (m as Record<string, unknown>)?.name === TOTAL_CREDIT_METRIC) as
    | Record<string, unknown>
    | undefined;
  if (!total) return null;
  return { remain: Math.round(num(total.package_credit_remain) * 100) / 100 };
}

interface BalanceResult {
  balance: { remain: number } | null;
  error?: string; // 仅进 detail（verbose 可见），不影响签到判定
}

async function queryBalance(tokens: StsTokens, ctx: RunContext): Promise<BalanceResult> {
  try {
    const res = await signedRequest(tokens, 'GET', CREDIT_STATISTICS_PATH, '', Buffer.from(''), ctx);
    const parsed = await parseJson(res);
    const balance = parseCodeartsBalance(parsed.data);
    return { balance, error: balance ? undefined : `HTTP ${res.status} ${parsed.text.slice(0, 200)}` };
  } catch (err) {
    return { balance: null, error: (err as Error).message };
  }
}

export const codearts: Provider = {
  id: 'codearts',
  name: '码道 CodeArts',
  async checkin(account: Account, ctx: RunContext): Promise<CheckinResult> {
    if (!account.refreshToken) {
      return { ok: false, message: '码道需要 refreshToken（STS 临时 AK/SK 由它换取，无法直接用 token）' };
    }
    let tokens: StsTokens;
    let rotatedRefreshToken: string | undefined;
    try {
      const refreshed = await refreshCredentials(account.refreshToken, ctx);
      tokens = refreshed.tokens;
      rotatedRefreshToken = refreshed.rotatedRefreshToken;
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }

    const balanceResult = await queryBalance(tokens, ctx);
    const balance = balanceResult.balance;
    let balanceSuffix = balance ? `；剩余 ${balance.remain} 积分` : '';
    const balanceError = balanceResult.error;
    // 领取后的余额必须重新查：claim 前查到的旧值永远少当天那 1000（用户对账会对不上）
    let freshBalance = balance;
    const refreshBalance = async (): Promise<void> => {
      const after = await queryBalance(tokens, ctx);
      if (after.balance) {
        freshBalance = after.balance;
        balanceSuffix = `；剩余 ${after.balance.remain} 积分`;
      }
    };

    const deliveryRes = await signedRequest(tokens, 'GET', DELIVERY_PATH, `channel=${OPS_CHANNEL}`, Buffer.from(''), ctx);
    const delivery = await parseJson(deliveryRes);
    // 错误信封（APIG  TM.*/error_code）没有 data——必须判失败，不能误报「活动未开放」
    if (!delivery.data || !delivery.data.data) {
      const errorCode = delivery.data?.error_code ?? delivery.data?.code ?? deliveryRes.status;
      const errorMsg = delivery.data?.error_msg ?? delivery.data?.message ?? delivery.text.slice(0, 100);
      return {
        ok: false,
        message: `查询签到活动失败: ${errorCode} ${errorMsg}`,
        detail: { delivery: delivery.data },
        rotatedRefreshToken,
      };
    }
    const campaign = findCampaign(delivery.data);
    if (!campaign) {
      return { ok: true, message: `官方签到活动未开放${balanceSuffix}`, detail: { delivery: delivery.data, balance, balanceError, rotatedRefreshToken }, rotatedRefreshToken };
    }
    if (campaign.endTime && Date.parse(campaign.endTime) <= ctx.now.getTime()) {
      return { ok: true, message: `官方签到活动已结束${balanceSuffix}`, detail: { campaign, balance, balanceError, rotatedRefreshToken }, rotatedRefreshToken };
    }

    const confirm = async (): Promise<CheckinResult | null> => {
      const res = await signedRequest(tokens, 'POST', CONFIRM_PATH, '', Buffer.from(JSON.stringify({ campaignId: campaign.campaignId })), ctx);
      const body = await parseJson(res);
      if (!body.data || body.data.code !== 0) {
        return { ok: false, message: `签到确认失败: code=${body.data?.code ?? res.status}`, detail: { confirm: body.data }, rotatedRefreshToken };
      }
      return null;
    };

    if (campaign.status === 'CONFIRMED' || campaign.status === 'CONSUMED') {
      return { ok: true, message: `今日已签到${balanceSuffix}`, skipped: true, detail: { campaign, balance, balanceError, rotatedRefreshToken }, rotatedRefreshToken };
    }
    if (campaign.status === 'CLAIMED') {
      // 已领未确认：只补第二步。confirm 失败必须报失败，否则当天封账后再不补确认
      const failure = await confirm();
      if (failure) return failure;
      await refreshBalance();
      return { ok: true, message: `已补确认签到（积分已在 claim 时到账）${balanceSuffix}`, detail: { campaign, balance: freshBalance, balanceError, rotatedRefreshToken }, rotatedRefreshToken };
    }
    if (campaign.status === 'ELIGIBLE' && campaign.claimable === true) {
      const idempotentKey = `claim_${campaign.campaignId}_${Date.now()}`;
      const claimRes = await signedRequest(
        tokens,
        'POST',
        CLAIM_PATH,
        '',
        Buffer.from(JSON.stringify({ campaignId: campaign.campaignId, idempotentKey, channel: OPS_CHANNEL })),
        ctx,
      );
      const claim = await parseJson(claimRes);
      const code = claim.data?.code;
      if (code !== 0) {
        // 业务码失败走 HTTP 200（如 40001 尚未到达权益刷新时间），不能只看状态码
        return {
          ok: false,
          message: `领取失败: code=${code} ${claim.data?.message ?? claim.text.slice(0, 80)}`,
          detail: { claim: claim.data },
          rotatedRefreshToken,
        };
      }
      const failure = await confirm();
      if (failure) return failure;
      await refreshBalance();
      const amount = typeof campaign.benefitAmount === 'number' ? `：+${campaign.benefitAmount} 积分` : '';
      return { ok: true, message: `签到成功${amount}${balanceSuffix}`, detail: { campaign, claim: claim.data, balance: freshBalance, balanceError, rotatedRefreshToken }, rotatedRefreshToken };
    }
    return { ok: false, message: '当前不可领取（活动存在但不可领）', detail: { campaign }, rotatedRefreshToken };
  },
};
