import dns from 'node:dns';

// DNS 兜底：本机代理把 DNS 劫持到 fake-IP 段（198.18.0.0/15）但 TUN 没跑，或系统
// scoped resolver 指向已停的 127.0.0.1 时，所有请求都会连到不可达地址/超时。
// 这里在进程内包装 dns.lookup：系统结果不可用（fake-IP / 报错 / 慢）时并行用 DoH
// （IP 直连，不依赖 DNS）拿真实地址，先到先用。CHECKIN_DNS_DOH=0 可关闭。
export const DEFAULT_DOH_URL = 'https://1.1.1.1/dns-query';

type LookupAddress = { address: string; family: number };
type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address?: string | LookupAddress[],
  family?: number,
) => void;
type PrimaryLookup = (hostname: string, options: Record<string, unknown>, cb: LookupCallback) => void;
type DohResolve = (hostname: string, family?: number) => Promise<LookupAddress[]>;

export function isFakeIp(address: string): boolean {
  return /^198\.1[89]\./.test(address);
}

function toList(address: string | LookupAddress[] | undefined, family?: number): LookupAddress[] {
  if (!address) return [];
  if (typeof address === 'string') return [{ address, family: family ?? 0 }];
  return address;
}

function lookupError(hostname: string, cause?: NodeJS.ErrnoException | null): NodeJS.ErrnoException {
  const err = new Error(`getaddrinfo ENOTFOUND ${hostname}`) as NodeJS.ErrnoException;
  err.code = cause?.code ?? 'ENOTFOUND';
  return err;
}

export function createDohLookup(primary: PrimaryLookup, dohResolve: DohResolve): typeof dns.lookup {
  return ((hostname: string, optionsOrCb: unknown, maybeCb?: unknown) => {
    const options = typeof optionsOrCb === 'object' && optionsOrCb ? (optionsOrCb as Record<string, unknown>) : {};
    const callback = (typeof optionsOrCb === 'function' ? optionsOrCb : maybeCb) as LookupCallback;
    const wantAll = options.all === true;
    const family = typeof options.family === 'number' ? options.family : 0;

    const usable = (list: LookupAddress[]): LookupAddress[] =>
      list.filter((a) => (family === 0 || a.family === family) && !isFakeIp(a.address));

    const primaryResult = new Promise<{ list: LookupAddress[]; err: NodeJS.ErrnoException | null }>((resolve) => {
      primary(hostname, options, (err, address, addrFamily) => {
        resolve({ list: err ? [] : toList(address, addrFamily), err: err ?? null });
      });
    });
    const dohResult = dohResolve(hostname, family || undefined).then(
      (list) => ({ list, err: null }),
      () => ({ list: [] as LookupAddress[], err: null }),
    );

    void (async () => {
      const respond = (list: LookupAddress[]): void => {
        if (wantAll) callback(null, list);
        else callback(null, list[0].address, list[0].family);
      };
      // DoH 先到立即返回，不等挂起的系统 resolver（否则每条请求都要陪它超时）
      const winner = await new Promise<LookupAddress[] | null>((resolve) => {
        void primaryResult.then(({ list }) => {
          const ok = usable(list);
          if (ok.length > 0) resolve(ok);
        });
        void dohResult.then(({ list }) => {
          const ok = usable(list);
          if (ok.length > 0) resolve(ok);
        });
        void Promise.all([primaryResult, dohResult]).then(() => resolve(null));
      });
      if (winner) {
        respond(winner);
        return;
      }
      const [p, d] = await Promise.all([primaryResult, dohResult]);
      const list = p.list.length > 0 ? p.list : d.list;
      if (list.length === 0) {
        callback(lookupError(hostname, p.err));
        return;
      }
      respond(list);
    })();
  }) as unknown as typeof dns.lookup;
}

const cache = new Map<string, LookupAddress[]>();

export async function dohResolve(hostname: string, family?: number): Promise<LookupAddress[]> {
  const key = `${family ?? 0}:${hostname}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const type = family === 6 ? 'AAAA' : 'A';
  const url = `${process.env.CHECKIN_DNS_DOH_URL ?? DEFAULT_DOH_URL}?name=${encodeURIComponent(hostname)}&type=${type}`;
  const res = await fetch(url, {
    headers: { accept: 'application/dns-json' },
    signal: AbortSignal.timeout(4000),
  });
  if (!res.ok) throw new Error(`DoH HTTP ${res.status}`);
  const data = (await res.json()) as { Answer?: Array<{ type: number; data: string }> };
  const list = (data.Answer ?? [])
    .filter((a) => a.type === 1 || a.type === 28)
    .map((a) => ({ address: a.data, family: a.type === 1 ? 4 : 6 }));
  if (list.length > 0) cache.set(key, list);
  return list;
}

let installed = false;

export function installDnsFallback(): boolean {
  if (installed) return false;
  if (process.env.CHECKIN_DNS_DOH === '0') return false;
  const original = dns.lookup.bind(dns) as unknown as PrimaryLookup;
  dns.lookup = createDohLookup(original, dohResolve) as unknown as typeof dns.lookup;
  installed = true;
  return true;
}
