export class ApiError extends Error { status: number; constructor(status: number, msg: string) { super(msg); this.status = status; } }

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const r = await fetch(path, {
    method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
    headers: { 'content-type': 'application/json', 'x-chumi': '1' },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await r.text();
  const data = text ? JSON.parse(text) : null;
  if (!r.ok) throw new ApiError(r.status, data?.error ?? r.statusText);
  return data as T;
}

export function subscribe(handlers: Record<string, (data: any) => void>, onConn: (ok: boolean) => void): () => void {
  let es: EventSource | null = null;
  let closed = false;
  const connect = () => {
    es = new EventSource('/api/events');
    es.onopen = () => onConn(true);
    es.onerror = () => { onConn(false); };
    for (const [ev, fn] of Object.entries(handlers)) es.addEventListener(ev, (e) => fn(JSON.parse((e as MessageEvent).data)));
  };
  connect();
  return () => { closed = true; es?.close(); void closed; };
}
