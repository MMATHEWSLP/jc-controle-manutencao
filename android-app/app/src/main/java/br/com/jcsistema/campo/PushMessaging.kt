package br.com.jcsistema.campo

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.messaging.FirebaseMessaging

/**
 * Avisos no celular pelo Firebase Cloud Messaging. Os dados do projeto Firebase vêm do build
 * (BuildConfig.FCM_*, preenchidos pelo workflow a partir do secret FIREBASE_GOOGLE_SERVICES_JSON);
 * sem eles o app funciona igual, só sem aviso no celular (o sino do sistema continua).
 * O token do aparelho é cadastrado pelo site (lib/push-client.ts) pela ponte WebBridge.
 */
object PushMessaging {
    const val CHANNEL_ID = "avisos"
    const val EXTRA_URL = "br.com.jcsistema.campo.URL_AVISO"
    private const val PREFS = "avisos"

    fun isConfigured(): Boolean =
        PushRules.configured(BuildConfig.FCM_APP_ID, BuildConfig.FCM_API_KEY, BuildConfig.FCM_PROJECT_ID, BuildConfig.FCM_SENDER_ID)

    /** Liga o Firebase (uma vez por processo). Chamado ao abrir o app e ao chegar um aviso. */
    fun init(context: Context): Boolean {
        if (!isConfigured()) return false
        return runCatching {
            if (FirebaseApp.getApps(context).isEmpty()) {
                val options = FirebaseOptions.Builder()
                    .setApplicationId(BuildConfig.FCM_APP_ID)
                    .setApiKey(BuildConfig.FCM_API_KEY)
                    .setProjectId(BuildConfig.FCM_PROJECT_ID)
                    .setGcmSenderId(BuildConfig.FCM_SENDER_ID)
                    .build()
                FirebaseApp.initializeApp(context.applicationContext, options)
            }
            true
        }.getOrDefault(false)
    }

    fun cachedToken(context: Context): String = prefs(context).getString("token", "").orEmpty()

    fun saveToken(context: Context, token: String) {
        prefs(context).edit().putString("token", token).apply()
    }

    /** Pede o token ao Firebase; callback(token, erro) na thread principal. */
    fun fetchToken(context: Context, callback: (String?, String?) -> Unit) {
        if (!init(context)) return callback(null, "Firebase não configurado neste app.")
        runCatching {
            FirebaseMessaging.getInstance().token.addOnCompleteListener { task ->
                val token = if (task.isSuccessful) task.result else null
                if (!token.isNullOrBlank()) {
                    saveToken(context, token)
                    callback(token, null)
                } else {
                    callback(null, task.exception?.message ?: "O Firebase não entregou o token. Confira a internet e tente de novo.")
                }
            }
        }.onFailure { callback(null, it.message ?: "Falha ao falar com o Firebase.") }
    }

    fun notificationsAllowed(context: Context): Boolean =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
        } else {
            NotificationManagerCompat.from(context).areNotificationsEnabled()
        }

    fun markDenied(context: Context, denied: Boolean) {
        prefs(context).edit().putBoolean("negou", denied).apply()
    }

    fun wasDenied(context: Context): Boolean = prefs(context).getBoolean("negou", false)

    fun createChannel(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val channel = NotificationChannel(CHANNEL_ID, context.getString(R.string.channel_notices), NotificationManager.IMPORTANCE_HIGH)
        channel.description = context.getString(R.string.channel_notices_description)
        context.getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
    }

    /** Mostra o aviso; o toque abre o app na página do aviso (MainActivity lê EXTRA_URL). */
    fun show(context: Context, data: Map<String, String>) {
        val notice = PushRules.notice(data, BuildConfig.SITE_URL)
        createChannel(context)
        if (!notificationsAllowed(context)) return
        val intent = Intent(context, MainActivity::class.java)
            .setAction(Intent.ACTION_VIEW)
            .putExtra(EXTRA_URL, notice.url)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        val pending = PendingIntent.getActivity(context, notice.id, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val notification = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_notify)
            .setColor(ContextCompat.getColor(context, R.color.jc_green))
            .setContentTitle(notice.title)
            .setContentText(notice.body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(notice.body))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setAutoCancel(true)
            .setContentIntent(pending)
            .build()
        try {
            NotificationManagerCompat.from(context).notify(notice.id, notification)
        } catch (_: SecurityException) {
            // Notificações bloqueadas nos ajustes: o aviso continua no sino do sistema.
        }
    }

    private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
}
