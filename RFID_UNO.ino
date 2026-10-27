/*
  RFID_UNO_HC05.ino
  Arduino Uno + MFRC522 RFID reader + HC-05 Bluetooth serial module.

  Reads MIFARE Classic 1K / 4K RFID cards and communicates with the EMR
  website over Bluetooth (HC-05 SPP) or USB, using exactly the same protocol
  as the original USB-only sketch.

  =====================================================================
  WIRING TABLE
  =====================================================================

  MFRC522 RFID reader          Arduino UNO
  ─────────────────────────────────────────
  SDA / SS                  →  Pin 10   (SPI slave select)
  SCK                       →  Pin 13   (SPI clock — hardware)
  MOSI                      →  Pin 11   (SPI data out — hardware)
  MISO                      →  Pin 12   (SPI data in — hardware)
  RST                       →  Pin 9
  3.3 V                     →  3.3 V output on UNO  ← NEVER 5 V
  GND                       →  GND
  IRQ                          not connected

  HC-05 Bluetooth module       Arduino UNO
  ─────────────────────────────────────────
  VCC                       →  5 V  (most HC-05 breakout boards have an
                                     onboard 3.3 V regulator; verify yours)
  GND                       →  GND
  TXD (HC-05 transmits)     →  Pin 2   (SoftwareSerial RX — direct wire,
                                        3.3 V signal is above the ~2 V
                                        logic-high threshold of the UNO)
  RXD (HC-05 receives)      →  voltage divider → Pin 3  (SoftwareSerial TX)

    Voltage divider (5 V → 3.3 V) to protect HC-05 RX:
      Pin 3  ──[1 kΩ]──┬── HC-05 RXD
                        └──[2 kΩ]── GND
    Gives: 5 V × 2/(1+2) ≈ 3.33 V — within HC-05 3.3 V logic spec.

  EN / KEY                     leave unconnected for normal operation
                               (tie to 3.3 V only when entering AT mode)
  STATE                        optional: HIGH when paired, LOW when not

  4-pin RGB LED module          Arduino UNO
  ─────────────────────────────────────────
  R channel                 →  Pin 5
  G channel                 →  Pin 6
  B channel                 →  Pin 8
  Common cathode (−)        →  GND
  If your module is common-anode (+), connect common to 5 V and set
  RGB_COMMON_ANODE to 1 below. Check the board's pin labels before wiring.
  Use a current-limiting resistor per channel if your module does not
  already include them.

  HC-05 STATE                →  Pin 4 (HIGH while connected on typical boards)

  Buzzer (success)             Arduino UNO
  ─────────────────────────────────────────
  + lead  →  Pin 7
  – lead  →  GND
  (Works with both active and passive piezo buzzers up to ~30 mA.
   For higher-current buzzers use a 2N2222 / BC547 NPN transistor
   with a 1 kΩ base resistor from Pin 7.)

  =====================================================================
  SERIAL PROTOCOL  (identical to the original USB-only sketch)
  =====================================================================

  Sent by Arduino → browser (via Bluetooth or USB):
    CODE:<10 digits>                  programmed card read successfully
    UID:<hex UID>                     card has no readable code (blank)
    INFO:CARD_CHECK_ARMED             PRECHECK accepted, ready for next tap
    INFO:PROGRAMMING_ARMED            ARM accepted, ready for next tap
    INFO:WRITE_OK                     card programmed successfully
    INFO:WRITE_COMMAND_RECEIVED       legacy WRITE command accepted
    INFO:WRONG_CARD_REMOVE_AND_TAP_ORIGINAL  wrong card for targeted write
    ERR:WRITE_<reason>                programming failed

  Sent by browser → Arduino (via Bluetooth or USB):
    PRECHECK                          read card UID + stored code, no write
    ARM:<10 digits>                   legacy arm for next-tap write
    WRITE:<digits>:<hex UID>          legacy targeted write

  Both USB serial (115200 baud) and Bluetooth serial (9600 baud) carry
  the full protocol simultaneously. USB serial also shows debug info.

  =====================================================================
  ONE-TIME HC-05 CONFIGURATION (AT command mode)
  =====================================================================
  The HC-05 factory default SPP baud rate is 9600. If yours is different:

  1. Power off the HC-05 module.
  2. Hold the EN / KEY pin HIGH (3.3 V) while applying power.
     The LED will blink slowly (~2 s period) — you are in AT mode.
  3. Open Arduino Serial Monitor at 38400 baud, line-ending = "Both NL & CR".
  4. Type and send these commands one at a time:
       AT                       → reply: OK  (confirms AT mode works)
       AT+UART=9600,0,0         → sets Bluetooth SPP baud to 9600
       AT+NAME=EMR-Reader       → optional friendly display name
       AT+PSWD="1234"           → default PIN; change if you prefer
  5. Power off, release KEY, power on normally. LED blinks fast (~0.5 s)
     when discoverable, solidly when paired.

  =====================================================================
  PAIRING ON WINDOWS
  =====================================================================
  1. Settings → Bluetooth & devices → Add device → Bluetooth.
     Select "HC-05" (or "EMR-Reader"). PIN = 1234.
  2. After pairing: Settings → "More Bluetooth settings" → COM Ports tab.
     Note the Outgoing COM port, e.g. COM5.
  3. In the EMR website header, choose "9600 baud" in the baud selector.
  4. Click "Connect reader" and select that COM port.

  PAIRING ON macOS
  =====================================================================
  1. System Preferences → Bluetooth → pair the HC-05.
  2. After pairing a /dev/tty.HC-05-DevB (or similar) device appears.
  3. In the EMR website header, choose "9600 baud", click "Connect reader",
     and select /dev/tty.HC-05-DevB (NOT /dev/cu.…).

  PAIRING ON LINUX
  =====================================================================
  1. bluetoothctl → scan on → pair <addr> → trust <addr> → connect <addr>
  2. sudo rfcomm bind /dev/rfcomm0 <HC-05-MAC-address>
  3. In the EMR website, choose "9600 baud", click "Connect reader",
     and select /dev/rfcomm0.

  =====================================================================
  ARDUINO IDE BOARD & LIBRARY SETTINGS
  =====================================================================
  Board    : "Arduino Uno"  (Tools → Board → Arduino AVR Boards → Arduino Uno)
  Libraries: MFRC522 by GithubCommunity (Library Manager)
             SoftwareSerial (built-in — no install needed)
  Upload   : Disconnect the HC-05 TXD wire from Pin 2 before uploading,
             then reconnect after. SoftwareSerial on Pin 2 can interfere
             with the bootloader upload if bytes arrive during the process.
*/

