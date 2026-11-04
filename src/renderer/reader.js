import { ImageSource, PdfSource } from './sources.js';
import { ReaderBookmarks } from './bookmarks.js';

const $ = (s) => document.querySelector(s);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const isWide = (d) => d && d.w > d.h * 1.1;

export class Reader {
  constructor(app) {
    this.app = app;
    this.el = $('#reader');
    this.stage = $('#stage');
    this.slider = $('#r-slider');
    this.token = 0;
    this.zoom = 1;
    this.idx = 0;
    this.spread = [0];
    this.bm = new ReaderBookmarks(this);
    this._bind();
  }

  // ---------- Apertura / cierre ----------
  async open(bookId, opts = {}) {
    this.closeEnd();
    const info = await window.porter.openBook(bookId);
    const { book } = info;
    this.book = book;
    const s = this.app.state.settings;
    this.mode = s.seriesMode?.[book.series] || s.readMode || 'manga';
    this.double = !!s.doublePage;
    this.shift = false;
    this.fit = s.fit || 'height';
    this.zoom = 1;
    this.rotation = s.rotation?.[book.fp] || 0;

    this.el.hidden = false;
    this.showLoading(true);
    $('#r-name').textContent = book.title;
    $('#r-series').textContent = book.series !== book.title ? book.series : '';

    try {
      this.src = book.ext === 'pdf' ? await PdfSource.open(book.id) : new ImageSource(book.id, info.pages);
    } catch (e) {
      this.el.hidden = true;
      this.showLoading(false);
      throw e;
    }
    this.total = this.src.count;
    if (!this.total) { this.close(); throw new Error('El archivo no contiene páginas'); }
    if (book.ext === 'pdf') window.porter.setPages(book.id, this.total);

    const p = info.progress;
    let start = opts.page != null ? clamp(opts.page, 0, this.total - 1) : p && !p.finished ? clamp(p.page, 0, this.total - 1) : 0;
    this.slider.max = String(this.total - 1);
    this.syncControls();
    this.stage.focus();
    this.showChrome();
    await this.layout(start, true);
    this.bm.refresh();
  }

  close() {
    if (!this.book) { this.el.hidden = true; return; }
    this.saveProgress(true);
    this.token++;
    this.io?.disconnect(); this.io2?.disconnect();
    this.invalidate(true);
    this.curLayer = null;
    this.stage.replaceChildren();
    this.src?.release();
    this.src = null; this.book = null;
    this.el.hidden = true;
    this.closeEnd();
    this.bm.reset();
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    window.porter.fullscreen(false);
    this.app.onReaderClosed();
  }

  get isOpen() { return !!this.book; }

  // Estado del lector para los reportes (sin títulos ni rutas)
  context() {
    if (!this.book) return null;
    return { formato: this.book.ext, modo: this.mode, doble: this.double, desplazar: this.shift, ajuste: this.fit,
      zoom: this.zoom, pagina: this.idx + 1, total: this.total, capas: this.stage.querySelectorAll('.layer').length,
      ventana: `${innerWidth}x${innerHeight}@${devicePixelRatio}` };
  }

  // ---------- Disposición ----------
  async layout(page, align = false) {
    this.stage.className = '';
    this.io?.disconnect(); this.io2?.disconnect();
    this.invalidate(true);
    // Vaciar el escenario: si quedaba la columna del modo vertical (y su scroll), las capas del
    // modo paginado quedaban fuera de la vista y se seguía viendo la imagen antigua.
    this.stage.replaceChildren();
    this.stage.scrollTop = 0; this.stage.scrollLeft = 0;
    this.curLayer = null; this.vpages = null;
    this.src.setBudget?.(this.ahead() + this.behind());
    if (this.mode === 'vertical') return this.buildVertical(page);
    this.stage.classList.add('paged');
    if (this.mode === 'manga') this.stage.classList.add('rtl');
    if (align) page = await this.alignPage(page);
    return this.go(page);
  }

  // Cuántas páginas se traen por adelantado / por detrás (ajustable)
  ahead() { return this.app.state.settings.preload ?? 10; }
  behind() { return Math.max(3, Math.round(this.ahead() / 2)); }

