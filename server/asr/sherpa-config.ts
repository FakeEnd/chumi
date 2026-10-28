import { join } from 'node:path';
import { mostlyHan } from './clean.ts';
import type { SherpaEngineId } from './engines.ts';

export const qwenLanguage = (text: string): 'zh' | 'en' => mostlyHan(text) ? 'zh' : 'en';
export const qwenHotwords = (terms: string[]): string => [...new Set(terms.flatMap((t) => t.split(/[,，\r\n]+/)).map((t) => t.trim()).filter(Boolean))].join(',');
export const senseVoiceLanguage = (lang: string | undefined): string | null => lang?.replace(/^<\|(.+)\|>$/, '$1').trim().toLowerCase() || null;

export function sherpaConfig(engine: SherpaEngineId, dir: string, threads: number, language = 'auto') {
  return {
    featConfig: { sampleRate: 16000, featureDim: engine === 'qwen3' ? 128 : 80 },
    modelConfig: {
      ...(engine === 'qwen3' ? {
        qwen3Asr: {
          convFrontend: join(dir, 'conv_frontend.onnx'), encoder: join(dir, 'encoder.int8.onnx'),
          decoder: join(dir, 'decoder.int8.onnx'), tokenizer: join(dir, 'tokenizer'), maxNewTokens: 256,
        },
      } : {
        senseVoice: { model: join(dir, 'model.int8.onnx'), language, useInverseTextNormalization: 1 },
      }),
      tokens: engine === 'sensevoice' ? join(dir, 'tokens.txt') : '', numThreads: threads, provider: 'cpu', debug: 0,
    },
  };
}
