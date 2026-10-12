package app.chumi.android

import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Log
import java.io.IOException
import java.util.ArrayDeque
import java.util.UUID
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.LinkedBlockingDeque
import java.util.concurrent.TimeUnit

/**
 * Records the meeting on the phone and streams it to Chumi on the computer, which transcribes it and does the rest.
 * Runs as a foreground service so recording continues with the screen off. Audio waits in memory (up to
 * [MAX_BUFFER_SEC]) while the network is away and is sent when it returns; it is never written to the phone's storage.
 */
class RecorderService : Service() {

    data class Status(
        val running: Boolean = false,
        val connected: Boolean = false,
        val recordedSec: Double = 0.0,
        val bufferedSec: Double = 0.0,
        /** Shown in the app; null when all is well. */
        val message: String? = null,
    )

    companion object {
        private const val TAG = "ChumiRecorder"
        private const val ACTION_START = "app.chumi.android.START"
        private const val ACTION_FINISH = "app.chumi.android.FINISH"
        private const val ACTION_STOP = "app.chumi.android.STOP"
        private const val CHANNEL = "recording"
        private const val NOTIFICATION_ID = 1
        private const val MAX_BUFFER_SEC = 600
        /** Resent after a reconnect, in case the server missed the end of the broken upload. Chumi drops repeats. */
        private const val RESEND_SEC = 5

        @Volatile var status = Status()
            private set
        private val listeners = CopyOnWriteArrayList<(Status) -> Unit>()
        private val main = Handler(Looper.getMainLooper())

        fun addListener(l: (Status) -> Unit) { listeners.add(l); l(status) }
        fun removeListener(l: (Status) -> Unit) { listeners.remove(l) }
        private fun publish(s: Status) { status = s; main.post { listeners.forEach { it(s) } } }

        /** Starts a meeting recorded on this phone, or joins one Chumi on the computer is already recording from it. */
        fun start(context: Context, title: String) =
            context.startForegroundService(Intent(context, RecorderService::class.java).setAction(ACTION_START).putExtra("title", title))

        /** Sends what is still buffered, then ends the meeting in Chumi (which then writes the summary). */
        fun finish(context: Context) =
            context.startService(Intent(context, RecorderService::class.java).setAction(ACTION_FINISH))

        /** Stops recording on the phone without ending the meeting. */
        fun stop(context: Context) =
            context.startService(Intent(context, RecorderService::class.java).setAction(ACTION_STOP))
    }

