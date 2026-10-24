import { homedir } from 'node:os';
import { join } from 'node:path';
import { locateStorageJson, readTraeCredentials } from '../core/trae-storage.ts';
import { setEnvValue } from '../core/dotenv.ts';

// 从本机 Trae 客户端登录态提取凭证（冷启动，与 `npm run login` 同用途）：
// 设备号来自 storage.json 键名（无需解密），refreshToken/token 来自解密 cloudide  blob。
// 用法：npm run trae-extract [-- --path <storage.json>] [-- --print]
//  默认写入 .env（gitignored）；--print 输出到终端（自行复制到 GitHub Secret 用）
//  终端只显示掩码，完整 token 不打印，避免泄露到日志/截图。
function mask(value: string): string {
  return value.length <= 8 ? '****' : `${value.slice(0, 6)}…${value.slice(-4)} (len=${value.length})`;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const pathFlag = args.indexOf('--path');
  const storagePath =
    pathFlag >= 0 ? args[pathFlag + 1] : locateStorageJson({ homeDir: homedir() });
  if (!storagePath) {
    console.error('未找到 Trae 客户端登录态（storage.json）。请先在本机 Trae 客户端登录，或用 --path 指定文件。');
    process.exitCode = 1;
    return;
  }
  const creds = readTraeCredentials(storagePath);
  if (!creds) {
    console.error(`${storagePath} 中未解析到设备号（iCubeAuthInfo://icube-dc:<数字>）。`);
    process.exitCode = 1;
    return;
  }

  console.log(`storage: ${storagePath}`);
  console.log(`TRAE_DEVICE_ID=${creds.deviceId}`);
  if (!creds.refreshToken) {
    console.error('未解出 refreshToken：客户端可能未登录或登录态结构已变化。');
    process.exitCode = 1;
    return;
  }
  console.log(`TRAE_REFRESH_TOKEN=${mask(creds.refreshToken)}`);
  if (creds.userId) console.log(`TRAE_USER_ID=${creds.userId}`);

  if (args.includes('--print')) return;

  const envFile = join(process.env.AIPUNCH_WORK_DIR ?? process.cwd(), '.env');
  setEnvValue(envFile, 'TRAE_REFRESH_TOKEN', creds.refreshToken);
  setEnvValue(envFile, 'TRAE_DEVICE_ID', creds.deviceId);
  if (creds.userId) setEnvValue(envFile, 'TRAE_USER_ID', creds.userId);
  console.log(`已写入 ${envFile}（token 不明文显示）`);
}

main().catch((err: unknown) => {
  console.error(`提取失败: ${(err as Error).message}`);
  process.exitCode = 1;
});
