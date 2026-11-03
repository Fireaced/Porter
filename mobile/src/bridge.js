// Puente de Porter para Android: implementa la misma API window.porter que usa la versión de PC,
// pero con almacenamiento local del móvil (Capacitor Filesystem).
import { Capacitor } from '@capacitor/core';
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { mergeProgress } from '../../src/shared/proto.mjs';
import { guessSeries } from '../../src/shared/series.js';
import { PorterFiles, openHandle, bookReader, forgetReader } from './files.js';

const ROOT = 'porter';
const DATA_FILE = `${ROOT}/data.json`;
const native = Capacitor.isNativePlatform();

const DEFAULTS = () => ({
  version: 1,
  books: {},           // id -> libro descargado o importado
  progress: {},
  history: {},
  historyDeleted: {},
  settings: { readMode: 'manga', doublePage: false, fit: 'height', seriesMode: {}, preload: 10 },
  pcs: {},             // PCs emparejados
  device: null,        // { id, name }
  autoNext: 2,
  removeFinished: false,
  onPc: {},            // pcId -> [fp] (qué hay en cada PC, para "Está en el PC")
  pcBooks: {},         // fp -> datos del libro en el PC (título, serie...)
  folders: [],         // carpetas del móvil elegidas por el usuario: { uri, name, writable, error }
  downloadTo: null,    // uri de la carpeta donde guardar lo que llega del PC (null = memoria de la app)
});

// ---------- utilidades de archivos ----------
export function b64FromBytes(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function bytesFromB64(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif', bmp: 'image/bmp', pdf: 'application/pdf' };
export const extOfMime = (m) => ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif', 'image/bmp': 'bmp' }[m] || 'jpg');

let rootUri = null;
let immersive = false;
const fullListeners = [];
export async function writeBytes(path, bytes) {
  await Filesystem.writeFile({ path, directory: Directory.Data, data: b64FromBytes(bytes), recursive: true });
}
export async function readBlob(path) {
  const ext = path.split('.').pop().toLowerCase();
  if (native && rootUri) {
    const r = await fetch(Capacitor.convertFileSrc(`${rootUri}/${path.slice(ROOT.length + 1)}`));
    if (!r.ok) throw new Error('No se pudo leer ' + path);
    return r.blob();
  }
  const r = await Filesystem.readFile({ path, directory: Directory.Data });
  return new Blob([typeof r.data === 'string' ? bytesFromB64(r.data) : r.data], { type: MIME[ext] || 'application/octet-stream' });
}
export async function removeDir(path) {
  try { await Filesystem.rmdir({ path, directory: Directory.Data, recursive: true }); } catch (_) {}
}
export async function sha1Hex(text) {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text)));
  return [...h].map((b) => b.toString(16).padStart(2, '0')).join('');
}
// Misma huella que en el PC: nombre de archivo + tamaño
export async function fingerprint(fileName, size) {
  return (await sha1Hex(fileName.toLowerCase() + '|' + size)).slice(0, 20);
}

// ---------- estado ----------
class MobileStore {
  constructor() { this.data = DEFAULTS(); this._t = null; this.listeners = []; }
  async load() {
    try {
      const r = await Filesystem.readFile({ path: DATA_FILE, directory: Directory.Data, encoding: Encoding.UTF8 });
      const raw = JSON.parse(r.data);
      const d = DEFAULTS();
      this.data = { ...d, ...raw, settings: { ...d.settings, ...(raw.settings || {}) } };
    } catch (_) { /* primer arranque */ }
    try { rootUri = (await Filesystem.getUri({ path: ROOT, directory: Directory.Data })).uri; } catch (_) {}
  }
  save(delay = 500) {
    clearTimeout(this._t);
    this._t = setTimeout(() => this.flush(), delay);
  }
  async flush() {
    clearTimeout(this._t);
    await Filesystem.writeFile({ path: DATA_FILE + '.tmp', directory: Directory.Data, data: JSON.stringify(this.data), encoding: Encoding.UTF8, recursive: true });
    try { await Filesystem.deleteFile({ path: DATA_FILE, directory: Directory.Data }); } catch (_) {}
    await Filesystem.rename({ from: DATA_FILE + '.tmp', to: DATA_FILE, directory: Directory.Data });
  }
  emit() { const snap = snapshot(); this.listeners.forEach((fn) => fn(snap)); }
}

