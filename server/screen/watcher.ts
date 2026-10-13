import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FrameRow, Store } from '../db.ts';
import { FRAMES_DIR, findScreenTool } from '../paths.ts';
import { log } from '../util.ts';
import { DESKTOP, desktopRequest } from '../desktop.ts';

export interface WindowInfo { id: number; app: string; bundleId: string; pid: number; title: string; width: number; height: number; onScreen: boolean }
interface CaptureResult { ok?: boolean; width?: number; height?: number; mean?: number; thumb?: string; title?: string; app?: string; error?: string; message?: string }

function runTool(args: string[], timeoutMs = 15000): Promise<any> {
  const tool = findScreenTool();
  if (!tool) return Promise.resolve({ error: 'not_built', message: 'Window capture tool not built. Run: bash native/build.sh screen' });
  return new Promise((resolve) => execFile(tool, args, { timeout: timeoutMs, maxBuffer: 4_000_000 }, (err, out) => {
    try { resolve(JSON.parse(out.trim().split('\n').pop() || '{}')); } catch { resolve({ error: 'capture_failed', message: err?.message ?? 'no output' }); }
  }));
}

export const screenPermission = async (): Promise<string> => DESKTOP ? 'granted' : ((await runTool(['--check'], 5000)).screen as string) ?? 'unknown';
export const requestScreenPermission = async (): Promise<string> => DESKTOP ? 'granted' : ((await runTool(['--request'], 60000)).screen as string) ?? 'unknown';
export async function listWindows(): Promise<{ windows: WindowInfo[]; error?: string; message?: string }> {
  if (DESKTOP) return { windows: await desktopRequest<WindowInfo[]>('screen-list') };
  const r = await runTool(['--list']);
  return Array.isArray(r) ? { windows: r as WindowInfo[] } : { windows: [], error: r.error, message: r.message };
}

/** Fraction of thumbnail pixels that changed noticeably (64×48 grayscale). */
export function thumbChange(a: Buffer, b: Buffer): number {
  if (a.length !== b.length || !a.length) return 1;
  let changed = 0;
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > 10) changed++;
  return changed / a.length;
}

/**
 * Decide whether to keep a capture as a new "slide".
 * - vsStored: change compared with the last kept capture.
 * - vsPrev:   change compared with the previous capture (small = the screen has settled).
 * Slides and documents change once and then stay still, so "different and settled" is kept right away.
 * Continuously moving content (video, a talking head) never settles: keep a big scene change after 3 s,
 * otherwise at most one sample every 45 s.
 */
export function shouldStore(vsStored: number, vsPrev: number, msSinceLastStored: number): boolean {
  const settled = vsPrev < 0.005;
  if (vsStored > 0.008 && settled && msSinceLastStored >= 2000) return true;
  if (vsStored > 0.3 && msSinceLastStored >= 3000) return true;
  if (vsStored > 0.02 && msSinceLastStored >= 45000) return true;
  return false;
}

const MAX_FRAMES_PER_SESSION = 400;

/**
 * Captures one window every few seconds while recording. Stores a frame only when the content changed
 * (new slide, new scene); the latest capture is kept separately so "what is on screen now" can be answered.
 */
export class ScreenWatcher extends EventEmitter<{ frame: [FrameRow]; notice: ['info' | 'warning' | 'error', string, string]; state: [] }> {
  readonly sessionId: string;
  readonly windowId: number;
  title: string;
  app: string;
  status: 'capturing' | 'paused' | 'stopped' | 'error' = 'capturing';
  frameCount = 0;
  lastCaptureAt = 0;
  private store: Store;
  private nowT: () => number;
  private intervalMs: number;
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private lastThumb: Buffer | null = null;
  private prevThumb: Buffer | null = null;
  private lastStoredWall = 0;
  private blankWarned = false;
  private dir: string;

