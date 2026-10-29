# Speech recognition engines

Chumi turns meeting audio into text with one of six engines, chosen in **Settings → Transcription**. Whatever the engine, transcription is independent of the AI provider: it keeps running when the AI is unavailable.

| Engine | Where audio goes | Cost | Live grey text |
|---|---|---|---|
| **Qwen3-ASR 0.6B int8** (default) | Nowhere: sherpa-onnx on this computer (CPU) | Free | Yes |
| **SenseVoice-Small int8** | Nowhere: sherpa-onnx on this computer (CPU) | Free | Yes, without preview throttling |
| **Whisper** | Nowhere: whisper.cpp on this computer | Free | Yes |
| **ElevenLabs Scribe** (`scribe_v2`) | ElevenLabs | Per hour of audio; vocabulary hints add 20% | No |
| **Qwen3-ASR, Alibaba Cloud** (`qwen3-asr-flash`) | Alibaba Cloud Model Studio | By audio length | No |
| **Qwen3-ASR, self-hosted** | A server you run | Free | Yes |

The paid services get finished utterances only. Live grey text re-sends a growing utterance every second or so, which would bill the same speech many times.

## Choosing a service is opt-in

Local Qwen3-ASR is the default on every platform. Download the model from Home’s **Get Chumi ready** checklist or **Settings → Transcription** (about 941 MB). SenseVoice-Small int8 (about 228 MB) is a faster CPU option; it supports inverse text normalization but no vocabulary hints. Whisper remains selectable. When the selected sherpa model is unavailable, Chumi tries the other installed sherpa model, then Whisper, and prompts you to download the selected model. Until someone picks an engine, the local one follows the default; existing service choices and new explicit engine selections are retained. Older saved Whisper settings have no record of whether Whisper was explicitly reselected, so unmarked Whisper settings follow the new default. Switching to ElevenLabs or Alibaba Cloud asks for confirmation, because meeting audio then leaves the computer while you record. The engine can only change between sessions.

API keys are stored like Chumi's other keys: in the macOS Keychain, or encrypted for your Windows account by the desktop app. They are never written to settings. The Alibaba Cloud key is only ever sent to an `*.aliyuncs.com` address.

## If a service fails

Each utterance that a service fails on (network down, key rejected, server stopped, no answer within 30 seconds) is transcribed by the installed local models in order: Qwen3-ASR, SenseVoice, then Whisper. A model that fails to load or decode is skipped for that request. After a failure, Chumi uses the local engine directly for 30 seconds before asking the service again, so an outage doesn't make every utterance wait. The first time, Chumi shows a notice, then the speech badge reports the problem. Recording never stops for this, and a meeting can start while the service is unreachable.

**Test speed and accuracy** never falls back: it measures the service itself, and reports its error if it fails.

Keep a local Qwen3-ASR, SenseVoice or Whisper model downloaded, even when you use a service. Without a local model, failed clips get up to three attempts, with retries after 2 and 30 seconds. Fresh audio goes first, so a failing clip does not block later speech or another meeting. Only failed audio is capped (15 minutes of audio or 15 minutes waiting); a healthy but slow backlog is kept. Untranscribed stretches get a timeline gap marker and a notice; any saved recording remains available. End can return while retries continue, and the final summary waits up to 20 minutes for pending transcription. If that wait expires, the summary is visibly marked incomplete and can be refreshed when late text arrives. Settings → Transcription shows which case applies.

## Local Qwen3-ASR

Chumi uses `sherpa-onnx-node` 2.0.1 with the int8 0.6B model. One persistent worker owns the recognizer, including synchronous feature extraction; loading and decoding also use sherpa’s asynchronous native APIs. Each utterance is one segment spanning the audio’s duration. Since sherpa’s Qwen3 result does not report language, Chumi labels text `zh` when Han characters outnumber English words, otherwise `en`, then applies the same Mandarin/English policy as the other engines.

