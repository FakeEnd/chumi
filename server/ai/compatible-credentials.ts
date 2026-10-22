import { createHash } from 'node:crypto';
import { COMPATIBLE_PRESETS, isCompatiblePreset, normalizeCompatibleUrl, type CompatiblePreset } from '../../shared/compatible-provider.ts';
import { deleteCredential, readCredential, storeCredential } from '../credentials.ts';

const SERVICE = 'Chumi compatible API key';

/** Include the full normalized API path: two gateways on one host must not share a key. */
export function compatibleKeyAccount(preset: CompatiblePreset, baseUrl: string): string {
  if (!isCompatiblePreset(preset)) throw new Error('Unknown model preset.');
  const url = normalizeCompatibleUrl(baseUrl, COMPATIBLE_PRESETS[preset].local);
  return `${preset}:${createHash('sha256').update(url).digest('hex')}`;
}

export async function readCompatibleKey(preset: CompatiblePreset, baseUrl: string): Promise<string | null> {
  return readCredential(SERVICE, compatibleKeyAccount(preset, baseUrl));
}

export async function storeCompatibleKey(preset: CompatiblePreset, baseUrl: string, key: string): Promise<void> {
  return storeCredential(SERVICE, compatibleKeyAccount(preset, baseUrl), key);
}

export async function deleteCompatibleKey(preset: CompatiblePreset, baseUrl: string): Promise<void> {
  return deleteCredential(SERVICE, compatibleKeyAccount(preset, baseUrl));
}
