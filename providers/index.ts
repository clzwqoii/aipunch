import { register } from '../core/registry.ts';
import { workbuddy } from './workbuddy.ts';
import { qoder } from './qoder.ts';
import { trae } from './trae.ts';
import { autoclaw } from './autoclaw.ts';
import { raccoon } from './raccoon.ts';

// 新增 AI 应用：实现 Provider 后在这里加一行 register
register(workbuddy);
register(qoder);
register(trae);
register(autoclaw);
register(raccoon);