    @Volatile private var running = false
    /** True while Chumi has the meeting paused: audio is read but not kept. */
    @Volatile private var holding = false
    @Volatile private var finishing = false
    private val pending = LinkedBlockingDeque<ByteArray>()
    private var capture: Thread? = null
    private var uploader: Thread? = null
    private var recordedSamples = 0L

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START -> begin(intent.getStringExtra("title") ?: "Phone meeting")
            ACTION_FINISH -> { finishing = true; publish(status.copy(message = getString(R.string.status_finishing))) }
            ACTION_STOP -> shutdown(null)
        }
        return START_NOT_STICKY
    }

    private fun begin(title: String) {
        if (running) return
        val pairing = Pairing.load(this) ?: return shutdown(getString(R.string.error_not_paired))
        startForeground(NOTIFICATION_ID, notification(getString(R.string.notification_connecting)), ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
        running = true
        finishing = false
        holding = false
        pending.clear()
        recordedSamples = 0
        publish(Status(running = true, message = getString(R.string.status_connecting)))
        val client = ChumiClient(pairing.serverUrl, pairing.token)
        uploader = Thread({ upload(client, title) }, "chumi-upload").also { it.start() }
    }

    // ------------------------------------------------------------------ capture

    @SuppressLint("MissingPermission") // MainActivity asks for the microphone before starting the service.
    private fun record() {
        val min = AudioRecord.getMinBufferSize(Frames.SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        // VOICE_RECOGNITION: tuned for speech, without the call-style processing of VOICE_COMMUNICATION.
        val rec = AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION, Frames.SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT, maxOf(min, Frames.SAMPLE_RATE)) // at least 0.5 s
        if (rec.state != AudioRecord.STATE_INITIALIZED) { rec.release(); return shutdown(getString(R.string.error_microphone)) }
        val buf = ShortArray(Frames.SAMPLES_PER_FRAME)
        val maxFrames = MAX_BUFFER_SEC * Frames.SAMPLE_RATE / Frames.SAMPLES_PER_FRAME
        rec.startRecording()
        try {
            while (running && !finishing) {
                val n = rec.read(buf, 0, buf.size)
                if (n <= 0) continue
                // The phone's clock: samples read since this capture started, paused or not.
                val ts = recordedSamples.toDouble() / Frames.SAMPLE_RATE
                recordedSamples += n
                if (holding) continue
                pending.add(Frames.encode(ts, buf, n))
                while (pending.size > maxFrames) pending.pollFirst() // keep the most recent 10 minutes
                if (recordedSamples % (Frames.SAMPLE_RATE / 2) < n) {
                    publish(status.copy(recordedSec = recordedSamples.toDouble() / Frames.SAMPLE_RATE, bufferedSec = pending.size * 0.05))
                }
            }
        } finally {
            rec.stop()
            rec.release()
        }
    }

    // ------------------------------------------------------------------ upload

    private fun upload(client: ChumiClient, title: String) {
        val captureId = UUID.randomUUID().toString()
        val recent = ArrayDeque<ByteArray>()
        var backoffMs = 1_000L
        var first = true
        while (running) {
            try {
                // Decide what to do from Chumi's state: start the meeting, join it, wait while paused, or stop.
                val state = client.state()
                when {
                    state.recordingFromPhone -> holding = false
                    // Audio from the pause is not kept, and nothing from before it is resent afterwards.
                    state.pausedFromPhone -> { holding = true; pending.clear(); recent.clear(); waitFor(3_000); continue }
                    state.status == "idle" && first -> client.startSession(title)
                    state.status == "idle" -> return shutdown(getString(R.string.status_ended))
                    else -> return shutdown(getString(R.string.error_busy))
                }
                if (first) { capture = Thread({ record() }, "chumi-capture").also { it.start() }; first = false }
                val conn = client.openAudioUpload(captureId)
                conn.outputStream.use { out ->
                    publish(status.copy(connected = true, message = null))
                    updateNotification(getString(R.string.notification_listening))
                    backoffMs = 1_000
                    for (f in recent) out.write(f)
                    while (running) {
                        val f = pending.poll(300, TimeUnit.MILLISECONDS)
                        if (f == null) {
                            if (finishing) break // everything recorded has been sent
                            continue
                        }
                        out.write(f)
                        out.flush()
                        recent.addLast(f)
                        while (recent.size > RESEND_SEC * 20) recent.removeFirst()
                    }
                }
                conn.responseCode
                conn.disconnect()
                if (finishing) { client.end(); return shutdown(getString(R.string.status_ended)) }
            } catch (e: IOException) {
                Log.i(TAG, "upload interrupted: ${e.message}")
                if (e is ChumiException && e.status == 401) return shutdown(getString(R.string.error_unpaired))
                // Chumi refused to start the meeting (for example, speech recognition is not ready): say why.
                if (e is ChumiException && first && e.status in 400..499) return shutdown(e.message)
                publish(status.copy(connected = false, message = getString(R.string.status_offline)))
                updateNotification(getString(R.string.notification_offline))
                waitFor(backoffMs)
                backoffMs = minOf(backoffMs * 2, 15_000)
            }
        }
    }

    private fun waitFor(ms: Long) { try { Thread.sleep(ms) } catch (_: InterruptedException) { } }

    private fun shutdown(message: String?) {
        running = false
        capture?.interrupt()
        uploader?.interrupt()
        publish(Status(running = false, recordedSec = recordedSamples.toDouble() / Frames.SAMPLE_RATE, message = message))
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    // ------------------------------------------------------------------ notification

    private fun notification(text: String): Notification {
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CHANNEL, getString(R.string.channel_recording), NotificationManager.IMPORTANCE_LOW))
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        return Notification.Builder(this, CHANNEL)
            .setContentTitle(getString(R.string.app_name))
            .setContentText(text)
            .setSmallIcon(R.drawable.ic_launcher)
            .setContentIntent(open)
            .setOngoing(true)
            .build()
    }

    private fun updateNotification(text: String) {
        if (running) getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, notification(text))
    }
}
