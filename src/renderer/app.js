import { Reader } from './reader.js';
import { makeCover } from './sources.js';

const $ = (s) => document.querySelector(s);
const collator = new Intl.Collator('es', { numeric: true, sensitivity: 'base' });
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

class App {
  constructor() {
    this.state = null;
    this.view = 'library';
    this.series = null;      // serie abierta
    this.query = '';
    this.covers = new Set();
    this.coverQueue = [];
    this.coverBusy = 0;
    this.coverFailed = new Set();
    this.ext = window.porterExt ? window.porterExt(this) : null;
    this.reader = new Reader(this);
    this.content = $('#content');
    this.coverIO = new IntersectionObserver((ents) => {
      for (const e of ents) {
        if (!e.isIntersecting) continue;
        this.coverIO.unobserve(e.target);
        const id = e.target.dataset.book;
        const b = this.state.books[id];
        if (b && !this.covers.has(b.fp)) this.enqueueCover(b);
      }
    }, { root: this.content, rootMargin: '400px' });
    this.bind();
    this.init();
  }

  async init() {
    if (window.porter.onPairRequest) {
      window.porter.onPairRequest((r) => this.showPairRequest(r));
      window.porter.onPaired((name) => {
        this.pairing = false;
        $('#modal').hidden = true;
        this.toast(`${name} emparejado. Ya se sincronizará solo en tu Wi‑Fi.`);
        this.deviceCount = (this.deviceCount || 0) + 1;
      });
      window.porter.syncDevices().then((i) => { this.deviceCount = i.devices.length; });
    }
    this.setState(await window.porter.getLibrary());
    window.porter.onLibrary((d) => { this.setState(d); });
    this.ext?.init?.();
  }

  setState(d) {
    this.state = d;
    for (const fp of d.covers || []) this.covers.add(fp);
    if (!this.reader.isOpen) this.render();
  }

  localProgress(fp, page, total) {
    this.state.progress[fp] = { page, total, updated: Date.now(), finished: page >= total - 1 };
    const h = this.state.history[fp];
    if (h) Object.assign(h, { page, total, lastRead: Date.now(), finished: page >= total - 1 });
  }

  // ---------- Datos derivados ----------
  booksArr() { return Object.values(this.state.books); }

  seriesMap() {
    const m = new Map();
    for (const b of this.booksArr()) {
      if (!m.has(b.series)) m.set(b.series, []);
      m.get(b.series).push(b);
    }
    for (const list of m.values()) list.sort((a, b) => collator.compare(a.title, b.title));
    return m;
  }

  nextBookOf(book) {
    const list = this.seriesMap().get(book.series) || [];
    const i = list.findIndex((b) => b.id === book.id);
    return i >= 0 ? list[i + 1] || null : null;
  }

  pct(b) {
    const p = this.state.progress[b.fp];
    if (!p) return 0;
    if (p.finished) return 100;
    return Math.round(((p.page + 1) / Math.max(1, p.total)) * 100);
  }

  // ---------- Portadas ----------
  coverURL(fp) { return window.porter.coverURL ? window.porter.coverURL(fp) : `porter://cover/${fp}`; }

  enqueueCover(b) {
    if (this.coverFailed.has(b.fp) || this.coverQueue.some((x) => x.fp === b.fp)) return;
    this.coverQueue.push(b);
    this.pumpCovers();
  }

  async pumpCovers() {
    while (this.coverBusy < 2 && this.coverQueue.length) {
      const b = this.coverQueue.shift();
      if (this.covers.has(b.fp)) continue;
      this.coverBusy++;
      makeCover(b).then(() => {
        this.covers.add(b.fp);
        document.querySelectorAll(`[data-fp="${b.fp}"]`).forEach((el) => this.fillCover(el, b.fp));
      }).catch(() => this.coverFailed.add(b.fp))
        .finally(() => { this.coverBusy--; this.pumpCovers(); });
    }
  }

