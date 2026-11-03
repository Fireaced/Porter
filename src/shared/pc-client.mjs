// Cliente del PC para la app móvil (funciona también en Node para las pruebas).
import * as P from './proto.mjs';

const HELLO = '/porter/hello';

async function fetchTimeout(url, opts = {}, ms = 4000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ac.signal }); } finally { clearTimeout(t); }
}

async function postJson(base, path, obj, ms = 8000) {
  const r = await fetchTimeout(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) }, ms);
  let data = null;
  try { data = await r.json(); } catch (_) {}
  if (!r.ok) {
    const e = new Error(data?.error || ('HTTP ' + r.status));
    e.code = data?.error; throw e;
  }
  return data;
}

export async function hello(host, port, ms = 1500) {
  try {
    const r = await fetchTimeout(`http://${host}:${port}${HELLO}`, {}, ms);
    if (!r.ok) return null;
    const j = await r.json();
    return j && j.app === 'porter' ? { ...j, host, port } : null;
  } catch (_) { return null; }
}

// Busca PCs con Porter en la red local (sin cámara). onFound se llama al encontrar cada uno.
export async function scanNetwork({ hints = [], port = P.DEFAULT_PORT, onFound, onProgress, signal } = {}) {
  const subnets = [];
  const addSub = (ip) => { const m = /^(\d+\.\d+\.\d+)\.\d+$/.exec(ip || ''); if (m && !subnets.includes(m[1])) subnets.push(m[1]); };
  hints.forEach(addSub);
  ['192.168.1', '192.168.0', '192.168.2', '192.168.18', '192.168.178', '192.168.31', '192.168.68', '192.168.100', '10.0.0', '10.0.1', '192.168.3', '192.168.10', '192.168.50', '192.168.88', '10.0.2'].forEach((s) => addSub(s + '.1'));
  const found = new Map();
  const hosts = [];
  for (const h of hints) if (h && !hosts.includes(h)) hosts.push(h);
  for (const s of subnets) for (let i = 1; i < 255; i++) hosts.push(`${s}.${i}`);
  let done = 0, idx = 0;
  const ports = [port, port + 1, port + 2];
  const worker = async () => {
    while (idx < hosts.length && !signal?.aborted) {
      const h = hosts[idx++];
      const r = await hello(h, port, 700);
      done++;
      if (r && !found.has(r.id)) { found.set(r.id, r); onFound?.(r); }
      if (done % 32 === 0) onProgress?.(done / hosts.length);
    }
  };
  await Promise.all(Array.from({ length: 48 }, worker));
  // Puertos alternativos solo en los ya conocidos
  for (const h of hints) for (const p of ports.slice(1)) {
    const r = await hello(h, p, 700);
    if (r && !found.has(r.id)) { found.set(r.id, r); onFound?.(r); }
  }
  return [...found.values()];
}

// ---------- emparejado con QR ----------
export async function pairWithQr(text, { deviceId, deviceName }) {
  const q = P.decodePairing(text);
  if (!q) throw new Error('Este QR no es de Porter');
  const kp = await P.generateKeyPair();
  const token = P.unb64u(q.t);
  const pcPub = P.unb64u(q.k);
  const proof = await P.hmac(token, P.concat(P.utf8('porter-qr'), kp.pub, pcPub));
  let lastErr = new Error('No se encontró el PC en la red. ¿Estáis en la misma Wi‑Fi?');
  for (const host of q.h) {
    const base = `http://${host}:${q.p}`;
    try {
      const r = await postJson(base, '/porter/pair/qr', { phoneId: deviceId, name: deviceName, phonePub: P.b64u(kp.pub), proof: P.b64u(proof) }, 5000);
      const expect = await P.hmac(token, P.concat(P.utf8('porter-qr-pc'), kp.pub));
      if (!P.equalBytes(expect, P.unb64u(r.proof))) throw new Error('Respuesta del PC no válida');
      const key = await P.deriveSessionKey(kp.priv, pcPub, token);
      return { id: q.id, name: q.n, hosts: [host, ...q.h.filter((h) => h !== host)], port: q.p, key: P.b64u(key), pairedAt: Date.now() };
    } catch (e) {
      if (e.code === 'pairing-closed') lastErr = new Error('El código ha caducado. Vuelve a abrir «Emparejar» en el PC.');
      else if (e.code === 'bad-proof') lastErr = new Error('El código no es válido. Vuelve a abrir «Emparejar» en el PC.');
      else if (e.name !== 'AbortError' && !/fetch|network|Failed/i.test(e.message)) lastErr = e;
    }
  }
  throw lastErr;
}

