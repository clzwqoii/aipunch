import { createDecipheriv, createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Trae 客户端登录态解密（算法移植自社区实现，三项目同源：L0NE-6/Trae-AutoCheckin、
// hyang0/trae-checkin、wallechfox/Trae-Checkin）：
//   base64 → [0:6] 头跳过 → rb=[6:38] → enc=[38:]
//   h=sha512(rb)；fh=sha512(h ‖ SALT_A xor SALT_B)；key=fh[:16]；iv=fh[16:32]
//   aes-128-cbc 解密 → 丢弃明文前 64 字节 → PKCS#7 / 零填充去填充 → JSON
// 盐值为社区公开常量（非密钥）；本模块只读本机自有登录态做凭证冷启动，不联网、不写盘。

export const TRAE_STORAGE_SALTS = {
  a: [
    82, 9, 106, 213, 48, 54, 165, 56, 191, 64, 163, 158, 129, 243, 215, 251,
    124, 227, 57, 130, 155, 47, 255, 135, 52, 142, 67, 68, 196, 222, 233, 203,
    84, 123, 148, 50, 166, 194, 35, 61, 238, 76, 149, 11, 66, 250, 195, 78,
    8, 46, 161, 102, 40, 217, 36, 178, 118, 91, 162, 73, 109, 139, 209, 37,
  ],
  b: [
    31, 221, 168, 51, 136, 7, 199, 49, 177, 18, 16, 89, 39, 128, 236, 95,
    96, 81, 127, 169, 25, 181, 74, 13, 45, 229, 122, 159, 147, 201, 156, 239,
    160, 224, 59, 77, 174, 42, 245, 176, 200, 235, 187, 60, 131, 83, 153, 97,
    23, 43, 4, 126, 186, 119, 214, 38, 225, 105, 20, 99, 85, 33, 12, 125,
  ],
};

const STORAGE_KEY = 'iCubeAuthInfo://icube.cloudide';
// 设备号写在键名冒号后，纯十进制 12–20 位（实测 15/16 位均有；UUID 形态不被服务端识别）
const DEVICE_KEY_RE = /^iCubeAuthInfo:\/\/icube-dc:(\d{12,20})$/;
// 客户端各产品变体目录名（wallechfox 实测 TraeWork 变体也存在）
const PRODUCT_DIRS = ['Trae CN', 'TRAE SOLO CN', 'TRAE SOLO', 'Trae', 'TraeWork', 'TraeWork CN'];

export function deriveKeyIv(rb: Buffer): { key: Buffer; iv: Buffer } {
  const h = createHash('sha512').update(rb).digest();
  const saltXor = Buffer.from(TRAE_STORAGE_SALTS.a.map((b, i) => b ^ TRAE_STORAGE_SALTS.b[i]));
  const fh = createHash('sha512').update(Buffer.concat([h, saltXor])).digest();
  return { key: fh.subarray(0, 16), iv: fh.subarray(16, 32) };
}

export function decryptStorageValue(b64: string): string | null {
  try {
    const buf = Buffer.from(b64, 'base64');
    const { key, iv } = deriveKeyIv(buf.subarray(6, 38));
    const decipher = createDecipheriv('aes-128-cbc', key, iv);
    let pt = Buffer.concat([decipher.update(buf.subarray(38)), decipher.final()]);
    pt = pt.subarray(64); // 丢弃客户端写入的 64 字节明文头
    const last = pt[pt.length - 1];
    if (last >= 1 && last <= 16) {
      pt = pt.subarray(0, pt.length - last); // PKCS#7
    } else {
      let end = pt.length;
      while (end > 0 && pt[end - 1] === 0) end -= 1; // 零填充
      pt = pt.subarray(0, end);
    }
    return pt.toString('utf8');
  } catch {
    return null;
  }
}

export function extractDeviceId(keys: string[]): string | null {
  for (const key of keys) {
    const m = DEVICE_KEY_RE.exec(key);
    if (m) return m[1];
  }
  return null;
}

export function extractCredentials(json: string): { refreshToken?: string; token?: string; userId?: string } {
  const pick = (re: RegExp): string | undefined => {
    const m = re.exec(json);
    return m ? m[1] : undefined;
  };
  return {
    refreshToken: pick(/"refreshToken"\s*:\s*"([^"]+)"/),
    token: pick(/"token"\s*:\s*"([^"]+)"/),
    userId: pick(/"userId"\s*:\s*"(\d+)"/),
  };
}

export interface TraeCredentials {
  deviceId: string;
  refreshToken?: string;
  token?: string;
  userId?: string;
  storagePath: string;
}

export function readTraeCredentials(storageJsonPath: string): TraeCredentials | null {
  let entries: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(readFileSync(storageJsonPath, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    entries = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  const deviceId = extractDeviceId(Object.keys(entries));
  if (!deviceId) return null;
  const blob = entries[STORAGE_KEY];
  const plaintext = typeof blob === 'string' ? decryptStorageValue(blob) : null;
  const creds = plaintext ? extractCredentials(plaintext) : {};
  return { deviceId, storagePath: storageJsonPath, ...creds };
}

export function locateStorageJson(opts: { homeDir: string; platform?: NodeJS.Platform }): string | null {
  const platform = opts.platform ?? process.platform;
  const bases =
    platform === 'win32'
      ? [process.env.APPDATA ?? join(opts.homeDir, 'AppData', 'Roaming')]
      : platform === 'darwin'
        ? [join(opts.homeDir, 'Library', 'Application Support')]
        : [join(opts.homeDir, '.config'), opts.homeDir];
  for (const base of bases) {
    for (const product of PRODUCT_DIRS) {
      const candidate = join(base, product, 'User', 'globalStorage', 'storage.json');
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}
