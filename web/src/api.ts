import { t } from './i18n.ts';

export class ApiError extends Error { status: number; constructor(status: number, msg: string, vars?: Record<string, string | number>) { super(t(msg, vars)); this.status = status; } }

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const request = {
    method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
    headers: { 'content-type': 'application/json', 'x-chumi': '1' },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: opts.signal,
  };
  let r: Response, text: string;
  try { r = await fetch(path, request); text = await r.text(); }
  catch (error) {
    if (error instanceof TypeError) throw new ApiError(0, "Chumi's server isn't reachable. Check the current state before trying again.");
    throw error;
  }
  const data = text ? JSON.parse(text) : null;
  if (!r.ok) throw new ApiError(r.status, data?.error ?? r.statusText, data?.vars);
  return data as T;
}

export function subscribe(handlers: Record<string, (data: any) => void>, onConn: (ok: boolean) => void): () => void {
  let es: EventSource | null = null;
  let closed = false, suspended = false;
  let leader = false, connected = false;
  let retry: ReturnType<typeof setTimeout> | undefined, retryMs = 1000;
  let pending: AbortController | null = null, release: (() => void) | null = null;
  let channel: BroadcastChannel | null = null;
  const events = new Set(Object.keys(handlers)), listening = new Set<string>();
  // Background pages still need notices and hotkey events. Only leaving or freezing a page releases its lock.
  try { if (navigator.locks && typeof BroadcastChannel !== 'undefined') channel = new BroadcastChannel('chumi-events'); } catch { /* Private browsing may disable cross-tab coordination. */ }
  const status = (ok: boolean) => {
    if (connected !== ok) { connected = ok; onConn(ok); }
    if (leader) channel?.postMessage({ type: 'status', ok });
  };
  const listen = () => {
    const source = es;
    if (!source) return;
    for (const event of events) {
      if (listening.has(event)) continue;
      listening.add(event);
      source.addEventListener(event, (e) => {
        if (closed || es !== source) return;
        const data = JSON.parse((e as MessageEvent).data);
        if (leader) channel?.postMessage({ type: 'event', event, data });
        handlers[event]?.(data);
      });
    }
  };
  const connect = () => {
    const source = es = new EventSource('/api/events');
    source.onopen = () => { if (!closed && es === source) { retryMs = 1000; status(true); } };
    source.onerror = () => {
      if (closed || es !== source) return;
      status(false);
      // CONNECTING retries itself; a rejected response can leave the browser permanently CLOSED.
      if (source.readyState !== EventSource.CLOSED) return;
      source.close(); es = null;
      retry = setTimeout(() => { retry = undefined; if (!closed && !suspended) connect(); }, retryMs);
      retryMs = Math.min(retryMs * 2, 30000);
    };
    listening.clear(); listen();
  };
  const stop = () => { clearTimeout(retry); retry = undefined; es?.close(); es = null; listening.clear(); status(false); };
  const hello = () => channel?.postMessage({ type: 'hello', events: Object.keys(handlers) });
  if (channel) channel.onmessage = ({ data: d }) => {
    if (closed || suspended) return;
    if (d.type === 'hello' && Array.isArray(d.events)) {
      for (const event of d.events) if (typeof event === 'string') events.add(event);
      if (leader) { listen(); channel!.postMessage({ type: 'status', ok: connected }); }
    } else if (d.type === 'leader') hello();
    else if (d.type === 'status' && !leader) status(d.ok === true);
    else if (d.type === 'event' && !leader) handlers[d.event]?.(d.data);
  };
  const deactivate = () => {
    suspended = true;
    pending?.abort(); pending = null;
    if (release) { release(); release = null; }
    else stop();
  };
  const activate = () => {
    if (closed || pending || es || retry) return;
    suspended = false;
    if (!channel) { connect(); return; }
    hello();
    const request = pending = new AbortController();
    void navigator.locks.request('chumi-events', { signal: request.signal }, async () => {
      if (closed || request.signal.aborted) return;
      leader = true;
      channel!.postMessage({ type: 'leader' });
      await new Promise<void>((resolve) => {
        release = () => { stop(); leader = false; resolve(); };
        connect();
      });
    }).catch(() => {
      if (closed || request.signal.aborted) return;
      channel?.close(); channel = null; pending = null;
      activate();
    });
  };
  document.addEventListener('freeze', deactivate);
  document.addEventListener('resume', activate);
  window.addEventListener('pagehide', deactivate);
  window.addEventListener('pageshow', activate);
  activate();
  return () => {
    closed = true; deactivate(); channel?.close();
    document.removeEventListener('freeze', deactivate);
    document.removeEventListener('resume', activate);
    window.removeEventListener('pagehide', deactivate);
    window.removeEventListener('pageshow', activate);
  };
}
