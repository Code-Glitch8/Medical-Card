// Usage: node verify-asar.mjs <app.asar>
// Validates an Electron ASAR archive the same way Electron reads it (Chromium pickle header), then checks every
// file's offset/size and SHA-256 integrity entry. Exit code 1 on any problem. No dependencies.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const file = process.argv[2];
if (!file) { console.error('Usage: node verify-asar.mjs <app.asar>'); process.exit(2); }
const buf = readFileSync(file);
const fail = (m) => { console.error('INVALID ASAR: ' + m); process.exit(1); };

if (buf.length < 16) fail('file too small');
if (buf.readUInt32LE(0) !== 4) fail('size-pickle payload length must be 4');
const headerSize = buf.readUInt32LE(4);                       // length of the header pickle
if (8 + headerSize > buf.length) fail('header size exceeds file');
const payloadSize = buf.readUInt32LE(8);                      // header pickle: payload length
if (payloadSize !== headerSize - 4) fail(`header pickle payload ${payloadSize} != headerSize-4 (${headerSize - 4})`);
const jsonLen = buf.readUInt32LE(12);                         // header pickle: string length prefix
if (jsonLen > payloadSize - 4) fail(`JSON length ${jsonLen} exceeds pickle payload`);
let header;
try { header = JSON.parse(buf.subarray(16, 16 + jsonLen).toString('utf8')); } catch (e) { fail('header JSON does not parse: ' + e.message); }

const base = 8 + headerSize;
let count = 0, bad = 0;
(function walk(node, p) {
  for (const [name, v] of Object.entries(node.files || {})) {
    const path = p + name;
    if (v.files) { walk(v, path + '/'); continue; }
    count++;
    if (v.unpacked) continue;
    const off = base + Number(v.offset), end = off + v.size;
    if (!(off >= base && end <= buf.length)) { console.error('out of range: ' + path); bad++; continue; }
    if (v.integrity) {
      const h = createHash('sha256').update(buf.subarray(off, end)).digest('hex');
      if (h !== v.integrity.hash) { console.error('hash mismatch: ' + path); bad++; }
    }
  }
})(header, '');
if (!header.files || !header.files['package.json']) fail('package.json missing from archive');
if (bad) fail(`${bad} file problem(s)`);
console.log(`OK: valid ASAR, ${count} files, header ${headerSize} bytes`);
