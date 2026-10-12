package app.chumi.android

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Test

class FramesTest {
    /** The bytes the server's FrameParser expects (see tests/remote.test.ts for the same frame built in Node). */
    @Test
    fun encodesTheServerFormat() {
        val frame = Frames.encode(1.5, shortArrayOf(1, -2, 300))
        val expected = byteArrayOf(
            'C'.code.toByte(), 'H'.code.toByte(), 'A'.code.toByte(), '1'.code.toByte(),
            1, 0, 0, 0,
            0, 0, 0, 0, 0, 0, 0xF8.toByte(), 0x3F, // 1.5 as a little-endian double
            3, 0, 0, 0,
            1, 0, 0xFE.toByte(), 0xFF.toByte(), 0x2C, 0x01,
        )
        assertArrayEquals(expected, frame)
        assertEquals(1.5, Frames.timestampSec(frame), 0.0)
        assertEquals(3.0 / 16_000, Frames.durationSec(frame), 1e-12)
    }

    @Test
    fun encodesOnlyTheSamplesRead() {
        val frame = Frames.encode(0.0, ShortArray(800) { 7 }, count = 320)
        assertEquals(20 + 320 * 2, frame.size)
        assertEquals(0.02, Frames.durationSec(frame), 1e-12)
    }
}
