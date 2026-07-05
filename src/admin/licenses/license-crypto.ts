/**
 * RoboCoders Studio offline activation-key crypto — server-side (Node) port of
 * admin-portal/src/App.jsx. Output is byte-identical to the browser portal and to
 * the desktop app's Node implementation (proven by admin-portal/verify-crosscompat.mjs),
 * so keys generated here verify offline inside RoboCoders Studio.
 *
 * Wire format (must match the desktop app exactly):
 *   plaintext (10 bytes) = machineId(3) | startDays(2) | expiryDays(2) | licenseNumber(3, uint24)
 *   tag (3)  = HMAC-SHA256(macKey, plaintext)[0..3]   ← tamper seal AND the AES-CTR IV
 *   wire (13) = tag(3) + AES-256-CTR(plaintext)(10)
 *   activation key = Base32(wire) grouped in 7s  →  21 characters
 */
import { createHash, createHmac, createCipheriv, timingSafeEqual } from 'crypto';

// ─── RFC 4648 Base32 ─────────────────────────────────────────────────────────
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const LOOKUP: Record<string, number> = Object.fromEntries(
  [...ALPHABET].map((c, i) => [c, i]),
);

function base32Encode(bytes: Uint8Array): string {
  let out = '';
  let bits = 0;
  let bitCount = 0;
  for (const b of bytes) {
    bits = (bits << 8) | b;
    bitCount += 8;
    while (bitCount >= 5) {
      bitCount -= 5;
      out += ALPHABET[(bits >>> bitCount) & 31];
    }
  }
  if (bitCount > 0) out += ALPHABET[(bits << (5 - bitCount)) & 31];
  return out;
}

function base32Decode(str: string): Uint8Array {
  const clean = str.replace(/[\s-]/g, '').toUpperCase();
  const out: number[] = [];
  let bits = 0;
  let bitCount = 0;
  for (const ch of clean) {
    const val = LOOKUP[ch];
    if (val === undefined) throw new Error(`Invalid Base32 character: "${ch}"`);
    bits = (bits << 5) | val;
    bitCount += 5;
    if (bitCount >= 8) {
      bitCount -= 8;
      out.push((bits >>> bitCount) & 0xff);
    }
  }
  // Canonical guard: trailing padding bits must be zero (rejects last-char tampers).
  if (bitCount > 0 && (bits & ((1 << bitCount) - 1)) !== 0) {
    throw new Error('Non-canonical Base32 (trailing padding bits set)');
  }
  return new Uint8Array(out);
}

function groupChars(str: string, size = 7): string {
  return str.match(new RegExp(`.{1,${size}}`, 'g'))!.join('-');
}

// ─── Wire format constants (must match the desktop app) ──────────────────────
const EPOCH = Date.UTC(2025, 0, 1);
const TAG_BYTES = 3;
const MACHINE_ID_BYTES = 3;
const LICENSE_BYTES = 3;
export const MAX_LICENSE_NUMBER = 99999;
const PLAINTEXT_BYTES = MACHINE_ID_BYTES + 2 + 2 + LICENSE_BYTES; // 10
const WIRE_BYTES = TAG_BYTES + PLAINTEXT_BYTES; // 13
const KEY_GROUP_SIZE = 7;

// ─── Date helpers (UTC days since 2025-01-01) ────────────────────────────────
export function dateToDays(dateStr: string): number {
  const ms = Date.parse(dateStr + 'T00:00:00Z');
  if (Number.isNaN(ms)) throw new Error('Invalid date: ' + dateStr);
  const d = Math.floor((ms - EPOCH) / 86400000);
  if (d < 0 || d > 0xffff) {
    throw new Error('Date out of range (2025-01-01 .. ~2204)');
  }
  return d;
}

export function daysToDate(days: number): string {
  return new Date(EPOCH + days * 86400000).toISOString().split('T')[0];
}

// ─── Key derivation: SHA-256(secret || 'enc') and SHA-256(secret || 'mac') ───
function deriveKeys(secret: Buffer) {
  const encKey = createHash('sha256')
    .update(Buffer.concat([secret, Buffer.from('enc')]))
    .digest();
  const macKey = createHash('sha256')
    .update(Buffer.concat([secret, Buffer.from('mac')]))
    .digest();
  return { encKey, macKey };
}

// AES-256-CTR with the 3-byte tag as the high bytes of the 16-byte IV (rest zero).
function ctrCrypt(encKey: Buffer, tag: Buffer, input: Buffer): Buffer {
  const iv = Buffer.alloc(16);
  tag.copy(iv, 0, 0, TAG_BYTES);
  const cipher = createCipheriv('aes-256-ctr', encKey, iv);
  return Buffer.concat([cipher.update(input), cipher.final()]);
}

// tag = first TAG_BYTES of HMAC-SHA256(plaintext)  (AES-SIV style: seal AND IV)
function tagOf(macKey: Buffer, plaintext: Buffer): Buffer {
  return createHmac('sha256', macKey).update(plaintext).digest().subarray(0, TAG_BYTES);
}