Vocabulary hints combine **Settings → Transcription → Vocabulary hints** with terms explained during the meeting. Every stream receives those terms through `setOption("hotwords", csv)`, with UTF-8 phrases separated by ASCII commas. This is Qwen3’s stream option, separate from the transducer-only `createStream(hotwords)` interface. One recognizer is reused across utterances, so new meeting terms do not reload the model. See the [sherpa 2.0.1 Qwen3 implementation](https://github.com/k2-fsa/sherpa-onnx/blob/v2.0.1/sherpa-onnx/csrc/offline-recognizer-qwen3-asr-impl.cc#L817).

The model lives in `models/qwen3-asr-0.6b-int8/`, separate from Whisper’s files. Downloads are pinned to commit `68818b2313fe77bd06f6a7c5068ff3ef59d02b8a` of [csukuangfj2/sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25](https://huggingface.co/csukuangfj2/sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25/tree/68818b2313fe77bd06f6a7c5068ff3ef59d02b8a). All six runtime files must pass their SHA-256 checks before the model directory is installed; `test_wavs` is excluded. **Download** and **Delete** work in Transcription settings. `CHUMI_MODELS_DIR` overrides the model directory. The existing `CHUMI_MODEL_BASE_URL` mirror setting also applies: for example, `https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main` downloads all local engines from hf-mirror.com, preserving each sherpa model’s repository and pinned commit.

Final results keep priority over grey previews. Previews run only while the final queue is empty, with only the newest pending preview per audio source retained. Local Qwen3 previews start at most once every 5 seconds per source: the end-to-end sample initially showed a final result waiting 1.46 seconds behind a preview.

For the full product path, including the transcriber, language policy and vocabulary hints:

```bash
node scripts/asr-eval.ts --engine qwen3 --threads 4 \
  --manifest /path/to/manifest.jsonl --out /path/to/results \
  --language auto --guard on
```

Use `--engine sensevoice` for SenseVoice or `--engine whisper` for Whisper, and `--glossary term1,term2` to supply vocabulary hints. The evaluation records event-loop maximum delay during transcription, excluding model loading and scoring.

## Local SenseVoice-Small

SenseVoice shares the persistent worker and engine implementation with Qwen3, using `sherpa-onnx-node` 2.0.1 on CPU. It uses 80-dimensional features and inverse text normalization (ITN) for numbers and punctuation. Automatic language passes `auto`; fixed Mandarin and English pass `zh` and `en` through the recognizer configuration without reloading the model. The result’s language tag, such as `<|zh|>` or `<|en|>`, becomes `zh` or `en`; other languages go through Chumi’s existing Mandarin/English policy. Vocabulary hints, including meeting terms, have no effect on SenseVoice.

Only `model.int8.onnx` and `tokens.txt` are downloaded into `models/sensevoice-small-int8/`, pinned to commit `2365baeacb507f821a0c8120fcee3d484dba7a07` of [csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17](https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/tree/2365baeacb507f821a0c8120fcee3d484dba7a07). Both files must pass SHA-256 verification before installation. The model directory override and mirror setting work as for Qwen3.

SenseVoice grey previews have no cooldown, as with Whisper; Qwen3 keeps its 5-second interval. Selected SenseVoice falls back to installed Qwen3, then Whisper; selected Qwen3 falls back to installed SenseVoice, then Whisper. Explicit Whisper selection stays on Whisper. The local default (Qwen3) is centralized in `defaultLocalEngine()` in `server/asr/engines.ts`, including the initial selection, recommended download and service fallback order.

## ElevenLabs

1. Create an ElevenLabs API key with speech-to-text access (ElevenLabs settings → API keys).
2. Settings → Transcription → ElevenLabs Scribe: paste the key, **Save key**, then **Use**.

Chumi sends each utterance as 16 kHz WAV with word timestamps on and audio-event tags off. It forces the language only if you chose English or Mandarin under **Spoken language**. Up to 100 vocabulary hints go along as `keyterms`. ElevenLabs bills those at a 20% surcharge, and more than 100 would raise the minimum billed length of every request. Remove the hints if you would rather not pay for them.

ElevenLabs keeps requests according to your account's retention settings. Chumi does not request its zero-retention mode (`enable_logging=false`), whose availability depends on your plan.

## Qwen3-ASR on Alibaba Cloud

1. In Alibaba Cloud Model Studio (百炼), create an API key in the region you want (Singapore for international accounts, Beijing for mainland China accounts).
2. Settings → Transcription → Qwen3-ASR (Alibaba Cloud): paste the key, pick the same **Region**, then **Use**.

The region fills in Model Studio's general address. Alibaba recommends workspace addresses, of the form `https://{WorkspaceId}.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1`; paste yours into **Address** if you have one. The OpenAI-compatible mode Chumi uses is not offered in the US (Virginia) region.

Requests go to `/chat/completions` with the audio as a base64 data URL and inverse text normalization off. Vocabulary hints and the previous sentence go along as context, which Qwen3-ASR uses to spell names and jargon. If the service refuses the context, Chumi asks again without it and leaves it out from then on. `qwen3-asr-flash` accepts up to 5 minutes and 10 MB per request; Chumi's utterances are at most 15 seconds.

## Qwen3-ASR on your own server

[Qwen3-ASR](https://github.com/QwenLM/Qwen3-ASR) (Apache 2.0) has two open models, 1.7B and 0.6B. Serving them with vLLM needs an NVIDIA GPU, so this suits a Windows or Linux machine with one, such as the Windows laptop. Running it on a Mac is not covered here.

```bash
pip install -U "qwen-asr[vllm]"
qwen-asr-serve Qwen/Qwen3-ASR-1.7B --gpu-memory-utilization 0.8 --host 127.0.0.1 --port 8000
```

`vllm serve Qwen/Qwen3-ASR-1.7B` works the same way. Then in Settings → Transcription → Qwen3-ASR (self-hosted), set **Server address** to `http://127.0.0.1:8000/v1` and **Model** to the name you served, and choose **Use**. Chumi checks the server's `/models` before each session.

To use a GPU machine from a Mac, start the server with `--host 0.0.0.0` and enter that machine's address. Audio then travels over your network unencrypted, so only do this on a network you trust; Settings warns about it.

The open model detects the language itself and writes `language Chinese<asr_text>…`; Chumi reads the language from that. Your **Spoken language** choice does not reach it.

## What was tested

- Full SenseVoice product evaluation on Apple M5, CPU 4 threads, automatic language with the Mandarin/English guard enabled: 291 AliMeeting utterances gave **17.69% Chinese CER**, and 446 AMI utterances gave **18.04% English WER**. RTF was **0.013 / 0.014** (Chinese / English), with **23.69 ms** maximum event-loop delay and no failed transcription requests.

- Full product evaluation on Apple M5, CPU 4 threads, automatic language with the Mandarin/English guard enabled: 291 AliMeeting utterances gave **17.43% Chinese CER**, and 446 AMI utterances gave **19.83% English WER**. RTF was **0.152 / 0.161** (Chinese / English), with **78.77 ms** maximum event-loop delay and no failed transcription requests.

- Local sherpa unit tests cover both pinned runtime file catalogs, mirror URLs, per-file checksum rejection, model-directory completeness, default migration, engine selection, missing-model and runtime-failure fallback order, SenseVoice language tags and ITN configuration, Qwen3 hotword formatting and preview throttling.
- Unit tests (`tests/speech-engines.test.ts`) against a local stand-in server cover request shapes, parsing, refused context, rejected keys (never echoed back), fallback to Whisper, skipping the service during an outage, missing keys, and address checks.
- End to end, local Qwen3 processed the sample meeting through a development server with isolated data/models directories; saved segments included both `en` and `zh` labels.
- End to end, with a stand-in for `qwen-asr-serve`: a 16-second clip went through the self-hosted engine, with glossary context, and was saved as two English lines. With the server stopped, the same clip started normally and local Whisper transcribed it.
- Not yet tested against the real ElevenLabs and Model Studio APIs or a real Qwen3-ASR server. Use **Test speed and accuracy of the engine in use** after adding a key: it sends two short clips, a few seconds of billed audio.
