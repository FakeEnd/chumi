#!/usr/bin/env bash
# Optional local speaker diarization; nothing is installed into system Python.
set -euo pipefail
cd "$(dirname "$0")/.."
SPEAKER_ROOT="$PWD/build/speakers"
supported_python() { "$1" -c 'import sys; sys.exit(0 if (3, 9) <= sys.version_info < (3, 13) else 1)' >/dev/null 2>&1; }
choose_speaker_python() {
  local candidate
  if [[ -n ${CHUMI_SPEAKER_SETUP_PYTHON:-} ]]; then
    if supported_python "$CHUMI_SPEAKER_SETUP_PYTHON"; then echo "$CHUMI_SPEAKER_SETUP_PYTHON"; return; fi
    echo "CHUMI_SPEAKER_SETUP_PYTHON needs Python 3.9–3.12 (found: $("$CHUMI_SPEAKER_SETUP_PYTHON" --version 2>&1 || true))." >&2
  else
    for candidate in python3.12 python3.11 python3.10 /usr/bin/python3 python3.9 python3; do
      if supported_python "$candidate"; then command -v "$candidate"; return; fi
    done
    echo "Speaker labels need Python 3.9–3.12 (python3 reports: $(python3 --version 2>&1 || true))." >&2
  fi
  echo "Install it with: brew install python@3.12, then rerun setup. To choose it explicitly, set CHUMI_SPEAKER_SETUP_PYTHON to its executable path." >&2
  return 1
}
SPEAKER_PYTHON=$(choose_speaker_python)
SPEAKER_MODELS="${CHUMI_SPEAKER_MODELS:-$SPEAKER_ROOT/models}"
SPEAKER_ARCHIVE="sherpa-onnx-pyannote-segmentation-3-0.tar.bz2"
SPEAKER_EMBEDDING="3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx"
SPEAKER_RELEASE="https://github.com/k2-fsa/sherpa-onnx/releases/download"
mkdir -p "$SPEAKER_ROOT/downloads" "$SPEAKER_MODELS"

if [[ ! -x "$SPEAKER_ROOT/venv/bin/python3" ]]; then
  "$SPEAKER_PYTHON" -m venv "$SPEAKER_ROOT/venv"
fi
if ! supported_python "$SPEAKER_ROOT/venv/bin/python3"; then
  echo "The existing build/speakers/venv needs Python 3.9–3.12. Remove that virtual environment and rerun setup." >&2
  exit 1
fi
"$SPEAKER_ROOT/venv/bin/python3" -m pip install --disable-pip-version-check --cache-dir "$SPEAKER_ROOT/pip-cache" --only-binary=:all: -r scripts/requirements-speakers.txt

download() {
  local url="$1" target="$2" sha="$3"
  if [[ -f "$target" ]] && [[ "$(shasum -a 256 "$target" | cut -d ' ' -f 1)" == "$sha" ]]; then return; fi
  curl --fail --location --proto '=https' --proto-redir '=https' --connect-timeout 20 --max-time 600 --output "$target.part" "$url"
  [[ "$(shasum -a 256 "$target.part" | cut -d ' ' -f 1)" == "$sha" ]] || { echo "Model checksum mismatch: $target" >&2; exit 1; }
  mv "$target.part" "$target"
}

# Segmentation hash recorded from the official release on 2026-10-11.
download "$SPEAKER_RELEASE/speaker-segmentation-models/$SPEAKER_ARCHIVE" "$SPEAKER_ROOT/downloads/$SPEAKER_ARCHIVE" 24615ee884c897d9d2ba09bb4d30da6bb1b15e685065962db5b02e76e4996488
# Embedding hash from the release's official checksum.txt.
download "$SPEAKER_RELEASE/speaker-recongition-models/$SPEAKER_EMBEDDING" "$SPEAKER_MODELS/$SPEAKER_EMBEDDING" aa3cfc16963a10586a9393f5035d6d6b57e98d358b347f80c2a30bf4f00ceba2

# Copy only the three expected regular files; never extract arbitrary archive paths or links.
"$SPEAKER_ROOT/venv/bin/python3" - "$SPEAKER_ROOT/downloads/$SPEAKER_ARCHIVE" "$SPEAKER_MODELS" <<'PY'
import hashlib, json, pathlib, sys, tarfile
archive, models = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
directory = 'sherpa-onnx-pyannote-segmentation-3-0'
with tarfile.open(archive, 'r:bz2') as bundle:
    for name in ['model.int8.onnx', 'LICENSE', 'README.md']:
        member = bundle.getmember(directory + '/' + name)
        if not member.isfile() or member.size <= 0 or member.size > 10_000_000:
            raise RuntimeError('Unexpected segmentation archive member')
        data = bundle.extractfile(member).read()
        target = models / directory / name
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = target.with_name(target.name + '.part')
        temporary.write_bytes(data)
        temporary.replace(target)
files = [models / directory / 'model.int8.onnx', models / '3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx']
manifest = {'runtime': 'sherpa-onnx==1.13.8', 'files': {str(p.relative_to(models)): hashlib.sha256(p.read_bytes()).hexdigest() for p in files}}
(models / 'checksums.json').write_text(json.dumps(manifest, indent=2) + '\n')
PY

"$SPEAKER_ROOT/venv/bin/python3" scripts/diarize.py --check "$SPEAKER_MODELS"
printf '\nLocal speaker diarization is ready. No audio was uploaded.\n'
