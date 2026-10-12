package app.chumi.android

import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * Chumi's audio frame format, the same one the macOS helper writes (native/README.md) and the server parses
 * (server/audio/capture.ts): "CHA1", source u8 (1 = microphone), flags u8, u16 reserved, f64 timestamp of the
 * first sample in seconds since the capture started, u32 sample count, then 16 kHz mono int16 samples.
 * All numbers are little-endian.
 */
object Frames {
    const val SAMPLE_RATE = 16_000
    /** 50 ms, like the macOS helper. */
    const val SAMPLES_PER_FRAME = 800
    private const val HEADER = 20

    fun encode(timestampSec: Double, samples: ShortArray, count: Int = samples.size): ByteArray {
        val buf = ByteBuffer.allocate(HEADER + count * 2).order(ByteOrder.LITTLE_ENDIAN)
        buf.put('C'.code.toByte()).put('H'.code.toByte()).put('A'.code.toByte()).put('1'.code.toByte())
        buf.put(1.toByte()).put(0.toByte()).putShort(0)
        buf.putDouble(timestampSec)
        buf.putInt(count)
        for (i in 0 until count) buf.putShort(samples[i])
        return buf.array()
    }

    /** Seconds of audio in an encoded frame. */
    fun durationSec(frame: ByteArray): Double =
        ByteBuffer.wrap(frame, 16, 4).order(ByteOrder.LITTLE_ENDIAN).int.toDouble() / SAMPLE_RATE

    fun timestampSec(frame: ByteArray): Double =
        ByteBuffer.wrap(frame, 8, 8).order(ByteOrder.LITTLE_ENDIAN).double
}
