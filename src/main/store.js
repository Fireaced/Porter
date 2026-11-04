'use strict';
// Almacén persistente en JSON con escritura atómica y diferida.
// Guarda: carpetas vigiladas, biblioteca, progreso, historial y ajustes.
const fs = require('fs');
const path = require('path');

const DEFAULTS = () => ({
  version: 1,
  folders: [],          // rutas vigiladas
  books: {},            // id -> libro
  progress: {},         // fingerprint -> { page, total, updated, finished }
  history: {},          // fingerprint -> entrada de historial (sobrevive al archivo)
  bookmarks: {},        // id -> marcador { fp, page, color, name, thumb, title, series… }
  bookmarksDeleted: {}, // id -> fecha de borrado (para sincronizar)
  settings: {
    readMode: 'manga',  // manga | ltr | vertical
    doublePage: false,
    fit: 'height',      // height | width | original
    seriesMode: {},     // serie -> modo de lectura preferido
  },
});

class Store {
  constructor(dir) {
    this.file = path.join(dir, 'porter-data.json');
    this.data = DEFAULTS();
    this._timer = null;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const d = DEFAULTS();
      this.data = { ...d, ...raw, settings: { ...d.settings, ...(raw.settings || {}) } };
    } catch (e) {
      // Intentar la copia de seguridad si el principal está dañado
      try {
        const raw = JSON.parse(fs.readFileSync(this.file + '.bak', 'utf8'));
        this.data = { ...DEFAULTS(), ...raw };
      } catch (_) { /* primer arranque */ }
    }
  }

  save(delay = 600) {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.flush(), delay);
  }

  flush() {
    clearTimeout(this._timer);
    this._timer = null;
    const tmp = this.file + '.tmp';
    try {
      fs.writeFileSync(tmp, JSON.stringify(this.data));
      if (fs.existsSync(this.file)) {
        try { fs.copyFileSync(this.file, this.file + '.bak'); } catch (_) {}
      }
      fs.renameSync(tmp, this.file);
    } catch (e) {
      console.error('No se pudo guardar', e);
    }
  }
}

module.exports = { Store };
