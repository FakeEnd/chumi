import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hardwareBudget, speechMemoryReserve, localHardware } from '../server/ai/local-hardware.ts';
import { assessLocalModels, estimateModelMemory, ESTIMATE_CONTEXTS, GiB, LOCAL_MODEL_CATALOG } from '../shared/local-model-advice.ts';

const computer = (ram: number, speechModel = 'ggml-large-v3-turbo.bin') => hardwareBudget({
  platform: 'darwin', arch: 'arm64', osRelease: '25.0.0', chip: 'Apple Silicon', cores: 8,
  memoryBytes: ram * GiB, homeDiskFreeBytes: 100 * GiB, speechModel,
});

test('recommendations reserve space for Chumi and scale from 8 to 64 GiB without always choosing the largest model', () => {
  for (const [ram, context, expected] of [[8, 4096, 'qwen3-0.6b'], [16, 8192, 'qwen3-8b'], [24, 8192, 'qwen3-8b'], [64, 8192, 'qwen3-8b']] as const) {
    const hw = computer(ram);
    const rows = assessLocalModels(hw, 'ollama', context);
    const picks = rows.filter((row) => row.recommended);
    assert.equal(picks.length, 1);
    assert.equal(picks[0].model.id, expected);
    assert.ok(picks[0].memory.highBytes <= hw.modelBudgetBytes * 0.9);
    assert.ok(hw.modelBudgetBytes + hw.speechReserveBytes + hw.systemReserveBytes <= hw.memoryBytes);
    if (ram === 64) assert.equal(rows.at(-1)?.fit, 'fits');
  }
});

test('longer context accounts for KV cache and can downgrade the recommendation', () => {
  const hw = computer(16);
  const short = assessLocalModels(hw, 'ollama', 4096);
  const long = assessLocalModels(hw, 'ollama', 32768);
  assert.notEqual(short.find((row) => row.recommended)?.model.id, long.find((row) => row.recommended)?.model.id);
  for (let i = 0; i < short.length; i++) {
    assert.ok(long[i].memory.lowBytes > short[i].memory.lowBytes);
    assert.ok(long[i].memory.highBytes > short[i].memory.highBytes);
    assert.ok(long[i].memory.highBytes > long[i].download.bytes);
  }
  assert.equal(long.find((row) => row.model.id === 'qwen3-8b')?.fit, 'too_large');
  assert.throws(() => estimateModelMemory(LOCAL_MODEL_CATALOG[0], 'ollama', 1000000));
});

test('small official LM Studio GGUFs have different quantization and size from Ollama builds', () => {
  const hw = computer(8);
  const ollama = assessLocalModels(hw, 'ollama', 4096)[0];
  const studio = assessLocalModels(hw, 'lmstudio', 4096)[0];
  assert.equal(ollama.download.quantization, 'Q4_K_M');
  assert.equal(studio.download.quantization, 'Q8_0');
  assert.ok(studio.download.bytes > ollama.download.bytes);
  assert.ok(studio.memory.highBytes > ollama.memory.highBytes);
  assert.ok(studio.download.url.endsWith('Qwen3-0.6B-Q8_0.gguf'));
});

test('speech headroom follows the selected transcription model and unknown models remain conservative', () => {
  assert.ok(speechMemoryReserve('ggml-large-v3-turbo-q5_0.bin') > speechMemoryReserve('ggml-small.bin'));
  assert.ok(speechMemoryReserve('custom.bin') >= speechMemoryReserve('ggml-large-v3.bin'));
  const tiny = computer(8, 'ggml-tiny.en.bin');
  const large = computer(8, 'ggml-large-v3.bin');
  assert.ok(tiny.modelBudgetBytes > large.modelBudgetBytes);
  assert.equal(assessLocalModels(large, 'ollama', 4096).some((row) => row.recommended), false);
});

test('unsupported Macs receive no LM Studio recommendation and other platforms are not assumed to have Metal', () => {
  for (const hw of [{ ...computer(32), arch: 'x64' }, { ...computer(32), osRelease: '22.6.0' }]) {
    const rows = assessLocalModels(hw, 'lmstudio', 8192);
    assert.ok(rows.every((row) => row.fit === 'unsupported' && !row.recommended));
  }
  assert.ok(assessLocalModels({ ...computer(32), osRelease: '22.6.0' }, 'ollama', 8192)
    .every((row) => row.fit === 'unsupported' && !row.recommended));
  const cpu = hardwareBudget({ ...computer(64), platform: 'linux', arch: 'arm64' });
  assert.equal(cpu.acceleration, 'cpu-or-unknown');
  assert.equal(assessLocalModels(cpu, 'ollama', 8192).find((row) => row.recommended)?.model.id, 'qwen3-1.7b');
});

test('low disk space prevents a recommendation; unavailable disk or memory readings stay distinct', () => {
  const hw = computer(16);
  const lowDisk = assessLocalModels({ ...hw, homeDiskFreeBytes: 0 }, 'ollama', 8192);
  assert.ok(lowDisk.every((row) => row.disk === 'low' && !row.recommended));
  const unknownDisk = assessLocalModels({ ...hw, homeDiskFreeBytes: null }, 'ollama', 8192);
  assert.ok(unknownDisk.every((row) => row.disk === 'unknown'));
  assert.ok(unknownDisk.some((row) => row.recommended));
  for (const ram of [0, NaN]) {
    assert.ok(assessLocalModels(computer(ram), 'ollama', 8192).every((row) => row.fit === 'unknown' && !row.recommended));
  }
});

test('all capacity recommendations leave headroom across supported contexts and common RAM sizes', () => {
  for (const ram of [4, 8, 12, 16, 24, 32, 48, 64, 128]) for (const context of ESTIMATE_CONTEXTS) for (const preset of ['ollama', 'lmstudio'] as const) {
    const hw = computer(ram);
    const picks = assessLocalModels(hw, preset, context).filter((row) => row.recommended);
    assert.ok(picks.length <= 1);
    for (const row of picks) {
      assert.ok(row.memory.highBytes + hw.systemReserveBytes + hw.speechReserveBytes < hw.memoryBytes);
      assert.equal(row.fit, 'fits');
      assert.equal(row.disk, 'enough');
    }
  }
});

test('hardware detection works without a model service and returns only local capacity metadata', async () => {
  const hw = await localHardware('ggml-small.bin');
  assert.ok(hw.chip);
  assert.ok(hw.cores > 0 && hw.memoryBytes > 0);
  assert.ok(hw.modelBudgetBytes < hw.memoryBytes);
  assert.equal(hw.speechModel, 'ggml-small.bin');
  assert.ok(hw.homeDiskFreeBytes == null || hw.homeDiskFreeBytes >= 0);
});
