// Construye mobile/www a partir del código compartido con la versión de PC.
import { build } from 'esbuild';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const mobile = path.join(here, '..');
const root = path.join(mobile, '..');
const www = path.join(mobile, 'www');
const nm = (p) => path.join(mobile, 'node_modules', p);
const pkg = JSON.parse(fs.readFileSync(path.join(mobile, 'package.json'), 'utf8'));

fs.rmSync(www, { recursive: true, force: true });
fs.mkdirSync(path.join(www, 'pdfjs'), { recursive: true });

const copy = (from, to) => fs.copyFileSync(from, path.join(www, to));
copy(path.join(mobile, 'src', 'index.html'), 'index.html');
copy(path.join(mobile, 'src', 'mobile.css'), 'mobile.css');
copy(path.join(root, 'src', 'renderer', 'styles.css'), 'styles.css');
copy(nm('pdfjs-dist/build/pdf.min.mjs'), 'pdfjs/pdf.min.mjs');
copy(nm('pdfjs-dist/build/pdf.worker.min.mjs'), 'pdfjs/pdf.worker.min.mjs');
copy(nm('node-unrar-js/esm/js/unrar.wasm'), 'unrar.wasm');

await build({
  entryPoints: [path.join(mobile, 'src', 'entry.js')],
  bundle: true,
  format: 'esm',
  target: ['chrome100'],
  platform: 'browser',
  outfile: path.join(www, 'porter.js'),
  minify: true,
  sourcemap: false,
  legalComments: 'none',
  define: { __PORTER_VERSION__: JSON.stringify(pkg.version) },
  loader: { '.json': 'json' },
  alias: { fs: path.join(mobile, 'src', 'shims', 'empty.js'), path: path.join(mobile, 'src', 'shims', 'empty.js') },
  logLevel: 'warning',
});
console.log('www listo:', fs.readdirSync(www).join(', '));
