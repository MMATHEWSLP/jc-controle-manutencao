package br.com.jcsistema.campo

import java.net.URLDecoder

/** Nomes e tipos dos arquivos baixados/enviados (regras puras, testadas em FileNamesTest). */
object FileNames {
    private val extensionsByMime = mapOf(
        "application/pdf" to "pdf",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" to "xlsx",
        "application/vnd.ms-excel" to "xls",
        "text/csv" to "csv",
        "text/plain" to "txt",
        "image/png" to "png",
        "image/jpeg" to "jpg",
        "image/webp" to "webp",
        "application/zip" to "zip",
    )

    private val mimeByExtension = mapOf(
        "pdf" to "application/pdf",
        "xlsx" to "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "xls" to "application/vnd.ms-excel",
        "csv" to "text/csv",
        "txt" to "text/plain",
        "png" to "image/png",
        "jpg" to "image/jpeg",
        "jpeg" to "image/jpeg",
        "webp" to "image/webp",
        "zip" to "application/zip",
    )

    /** Lê o nome de um cabeçalho Content-Disposition (attachment ou inline; filename* tem prioridade). */
    fun fromContentDisposition(contentDisposition: String?): String? {
        if (contentDisposition.isNullOrBlank()) return null
        Regex("filename\\*\\s*=\\s*(?:UTF-8|utf-8)''([^;]+)").find(contentDisposition)?.let { match ->
            return runCatching { URLDecoder.decode(match.groupValues[1].trim(), "UTF-8") }.getOrNull()?.takeIf { it.isNotBlank() }
        }
        Regex("filename\\s*=\\s*\"([^\"]*)\"").find(contentDisposition)?.let { return it.groupValues[1].takeIf { name -> name.isNotBlank() } }
        Regex("filename\\s*=\\s*([^;]+)").find(contentDisposition)?.let { return it.groupValues[1].trim().takeIf { name -> name.isNotBlank() } }
        return null
    }

    fun sanitize(name: String?): String {
        val cleaned = (name ?: "").replace(Regex("[\\\\/:*?\"<>|\\p{Cntrl}]"), "_").trim().trim('.').take(120)
        return cleaned.ifEmpty { "arquivo" }
    }

    fun extensionOf(name: String): String = name.substringAfterLast('.', "").lowercase().takeIf { it.isNotEmpty() && it.length <= 5 && name.contains('.') } ?: ""

    fun mimeFor(name: String, fallback: String?): String =
        mimeByExtension[extensionOf(name)] ?: fallback?.substringBefore(';')?.trim()?.takeIf { it.isNotEmpty() } ?: "application/octet-stream"

    /** Nome final: limpo e com extensão (pela do nome ou pelo tipo do arquivo). */
    fun finalName(name: String?, mime: String?): String {
        val clean = sanitize(name)
        if (extensionOf(clean).isNotEmpty()) return clean
        val ext = extensionsByMime[mime?.substringBefore(';')?.trim()?.lowercase()] ?: return clean
        return "$clean.$ext"
    }

    /** O que o campo de arquivo do site aceita (atributo accept) → tipos para o seletor do Android. */
    fun mimeTypesForAccept(acceptTypes: List<String>): Array<String> {
        val accepted = acceptTypes.flatMap { it.split(',') }.map { it.trim().lowercase() }.filter { it.isNotEmpty() }
        if (accepted.isEmpty() || accepted.any { it == "*/*" }) return arrayOf("*/*")
        val result = linkedSetOf<String>()
        for (type in accepted) {
            when {
                type.contains('/') -> result += type
                type.startsWith('.') -> {
                    when (val ext = type.removePrefix(".")) {
                        // Planilhas chegam do WhatsApp/Drive com tipos variados: aceita os comuns.
                        "csv" -> result += listOf("text/csv", "text/comma-separated-values", "application/csv", "text/plain")
                        "xlsx", "xls" -> result += listOf(mimeByExtension.getValue(ext), "application/octet-stream")
                        else -> mimeByExtension[ext]?.let { result += it } ?: return arrayOf("*/*")
                    }
                }
            }
        }
        return if (result.isEmpty()) arrayOf("*/*") else result.toTypedArray()
    }

    fun acceptsOnlyImages(acceptTypes: List<String>): Boolean {
        val accepted = acceptTypes.flatMap { it.split(',') }.map { it.trim().lowercase() }.filter { it.isNotEmpty() }
        val imageExtensions = setOf(".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif")
        return accepted.isNotEmpty() && accepted.all { it.startsWith("image/") || it in imageExtensions }
    }
}
