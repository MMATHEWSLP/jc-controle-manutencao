package br.com.jcsistema.campo

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AppLinksTest {
    @Test
    fun paginasDoSistemaAbremDentroDoApp() {
        assertEquals(AppLinks.Target.INTERNAL, AppLinks.classify("https://www.jcsistema.online/"))
        assertEquals(AppLinks.Target.INTERNAL, AppLinks.classify("https://jcsistema.online/app/baixar"))
        assertEquals(AppLinks.Target.INTERNAL, AppLinks.classify("https://WWW.JCSISTEMA.ONLINE/api/maintenance-pdf?id=3"))
        assertEquals(AppLinks.Target.INTERNAL, AppLinks.classify("blob:https://www.jcsistema.online/8a6e"))
        assertEquals(AppLinks.Target.INTERNAL, AppLinks.classify("about:blank"))
    }

    @Test
    fun linksExternosAbremNoAppDoCelular() {
        assertEquals(AppLinks.Target.EXTERNAL, AppLinks.classify("https://wa.me/5588999999999?text=Ol%C3%A1"))
        assertEquals(AppLinks.Target.EXTERNAL, AppLinks.classify("https://api.whatsapp.com/send?phone=5588"))
        assertEquals(AppLinks.Target.EXTERNAL, AppLinks.classify("https://www.google.com/maps?q=-2.44,-54.70"))
        assertEquals(AppLinks.Target.EXTERNAL, AppLinks.classify("tel:+5588999999999"))
        assertEquals(AppLinks.Target.EXTERNAL, AppLinks.classify("mailto:contato@jc.com.br"))
        assertEquals(AppLinks.Target.EXTERNAL, AppLinks.classify("whatsapp://send?text=oi"))
        assertEquals(AppLinks.Target.EXTERNAL, AppLinks.classify("intent://scan/#Intent;scheme=zxing;end"))
        // Domínio parecido não é o sistema.
        assertEquals(AppLinks.Target.EXTERNAL, AppLinks.classify("https://jcsistema.online.golpe.com/"))
        assertEquals(AppLinks.Target.EXTERNAL, AppLinks.classify("https://user@evil.com/www.jcsistema.online"))
    }

    @Test
    fun arquivosLocaisNuncaAbrem() {
        assertEquals(AppLinks.Target.BLOCKED, AppLinks.classify("file:///sdcard/a.html"))
        assertEquals(AppLinks.Target.BLOCKED, AppLinks.classify("content://com.android.providers/1"))
        assertEquals(AppLinks.Target.BLOCKED, AppLinks.classify("sem-esquema"))
    }

    @Test
    fun telaInicial() {
        assertTrue(AppLinks.isHome("https://www.jcsistema.online/"))
        assertTrue(AppLinks.isHome("https://www.jcsistema.online"))
        assertTrue(AppLinks.isHome("https://jcsistema.online/?tela=historico-diario"))
        assertFalse(AppLinks.isHome("https://www.jcsistema.online/equipamento/qr/abc"))
        assertFalse(AppLinks.isHome("https://wa.me/"))
        assertFalse(AppLinks.isHome(null))
    }
}
