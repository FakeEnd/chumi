// Pipeline.swift — per-source processing: mono float at device rate → 16 kHz → Int16 chunks + levels.
//
// All methods except `downmix*` must be called on `queue` (a serial queue per source), never on a
// real-time audio thread.

import Foundation
import AVFAudio

let kOutputRate: Double = 16000

final class SourcePipeline {
    let source: SourceID
    let queue: DispatchQueue
    let chunkSamples: Int

    private let outFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: kOutputRate, channels: 1, interleaved: false)!
    private var inFormat: AVAudioFormat?
    private var converter: AVAudioConverter?
    private var inRate: Double = 0

    // Timestamp bookkeeping (seconds since helper start).
    private var anchored = false
    private var anchorTime: Double = 0
    private var inFramesSinceAnchor: Int64 = 0
    private var outSamplesSinceAnchor: Int64 = 0

    // Current chunk being filled.
    private var chunk: [Int16] = []
    private var chunkStart: Double = 0

    // Levels (~10 Hz on the 16 kHz output).
    private let levelWindow = Int(kOutputRate / 10)
    private var levelSumSq: Double = 0
    private var levelPeak: Float = 0
    private var levelCount = 0

    /// Called on `queue` with the max |sample| of every input block (for silence detection).
    var onInputBlock: ((_ maxAbs: Float, _ seconds: Double) -> Void)?

    init(source: SourceID, chunkMs: Int) {
        self.source = source
        self.queue = DispatchQueue(label: "local.chumi.audio.\(source.name)", qos: .userInitiated)
        self.chunkSamples = max(1, Int(kOutputRate * Double(chunkMs) / 1000))
        chunk.reserveCapacity(chunkSamples)
    }

    /// Mark a discontinuity (device change / restart): the next block re-anchors the timestamps.
    func reset() {
        flushPartialChunk()
        anchored = false
        converter?.reset()
    }

    /// Feed one block of mono samples captured at `rate`. `hostSeconds` is the capture time of the
    /// first sample (seconds since helper start), or nil if unknown.
    func push(_ mono: [Float], rate: Double, hostSeconds: Double?) {
        let n = mono.count
        guard n > 0, rate > 0 else { return }
        let t = hostSeconds ?? (Clock.now() - Double(n) / rate)

        if rate != inRate {
            setupConverter(rate: rate)
            flushPartialChunk()
            anchored = false
        }

        if anchored {
            let expected = anchorTime + Double(inFramesSinceAnchor) / inRate
            // Large jump between the device clock and the host clock: gap, restart or overload.
            if abs(t - expected) > 0.2 {
                EventLog.debug("\(source.name): timestamp re-anchor (drift \(String(format: "%.3f", t - expected)) s)")
                flushPartialChunk()
                anchored = false
            }
        }
        if !anchored {
            anchored = true
            anchorTime = t
            inFramesSinceAnchor = 0
            outSamplesSinceAnchor = 0
        }
        inFramesSinceAnchor += Int64(n)

        var maxAbs: Float = 0
        for x in mono { let a = abs(x); if a > maxAbs { maxAbs = a } }
        onInputBlock?(maxAbs, Double(n) / rate)

        let out = (rate == kOutputRate) ? mono : resample(mono)
        append(out)
    }

    /// Emit whatever is in the current chunk as a (short) frame.
    func flushPartialChunk() {
        guard !chunk.isEmpty else { return }
        FrameWriter.write(source: source, timestamp: chunkStart, samples: chunk)
        chunk.removeAll(keepingCapacity: true)
    }

    // MARK: private

    private func setupConverter(rate: Double) {
        inRate = rate
        if rate == kOutputRate {
            converter = nil
            inFormat = nil
            return
        }
        inFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: rate, channels: 1, interleaved: false)
        if let inFormat, let conv = AVAudioConverter(from: inFormat, to: outFormat) {
            conv.sampleRateConverterQuality = AVAudioQuality.high.rawValue
            converter = conv
        } else {
            converter = nil
            EventLog.warning("resampler_failed", "Could not create a \(Int(rate)) Hz → 16 kHz converter for \(source.name).")
        }
        EventLog.debug("\(source.name): input rate \(rate) Hz")
    }

    private func resample(_ mono: [Float]) -> [Float] {
        guard let conv = converter, let inFormat else { return [] }
        let n = mono.count
        guard let inBuf = AVAudioPCMBuffer(pcmFormat: inFormat, frameCapacity: AVAudioFrameCount(n)) else { return [] }
        inBuf.frameLength = AVAudioFrameCount(n)
        mono.withUnsafeBufferPointer { src in
            inBuf.floatChannelData![0].update(from: src.baseAddress!, count: n)
        }
        let capacity = AVAudioFrameCount(Double(n) * kOutputRate / inRate) + 64
        var result: [Float] = []
        result.reserveCapacity(Int(capacity))
        var consumed = false
        for _ in 0..<8 {
            guard let outBuf = AVAudioPCMBuffer(pcmFormat: outFormat, frameCapacity: capacity) else { break }
            var error: NSError?
            let status = conv.convert(to: outBuf, error: &error) { _, inputStatus in
                if consumed {
                    inputStatus.pointee = .noDataNow
                    return nil
                }
                consumed = true
                inputStatus.pointee = .haveData
                return inBuf
            }
            let got = Int(outBuf.frameLength)
            if got > 0 {
                result.append(contentsOf: UnsafeBufferPointer(start: outBuf.floatChannelData![0], count: got))
            }
            if status == .error {
                EventLog.debug("\(source.name): converter error \(error?.localizedDescription ?? "?")")
                break
            }
            // .haveData means the output buffer filled up and more is pending.
            if status == .haveData && got > 0 { continue }
            break
        }
        return result
    }

    private func append(_ samples: [Float]) {
        for x in samples {
            // Levels.
            let a = abs(x)
            if a > levelPeak { levelPeak = a }
            levelSumSq += Double(x) * Double(x)
            levelCount += 1
            if levelCount >= levelWindow { emitLevel() }

            if chunk.isEmpty {
                chunkStart = anchorTime + Double(outSamplesSinceAnchor) / kOutputRate
            }
            let clipped = max(-1, min(1, x))
            chunk.append(Int16((clipped * 32767).rounded()))
            outSamplesSinceAnchor += 1
            if chunk.count >= chunkSamples {
                FrameWriter.write(source: source, timestamp: chunkStart, samples: chunk)
                chunk.removeAll(keepingCapacity: true)
            }
        }
    }

    private func emitLevel() {
        let rms = (levelSumSq / Double(max(1, levelCount))).squareRoot()
        let rmsDb = rms > 1e-6 ? 20 * log10(rms) : -120
        let peakDb = levelPeak > 1e-6 ? 20 * log10(Double(levelPeak)) : -120
        EventLog.emit(["type": "level", "source": .string(source.name),
                       "rms": .number(round1(max(-120, rmsDb))), "peak": .number(round1(max(-120, peakDb)))])
        levelSumSq = 0
        levelPeak = 0
        levelCount = 0
    }
}