  constructor(store: Store, o: { sessionId: string; windowId: number; title?: string; app?: string; nowT: () => number; intervalSec: number }) {
    super();
    this.store = store; this.sessionId = o.sessionId; this.windowId = o.windowId; this.title = o.title ?? ''; this.app = o.app ?? '';
    this.nowT = o.nowT; this.intervalMs = Math.max(1, o.intervalSec) * 1000;
    this.dir = join(FRAMES_DIR, o.sessionId);
    mkdirSync(this.dir, { recursive: true });
    this.frameCount = store.frames(o.sessionId).length;
  }

  get latestPath(): string { return join(this.dir, `latest-${this.windowId}.jpg`); }

  start(): void {
    this.status = 'capturing';
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.emit('state');
  }
  pause(): void { if (this.timer) clearInterval(this.timer); this.timer = null; this.status = 'paused'; this.emit('state'); }
  resume(): void { if (this.status === 'paused') this.start(); }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; this.status = 'stopped'; this.emit('state'); }

  private async capture(): Promise<CaptureResult> {
    if (DESKTOP) {
      const r = await desktopRequest<CaptureResult & { image?: string }>('screen-capture', { id: this.windowId });
      if (r.image) writeFileSync(this.latestPath, Buffer.from(r.image, 'base64'));
      return r;
    }
    return runTool(['--capture', String(this.windowId), '--out', this.latestPath]);
  }

  private async tick(): Promise<void> {
    if (this.busy || this.status !== 'capturing') return;
    this.busy = true;
    try {
      const t = this.nowT();
      const r = await this.capture();
      if (r.error) {
        const msg = r.message ?? r.error;
        if (r.error === 'window_not_found') { this.emit('notice', 'warning', 'window_closed', `Window capture stopped: “${this.title || this.app}” is no longer available.`); this.stop(); }
        else if (r.error === 'permission') { this.emit('notice', 'error', 'screen_permission', msg); this.status = 'error'; this.stop(); }
        else log('screen', `capture failed: ${msg}`);
        return;
      }
      this.lastCaptureAt = Date.now();
      if (r.title) this.title = r.title;
      if (r.app) this.app = r.app;
      if ((r.mean ?? 255) < 3) {
        if (!this.blankWarned) { this.blankWarned = true; this.emit('notice', 'warning', 'screen_blank', 'The captured window is black. Protected (DRM) video and minimized windows cannot be captured.'); }
        return;
      }
      const thumb = Buffer.from(r.thumb ?? '', 'base64');
      const vsStored = this.lastThumb ? thumbChange(this.lastThumb, thumb) : 1;
      const vsPrev = this.prevThumb ? thumbChange(this.prevThumb, thumb) : 0;
      this.prevThumb = thumb;
      if (this.frameCount < MAX_FRAMES_PER_SESSION && (!this.lastThumb || shouldStore(vsStored, vsPrev, Date.now() - this.lastStoredWall))) {
        this.lastThumb = thumb;
        this.lastStoredWall = Date.now();
        this.storeLatest(t, 'slide', r.width ?? null, r.height ?? null);
      }
    } finally {
      this.busy = false;
    }
  }

  private storeLatest(t: number, kind: 'slide' | 'snapshot', width: number | null, height: number | null): FrameRow | null {
    if (!existsSync(this.latestPath)) return null;
    const path = join(this.dir, `${kind}-${Math.round(t)}-${Date.now() % 100000}.jpg`);
    copyFileSync(this.latestPath, path);
    const row = this.store.addFrame({ session_id: this.sessionId, t, path, width, height, kind, window_title: this.title, app: this.app });
    this.frameCount++;
    this.emit('frame', row);
    return row;
  }

  /** Capture right now and keep it (used when a question needs "what is on screen now"). */
  async snapshot(): Promise<FrameRow | null> {
    if (this.status !== 'capturing') return null;
    while (this.busy) await new Promise((r) => setTimeout(r, 50));
    this.busy = true;
    try {
      const t = this.nowT();
      const r = await this.capture();
      if (r.error || (r.mean ?? 255) < 3) return null;
      return this.storeLatest(t, 'snapshot', r.width ?? null, r.height ?? null);
    } finally { this.busy = false; }
  }
}
