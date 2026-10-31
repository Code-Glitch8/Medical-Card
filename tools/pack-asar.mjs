// Usage: node pack-asar.mjs <stageDir> <out.asar>
// Minimal, dependency-free ASAR writer producing the exact header layout Electron expects
// (size pickle + header pickle with a length-prefixed JSON string, 4-byte aligned) plus SHA-256 integrity data.
// Official releases are built by electron-builder; this exists for offline repair/verification only.
import { readdirSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const [stage, out] = process.argv.slice(2);
if (!stage || !out) { console.error('Usage: node pack-asar.mjs <stageDir> <out.asar>'); process.exit(2); }
const BLOCK = 4 * 1024 * 1024;
const chunks = []; let offset = 0;

function build(dir) {
  const files = {};
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name), st = statSync(full);
    if (st.isDirectory()) { files[name] = { files: build(full) }; continue; }
    const data = readFileSync(full);
    const blocks = []; for (let i = 0; i < data.length; i += BLOCK) blocks.push(createHash('sha256').update(data.subarray(i, i + BLOCK)).digest('hex'));
    files[name] = { size: data.length, offset: String(offset),
      integrity: { algorithm: 'SHA256', hash: createHash('sha256').update(data).digest('hex'), blockSize: BLOCK, blocks } };
    chunks.push(data); offset += data.length;
  }
  return files;
}
const header = { files: build(stage) };
const json = Buffer.from(JSON.stringify(header), 'utf8');
const aligned = (json.length + 3) & ~3;
const payload = 4 + aligned;                                   // string length prefix + padded characters
const headerPickle = Buffer.alloc(4 + payload);                // pickle header (payload size) + payload
headerPickle.writeUInt32LE(payload, 0); headerPickle.writeUInt32LE(json.length, 4); json.copy(headerPickle, 8);
const sizePickle = Buffer.alloc(8); sizePickle.writeUInt32LE(4, 0); sizePickle.writeUInt32LE(headerPickle.length, 4);
writeFileSync(out, Buffer.concat([sizePickle, headerPickle, ...chunks]));
console.log(`Wrote ${out}`);
