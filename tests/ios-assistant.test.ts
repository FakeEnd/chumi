import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const source = (path: string) => readFileSync(new URL('../ios/Chumi/' + path, import.meta.url), 'utf8');
test('answer polling survives navigation and does not hold recording or sync busy', () => {
  const view = source('Views/Meeting/MeetingDetailView.swift');
  const store = source('Models/MeetingStore.swift');
  const app = source('ChumiApp.swift');
  assert.match(view, /canStart: !starting && !store.isReadOnly/);
  assert.doesNotMatch(view, /try await poll\(/);
  assert.match(store, /pollingTasks\[key\] == nil/);
  assert.match(store, /meeting\(meetingId\)\?\.syncedServer == identity/);
  assert.match(store, /where !output.isFinished/);
  assert.match(app, /task\(id: connection.credentials\)[^\n]*resumePendingOutputs/);
  assert.match(app, /phase == \.active[^\n]*resumePendingOutputs/);
});

test('live AI commits the recognition window and syncs before asking', () => {
  const view = source('Views/Meeting/MeetingDetailView.swift');
  const recorder = source('Recording/MeetingRecorder.swift');
  const runAI = view.slice(view.indexOf('private func runAI'), view.indexOf('private func refreshOutput'));
  assert.match(runAI, /await recorder.flush\(\)[\s\S]*?await synchronize\(\)[\s\S]*?client.catchup/);
  assert.match(recorder, /func flush\(onBoundary: .* async -> Int/);
  assert.match(recorder, /let pending = Set\(windowOrder\)/);
  assert.match(recorder, /onBoundary\?\(milliseconds\)\s+commitBarrierID = nil\s+commitFinishedWindows\(\)/);

});

test('live notes commit between recognition windows and recognition language survives reopening', () => {
  const recorder = source('Recording/MeetingRecorder.swift');
  const view = source('Views/Meeting/MeetingDetailView.swift');
  assert.match(recorder, /id != commitBarrierID/);
  assert.match(recorder, /onBoundary\?\(milliseconds\)\s+commitBarrierID = nil\s+commitFinishedWindows\(\)/);
  assert.match(view, /canAddNote: !recordingTransition && !busy/);
  assert.match(view, /await recorder.flush \{ offset in[\s\S]*?runOffset \+ offset/);
  assert.match(view, /locale = meeting\?\.recognitionLocale \?\? meeting\?\.segments.last/);
});
