'use strict';
// Servidor de Porter para móviles y tablets en la red local.
// Solo se arranca si hay algún dispositivo emparejado o si el usuario abre el emparejado.
// Toda la comunicación posterior al emparejado va cifrada (ver src/shared/proto.mjs).
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const QRCode = require('qrcode');

let P = null;
const loadProto = async () => P || (P = await import(pathToFileURL(path.join(__dirname, '..', 'shared', 'proto.mjs')).href));

const MAX_BODY = 1024 * 1024;
const CLOCK_SKEW = 10 * 60e3;

class SyncServer {
  constructor({ store, books, readFirstPage, coversDir, rarCache, naturalCompare, onChange, onPairRequest, onPaired }) {
    Object.assign(this, { store, books, readFirstPage, coversDir, rarCache, naturalCompare, onChange, onPairRequest, onPaired });
    this.server = null;
    this.port = null;
    this.pairing = null;          // { token, expires }
    this.sas = new Map();         // sesiones de emparejado sin cámara
    this.nonces = new Map();      // nonce -> caducidad (anti-repetición)
  }

  get cfg() {
    const d = this.store.data;
    if (!d.sync) d.sync = { devices: {} };
    if (!d.sync.devices) d.sync.devices = {};
    return d.sync;
  }

  async init() {
    await loadProto();
    const c = this.cfg;
    if (!c.pcId) c.pcId = P.b64u(P.randomBytes(9));
    if (!c.keys) {
      const kp = await P.generateKeyPair();
      c.keys = { pub: P.b64u(kp.pub), priv: kp.priv };
    }
    this.store.save();
    if (Object.keys(c.devices).length) await this.start();
  }

  pcName() { return this.cfg.name || os.hostname() || 'PC'; }

