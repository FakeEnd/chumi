/**
 * Speech recognition services other than local Qwen3-ASR and whisper.cpp: ElevenLabs Scribe, Qwen3-ASR on Alibaba Cloud
 * Model Studio, and Qwen3-ASR on a server the user runs (qwen-asr-serve / vllm serve). Each turns one utterance of
 * 16 kHz mono audio into the same result shape as whisper-server, so the transcriber treats them alike.
 */
import { encodeWav } from '../audio/wav.ts';
import { langCode } from './clean.ts';
import type { WhisperResult, WhisperSegment } from './whisper.ts';

export const SPEECH_ENGINES = ['qwen3', 'sensevoice', 'whisper', 'elevenlabs', 'qwen-cloud', 'qwen-local'] as const;
export type SpeechEngineId = (typeof SPEECH_ENGINES)[number];
export type SherpaEngineId = 'qwen3' | 'sensevoice';
export type LocalEngineId = SherpaEngineId | 'whisper';
export type RemoteEngineId = Exclude<SpeechEngineId, LocalEngineId>;

/**
 * The local model a new install uses. Measured on real meeting audio (docs/transcription.md), the two transcribe Mandarin
 * equally well; Qwen3-ASR also takes the glossary. On a Windows laptop CPU (i9-12900H) Qwen3-ASR is too slow for live
 * meetings (RTF 0.6, 0.35 on performance cores only; its int8 model is no faster on CUDA), while SenseVoice runs at 0.09.
 */
export function defaultLocalEngine(platform: string = process.platform): SherpaEngineId { return platform === 'win32' ? 'sensevoice' : 'qwen3'; }
export const isSherpaEngine = (engine: SpeechEngineId): engine is SherpaEngineId => engine === 'qwen3' || engine === 'sensevoice';
export const isLocalEngine = (engine: SpeechEngineId): engine is LocalEngineId => engine === 'whisper' || isSherpaEngine(engine);

export function localEngineOrder(engine: SpeechEngineId): LocalEngineId[] {
  if (engine === 'whisper') return ['whisper'];
  const first = isSherpaEngine(engine) ? engine : defaultLocalEngine();
  return [first, first === 'qwen3' ? 'sensevoice' : 'qwen3', 'whisper'];
}
/** Engines whose API key Chumi keeps (Keychain, or encrypted for the Windows account). */
export const KEYED_ENGINES = ['elevenlabs', 'qwen-cloud'] as const;
export type KeyedEngineId = (typeof KEYED_ENGINES)[number];

export const isSpeechEngine = (v: unknown): v is SpeechEngineId => (SPEECH_ENGINES as readonly unknown[]).includes(v);
export const isKeyedEngine = (v: unknown): v is KeyedEngineId => (KEYED_ENGINES as readonly unknown[]).includes(v);

export const ENGINE_NAMES: Record<SpeechEngineId, string> = {
  qwen3: 'Qwen3-ASR (this computer)', sensevoice: 'SenseVoice-Small (this computer)', whisper: 'Whisper', elevenlabs: 'ElevenLabs', 'qwen-cloud': 'Qwen3-ASR (Alibaba Cloud)', 'qwen-local': 'Qwen3-ASR (self-hosted)',
};

export const ELEVENLABS_URL = 'https://api.elevenlabs.io/v1/speech-to-text';
export const ELEVENLABS_MODEL = 'scribe_v2';
/** Model Studio's general addresses. A workspace address (https://{WorkspaceId}.<region>.maas.aliyuncs.com/…) also works. */
export const QWEN_CLOUD_REGIONS = {
  singapore: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
  beijing: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
} as const;
export const QWEN_CLOUD_MODEL = 'qwen3-asr-flash';
export const QWEN_LOCAL_URL = 'http://127.0.0.1:8000/v1';
export const QWEN_LOCAL_MODEL = 'Qwen/Qwen3-ASR-1.7B';

const parseUrl = (raw: unknown): URL | null => { try { return new URL(String(raw ?? '').trim()); } catch { return null; } };

/** The stored Model Studio key is only ever sent to Alibaba Cloud. */
export function normalizeQwenCloudUrl(raw: unknown): string {
  const u = parseUrl(raw);
  const path = u?.pathname.replace(/\/+$/, '') ?? '';
  if (!u || u.protocol !== 'https:' || u.username || u.password || u.search || u.hash || !/(^|\.)aliyuncs\.com$/i.test(u.hostname) || !path.endsWith('/compatible-mode/v1')) {
    throw new Error('Use a Model Studio address such as https://dashscope-intl.aliyuncs.com/compatible-mode/v1.');
  }
  return `https://${u.host.toLowerCase()}${path}`;
}

