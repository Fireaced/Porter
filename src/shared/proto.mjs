// Protocolo de Porter entre PC y móvil (compartido por Electron y Android).
// Solo usa WebCrypto, disponible tanto en Node 20+ como en el WebView de Android.
//
// Seguridad:
//  - Emparejado: intercambio de claves ECDH P-256. Con QR, el QR lleva la clave pública del PC
//    y un token de un solo uso que autentica la del móvil. Sin cámara, ambos muestran un código
//    de 6 cifras derivado de las dos claves (como Bluetooth); el usuario lo confirma en el PC.
//  - Después: cada petición y respuesta va cifrada y autenticada con AES-256-GCM, con marca de
//    tiempo y nonce contra repeticiones. El PC solo atiende a dispositivos emparejados.

export const PROTO_VERSION = 1;
export const DEFAULT_PORT = 47321;

const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();

// ---------- utilidades ----------
export function randomBytes(n) { return globalThis.crypto.getRandomValues(new Uint8Array(n)); }
export function concat(...parts) {
  const len = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
export function b64u(bytes) {
  let s = '';
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function unb64u(str) {
  const s = str.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '==='.slice((s.length + 3) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
export const utf8 = (s) => enc.encode(s);
export const fromUtf8 = (b) => dec.decode(b);
export async function sha256(bytes) { return new Uint8Array(await subtle.digest('SHA-256', bytes)); }
export async function hmac(keyBytes, data) {
  const k = await subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await subtle.sign('HMAC', k, data));
}
export function equalBytes(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

// ---------- claves ----------
export async function generateKeyPair() {
  const kp = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const pub = new Uint8Array(await subtle.exportKey('raw', kp.publicKey));
  const priv = await subtle.exportKey('jwk', kp.privateKey);
  return { pub, priv };
}

async function importPriv(jwk) {
  return subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
}
async function importPub(raw) {
  return subtle.importKey('raw', raw, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
}

// Clave de sesión AES-256 (bytes) a partir de ECDH + HKDF
export async function deriveSessionKey(privJwk, peerPubRaw, salt) {
  const bits = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: await importPub(peerPubRaw) }, await importPriv(privJwk), 256));
  const hk = await subtle.importKey('raw', bits, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: utf8('porter-v1-session') }, hk, 256));
}

// Código de 6 cifras para el emparejado sin cámara
export async function sasCode(pcPub, phonePub, pcNonce, phoneNonce) {
  const h = await sha256(concat(utf8('porter-sas'), pcPub, phonePub, pcNonce, phoneNonce));
  const n = ((h[0] << 24) >>> 0) + (h[1] << 16) + (h[2] << 8) + h[3];
  return String(n % 1000000).padStart(6, '0');
}
export const formatSas = (c) => `${c.slice(0, 3)} ${c.slice(3)}`;

// ---------- sobres cifrados ----------
const keyCache = new Map();
async function aesKey(raw) {
  const id = b64u(raw);
  let k = keyCache.get(id);
  if (!k) { k = await subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']); keyCache.set(id, k); }
  return k;
}
export async function seal(keyRaw, plain, aad) {
  const iv = randomBytes(12);
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, await aesKey(keyRaw), plain));
  return concat(iv, ct);
}
export async function open(keyRaw, sealed, aad) {
  const b = sealed instanceof Uint8Array ? sealed : new Uint8Array(sealed);
  if (b.length < 29) throw new Error('mensaje corto');
  return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: b.subarray(0, 12), additionalData: aad }, await aesKey(keyRaw), b.subarray(12)));
}
export const aadFor = (deviceId, dir) => utf8(`porter-v1|${deviceId}|${dir}`);

// Respuesta: 0x01 + JSON  |  0x02 + len(4) + cabecera JSON + bytes
export function packJson(obj) { return concat(new Uint8Array([1]), utf8(JSON.stringify(obj))); }
export function packBinary(header, bytes) {
  const h = utf8(JSON.stringify(header || {}));
  const len = new Uint8Array(4);
  new DataView(len.buffer).setUint32(0, h.length);
  return concat(new Uint8Array([2]), len, h, bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
}
export function unpack(b) {
  if (b[0] === 1) return { json: JSON.parse(fromUtf8(b.subarray(1))) };
  if (b[0] === 2) {
    const n = new DataView(b.buffer, b.byteOffset + 1, 4).getUint32(0);
    return { header: JSON.parse(fromUtf8(b.subarray(5, 5 + n))), bytes: b.subarray(5 + n) };
  }
  throw new Error('formato desconocido');
}

// ---------- QR ----------
export function encodePairing(p) { return 'porter:pair?d=' + b64u(utf8(JSON.stringify(p))); }
export function decodePairing(text) {
  const m = /porter:(?:\/\/)?pair\?d=([A-Za-z0-9_-]+)/.exec(String(text || '').trim());
  if (!m) return null;
  try {
    const p = JSON.parse(fromUtf8(unb64u(m[1])));
    if (!p || p.v !== PROTO_VERSION || !p.id || !p.k || !p.t || !Array.isArray(p.h)) return null;
    return p;
  } catch (_) { return null; }
}

// ---------- fusión de datos ----------
// Progreso: por libro gana el registro más reciente.
export function mergeProgress(a = {}, b = {}) {
  const out = { ...a };
  for (const [fp, r] of Object.entries(b)) {
    const l = out[fp];
    if (!l || (r.updated || 0) > (l.updated || 0)) out[fp] = { ...r };
  }
  return out;
}

const LOCAL_HISTORY_FIELDS = ['path', 'available', 'cover'];

// Historial: unión con borrados (lápidas). Los campos locales (ruta, disponibilidad) no se copian.
export function mergeHistory(local = {}, remote = {}, localDel = {}, remoteDel = {}) {
  const deleted = { ...localDel };
  for (const [fp, t] of Object.entries(remoteDel)) deleted[fp] = Math.max(deleted[fp] || 0, t);
  const out = {};
  const fps = new Set([...Object.keys(local), ...Object.keys(remote)]);
  for (const fp of fps) {
    const l = local[fp], r = remote[fp];
    let m;
    if (l && r) {
      const newer = (r.lastRead || 0) > (l.lastRead || 0) ? r : l;
      m = { ...l };
      for (const [k, v] of Object.entries(newer)) if (!LOCAL_HISTORY_FIELDS.includes(k)) m[k] = v;
      m.firstRead = Math.min(l.firstRead || Infinity, r.firstRead || Infinity);
      if (!isFinite(m.firstRead)) delete m.firstRead;
      m.lastRead = Math.max(l.lastRead || 0, r.lastRead || 0);
    } else if (l) m = { ...l };
    else {
      m = {};
      for (const [k, v] of Object.entries(r)) if (!LOCAL_HISTORY_FIELDS.includes(k)) m[k] = v;
      m.available = false;
    }
    if (deleted[fp] && (m.lastRead || 0) <= deleted[fp]) continue;
    out[fp] = m;
  }
  // Las lápidas viejas (más de 180 días) se olvidan
  const limit = Date.now() - 180 * 864e5;
  for (const [fp, t] of Object.entries(deleted)) if (t < limit) delete deleted[fp];
  return { history: out, deleted };
}

// Historial sin campos locales, para enviarlo al otro dispositivo
export function shareableHistory(h = {}) {
  const out = {};
  for (const [fp, e] of Object.entries(h)) {
    const c = {};
    for (const [k, v] of Object.entries(e)) if (!LOCAL_HISTORY_FIELDS.includes(k)) c[k] = v;
    out[fp] = c;
  }
  return out;
}
