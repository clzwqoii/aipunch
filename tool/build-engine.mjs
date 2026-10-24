#!/usr/bin/env node
// 把 Node 运行时与签到引擎打包进 app Resources，安装后无需仓库即可运行。
// 依赖 esbuild（tsx 的传递依赖）与当前运行的 node 二进制；CI 由 setup-node 提供。
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const resourcesDir = join(root, 'shell/src-tauri/resources');
const engineDir = join(resourcesDir, 'engine');

// 桌面端会调用的脚本；新增 runner 时记得在这里登记
const ENTRIES = {
  cli: 'runners/cli.ts',
  'ci-checkin': 'runners/ci-checkin.ts',
  'ci-sync': 'runners/ci-sync.ts',
  'trae-extract': 'runners/trae-extract.ts',
  'trae-login': 'runners/trae-login.ts',
  'qoder-login': 'runners/qoder-login.ts',
  'codearts-login': 'runners/codearts-login.ts',
  'autoclaw-login': 'runners/autoclaw-login.ts',
  'autoclaw-intl-login': 'runners/autoclaw-intl-login.ts',
  'cf-deploy': 'runners/cf-deploy.ts',
  login: 'runners/login.ts',
};

rmSync(resourcesDir, { recursive: true, force: true });
mkdirSync(engineDir, { recursive: true });

await build({
  entryPoints: Object.entries(ENTRIES).map(([name, file]) => ({ in: join(root, file), out: name })),
  outdir: engineDir,
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  logLevel: 'info',
});

// Cloudflare Workers 执行端脚本（ADR 0004 P2）：桌面端部署 UI 读取此产物上传 CF。
// platform 保持 node 让 node:crypto 留 external（Workers nodejs_compat 运行时提供）。
await build({
  entryPoints: [{ in: join(root, 'cloudflare/worker.ts'), out: 'worker' }],
  outdir: engineDir,
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'es2022',
  logLevel: 'info',
});

copyFileSync(join(root, 'config.json'), join(engineDir, 'config.default.json'));

// 内置 Node 必须是自包含二进制（Homebrew 版依赖 libnode.dylib，不能内嵌）。
// 逐候选复制到临时路径试跑：同一路径反复覆盖已执行过的二进制会触发 SIGKILL。
const nodeName = process.platform === 'win32' ? 'node.exe' : 'node';
const target = join(resourcesDir, nodeName);
const probe = join(tmpdir(), `aipunch-node-${process.pid}${process.platform === 'win32' ? '.exe' : ''}`);

function runnable(bin) {
  try {
    execFileSync(bin, ['-v'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function candidates() {
  const list = [];
  if (process.env.AIPUNCH_NODE_BIN) list.push(process.env.AIPUNCH_NODE_BIN);
  if (!/\/(Cellar|homebrew)\//.test(process.execPath)) list.push(process.execPath);
  const fnmRoot = join(homedir(), '.local/share/fnm/node-versions');
  if (existsSync(fnmRoot)) {
    for (const version of readdirSync(fnmRoot).sort().reverse()) {
      const bin = join(fnmRoot, version, 'installation', 'bin', nodeName);
      if (existsSync(bin)) list.push(bin);
    }
  }
  return list;
}

let chosen;
for (const bin of candidates()) {
  try {
    copyFileSync(bin, probe);
    if (process.platform !== 'win32') chmodSync(probe, 0o755);
  } catch {
    continue;
  }
  if (runnable(probe)) {
    chosen = bin;
    break;
  }
}
rmSync(probe, { force: true });
if (!chosen) {
  throw new Error('找不到自包含的 node 二进制：用 AIPUNCH_NODE_BIN 指定官方 Node 构建');
}
copyFileSync(chosen, target);
if (process.platform !== 'win32') chmodSync(target, 0o755);
const nodeVersion = execFileSync(target, ['-v']).toString().trim();

console.log(`engine: ${Object.keys(ENTRIES).length} bundles + ${nodeName} (${nodeVersion})`);
