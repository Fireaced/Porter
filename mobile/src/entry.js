// Punto de entrada de Porter para Android
import { initBridge } from './bridge.js';
import { createExt } from './ext.js';

await initBridge();
if (location.protocol === 'http:') {   // solo en las pruebas en navegador
  const [{ sync }, { store }] = await Promise.all([import('./sync.js'), import('./bridge.js')]);
  window.__porterTest = { sync, store };
}
window.porterExt = createExt;
await import('../../src/renderer/app.js');
