# Local speaker analysis

Speaker analysis runs after capture in a separate local Python process. It groups voices into anonymous, meeting-local speakers; names are supplied by the user. Audio is not uploaded. All takes for one source must be processed together because clustering identifiers are not stable across independent runs or sources.

## Setup

Run `npm run setup:speakers` (or `bash scripts/setup-speakers.sh`). Python 3.9–3.12 is required; `CHUMI_SPEAKER_SETUP_PYTHON=/absolute/python3` can select it. The script creates `build/speakers/venv`, installs the pinned requirements, downloads and checks the models, then loads both models on CPU to verify installation. It does not modify system Python.

Runtime defaults:

- Python: `build/speakers/venv/bin/python3`; override with `CHUMI_SPEAKER_PYTHON` (absolute executable path).
- Models: `build/speakers/models`; override with `CHUMI_SPEAKER_MODELS` (also honored by setup).
- Packages: `sherpa-onnx==1.13.8` and `numpy==1.26.4`. The sherpa package installs its matching `sherpa-onnx-core` dependency. [Official Python packages](https://pypi.org/project/sherpa-onnx/1.13.8/) include macOS arm64 wheels.

The lightweight UI readiness check verifies the executable and model files. Each actual worker invocation imports dependencies and validates the model configuration; a corrupted installation can still fail at that stage.

## Models and provenance

Both downloads come directly from the [sherpa-onnx project's release assets](https://k2-fsa.github.io/sherpa/onnx/speaker-diarization/models.html), without a Hugging Face account or token.

| Component | Exact release asset | Download size | SHA-256 |
| --- | --- | --- | --- |
| Segmentation archive | [sherpa-onnx-pyannote-segmentation-3-0.tar.bz2](https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2) | 6.64 MiB | `24615ee884c897d9d2ba09bb4d30da6bb1b15e685065962db5b02e76e4996488` |
| Speaker embedding | [3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx](https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx) | 27.0 MiB | `aa3cfc16963a10586a9393f5035d6d6b57e98d358b347f80c2a30bf4f00ceba2` |

The embedding digest is published in the release's [checksum.txt](https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/checksum.txt). The segmentation archive digest was recorded from the official HTTPS download on 2026-10-11; it is a pinned audit value, not an independently signed upstream checksum. Setup copies only the archive's regular `model.int8.onnx`, `LICENSE`, and `README.md` files and records extracted model digests in `models/checksums.json`. The segmentation model is approximately 1.5 MiB.

Licenses are separate from Chumi's license:

- [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx/blob/v1.13.8/LICENSE): Apache-2.0.
- [pyannote segmentation-3.0](https://huggingface.co/pyannote/segmentation-3.0): MIT. Its license and model README are retained from the official conversion archive. Direct Hugging Face access is gated; this setup uses sherpa's published conversion.
- [3D-Speaker](https://github.com/modelscope/3D-Speaker#license): Apache-2.0, also explicitly declared in the selected [bilingual CAM++ model card](https://modelscope.cn/models/iic/speech_campplus_sv_zh_en_16k-common_advanced) (verified through its official README endpoint on 2026-10-11). This embedding was trained on Chinese and English speaker audio. Preserve the model's upstream license/attribution when redistributing the model; setup downloads the upstream artifact rather than checking weights into this repository.

## Worker contract and limitations

`scripts/diarize.py` consumes one JSON line, `{ "v": 1, "wav": "/absolute/recording.wav", "models": "/absolute/models" }`. It returns one JSON object with `v: 1`, `type: "result"`, `duration_ms`, and `turns: [{ start_ms, end_ms, speaker }]`. Speaker identifiers have the form `speaker_0`. Times are recording-relative milliseconds, and overlapping turns are valid. Errors use `type: "error"` and a fixed code. No transcript or names are sent to the worker.

Input must be complete 16 kHz mono PCM16 WAV, longer than zero and at most two hours of source recordings. The worker allows one additional minute for separators between takes. Inference uses CPU with one thread, automatic speaker counting, clustering threshold 0.75, and quantized segmentation. The parent enforces a 30-minute timeout, a 4 MiB response limit, and cancellation with SIGTERM followed by SIGKILL after one second. Results are accepted only after normal process exit and validation.

Short speech, overlap, similar voices, noise, and audio leaking between sources can cause incorrect grouping. Automatic counting may over-split or merge voices. This pipeline does not identify real people, provide calibrated confidence, or guarantee matching identities across separate sources/runs. Manual corrections should remain authoritative.

A one-hour float32 waveform alone occupies about 230 MB; Python/C++ transfer and inference need additional memory. Run one analysis at a time and avoid competing with live ASR when possible. There is no claimed real-time or fixed-RAM guarantee; measure on representative local recordings before changing CPU/thread settings.

## Development smoke test (2026-10-11)

On this development Mac (arm64, macOS 26.5.1, Python 3.9.6), the official public [Chinese four-speaker fixture](https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/0-four-speakers-zh.wav) is 56.86 seconds and the [English two-speaker fixture](https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/1-two-speakers-en.wav) is 16 seconds. Both were processed locally, with the same segmentation and one CPU thread. Automatic clustering comparisons were:

| Embedding | Fixed threshold | Chinese speaker count | English speaker count |
| --- | --- | --- | --- |
| ERes2Net base (Chinese) | 0.5 | 7 | 2 |
| ERes2Net base (Chinese) | 0.75 | 6 | 2 |
| ERes2Net base (Chinese) | 0.9 | 4 | 1 |
| CAM++ (Chinese-English) | 0.5 | 6 | 2 |
| CAM++ (Chinese-English), selected | 0.75 | 4 | 2 |

The selected model's inference took about 2.8 seconds for the Chinese fixture and 0.44 seconds for the English fixture, excluding startup. These are two smoke tests with known speaker counts, not a diarization error-rate benchmark or evidence of general meeting accuracy. The fixed 0.75 threshold remains an initial setting that needs evaluation on varied recordings; manual corrections are still necessary.
