#!/usr/bin/env node
// make-sample.mjs: render a scripted multi-speaker dialogue to a single WAV
// using macOS `say`, for testing Chumi's transcription and summaries.
//
// Usage:
//   node scripts/make-sample.mjs [--script <script.json>] [--out-dir <dir>]
//                                [--cache-dir <dir>] [--no-cache]
//
// Defaults: --script samples/lab-meeting/script.json, --out-dir = the folder
// containing the script, --cache-dir = $CHUMI_SAMPLE_CACHE or
// <os tmpdir>/chumi-sample-cache.
//
// Output (in --out-dir):
//   lab-meeting.wav  (16 kHz, mono, 16-bit PCM WAV; name = script folder name)
//   manifest.json    (total duration + per-line {index, speaker, startMs,
//                     endMs, text, tags})
//
// No dependencies. Requires macOS `say` and Node 18+.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SAMPLE_RATE = 16000;
const CHANNELS = 1;
const BITS = 16;
const BYTES_PER_SAMPLE = BITS / 8;
const SAY_FORMAT = `LEI16@${SAMPLE_RATE}`;
// Bump when the rendering pipeline changes so stale cache entries are ignored.
const CACHE_VERSION = 'v1';
// Samples below this absolute amplitude count as silence when trimming the
// edges of each rendered line (say pads its output with a little silence).
const SILENCE_THRESHOLD = 48;
const EDGE_MARGIN_MS = 40;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const args = { cache: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`Missing value for ${a}`);
      return v;
    };
    if (a === '--script') args.script = next();
    else if (a === '--out-dir') args.outDir = next();
    else if (a === '--cache-dir') args.cacheDir = next();
    else if (a === '--no-cache') args.cache = false;
    else if (a === '-h' || a === '--help') args.help = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return args;
}

// ---------------------------------------------------------------- WAV I/O

/** Parse a RIFF/WAVE buffer; walk all chunks and return fmt info + PCM data. */
function parseWav(buf, label = 'wav') {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error(`${label}: not a RIFF/WAVE file`);
  }
  let fmt = null;
  let data = null;
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    let size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    // Some writers leave a placeholder size (0 / 0xFFFFFFFF) on the data chunk.
    if (body + size > buf.length) size = buf.length - body;
    if (id === 'fmt ') {
      fmt = {
        audioFormat: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bitsPerSample: buf.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      data = buf.subarray(body, body + size);
    }
    off = body + size + (size % 2); // chunks are word-aligned
  }
  if (!fmt) throw new Error(`${label}: no fmt chunk`);
  if (!data) throw new Error(`${label}: no data chunk`);
  // WAVE_FORMAT_EXTENSIBLE (0xFFFE) with PCM subformat is also acceptable.
  if (fmt.audioFormat !== 1 && fmt.audioFormat !== 0xfffe) {
    throw new Error(`${label}: expected PCM, got format ${fmt.audioFormat}`);
  }
  if (fmt.channels !== CHANNELS || fmt.sampleRate !== SAMPLE_RATE || fmt.bitsPerSample !== BITS) {
    throw new Error(
      `${label}: expected ${CHANNELS}ch ${SAMPLE_RATE}Hz ${BITS}-bit, got ` +
        `${fmt.channels}ch ${fmt.sampleRate}Hz ${fmt.bitsPerSample}-bit`,
    );
  }
  return { fmt, data };
}

function wavHeader(dataBytes) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'ascii');
  h.writeUInt32LE(36 + dataBytes, 4);
  h.write('WAVE', 8, 'ascii');
  h.write('fmt ', 12, 'ascii');
  h.writeUInt32LE(16, 16); // fmt chunk size
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(CHANNELS, 22);
  h.writeUInt32LE(SAMPLE_RATE, 24);
  h.writeUInt32LE(SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE, 28); // byte rate
  h.writeUInt16LE(CHANNELS * BYTES_PER_SAMPLE, 32); // block align
  h.writeUInt16LE(BITS, 34);
  h.write('data', 36, 'ascii');
  h.writeUInt32LE(dataBytes, 40);
  return h;
}

/** Trim leading/trailing near-silence, keeping a small margin. */
function trimSilence(pcm) {
  const n = Math.floor(pcm.length / BYTES_PER_SAMPLE);
  let first = 0;
  while (first < n && Math.abs(pcm.readInt16LE(first * 2)) < SILENCE_THRESHOLD) first++;
  if (first === n) return pcm.subarray(0, 0);
  let last = n - 1;
  while (last > first && Math.abs(pcm.readInt16LE(last * 2)) < SILENCE_THRESHOLD) last--;
  const margin = Math.round((EDGE_MARGIN_MS / 1000) * SAMPLE_RATE);
  const start = Math.max(0, first - margin);
  const end = Math.min(n, last + 1 + margin);
  return pcm.subarray(start * 2, end * 2);
}

