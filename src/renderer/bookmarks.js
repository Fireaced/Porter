// Marcadores: páginas marcadas con un color (12) y un nombre opcional.
// Se ven en el lector (barra de progreso, cinta en la página y panel lateral), en las portadas
// y en la pestaña «Marcadores». Se sincronizan entre PC y móvil.

export const BM_COLORS = [
  { name: 'Rojo', hex: '#ef4444' },
  { name: 'Naranja', hex: '#f97316' },
  { name: 'Amarillo', hex: '#facc15' },
  { name: 'Lima', hex: '#a3e635' },
  { name: 'Verde', hex: '#22c55e' },
  { name: 'Turquesa', hex: '#14b8a6' },
  { name: 'Cian', hex: '#22d3ee' },
  { name: 'Azul', hex: '#3b82f6' },
  { name: 'Morado', hex: '#a855f7' },
  { name: 'Rosa', hex: '#ec4899' },
  { name: 'Marrón', hex: '#a0673a' },
  { name: 'Gris', hex: '#9ca3af' },
];
export const bmHex = (c) => (BM_COLORS[c] || BM_COLORS[0]).hex;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function newBookmarkId() {
  return [...crypto.getRandomValues(new Uint8Array(9))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function bookmarksOf(state, fp) {
  return Object.values(state?.bookmarks || {}).filter((b) => b.fp === fp).sort((a, b) => a.page - b.page || a.created - b.created);
}

// Cintas de colores para la esquina de una portada (una por color, máx. 5)
export function ribbonsHTML(list) {
  if (!list.length) return '';
  const colors = [...new Set(list.map((b) => b.color))].slice(0, 5);
  return `<div class="bm-ribbons" title="${list.length} marcador${list.length > 1 ? 'es' : ''}">${colors.map((c) => `<i style="--c:${bmHex(c)}"></i>`).join('')}</div>`;
}

export function bmLabel(bm) { return bm.name || `Página ${bm.page + 1}`; }

// Editor: 12 colores + nombre. Los cambios se guardan al momento.
export function editorHTML(bm, heading) {
  return `<div class="bm-edit">
    <div class="bm-edit-h"><b>${esc(heading)}</b><span>Pág. ${bm.page + 1}</span></div>
    <div class="bm-swatches">${BM_COLORS.map((c, i) => `<button class="bm-sw ${i === bm.color ? 'on' : ''}" data-bmc="${i}" style="--c:${c.hex}" title="${c.name}" aria-label="${c.name}"></button>`).join('')}</div>
    <input class="bm-name" type="text" maxlength="80" placeholder="Nombre (opcional)" value="${esc(bm.name || '')}">
    <div class="bm-edit-f"><button class="btn ghost danger-text" data-bmx="delete">Eliminar</button><button class="btn" data-bmx="done">Listo</button></div>
  </div>`;
}

// Conecta un editor ya pintado en `root`. save(patch) guarda; del() borra; done() cierra.
export function bindEditor(root, bm, { save, del, done }) {
  root.querySelectorAll('[data-bmc]').forEach((b) => b.onclick = (e) => {
    e.stopPropagation();
    root.querySelectorAll('[data-bmc]').forEach((x) => x.classList.toggle('on', x === b));
    save({ color: +b.dataset.bmc });
  });
  const name = root.querySelector('.bm-name');
  let t;
  name.oninput = () => { clearTimeout(t); t = setTimeout(() => save({ name: name.value.trim() }), 400); };
  name.onkeydown = (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { clearTimeout(t); save({ name: name.value.trim() }); done(); }
    if (e.key === 'Escape') { e.preventDefault(); done(); }
  };
  root.querySelector('[data-bmx="delete"]').onclick = (e) => { e.stopPropagation(); clearTimeout(t); del(); };
  root.querySelector('[data-bmx="done"]').onclick = (e) => { e.stopPropagation(); clearTimeout(t); if (name.value.trim() !== (bm.name || '')) save({ name: name.value.trim() }); done(); };
}

// ---------- Marcadores dentro del lector ----------
export class ReaderBookmarks {
  constructor(reader) {
    this.r = reader;
    this.pop = document.querySelector('#r-bmpop');
    this.panel = document.querySelector('#r-bmpanel');
    this.ribbon = document.querySelector('#r-ribbon');
    this.ticks = document.querySelector('#r-ticks');
    this.thumbs = new Map();
  }
  get app() { return this.r.app; }
  list() { return this.r.book ? bookmarksOf(this.app.state, this.r.book.fp) : []; }
  here() { const sp = this.r.spread || []; return this.list().filter((b) => sp.includes(b.page)); }

  async persist(bm) {
    const snap = await window.porter.saveBookmark(bm);
    if (snap) this.app.state.bookmarks = snap.bookmarks;
    this.refresh();
  }

  async toggle() {
    if (!this.r.book) return;
    const cur = this.here()[0];
    if (cur) return this.openEditor(cur);
    const book = this.r.book, page = this.r.spread[0];
    const color = this.app.state.settings.bmColor ?? 0;
    const bm = { id: newBookmarkId(), fp: book.fp, page, total: this.r.total, color, name: '', title: book.title, series: book.series, ext: book.ext, created: Date.now() };
    this.app.state.bookmarks = { ...(this.app.state.bookmarks || {}), [bm.id]: bm };
    this.refresh();
    this.showAdded(bm);
    try { bm.thumb = await this.r.src.thumb(page, this.r.rotation, 240); } catch (_) {}
    await this.persist(bm);
  }

  showAdded(bm) {
    this.pop.innerHTML = `<div class="bm-added"><i style="background:${bmHex(bm.color)}"></i><span>Marcador añadido · pág. ${bm.page + 1}</span><button class="chip" data-bmx="edit">Editar</button></div>`;
    this.pop.hidden = false;
    this.pop.querySelector('[data-bmx="edit"]').onclick = (e) => { e.stopPropagation(); this.openEditor(this.app.state.bookmarks[bm.id] || bm); };
    clearTimeout(this._popT);
    this._popT = setTimeout(() => { if (this.pop.querySelector('.bm-added')) this.closePop(); }, 3200);
  }

  openEditor(bm) {
    clearTimeout(this._popT);
    this.pop.innerHTML = editorHTML(bm, 'Marcador');
    this.pop.hidden = false;
    this.r.showChrome?.();
    let cur = { ...bm };
    bindEditor(this.pop, bm, {
      save: async (patch) => {
        cur = { ...cur, ...patch };
        if (patch.color != null) this.app.state.settings = await window.porter.setSettings({ bmColor: patch.color });
        this.app.state.bookmarks[cur.id] = cur;
        this.refresh();
        await this.persist(cur);
      },
      del: async () => { await this.remove(cur.id); this.closePop(); },
      done: () => this.closePop(),
    });
  }

  async remove(id) {
    const snap = await window.porter.removeBookmark(id);
    if (snap) this.app.state.bookmarks = snap.bookmarks;
    else delete this.app.state.bookmarks[id];
    this.refresh();
  }

  closePop() { this.pop.hidden = true; this.pop.innerHTML = ''; this.r.stage?.focus(); }
  get popOpen() { return !this.pop.hidden; }

  togglePanel(v = this.panel.hidden) {
    this.panel.hidden = !v;
    if (v) { this.renderPanel(); this.r.showChrome?.(); }
  }

  renderPanel() {
    if (this.panel.hidden) return;
    const list = this.list();
    this.panel.innerHTML = `<div class="bmp-h"><b>Marcadores</b><span>${list.length || ''}</span><button class="icon-btn" data-bmx="close" title="Cerrar">✕</button></div>
      ${list.length ? `<div class="bmp-list">${list.map((b) => `<div class="bmp-item ${this.r.spread.includes(b.page) ? 'cur' : ''}" data-bmgo="${b.id}">
          <div class="bmp-th" style="--c:${bmHex(b.color)}">${b.thumb ? `<img alt="" src="${b.thumb}">` : ''}</div>
          <div class="bmp-tx"><div class="t">${esc(bmLabel(b))}</div><div class="s">Pág. ${b.page + 1}</div></div>
          <button class="icon-btn" data-bmedit="${b.id}" title="Editar">✎</button></div>`).join('')}</div>`
        : `<p class="bmp-empty">Aún no hay marcadores en este tomo. Pulsa <b>🔖</b> (o la tecla B) para marcar la página que estás viendo.</p>`}`;
    this.panel.querySelector('[data-bmx="close"]').onclick = () => this.togglePanel(false);
    this.panel.querySelectorAll('[data-bmgo]').forEach((el) => el.onclick = (e) => {
      const bm = this.app.state.bookmarks[el.dataset.bmgo];
      if (e.target.closest('[data-bmedit]')) return this.openEditor(bm);
      if (bm) this.r.jump(bm.page);
      if (innerWidth < 700) this.togglePanel(false);
    });
  }

  // Marcas en la barra de progreso, cinta en la página actual y botón activo
  refresh() {
    if (!this.r.book) return;
    const list = this.list(), total = this.r.total || 1;
    const rtl = this.r.mode === 'manga';
    this.ticks.innerHTML = list.map((b) => {
      const pct = total > 1 ? (b.page / (total - 1)) * 100 : 0;
      return `<button class="bm-tick" data-bmgo="${b.id}" style="--c:${bmHex(b.color)};${rtl ? 'right' : 'left'}:${pct}%" title="${esc(bmLabel(b))} · pág. ${b.page + 1}"></button>`;
    }).join('');
    this.ticks.querySelectorAll('[data-bmgo]').forEach((t) => t.onclick = (e) => {
      e.stopPropagation();
      const bm = this.app.state.bookmarks[t.dataset.bmgo];
      if (bm) this.r.jump(bm.page);
    });
    const here = this.here();
    this.ribbon.hidden = !here.length;
    this.ribbon.innerHTML = here.map((b) => `<i style="--c:${bmHex(b.color)}" title="${esc(bmLabel(b))}"></i>`).join('');
    if (here.length) this.placeRibbon(here[0].page);
    const btn = document.querySelector('#r-bm');
    if (btn) {
      btn.classList.toggle('on', !!here.length);
      btn.style.color = here.length ? bmHex(here[0].color) : '';
      btn.title = here.length ? 'Editar el marcador de esta página (B)' : 'Marcar esta página (B)';
    }
    this.renderPanel();
  }

  // La cinta cuelga del borde superior derecho de la página marcada
  placeRibbon(page) {
    const st = this.r.stage;
    let el = this.r.mode === 'vertical' ? this.r.vpages?.[page]
      : [...(this.r.curLayer?.el || st).querySelectorAll('canvas, img')].find((c) => c._page === page);
    const sr = st.getBoundingClientRect();
    const rr = el?.getBoundingClientRect();
    const w = this.ribbon.offsetWidth || 20;
    const right = rr && rr.width ? Math.min(rr.right, sr.right) : sr.right - 8;
    this.ribbon.style.left = Math.max(sr.left + 4, right - w - 18) + 'px';
    this.ribbon.style.right = 'auto';
  }

  reset() { this.closePop(); this.panel.hidden = true; this.ticks.innerHTML = ''; this.ribbon.hidden = true; }
}