  pairStart() { return this.shift ? 0 : 1; }

  // Dimensiones teniendo en cuenta el giro
  rd(d) { return d && this.rotation % 180 ? { w: d.h, h: d.w } : d; }
  async rdims(i) { return this.rd(await this.src.dims(i)); }
  element(i, w, h, cache = true) {
    return this.src instanceof PdfSource ? this.src.element(i, w, h, cache, this.rotation) : this.src.element(i, w, h, this.rotation);
  }

  async alignPage(i) {
    if (!this.double || i === 0) return i;
    const d = await this.rdims(i).catch(() => null);
    if (isWide(d)) return i;
    if ((i - this.pairStart()) % 2 !== 0 && i > 0) return i - 1;
    return i;
  }

  async spreadAt(i) {
    if (!this.double || this.mode === 'vertical') return [i];
    if (i < this.pairStart() || i + 1 >= this.total) return [i];
    const [a, b] = await Promise.all([this.rdims(i), this.rdims(i + 1)]);
    if (isWide(a) || isWide(b)) return [i];
    return [i, i + 1];
  }

  async prevStart(i) {
    if (i <= 0) return null;
    if (this.double && i - 2 >= this.pairStart()) {
      const s = await this.spreadAt(i - 2);
      if (s.length === 2) return i - 2;
    }
    return i - 1;
  }

  // ----- Capas: cada doble/página se monta oculta y ya decodificada; pasar página = mostrarla -----
  invalidate(dropAll = false) {
    this.gen = (this.gen || 0) + 1;
    for (const l of (this.layers || new Map()).values()) {
      l.then((x) => { if (x && (dropAll || !x.el.classList.contains('cur'))) x.el.remove(); else if (x) x.stale = true; }).catch(() => {});
    }
    this.layers = new Map();
  }

  layer(start) {
    let p = this.layers.get(start);
    if (p) return p;
    const gen = this.gen;
    p = (async () => {
      const spread = await this.spreadAt(start);
      const dims = await Promise.all(spread.map((q) => this.rdims(q)));
      if (gen !== this.gen) return null;
      const sizes = this.computeSizes(dims);
      const nodes = await Promise.all(spread.map((q, k) => this.element(q, sizes[k].w, sizes[k].h)));
      if (gen !== this.gen || !this.book) return null;
      const el = document.createElement('div');
      el.className = 'layer';
      const wrap = document.createElement('div');
      wrap.className = 'spread';
      wrap.append(...nodes);
      el.append(wrap);
      this.stage.append(el);
      return { start, spread, el };
    })();
    this.layers.set(start, p);
    p.then(() => { p.done = true; }, () => this.layers.delete(start));
    return p;
  }

  scroller() {
    if (this.mode === 'vertical') return this.stage;
    return this.curLayer?.el || this.stage;
  }

  async go(i) {
    i = clamp(i, 0, this.total - 1);
    const t = ++this.token;
    this.want = i;
    const instant = !!this.layers.get(i)?.done;
    const slow = setTimeout(() => t === this.token && this.showLoading(true), 120);
    try {
      const L = await this.layer(i);
      if (!L || t !== this.token) return;
      this.show(L, !instant);
    } catch (e) {
      console.error(e);
      if (t === this.token) this.app.toast('No se pudo cargar la página ' + (i + 1));
    } finally {
      clearTimeout(slow);
      if (t === this.token) this.showLoading(false);
    }
  }

  show(L, fade) {
    const prev = this.curLayer;
    L.el.classList.toggle('fade', !!fade && !!prev);
    L.el.classList.add('cur');
    L.el.scrollTop = 0;
    L.el.scrollLeft = this.mode === 'manga' ? L.el.scrollWidth : 0;
    if (prev && prev !== L) { prev.el.classList.remove('cur', 'fade'); if (prev.stale) prev.el.remove(); }
    this.curLayer = L;
    this.idx = L.start; this.spread = L.spread;
    this.updateCounter();
    this.saveProgress();
    this.schedulePreload();
  }

  // Precarga alrededor de la página actual
  schedulePreload() {
    clearTimeout(this._preT);
    this._preT = setTimeout(() => this.preload(), 0);
  }

