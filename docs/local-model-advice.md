# Local model capacity advice

The Ollama and LM Studio settings show a curated, version-specific Qwen3 text-model catalog alongside the installed-model selector. The catalog is not a ranking of all available models. Hardware discovery is independent of model-service discovery, so users can plan before installing anything.

`GET /api/provider/local-hardware` reads the host platform, architecture, CPU description/core count, total RAM, home-volume free disk space, and selected Chumi transcription model. It does not inspect documents, download models, call a model endpoint, or send hardware data externally. Disk failures return unknown, not zero. Total memory is used because OS free-memory readings omit reclaimable caches; the UI explicitly does not claim to measure currently available RAM.

## Budget and estimates

All calculations use bytes. Downloads display decimal GB; memory displays GiB (2^30 bytes), rounded upward to one decimal place.

- System/apps reserve: 20% of total RAM, bounded to 3–8 GiB.
- Speech/audio reserve: tiny 0.5, base 0.75, small 1, medium 2, large-v3-turbo 2.5, other/unknown 3.5 GiB. These are planning allowances, not measured working sets.
- Model budget: the smaller of 65% of total RAM and total RAM minus those reserves, floored at zero. Apple unified RAM is counted once, not again as VRAM.
- KV cache: `2 × layers × KV heads × head dimension × 2 bytes × context tokens` (F16 K and V, one text request).
- Runtime memory range: `weights × 1.1 + KV + 0.5 GiB` through `weights × 1.3 + KV × 1.15 + 1 GiB`. The overhead range is a heuristic allowance for compute/runtime buffers, not a benchmark or an OOM guarantee.
- Fits: upper estimate at most 90% of the model budget. Tight: upper estimate exceeds that threshold but lower estimate fits. Too large: even the lower estimate exceeds the budget.
- Download-space allowance: `file size × 1.15 + 1 GiB`. The home volume is a proxy for the usual download location, not detection of a custom model directory. Check a different destination separately.

The recommended starting point is the largest fitting model up to 8B on Apple Silicon/Metal, or 1.7B when GPU acceleration is unverified. This deliberately favors smaller models for live meetings, without claiming measured throughput. Larger models remain in the comparison table. Low disk space or an unsupported runtime prevents a recommendation; unknown disk space is labeled and does not pretend to be a known failure. macOS LM Studio support requires Apple Silicon and Darwin 23+ (macOS 14+), per its documentation. Other platforms use conservative CPU assumptions; Chumi does not detect discrete GPU VRAM.

The context selector supports 4K, 8K, 16K and 32K. Its default is 4K on computers with at most 8 GiB, otherwise 8K. **It only changes the estimate, not the local service configuration.** Runtime defaults can be much larger. Set matching context capacity in Ollama/LM Studio, close memory-heavy apps, and try a short generation before a meeting. Concurrent requests, images, runtime differences, loaded models, and background apps can increase usage. Chumi does not automatically download, select, or switch providers based on advice.

## One-click downloads

Once the local service is running, **Download recommended model** starts a server-owned job. Chumi rechecks the memory budget, runtime compatibility, and home-volume disk allowance before reading a scoped credential or making a download request. Only catalog model IDs, supported context lengths, and normalized loopback endpoints ending in `/v1` are accepted. Credentials are read for the complete configured endpoint, sent only in headers, and never persisted in the progress journal. Redirects are refused; request bodies and model-service errors are not echoed to the UI. Download APIs are write routes protected by Chumi's existing host and `X-Chumi` checks.

- Ollama: `POST /api/pull` with the exact catalog tag and streaming NDJSON. Progress is **per file/layer**, not an invented percentage of the entire installation. A full byte count or an ended connection is not success: only `status: success` completes the job after verification. Cancellation aborts Chumi's pull connection; Ollama manages partial files and resumes them on an explicit retry. No model deletion API is called.
- LM Studio 0.4+: `POST /api/v1/models/download` with the official Qwen Hugging Face repository and exact quantization, then `GET /api/v1/models/download/status/:job_id`. Whole-job byte progress, paused, completed, failed, and already-downloaded responses are handled. Its documented REST API has no cancellation endpoint; use LM Studio's Downloads UI. Chumi never simulates cancellation by merely hiding the job.

