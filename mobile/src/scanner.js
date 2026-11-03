// Lector de códigos QR: cámara en directo o una foto/captura.
import jsQR from 'jsqr';

let detector = null;
async function getDetector() {
  if (detector !== null) return detector;
  try {
    if ('BarcodeDetector' in window && (await window.BarcodeDetector.getSupportedFormats()).includes('qr_code')) {
      detector = new window.BarcodeDetector({ formats: ['qr_code'] });
    } else detector = false;
  } catch (_) { detector = false; }
  return detector;
}

// Lee un QR de un <video>, <img> o <canvas>
async function decodeSource(src, w, h, canvas) {
  const det = await getDetector();
  if (det) {
    try { const r = await det.detect(src); if (r[0]?.rawValue) return r[0].rawValue; } catch (_) {}
  }
  const scale = Math.min(1, 1000 / Math.max(w, h));
  canvas.width = Math.round(w * scale); canvas.height = Math.round(h * scale);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const r = jsQR(img.data, img.width, img.height, { inversionAttempts: 'attemptBoth' });
  return r?.data || null;
}

export async function decodeImageFile(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return await decodeSource(img, img.naturalWidth, img.naturalHeight, document.createElement('canvas'));
  } finally { URL.revokeObjectURL(url); }
}

// Abre la cámara a pantalla completa. Devuelve el texto del QR o null si se cancela.
export function scanWithCamera({ onAlternative } = {}) {
  return new Promise((resolve) => {
    const ov = document.createElement('div');
    ov.className = 'scanner';
    ov.innerHTML = `
      <video playsinline muted></video>
      <div class="scan-frame"></div>
      <div class="scan-top"><button class="icon-btn scan-close" aria-label="Cerrar">✕</button><span>Apunta al QR que muestra Porter en el PC</span></div>
      <div class="scan-bottom">
        <p class="scan-msg"></p>
        <div class="scan-actions">
          <label class="btn ghost">Leer QR de una foto<input type="file" accept="image/*" hidden></label>
          <button class="btn ghost scan-alt">Emparejar sin cámara</button>
        </div>
      </div>`;
    document.body.append(ov);
    const video = ov.querySelector('video');
    const msg = ov.querySelector('.scan-msg');
    const canvas = document.createElement('canvas');
    let stream = null, done = false, raf = 0;

    const finish = (val) => {
      if (done) return;
      done = true;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
      ov.remove();
      resolve(val);
    };
    ov.querySelector('.scan-close').onclick = () => finish(null);
    ov.querySelector('.scan-alt').onclick = () => { finish(null); onAlternative?.(); };
    ov.querySelector('input[type=file]').onchange = async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      msg.textContent = 'Leyendo la imagen…';
      const v = await decodeImageFile(f).catch(() => null);
      if (v) finish(v);
      else msg.textContent = 'No se encontró ningún QR en la imagen. Prueba con otra foto más cerca y nítida.';
    };
    window.__porterScannerClose = () => finish(null);

    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
      } catch (e) {
        msg.textContent = 'No se pudo usar la cámara. Puedes leer el QR de una foto o emparejar sin cámara.';
        return;
      }
      if (done) { stream.getTracks().forEach((t) => t.stop()); return; }
      video.srcObject = stream;
      await video.play().catch(() => {});
      let busy = false, last = 0;
      const tick = async (t) => {
        if (done) return;
        raf = requestAnimationFrame(tick);
        if (busy || t - last < 150 || video.readyState < 2) return;
        busy = true; last = t;
        const v = await decodeSource(video, video.videoWidth, video.videoHeight, canvas).catch(() => null);
        busy = false;
        if (v) { if (navigator.vibrate) navigator.vibrate(40); finish(v); }
      };
      raf = requestAnimationFrame(tick);
      setTimeout(() => { if (!done && !msg.textContent) msg.textContent = '¿No lo lee? Acerca o aleja el móvil, o prueba con una foto.'; }, 12000);
    })();
  });
}
