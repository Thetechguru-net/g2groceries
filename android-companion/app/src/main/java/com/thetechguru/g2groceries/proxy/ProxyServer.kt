package com.thetechguru.g2groceries.proxy

import fi.iki.elonen.NanoHTTPD
import org.json.JSONObject
import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap

class ProxyServer : NanoHTTPD("127.0.0.1", PORT) {
    // NanoHTTPD gzips text and JSON responses by default, switching them to
    // chunked encoding. On the 204 preflight reply that leaves body bytes on
    // the keep-alive connection, which the WebView then reads as the response
    // to the next request on that socket and fails with "Failed to fetch".
    override fun useGzipWhenAccepted(r: Response): Boolean = false

    override fun serve(session: IHTTPSession): Response {
        val headers = mapOf(
            "Access-Control-Allow-Origin" to "*",
            "Access-Control-Allow-Methods" to "POST, OPTIONS",
            "Access-Control-Allow-Headers" to "Content-Type",
            "Access-Control-Max-Age" to "86400",
        )
        if (session.method == Method.OPTIONS) {
            ProxyLog.i("preflight ${session.uri}")
            return newFixedLengthResponse(Response.Status.NO_CONTENT, MIME_PLAINTEXT, "").withHeaders(headers)
        }
        if (session.method != Method.POST) {
            return jsonError(Response.Status.METHOD_NOT_ALLOWED, "POST only").withHeaders(headers)
        }

        val route = session.uri.removePrefix("/api/")
        if (!session.uri.startsWith("/api/") || route.contains('/')) {
            return jsonError(Response.Status.NOT_FOUND, "Unknown route").withHeaders(headers)
        }

        val started = System.currentTimeMillis()
        val elapsed = { "${System.currentTimeMillis() - started} ms" }
        return try {
            val contentLength = session.headers["content-length"]?.toLongOrNull()
            if (contentLength != null && contentLength > MAX_BODY_BYTES) {
                throw HttpError(Response.Status.PAYLOAD_TOO_LARGE, "Body too large")
            }
            val files = HashMap<String, String>()
            session.parseBody(files)
            val raw = files["postData"] ?: "{}"
            if (raw.toByteArray(Charsets.UTF_8).size > MAX_BODY_BYTES) {
                throw HttpError(Response.Status.PAYLOAD_TOO_LARGE, "Body too large")
            }
            val body = JSONObject(raw)
            val email = body.optString("email").trim()
            val password = body.optString("password")
            if (email.isEmpty() || password.isEmpty()) {
                throw HttpError(Response.Status.BAD_REQUEST, "email and password required")
            }
            val client = clientFor(email, password)
            JSONObject().apply {
                when (route) {
                    "login" -> {
                        client.login()
                        put("ok", true)
                    }
                    "lists" -> put("lists", client.getLists())
                    "log" -> put("lines", org.json.JSONArray(ProxyLog.lines()))
                    "list" -> {
                        val listId = body.optString("listId")
                        if (listId.isBlank()) throw HttpError(Response.Status.BAD_REQUEST, "listId required")
                        val list = client.getList(listId)
                        list.keys().forEach { key -> put(key, list.get(key)) }
                    }
                    "toggle" -> {
                        val listId = body.optString("listId")
                        val itemId = body.optString("itemId")
                        if (listId.isBlank() || itemId.isBlank()) {
                            throw HttpError(Response.Status.BAD_REQUEST, "listId and itemId required")
                        }
                        client.toggle(
                            listId, itemId, body.optBoolean("crossedOff", false),
                        )
                        put("ok", true)
                    }
                    "clear-crossed-off" -> {
                        val listId = body.optString("listId")
                        if (listId.isBlank()) throw HttpError(Response.Status.BAD_REQUEST, "listId required")
                        client.clearCrossedOff(listId)
                        put("ok", true)
                    }
                    else -> throw HttpError(Response.Status.NOT_FOUND, "Unknown route")
                }
            }.toString().let { newFixedLengthResponse(Response.Status.OK, "application/json", it) }
                .withHeaders(headers)
                .also { if (route != "log") ProxyLog.i("/api/$route ${describe(body)} -> 200 in ${elapsed()}") }
        } catch (err: HttpError) {
            ProxyLog.w("/api/$route -> ${err.status.requestStatus} in ${elapsed()}: ${err.message}")
            jsonError(err.status, err.message ?: "Request failed").withHeaders(headers)
        } catch (err: OurGroceriesException) {
            ProxyLog.e("/api/$route -> ${err.status.requestStatus} in ${elapsed()}: ${err.message}")
            jsonError(err.status, err.message ?: "OurGroceries request failed").withHeaders(headers)
        } catch (err: Exception) {
            ProxyLog.e("/api/$route -> 500 in ${elapsed()}: ${err.message}", err)
            jsonError(Response.Status.INTERNAL_ERROR, err.message ?: "Internal error").withHeaders(headers)
        }
    }

    private fun jsonError(status: Response.IStatus, message: String): Response =
        newFixedLengthResponse(
            status,
            "application/json",
            JSONObject().put("error", message).put("auth", status == Response.Status.UNAUTHORIZED).toString(),
        )

    private fun clientFor(email: String, password: String): OurGroceriesClient {
        val key = MessageDigest.getInstance("SHA-256")
            .digest("$email\u0000$password".toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it) }
        return clients.computeIfAbsent(key) { OurGroceriesClient(email, password) }
    }

    /** Request details safe to log (never the credentials). */
    private fun describe(body: JSONObject): String =
        listOf("listId", "itemId", "crossedOff")
            .filter { body.has(it) }
            .joinToString(" ") { "$it=${body.opt(it)}" }

    private fun Response.withHeaders(extra: Map<String, String>): Response = apply {
        extra.forEach { (name, value) -> addHeader(name, value) }
    }

    private class HttpError(val status: Response.IStatus, message: String) : Exception(message)

    companion object {
        const val PORT = 42225
        private const val MAX_BODY_BYTES = 64 * 1024
        private val clients = ConcurrentHashMap<String, OurGroceriesClient>()
    }
}
