'use strict';
// Lectura de páginas de CBZ/ZIP (acceso aleatorio, sin descomprimir todo)
// y CBR/RAR (extracción progresiva a caché en disco). Los bytes de cada
// imagen se sirven tal cual: nunca se recomprimen, así la calidad es la original.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const yauzl = require('yauzl');

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif', '.bmp', '.jxl']);
const MIME = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
  '.gif': 'image/gif', '.avif': 'image/avif', '.bmp': 'image/bmp', '.jxl': 'image/jxl',
};

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const naturalSort = (a, b) => collator.compare(a, b);

function isImageName(name) {
  const base = path.posix.basename(name.replace(/\\/g, '/'));
  if (base.startsWith('.') || name.includes('__MACOSX')) return false;
  return IMAGE_EXT.has(path.extname(base).toLowerCase());
}
const mimeOf = (name) => MIME[path.extname(name).toLowerCase()] || 'application/octet-stream';

// ---------- ZIP / CBZ ----------
class ZipBook {
  constructor(file) { this.file = file; this.zip = null; this.entries = []; }

  async open() {
    this.zip = await new Promise((res, rej) =>
      yauzl.open(this.file, { lazyEntries: true, autoClose: false, decodeStrings: true }, (e, z) => e ? rej(e) : res(z)));
    const list = [];
    await new Promise((res, rej) => {
      this.zip.on('entry', (en) => {
        if (!/\/$/.test(en.fileName) && isImageName(en.fileName)) list.push(en);
        this.zip.readEntry();
      });
      this.zip.on('end', res);
      this.zip.on('error', rej);
      this.zip.readEntry();
    });
    list.sort((a, b) => naturalSort(a.fileName, b.fileName));
    this.entries = list;
    return this;
  }

  get count() { return this.entries.length; }
  name(i) { return this.entries[i]?.fileName; }

  async read(i) {
    const en = this.entries[i];
    if (!en) throw new Error('Página fuera de rango');
    const stream = await new Promise((res, rej) => this.zip.openReadStream(en, (e, s) => e ? rej(e) : res(s)));
    const chunks = [];
    for await (const c of stream) chunks.push(c);
    return { data: Buffer.concat(chunks), mime: mimeOf(en.fileName) };
  }

  close() { try { this.zip?.close(); } catch (_) {} }
}

// ---------- RAR / CBR ----------
let unrarMod = null;
function unrar() { return unrarMod || (unrarMod = require('node-unrar-js')); }

class RarBook {
  constructor(file, cacheRoot) {
    this.file = file;
    this.dir = path.join(cacheRoot, crypto.createHash('sha1').update(file).digest('hex'));
    this.names = [];
    this.ready = new Map();   // nombre -> ruta en disco
    this.waiters = new Map(); // nombre -> [resolve]
    this.failed = null;
  }

  async open() {
    const ex = await unrar().createExtractorFromFile({ filepath: this.file, targetPath: this.dir });
    const list = ex.getFileList();
    const names = [];
    for (const f of list.fileHeaders) {
      if (!f.flags.directory && isImageName(f.name)) names.push(f.name);
    }
    names.sort(naturalSort);
    this.names = names;
    // Lo ya extraído en sesiones anteriores se reutiliza
    await fsp.mkdir(this.dir, { recursive: true });
    for (const n of names) {
      const p = path.join(this.dir, n);
      if (fs.existsSync(p)) this.ready.set(n, p);
    }
    if (this.ready.size < names.length) this._extractAll();
    return this;
  }

  async _extractAll() {
    try {
      const ex = await unrar().createExtractorFromFile({ filepath: this.file, targetPath: this.dir });
      const pending = this.names.filter((n) => !this.ready.has(n));
      const { files } = ex.extract({ files: pending });
      for (const f of files) {   // el generador extrae archivo a archivo
        const n = f.fileHeader.name;
        const p = path.join(this.dir, n);
        this.ready.set(n, p);
        (this.waiters.get(n) || []).forEach((r) => r());
        this.waiters.delete(n);
        await new Promise(setImmediate); // no bloquear el proceso principal
      }
    } catch (e) {
      this.failed = e;
      for (const list of this.waiters.values()) list.forEach((r) => r());
      this.waiters.clear();
    }
  }

