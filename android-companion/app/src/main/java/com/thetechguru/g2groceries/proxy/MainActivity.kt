package com.thetechguru.g2groceries.proxy

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.view.Gravity
import android.view.ViewGroup
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView

class MainActivity : Activity() {
    private lateinit var status: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        requestNotificationPermission()

        val padding = (24 * resources.displayMetrics.density).toInt()
        val layout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(padding, padding, padding, padding)
        }
        status = TextView(this).apply {
            textSize = 18f
            text = "Proxy stopped"
        }
        val start = Button(this).apply {
            text = "Start proxy"
            setOnClickListener {
                startForegroundService(Intent(this@MainActivity, ProxyService::class.java))
                status.text = "Starting on http://127.0.0.1:${ProxyServer.PORT}"
                status.postDelayed({ updateStatus() }, 750)
            }
        }
        val stop = Button(this).apply {
            text = "Stop proxy"
            setOnClickListener {
                stopService(Intent(this@MainActivity, ProxyService::class.java))
                status.text = "Proxy stopped"
            }
        }
        val help = TextView(this).apply {
            text = "\nKeep this service running while using the Even app.\n\n" +
                "In the Even app Server field, use:\nhttp://127.0.0.1:${ProxyServer.PORT}\n\n" +
                "The companion communicates with OurGroceries over HTTPS."
        }
        layout.addView(status, ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
        layout.addView(start)
        layout.addView(stop)
        layout.addView(help, ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
        setContentView(layout)
    }

    override fun onResume() {
        super.onResume()
        updateStatus()
    }

    private fun updateStatus() {
        status.text = if (ProxyService.running) {
            "Proxy running on http://127.0.0.1:${ProxyServer.PORT}"
        } else if (ProxyService.lastError != null) {
            "Proxy failed to start: ${ProxyService.lastError}"
        } else {
            "Proxy stopped"
        }
    }

    private fun requestNotificationPermission() {
        if (Build.VERSION.SDK_INT >= 33 &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
        }
    }
}
