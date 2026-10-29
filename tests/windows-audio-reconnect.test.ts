import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Compile the actual retry and recovery blocks with tiny substitutes for WASAPI and its event sink.
// The full helper still needs a Windows SDK build and real device-disconnect testing.
test('Windows audio warns once per outage, backs off with interruptible waits and resets after recovery', { skip: process.platform === 'win32' }, () => {
  const source = readFileSync(new URL('../native/windows/audio/main.cpp', import.meta.url), 'utf8');
  const declarations = source.match(/        bool announced = false;([\s\S]*?)        try \{ check\(CoCreateInstance/)?.[0].split('        try {')[0];
  const success = source.match(/check\(client->Start\(\), "Start audio device"\);([\s\S]*?)                double lastPacket/)?.[1];
  const failure = source.match(/client->Stop\(\); flush\(\); nextTime = -1;\s*\} catch \(const AudioError& error\) \{([\s\S]*?)\n            \}/)?.[1];
  assert.ok(declarations && success && failure);
  const temp = mkdtempSync(join(tmpdir(), 'chumi-win-audio-'));
  try {
    const file = join(temp, 'reconnect.cpp'), binary = join(temp, 'reconnect');
    writeFileSync(file, `
#include <algorithm>
#include <cassert>
#include <map>
#include <string>
#include <vector>
using DWORD = unsigned;
using Fields = std::map<std::string, std::string>;
const unsigned WAIT_OBJECT_0 = 0;
int stopEvent = 0;
bool stopping = false;
std::vector<unsigned> waits;
unsigned WaitForSingleObject(int, unsigned ms) { waits.push_back(ms); return stopping ? WAIT_OBJECT_0 : 258; }
struct Started { Fields value; void set_value(const Fields& next) { value = next; } };
int main() {
${declarations}
  Started started;
  int id = 1, flushed = 0, nextTime = 5;
  std::string friendlyName = "USB mic", uid = "device", error = "missing";
  std::vector<Fields> events;
  auto event = [&](const Fields& value) { events.push_back(value); };
  auto errorMessage = [](const std::string& value) { return value; };
  auto utf8 = [](const std::string& value) { return value; };
  auto flush = [&] { flushed++; };
  bool returnedFromWait = false;
  auto fail = [&] {
${failure}
    returnedFromWait = true;
  };
  auto recover = [&] {
${success}
  };
  fail();
  assert(started.value.at("error") == "missing" && waits.empty() && events.empty());
  recover();
  assert(announced && started.value.at("name") == "USB mic" && events.empty());
  for (int i = 0; i < 1200; i++) fail();
  assert(events.size() == 1 && events[0].at("code") == "device_disconnected");
  assert(waits[0] == 1000 && waits[1] == 2000 && waits[2] == 5000);
  assert(std::all_of(waits.begin() + 3, waits.end(), [](unsigned delay) { return delay == 10000; }));
  assert(flushed == 1200 && nextTime == -1);
  recover();
  assert(events.size() == 2 && events[1].at("type") == "device_changed");
  fail();
  assert(events.size() == 3 && waits.back() == 1000);
  returnedFromWait = false; stopping = true;
  fail();
  assert(!returnedFromWait && events.size() == 3 && waits.back() == 2000);
}
`);
    execFileSync(process.platform === 'darwin' ? 'clang++' : 'c++', ['-std=c++17', '-Wall', '-Wextra', '-Werror', file, '-o', binary], { timeout: 30000 });
    execFileSync(binary, [], { timeout: 5000 });
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