#include <SPI.h>
#include <MFRC522.h>
#include <SoftwareSerial.h>

// ── MFRC522 pins ──────────────────────────────────────────────────────────────
#define SS_PIN     10  // SPI slave-select (SDA on RC522 breakout)
#define RST_PIN     9
#define CODE_BLOCK  4  // MIFARE Classic data block that stores the 10-digit code

// ── RGB status LED and success-feedback pins ───────────────────────────────────
// Assumes a 4-pin RGB module with separate R/G/B channels and one common pin.
// For a common-cathode module, common -> GND and RGB_COMMON_ANODE = 0.
// For a common-anode module, common -> 5V and RGB_COMMON_ANODE = 1.
#define RGB_R_PIN 5
#define RGB_G_PIN 6
#define RGB_B_PIN 8
#define BT_STATE_PIN 4  // HC-05 STATE; usually HIGH while SPP link is connected
#define RGB_COMMON_ANODE 0
#define BUZZER_PIN   7  // active or passive piezo buzzer to GND
#define FEEDBACK_FREQ 2000
#define FEEDBACK_MS    180

// ── HC-05 SoftwareSerial pins ─────────────────────────────────────────────────
#define BT_RX_PIN  2   // Arduino RX ← HC-05 TXD (direct, 3.3 V OK as UNO input)
#define BT_TX_PIN  3   // Arduino TX → HC-05 RXD via 1 kΩ / 2 kΩ voltage divider
#define BT_BAUD 9600   // Must match AT+UART setting; factory default is 9600

// ── Objects ───────────────────────────────────────────────────────────────────
MFRC522 rfid(SS_PIN, RST_PIN);
MFRC522::MIFARE_Key defaultKey;
SoftwareSerial btSerial(BT_RX_PIN, BT_TX_PIN);

