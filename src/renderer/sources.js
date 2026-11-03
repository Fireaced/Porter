// Fuentes de páginas: imágenes (CBZ/CBR) y PDF.
// Interfaz común: count, dims(i) -> {w,h}, element(i, cssW, cssH) -> nodo listo, release()

// Plataforma: Electron usa el protocolo porter://; Android aporta sus propias funciones en window.porter
const PF = () => window.porter || {};
const PDFJS_BASE = () => PF().pdfjsBase || 'porter://app/pdfjs/';

let pdfjsPromise = null;
function pdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import(/* @vite-ignore */ PDFJS_BASE() + 'pdf.min.mjs').then((m) => {
      m.GlobalWorkerOptions.workerSrc = PDFJS_BASE() + 'pdf.worker.min.mjs';
      return m;
    });
  }
  return pdfjsPromise;
}

async function pdfParams(bookId) {
  const src = PF().pdfSource ? await PF().pdfSource(bookId) : { url: `porter://file/${bookId}` };
  return { ...src, isEvalSupported: false, enableXfa: false };
}

class LRU {
  constructor(max, onEvict) { this.max = max; this.map = new Map(); this.onEvict = onEvict; }
  get(k) { const v = this.map.get(k); if (v !== undefined) { this.map.delete(k); this.map.set(k, v); } return v; }
  set(k, v) {
    this.map.delete(k); this.map.set(k, v);
    while (this.map.size > this.max) {
      const [ok, ov] = this.map.entries().next().value;
      this.map.delete(ok); this.onEvict?.(ov, ok);
    }
  }
  clear() { for (const [k, v] of this.map) this.onEvict?.(v, k); this.map.clear(); }
}

// Tamaño en píxeles reales de pantalla (con límite de memoria para zooms extremos)
function devicePixels(w, h, natW, natH) {
  const dpr = window.devicePixelRatio || 1;
  let pw = Math.max(1, Math.round(w * dpr)), ph = Math.max(1, Math.round(h * dpr));
  const max = 40e6;
  if (pw * ph > max) { const f = Math.sqrt(max / (pw * ph)); pw = Math.round(pw * f); ph = Math.round(ph * f); }
  return { pw, ph };
}

// Copia un bitmap ya decodificado a un <canvas> nuevo: mostrarlo no requiere más decodificación
function canvasFrom(src, w, h, page) {
  const c = document.createElement('canvas');
  c.width = src.width; c.height = src.height;
  c.getContext('2d').drawImage(src, 0, 0);
  c.style.width = w + 'px'; c.style.height = h + 'px';
  c._page = page;
  return c;
}

export class ImageSource {
  constructor(bookId, count) {
    this.id = bookId; this.count = count;
    this.dimCache = new Map();
    // Nivel 1: bytes originales traídos del archivo (sin decodificar)
    this.blobs = new LRU(48);
    // Nivel 2: páginas decodificadas y escaladas a la resolución exacta de pantalla.
    // Las controla Porter (no la caché interna del navegador), así que no pueden "caducar" sin aviso.
    this.bitmaps = new LRU(14, (p) => p.then((b) => b.close()).catch(() => {}));
  }
  url(i) { return `porter://page/${this.id}/${i}`; }
  setBudget(n) { this.blobs.max = Math.max(16, n + 8); }
  blob(i) {
    if (i < 0 || i >= this.count) return Promise.reject(new Error('rango'));
    let p = this.blobs.get(i);
    if (!p) {
      p = PF().pageBlob ? PF().pageBlob(this.id, i)
        : fetch(this.url(i)).then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.blob(); });
      this.blobs.set(i, p);
      p.catch(() => this.blobs.map.delete(i));
    }
    return p;
  }
  knownDims(i) { return this.dimCache.get(i); }
  async dims(i) {
    let d = this.dimCache.get(i);
    if (d) return d;
    if (!this._dimP) this._dimP = new Map();
    let p = this._dimP.get(i);
    if (!p) {
      p = this.blob(i).then((b) => new Promise((res, rej) => {
        const u = URL.createObjectURL(b);
        const img = new Image();
        img.onload = () => { const d = { w: img.naturalWidth, h: img.naturalHeight }; this.dimCache.set(i, d); URL.revokeObjectURL(u); img.src = ''; res(d); };
        img.onerror = () => { URL.revokeObjectURL(u); rej(new Error('imagen')); };
        img.src = u;
      }));
      this._dimP.set(i, p);
      p.finally(() => this._dimP.delete(i)).catch(() => {});
    }
    return p;
  }
  bitmap(i, pw, ph) {
    const key = `${i}@${pw}x${ph}`;
    let p = this.bitmaps.get(key);
    if (!p) {
      p = this.blob(i).then((b) => createImageBitmap(b, { resizeWidth: pw, resizeHeight: ph, resizeQuality: 'high' }));
      this.bitmaps.set(key, p);
      p.catch(() => this.bitmaps.map.delete(key));
    }
    return p;
  }
  // Devuelve un <canvas> nuevo con la página ya decodificada al tamaño pedido
  async element(i, w, h) {
    const d = await this.dims(i);
    const { pw, ph } = devicePixels(w, h, d.w, d.h);
    const bmp = await this.bitmap(i, pw, ph);
    return canvasFrom(bmp, w, h, i);
  }
  // Modo vertical: <img> nuevo por página, usando los bytes precargados si existen
  freshElement(i) {
    const img = new Image(); img.decoding = 'async'; img.draggable = false;
    this.blob(i).then((b) => {
      const u = URL.createObjectURL(b);
      img.addEventListener('load', () => setTimeout(() => URL.revokeObjectURL(u), 1000), { once: true });
      img.src = u;
    }).catch(() => { img.src = this.url(i); });
    return img;
  }
  warm(i) { if (i >= 0 && i < this.count) this.blob(i).catch(() => {}); }
  prefetch(i) { if (i >= 0 && i < this.count) this.dims(i).catch(() => {}); }
  release() { this.bitmaps.clear(); this.blobs.clear(); }
}

