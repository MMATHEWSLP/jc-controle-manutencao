package br.com.jcsistema.campo

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.view.Gravity
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import androidx.appcompat.app.AlertDialog
import androidx.core.content.FileProvider
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

/**
 * Atualização própria (sem Play Store), como o app de referência:
 *  1. ao abrir (no máximo a cada 6 h) consulta https://www.jcsistema.online/app/versao.json;
 *  2. versão maior que a instalada → "Nova versão disponível. Deseja baixar agora?";
 *  3. baixa o APK (conferindo tamanho e SHA-256), pede a permissão "instalar apps desta fonte" se
 *     precisar e abre o instalador do Android;
 *  4. "obrigatoria": true → com internet, o app só segue depois de atualizar.
 */
class Updater(private val activity: MainActivity) {
    private val prefs = activity.getSharedPreferences("atualizacao", Context.MODE_PRIVATE)
    private var pendingApk: File? = null
    private var offered: UpdateInfo? = null
    private var dialog: AlertDialog? = null
    private var downloadJob: Job? = null

    /** Chamado ao abrir e ao voltar para o app. */
    fun checkIfDue() {
        if (BuildConfig.DEBUG) return
        val now = System.currentTimeMillis()
        val mandatoryPending = prefs.getInt(KEY_MANDATORY, 0) > BuildConfig.VERSION_CODE
        if (!mandatoryPending && !UpdateRules.isDue(prefs.getLong(KEY_LAST_CHECK, 0), now)) return
        if (dialog?.isShowing == true || downloadJob?.isActive == true) return
        activity.lifecycleScope.launch {
            val info = withContext(Dispatchers.IO) { fetchInfo() } ?: return@launch
            prefs.edit().putLong(KEY_LAST_CHECK, now).putInt(KEY_MANDATORY, if (info.mandatory) info.versionCode else 0).apply()
            if (UpdateRules.isNewer(info, BuildConfig.VERSION_CODE)) offer(info)
        }
    }

    /** Volta das configurações de "instalar apps desconhecidos" ou do instalador. */
    fun onResume() {
        val apk = pendingApk
        if (apk != null && apk.exists() && canInstall()) {
            pendingApk = null
            install(apk)
            return
        }
        checkIfDue()
    }

    private fun fetchInfo(): UpdateInfo? = try {
        val connection = (URL(BuildConfig.UPDATE_URL).openConnection() as HttpURLConnection).apply {
            connectTimeout = 10_000
            readTimeout = 15_000
            useCaches = false
            setRequestProperty("Cache-Control", "no-cache")
            setRequestProperty("User-Agent", "JCSistemaAndroid/${BuildConfig.VERSION_NAME}")
        }
        try {
            if (connection.responseCode == HttpURLConnection.HTTP_OK) UpdateRules.parse(connection.inputStream.bufferedReader().use { it.readText() }) else null
        } finally {
            connection.disconnect()
        }
    } catch (_: Exception) {
        null
    }

    private fun offer(info: UpdateInfo) {
        if (activity.isFinishing || activity.isDestroyed) return
        offered = info
        val message = buildString {
            append(activity.getString(R.string.update_message, info.versionName, BuildConfig.VERSION_NAME))
            if (info.notes.isNotBlank()) append("\n\n").append(info.notes)
            if (info.mandatory) append("\n\n").append(activity.getString(R.string.update_mandatory))
        }
        val builder = AlertDialog.Builder(activity)
            .setTitle(R.string.update_title)
            .setMessage(message)
            .setCancelable(!info.mandatory)
            .setPositiveButton(R.string.update_download) { _, _ -> download(info) }
        if (!info.mandatory) builder.setNegativeButton(R.string.update_later, null)
        dialog = builder.show()
    }

