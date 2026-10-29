import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const view = readFileSync(new URL('../ios/Chumi/Views/Meeting/MeetingDetailView.swift', import.meta.url), 'utf8');
test('leaving an active iPhone recording requires confirmation and finishes saving before dismissal', () => {
  assert.match(view, /navigationBarBackButtonHidden\(recordingBusy\)/);
  assert.match(view, /RecordingNavigationGuard\(isLocked: recordingBusy\)/);
  const confirmation = view.slice(view.indexOf('.confirmationDialog('), view.indexOf('.sheet('));
  assert.match(confirmation, /await recorder\.stop\(\)\s+finishRecording\(\)\s+dismiss\(\)/);
  assert.match(view, /current\.isEnabled = false/);
  assert.match(view, /dismantleUIViewController[^\n]*controller\.restore\(\)/);
  assert.match(view, /gesture\?\.isEnabled = wasEnabled/);
});