export interface GenerateParams {
  machineId: string;
  startDate: string; // YYYY-MM-DD
  expiryDate: string; // YYYY-MM-DD
  licenseNumber: number;
  secret: Buffer;
}

/** Generate the 21-char grouped activation key. */
export function generateActivationNumber(params: GenerateParams): string {
  const { machineId, startDate, expiryDate, licenseNumber, secret } = params;
  const id = machineId.trim().toUpperCase();
  if (!/^[0-9A-F]{16}$/.test(id)) {
    throw new Error('Machine ID must be 16 hex characters');
  }
  if (
    !Number.isInteger(licenseNumber) ||
    licenseNumber < 0 ||
    licenseNumber > MAX_LICENSE_NUMBER
  ) {
    throw new Error('License number must be an integer between 0 and 99999');
  }

  const plaintext = Buffer.alloc(PLAINTEXT_BYTES);
  for (let i = 0; i < MACHINE_ID_BYTES; i++) {
    plaintext[i] = parseInt(id.slice(i * 2, i * 2 + 2), 16);
  }
  plaintext.writeUInt16BE(dateToDays(startDate), MACHINE_ID_BYTES); // [3..5)
  plaintext.writeUInt16BE(dateToDays(expiryDate), MACHINE_ID_BYTES + 2); // [5..7)
  const lo = MACHINE_ID_BYTES + 4; // [7..10) uint24 license, big-endian
  plaintext[lo] = (licenseNumber >>> 16) & 0xff;
  plaintext[lo + 1] = (licenseNumber >>> 8) & 0xff;
  plaintext[lo + 2] = licenseNumber & 0xff;

  const { encKey, macKey } = deriveKeys(secret);
  const tag = tagOf(macKey, plaintext);
  const ciphertext = ctrCrypt(encKey, tag, plaintext);

  return groupChars(base32Encode(Buffer.concat([tag, ciphertext])), KEY_GROUP_SIZE);
}

export interface DecodeResult {
  valid: boolean;
  reason?: string;
  machineId?: string;
  startDate?: string;
  expiryDate?: string;
  licenseNumber?: number;
}

/** Decode + verify the tamper seal on an activation key. */
export function readActivationNumber(
  activationNumber: string,
  secret: Buffer,
): DecodeResult {
  let wire: Uint8Array;
  try {
    wire = base32Decode(activationNumber);
  } catch (e) {
    return { valid: false, reason: 'Invalid format: ' + (e as Error).message };
  }

  if (wire.length !== WIRE_BYTES) {
    return { valid: false, reason: 'Wrong length — not a valid activation key' };
  }

  const wireBuf = Buffer.from(wire);
  const tag = wireBuf.subarray(0, TAG_BYTES);
  const ciphertext = wireBuf.subarray(TAG_BYTES);

  const { encKey, macKey } = deriveKeys(secret);
  const plaintext = ctrCrypt(encKey, tag, ciphertext);
  const expectedTag = tagOf(macKey, plaintext);

  if (tag.length !== expectedTag.length || !timingSafeEqual(tag, expectedTag)) {
    return { valid: false, reason: 'Activation key is invalid or was modified' };
  }

  const machineId = plaintext
    .subarray(0, MACHINE_ID_BYTES)
    .toString('hex')
    .toUpperCase();
  const lo = MACHINE_ID_BYTES + 4; // [7..10) uint24 license
  const licenseNumber =
    (plaintext[lo] << 16) | (plaintext[lo + 1] << 8) | plaintext[lo + 2];

  return {
    valid: true,
    machineId,
    startDate: daysToDate(plaintext.readUInt16BE(MACHINE_ID_BYTES)),
    expiryDate: daysToDate(plaintext.readUInt16BE(MACHINE_ID_BYTES + 2)),
    licenseNumber,
  };
}

/** Resolve the shared secret (base64) from env, falling back to the known value. */
const DEFAULT_SECRET_B64 = 'uZXHVDLXN7WDOOf12G+z+bKf3xhDhTvIZdhcsGcRSxQ=';
export function getLicenseSecret(): Buffer {
  const b64 = process.env.ROBOCODERS_LICENSE_SECRET || DEFAULT_SECRET_B64;
  return Buffer.from(b64, 'base64');
}

/**
 * The build/batch number compiled into the desktop app (keys.js → LICENSE_NUMBER).
 * Every key must carry this exact value or the desktop app rejects it with
 * "license number mismatch". Change ROBOCODERS_BUILD_LICENSE_NUMBER in env
 * whenever a new desktop build is released with a different LICENSE_NUMBER.
 */
export function getBuildLicenseNumber(): number {
  const raw = process.env.ROBOCODERS_BUILD_LICENSE_NUMBER;
  if (raw !== undefined) {
    const n = parseInt(raw, 10);
    if (Number.isInteger(n) && n >= 0 && n <= MAX_LICENSE_NUMBER) return n;
  }
  return 10001; // matches openblock-desktop/src/main/license/keys.js LICENSE_NUMBER
}
