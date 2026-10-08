package br.com.jcsistema.campo

/**
 * Regras puras dos avisos que chegam pelo Firebase (testadas em PushRulesTest):
 *  - o servidor manda só dados (title, body, url, tag); faltando algo, vale o padrão;
 *  - o toque só abre página do próprio sistema (link de outro site cai na página inicial);
 *  - avisos com a mesma etiqueta (ex.: "5 abastecimentos aguardando") substituem o anterior.
 */
object PushRules {
    data class Notice(val title: String, val body: String, val url: String, val id: Int)

    fun notice(data: Map<String, String>, home: String): Notice {
        val title = data["title"]?.trim().orEmpty().ifEmpty { "JC Sistema" }.take(120)
        val body = data["body"]?.trim().orEmpty().take(600)
        val url = data["url"]?.trim()?.takeIf { AppLinks.isSite(it) } ?: home
        val tag = data["tag"]?.trim().orEmpty()
        return Notice(title, body, url, notificationId(tag, url))
    }

    /** Mesmo número = o Android troca o aviso anterior pelo novo. Sem etiqueta, cada aviso é um. */
    fun notificationId(tag: String, url: String): Int = (if (tag.isNotEmpty()) "tag:$tag" else "url:$url").hashCode() and 0x7fffffff

    /** Valor de BuildConfig que veio vazio (app sem Firebase) desliga os avisos no celular. */
    fun configured(vararg values: String): Boolean = values.all { it.isNotBlank() }
}
