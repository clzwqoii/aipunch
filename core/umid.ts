// Qoder 客户端自带的 UMID 组件（阿里 securityguard 设备指纹）封装：
// 国际版活动列表只在请求携带 Cosy-MachineToken/Type/Code 时下发每日 CLAIM_BENEFIT，
// 身份由本机安装的 Qoder 客户端实时指纹生成（不可伪造、与区域绑定）。
// 契约来源：magpie#1268 / dsh-connect-qoder docs/PAT.md / locdd 国际版脚本。

export interface UmidIdentity {
  machineToken: string;
  machineType: string;
  machineCode: string;
}

// 组件输出首行 JSON：{"machineToken":"...","machineType":"...","machineCode":"...","vmInfo":{...}}
export function parseRuntimeInfo(raw: string): UmidIdentity | null {
  const line = raw
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.startsWith('{'));
  if (!line) return null;
  try {
    const obj = JSON.parse(line) as Record<string, unknown>;
    const machineToken = typeof obj.machineToken === 'string' ? obj.machineToken : '';
    const machineType = typeof obj.machineType === 'string' ? obj.machineType : '';
    const machineCode = typeof obj.machineCode === 'string' ? obj.machineCode : '';
    if (!machineToken || !machineType) return null;
    return { machineToken, machineType, machineCode };
  } catch {
    return null;
  }
}

// 只认显式配置 + macOS 默认安装路径；其他平台不猜路径（Windows 等用 QODER_UMID_PATH 指定）
export function umidCandidates(
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
): string[] {
  const list: string[] = [];
  if (env.QODER_UMID_PATH) list.push(env.QODER_UMID_PATH);
  if (platform === 'darwin') list.push('/Applications/Qoder.app/Contents/Resources/umid/runtime-info');
  return list;
}

export function findUmidBinary(
  exists: (path: string) => boolean,
  platform: NodeJS.Platform = process.platform,
  env: Record<string, string | undefined> = process.env,
): string | null {
  for (const candidate of umidCandidates(platform, env)) {
    if (exists(candidate)) return candidate;
  }
  return null;
}

// 补刷节流：桌面端每次启动都调用，只有距上次刷新超过 maxAgeHours 才重新生成
// （设备指纹有时效，但不必每次开机都换新设备身份）
export function isStale(refreshedAt: string | undefined, now: Date, maxAgeHours: number): boolean {
  if (!refreshedAt) return true;
  const at = Date.parse(refreshedAt);
  if (!Number.isFinite(at)) return true;
  return now.getTime() - at >= maxAgeHours * 3_600_000;
}
