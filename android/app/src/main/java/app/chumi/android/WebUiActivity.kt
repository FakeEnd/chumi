package app.chumi.android

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.KeyEvent
import android.view.WindowInsets
import android.webkit.CookieManager
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.window.OnBackInvokedCallback
import android.window.OnBackInvokedDispatcher

/**
 * The full Chumi interface from the computer: live transcript, catch-up, questions, summaries and handoffs.
 * The device token travels as a cookie, which Chumi's phone access accepts like the Authorization header.
 */
class WebUiActivity : Activity() {
    private lateinit var web: WebView

    @SuppressLint("SetJavaScriptEnabled") // Chumi's interface is a JavaScript app served by the user's own computer.
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val pairing = Pairing.load(this) ?: return finish()
        CookieManager.getInstance().setCookie(pairing.serverUrl, "chumi_device=${pairing.token}; Path=/; HttpOnly; SameSite=Strict")
        web = WebView(this)
        web.settings.javaScriptEnabled = true
        web.settings.domStorageEnabled = true
        web.webViewClient = object : WebViewClient() {
            // Links to other sites (documentation, evidence elsewhere) open in the browser.
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                if (request.url.toString().startsWith(pairing.serverUrl)) return false
                startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(request.url.toString())))
                return true
            }
        }
        web.setOnApplyWindowInsetsListener { v, insets ->
            val bars = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.ime())
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            insets
        }
        setContentView(web)
        web.loadUrl(pairing.serverUrl)
    }

    // Back goes back inside Chumi's interface first. Android 13+ delivers it through OnBackInvokedDispatcher (with
    // predictive back, Android 16 sends no back key at all); Android 11 and 12 send the back key.
    private var back: Any? = null

    override fun onStart() {
        super.onStart()
        if (Build.VERSION.SDK_INT >= 33) {
            val cb = OnBackInvokedCallback { if (web.canGoBack()) web.goBack() else finish() }
            onBackInvokedDispatcher.registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT, cb)
            back = cb
        }
    }

    override fun onStop() {
        super.onStop()
        if (Build.VERSION.SDK_INT >= 33) (back as? OnBackInvokedCallback)?.let { onBackInvokedDispatcher.unregisterOnBackInvokedCallback(it) }
        back = null
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        if (keyCode == KeyEvent.KEYCODE_BACK && ::web.isInitialized && web.canGoBack()) { web.goBack(); return true }
        return super.onKeyDown(keyCode, event)
    }
}
