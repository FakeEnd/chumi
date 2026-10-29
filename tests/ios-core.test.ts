import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('iOS models, persistence and network decoding compile and pass core checks', { skip: process.platform !== 'darwin' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'chumi-ios-core-'));
  try {
    for (const language of ['en', 'zh-Hans']) {
      const bundle = join(dir, language + '.lproj');
      mkdirSync(bundle);
      for (const table of ['Localizable', 'InfoPlist']) {
        const catalog = JSON.parse(readFileSync(`ios/Chumi/${table}.xcstrings`, 'utf8'));
        const strings = Object.entries(catalog.strings).map(([key, entry]: [string, any]) =>
          `${JSON.stringify(key)} = ${JSON.stringify(entry.localizations[language].stringUnit.value)};`).join('\n');
        writeFileSync(join(bundle, table + '.strings'), strings);
      }
    }
    const binary = join(dir, 'checks');
    execFileSync('xcrun', ['swiftc', '-module-cache-path', join(dir, 'cache'), '-o', binary,
      'ios/Chumi/Models/RecoveryPolicy.swift', 'ios/Chumi/Models/Meeting.swift', 'ios/Chumi/Models/MeetingStore.swift',
      'ios/Chumi/Networking/MobileEndpoint.swift', 'ios/Chumi/Networking/ConnectionStore.swift',
      'ios/Chumi/Networking/MobileAPI.swift', 'ios/Tests/CoreChecks.swift'], { stdio: 'pipe', timeout: 120_000 });
    execFileSync(binary, [dir], { stdio: 'pipe', timeout: 15_000 });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
