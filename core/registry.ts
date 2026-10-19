import type { Provider } from './types.ts';

const providers = new Map<string, Provider>();

export function register(provider: Provider): void {
  if (providers.has(provider.id)) {
    throw new Error(`Provider 重复注册: ${provider.id}`);
  }
  providers.set(provider.id, provider);
}

export function get(id: string): Provider {
  const provider = providers.get(id);
  if (!provider) {
    throw new Error(`未注册的 Provider: ${id}`);
  }
  return provider;
}

export function list(): Provider[] {
  return [...providers.values()];
}

export function has(id: string): boolean {
  return providers.has(id);
}