const msToSamples = (ms) => Math.round((ms / 1000) * SAMPLE_RATE);
const samplesToMs = (s) => Math.round((s / SAMPLE_RATE) * 1000);

function mmss(ms) {
  const total = Math.floor(ms / 1000);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

// ---------------------------------------------------------------- text stats

const CJK_RE = /[㐀-䶿一-鿿豈-﫿]/g;

/** English-style tokens plus Chinese characters (each counted as one word). */
function countWords(text) {
  const cjk = (text.match(CJK_RE) || []).length;
  const latin = text
    .replace(CJK_RE, ' ')
    .split(/[\s　-〿＀-￯]+/)
    .filter((t) => /[A-Za-z0-9]/.test(t)).length;
  return { latin, cjk, total: latin + cjk };
}

// ---------------------------------------------------------------- rendering

function renderLine({ voice, rate, text }, cacheDir, useCache, workDir) {
  const key = createHash('sha256')
    .update(JSON.stringify([CACHE_VERSION, voice, rate, text, SAY_FORMAT]))
    .digest('hex')
    .slice(0, 32);
  const cached = path.join(cacheDir, `${key}.wav`);
  if (useCache && fs.existsSync(cached)) {
    return { buf: fs.readFileSync(cached), cached: true, key };
  }
  const tmpOut = path.join(workDir, `${key}.${process.pid}.wav`);
  const sayArgs = ['-v', voice, '-r', String(rate), '-o', tmpOut, `--data-format=${SAY_FORMAT}`, '--file-format=WAVE'];
  let tmpText = null;
  if (text.startsWith('-')) {
    // Avoid the text being parsed as an option.
    tmpText = path.join(workDir, `${key}.${process.pid}.txt`);
    fs.writeFileSync(tmpText, text, 'utf8');
    sayArgs.push('-f', tmpText);
  } else {
    sayArgs.push(text);
  }
  execFileSync('say', sayArgs, { stdio: ['ignore', 'ignore', 'pipe'] });
  if (tmpText) fs.rmSync(tmpText, { force: true });
  const buf = fs.readFileSync(tmpOut);
  if (useCache) fs.renameSync(tmpOut, cached);
  else fs.rmSync(tmpOut, { force: true });
  return { buf, cached: false, key };
}

// ---------------------------------------------------------------- main

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 19).join('\n'));
    return;
  }
  const scriptPath = path.resolve(args.script ?? path.join(repoRoot, 'samples/lab-meeting/script.json'));
  const outDir = path.resolve(args.outDir ?? path.dirname(scriptPath));
  const cacheDir = path.resolve(
    args.cacheDir ?? process.env.CHUMI_SAMPLE_CACHE ?? path.join(os.tmpdir(), 'chumi-sample-cache'),
  );
  const baseName = path.basename(path.dirname(scriptPath)) || 'sample';
  fs.mkdirSync(outDir, { recursive: true });
  fs.mkdirSync(cacheDir, { recursive: true });
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chumi-say-'));

  const script = JSON.parse(fs.readFileSync(scriptPath, 'utf8'));
  if (!script.speakers || !Array.isArray(script.lines) || script.lines.length === 0) {
    throw new Error(`${scriptPath}: expected {speakers, lines[]}`);
  }
  const leadInMs = script.leadInMs ?? 500;
  const tailMs = script.tailMs ?? 1000;
  const defaultPause = script.defaultPauseMs ?? 600;

  const chunks = [];
  let cursor = 0; // in samples
  const pushSilence = (ms) => {
    const n = msToSamples(ms);
    if (n > 0) {
      chunks.push(Buffer.alloc(n * BYTES_PER_SAMPLE));
      cursor += n;
    }
  };

  pushSilence(leadInMs);
  const manifestLines = [];
  const words = { latin: 0, cjk: 0, total: 0 };
  const perSpeaker = {};
  let hits = 0;
  const t0 = Date.now();

  script.lines.forEach((line, index) => {
    const spk = script.speakers[line.speaker];
    if (!spk) throw new Error(`line ${index}: unknown speaker "${line.speaker}"`);
    if (!line.text || !line.text.trim()) throw new Error(`line ${index}: empty text`);
    const voice = spk.voice;
    const rate = line.rate ?? spk.rate ?? 180;
    let rendered;
    try {
      rendered = renderLine({ voice, rate, text: line.text }, cacheDir, args.cache, workDir);
    } catch (err) {
      throw new Error(`line ${index} (${line.speaker}/${voice}): say failed: ${err.stderr?.toString() || err.message}`);
    }
    if (rendered.cached) hits++;
    const { data } = parseWav(rendered.buf, `line ${index}`);
    const pcm = trimSilence(data);
    const nSamples = pcm.length / BYTES_PER_SAMPLE;
    if (nSamples === 0) throw new Error(`line ${index} (${voice}): rendered silence`);

    const startMs = samplesToMs(cursor);
    chunks.push(pcm);
    cursor += nSamples;
    const endMs = samplesToMs(cursor);
    pushSilence(line.pauseAfterMs ?? defaultPause);

    const wc = countWords(line.text);
    words.latin += wc.latin;
    words.cjk += wc.cjk;
    words.total += wc.total;
    const ps = (perSpeaker[line.speaker] ??= { voice, lines: 0, speechMs: 0, words: 0, minMsPerWord: Infinity });
    ps.lines++;
    ps.speechMs += endMs - startMs;
    ps.words += wc.total;
    ps.minMsPerWord = Math.min(ps.minMsPerWord, (endMs - startMs) / Math.max(1, wc.total));

    manifestLines.push({ index, speaker: line.speaker, startMs, endMs, text: line.text, tags: line.tags ?? [] });
    const n = script.lines.length;
    if (process.stdout.isTTY) process.stdout.write(`\r  rendered ${index + 1}/${n}`);
    else if ((index + 1) % 25 === 0 || index + 1 === n) console.log(`  rendered ${index + 1}/${n}`);
  });
  if (process.stdout.isTTY) process.stdout.write('\n');
  pushSilence(tailMs);
  fs.rmSync(workDir, { recursive: true, force: true });

  // Write WAV (header + all PCM chunks) atomically.
  const dataBytes = cursor * BYTES_PER_SAMPLE;
  const wavPath = path.join(outDir, `${baseName}.wav`);
  const tmpWav = `${wavPath}.tmp`;
  const fd = fs.openSync(tmpWav, 'w');
  fs.writeSync(fd, wavHeader(dataBytes));
  for (const c of chunks) fs.writeSync(fd, c);
  fs.closeSync(fd);
  fs.renameSync(tmpWav, wavPath);

  // Verify what we wrote round-trips through our own parser.
  const check = parseWav(fs.readFileSync(wavPath), wavPath);
  if (check.data.length !== dataBytes) throw new Error('WAV verification failed: data size mismatch');

  const durationMs = samplesToMs(cursor);
  const tagIndex = {};
  for (const l of manifestLines) {
    for (const t of l.tags) (tagIndex[t] ??= []).push({ index: l.index, startMs: l.startMs, at: mmss(l.startMs) });
  }
  const manifest = {
    title: script.title ?? baseName,
    audioFile: path.basename(wavPath),
    format: { container: 'WAVE', encoding: 'PCM signed 16-bit little-endian', sampleRate: SAMPLE_RATE, channels: CHANNELS, bitsPerSample: BITS },
    durationMs,
    duration: mmss(durationMs),
    lineCount: manifestLines.length,
    wordCount: { ...words, note: 'total = English-style tokens + Chinese characters (each counted as one word)' },
    speakers: Object.fromEntries(
      Object.entries(script.speakers).map(([k, v]) => [k, { ...v, lines: perSpeaker[k]?.lines ?? 0 }]),
    ),
    tagIndex,
    lines: manifestLines,
  };
  const manifestPath = path.join(outDir, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

  // ---- summary
  console.log(`\n${manifest.title}`);
  console.log(`  duration   ${mmss(durationMs)} (${(durationMs / 1000).toFixed(1)} s)`);
  console.log(`  lines      ${manifestLines.length}`);
  console.log(`  words      ${words.total} (${words.latin} English-style tokens + ${words.cjk} Chinese characters)`);
  console.log(`  cache      ${hits}/${manifestLines.length} hits in ${cacheDir} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  console.log('  speakers');
  for (const [k, s] of Object.entries(perSpeaker)) {
    console.log(
      `    ${k.padEnd(5)} ${s.voice.padEnd(22)} ${String(s.lines).padStart(3)} lines  ` +
        `${mmss(s.speechMs)} speech  ${s.words} words  min ${Math.round(s.minMsPerWord)} ms/word`,
    );
  }
  console.log('  tagged lines');
  for (const [tag, hitsForTag] of Object.entries(tagIndex)) {
    console.log(`    ${tag.padEnd(26)} ${hitsForTag.map((h) => `${h.at} (#${h.index})`).join(', ')}`);
  }
  console.log(`  wrote ${wavPath}`);
  console.log(`  wrote ${manifestPath}`);
}

try {
  main();
} catch (err) {
  console.error(`make-sample: ${err.message}`);
  process.exit(1);
}