  async preload() {
    const gen = this.gen, here = this.idx;
    const stillHere = () => gen === this.gen && here === this.idx && this.book;
    // 1) Capas listas (decodificadas): 3 por delante y 1 por detrás
    const keep = new Set([here]);
    let n = this.spread[this.spread.length - 1] + 1;
    for (let k = 0; k < 3 && n < this.total; k++) {
      keep.add(n);
      const L = await this.layer(n).catch(() => null);
      if (!stillHere() || !L) break;
      n = L.spread[L.spread.length - 1] + 1;
    }
    if (!stillHere()) return;
    const pv = await this.prevStart(here);
    if (pv != null && stillHere()) { keep.add(pv); await this.layer(pv).catch(() => {}); }
    if (!stillHere()) return;
    // Quitar capas lejanas
    for (const [k, p] of this.layers) {
      if (keep.has(k)) continue;
      this.layers.delete(k);
      p.then((x) => x && x !== this.curLayer && x.el.remove()).catch(() => {});
    }
    // 2) Bytes de las siguientes N y anteriores N/2 páginas (sin decodificar)
    const last = this.spread[this.spread.length - 1];
    for (let k = 1; k <= this.ahead(); k++) this.src.warm(last + k);
    for (let k = 1; k <= this.behind(); k++) this.src.warm(here - k);
  }

  computeSizes(dims) {
    const W = this.stage.clientWidth, H = this.stage.clientHeight;
    const refH = Math.max(...dims.map((d) => d.h));
    // Igualar alturas dentro de la doble página
    const norm = dims.map((d) => ({ w: d.w * (refH / d.h), h: refH }));
    const totalW = norm.reduce((s, d) => s + d.w, 0);
    let scale;
    if (this.fit === 'width') scale = W / totalW;
    else if (this.fit === 'original') scale = 1 / (window.devicePixelRatio || 1);
    else scale = Math.min(W / totalW, H / refH);
    scale *= this.zoom;
    return norm.map((d) => ({ w: Math.round(d.w * scale), h: Math.round(d.h * scale) }));
  }

  // Base para la siguiente navegación: la última página pedida (aunque aún no se vea)
  async navBase() {
    const p = this.layers.get(this.want);
    const L = p ? await p.catch(() => null) : null;
    return L || { start: this.idx, spread: this.spread };
  }

  async next() {
    if (this.mode === 'vertical') return this.scrollBy(0.9);
    const b = await this.navBase();
    const n = b.spread[b.spread.length - 1] + 1;
    if (n >= this.total) return this.showEnd();
    return this.go(n);
  }

  async prev() {
    if (this.mode === 'vertical') return this.scrollBy(-0.9);
    const b = await this.navBase();
    const pv = await this.prevStart(b.start);
    if (pv == null) return;
    return this.go(pv);
  }

  async jump(i) {
    i = clamp(i, 0, this.total - 1);
    if (this.mode === 'vertical') return this.vScrollTo(i);
    return this.go(await this.alignPage(i));
  }

  // ---------- Modo vertical (webtoon / scroll continuo) ----------
  verticalWidth() {
    const W = this.stage.clientWidth - 2;
    let w;
    if (this.fit === 'width') w = W;
    else if (this.fit === 'original') {
      const d = this.src.knownDims(0);
      w = d ? d.w / (window.devicePixelRatio || 1) : Math.min(W, 960);
    } else w = Math.min(W, 960);
    return Math.round(w * this.zoom);
  }