// MARK: - Downmixing helpers (cheap, safe to call from the capture callback)

/// Downmix any AVAudioPCMBuffer (float/int16/int32, interleaved or not) to mono Float.
/// If `firstChannelOnly`, only channel 0 is used (voice-processing input puts the processed signal there).
func downmixToMono(_ buffer: AVAudioPCMBuffer, firstChannelOnly: Bool) -> [Float] {
    let n = Int(buffer.frameLength)
    let channels = Int(buffer.format.channelCount)
    guard n > 0, channels > 0 else { return [] }
    var out = [Float](repeating: 0, count: n)
    let useChannels = firstChannelOnly ? 1 : channels
    let interleaved = buffer.format.isInterleaved
    let stride = buffer.stride

    out.withUnsafeMutableBufferPointer { dst in
        if let data = buffer.floatChannelData {
            for c in 0..<useChannels {
                let p = interleaved ? data[0] + c : data[c]
                for i in 0..<n { dst[i] += p[i * stride] }
            }
        } else if let data = buffer.int16ChannelData {
            for c in 0..<useChannels {
                let p = interleaved ? data[0] + c : data[c]
                for i in 0..<n { dst[i] += Float(p[i * stride]) / 32768 }
            }
        } else if let data = buffer.int32ChannelData {
            for c in 0..<useChannels {
                let p = interleaved ? data[0] + c : data[c]
                for i in 0..<n { dst[i] += Float(p[i * stride]) / 2147483648 }
            }
        }
        if useChannels > 1 {
            let scale = 1 / Float(useChannels)
            for i in 0..<n { dst[i] *= scale }
        }
    }
    return out
}
