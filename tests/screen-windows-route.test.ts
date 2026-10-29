import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Execute the real route with desktop and screen-tool stand-ins.
const main = readFileSync(new URL('../server/main.ts', import.meta.url), 'utf8');
const start = main.indexOf("route('GET', '/api/screen/windows'");
const end = main.indexOf("route('POST', '/api/screen/request'", start);
const source = main.slice(start, end);

async function windowsRoute(desktop: boolean, tool: string | null) {
  let handler!: () => Promise<unknown>;
  const windows = [{ id: 1, app: 'Slides', title: 'Talk' }];
  new Function('route', 'DESKTOP', 'findScreenTool', 'screenPermission', 'listWindows', source)(
    (_method: string, _path: string, h: () => Promise<unknown>) => { handler = h; }, desktop, () => tool,
    async () => 'granted', async () => ({ windows }),
  );
  return handler();
}

test('screen windows reports desktop capture as available without a native screen tool', async () => {
  assert.deepEqual(await windowsRoute(true, null), { permission: 'granted', toolBuilt: true, windows: [{ id: 1, app: 'Slides', title: 'Talk' }] });
  assert.equal((await windowsRoute(false, null) as { toolBuilt: boolean }).toolBuilt, false);
  assert.equal((await windowsRoute(false, '/screen-tool') as { toolBuilt: boolean }).toolBuilt, true);
});
