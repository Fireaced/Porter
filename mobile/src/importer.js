// Importar CBZ/ZIP, CBR/RAR y PDF desde el almacenamiento del móvil.
import { unzip } from 'fflate';
import { writeBytes, addLocalBook, fingerprint, store } from './bridge.js';

const ROOT = 'porter';
const IMG = /\.(jpe?g|png|webp|gif|avif|bmp)$/i;
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export function guessSeries(title) {
  const m = /^(.*?)[\s._-]*(?:vol(?:umen|ume)?\.?|tomo|t\.|v\.|#|cap(?:[ií]tulo)?\.?|ch\.?)\s*\d+.*$/i.exec(title)
    || /^(.*?)[\s._-]+\d{1,4}(?:\s*\(.*\))?$/.exec(title);
  const s = m && m[1].trim();
  return s && s.length >= 2 ? s : title;
}

const unzipAsync = (u8) => new Promise((res, rej) => unzip(u8, { filter: (f) => IMG.test(f.name) && !/__MACOSX|\/\./.test(f.name) && f.originalSize > 0 }, (e, d) => e ? rej(e) : res(d)));

let unrarMod = null;
async function extractRar(u8) {
  if (!unrarMod) unrarMod = await import('node-unrar-js/esm');
  const wasmBinary = await (await fetch('./unrar.wasm')).arrayBuffer();
  const ex = await unrarMod.createExtractorFromData({ wasmBinary, data: u8.buffer });
  const { files } = ex.extract({ files: (h) => !h.flags.directory && IMG.test(h.name) });
  const out = {};
  for (const f of files) if (f.extraction) out[f.fileHeader.name] = f.extraction;
  return out;
}

export async function importFile(file, onProgress) {
  const name = file.name;
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (!['cbz', 'zip', 'cbr', 'rar', 'pdf'].includes(ext)) throw new Error(`${name}: formato no compatible`);
  const fp = await fingerprint(name, file.size);
  if (store.data.books[fp]) return { skipped: true, fp };
  const title = name.replace(/\.[^.]+$/, '').replace(/_+/g, ' ').trim();
  const dir = `${ROOT}/books/${fp}`;
  const u8 = new Uint8Array(await file.arrayBuffer());
  const files = [];
  let pages = null;
  if (ext === 'pdf') {
    await writeBytes(`${dir}/book.pdf`, u8);
    files.push('book.pdf');
  } else {
    let entries;
    try {
      entries = (ext === 'cbr' || ext === 'rar') ? await extractRar(u8) : await unzipAsync(u8);
    } catch (e) {
      // Hay CBR que en realidad son ZIP (y al revés)
      entries = (ext === 'cbr' || ext === 'rar') ? await unzipAsync(u8) : await extractRar(u8);
    }
    const names = Object.keys(entries).sort(collator.compare);
    if (!names.length) throw new Error(`${name}: no contiene imágenes`);
    for (let i = 0; i < names.length; i++) {
      const e = names[i].split('.').pop().toLowerCase().replace('jpeg', 'jpg');
      const fn = `p${String(i + 1).padStart(4, '0')}.${e}`;
      await writeBytes(`${dir}/${fn}`, entries[names[i]]);
      files.push(fn);
      onProgress?.((i + 1) / names.length);
    }
    pages = names.length;
  }
  addLocalBook({ fp, title, series: guessSeries(title), ext: ext === 'zip' ? 'cbz' : ext === 'rar' ? 'cbr' : ext, pages, size: file.size, files });
  return { fp };
}
