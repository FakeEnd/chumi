import { hostname } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { DATA_DIR } from '../server/paths.ts';
import { pairingCode, setupMobileConfiguration } from '../server/mobile-config.ts';

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('Usage: npm run mobile:setup -- [--address My-Mac.local] [--port 4778] [--rotate]\n\nCreates a private TLS certificate and phone pairing token. Does not start a server.\nExisting pairing is reused; --rotate revokes it after restarting the mobile server.');
  process.exit(0);
}
let address: string | undefined;
let port = 4778;
let rotate = false;
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--rotate') rotate = true;
  else if (arg === '--address' && args[i + 1]) address = args[++i];
  else if (arg === '--port' && args[i + 1]) port = Number(args[++i]);
  else throw new Error(`Unknown or incomplete option: ${arg}. Use --help.`);
}
if (!address) {
  try { address = `${execFileSync('/usr/sbin/scutil', ['--get', 'LocalHostName'], { encoding: 'utf8' }).trim()}.local`; }
  catch { const name = hostname(); address = name.includes('.') ? name : `${name}.local`; }
}
try {
  const config = setupMobileConfiguration({ directory: join(DATA_DIR, 'mobile'), address, port, rotate });
  console.log(`Chumi iPhone pairing\n\nMac address: ${config.url}\n\nOn iPhone, open Connect Mac → Paste pairing code. Copy this entire line privately:\n\n${pairingCode(config)}\n\nKeep the code private: it grants access to synced mobile meetings and AI requests.\nRun npm run start:mobile, and keep both devices on the same local network.\nIf you changed the Mac address, run this command again with --rotate --address <new-address>.`);
} catch (error) {
  console.error(`Mobile setup failed: ${(error as Error).message}`);
  process.exitCode = 1;
}