// ── State ─────────────────────────────────────────────────────────────────────
String pendingCode  = "";  // code queued for next card write (ARM/WRITE mode)
bool pendingPrecheck = false; // read UID + stored code without writing
String pendingUid   = "";  // optional target UID (legacy WRITE mode)
String lastUid      = "";  // dedup: suppress repeated reports for same card
unsigned long lastSentAt = 0;
bool awaitingProfileResponse = false;
unsigned long profileResponseStartedAt = 0;

// Non-blocking line buffers — one per serial interface
String usbBuf = "";
String btBuf  = "";

// ── Protocol helpers ──────────────────────────────────────────────────────────

// ── RGB status helpers ─────────────────────────────────────────────────────────
enum RgbStatus { RGB_OFF, RGB_WHITE, RGB_BLUE, RGB_GREEN, RGB_RED };

void writeRgbChannel(byte pin, bool on) {
  digitalWrite(pin, (RGB_COMMON_ANODE ? !on : on) ? HIGH : LOW);
}

void setRgb(RgbStatus status) {
  bool r = false, g = false, b = false;
  switch (status) {
    case RGB_WHITE: r = true; g = true; b = true; break;
    case RGB_BLUE:  b = true; break;
    case RGB_GREEN: g = true; break;
    case RGB_RED:   r = true; break;
    case RGB_OFF: default: break;
  }
  writeRgbChannel(RGB_R_PIN, r);
  writeRgbChannel(RGB_G_PIN, g);
  writeRgbChannel(RGB_B_PIN, b);
}

bool bluetoothConnected() {
  return digitalRead(BT_STATE_PIN) == HIGH;
}

void showBaseStatus() {
  // On power-up show white. Once HC-05 STATE goes HIGH, show blue.
  setRgb(bluetoothConnected() ? RGB_BLUE : RGB_WHITE);
}

void pulseStatus(RgbStatus status, unsigned int durationMs = FEEDBACK_MS) {
  setRgb(status);
  delay(durationMs);
  showBaseStatus();
}

// Send a protocol line to USB and Bluetooth. Error responses flash red.
void sendLine(const __FlashStringHelper *msg) {
  Serial.println(msg);
  btSerial.println(msg);
  // Flash red for firmware-reported errors; do not alter the message protocol.
  String s(msg);
  if (s.startsWith(F("ERR:")) || s.startsWith(F("INFO:WRONG_CARD"))) pulseStatus(RGB_RED, FEEDBACK_MS);
}

void sendLine(const String &msg) {
  Serial.println(msg);
  btSerial.println(msg);
  if (msg.startsWith(F("ERR:")) || msg.startsWith(F("INFO:WRONG_CARD"))) pulseStatus(RGB_RED, FEEDBACK_MS);
}

// Send prefix (F-string) then a String value with newline on both ports.
void sendPrefixLine(const __FlashStringHelper *prefix, const String &value) {
  Serial.print(prefix);
  Serial.println(value);
  btSerial.print(prefix);
  btSerial.println(value);
}

// ── RFID helpers ──────────────────────────────────────────────────────────────

String uidToHex(const MFRC522::Uid *uid) {
  String out;
  out.reserve(uid->size * 2);
  for (byte i = 0; i < uid->size; i++) {
    if (uid->uidByte[i] < 0x10) out += '0';
    out += String(uid->uidByte[i], HEX);
  }
  out.toUpperCase();
  return out;
}

bool isClassicCard() {
  MFRC522::PICC_Type t = rfid.PICC_GetType(rfid.uid.sak);
  return t == MFRC522::PICC_TYPE_MIFARE_MINI ||
         t == MFRC522::PICC_TYPE_MIFARE_1K   ||
         t == MFRC522::PICC_TYPE_MIFARE_4K;
}

bool authenticateBlock() {
  MFRC522::StatusCode s = rfid.PCD_Authenticate(
      MFRC522::PICC_CMD_MF_AUTH_KEY_A, CODE_BLOCK, &defaultKey, &(rfid.uid));
  if (s != MFRC522::STATUS_OK) { rfid.PCD_StopCrypto1(); return false; }
  return true;
}

