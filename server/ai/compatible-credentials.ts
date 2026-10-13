import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { COMPATIBLE_PRESETS, isCompatiblePreset, normalizeCompatibleUrl, type CompatiblePreset } from '../../shared/compatible-provider.ts';
import { DESKTOP, desktopRequest } from '../desktop.ts';

const SERVICE = 'Chumi compatible API key';

/** Include the full normalized API path: two gateways on one host must not share a key. */
export function compatibleKeyAccount(preset: CompatiblePreset, baseUrl: string): string {
  if (!isCompatiblePreset(preset)) throw new Error('Unknown model preset.');
  const url = normalizeCompatibleUrl(baseUrl, COMPATIBLE_PRESETS[preset].local);
  return `${preset}:${createHash('sha256').update(url).digest('hex')}`;
}

export async function readCompatibleKey(preset: CompatiblePreset, baseUrl: string): Promise<string | null> {
  const account = compatibleKeyAccount(preset, baseUrl);
  if (DESKTOP) return desktopRequest<string | null>('credential-read', { service: SERVICE, account });
  return new Promise((resolve) => execFile('/usr/bin/security', ['find-generic-password', '-s', SERVICE, '-a', account, '-w'], { timeout: 5000 },
    (error, output) => resolve(error ? null : output.trim() || null)));
}

/** Keys travel over stdin, never process arguments. Do not surface security's stderr: it can echo input. */
export async function storeCompatibleKey(preset: CompatiblePreset, baseUrl: string, key: string): Promise<void> {
  const account = compatibleKeyAccount(preset, baseUrl);
  if (!/^[A-Za-z0-9._~+/:=\-]{8,4096}$/.test(key)) throw new Error('Enter a valid API key without spaces or quotes.');
  if (DESKTOP) return desktopRequest<void>('credential-write', { service: SERVICE, account, key });
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/security', ['-i'], { stdio: ['pipe', 'ignore', 'pipe'], timeout: 5000 });
    let failed = false;
    child.stderr.on('data', (chunk: Buffer) => { if (/error|failed|denied|SecKeychain/i.test(chunk.toString())) failed = true; });
    child.on('error', () => reject(new Error('Could not save the API key in macOS Keychain.')));
    child.stdin.on('error', () => reject(new Error('Could not save the API key in macOS Keychain.')));
    child.on('close', (code) => code === 0 && !failed ? resolve() : reject(new Error('Could not save the API key in macOS Keychain.')));
    child.stdin.end(`add-generic-password -U -s "${SERVICE}" -a "${account}" -w "${key}"\n`);
  });
}

export async function deleteCompatibleKey(preset: CompatiblePreset, baseUrl: string): Promise<void> {
  const account = compatibleKeyAccount(preset, baseUrl);
  if (DESKTOP) return desktopRequest<void>('credential-delete', { service: SERVICE, account });
  return new Promise((resolve, reject) => execFile('/usr/bin/security', ['delete-generic-password', '-s', SERVICE, '-a', account], { timeout: 5000 },
    (error) => !error || error.code === 44 ? resolve() : reject(new Error('Could not remove the API key from macOS Keychain.'))));
}
