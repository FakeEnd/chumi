import { randomUUID } from 'node:crypto';

export const now = (): number => Date.now();
export const uid = (prefix = ''): string => prefix + randomUUID().replace(/-/g, '').slice(0, 16);

/** Format session-relative milliseconds as m:ss or h:mm:ss. */
export function fmtT(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

/** Parse "m:ss" / "mm:ss" / "h:mm:ss" into ms. */
export function parseT(s: string): number | null {
  const parts = s.trim().split(':').map((x) => Number(x));
  if (parts.some((n) => !Number.isFinite(n))) return null;
  if (parts.length === 2) return (parts[0] * 60 + parts[1]) * 1000;
  if (parts.length === 3) return (parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000;
  return null;
}

export function log(scope: string, ...args: unknown[]): void {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] [${scope}]`, ...args);
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** Deep merge plain objects (arrays replaced). Used for partial settings updates. */
export function deepMerge<T>(base: T, patch: unknown): T {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return (patch as T) ?? base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    const cur = out[k];
    out[k] = cur && typeof cur === 'object' && !Array.isArray(cur) && v && typeof v === 'object' && !Array.isArray(v)
      ? deepMerge(cur, v)
      : v;
  }
  return out as T;
}

/** Normalise a concept/term so "Massively Parallel Reporter Assays" and "massively-parallel reporter assay" dedupe. */
export function termKey(term: string): string {
  return term
    .toLowerCase()
    .normalize('NFKC')
    .replace(/\(.*?\)|（.*?）/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(' ')
    .filter(Boolean)
    .map((w) => (w.length > 4 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w))
    .join(' ')
    .trim();
}

/** Character-trigram Jaccard similarity; works for English and Chinese. */
export function similarity(a: string, b: string): number {
  const grams = (s: string) => {
    const t = s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
    const g = new Set<string>();
    for (let i = 0; i + 3 <= t.length; i++) g.add(t.slice(i, i + 3));
    return g;
  };
  const A = grams(a), B = grams(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

export class AsyncQueue {
  private running = 0;
  private q: Array<{ prio: number; run: () => Promise<void> }> = [];
  private concurrency: number;
  constructor(concurrency: number) { this.concurrency = concurrency; }
  push(run: () => Promise<void>, prio = 0): void {
    this.q.push({ prio, run });
    this.q.sort((a, b) => b.prio - a.prio);
    this.pump();
  }
  get size(): number { return this.q.length + this.running; }
  private pump(): void {
    while (this.running < this.concurrency && this.q.length) {
      const job = this.q.shift()!;
      this.running++;
      job.run().catch(() => {}).finally(() => { this.running--; this.pump(); });
    }
  }
}
