package com.medicalcard.app

import android.Manifest
import android.annotation.SuppressLint
import android.app.AlertDialog
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothManager
import android.content.ActivityNotFoundException
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.util.Base64
import android.util.Log
import android.view.Gravity
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
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.net.SocketTimeoutException
import java.net.URL
import java.util.concurrent.Executors
import javax.net.ssl.HttpsURLConnection

/**
 * Hosts the MedVault Secure Medical Records web app (bundled in assets/, served from https://appassets.androidplatform.net)
 * in a locked-down WebView. Patient data is never stored by this app: all reads/writes go to Supabase
 * through the page's existing RPC wrappers.
 */
class MainActivity : ComponentActivity() {

    private lateinit var webView: WebView
    private var reply: JavaScriptReplyProxy? = null
    private var bt: BtSerial? = null
    private var afterPermission: (() -> Unit)? = null

    private var progress: AlertDialog? = null
    private val edgeExecutor = Executors.newFixedThreadPool(2) { r -> Thread(r, "edge-https").apply { isDaemon = true } }
    private val prefs by lazy { getSharedPreferences("bt_prefs", MODE_PRIVATE) }

    private val permissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            val next = afterPermission; afterPermission = null
            if (granted) { next?.invoke(); return@registerForActivityResult }
            // Denied. If Android will no longer show the system prompt, only the app settings can fix it.
            val permanent = !shouldShowRequestPermissionRationale(Manifest.permission.BLUETOOTH_CONNECT)
            showPermissionDenied(permanent, next)
        }

    private val enableBluetoothLauncher =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) {
            val next = afterEnable; afterEnable = null
            if (btAdapter()?.isEnabled == true) next?.invoke()
            else pickFailed("Bluetooth is still off. Turn it on, then try again.")
        }
    private var afterEnable: (() -> Unit)? = null

    /** Android tells us when the link drops or Bluetooth is switched off, faster than a socket read fails. */
    private var btReceiverRegistered = false
    /** Registered only when the user first uses Bluetooth, not at startup. */
    private fun registerBtReceiver() {
        if (btReceiverRegistered) return
        try {
            ContextCompat.registerReceiver(this, btReceiver,
                IntentFilter().apply { addAction(BluetoothDevice.ACTION_ACL_DISCONNECTED); addAction(BluetoothAdapter.ACTION_STATE_CHANGED) },
                ContextCompat.RECEIVER_NOT_EXPORTED)
            btReceiverRegistered = true
        } catch (t: Exception) { Log.w(TAG, "Bluetooth receiver not registered: ${t.javaClass.simpleName}") }
    }

    private val btReceiver = object : BroadcastReceiver() {
        @SuppressLint("MissingPermission")
        override fun onReceive(c: Context, i: Intent) {
            when (i.action) {
                BluetoothDevice.ACTION_ACL_DISCONNECTED -> {
                    val d = if (Build.VERSION.SDK_INT >= 33) i.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE, BluetoothDevice::class.java)
                            else @Suppress("DEPRECATION") i.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE)
                    bt?.onLinkDown(d?.address, "The Bluetooth reader disconnected.")
                }
                BluetoothAdapter.ACTION_STATE_CHANGED -> {
                    val st = i.getIntExtra(BluetoothAdapter.EXTRA_STATE, BluetoothAdapter.ERROR)
                    if (st == BluetoothAdapter.STATE_TURNING_OFF || st == BluetoothAdapter.STATE_OFF)
                        bt?.onLinkDown(null, "Bluetooth was turned off.")
                }
            }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // A startup failure must show a readable message, never a silent close behind the splash.
        try { initUi() } catch (t: Throwable) { showStartupError(t) }
    }

    /** Logs only the exception type and message (never page content, tokens or medical data) and shows it on screen. */
    private fun showStartupError(t: Throwable) {
        Log.e(TAG, "Startup failure: ${t.javaClass.name}: ${t.message}")
        val pad = (24 * resources.displayMetrics.density).toInt()
        val tv = TextView(this).apply {
            text = "MedVault Secure Medical Records could not start.\n\n${t.javaClass.simpleName}: ${t.message ?: ""}\n\nPlease update Android System WebView and reopen the app."
            setTextColor(0xFFFFFFFF.toInt()); setBackgroundColor(0xFF0A1628.toInt()); textSize = 16f; setPadding(pad, pad * 2, pad, pad)
        }
        setContentView(tv)
    }

    @Suppress("DEPRECATION")
    @SuppressLint("SetJavaScriptEnabled") // required: the app IS a JavaScript web app; origin is locked below
    private fun initUi() {

        // Medical data: block screenshots, screen recording and the recents-screen thumbnail.
        window.setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        WindowCompat.getInsetsController(window, window.decorView).apply {
            isAppearanceLightStatusBars = false          // light icons on the navy status area
            isAppearanceLightNavigationBars = false
        }

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
                al safeAreas = WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout() or WindowInsetsCompat.Type.ime()
                val i = insets.getInsets(safeAreas)
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
                    Log.e(TAG, "WebView renderer gone, crashed=${detail.didCrash()}")
                    if (!isFinishing) AlertDialog.Builder(this@MainActivity)
                        .setMessage("The app view stopped unexpectedly.")
                        .setPositiveButton("Reopen") { _, _ -> recreate() }
                        .setNegativeButton("Close") { _, _ -> finish() }
                        .setCancelable(false).show()
                    return true
                }

                override fun onReceivedError(view: WebView, request: WebResourceRequest, error: android.webkit.WebResourceError) {
                    if (request.isForMainFrame) {
                        Log.e(TAG, "Main frame failed to load: code=${error.errorCode} ${error.description}")
                        showStartupError(IOException("Could not load the bundled app (${error.description})"))
                    }
                }

                override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, errorResponse: WebResourceResponse) {
                    if (request.isForMainFrame || request.url.path?.endsWith(".js") == true)
                        Log.e(TAG, "Asset request failed: ${request.url.path} -> ${errorResponse.statusCode}")
                }
            }
            webChromeClient = dialogsChromeClient()
        }
        setContentView(webView)

        val adapter = btAdapter()
        if (adapter != null) {
            try {
                bt = BtSerial(adapter,
                    onData = { bytes -> emit(JSONObject().put("ev", "data").put("b64", Base64.encodeToString(bytes, Base64.NO_WRAP))) },
                    onLost = { msg -> emit(JSONObject().put("ev", "closed").put("error", msg)) })
            } catch (t: Exception) { Log.w(TAG, "Bluetooth serial unavailable: ${t.javaClass.simpleName}") }
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
                // The page decides first (close sub-screen, return to the home tab, leave register/lookup views).
                webView.evaluateJavascript("(function(){try{return !!(window.__mcHandleBack&&window.__mcHandleBack())}catch(e){return false}})()") { r ->
                    if (r == "true") return@evaluateJavascript
                    AlertDialog.Builder(this@MainActivity)
                        .setMessage("Exit the app? Any unsaved changes will be lost.")
                        .setPositiveButton("Exit") { _, _ -> finish() }
                        .setNegativeButton("Stay", null).show()
                }
            }
        })

        try { assets.open("index.html").close() }
        catch (e: IOException) { showStartupError(e); return }
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
            "pick" -> startPick()
            "open" -> { val addr = o.optString("address"); ensureReady { openDevice(addr) } }
            "write" -> {
                val b64 = o.optString("b64")
                if (b64.length <= 8192) try { bt?.write(Base64.decode(b64, Base64.DEFAULT)) } catch (_: IllegalArgumentException) {}
            }
            "close" -> bt?.close()
            "edge" -> handleEdge(o)
        }
    }

    // ---- Bluetooth: permission -> adapter on -> picker -> connect -------------------------------------------
    private fun btAdapter(): BluetoothAdapter? = getSystemService(BluetoothManager::class.java)?.adapter

    private fun pickFailed(msg: String) = emit(JSONObject().put("ev", "pick_failed").put("error", msg))

    private fun startPick() = ensureReady { showDevicePicker() }

    /** Runs [then] once BLUETOOTH_CONNECT is granted AND the adapter is on; otherwise explains and offers the fix. */
    private fun ensureReady(then: () -> Unit) = runOnUiThread {
        registerBtReceiver()
        if (btAdapter() == null) { pickFailed("This device has no Bluetooth."); return@runOnUiThread }
        ensureBluetoothConnectPermission {
            if (btAdapter()?.isEnabled == true) then()
            else { afterEnable = then; try { enableBluetoothLauncher.launch(Intent(BluetoothAdapter.ACTION_REQUEST_ENABLE)) } catch (_: ActivityNotFoundException) { pickFailed("Turn Bluetooth on in Android settings, then try again.") } }
        }
    }

    private fun ensureBluetoothConnectPermission(then: () -> Unit) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S ||
            checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED) { then(); return }
        // Asked before and Android no longer shows the prompt -> send the user to settings instead of failing silently.
        val askedBefore = prefs.getBoolean("asked", false)
        if (askedBefore && !shouldShowRequestPermissionRationale(Manifest.permission.BLUETOOTH_CONNECT)) { showPermissionDenied(true, null); return }
        prefs.edit().putBoolean("asked", true).apply()
        afterPermission = then
        permissionLauncher.launch(Manifest.permission.BLUETOOTH_CONNECT)
    }

    private fun showPermissionDenied(permanent: Boolean, retry: (() -> Unit)?) {
        val b = AlertDialog.Builder(this)
            .setTitle("Bluetooth permission needed")
            .setOnCancelListener { pickFailed("Bluetooth permission was denied.") }
        if (permanent) {
            b.setMessage("The app cannot connect to the RFID reader without the \"Nearby devices\" permission. Open the app settings, choose Permissions, and allow Nearby devices.")
                .setPositiveButton("Open app settings") { _, _ ->
                    pickFailed("Allow \"Nearby devices\" in app settings, then try again.")
                    try { startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", packageName, null))) } catch (_: ActivityNotFoundException) {}
                }
        } else {
            b.setMessage("MedVault Secure Medical Records only uses Bluetooth to talk to the paired RFID reader (HC-05). Nothing is scanned and your location is not used.")
                .setPositiveButton("Try again") { _, _ -> afterPermission = retry; permissionLauncher.launch(Manifest.permission.BLUETOOTH_CONNECT) }
        }
        b.setNegativeButton("Cancel") { _, _ -> pickFailed("Bluetooth permission was denied.") }.show()
    }

    @SuppressLint("MissingPermission")
    private fun pairedDevices(): List<BluetoothDevice>? {
        val adapter = btAdapter() ?: return null
        if (!adapter.isEnabled) return null
        return try { adapter.bondedDevices.toList() } catch (_: SecurityException) { null }
    }

    @SuppressLint("MissingPermission")
    private fun isHc05(d: BluetoothDevice): Boolean = HC_NAME.containsMatchIn(try { d.name ?: "" } catch (_: SecurityException) { "" })

    @SuppressLint("MissingPermission")
    private fun showDevicePicker() = runOnUiThread {
        val devices = pairedDevices()?.sortedWith(compareByDescending<BluetoothDevice> { isHc05(it) }.thenBy { it.name ?: "" })
        if (devices == null) { pickFailed("Bluetooth is off or unavailable. Turn it on, then try again."); return@runOnUiThread }
        val openSettings = { try { startActivity(Intent(Settings.ACTION_BLUETOOTH_SETTINGS)) } catch (_: ActivityNotFoundException) {} }
        if (devices.isEmpty()) {
            AlertDialog.Builder(this)
                .setTitle("No paired Bluetooth devices")
                .setMessage("Pair the HC-05 reader first in Android Bluetooth settings (the PIN is usually 1234 or 0000), then connect again.")
                .setPositiveButton("Bluetooth settings") { _, _ -> openSettings() }
                .setNegativeButton("Cancel", null)
                .setOnDismissListener { emit(JSONObject().put("ev", "pick_cancelled")) }
                .show()
            return@runOnUiThread
        }
        var chosen = false
        val labels = devices.map { (if (isHc05(it)) "\u2605 HC-05 reader \u2014 " else "") + (it.name ?: "Unnamed device") + "\n" + it.address }.toTypedArray()
        AlertDialog.Builder(this)
            .setTitle("Select the RFID reader")
            .setItems(labels) { _, which ->
                chosen = true
                emit(JSONObject().put("ev", "picked").put("address", devices[which].address).put("name", devices[which].name ?: ""))
            }
            .setNeutralButton("Pair new device") { _, _ -> openSettings() }
            .setOnDismissListener { if (!chosen) emit(JSONObject().put("ev", "pick_cancelled")) }
            .show()
    }

    private fun openDevice(address: String) = runOnUiThread {
        // Never trust the page: only connect to a device that is actually paired on this phone.
        val device = pairedDevices()?.firstOrNull { it.address.equals(address, ignoreCase = true) }
        val b = bt
        if (device == null || b == null) {
            emit(JSONObject().put("ev", "open_failed").put("error", "That device is not paired with this phone.")); return@runOnUiThread
        }
        if (b.isConnecting) { emit(JSONObject().put("ev", "open_failed").put("error", "A connection attempt is already in progress.")); return@runOnUiThread }
        showProgress("Connecting to ${try { device.name } catch (_: SecurityException) { null } ?: "reader"}\u2026") {
            b.close()
            emit(JSONObject().put("ev", "open_failed").put("error", "Connection cancelled."))
        }
        b.connect(device) { err ->
            runOnUiThread { hideProgress() }
            emit(if (err == null) JSONObject().put("ev", "opened") else JSONObject().put("ev", "open_failed").put("error", err))
        }
    }

    private fun showProgress(text: String, onCancel: () -> Unit) {
        hideProgress()
        val pad = (20 * resources.displayMetrics.density).toInt()
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; setPadding(pad, pad, pad, pad)
            addView(ProgressBar(context).apply { isIndeterminate = true })
            addView(TextView(context).apply { this.text = text; textSize = 16f; setPadding(pad, 0, 0, 0) })
        }
        progress = AlertDialog.Builder(this).setView(row).setCancelable(false)
            .setNegativeButton("Cancel") { _, _ -> progress = null; onCancel() }.show()
    }

    private fun hideProgress() { progress?.dismiss(); progress = null }

    // ---- Edge Functions over the native HTTPS stack (no browser CORS / Origin) --------------------------------
    private fun handleEdge(o: JSONObject) {
        val id = o.optString("id"); val fn = o.optString("fn"); val body = o.optString("body"); val key = o.optString("apikey")
        val timeout = o.optInt("timeoutMs", 25000).coerceIn(5000, 60000)
        fun fail(e: String) = emit(JSONObject().put("ev", "edge").put("id", id).put("error", e))
        // Only our own project, only the three known functions, only a JWT-shaped public (anon) key.
        if (id.isEmpty() || id.length > 16 || fn !in EDGE_FUNCTIONS || body.length > 16384 || key.length !in 20..600 || key.count { it == '.' } != 2) { fail("bad_request"); return }
        edgeExecutor.execute {
            var conn: HttpsURLConnection? = null
            try {
                conn = (URL("$SUPABASE_URL/functions/v1/$fn").openConnection() as HttpsURLConnection).apply {
                    requestMethod = "POST"; connectTimeout = 10000; readTimeout = timeout; doOutput = true; instanceFollowRedirects = false
                    setRequestProperty("Content-Type", "application/json"); setRequestProperty("Accept", "application/json")
                    setRequestProperty("apikey", key); setRequestProperty("Authorization", "Bearer $key")
                }
                conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
                val status = conn.responseCode
                val stream = if (status in 200..299) conn.inputStream else conn.errorStream
                val text = stream?.use { readCapped(it, 262144) } ?: ""
                emit(JSONObject().put("ev", "edge").put("id", id).put("status", status).put("body", text))   // never logged
            } catch (_: SocketTimeoutException) { fail("timeout") }
            catch (_: IOException) { fail("network") }
            catch (_: Exception) { fail("network") }
            finally { conn?.disconnect() }
        }
    }

    private fun readCapped(i: InputStream, max: Int): String {
        val out = ByteArrayOutputStream(); val buf = ByteArray(4096)
        while (true) { val n = i.read(buf); if (n < 0) break; if (out.size() + n > max) throw IOException("too large"); out.write(buf, 0, n) }
        return out.toString("UTF-8")
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
        hideProgress()
        if (btReceiverRegistered) try { unregisterReceiver(btReceiver) } catch (_: IllegalArgumentException) {}
        bt?.shutdown()
        edgeExecutor.shutdownNow()
        reply = null
        if (::webView.isInitialized) webView.apply { loadUrl("about:blank"); clearHistory(); clearCache(true); removeAllViews(); destroy() }
        super.onDestroy()
    }

    companion object {
        private const val TAG = "MedVault"
        private const val HOST = "appassets.androidplatform.net"
        private const val SUPABASE_URL = "https://pkzzktnxiboottirasvc.supabase.co"
        private val EDGE_FUNCTIONS = setOf("register-hospital", "login-with-id", "request-password-reset")
        private val HC_NAME = Regex("(?i)hc[-_ ]?0?[56]|linvor")
    }
}
