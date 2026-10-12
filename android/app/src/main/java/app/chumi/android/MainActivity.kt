package app.chumi.android

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Typeface
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.InputType
import android.view.WindowInsets
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import java.text.DateFormat
import java.util.Date
import java.util.concurrent.Executors

/**
 * Pairing with Chumi on the computer, and the controls for a meeting recorded on this phone. The full Chumi
 * interface (transcript, questions, summary, handoff) opens in [WebUiActivity].
 */
class MainActivity : Activity() {

    private val io = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())
    private lateinit var root: LinearLayout
    private var server: ServerState? = null
    private var serverError: String? = null
    private var recorder = RecorderService.Status()
    private val onRecorder: (RecorderService.Status) -> Unit = { recorder = it; render() }
    private val poll = object : Runnable {
        override fun run() { refreshServer(); main.postDelayed(this, 2_000) }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        val scroll = ScrollView(this).apply { addView(root) }
        // Edge to edge (Android 15+): keep the content clear of the status bar, navigation bar and keyboard.
        scroll.setOnApplyWindowInsetsListener { v, insets ->
            val bars = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.ime())
            val pad = dp(20)
            v.setPadding(bars.left + pad, bars.top + pad, bars.right + pad, bars.bottom + pad)
            insets
        }
        setContentView(scroll)
        askPermissions()
        render()
    }

    override fun onResume() {
        super.onResume()
        RecorderService.addListener(onRecorder)
        main.post(poll)
    }

    override fun onPause() {
        super.onPause()
        RecorderService.removeListener(onRecorder)
        main.removeCallbacks(poll)
    }

    private fun askPermissions() {
        val wanted = buildList {
            add(Manifest.permission.RECORD_AUDIO)
            if (Build.VERSION.SDK_INT >= 33) add(Manifest.permission.POST_NOTIFICATIONS)
        }.filter { checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED }
        if (wanted.isNotEmpty()) requestPermissions(wanted.toTypedArray(), 1)
    }

    private fun refreshServer() {
        val pairing = Pairing.load(this) ?: return
        io.execute {
            val (state, error) = try { ChumiClient(pairing.serverUrl, pairing.token).state() to null }
                catch (e: ChumiException) { if (e.status == 401) Pairing.clear(this); null to e.message }
                catch (e: Exception) { null to (e.message ?: e.javaClass.simpleName) }
            main.post { server = state; serverError = error; render() }
        }
    }

    // ------------------------------------------------------------------ screens

    private var rendered: String? = null

    /** Rebuilds the screen when what it shows changed (rebuilding on every poll would swallow taps). */
    private fun render() {
        val shown = listOf(Pairing.load(this)?.serverUrl, server, serverError, recorder.copy(recordedSec = recorder.recordedSec.toInt().toDouble())).toString()
        if (shown == rendered && root.childCount > 0) return
        rendered = shown
        root.removeAllViews()
        root.addView(title(getString(R.string.app_name)))
        val pairing = Pairing.load(this)
        if (pairing == null) renderPairing() else renderPaired(pairing)
    }

    private fun renderPairing() {
        root.addView(heading(getString(R.string.pair_title)))
        root.addView(text(getString(R.string.pair_help)))
        val address = field(getString(R.string.address_hint), InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI)
        val code = field(getString(R.string.code_hint), InputType.TYPE_CLASS_NUMBER)
        val name = field(getString(R.string.name_hint), InputType.TYPE_CLASS_TEXT).apply { setText(Build.MODEL) }
        val message = text("")
        listOf(address, code, name).forEach(root::addView)
        root.addView(button(getString(R.string.pair_button)) { b ->
            b.isEnabled = false
            message.text = getString(R.string.pairing)
            io.execute {
                val error = try { Pairing.save(this, ChumiClient.pair(address.text.toString(), code.text.toString(), name.text.toString())); null }
                    catch (e: Exception) { e.message ?: e.javaClass.simpleName }
                main.post { if (error == null) { render(); refreshServer() } else { message.text = error; b.isEnabled = true } }
            }
        })
        root.addView(message)
    }

    private fun renderPaired(pairing: Pairing) {
        root.addView(text(getString(R.string.paired_with, pairing.serverUrl)))
        val s = server
        val computer = when {
            serverError != null -> getString(R.string.computer_unreachable, serverError)
            s == null -> getString(R.string.status_connecting)
            s.recordingFromPhone -> getString(R.string.computer_recording_phone, s.sessionTitle ?: "")
            s.pausedFromPhone -> getString(R.string.computer_paused, s.sessionTitle ?: "")
            s.status == "idle" -> getString(R.string.computer_idle)
            else -> getString(R.string.computer_recording_other, s.sessionTitle ?: "")
        }
        root.addView(heading(computer))
        if (recorder.running || recorder.recordedSec > 0) {
            val sent = if (recorder.connected) getString(R.string.sending) else getString(R.string.not_sending)
            root.addView(text(getString(R.string.recorded, minutes(recorder.recordedSec), sent, recorder.bufferedSec.toInt())))
        }
        recorder.message?.let { root.addView(text(it)) }

        val phoneMeeting = s != null && (s.recordingFromPhone || s.pausedFromPhone)
        if (!recorder.running && (s == null || s.status == "idle" || phoneMeeting)) {
            root.addView(button(getString(if (phoneMeeting) R.string.rejoin_button else R.string.start_button)) {
                if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) { askPermissions(); return@button }
                RecorderService.start(this, getString(R.string.meeting_title, DateFormat.getTimeInstance(DateFormat.SHORT).format(Date())))
            })
        }
        if (phoneMeeting) {
            root.addView(button(getString(if (s!!.pausedFromPhone) R.string.resume_button else R.string.pause_button)) {
                io.execute { runCatching { ChumiClient(pairing.serverUrl, pairing.token).let { c -> if (s.pausedFromPhone) c.resume() else c.pause() } }; main.post { refreshServer() } }
            })
            root.addView(button(getString(R.string.end_button)) {
                if (recorder.running) RecorderService.finish(this)
                else io.execute { runCatching { ChumiClient(pairing.serverUrl, pairing.token).end() }; main.post { refreshServer() } }
            })
        }
        root.addView(button(getString(R.string.open_button)) { startActivity(Intent(this, WebUiActivity::class.java)) })
        root.addView(button(getString(R.string.unpair_button)) {
            if (recorder.running) RecorderService.stop(this)
            Pairing.clear(this)
            server = null
            render()
        })
    }

    // ------------------------------------------------------------------ views

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()
    private fun minutes(sec: Double) = "%d:%02d".format((sec / 60).toInt(), (sec % 60).toInt())
    private fun title(s: String) = TextView(this).apply { text = s; textSize = 28f; typeface = Typeface.DEFAULT_BOLD; setPadding(0, 0, 0, dp(12)) }
    private fun heading(s: String) = TextView(this).apply { text = s; textSize = 18f; typeface = Typeface.DEFAULT_BOLD; setPadding(0, dp(12), 0, dp(8)) }
    private fun text(s: String) = TextView(this).apply { text = s; textSize = 15f; setPadding(0, dp(4), 0, dp(4)) }
    private fun field(hint: String, type: Int) = EditText(this).apply { this.hint = hint; inputType = type; setSingleLine() }
    private fun button(label: String, onClick: (Button) -> Unit) = Button(this).apply {
        text = label
        isAllCaps = false
        setOnClickListener { onClick(this) }
        layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(8) }
    }

}
