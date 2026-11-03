// Interfaz propia de la versión Android: pestaña PC, emparejado (QR y sin cámara),
// descargas, importación y sincronización automática.
import { App as CapApp } from '@capacitor/app';
import { pairWithQr, sasBegin, scanNetwork } from '../../src/shared/pc-client.mjs';
import { decodePairing, DEFAULT_PORT } from '../../src/shared/proto.mjs';
import { store, deleteLocalBook } from './bridge.js';
import { sync } from './sync.js';
import { scanWithCamera } from './scanner.js';
import { importFile } from './importer.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const collator = new Intl.Collator('es', { numeric: true, sensitivity: 'base' });

const QR_ICON = '<svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M3 3h8v8H3zm2 2v4h4V5zm8-2h8v8h-8zm2 2v4h4V5zM3 13h8v8H3zm2 2v4h4v-4zm11-2h2v2h-2zm-3 0h2v3h-2zm5 3h3v2h-3zm-5 2h3v3h-3zm6 2h2v3h-2zm-2-6h2v2h-2z"/></svg>';

export function createExt(app) {
  const remoteCovers = new Map();     // fp -> blob URL (portadas del PC)
  let pcLib = null;                   // { pcId, books, covers, loadedAt }
  let pcQuery = '';
  let pcSeries = null;

  const pcs = () => Object.values(store.data.pcs);
  const onPcFps = () => new Set(Object.values(store.data.onPc).flat());
  const pcIdFor = (fp) => Object.entries(store.data.onPc).find(([, l]) => l.includes(fp))?.[0] || pcs()[0]?.id;

  // ---------- emparejado ----------
  async function scanQr() {
    const text = await scanWithCamera({ onAlternative: () => pairNoCamera() });
    if (!text) return;
    if (!decodePairing(text)) return app.toast('Ese QR no es de Porter. En el PC abre Ajustes → «Emparejar un móvil o tablet».');
    app.toast('Emparejando…');
    try {
      const pc = await pairWithQr(text, { deviceId: store.data.device.id, deviceName: store.data.device.name });
      sync.addPc(pc);
      app.toast(`Emparejado con ${pc.name}`);
      app.view = 'pc'; app.render();
      sync.syncAll();
    } catch (e) { modalMsg('No se pudo emparejar', e.message); }
  }

  function modalMsg(title, text) {
    const m = $('#modal');
    m.innerHTML = `<div class="dialog"><h3>${esc(title)}</h3><p>${esc(text)}</p><div class="foot"><button class="btn" data-act="close-modal">Entendido</button></div></div>`;
    m.hidden = false;
  }

  let scanAbort = null;
  function pairNoCamera() {
    const m = $('#modal');
    m.innerHTML = `<div class="dialog">
      <h3>Emparejar sin cámara</h3>
      <ol class="steps">
        <li>En el PC abre Porter → Ajustes → <b>Emparejar un móvil o tablet</b>.</li>
        <li>Elige tu PC en la lista. Si no aparece, escribe la dirección que muestra el PC.</li>
        <li>Comprueba que el número de 6 cifras es el mismo en los dos y pulsa <b>Coinciden</b> en el PC.</li>
      </ol>
      <h4>Ordenadores con Porter en esta Wi‑Fi</h4>
      <div id="nc-list" class="nc-list"><p class="hint">Buscando… <span id="nc-pct"></span></p></div>
      <h4>O escribe la dirección del PC</h4>
      <div class="nc-manual"><input id="nc-host" type="text" inputmode="decimal" placeholder="192.168.1.35" autocomplete="off"><button class="btn" id="nc-go">Conectar</button></div>
      <p class="err" id="nc-err" hidden></p>
      <div class="foot"><button class="btn ghost" data-act="close-nc">Cancelar</button></div>
    </div>`;
    m.hidden = false;
    const list = $('#nc-list');
    const found = [];
    const draw = () => {
      if (!found.length) return;
      list.innerHTML = found.map((p, i) => `<button class="nc-pc" data-nc="${i}"><span>💻 ${esc(p.name)}</span><span class="hint">${esc(p.host)}${p.pairing ? '' : ' · abre «Emparejar» en el PC'}</span></button>`).join('');
    };
    scanAbort?.abort();
    scanAbort = new AbortController();
    const hints = pcs().flatMap((p) => p.hosts);
    scanNetwork({
      hints, signal: scanAbort.signal,
      onFound: (r) => { found.push(r); draw(); },
      onProgress: (p) => { const el = $('#nc-pct'); if (el) el.textContent = Math.round(p * 100) + '%'; },
    }).then(() => { if (!found.length && $('#nc-list')) list.innerHTML = '<p class="hint">No se ha encontrado ningún PC. Escribe su dirección abajo.</p>'; });
    list.onclick = (e) => {
      const b = e.target.closest('[data-nc]');
      if (b) startSas(found[+b.dataset.nc].host, found[+b.dataset.nc].port);
    };
    $('#nc-go').onclick = () => {
      const v = $('#nc-host').value.trim();
      const mm = /^(\d{1,3}(?:\.\d{1,3}){3})(?::(\d+))?$/.exec(v);
      if (!mm) { const er = $('#nc-err'); er.textContent = 'Escribe una dirección como 192.168.1.35'; er.hidden = false; return; }
      startSas(mm[1], mm[2] ? +mm[2] : DEFAULT_PORT);
    };
  }

  async function startSas(host, port) {
    scanAbort?.abort();
    const m = $('#modal');
    m.innerHTML = `<div class="dialog" style="text-align:center"><h3>Emparejar sin cámara</h3><p class="hint">Conectando con ${esc(host)}…</p></div>`;
    try {
      const s = await sasBegin(host, port, { deviceId: store.data.device.id, deviceName: store.data.device.name });
      const ac = new AbortController();
      m.innerHTML = `<div class="dialog" style="text-align:center">
        <h3>Comprueba el número</h3>
        <p>En <b>${esc(s.pcName)}</b> debe aparecer este mismo número:</p>
        <div class="sas">${esc(s.code)}</div>
        <p class="hint">Si coincide, pulsa <b>Coinciden</b> en el PC. Si no, pulsa «No coinciden».</p>
        <div class="foot"><button class="btn ghost" id="sas-cancel">Cancelar</button></div></div>`;
      $('#sas-cancel').onclick = () => { ac.abort(); m.hidden = true; };
      const pc = await s.wait({ signal: ac.signal });
      sync.addPc(pc);
      m.hidden = true;
      app.toast(`Emparejado con ${pc.name}`);
      app.view = 'pc'; app.render();
      sync.syncAll();
    } catch (e) {
      if (!m.hidden) modalMsg('No se pudo emparejar', e.message);
    }
  }

  // ---------- importar ----------
  function importFlow() {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.multiple = true;
    inp.accept = '.cbz,.zip,.cbr,.rar,.pdf,application/zip,application/pdf,application/x-cbz,application/x-cbr,application/vnd.comicbook+zip,application/vnd.comicbook-rar';
    inp.onchange = async () => {
      const files = [...inp.files];
      let ok = 0;
      for (let i = 0; i < files.length; i++) {
        app.toast(`Importando ${i + 1} de ${files.length}: ${files[i].name}`);
        try { const r = await importFile(files[i]); if (!r.skipped) ok++; } catch (e) { app.toast(e.message); await new Promise((r) => setTimeout(r, 1500)); }
      }
      app.toast(ok ? `${ok} archivo${ok > 1 ? 's' : ''} importado${ok > 1 ? 's' : ''}` : 'No se importó nada nuevo');
    };
    inp.click();
  }

  // ---------- portadas remotas ----------
  const coverQueue = [];
  let coverBusy = 0;
  function remoteCover(fp, el) {
    if (remoteCovers.has(fp)) { setImg(el, remoteCovers.get(fp)); return; }
    if (!pcLib?.covers?.includes(fp)) return;
    coverQueue.push({ fp, el });
    pumpCovers();
  }
  function setImg(el, url) {
    if (!el || !url) return;
    el.querySelector('.ph')?.remove();
    if (!el.querySelector('img')) { const i = new Image(); i.alt = ''; i.loading = 'lazy'; i.src = url; el.prepend(i); }
  }
  async function pumpCovers() {
    while (coverBusy < 3 && coverQueue.length) {
      const { fp, el } = coverQueue.shift();
      if (remoteCovers.has(fp)) { setImg(el, remoteCovers.get(fp)); continue; }
      coverBusy++;
      (async () => {
        try {
          const c = await sync.client(pcLib.pcId, { scan: false });
          const r = await c.call('cover', { fp });
          const url = URL.createObjectURL(new Blob([r.bytes], { type: 'image/webp' }));
          remoteCovers.set(fp, url);
          document.querySelectorAll(`[data-rcover="${fp}"]`).forEach((x) => setImg(x, url));
        } catch (_) {}
        coverBusy--; pumpCovers();
      })();
    }
  }
  const coverIO = new IntersectionObserver((ents) => {
    for (const e of ents) if (e.isIntersecting) { coverIO.unobserve(e.target); remoteCover(e.target.dataset.rcover, e.target); }
  }, { rootMargin: '300px' });

  function remoteCoverHTML(fp, title, extra = '') {
    const local = app.covers.has(fp) ? `<img loading="lazy" alt="" src="${esc(window.porter.coverURL(fp))}">` : (remoteCovers.has(fp) ? `<img loading="lazy" alt="" src="${remoteCovers.get(fp)}">` : `<div class="ph">${esc(title)}</div>`);
    return `<div class="cover" data-rcover="${fp}">${local}${extra}</div>`;
  }

  // ---------- pestaña PC ----------
  async function loadPcLibrary(force = false) {
    const pc = pcs()[0];
    if (!pc) return;
    if (pcLib && !force && Date.now() - pcLib.loadedAt < 60e3) return;
    const c = await sync.client(pc.id).catch(() => null);
    if (!c) { pcLib = null; renderIfPc(); return; }
    const lib = await c.call('library').catch(() => null);
    if (lib) pcLib = { pcId: pc.id, books: lib.books, covers: lib.covers, loadedAt: Date.now() };
    for (const b of pcLib?.books || []) store.data.pcBooks[b.fp] = { title: b.title, series: b.series, ext: b.ext, pages: b.pages, size: b.size };
    store.save();
    renderIfPc();
  }
  const renderIfPc = () => { if (app.view === 'pc' && !app.reader.isOpen) { const y = app.content.scrollTop; renderPc(); app.content.scrollTop = y; } };

  function statusHTML() {
    const s = sync.status;
    const cls = { ok: 'ok', offline: 'warn', error: 'bad', searching: 'busy', syncing: 'busy' }[s.state] || '';
    return `<div class="sync-bar ${cls}"><span>${esc(s.text || 'Listo para sincronizar')}</span><button class="btn ghost small" data-act="sync-now">Sincronizar</button></div>`;
  }

  function downloadsHTML() {
    const items = [...(sync.current ? [sync.current] : []), ...sync.queue];
    if (!items.length) return '';
    return `<div class="section-h"><h2>Descargando</h2><span class="meta">${items.length}</span></div><div class="dl-list">${items.map((j, i) => `
      <div class="dl"><div class="dl-t"><b>${esc(j.book.title)}</b><span class="hint">${i === 0 && sync.current ? Math.round((j.progress || 0) * 100) + '%' : 'En espera'}${j.auto ? ' · automática' : ''}</span></div>
      <div class="dl-bar"><i style="width:${Math.round((j.progress || 0) * 100)}%"></i></div>
      <button class="icon-btn" data-cancel-dl="${j.book.fp}" title="Cancelar">✕</button></div>`).join('')}</div>`;
  }

  function bookState(b) {
    if (store.data.books[b.fp]) return '<span class="pill done">En el móvil</span>';
    const j = sync.current?.book.fp === b.fp ? sync.current : sync.queue.find((q) => q.book.fp === b.fp);
    if (j) return `<span class="pill">${j === sync.current ? Math.round((j.progress || 0) * 100) + '%' : 'En cola'}</span>`;
    return '';
  }

  function renderPc() {
    const c = app.content;
    if (!pcs().length) {
      c.innerHTML = `<div class="empty connect">
        <div class="big-ico">${QR_ICON}</div>
        <h3>Conecta con Porter en tu PC</h3>
        <p>Sincroniza lo que lees y pásate mangas por la Wi‑Fi de casa. En el PC abre <b>Ajustes → Emparejar un móvil o tablet</b>.</p>
        <button class="btn big" data-act="scan-qr">${QR_ICON} Escanear QR</button>
        <button class="btn ghost" data-act="pair-nocam">Emparejar sin cámara</button>
      </div>`;
      return;
    }
    const pc = pcs()[0];
    let html = `<div class="pc-head"><div><h1 class="series-title">💻 ${esc(pc.name)}</h1></div></div>${statusHTML()}${downloadsHTML()}`;
    if (!pcLib) {
      html += `<div class="empty"><h3>${sync.busy ? 'Buscando tu PC…' : 'PC no disponible'}</h3><p>Para ver y descargar la biblioteca del PC, ten Porter abierto en el PC y el móvil en la misma Wi‑Fi.</p><button class="btn" data-act="pc-reload">Reintentar</button></div>`;
      c.innerHTML = html;
      return;
    }
    const q = pcQuery.trim().toLowerCase();
    const bySeries = new Map();
    for (const b of pcLib.books) {
      if (q && !(b.title + ' ' + b.series).toLowerCase().includes(q)) continue;
      if (!bySeries.has(b.series)) bySeries.set(b.series, []);
      bySeries.get(b.series).push(b);
    }
    for (const l of bySeries.values()) l.sort((a, b) => collator.compare(a.title, b.title));
    if (pcSeries && bySeries.has(pcSeries)) {
      const list = bySeries.get(pcSeries);
      const missing = list.filter((b) => !store.data.books[b.fp]).length;
      html += `<button class="back" data-act="pc-back">← Biblioteca del PC</button>
        <h2 class="series-title">${esc(pcSeries)}</h2>
        <div class="section-h"><span class="meta">${list.length} volúmenes</span>${missing ? `<button class="btn small" style="margin-left:auto" data-dl-series="${esc(pcSeries)}">Descargar ${missing === list.length ? 'todos' : `los ${missing} que faltan`}</button>` : ''}</div>
        <div class="grid">${list.map((b) => pcCard(b)).join('')}</div>`;
    } else {
      const names = [...bySeries.keys()].sort(collator.compare);
      html += `<div class="search pc-search"><input id="pc-q" type="search" placeholder="Buscar en el PC…" value="${esc(pcQuery)}"></div>
        <div class="section-h"><h2>Biblioteca del PC</h2><span class="meta">${pcLib.books.length} archivos</span></div><div class="grid">`;
      for (const n of names) {
        const list = bySeries.get(n);
        if (list.length === 1) { html += pcCard(list[0]); continue; }
        const have = list.filter((b) => store.data.books[b.fp]).length;
        html += `<div class="card" data-pc-series="${esc(n)}">${remoteCoverHTML(list[0].fp, n, `<span class="badge count">${list.length}</span>`)}<div class="t">${esc(n)}</div><div class="s">${have ? `${have} de ${list.length} en el móvil` : `${list.length} volúmenes`}</div></div>`;
      }
      html += '</div>';
    }
    c.innerHTML = html;
    c.querySelectorAll('[data-rcover]').forEach((el) => { if (!el.querySelector('img')) coverIO.observe(el); });
    const qi = $('#pc-q');
    if (qi) { let t; qi.oninput = () => { clearTimeout(t); t = setTimeout(() => { pcQuery = qi.value; renderPc(); const n = $('#pc-q'); n.focus(); n.setSelectionRange(n.value.length, n.value.length); }, 250); }; }
  }

  function pcCard(b) {
    const p = store.data.progress[b.fp];
    const pct = p ? (p.finished ? 100 : Math.round(((p.page + 1) / Math.max(1, p.total)) * 100)) : 0;
    const extra = (p?.finished ? '<span class="badge done">✓</span>' : '') + (pct > 0 && !p?.finished ? `<div class="bar"><i style="width:${pct}%"></i></div>` : '');
    const local = !!store.data.books[b.fp];
    return `<div class="card pc-card" data-pc-book="${b.fp}">${remoteCoverHTML(b.fp, b.title, extra)}
      <div class="t">${esc(b.title)}</div>
      <div class="s">${bookState(b) || (b.pages ? b.pages + ' págs.' : b.ext.toUpperCase())}</div>
      <div class="pc-actions">${local ? `<button class="btn small" data-open="${b.fp}">Leer</button>` : `<button class="btn small" data-dl="${b.fp}">Descargar</button><button class="btn ghost small" data-stream="${b.fp}">Leer</button>`}</div>
    </div>`;
  }

  function pcBook(fp) {
    const b = pcLib?.books.find((x) => x.fp === fp);
    if (b) return b;
    return null;
  }

  async function remoteMenu(fp) {
    const meta = store.data.pcBooks[fp] || store.data.history[fp] || {};
    const m = $('#modal');
    m.innerHTML = `<div class="dialog"><h3>${esc(meta.title || 'Libro')}</h3>
      <p>Este tomo está en tu PC, no en el móvil.</p>
      <div class="actions col"><button class="btn" data-dl="${fp}">Descargar al móvil</button><button class="btn ghost" data-stream="${fp}">Leer desde el PC (sin descargar)</button></div>
      <div class="foot"><button class="btn ghost" data-act="close-modal">Cerrar</button></div></div>`;
    m.hidden = false;
  }

  async function ensureBook(fp) {
    if (!pcLib) await loadPcLibrary(true);
    const b = pcBook(fp);
    if (!b) throw new Error('No encuentro ese tomo en el PC. ¿Está encendido y en la misma Wi‑Fi?');
    return b;
  }

  // ---------- extensión que usa app.js ----------
  const ext = {
    init() {
      const add = $('#btn-add');
      add.textContent = 'Importar';
      add.onclick = importFlow;
      $('#btn-qr').onclick = () => (pcs().length ? (app.view = 'pc', app.series = null, app.render(), loadPcLibrary(true)) : scanQr());
      document.querySelector('.tab[data-view="pc"]').addEventListener('click', () => loadPcLibrary());
      sync.on(() => {
        const ind = $('#sync-ind');
        if (ind) ind.dataset.state = sync.status.state;
        if (app.view === 'pc' && !app.reader.isOpen) {
          // Refresco ligero mientras se descarga
          clearTimeout(ext._rt); ext._rt = setTimeout(renderIfPc, 120);
        }
      });
      CapApp.addListener('resume', () => sync.syncAll({ quiet: true }));
      CapApp.addListener('backButton', () => ext.back());
      setInterval(() => { if (document.visibilityState === 'visible' && !sync.busy) sync.syncAll({ scan: false, quiet: true }); }, 5 * 60e3);
      setTimeout(() => sync.syncAll({ quiet: true }), 600);
    },

    back() {
      if (window.__porterScannerClose && document.querySelector('.scanner')) return window.__porterScannerClose();
      if (!$('#modal').hidden) { scanAbort?.abort(); $('#modal').hidden = true; return; }
      if (!$('#ctx').hidden) { $('#ctx').hidden = true; return; }
      if (app.reader.isOpen) return app.reader.close();
      if (app.view === 'pc' && pcSeries) { pcSeries = null; return renderPc(); }
      if (app.series) { app.series = null; return app.render(); }
      if (app.view !== 'library') { app.view = 'library'; return app.render(); }
      CapApp.minimizeApp?.() ?? CapApp.exitApp();
    },

    renderView(view) { if (view === 'pc') { renderPc(); if (!pcLib) loadPcLibrary(); } },

    emptyLibraryHTML() {
      const paired = pcs().length;
      return `<div class="empty connect">
        <h3>Tu biblioteca del móvil está vacía</h3>
        <p>${paired ? 'Abre la pestaña <b>PC</b> para descargar mangas de tu ordenador, o importa archivos de este dispositivo.' : 'Empareja este móvil con Porter en tu PC para sincronizar lo que lees y pasarte mangas, o importa archivos de este dispositivo.'}</p>
        ${paired ? '<button class="btn big" data-act="go-pc">Ver la biblioteca del PC</button>' : `<button class="btn big" data-act="scan-qr">${QR_ICON} Escanear QR del PC</button><button class="btn ghost" data-act="pair-nocam">Emparejar sin cámara</button>`}
        <button class="btn ghost" data-act="import">Importar archivos (CBZ, CBR, PDF)</button>
      </div>${this.extraLibraryHTML()}`;
    },

    // "Leyendo en el PC": lo que lees en otros dispositivos aunque no esté en el móvil
    extraLibraryHTML() {
      const d = store.data;
      const onPc = onPcFps();
      const items = Object.entries(d.progress)
        .filter(([fp, p]) => !d.books[fp] && !p.finished && onPc.has(fp) && Date.now() - (p.updated || 0) < 60 * 864e5)
        .sort((a, b) => b[1].updated - a[1].updated).slice(0, 12);
      if (!items.length) return '';
      return `<div class="section-h"><h2>Leyendo en el PC</h2><span class="meta">toca para descargar o leer</span></div><div class="row">${items.map(([fp, p]) => {
        const meta = d.pcBooks[fp] || d.history[fp] || { title: '?' };
        const pct = Math.round(((p.page + 1) / Math.max(1, p.total)) * 100);
        return `<div class="card" data-remote="${fp}">${remoteCoverHTML(fp, meta.title, `<span class="badge pc">PC</span><div class="bar"><i style="width:${pct}%"></i></div>`)}<div class="t">${esc(meta.title)}</div><div class="s">Pág. ${p.page + 1} de ${p.total}</div></div>`;
      }).join('')}</div>`;
    },

    isRemote(fp) { return onPcFps().has(fp); },
    historyBadge(h) { return this.isRemote(h.fp) ? '<span class="pill pc">En el PC</span>' : '<span class="pill gone">Archivo no disponible</span>'; },

    settingsHTML() {
      const d = store.data;
      return `<h4>Tu PC</h4>
        ${pcs().map((p) => `<div class="folder"><span>💻 ${esc(p.name)} <span class="hint">· ${p.lastSync ? 'sincronizado ' + new Date(p.lastSync).toLocaleString('es-ES', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'sin sincronizar'}</span></span><button class="icon-btn" data-unpair="${esc(p.id)}" title="Desemparejar">✕</button></div>`).join('') || '<p class="hint">Ningún PC emparejado.</p>'}
        <div class="actions"><button class="btn" data-act="scan-qr">${QR_ICON} Escanear QR</button><button class="btn ghost" data-act="pair-nocam">Emparejar sin cámara</button></div>
        <h4>Descargar automáticamente</h4>
        <p class="hint" style="margin:0 0 8px">Cuando estés en la Wi‑Fi de casa, Porter se trae del PC lo que estás leyendo y los siguientes tomos de la serie.</p>
        <div class="actions seg" style="display:inline-flex">${[0, 1, 2, 3, 5].map((n) => `<button data-autonext="${n}" class="${d.autoNext === n ? 'on' : ''}">${n === 0 ? 'No' : n}</button>`).join('')}</div>
        <label class="check"><input type="checkbox" id="rm-finished" ${d.removeFinished ? 'checked' : ''}><span>Borrar del móvil los tomos descargados del PC 3 días después de terminarlos<br><span class="hint">Siguen en el PC y en el historial.</span></span></label>
        <h4>Este dispositivo</h4>
        <div class="field" style="margin-top:0"><input type="text" id="dev-name" maxlength="40" value="${esc(d.device?.name || '')}" placeholder="Nombre del móvil"></div>
        <p class="hint">${Object.keys(d.books).length} tomos guardados en el móvil.</p>
        <div class="actions"><button class="btn ghost" data-act="import">Importar archivos</button></div>`;
    },

    afterSettings() {
      const rm = $('#rm-finished');
      if (rm) rm.onchange = () => { store.data.removeFinished = rm.checked; store.save(); };
      const dn = $('#dev-name');
      if (dn) dn.onchange = () => { store.data.device.name = dn.value.trim() || 'Android'; store.save(); };
    },

    contextItems() { return '<button data-c="delete-local">Borrar del móvil</button>'; },
    async contextAction(a, book) {
      if (a === 'delete-local' && confirm(`¿Borrar «${book.title}» del móvil? El progreso y el historial se conservan.`)) {
        await deleteLocalBook(book.fp);
        app.toast('Borrado del móvil');
      }
    },

    async action(act, t) {
      if (act === 'scan-qr') { $('#modal').hidden = true; scanQr(); return true; }
      if (act === 'pair-nocam') { pairNoCamera(); return true; }
      if (act === 'close-nc') { scanAbort?.abort(); $('#modal').hidden = true; return true; }
      if (act === 'import') { $('#modal').hidden = true; importFlow(); return true; }
      if (act === 'go-pc') { app.view = 'pc'; app.render(); loadPcLibrary(true); return true; }
      if (act === 'sync-now') { sync.syncAll().then(() => loadPcLibrary(true)); return true; }
      if (act === 'pc-reload') { pcLib = null; renderPc(); loadPcLibrary(true); sync.syncAll(); return true; }
      if (act === 'pc-back') { pcSeries = null; renderPc(); return true; }
      const an = t.closest('[data-autonext]');
      if (an) { store.data.autoNext = +an.dataset.autonext; store.save(); app.settings(); return true; }
      const up = t.closest('[data-unpair]');
      if (up) { if (confirm('¿Desemparejar este PC?')) { sync.removePc(up.dataset.unpair); app.settings(); } return true; }
      const cd = t.closest('[data-cancel-dl]');
      if (cd) { sync.cancel(cd.dataset.cancelDl); return true; }
      const dls = t.closest('[data-dl-series]');
      if (dls && pcLib) {
        const list = pcLib.books.filter((b) => b.series === dls.dataset.dlSeries).sort((a, b) => collator.compare(a.title, b.title));
        list.forEach((b) => sync.enqueue(pcLib.pcId, b));
        app.toast('Descargando la serie…'); return true;
      }
      const dl = t.closest('[data-dl]');
      if (dl) {
        $('#modal').hidden = true;
        try { const b = await ensureBook(dl.dataset.dl); sync.enqueue(pcLib.pcId, b); app.toast(`Descargando «${b.title}»`); renderIfPc(); } catch (e) { app.toast(e.message); }
        return true;
      }
      const st = t.closest('[data-stream]');
      if (st) {
        $('#modal').hidden = true;
        try {
          const b = await ensureBook(st.dataset.stream);
          const id = await sync.openRemote(pcLib.pcId, b);
          await app.openBook(id);
        } catch (e) { app.toast(e.message); }
        return true;
      }
      const ps = t.closest('[data-pc-series]');
      if (ps) { pcSeries = ps.dataset.pcSeries; renderPc(); app.content.scrollTop = 0; return true; }
      const rm = t.closest('[data-remote]');
      if (rm) { remoteMenu(rm.dataset.remote); return true; }
      const pcb = t.closest('[data-pc-book]');
      if (pcb && !t.closest('button')) {
        if (store.data.books[pcb.dataset.pcBook]) app.openBook(pcb.dataset.pcBook); else remoteMenu(pcb.dataset.pcBook);
        return true;
      }
      return false;
    },

    onReaderClosed() { setTimeout(() => sync.syncAll({ scan: false, quiet: true }), 300); },
  };
  return ext;
}
