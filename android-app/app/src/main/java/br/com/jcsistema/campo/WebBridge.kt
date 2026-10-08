package br.com.jcsistema.campo

import android.webkit.JavascriptInterface
import android.widget.Toast
import org.json.JSONObject

/**
 * Métodos que o script injetado (res/raw/jc_android.js) chama como window.JCAndroid.*.
 * Rodam fora da thread da tela; só agem quando a página aberta é o próprio sistema.
 */
class WebBridge(private val activity: MainActivity) {

    @JavascriptInterface
    fun setPullToRefresh(allowed: Boolean) {
        activity.canPullToRefresh = allowed && activity.siteLoaded
    }

    @JavascriptInterface
    fun saveBase64(dataUrl: String, name: String, mime: String, open: Boolean) {
        if (!activity.siteLoaded) return
        activity.downloads.saveDataUrl(dataUrl, name, mime, open)
    }

    @JavascriptInterface
    fun saveFailed(reason: String) {
        activity.runOnUiThread {
            Toast.makeText(activity, activity.getString(R.string.download_failed), Toast.LENGTH_LONG).show()
        }
    }

    @JavascriptInterface
    fun print() {
        if (!activity.siteLoaded) return
        activity.runOnUiThread { activity.printMainPage() }
    }

    /**
     * Avisos no celular (lib/push-client.ts): {"available": Firebase configurado neste app,
     * "permission": granted|denied|default, "token": token do Firebase já obtido}.
     */
    @JavascriptInterface
    fun pushState(): String {
        if (!activity.siteLoaded) return ""
        return JSONObject()
            .put("available", PushMessaging.isConfigured())
            .put("permission", activity.notificationPermission())
            .put("token", PushMessaging.cachedToken(activity))
            .toString()
    }

    /** "Ativar notificações": pede a permissão e o token; a resposta volta no evento jc:android-push. */
    @JavascriptInterface
    fun requestPush() {
        if (!activity.siteLoaded) return
        activity.runOnUiThread { activity.requestPush() }
    }
}
