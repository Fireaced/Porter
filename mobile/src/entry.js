// Punto de entrada de Porter para Android
import { initBridge } from './bridge.js';
import { createExt } from './ext.js';

await initBridge();
window.porterExt = createExt;
await import('../../src/renderer/app.js');
