import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { findUmidBinary, parseRuntimeInfo } from '../core/umid.ts';
import { loadDotEnv, setEnvValue } from '../core/dotenv.ts';

// 生成 Qoder 国际版签到所需的设备身份三件套（Cosy-MachineToken/Type/Code）。
// 身份由本机 Qoder 客户端自带的 UMID 组件现场指纹，无法跨机复制；活动列表缺它只返回
// 「无活动」的 200，会导致签到天天假阳性，所以国际版 Provider 缺头直接判失败。
// 用法：
//   npm run qoder-umid           写 .env（QODER_INTL_COSY_MACHINE_*）
//   npm run qoder-umid -- --print 只打印到终端
// Linux/Windows 需 QODER_UMID_PATH 指向客户端 resources/umid/runtime-info[.exe]
function mask(value: string): string {
  return value.length <= 8 ? '****' : `${value.slice(0, 6)}…${value.slice(-4)} (len=${value.length})`;
}

function main(): void {
  loadDotEnv();
  const args = process.argv.slice(2);
  const bin = findUmidBinary(existsSync);
  if (!bin) {
    console.error('未找到 Qoder 客户端的 umid/runtime-info 组件。请安装 Qoder 国际版客户端，或用 QODER_UMID_PATH 指定其路径。');
    process.exitCode = 1;
    return;
  }

  let raw: string;
  try {
    raw = execFileSync(bin, ['--account-stdin'], {
      input: '{"account":""}\n',
      encoding: 'utf-8',
      timeout: 20_000,
    });
  } catch (err) {
    console.error(`设备指纹组件执行失败: ${(err as Error).message}`);
    process.exitCode = 1;
    return;
  }

  const identity = parseRuntimeInfo(raw);
  if (!identity) {
    console.error(`无法解析设备身份输出: ${raw.slice(0, 200)}`);
    process.exitCode = 1;
    return;
  }

  const entries: Array<[string, string]> = [
    ['QODER_INTL_COSY_MACHINE_TOKEN', identity.machineToken],
    ['QODER_INTL_COSY_MACHINE_TYPE', identity.machineType],
    ['QODER_INTL_COSY_MACHINE_CODE', identity.machineCode],
  ];

  if (args.includes('--print')) {
    for (const [key, value] of entries) console.log(`${key}=${value}`);
    return;
  }

  const envFile = join(process.cwd(), '.env');
  for (const [key, value] of entries) setEnvValue(envFile, key, value);
  console.log(`已写入 ${envFile}：QODER_INTL_COSY_MACHINE_TOKEN=${mask(identity.machineToken)}`);
  console.log('设备身份与区域绑定：国际版必须用 Qoder 国际版客户端生成，CN 客户端的三件套会被风控拒绝。');
}

main();
