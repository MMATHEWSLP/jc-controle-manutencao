package br.com.jcsistema.campo

/**
 * Para onde vai cada link tocado no site (regra pura, testada em AppLinksTest):
 *  - páginas do próprio sistema (www.jcsistema.online / jcsistema.online) abrem dentro do app;
 *  - WhatsApp (wa.me), Google Maps, telefone, e-mail e qualquer outro site abrem no app do celular;
 *  - arquivos locais (file:, content:) nunca são abertos pelo WebView.
 */
object AppLinks {
    val SITE_HOSTS = setOf("www.jcsistema.online", "jcsistema.online")

    enum class Target { INTERNAL, EXTERNAL, BLOCKED }

    private val schemeRegex = Regex("^([a-zA-Z][a-zA-Z0-9+.-]*):")
    private val hostRegex = Regex("^[a-zA-Z][a-zA-Z0-9+.-]*://(?:[^@/?#]*@)?([^/?#:]+)")

    fun scheme(url: String): String = schemeRegex.find(url.trim())?.groupValues?.get(1)?.lowercase() ?: ""

    fun host(url: String): String = hostRegex.find(url.trim())?.groupValues?.get(1)?.lowercase() ?: ""

    fun isSite(url: String): Boolean = scheme(url) in setOf("http", "https") && host(url) in SITE_HOSTS

    fun classify(url: String): Target = when (scheme(url)) {
        "http", "https" -> if (host(url) in SITE_HOSTS) Target.INTERNAL else Target.EXTERNAL
        // Gerados pela própria página (arquivos baixados, janelas de impressão).
        "blob", "data", "about", "javascript" -> Target.INTERNAL
        "file", "content" -> Target.BLOCKED
        "" -> Target.BLOCKED
        // tel:, mailto:, whatsapp:, geo:, intent:, sms:, market: …
        else -> Target.EXTERNAL
    }

    /** Página inicial do sistema (onde o "voltar" pergunta se quer sair). */
    fun isHome(url: String?): Boolean {
        if (url == null || !isSite(url)) return false
        val path = url.trim().replace(hostRegex, "").substringBefore('#').substringBefore('?')
        return path.isEmpty() || path == "/"
    }
}
