import { register } from '../core/registry.ts';
import { workbuddy } from './workbuddy.ts';

// 新增 AI 应用：实现 Provider 后在这里加一行 register
register(workbuddy);
