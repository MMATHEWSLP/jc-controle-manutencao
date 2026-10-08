package br.com.jcsistema.campo

import android.Manifest
import android.annotation.SuppressLint
import android.app.Dialog
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.Color
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.Message
import android.os.SystemClock
import android.print.PrintAttributes
import android.print.PrintManager
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.CookieManager
import android.webkit.GeolocationPermissions
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import kotlin.math.max

/**
 * Uma única tela: o sistema (https://www.jcsistema.online) em tela cheia num WebView.
 * Câmera/galeria (FileChooser), downloads (Downloads), atualização própria (Updater), GPS para o
 * site, links externos no app do celular, janelas novas e impressão, botão voltar, puxar para
 * recarregar e a tela "Sem internet" quando não há sinal nem cópia salva.
 */
class MainActivity : AppCompatActivity() {
    var mainWebView: WebView? = null
        private set
    private lateinit var root: View
    private lateinit var swipe: SwipeRefreshLayout
    private lateinit var progress: ProgressBar
    private lateinit var offlineView: View
    private lateinit var offlineTitle: TextView
    private lateinit var offlineText: TextView

    lateinit var downloads: Downloads
        private set
    private lateinit var fileChooser: FileChooser
    private lateinit var updater: Updater
    private val handler = Handler(Looper.getMainLooper())

    /** Atualizado pelo script injetado (toque na página): pode puxar para recarregar agora? */
    @Volatile var canPullToRefresh = false

    /** A página aberta no WebView é o próprio sistema (só então o script pode chamar o app). */
    @Volatile var siteLoaded = false
        private set

    private var showingOffline = false
    private var failedUrl: String? = null
    private var firstPageShown = false
    private val startedAt = SystemClock.uptimeMillis()
    private var networkCallback: ConnectivityManager.NetworkCallback? = null
    private val popups = mutableListOf<Dialog>()
    private var injectScript: String = ""

    // Permissões pedidas na hora do uso (câmera, localização, gravar em Downloads no Android 7–9).
    private var permissionCallback: ((Boolean) -> Unit)? = null
    private val permissionLauncher = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { result ->
        val callback = permissionCallback
        permissionCallback = null
        callback?.invoke(result.values.any { it })
    }

    fun askPermissions(permissions: Array<String>, onResult: (Boolean) -> Unit) {
        if (permissions.any { ContextCompat.checkSelfPermission(this, it) == PackageManager.PERMISSION_GRANTED }) return onResult(true)
        permissionCallback?.invoke(false)
        permissionCallback = onResult
        permissionLauncher.launch(permissions)
    }

    // ------------------------------------------------------------------------------------------
    // Avisos do sistema (Firebase): permissão, token para o site e abrir a página do aviso.
    // ------------------------------------------------------------------------------------------
    fun notificationPermission(): String = when {
        PushMessaging.notificationsAllowed(this) -> "granted"
        Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU -> "denied"
        PushMessaging.wasDenied(this) && !shouldShowRequestPermissionRationale(Manifest.permission.POST_NOTIFICATIONS) -> "denied"
        else -> "default"
    }

