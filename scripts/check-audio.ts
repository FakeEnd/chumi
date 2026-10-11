/**
 * Verifies that the native helper captures REAL audio (acceptance criterion 1).
 *
 *   node scripts/check-audio.ts mic 6          # speak while it runs
 *   node scripts/check-audio.ts system 6 --play  # plays a short test sound through the speakers/headphones
 *   node scripts/check-audio.ts both 6 --play
 *
 * Prints per-source frame counts, captured duration and RMS/peak levels, plus the helper's status events.
 * macOS attributes the permission prompt to the app that launched this script (Terminal / iTerm / Chumi.app).
 */
import { spawn, execFile } from 'node:child_process';
import { FrameParser } from '../server/audio/capture.ts';
import { findAudioHelper } from '../server/paths.ts';

const source = process.argv[2] ?? 'mic';
const seconds = Number(process.argv[3] ?? 6);
const play = process.argv.includes('--play');
const helper = findAudioHelper();
if (!helper) { console.error('Audio helper not built. Run: npm run build:native'); process.exit(2); }

const stats = new Map<number, { frames: number; samples: number; sumSq: number; peak: number; nonZero: number }>();
const parser = new FrameParser((src, _ts, s) => {
  const st = stats.get(src) ?? { frames: 0, samples: 0, sumSq: 0, peak: 0, nonZero: 0 };
  st.frames++; st.samples += s.length;
  for (const v of s) { const x = v / 32768; st.sumSq += x * x; if (Math.abs(x) > st.peak) st.peak = Math.abs(x); if (v !== 0) st.nonZero++; }
  stats.set(src, st);
});
const p = spawn(helper, ['--source', source], { stdio: ['pipe', 'pipe', 'pipe'] });
p.stdout.on('data', (d: Buffer) => parser.push(d));
const events: string[] = [];
p.stderr.on('data', (d: Buffer) => { for (const l of d.toString().split('\n')) if (l.trim() && !l.includes('"type":"level"')) events.push(l.trim()); });
let playTimer: NodeJS.Timeout | null = null;
if (play) {
  const sound = '/System/Library/Sounds/Glass.aiff';
  playTimer = setInterval(() => execFile('/usr/bin/afplay', [sound]), 1200);
}
setTimeout(() => {
  if (playTimer) clearInterval(playTimer);
  p.stdin.end(); p.kill('SIGTERM');
}, seconds * 1000);
p.on('exit', (code) => {
  console.log(`helper: ${helper}\nsource: ${source}, ran ${seconds}s, exit code ${code}`);
  for (const e of events) console.log(`  event ${e}`);
  let ok = false;
  for (const [src, st] of stats) {
    const rms = 10 * Math.log10(st.sumSq / Math.max(1, st.samples) + 1e-12);
    const real = st.nonZero / Math.max(1, st.samples) > 0.05 && rms > -75;
    ok ||= real;
    console.log(`  ${src === 2 ? 'system' : 'mic   '}: ${st.frames} frames, ${(st.samples / 16000).toFixed(1)} s audio, RMS ${rms.toFixed(1)} dBFS, peak ${(20 * Math.log10(st.peak + 1e-9)).toFixed(1)} dBFS, non-zero ${(100 * st.nonZero / Math.max(1, st.samples)).toFixed(0)}% → ${real ? 'REAL AUDIO' : 'silent'}`);
  }
  if (!stats.size) console.log('  no audio frames received (check permission events above)');
  process.exit(ok ? 0 : 1);
});