// ---------- emparejado sin cámara (código de 6 cifras) ----------
export async function sasBegin(host, port, { deviceId, deviceName }) {
  const base = `http://${host}:${port}`;
  const kp = await P.generateKeyPair();
  const nonce = P.randomBytes(16);
  const commit = P.b64u(await P.sha256(P.concat(kp.pub, nonce)));
  let s;
  try { s = await postJson(base, '/porter/pair/sas/start', { phoneId: deviceId, name: deviceName, commit }); } catch (e) {
    if (e.code === 'pairing-closed') throw new Error('En el PC abre Ajustes → «Emparejar un móvil o tablet» y vuelve a intentarlo.');
    throw e;
  }
  await postJson(base, '/porter/pair/sas/reveal', { session: s.session, phonePub: P.b64u(kp.pub), phoneNonce: P.b64u(nonce) });
  const pcPub = P.unb64u(s.pcPub), pcNonce = P.unb64u(s.pcNonce);
  const code = await P.sasCode(pcPub, kp.pub, pcNonce, nonce);
  return {
    code: P.formatSas(code),
    pcName: s.pcName,
    // Espera a que el usuario acepte en el PC
    async wait({ signal } = {}) {
      const until = Date.now() + 3 * 60e3;
      while (Date.now() < until && !signal?.aborted) {
        const st = await postJson(base, '/porter/pair/sas/status', { session: s.session }).catch(() => ({ state: 'pending' }));
        if (st.state === 'accepted') {
          const key = await P.deriveSessionKey(kp.priv, pcPub, P.concat(pcNonce, nonce));
          return { id: s.pcId, name: s.pcName, hosts: [host], port, key: P.b64u(key), pairedAt: Date.now() };
        }
        if (st.state === 'rejected') throw new Error('Se rechazó en el PC: los números no coincidían.');
        await new Promise((r) => setTimeout(r, 1200));
      }
      throw new Error('Tiempo agotado. Vuelve a intentarlo.');
    },
  };
}

// ---------- llamadas cifradas ----------
export class PcClient {
  constructor(pc, deviceId) {
    this.pc = pc; this.deviceId = deviceId;
    this.key = P.unb64u(pc.key);
    this.base = null;
  }

  // Encuentra el PC en la red actual (prueba las direcciones conocidas y, si no, escanea la subred)
  async connect({ scan = true } = {}) {
    const tryHost = async (h, port = this.pc.port) => {
      const r = await hello(h, port, 1500);
      return r && r.id === this.pc.id ? `http://${h}:${port}` : null;
    };
    for (const h of this.pc.hosts) { const b = await tryHost(h); if (b) return this.setBase(b, h); }
    if (!scan) return null;
    let hit = null;
    const ac = new AbortController();
    await scanNetwork({ hints: this.pc.hosts, port: this.pc.port, signal: ac.signal, onFound: (r) => { if (r.id === this.pc.id && !hit) { hit = r; ac.abort(); } } });
    if (hit) return this.setBase(`http://${hit.host}:${hit.port}`, hit.host, hit.port);
    return null;
  }

  setBase(base, host, port) {
    this.base = base;
    this.pc.hosts = [host, ...this.pc.hosts.filter((h) => h !== host)].slice(0, 6);
    if (port) this.pc.port = port;
    return base;
  }

  async call(m, a = {}, ms = 20000) {
    if (!this.base) throw new Error('PC no conectado');
    const plain = P.utf8(JSON.stringify({ m, a, ts: Date.now(), n: P.b64u(P.randomBytes(12)) }));
    const body = await P.seal(this.key, plain, P.aadFor(this.deviceId, 'req'));
    const r = await fetchTimeout(this.base + '/porter/rpc', { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-porter-device': this.deviceId }, body }, ms);
    if (r.status === 401) { const e = new Error('Este dispositivo ya no está emparejado con el PC'); e.code = 'unpaired'; throw e; }
    if (!r.ok) {
      let j = null; try { j = await r.json(); } catch (_) {}
      const e = new Error(j?.error === 'clock' ? 'La hora del móvil y la del PC no coinciden' : (j?.error || 'HTTP ' + r.status));
      e.code = j?.error; throw e;
    }
    const out = P.unpack(await P.open(this.key, new Uint8Array(await r.arrayBuffer()), P.aadFor(this.deviceId, 'res')));
    if (out.json && out.json.error) throw new Error(out.json.error);
    return out.json !== undefined ? out.json : out;
  }

  async pageBlob(id, n) {
    const r = await this.call('page', { id, n });
    return new Blob([r.bytes], { type: r.header.mime || 'application/octet-stream' });
  }

  async fileBytes(id, onProgress) {
    const CH = 4 * 1024 * 1024;
    let offset = 0, size = Infinity;
    const parts = [];
    while (offset < size) {
      const r = await this.call('file', { id, offset, length: CH }, 60000);
      size = r.header.size;
      parts.push(r.bytes);
      offset += r.bytes.length;
      onProgress?.(offset / size);
      if (!r.bytes.length) break;
    }
    return new Blob(parts, { type: 'application/pdf' });
  }
}