  addresses() {
    if (process.env.PORTER_TEST_HOSTS) return process.env.PORTER_TEST_HOSTS.split(',');
    const out = [];
    for (const [name, list] of Object.entries(os.networkInterfaces())) {
      for (const a of list || []) {
        if (a.family !== 'IPv4' || a.internal) continue;
        if (!/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address)) continue;
        const virtual = /vEthernet|VirtualBox|VMware|Hyper-V|WSL|docker|vbox|Loopback|Tailscale|ZeroTier/i.test(name);
        out.push({ ip: a.address, score: (virtual ? 10 : 0) + (a.address.startsWith('192.168.') ? 0 : 1) });
      }
    }
    return out.sort((a, b) => a.score - b.score).map((a) => a.ip);
  }

  async start() {
    if (this.server) return this.port;
    const tryListen = (port) => new Promise((res, rej) => {
      const srv = http.createServer((q, s) => this.handle(q, s).catch((e) => {
        try { s.writeHead(500, this.cors()); s.end(String(e.message || e)); } catch (_) {}
      }));
      srv.once('error', rej);
      srv.listen(port, '0.0.0.0', () => res(srv));
    });
    const base = this.cfg.port || 47321;
    for (let p = base; p < base + 10; p++) {
      try { this.server = await tryListen(p); this.port = p; break; } catch (_) {}
    }
    if (!this.server) throw new Error('No se pudo abrir el puerto de sincronización');
    this.cfg.port = this.port;
    this.store.save();
    return this.port;
  }

  stop() { try { this.server?.close(); } catch (_) {} this.server = null; }

  cors() {
    return {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'content-type, x-porter-device',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-private-network': 'true',
      'access-control-max-age': '600',
    };
  }

  readBody(req) {
    return new Promise((res, rej) => {
      const chunks = []; let n = 0;
      req.on('data', (c) => { n += c.length; if (n > MAX_BODY) { rej(new Error('demasiado grande')); req.destroy(); } else chunks.push(c); });
      req.on('end', () => res(new Uint8Array(Buffer.concat(chunks))));
      req.on('error', rej);
    });
  }

  json(res, code, obj) {
    res.writeHead(code, { ...this.cors(), 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(obj));
  }

  async handle(req, res) {
    await loadProto();
    const url = new URL(req.url, 'http://x');
    if (req.method === 'OPTIONS') { res.writeHead(204, this.cors()); return res.end(); }
    if (url.pathname === '/porter/hello') {
      return this.json(res, 200, { app: 'porter', proto: P.PROTO_VERSION, id: this.cfg.pcId, name: this.pcName(), pairing: this.isPairing() });
    }
    if (req.method !== 'POST') return this.json(res, 404, { error: 'not found' });
    const body = await this.readBody(req);
    switch (url.pathname) {
      case '/porter/pair/qr': return this.pairQr(res, body);
      case '/porter/pair/sas/start': return this.sasStart(res, body);
      case '/porter/pair/sas/reveal': return this.sasReveal(res, body);
      case '/porter/pair/sas/status': return this.sasStatus(res, body);
      case '/porter/rpc': return this.rpc(req, res, body);
    }
    return this.json(res, 404, { error: 'not found' });
  }

  // ---------- emparejado ----------
  isPairing() { return !!(this.pairing && this.pairing.expires > Date.now()); }

  async openPairing() {
    await loadProto();
    await this.start();
    this.pairing = { token: P.randomBytes(16), expires: Date.now() + 10 * 60e3 };
    const payload = { v: 1, id: this.cfg.pcId, n: this.pcName(), h: this.addresses(), p: this.port, k: this.cfg.keys.pub, t: P.b64u(this.pairing.token) };
    const text = P.encodePairing(payload);
    const qr = await QRCode.toDataURL(text, { errorCorrectionLevel: 'M', margin: 2, width: 360, color: { dark: '#111113', light: '#ffffff' } });
    return { qr, text, name: this.pcName(), addresses: payload.h, port: this.port };
  }

  closePairing() { this.pairing = null; this.sas.clear(); if (!Object.keys(this.cfg.devices).length) this.stop(); }

  addDevice(id, name, keyRaw) {
    this.cfg.devices[id] = { name: String(name || 'Móvil').slice(0, 60), key: P.b64u(keyRaw), pairedAt: Date.now(), lastSeen: Date.now(), outbox: this.cfg.devices[id]?.outbox || [] };
    this.store.save();
    this.onPaired?.(this.cfg.devices[id].name);
    this.onChange?.();
  }

  removeDevice(id) {
    delete this.cfg.devices[id];
    this.store.save();
    if (!Object.keys(this.cfg.devices).length && !this.isPairing()) this.stop();
  }

  parse(body) { try { return JSON.parse(P.fromUtf8(body)); } catch (_) { return null; } }

  async pairQr(res, body) {
    if (!this.isPairing()) return this.json(res, 403, { error: 'pairing-closed' });
    const b = this.parse(body);
    if (!b || !b.phoneId || !b.phonePub || !b.proof) return this.json(res, 400, { error: 'bad request' });
    const phonePub = P.unb64u(b.phonePub);
    const pcPub = P.unb64u(this.cfg.keys.pub);
    const expect = await P.hmac(this.pairing.token, P.concat(P.utf8('porter-qr'), phonePub, pcPub));
    if (!P.equalBytes(expect, P.unb64u(b.proof))) return this.json(res, 403, { error: 'bad-proof' });
    const key = await P.deriveSessionKey(this.cfg.keys.priv, phonePub, this.pairing.token);
    const proof = await P.hmac(this.pairing.token, P.concat(P.utf8('porter-qr-pc'), phonePub));
    this.addDevice(String(b.phoneId).slice(0, 40), b.name, key);
    this.pairing = null;
    return this.json(res, 200, { ok: true, id: this.cfg.pcId, name: this.pcName(), proof: P.b64u(proof) });
  }

  async sasStart(res, body) {
    if (!this.isPairing()) return this.json(res, 403, { error: 'pairing-closed' });
    const b = this.parse(body);
    if (!b || !b.phoneId || !b.commit) return this.json(res, 400, { error: 'bad request' });
    for (const [k, s] of this.sas) if (s.created < Date.now() - 3 * 60e3) this.sas.delete(k);
    if (this.sas.size >= 3) return this.json(res, 429, { error: 'busy' });
    const id = P.b64u(P.randomBytes(12));
    const pcNonce = P.randomBytes(16);
    this.sas.set(id, { phoneId: String(b.phoneId).slice(0, 40), name: String(b.name || 'Móvil').slice(0, 60), commit: b.commit, pcNonce, state: 'started', created: Date.now() });
    return this.json(res, 200, { session: id, pcId: this.cfg.pcId, pcName: this.pcName(), pcPub: this.cfg.keys.pub, pcNonce: P.b64u(pcNonce) });
  }

  async sasReveal(res, body) {
    const b = this.parse(body);
    const s = b && this.sas.get(b.session);
    if (!s || s.state !== 'started') return this.json(res, 404, { error: 'no-session' });
    const phonePub = P.unb64u(b.phonePub), phoneNonce = P.unb64u(b.phoneNonce);
    const commit = P.b64u(await P.sha256(P.concat(phonePub, phoneNonce)));
    if (commit !== s.commit) { this.sas.delete(b.session); return this.json(res, 403, { error: 'bad-commit' }); }
    const pcPub = P.unb64u(this.cfg.keys.pub);
    s.code = await P.sasCode(pcPub, phonePub, s.pcNonce, phoneNonce);
    s.key = await P.deriveSessionKey(this.cfg.keys.priv, phonePub, P.concat(s.pcNonce, phoneNonce));
    s.state = 'pending';
    this.onPairRequest?.({ session: b.session, name: s.name, code: P.formatSas(s.code) });
    return this.json(res, 200, { ok: true });
  }

  answerSas(session, accept) {
    const s = this.sas.get(session);
    if (!s || s.state !== 'pending') return false;
    s.state = accept ? 'accepted' : 'rejected';
    if (accept) { this.addDevice(s.phoneId, s.name, s.key); this.pairing = null; }
    return true;
  }

  async sasStatus(res, body) {
    const b = this.parse(body);
    const s = b && this.sas.get(b.session);
    if (!s) return this.json(res, 404, { error: 'no-session' });
    if (s.state !== 'pending') setTimeout(() => this.sas.delete(b.session), 30e3);
    return this.json(res, 200, { state: s.state });
  }

  // ---------- llamadas cifradas ----------
  async rpc(req, res, body) {
    const devId = String(req.headers['x-porter-device'] || '');
    const dev = this.cfg.devices[devId];
    if (!dev) return this.json(res, 401, { error: 'unpaired' });
    const key = P.unb64u(dev.key);
    let msg;
    try { msg = JSON.parse(P.fromUtf8(await P.open(key, body, P.aadFor(devId, 'req')))); } catch (_) {
      return this.json(res, 401, { error: 'bad-key' });
    }
    const now = Date.now();
    if (!msg.ts || Math.abs(now - msg.ts) > CLOCK_SKEW) return this.json(res, 400, { error: 'clock' });
    for (const [n, exp] of this.nonces) if (exp < now) this.nonces.delete(n);
    if (!msg.n || this.nonces.has(msg.n)) return this.json(res, 400, { error: 'replay' });
    this.nonces.set(msg.n, now + 2 * CLOCK_SKEW);
    dev.lastSeen = now;

    let out;
    try { out = await this.call(devId, dev, msg.m, msg.a || {}); } catch (e) { out = P.packJson({ error: String(e.message || e) }); }
    const sealed = await P.seal(key, out, P.aadFor(devId, 'res'));
    res.writeHead(200, { ...this.cors(), 'content-type': 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(Buffer.from(sealed));
  }

  bookByFp(fp) { return Object.values(this.store.data.books).find((b) => b.fp === fp); }
  bookById(id) {
    const b = this.store.data.books[id];
    if (!b) throw new Error('Ese archivo ya no está en el PC');
    return b;
  }
  publicBook(b) { return { id: b.id, fp: b.fp, title: b.title, series: b.series, ext: b.ext, pages: b.pages, size: b.size }; }
  hasCover(fp) { return fs.existsSync(path.join(this.coversDir, fp + '.webp')); }

  async call(devId, dev, m, a) {
    const d = this.store.data;
    switch (m) {
      case 'sync': {
        if (a.deviceName) dev.name = String(a.deviceName).slice(0, 60);
        d.progress = P.mergeProgress(d.progress, a.progress || {});
        const mh = P.mergeHistory(d.history, a.history || {}, d.historyDeleted || {}, a.deleted || {});
        // Mantener disponibilidad/ruta locales del PC
        for (const [fp, e] of Object.entries(mh.history)) {
          const b = this.bookByFp(fp);
          e.available = !!b;
          if (b) e.path = b.path;
        }
        d.history = mh.history; d.historyDeleted = mh.deleted;
        // Notas de lectura del PC en libros: actualizar páginas
        this.store.save();
        this.onChange?.();
        return P.packJson({
          pcName: this.pcName(),
          progress: d.progress,
          history: P.shareableHistory(d.history),
          deleted: d.historyDeleted,
          send: this.suggestions(dev, new Set(a.localBooks || []), Math.max(0, Math.min(10, a.autoNext ?? 2))),
          onPc: Object.values(d.books).map((b) => b.fp),
        });
      }
      case 'library':
        return P.packJson({ books: Object.values(d.books).map((b) => this.publicBook(b)), covers: Object.values(d.books).filter((b) => this.hasCover(b.fp)).map((b) => b.fp) });
      case 'cover': {
        const p = path.join(this.coversDir, path.basename(String(a.fp)) + '.webp');
        return P.packBinary({ mime: 'image/webp' }, new Uint8Array(await fs.promises.readFile(p)));
      }
      case 'open': {
        const b = this.bookById(a.id);
        if (b.ext === 'pdf') return P.packJson({ ...this.publicBook(b), pages: b.pages });
        const bk = await this.books.get(b.path);
        b.pages = bk.count;
        return P.packJson({ ...this.publicBook(b), pages: bk.count });
      }
      case 'page': {
        const b = this.bookById(a.id);
        const bk = await this.books.get(b.path);
        const { data, mime } = await bk.read(Number(a.n));
        return P.packBinary({ mime, n: Number(a.n), name: bk.name(Number(a.n)) }, new Uint8Array(data));
      }
      case 'file': {
        const b = this.bookById(a.id);
        const st = await fs.promises.stat(b.path);
        const offset = Math.max(0, Number(a.offset) || 0);
        const length = Math.min(4 * 1024 * 1024, Math.max(0, Number(a.length) || 0), st.size - offset);
        const fh = await fs.promises.open(b.path, 'r');
        try {
          const buf = Buffer.alloc(Math.max(0, length));
          if (length > 0) await fh.read(buf, 0, length, offset);
          return P.packBinary({ size: st.size, offset }, new Uint8Array(buf));
        } finally { await fh.close(); }
      }
      case 'ack': {
        const done = new Set(a.fps || []);
        dev.outbox = (dev.outbox || []).filter((fp) => !done.has(fp));
        this.store.save();
        return P.packJson({ ok: true });
      }
    }
    throw new Error('Método desconocido');
  }

  // Qué debería tener el móvil: lo enviado a mano + lo que se está leyendo + los N siguientes tomos
  suggestions(dev, onPhone, autoNext) {
    const d = this.store.data;
    const out = new Map();
    const add = (b, reason) => { if (b && !onPhone.has(b.fp) && !out.has(b.fp)) out.set(b.fp, { ...this.publicBook(b), reason }); };
    for (const fp of dev.outbox || []) add(this.bookByFp(fp), 'manual');
    if (autoNext > 0) {
      const bySeries = new Map();
      for (const b of Object.values(d.books)) {
        if (!bySeries.has(b.series)) bySeries.set(b.series, []);
        bySeries.get(b.series).push(b);
      }
      for (const list of bySeries.values()) list.sort((x, y) => this.naturalCompare(x.title, y.title));
      const recent = Date.now() - 45 * 864e5;
      const reading = Object.entries(d.progress)
        .filter(([, p]) => (p.updated || 0) > recent)
        .sort((x, y) => (y[1].updated || 0) - (x[1].updated || 0))
        .slice(0, 5);
      for (const [fp, p] of reading) {
        const b = this.bookByFp(fp) || null;
        const series = b ? b.series : d.history[fp]?.series;
        const list = series && bySeries.get(series);
        if (!list) continue;
        const i = b ? list.findIndex((x) => x.fp === fp) : -1;
        if (b && !p.finished) add(b, 'reading');
        let added = 0;
        for (let k = i + 1; k < list.length && added < autoNext; k++) {
          const nb = list[k];
          if (d.progress[nb.fp]?.finished) continue;
          add(nb, 'next'); added++;
        }
      }
    }
    return [...out.values()].slice(0, 20);
  }

  queueForDevices(fps) {
    for (const dev of Object.values(this.cfg.devices)) {
      dev.outbox = [...new Set([...(dev.outbox || []), ...fps])];
    }
    this.store.save();
  }

  devicesList() {
    return Object.entries(this.cfg.devices).map(([id, x]) => ({ id, name: x.name, pairedAt: x.pairedAt, lastSeen: x.lastSeen, pending: (x.outbox || []).length }));
  }
}

module.exports = { SyncServer };
