package br.com.jcsistema.campo

import android.Manifest
import android.app.DownloadManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.ActivityNotFoundException
import android.content.ContentValues
import android.content.Intent
import android.content.pm.PackageManager
import android.media.MediaScannerConnection
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.util.Base64
import android.webkit.CookieManager
import android.webkit.DownloadListener
import android.webkit.URLUtil
import android.widget.Toast
import androidx.core.app.ActivityCompat
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import org.json.JSONObject
import java.io.File
import kotlin.concurrent.thread

/**
 * Downloads do sistema (PDF, Excel, CSV, QR Code), sempre na pasta Downloads do celular:
 *  - endereços do servidor (PDF dos relatórios): DownloadManager levando o login (cookie) junto,
 *    com a notificação do próprio Android;
 *  - arquivos gerados no navegador (blob:/data:): o script injetado manda o conteúdo e o app grava,
 *    avisando por notificação (e abrindo o arquivo quando o site queria "ver" o PDF).
 */
class Downloads(private val activity: MainActivity) : DownloadListener {

    override fun onDownloadStart(url: String, userAgent: String?, contentDisposition: String?, mimetype: String?, contentLength: Long) {
        val name = FileNames.finalName(FileNames.fromContentDisposition(contentDisposition) ?: URLUtil.guessFileName(url, contentDisposition, mimetype), mimetype)
        when (AppLinks.scheme(url)) {
            "blob" -> activity.mainWebView?.evaluateJavascript(
                "window.__jcSaveBlob && window.__jcSaveBlob(${JSONObject.quote(url)}, ${JSONObject.quote(name)}, false)", null,
            )
            "data" -> saveDataUrl(url, name, mimetype ?: "", open = false)
            "http", "https" -> withLegacyStoragePermission { enqueue(url, userAgent, name, mimetype) }
        }
    }

