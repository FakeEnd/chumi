"""Build Windows audio and a self-contained Electron installer. Python is only a developer dependency."""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import urllib.request
import tarfile

ROOT = Path(__file__).resolve().parents[1]
BUILD = ROOT / 'build' / 'windows'


def run(args, **kwargs):
    print('>', ' '.join(map(str, args)), flush=True)
    env = os.environ.copy()
    env.pop('ELECTRON_RUN_AS_NODE', None)
    temp = BUILD / 'tmp'
    temp.mkdir(parents=True, exist_ok=True)
    env.update(ELECTRON_BUILDER_CACHE=str(BUILD / 'cache'), TEMP=str(temp), TMP=str(temp))
    if Path(args[0]).name.lower() == 'node.exe':
        env['PATH'] = str(Path(args[0]).parent) + os.pathsep + env.get('PATH', '')
    subprocess.run(list(map(str, args)), cwd=ROOT, check=True, env=env, **kwargs)


def download(url, destination):
    if destination.exists():
        return
    destination.parent.mkdir(parents=True, exist_ok=True)
    print('Downloading', destination.name, flush=True)
    part = destination.with_suffix(destination.suffix + '.part')
    urllib.request.urlretrieve(url, part)
    part.replace(destination)


def build_audio():
    vendor = BUILD / 'vendor'
    download('https://raw.githubusercontent.com/nlohmann/json/v3.12.0/single_include/nlohmann/json.hpp', vendor / 'json.hpp')
    download('https://raw.githubusercontent.com/nlohmann/json/v3.12.0/LICENSE.MIT', vendor / 'json-LICENSE.txt')
    source = ROOT / 'native' / 'windows' / 'audio' / 'main.cpp'
    output = ROOT / 'build' / 'chumi-audio.exe'
    if output.exists() and output.stat().st_mtime >= max(source.stat().st_mtime, (vendor / 'json.hpp').stat().st_mtime):
        return
    compiler = shutil.which('g++')
    if not compiler:
        raise RuntimeError('Install MinGW-w64 g++ (MSYS2 mingw-w64-x86_64-gcc) to build the audio helper.')
    run([compiler, '-std=c++17', '-O2', '-Wall', '-Wextra', '-static', '-static-libgcc', '-static-libstdc++', '-municode',
         '-I', vendor, source, '-o', output, '-lole32', '-lpropsys', '-luuid'])
    run([output, '--version'])


def stage_backend(node):
    backend = BUILD / 'backend'
    backend.mkdir(parents=True, exist_ok=True)
    for folder in ['server', 'shared', 'assets/bench']:
        target = backend / folder
        if target.exists():
            shutil.rmtree(target)
        shutil.copytree(ROOT / folder, target)
    web = backend / 'web' / 'dist'
    if web.exists():
        shutil.rmtree(web)
    shutil.copytree(ROOT / 'web' / 'dist', web)
    for name in ['package.json', 'package-lock.json', 'LICENSE']:
        shutil.copy2(ROOT / name, backend / name)
    npm = node.parent / 'node_modules' / 'npm' / 'bin' / 'npm-cli.js'
    run([node, npm, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', backend])
    runtime = BUILD / 'runtime'
    runtime.mkdir(exist_ok=True)
    shutil.copy2(node, runtime / 'node.exe')
    shutil.copy2(node.parent / 'LICENSE', runtime / 'Node-LICENSE.txt')
    # Include the official CLI so a fresh Windows install can sign in from Chumi without npm or a terminal.
    codex_version = '0.125.0'
    tools = BUILD / 'vendor' / 'codex'
    if not (tools / 'vendor').exists():
        archive = BUILD / 'vendor' / f'codex-win32-x64-{codex_version}.tgz'
        download(f'https://registry.npmjs.org/@openai/codex/-/codex-{codex_version}-win32-x64.tgz', archive)
        tools.mkdir(exist_ok=True)
        with tarfile.open(archive, 'r:gz') as bundle:
            bundle.extractall(tools, filter='data')
        (tools / 'package' / 'vendor').rename(tools / 'vendor')
    for file in (tools / 'vendor').rglob('*.exe'):
        shutil.copy2(file, runtime / file.name)
    (runtime / 'Codex-NOTICE.txt').write_text(f'OpenAI Codex CLI {codex_version}\nhttps://github.com/openai/codex\nApache License 2.0\n', encoding='utf-8')
    download('https://raw.githubusercontent.com/openai/codex/rust-v0.125.0/LICENSE', runtime / 'Codex-LICENSE.txt')
    whisper = backend / 'build' / 'whisper'
    whisper.mkdir(parents=True, exist_ok=True)
    source = ROOT / 'build' / 'whisper'
    if not (source / 'whisper-server.exe').exists():
        raise RuntimeError('Install whisper.cpp in build/whisper before packaging (see docs/windows.md).')
    for file in source.iterdir():
        if file.suffix.lower() == '.dll' or file.name == 'whisper-server.exe':
            shutil.copy2(file, whisper / file.name)
    # App-local Microsoft runtime DLLs: whisper.cpp must also work without a developer toolchain.
    for name in ['vcruntime140.dll', 'vcruntime140_1.dll', 'msvcp140.dll']:
        file = Path(os.environ['WINDIR']) / 'System32' / name
        if not file.exists():
            raise RuntimeError(f'Missing redistributable runtime {name}; install the Microsoft Visual C++ runtime on the build machine.')
        shutil.copy2(file, whisper / name)
        shutil.copy2(file, runtime / name)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--native-only', action='store_true')
    parser.add_argument('--installer', action='store_true')
    parser.add_argument('--node', type=Path, default=Path(os.environ.get('CHUMI_NODE', shutil.which('node') or 'node')))
    args = parser.parse_args()
    if os.name != 'nt':
        raise RuntimeError('Run this build on Windows.')
    BUILD.mkdir(parents=True, exist_ok=True)
    build_audio()
    if args.native_only:
        return
    node = args.node.resolve()
    version = subprocess.check_output([str(node), '--version'], text=True).strip()
    if int(version.lstrip('v').split('.')[0]) != 24:
        raise RuntimeError(f'Use Node 24 to package the app; found {version}. Pass --node PATH or set CHUMI_NODE.')
    npm = node.parent / 'node_modules' / 'npm' / 'bin' / 'npm-cli.js'
    run([node, npm, 'run', 'build:web'])
    # Render the existing SVG logo with Electron; no extra graphics libraries are needed for the build.
    run([ROOT / 'node_modules' / 'electron' / 'dist' / 'electron.exe', ROOT / 'native' / 'windows' / 'desktop', '--make-icon', BUILD / 'icon.png'])
    stage_backend(node)
    builder = ROOT / 'node_modules' / 'electron-builder' / 'out' / 'cli' / 'cli.js'
    # Keep dependencies in the backend resource; the Electron shell itself has no npm runtime dependencies.
    (ROOT / 'native' / 'windows' / 'desktop' / 'node_modules').mkdir(exist_ok=True)
    run([node, builder, '--win', 'nsis' if args.installer else 'dir', '--x64', '--config', ROOT / 'native' / 'windows' / 'electron-builder.yml', '--publish', 'never'])
    print('Windows build ready:', ROOT / 'dist', flush=True)


if __name__ == '__main__':
    main()
