package br.com.jcsistema.campo

import org.json.JSONObject

/** Conteúdo de https://www.jcsistema.online/app/versao.json (publicado pelo workflow "App Android"). */
data class UpdateInfo(
    val versionCode: Int,
    val versionName: String,
    val url: String,
    val notes: String,
    val mandatory: Boolean,
    val sha256: String?,
    val size: Long?,
)

object UpdateRules {
    /** Consulta no máximo a cada 6 horas (a não ser que haja atualização obrigatória pendente). */
    const val CHECK_INTERVAL_MS = 6L * 60 * 60 * 1000

    fun isDue(lastCheckMs: Long, nowMs: Long, intervalMs: Long = CHECK_INTERVAL_MS): Boolean =
        lastCheckMs <= 0 || nowMs < lastCheckMs || nowMs - lastCheckMs >= intervalMs

    fun isNewer(info: UpdateInfo, installedVersionCode: Int): Boolean = info.versionCode > installedVersionCode

    fun parse(json: String): UpdateInfo? = try {
        val data = JSONObject(json)
        val code = data.optInt("versionCode", 0)
        val name = data.optString("versionName", "").trim()
        val url = data.optString("url", "").trim()
        val sha = data.optString("sha256", "").trim().lowercase().takeIf { it.matches(Regex("[0-9a-f]{64}")) }
        val size = data.optLong("tamanho", 0L).takeIf { it > 0 }
        if (code <= 0 || name.isEmpty() || !url.startsWith("https://")) null
        else UpdateInfo(code, name, url, data.optString("notas", "").trim(), data.optBoolean("obrigatoria", false), sha, size)
    } catch (_: Exception) {
        null
    }
}
