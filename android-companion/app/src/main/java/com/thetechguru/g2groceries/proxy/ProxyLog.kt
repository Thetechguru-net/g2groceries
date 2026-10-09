package com.thetechguru.g2groceries.proxy

import android.util.Log
import java.text.SimpleDateFormat
import java.util.ArrayDeque
import java.util.Date
import java.util.Locale

/**
 * Diagnostic log: every line goes to Logcat (tag "G2GroceriesProxy") and the
 * most recent lines are kept in memory so the Even app can show them via the
 * `log` route. Never log credentials.
 */
internal object ProxyLog {
    private const val TAG = "G2GroceriesProxy"
    private const val MAX_LINES = 300
    private val lines = ArrayDeque<String>()
    private val format = SimpleDateFormat("HH:mm:ss.SSS", Locale.US)

    fun i(message: String) = write("INFO ", message) { Log.i(TAG, it) }
    fun w(message: String) = write("WARN ", message) { Log.w(TAG, it) }
    fun e(message: String, err: Throwable? = null) = write("ERROR", message) { Log.e(TAG, it, err) }

    @Synchronized
    fun lines(): List<String> = lines.toList()

    @Synchronized
    private fun write(level: String, message: String, logcat: (String) -> Unit) {
        logcat(message)
        lines.addLast("${format.format(Date())} $level $message")
        while (lines.size > MAX_LINES) lines.removeFirst()
    }
}