    private fun enqueue(url: String, userAgent: String?, name: String, mimetype: String?) {
        try {
            val request = DownloadManager.Request(Uri.parse(url))
                .setTitle(name)
                .setDescription(activity.getString(R.string.app_name))
                .setMimeType(FileNames.mimeFor(name, mimetype))
                .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                .setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name)
            // O relatório só sai com o login: o DownloadManager não usa os cookies do WebView sozinho.
            CookieManager.getInstance().getCookie(url)?.let { request.addRequestHeader("Cookie", it) }
            userAgent?.let { request.addRequestHeader("User-Agent", it) }
            (activity.getSystemService(DownloadManager::class.java)).enqueue(request)
            toast(activity.getString(R.string.download_started, name))
        } catch (_: Exception) {
            toast(activity.getString(R.string.download_failed))
        }
    }

    /** Conteúdo "data:tipo;base64,..." vindo do site. Pode ser chamado fora da thread da tela. */
    fun saveDataUrl(dataUrl: String, requestedName: String, requestedMime: String, open: Boolean) {
        val comma = dataUrl.indexOf(',')
        if (!dataUrl.startsWith("data:") || comma < 0) return toast(activity.getString(R.string.download_failed))
        val header = dataUrl.substring(5, comma)
        val mime = requestedMime.ifBlank { header.substringBefore(';') }.ifBlank { "application/octet-stream" }
        val bytes = try {
            if (header.contains(";base64")) Base64.decode(dataUrl.substring(comma + 1), Base64.DEFAULT)
            else Uri.decode(dataUrl.substring(comma + 1)).toByteArray()
        } catch (_: IllegalArgumentException) {
            return toast(activity.getString(R.string.download_failed))
        }
        val name = FileNames.finalName(requestedName.ifBlank { "arquivo-jc-sistema" }, mime)
        activity.runOnUiThread {
            withLegacyStoragePermission {
                thread(name = "salvar-arquivo") {
                    val saved = runCatching { write(name, FileNames.mimeFor(name, mime), bytes) }.getOrNull()
                    activity.runOnUiThread {
                        if (saved == null) toast(activity.getString(R.string.download_failed))
                        else afterSaved(saved.first, saved.second, FileNames.mimeFor(name, mime), open)
                    }
                }
            }
        }
    }

    /** Grava em Downloads. Devolve (nome final, endereço para abrir). */
    private fun write(name: String, mime: String, bytes: ByteArray): Pair<String, Uri> {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val resolver = activity.contentResolver
            val values = ContentValues().apply {
                put(MediaStore.MediaColumns.DISPLAY_NAME, name)
                put(MediaStore.MediaColumns.MIME_TYPE, mime)
                put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS)
                put(MediaStore.MediaColumns.IS_PENDING, 1)
            }
            val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: error("sem acesso a Downloads")
            resolver.openOutputStream(uri)?.use { it.write(bytes) } ?: error("sem acesso a Downloads")
            values.clear()
            values.put(MediaStore.MediaColumns.IS_PENDING, 0)
            resolver.update(uri, values, null, null)
            return name to uri
        }
        @Suppress("DEPRECATION")
        val dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS).apply { mkdirs() }
        var file = File(dir, name)
        var index = 1
        while (file.exists()) {
            val ext = FileNames.extensionOf(name)
            val base = if (ext.isEmpty()) name else name.dropLast(ext.length + 1)
            file = File(dir, if (ext.isEmpty()) "$base ($index)" else "$base ($index).$ext")
            index++
        }
        file.writeBytes(bytes)
        MediaScannerConnection.scanFile(activity, arrayOf(file.absolutePath), arrayOf(mime), null)
        return file.name to FileProvider.getUriForFile(activity, "${activity.packageName}.arquivos", file)
    }

    private fun afterSaved(name: String, uri: Uri, mime: String, open: Boolean) {
        toast(activity.getString(R.string.download_saved, name))
        notifySaved(name, uri, mime)
        if (open) openFile(uri, mime)
    }

    private fun viewIntent(uri: Uri, mime: String) = Intent(Intent.ACTION_VIEW)
        .setDataAndType(uri, mime)
        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)

    private fun openFile(uri: Uri, mime: String) {
        try {
            activity.startActivity(viewIntent(uri, mime))
        } catch (_: ActivityNotFoundException) {
            toast(activity.getString(R.string.no_app_to_open))
        }
    }

    private fun notifySaved(name: String, uri: Uri, mime: String) {
        val manager = NotificationManagerCompat.from(activity)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(CHANNEL_ID, activity.getString(R.string.channel_downloads), NotificationManager.IMPORTANCE_DEFAULT)
            activity.getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ActivityCompat.checkSelfPermission(activity, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            activity.askNotificationPermissionOnce()
            return
        }
        val pending = PendingIntent.getActivity(activity, uri.hashCode(), viewIntent(uri, mime), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val notification = NotificationCompat.Builder(activity, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_download)
            .setContentTitle(activity.getString(R.string.download_notification_title))
            .setContentText(name)
            .setContentIntent(pending)
            .setAutoCancel(true)
            .build()
        try {
            manager.notify(uri.hashCode(), notification)
        } catch (_: SecurityException) {
            // Notificações bloqueadas: o aviso na tela já foi mostrado.
        }
    }

    /** Android 7 a 9 pedem permissão para gravar na pasta Downloads; do 10 em diante não precisa. */
    private fun withLegacyStoragePermission(action: () -> Unit) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q ||
            ContextCompat.checkSelfPermission(activity, Manifest.permission.WRITE_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED
        ) return action()
        activity.askPermissions(arrayOf(Manifest.permission.WRITE_EXTERNAL_STORAGE)) { granted ->
            if (granted) action() else toast(activity.getString(R.string.storage_denied))
        }
    }

    private fun toast(message: String) {
        activity.runOnUiThread { Toast.makeText(activity, message, Toast.LENGTH_LONG).show() }
    }

    companion object {
        private const val CHANNEL_ID = "arquivos"
    }
}
