import { createHash, randomBytes, X509Certificate } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { join, resolve } from 'node:path';

export interface MobileConfiguration {
  version: 1;
  host: string;
  port: number;
  url: string;
  token: string;
  certificatePath: string;
  privateKeyPath: string;
  certificateSHA256: string;
}

export function validateMobileAddress(address: string): string {
  // A host only: never allow OpenSSL configuration fragments, URLs, or shell syntax.
  if (isIP(address)) return address;
  if (address.length > 253 || !address.split('.').every((part) => /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(part))) {
    throw new Error('Use a Mac hostname (such as My-Mac.local) or an IP address, without a URL or port.');
  }
  return address;
}

export function certificateFingerprint(pem: string | Buffer): string {
  return createHash('sha256').update(new X509Certificate(pem).raw).digest('hex');
}

export function loadMobileConfiguration(path: string): MobileConfiguration & { tls: { key: Buffer; cert: Buffer } } {
  if (!existsSync(path)) throw new Error('Mobile pairing is not configured. Run npm run mobile:setup first.');
  const value = JSON.parse(readFileSync(path, 'utf8')) as MobileConfiguration;
  if (value.version !== 1 || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535 ||
      typeof value.host !== 'string' || !isIP(value.host) || typeof value.token !== 'string' || !/^[A-Za-z0-9_-]{43,}$/.test(value.token) ||
      typeof value.certificatePath !== 'string' || typeof value.privateKeyPath !== 'string' || typeof value.url !== 'string' ||
      !/^[a-f0-9]{64}$/.test(value.certificateSHA256)) {
    throw new Error('Invalid mobile configuration. Recreate it with npm run mobile:setup -- --rotate.');
  }
  const url = new URL(value.url);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash || Number(url.port || 443) !== value.port) {
    throw new Error('Invalid mobile HTTPS address.');
  }
  const cert = readFileSync(value.certificatePath);
  const key = readFileSync(value.privateKeyPath);
  if (certificateFingerprint(cert) !== value.certificateSHA256) throw new Error('The mobile certificate changed. Pair the phone again.');
  const x509 = new X509Certificate(cert);
  if (Date.parse(x509.validTo) <= Date.now()) throw new Error('The mobile certificate expired. Run npm run mobile:setup -- --rotate and pair again.');
  return { ...value, tls: { key, cert } };
}

export function setupMobileConfiguration(options: { directory: string; address: string; port?: number; rotate?: boolean }): MobileConfiguration {
  const dir = resolve(options.directory);
  const path = join(dir, 'companion.json');
  if (existsSync(path) && !options.rotate) {
    const { tls: _tls, ...existing } = loadMobileConfiguration(path);
    return existing;
  }
  const address = validateMobileAddress(options.address);
  const port = options.port ?? 4778;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be an integer between 1 and 65535.');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  // New files for each rotation keep the old pairing intact if certificate creation fails.
  const suffix = randomBytes(8).toString('hex');
  const privateKeyPath = join(dir, `key-${suffix}.pem`);
  const certificatePath = join(dir, `cert-${suffix}.pem`);
  writeFileSync(privateKeyPath, '', { mode: 0o600 });
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-nodes',
    '-keyout', privateKeyPath, '-out', certificatePath, '-days', '365', '-subj', '/CN=Chumi Mobile Companion',
    '-addext', `subjectAltName=${isIP(address) ? 'IP' : 'DNS'}:${address}`], { stdio: ['ignore', 'ignore', 'pipe'] });
  chmodSync(privateKeyPath, 0o600);
  chmodSync(certificatePath, 0o600);
  const value: MobileConfiguration = {
    version: 1, host: isIP(address) === 6 ? '::' : '0.0.0.0', port,
    url: `https://${isIP(address) === 6 ? `[${address}]` : address}:${port}`,
    token: randomBytes(32).toString('base64url'), certificatePath, privateKeyPath,
    certificateSHA256: certificateFingerprint(readFileSync(certificatePath)),
  };
  const pendingPath = join(dir, `companion-${suffix}.json`);
  writeFileSync(pendingPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(pendingPath, path);
  return value;
}

export function pairingCode(config: MobileConfiguration): string {
  return JSON.stringify({ url: config.url, token: config.token, certificateSHA256: config.certificateSHA256 });
}
