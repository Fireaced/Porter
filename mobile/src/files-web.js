// Versión para navegador del plugin PorterFiles (solo para pruebas fuera de Android).
// Las pruebas pueden definir window.__PORTER_FAKE_FS__ = { name, files: { 'Serie/Tomo 1.cbz': Uint8Array } }
import { WebPlugin } from '@capacitor/core';
import { b64, unb64 } from './files.js';

const fake = () => (window.__PORTER_FAKE_FS__ ||= { name: 'Mangas', files: {} });
const TREE = 'fake://tree/';

export class PorterFilesWeb extends WebPlugin {
  async pickFolder() {
    const fs = fake();
    if (fs.cancel) throw new Error('Cancelado');
    return { uri: TREE + encodeURIComponent(fs.name), name: fs.name, writable: true };
  }
  async check() { return { ok: !fake().revoked }; }
  async list() {
    const fs = fake();
    const files = Object.entries(fs.files).filter(([p]) => /\.(cbz|zip|cbr|rar|pdf)$/i.test(p)).map(([p, d]) => {
      const i = p.lastIndexOf('/');
      return { uri: 'fake://doc/' + encodeURIComponent(p), name: p.slice(i + 1), dir: i < 0 ? '' : p.slice(0, i), size: d.length, mtime: 0 };
    });
    return { files };
  }
  path(uri) { return decodeURIComponent(uri.replace('fake://doc/', '')); }
  async read({ uri, offset = 0, length = 0 }) {
    const d = fake().files[this.path(uri)];
    if (!d) throw new Error('No existe');
    return { data: b64(d.subarray(offset, offset + length)), size: d.length };
  }
  async createFile({ dir, name }) {
    const p = dir ? `${dir}/${name}` : name;
    fake().files[p] ||= new Uint8Array(0);
    return { uri: 'fake://doc/' + encodeURIComponent(p) };
  }
  async write({ uri, data, append }) {
    const fs = fake(), p = this.path(uri);
    const add = unb64(data);
    const prev = append ? (fs.files[p] || new Uint8Array(0)) : new Uint8Array(0);
    const out = new Uint8Array(prev.length + add.length);
    out.set(prev); out.set(add, prev.length);
    fs.files[p] = out;
  }
  async delete({ uri }) { delete fake().files[this.path(uri)]; }
  async immersive({ on }) {
    window.__PORTER_IMMERSIVE__ = !!on;
    return { on: !!on };
  }
}
