package br.com.jcsistema.campo

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class UpdateRulesTest {
    private val json = """{"versionCode":10001,"versionName":"1.0.1","url":"https://www.jcsistema.online/app/jc-sistema.apk?v=10001","notas":"Correções","obrigatoria":false,"sha256":"${"a".repeat(64)}","tamanho":4200000}"""

    @Test
    fun leOVersaoJsonPublicado() {
        val info = UpdateRules.parse(json)!!
        assertEquals(10001, info.versionCode)
        assertEquals("1.0.1", info.versionName)
        assertEquals("Correções", info.notes)
        assertFalse(info.mandatory)
        assertEquals("a".repeat(64), info.sha256)
        assertEquals(4_200_000L, info.size)
        assertTrue(UpdateRules.parse(json.replace("\"obrigatoria\":false", "\"obrigatoria\":true"))!!.mandatory)
    }

    @Test
    fun recusaVersaoJsonInvalido() {
        assertNull(UpdateRules.parse("não é json"))
        assertNull(UpdateRules.parse(json.replace("https://", "http://")))
        assertNull(UpdateRules.parse(json.replace("10001", "0")))
        assertNull(UpdateRules.parse("""{"versionCode":10001,"url":"https://x/a.apk"}"""))
        assertNull(UpdateRules.parse(json.replace("a".repeat(64), "xyz"))!!.sha256)
    }

    @Test
    fun ofereceSoVersaoMaior() {
        val info = UpdateRules.parse(json)!!
        assertTrue(UpdateRules.isNewer(info, 10000))
        assertFalse(UpdateRules.isNewer(info, 10001))
        assertFalse(UpdateRules.isNewer(info, 10100))
    }

    @Test
    fun consultaNoMaximoACada6Horas() {
        val hora = 60L * 60 * 1000
        assertTrue(UpdateRules.isDue(0, 1_000))
        assertFalse(UpdateRules.isDue(10 * hora, 15 * hora))
        assertTrue(UpdateRules.isDue(10 * hora, 16 * hora))
        assertTrue(UpdateRules.isDue(10 * hora, 9 * hora), "relógio voltou: consulta")
    }

    private fun assertTrue(condition: Boolean, message: String) = org.junit.Assert.assertTrue(message, condition)
}
