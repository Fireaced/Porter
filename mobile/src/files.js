// Libros como archivos originales (CBZ/CBR/PDF) en el móvil: en carpetas elegidas por el usuario
// o en la memoria de la app. Se leen por trozos, sin cargar el archivo entero.
import { Capacitor, registerPlugin } from '@capacitor/core';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { inflateSync } from 'fflate';

export const PorterFiles = registerPlugin('PorterFiles', {
  web: () => import('./files-web.js').then((m) => new m.PorterFilesWeb()),
});

const native = Capacitor.isNativePlatform();
const IMG = /\.(jpe?g|png|webp|gif|avif|bmp)$/i;
const MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif', bmp: 'image/bmp' };
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const mimeOf = (name) => MIME[name.split('.').pop().toLowerCase()] || 'application/octet-stream';

export function b64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
export function unb64(str) {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

let dataUri = null;   // file:///…/files (Directory.Data)
async function dataRoot() {
  if (!dataUri) dataUri = (await Filesystem.getUri({ path: '', directory: Directory.Data })).uri.replace(/\/$/, '');
  return dataUri;
}

// ---------- acceso por trozos ----------
// Devuelve { size, read(offset, length) -> Uint8Array }
export async function openHandle(book) {
  const f = book.file;
  if (f.kind === 'saf' || native) {
    const uri = f.kind === 'saf' ? f.uri : `${await dataRoot()}/${f.path.split('/').map(encodeURIComponent).join('/')}`;
    const read = async (offset, length) => {
      const out = new Uint8Array(length);
      let got = 0;
      while (got < length) {
        const n = Math.min(4 * 1024 * 1024, length - got);
        const r = await PorterFiles.read({ uri, offset: offset + got, length: n });
        const part = unb64(r.data);
        out.set(part, got);
        got += part.length;
        if (part.length < n) break;
      }
      return got < length ? out.subarray(0, got) : out;
    };
    let size = book.size;
    if (!size) size = (await PorterFiles.read({ uri, offset: 0, length: 0 })).size;
    return { size, read };
  }
  // Navegador (pruebas): se lee de la memoria simulada de Capacitor
  const r = await Filesystem.readFile({ path: f.path, directory: Directory.Data });
  const all = typeof r.data === 'string' ? unb64(r.data) : new Uint8Array(await r.data.arrayBuffer());
  return { size: all.length, read: async (o, l) => all.slice(o, o + l) };
}

// ---------- escribir por trozos (descargas) ----------
// Crea el archivo de destino y devuelve { file, append(bytes), abort() }
export async function createTarget({ tree, dir, name, appPath }) {
  if (tree) {
    const { uri } = await PorterFiles.createFile({ tree, dir, name, mime: 'application/octet-stream' });
    let first = true;
    return {
      file: { kind: 'saf', uri, name },
      append: async (bytes) => {
        for (let o = 0; o < bytes.length || first; o += 4 * 1024 * 1024) {
          await PorterFiles.write({ uri, data: b64(bytes.subarray(o, o + 4 * 1024 * 1024)), append: !first });
          first = false;
        }
      },
      abort: () => PorterFiles.delete({ uri }).catch(() => {}),
    };
  }
  await Filesystem.writeFile({ path: appPath, directory: Directory.Data, data: '', recursive: true });
  return {
    file: { kind: 'app', path: appPath, name },
    append: async (bytes) => {
      for (let o = 0; o < bytes.length; o += 4 * 1024 * 1024) {
        await Filesystem.appendFile({ path: appPath, directory: Directory.Data, data: b64(bytes.subarray(o, o + 4 * 1024 * 1024)) });
      }
    },
    abort: () => Filesystem.deleteFile({ path: appPath, directory: Directory.Data }).catch(() => {}),
  };
}

// ---------- ZIP / CBZ con acceso aleatorio ----------
async function zipReader(h) {
  const tailLen = Math.min(h.size, 65557 + 20);
  const tail = await h.read(h.size - tailLen, tailLen);
  const tv = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  let p = -1;
  for (let i = tail.length - 22; i >= 0; i--) if (tv.getUint32(i, true) === 0x06054b50) { p = i; break; }
  if (p < 0) throw new Error('El archivo ZIP está dañado');
  let count = tv.getUint16(p + 10, true), cdSize = tv.getUint32(p + 12, true), cdOff = tv.getUint32(p + 16, true);
  const u64 = (v, o) => v.getUint32(o, true) + v.getUint32(o + 4, true) * 2 ** 32;
  if ((cdOff === 0xffffffff || count === 0xffff || cdSize === 0xffffffff) && p >= 20 && tv.getUint32(p - 20, true) === 0x07064b50) {
    const e = await h.read(u64(tv, p - 12), 56);
    const ev = new DataView(e.buffer, e.byteOffset, e.byteLength);
    count = u64(ev, 32); cdSize = u64(ev, 40); cdOff = u64(ev, 48);
  }
  const cd = await h.read(cdOff, cdSize);
  const v = new DataView(cd.buffer, cd.byteOffset, cd.byteLength);
  const utf8 = new TextDecoder('utf-8');
  const entries = [];
  for (let o = 0; o + 46 <= cd.length && v.getUint32(o, true) === 0x02014b50;) {
    const flags = v.getUint16(o + 8, true), method = v.getUint16(o + 10, true);
    let csize = v.getUint32(o + 20, true), usize = v.getUint32(o + 24, true);
    const nlen = v.getUint16(o + 28, true), xlen = v.getUint16(o + 30, true), clen = v.getUint16(o + 32, true);
    let lho = v.getUint32(o + 42, true);
    const name = utf8.decode(cd.subarray(o + 46, o + 46 + nlen));
    // Extra ZIP64
    for (let x = o + 46 + nlen; x + 4 <= o + 46 + nlen + xlen;) {
      const id = v.getUint16(x, true), len = v.getUint16(x + 2, true);
      if (id === 1) {
        let q = x + 4;
        if (usize === 0xffffffff) { usize = u64(v, q); q += 8; }
        if (csize === 0xffffffff) { csize = u64(v, q); q += 8; }
        if (lho === 0xffffffff) { lho = u64(v, q); }
      }
      x += 4 + len;
    }
    if (IMG.test(name) && !/__MACOSX|(^|\/)\./.test(name) && usize > 0 && !(flags & 1)) entries.push({ name, method, csize, usize, lho });
    o += 46 + nlen + xlen + clen;
  }
  entries.sort((a, b) => collator.compare(a.name, b.name));
  return {
    count: entries.length,
    name: (i) => entries[i]?.name,
    async blob(i) {
      const e = entries[i];
      if (!e) throw new Error('Página fuera de rango');
      let buf = await h.read(e.lho, 30 + e.name.length * 3 + 512 + e.csize);
      const lv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
      const start = 30 + lv.getUint16(26, true) + lv.getUint16(28, true);
      let data = buf.subarray(start, start + e.csize);
      if (data.length < e.csize) data = await h.read(e.lho + start, e.csize);
      const bytes = e.method === 0 ? data : e.method === 8 ? inflateSync(data, { out: new Uint8Array(e.usize) }) : null;
      if (!bytes) throw new Error('Compresión ZIP no compatible');
      return new Blob([bytes], { type: mimeOf(e.name) });
    },
    close() {},
  };
}

// ---------- RAR / CBR: se extrae una vez a la caché de la app ----------
let unrarMod = null, wasm = null;
async function rarReader(h, fp, onProgress) {
  const dir = `porter-rar/${fp}`;
  let index = null;
  try {
    const r = await Filesystem.readFile({ path: `${dir}/index.json`, directory: Directory.Cache, encoding: 'utf8' });
    index = JSON.parse(r.data);
  } catch (_) {}
  if (!index) {
    const data = new Uint8Array(h.size);
    for (let o = 0; o < h.size; o += 8 * 1024 * 1024) {
      data.set(await h.read(o, Math.min(8 * 1024 * 1024, h.size - o)), o);
      onProgress?.(0.5 * Math.min(1, (o + 8 * 1024 * 1024) / h.size));
    }
    if (!unrarMod) unrarMod = await import('node-unrar-js/esm');
    if (!wasm) wasm = await (await fetch('./unrar.wasm')).arrayBuffer();
    const ex = await unrarMod.createExtractorFromData({ wasmBinary: wasm, data: data.buffer });
    const names = [...ex.getFileList().fileHeaders].filter((f) => !f.flags.directory && IMG.test(f.name) && !/__MACOSX|(^|\/)\./.test(f.name)).map((f) => f.name).sort(collator.compare);
    if (!names.length) throw new Error('El archivo no contiene imágenes');
    const order = new Map(names.map((n, i) => [n, i]));
    const files = new Array(names.length);
    const wanted = new Set(names);
    let done = 0;
    for (const f of ex.extract({ files: (fh) => wanted.has(fh.name) }).files) {
      if (!f.extraction) continue;
      const i = order.get(f.fileHeader.name);
      const fn = `${String(i).padStart(5, '0')}.${f.fileHeader.name.split('.').pop().toLowerCase()}`;
      await Filesystem.writeFile({ path: `${dir}/${fn}`, directory: Directory.Cache, data: b64(f.extraction), recursive: true });
      files[i] = fn;
      onProgress?.(0.5 + 0.5 * (++done / names.length));
    }
    index = { files: files.filter(Boolean), at: Date.now() };
    await Filesystem.writeFile({ path: `${dir}/index.json`, directory: Directory.Cache, data: JSON.stringify(index), encoding: 'utf8', recursive: true });
    pruneRarCache(fp).catch(() => {});
  }
  const cacheUri = native ? (await Filesystem.getUri({ path: dir, directory: Directory.Cache })).uri : null;
  return {
    count: index.files.length,
    name: (i) => index.files[i],
    async blob(i) {
      const fn = index.files[i];
      if (!fn) throw new Error('Página fuera de rango');
      if (cacheUri) {
        const r = await fetch(Capacitor.convertFileSrc(`${cacheUri}/${fn}`));
        if (r.ok) return new Blob([await r.arrayBuffer()], { type: mimeOf(fn) });
      }
      const r = await Filesystem.readFile({ path: `${dir}/${fn}`, directory: Directory.Cache });
      return new Blob([typeof r.data === 'string' ? unb64(r.data) : r.data], { type: mimeOf(fn) });
    },
    close() {},
  };
}

// Solo se guardan extraídos los últimos 4 CBR abiertos
async function pruneRarCache(keep) {
  const list = await Filesystem.readdir({ path: 'porter-rar', directory: Directory.Cache });
  const dirs = [];
  for (const e of list.files) {
    const name = typeof e === 'string' ? e : e.name;
    if (name === keep) continue;
    dirs.push({ name, mtime: Number(e.mtime) || 0 });
  }
  dirs.sort((a, b) => b.mtime - a.mtime);
  for (const d of dirs.slice(3)) await Filesystem.rmdir({ path: `porter-rar/${d.name}`, directory: Directory.Cache, recursive: true }).catch(() => {});
}

// ---------- lectores abiertos ----------
const readers = new Map();   // fp -> Promise<reader>
export function bookReader(book, onProgress) {
  let p = readers.get(book.fp);
  if (!p) {
    p = (async () => {
      const h = await openHandle(book);
      const head = await h.read(0, 8);
      const isZip = head[0] === 0x50 && head[1] === 0x4b;
      const isRar = head[0] === 0x52 && head[1] === 0x61 && head[2] === 0x72 && head[3] === 0x21;
      if (isZip) return zipReader(h);
      if (isRar) return rarReader(h, book.fp, onProgress);
      throw new Error('Formato de archivo no reconocido');
    })();
    p.catch(() => readers.delete(book.fp));
    readers.set(book.fp, p);
    while (readers.size > 4) readers.delete(readers.keys().next().value);
  }
  return p;
}
export function forgetReader(fp) { readers.delete(fp); }
