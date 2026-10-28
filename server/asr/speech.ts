import { EventEmitter } from 'node:events';
import type { AsrState, WhisperResult, WhisperServer } from './whisper.ts';
import {
  ELEVENLABS_MODEL, ELEVENLABS_URL, ENGINE_NAMES, checkLocalServer, isKeyedEngine, transcribeRemote,
  type KeyedEngineId, type RemoteEngineId, type RemoteOptions, type RemoteTarget, type SpeechEngineId,
} from './engines.ts';
import { deleteCredential, readCredential, storeCredential } from '../credentials.ts';
import { QwenAsr } from './qwen3.ts';
import { log } from '../util.ts';

export interface SpeechSettings { threads?: number; engine: SpeechEngineId; qwenCloud: { baseUrl: string; model: string }; qwenLocal: { baseUrl: string; model: string } }
/** Where API keys are kept; tests pass an in-memory stand-in. */
export interface SecretStore { read: typeof readCredential; store: typeof storeCredential; delete: typeof deleteCredential }

const KEY_SERVICE = 'Chumi speech API key';
const FALLBACK_NOTICE_MS = 5 * 60_000;
/** After a failure, go straight to local recognition for a while instead of making every utterance wait for the service. */
const RETRY_SERVICE_MS = 30_000;

/**
 * The speech engine the transcriber talks to: local Qwen3-ASR, whisper.cpp, or one of the services in engines.ts.
 * When a service fails and a local model is installed, that utterance is transcribed locally instead,
 * so a network problem never loses part of a meeting.
 */
export class SpeechService extends EventEmitter<{ state: [AsrState, string | null]; fallback: [message: string] }> {
  lastLatencyMs = 0;
  private whisper: WhisperServer;
  private cfg: () => SpeechSettings;
  private canFallback: () => boolean;
  private secrets: SecretStore;
  private qwen: Pick<QwenAsr, 'installed' | 'state' | 'message' | 'ensure' | 'stop' | 'transcribe' | 'on'>;
  private keys = new Map<KeyedEngineId, string | null>();
  private remoteState: AsrState = 'stopped';
  private remoteMessage: string | null = null;
  private fallbackNoticeAt = 0;
  private serviceDownUntil = 0;
  private configuring: Promise<void> | null = null;

  constructor(whisper: WhisperServer, cfg: () => SpeechSettings, canFallback: () => boolean,
    secrets: SecretStore = { read: readCredential, store: storeCredential, delete: deleteCredential },
    qwen: SpeechService['qwen'] = new QwenAsr(() => cfg().threads ?? 4)) {
    super();
    this.whisper = whisper; this.cfg = cfg; this.canFallback = canFallback; this.secrets = secrets; this.qwen = qwen;
    qwen.on('state', (s, m) => { if (this.engine === 'qwen3') this.emit('state', s, m); });
    whisper.on('state', (s, m) => { if (this.engine === 'whisper') this.emit('state', s, m); });
  }

  get engine(): SpeechEngineId { return this.cfg().engine; }
  /** Grey live text re-sends the growing utterance every second or so: only worth it when transcription is free. */
  get partials(): boolean { return this.engine === 'whisper' || this.engine === 'qwen3' || this.engine === 'qwen-local'; }
  get partialIntervalMs(): number { return this.engine === 'qwen3' ? 5000 : 0; }
  get state(): AsrState { return this.engine === 'whisper' ? this.whisper.state : this.engine === 'qwen3' ? this.qwen.state : this.remoteState; }
  get message(): string | null { return this.engine === 'whisper' ? this.whisper.message : this.engine === 'qwen3' ? this.qwen.message : this.remoteMessage; }
  /** What benchmark results and logs call the engine in use. */
  get label(): string {
    const s = this.cfg();
    return s.engine === 'whisper' ? 'Whisper' : s.engine === 'qwen3' ? 'Qwen3-ASR 0.6B (int8)' : `${ENGINE_NAMES[s.engine]} · ${s.engine === 'elevenlabs' ? ELEVENLABS_MODEL : s.engine === 'qwen-cloud' ? s.qwenCloud.model : s.qwenLocal.model}`;
  }

  private setRemote(state: AsrState, message: string | null = null): void {
    if (state === this.remoteState && message === this.remoteMessage) return;
    this.remoteState = state; this.remoteMessage = message;
    if (this.engine !== 'whisper') this.emit('state', state, message);
  }

