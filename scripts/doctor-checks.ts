import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

type Package = { version?: string; integrity?: string; optional?: boolean; os?: string[]; cpu?: string[] };
type Lock = { packages: Record<string, Package> };

/** npm's installed lock omits optional packages for other operating systems and CPUs. */
export function javascriptPackages(root: string): boolean {
  try {
    const wanted = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8')) as Lock;
    const installed = JSON.parse(readFileSync(join(root, 'node_modules/.package-lock.json'), 'utf8')) as Lock;
    const matches = (list: string[] | undefined, value: string) => !list || (!list.includes(`!${value}`) && (!list.some((v) => !v.startsWith('!')) || list.includes(value)));
    return Object.entries(wanted.packages).every(([path, pkg]) => {
      if (!path || !matches(pkg.os, process.platform) || !matches(pkg.cpu, process.arch)) return true;
      const actual = installed.packages[path];
      if (!actual) return !!pkg.optional;
      return actual.version === pkg.version && actual.integrity === pkg.integrity && existsSync(join(root, path, 'package.json'));
    });
  } catch { return false; }
}

type Probe = (args: string[]) => { status: number | null; error?: Error; stdout?: string | null; stderr?: string | null };
export function commandLineTools(probe: Probe = (args) => spawnSync('xcrun', args, { encoding: 'utf8', timeout: 15_000 })) {
  for (const args of [['--find', 'swiftc'], ['swiftc', '-version']]) {
    const result = probe(args);
    if (result.error || result.status !== 0) {
      const license = /licen[cs]e/i.test(`${result.stdout ?? ''}${result.stderr ?? ''}`);
      return { ready: false, fix: license ? 'sudo xcodebuild -license accept' : 'xcode-select --install' };
    }
  }
  return { ready: true, fix: undefined };
}
