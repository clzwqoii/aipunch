// AutoClaw 国际版浏览器授权（Zai/Google OAuth + 阿里云滑块）的纯函数部分。
// 契约来源：CencYun/agent2api 移植自官方客户端 app.asar 的实现（ui/aliyun-captcha.js、
// ui/autoclaw-oauth.js，2026-09-28 实测）：
//   ① POST /userapi/overseasv1/oauth-captcha-config → { enabled, region, prefix, sceneId }
//   ② 浏览器页面跑阿里云 SDK 过滑块 → captchaVerifyParam（base64(JSON)，原样透传，勿序列化）
//   ③ POST /userapi/overseasv1/{zai|google}-oauth-url 带 ali_captcha_verify_param → oauth_url
//   ④ 浏览器登录 → 回调 {navigate_uri}?code=&state=（Zai 仅 4 个白名单 loopback 端口）
//   ⑤ POST /userapi/overseasv1/{zai|google}-oauth-login → access_token/refresh_token
// 关键坑：window.AliyunCaptchaConfig 必须先于 SDK 脚本设置，否则验证码一直转圈。

export type OauthVendor = 'zai' | 'google';

// Zai 逐字白名单（RFC 8252 的任意端口只对 Google 成立）；18432 常被官方客户端占用，排最后
const ZAI_PINNED_PORTS = [19654, 19723, 53699, 18432];

export const CAPTCHA_SDK_URL = 'https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js';

export function pinnedPorts(): number[] {
  return [...ZAI_PINNED_PORTS];
}

export function callbackPath(vendor: OauthVendor): string {
  return `/auth/callback-${vendor}`;
}

export function oauthUrlPath(vendor: OauthVendor): string {
  return `/userapi/overseasv1/${vendor}-oauth-url`;
}

export function oauthLoginPath(vendor: OauthVendor): string {
  return `/userapi/overseasv1/${vendor}-oauth-login`;
}

export interface CaptchaConfig {
  enabled: boolean;
  region: string;
  prefix: string;
  sceneId: string;
}

export function normalizeCaptchaConfig(raw: Record<string, unknown>): CaptchaConfig {
  const data = ((raw.data as Record<string, unknown> | undefined) ?? raw) as Record<string, unknown>;
  const pick = (snake: string, camel: string): string => {
    const value = data[snake] ?? data[camel];
    return typeof value === 'string' ? value : '';
  };
  return {
    enabled: data.enabled === true,
    region: pick('region', 'region') || 'ga',
    prefix: pick('prefix', 'prefix'),
    sceneId: pick('scene_id', 'sceneId'),
  };
}

export function parseCallbackQuery(url: string): { code: string; state: string } | null {
  const queryIndex = url.indexOf('?');
  if (queryIndex < 0) return null;
  const params = new URLSearchParams(url.slice(queryIndex + 1));
  const code = params.get('code') ?? '';
  if (!code) return null;
  return { code, state: params.get('state') ?? '' };
}

export interface CaptchaPageOptions {
  region: string;
  prefix: string;
  sceneId: string;
  postPath: string;
}

// 本地验证码页：官方 SDK + 可见触发按钮（用户手势弹滑块），成功后把原串 POST 回本地服务。
// 说明：不伪造任何浏览器指纹，滑块由用户本人完成。
export function captchaPageHtml(options: CaptchaPageOptions): string {
  const json = (value: string): string => JSON.stringify(value);
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>AutoClaw 国际版授权 - 人机验证</title>
<style>
  body { font-family: -apple-system, "PingFang SC", sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #f5f6f8; color: #1f2329; }
  .card { background: #fff; border-radius: 12px; padding: 40px 48px; box-shadow: 0 8px 32px rgba(0,0,0,.08); text-align: center; max-width: 420px; }
  h1 { font-size: 18px; margin: 0 0 8px; }
  p { font-size: 13px; color: #646a73; line-height: 1.6; margin: 0 0 24px; }
  button { font-size: 15px; padding: 10px 28px; border-radius: 8px; border: 0; background: #3370ff; color: #fff; cursor: pointer; }
  button:disabled { background: #a8b8e8; cursor: default; }
  .status { margin-top: 16px; font-size: 13px; color: #646a73; min-height: 20px; }
</style>
</head>
<body>
  <div class="card">
    <h1>AutoClaw 国际版官方授权</h1>
    <p>官方要求先完成一次人机验证（阿里云滑块）。<br>通过后将自动打开授权登录页。</p>
    <button id="captcha-trigger">开始验证</button>
    <div class="status" id="status"></div>
    <div id="aliyun-captcha-element" style="position:relative;z-index:2147483000"></div>
  </div>
  <script>
    window.AliyunCaptchaConfig = { region: ${json(options.region)}, prefix: ${json(options.prefix)} };
  </script>
  <script src="${CAPTCHA_SDK_URL}"></script>
  <script>
    (function () {
      var status = document.getElementById('status');
      var trigger = document.getElementById('captcha-trigger');
      var timer = setTimeout(function () {
        status.textContent = '验证码组件加载超时，请检查网络后刷新页面。';
      }, 40000);

      if (typeof window.initAliyunCaptcha !== 'function') {
        status.textContent = '验证码组件加载失败，请检查网络后刷新页面。';
        return;
      }
      clearTimeout(timer);
      window.initAliyunCaptcha({
        SceneId: ${json(options.sceneId)},
        mode: 'popup',
        element: '#aliyun-captcha-element',
        button: '#captcha-trigger',
        captchaVerifyCallback: function (param) {
          status.textContent = '验证通过，正在打开登录页…';
          fetch(${json(options.postPath)}, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: param })
            .then(function () { trigger.disabled = true; });
          return { captchaResult: true, bizResult: true };
        },
        onBizResultCallback: function () {},
        getInstance: function () {},
        slideStyle: { width: 360, height: 40 },
        language: 'cn',
        onError: function () { status.textContent = '验证失败，请重试。'; }
      });
    })();
  </script>
</body>
</html>`;
}
