/**
 * End-to-end acceptance run for Chumi.
 *
 *   node scripts/acceptance.ts                 # offline test provider (no AI quota used), real local Whisper
 *   node scripts/acceptance.ts --provider codex  # also checks answer content with your real ChatGPT-plan provider
 *   node scripts/acceptance.ts --provider claude-cli
 *
 * Starts its own server on a spare port with a throwaway data folder, streams the ~20-minute
 * sample lab meeting through the live pipeline (8× speed), and checks the acceptance criteria.
 * Live microphone / computer-audio capture is covered by scripts/check-audio.sh (needs macOS permissions).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const SAMPLE = join(ROOT, 'samples/lab-meeting/lab-meeting.wav');
const MANIFEST = join(ROOT, 'samples/lab-meeting/manifest.json');
const args = process.argv.slice(2);
const PROVIDER = args.includes('--provider') ? args[args.indexOf('--provider') + 1] : 'mock';
const REAL = PROVIDER !== 'mock';
const SPEED = Number(args.includes('--speed') ? args[args.indexOf('--speed') + 1] : 8);
const PORT = 4890 + Math.floor(Math.random() * 50);
const B = `http://127.0.0.1:${PORT}`;
const DATA = mkdtempSync(join(tmpdir(), 'chumi-accept-'));

type Res = { id: string; name: string; status: 'PASS' | 'FAIL' | 'WARN' | 'MANUAL'; detail: string };
const results: Res[] = [];
const record = (id: string, name: string, status: Res['status'], detail: string) => { results.push({ id, name, status, detail }); console.log(`${status.padEnd(6)} ${id.padEnd(4)} ${name} — ${detail}`); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function api(path: string, body?: unknown, method?: string): Promise<any> {
  const r = await fetch(B + path, { method: method ?? (body !== undefined ? 'POST' : 'GET'), headers: { 'content-type': 'application/json', 'x-chumi': '1' }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const t = await r.text();
  const j = t && r.headers.get('content-type')?.includes('json') ? JSON.parse(t) : t;
  if (!r.ok) throw new Error(`${path}: ${r.status} ${typeof j === 'string' ? j : j.error}`);
  return j;
}
async function until<T>(fn: () => Promise<T | null | undefined | false>, timeoutMs: number, what: string): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) { const v = await fn().catch(() => null); if (v) return v as T; if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`); await sleep(400); }
}

let server: ChildProcess | null = null;
async function startServer(): Promise<void> {
  server = spawn(process.execPath, [join(ROOT, 'server/main.ts')], { env: { ...process.env, CHUMI_DEV: '1', CHUMI_NO_HOTKEY: '1', CHUMI_DATA_DIR: DATA, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout!.on('data', () => {}); server.stderr!.on('data', (d) => process.env.VERBOSE && process.stderr.write(d));
  await until(async () => (await api('/api/state')).live.asr.state === 'ready', 120_000, 'server + speech engine');
}
async function crashServer(): Promise<void> { server?.kill('SIGKILL'); await sleep(800); }

const session = (id: string) => api(`/api/sessions/${id}`);
const output = async (sid: string, oid: string) => (await session(sid)).outputs.find((o: any) => o.id === oid);
const waitOutput = (sid: string, oid: string, ms = REAL ? 240_000 : 30_000) => until(async () => { const o = await output(sid, oid); return o && !['pending', 'streaming'].includes(o.status) ? o : null; }, ms, `output ${oid}`);

async function main(): Promise<void> {
  if (!existsSync(SAMPLE)) throw new Error('Sample missing: run `npm run sample` first.');
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  console.log(`Data dir: ${DATA}\nProvider: ${PROVIDER}${REAL ? ' (REAL — uses your plan allowance)' : ' (offline test stub — no AI calls)'}\n`);
  await startServer();
  await api('/api/settings', { ai: { provider: PROVIDER }, assist: { autoOverview: true, autoExplain: false } }, 'PUT');
  if (!REAL) await api('/api/dev/mock', { failMode: null, delayMs: 2500 });
  const prov = await api('/api/provider/status?refresh=1');
  if (REAL && !prov.ready) throw new Error(`Provider not ready: ${prov.state} — ${prov.message ?? ''}`);

  // ---------------------------------------------------------------- live session from the sample
  const { session: s } = await api('/api/session/start', { title: 'Acceptance: lab meeting sample', type: 'lab_meeting', source: 'file', filePath: SAMPLE, speed: SPEED });
  const sid = s.id;
  await until(async () => (await session(sid)).segments.at(-1)?.t_end > 180_000, 180_000, '3 minutes of transcript');

  // C2 + C3: catch-up while transcription continues; answer states its interval
  const n0 = (await session(sid)).segments.length;
  const { id: cu } = await api('/api/ai/catchup', { sessionId: sid, scope: '2m' });
  const pendingCounts: number[] = [];
  const cuOut = await until(async () => { const d = await session(sid); pendingCounts.push(d.segments.length); const o = d.outputs.find((x: any) => x.id === cu); return o && !['pending', 'streaming'].includes(o.status) ? o : null; }, REAL ? 240_000 : 30_000, 'catch-up');
  const grew = Math.max(...pendingCounts) > n0;
  record('C2', 'Transcription continues during a catch-up', grew ? 'PASS' : 'FAIL', `segments ${n0} → ${Math.max(...pendingCounts)} while the catch-up was in flight`);
  const rc = cuOut.data?.refCheck;
  record('C3', 'Answers identify the transcript interval', cuOut.status === 'done' && cuOut.covered_from != null && cuOut.covered_to - cuOut.covered_from <= 140_000 /* 2 min + the line straddling the boundary (≤ 15 s) */ && rc?.invalid?.length === 0 ? 'PASS' : 'FAIL',
    `covers ${(cuOut.covered_from / 1000).toFixed(0)}–${(cuOut.covered_to / 1000).toFixed(0)} s, ${rc?.total ?? 0} citations, ${rc?.invalid?.length ?? '?'} unsupported`);
  const nAfter = (await session(sid)).segments.length;
  const again = await output(sid, cu);
  record('C2b', 'Catch-up stays stable while new speech arrives', again.content === cuOut.content && nAfter >= n0 ? 'PASS' : 'FAIL', 'content unchanged after more transcript arrived; refresh is explicit');

  // C5: auto-explain off suppresses pending unsolicited cards
  if (!REAL) await api('/api/dev/mock', { delayMs: 3000 });
  await api('/api/settings', { assist: { autoExplain: true } }, 'PUT');
  const before = (await session(sid)).outputs.filter((o: any) => o.kind === 'auto_explain').length;
  const statsBefore = (await api('/api/dev/stats')).assistant;
  const forced = await api('/api/dev/auto-explain/force', { sessionId: sid });
  await sleep(300);
  await api('/api/settings', { assist: { autoExplain: false } }, 'PUT');
  await sleep(REAL ? 30_000 : 4500);
  const after = (await session(sid)).outputs.filter((o: any) => o.kind === 'auto_explain').length;
  const statsAfter = (await api('/api/dev/stats')).assistant;
  record('C5', 'Turning auto-explain off suppresses pending cards', forced.started && after === before && statsAfter.suppressedAuto > statsBefore.suppressedAuto ? 'PASS' : 'FAIL',
    `check started=${forced.started}; visible cards ${before} → ${after}; suppressed ${statsBefore.suppressedAuto} → ${statsAfter.suppressedAuto}`);
  // positive control: with the switch on, a card does appear and is not repeated
  if (!REAL) await api('/api/dev/mock', { delayMs: 400 });
  await api('/api/settings', { assist: { autoExplain: true } }, 'PUT');
  await api('/api/dev/auto-explain/force', { sessionId: sid });
  const cards = await until(async () => { const c = (await session(sid)).outputs.filter((o: any) => o.kind === 'auto_explain'); return c.length > 0 ? c : null; }, REAL ? 120_000 : 15_000, 'an auto-explain card').catch(() => []);
  await api('/api/dev/auto-explain/force', { sessionId: sid }); await sleep(REAL ? 60_000 : 2000);
  const cards2 = (await session(sid)).outputs.filter((o: any) => o.kind === 'auto_explain');
  const terms = cards2.map((c: any) => (c.question ?? '').toLowerCase());
  record('C5b', 'Auto-explain on: cards appear once (no repeats)', cards.length > 0 && new Set(terms).size === terms.length ? 'PASS' : REAL ? 'WARN' : 'FAIL', `cards: ${terms.join(', ') || 'none'}`);
  await api('/api/settings', { assist: { autoExplain: false } }, 'PUT');

  // C4: explanation depth and domain familiarity change the request; per-question depth leaves the profile untouched
  const profile0 = await api('/api/profile');
  const sel = { fromT: 25_000, toT: 40_000, text: 'lenti MPRA' };
  const ex = async (depth: string) => { const { id } = await api('/api/ai/explain', { sessionId: sid, term: 'MPRA', selection: sel, depth }); return waitOutput(sid, id); };
  const q = await ex('quick');
  const d = await ex('deep');
  const profile1 = await api('/api/profile');
  let c4 = JSON.stringify(profile0) === JSON.stringify(profile1);
  let c4detail = `profile unchanged after quick+deep requests: ${c4}`;
  if (!REAL) {
    const calls = await api('/api/dev/mock-calls');
    const ins = calls.filter((c: any) => c.task === 'explain').map((c: any) => c.instructions as string);
    const quickOk = ins.some((i: string) => i.includes('DEPTH = QUICK')), deepOk = ins.some((i: string) => i.includes('DEPTH = DEEP'));
    await api('/api/profile', { ...profile0, domains: profile0.domains.map((x: any) => x.name.startsWith('Wet-lab') ? { ...x, level: 4 } : x) }, 'PUT');
    await ex('standard');
    const calls2 = await api('/api/dev/mock-calls');
    const famOk = calls2.at(-1).instructions.includes('Wet-lab experimental techniques: expert') && ins.some((i: string) => i.includes('Wet-lab experimental techniques: introductory'));
    await api('/api/profile', profile0, 'PUT');
    c4 = c4 && quickOk && deepOk && famOk;
    c4detail += `; quick/deep guides in prompt: ${quickOk}/${deepOk}; familiarity change reflected: ${famOk}`;
  } else {
    const ql = (q.content ?? '').length, dl = (d.content ?? '').length;
    c4 = c4 && dl > ql * 1.5;
    c4detail += `; answer length quick=${ql} chars, deep=${dl} chars`;
  }
  record('C4', 'Depth and familiarity affect responses; profile untouched', c4 ? 'PASS' : REAL ? 'WARN' : 'FAIL', c4detail);

  // C11 + C12: explanation language switch and window-capture images reach the AI request
  if (!REAL) {
    const prof = await api('/api/profile');
    await api('/api/profile', { ...prof, explanationLanguage: 'English' }, 'PUT');
    const { id: en } = await api('/api/ai/explain', { sessionId: sid, term: 'enhancer', depth: 'quick' });
    await waitOutput(sid, en);
    const enCall = (await api('/api/dev/mock-calls')).at(-1);
    await api('/api/profile', { ...prof, explanationLanguage: '中文' }, 'PUT');
    const back = await api('/api/profile');
    const { id: zh } = await api('/api/ai/explain', { sessionId: sid, term: 'enhancer', depth: 'quick' });
    await waitOutput(sid, zh);
    const zhCall = (await api('/api/dev/mock-calls')).at(-1);
    record('C11', 'Explanation language can be English or Chinese', /Write everything in English/.test(enCall.instructions) && /Simplified Chinese/.test(zhCall.instructions) && back.explanationLanguage === 'Simplified Chinese' ? 'PASS' : 'FAIL',
      `English rule in prompt: ${/Write everything in English/.test(enCall.instructions)}; "中文" normalised to "${back.explanationLanguage}"`);

    const jpg = join(DATA, 'slide.jpg');
    writeFileSync(jpg, Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==', 'base64'));
    const fr = await api('/api/dev/inject-frame', { sessionId: sid, path: jpg });
    const { id: qs } = await api('/api/ai/ask', { sessionId: sid, question: 'What is on this slide?', depth: 'quick', frameIds: [fr.id] });
    const qso = await waitOutput(sid, qs);
    const call = (await api('/api/dev/mock-calls')).at(-1);
    const img = await fetch(`${B}/api/frames/${fr.id}`);
    const ok = call.input.includes('SCREEN CAPTURES ATTACHED') && qso.data?.images?.length === 1 && img.ok && img.headers.get('content-type') === 'image/jpeg';
    record('C12', 'Window captures are attached to questions and viewable', ok ? 'PASS' : 'FAIL', `capture listed in prompt: ${call.input.includes('SCREEN CAPTURES ATTACHED')}; card shows ${qso.data?.images?.length ?? 0} capture; image served: ${img.status}`);
  }

  // C13: reasoning effort — default from Settings, per-question override, background stays low
  if (!REAL) {
    await api('/api/settings', { ai: { effort: 'xhigh', backgroundEffort: 'low' } }, 'PUT');
    const { id: e1 } = await api('/api/ai/ask', { sessionId: sid, question: 'Why use a negative binomial model?', depth: 'standard' });
    const o1 = await waitOutput(sid, e1);
    const c1 = (await api('/api/dev/mock-calls')).at(-1);
    const { id: e2 } = await api('/api/ai/ask', { sessionId: sid, question: 'Short version?', depth: 'quick', effort: 'max' });
    await waitOutput(sid, e2);
    const c2 = (await api('/api/dev/mock-calls')).at(-1);
    const { id: e3 } = await api('/api/ai/recap', { sessionId: sid });
    await waitOutput(sid, e3);
    const c3 = (await api('/api/dev/mock-calls')).filter((c: any) => c.task === 'overview').at(-1);
    await api('/api/settings', { ai: { effort: 'auto' } }, 'PUT');
    const ok = c1.effort === 'xhigh' && o1.data?.effort === 'xhigh' && c2.effort === 'max' && (!c3 || c3.effort === 'low');
    record('C13', 'Reasoning effort: default, per-question override, background low', ok ? 'PASS' : 'FAIL', `default→${c1.effort} (card shows ${o1.data?.effort}); override→${c2.effort}; overview→${c3?.effort ?? 'n/a'}`);
  }

  // C8: model outage / quota limit does not erase captured content or activate a paid fallback
  if (!REAL) {
    const providerBefore = (await api('/api/settings')).ai.provider;
    await api('/api/dev/mock', { failMode: 'quota', delayMs: 200 });
    const nA = (await session(sid)).segments.length;
    const { id: qa } = await api('/api/ai/ask', { sessionId: sid, question: 'What are they discussing right now?', depth: 'quick' });
    const qo = await waitOutput(sid, qa);
    await api('/api/dev/mock', { failMode: 'network' });
    const { id: qb } = await api('/api/ai/catchup', { sessionId: sid, scope: '5m' });
    const qbo = await waitOutput(sid, qb);
    await sleep(3000);
    const nB = (await session(sid)).segments.length;
    const st = await api('/api/settings');
    await api('/api/dev/mock', { failMode: null, delayMs: 300 });
    const ok = qo.status === 'error' && /Transcription continues/.test(qo.error) && qbo.status === 'error' && nB > nA && st.ai.provider === providerBefore;
    record('C8', 'Outage/quota keeps captured content; no paid fallback', ok ? 'PASS' : 'FAIL', `quota error shown: "${qo.error?.slice(0, 70)}…"; network error shown: ${qbo.status === 'error'}; segments ${nA} → ${nB}; provider still "${st.ai.provider}"`);
  } else record('C8', 'Outage/quota keeps captured content; no paid fallback', 'MANUAL', 'run the offline acceptance (no --provider) for the simulated failure test');

  // let the sample finish, then end the session
  const total = manifest.durationMs ?? manifest.totalMs ?? 1_243_000;
  await until(async () => (await api('/api/state')).live.warnings.some((w: any) => w.code === 'file_finished') || (await session(sid)).segments.at(-1)?.t_end > total - 15_000, 600_000, 'end of sample');
  const ended = await api('/api/session/end', {});
  const fin = await session(sid);
  record('C9a', 'Ending saves the final transcript', fin.session.status === 'ended' && fin.segments.length > 100 && fin.timeline.some((e: any) => e.kind === 'stop') ? 'PASS' : 'FAIL', `${fin.segments.length} segments, status ${fin.session.status}`);
  const sum = ended.summaryId ? await waitOutput(sid, ended.summaryId, REAL ? 300_000 : 30_000) : null;
  record('C9b', 'Ending saves the final summary', sum?.status === 'done' && (sum.content ?? '').length > 50 ? 'PASS' : 'FAIL', sum ? `${sum.status}, ${sum.content?.length ?? 0} chars, ${sum.data?.refCheck?.total ?? 0} citations (${sum.data?.refCheck?.invalid?.length ?? '?'} unsupported)` : 'no summary started');

  // C6 + C7: uncertainty / deadlines (needs a real model) and references resolve to transcript
  if (REAL && sum?.content) {
    const c = sum.content as string;
    const tentative = /(preliminary|tentative|not (yet )?confirmed|unconfirmed|batch (effect|artifact)|初步|尚未|未确认|待验证|不确定|批次)/i.test(c);
    const noDeadline = /(chromosome|染色体)[\s\S]{0,300}(not stated|未说明|未提及|未明确|没有明确|未指定|unspecified)/i.test(c) || /(not stated|未说明|未提及|未明确)[\s\S]{0,300}(chromosome|染色体)/i.test(c);
    const friday = /(Friday|周五|星期五)/i.test(c);
    record('C6', 'Summary keeps uncertainty; unspecified deadline stays unknown', tentative && noDeadline && friday ? 'PASS' : 'WARN', `tentative GATA language: ${tentative}; holdout rerun deadline "not stated": ${noDeadline}; Friday deadline kept: ${friday}`);
  } else record('C6', 'Summary keeps uncertainty; unspecified deadline stays unknown', 'MANUAL', 'needs a real model: run with --provider codex (or claude-cli) when your plan allowance is available; prompt rules are unit-tested');
  const allOuts = fin.outputs.filter((o: any) => o.status === 'done' && o.data?.refCheck);
  const tot = allOuts.reduce((n: number, o: any) => n + o.data.refCheck.total, 0), bad = allOuts.reduce((n: number, o: any) => n + o.data.refCheck.invalid.length, 0);
  record('C7', 'Transcript references lead to supporting passages', tot > 0 && bad === 0 ? 'PASS' : bad / Math.max(1, tot) < 0.05 ? 'WARN' : 'FAIL', `${tot} citations checked across ${allOuts.length} answers; ${bad} without a transcript line within ±15 s (UI jumps to and highlights the cited lines)`);

  // C10: reopen + export
  const md = await api(`/api/sessions/${sid}/export?format=md`);
  const txt = await api(`/api/sessions/${sid}/export?format=txt`);
  const list = await api('/api/sessions?q=chromosome');
  record('C10', 'Saved sessions reopen, search and export', fin.segments.length > 0 && md.includes('## Transcript (raw)') && md.includes('## Summary (AI-generated)') && !txt.includes('## ') && list.sessions.some((x: any) => x.id === sid) ? 'PASS' : 'FAIL',
    `markdown ${md.length} chars, text ${txt.length} chars, full-text search finds the session`);

  // transcript quality spot-checks against the sample manifest
  const text = fin.segments.map((x: any) => x.text).join(' ');
  const zhLines = fin.segments.filter((x: any) => x.lang === 'zh').length;
  const expectZh = manifest.lines.filter((l: any) => l.tags?.includes('mandarin')).length;
  const hits = ['MPRA', 'GATA', 'chromosome', 'negative binomial', 'barcode', 'Friday', 'replicate'].filter((k) => text.toLowerCase().includes(k.toLowerCase()));
  record('Q1', 'Transcript quality on the sample', hits.length >= 6 && zhLines >= expectZh * 0.7 ? 'PASS' : 'WARN', `key terms found: ${hits.join(', ')}; Mandarin transcript lines: ${zhLines} (sample has ${expectZh} Mandarin turns)`);

  // R1: crash while recording → content kept, session marked interrupted, resumable with a gap marker
  const { session: s2 } = await api('/api/session/start', { title: 'Acceptance: crash test', type: 'lecture', source: 'file', filePath: SAMPLE, speed: SPEED });
  await until(async () => (await session(s2.id)).segments.length >= 5, 120_000, 'segments before crash');
  const kept = (await session(s2.id)).segments.length;
  await crashServer();
  await startServer();
  const r2 = await session(s2.id);
  await api(`/api/sessions/${s2.id}/resume`, { source: 'file', filePath: SAMPLE, speed: SPEED });
  await sleep(4000);
  await api('/api/session/end', {});
  const r3 = await session(s2.id);
  const gap = r3.timeline.find((e: any) => e.kind === 'gap');
  record('R1', 'Restart keeps saved content and marks the recording gap', r2.session.status === 'interrupted' && r2.segments.length >= kept && r2.timeline.some((e: any) => e.kind === 'interrupted') && !!gap ? 'PASS' : 'FAIL',
    `after crash: status ${r2.session.status}, ${r2.segments.length}/${kept} segments kept; gap marker: "${gap?.detail ?? 'none'}"`);

  record('C1', 'Microphone and computer-audio capture real audio', 'MANUAL', 'see scripts/check-audio.sh and the manual checklist in README (needs macOS permission prompts)');
}

main().catch((e) => { record('ERR', 'Acceptance run aborted', 'FAIL', (e as Error).message); }).finally(async () => {
  server?.kill('SIGTERM');
  await sleep(1500);
  const fails = results.filter((r) => r.status === 'FAIL').length;
  console.log(`\n${results.filter((r) => r.status === 'PASS').length} pass · ${fails} fail · ${results.filter((r) => r.status === 'WARN').length} warn · ${results.filter((r) => r.status === 'MANUAL').length} manual`);
  if (!process.env.KEEP_DATA) rmSync(DATA, { recursive: true, force: true });
  process.exit(fails ? 1 : 0);
});