bool readStoredCode(String &code) {
  if (!isClassicCard() || !authenticateBlock()) return false;
  byte buf[18], sz = sizeof(buf);
  MFRC522::StatusCode s = rfid.MIFARE_Read(CODE_BLOCK, buf, &sz);
  rfid.PCD_StopCrypto1();
  if (s != MFRC522::STATUS_OK) return false;

  // Accept 10-digit codes (current) and 16-digit codes (legacy).
  bool first10 = true;
  for (byte i = 0; i < 10; i++) if (buf[i] < '0' || buf[i] > '9') { first10 = false; break; }
  if (!first10) return false;

  bool all16 = true;
  for (byte i = 0; i < 16; i++) if (buf[i] < '0' || buf[i] > '9') { all16 = false; break; }
  if (all16) {
    code = "";
    for (byte i = 0; i < 16; i++) code += (char)buf[i];
    return true;
  }
  for (byte i = 10; i < 16; i++) if (buf[i] != ' ' && buf[i] != 0x00) return false;
  code = "";
  for (byte i = 0; i < 10; i++) code += (char)buf[i];
  return true;
}

// Precheck uses three states so a failed read is never mistaken for a blank card.
// 0 = readable block with no supported numeric code, 1 = valid stored code, 2 = unreadable/auth failure.
byte readStoredCodeStatus(String &code) {
  if (!isClassicCard() || !authenticateBlock()) return 2;
  byte buf[18], sz = sizeof(buf);
  MFRC522::StatusCode s = rfid.MIFARE_Read(CODE_BLOCK, buf, &sz);
  rfid.PCD_StopCrypto1();
  if (s != MFRC522::STATUS_OK) return 2;
  bool first10 = true;
  for (byte i=0;i<10;i++) if (buf[i]<'0'||buf[i]>'9') { first10=false; break; }
  if (!first10) return 0;
  bool all16=true;
  for (byte i=0;i<16;i++) if (buf[i]<'0'||buf[i]>'9') { all16=false; break; }
  if (all16) { code=""; for(byte i=0;i<16;i++) code+=(char)buf[i]; return 1; }
  for(byte i=10;i<16;i++) if(buf[i]!=' '&&buf[i]!=0x00) return 0;
  code=""; for(byte i=0;i<10;i++) code+=(char)buf[i]; return 1;
}

// Returns 0 = OK, 1 = auth failed, 2 = write failed, 3 = read-back mismatch.
byte writeStoredCode(const String &code) {
  byte data[16];
  for (byte i = 0; i < 16; i++) data[i] = ' ';
  for (byte i = 0; i < code.length() && i < 16; i++) data[i] = (byte)code.charAt(i);

  byte result = 1;
  for (byte attempt = 0; attempt < 3; attempt++) {
    if (!authenticateBlock()) { result = 1; delay(10); continue; }
    if (rfid.MIFARE_Write(CODE_BLOCK, data, 16) != MFRC522::STATUS_OK) {
      rfid.PCD_StopCrypto1(); result = 2; delay(10); continue;
    }
    byte rbuf[18]; byte rsz = sizeof(rbuf);
    MFRC522::StatusCode rs = rfid.MIFARE_Read(CODE_BLOCK, rbuf, &rsz);
    rfid.PCD_StopCrypto1();
    if (rs == MFRC522::STATUS_OK && memcmp(rbuf, data, 16) == 0) return 0;
    result = 3; delay(10);
  }
  return result;
}

bool isDigitsCode(const String &s) {
  if (s.length() != 10 && s.length() != 16) return false;
  for (unsigned int i = 0; i < s.length(); i++)
    if (s.charAt(i) < '0' || s.charAt(i) > '9') return false;
  return true;
}

// ── Command parser ────────────────────────────────────────────────────────────