    private fun download(info: UpdateInfo) {
        val bar = ProgressBar(activity, null, android.R.attr.progressBarStyleHorizontal).apply { max = 100; isIndeterminate = true }
        val label = TextView(activity).apply { text = activity.getString(R.string.update_downloading, 0); gravity = Gravity.CENTER }
        val padding = (20 * activity.resources.displayMetrics.density).toInt()
        val content = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(padding, padding, padding, padding / 2)
            addView(bar)
            addView(label)
        }
        val builder = AlertDialog.Builder(activity).setTitle(R.string.update_title).setView(content).setCancelable(false)
        if (!info.mandatory) builder.setNegativeButton(R.string.cancel) { _, _ -> downloadJob?.cancel() }
        dialog = builder.show()
        downloadJob = activity.lifecycleScope.launch {
            val file = try {
                withContext(Dispatchers.IO) {
                    downloadApk(info) { percent ->
                        activity.runOnUiThread {
                            bar.isIndeterminate = percent < 0
                            if (percent >= 0) bar.progress = percent
                            label.text = activity.getString(R.string.update_downloading, percent.coerceAtLeast(0))
                        }
                    }
                }
            } catch (cancel: CancellationException) {
                throw cancel
            } catch (_: Exception) {
                null
            }
            dialog?.dismiss()
            if (file == null) failed(info) else install(file)
        }
    }

    private suspend fun downloadApk(info: UpdateInfo, progress: (Int) -> Unit): File {
        val dir = File(activity.cacheDir, "atualizacao").apply { mkdirs() }
        dir.listFiles()?.forEach { it.delete() }
        val target = File(dir, "jc-sistema-${info.versionCode}.apk")
        val connection = (URL(info.url).openConnection() as HttpURLConnection).apply {
            connectTimeout = 15_000
            readTimeout = 30_000
            setRequestProperty("User-Agent", "JCSistemaAndroid/${BuildConfig.VERSION_NAME}")
        }
        try {
            check(connection.responseCode == HttpURLConnection.HTTP_OK) { "HTTP ${connection.responseCode}" }
            val total = connection.contentLengthLong.takeIf { it > 0 } ?: info.size ?: -1L
            val digest = MessageDigest.getInstance("SHA-256")
            var done = 0L
            var lastPercent = -2
            connection.inputStream.use { input ->
                target.outputStream().use { output ->
                    val buffer = ByteArray(64 * 1024)
                    while (true) {
                        kotlin.coroutines.coroutineContext.ensureActive()
                        val read = input.read(buffer)
                        if (read < 0) break
                        output.write(buffer, 0, read)
                        digest.update(buffer, 0, read)
                        done += read
                        val percent = if (total > 0) (done * 100 / total).toInt().coerceIn(0, 100) else -1
                        if (percent != lastPercent) { lastPercent = percent; progress(percent) }
                    }
                }
            }
            // Arquivo incompleto ou diferente do publicado nunca vai para o instalador.
            if (info.size != null) check(done == info.size) { "tamanho diferente" }
            if (info.sha256 != null) check(digest.digest().joinToString("") { "%02x".format(it) } == info.sha256) { "arquivo corrompido" }
            return target
        } catch (problem: Exception) {
            target.delete()
            throw problem
        } finally {
            connection.disconnect()
        }
    }

    private fun failed(info: UpdateInfo) {
        if (activity.isFinishing || activity.isDestroyed) return
        val builder = AlertDialog.Builder(activity)
            .setTitle(R.string.update_title)
            .setMessage(R.string.update_failed)
            .setCancelable(!info.mandatory)
            .setPositiveButton(R.string.retry) { _, _ -> download(info) }
        if (!info.mandatory) builder.setNegativeButton(R.string.update_later, null)
        dialog = builder.show()
    }

    private fun canInstall(): Boolean = Build.VERSION.SDK_INT < Build.VERSION_CODES.O || activity.packageManager.canRequestPackageInstalls()

    private fun install(apk: File) {
        if (!canInstall() && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            pendingApk = apk
            dialog = AlertDialog.Builder(activity)
                .setTitle(R.string.install_permission_title)
                .setMessage(R.string.install_permission_message)
                .setCancelable(offered?.mandatory != true)
                .setPositiveButton(R.string.open_settings) { _, _ ->
                    activity.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${activity.packageName}")))
                }
                .show()
            return
        }
        val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.arquivos", apk)
        val intent = Intent(Intent.ACTION_VIEW)
            .setDataAndType(uri, "application/vnd.android.package-archive")
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        try {
            // Se a pessoa cancelar o instalador: obrigatória → o aviso volta ao retornar ao app;
            // opcional → volta na próxima consulta (6 h).
            activity.startActivity(intent)
        } catch (_: ActivityNotFoundException) {
            offered?.let { failed(it) }
        }
    }

    companion object {
        private const val KEY_LAST_CHECK = "ultimaConsulta"
        private const val KEY_MANDATORY = "obrigatoriaVersao"
    }
}
