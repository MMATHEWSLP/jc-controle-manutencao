package br.com.jcsistema.campo

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class FileNamesTest {
    @Test
    fun nomeDoCabecalhoContentDisposition() {
        assertEquals("ordem-servico-12.pdf", FileNames.fromContentDisposition("inline; filename=\"ordem-servico-12.pdf\""))
        assertEquals("relatório.pdf", FileNames.fromContentDisposition("attachment; filename=\"relatorio.pdf\"; filename*=UTF-8''relat%C3%B3rio.pdf"))
        assertEquals("trocas.xlsx", FileNames.fromContentDisposition("attachment; filename=trocas.xlsx"))
        assertNull(FileNames.fromContentDisposition("inline"))
        assertNull(FileNames.fromContentDisposition(null))
    }

    @Test
    fun nomeFinalLimpoEComExtensao() {
        assertEquals("custos_2026.csv", FileNames.finalName("custos/2026.csv", "text/csv"))
        assertEquals("arquivo-jc-sistema.pdf", FileNames.finalName("arquivo-jc-sistema", "application/pdf"))
        assertEquals("QR-PC-20.png", FileNames.finalName("QR-PC-20.png", "image/png"))
        assertEquals("arquivo", FileNames.finalName("", null))
        assertEquals("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", FileNames.mimeFor("a.xlsx", null))
        assertEquals("application/pdf", FileNames.mimeFor("sem-extensao", "application/pdf; charset=binary"))
    }

    @Test
    fun seletorDeArquivosPeloAccept() {
        assertArrayEquals(arrayOf("*/*"), FileNames.mimeTypesForAccept(emptyList()))
        assertArrayEquals(
            arrayOf("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "application/octet-stream", "application/vnd.ms-excel", "text/csv", "text/comma-separated-values", "application/csv", "text/plain"),
            FileNames.mimeTypesForAccept(listOf(".xlsx,.xls,.csv")),
        )
        assertArrayEquals(arrayOf("*/*"), FileNames.mimeTypesForAccept(listOf(".dwg")))
        assertTrue(FileNames.acceptsOnlyImages(listOf("image/*")))
        assertTrue(FileNames.acceptsOnlyImages(listOf("image/jpeg,image/png,image/webp")))
        assertFalse(FileNames.acceptsOnlyImages(listOf(".xlsx")))
        assertFalse(FileNames.acceptsOnlyImages(emptyList()))
    }
}
