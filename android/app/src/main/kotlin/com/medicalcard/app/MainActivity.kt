package com.medicalcard.app

import android.Manifest
import android.annotation.SuppressLint
import android.app.AlertDialog
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothManager
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.util.Base64
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.JsPromptResult
import android.webkit.JsResult
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.EditText
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONObject

/**
 * Hosts the Medical Card web app (bundled in assets/, served from https://appassets.androidplatform.net)
 * in a locked-down WebView. Patient data is never stored by this app: all reads/writes go to Supabase
 * through the page's existing RPC wrappers.
 */
class MainActivity : ComponentActivity() {

    private lateinit var webView: WebView
    private var reply: JavaScriptReplyProxy? = null
    private var bt: BtSerial? = null
    private var afterPermission: (() -> Unit)? = null

    private val permissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            val next = afterPermission; afterPermission = null
            if (granted) next?.invoke() else emit(JSONObject().put("ev", "pick_failed")
                .put("error", "Bluetooth permission was denied. Allow \"Nearby devices\" for this app in Android settings."))
        }

    @Suppress("DEPRECATION")
    @SuppressLint("SetJavaScriptEnabled") // required: the app IS a JavaScript web app; origin is locked below
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Medical data: block screenshots, screen recording and the recents-screen thumbnail.
        window.setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE)
        WindowCompat.setDecorFitsSystemWindows(window, false)

        val assetLoader = WebViewAssetLoader.Builder()
            .setDomain(HOST)
            .addPathHandler("/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        webView = WebView(this).apply {
            layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
            setBackgroundColor(getColor(R.color.window_bg))
            settings.apply {
                javaScriptEnabled = true
                domStorageEnabled = true                       // sessionStorage (auth session) + localStorage (theme)
                allowFileAccess = false
                allowContentAccess = false
                allowFileAccessFromFileURLs = false
                allowUniversalAccessFromFileURLs = false
                mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
                javaScriptCanOpenWindowsAutomatically = false
                setSupportMultipleWindows(false)
                setGeolocationEnabled(false)
                saveFormData = false
                cacheMode = WebSettings.LOAD_NO_CACHE          // do not keep API responses (patient data) in the HTTP cache
                safeBrowsingEnabled = true
            }
            ViewCompat.setOnApplyWindowInsetsListener(this) { v, insets ->
                val i = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.ime())
                v.setPadding(i.left, i.top, i.right, i.bottom)
                WindowInsetsCompat.CONSUMED
            }
            webViewClient = object : WebViewClient() {
                override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                    assetLoader.shouldInterceptRequest(request.url)

                // Only the bundled app may load in this WebView. Any other https link opens in the system browser.
                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                    val u = request.url
                    if (u.scheme == "https" && u.host == HOST) return false
                    if (u.scheme == "https") openExternal(u)
                    return true
                }

                override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                    Toast.makeText(this@MainActivity, "The app view stopped unexpectedly. Please reopen the app.", Toast.LENGTH_LONG).show()
                    finish(); return true
                }
            }
            webChromeClient = dialogsChromeClient()
        }
        setContentView(webView)

        val adapter = getSystemService(BluetoothManager::class.java)?.adapter
        if (adapter != null) {
            bt = BtSerial(adapter,
                onData = { bytes -> emit(JSONObject().put("ev", "data").put("b64", Base64.encodeToString(bytes, Base64.NO_WRAP))) },
                onLost = { msg -> emit(JSONObject().put("ev", "closed").put("error", msg)) })
        }

        // The native bridge exists ONLY for the app's own origin and only in the main frame.
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            WebViewCompat.addWebMessageListener(webView, "McNative", setOf("https://$HOST"),
                WebViewCompat.WebMessageListener { _, message, _, isMainFrame, proxy ->
                    if (isMainFrame) { reply = proxy; handleMessage(message) }
                })
        } // else: no bridge -> the page falls back to manual 10-digit code entry

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (webView.canGoBack()) { webView.goBack(); return }
                AlertDialog.Builder(this@MainActivity)
                    .setMessage("Exit the app? Any unsaved changes will be lost.")
                    .setPositiveButton("Exit") { _, _ -> finish() }
                    .setNegativeButton("Stay", null).show()
            }
        })

        webView.loadUrl("https://$HOST/index.html")
    }

    // ---- bridge ---------------------------------------------------------------------------------------------
    private fun emit(o: JSONObject) {
        val s = o.toString()
        runOnUiThread { reply?.postMessage(s) }
    }

    private fun handleMessage(m: WebMessageCompat) {
        val o = try { JSONObject(m.data ?: return) } catch (_: Exception) { return }
        when (o.optString("op")) {
            "pick" -> ensureBluetoothConnectPermission { showDevicePicker() }
            "open" -> ensureBluetoothConnectPermission { openDevice(o.optString("address")) }
            "write" -> {
                val b64 = o.optString("b64")
                if (b64.length <= 8192) try { bt?.write(Base64.decode(b64, Base64.DEFAULT)) } catch (_: IllegalArgumentException) {}
            }
            "close" -> bt?.close()
        }
    }

    private fun ensureBluetoothConnectPermission(then: () -> Unit) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S ||
            checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED) { then(); return }
        afterPermission = then
        permissionLauncher.launch(Manifest.permission.BLUETOOTH_CONNECT)
    }

    @SuppressLint("MissingPermission")
    private fun pairedDevices(): List<BluetoothDevice>? {
        val adapter = getSystemService(BluetoothManager::class.java)?.adapter ?: return null
        if (!adapter.isEnabled) return null
        return try { adapter.bondedDevices.toList() } catch (_: SecurityException) { null }
    }

    @SuppressLint("MissingPermission")
    private fun showDevicePicker() = runOnUiThread {
        val devices = pairedDevices()
        if (devices == null) {
            emit(JSONObject().put("ev", "pick_failed").put("error", "Bluetooth is off or unavailable. Turn it on, then try again."))
            return@runOnUiThread
        }
        if (devices.isEmpty()) {
            AlertDialog.Builder(this)
                .setTitle("No paired Bluetooth devices")
                .setMessage("Pair the HC-05 reader first in Android Bluetooth settings (the PIN is usually 1234 or 0000), then connect again.")
                .setPositiveButton("Bluetooth settings") { _, _ ->
                    try { startActivity(Intent(Settings.ACTION_BLUETOOTH_SETTINGS)) } catch (_: ActivityNotFoundException) {}
                }
                .setNegativeButton("Cancel", null)
                .setOnDismissListener { emit(JSONObject().put("ev", "pick_cancelled")) }
                .show()
            return@runOnUiThread
        }
        var chosen = false
        val labels = devices.map { "${it.name ?: "Unnamed device"}\n${it.address}" }.toTypedArray()
        AlertDialog.Builder(this)
            .setTitle("Select the RFID reader")
            .setItems(labels) { _, which ->
                chosen = true
                emit(JSONObject().put("ev", "picked").put("address", devices[which].address).put("name", devices[which].name ?: ""))
            }
            .setOnDismissListener { if (!chosen) emit(JSONObject().put("ev", "pick_cancelled")) }
            .show()
    }

    private fun openDevice(address: String) {
        // Never trust the page: only connect to a device that is actually paired on this phone.
        val device = pairedDevices()?.firstOrNull { it.address.equals(address, ignoreCase = true) }
        val adapter = getSystemService(BluetoothManager::class.java)?.adapter
        if (device == null || adapter == null || bt == null) {
            emit(JSONObject().put("ev", "open_failed").put("error", "That device is not paired with this phone."))
            return
        }
        bt!!.connect(device) { err ->
            emit(if (err == null) JSONObject().put("ev", "opened") else JSONObject().put("ev", "open_failed").put("error", err))
        }
    }

    // ---- misc -----------------------------------------------------------------------------------------------
    private fun openExternal(u: Uri) {
        try { startActivity(Intent(Intent.ACTION_VIEW, u).addCategory(Intent.CATEGORY_BROWSABLE)) }
        catch (_: ActivityNotFoundException) { Toast.makeText(this, "No app can open this link.", Toast.LENGTH_SHORT).show() }
    }

    /** The site uses window.alert/confirm/prompt (e.g. typed-name confirmation before deleting a profile). */
    private fun dialogsChromeClient() = object : WebChromeClient() {
        override fun onJsAlert(view: WebView, url: String?, message: String?, result: JsResult): Boolean {
            AlertDialog.Builder(this@MainActivity).setMessage(message)
                .setPositiveButton(android.R.string.ok) { _, _ -> result.confirm() }
                .setOnCancelListener { result.confirm() }.show()
            return true
        }

        override fun onJsConfirm(view: WebView, url: String?, message: String?, result: JsResult): Boolean {
            AlertDialog.Builder(this@MainActivity).setMessage(message)
                .setPositiveButton(android.R.string.ok) { _, _ -> result.confirm() }
                .setNegativeButton(android.R.string.cancel) { _, _ -> result.cancel() }
                .setOnCancelListener { result.cancel() }.show()
            return true
        }

        override fun onJsPrompt(view: WebView, url: String?, message: String?, defaultValue: String?, result: JsPromptResult): Boolean {
            val input = EditText(this@MainActivity).apply { setText(defaultValue ?: ""); setSingleLine(false); setSelectAllOnFocus(true) }
            AlertDialog.Builder(this@MainActivity).setMessage(message).setView(input)
                .setPositiveButton(android.R.string.ok) { _, _ -> result.confirm(input.text.toString()) }
                .setNegativeButton(android.R.string.cancel) { _, _ -> result.cancel() }
                .setOnCancelListener { result.cancel() }.show()
            return true
        }
    }

    override fun onDestroy() {
        bt?.close()
        reply = null
        webView.apply { loadUrl("about:blank"); clearHistory(); clearCache(true); removeAllViews(); destroy() }
        super.onDestroy()
    }

    companion object {
        private const val HOST = "appassets.androidplatform.net"
    }
}
