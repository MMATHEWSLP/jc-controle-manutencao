package br.com.jcsistema.campo

import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

/** Recebe os avisos do Firebase, inclusive com o app fechado, e mostra na barra de notificações. */
class PushService : FirebaseMessagingService() {
    override fun onCreate() {
        PushMessaging.init(this)
        super.onCreate()
    }

    /** Token novo: guardado; o site cadastra no próximo acesso (lib/push-client.ts: syncPush). */
    override fun onNewToken(token: String) {
        PushMessaging.saveToken(this, token)
    }

    override fun onMessageReceived(message: RemoteMessage) {
        PushMessaging.show(this, message.data)
    }
}