export const store = new MobileStore();
const coverUrls = new Map();   // fp -> URL utilizable por <img>
export const remote = { open: new Map(), client: null };  // libros abiertos en streaming desde el PC

function snapshot() {
  const d = store.data;
  return { books: d.books, progress: d.progress, history: d.history, settings: d.settings, folders: [], covers: [...coverUrls.keys()] };
}

async function loadCovers() {
  try {
    const list = await Filesystem.readdir({ path: `${ROOT}/covers`, directory: Directory.Data });
    for (const f of list.files) {
      const name = typeof f === 'string' ? f : f.name;
      if (!name.endsWith('.webp')) continue;
      const fp = name.slice(0, -5);
      if (native && rootUri) coverUrls.set(fp, Capacitor.convertFileSrc(`${rootUri}/covers/${name}`));
      else coverUrls.set(fp, URL.createObjectURL(await readBlob(`${ROOT}/covers/${name}`)));
    }
  } catch (_) {}
}

export async function saveCoverBytes(fp, bytes) {
  await writeBytes(`${ROOT}/covers/${fp}.webp`, bytes);
  if (native && rootUri) coverUrls.set(fp, Capacitor.convertFileSrc(`${rootUri}/covers/${fp}.webp`) + `?v=${Date.now()}`);
  else coverUrls.set(fp, URL.createObjectURL(new Blob([bytes], { type: 'image/webp' })));
  const h = store.data.history[fp]; if (h) h.cover = true;
}

export function touchHistory(meta, page, total) {
  const now = Date.now();
  const h = store.data.history[meta.fp] || { fp: meta.fp, firstRead: now };
  Object.assign(h, { title: meta.title, series: meta.series, ext: meta.ext, size: meta.size, lastRead: now, available: !!store.data.books[meta.fp] });
  if (page != null) { h.page = page; h.total = total; h.finished = total > 0 && page >= total - 1; }
  store.data.history[meta.fp] = h;
}

export function addLocalBook(meta) {
  store.data.books[meta.fp] = { ...meta, id: meta.fp, added: meta.added || Date.now() };
  const h = store.data.history[meta.fp]; if (h) h.available = true;
  store.save(); store.emit();
}

export async function deleteLocalBook(fp) {
  const b = store.data.books[fp];
  if (!b) return;
  delete store.data.books[fp];
  const h = store.data.history[fp]; if (h) h.available = false;
  forgetReader(fp);
  if (b.file?.kind === 'saf') await PorterFiles.delete({ uri: b.file.uri }).catch(() => {});
  else await removeDir(`${ROOT}/books/${b.dir || fp}`);
  store.save(); store.emit();
}