  async buildVertical(start) {
    this.stage.classList.add('vertical');
    const t = ++this.token;
    await this.src.dims(start).catch(() => {});
    await this.src.dims(0).catch(() => {});
    if (t !== this.token) return;
    const w = this.verticalWidth();
    const fallback = this.rd(this.src.knownDims(start) || this.src.knownDims(0)) || { w: 1, h: 1.42 };
    const col = document.createElement('div');
    col.className = 'vcol';
    col.style.width = w + 'px';
    this.vpages = [];
    for (let i = 0; i < this.total; i++) {
      const d = this.rd(this.src.knownDims(i)) || fallback;
      const div = document.createElement('div');
      div.className = 'vpage';
      div.dataset.i = i;
      div.style.height = Math.round(w * d.h / d.w) + 'px';
      this.vpages.push(div);
      col.append(div);
    }
    // Al final de la columna: aviso de fin y paso al siguiente tomo
    const end = document.createElement('div');
    end.className = 'vend';
    col.append(end);
    this.fillEndBox(end);
    this.stage.replaceChildren(col);
    this.showLoading(false);

    const attach = (div) => {
      if (div.firstChild || div._loading) return;
      const i = +div.dataset.i;
      div._loading = true;
      const fit = (d) => {
        const width = parseFloat(col.style.width);
        div.style.height = Math.round(width * d.h / d.w) + 'px';
      };
      if (this.src instanceof ImageSource) {
        const img = this.src.freshElement(i);
        const rot = this.rotation;
        img.decode().then(() => {
          const nd = { w: img.naturalWidth, h: img.naturalHeight };
          fit(this.rd(nd));
          if (rot) {
            Object.assign(img.style, { inset: 'auto', left: '50%', top: '50%', transform: `translate(-50%, -50%) rotate(${rot}deg)` });
            if (rot % 180) { img.style.width = (nd.w / nd.h * 100) + '%'; img.style.height = (nd.h / nd.w * 100) + '%'; }
          }
        }).catch(() => {});
        div.append(img); div._loading = false;
      } else {
        this.rdims(i).then((d) => {
          fit(d);
          const width = parseFloat(col.style.width);
          return this.element(i, width, Math.round(width * d.h / d.w), false);
        }).then((c) => { if (div._wanted !== false) div.replaceChildren(c); else { c.width = 0; c.height = 0; } })
          .catch(() => {}).finally(() => { div._loading = false; });
      }
    };
    const detach = (div) => {
      div._wanted = false;
      const n = div.firstChild;
      if (!n) return;
      if (n.tagName === 'IMG') n.src = ''; else { n.width = 0; n.height = 0; }
      div.replaceChildren();
    };

    this.io = new IntersectionObserver((ents) => {
      for (const e of ents) if (e.isIntersecting) { e.target._wanted = true; attach(e.target); }
    }, { root: this.stage, rootMargin: '180% 0px' });
    this.io2 = new IntersectionObserver((ents) => {
      for (const e of ents) if (!e.isIntersecting) detach(e.target);
    }, { root: this.stage, rootMargin: '500% 0px' });
    for (const d of this.vpages) { this.io.observe(d); this.io2.observe(d); }

    this.vScrollTo(start);
    this.idx = start; this.spread = [start];
    this.updateCounter();
  }

  vStep(d) {
    const n = this.idx + d;
    if (n >= this.total) return this.showEnd();
    this.vScrollTo(clamp(n, 0, this.total - 1));
  }

  vScrollTo(i) {
    const d = this.vpages?.[i];
    if (d) this.stage.scrollTop = d.offsetTop;
  }

