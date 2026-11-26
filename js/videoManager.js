// videoManager.js — carga de .mp4, respaldo procedural en <canvas> y extracción de paleta dominante (8×8 @ ~7 Hz).
import * as THREE from 'three';

const SAMPLE_INTERVAL = 1 / 7;
const FB_W = 512, FB_H = 288;
const LOCAL_W = 24, LOCAL_H = 14;

/* ---------- utilidades de color (sin THREE.Color para evitar conversiones de espacio) ---------- */
function hexToRgb(hex) {
  const h = (hex || '#4A90E2').replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
function rgbToHsl([r, g, b]) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
  let h = 0, s = 0;
  if (mx !== mn) {
    const d = mx - mn;
    s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    if (mx === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  return [h, s, l];
}
function hslToRgb([h, s, l]) {
  const f = (p, q, t) => {
    t = ((t % 1) + 1) % 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  if (s === 0) return [l, l, l];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  return [f(p, q, h + 1 / 3), f(p, q, h), f(p, q, h - 1 / 3)];
}
const hslCss = (h, s, l, a = 1) => `hsla(${Math.round(((h % 1) + 1) % 1 * 360)},${Math.round(s * 100)}%,${Math.round(l * 100)}%,${a})`;

/** Color apto para partículas/tinte: saturación controlada y luminosidad con buen contraste sobre #121315. */
function toDisplay(rgb) {
  const [h, s, l] = rgbToHsl(rgb);
  return hslToRgb([h, Math.min(Math.max(s, 0.35), 0.78), Math.min(Math.max(l, 0.5), 0.72)]);
}

/* ---------- vídeo procedural de respaldo ---------- */
function makeFallback(index, baseRgb) {
  const canvas = document.createElement('canvas');
  canvas.width = FB_W; canvas.height = FB_H;
  const ctx = canvas.getContext('2d');
  const [h, s] = rgbToHsl(baseRgb);
  const sat = Math.max(0.45, Math.min(s, 0.8));
  const pal = {
    bg0: hslCss(h, sat * 0.6, 0.10), bg1: hslCss(h + 0.05, sat * 0.7, 0.20),
    a: (al = 1) => hslCss(h, sat, 0.56, al),
    b: (al = 1) => hslCss(h + 0.09, sat, 0.62, al),
    c: (al = 1) => hslCss(h - 0.1, sat * 0.9, 0.46, al),
    d: (al = 1) => hslCss(h + 0.5, sat * 0.7, 0.66, al),
  };
  const program = index % 3;
  const draw = (t) => {
    const w = FB_W, hh = FB_H;
    const g = ctx.createLinearGradient(0, 0, w, hh);
    g.addColorStop(0, pal.bg0); g.addColorStop(1, pal.bg1);
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, hh);
    if (program === 0) {            // círculos flotantes + anillos concéntricos
      for (let r = 0; r < 5; r++) {
        ctx.strokeStyle = pal.d(0.35 - r * 0.05); ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(w * 0.5, hh * 0.5, 30 + r * 34 + 10 * Math.sin(t * 1.3 + r), 0, 7); ctx.stroke();
      }
      for (let j = 0; j < 8; j++) {
        const x = w * (0.5 + 0.42 * Math.sin(t * 0.45 + j * 1.7)), y = hh * (0.5 + 0.38 * Math.cos(t * 0.37 + j * 2.3));
        ctx.fillStyle = [pal.a, pal.b, pal.c][j % 3](0.9);
        ctx.beginPath(); ctx.arc(x, y, 14 + 12 * Math.abs(Math.sin(t * 0.9 + j)), 0, 7); ctx.fill();
      }
    } else if (program === 1) {     // cuadrícula de cuadrados rotando + franjas diagonales
      ctx.save(); ctx.translate(w / 2, hh / 2); ctx.rotate(0.5);
      for (let k = -8; k < 8; k++) {
        ctx.fillStyle = k % 2 ? pal.c(0.35) : pal.a(0.25);
        ctx.fillRect(-w + ((t * 40 + k * 70) % (w * 2)) - w * 0.2, -hh, 28, hh * 2);
      }
      ctx.restore();
      for (let i = 0; i < 6; i++) for (let j = 0; j < 4; j++) {
        ctx.save(); ctx.translate(w * (i + 0.5) / 6, hh * (j + 0.5) / 4); ctx.rotate(t * (0.6 + 0.1 * i) + j);
        const sz = 16 + 10 * Math.sin(t + i * j);
        ctx.fillStyle = ((i + j) % 2 ? pal.b : pal.a)(0.85); ctx.fillRect(-sz / 2, -sz / 2, sz, sz);
        ctx.restore();
      }
    } else {                        // barras deslizantes + ondas + cuadrados orbitando
      for (let i = 0; i < 9; i++) {
        const y = (i / 9) * hh, ww = w * (0.25 + 0.5 * Math.abs(Math.sin(t * 0.6 + i)));
        ctx.fillStyle = [pal.a, pal.c, pal.b][i % 3](0.55);
        ctx.fillRect(((t * 60 * (i % 2 ? 1 : -1) + i * 90) % (w + ww)) - ww, y, ww, hh / 9 - 4);
      }
      ctx.strokeStyle = pal.d(0.85); ctx.lineWidth = 3; ctx.beginPath();
      for (let x = 0; x <= w; x += 8) { const y = hh * 0.5 + 50 * Math.sin(x * 0.02 + t * 2) * Math.sin(t * 0.5); x ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
      ctx.stroke();
      for (let j = 0; j < 5; j++) {
        const a = t * 0.9 + j * 1.256;
        ctx.fillStyle = pal.b(0.95); ctx.fillRect(w / 2 + Math.cos(a) * 130 - 9, hh / 2 + Math.sin(a) * 80 - 9, 18, 18);
      }
    }
  };
  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter; texture.generateMipmaps = false;
  draw(0); texture.needsUpdate = true;
  return { canvas, draw, texture };
}

export class VideoManager {
  constructor(projects) {
    this.sCanvas = document.createElement('canvas');
    this.sCanvas.width = this.sCanvas.height = 8;
    this.sCtx = this.sCanvas.getContext('2d', { willReadFrequently: true });
    this.lCanvas = document.createElement('canvas');
    this.lCanvas.width = LOCAL_W; this.lCanvas.height = LOCAL_H;
    this.lCtx = this.lCanvas.getContext('2d', { willReadFrequently: true });
    this.lastLocal = 0;
    this.lastSample = 0;
    this.lastFb = 0;
    this.items = projects.map((p, i) => this._createItem(p, i));
  }

  _createItem(project, index) {
    const base = hexToRgb(project.fallbackColor);
    const [h, s, l] = rgbToHsl(base);
    const fb = makeFallback(index, base);
    const derived = [base, hslToRgb([h + 0.08, s, l]), hslToRgb([h - 0.1, s, l])];
    const item = {
      project, index, fb, base,
      texture: fb.texture, canvas: fb.canvas, video: null, usingVideo: false,
      targets: derived.map(c => c.slice()), colors: derived.map(c => c.slice()),
      display: toDisplay(base),
      localT: new Float32Array(LOCAL_W * LOCAL_H * 3), localS: new Float32Array(LOCAL_W * LOCAL_H * 3),
    };
    const d0 = item.display;
    for (let p = 0; p < LOCAL_W * LOCAL_H; p++) { item.localT[p * 3] = item.localS[p * 3] = d0[0]; item.localT[p * 3 + 1] = item.localS[p * 3 + 1] = d0[1]; item.localT[p * 3 + 2] = item.localS[p * 3 + 2] = d0[2]; }
    if (project.video) {
      const v = document.createElement('video');
      v.muted = true; v.loop = true; v.playsInline = true; v.preload = 'auto';
      v.setAttribute('muted', ''); v.setAttribute('playsinline', '');
      v.addEventListener('loadeddata', () => {
        if (item.usingVideo) return;
        const tex = new THREE.VideoTexture(v);
        tex.minFilter = THREE.LinearFilter; tex.generateMipmaps = false;
        item.vtex = tex; item.video = v;
        item.texture = tex; item.usingVideo = true;
        v.play().catch(() => { /* autoplay bloqueado: seguirá el respaldo hasta interacción */ item.usingVideo = false; item.texture = fb.texture; });
      });
      v.addEventListener('error', () => console.info(`[videoManager] ${project.video} no disponible → vídeo procedural de respaldo.`));
      v.src = project.video;
      v.load();
      // si el navegador bloquea el autoplay, reintentar con el primer gesto
      const kick = () => { if (item.video && item.video.paused) item.video.play().then(() => { item.usingVideo = true; item.texture = item.vtex; }).catch(() => {}); };
      window.addEventListener('pointerdown', kick, { once: true });
      window.addEventListener('wheel', kick, { once: true, passive: true });
    }
    return item;
  }

  getTexture(i) { return this.items[i].texture; }
  getColor(i) { return this.items[i].display; }
  restart(i) { const it = this.items[i]; if (it && it.usingVideo) { try { it.video.currentTime = 0; } catch (e) { /* noop */ } } }

  /** @param needed Set de índices cuyo frame se usa ahora mismo (para limitar subidas de textura) */
  /** Rejilla 24×14 de color local del vídeo (suavizada) para colorear el marco perimetral del rectángulo. */
  getLocal(i) { return this.items[i].localS; }

  _sampleLocal(item) {
    const src = item.usingVideo ? item.video : item.canvas;
    let data;
    try { this.lCtx.drawImage(src, 0, 0, LOCAL_W, LOCAL_H); data = this.lCtx.getImageData(0, 0, LOCAL_W, LOCAL_H).data; } catch (e) { data = null; }
    for (let p = 0; p < LOCAL_W * LOCAL_H; p++) {
      let rgb = item.display;
      if (data && Math.max(data[p * 4], data[p * 4 + 1], data[p * 4 + 2]) > 28) {
        const [h, s, l] = rgbToHsl([data[p * 4] / 255, data[p * 4 + 1] / 255, data[p * 4 + 2] / 255]);
        rgb = hslToRgb([h, Math.min(s * 1.05, 0.85), Math.min(Math.max(l, 0.42), 0.8)]);
      }
      item.localT[p * 3] = rgb[0]; item.localT[p * 3 + 1] = rgb[1]; item.localT[p * 3 + 2] = rgb[2];
    }
  }

  update(t, dt, needed, localId = -1) {
    if (localId >= 0 && t - this.lastLocal > 0.11) { this.lastLocal = t; this._sampleLocal(this.items[localId]); }
    if (localId >= 0) {
      const it = this.items[localId], k = 1 - Math.exp(-dt * 8);
      for (let q = 0; q < it.localS.length; q++) it.localS[q] += (it.localT[q] - it.localS[q]) * k;
    }
    // respaldo procedural: 30 fps solo si se necesita
    if (t - this.lastFb > 1 / 30) {
      this.lastFb = t;
      for (const it of this.items) if (!it.usingVideo && needed.has(it.index)) { it.fb.draw(t); it.fb.texture.needsUpdate = true; }
    }
    // extracción de paleta a ~7 Hz
    if (t - this.lastSample > SAMPLE_INTERVAL) {
      this.lastSample = t;
      for (const it of this.items) {
        if (!it.usingVideo) it.fb.draw(t);
        this._sample(it);
      }
    }
    // lerp continuo hacia la paleta objetivo
    const k = 1 - Math.exp(-dt * 4);
    for (const it of this.items) {
      for (let c = 0; c < 3; c++) for (let j = 0; j < 3; j++) it.colors[c][j] += (it.targets[c][j] - it.colors[c][j]) * k;
      it.display = toDisplay(it.colors[0]);
    }
  }

  _sample(item) {
    const src = item.usingVideo ? item.video : item.canvas;
    let data;
    try {
      this.sCtx.drawImage(src, 0, 0, 8, 8);
      data = this.sCtx.getImageData(0, 0, 8, 8).data;
    } catch (e) { data = null; }
    const [h, s, l] = rgbToHsl(item.base);
    const fallback = [item.base, hslToRgb([h + 0.08, s, l]), hslToRgb([h - 0.1, s, l])];
    if (!data) { item.targets = fallback; return; }

    const buckets = new Map();
    let maxLum = 0;
    for (let p = 0; p < 64; p++) {
      const r = data[p * 4], g = data[p * 4 + 1], b = data[p * 4 + 2];
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      maxLum = Math.max(maxLum, mx);
      if (mx < 24) continue;
      const sat = (mx - mn) / (mx || 1);
      const key = ((r >> 5) << 6) | ((g >> 5) << 3) | (b >> 5);
      let bk = buckets.get(key);
      if (!bk) { bk = { r: 0, g: 0, b: 0, n: 0, score: 0 }; buckets.set(key, bk); }
      bk.r += r; bk.g += g; bk.b += b; bk.n++; bk.score += 1 + sat * 2;
    }
    if (maxLum < 32 || buckets.size === 0) { item.targets = fallback; return; }   // fotograma negro → color de respaldo

    const sorted = [...buckets.values()].sort((a, b) => b.score - a.score);
    const picked = [];
    for (const bk of sorted) {
      const c = [bk.r / bk.n / 255, bk.g / bk.n / 255, bk.b / bk.n / 255];
      if (picked.every(q => Math.hypot(q[0] - c[0], q[1] - c[1], q[2] - c[2]) > 0.22)) picked.push(c);
      if (picked.length === 3) break;
    }
    while (picked.length < 3) picked.push(fallback[picked.length]);
    item.targets = picked;
  }
}
