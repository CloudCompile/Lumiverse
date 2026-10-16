package chat.lumiverse.prototype

import android.app.Activity
import android.webkit.CookieManager
import android.webkit.WebView
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Plugin
import org.json.JSONObject

@TauriPlugin
class RuntimePlugin(private val activity: Activity) : Plugin(activity) {
    private var runtime: RuntimeHost? = null
    override fun load(webView: WebView) {
        webView.settings.javaScriptEnabled = true
        webView.settings.domStorageEnabled = true
        webView.settings.allowFileAccess = false
        webView.settings.allowContentAccess = false
        CookieManager.getInstance().setAcceptCookie(true)
        runtime = RuntimeHost(activity, "tauri", object : RuntimeHost.Listener {
            override fun ready(url: String) { activity.runOnUiThread { webView.loadUrl(url) } }
            override fun failed(message: String) { activity.runOnUiThread {
                webView.evaluateJavascript("document.getElementById('status')?.replaceChildren(document.createTextNode(${JSONObject.quote(message)}))", null)
            } }
        }).also { it.start() }
    }
    override fun onDestroy() { runtime?.stop(); runtime = null }
}