void handleCommand(const String &cmd) {
  // The website must send one of these after looking up a scanned code.
  // PROFILE_NOT_FOUND -> red flash; PROFILE_FOUND -> green flash.
  if (cmd == F("PROFILE_NOT_FOUND") || cmd == F("PROFILE_ERROR")) {
    awaitingProfileResponse = false;
    pulseStatus(RGB_RED, FEEDBACK_MS);
    Serial.println(cmd == F("PROFILE_NOT_FOUND") ? F("INFO:PROFILE_NOT_FOUND_RED_FLASH") : F("INFO:PROFILE_ERROR_RED_FLASH"));
    return;
  }
  if (cmd == F("PROFILE_FOUND")) {
    awaitingProfileResponse = false;
    pulseStatus(RGB_GREEN, FEEDBACK_MS);
    Serial.println(F("INFO:PROFILE_FOUND_GREEN_FLASH"));
    return;
  }
  if (cmd == F("PRECHECK")) {
    pendingPrecheck = true; pendingCode = ""; pendingUid = "";
    sendLine(F("INFO:CARD_CHECK_ARMED")); return;
  }
  if (cmd.startsWith(F("ARM:"))) {
    pendingPrecheck = false;
    String code = cmd.substring(4);
    code.trim();
    if (!isDigitsCode(code) || code.length() != 10) {
      sendLine(F("ERR:WRITE_BAD_CODE")); return;
    }
    pendingCode = code;
    pendingUid  = "";
    sendLine(F("INFO:PROGRAMMING_ARMED"));
    return;
  }
  if (!cmd.startsWith(F("WRITE:"))) return;  // unknown — ignore
  pendingPrecheck = false;
  int split = cmd.indexOf(':', 6);
  if (split < 0) { sendLine(F("ERR:WRITE_BAD_COMMAND")); return; }
  String code = cmd.substring(6, split);
  String tuid = cmd.substring(split + 1);
  code.trim(); tuid.trim(); tuid.toUpperCase();
  if (!isDigitsCode(code) || tuid.length() < 8 || tuid.length() > 20) {
    sendLine(F("ERR:WRITE_BAD_CODE_OR_UID")); return;
  }
  for (unsigned int i = 0; i < tuid.length(); i++) {
    char c = tuid.charAt(i);
    if (!((c >= '0' && c <= '9') || (c >= 'A' && c <= 'F'))) {
      sendLine(F("ERR:WRITE_BAD_CODE_OR_UID")); return;
    }
  }
  pendingCode = code;
  pendingUid  = tuid;
  sendLine(F("INFO:WRITE_COMMAND_RECEIVED"));
}

// Non-blocking: drain available bytes from both ports, dispatch complete lines.
void processCommands() {
  while (Serial.available()) {
    char c = (char)Serial.read();
    if (c == '\n') {
      usbBuf.trim();
      if (usbBuf.length()) handleCommand(usbBuf);
      usbBuf = "";
    } else if (c != '\r' && usbBuf.length() < 80) {
      usbBuf += c;
    }
  }
  while (btSerial.available()) {
    char c = (char)btSerial.read();
    if (c == '\n') {
      btBuf.trim();
      if (btBuf.length()) handleCommand(btBuf);
      btBuf = "";
    } else if (c != '\r' && btBuf.length() < 80) {
      btBuf += c;
    }
  }
}

// ── Success feedback ──────────────────────────────────────────────────────────

void successFeedback() {
  setRgb(RGB_GREEN);
  tone(BUZZER_PIN, FEEDBACK_FREQ, FEEDBACK_MS);
  delay(FEEDBACK_MS + 60);
  noTone(BUZZER_PIN);
  showBaseStatus();
}

// ── setup() ──────────────────────────────────────────────────────────────────

void setup() {
  Serial.begin(115200);       // USB — monitoring / debugging at 115200 baud
  btSerial.begin(BT_BAUD);    // HC-05 Bluetooth SPP — must match AT+UART setting

  for (byte i = 0; i < 6; i++) defaultKey.keyByte[i] = 0xFF;

  pinMode(RGB_R_PIN, OUTPUT);
  pinMode(RGB_G_PIN, OUTPUT);
  pinMode(RGB_B_PIN, OUTPUT);
  pinMode(BT_STATE_PIN, INPUT);
  pinMode(BUZZER_PIN, OUTPUT); digitalWrite(BUZZER_PIN, LOW);
  setRgb(RGB_WHITE);  // all RGB channels on when Arduino powers up

  SPI.begin();
  rfid.PCD_Init();
  rfid.PCD_SetAntennaGain(rfid.RxGain_max);
  delay(50);

  sendLine(F("INFO: Arduino Uno + HC-05 RFID reader/writer starting"));
  byte ver = rfid.PCD_ReadRegister(rfid.VersionReg);
  Serial.print(F("INFO: MFRC522 firmware version 0x"));
  if (ver < 0x10) Serial.print('0');
  Serial.println(ver, HEX);
  if (ver == 0x00 || ver == 0xFF)
    sendLine(F("ERR:MFRC522_NOT_RESPONDING_CHECK_WIRING"));
  else
    sendLine(F("INFO:READY_10_DIGIT_CODE_IN_BLOCK_4"));
}

// ── loop() ───────────────────────────────────────────────────────────────────

