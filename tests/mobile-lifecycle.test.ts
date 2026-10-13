import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/db.ts';
import { SessionManager } from '../server/session/manager.ts';
import type { WhisperServer } from '../server/asr/whisper.ts';
import type { Assistant } from '../server/ai/assistant.ts';

test('Mac recovery and resume never take ownership of a phone recording', async () => {
  const store = new Store(':memory:');
  let starts = 0;
  const manager = new SessionManager(store, { ensure: async () => { starts++; } } as unknown as WhisperServer, {} as Assistant, () => {});
  try {
    store.createSession({ id: 'phone', title: 'Phone', type: 'other', audio_source: 'mobile' });
    store.createSession({ id: 'desktop', title: 'Desktop', type: 'other', audio_source: 'mic' });
    manager.recoverOnBoot();
    assert.equal(store.getSession('phone')?.status, 'recording');
    assert.equal(store.timeline('phone').length, 0);
    assert.equal(store.getSession('desktop')?.status, 'interrupted');
    await assert.rejects(manager.resumeSession('phone', 'mic'), /iPhone/);
    assert.equal(starts, 0);
    assert.equal(manager.status, 'idle');
    assert.equal(manager.session, null);
  } finally { store.close(); }
});
