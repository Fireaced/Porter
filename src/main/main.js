'use strict';
const { app, BrowserWindow, ipcMain, dialog, protocol, shell, net } = require('electron');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { pathToFileURL } = require('url');
const { Store } = require('./store');
const { Library } = require('./library');
const { BookCache, readFirstPage } = require('./archives');
const report = require('./report');

process.on('uncaughtException', (e) => { report.logError('main', e && e.stack || e); console.error(e); });
process.on('unhandledRejection', (e) => report.logError('main', e && e.stack || e));

// Se usan los ajustes de GPU por defecto de Chromium: forzar la GPU en drivers vetados
// ('ignore-gpu-blocklist', 'enable-zero-copy') puede dejar la pantalla sin refrescar en algunos equipos.

protocol.registerSchemesAsPrivileged([{
  scheme: 'porter',
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true },
}]);

if (process.env.PORTER_USER_DATA) app.setPath('userData', process.env.PORTER_USER_DATA);
if (!app.requestSingleInstanceLock()) app.quit();

let win, store, library, books;
const ROOT = path.join(__dirname, '..', '..');
const RENDERER = path.join(ROOT, 'src', 'renderer');
const PDFJS = path.join(ROOT, 'node_modules', 'pdfjs-dist', 'build');
let COVERS, RARCACHE;

const send = (ch, data) => win && !win.isDestroyed() && win.webContents.send(ch, data);

function snapshot() {
  const d = store.data;
  return { books: d.books, progress: d.progress, history: d.history, settings: d.settings, folders: d.folders, covers: [...coverSet] };
}
const coverSet = new Set();

function safeJoin(base, rel) {
  const p = path.normalize(path.join(base, rel));
  return p.startsWith(base) ? p : null;
}

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.map': 'application/json',
  '.wasm': 'application/wasm', '.ttf': 'font/ttf', '.woff2': 'font/woff2' };

async function serveStatic(base, rel) {
  const p = safeJoin(base, decodeURIComponent(rel));
  if (!p) return new Response('Forbidden', { status: 403 });
  try {
    const data = await fsp.readFile(p);
    return new Response(data, { headers: { 'content-type': TYPES[path.extname(p)] || 'application/octet-stream' } });
  } catch (_) { return new Response('Not found', { status: 404 }); }
}

function registerProtocol() {
  protocol.handle('porter', async (req) => {
    const u = new URL(req.url);
    const parts = u.pathname.split('/').filter(Boolean);
    try {
      switch (u.host) {
        case 'app':
          if (parts[0] === 'pdfjs') return serveStatic(PDFJS, parts.slice(1).join('/'));
          return serveStatic(RENDERER, parts.join('/') || 'index.html');
        case 'page': {
          const book = store.data.books[parts[0]];
          if (!book) return new Response('', { status: 404 });
          const b = await books.get(book.path);
          const { data, mime } = await b.read(Number(parts[1]));
          return new Response(data, { headers: { 'content-type': mime, 'cache-control': 'max-age=31536000, immutable' } });
        }
        case 'thumb': {
          const book = store.data.books[parts[0]];
          if (!book) return new Response('', { status: 404 });
          const { data, mime, count } = await readFirstPage(book.path, RARCACHE);
          if (book.pages !== count) { book.pages = count; store.save(); }
          return new Response(data, { headers: { 'content-type': mime } });
        }
        case 'file': {
          const book = store.data.books[parts[0]];
          if (!book) return new Response('', { status: 404 });
          return net.fetch(pathToFileURL(book.path).toString());
        }
        case 'cover': {
          const p = path.join(COVERS, path.basename(parts[0]) + '.webp');
          const data = await fsp.readFile(p);
          return new Response(data, { headers: { 'content-type': 'image/webp', 'cache-control': 'no-cache' } });
        }
      }
    } catch (e) {
      return new Response(String(e.message || e), { status: 500 });
    }
    return new Response('', { status: 404 });
  });
}