  onVerticalScroll() {
    if (this.mode !== 'vertical' || !this.vpages) return;
    const y = this.stage.scrollTop + this.stage.clientHeight * 0.35;
    let lo = 0, hi = this.vpages.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.vpages[mid].offsetTop <= y) lo = mid; else hi = mid - 1;
    }
    // ¿Al final del todo? cuenta como última página
    if (this.stage.scrollTop + this.stage.clientHeight >= this.stage.scrollHeight - 4) lo = this.total - 1;
    if (lo !== this.idx) {
      this.idx = lo; this.spread = [lo];
      this.updateCounter();
      this.saveProgress();
      for (let k = 1; k <= this.ahead(); k++) this.src.warm(lo + k);
    }
  }

  scrollBy(f) {
    const atEnd = this.stage.scrollTop + this.stage.clientHeight >= this.stage.scrollHeight - 4;
    if (f > 0 && atEnd) return this.showEnd();
    this.stage.scrollBy({ top: this.stage.clientHeight * f, behavior: 'smooth' });
  }

  async rezoom(z) {
    z = clamp(Math.round(z * 100) / 100, 0.25, 6);
    if (z === this.zoom) return;
    if (this.mode === 'vertical' && this.vpages) {
      const cur = this.vpages[this.idx];
      const frac = cur ? (this.stage.scrollTop - cur.offsetTop) / cur.offsetHeight : 0;
      this.zoom = z;
      const w = this.verticalWidth();
      const col = this.stage.firstChild;
      col.style.width = w + 'px';
      for (const div of this.vpages) {
        const d = this.rd(this.src.knownDims(+div.dataset.i));
        if (d) div.style.height = Math.round(w * d.h / d.w) + 'px';
        else div.style.height = Math.round(parseFloat(div.style.height) * z / (this._lastZ || 1)) + 'px';
        if (this.src instanceof PdfSource && div.firstChild) { div.replaceChildren(); this.io.unobserve(div); this.io.observe(div); }
      }
      if (cur) this.stage.scrollTop = cur.offsetTop + frac * cur.offsetHeight;
    } else {
      this.zoom = z;
      this.invalidate();
      await this.go(this.idx);
    }
    this._lastZ = z;
    this.updateCounter();
  }

  // ---------- Progreso ----------
  saveProgress(now = false) {
    if (!this.book) return;
    const page = this.spread[this.spread.length - 1];
    const id = this.book.id, total = this.total;
    this.app.localProgress(this.book.fp, page, total);
    clearTimeout(this._saveT);
    const doSave = () => window.porter.setProgress(id, page, total);
    if (now) doSave(); else this._saveT = setTimeout(doSave, 350);
  }

  // ---------- Interfaz ----------
  updateCounter() {
    const a = this.spread[0] + 1, b = this.spread[this.spread.length - 1] + 1;
    $('#r-count').textContent = (a === b ? `${a}` : `${a}–${b}`) + ` / ${this.total}`;
    this.slider.value = String(this.spread[0]);
    $('#r-zoom').textContent = this.zoom === 1 ? '' : Math.round(this.zoom * 100) + '%';
    const atEnd = this.spread[this.spread.length - 1] >= this.total - 1;
    const nb = $('#r-next');
    if (nb) {
      const next = atEnd ? this.app.nextFor(this.book) : null;
      nb.hidden = !next;
      if (next) nb.textContent = 'Siguiente tomo ›';
    }
    this.bm?.refresh();
  }

  // ---------- Girar ----------
  async rotate(delta = 90) {
    this.rotation = (this.rotation + delta + 360) % 360;
    const s = this.app.state.settings;
    const rotation = { ...(s.rotation || {}) };
    if (this.rotation) rotation[this.book.fp] = this.rotation; else delete rotation[this.book.fp];
    this.app.state.settings = await window.porter.setSettings({ rotation });
    this.syncControls();
    const page = this.spread[0];
    await this.layout(page, true);
  }

  syncControls() {
    document.querySelectorAll('#r-mode button').forEach((b) => b.classList.toggle('on', b.dataset.mode === this.mode));
    document.querySelectorAll('#r-fit button').forEach((b) => b.classList.toggle('on', b.dataset.fit === this.fit));
    $('#r-double').classList.toggle('on', this.double);
    $('#r-double').disabled = this.mode === 'vertical';
    $('#r-shift').classList.toggle('on', this.shift);
    $('#r-shift').disabled = this.mode === 'vertical' || !this.double;
    this.slider.classList.toggle('rtl', this.mode === 'manga');
    this.bm?.refresh();
    const rb = $('#r-rotate');
    if (rb) { rb.classList.toggle('on', !!this.rotation); rb.title = `Girar (R)${this.rotation ? ' · ' + this.rotation + '°' : ''}`; }
  }

  async setMode(m) {
    if (m === this.mode) return;
    const page = this.spread[0];
    this.mode = m;
    this.zoom = 1;
    this.syncControls();
    const s = this.app.state.settings;
    const seriesMode = { ...(s.seriesMode || {}), [this.book.series]: m };
    this.app.state.settings = await window.porter.setSettings({ seriesMode });
    await this.layout(page, true);
  }

  async setDouble(v) {
    this.double = v; this.syncControls();
    this.app.state.settings = await window.porter.setSettings({ doublePage: v });
    if (this.mode !== 'vertical') { this.invalidate(); this.go(await this.alignPage(this.spread[0])); }
  }

  async setFit(f) {
    this.fit = f; this.zoom = 1; this.syncControls();
    this.app.state.settings = await window.porter.setSettings({ fit: f });
    await this.layout(this.spread[0]);
  }

  showLoading(v) { $('#r-loading').hidden = !v; }

  showChrome() {
    this.el.classList.remove('chrome-off', 'idle');
    clearTimeout(this._hideT);
    this._hideT = setTimeout(() => {
      if (this._hover) return;
      this.el.classList.add('chrome-off', 'idle');
    }, 2200);
  }
  toggleChrome() {
    if (this.el.classList.contains('chrome-off')) this.showChrome();
    else { clearTimeout(this._hideT); this.el.classList.add('chrome-off'); }
  }

  // Contenido de "Has terminado" (superpuesto o al final de la columna vertical)
  fillEndBox(box) {
    const next = this.app.nextFor(this.book);
    box.innerHTML = '';
    const d = document.createElement('div');
    d.className = 'box';
    d.innerHTML = `<h3>Has terminado</h3><p></p><div class="actions"></div>`;
    d.querySelector('p').textContent = this.book.title;
    const act = d.querySelector('.actions');
    const back = document.createElement('button');
    back.className = 'btn ghost'; back.textContent = 'Volver a la biblioteca';
    back.onclick = () => this.close();
    act.append(back);
    if (next) {
      const nx = document.createElement('button');
      nx.className = 'btn next-btn'; nx.textContent = (next.where === 'pc' ? 'Siguiente (en el PC): ' : 'Siguiente: ') + next.title;
      nx.onclick = () => this.goNextBook();
      act.append(nx);
    }
    box.append(d);
    return next;
  }

  async goNextBook() {
    const next = this.app.nextFor(this.book);
    if (!next) return;
    this.saveProgress(true);
    this.close();
    await next.open();
  }

  showEnd() {
    const box = $('#r-end');
    const next = this.fillEndBox(box);
    box.hidden = false;
    if (next) setTimeout(() => box.querySelector('.next-btn')?.focus(), 0);
    this.saveProgress(true);
  }
  closeEnd() { $('#r-end').hidden = true; }

  // ---------- Eventos ----------
  _bind() {
    const st = this.stage;
    $('#r-back').onclick = () => this.close();
    $('#r-full').onclick = () => window.porter.fullscreen();
    if ($('#r-rotate')) $('#r-rotate').onclick = () => this.rotate(90);
    if ($('#r-next')) $('#r-next').onclick = () => this.goNextBook();
    $('#r-bm').onclick = () => this.bm.toggle();
    $('#r-bmlist').onclick = () => this.bm.togglePanel();
    $('#r-double').onclick = () => this.setDouble(!this.double);
    $('#r-shift').onclick = async () => { this.shift = !this.shift; this.syncControls(); this.invalidate(); this.go(await this.alignPage(this.spread[0])); };
    document.querySelectorAll('#r-mode button').forEach((b) => b.onclick = () => this.setMode(b.dataset.mode));
    document.querySelectorAll('#r-fit button').forEach((b) => b.onclick = () => this.setFit(b.dataset.fit));
    this.slider.oninput = () => { $('#r-count').textContent = `${+this.slider.value + 1} / ${this.total}`; };
    this.slider.onchange = () => this.jump(+this.slider.value);
    for (const id of ['#r-top', '#r-bottom', '#r-bmpanel', '#r-bmpop']) {
      const bar = $(id);
      bar.addEventListener('mouseenter', () => { this._hover = true; this.showChrome(); });
      bar.addEventListener('mouseleave', () => { this._hover = false; this.showChrome(); });
    }
    this.el.addEventListener('mousemove', (e) => {
      if (Math.abs(e.movementX) + Math.abs(e.movementY) < 2) return;
      this.el.classList.remove('idle');
      const H = window.innerHeight;
      if (e.clientY < 70 || e.clientY > H - 70) this.showChrome();
      else {
        clearTimeout(this._idleT);
        this._idleT = setTimeout(() => this.el.classList.add('idle'), 1800);
      }
    });

    let resizeT;
    window.addEventListener('resize', () => {
      if (!this.isOpen) return;
      clearTimeout(resizeT);
      resizeT = setTimeout(() => {
        if (this.mode === 'vertical') this.layout(this.spread[0]);
        else { this.invalidate(); this.go(this.spread[0]); }
      }, 120);
    });

    st.addEventListener('scroll', () => {
      if (this._scrollRaf) return;
      this._scrollRaf = requestAnimationFrame(() => { this._scrollRaf = 0; this.onVerticalScroll(); });
    }, { passive: true });

    // Arrastrar para desplazar cuando la página no cabe (zoom / 100% / ancho)
    // Ratón y táctil: arrastrar para mover, deslizar para pasar página, doble toque para zoom,
    // pellizcar para hacer zoom (táctil) y toques en los laterales para pasar página.
    let drag = null;
    const pointers = new Map();
    let pinch = null;
    let lastTap = null, tapTimer = null;
    st.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2 && this.mode !== 'vertical') {
        const [a, b] = [...pointers.values()];
        pinch = { d0: Math.hypot(a.x - b.x, a.y - b.y), ratio: 1, el: this.scroller() };
        drag = null;
        return;
      }
      const sc = this.scroller();
      drag = { sc, x: e.clientX, y: e.clientY, dx: 0, dy: 0, sl: sc.scrollLeft, stp: sc.scrollTop, moved: false, t: performance.now(), type: e.pointerType };
    });
    window.addEventListener('pointermove', (e) => {
      if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch && pointers.size >= 2) {
        const [a, b] = [...pointers.values()];
        pinch.ratio = Math.max(0.5, Math.min(4, Math.hypot(a.x - b.x, a.y - b.y) / pinch.d0));
        const inner = pinch.el.firstElementChild;
        if (inner) { inner.style.transform = `scale(${pinch.ratio})`; inner.style.transformOrigin = 'center'; }
        return;
      }
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      drag.dx = dx; drag.dy = dy;
      if (!drag.moved && Math.hypot(dx, dy) > 8) {
        drag.moved = true; st.classList.add('grabbing');
        try { st.setPointerCapture(e.pointerId); } catch (_) {}
      }
      if (drag.moved && drag.type === 'mouse' || (drag.moved && this.mode !== 'vertical')) {
        drag.sc.scrollLeft = drag.sl - dx; drag.sc.scrollTop = drag.stp - dy;
      }
    });
    const endPointer = (e) => {
      pointers.delete(e.pointerId);
      if (pinch) {
        if (pointers.size < 2) {
          const inner = pinch.el.firstElementChild;
          if (inner) inner.style.transform = '';
          const r = pinch.ratio; pinch = null;
          if (Math.abs(r - 1) > 0.05) this.rezoom(this.zoom * r);
        }
        return;
      }
      if (!drag) return;
      const d = drag; drag = null; st.classList.remove('grabbing');
      if (e.type === 'pointercancel' || !this.isOpen || e.target.closest?.('.r-bar')) return;
      if (d.moved) {
        // Deslizar para pasar página (si la página cabe a lo ancho)
        const fitsX = d.sc.scrollWidth <= d.sc.clientWidth + 2;
        const fast = performance.now() - d.t < 600;
        if (this.mode !== 'vertical' && fitsX && fast && Math.abs(d.dx) > 50 && Math.abs(d.dx) > Math.abs(d.dy) * 1.4) {
          const towardsNext = this.mode === 'manga' ? d.dx > 0 : d.dx < 0;
          towardsNext ? this.next() : this.prev();
        }
        return;
      }
      if (!e.target.closest?.('#stage')) return;
      if (this.bm.popOpen) { this.bm.closePop(); return; }
      const x = e.clientX / window.innerWidth;
      const act = () => {
        if (this.mode === 'vertical') { if (x > 0.3 && x < 0.7) this.toggleChrome(); return; }
        if (x < 0.3) this.mode === 'manga' ? this.next() : this.prev();
        else if (x > 0.7) this.mode === 'manga' ? this.prev() : this.next();
        else this.toggleChrome();
      };
      // En táctil, el doble toque hace zoom; el toque simple espera un instante
      if (d.type === 'touch') {
        const now = performance.now();
        if (lastTap && now - lastTap.t < 280 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 40) {
          clearTimeout(tapTimer); lastTap = null;
          this.rezoom(this.zoom > 1.05 ? 1 : 2);
          return;
        }
        lastTap = { t: now, x: e.clientX, y: e.clientY };
        clearTimeout(tapTimer);
        tapTimer = setTimeout(() => { lastTap = null; act(); }, 260);
        return;
      }
      act();
    };
    window.addEventListener('pointerup', endPointer);
    window.addEventListener('pointercancel', endPointer);

    let wheelLock = 0;
    st.addEventListener('wheel', (e) => {
      if (e.ctrlKey) { e.preventDefault(); this.rezoom(this.zoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12)); return; }
      if (this.mode === 'vertical') return;
      const sc = this.scroller();
      const canScroll = sc.scrollHeight > sc.clientHeight + 2;
      const atBottom = sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 2;
      const atTop = sc.scrollTop <= 0;
      if (canScroll && ((e.deltaY > 0 && !atBottom) || (e.deltaY < 0 && !atTop))) return;
      e.preventDefault();
      const now = performance.now();
      if (now - wheelLock < 260) return;
      wheelLock = now;
      e.deltaY > 0 ? this.next() : this.prev();
    }, { passive: false });

    document.addEventListener('keydown', (e) => {
      if (!this.isOpen) return;
      if (!document.querySelector('#modal').hidden) { if (e.key === 'Escape') { document.querySelector('#modal').hidden = true; e.preventDefault(); } return; }
      if ((e.target.tagName === 'INPUT' && e.target.type !== 'range') || e.target.tagName === 'TEXTAREA') return;
      const k = e.key;
      const endOpen = !$('#r-end').hidden;
      if (endOpen && k !== 'Escape' && k !== 'Enter') { if (k === 'ArrowLeft' || k === 'ArrowRight' || k === 'Backspace') this.closeEnd(); return; }
      const manga = this.mode === 'manga', vert = this.mode === 'vertical';
      let handled = true;
      const sc = this.scroller();
      switch (k) {
        case 'ArrowLeft': if (vert) this.vStep(-1); else manga ? this.next() : this.prev(); break;
        case 'ArrowRight': if (vert) this.vStep(1); else manga ? this.prev() : this.next(); break;
        case 'ArrowDown': if (vert) handled = false; else if (sc.scrollHeight > sc.clientHeight + 2 && sc.scrollTop + sc.clientHeight < sc.scrollHeight - 2) { sc.scrollBy({ top: 80 }); } else this.next(); break;
        case 'ArrowUp': if (vert) handled = false; else if (sc.scrollTop > 0) { sc.scrollBy({ top: -80 }); } else this.prev(); break;
        case ' ': case 'PageDown': e.shiftKey ? this.prev() : this.next(); break;
        case 'PageUp': this.prev(); break;
        case 'Home': this.jump(0); break;
        case 'End': this.jump(this.total - 1); break;
        case 'f': case 'F': case 'F11': window.porter.fullscreen(); break;
        case 'm': case 'M': this.setMode({ manga: 'ltr', ltr: 'vertical', vertical: 'manga' }[this.mode]); break;
        case 'd': case 'D': if (!vert) this.setDouble(!this.double); break;
        case 'r': case 'R': this.rotate(e.shiftKey ? -90 : 90); break;
        case 'b': case 'B': this.bm.toggle(); break;
        case 'l': case 'L': this.bm.togglePanel(); break;
        case '+': case '=': this.rezoom(this.zoom * 1.2); break;
        case '-': this.rezoom(this.zoom / 1.2); break;
        case '0': this.rezoom(1); break;
        case 'Escape':
          if (this.bm.popOpen) this.bm.closePop();
          else if (!this.bm.panel.hidden) this.bm.togglePanel(false);
          else if (endOpen) this.closeEnd();
          else if (this.isFull) window.porter.fullscreen(false);
          else this.close();
          break;
        case 'Enter': if (endOpen) ($('#r-end .next-btn') || document.activeElement)?.click?.(); else handled = false; break;
        default: handled = false;
      }
      if (handled) e.preventDefault();
    });
    window.porter.onFullscreen((v) => { this.isFull = v; });
  }
}
