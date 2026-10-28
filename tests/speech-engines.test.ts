import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  keyterms, normalizeLocalAsrUrl, normalizeQwenCloudUrl, parseElevenLabs, parseQwen, qwenBody, transcribeRemote, type RemoteOptions,
} from '../server/asr/engines.ts';
import { SherpaAsr } from '../server/asr/sherpa.ts';
import { SpeechService, type SecretStore, type SpeechSettings } from '../server/asr/speech.ts';
import { Transcriber } from '../server/asr/transcriber.ts';
import type { WhisperResult, WhisperServer } from '../server/asr/whisper.ts';

const audio = new Int16Array(16_000);

/** A local server stands in for ElevenLabs, Model Studio and vLLM; nothing leaves this computer in tests. */
type Seen = { url: string; headers: IncomingMessage['headers']; body: Buffer };
const seen: Seen[] = [];
let reply: (s: Seen) => { status: number; json: unknown } = () => ({ status: 500, json: {} });
const server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    const s = { url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks) };
    seen.push(s);
    const r = reply(s);
    res.writeHead(r.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(r.json));
  });
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
test.after(() => server.close());

test('Model Studio keys are only sent to Alibaba Cloud addresses', () => {
  assert.equal(normalizeQwenCloudUrl('https://dashscope-intl.aliyuncs.com/compatible-mode/v1/'), 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1');
  assert.equal(normalizeQwenCloudUrl(' https://WS-1.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1 '), 'https://ws-1.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1');
  for (const bad of ['http://dashscope.aliyuncs.com/compatible-mode/v1', 'https://aliyuncs.com.evil.example/compatible-mode/v1',
    'https://dashscope.aliyuncs.com/api/v1', 'https://user:pw@dashscope.aliyuncs.com/compatible-mode/v1', 'not a url']) {
    assert.throws(() => normalizeQwenCloudUrl(bad), /Model Studio address/, bad);
  }
  assert.equal(normalizeLocalAsrUrl('http://192.168.1.20:8000/v1/'), 'http://192.168.1.20:8000/v1');
  assert.throws(() => normalizeLocalAsrUrl('ftp://127.0.0.1/v1'));
  assert.throws(() => normalizeLocalAsrUrl('http://127.0.0.1:8000/v1?key=x'));
});

test('glossary terms ElevenLabs would reject are left out of keyterms', () => {
  assert.deepEqual(keyterms(['ATAC-seq', ' ATAC-seq ', 'a very long phrase with far too many words', '[bad]', '']), ['ATAC-seq']);
  assert.equal(keyterms(Array.from({ length: 300 }, (_, i) => `term${i}`)).length, 100);
});

test('ElevenLabs words become sentence segments with Chumi language codes', () => {
  const r = parseElevenLabs({
    text: 'We ran it. (laughter) It worked', language_code: 'eng', language_probability: 0.97,
    words: [
      { text: 'We', type: 'word', start: 0.1, end: 0.3 }, { text: ' ', type: 'spacing' }, { text: 'ran', type: 'word', start: 0.3, end: 0.5 },
      { text: ' ', type: 'spacing' }, { text: 'it.', type: 'word', start: 0.5, end: 0.8 }, { text: '(laughter)', type: 'audio_event', start: 0.9, end: 1.2 },
      { text: 'It', type: 'word', start: 1.3, end: 1.4 }, { text: ' ', type: 'spacing' }, { text: 'worked', type: 'word', start: 1.4, end: 1.9 },
    ],
  });
  assert.equal(r.language, 'en');
  assert.deepEqual(r.langProbs, { en: 0.97 });
  assert.deepEqual(r.segments, [{ start: 0.1, end: 0.8, text: ' We ran it.' }, { start: 1.3, end: 1.9, text: ' It worked' }]);
  assert.equal(parseElevenLabs({ text: '', language_code: 'cmn', words: [] }).language, 'zh');
});

test('Qwen3-ASR answers from Model Studio and from the open model are read alike', () => {
  const cloud = parseQwen({ choices: [{ message: { content: '我们用了三个重复。', annotations: [{ language: 'zh' }] } }] });
  assert.deepEqual([cloud.text, cloud.language], ['我们用了三个重复。', 'zh']);
  const open = parseQwen({ choices: [{ message: { content: 'language Chinese,English<asr_text>这个 enhancer 很强' } }] });
  assert.deepEqual([open.text, open.language], ['这个 enhancer 很强', 'zh']);
  assert.equal(parseQwen({ choices: [{ message: { content: 'language None<asr_text>' } }] }).text, '');
  assert.equal(parseQwen({ choices: [{ message: { content: 'plain words' } }] }).text, 'plain words');
});

test('Qwen requests carry context, and Model Studio gets its language option only when forced', () => {
  const cloud = qwenBody('qwen-cloud', 'qwen3-asr-flash', audio, { language: 'auto', prompt: 'Glossary: ATAC-seq.' }) as any;
  assert.deepEqual(cloud.messages[0], { role: 'system', content: 'Glossary: ATAC-seq.' });
  assert.match(cloud.messages[1].content[0].input_audio.data, /^data:audio\/wav;base64,UklGR/);
  assert.deepEqual(cloud.asr_options, { enable_itn: false });
  assert.equal((qwenBody('qwen-cloud', 'm', audio, { language: 'zh' }) as any).asr_options.language, 'zh');
  const local = qwenBody('qwen-local', 'Qwen/Qwen3-ASR-1.7B', audio, { language: 'en' }) as any;
  assert.equal(local.messages.length, 1);
  assert.equal(local.messages[0].content[0].type, 'audio_url');
  assert.equal(local.asr_options, undefined);
});

test('ElevenLabs request: key header, model, keyterms, and no language on auto', async () => {
  seen.length = 0;
  reply = () => ({ status: 200, json: { text: 'Hello.', language_code: 'eng', words: [{ text: 'Hello.', type: 'word', start: 0, end: 0.5 }] } });
  const r = await transcribeRemote({ engine: 'elevenlabs', url: `${base}/v1/speech-to-text`, model: 'scribe_v2', key: 'sk_test_key' }, audio,
    { language: 'auto', glossary: ['ATAC-seq', 'eQTL'], prompt: 'ignored by ElevenLabs' });
  assert.equal(r.text, 'Hello.');
  assert.equal(seen[0].headers['xi-api-key'], 'sk_test_key');
  const form = await new Response(seen[0].body, { headers: { 'content-type': String(seen[0].headers['content-type']) } }).formData();
  assert.equal(form.get('model_id'), 'scribe_v2');
  assert.deepEqual(form.getAll('keyterms'), ['ATAC-seq', 'eQTL']);
  assert.equal(form.get('language_code'), null);
  assert.equal(form.get('tag_audio_events'), 'false');
});

test('a server that refuses the context is asked again without it, and from then on', async () => {
  seen.length = 0;
  reply = (s) => JSON.parse(s.body.toString()).messages[0].role === 'system'
    ? { status: 400, json: { error: { message: 'system message not supported' } } }
    : { status: 200, json: { choices: [{ message: { content: 'ok' } }] } };
  const target = { engine: 'qwen-cloud' as const, url: `${base}/refuses-context`, model: 'qwen3-asr-flash', key: 'sk-test' };
  assert.equal((await transcribeRemote(target, audio, { language: 'auto', prompt: 'Glossary: x.' })).text, 'ok');
  assert.equal(seen.length, 2);
  assert.equal(seen[0].headers.authorization, 'Bearer sk-test');
  await transcribeRemote(target, audio, { language: 'auto', prompt: 'Glossary: x.' });
  assert.equal(seen.length, 3);
});

test('a rejected key is reported without echoing it', async () => {
  reply = () => ({ status: 401, json: { detail: { status: 'invalid_api_key', message: 'Invalid API key' } } });
  await assert.rejects(transcribeRemote({ engine: 'elevenlabs', url: `${base}/v1/speech-to-text`, model: 'scribe_v2', key: 'sk_secret_value' }, audio, { language: 'en' }),
    (e: Error) => /rejected the API key \(HTTP 401\)\. Invalid API key/.test(e.message) && !e.message.includes('sk_secret_value'));
});

// ---------------------------------------------------------------- SpeechService
const whisperResult: WhisperResult = { text: 'local', language: 'en', langProbs: {}, segments: [], ms: 5 };
function makeService(engine: SpeechSettings['engine'], opts: { fallback: boolean; keys?: Record<string, string>; local?: (o: RemoteOptions) => WhisperResult; qwen?: boolean; sensevoice?: boolean; qwenError?: boolean; sensevoiceError?: boolean }) {
  const calls: string[] = [];
  const whisper = Object.assign(new EventEmitter(), {
    state: 'ready', message: null, ensure: async () => {}, stop: async () => { calls.push('stop'); },
    transcribe: async (_samples: Int16Array, o: RemoteOptions) => { calls.push('whisper'); return opts.local?.(o) ?? whisperResult; },
  }) as unknown as WhisperServer;
  const keys = { ...opts.keys };
  const secrets: SecretStore = {
    read: async (_s, account) => keys[account] ?? null,
    store: async (_s, account, key) => { keys[account] = key; },
    delete: async (_s, account) => { delete keys[account]; },
  };
  const cfg: SpeechSettings = { engine, qwenCloud: { baseUrl: `${base}/cloud`, model: 'qwen3-asr-flash' }, qwenLocal: { baseUrl: 'http://127.0.0.1:18999/v1', model: 'Qwen/Qwen3-ASR-1.7B' } };
  class FakeSherpa extends SherpaAsr {
    override get installed() { return (this.engine === 'qwen3' ? opts.qwen : opts.sensevoice) ?? false; }
    override async ensure() {
      if (!this.installed) {
        this.state = 'missing_model'; this.message = this.engine === 'qwen3' ? 'Download Qwen3-ASR' : 'Download SenseVoice';
        throw new Error(this.message);
      }
      if (this.engine === 'qwen3' ? opts.qwenError : opts.sensevoiceError) {
        calls.push(`${this.engine}:failed`); throw new Error(`${this.engine} failed`);
      }
      this.state = 'ready';
    }
    override async transcribe(_samples: Int16Array, o: RemoteOptions) {
      await this.ensure();
      const name = this.engine === 'qwen3' ? 'qwen' : 'sensevoice';
      calls.push(`${name}:${o.glossary?.join(',') ?? ''}`);
      return { ...whisperResult, text: name };
    }
  }
  return { speech: new SpeechService(whisper, () => cfg, () => opts.fallback, secrets,
    new FakeSherpa('qwen3', () => 4), new FakeSherpa('sensevoice', () => 4)), calls, cfg };
}

test('when the service fails, local Whisper transcribes the utterance and the user is told once', async () => {
  const { speech, calls } = makeService('qwen-local', { fallback: true });
  const notices: string[] = [];
  speech.on('fallback', (m) => notices.push(m));
  assert.equal((await speech.transcribe(audio, { language: 'auto' })).text, 'local');
  await speech.transcribe(audio, { language: 'auto' });
  assert.deepEqual(calls, ['whisper', 'whisper']);
  assert.equal(notices.length, 1);
  assert.equal(speech.state, 'error');
});

test('during an outage the service is skipped for a while, but the speed test always asks it', async () => {
  const { speech, calls } = makeService('qwen-cloud', { fallback: true, keys: { 'qwen-cloud': 'sk-test-key-123' } });
  seen.length = 0;
  reply = () => ({ status: 503, json: { error: { message: 'overloaded' } } });
  await speech.transcribe(audio, { language: 'auto' });
  await speech.transcribe(audio, { language: 'auto' });
  assert.equal(seen.length, 1, 'the second utterance went straight to Whisper');
  assert.deepEqual(calls, ['whisper', 'whisper']);
  await assert.rejects(speech.transcribe(audio, { language: 'en', fallback: false }), /HTTP 503: overloaded/);
  assert.equal(seen.length, 2);
});

test('without a local model the failure reaches the transcriber, which keeps the audio for a retry', async () => {
  const { speech } = makeService('qwen-local', { fallback: false });
  await assert.rejects(speech.transcribe(audio, { language: 'auto' }), /Cannot reach Qwen3-ASR \(self-hosted\) at 127\.0\.0\.1:18999 \(ECONNREFUSED\)/);
});

test('a paid service without a key reports it instead of calling out', async () => {
  const { speech, calls } = makeService('qwen-cloud', { fallback: false });
  const states: string[] = [];
  speech.on('state', (s) => states.push(s));
  await assert.rejects(speech.ensure(), /Add your Qwen3-ASR \(Alibaba Cloud\) API key/);
  assert.equal(speech.state, 'missing_key');
  assert.deepEqual(states, ['missing_key']);
  assert.equal(speech.partials, false);
  await speech.saveKey('qwen-cloud', 'sk-new-key-1234');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(speech.state, 'ready');
  assert.deepEqual(calls, []);
});

test('a service that is not ready does not block a meeting that local Whisper can take', async () => {
  const { speech } = makeService('elevenlabs', { fallback: true });
  await speech.ensure();
  assert.equal(speech.state, 'missing_key');
  const down = makeService('qwen-local', { fallback: true }).speech;
  await down.ensure();
  assert.equal(down.state, 'error');
  assert.match(down.message ?? '', /Cannot reach the Qwen3-ASR server/);
});

test('Whisper remains selectable and keeps live partial text', () => {
  const { speech } = makeService('whisper', { fallback: true });
  assert.equal(speech.partials, true);
  assert.equal(speech.label, 'Whisper');
});

test('the glossary goes out as a sentence, and a prompt the engine repeats as speech is removed, after a fallback too', async () => {
  const glossary = ['ATAC-seq', 'ChIP-seq', 'RNA-seq'];
  const toWhisper: RemoteOptions[] = [];
  const { speech } = makeService('qwen-cloud', {
    fallback: true, keys: { 'qwen-cloud': 'sk-test-key-123' },
    local: (o) => { toWhisper.push(o); return { ...whisperResult, text: `${o.prompt} Next slide.` }; },
  });
  const t = new Transcriber(speech, () => ({ language: 'en', glossary, chineseScript: 'simplified' }));
  const lines: string[] = [], errors: string[] = [];
  t.on('final', (pieces) => lines.push(...pieces.map((p) => p.text)));
  t.on('error', (m) => errors.push(m));
  const utt = (id: number) => ({ id, startSec: id, endSec: id + 1, samples: audio, final: true });

  // Qwen3-ASR reads the prompt as context and sometimes says it back
  seen.length = 0;
  reply = (s) => ({ status: 200, json: { choices: [{ message: { content: `${JSON.parse(s.body.toString()).messages[0].content} The peaks moved.` } }] } });
  t.pushFinal('mic', utt(1));
  await t.drain();
  assert.equal(JSON.parse(seen[0].body.toString()).messages[0].content, 'We talked about ATAC-seq, ChIP-seq and RNA-seq.');

  // The service fails, so local Whisper gets the same prompt, now with the previous line after the sentence
  reply = () => ({ status: 503, json: { error: { message: 'overloaded' } } });
  t.pushFinal('mic', utt(2));
  await t.drain();
  assert.equal(toWhisper[0].prompt, 'We talked about ATAC-seq, ChIP-seq and RNA-seq. The peaks moved.');
  assert.deepEqual(toWhisper[0].glossary, glossary);
  assert.deepEqual(lines, ['The peaks moved.', 'Next slide.']);
  assert.deepEqual(errors, []);
});


test('Qwen3 is selected locally, and receives glossary hints without calling Whisper', async () => {
  const { speech, calls } = makeService('qwen3', { fallback: true, qwen: true });
  await speech.ensure();
  const result = await speech.transcribe(audio, { language: 'auto', glossary: ['ATAC-seq', 'meeting term'] });
  assert.equal(result.text, 'qwen');
  assert.equal(speech.partials, true);
  assert.deepEqual(calls, ['qwen:ATAC-seq,meeting term']);
});

test('missing Qwen3 model keeps captions running through Whisper and prompts a download', async () => {
  const { speech, calls } = makeService('qwen3', { fallback: true });
  const notices: string[] = [];
  speech.on('fallback', (m) => notices.push(m));
  await speech.ensure();
  assert.equal((await speech.transcribe(audio, { language: 'auto' })).text, 'local');
  assert.equal(speech.state, 'missing_model');
  assert.match(speech.message!, /Download Qwen3/);
  assert.equal(notices.length, 1);
  assert.deepEqual(calls, ['whisper']);
  await assert.rejects(speech.transcribe(audio, { language: 'auto', fallback: false }), /Download Qwen3/);
});

test('remote failures prefer local Qwen3 even when Whisper is unavailable', async () => {
  const { speech, calls } = makeService('qwen-local', { fallback: false, qwen: true });
  await speech.ensure();
  assert.equal((await speech.transcribe(audio, { language: 'auto' })).text, 'qwen');
  await speech.transcribe(audio, { language: 'auto' });
  assert.deepEqual(calls, ['qwen:', 'qwen:']);
});

test('explicit Whisper selection stays on Whisper when Qwen3 is installed', async () => {
  const { speech, calls } = makeService('whisper', { fallback: true, qwen: true });
  await speech.transcribe(audio, { language: 'auto' });
  assert.deepEqual(calls, ['whisper']);
});


for (const engine of ['qwen3', 'sensevoice'] as const) {
  const other = engine === 'qwen3' ? 'sensevoice' : 'qwen';
  test(`${engine} uses the other installed sherpa model before Whisper when missing`, async () => {
    const { speech, calls } = makeService(engine, { fallback: true, qwen: engine !== 'qwen3', sensevoice: engine !== 'sensevoice' });
    await speech.ensure();
    assert.equal((await speech.transcribe(audio, { language: 'auto' })).text, other);
    assert.deepEqual(calls, [`${other}:`]);
    await assert.rejects(speech.transcribe(audio, { language: 'auto', fallback: false }), /Download/);
    assert.deepEqual(calls, [`${other}:`]);
  });
  test(`${engine} runtime failure tries the other sherpa model, then Whisper`, async () => {
    const { speech, calls } = makeService(engine, {
      fallback: true, qwen: true, sensevoice: true, qwenError: true, sensevoiceError: true,
    });
    assert.equal((await speech.transcribe(audio, { language: 'auto' })).text, 'local');
    const second = engine === 'qwen3' ? 'sensevoice' : 'qwen3';
    assert.deepEqual(calls, [`${engine}:failed`, `${second}:failed`, 'whisper']);
  });
}

test('SenseVoice selection keeps unthrottled previews and does not call Qwen3 or Whisper', async () => {
  const { speech, calls } = makeService('sensevoice', { fallback: true, qwen: true, sensevoice: true });
  await speech.ensure();
  assert.equal((await speech.transcribe(audio, { language: 'auto' })).text, 'sensevoice');
  assert.equal(speech.partials, true);
  assert.equal(speech.partialIntervalMs, 0);
  assert.match(speech.label, /SenseVoice/);
  assert.deepEqual(calls, ['sensevoice:']);
  const qwen = makeService('qwen3', { fallback: true, qwen: true }).speech;
  assert.equal(qwen.partialIntervalMs, 5000);
});

for (const opts of [
  { qwen: true, sensevoice: true, expected: ['qwen:'] },
  { qwen: false, sensevoice: true, expected: ['sensevoice:'] },
  { qwen: true, qwenError: true, sensevoice: true, expected: ['qwen3:failed', 'sensevoice:'] },
  { qwen: true, qwenError: true, sensevoice: true, sensevoiceError: true, expected: ['qwen3:failed', 'sensevoice:failed', 'whisper'] },
]) {
  test(`cloud failure follows the default sherpa order: ${opts.expected.join(' → ')}`, async () => {
    const { speech, calls } = makeService('qwen-cloud', { fallback: true, ...opts });
    await speech.ensure();
    await speech.transcribe(audio, { language: 'auto' });
    assert.deepEqual(calls, opts.expected);
  });
}
