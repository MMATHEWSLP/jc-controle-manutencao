package br.com.jcsistema.campo

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class PushRulesTest {
    private val home = "https://www.jcsistema.online/"

    @Test
    fun avisoComOsDadosDoServidor() {
        val notice = PushRules.notice(mapOf("title" to "Abastecimento rejeitado", "body" to "CM-33 · 150 L\nMotivo: foto", "url" to "https://www.jcsistema.online/?notificacao=12", "tag" to ""), home)
        assertEquals("Abastecimento rejeitado", notice.title)
        assertEquals("CM-33 · 150 L\nMotivo: foto", notice.body)
        assertEquals("https://www.jcsistema.online/?notificacao=12", notice.url)
        assertTrue(notice.id >= 0)
    }

    @Test
    fun faltandoDadosValeOPadrao() {
        val notice = PushRules.notice(emptyMap(), home)
        assertEquals("JC Sistema", notice.title)
        assertEquals("", notice.body)
        assertEquals(home, notice.url)
    }

    @Test
    fun linkDeOutroSiteAbreAPaginaInicial() {
        assertEquals(home, PushRules.notice(mapOf("url" to "https://golpe.com/?notificacao=1"), home).url)
        assertEquals(home, PushRules.notice(mapOf("url" to "javascript:alert(1)"), home).url)
        assertEquals(home, PushRules.notice(mapOf("url" to "https://jcsistema.online.golpe.com/"), home).url)
    }

    @Test
    fun mesmaEtiquetaSubstituiOAvisoAnterior() {
        val first = PushRules.notice(mapOf("tag" to "convoy.pending:3", "url" to "https://www.jcsistema.online/?notificacao=1"), home)
        val second = PushRules.notice(mapOf("tag" to "convoy.pending:3", "url" to "https://www.jcsistema.online/?notificacao=2"), home)
        assertEquals(first.id, second.id)
        val other = PushRules.notice(mapOf("tag" to "", "url" to "https://www.jcsistema.online/?notificacao=2"), home)
        val another = PushRules.notice(mapOf("tag" to "", "url" to "https://www.jcsistema.online/?notificacao=3"), home)
        assertNotEquals(other.id, another.id)
    }

    @Test
    fun appSemFirebaseNaoLigaOsAvisos() {
        assertTrue(PushRules.configured("1:2:android:3", "AIza", "jc-sistema", "123"))
        assertFalse(PushRules.configured("", "AIza", "jc-sistema", "123"))
        assertFalse(PushRules.configured("1:2:android:3", " ", "jc-sistema", "123"))
    }
}
