import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const recorder = readFileSync(new URL('../ios/Chumi/Recording/MeetingRecorder.swift', import.meta.url), 'utf8');
const view = readFileSync(new URL('../ios/Chumi/Views/Meeting/MeetingDetailView.swift', import.meta.url), 'utf8');

test('iOS recording keeps the screen awake only while capture is running', () => {
  assert.match(recorder, /@MainActor\s+final class MeetingRecorder/);
  const start = recorder.slice(recorder.indexOf('    func start('), recorder.indexOf('    func stop()'));
  assert.match(start, /try engine\.start\(\)[\s\S]*?isRecording = true\s+UIApplication\.shared\.isIdleTimerDisabled = true/);
  assert.match(start, /\} catch \{\s+UIApplication\.shared\.isIdleTimerDisabled = false/);
  const stop = recorder.slice(recorder.indexOf('    func stop()'), recorder.indexOf('    private func beginRecognitionWindow('));
  assert.match(stop, /guard isRecording else \{ return \}\s+isStopping = true\s+UIApplication\.shared\.isIdleTimerDisabled = false/);
  assert.ok(stop.indexOf('isIdleTimerDisabled = false') < stop.indexOf('await sink.finish()'));
});

test('interruptions, backgrounding and leaving the view use the recording stop path', () => {
  for (const notification of ['AVAudioSession.interruptionNotification', 'AVAudioSession.routeChangeNotification', 'AVAudioSession.mediaServicesWereResetNotification', 'UIApplication.didEnterBackgroundNotification']) {
    const observer = recorder.slice(recorder.indexOf(`observe(${notification})`));
    assert.match(observer.slice(0, observer.indexOf('\n        }')), /stopForInterruption\(/, notification);
  }
  assert.match(recorder, /private func stopForInterruption[\s\S]*?Task \{ \[weak self\] in\s+await self\?\.stop\(\)/);
  assert.match(view, /\.onDisappear \{[\s\S]*?await recorder\.stop\(\)/);
});
