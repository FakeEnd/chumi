import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { EventEmitter } from 'node:events';
import { DATA_DIR, MODELS_DIR, which } from '../paths.ts';
import { log } from '../util.ts';
import { encodeWav } from '../audio/wav.ts';

export interface WhisperSegment { start: number; end: number; text: string; avg_logprob?: number; no_speech_prob?: number }
export interface WhisperResult { text: string; language: string | null; langProbs: Record<string, number>; segments: WhisperSegment[]; ms: number }
export type AsrState = 'stopped' | 'starting' | 'ready' | 'error' | 'missing_binary' | 'missing_model';

const PID_FILE = join(DATA_DIR, 'whisper-server.pid');

/** If a previous Chumi server crashed, its whisper-server may still be running: stop it (only if it really is ours). */
function killStale(): void {
  try {
    const pid = Number(readFileSync(PID_FILE, 'utf8').trim());
    if (!pid) return;
    // Windows' tasklist shows only the program name, not its arguments.
    const cmd = process.platform === 'win32'
      ? execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true }) + MODELS_DIR
      : execFileSync('/bin/ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).trim();
    if (cmd.includes('whisper-server') && cmd.includes(MODELS_DIR)) { process.kill(pid, 'SIGTERM'); log('asr', `stopped stale whisper-server ${pid}`); }
  } catch { /* no pid file or process already gone */ }
  try { rmSync(PID_FILE); } catch { /* ignore */ }
}

function freePort(start: number): Promise<number> {
  return new Promise((resolve) => {
    const tryPort = (p: number) => {
      const srv = createServer();
      srv.once('error', () => tryPort(p + 1));
      srv.once('listening', () => srv.close(() => resolve(p)));
      srv.listen(p, '127.0.0.1');
    };
    tryPort(start);
  });
}

/**
 * Runs whisper.cpp's HTTP server as a separate local process.
 * Transcription is fully independent of the AI provider: no network, no subscription involved.
 */
export class WhisperServer extends EventEmitter<{ state: [AsrState, string | null] }> {
  state: AsrState = 'stopped';
  message: string | null = null;
  private proc: ChildProcess | null = null;
  private port = 0;
  private restarts = 0;
  private wanted = false;
  private startPromise: Promise<void> | null = null;
  lastLatencyMs = 0;

  private opts: { model: string; threads: number };
  constructor(opts: { model: string; threads: number }) { super(); this.opts = opts; }

  get modelPath(): string { return this.opts.model.includes('/') ? this.opts.model : join(MODELS_DIR, this.opts.model); }

  private setState(s: AsrState, msg: string | null = null): void {
    this.state = s; this.message = msg;
    this.emit('state', s, msg);
  }

  configure(opts: { model: string; threads: number }): void {
    const changed = opts.model !== this.opts.model || opts.threads !== this.opts.threads;
    this.opts = opts;
    if (changed && this.proc) { void this.stop().then(() => this.ensure()); }
  }

  ensure(): Promise<void> {
    this.wanted = true;
    if (this.state === 'ready' && this.proc) return Promise.resolve();
    this.startPromise ??= this.start().finally(() => { this.startPromise = null; });
    return this.startPromise;
  }

  private async start(): Promise<void> {
    const bin = which('whisper-server');
    if (!bin) { this.setState('missing_binary', process.platform === 'win32' ? 'whisper.cpp is not installed. Run: powershell -File scripts\\setup.ps1' : 'whisper.cpp is not installed. Run: brew install whisper-cpp'); throw new Error(this.message!); }
    if (!existsSync(this.modelPath)) { this.setState('missing_model', `Speech model not found at ${this.modelPath}. Run: npm run setup`); throw new Error(this.message!); }
    this.setState('starting', 'Loading speech model…');
    killStale();
    this.port = await freePort(8178);
    const args = ['-m', this.modelPath, '--host', '127.0.0.1', '--port', String(this.port), '-l', 'auto', '-t', String(this.opts.threads), '-nth', '0.6'];
    log('asr', 'starting whisper-server', args.join(' '));
    const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    this.proc = proc;
    if (proc.pid) writeFileSync(PID_FILE, String(proc.pid));
    let tail = '';
    const keepTail = (d: Buffer) => { tail = (tail + d.toString()).slice(-4000); };
    proc.stdout!.on('data', keepTail); proc.stderr!.on('data', keepTail);
    proc.on('exit', (code) => {
      this.proc = null;
      try { rmSync(PID_FILE); } catch { /* ignore */ }
      if (!this.wanted) { this.setState('stopped'); return; }
      log('asr', `whisper-server exited (code ${code}). Tail:\n${tail.slice(-800)}`);
      this.setState('error', `Speech engine stopped unexpectedly (code ${code}); restarting…`);
      const delay = Math.min(30000, 1000 * 2 ** this.restarts++);
      setTimeout(() => { if (this.wanted) this.ensure().catch(() => {}); }, delay);
    });
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      if (!this.proc) throw new Error('whisper-server exited during startup');
      try {
        const r = await fetch(`http://127.0.0.1:${this.port}/`, { signal: AbortSignal.timeout(1000) });
        if (r.ok) { this.restarts = 0; this.setState('ready'); log('asr', `whisper-server ready on ${this.port}`); return; }
      } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 300));
    }
    this.setState('error', 'Speech engine did not start within 2 minutes.');
    throw new Error(this.message!);
  }

  async stop(): Promise<void> {
    this.wanted = false;
    const p = this.proc;
    if (!p) return;
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch { /* */ } resolve(); }, 3000);
      p.once('exit', () => { clearTimeout(t); resolve(); });
      p.kill('SIGTERM');
    });
  }

  async transcribe(samples: Int16Array, o: { language: string; prompt?: string; timeoutMs?: number }): Promise<WhisperResult> {
    await this.ensure();
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(encodeWav(samples))], { type: 'audio/wav' }), 'audio.wav');
    form.append('temperature', '0.0');
    form.append('temperature_inc', '0.2');
    form.append('response_format', 'verbose_json');
    form.append('language', o.language);
    if (o.prompt) form.append('prompt', o.prompt);
    const t0 = Date.now();
    const r = await fetch(`http://127.0.0.1:${this.port}/inference`, { method: 'POST', body: form, signal: AbortSignal.timeout(o.timeoutMs ?? 60000) });
    if (!r.ok) throw new Error(`whisper-server HTTP ${r.status}`);
    const j = await r.json() as { text?: string; language?: string; detected_language?: string; language_probabilities?: Record<string, number>; segments?: WhisperSegment[]; error?: string };
    if (j.error) throw new Error(`whisper-server: ${j.error}`);
    this.lastLatencyMs = Date.now() - t0;
    const lang = j.detected_language || j.language || null;
    return { text: (j.text || '').trim(), language: lang, langProbs: j.language_probabilities ?? {}, segments: j.segments ?? [], ms: this.lastLatencyMs };
  }
}