    fun requestPush() {
        if (!PushMessaging.isConfigured()) return answerPush(null, getString(R.string.push_not_configured))
        val fetch = { PushMessaging.fetchToken(this) { token, error -> answerPush(token, error) } }
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            return if (PushMessaging.notificationsAllowed(this)) fetch() else answerPush(null, getString(R.string.push_denied))
        }
        askPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS)) { granted ->
            PushMessaging.markDenied(this, !granted)
            if (granted) fetch() else answerPush(null, getString(R.string.push_denied))
        }
    }

    private fun answerPush(token: String?, error: String?) {
        val detail = org.json.JSONObject().put("token", token ?: "").put("error", error ?: "").toString()
        runOnUiThread {
            mainWebView?.evaluateJavascript("window.dispatchEvent(new CustomEvent('jc:android-push',{detail:$detail}))", null)
        }
    }

    /** Página do aviso tocado na barra de notificações (só do próprio sistema). */
    private fun noticeUrl(intent: Intent?): String? =
        intent?.getStringExtra(PushMessaging.EXTRA_URL)?.takeIf { AppLinks.isSite(it) }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        noticeUrl(intent)?.let { url -> mainWebView?.loadUrl(url) }
    }

    fun askNotificationPermissionOnce() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
        val prefs = getSharedPreferences("app", MODE_PRIVATE)
        if (prefs.getBoolean("pediuNotificacao", false)) return
        prefs.edit().putBoolean("pediuNotificacao", true).apply()
        askPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS)) { }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        val splash = installSplashScreen()
        super.onCreate(savedInstanceState)
        // Logo na tela até a primeira página aparecer (no máximo 5 s).
        splash.setKeepOnScreenCondition { !firstPageShown && SystemClock.uptimeMillis() - startedAt < 5_000 }

        downloads = Downloads(this)
        fileChooser = FileChooser(this)
        updater = Updater(this)

        WindowCompat.setDecorFitsSystemWindows(window, false)
        setContentView(R.layout.activity_main)
        root = findViewById(R.id.root)
        swipe = findViewById(R.id.swipe)
        progress = findViewById(R.id.progress)
        offlineView = findViewById(R.id.offline)
        offlineTitle = findViewById(R.id.offline_title)
        offlineText = findViewById(R.id.offline_text)
        findViewById<Button>(R.id.offline_retry).setOnClickListener { retry() }
        applyInsets()

        val webView = findViewById<WebView>(R.id.webview)
        mainWebView = webView
        injectScript = resources.openRawResource(R.raw.jc_android).bufferedReader().use { it.readText() }
        configure(webView)

        swipe.setColorSchemeColors(ContextCompat.getColor(this, R.color.jc_green))
        swipe.setOnChildScrollUpCallback { _, _ -> showingOffline || !canPullToRefresh || webView.scrollY > 0 }
        swipe.setOnRefreshListener {
            canPullToRefresh = false
            webView.reload()
        }

        onBackPressedDispatcher.addCallback(this, backCallback)
        watchConnection()
        fileChooser.cleanOldPhotos()

        val notice = noticeUrl(intent)
        if (notice != null) {
            webView.loadUrl(notice)
        } else if (savedInstanceState == null || webView.restoreState(savedInstanceState) == null) {
            webView.loadUrl(BuildConfig.SITE_URL)
        }
        updater.checkIfDue()
        // Avisos: canal criado e, com a permissão já dada, o token pronto para o site cadastrar.
        PushMessaging.createChannel(this)
        if (PushMessaging.isConfigured() && PushMessaging.notificationsAllowed(this)) PushMessaging.fetchToken(this) { _, _ -> }
    }

    // Android 15/16 desenham o app por baixo das barras: margens e teclado tratados aqui.
    private fun applyInsets() {
        ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
            view.setPadding(bars.left, bars.top, bars.right, max(bars.bottom, ime.bottom))
            WindowInsetsCompat.CONSUMED
        }
        WindowInsetsControllerCompat(window, root).apply {
            isAppearanceLightStatusBars = true
            isAppearanceLightNavigationBars = true
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun configure(webView: WebView) {
        webView.setBackgroundColor(Color.WHITE)
        with(webView.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            @Suppress("DEPRECATION")
            databaseEnabled = true
            // Cache padrão: o service worker e o IndexedDB do site cuidam do funcionamento sem sinal.
            cacheMode = WebSettings.LOAD_DEFAULT
            allowFileAccess = false
            allowContentAccess = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            setSupportMultipleWindows(true)
            javaScriptCanOpenWindowsAutomatically = true
            setGeolocationEnabled(true)
            mediaPlaybackRequiresUserGesture = true
            userAgentString = "$userAgentString JCSistemaAndroid/${BuildConfig.VERSION_NAME}"
        }
        // Login guardado no celular (cookie com validade definida pelo site).
        CookieManager.getInstance().apply {
            setAcceptCookie(true)
            setAcceptThirdPartyCookies(webView, false)
        }
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        webView.addJavascriptInterface(WebBridge(this), "JCAndroid")
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            WebViewCompat.addDocumentStartJavaScript(webView, injectScript, AppLinks.SITE_HOSTS.map { "https://$it" }.toSet())
        }
        webView.webViewClient = MainClient()
        webView.webChromeClient = MainChromeClient()
        webView.setDownloadListener(downloads)
    }

    /** Em WebViews antigos (sem script no início da página), injeta assim que der. */
    private fun injectFallback(view: WebView, url: String?) {
        if (url != null && AppLinks.isSite(url) && !WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            view.evaluateJavascript(injectScript, null)
        }
    }

    private inner class MainClient : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean = route(request.url.toString())

        override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
            siteLoaded = url != null && AppLinks.isSite(url)
            canPullToRefresh = false
            progress.visibility = View.VISIBLE
            injectFallback(view, url)
        }

        override fun onPageCommitVisible(view: WebView, url: String?) {
            if (!showingOffline) firstPageShown = true
        }

        override fun onPageFinished(view: WebView, url: String?) {
            progress.visibility = View.GONE
            swipe.isRefreshing = false
            if (!showingOffline) firstPageShown = true
            injectFallback(view, url)
            CookieManager.getInstance().flush()
        }

        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
            if (!request.isForMainFrame) return
            showOffline(request.url.toString())
        }

        override fun onRenderProcessGone(view: WebView, detail: android.webkit.RenderProcessGoneDetail?): Boolean {
            // O motor do WebView caiu (pouca memória): abre a tela de novo em vez de fechar o app.
            (view.parent as? ViewGroup)?.removeView(view)
            view.destroy()
            mainWebView = null
            recreate()
            return true
        }
    }

    private inner class MainChromeClient : WebChromeClient() {
        override fun onProgressChanged(view: WebView, newProgress: Int) {
            progress.progress = newProgress
            if (newProgress >= 100) progress.visibility = View.GONE
        }

        override fun onShowFileChooser(webView: WebView, filePathCallback: ValueCallback<Array<Uri>>, fileChooserParams: FileChooserParams): Boolean =
            fileChooser.open(filePathCallback, fileChooserParams)

        // Localização para o site (fotos do comboio com GPS): só para o próprio sistema.
        override fun onGeolocationPermissionsShowPrompt(origin: String, callback: GeolocationPermissions.Callback) {
            if (!AppLinks.isSite(origin)) return callback.invoke(origin, false, false)
            askPermissions(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION)) { granted ->
                callback.invoke(origin, granted, false)
            }
        }

        // Câmera ao vivo (getUserMedia), se o site vier a usar: só para o próprio sistema.
        override fun onPermissionRequest(request: PermissionRequest) {
            val wantsCamera = request.resources.contains(PermissionRequest.RESOURCE_VIDEO_CAPTURE)
            if (!wantsCamera || !AppLinks.isSite(request.origin.toString())) return request.deny()
            askPermissions(arrayOf(Manifest.permission.CAMERA)) { granted ->
                if (granted) request.grant(arrayOf(PermissionRequest.RESOURCE_VIDEO_CAPTURE)) else request.deny()
            }
        }

        override fun onCreateWindow(view: WebView, isDialog: Boolean, isUserGesture: Boolean, resultMsg: Message): Boolean {
            openPopup(resultMsg)
            return true
        }
    }

    /** true = o app tratou o link (não carregar no WebView). */
    private fun route(url: String): Boolean = when (AppLinks.classify(url)) {
        AppLinks.Target.INTERNAL -> false
        AppLinks.Target.EXTERNAL -> { openExternal(url); true }
        AppLinks.Target.BLOCKED -> true
    }

    // WhatsApp, Maps, telefone, e-mail e outros sites: no app correspondente do celular.
    private fun openExternal(url: String) {
        try {
            val intent = if (url.startsWith("intent:")) {
                Intent.parseUri(url, Intent.URI_INTENT_SCHEME).apply {
                    addCategory(Intent.CATEGORY_BROWSABLE)
                    component = null
                    selector = null
                }
            } else {
                Intent(Intent.ACTION_VIEW, Uri.parse(url))
            }
            startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (_: ActivityNotFoundException) {
            val fallback = runCatching { Intent.parseUri(url, Intent.URI_INTENT_SCHEME).getStringExtra("browser_fallback_url") }.getOrNull()
            if (fallback != null && AppLinks.classify(fallback) == AppLinks.Target.EXTERNAL && !fallback.startsWith("intent:")) openExternal(fallback)
            else Toast.makeText(this, R.string.no_app_to_open, Toast.LENGTH_LONG).show()
        } catch (_: Exception) {
            Toast.makeText(this, R.string.no_app_to_open, Toast.LENGTH_LONG).show()
        }
    }

    // ------------------------------------------------------------------------------------------
    // Janelas novas (window.open): PDF baixa, WhatsApp/Maps abrem fora, páginas de impressão abrem
    // numa janela com "Imprimir / Salvar PDF".
    // ------------------------------------------------------------------------------------------
    @SuppressLint("SetJavaScriptEnabled")
    private fun openPopup(resultMsg: Message) {
        val popup = WebView(this)
        val dialog = Dialog(this, android.R.style.Theme_DeviceDefault_Light_NoActionBar)
        var handled = false
        var printed = false
        fun close() {
            handled = true
            if (dialog.isShowing) dialog.dismiss() else { popups.remove(dialog); popup.destroy() }
        }
        with(popup.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            userAgentString = mainWebView?.settings?.userAgentString ?: userAgentString
        }
        popup.setBackgroundColor(Color.WHITE)
        popup.setDownloadListener { url, userAgent, disposition, mime, length ->
            downloads.onDownloadStart(url, userAgent, disposition, mime, length)
            close()
        }
        popup.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val url = request.url.toString()
                return when (AppLinks.classify(url)) {
                    AppLinks.Target.INTERNAL -> false
                    AppLinks.Target.EXTERNAL -> { openExternal(url); close(); true }
                    AppLinks.Target.BLOCKED -> { close(); true }
                }
            }

            override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
                if (url != null && AppLinks.classify(url) == AppLinks.Target.EXTERNAL) {
                    view.stopLoading()
                    openExternal(url)
                    close()
                }
            }
        }
        popup.webChromeClient = object : WebChromeClient() {
            override fun onCloseWindow(window: WebView) = close()
        }
        val toolbar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            setBackgroundColor(ContextCompat.getColor(this@MainActivity, R.color.jc_dark))
            val pad = (8 * resources.displayMetrics.density).toInt()
            setPadding(pad, pad, pad, pad)
            addView(Button(this@MainActivity).apply { setText(R.string.popup_close); setOnClickListener { close() } })
            addView(View(this@MainActivity), LinearLayout.LayoutParams(0, 1, 1f))
            addView(Button(this@MainActivity).apply { setText(R.string.popup_print); setOnClickListener { print(popup, getString(R.string.app_name)) } })
        }
        val content = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            addView(toolbar, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
            addView(popup, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        }
        dialog.setContentView(content)
        dialog.window?.setLayout(WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.MATCH_PARENT)
        dialog.setOnDismissListener {
            popups.remove(dialog)
            popup.destroy()
        }
        popups += dialog
        (resultMsg.obj as WebView.WebViewTransport).webView = popup
        resultMsg.sendToTarget()
        // Mostra a janela só se ela não virou download/WhatsApp logo de cara (evita piscar).
        handler.postDelayed({ if (!handled && !isFinishing) dialog.show() }, 400)
        // Páginas de impressão do site chamam window.print() ao carregar (no WebView não faz nada):
        // o app abre a impressão do Android no lugar.
        for (delay in longArrayOf(900, 2_000)) {
            handler.postDelayed({
                if (handled || printed || !dialog.isShowing) return@postDelayed
                popup.evaluateJavascript("(document.documentElement.innerHTML.indexOf('window.print') >= 0)") { result ->
                    if (result == "true" && !printed) { printed = true; print(popup, getString(R.string.app_name)) }
                }
            }, delay)
        }
    }

    fun printMainPage() {
        mainWebView?.let { print(it, it.title?.takeIf { title -> title.isNotBlank() } ?: getString(R.string.app_name)) }
    }

    private fun print(view: WebView, title: String) {
        try {
            val manager = getSystemService(PrintManager::class.java)
            val attributes = PrintAttributes.Builder().setMediaSize(PrintAttributes.MediaSize.ISO_A4).build()
            manager.print(title, view.createPrintDocumentAdapter(title), attributes)
        } catch (_: Exception) {
            Toast.makeText(this, R.string.print_failed, Toast.LENGTH_LONG).show()
        }
    }

    // ------------------------------------------------------------------------------------------
    // Sem internet
    // ------------------------------------------------------------------------------------------
    private fun isOnline(): Boolean {
        val manager = getSystemService(ConnectivityManager::class.java) ?: return true
        val capabilities = manager.getNetworkCapabilities(manager.activeNetwork) ?: return false
        return capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
    }

    private fun showOffline(url: String) {
        failedUrl = url
        showingOffline = true
        firstPageShown = true
        swipe.isRefreshing = false
        progress.visibility = View.GONE
        val online = isOnline()
        offlineTitle.setText(if (online) R.string.error_title else R.string.offline_title)
        offlineText.setText(if (online) R.string.error_text else R.string.offline_text)
        offlineView.visibility = View.VISIBLE
        mainWebView?.visibility = View.INVISIBLE
    }

    private fun retry() {
        val webView = mainWebView ?: return
        showingOffline = false
        offlineView.visibility = View.GONE
        webView.visibility = View.VISIBLE
        webView.loadUrl(failedUrl ?: BuildConfig.SITE_URL)
    }

    // A conexão voltou: recarrega sozinho.
    private fun watchConnection() {
        val manager = getSystemService(ConnectivityManager::class.java) ?: return
        val callback = object : ConnectivityManager.NetworkCallback() {
            override fun onCapabilitiesChanged(network: Network, capabilities: NetworkCapabilities) {
                if (capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)) {
                    handler.post { if (showingOffline) retry() }
                }
            }
        }
        try {
            manager.registerDefaultNetworkCallback(callback)
            networkCallback = callback
        } catch (_: Exception) {
            // Sem aviso de rede: o botão "Tentar novamente" continua funcionando.
        }
    }

    // ------------------------------------------------------------------------------------------
    // Voltar: fecha a janela aberta no sistema → volta a página → na tela inicial, pergunta se sai.
    // ------------------------------------------------------------------------------------------
    private val backCallback = object : OnBackPressedCallback(true) {
        override fun handleOnBackPressed() {
            popups.lastOrNull()?.let { if (it.isShowing) { it.dismiss(); return } }
            val webView = mainWebView
            if (webView == null || showingOffline) return confirmExit()
            webView.evaluateJavascript("(window.__jcBack ? window.__jcBack() : false)") { result ->
                when {
                    result == "true" -> Unit
                    webView.canGoBack() && !AppLinks.isHome(webView.url) -> webView.goBack()
                    else -> confirmExit()
                }
            }
        }
    }

    private fun confirmExit() {
        AlertDialog.Builder(this)
            .setTitle(R.string.exit_title)
            .setMessage(R.string.exit_message)
            .setPositiveButton(R.string.exit_yes) { _, _ -> finish() }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    override fun onResume() {
        super.onResume()
        mainWebView?.onResume()
        updater.onResume()
    }

    override fun onPause() {
        CookieManager.getInstance().flush()
        mainWebView?.onPause()
        super.onPause()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        mainWebView?.saveState(outState)
        super.onSaveInstanceState(outState)
    }

    override fun onDestroy() {
        networkCallback?.let { callback -> runCatching { getSystemService(ConnectivityManager::class.java)?.unregisterNetworkCallback(callback) } }
        handler.removeCallbacksAndMessages(null)
        popups.toList().forEach { it.dismiss() }
        mainWebView?.let {
            (it.parent as? ViewGroup)?.removeView(it)
            it.destroy()
        }
        mainWebView = null
        super.onDestroy()
    }
}
