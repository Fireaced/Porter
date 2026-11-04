// Sincronización automática con el PC y descargas de mangas.
import { PcClient } from '../../src/shared/pc-client.mjs';
import { mergeProgress, mergeHistory, shareableHistory, mergeBookmarks } from '../../src/shared/proto.mjs';
import { zipSync } from 'fflate';
import { createTarget, openHandle } from './files.js';
import { store, writeBytes, addLocalBook, deleteLocalBook, saveCoverBytes, extOfMime, remote, readBlob, b64FromBytes, rekeyBook } from './bridge.js';

const ROOT = 'porter';
const safeName = (x) => String(x || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/^[ .]+|[ .]+$/g, '').slice(0, 150) || 'Sin título';

export class SyncEngine {
  constructor() {
    this.status = { state: 'idle', text: '' };   // idle | searching | syncing | ok | offline | error
    this.clients = new Map();                     // pcId -> PcClient conectado
    this.queue = [];                              // descargas pendientes
    this.current = null;                          // descarga en curso
    this.listeners = new Set();
    this.busy = false;
  }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit() { for (const fn of this.listeners) fn(this); }
  setStatus(state, text) { this.status = { state, text }; this.emit(); }

  get pcs() { return Object.values(store.data.pcs); }
  get device() { return store.data.device; }

  addPc(pc) {
    store.data.pcs[pc.id] = pc;
    this.clients.delete(pc.id);
    store.save();
    this.emit();
  }

  removePc(id) {
    delete store.data.pcs[id];
    delete store.data.onPc[id];
    this.clients.delete(id);
    store.save();
    this.emit();
  }

  // Cliente conectado al PC (busca en la red si hace falta)
  async client(pcId, { scan = true } = {}) {
    const pc = store.data.pcs[pcId];
    if (!pc) return null;
    let c = this.clients.get(pcId);
    if (c && c.base) return c;
    c = new PcClient(pc, this.device.id);
    const ok = await c.connect({ scan });
    store.save();
    if (!ok) return null;
    this.clients.set(pcId, c);
    return c;
  }

  // Sincroniza con todos los PC emparejados que estén en la misma Wi‑Fi
  async syncAll({ scan = true, quiet = false } = {}) {
    if (this.busy || !this.pcs.length) return;
    this.busy = true;
    try {
      if (!quiet) this.setStatus('searching', 'Buscando tu PC en la Wi‑Fi…');
      let any = false;
      for (const pc of this.pcs) {
        this.clients.delete(pc.id);
        const c = await this.client(pc.id, { scan }).catch(() => null);
        if (!c) continue;
        any = true;
        this.setStatus('syncing', `Sincronizando con ${pc.name}…`);
        try { await this.syncWith(pc, c); } catch (e) {
          if (e.code === 'unpaired') { this.removePc(pc.id); this.setStatus('error', `${pc.name} ya no reconoce este móvil. Vuelve a emparejarlo.`); return; }
          throw e;
        }
      }
      if (any) this.setStatus('ok', `Sincronizado ${new Date().toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}`);
      else this.setStatus('offline', 'PC no encontrado. ¿Está encendido, con Porter abierto y en la misma Wi‑Fi?');
    } catch (e) {
      this.setStatus('error', e.message || String(e));
    } finally {
      this.busy = false;
      this.pump();
    }
  }

  async syncWith(pc, c) {
    const d = store.data;
    const res = await c.call('sync', {
      deviceName: this.device.name,
      progress: d.progress,
      history: shareableHistory(d.history),
      deleted: d.historyDeleted,
      bookmarks: d.bookmarks,
      bookmarksDeleted: d.bookmarksDeleted,
      localBooks: Object.keys(d.books),
      autoNext: d.autoNext,
    }, 30000);
    d.progress = mergeProgress(d.progress, res.progress);
    const mh = mergeHistory(d.history, res.history, d.historyDeleted, res.deleted);
    for (const [fp, e] of Object.entries(mh.history)) e.available = !!d.books[fp];
    d.history = mh.history; d.historyDeleted = mh.deleted;
    if (res.bookmarks) {
      const mb = mergeBookmarks(d.bookmarks, res.bookmarks, d.bookmarksDeleted, res.bookmarksDeleted);
      d.bookmarks = mb.bookmarks; d.bookmarksDeleted = mb.deleted;
    }
    d.onPc[pc.id] = res.onPc || [];
    pc.name = res.pcName || pc.name;
    pc.lastSync = Date.now();
    // Libros que el PC propone enviar (enviados a mano, lo que estás leyendo y los siguientes tomos)
    for (const b of res.send || []) this.enqueue(pc.id, b, true);
    // Borrar del móvil los tomos terminados (opcional)
    if (d.removeFinished) {
      for (const [fp, b] of Object.entries(d.books)) {
        const p = d.progress[fp];
        if (b.fromPc && p?.finished && Date.now() - (p.updated || 0) > 3 * 864e5) await deleteLocalBook(fp);
      }
    }
    store.save();
    store.emit();
  }

  // ---------- descargas ----------
  enqueue(pcId, book, auto = false) {
    if (store.data.books[book.fp]) return false;
    if (this.queue.some((q) => q.book.fp === book.fp) || this.current?.book.fp === book.fp) return false;
    this.queue.push({ pcId, book, auto, progress: 0 });
    this.emit();
    this.pump();
    return true;
  }

  cancel(fp) {
    this.queue = this.queue.filter((q) => q.book.fp !== fp);
    if (this.current?.book.fp === fp) this.current.cancelled = true;
    this.emit();
  }

