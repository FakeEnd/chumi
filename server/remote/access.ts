/**
 * Phone access: pairing and device tokens for the Chumi phone app (android/). The phone reaches this computer's
 * Chumi over the local network or a VPN such as Tailscale, on a separate port that is off until the user turns it
 * on (Settings → Phone). A phone pairs once with a short code shown here, then sends a long random token with every
 * request. Only token hashes are stored. Plain HTTP: use it on a trusted network or a VPN.
 */
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { uid } from '../util.ts';

export interface RemoteDevice { id: string; name: string; createdAt: number; lastSeenAt: number | null }
interface StoredDevice extends RemoteDevice { tokenHash: string }

const CODE_TTL_MS = 5 * 60_000;
const CODE_ATTEMPTS = 5;
const hash = (token: string) => createHash('sha256').update(token).digest('hex');

export class RemoteAccess {
  private file: string;
  private list: StoredDevice[];
  private code: { value: string; expiresAt: number; attempts: number } | null = null;

  constructor(file: string) {
    this.file = file;
    try { this.list = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as StoredDevice[] : []; } catch { this.list = []; }
  }

  devices(): RemoteDevice[] { return this.list.map(({ tokenHash: _t, ...d }) => d); }

  /** A new six-digit pairing code; any earlier code stops working. */
  newCode(): { code: string; expiresAt: number } {
    this.code = { value: String(randomInt(0, 1_000_000)).padStart(6, '0'), expiresAt: Date.now() + CODE_TTL_MS, attempts: 0 };
    return { code: this.code.value, expiresAt: this.code.expiresAt };
  }

  /** Exchanges a valid pairing code for a device token. Each code works once and allows a few wrong guesses. */
  pair(code: string, name: string): { token: string; device: RemoteDevice } {
    const c = this.code;
    if (!c || Date.now() > c.expiresAt) throw new Error('No pairing code is active. Show a new code in Chumi on the computer.');
    if (String(code).trim() !== c.value) {
      if (++c.attempts >= CODE_ATTEMPTS) this.code = null;
      throw new Error('Wrong pairing code.');
    }
    this.code = null;
    const token = randomBytes(32).toString('base64url');
    const device: StoredDevice = { id: uid('dev_'), name: String(name || 'Phone').trim().slice(0, 80) || 'Phone', createdAt: Date.now(), lastSeenAt: null, tokenHash: hash(token) };
    this.list.push(device);
    this.save();
    const { tokenHash: _t, ...pub } = device;
    return { token, device: pub };
  }

  /** The paired device a token belongs to, or null. */
  authenticate(token: string | null | undefined): RemoteDevice | null {
    if (!token) return null;
    const h = Buffer.from(hash(token), 'hex');
    const d = this.list.find((x) => timingSafeEqual(Buffer.from(x.tokenHash, 'hex'), h));
    if (!d) return null;
    if (!d.lastSeenAt || Date.now() - d.lastSeenAt > 60_000) { d.lastSeenAt = Date.now(); this.save(); }
    const { tokenHash: _t, ...pub } = d;
    return pub;
  }

  revoke(id: string): boolean {
    const before = this.list.length;
    this.list = this.list.filter((d) => d.id !== id);
    if (this.list.length !== before) this.save();
    return this.list.length !== before;
  }

  private save(): void {
    writeFileSync(`${this.file}.tmp`, JSON.stringify(this.list, null, 1), { mode: 0o600 });
    renameSync(`${this.file}.tmp`, this.file);
  }
}

/** Addresses a phone can use for this computer: its IPv4 addresses on the local network and on VPNs. */
export function remoteUrls(port: number): string[] {
  const out: string[] = [];
  for (const addrs of Object.values(networkInterfaces())) {
    // 198.18.0.0/15 is a benchmarking range that proxy tools use for their virtual network adapters.
    for (const a of addrs ?? []) if (a.family === 'IPv4' && !a.internal && !/^198\.1[89]\./.test(a.address)) out.push(`http://${a.address}:${port}`);
  }
  return out;
}

/** The token in "Authorization: Bearer …", or in the chumi_device cookie that the app sets for its web view. */
export function requestToken(headers: { authorization?: string; cookie?: string }): string | null {
  const bearer = headers.authorization?.match(/^Bearer\s+(\S+)$/i)?.[1];
  if (bearer) return bearer;
  return headers.cookie?.split(';').map((c) => c.trim()).find((c) => c.startsWith('chumi_device='))?.slice('chumi_device='.length) || null;
}
