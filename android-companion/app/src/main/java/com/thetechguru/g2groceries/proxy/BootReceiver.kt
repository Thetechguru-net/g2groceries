package com.thetechguru.g2groceries.proxy

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** Starts the proxy in the background after the phone boots or this app is updated. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
            Intent.ACTION_BOOT_COMPLETED -> ProxyService.start(context, "phone booted")
            Intent.ACTION_MY_PACKAGE_REPLACED -> ProxyService.start(context, "app updated")
        }
    }
}