  get count() { return this.names.length; }
  name(i) { return this.names[i]; }

  async read(i) {
    const n = this.names[i];
    if (!n) throw new Error('Página fuera de rango');
    if (!this.ready.has(n)) {
      if (this.failed) throw this.failed;
      await new Promise((r) => {
        const l = this.waiters.get(n) || [];
        l.push(r); this.waiters.set(n, l);
      });
      if (!this.ready.has(n)) throw this.failed || new Error('No se pudo extraer');
    }
    return { data: await fsp.readFile(this.ready.get(n)), mime: mimeOf(n) };
  }

  close() {}
}

// ---------- Caché de libros abiertos (LRU) ----------
class BookCache {
  constructor(rarCacheRoot, max = 4) {
    this.root = rarCacheRoot; this.max = max; this.map = new Map();
  }

  async get(file) {
    if (this.map.has(file)) {
      const b = this.map.get(file);
      this.map.delete(file); this.map.set(file, b);
      return b;
    }
    const ext = path.extname(file).toLowerCase();
    const p = (ext === '.cbr' || ext === '.rar')
      ? new RarBook(file, this.root).open()
      : new ZipBook(file).open();
    this.map.set(file, p);
    p.catch(() => this.map.delete(file));
    while (this.map.size > this.max) {
      const [k, v] = this.map.entries().next().value;
      this.map.delete(k);
      v.then((b) => b.close()).catch(() => {});
    }
    return p;
  }

  // Limita la caché de CBR extraídos (por defecto 3 GB), borrando lo más antiguo
  async trimRarCache(maxBytes = 3 * 1024 ** 3) {
    try {
      const dirs = await fsp.readdir(this.root);
      const stats = [];
      for (const d of dirs) {
        const full = path.join(this.root, d);
        let size = 0, mtime = 0;
        const walk = async (p) => {
          for (const e of await fsp.readdir(p, { withFileTypes: true })) {
            const q = path.join(p, e.name);
            if (e.isDirectory()) await walk(q);
            else { const s = await fsp.stat(q); size += s.size; mtime = Math.max(mtime, s.mtimeMs); }
          }
        };
        await walk(full);
        stats.push({ full, size, mtime });
      }
      stats.sort((a, b) => b.mtime - a.mtime);
      let total = 0;
      for (const s of stats) {
        total += s.size;
        if (total > maxBytes) await fsp.rm(s.full, { recursive: true, force: true });
      }
    } catch (_) {}
  }
}

// Primera página + nº de páginas sin abrir el libro entero (para portadas).
// En CBR solo se extrae la primera imagen, no todo el archivo.
async function readFirstPage(file, tmpRoot) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.cbr' || ext === '.rar') {
    const tmp = path.join(tmpRoot, 'thumb-' + crypto.randomBytes(6).toString('hex'));
    try {
      const ex = await unrar().createExtractorFromFile({ filepath: file, targetPath: tmp });
      const names = [...ex.getFileList().fileHeaders]
        .filter((f) => !f.flags.directory && isImageName(f.name)).map((f) => f.name).sort(naturalSort);
      if (!names.length) throw new Error('Sin imágenes');
      const ex2 = await unrar().createExtractorFromFile({ filepath: file, targetPath: tmp });
      [...ex2.extract({ files: [names[0]] }).files];
      const data = await fsp.readFile(path.join(tmp, names[0]));
      return { data, mime: mimeOf(names[0]), count: names.length };
    } finally {
      fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
  }
  const z = await new ZipBook(file).open();
  try {
    if (!z.count) throw new Error('Sin imágenes');
    const r = await z.read(0);
    return { ...r, count: z.count };
  } finally { z.close(); }
}

module.exports = { BookCache, naturalSort, isImageName, readFirstPage };
