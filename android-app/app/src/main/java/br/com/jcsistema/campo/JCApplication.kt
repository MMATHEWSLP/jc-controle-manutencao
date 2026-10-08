package br.com.jcsistema.campo

import android.app.Application

/** Liga o Firebase antes de qualquer tela ou aviso (o aviso pode chegar com o app fechado). */
class JCApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        PushMessaging.init(this)
    }
}
