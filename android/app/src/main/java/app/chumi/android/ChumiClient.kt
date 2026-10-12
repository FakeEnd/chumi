package app.chumi.android

import android.content.Context
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

/** The computer this phone is paired with, kept in the app's private preferences. */
data class Pairing(val serverUrl: String, val token: String, val deviceName: String) {
    companion object {
        private const val PREFS = "pairing"

        fun load(context: Context): Pairing? {
            val p = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            val url = p.getString("serverUrl", null) ?: return null
            val token = p.getString("token", null) ?: return null
            return Pairing(url, token, p.getString("deviceName", "") ?: "")
        }

        fun save(context: Context, pairing: Pairing) {
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .putString("serverUrl", pairing.serverUrl).putString("token", pairing.token)
                .putString("deviceName", pairing.deviceName).apply()
        }

        fun clear(context: Context) {
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().clear().apply()
        }
    }
}

class ChumiException(val status: Int, message: String) : IOException(message)

/** What Chumi on the computer is doing (GET /api/remote/whoami). */
data class ServerState(val status: String, val source: String?, val sessionTitle: String?, val phoneConnected: Boolean) {
    val recordingFromPhone get() = status == "recording" && source == "phone"
    val pausedFromPhone get() = status == "paused" && source == "phone"
}

/**
 * Chumi's HTTP API on the computer (server/main.ts, phone access in server/remote/access.ts). Calls block, so run
 * them off the main thread. Writes carry the X-Chumi header that Chumi requires.
 */
class ChumiClient(private val baseUrl: String, private val token: String?) {

    companion object {
        /** "192.168.1.20:4787" or "http://…/" → "http://192.168.1.20:4787" */
        fun normalize(address: String): String {
            var a = address.trim().trimEnd('/')
            if (!a.startsWith("http://") && !a.startsWith("https://")) a = "http://$a"
            return a
        }

        /** Exchanges the code shown on the computer for this phone's token. */
        fun pair(address: String, code: String, deviceName: String): Pairing {
            val url = normalize(address)
            val body = JSONObject().put("code", code.trim()).put("name", deviceName)
            val r = ChumiClient(url, null).request("POST", "/api/remote/pair", body)
            return Pairing(url, r.getString("token"), deviceName)
        }
    }

    fun state(): ServerState {
        val r = request("GET", "/api/remote/whoami", null)
        val session = r.optJSONObject("session")
        return ServerState(r.optString("status", "idle"), r.optString("source", "").ifEmpty { null }, session?.optString("title"), r.optBoolean("phoneConnected"))
    }

    fun startSession(title: String) {
        request("POST", "/api/session/start", JSONObject().put("title", title).put("source", "phone"))
    }

    fun pause() { request("POST", "/api/session/pause", JSONObject()) }
    fun resume() { request("POST", "/api/session/resume", JSONObject()) }
    fun end() { request("POST", "/api/session/end", JSONObject()) }

    /** An open, chunked upload of audio frames for one capture (POST /api/remote/audio). */
    fun openAudioUpload(captureId: String): HttpURLConnection {
        val c = (URL("$baseUrl/api/remote/audio?capture=$captureId").openConnection() as HttpURLConnection)
        c.requestMethod = "POST"
        c.doOutput = true
        c.setChunkedStreamingMode(0)
        c.connectTimeout = 5_000
        c.readTimeout = 0
        c.setRequestProperty("content-type", "application/octet-stream")
        c.setRequestProperty("x-chumi", "1")
        token?.let { c.setRequestProperty("authorization", "Bearer $it") }
        return c
    }

    private fun request(method: String, path: String, body: JSONObject?): JSONObject {
        val c = (URL(baseUrl + path).openConnection() as HttpURLConnection)
        try {
            c.requestMethod = method
            c.connectTimeout = 5_000
            c.readTimeout = 20_000
            c.setRequestProperty("x-chumi", "1")
            token?.let { c.setRequestProperty("authorization", "Bearer $it") }
            if (body != null) {
                c.doOutput = true
                c.setRequestProperty("content-type", "application/json")
                c.outputStream.use { it.write(body.toString().toByteArray()) }
            }
            val status = c.responseCode
            val text = (if (status >= 400) c.errorStream else c.inputStream)?.bufferedReader()?.use { it.readText() } ?: ""
            val json = runCatching { JSONObject(text) }.getOrDefault(JSONObject())
            if (status >= 400) throw ChumiException(status, json.optString("error", "HTTP $status"))
            return json
        } finally {
            c.disconnect()
        }
    }
}
