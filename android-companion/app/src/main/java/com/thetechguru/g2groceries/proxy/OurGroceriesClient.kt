package com.thetechguru.g2groceries.proxy

import okhttp3.Cookie
import okhttp3.CookieJar
import okhttp3.FormBody
import okhttp3.HttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import fi.iki.elonen.NanoHTTPD
import org.json.JSONArray
import org.json.JSONObject
import org.jsoup.Jsoup
import java.io.IOException
import java.util.concurrent.TimeUnit

internal class OurGroceriesClient(
    private val email: String,
    private val password: String,
) {
    private val cookieJar = MemoryCookieJar()
    private val http = OkHttpClient.Builder()
        .cookieJar(cookieJar)
        .followRedirects(true)
        .callTimeout(20, TimeUnit.SECONDS)
        .build()
    private var teamId: String? = null
    private var categoryListId: String? = null

    @Synchronized
    fun login() {
        if (cookieJar.hasSession()) return
        ProxyLog.i("Signing in to OurGroceries")
        try {
            var form = loginForm(get("$BASE_URL/sign-in"))
            form["emailAddress"] = email
            form["action"] = form["action"] ?: "email-address"
            form = loginForm(postForm("$BASE_URL/sign-in", form))
            form["emailAddress"] = email
            form["password"] = password
            form["action"] = form["action"]?.lowercase()?.replace(Regex("\\s+"), "-") ?: "sign-in"
            postForm("$BASE_URL/sign-in", form)
            if (!cookieJar.hasSession()) throw AuthenticationException("Invalid email or password")
            readMetadata()
            ProxyLog.i("Signed in")
        } catch (err: AuthenticationException) {
            cookieJar.clear()
            ProxyLog.w("Sign-in rejected: ${err.message}")
            throw err
        } catch (err: Exception) {
            cookieJar.clear()
            ProxyLog.e("Sign-in failed: ${err.message}", err)
            throw OurGroceriesException("OurGroceries sign-in failed: ${err.message}")
        }
    }

    @Synchronized
    fun getLists(): JSONArray = withSession {
        val overview = command("getOverview")
        val source = overview.optJSONArray("shoppingLists") ?: JSONArray()
        JSONArray().apply {
            for (index in 0 until source.length()) {
                val summary = source.optJSONObject(index) ?: continue
                val id = summary.optString("id")
                val detail = command("getList", JSONObject().put("listId", id))
                val list = detail.optJSONObject("list") ?: JSONObject()
                val items = list.optJSONArray("items") ?: JSONArray()
                var active = 0
                for (i in 0 until items.length()) {
                    if (items.optJSONObject(i)?.optBoolean("crossedOff", false) == false) active++
                }
                put(JSONObject().put("id", id).put("name", summary.optString("name")).put("activeCount", active))
            }
        }
    }

    @Synchronized
    fun getList(listId: String): JSONObject = withSession {
        val response = command("getList", JSONObject().put("listId", listId))
        val list = response.optJSONObject("list") ?: JSONObject()
        val categories = getCategories()
        val rawItems = list.optJSONArray("items") ?: JSONArray()
        val activeItems = JSONArray()
        for (index in 0 until rawItems.length()) {
            val item = rawItems.optJSONObject(index) ?: continue
            if (item.optBoolean("crossedOff", false)) continue
            activeItems.put(
                JSONObject()
                    .put("id", item.optString("id"))
                    .put("value", item.optString("value"))
                    .putIfPresent("categoryId", item.optString("categoryId").takeIf(String::isNotBlank))
                    .put("crossedOff", false)
                    .putIfPresent("note", item.optString("note").takeIf(String::isNotBlank)),
            )
        }
        JSONObject()
            .put("id", listId)
            .put("name", list.optString("name"))
            .put("categories", categories)
            .put("items", activeItems)
    }

    @Synchronized
    fun toggle(listId: String, itemId: String, crossedOff: Boolean) = withSession {
        command(
            "setItemCrossedOff",
            JSONObject().put("listId", listId).put("itemId", itemId).put("crossedOff", crossedOff),
        )
    }

    @Synchronized
    fun clearCrossedOff(listId: String) = withSession {
        command("deleteAllCrossedOffItems", JSONObject().put("listId", listId))
    }

    private inline fun <T> withSession(block: () -> T): T {
        login()
        return try {
            block()
        } catch (err: AuthenticationException) {
            throw err
        } catch (first: Exception) {
            ProxyLog.w("Request failed, signing in again and retrying: ${first.message}")
            cookieJar.clear()
            login()
            try {
                block()
            } catch (err: Exception) {
                ProxyLog.e("Retry failed: ${err.message}", err)
                throw OurGroceriesException("OurGroceries request failed: ${err.message}")
            }
        }
    }

    private fun readMetadata() {
        val html = get("$BASE_URL/your-lists/")
        val teamMatch = Regex("""g_teamId\s*=\s*"([^"]+)";""").find(html)
            ?: throw IOException("team metadata missing")
        teamId = teamMatch.groupValues[1]
        val metaMatch = Regex("""g_staticMetalist\s*=\s*(\[.*?]);""", RegexOption.DOT_MATCHES_ALL)
            .find(html) ?: throw IOException("category metadata missing")
        val metadata = JSONArray(metaMatch.groupValues[1])
        categoryListId = (0 until metadata.length())
            .mapNotNull { metadata.optJSONObject(it) }
            .firstOrNull { it.optString("listType") == "CATEGORY" }
            ?.optString("id")
            ?: throw IOException("category list metadata missing")
    }

    private fun getCategories(): JSONArray {
        val response = command("getList", JSONObject().put("listId", categoryListId))
        val raw = response.optJSONObject("list")?.optJSONArray("items") ?: JSONArray()
        return JSONArray().apply {
            for (index in 0 until raw.length()) {
                val item = raw.optJSONObject(index) ?: continue
                put(JSONObject().put("id", item.optString("id")).put("name", item.optString("value")))
            }
        }
    }

    private fun command(name: String, extra: JSONObject = JSONObject()): JSONObject {
        val payload = JSONObject().put("command", name)
        teamId?.let { payload.put("teamId", it) }
        extra.keys().forEach { key -> payload.put(key, extra.get(key)) }
        val request = Request.Builder()
            .url("$BASE_URL/your-lists/")
            .post(payload.toString().toRequestBody(JSON_MEDIA_TYPE))
            .header("Accept", "application/json")
            .header("User-Agent", USER_AGENT)
            .build()
        val started = System.currentTimeMillis()
        http.newCall(request).execute().use { response ->
            val body = response.body?.string().orEmpty()
            val elapsed = System.currentTimeMillis() - started
            if (!response.isSuccessful) {
                ProxyLog.w("$name -> HTTP ${response.code} in $elapsed ms")
                throw IOException("OurGroceries returned HTTP ${response.code}")
            }
            ProxyLog.i("$name -> HTTP ${response.code}, ${body.length} bytes in $elapsed ms")
            // Some commands (e.g. deleteAllCrossedOffItems) succeed with an empty body.
            if (body.isBlank()) return JSONObject()
            return try {
                JSONObject(body)
            } catch (err: org.json.JSONException) {
                ProxyLog.w("$name returned non-JSON: ${body.take(200)}")
                throw IOException("OurGroceries returned an unexpected response to $name")
            }
        }
    }

    private fun get(url: String): String {
        val request = Request.Builder().url(url).header("User-Agent", USER_AGENT).build()
        http.newCall(request).execute().use { response ->
            if (!response.isSuccessful) throw IOException("OurGroceries returned HTTP ${response.code}")
            return response.body?.string().orEmpty()
        }
    }

    private fun postForm(url: String, values: Map<String, String>): String {
        val form = FormBody.Builder().apply { values.forEach { (key, value) -> add(key, value) } }.build()
        val request = Request.Builder()
            .url(url)
            .post(form)
            .header("User-Agent", USER_AGENT)
            .header("Referer", "$BASE_URL/sign-in")
            .build()
        http.newCall(request).execute().use { response ->
            if (!response.isSuccessful) {
                if (response.code == 401 || response.code == 403) {
                    throw AuthenticationException("Invalid email or password")
                }
                throw IOException("OurGroceries sign-in returned HTTP ${response.code}")
            }
            return response.body?.string().orEmpty()
        }
    }

    private fun loginForm(html: String): MutableMap<String, String> {
        val form = Jsoup.parse(html).selectFirst("form[action=/sign-in]")
            ?: Jsoup.parse(html).selectFirst("form")
            ?: throw AuthenticationException("OurGroceries sign-in form not found")
        val result = linkedMapOf<String, String>()
        form.select("input[name]").forEach { input ->
            val name = input.attr("name")
            val type = input.attr("type").lowercase()
            if (type != "checkbox" && type != "radio" || input.hasAttr("checked")) {
                result[name] = input.attr("value").ifEmpty {
                    if (type == "checkbox" || type == "radio") "on" else ""
                }
            }
        }
        form.select("button[name]").forEach { button ->
            val type = button.attr("type").lowercase()
            if (type.isEmpty() || type == "submit") {
                result[button.attr("name")] = button.attr("value").ifEmpty { button.text().trim() }
            }
        }
        if (result.containsKey("locale") && result["locale"].isNullOrEmpty()) result["locale"] = "en-US"
        if (result.containsKey("localeInput") && result["localeInput"].isNullOrEmpty()) {
            result["localeInput"] = "en-US"
        }
        return result
    }

    private class MemoryCookieJar : CookieJar {
        private val cookies = mutableMapOf<String, List<Cookie>>()

        @Synchronized
        override fun saveFromResponse(url: HttpUrl, cookies: List<Cookie>) {
            val current = this.cookies[url.host].orEmpty().associateBy { it.name }.toMutableMap()
            cookies.forEach { cookie ->
                if (cookie.expiresAt < System.currentTimeMillis()) current.remove(cookie.name)
                else current[cookie.name] = cookie
            }
            this.cookies[url.host] = current.values.toList()
        }

        @Synchronized
        override fun loadForRequest(url: HttpUrl): List<Cookie> =
            cookies[url.host].orEmpty().filter { it.expiresAt >= System.currentTimeMillis() }

        @Synchronized
        fun hasSession(): Boolean =
            cookies.values.flatten().any { it.name == SESSION_COOKIE && it.expiresAt >= System.currentTimeMillis() }

        @Synchronized
        fun clear() = cookies.clear()
    }

    companion object {
        private const val BASE_URL = "https://www.ourgroceries.com"
        private const val SESSION_COOKIE = "ourgroceries-auth"
        private const val USER_AGENT =
            "Mozilla/5.0 (compatible; OurGroceriesAndroidProxy/1.0; +https://www.ourgroceries.com)"
        private val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()

        private fun JSONObject.putIfPresent(key: String, value: String?): JSONObject =
            apply { if (value != null) put(key, value) }
    }
}

internal open class OurGroceriesException(
    message: String,
    val status: NanoHTTPD.Response.IStatus = NanoHTTPD.Response.Status.INTERNAL_ERROR,
) : Exception(message)

internal class AuthenticationException(message: String) : OurGroceriesException(
    message,
    NanoHTTPD.Response.Status.UNAUTHORIZED,
)
