import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('Core Audio timestamps include sleep and silence detection re-arms on wake', { skip: process.platform !== 'darwin', timeout: 60_000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'chumi-audio-clock-'));
  try {
    writeFileSync(join(dir, 'main.swift'), `
import Foundation
import CoreAudio
final class SourcePipeline {
    let queue = DispatchQueue(label: "silence-test")
    let source = SourceID.mic
    var onInputBlock: ((Float, Double) -> Void)?
}
enum CA {
    static func get<T>(_ device: AudioObjectID, _ property: AudioObjectPropertySelector, initial: T) -> T { initial }
}
enum Options { static let debug = false }
Clock.startContinuous = 1000
Clock.ticksToSeconds = 0.001
precondition(abs(Clock.seconds(hostTime: 1200, absoluteNow: 1300, continuousNow: 1300) - 0.2) < 0.000001)
precondition(abs(Clock.seconds(hostTime: 1200, absoluteNow: 1300, continuousNow: 601300) - 600.2) < 0.000001)
Clock.startContinuous = 601000
precondition(abs(Clock.seconds(hostTime: 1200, absoluteNow: 1300, continuousNow: 601300) - 0.2) < 0.000001)
Clock.start()
precondition(abs(Clock.now()) < 1)
var silence = SilenceState(now: 100, awakeTime: 100)
precondition(silence.check(now: 109, awakeTime: 109, seconds: 10) == nil)
// A ten-minute sleep must not count as ten minutes of silent audio.
precondition(silence.check(now: 710, awakeTime: 110, seconds: 10) == nil)
precondition(silence.check(now: 719, awakeTime: 119, seconds: 10) == nil)
precondition(silence.check(now: 720, awakeTime: 120, seconds: 10) == true)
// Clear a warning from before sleep; only warn again after another full silence interval.
precondition(silence.check(now: 1321, awakeTime: 121, seconds: 10) == false)
precondition(silence.check(now: 1330, awakeTime: 130, seconds: 10) == nil)
precondition(silence.check(now: 1331, awakeTime: 131, seconds: 10) == true)
precondition(silence.signal(now: 1332))
precondition(silence.check(now: 1341, awakeTime: 141, seconds: 10) == nil)
precondition(silence.check(now: 1342, awakeTime: 142, seconds: 10) == true)
print("ok")
`);
    execFileSync('swiftc', ['-swift-version', '5', '-module-cache-path', join(dir, 'cache'), resolve('native/audio/Output.swift'), resolve('native/audio/SilenceWatch.swift'), join(dir, 'main.swift'), '-o', join(dir, 'clock')], { timeout: 50_000, stdio: 'pipe' });
    assert.equal(execFileSync(join(dir, 'clock'), { encoding: 'utf8' }).trim(), 'ok');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
