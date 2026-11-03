'use strict';
// Biblioteca: escaneo recursivo de carpetas vigiladas, agrupación por series
// y detección en vivo de archivos nuevos o eliminados.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const chokidar = require('chokidar');
const { guessSeries } = require('../shared/series.js');

const BOOK_EXT = new Set(['.cbz', '.zip', '.cbr', '.rar', '.pdf']);
const isBook = (f) => BOOK_EXT.has(path.extname(f).toLowerCase());
const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');

// La huella identifica el libro aunque cambie de carpeta (nombre + tamaño),
// así el progreso y el historial sobreviven a mover o renombrar la carpeta.
function fingerprint(file, size) {
  return sha1(path.basename(file).toLowerCase() + '|' + size).slice(0, 20);
}

function cleanTitle(file) {
  return path.basename(file, path.extname(file)).replace(/[_]+/g, ' ').trim();
}

// Serie: la primera subcarpeta dentro de la carpeta vigilada. Si el tomo está suelto (o en una
// carpeta que solo es un número de tomo), se deduce del nombre: «Berserk 01», «Berserk 02»… -> «Berserk».
function seriesOf(root, file) {
  const rel = path.relative(root, path.dirname(file));
  const fromName = () => guessSeries(cleanTitle(file));
  if (!rel || rel === '.' || rel.startsWith('..')) return fromName();
  const parts = rel.split(path.sep);
  if (parts[0] === 'Porter - Recibidos') parts.shift();   // libros enviados desde el móvil
  const first = parts[0];
  if (!first) return fromName();
  if (/^\s*(?:vol(?:umen|ume)?|tomo|t|v|cap(?:[ií]tulo)?|ch(?:apter)?|#)?\.?\s*\d{1,4}\s*$/i.test(first)) return fromName();
  return guessSeries(first);
}

class Library {
  constructor(store, onChange) {
    this.store = store;
    this.onChange = onChange;
    this.watcher = null;
    this._notifyTimer = null;
  }

  notify() {
    clearTimeout(this._notifyTimer);
    this._notifyTimer = setTimeout(() => this.onChange(), 250);
  }

  rootFor(file) {
    return this.store.data.folders
      .filter((r) => file.startsWith(r + path.sep) || file === r)
      .sort((a, b) => b.length - a.length)[0];
  }

  async addFile(file, stat) {
    const root = this.rootFor(file);
    if (!root) return;
    stat = stat || await fsp.stat(file).catch(() => null);
    if (!stat) return;
    const id = sha1(file).slice(0, 20);
    const prev = this.store.data.books[id];
    const fp = fingerprint(file, stat.size);
    this.store.data.books[id] = {
      id, fp, path: file,
      title: cleanTitle(file),
      series: seriesOf(root, file),
      ext: path.extname(file).slice(1).toLowerCase(),
      size: stat.size,
      added: prev?.added || Date.now(),
      pages: prev?.fp === fp ? prev.pages : null,
      missing: false,
    };
    // Si en el historial existía (aunque el archivo hubiera desaparecido), se actualiza la ruta
    const h = this.store.data.history[fp];
    if (h) { h.path = file; h.available = true; }
    this.store.save();
    this.notify();
  }

  removeFile(file) {
    const id = sha1(file).slice(0, 20);
    const b = this.store.data.books[id];
    if (!b) return;
    delete this.store.data.books[id];
    const h = this.store.data.history[b.fp];
    if (h) h.available = false;   // el historial se conserva
    this.store.save();
    this.notify();
  }

  async scanFolder(root) {
    const found = new Set();
    const walk = async (dir) => {
      let entries;
      try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch (_) { return; }
      await Promise.all(entries.map(async (e) => {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) return walk(full);
        if (e.isFile() && isBook(e.name)) {
          found.add(full);
          await this.addFile(full);
        }
      }));
    };
    await walk(root);
    return found;
  }

  async rescanAll() {
    const all = new Set();
    for (const r of this.store.data.folders) {
      for (const f of await this.scanFolder(r)) all.add(f);
    }
    // Quitar de la biblioteca lo que ya no existe (queda en el historial)
    for (const b of Object.values(this.store.data.books)) {
      if (!all.has(b.path)) this.removeFile(b.path);
    }
    this.store.save();
    this.notify();
  }

  watch() {
    if (this.watcher) this.watcher.close();
    const folders = this.store.data.folders.filter((f) => fs.existsSync(f));
    if (!folders.length) return;
    this.watcher = chokidar.watch(folders, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 1500, pollInterval: 300 },
      depth: 20,
      ignored: (p) => /(^|[\\/])\../.test(p),
    });
    this.watcher
      .on('add', (f, st) => isBook(f) && this.addFile(f, st))
      .on('unlink', (f) => isBook(f) && this.removeFile(f))
      .on('unlinkDir', (d) => {
        for (const b of Object.values(this.store.data.books)) {
          if (b.path.startsWith(d + path.sep)) this.removeFile(b.path);
        }
      });
  }

  async addFolder(dir) {
    dir = path.resolve(dir);
    if (!this.store.data.folders.includes(dir)) this.store.data.folders.push(dir);
    await this.scanFolder(dir);
    this.store.save();
    this.watch();
    this.notify();
  }

  removeFolder(dir) {
    this.store.data.folders = this.store.data.folders.filter((f) => f !== dir);
    for (const b of Object.values(this.store.data.books)) {
      if (!this.rootFor(b.path)) this.removeFile(b.path);
    }
    this.store.save();
    this.watch();
    this.notify();
  }
}

module.exports = { Library, fingerprint };
