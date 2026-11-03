// Copiar CBZ/ZIP, CBR/RAR y PDF sueltos a la memoria de Porter (para quien no quiera elegir una carpeta).
// El archivo original se copia por trozos, sin cargarlo entero en memoria.
import { addLocalBook, fingerprint, store } from './bridge.js';
import { createTarget } from './files.js';
import { guessSeries } from '../../src/shared/series.js';

export { guessSeries };
const ROOT = 'porter';

export async function importFile(file, onProgress) {
  const name = file.name;
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (!['cbz', 'zip', 'cbr', 'rar', 'pdf'].includes(ext)) throw new Error(`${name}: formato no compatible`);
  const fp = await fingerprint(name, file.size);
  if (store.data.books[fp]) return { skipped: true, fp };
  const title = name.replace(/\.[^.]+$/, '').replace(/_+/g, ' ').trim();
  const safe = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
  const target = await createTarget({ appPath: `${ROOT}/books/${fp}/${safe}`, name: safe });
  try {
    const CH = 4 * 1024 * 1024;
    for (let o = 0; o < file.size; o += CH) {
      await target.append(new Uint8Array(await file.slice(o, o + CH).arrayBuffer()));
      onProgress?.(Math.min(1, (o + CH) / file.size));
    }
  } catch (e) { await target.abort(); throw e; }
  addLocalBook({ fp, title, series: guessSeries(title), ext: ext === 'zip' ? 'cbz' : ext === 'rar' ? 'cbr' : ext, pages: null, size: file.size, file: target.file });
  return { fp };
}
