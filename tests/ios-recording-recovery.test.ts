import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const recorder = readFileSync(new URL('../ios/Chumi/Recording/MeetingRecorder.swift', import.meta.url), 'utf8');
test('capture clock follows saved audio, detects missing input and retries on-device speech', () => {
  assert.match(recorder, /observe\(\.AVAudioEngineConfigurationChange\)/);
  assert.match(recorder, /changed === recorder.engine/);
  assert.match(recorder, /let elapsed = Int\(progress.duration \* 1000\)/);
  assert.match(recorder, /!self.engine.isRunning \|\| now - lastProgress >= 2/);
  assert.match(recorder, /speechRetryAt = ProcessInfo.processInfo.systemUptime \+ 30/);
  assert.match(recorder, /if let retry = self.speechRetryAt, now >= retry[\s\S]*?self.speechEnabled = true/);
});
