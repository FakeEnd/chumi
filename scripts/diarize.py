#!/usr/bin/env python3
"""One offline CPU diarization job: JSON stdin -> JSON stdout; diagnostics on stderr."""
import json
import math
import pathlib
import sys
import wave

SEGMENTATION = 'sherpa-onnx-pyannote-segmentation-3-0/model.int8.onnx'
EMBEDDING = '3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx'
# Source recordings are capped at two hours; allow separators between takes.
MAX_SECONDS = 2 * 60 * 60 + 60


def emit(value):
    print(json.dumps(value, allow_nan=False, separators=(',', ':')), flush=True)


def diarizer(models):
    import sherpa_onnx
    config = sherpa_onnx.OfflineSpeakerDiarizationConfig(
        segmentation=sherpa_onnx.OfflineSpeakerSegmentationModelConfig(
            pyannote=sherpa_onnx.OfflineSpeakerSegmentationPyannoteModelConfig(
                model=str(models / SEGMENTATION), window_shift_ratio=0.1),
            num_threads=1, provider='cpu'),
        embedding=sherpa_onnx.SpeakerEmbeddingExtractorConfig(
            model=str(models / EMBEDDING), num_threads=1, provider='cpu'),
        clustering=sherpa_onnx.FastClusteringConfig(num_clusters=-1, threshold=0.75),
        min_duration_on=0.3, min_duration_off=0.5)
    if not config.validate():
        raise ValueError('Invalid diarization model files')
    return sherpa_onnx.OfflineSpeakerDiarization(config)


def main():
    if len(sys.argv) == 3 and sys.argv[1] == '--check':
        import numpy  # Check all dependencies before reporting setup success.
        diarizer(pathlib.Path(sys.argv[2]))
        emit({'v': 1, 'type': 'ready'})
        return
    request_line = sys.stdin.buffer.readline(65537)
    if len(request_line) > 65536:
        raise ValueError('Request too large')
    request = json.loads(request_line)
    if request.get('v') != 1 or not isinstance(request.get('wav'), str) or not isinstance(request.get('models'), str):
        raise ValueError('Invalid request')
    import numpy as np
    with wave.open(request['wav'], 'rb') as audio:
        frames = audio.getnframes()
        if audio.getframerate() != 16000 or audio.getnchannels() != 1 or audio.getsampwidth() != 2 or audio.getcomptype() != 'NONE':
            emit({'v': 1, 'type': 'error', 'code': 'bad_audio'})
            return
        if frames <= 0 or frames > MAX_SECONDS * 16000:
            emit({'v': 1, 'type': 'error', 'code': 'audio_duration'})
            return
        # Convert in blocks into one float32 array, so two hours peak near 460 MB rather than 690 MB.
        samples = np.empty(frames, dtype=np.float32)
        position = 0
        while position < frames:
            block = audio.readframes(min(1 << 20, frames - position))
            count = len(block) // 2
            if count == 0:
                break
            samples[position:position + count] = np.frombuffer(block, dtype='<i2', count=count)
            position += count
        if position != frames:
            emit({'v': 1, 'type': 'error', 'code': 'bad_audio'})
            return
    samples *= 1.0 / 32768.0
    engine = diarizer(pathlib.Path(request['models']))
    duration_ms = frames / 16.0
    turns = []
    for turn in engine.process(samples).sort_by_start_time():
        if not math.isfinite(turn.start) or not math.isfinite(turn.end) or turn.speaker < 0:
            raise ValueError('Invalid model result')
        start = max(0, round(turn.start * 1000))
        end = min(round(duration_ms), round(turn.end * 1000))
        if end > start:
            turns.append({'start_ms': start, 'end_ms': end, 'speaker': 'speaker_' + str(turn.speaker)})
    emit({'v': 1, 'type': 'result', 'duration_ms': round(duration_ms), 'turns': turns})


if __name__ == '__main__':
    try:
        main()
    except (ImportError, ModuleNotFoundError):
        emit({'v': 1, 'type': 'error', 'code': 'missing_dependency'})
        sys.exit(1)
    except Exception as error:
        # Do not echo the request, audio contents, or arbitrary native exception messages.
        print('Diarization failed: ' + type(error).__name__, file=sys.stderr)
        emit({'v': 1, 'type': 'error', 'code': 'inference_failed'})
        sys.exit(1)