The settings panel polls Chumi, so closing it does not cancel the transfer. `local-model-download.json` in Chumi's data directory stores the latest task, without credentials, using atomic replacement. After Chumi restarts, an existing LM Studio job is monitored with GET requests only; Ollama requires an explicit retry. A lost LM Studio start response is reported as uncertain and is never auto-resubmitted. A missing job releases the slot with guidance to check downloaded models first. One job is tracked at a time, and stale cancellation IDs cannot affect another job.

Completion triggers model-list discovery for the matching service and endpoint. It does not change the active provider, saved model, or load a model into memory. LM Studio's OpenAI-compatible list depends on JIT/loading settings; the completion UI explains how to make an unloaded download visible. Model weights live in the runtime's configured storage directory. Hardware preflight checks the home volume only; the runtime remains responsible for validating its actual download destination and reporting out-of-space errors.

Download references: [Ollama pull API](https://docs.ollama.com/api/pull), [LM Studio download API](https://lmstudio.ai/docs/developer/rest/download), [LM Studio download status](https://lmstudio.ai/docs/developer/rest/download-status), [LM Studio model visibility](https://lmstudio.ai/docs/developer/openai-compat/models).

## Catalog sources

Metadata checked 2026-10-11. Recheck exact tags/files before changing this catalog; do not substitute a similarly named quantization. Ollama publishes rounded sizes; Hugging Face's file-tree API supplies exact byte counts. Only metadata was retrieved, not weights.

| Model | Ollama Q4_K_M download (approx.) | Official Qwen GGUF for LM Studio |
|---|---:|---:|
| Qwen3 0.6B | [523 MB](https://ollama.com/library/qwen3:0.6b-q4_K_M) | [Q8_0, 639,446,688 bytes](https://huggingface.co/Qwen/Qwen3-0.6B-GGUF/blob/main/Qwen3-0.6B-Q8_0.gguf) |
| Qwen3 1.7B | [1.4 GB](https://ollama.com/library/qwen3:1.7b-q4_K_M) | [Q8_0, 1,834,426,016 bytes](https://huggingface.co/Qwen/Qwen3-1.7B-GGUF/blob/main/Qwen3-1.7B-Q8_0.gguf) |
| Qwen3 4B | [2.6 GB](https://ollama.com/library/qwen3:4b-q4_K_M) | [Q4_K_M, 2,497,280,256 bytes](https://huggingface.co/Qwen/Qwen3-4B-GGUF/blob/main/Qwen3-4B-Q4_K_M.gguf) |
| Qwen3 8B | [5.2 GB](https://ollama.com/library/qwen3:8b-q4_K_M) | [Q4_K_M, 5,027,783,488 bytes](https://huggingface.co/Qwen/Qwen3-8B-GGUF/blob/main/Qwen3-8B-Q4_K_M.gguf) |
| Qwen3 14B | [9.3 GB](https://ollama.com/library/qwen3:14b-q4_K_M) | [Q4_K_M, 9,001,752,960 bytes](https://huggingface.co/Qwen/Qwen3-14B-GGUF/blob/main/Qwen3-14B-Q4_K_M.gguf) |
| Qwen3 32B | [20 GB](https://ollama.com/library/qwen3:32b-q4_K_M) | [Q4_K_M, 19,762,149,024 bytes](https://huggingface.co/Qwen/Qwen3-32B-GGUF/blob/main/Qwen3-32B-Q4_K_M.gguf) |

Layer counts are 28, 28, 36, 36, 40, and 64 respectively. All six use 8 KV heads and head dimension 128, from Qwen's architecture configs: [0.6B](https://huggingface.co/Qwen/Qwen3-0.6B/blob/main/config.json), [1.7B](https://huggingface.co/Qwen/Qwen3-1.7B/blob/main/config.json), [4B](https://huggingface.co/Qwen/Qwen3-4B/blob/main/config.json), [8B](https://huggingface.co/Qwen/Qwen3-8B/blob/main/config.json), [14B](https://huggingface.co/Qwen/Qwen3-14B/blob/main/config.json), [32B](https://huggingface.co/Qwen/Qwen3-32B/blob/main/config.json).

Both runtimes require macOS 14 or later; older macOS versions receive no recommendation. Runtime references: [Ollama macOS requirements](https://docs.ollama.com/macos), [Ollama context length and memory](https://docs.ollama.com/context-length), [LM Studio system requirements](https://lmstudio.ai/docs/app/system-requirements).