function createWindow() {
  const st = store.data.window || {};
  win = new BrowserWindow({
    width: st.width || 1280, height: st.height || 860, x: st.x, y: st.y,
    minWidth: 720, minHeight: 500,
    backgroundColor: '#111113',
    title: 'Porter',
    show: false,
    autoHideMenuBar: true,
    icon: path.join(ROOT, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });
  win.setMenuBarVisibility(false);
  if (st.maximized) win.maximize();
  win.once('ready-to-show', () => win.show());
  win.loadURL('porter://app/index.html');
  const saveBounds = () => {
    if (win.isDestroyed()) return;
    store.data.window = { ...(win.isMaximized() ? store.data.window : win.getBounds()), maximized: win.isMaximized() };
    store.save(1500);
  };
  win.on('resize', saveBounds); win.on('move', saveBounds);
  win.on('enter-full-screen', () => send('fullscreen', true));
  win.on('leave-full-screen', () => send('fullscreen', false));
}

function touchHistory(book, page, total) {
  const now = Date.now();
  const h = store.data.history[book.fp] || { fp: book.fp, firstRead: now };
  Object.assign(h, {
    title: book.title, series: book.series, ext: book.ext, path: book.path, size: book.size,
    lastRead: now, available: true,
  });
  if (page != null) { h.page = page; h.total = total; h.finished = total > 0 && page >= total - 1; }
  store.data.history[book.fp] = h;
}

function registerIpc() {
  ipcMain.handle('library:get', () => snapshot());

  ipcMain.handle('folder:add', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Añadir carpeta a la biblioteca', properties: ['openDirectory', 'multiSelections'] });
    if (r.canceled) return snapshot();
    for (const d of r.filePaths) await library.addFolder(d);
    return snapshot();
  });
  ipcMain.handle('folder:addPath', async (_e, d) => {
    const st = await fsp.stat(d).catch(() => null);
    if (st) await library.addFolder(st.isDirectory() ? d : path.dirname(d));
    return snapshot();
  });
  ipcMain.handle('folder:remove', (_e, d) => { library.removeFolder(d); return snapshot(); });
  ipcMain.handle('library:rescan', async () => { await library.rescanAll(); return snapshot(); });

  ipcMain.handle('book:open', async (_e, id) => {
    const book = store.data.books[id];
    if (!book) throw new Error('Este archivo ya no está disponible');
    if (!fs.existsSync(book.path)) { library.removeFile(book.path); throw new Error('Este archivo ya no está disponible'); }
    let pages = null;
    if (book.ext !== 'pdf') {
      const b = await books.get(book.path);
      pages = b.count;
      book.pages = pages;
    }
    touchHistory(book);
    store.save();
    return { book, pages, progress: store.data.progress[book.fp] || null };
  });

  ipcMain.handle('book:pages', (_e, id, total) => {
    const book = store.data.books[id];
    if (book) { book.pages = total; store.save(); }
  });

  ipcMain.handle('progress:set', (_e, id, page, total) => {
    const book = store.data.books[id];
    if (!book) return;
    store.data.progress[book.fp] = { page, total, updated: Date.now(), finished: total > 0 && page >= total - 1 };
    book.pages = total;
    touchHistory(book, page, total);
    store.save();
  });

  ipcMain.handle('progress:reset', (_e, fp) => {
    delete store.data.progress[fp];
    const h = store.data.history[fp];
    if (h) { h.page = 0; h.finished = false; }
    store.save();
    return snapshot();
  });

  ipcMain.handle('history:remove', (_e, fp) => { delete store.data.history[fp]; store.save(); return snapshot(); });
  ipcMain.handle('history:clear', () => { store.data.history = {}; store.save(); return snapshot(); });

  ipcMain.handle('cover:has', (_e, fp) => fs.existsSync(path.join(COVERS, path.basename(fp) + '.webp')));
  ipcMain.handle('cover:save', async (_e, fp, buf) => {
    await fsp.writeFile(path.join(COVERS, path.basename(fp) + '.webp'), Buffer.from(buf));
    coverSet.add(fp);
    const h = store.data.history[fp]; if (h) h.cover = true;
    return true;
  });

  ipcMain.handle('settings:set', (_e, patch) => {
    Object.assign(store.data.settings, patch);
    store.save();
    return store.data.settings;
  });

  ipcMain.handle('book:reveal', (_e, id) => { const b = store.data.books[id]; if (b) shell.showItemInFolder(b.path); });
  ipcMain.handle('report:info', (_e, ctx) => report.systemInfo(store, ctx));
  ipcMain.handle('report:send', (_e, input) => report.sendReport(store, input));
  ipcMain.handle('report:available', () => report.isConfigured());
  ipcMain.on('log:error', (_e, msg) => report.logError('interfaz', msg));
  ipcMain.handle('win:fullscreen', (_e, v) => { win.setFullScreen(v ?? !win.isFullScreen()); return win.isFullScreen(); });
}

app.whenReady().then(async () => {
  const userData = app.getPath('userData');
  COVERS = path.join(userData, 'covers');
  RARCACHE = path.join(userData, 'cache', 'cbr');
  await fsp.mkdir(COVERS, { recursive: true });
  await fsp.mkdir(RARCACHE, { recursive: true });
  for (const f of await fsp.readdir(COVERS)) if (f.endsWith('.webp')) coverSet.add(f.slice(0, -5));

  store = new Store(userData);
  books = new BookCache(RARCACHE);
  library = new Library(store, () => send('library:changed', snapshot()));

  registerProtocol();
  registerIpc();
  createWindow();

  // Verificar la biblioteca en segundo plano tras abrir la ventana
  setTimeout(async () => {
    await library.rescanAll();
    library.watch();
    books.trimRarCache();
    report.flushPending(store).catch(() => {});
  }, 300);
});

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.on('before-quit', () => store && store.flush());
app.on('window-all-closed', () => app.quit());