// ---------- carpetas del móvil ----------
// Los archivos se leen directamente de la carpeta (no se copian). Se vuelve a mirar al abrir la app.
let scanning = null;
export function scanFolders() {
  if (!scanning) scanning = doScan().finally(() => { scanning = null; });
  return scanning;
}
async function doScan() {
  const d = store.data;
  let changed = false;
  for (const folder of d.folders) {
    let files;
    try {
      const ok = (await PorterFiles.check({ uri: folder.uri })).ok;
      if (!ok) throw new Error('Sin permiso');
      files = (await PorterFiles.list({ uri: folder.uri })).files;
      if (folder.error) { delete folder.error; changed = true; }
    } catch (e) {
      if (!folder.error) changed = true;
      folder.error = 'Porter ya no tiene permiso para esta carpeta. Quítala y vuelve a añadirla.';
      continue;
    }
    const byUri = new Map(Object.values(d.books).filter((b) => b.folder === folder.uri).map((b) => [b.file.uri, b]));
    const seen = new Set();
    for (const f of files) {
      const prev = byUri.get(f.uri);
      if (prev && prev.size === f.size) { seen.add(prev.fp); continue; }
      const fp = await fingerprint(f.name, f.size);
      if (prev) { delete d.books[prev.fp]; forgetReader(prev.fp); }
      if (d.books[fp] && d.books[fp].folder !== folder.uri) continue;   // ya está (importado o en otra carpeta)
      const title = f.name.replace(/\.[^.]+$/, '').replace(/_+/g, ' ').trim();
      const first = (f.dir || '').split('/')[0];
      const series = first && !/^\s*(?:vol(?:umen|ume)?|tomo|t|v|#)?\.?\s*\d{1,4}\s*$/i.test(first) ? guessSeries(first) : guessSeries(title);
      const ext = (f.name.split('.').pop() || '').toLowerCase();
      d.books[fp] = {
        fp, id: fp, title, series, ext: ext === 'zip' ? 'cbz' : ext === 'rar' ? 'cbr' : ext,
        size: f.size, pages: d.books[fp]?.pages || null, added: d.books[fp]?.added || Date.now(),
        file: { kind: 'saf', uri: f.uri, name: f.name }, folder: folder.uri, fromPc: d.books[fp]?.fromPc,
      };
      const h = d.history[fp]; if (h) h.available = true;
      seen.add(fp); changed = true;
    }
    for (const b of byUri.values()) {
      if (seen.has(b.fp)) continue;
      delete d.books[b.fp]; forgetReader(b.fp);
      const h = d.history[b.fp]; if (h) h.available = false;
      changed = true;
    }
  }
  // Libros de carpetas que ya no están en la lista
  const uris = new Set(d.folders.map((f) => f.uri));
  for (const b of Object.values(d.books)) {
    if (b.folder && !uris.has(b.folder)) { delete d.books[b.fp]; const h = d.history[b.fp]; if (h) h.available = false; changed = true; }
  }
  if (changed) { store.save(); store.emit(); }
  return changed;
}

export async function addPhoneFolder() {
  const r = await PorterFiles.pickFolder();
  const d = store.data;
  if (!d.folders.some((f) => f.uri === r.uri)) d.folders.push({ uri: r.uri, name: r.name || 'Carpeta', writable: r.writable !== false });
  if (!d.downloadTo && r.writable !== false) d.downloadTo = r.uri;
  store.save();
  await scanFolders();
  store.emit();
  return r;
}

export async function removePhoneFolder(uri) {
  const d = store.data;
  d.folders = d.folders.filter((f) => f.uri !== uri);
  if (d.downloadTo === uri) d.downloadTo = d.folders.find((f) => f.writable && !f.error)?.uri || null;
  await scanFolders();
  store.save(); store.emit();
}

// Tras enviar un libro al PC, el PC asigna su propia huella al archivo: se reasigna aquí para
// que el progreso y el historial queden vinculados en los dos dispositivos.
export async function rekeyBook(oldFp, newFp, pcId) {
  const d = store.data;
  const b = d.books[oldFp];
  if (!b || oldFp === newFp) { if (b) { b.fromPc = pcId; store.save(); } return; }
  d.books[newFp] = { ...b, fp: newFp, id: newFp, dir: b.dir || oldFp, fromPc: pcId };
  delete d.books[oldFp];
  if (d.progress[oldFp] && !(d.progress[newFp]?.updated > d.progress[oldFp].updated)) d.progress[newFp] = d.progress[oldFp];
  delete d.progress[oldFp];
  if (d.history[oldFp]) { d.history[newFp] = { ...d.history[oldFp], fp: newFp, available: true }; delete d.history[oldFp]; }
  if (coverUrls.has(oldFp)) {
    try { await Filesystem.rename({ from: `${ROOT}/covers/${oldFp}.webp`, to: `${ROOT}/covers/${newFp}.webp`, directory: Directory.Data }); } catch (_) {}
    coverUrls.delete(oldFp);
    if (native && rootUri) coverUrls.set(newFp, Capacitor.convertFileSrc(`${rootUri}/covers/${newFp}.webp`) + `?v=${Date.now()}`);
    else { try { coverUrls.set(newFp, URL.createObjectURL(await readBlob(`${ROOT}/covers/${newFp}.webp`))); } catch (_) {} }
  }
  store.save(); store.emit();
}

const bookFromId = (id) => {
  if (String(id).startsWith('R:')) return remote.open.get(id);
  return store.data.books[id];
};

// ---------- API window.porter ----------
const api = {
  platform: 'android',
  pdfjsBase: './pdfjs/',
  getLibrary: async () => snapshot(),
  addFolder: async () => snapshot(),        // en Android se usa "Importar" (ver ext.js)
  addFolderPath: async () => snapshot(),
  removeFolder: async () => snapshot(),
  rescan: async () => snapshot(),

  openBook: async (id) => {
    const b = bookFromId(id);
    if (!b) throw new Error('Este archivo ya no está en el móvil');
    if (String(id).startsWith('R:')) {
      const info = await remote.client.call('open', { id: b.pcId });
      b.pages = info.pages;
    } else if (b.file && b.ext !== 'pdf') {
      b.pages = (await bookReader(b)).count;
    }
    touchHistory(b);
    store.save();
    return { book: { ...b, id }, pages: b.ext === 'pdf' ? null : b.pages, progress: store.data.progress[b.fp] || null };
  },
  setPages: async (id, total) => { const b = bookFromId(id); if (b) { b.pages = total; store.save(); } },
  setProgress: async (id, page, total) => {
    const b = bookFromId(id);
    if (!b) return;
    store.data.progress[b.fp] = { page, total, updated: Date.now(), finished: total > 0 && page >= total - 1 };
    b.pages = total;
    touchHistory(b, page, total);
    store.save();
  },
  resetProgress: async (fp) => {
    store.data.progress[fp] = { page: 0, total: store.data.progress[fp]?.total || 0, updated: Date.now(), finished: false };
    const h = store.data.history[fp]; if (h) { h.page = 0; h.finished = false; }
    store.save(); return snapshot();
  },
  removeHistory: async (fp) => {
    delete store.data.history[fp];
    store.data.historyDeleted[fp] = Date.now();
    store.save(); return snapshot();
  },
  clearHistory: async () => {
    const now = Date.now();
    for (const fp of Object.keys(store.data.history)) store.data.historyDeleted[fp] = now;
    store.data.history = {};
    store.save(); return snapshot();
  },
  hasCover: async (fp) => coverUrls.has(fp),
  saveCover: async (fp, buf) => { await saveCoverBytes(fp, new Uint8Array(buf)); return true; },
  setSettings: async (patch) => { Object.assign(store.data.settings, patch); store.save(); return store.data.settings; },
  reveal: async () => {},
  // Pantalla completa: en Android se ocultan las barras del sistema (el modo del navegador no hace nada)
  fullscreen: async (v) => {
    const on = v ?? !immersive;
    if (on === immersive) return immersive;
    try { await PorterFiles.immersive({ on }); immersive = on; } catch (_) {}
    document.body.classList.toggle('immersive', immersive);
    fullListeners.forEach((fn) => fn(immersive));
    return immersive;
  },
  onLibrary: (fn) => store.listeners.push(fn),
  onFullscreen: (fn) => fullListeners.push(fn),

  // Recursos de los libros
  coverURL: (fp) => coverUrls.get(fp) || '',
  pageBlob: async (id, i) => {
    if (String(id).startsWith('R:')) return remote.client.pageBlob(remote.open.get(id).pcId, i);
    const b = store.data.books[id];
    if (b.file) return (await bookReader(b)).blob(i);
    return readBlob(`${ROOT}/books/${b.dir || b.fp}/${b.files[i]}`);
  },
  thumbBlob: async (book) => api.pageBlob(book.id, 0),
  pdfSource: async (id) => {
    if (String(id).startsWith('R:')) {
      // PDF del PC: se piden al PC solo los trozos que se van leyendo
      const b = remote.open.get(id), c = remote.client;
      let size = b.size;
      if (!size) size = (await c.call('file', { id: b.pcId, offset: 0, length: 0 })).header.size;
      return { reader: { size, read: async (offset, length) => {
        const out = new Uint8Array(length);
        let got = 0;
        while (got < length) {
          const part = (await c.call('file', { id: b.pcId, offset: offset + got, length: Math.min(4 * 1024 * 1024, length - got) }, 60000)).bytes;
          if (!part.length) break;
          out.set(part, got); got += part.length;
        }
        return got < length ? out.subarray(0, got) : out;
      } } };
    }
    const b = store.data.books[id];
    if (b.file) return { reader: await openHandle(b) };
    if (native && rootUri) return { url: Capacitor.convertFileSrc(`${rootUri}/books/${b.dir || b.fp}/${b.files[0]}`) };
    return { data: new Uint8Array(await (await readBlob(`${ROOT}/books/${b.dir || b.fp}/${b.files[0]}`)).arrayBuffer()) };
  },

  // Reportes de fallos: mismo formulario que el PC
  reportAvailable: async () => true,
  reportInfo: async (ctx) => reportInfo(ctx),
  sendReport: async (input) => sendReport(input),
  logError: (msg) => { errorLog.push(`[${new Date().toISOString()}] ${String(msg).slice(0, 600)}`); if (errorLog.length > 40) errorLog.shift(); },
};

// ---------- reportes ----------
import FORM from '../../src/main/report-config.json';
const errorLog = [];
const APP_VERSION = typeof __PORTER_VERSION__ !== 'undefined' ? __PORTER_VERSION__ : 'dev';
function reportInfo(ctx) {
  const d = store.data;
  const exts = {};
  for (const b of Object.values(d.books)) exts[b.ext] = (exts[b.ext] || 0) + 1;
  const lines = [
    `Porter Android ${APP_VERSION}`,
    `Dispositivo: ${navigator.userAgent.replace(/\(([^)]*)\)/, (m, g) => `(${g.split(';').slice(0, 3).join(';')})`)}`,
    `Pantalla: ${screen.width}x${screen.height} @${devicePixelRatio}x`,
    `Biblioteca: ${Object.keys(d.books).length} archivos ${JSON.stringify(exts)}, ${Object.keys(d.pcs).length} PC emparejados`,
    `Ajustes: ${JSON.stringify({ ...d.settings, seriesMode: undefined, autoNext: d.autoNext })}`,
  ];
  if (ctx) lines.push(`Lector: ${JSON.stringify(ctx)}`);
  if (errorLog.length) lines.push('', 'Errores recientes:', ...errorLog);
  return lines.join('\n').replace(/(file|https?):\/\/[^\s"]+/g, '<ruta>');
}
let lastReport = 0;
async function sendReport(input) {
  if (Date.now() - lastReport < 30e3) return { ok: false, error: 'Espera unos segundos antes de enviar otro reporte.' };
  lastReport = Date.now();
  const f = FORM.fields;
  const body = new URLSearchParams();
  const put = (k, v) => { if (f[k] && v) body.append(f[k], String(v).slice(0, 20000)); };
  put('type', input.type === 'sugerencia' ? 'Sugerencia' : 'Fallo');
  put('description', input.description); put('steps', input.steps); put('contact', input.contact);
  put('version', 'Android ' + APP_VERSION);
  put('details', input.includeInfo ? reportInfo(input.context) : '');
  try {
    await fetch(`https://docs.google.com/forms/d/e/${FORM.formId}/formResponse`, { method: 'POST', mode: 'no-cors', body });
    return { ok: true };
  } catch (_) { return { ok: false, error: 'No hay conexión a internet. Inténtalo más tarde.' }; }
}

window.addEventListener('error', (e) => api.logError(`${e.message} @ ${(e.filename || '').split('/').pop()}:${e.lineno}`));
window.addEventListener('unhandledrejection', (e) => api.logError('Promesa: ' + (e.reason?.stack || e.reason)));

export async function initBridge() {
  await store.load();
  await loadCovers();
  if (!store.data.device) {
    const id = [...crypto.getRandomValues(new Uint8Array(9))].map((b) => b.toString(16).padStart(2, '0')).join('');
    let name = 'Android';
    try { const { Device } = await import('@capacitor/device'); const i = await Device.getInfo(); name = i.name || [i.manufacturer, i.model].filter(Boolean).join(' ') || name; } catch (_) {}
    store.data.device = { id, name };
    store.save();
  }
  window.porter = api;
}

export { snapshot, mergeProgress };
