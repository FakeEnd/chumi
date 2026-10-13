import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { findHotkeyTool } from './paths.ts';
import { log } from './util.ts';
import { DESKTOP, desktopRequest } from './desktop.ts';

/**
 * Runs the native chumi-hotkey helper, which registers a system-wide shortcut (Carbon hotkey,
 * no Accessibility permission) and reports each press. Restarts it if it exits unexpectedly.
 */
export class HotkeyAgent extends EventEmitter<{ pressed: []; state: [] }> {
  state: 'off' | 'starting' | 'ready' | 'error' | 'missing' = 'off';
  shortcut = '';
  message: string | null = null;
  private proc: ChildProcess | null = null;
  private spec = 'off';
  private restarts = 0;

  configure(spec: string): void {
    if (spec === this.spec && (this.state === 'ready' || this.state === 'starting')) return;
    this.spec = spec;
    this.stopProc();
    if (spec === 'off') {
      if (DESKTOP) void desktopRequest('hotkey', { spec: 'off' }).catch(() => {});
      this.set('off', null); return;
    }
    this.startProc();
  }

  private set(state: HotkeyAgent['state'], message: string | null): void {
    this.state = state; this.message = message;
    this.emit('state');
  }

  private startProc(): void {
    if (DESKTOP) {
      const spec = this.spec;
      this.set('starting', null);
      void desktopRequest<{ registered: boolean; shortcut: string }>('hotkey', { spec }).then((r) => {
        if (this.spec !== spec) return;
        this.shortcut = r.shortcut;
        this.set(r.registered ? 'ready' : 'error', r.registered ? null : 'This shortcut is already used by another app. Choose a different one.');
      }).catch((e) => this.set('error', (e as Error).message));
      return;
    }
    const tool = findHotkeyTool();
    if (!tool) { this.set('missing', 'Shortcut helper not built. Run: bash native/build.sh tools'); return; }
    this.set('starting', null);
    const spec = this.spec;
    const proc = spawn(tool, ['--shortcut', spec], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc = proc;
    let buf = '';
    proc.stdout!.on('data', (d: Buffer) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line) continue;
        try {
          const ev = JSON.parse(line) as { type: string; shortcut?: string; message?: string };
          if (ev.type === 'ready') { this.shortcut = ev.shortcut ?? spec; this.restarts = 0; this.set('ready', null); log('hotkey', `quick-start shortcut ${this.shortcut} ready`); }
          else if (ev.type === 'hotkey') this.emit('pressed');
          else if (ev.type === 'error') this.set('error', ev.message ?? 'Shortcut error');
        } catch { /* ignore */ }
      }
    });
    proc.on('exit', (code) => {
      if (this.proc !== proc) return;
      this.proc = null;
      if (this.spec !== spec || this.spec === 'off') return;
      if (this.state === 'error') return; // e.g. combination already taken: don't loop
      this.set('error', `Shortcut helper exited (code ${code}); restarting…`);
      const delay = Math.min(60_000, 2000 * 2 ** this.restarts++);
      setTimeout(() => { if (this.spec === spec && !this.proc) this.startProc(); }, delay);
    });
  }

  private stopProc(): void {
    const p = this.proc;
    this.proc = null;
    if (p) { p.stdin?.end(); p.kill('SIGTERM'); }
  }

  stop(): void {
    this.spec = 'off'; this.stopProc();
    if (DESKTOP) void desktopRequest('hotkey', { spec: 'off' }).catch(() => {});
  }
}
