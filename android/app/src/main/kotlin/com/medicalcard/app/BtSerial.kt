package com.medicalcard.app

import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothSocket
import java.io.IOException
import java.util.UUID
import java.util.concurrent.Executors

/**
 * Bluetooth Classic RFCOMM/SPP link to the HC-05 (the HC-05 is a Classic module, not BLE).
 * It moves raw bytes only; the Arduino line protocol (UID:/CARD:/CODE:/INFO:/ERR:) stays entirely in the web app.
 * Never logs payloads: they contain card codes and medical-record identifiers.
 * Callbacks arrive on background threads.
 */
@SuppressLint("MissingPermission") // BLUETOOTH_CONNECT is requested by MainActivity before any call here
class BtSerial(
    private val adapter: BluetoothAdapter,
    private val onData: (ByteArray) -> Unit,
    private val onLost: (String) -> Unit,
) {
    private val writeExecutor = Executors.newSingleThreadExecutor()
    @Volatile private var socket: BluetoothSocket? = null

    /** [done] receives null on success or a user-readable error. */
    fun connect(device: BluetoothDevice, done: (String?) -> Unit) {
        close()
        Thread {
            val s: BluetoothSocket = try {
                adapter.cancelDiscovery()                        // discovery slows/blocks connect()
                device.createRfcommSocketToServiceRecord(SPP_UUID)
            } catch (e: IOException) {
                done("Could not open a Bluetooth channel."); return@Thread
            } catch (e: SecurityException) {
                done("Bluetooth permission was denied."); return@Thread
            }
            try {
                s.connect()
            } catch (e: IOException) {
                try { s.close() } catch (_: IOException) {}
                done("Could not connect. Check the reader is powered, paired and in range.")
                return@Thread
            }
            socket = s
            done(null)
            readLoop(s)
        }.apply { name = "bt-connect-read"; isDaemon = true }.start()
    }

    private fun readLoop(s: BluetoothSocket) {
        val buf = ByteArray(1024)
        try {
            val input = s.inputStream
            while (true) {
                val n = input.read(buf)
                if (n < 0) break
                if (n > 0) onData(buf.copyOf(n))
            }
        } catch (_: IOException) { /* closed locally or link dropped */ }
        // Report only if we did not close it ourselves (close() nulls the field first).
        if (socket === s) {
            socket = null
            try { s.close() } catch (_: IOException) {}
            onLost("Bluetooth connection lost.")
        }
    }

    fun write(bytes: ByteArray) {
        val s = socket ?: return
        writeExecutor.execute {
            try {
                s.outputStream.write(bytes)
                s.outputStream.flush()
            } catch (_: IOException) {
                if (socket === s) {
                    socket = null
                    try { s.close() } catch (_: IOException) {}
                    onLost("Bluetooth connection lost.")
                }
            }
        }
    }

    fun close() {
        val s = socket
        socket = null
        try { s?.close() } catch (_: IOException) {}
    }

    companion object {
        /** Standard Serial Port Profile UUID used by the HC-05. */
        val SPP_UUID: UUID = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB")
    }
}