export function normalizeLocalAsrUrl(raw: unknown): string {
  const u = parseUrl(raw);
  if (!u || !['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash) {
    throw new Error('Use the server address with its API path, for example http://127.0.0.1:8000/v1.');
  }
  return `${u.protocol}//${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, '')}`;
}

export function speechModelId(raw: unknown): string {
  const id = String(raw ?? '').trim();
  if (!/^[\w.\-/:]{1,200}$/.test(id)) throw new Error('Enter the speech model name, for example qwen3-asr-flash.');
  return id;
}

export const isLoopbackUrl = (url: string): boolean => ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname);

const ISO_639_3: Record<string, string> = {
  eng: 'en', cmn: 'zh', zho: 'zh', chi: 'zh', yue: 'yue', jpn: 'ja', kor: 'ko', fra: 'fr', fre: 'fr', deu: 'de', ger: 'de',
  spa: 'es', rus: 'ru', por: 'pt', ita: 'it', ara: 'ar', hin: 'hi',
};
/** ElevenLabs reports ISO 639-3 codes ('eng', 'cmn'); the rest of Chumi uses 'en' and 'zh'. */
export const isoLanguage = (code: string | null | undefined): string | null => (code ? ISO_639_3[code.toLowerCase()] ?? code.toLowerCase() : null);

/** Glossary entries ElevenLabs accepts as keyterms. More than 100 would raise the minimum billed length per request. */
export function keyterms(glossary: string[]): string[] {
  const ok = glossary.map((t) => t.trim()).filter((t) => t && t.length < 50 && t.split(/\s+/).length <= 5 && !/[<>{}[\]\\]/.test(t));
  return [...new Set(ok)].slice(0, 100);
}

/** fallback: false makes a failure surface instead of being covered by local recognition (the speed test measures the service). */
export interface RemoteOptions { language: string; prompt?: string; glossary?: string[]; timeoutMs?: number; fallback?: boolean }
type Parsed = Omit<WhisperResult, 'ms'>;

export function elevenLabsForm(samples: Int16Array, o: RemoteOptions): FormData {
  const form = new FormData();
  form.append('model_id', ELEVENLABS_MODEL);
  form.append('file', new Blob([new Uint8Array(encodeWav(samples))], { type: 'audio/wav' }), 'audio.wav');
  if (o.language !== 'auto') form.append('language_code', o.language);
  form.append('tag_audio_events', 'false');
  form.append('timestamps_granularity', 'word');
  for (const term of keyterms(o.glossary ?? [])) form.append('keyterms', term);
  return form;
}

