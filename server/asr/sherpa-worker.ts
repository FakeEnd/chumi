import { createRequire } from 'node:module';
import { parentPort, workerData } from 'node:worker_threads';
import { sherpaConfig } from './sherpa-config.ts';
import type { SherpaEngineId } from './engines.ts';

interface Stream {
  setOption(key: string, value: string): void;
  acceptWaveform(wave: { sampleRate: number; samples: Float32Array }): void;
}
interface Recognizer {
  createStream(): Stream;
  setConfig(config: unknown): void;
  decodeAsync(stream: Stream): Promise<{ text: string; lang?: string }>;
}
interface Request { id: number; samples: Int16Array; language: string; hotwords: string }

try {
  const { OfflineRecognizer } = createRequire(import.meta.url)('sherpa-onnx-node') as {
    OfflineRecognizer: { createAsync(config: unknown): Promise<Recognizer> };
  };
  const { engine, dir, threads } = workerData as { engine: SherpaEngineId; dir: string; threads: number };
  const recognizer = await OfflineRecognizer.createAsync(sherpaConfig(engine, dir, threads));
  let language = 'auto';
  let queue = Promise.resolve();
  parentPort!.on('message', (request: Request) => {
    queue = queue.then(async () => {
      try {
        if (engine === 'sensevoice' && language !== request.language) {
          recognizer.setConfig(sherpaConfig(engine, dir, threads, request.language));
          language = request.language;
        }
        const stream = recognizer.createStream();
        if (engine === 'qwen3') {
          stream.setOption('hotwords', request.hotwords);
          if (request.language !== 'auto') stream.setOption('language', request.language === 'zh' ? 'Chinese' : 'English');
        }
        stream.acceptWaveform({ sampleRate: 16000, samples: Float32Array.from(request.samples, (s) => s / 32768) });
        const result = await recognizer.decodeAsync(stream);
        parentPort!.postMessage({ id: request.id, text: result.text.trim(), lang: result.lang });
      } catch (e) { parentPort!.postMessage({ id: request.id, error: (e as Error).message }); }
    });
  });
  parentPort!.postMessage({ ready: true });
} catch (e) {
  parentPort!.postMessage({ error: (e as Error).message });
  parentPort!.close();
}
