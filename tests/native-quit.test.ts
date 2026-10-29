import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import type { Assistant } from '../server/ai/assistant.ts';
import type { SpeechService } from '../server/asr/speech.ts';
import { quitCheck } from '../server/quit-check.ts';

const root = mkdtempSync(join(tmpdir(), 'chumi-native-quit-'));
process.env.CHUMI_DATA_DIR = root;
const { Store } = await import('../server/db.ts');
const { SessionManager } = await import('../server/session/manager.ts');
test.after(() => rmSync(root, { recursive: true, force: true }));

test('the quit endpoint covers End, deferred speaker summaries and AI work across meetings without provider calls', async () => {
  const store = new Store(':memory:');
  const assistant = { summary(id: string) { store.insertOutput({ id: 'summary', session_id: id, kind: 'final_summary', status: 'pending' }); } } as unknown as Assistant;
  const manager = new SessionManager(store, {} as SpeechService, assistant, () => {});
  const main = readFileSync(new URL('../server/main.ts', import.meta.url), 'utf8');
  const route = main.split('\n').find((line) => line.startsWith("route('GET', '/api/quit-check'"))!;
  assert.ok(route);
  let check!: () => ReturnType<typeof quitCheck>;
  new Function('route', 'quitCheck', 'store', 'manager', route)(
    (_method: string, _path: string, handler: typeof check) => { check = handler; }, quitCheck, store, manager,
  );
  try {
    assert.deepEqual(check(), { status: 'idle', pendingOutputs: 0, handoffGenerating: false, pendingSummaries: 0 });
    manager.session = store.createSession({ id: 'meeting', title: 'Meeting', type: 'other', audio_source: 'file' });
    store.addSegment({ session_id: 'meeting', source: 'file', run: 1, t_start: 0, t_end: 1000, text: 'Fixture transcript.', lang: 'en' });
    manager.status = 'recording';
    assert.equal(check().status, 'recording');
    manager.status = 'paused';
    assert.equal(check().status, 'paused');
    let speakersDone!: () => void;
    manager.beforeSummary = () => new Promise<void>((resolve) => { speakersDone = resolve; });
    const ending = manager.end();
    assert.equal(check().status, 'ending');
    await ending;
    assert.deepEqual(check(), { status: 'idle', pendingOutputs: 0, handoffGenerating: false, pendingSummaries: 1 });
    speakersDone(); await setImmediate();
    assert.equal(check().pendingSummaries, 0);
    assert.equal(check().pendingOutputs, 1);
    store.updateOutput('summary', { status: 'streaming' });
    assert.equal(check().pendingOutputs, 1);
    store.updateOutput('summary', { status: 'done' });
    store.createSession({ id: 'older', title: 'Older meeting', type: 'other', audio_source: 'file' });
    store.createHandoff({ id: 'handoff', session_id: 'older', project_id: null, status: 'generating' });
    assert.equal(check().handoffGenerating, true);
    store.updateHandoff('handoff', { status: 'draft' });
    assert.deepEqual(check(), { status: 'idle', pendingOutputs: 0, handoffGenerating: false, pendingSummaries: 0 });
  } finally { store.close(); }
});

test('the macOS quit decision protects active meetings, finishing work and unanswered checks', {
  skip: process.platform !== 'darwin', timeout: 90_000,
}, () => {
  const source = join(root, 'main.swift'), binary = join(root, 'quit-test');
  writeFileSync(source, String.raw`
import Foundation
func check(_ status: String, outputs: Int = 0, handoff: Bool = false, summaries: Int = 0) -> QuitCheck {
    QuitCheck.parse((200, ["status": status, "pendingOutputs": outputs, "handoffGenerating": handoff, "pendingSummaries": summaries]))
}
for status in ["recording", "paused", "starting"] { precondition(check(status) == .active) }
precondition(check("ending") == .finishing)
precondition(check("idle", outputs: 1) == .finishing)
precondition(check("idle", handoff: true) == .finishing)
precondition(check("idle", summaries: 1) == .finishing)
precondition(check("idle") == .idle)
precondition(check("unexpected") == .unknown)
precondition(check("idle", outputs: -1) == .unknown)
precondition(QuitCheck.parse(nil) == .unknown)
precondition(QuitCheck.parse((503, nil)) == .unknown)
precondition(QuitCheck.parse((200, ["status": "idle"])) == .unknown)

var lifecycle = ServerLifecycle()
let starting = Process(), previous = Process()
var requests = 0
func unavailable() -> (Int, [String: Any]?)? { requests += 1; return nil }
precondition(lifecycle.beginStart())
precondition(lifecycle.quitCheck(for: starting, fetch: unavailable) == .idle)
precondition(requests == 0, "Do not probe a child that has never passed health")
lifecycle.markReady(previous)
precondition(lifecycle.quitCheck(for: starting, fetch: unavailable) == .idle)
precondition(requests == 0, "Another child's ready state does not make this child ready")
lifecycle.markReady(starting)
precondition(lifecycle.quitCheck(for: starting, fetch: unavailable) == .unknown)
precondition(requests == 1, "A ready server that stops answering still needs confirmation")
precondition(lifecycle.quitCheck(for: starting) { (200, ["status": "ending", "pendingOutputs": 0, "handoffGenerating": false, "pendingSummaries": 0]) } == .finishing)
precondition(lifecycle.quitCheck(for: nil, fetch: unavailable) == .idle)
lifecycle.stop()
precondition(lifecycle.quitCheck(for: starting, fetch: unavailable) == .idle)
precondition(requests == 1)
print("quit-check-ok")
`);
  execFileSync('/usr/bin/swiftc', [resolve('native/app/ServerManager.swift'), resolve('native/app/ShellLocalization.swift'), source, '-module-cache-path', join(root, 'swift-cache'), '-o', binary], { timeout: 60_000, stdio: 'pipe' });
  assert.match(execFileSync(binary, { timeout: 5000, encoding: 'utf8' }), /quit-check-ok/);
});