interface ElevenLabsWord { text: string; type: 'word' | 'spacing' | 'audio_event'; start?: number | null; end?: number | null }
/** Words become sentence segments. Each starts with a space, as Whisper's do, so the transcriber never glues words. */
export function parseElevenLabs(j: { text?: string; language_code?: string; language_probability?: number; words?: ElevenLabsWord[] }): Parsed {
  const language = isoLanguage(j.language_code);
  const segments: WhisperSegment[] = [];
  let cur: WhisperSegment | null = null;
  for (const w of j.words ?? []) {
    if (w.type === 'audio_event') continue;
    if (w.type === 'spacing') { if (cur) cur.text += w.text; continue; }
    cur ??= { start: w.start ?? segments.at(-1)?.end ?? 0, end: w.end ?? w.start ?? 0, text: ' ' };
    cur.text += w.text;
    if (w.end != null) cur.end = w.end;
    if (/[.?!。？！]["”']?$/.test(w.text)) { segments.push(cur); cur = null; }
  }
  if (cur) segments.push(cur);
  return {
    text: (j.text ?? '').trim(), language,
    langProbs: language && typeof j.language_probability === 'number' ? { [language]: j.language_probability } : {},
    segments: segments.map((s) => ({ ...s, text: ` ${s.text.trim()}` })).filter((s) => s.text.trim()),
  };
}

/** Model Studio takes "input_audio" and asr_options; vLLM takes an "audio_url". Both accept a data URL. */
export function qwenBody(engine: 'qwen-cloud' | 'qwen-local', model: string, samples: Int16Array, o: { language: string; prompt?: string }) {
  const data = `data:audio/wav;base64,${encodeWav(samples).toString('base64')}`;
  const audio = engine === 'qwen-cloud' ? { type: 'input_audio', input_audio: { data } } : { type: 'audio_url', audio_url: { url: data } };
  // Qwen3-ASR reads the system message as context: glossary terms and the previous sentence improve spelling.
  const messages: unknown[] = o.prompt ? [{ role: 'system', content: o.prompt }] : [];
  messages.push({ role: 'user', content: [audio] });
  if (engine === 'qwen-local') return { model, messages, stream: false, temperature: 0 };
  return { model, messages, stream: false, asr_options: { enable_itn: false, ...(o.language !== 'auto' ? { language: o.language } : {}) } };
}

/** Model Studio returns plain text and an annotation; the open model writes "language Chinese<asr_text>…". */
export function parseQwen(j: { choices?: { message?: { content?: unknown; annotations?: { language?: string }[] } }[] }): Parsed {
  const msg = j.choices?.[0]?.message;
  let text = typeof msg?.content === 'string' ? msg.content
    : Array.isArray(msg?.content) ? (msg.content as { text?: string }[]).map((p) => p.text ?? '').join('') : '';
  let language: string | null = msg?.annotations?.find((a) => a.language)?.language ?? null;
  const tag = text.indexOf('<asr_text>');
  if (tag >= 0) {
    const named = text.slice(0, tag).trim().replace(/^language\s*/i, '').split(/[,，]/)[0].trim();
    text = named.toLowerCase() === 'none' ? '' : text.slice(tag + '<asr_text>'.length);
    if (named && named.toLowerCase() !== 'none') language ??= named;
  }
  return { text: text.trim(), language: langCode(language), langProbs: {}, segments: [] };
}

async function readResult(r: Response, service: string): Promise<any> {
  const body = await r.text();
  let j: any = null;
  try { j = JSON.parse(body); } catch { /* not JSON */ }
  if (!r.ok) {
    // ElevenLabs: { detail: { message } }, or a list of validation errors. Model Studio and vLLM: { error: { message } }.
    const d = j?.detail;
    const fromDetail = Array.isArray(d) ? d.map((x: { msg?: string }) => x.msg).join('; ') : typeof d === 'string' ? d : d?.message;
    const detail = String(fromDetail ?? j?.error?.message ?? j?.message ?? body.slice(0, 200)).trim();
    if (r.status === 401 || r.status === 403) throw new Error(`${service} rejected the API key (HTTP ${r.status}). ${detail}`.trim());
    throw new Error(`${service} HTTP ${r.status}${detail ? `: ${detail}` : ''}`);
  }
  if (!j) throw new Error(`${service} returned a response Chumi could not read.`);
  return j;
}

export interface RemoteTarget { engine: RemoteEngineId; url: string; model: string; key: string | null }

const REMOTE_TIMEOUT_MS = 30_000;

/** Servers that refused a system message once are asked without one from then on. */
const contextRefused = new Set<string>();

export async function transcribeRemote(t: RemoteTarget, samples: Int16Array, o: RemoteOptions): Promise<WhisperResult> {
  const t0 = Date.now();
  // Utterances are at most 15 s; a service that takes longer than this is better replaced by local recognition.
  const timeoutMs = Math.min(o.timeoutMs ?? REMOTE_TIMEOUT_MS, REMOTE_TIMEOUT_MS);
  const signal = AbortSignal.timeout(timeoutMs);
  const service = ENGINE_NAMES[t.engine];
  // fetch only says "fetch failed"; name the service and the reason instead.
  const fetch = (url: string, init: RequestInit) => globalThis.fetch(url, init).catch((e: Error & { cause?: { code?: string; message?: string } }) => {
    if (e.name === 'TimeoutError') throw new Error(`${service} did not answer within ${Math.round(timeoutMs / 1000)} s.`);
    throw new Error(`Cannot reach ${service} at ${new URL(url).host} (${e.cause?.code ?? e.cause?.message ?? e.message}).`);
  });
  if (t.engine === 'elevenlabs') {
    const r = await fetch(t.url, { method: 'POST', headers: { 'xi-api-key': t.key ?? '' }, body: elevenLabsForm(samples, o), signal });
    return { ...parseElevenLabs(await readResult(r, service)), ms: Date.now() - t0 };
  }
  const engine = t.engine;
  const headers: Record<string, string> = { 'content-type': 'application/json', ...(t.key ? { authorization: `Bearer ${t.key}` } : {}) };
  const post = (prompt?: string) => fetch(`${t.url}/chat/completions`, {
    method: 'POST', headers, signal, body: JSON.stringify(qwenBody(engine, t.model, samples, { language: o.language, prompt })),
  });
  const prompt = contextRefused.has(t.url) ? undefined : o.prompt;
  let r = await post(prompt);
  if (r.status === 400 && prompt) {
    const retry = await post();
    if (retry.ok) contextRefused.add(t.url);
    r = retry;
  }
  return { ...parseQwen(await readResult(r, service)), ms: Date.now() - t0 };
}

/** A self-hosted server answers its model list; this checks it is up before a session starts. */
export async function checkLocalServer(url: string): Promise<void> {
  try {
    const r = await fetch(`${url}/models`, { signal: AbortSignal.timeout(3000) });
    if (r.ok) return;
    throw new Error(`HTTP ${r.status}`);
  } catch (e) {
    const err = e as Error & { cause?: { code?: string } };
    throw new Error(`Cannot reach the Qwen3-ASR server at ${url} (${err.cause?.code ?? err.message}). Start it with qwen-asr-serve, or check the address.`);
  }
}
