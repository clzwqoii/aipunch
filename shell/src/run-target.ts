// 单账号「▶」按钮的执行端分流（ADR 0004 平台单选）。
// CF worker 只由 cron 触发，没有单账号入口——落回 ci-checkin 会打 GitHub，
// 而 GitHub workflow 在 CF 平台下是禁用的（实测 HTTP 422 cannot trigger a disabled workflow）。
export interface RunTarget {
  runner: string;
  args: string[];
  log: string;
}

export function singleRunTarget(platform: string, provider: string, name: string): RunTarget {
  if (platform === 'cloudflare-workers') {
    return {
      runner: 'cf-deploy',
      args: ['--trigger-now'],
      log: `[ACTION] 触发云端签到（CF 全量执行，无法只跑 ${provider}/${name}）...`,
    };
  }
  if (platform === 'local') {
    return {
      runner: 'checkin',
      args: ['--provider', provider, '--account', name],
      log: `[ACTION] 本地签到：${provider}/${name}...`,
    };
  }
  return {
    runner: 'ci-checkin',
    args: ['--provider', provider, '--account', name],
    log: `[ACTION] 触发 CI 签到：${provider}/${name}...`,
  };
}