  async hasKey(engine: KeyedEngineId): Promise<boolean> { return !!(await this.key(engine)); }
  private async key(engine: KeyedEngineId): Promise<string | null> {
    if (!this.keys.has(engine)) this.keys.set(engine, await this.secrets.read(KEY_SERVICE, engine));
    return this.keys.get(engine) ?? null;
  }
  async saveKey(engine: KeyedEngineId, key: string): Promise<void> {
    await this.secrets.store(KEY_SERVICE, engine, key);
    this.keys.set(engine, key);
    if (this.engine === engine) void this.ensure().catch(() => {});
  }
  async deleteKey(engine: KeyedEngineId): Promise<void> {
    await this.secrets.delete(KEY_SERVICE, engine);
    this.keys.set(engine, null);
    if (this.engine === engine) void this.ensure().catch(() => {});
  }

  /** After the engine or its settings change. Whisper stops while a service is in use and starts again on demand. */
  configure(): void {
    this.serviceDownUntil = 0;
    this.remoteState = 'stopped';
    this.configuring = this.stop().finally(() => { this.configuring = null; });
    void this.configuring.then(() => this.ensure()).catch((e) => log('asr', (e as Error).message));
  }

  /** A service that is not ready only blocks a meeting when local recognition cannot take over its audio. */
  async ensure(): Promise<void> {
    await this.configuring;
    if (this.engine === 'whisper') return this.whisper.ensure();
    if (this.engine === 'qwen3') {
      try { await this.qwen.ensure(); }
      catch (e) {
        if (!this.canFallback()) throw e;
        this.notice(`${(e as Error).message} Using local Whisper.`);
        await this.whisper.ensure();
      }
      return;
    }
    try {
      const target = await this.target();
      if (target.engine === 'qwen-local') {
        try { await checkLocalServer(target.url); }
        catch (e) { this.setRemote('error', (e as Error).message); throw e; }
      }
      this.setRemote('ready');
    } catch (e) {
      if (!this.qwen.installed && !this.canFallback()) throw e;
    }
  }

  private async target(): Promise<RemoteTarget> {
    const s = this.cfg();
    const engine = s.engine as RemoteEngineId;
    let key: string | null = null;
    if (isKeyedEngine(engine)) {
      key = await this.key(engine);
      if (!key) {
        const message = `Add your ${ENGINE_NAMES[engine]} API key in Settings → Transcription.`;
        this.setRemote('missing_key', message);
        throw new Error(message);
      }
    }
    if (engine === 'elevenlabs') return { engine, url: ELEVENLABS_URL, model: ELEVENLABS_MODEL, key };
    const { baseUrl, model } = engine === 'qwen-cloud' ? s.qwenCloud : s.qwenLocal;
    return { engine, url: baseUrl, model, key };
  }

  async transcribe(samples: Int16Array, o: RemoteOptions): Promise<WhisperResult> {
    await this.configuring;
    if (this.engine === 'whisper' || this.engine === 'qwen3') return this.local(samples, o);
    const fallback = o.fallback !== false && (this.qwen.installed || this.canFallback());
    if (fallback && Date.now() < this.serviceDownUntil) return this.local(samples, o);
    try {
      const r = await transcribeRemote(await this.target(), samples, o);
      this.lastLatencyMs = r.ms;
      this.serviceDownUntil = 0;
      this.setRemote('ready');
      return r;
    } catch (e) {
      const message = (e as Error).message;
      if (this.remoteState !== 'missing_key') this.setRemote('error', message);
      if (!fallback) throw e;
      this.serviceDownUntil = Date.now() + RETRY_SERVICE_MS;
      log('asr', `${ENGINE_NAMES[this.engine]} failed, using local speech recognition: ${message}`);
      this.notice(`${ENGINE_NAMES[this.engine]} failed (${message}). Chumi is transcribing with ${this.qwen.installed ? 'local Qwen3-ASR' : 'local Whisper'} until it works again.`);
      return this.local(samples, o);
    }
  }

  private notice(message: string): void {
    if (Date.now() - this.fallbackNoticeAt <= FALLBACK_NOTICE_MS) return;
    this.fallbackNoticeAt = Date.now();
    this.emit('fallback', message);
  }

  async stop(): Promise<void> { await Promise.all([this.qwen.stop(), this.whisper.stop()]); }

  private async local(samples: Int16Array, o: RemoteOptions): Promise<WhisperResult> {
    if (this.engine !== 'whisper' && (this.qwen.installed || this.engine === 'qwen3')) {
      try {
        const r = await this.qwen.transcribe(samples, o);
        this.lastLatencyMs = r.ms;
        return r;
      } catch (e) {
        if (o.fallback === false || !this.canFallback()) throw e;
        this.notice(`${(e as Error).message} Using local Whisper. Download Qwen3-ASR in Settings → Transcription.`);
      }
    }
    const r = await this.whisper.transcribe(samples, o);
    this.lastLatencyMs = r.ms;
    return r;
  }
}
