import { createRequire } from 'node:module';
import { join } from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';

interface Stream {
  setOption(key: string, value: string): void;
  acceptWaveform(wave: { sampleRate: number; samples: Float32Array }): void;
}
interface Recognizer {
  createStream(): Stream;
  decodeAsync(stream: Stream): Promise<{ text: string }>;
  getResult(stream: Stream): { text: string };
}
interface Request { id: number; samples: Int16Array; language: string; hotwords: string }

try {
  const { OfflineRecognizer } = createRequire(import.meta.url)('sherpa-onnx-node') as {
    OfflineRecognizer: { createAsync(config: unknown): Promise<Recognizer> };
  };
  const { dir, threads } = workerData as { dir: string; threads: number };
  const recognizer = await OfflineRecognizer.createAsync({
    featConfig: { sampleRate: 16000, featureDim: 128 },
    modelConfig: {
      qwen3Asr: {
        convFrontend: join(dir, 'conv_frontend.onnx'), encoder: join(dir, 'encoder.int8.onnx'),
        decoder: join(dir, 'decoder.int8.onnx'), tokenizer: join(dir, 'tokenizer'), maxNewTokens: 256,
      },
      tokens: '', numThreads: threads, provider: 'cpu', debug: 0,
    },
  });
  let queue = Promise.resolve();
  parentPort!.on('message', (request: Request) => {
    queue = queue.then(async () => {
      try {
        const stream = recognizer.createStream();
        stream.setOption('hotwords', request.hotwords);
        if (request.language !== 'auto') stream.setOption('language', request.language === 'zh' ? 'Chinese' : 'English');
        stream.acceptWaveform({ sampleRate: 16000, samples: Float32Array.from(request.samples, (s) => s / 32768) });
        await recognizer.decodeAsync(stream);
        parentPort!.postMessage({ id: request.id, text: recognizer.getResult(stream).text.trim() });
      } catch (e) { parentPort!.postMessage({ id: request.id, error: (e as Error).message }); }
    });
  });
  parentPort!.postMessage({ ready: true });
} catch (e) {
  parentPort!.postMessage({ error: (e as Error).message });
  parentPort!.close();
}
