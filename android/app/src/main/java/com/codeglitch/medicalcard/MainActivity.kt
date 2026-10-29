package com.codeglitch.medicalcard

import android.Manifest
import android.app.Activity
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothSocket
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.webkit.JavascriptInterface
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import androidx.webkit.WebViewAssetLoader
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.io.OutputStream
import java.util.UUID
import kotlin.concurrent.thread

class MainActivity : Activity() {
    private lateinit var webView: WebView
    private lateinit var statusPanel: LinearLayout
    private lateinit var statusText: TextView
    private val assetLoader by lazy {
        WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()
    }
    private lateinit var bridge: MedicalCardAndroidBridge

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.statusBarColor = Color.rgb(11, 37, 54)
        window.navigationBarColor = Color.rgb(11, 37, 54)

        val root = FrameLayout(this)
        webView = WebView(this)
        webView.settings.javaScriptEnabled = true
        webView.settings.domStorageEnabled = true
        webView.settings.allowFileAccess = false
        webView.settings.allowContentAccess = false
        webView.settings.javaScriptCanOpenWindowsAutomatically = false
        webView.settings.setSupportMultipleWindows(false)
        webView.settings.mixedContentMode = android.webkit.WebSettings.MIXED_CONTENT_NEVER_ALLOW
        webView.setBackgroundColor(Color.WHITE)
        bridge = MedicalCardAndroidBridge(this)
        webView.addJavascriptInterface(bridge, "MedicalCardAndroid")

        val statusContainer = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setPadding(28, 28, 28, 28)
            setBackgroundColor(Color.rgb(247, 250, 252))
        }
        val spinner = ProgressBar(this)
        statusText = TextView(this).apply {
            text = "Opening Medical Card…"
            textSize = 17f
            setTextColor(Color.rgb(17, 46, 61))
            gravity = Gravity.CENTER
            setPadding(0, 18, 0, 18)
        }
        val retry = Button(this).apply {
            text = "Reload"
            visibility = View.GONE
        }
        retry.setOnClickListener {
            retry.visibility = View.GONE
            statusText.text = "Reconnecting…"
            webView.reload()
        }
        statusContainer.addView(spinner)
        statusContainer.addView(statusText)
        statusContainer.addView(retry)
        statusPanel = statusContainer
        root.addView(webView, FrameLayout.LayoutParams(-1, -1))
        root.addView(statusPanel, FrameLayout.LayoutParams(-1, -1))
        setContentView(root)

        webView.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView?, request: WebResourceRequest?) =
                request?.let { assetLoader.shouldInterceptRequest(it.url) }

            override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
                val uri = request?.url ?: return true
                if (uri.scheme == "https" && uri.host == "appassets.androidplatform.net") return false
                // Keep the app's privileged WebView on bundled content only. Open external HTTPS
                // links in the system browser instead of navigating the JavaScript bridge away.
                if (uri.scheme == "https" || uri.scheme == "mailto" || uri.scheme == "tel") {
                    return try {
                        startActivity(Intent(Intent.ACTION_VIEW, uri))
                        true
                    } catch (_: Exception) { true }
                }
                return true
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                super.onPageFinished(view, url)
                statusPanel.visibility = View.GONE
            }

            override fun onReceivedError(view: WebView?, request: WebResourceRequest?, error: WebResourceError?) {
                super.onReceivedError(view, request, error)
                if (request?.isForMainFrame == true) {
                    statusText.text = "Medical Card could not load. Check your internet connection, then reload."
                    statusPanel.visibility = View.VISIBLE
                    if (statusPanel.childCount >= 3) statusPanel.getChildAt(2).visibility = View.VISIBLE
                }
            }
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S &&
            checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.BLUETOOTH_CONNECT), 4102)
        }
        webView.loadUrl("https://appassets.androidplatform.net/assets/www/index.html")
    }

    override fun onBackPressed() {
        if (::webView.isInitialized && webView.canGoBack()) webView.goBack() else super.onBackPressed()
    }

    override fun onDestroy() {
        if (::bridge.isInitialized) bridge.disconnect()
        if (::webView.isInitialized) {
            webView.removeJavascriptInterface("MedicalCardAndroid")
            webView.stopLoading()
            webView.destroy()
        }
        super.onDestroy()
    }
}

class MedicalCardAndroidBridge(private val activity: Activity) {
    private val lock = Any()
    @Volatile private var state: String = "disconnected"
    @Volatile private var lastError: String = ""
    @Volatile private var socket: BluetoothSocket? = null
    @Volatile private var pendingSocket: BluetoothSocket? = null
    @Volatile private var output: OutputStream? = null
    @Volatile private var input: InputStream? = null
    private val queue = ByteArrayOutputStream()
    private val sppUuid: UUID = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB")