  async pump() {
    if (this.current || !this.queue.length) return;
    const job = this.queue.shift();
    this.current = job;
    this.emit();
    try {
      await this.download(job);
      const c = this.clients.get(job.pcId);
      c?.call('ack', { fps: [job.book.fp] }).catch(() => {});
    } catch (e) {
      if (!job.cancelled) { job.error = e.message; this.setStatus('error', `No se pudo descargar «${job.book.title}»: ${e.message}`); }
      await deleteLocalBook(job.book.fp).catch(() => {});
    } finally {
      this.current = null;
      this.emit();
      setTimeout(() => this.pump(), 50);
    }
  }

  // Se descarga el archivo original por trozos de 4 MB, escribiéndolo directamente en el disco
  // (en la carpeta del móvil elegida, o en la memoria de la app).
  async download(job) {
    const c = await this.client(job.pcId);
    if (!c) throw new Error('PC no disponible');
    const b = job.book;
    const ext = b.ext === 'zip' ? 'cbz' : b.ext === 'rar' ? 'cbr' : b.ext;
    const name = safeName(b.name || `${b.title}.${ext}`);
    const d = store.data;
    const folder = d.folders.find((f) => f.uri === d.downloadTo && f.writable && !f.error);
    const sub = b.series && b.series !== b.title ? safeName(b.series) : '';
    const target = await createTarget(folder
      ? { tree: folder.uri, dir: sub, name }
      : { appPath: `${ROOT}/books/${b.fp}/${name}`, name });
    try {
      let offset = 0, size = b.size || Infinity;
      while (offset < size) {
        if (job.cancelled) throw new Error('cancelada');
        const r = await c.call('file', { id: b.id, offset, length: 4 * 1024 * 1024 }, 90000);
        size = r.header.size;
        if (!r.bytes.length && offset < size) throw new Error('El PC dejó de enviar el archivo');
        await target.append(r.bytes);
        offset += r.bytes.length;
        job.progress = size ? offset / size : 1;
        this.emit();
      }
      b.size = size;
    } catch (e) {
      await target.abort();
      throw e;
    }
    // Portada del PC (si la tiene)
    try {
      const cv = await c.call('cover', { fp: b.fp });
      if (cv.bytes?.length) await saveCoverBytes(b.fp, cv.bytes);
    } catch (_) {}
    addLocalBook({
      fp: b.fp, title: b.title, series: b.series, ext, pages: ext === 'pdf' ? b.pages : null, size: b.size,
      file: target.file, folder: folder?.uri, fromPc: job.pcId,
    });
  }

  // ---------- enviar un libro del móvil al PC ----------
  async uploadToPc(book, onProgress) {
    const pc = this.pcs[0];
    if (!pc) throw new Error('Primero empareja el móvil con tu PC');
    const c = await this.client(pc.id);
    if (!c) throw new Error('No encuentro tu PC en la Wi‑Fi. ¿Está encendido y con Porter abierto?');
    const uid = [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, '0')).join('');
    const CH = 512 * 1024;
    let res = null;
    if (book.file) {
      // Archivo original: se envía tal cual, por trozos
      const h = await openHandle(book);
      const name = book.file.name || `${book.title}.${book.ext}`;
      for (let off = 0; off < h.size; off += CH) {
        const chunk = await h.read(off, Math.min(CH, h.size - off));
        res = await c.call('put', { uid, name, series: book.series, title: book.title, offset: off, size: h.size, data: b64FromBytes(chunk), origFp: book.fp }, 60000);
        onProgress?.(Math.min(1, (off + chunk.length) / h.size));
      }
    } else {
      const dir = `${ROOT}/books/${book.dir || book.fp}`;
      let bytes, ext;
      if (book.ext === 'pdf') {
        bytes = new Uint8Array(await (await readBlob(`${dir}/${book.files[0]}`)).arrayBuffer());
        ext = 'pdf';
      } else {
        // Se rehace un CBZ con las páginas originales (sin recomprimir)
        const files = {};
        for (let i = 0; i < book.files.length; i++) {
          files[book.files[i]] = [new Uint8Array(await (await readBlob(`${dir}/${book.files[i]}`)).arrayBuffer()), { level: 0 }];
          onProgress?.(0.2 * (i + 1) / book.files.length);
        }
        bytes = zipSync(files, { level: 0 });
        ext = 'cbz';
      }
      for (let off = 0; off < bytes.length; off += CH) {
        const chunk = bytes.subarray(off, Math.min(bytes.length, off + CH));
        res = await c.call('put', { uid, name: `${book.title}.${ext}`, series: book.series, title: book.title, offset: off, size: bytes.length, data: b64FromBytes(chunk), origFp: book.fp }, 60000);
        onProgress?.(0.2 + 0.8 * Math.min(1, (off + chunk.length) / bytes.length));
      }
    }
    if (res?.fp) await rekeyBook(book.fp, res.fp, pc.id);
    await this.syncAll({ scan: false, quiet: true });
    return res;
  }

  // ---------- lectura en streaming desde el PC ----------
  async openRemote(pcId, book) {
    const c = await this.client(pcId);
    if (!c) throw new Error('No encuentro el PC en la Wi‑Fi');
    remote.client = c;
    const id = `R:${book.fp}`;
    remote.open.set(id, { ...book, pcId: book.id, id });
    return id;
  }
}

export const sync = new SyncEngine();
