const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

module.exports = async ({ appOutDir }) => {
  const backend = path.join(appOutDir, 'resources', 'backend');
  const metadata = JSON.parse(fs.readFileSync(path.join(backend, 'package.json'), 'utf8'));
  for (const name of Object.keys(metadata.dependencies)) {
    const manifest = path.join(backend, 'node_modules', name, 'package.json');
    if (!fs.existsSync(manifest)) throw new Error(`Windows package is missing backend dependency ${name}.`);
  }
  // Validate the actual bundled Node and SDK entry points before generating an installer.
  execFileSync(path.join(appOutDir, 'resources', 'runtime', 'node.exe'), [
    '--input-type=module', '--eval',
    'await import("@anthropic-ai/sdk"); await import("@modelcontextprotocol/sdk/client/index.js"); await import("cross-spawn"); await import("node:sqlite");',
  ], { cwd: backend, windowsHide: true, stdio: 'pipe' });
};