    @JavascriptInterface
    fun getPairedDevices(): String {
        val adapter = BluetoothAdapter.getDefaultAdapter()
            ?: return JSONObject().put("error", "This device does not support Bluetooth.").toString()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S &&
            activity.checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) != PackageManager.PERMISSION_GRANTED) {
            return JSONObject().put("error", "Bluetooth permission is not granted. Allow Nearby devices permission in Android Settings.").toString()
        }
        return try {
            val result = JSONArray()
            if (!adapter.isEnabled) {
                return JSONObject().put("error", "Turn on Bluetooth in Android Settings, then pair the HC-05 before connecting.").toString()
            }
            adapter.bondedDevices.sortedBy { it.name ?: it.address }.forEach { device: BluetoothDevice ->
                result.put(JSONObject().put("name", device.name ?: "Bluetooth device").put("address", device.address))
            }
            result.toString()
        } catch (e: Exception) {
            JSONObject().put("error", "Could not list paired Bluetooth devices: ${safeMessage(e)}").toString()
        }
    }

    @JavascriptInterface
    fun beginConnect(address: String, baudRate: Int): String {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S &&
            activity.checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) != PackageManager.PERMISSION_GRANTED) {
            state = "error"
            lastError = "Bluetooth permission is not granted."
            return "error:$lastError"
        }
        if (address.length > 64 || !address.matches(Regex("(?i)[0-9a-f]{2}(:[0-9a-f]{2}){5}"))) {
            state = "error"
            lastError = "Invalid Bluetooth device address."
            return "error:$lastError"
        }
        disconnect()
        state = "connecting"
        lastError = ""
        thread(name = "MedicalCard-BluetoothConnect") {
            var candidateSocket: BluetoothSocket? = null
            try {
                val adapter = BluetoothAdapter.getDefaultAdapter() ?: throw IllegalStateException("Bluetooth is unavailable.")
                val device = adapter.getRemoteDevice(address)
                val created = device.createRfcommSocketToServiceRecord(sppUuid)
                candidateSocket = created
                synchronized(lock) { pendingSocket = created }
                created.connect()
                val shouldRead = synchronized(lock) {
                    if (state != "connecting") {
                        pendingSocket = null
                        false
                    } else {
                        socket = created
                        pendingSocket = null
                        input = created.inputStream
                        output = created.outputStream
                        queue.reset()
                        state = "connected"
                        true
                    }
                }
                if (!shouldRead) {
                    try { created.close() } catch (_: Exception) {}
                    return@thread
                }
                readLoop(created, created.inputStream)
            } catch (e: Exception) {
                try { candidateSocket?.close() } catch (_: Exception) {}
                synchronized(lock) {
                    pendingSocket = null
                    if (state != "disconnected") {
                        lastError = safeMessage(e)
                        state = "error"
                    }
                    try { socket?.close() } catch (_: Exception) {}
                    socket = null
                    input = null
                    output = null
                }
            }
        }
        return "connecting"
    }

    @JavascriptInterface
    fun getConnectionStatus(): String = when (state) {
        "error" -> "error:${lastError.ifBlank { "Bluetooth connection failed." }}"
        else -> state
    }

    @JavascriptInterface
    fun readChunk(): String {
        val statusNow = when (state) { "error" -> "error"; "connected" -> "connected"; else -> "disconnected" }
        val bytes = synchronized(lock) {
            val all = queue.toByteArray()
            if (all.isNotEmpty()) queue.reset()
            all
        }
        val payload = if (bytes.isNotEmpty()) android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP) else ""
        return JSONObject().put("status", statusNow).put("data", payload).toString()
    }

    @JavascriptInterface
    fun writeData(base64: String): Boolean {
        return try {
            if (base64.length > 16384) return false
            val bytes = android.util.Base64.decode(base64, android.util.Base64.DEFAULT)
            synchronized(lock) {
                val stream = output ?: return false
                stream.write(bytes)
                stream.flush()
            }
            true
        } catch (_: Exception) { false }
    }

    @JavascriptInterface
    fun disconnect() {
        synchronized(lock) {
            state = "disconnected"
            try { input?.close() } catch (_: Exception) {}
            try { output?.close() } catch (_: Exception) {}
            try { socket?.close() } catch (_: Exception) {}
            try { pendingSocket?.close() } catch (_: Exception) {}
            input = null
            output = null
            socket = null
            pendingSocket = null
            queue.reset()
        }
    }

    private fun readLoop(activeSocket: BluetoothSocket, source: InputStream) {
        val chunk = ByteArray(1024)
        try {
            while (state == "connected" && activeSocket.isConnected) {
                val count = source.read(chunk)
                if (count < 0) break
                synchronized(lock) {
                    val existing = queue.toByteArray()
                    queue.reset()
                    // Keep the newest 64 KiB if the UI is not consuming quickly enough.
                    if (existing.size + count > 65536) {
                        val keepFrom = (existing.size + count) - 65536
                        if (keepFrom < existing.size) queue.write(existing, keepFrom, existing.size - keepFrom)
                        val remaining = 65536 - queue.size()
                        if (remaining > 0) queue.write(chunk, maxOf(0, count - remaining), minOf(count, remaining))
                    } else {
                        queue.write(existing)
                        queue.write(chunk, 0, count)
                    }
                }
            }
        } catch (e: Exception) {
            if (state == "connected") {
                lastError = safeMessage(e)
                state = "error"
            }
        } finally {
            if (socket === activeSocket && state != "disconnected") {
                try { activeSocket.close() } catch (_: Exception) {}
                socket = null
                input = null
                output = null
                if (state != "error") state = "disconnected"
            }
        }
    }

    private fun safeMessage(error: Exception): String {
        val raw = error.message.orEmpty().replace(Regex("[\\r\\n]+"), " ").take(180)
        return if (raw.isBlank()) "Connection failed. Check Bluetooth pairing and range." else raw
    }
}
