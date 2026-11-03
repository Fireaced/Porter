'use strict';
// Reportes de fallos: se envían a un Formulario de Google privado del autor.
// En el código solo está el identificador público del formulario (que solo permite
// enviar respuestas); las respuestas se ven únicamente desde la cuenta del autor.
const os = require('os');
const path = require('path');
const { app, net, screen } = require('electron');

const FORM = require('./report-config.json');

const MAX_LOG = 40;
const errorLog = [];

function logError(source, msg) {
  errorLog.push(`[${new Date().toISOString()}] ${source}: ${String(msg).slice(0, 600)}`);
  if (errorLog.length > MAX_LOG) errorLog.shift();
}

// Quita rutas y nombres de archivo personales de cualquier texto que se vaya a enviar
function sanitize(text, folders) {
  let t = String(text || '');
  const home = os.homedir();
  for (const f of [...(folders || [])].sort((a, b) => b.length - a.length)) {
    if (f) t = t.split(f).join('<carpeta>');
  }
  if (home) t = t.split(home).join('%USERPROFILE%');
  // Cualquier otra ruta absoluta de Windows o Unix que quede
  t = t.replace(/[A-Za-z]:\\[^\s"'<>|]+/g, '<ruta>').replace(/(^|\s)\/(?:[^\s/]+\/)+[^\s]*/g, '$1<ruta>');
  return t;
}

function systemInfo(store, ctx) {
  const d = store.data;
  const disp = screen.getPrimaryDisplay();
  let gpu = '';
  try {
    const st = app.getGPUFeatureStatus();
    gpu = `gpu_compositing=${st.gpu_compositing}, rasterization=${st.rasterization}, 2d_canvas=${st['2d_canvas']}`;
  } catch (_) {}
  const exts = {};
  for (const b of Object.values(d.books)) exts[b.ext] = (exts[b.ext] || 0) + 1;
  const lines = [
    `Porter ${app.getVersion()}`,
    `Sistema: ${os.type()} ${os.release()} ${os.arch()} · RAM ${Math.round(os.totalmem() / 1024 ** 3)} GB`,
    `Electron ${process.versions.electron} · Chromium ${process.versions.chrome}`,
    `Pantalla: ${disp.size.width}x${disp.size.height} @${disp.scaleFactor}x`,
    `GPU: ${gpu}`,
    `Biblioteca: ${Object.keys(d.books).length} archivos ${JSON.stringify(exts)}, ${d.folders.length} carpetas`,
    `Ajustes: ${JSON.stringify({ ...d.settings, seriesMode: undefined })}`,
  ];
  if (ctx) lines.push(`Lector: ${JSON.stringify(ctx)}`);
  if (errorLog.length) lines.push('', 'Errores recientes:', ...errorLog);
  return sanitize(lines.join('\n'), d.folders);
}

function isConfigured() { return !!(FORM.formId && FORM.fields && FORM.fields.description); }

async function postReport(r) {
  const body = new URLSearchParams();
  const f = FORM.fields;
  const put = (key, val) => { if (f[key] && val) body.append(f[key], String(val).slice(0, 20000)); };
  put('type', r.type);
  put('description', r.description);
  put('steps', r.steps);
  put('contact', r.contact);
  put('version', r.version);
  put('details', r.details);
  const res = await net.fetch(`https://docs.google.com/forms/d/e/${FORM.formId}/formResponse`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
}

// Envía o deja en cola (sin conexión) y reintenta en el siguiente arranque
async function sendReport(store, input) {
  const d = store.data;
  const now = Date.now();
  d.reportTimes = (d.reportTimes || []).filter((t) => now - t < 24 * 3600e3);
  if (d.reportTimes.length && now - d.reportTimes[d.reportTimes.length - 1] < 30e3) {
    return { ok: false, error: 'Espera unos segundos antes de enviar otro reporte.' };
  }
  if (d.reportTimes.length >= 10) return { ok: false, error: 'Has enviado muchos reportes hoy. Gracias, inténtalo mañana.' };
  const report = {
    type: input.type === 'sugerencia' ? 'Sugerencia' : 'Fallo',
    description: sanitize(input.description, d.folders),
    steps: sanitize(input.steps, d.folders),
    contact: (input.contact || '').trim(),
    version: app.getVersion(),
    details: input.includeInfo ? systemInfo(store, input.context) : '',
  };
  d.reportTimes.push(now);
  if (!isConfigured()) return { ok: false, error: 'El envío de reportes no está configurado en esta versión.' };
  try {
    await postReport(report);
    store.save();
    return { ok: true };
  } catch (e) {
    d.pendingReports = [...(d.pendingReports || []), report].slice(-10);
    store.save();
    return { ok: true, queued: true };
  }
}

async function flushPending(store) {
  const list = store.data.pendingReports || [];
  if (!list.length || !isConfigured()) return;
  const left = [];
  for (const r of list) {
    try { await postReport(r); } catch (_) { left.push(r); }
  }
  store.data.pendingReports = left;
  store.save();
}

module.exports = { logError, systemInfo, sendReport, flushPending, isConfigured };
