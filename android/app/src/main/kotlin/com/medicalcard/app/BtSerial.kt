package com.medicalcard.app

import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothSocket
import java.io.IOException
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Bluetooth Classic RFCOMM/SPP link to the HC-05 (a Classic module, not BLE).
 *
 * Guarantees:
 *  - at most ONE socket exists at any time (a second connect() while CONNECTING is rejected; connecting
 *    while CONNECTED closes the old link first);
 *  - "connected" is reported only after BluetoothSocket.connect() really returned;
 *  - every connect attempt has a hard timeout ([CONNECT_TIMEOUT_S]) enforced by closing the socket;
 *  - a generation counter makes callbacks from an old/closed link harmless (no ghost "lost" events);
 *  - the read buffer is fixed-size and chunks are forwarded in order, so no bytes are lost or reordered and
 *    nothing accumulates here (line assembly + its size cap live in the page).
 * Never logs payloads: they contain card codes and medical-record identifiers.
 * Callbacks arrive on background threads.
 */
@SuppressLint("MissingPermission") // BLUETOOTH_CONNECT is requested by MainActivity before any call here
class BtSerial(
    private val adapter: BluetoothAdapter,
    private val onData: (ByteArray) -> Unit,
    private val onLost: (String) -> Unit,
) {
    private enum class State { IDLE, CONNECTING, CONNECTED }

    private val lock = Any()
    private var state = State.IDLE
    private var generation = 0
    private var socket: BluetoothSocket? = null        // the live link (CONNECTED)
    private var pending: BluetoothSocket? = null       // the socket being connected (CONNECTING)
    private var address: String? = null

    private val io = Executors.newCachedThreadPool { r -> Thread(r, "bt-io").apply { isDaemon = true } }
    private val writer = Executors.newSingleThreadExecutor { r -> Thread(r, "bt-write").apply { isDaemon = true } }
    private val watchdog = Executors.newSingleThreadScheduledExecutor { r -> Thread(r, "bt-watchdog").apply { isDaemon = true } }

    val isConnecting: Boolean get() = synchronized(lock) { state == State.CONNECTING }
    val isConnected: Boolean get() = synchronized(lock) { state == State.CONNECTED }

    /** [done] is called exactly once with null on success or a user-readable error, unless close() cancelled it. */
    fun connect(device: BluetoothDevice, done: (String?) -> Unit) {
        val gen: Int
        synchronized(lock) {
            if (state == State.CONNECTING) { done("A connection attempt is already in progress."); return }
            closeLocked()                                // replaces an existing link: never two at once
            state = State.CONNECTING
            gen = ++generation
            address = device.address
        }
        io.execute {
            try { adapter.cancelDiscovery() } catch (_: SecurityException) {}   // discovery slows/blocks connect()
            var error = "Could not connect. Check the reader is powered, paired and in range."
            var connected: BluetoothSocket? = null
            for (attempt in 0..1) {                      // 1st: secure SPP, 2nd: insecure SPP (some HC-05 firmware)
                val s: BluetoothSocket = try {
                    if (attempt == 0) device.createRfcommSocketToServiceRecord(SPP_UUID)
                    else device.createInsecureRfcommSocketToServiceRecord(SPP_UUID)
                } catch (e: SecurityException) {
                    finishFailed(gen, done, "Bluetooth permission was denied."); return@execute
                } catch (e: IOException) {
                    error = "Could not open a Bluetooth channel."; continue
                }
                synchronized(lock) {
                    if (generation != gen) { closeQuietly(s); return@execute }   // cancelled meanwhile
                    pending = s
                }
                val timedOut = AtomicBoolean(false)
                val wd = watchdog.schedule({ timedOut.set(true); closeQuietly(s) }, CONNECT_TIMEOUT_S, TimeUnit.SECONDS)
                try {
                    s.connect()
                    wd.cancel(false)
                    if (timedOut.get()) { error = "Connection timed out."; continue }
                    connected = s
                    break
                } catch (e: IOException) {
                    wd.cancel(false)
                    closeQuietly(s)
                    error = if (timedOut.get()) "Connection timed out. Is the reader powered and in range?"
                            else "Could not connect. Check the reader is powered, paired and in range."
                    synchronized(lock) { if (generation != gen) return@execute }
                    try { Thread.sleep(400) } catch (_: InterruptedException) {}
                } catch (e: SecurityException) {
                    closeQuietly(s)
                    finishFailed(gen, done, "Bluetooth permission was denied."); return@execute
                }
            }
            val s = connected
            if (s == null) { finishFailed(gen, done, error); return@execute }
            synchronized(lock) {
                if (generation != gen) { closeQuietly(s); return@execute }
                socket = s; pending = null; state = State.CONNECTED
            }
            done(null)
            readLoop(s, gen)
        }
    }

    private fun finishFailed(gen: Int, done: (String?) -> Unit, msg: String) {
        synchronized(lock) {
            if (generation != gen) return              // cancelled: the canceller reports it
            pending = null; state = State.IDLE
        }
        done(msg)
    }

    private fun readLoop(s: BluetoothSocket, gen: Int) {
        val buf = ByteArray(1024)
        try {
            val input = s.inputStream
            while (true) {
                val n = input.read(buf)
                if (n < 0) break
                if (n > 0) onData(buf.copyOf(n))
            }
        } catch (_: IOException) { /* closed locally or link dropped */ }
        lost(s, gen, "Bluetooth connection lost. Reconnect the reader.")
    }

    fun write(bytes: ByteArray) {
        val s: BluetoothSocket; val gen: Int
        synchronized(lock) { s = socket ?: return; gen = generation }
        writer.execute {
            try {
                s.outputStream.write(bytes)
                s.outputStream.flush()
            } catch (_: IOException) {
                lost(s, gen, "Bluetooth connection lost while sending. Reconnect the reader.")
            }
        }
    }

    /** Called by MainActivity when Android reports ACL disconnect / Bluetooth switched off. */
    fun onLinkDown(addr: String?, reason: String) {
        val s: BluetoothSocket; val gen: Int
        synchronized(lock) {
            s = socket ?: return
            if (addr != null && !addr.equals(address, ignoreCase = true)) return
            gen = generation
        }
        lost(s, gen, reason)
    }

    private fun lost(s: BluetoothSocket, gen: Int, msg: String) {
        val report: Boolean
        synchronized(lock) {
            report = generation == gen && socket === s
            if (report) { socket = null; state = State.IDLE; generation++ }
        }
        closeQuietly(s)
        if (report) onLost(msg)                          // only for an unexpected loss, never for our own close()
    }

    /** Idempotent. Cancels a pending connect and closes the live link. */
    fun close() = synchronized(lock) { closeLocked() }

    private fun closeLocked() {
        generation++                                      // invalidates every in-flight callback
        val a = socket; val b = pending
        socket = null; pending = null; state = State.IDLE
        closeQuietly(a); closeQuietly(b)
    }

    fun shutdown() { close(); writer.shutdownNow(); watchdog.shutdownNow(); io.shutdownNow() }

    private fun closeQuietly(s: BluetoothSocket?) { try { s?.close() } catch (_: IOException) {} }

    companion object {
        /** Standard Serial Port Profile UUID used by the HC-05. */
        val SPP_UUID: UUID = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB")
        const val CONNECT_TIMEOUT_S = 15L
    }
}