  fillCover(el, fp) {
    const img = new Image();
    img.decoding = 'async'; img.loading = 'lazy'; img.alt = '';
    img.src = this.coverURL(fp) + (this.coverURL(fp).startsWith('blob:') ? '' : `?t=${Date.now()}`);
    el.querySelector('.ph')?.remove();
    el.querySelector('img')?.remove();
    el.prepend(img);
  }

  coverHTML(fp, title, extra = '') {
    const has = this.covers.has(fp);
    return `<div class="cover" data-fp="${fp}">${has ? `<img loading="lazy" decoding="async" alt="" src="${this.coverURL(fp)}">` : `<div class="ph">${esc(title)}</div>`}${extra}</div>`;
  }

  // ---------- Vistas ----------
  render() {
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === this.view));
    document.body.dataset.view = this.view;
    const scroll = this.content.scrollTop;
    if (this.view === 'history') this.renderHistory();
    else if (this.view !== 'library' && this.ext?.renderView) this.ext.renderView(this.view);
    else if (this.series) this.renderSeries(this.series);
    else this.renderLibrary();
    if (this._keepScroll) this.content.scrollTop = scroll;
    this._keepScroll = false;
    // Encolar portadas que falten cuando se vean
    this.content.querySelectorAll('[data-book]').forEach((el) => {
      const b = this.state.books[el.dataset.book];
      if (b && !this.covers.has(b.fp)) this.coverIO.observe(el);
    });
  }

  bookCard(b, sub) {
    const p = this.state.progress[b.fp];
    const pct = this.pct(b);
    let extra = '';
    if (p?.finished) extra += `<span class="badge done">✓ Leído</span>`;
    else if (pct > 0) extra += `<div class="bar"><i style="width:${pct}%"></i></div>`;
    return `<div class="card" data-book="${b.id}" title="${esc(b.title)}">
      ${this.coverHTML(b.fp, b.title, extra)}
      <div class="t">${esc(b.title)}</div>
      <div class="s">${esc(sub ?? (p && !p.finished ? `Pág. ${p.page + 1} de ${p.total}` : b.pages ? `${b.pages} págs.` : b.ext.toUpperCase()))}</div>
    </div>`;
  }

  renderLibrary() {
    const q = this.query.trim().toLowerCase();
    const books = this.booksArr();
    if (this.ext?.emptyLibraryHTML && !books.length && !q) {
      this.content.innerHTML = this.ext.emptyLibraryHTML();
      return;
    }
    if (!this.ext && !this.state.folders.length) {
      this.content.innerHTML = `<div class="empty"><h3>Tu biblioteca está vacía</h3>
        <p>Añade la carpeta donde guardas tus mangas y libros (CBZ, CBR, ZIP, RAR o PDF). Porter la vigilará y añadirá solo lo nuevo.</p>
        <button class="btn" data-act="add">+ Añadir carpeta</button></div>`;
      return;
    }
    let html = '';
    if (!q) {
      const cont = books
        .filter((b) => { const p = this.state.progress[b.fp]; return p && !p.finished && p.page > 0; })
        .sort((a, b) => this.state.progress[b.fp].updated - this.state.progress[a.fp].updated)
        .slice(0, 20);
      if (cont.length) {
        html += `<div class="section-h"><h2>Continuar leyendo</h2></div><div class="row">${cont.map((b) => this.bookCard(b, `${b.series !== b.title ? b.series + ' · ' : ''}${this.pct(b)}%`)).join('')}</div>`;
      }
      if (this.ext?.extraLibraryHTML) html += this.ext.extraLibraryHTML();
    }
    const sm = this.seriesMap();
    let names = [...sm.keys()].sort(collator.compare);
    if (q) {
      // En búsqueda: libros que coinciden directamente
      const hits = books.filter((b) => b.title.toLowerCase().includes(q) || b.series.toLowerCase().includes(q))
        .sort((a, b) => collator.compare(a.series + a.title, b.series + b.title));
      html += `<div class="section-h"><h2>Resultados</h2><span class="meta">${hits.length}</span></div>`;
      html += hits.length ? `<div class="grid">${hits.slice(0, 600).map((b) => this.bookCard(b, b.series)).join('')}</div>` : `<p style="color:var(--muted)">Nada coincide con “${esc(this.query)}”.</p>`;
      this.content.innerHTML = html;
      return;
    }
    html += `<div class="section-h"><h2>Series</h2><span class="meta">${names.length} series · ${books.length} archivos</span></div><div class="grid">`;
    for (const name of names) {
      const list = sm.get(name);
      const read = list.filter((b) => this.state.progress[b.fp]?.finished).length;
      const first = list.find((b) => this.covers.has(b.fp)) || list[0];
      if (list.length === 1) { html += this.bookCard(list[0], list[0].series !== list[0].title ? list[0].series : undefined); continue; }
      const badge = `<span class="badge count">${list.length}</span>`;
      const pct = Math.round((read / list.length) * 100);
      const bar = pct > 0 ? `<div class="bar"><i style="width:${pct}%"></i></div>` : '';
      html += `<div class="card" data-series="${esc(name)}" data-book="${first.id}">
        ${this.coverHTML(first.fp, name, badge + bar)}
        <div class="t">${esc(name)}</div>
        <div class="s">${read ? `${read} de ${list.length} leídos` : `${list.length} volúmenes`}</div></div>`;
    }
    html += '</div>';
    if (!books.length) html += `<div class="empty"><h3>No hay archivos todavía</h3><p>Las carpetas vigiladas no contienen CBZ, CBR o PDF. En cuanto copies alguno, aparecerá aquí.</p></div>`;
    this.content.innerHTML = html;
  }

  renderSeries(name) {
    const list = this.seriesMap().get(name);
    if (!list) { this.series = null; return this.renderLibrary(); }
    const read = list.filter((b) => this.state.progress[b.fp]?.finished).length;
    const nextUp = list.find((b) => !this.state.progress[b.fp]?.finished) || list[0];
    this.content.innerHTML = `<button class="back" data-act="back">← Biblioteca</button>
      <h1 class="series-title">${esc(name)}</h1>
      <div class="section-h"><span class="meta">${list.length} volúmenes · ${read} leídos</span>
        <button class="btn" style="margin-left:auto" data-open="${nextUp.id}">${this.state.progress[nextUp.fp] ? 'Continuar' : 'Empezar'}: ${esc(nextUp.title)}</button></div>
      <div class="grid">${list.map((b) => this.bookCard(b)).join('')}</div>`;
  }

  renderHistory() {
    const q = this.query.trim().toLowerCase();
    const avail = new Map(this.booksArr().map((b) => [b.fp, b]));
    let items = Object.values(this.state.history).sort((a, b) => (b.lastRead || 0) - (a.lastRead || 0));
    if (q) items = items.filter((h) => (h.title + ' ' + h.series).toLowerCase().includes(q));
    if (!items.length) {
      this.content.innerHTML = `<div class="empty"><h3>Sin historial</h3><p>Aquí verás todo lo que has leído, aunque después borres o muevas el archivo.</p></div>`;
      return;
    }
    const dayKey = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
    const today = dayKey(Date.now());
    const label = (k) => k === today ? 'Hoy' : k === today - 864e5 ? 'Ayer'
      : new Date(k).toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long', year: new Date(k).getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined });
    let html = `<div class="section-h"><h2>Historial de lectura</h2><span class="meta">${items.length} títulos</span>
      <button class="btn ghost" style="margin-left:auto" data-act="clear-history">Borrar historial</button></div><div class="hist">`;
    let last = null;
    for (const h of items) {
      const k = dayKey(h.lastRead || 0);
      if (k !== last) { html += `<div class="hday">${esc(label(k))}</div>`; last = k; }
      const book = avail.get(h.fp);
      const gone = !book;
      const prog = h.finished ? `<span class="pill done">Terminado</span>` : h.total ? `<span class="p">Pág. ${(h.page || 0) + 1}</span> de ${h.total}` : 'Abierto';
      const time = new Date(h.lastRead).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
      const remote = gone && this.ext?.isRemote?.(h.fp);
      html += `<div class="hrow ${gone && !remote ? 'gone' : ''}" ${book ? `data-open="${book.id}"` : remote ? `data-remote="${h.fp}"` : ''} data-fp="${h.fp}" title="${esc(h.path || '')}">
        <div class="hcover">${this.covers.has(h.fp) ? `<img loading="lazy" alt="" src="${this.coverURL(h.fp)}">` : ''}</div>
        <div class="hmain"><div class="t">${esc(h.title)}${gone ? (this.ext?.historyBadge ? this.ext.historyBadge(h) : '<span class="pill gone">Archivo no disponible</span>') : ''}</div>
          <div class="s">${esc(h.series !== h.title ? h.series : '')}${h.series !== h.title ? ' · ' : ''}${esc((h.ext || '').toUpperCase())}</div></div>
        <div class="hstate">${prog}<div>${time}</div></div>
        <button class="icon-btn" data-remove-hist="${h.fp}" title="Quitar del historial">✕</button>
      </div>`;
    }
    this.content.innerHTML = html + '</div>';
  }

  // ---------- Acciones ----------
  async openBook(id) {
    try {
      await this.reader.open(id);
    } catch (e) {
      this.toast(e.message?.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') || 'No se pudo abrir');
      this.setState(await window.porter.getLibrary());
    }
  }

  onReaderClosed() {
    this.ext?.onReaderClosed?.();
    this._keepScroll = true;
    window.porter.getLibrary().then((d) => { this._keepScroll = true; this.setState(d); });
  }

  toast(msg) {
    const t = $('#toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(this._toastT);
    this._toastT = setTimeout(() => (t.hidden = true), 3200);
  }

  async addFolder() {
    this.toast('Escaneando…');
    this.setState(await window.porter.addFolder());
    $('#toast').hidden = true;
  }

  // ---------- Reporte de fallos ----------
  async reportDialog(context = null) {
    const m = $('#modal');
    const wasReader = this.reader.isOpen;
    m.innerHTML = `<div class="dialog">
      <h3>Reportar un fallo o sugerencia</h3>
      <p style="color:var(--muted);margin:-8px 0 4px;font-size:13px">Tu reporte llega de forma privada al autor de Porter. No se publica en ningún sitio.</p>
      <div class="seg" style="display:inline-flex;margin-top:8px" id="rp-type">
        <button data-t="fallo" class="on">Fallo</button><button data-t="sugerencia">Sugerencia</button>
      </div>
      <div class="field"><label for="rp-desc">¿Qué ha pasado?</label>
        <textarea id="rp-desc" rows="4" maxlength="5000" placeholder="Ej.: en modo manga, al pasar de página la imagen se queda congelada aunque el contador avanza."></textarea></div>
      <div class="field"><label for="rp-steps">Pasos para reproducirlo <span class="hint">(opcional)</span></label>
        <textarea id="rp-steps" rows="3" maxlength="5000" placeholder="1. Abro un CBZ…&#10;2. Activo doble página…"></textarea></div>
      <div class="field"><label for="rp-contact">Correo de contacto <span class="hint">(opcional, solo si quieres respuesta)</span></label>
        <input id="rp-contact" type="email" maxlength="200" autocomplete="email"></div>
      <label class="check"><input type="checkbox" id="rp-info" checked>
        <span>Adjuntar información técnica<br><span class="hint">Versión, Windows, pantalla, ajustes de lectura y errores recientes. Sin nombres de archivos ni rutas.</span>
        <button class="linkbtn" id="rp-show" type="button">Ver qué se envía</button></span></label>
      <pre class="info" id="rp-preview" hidden></pre>
      <div class="err" id="rp-err" hidden></div>
      <div class="foot" style="gap:8px"><button class="btn ghost" data-act="close-modal">Cancelar</button><button class="btn" id="rp-send">Enviar</button></div>
    </div>`;
    m.hidden = false;
    setTimeout(() => $('#rp-desc').focus(), 0);
    let type = 'fallo';
    m.querySelectorAll('#rp-type button').forEach((b) => b.onclick = () => {
      type = b.dataset.t;
      m.querySelectorAll('#rp-type button').forEach((x) => x.classList.toggle('on', x === b));
      $('#rp-desc').placeholder = type === 'fallo' ? 'Ej.: en modo manga, al pasar de página la imagen se queda congelada aunque el contador avanza.' : '¿Qué te gustaría que hiciera Porter?';
    });
    $('#rp-show').onclick = async () => {
      const pre = $('#rp-preview');
      if (!pre.hidden) { pre.hidden = true; return; }
      pre.textContent = await window.porter.reportInfo(context);
      pre.hidden = false;
    };
    $('#rp-send').onclick = async () => {
      const err = $('#rp-err');
      err.hidden = true;
      const description = $('#rp-desc').value.trim();
      if (description.length < 10) { err.textContent = 'Cuéntame un poco más (al menos 10 caracteres).'; err.hidden = false; return; }
      const btn = $('#rp-send'); btn.disabled = true; btn.textContent = 'Enviando…';
      const r = await window.porter.sendReport({
        type, description, steps: $('#rp-steps').value.trim(), contact: $('#rp-contact').value.trim(),
        includeInfo: $('#rp-info').checked, context,
      }).catch((e) => ({ ok: false, error: e.message }));
      if (!r.ok) { err.textContent = r.error || 'No se pudo enviar.'; err.hidden = false; btn.disabled = false; btn.textContent = 'Enviar'; return; }
      m.hidden = true;
      this.toast(r.queued ? 'Sin conexión: el reporte se enviará la próxima vez que abras Porter.' : '¡Gracias! Reporte enviado.');
      if (wasReader) this.reader.stage.focus();
    };
  }

  settings() {
    const s = this.state.settings;
    const m = $('#modal');
    m.innerHTML = `<div class="dialog">
      <h3>Ajustes</h3>
      ${this.ext?.settingsHTML ? this.ext.settingsHTML() : `<h4>Carpetas vigiladas</h4>
      <div id="folders">${this.state.folders.map((f) => `<div class="folder"><span title="${esc(f)}">${esc(f)}</span><button class="icon-btn" data-rmfolder="${esc(f)}" title="Quitar">✕</button></div>`).join('') || '<p style="color:var(--muted)">Ninguna todavía.</p>'}</div>
      <div class="actions"><button class="btn" data-act="add">+ Añadir carpeta</button><button class="btn ghost" data-act="rescan">Volver a escanear</button></div>
      <h4>Móviles y tablets</h4>
      <div id="devices"><p style="color:var(--muted)">Cargando…</p></div>
      <div class="actions"><button class="btn" data-act="pair">Emparejar un móvil o tablet</button></div>`}
      <h4>Lectura por defecto</h4>
      <div class="actions seg" style="display:inline-flex">
        ${[['manga', 'Manga (der. → izq.)'], ['ltr', 'Normal (izq. → der.)'], ['vertical', 'Vertical']].map(([k, l]) => `<button data-defmode="${k}" class="${s.readMode === k ? 'on' : ''}">${l}</button>`).join('')}
      </div>
      <p style="color:var(--muted);font-size:12.5px;margin-top:8px">Porter recuerda el modo que eliges en cada serie.</p>
      <h4>Páginas precargadas</h4>
      <div class="actions seg" style="display:inline-flex">
        ${[5, 10, 20, 40].map((n) => `<button data-preload="${n}" class="${(s.preload ?? 10) === n ? 'on' : ''}">${n}</button>`).join('')}
      </div>
      <p style="color:var(--muted);font-size:12.5px;margin-top:8px">Páginas que Porter tiene listas por delante (y la mitad por detrás). Más páginas = pasos más fluidos tras un salto, a cambio de algo más de memoria.</p>
      <h4>Ayuda</h4>
      <div class="actions"><button class="btn ghost" data-act="report">Reportar un fallo o sugerencia</button></div>
      <h4>Datos</h4>
      <div class="actions"><button class="btn danger" data-act="clear-history">Borrar historial</button></div>
      <div class="foot"><button class="btn ghost" data-act="close-modal">Cerrar</button></div>
    </div>`;
    m.hidden = false;
    if (window.porter.syncDevices) this.renderDevices();
    this.ext?.afterSettings?.();
  }

  // ---------- Móviles emparejados (PC) ----------
  async renderDevices() {
    const box = $('#devices');
    if (!box) return;
    const info = await window.porter.syncDevices();
    this.deviceCount = info.devices.length;
    const ago = (t) => {
      if (!t) return 'nunca';
      const m = Math.round((Date.now() - t) / 60000);
      if (m < 2) return 'ahora mismo';
      if (m < 60) return `hace ${m} min`;
      if (m < 1440) return `hace ${Math.round(m / 60)} h`;
      return new Date(t).toLocaleDateString('es-ES');
    };
    box.innerHTML = info.devices.length ? info.devices.map((d) => `<div class="folder"><span>📱 ${esc(d.name)} <span style="color:var(--muted)">· última sincronización ${ago(d.lastSeen)}${d.pending ? ` · ${d.pending} pendiente${d.pending > 1 ? 's' : ''} de enviar` : ''}</span></span>
      <button class="icon-btn" data-rmdevice="${esc(d.id)}" title="Desemparejar">✕</button></div>`).join('')
      : '<p style="color:var(--muted);font-size:13px">Ninguno todavía. Empareja tu móvil para sincronizar el progreso y pasarle mangas por la Wi‑Fi de casa.</p>';
  }

  async pairDialog() {
    const m = $('#modal');
    m.innerHTML = `<div class="dialog" style="text-align:center"><h3>Emparejar un móvil o tablet</h3><p style="color:var(--muted)">Preparando…</p></div>`;
    m.hidden = false;
    const r = await window.porter.openPairing();
    if (r.error) { m.innerHTML = `<div class="dialog"><h3>No se pudo emparejar</h3><p class="err">${esc(r.error)}</p><div class="foot"><button class="btn ghost" data-act="close-pair">Cerrar</button></div></div>`; return; }
    this.pairing = true;
    m.innerHTML = `<div class="dialog pair">
      <h3>Emparejar un móvil o tablet</h3>
      <div id="pair-main">
        <p>En Porter para Android, pulsa <b>Escanear QR</b> y apunta a este código:</p>
        <img class="qr" src="${r.qr}" alt="Código QR de emparejado">
        <p class="hint">El móvil y este PC tienen que estar en la misma Wi‑Fi. El código caduca en 10 minutos.</p>
        <details class="nocam"><summary>¿La tablet no tiene cámara o no lee el QR?</summary>
          <ol>
            <li>En la tablet pulsa <b>Emparejar sin cámara</b>. Buscará este PC («${esc(r.name)}») en la Wi‑Fi.</li>
            <li>Si no lo encuentra, escribe esta dirección: ${r.addresses.map((a) => `<code>${esc(a)}:${r.port}</code>`).join(' o ') || '<i>no se detectó ninguna red</i>'}</li>
            <li>Aparecerá aquí un número de 6 cifras. Comprueba que es el mismo que ves en la tablet y pulsa <b>Coinciden</b>.</li>
          </ol>
        </details>
      </div>
      <div id="pair-req" hidden></div>
      <div class="foot"><button class="btn ghost" data-act="close-pair">Cerrar</button></div>
    </div>`;
    if (this._pendingPair) { this.showPairRequest(this._pendingPair); this._pendingPair = null; }
  }

  showPairRequest(r) {
    const box = $('#pair-req');
    if (!box || $('#modal').hidden) { this._pendingPair = r; return this.pairDialog(); }
    $('#pair-main').hidden = true;
    box.hidden = false;
    box.innerHTML = `<p><b>${esc(r.name)}</b> quiere emparejarse con este PC.</p>
      <p class="hint">Comprueba que en su pantalla aparece el mismo número:</p>
      <div class="sas">${esc(r.code)}</div>
      <div class="actions" style="justify-content:center"><button class="btn danger" data-sas="no" data-session="${esc(r.session)}">No coinciden</button><button class="btn" data-sas="yes" data-session="${esc(r.session)}">Coinciden</button></div>`;
  }

  contextMenu(e, book) {
    e.preventDefault();
    const c = $('#ctx');
    const p = this.state.progress[book.fp];
    c.innerHTML = `<button data-c="open">Abrir</button>
      ${p ? '<button data-c="reset">Marcar como no leído</button>' : ''}
      ${!p?.finished ? '<button data-c="done">Marcar como leído</button>' : ''}
      ${this.deviceCount ? '<button data-c="phone">Enviar al móvil</button>' : ''}
      ${this.ext?.contextItems ? this.ext.contextItems(book) : '<button data-c="reveal">Mostrar en la carpeta</button>'}`;
    c.style.left = Math.min(e.clientX, innerWidth - 200) + 'px';
    c.style.top = Math.min(e.clientY, innerHeight - 150) + 'px';
    c.hidden = false;
    c.onclick = async (ev) => {
      const a = ev.target.dataset.c; c.hidden = true;
      if (a === 'open') this.openBook(book.id);
      if (a === 'reveal') window.porter.reveal(book.id);
      if (a === 'phone') { await window.porter.sendToPhone([book.fp]); this.toast('Se enviará al móvil la próxima vez que se sincronice'); }
      if (this.ext?.contextAction) this.ext.contextAction(a, book);
      if (a === 'reset') { this._keepScroll = true; this.setState(await window.porter.resetProgress(book.fp)); }
      if (a === 'done') {
        const total = book.pages || 1;
        await window.porter.setProgress(book.id, total - 1, total);
        this._keepScroll = true; this.setState(await window.porter.getLibrary());
      }
    };
  }

  bind() {
    document.querySelectorAll('.tab').forEach((t) => t.onclick = () => { this.view = t.dataset.view; this.series = null; this.render(); this.content.scrollTop = 0; });
    $('#btn-add').onclick = () => this.addFolder();
    $('#btn-settings').onclick = () => this.settings();
    $('#btn-report').onclick = () => this.reportDialog();
    $('#r-report').onclick = () => this.reportDialog(this.reader.context());
    let qt;
    $('#search').oninput = (e) => { clearTimeout(qt); qt = setTimeout(() => { this.query = e.target.value; this.render(); }, 120); };

    document.addEventListener('click', async (e) => {
      $('#ctx').hidden = true;
      const t = e.target;
      const act = t.closest('[data-act]')?.dataset.act;
      if (act === 'add') { $('#modal').hidden = true; return this.addFolder(); }
      if (act === 'report') return this.reportDialog();
      if (act === 'pair') return this.pairDialog();
      if (act === 'close-pair') { this.pairing = false; window.porter.closePairing(); $('#modal').hidden = true; return; }
      const sas = t.closest('[data-sas]');
      if (sas) {
        const ok = sas.dataset.sas === 'yes';
        await window.porter.answerPairing(sas.dataset.session, ok);
        if (!ok) { this.toast('Emparejado cancelado'); this.pairing = false; window.porter.closePairing(); $('#modal').hidden = true; }
        return;
      }
      const rmd = t.closest('[data-rmdevice]')?.dataset.rmdevice;
      if (rmd) { if (confirm('¿Desemparejar este dispositivo? Tendrás que volver a emparejarlo para sincronizar.')) { await window.porter.removeDevice(rmd); this.renderDevices(); } return; }
      if (this.ext?.action && await this.ext.action(act, t, e)) return;
      if (act === 'back') { this.series = null; this.render(); return; }
      if (act === 'rescan') { this.toast('Escaneando…'); this.setState(await window.porter.rescan()); this.toast('Biblioteca actualizada'); return this.settings(); }
      if (act === 'close-modal' || (t.id === 'modal' && !this.pairing)) { $('#modal').hidden = true; return; }
      if (act === 'clear-history') {
        if (confirm('¿Borrar todo el historial de lectura? El progreso de cada libro se mantiene.')) this.setState(await window.porter.clearHistory());
        $('#modal').hidden = true; return;
      }
      const rmf = t.closest('[data-rmfolder]')?.dataset.rmfolder;
      if (rmf) { this.setState(await window.porter.removeFolder(rmf)); return this.settings(); }
      const pl = t.closest('[data-preload]')?.dataset.preload;
      if (pl) { this.state.settings = await window.porter.setSettings({ preload: +pl }); return this.settings(); }
      const dm = t.closest('[data-defmode]')?.dataset.defmode;
      if (dm) { this.state.settings = await window.porter.setSettings({ readMode: dm, seriesMode: {} }); return this.settings(); }
      const rh = t.closest('[data-remove-hist]')?.dataset.removeHist;
      if (rh) { e.stopPropagation(); this._keepScroll = true; this.setState(await window.porter.removeHistory(rh)); return; }
      const op = t.closest('[data-open]')?.dataset.open;
      if (op) return this.openBook(op);
      const card = t.closest('.card');
      if (card) {
        if (card.dataset.series) { this.series = card.dataset.series; this.render(); this.content.scrollTop = 0; }
        else this.openBook(card.dataset.book);
      }
    });

    document.addEventListener('contextmenu', (e) => {
      const card = e.target.closest('.card:not([data-series])');
      if (!card) return;
      const b = this.state.books[card.dataset.book];
      if (b) this.contextMenu(e, b);
    });

    document.addEventListener('keydown', (e) => {
      if (this.reader.isOpen || e.defaultPrevented) return;
      if (e.key === 'Escape') {
        if (!$('#modal').hidden) { if (this.pairing) { this.pairing = false; window.porter.closePairing(); } $('#modal').hidden = true; }
        else if (this.series) { this.series = null; this.render(); }
      }
      if ((e.ctrlKey && e.key === 'f') || (e.key === '/' && document.activeElement.tagName !== 'INPUT')) { e.preventDefault(); $('#search').focus(); }
    });

    // Arrastrar una carpeta a la ventana la añade a la biblioteca
    document.addEventListener('dragover', (e) => e.preventDefault());
    document.addEventListener('drop', async (e) => {
      e.preventDefault();
      for (const f of e.dataTransfer.files) {
        const p = window.porter.pathForFile(f);
        if (p) this.setState(await window.porter.addFolderPath(p));
      }
    });
  }
}

// Errores de la interfaz: se guardan (sin datos personales) para adjuntarlos a los reportes
window.addEventListener('error', (e) => window.porter.logError(`${e.message} @ ${(e.filename || '').split('/').pop()}:${e.lineno}`));
window.addEventListener('unhandledrejection', (e) => window.porter.logError('Promesa: ' + (e.reason?.stack || e.reason)));
const _ce = console.error.bind(console);
console.error = (...a) => { try { window.porter.logError(a.map((x) => x?.stack || String(x)).join(' ')); } catch (_) {} _ce(...a); };

window.app = new App();