void loop() {
  processCommands();  // non-blocking; drains both serial buffers each iteration
  // Wait for the website's database lookup result before showing success/failure.
  if (awaitingProfileResponse) {
    if (millis() - profileResponseStartedAt >= 6000UL) {
      awaitingProfileResponse = false;
      pulseStatus(RGB_RED, FEEDBACK_MS); // no reply is an error, never success
      Serial.println(F("ERR:PROFILE_LOOKUP_TIMEOUT"));
    }
    delay(20);
    return;
  }
  // Blue = connected; white = powered but not connected.
  showBaseStatus();

  // In ARM mode PICC_WakeupA re-selects a card that may already be halted;
  // in normal mode PICC_IsNewCardPresent waits for a fresh tap.
  bool cardPresent = false;
  if (pendingPrecheck || pendingCode.length() == 10 || pendingCode.length() == 16) {
    byte atqa[2]; byte asz = sizeof(atqa);
    cardPresent = (rfid.PICC_WakeupA(atqa, &asz) == MFRC522::STATUS_OK);
    if (!cardPresent) cardPresent = rfid.PICC_IsNewCardPresent();
  } else {
    cardPresent = rfid.PICC_IsNewCardPresent();
  }
  if (!cardPresent) { delay(20); return; }
  if (!rfid.PICC_ReadCardSerial()) { delay(20); return; }

  String uid = uidToHex(&rfid.uid);
  unsigned long nowMs = millis();
  bool report = uid.length() > 0 && (uid != lastUid || nowMs - lastSentAt > 2500);

  if (pendingPrecheck) {
    String storedCode;
    byte readState = readStoredCodeStatus(storedCode);
    pendingPrecheck = false;
    if (readState == 2) sendLine(F("ERR:CARD_UNREADABLE"));
    else {
      sendLine(String(F("CARD:")) + uid + ":" + (readState == 1 ? storedCode : String(F("NONE"))));
      // This is a read-only card check for card assignment, not a profile lookup.
      // The website will decide whether the profile exists when it opens the code.
      if (readState != 1) pulseStatus(RGB_RED, FEEDBACK_MS);
    }
  } else if (pendingCode.length() == 10 || pendingCode.length() == 16) {
    // ── Write mode ───────────────────────────────────────────────────────────
    if (pendingUid.length() > 0 && uid != pendingUid) {
      sendLine(F("INFO:WRONG_CARD_REMOVE_AND_TAP_ORIGINAL"));
    } else if (!isClassicCard()) {
      sendLine(F("ERR:WRITE_UNSUPPORTED_CARD_USE_MIFARE_CLASSIC"));
      pendingCode = ""; pendingUid = "";
    } else {
      byte res = writeStoredCode(pendingCode);
      if (res == 0) {
        String written = pendingCode;
        pendingCode = ""; pendingUid = "";
        sendPrefixLine(F("CODE:"), written);
        sendLine(F("INFO:WRITE_OK"));
        successFeedback();
      } else if (res == 1) {
        sendLine(F("ERR:WRITE_AUTH_FAILED_CARD_NOT_DEFAULT_KEY_OR_MOVED"));
        pendingCode = ""; pendingUid = "";
      } else if (res == 2) {
        sendLine(F("ERR:WRITE_FAILED_CARD_MOVED_OR_BLOCK_LOCKED"));
        pendingCode = ""; pendingUid = "";
      } else {
        sendLine(F("ERR:WRITE_VERIFY_MISMATCH"));
        pendingCode = ""; pendingUid = "";
      }
    }
  } else if (report) {
    // ── Read mode ────────────────────────────────────────────────────────────
    String storedCode;
    if (readStoredCode(storedCode)) {
      // Send the readable code to the website and wait for its lookup result.
      // Green is shown only after PROFILE_FOUND arrives from the website.
      sendPrefixLine(F("CODE:"), storedCode);
      awaitingProfileResponse = true;
      profileResponseStartedAt = millis();
    } else {
      // A blank card UID is a valid protocol response, but not a successful
      // stored-code read, so briefly show red as requested.
      sendPrefixLine(F("UID:"), uid);
      pulseStatus(RGB_RED, FEEDBACK_MS);
    }
  }

  lastUid    = uid;
  lastSentAt = nowMs;
  rfid.PICC_HaltA();
  rfid.PCD_StopCrypto1();
  delay(120);
}
