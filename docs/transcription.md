# Speech recognition engines

Chumi turns meeting audio into text with one of four engines, chosen in **Settings → Transcription**. Whatever the engine, transcription is independent of the AI provider: it keeps running when the AI is unavailable.

| Engine | Where audio goes | Cost | Live grey text |
|---|---|---|---|
| **Whisper** (default) | Nowhere: whisper.cpp on this computer | Free | Yes |
| **ElevenLabs Scribe** (`scribe_v2`) | ElevenLabs | Per hour of audio; vocabulary hints add 20% | No |
| **Qwen3-ASR, Alibaba Cloud** (`qwen3-asr-flash`) | Alibaba Cloud Model Studio | By audio length | No |
| **Qwen3-ASR, self-hosted** | A server you run | Free | Yes |

The paid services get finished utterances only. Live grey text re-sends a growing utterance every second or so, which would bill the same speech many times.

## Choosing a service is opt-in

Whisper stays the default. Switching to ElevenLabs or Alibaba Cloud asks for confirmation, because meeting audio then leaves the computer while you record. The engine can only change between sessions.

API keys are stored like Chumi's other keys: in the macOS Keychain, or encrypted for your Windows account by the desktop app. They are never written to settings. The Alibaba Cloud key is only ever sent to an `*.aliyuncs.com` address.

## If a service fails

Each utterance that a service fails on (network down, key rejected, server stopped, no answer within 30 seconds) is transcribed by the local Whisper model instead. After a failure, Chumi uses Whisper directly for 30 seconds before asking the service again, so an outage doesn't make every utterance wait. The first time, Chumi shows a notice, then the speech badge reports the problem. Recording never stops for this, and a meeting can start while the service is unreachable.

**Test speed and accuracy** never falls back: it measures the service itself, and reports its error if it fails.

So keep a Whisper model downloaded, even when you use a service. Without one, the transcriber retries once, then that piece of audio is not transcribed. Settings → Transcription shows which case applies.

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

- Unit tests (`tests/speech-engines.test.ts`) against a local stand-in server cover request shapes, parsing, refused context, rejected keys (never echoed back), fallback to Whisper, skipping the service during an outage, missing keys, and address checks.
- End to end, with a stand-in for `qwen-asr-serve`: a 16-second clip went through the self-hosted engine, with glossary context, and was saved as two English lines. With the server stopped, the same clip started normally and local Whisper transcribed it.
- Not yet tested against the real ElevenLabs and Model Studio APIs or a real Qwen3-ASR server. Use **Test speed and accuracy of the engine in use** after adding a key: it sends two short clips, a few seconds of billed audio.
