import { execFile, spawn } from 'node:child_process';
import { DESKTOP, desktopRequest } from './desktop.ts';

/**
 * API keys live in the macOS Keychain, or encrypted for the Windows account by the desktop app. Never in settings.
 * `service` and `account` are fixed strings chosen by Chumi, never user input.
 */
export async function readCredential(service: string, account: string): Promise<string | null> {
  if (DESKTOP) return desktopRequest<string | null>('credential-read', { service, account });
  return new Promise((resolve) => execFile('/usr/bin/security', ['find-generic-password', '-s', service, '-a', account, '-w'], { timeout: 5000 },
    (error, output) => resolve(error ? null : output.trim() || null)));
}

/** Keys travel over stdin, never process arguments. Do not surface security's stderr: it can echo input. */
export async function storeCredential(service: string, account: string, key: string): Promise<void> {
  if (!/^[A-Za-z0-9._~+/:=\-]{8,4096}$/.test(key)) throw new Error('Enter a valid API key without spaces or quotes.');
  if (DESKTOP) return desktopRequest<void>('credential-write', { service, account, key });
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/security', ['-i'], { stdio: ['pipe', 'ignore', 'pipe'], timeout: 5000 });
    let failed = false;
    child.stderr.on('data', (chunk: Buffer) => { if (/error|failed|denied|SecKeychain/i.test(chunk.toString())) failed = true; });
    child.on('error', () => reject(new Error('Could not save the API key in macOS Keychain.')));
    child.stdin.on('error', () => reject(new Error('Could not save the API key in macOS Keychain.')));
    child.on('close', (code) => code === 0 && !failed ? resolve() : reject(new Error('Could not save the API key in macOS Keychain.')));
    child.stdin.end(`add-generic-password -U -s "${service}" -a "${account}" -w "${key}"\n`);
  });
}

export async function deleteCredential(service: string, account: string): Promise<void> {
  if (DESKTOP) return desktopRequest<void>('credential-delete', { service, account });
  return new Promise((resolve, reject) => execFile('/usr/bin/security', ['delete-generic-password', '-s', service, '-a', account], { timeout: 5000 },
    (error) => !error || error.code === 44 ? resolve() : reject(new Error('Could not remove the API key from macOS Keychain.'))));
}