export class PdfSource {
  static async open(bookId) {
    const lib = await pdfjs();
    const doc = await lib.getDocument(await pdfParams(bookId)).promise;
    return new PdfSource(doc);
  }
  constructor(doc) {
    this.doc = doc; this.count = doc.numPages;
    this.dimCache = new Map();
    this.pageCache = new Map();
    this.canvases = new LRU(16, (p) => p.then((c) => { c.width = 0; c.height = 0; }).catch(() => {}));
  }
  page(i) {
    if (!this.pageCache.has(i)) this.pageCache.set(i, this.doc.getPage(i + 1));
    return this.pageCache.get(i);
  }
  knownDims(i) { return this.dimCache.get(i); }
  async dims(i) {
    let d = this.dimCache.get(i);
    if (!d) {
      const vp = (await this.page(i)).getViewport({ scale: 1 });
      d = { w: vp.width, h: vp.height };
      this.dimCache.set(i, d);
    }
    return d;
  }
  // Renderiza a la resolución exacta de pantalla (× devicePixelRatio): máxima nitidez
  async element(i, w, h, useCache = true) {
    const base0 = await this.dims(i);
    const { pw, ph } = devicePixels(w, h, base0.w, base0.h);
    const key = `${i}@${pw}x${ph}`;
    let p = useCache ? this.canvases.get(key) : null;
    if (!p) {
      p = (async () => {
        const page = await this.page(i);
        const base = page.getViewport({ scale: 1 });
        const vp = page.getViewport({ scale: pw / base.width });
        const c = document.createElement('canvas');
        c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
        const ctx = c.getContext('2d', { alpha: false });
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
        await page.render({ canvasContext: ctx, viewport: vp, intent: 'display' }).promise;
        return c;
      })();
      if (useCache) { this.canvases.set(key, p); p.catch(() => this.canvases.map.delete(key)); }
    }
    const master = await p;
    if (!useCache) { master.style.width = w + 'px'; master.style.height = h + 'px'; return master; }
    return canvasFrom(master, w, h, i);
  }
  setBudget() {}
  warm(i) { if (i >= 0 && i < this.count) this.dims(i).catch(() => {}); }
  prefetch(i) { if (i >= 0 && i < this.count) this.dims(i).catch(() => {}); }
  release() { this.canvases.clear(); this.doc.destroy(); }
}

// Portada pequeña (webp) para la biblioteca/historial
export async function makeCover(book) {
  const W = 360;
  let bitmap;
  if (book.ext === 'pdf') {
    const lib = await pdfjs();
    const doc = await lib.getDocument(await pdfParams(book.id)).promise;
    try {
      const page = await doc.getPage(1);
      const base = page.getViewport({ scale: 1 });
      const vp = page.getViewport({ scale: (W * 1.5) / base.width });
      const c = new OffscreenCanvas(Math.floor(vp.width), Math.floor(vp.height));
      const ctx = c.getContext('2d', { alpha: false });
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      bitmap = await createImageBitmap(c, { resizeWidth: W, resizeQuality: 'high' });
      book.pages = doc.numPages;
      window.porter.setPages(book.id, doc.numPages);
    } finally { doc.destroy(); }
  } else {
    let blob;
    if (PF().thumbBlob) blob = await PF().thumbBlob(book);
    else {
      const r = await fetch(`porter://thumb/${book.id}`);
      if (!r.ok) throw new Error('sin portada');
      blob = await r.blob();
    }
    const full = await createImageBitmap(blob);
    // Si la primera página es una doble (apaisada), usar la mitad derecha como portada
    let sx = 0, sw = full.width;
    if (full.width > full.height * 1.15) { sx = full.width / 2; sw = full.width / 2; }
    bitmap = await createImageBitmap(full, sx, 0, sw, full.height, { resizeWidth: W, resizeQuality: 'high' });
    full.close();
  }
  const c = new OffscreenCanvas(bitmap.width, bitmap.height);
  c.getContext('2d').drawImage(bitmap, 0, 0);
  bitmap.close();
  const out = await c.convertToBlob({ type: 'image/webp', quality: 0.86 });
  await window.porter.saveCover(book.fp, await out.arrayBuffer());
}
