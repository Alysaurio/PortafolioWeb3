// particles.js — motor de partículas ASCII: partículas físicas invisibles (masa, energía, color) que hacen *splatting*
// sobre una grilla fija en pantalla; la grilla se dibuja con un atlas tipográfico (una sola textura de datos, un quad).
// Física en dos fases (humo inercial → regeneración violenta con rebote), hash espacial O(N) y pool estrictamente conservado.
import * as THREE from 'three';
import { GRID_FS, QUAD_VS } from './shaders.js';

/* ======================= AJUSTES FÍSICOS CENTRALIZADOS ======================= */
export const PHYSICS_CONFIG = {
  charset: ['.', ':', ';', '=', '+', 'x', '#', '%', '@'],   // rampa Técnica (baja → alta densidad)
  cellSize: 7,                       // px de la grilla ASCII fija (6–7)
  particleCount: { low: 2600, mid: 2900, high: 3200 },   // según núcleos de CPU; el pool es fijo y se conserva
  pushForce: 1.00,                   // impulso del cursor (proporcional a su velocidad)
  magneticBrake: 0.20,               // fracción de velocidad normal que se conserva al encajar → leve rebote
  cursorRadius: 85,                  // px, radio de la cápsula barrida
  xsphCohesion: 0.30,                // arrastre de vecinas (XSPH) en la fase de humo
  dispersionDrag: 0.96,              // fricción viscosa por frame@60fps en Fase 1
  apexDelayMs: 220,                  // pausa en el ápice antes de detonar el retorno
  returnAcceleration: 70,            // rigidez (1/s²) de la Fase 2: reconstrucción violenta en ~220–320 ms
  returnDamping: 0.12,               // amortiguamiento normal de la Fase 2 (casi libre → aceleración sostenida)
  lateralDamping: 11,                // 1/s, mata la deriva lateral → filamentos afilados
  settleStiffness: 1000, settleDamping: 0.5, settleTime: 0.32,   // asentamiento elástico tras el encaje
  arrivalRadius: 30, inset: 6,       // px
  holdStiffness: 450,                // retención de partículas en reposo que quedan fuera de la figura
  relapseDistance: 24,               // si una partícula en reposo queda más lejos → regenera (Fase 2)
  spacing: 1100, spacingScale: 1.15, // repulsión suave de equilibrado (reparto uniforme del volumen)
  apexSpeed: 110, smokeMax: 1.7,     // px/s para entrar al ápice; tope de la fase de humo (s)
  turbulence: 140,                   // px/s² de turbulencia suave en el humo
  burstTime: 0.42,                   // s de expansión a pantalla completa en transiciones Hero ↔ Aro
  maxSpeed: 4200, edgeMargin: 28, edgeForce: 3500,
  kernelSigma: 0.75, fill: 1.0,      // splatting
  enableHoldAttraction: false,       // clic mantenido NO atrae (desactivado)
};
const C = PHYSICS_CONFIG;
const HC = 16;                       // celda del hash espacial
const TC = 4;                        // celda del campo de distancia del texto
const ROPE_N = 96;
const LW = 24, LH = 14;              // rejilla de color local del vídeo
const TWO_PI = Math.PI * 2;

export const centerAngle = (k, N) => Math.PI / 2 - k * (TWO_PI / N);
export const boundaryAngle = (j, N) => Math.PI / 2 - (j + 0.5) * (TWO_PI / N);
export function segmentAt(angle, N) {
  const seg = TWO_PI / N;
  let u = (Math.PI / 2 + seg / 2 - angle) / seg;
  u = ((u % N) + N) % N;
  const k = Math.floor(u);
  return { k, f: u - k };
}

/* ------------------------- SDF de la escena ------------------------- */
let tSd = 0, tGx = 0, tGy = 1, tComp = -1, tArc = -1;

function sdfScene(S, x, y) {
  let d = 1e9; tComp = -1; tArc = -1;
  const N = S.N, R = S.R, rb = S.rb;
  for (let k = 0; k < N; k++) {
    const ap = S.ap[k], g = S.gam[k];
    if (ap - g < 0.03) continue;
    const c = S.cosC[k], s = S.sinC[k];
    const py = x * c + y * s, px = Math.abs(-x * s + y * c);
    const cm = S.cosM[k], sm = S.sinM[k];
    const qx = Math.abs(px * cm - py * sm), qy = py * cm + px * sm;     // arco [g, ap] plegado y rotado a su eje
    const sa = S.sinH[k], ca = S.cosH[k];
    let dd;
    if (ca * qx > sa * qy) { const ex = qx - sa * R, ey = qy - ca * R; dd = Math.sqrt(ex * ex + ey * ey) - rb; }
    else dd = Math.abs(Math.sqrt(qx * qx + qy * qy) - R) - rb;
    if (dd < d) { d = dd; tComp = 0; tArc = k; }
  }
  if (S.boxOn) {
    const qx = Math.abs(x - S.bx) - S.bhw + S.bcr, qy = Math.abs(y - S.by) - S.bhh + S.bcr;
    const mx = qx > 0 ? qx : 0, my = qy > 0 ? qy : 0;
    const sd0 = Math.sqrt(mx * mx + my * my) + Math.min(Math.max(qx, qy), 0) - S.bcr;
    const dd = Math.abs(sd0 - S.boff) - S.brb;
    if (dd < d) { d = dd; tComp = 1; }
  }
  if (S.jr > 1.5) {
    const ex = x - S.jx, ey = y - S.jy, dd = Math.sqrt(ex * ex + ey * ey) - S.jr;
    if (dd < d) { d = dd; tComp = 2; }
  }
  if (S.L > 2) {
    let f = (y + S.ropeH) / (2 * S.ropeH) * (ROPE_N - 1);
    f = f < 0 ? 0 : f > ROPE_N - 1.001 ? ROPE_N - 1.001 : f;
    const i0 = f | 0, fr = f - i0;
    const off = S.ro[i0] * (1 - fr) + S.ro[i0 + 1] * fr;
    const ex = Math.abs(x - off), ay = Math.abs(y) - S.L, ey = ay > 0 ? ay : 0;
    const dd = Math.sqrt(ex * ex + ey * ey) - S.lrb;
    if (dd < d) { d = dd; tComp = 3; }
  }
  return d;
}

let oR = 1, oG = 1, oB = 1;
function arcColor(S, x, y) {
  const N = S.N, col = S.colors;
  const { k, f } = segmentAt(Math.atan2(y, x), N);
  const c = col[k % N];
  if (f < 0.14) { const t = 0.5 + f / 0.28, p = col[(k + N - 1) % N]; oR = p[0] + (c[0] - p[0]) * t; oG = p[1] + (c[1] - p[1]) * t; oB = p[2] + (c[2] - p[2]) * t; }
  else if (f > 0.86) { const t = (f - 0.86) / 0.28, q = col[(k + 1) % N]; oR = c[0] + (q[0] - c[0]) * t; oG = c[1] + (q[1] - c[1]) * t; oB = c[2] + (q[2] - c[2]) * t; }
  else { oR = c[0]; oG = c[1]; oB = c[2]; }
}

function propagate(mask, gw, gh) {
  const nx = new Int16Array(gw * gh).fill(-1), ny = new Int16Array(gw * gh).fill(-1);
  for (let i = 0; i < mask.length; i++) if (mask[i]) { nx[i] = i % gw; ny[i] = (i / gw) | 0; }
  const tryN = (i, x, y, j) => {
    const sx = nx[j]; if (sx < 0) return;
    const sy = ny[j];
    if (nx[i] < 0) { nx[i] = sx; ny[i] = sy; return; }
    const d0 = (nx[i] - x) ** 2 + (ny[i] - y) ** 2, d1 = (sx - x) ** 2 + (sy - y) ** 2;
    if (d1 < d0) { nx[i] = sx; ny[i] = sy; }
  };
  for (let pass = 0; pass < 2; pass++) {
    for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
      const i = y * gw + x;
      if (x > 0) tryN(i, x, y, i - 1);
      if (y > 0) { tryN(i, x, y, i - gw); if (x > 0) tryN(i, x, y, i - gw - 1); if (x < gw - 1) tryN(i, x, y, i - gw + 1); }
    }
    for (let y = gh - 1; y >= 0; y--) for (let x = gw - 1; x >= 0; x--) {
      const i = y * gw + x;
      if (x < gw - 1) tryN(i, x, y, i + 1);
      if (y < gh - 1) { tryN(i, x, y, i + gw); if (x < gw - 1) tryN(i, x, y, i + gw + 1); if (x > 0) tryN(i, x, y, i + gw - 1); }
    }
  }
  return { nx, ny };
}

function ihash(a, b) {
  let h = Math.imul(a, 374761393) + Math.imul(b, 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

export class ParticleSystem {
  constructor({ atlas, N, count }) {
    this.n = count;
    this.W = 1; this.H = 1; this.frame = 0;
    const n = count;
    this.px = new Float32Array(n); this.py = new Float32Array(n);
    this.vx = new Float32Array(n); this.vy = new Float32Array(n);
    this.phase = new Uint8Array(n);          // 0 reposo · 1 humo · 2 ápice · 3 regeneración · 4 expansión
    this.timer = new Float32Array(n); this.t1 = new Float32Array(n); this.settle = new Float32Array(n);
    this.arrived = new Uint8Array(n); this.heat = new Float32Array(n); this.rnd = new Float32Array(n);
    this.bdx = new Float32Array(n); this.bdy = new Float32Array(n);
    this.cr = new Float32Array(n).fill(1); this.cg = new Float32Array(n).fill(1); this.cb = new Float32Array(n).fill(1);
    this.en = new Float32Array(n);
    this.hItems = new Int32Array(n); this.hCell = new Int32Array(n);
    for (let i = 0; i < n; i++) this.rnd[i] = Math.random();

    this.material = new THREE.ShaderMaterial({
      vertexShader: QUAD_VS, fragmentShader: GRID_FS, transparent: true, depthTest: false, depthWrite: false,
      uniforms: {
        tGrid: { value: null }, tAtlas: { value: atlas }, uGrid: { value: new THREE.Vector2(1, 1) },
        uCell: { value: C.cellSize }, uDpr: { value: 1 },
      },
    });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    this.mesh.frustumCulled = false; this.mesh.renderOrder = 3;

    this.setProjects(N);
    this.ropeO = new Float32Array(ROPE_N); this.ropeV = new Float32Array(ROPE_N);
    this.S.ro = this.ropeO;
    this.tgw = 1; this.tgh = 1; this.tin = new Uint8Array(1);
    this.tIn = null; this.tOut = null; this.textArea = 20000;
    this.cursorEnabled = false;
    this.areaSm = 20000;
    this.inited = false;
  }

  setProjects(N) {
    this.S = {
      N, mode: 1, R: 300, rb: 13,
      ap: new Float32Array(N), apT: new Float32Array(N), gam: new Float32Array(N), gamT: new Float32Array(N),
      cosC: new Float32Array(N), sinC: new Float32Array(N), cosM: new Float32Array(N).fill(1), sinM: new Float32Array(N),
      cosH: new Float32Array(N).fill(1), sinH: new Float32Array(N),
      colors: Array.from({ length: N }, () => [1, 1, 1]),
      boxOn: false, bx: 0, by: 0, bhw: 0, bhh: 0, bcr: 0, brb: 6, boff: 0, boxD: 0, local: null,
      jx: 0, jy: 0, jr: 0, jtx: 0, jty: 0, jtr: 0,
      L: 0, LT: 0, lrb: 13, ropeH: 400, ro: null,
    };
    for (let k = 0; k < N; k++) { const a = centerAngle(k, N); this.S.cosC[k] = Math.cos(a); this.S.sinC[k] = Math.sin(a); }
  }

  resize(W, H, dpr) {
    this.W = W; this.H = H;
    const cs = C.cellSize;
    this.gw = Math.ceil(W / cs); this.gh = Math.ceil(H / cs);
    const sz = this.gw * this.gh;
    this.Dm = new Float32Array(sz); this.Dr = new Float32Array(sz); this.Dg = new Float32Array(sz);
    this.Db = new Float32Array(sz); this.De = new Float32Array(sz);
    this.gridData = new Float32Array(sz * 4);
    if (this.gridTex) this.gridTex.dispose();
    this.gridTex = new THREE.DataTexture(this.gridData, this.gw, this.gh, THREE.RGBAFormat, THREE.FloatType);
    this.gridTex.minFilter = this.gridTex.magFilter = THREE.NearestFilter;
    this.gridTex.generateMipmaps = false; this.gridTex.needsUpdate = true;
    const u = this.material.uniforms;
    u.tGrid.value = this.gridTex; u.uGrid.value.set(this.gw, this.gh); u.uDpr.value = dpr;
    this.hgw = Math.ceil(W / HC) + 3; this.hgh = Math.ceil(H / HC) + 3;
    this.hStart = new Int32Array(this.hgw * this.hgh + 1);
    this.S.ropeH = H * 0.46;
    if (!this.inited) { this.scatter(true); this.inited = true; }
  }

  /** Reparte el pool de forma casi uniforme (jitter estratificado) por todo el viewport. */
  _stratified() {
    const n = this.n, W = this.W, H = this.H;
    const cols = Math.ceil(Math.sqrt(n * W / H)), rows = Math.ceil(n / cols);
    const pts = [];
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) pts.push([((c + Math.random()) / cols - 0.5) * W, ((r + Math.random()) / rows - 0.5) * H]);
    for (let i = pts.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [pts[i], pts[j]] = [pts[j], pts[i]]; }
    return pts;
  }

  /** Carga/recarga: partículas por todo el viewport, parpadean un instante y detonan hacia la figura. */
  scatter(initial) {
    const pts = this._stratified();
    for (let i = 0; i < this.n; i++) {
      this.px[i] = pts[i][0]; this.py[i] = pts[i][1]; this.vx[i] = this.vy[i] = 0;
      this.phase[i] = 2; this.timer[i] = 0.35 + this.rnd[i] * 0.5; this.heat[i] = 0;
    }
  }

  /** Expansión a pantalla completa (Hero ↔ Aro): todas las partículas se reparten por el viewport y luego colapsan. */
  burst() {
    const pts = this._stratified();
    for (let i = 0; i < this.n; i++) {
      this.bdx[i] = pts[i][0]; this.bdy[i] = pts[i][1];
      this.phase[i] = 4; this.timer[i] = C.burstTime * (0.85 + this.rnd[i] * 0.3); this.arrived[i] = 0;
    }
  }

  buildTextField(text, fontFamily) {
    const W = this.W, H = this.H;
    const gw = Math.ceil(W / TC), gh = Math.ceil(H / TC);
    const cv = document.createElement('canvas'); cv.width = gw; cv.height = gh;
    const g = cv.getContext('2d', { willReadFrequently: true });
    g.scale(1 / TC, 1 / TC);
    g.fillStyle = '#fff'; g.textAlign = 'center'; g.textBaseline = 'alphabetic';
    g.font = `800 200px ${fontFamily}`;
    const m0 = g.measureText(text);
    let fs = Math.min(200 * (W * 0.84) / m0.width, H * 0.36);
    g.font = `800 ${fs}px ${fontFamily}`;
    const asc = g.measureText(text).actualBoundingBoxAscent || fs * 0.73;
    g.fillText(text, W / 2, H * 0.44 + asc / 2);
    const data = g.getImageData(0, 0, gw, gh).data;
    const inside = new Uint8Array(gw * gh), outside = new Uint8Array(gw * gh);
    let cnt = 0;
    for (let i = 0; i < gw * gh; i++) { const v = data[i * 4 + 3] > 110 ? 1 : 0; inside[i] = v; outside[i] = 1 - v; cnt += v; }
    this.tgw = gw; this.tgh = gh;
    this.tIn = propagate(inside, gw, gh);       // punto interior más cercano (para celdas exteriores)
    this.tOut = propagate(outside, gw, gh);     // punto exterior más cercano (para celdas interiores)
    this.tMask = inside;
    this.textArea = Math.max(5000, cnt * TC * TC);
  }

  /** Distancia con signo + gradiente saliente del texto. */
  _textEval(x, y) {
    const gw = this.tgw, gh = this.tgh, hW = this.W * 0.5, hH = this.H * 0.5;
    const cx = x + hW, cy = hH - y;
    let gx = (cx / TC) | 0, gy = (cy / TC) | 0;
    gx = gx < 0 ? 0 : gx >= gw ? gw - 1 : gx; gy = gy < 0 ? 0 : gy >= gh ? gh - 1 : gy;
    const i = gy * gw + gx; tComp = 4; tArc = -1;
    if (this.tMask[i]) {
      const sx = this.tOut.nx[i];
      if (sx < 0) { tSd = -50; tGx = 0; tGy = 1; return; }
      const dxc = (sx + 0.5) * TC - cx, dyc = (this.tOut.ny[i] + 0.5) * TC - cy, L = Math.sqrt(dxc * dxc + dyc * dyc) || 1;
      tSd = -Math.max(0, L - TC * 0.5); tGx = dxc / L; tGy = -dyc / L;
    } else {
      const sx = this.tIn.nx[i];
      if (sx < 0) { tSd = 1e3; tGx = 0; tGy = 1; return; }
      const dxc = (sx + 0.5) * TC - cx, dyc = (this.tIn.ny[i] + 0.5) * TC - cy, L = Math.sqrt(dxc * dxc + dyc * dyc) || 1;
      tSd = L; tGx = -dxc / L; tGy = dyc / L;
    }
  }

  _eval(x, y, needGrad) {
    if (this.S.mode === 0) { this._textEval(x, y); return; }
    const S = this.S;
    const d = sdfScene(S, x, y); const comp = tComp, arc = tArc;
    tSd = d;
    if (d > 1e8) { tGx = 0; tGy = 1; return; }
    if (needGrad || d > 0) {
      const e = 2, gx = (sdfScene(S, x + e, y) - d) / e, gy = (sdfScene(S, x, y + e) - d) / e;
      const l = Math.sqrt(gx * gx + gy * gy) || 1; tGx = gx / l; tGy = gy / l;
    }
    tComp = comp; tArc = arc;
  }

  /** t: {mode:0|1, R, rb, ap[], gam[], colors[], box:{x,y,hw,hh,cr,rb,off,d,local}|null, junction:{x,y,r}, lineL, enabled} */
  setTargets(t) {
    const S = this.S;
    S.mode = t.mode; S.R = t.R; S.rb = t.rb;
    for (let k = 0; k < S.N; k++) { S.apT[k] = t.ap[k]; S.gamT[k] = t.gam[k]; }
    S.colors = t.colors;
    if (t.box) { S.boxOn = true; S.bx = t.box.x; S.by = t.box.y; S.bhw = t.box.hw; S.bhh = t.box.hh; S.bcr = t.box.cr; S.brb = t.box.rb; S.boff = t.box.off; S.boxD = t.box.d; S.local = t.box.local; }
    else S.boxOn = false;
    S.jtx = t.junction.x; S.jty = t.junction.y; S.jtr = t.junction.r;
    S.LT = t.lineL; S.lrb = t.lrb || 13;
    this.cursorEnabled = t.enabled;
  }

  _rope(dt, cur) {
    const S = this.S, n = ROPE_N, o = this.ropeO, v = this.ropeV;
    const dy = (2 * S.ropeH) / (n - 1), c2 = (620 / dy) ** 2, steps = 3, h = dt / steps;
    if (cur.valid && S.LT > 50) {
      for (let k = 0; k < n; k++) {
        const ddy = Math.abs(-S.ropeH + k * dy - cur.y);
        if (ddy > 130) continue;
        const w = (1 - ddy / 130) ** 2, prox = Math.max(0, 1 - Math.abs(cur.x - o[k]) / 170), wp = w * prox;
        v[k] += cur.vx * 0.16 * wp;
        v[k] += (Math.max(-170, Math.min(170, cur.x)) - o[k]) * 14 * wp * dt;
      }
    }
    const damp = Math.exp(-1.4 * h);
    for (let s = 0; s < steps; s++) {
      for (let k = 1; k < n - 1; k++) v[k] += (c2 * (o[k - 1] + o[k + 1] - 2 * o[k]) - 5 * o[k]) * h;
      for (let k = 1; k < n - 1; k++) { v[k] *= damp; o[k] += v[k] * h; }
      o[0] = o[n - 1] = 0; v[0] = v[n - 1] = 0;
    }
  }

  _area() {
    const S = this.S;
    let a = 0;
    if (S.mode === 0) return this.textArea;
    for (let k = 0; k < S.N; k++) { const l = S.ap[k] - S.gam[k]; if (l > 0.03) a += 2 * l * S.R * 2 * S.rb; }
    if (S.boxOn) {
      const per = 2 * (2 * S.bhw + 2 * S.bhh) - 8 * S.bcr + TWO_PI * S.bcr + TWO_PI * Math.max(0, S.boff);
      a += per * 2 * S.brb;
    }
    if (S.jr > 1.5) a += Math.PI * S.jr * S.jr;
    if (S.L > 2) a += 2 * S.L * 2 * S.lrb;
    return Math.max(a, 3000);
  }

  /** cur: {x,y,px,py,vx,vy,speed,valid} coords centradas (y arriba), px/s */
  update(dt, t, cur) {
    const S = this.S, W = this.W, H = this.H, n = this.n, cs = C.cellSize;
    const hW = W * 0.5, hH = H * 0.5;
    this.frame++;

    // --- suavizado de parámetros de la escena ---
    const ka = 1 - Math.exp(-9 * dt), kj = 1 - Math.exp(-14 * dt), kl = 1 - Math.exp(-5 * dt);
    for (let k = 0; k < S.N; k++) {
      S.ap[k] += (S.apT[k] - S.ap[k]) * ka; S.gam[k] += (S.gamT[k] - S.gam[k]) * ka;
      const m = (S.ap[k] + S.gam[k]) * 0.5, h = (S.ap[k] - S.gam[k]) * 0.5;
      S.cosM[k] = Math.cos(m); S.sinM[k] = Math.sin(m); S.cosH[k] = Math.cos(h); S.sinH[k] = Math.sin(Math.max(h, 0));
    }
    if (S.jr < 1.5 && S.jtr > 1.5) { S.jx = S.jtx; S.jy = S.jty; }
    S.jx += (S.jtx - S.jx) * kj; S.jy += (S.jty - S.jy) * kj; S.jr += (S.jtr - S.jr) * kj;
    S.L += (S.LT - S.L) * kl;
    this._rope(dt, cur);

    // --- volumen objetivo → espaciado y masa de splatting ---
    const area = this._area();
    this.areaSm += (area - this.areaSm) * (1 - Math.exp(-6 * dt));
    const h = Math.max(5, Math.min(15, Math.sqrt(this.areaSm / n) * C.spacingScale));
    const massScale = this.areaSm / (cs * cs * n) * C.fill;

    // --- hash espacial O(N) ---
    const hgw = this.hgw, hgh = this.hgh, hStart = this.hStart, hItems = this.hItems, hCell = this.hCell;
    const px = this.px, py = this.py, vxA = this.vx, vyA = this.vy;
    hStart.fill(0);
    for (let i = 0; i < n; i++) {
      let cx = ((px[i] + hW) / HC | 0) + 1, cy = ((py[i] + hH) / HC | 0) + 1;
      cx = cx < 1 ? 1 : cx > hgw - 2 ? hgw - 2 : cx; cy = cy < 1 ? 1 : cy > hgh - 2 ? hgh - 2 : cy;
      const c = cy * hgw + cx; hCell[i] = c; hStart[c + 1]++;
    }
    for (let c = 0; c < hgw * hgh; c++) hStart[c + 1] += hStart[c];
    const fillp = this._fillp || (this._fillp = new Int32Array(hgw * hgh + 1));
    if (fillp.length !== hStart.length) this._fillp = new Int32Array(hStart.length);
    const fp = this._fillp; fp.set(hStart);
    for (let i = 0; i < n; i++) hItems[fp[hCell[i]]++] = i;

    // --- cápsula barrida del cursor ---
    const capOn = this.cursorEnabled && cur.valid;
    const sx = cur.x - cur.px, sy = cur.y - cur.py, sl2 = sx * sx + sy * sy, sl = Math.sqrt(sl2);
    const cspeed = Math.min(sl / Math.max(dt, 1e-3), 6000);
    const capActive = capOn && sl > 0.6 && cspeed > 60;
    const ux = capActive ? sx / sl : 0, uy = capActive ? sy / sl : 0;
    const cr0 = C.cursorRadius + Math.min(cspeed * 0.01, 25), cr2 = cr0 * cr0;

    const phase = this.phase, timer = this.timer, t1 = this.t1, settle = this.settle, arrived = this.arrived, heat = this.heat;
    const rnd = this.rnd, en = this.en, ccr = this.cr, ccg = this.cg, ccb = this.cb;
    const dragK = Math.pow(C.dispersionDrag, dt * 60), xsphK = C.xsphCohesion * Math.min(1, dt * 60);
    const Kret = C.returnAcceleration, wRet = Math.sqrt(Kret), cRet = 2 * C.returnDamping * wRet;
    const Kset = C.settleStiffness, cSet = 2 * C.settleDamping * Math.sqrt(Kset);
    const latK = Math.exp(-C.lateralDamping * dt), rest = Math.exp(-9 * dt);
    const h2 = h * h, NR2 = 18 * 18, vmax2 = C.maxSpeed * C.maxSpeed;
    const mg = C.edgeMargin, EF = C.edgeForce, inset = C.inset, arrR = C.arrivalRadius;
    const local = S.local;

    for (let i = 0; i < n; i++) {
      let x = px[i], y = py[i], vx = vxA[i], vy = vyA[i];
      let ph = phase[i];

      // impulso del cursor (cápsula barrida): inyecta velocidad y manda la partícula a Fase 1
      if (capActive) {
        const l = ((x - cur.px) * sx + (y - cur.py) * sy) / sl2, s = l < 0 ? 0 : l > 1 ? 1 : l;
        const dx = x - (cur.px + sx * s), dy = y - (cur.py + sy * s), d2 = dx * dx + dy * dy;
        if (d2 < cr2) {
          const d = Math.sqrt(d2), f = 1 - d / cr0, f2 = f * f;
          const side = (ux * dy - uy * dx) >= 0 ? 1 : -1;
          const mag = cspeed * 0.55 * C.pushForce * f2;
          vx += ux * mag - uy * side * mag * 0.30 + (rnd[i] - 0.5) * mag * 0.25;   // dirección + apertura lateral laminar + turbulencia
          vy += uy * mag + ux * side * mag * 0.30 + (Math.random() - 0.5) * mag * 0.25;
          ph = 1; t1[i] = 0; arrived[i] = 0;
        }
      }

      // vecinos (hash espacial)
      let rx = 0, ry = 0, sw = 0, svx = 0, svy = 0, prx = 0, pry = 0;
      {
        const c = hCell[i];
        for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
          const cc = c + oy * hgw + ox;
          for (let q = hStart[cc], e = hStart[cc + 1]; q < e; q++) {
            const j = hItems[q]; if (j === i) continue;
            const dx = x - px[j], dy = y - py[j], r2 = dx * dx + dy * dy;
            if (r2 >= NR2) continue;
            const r = Math.sqrt(r2) + 1e-4;
            if (r2 < h2) { const f = 1 - r / h; rx += dx / r * f; ry += dy / r * f; }
            if (ph === 1) {
              const w = 1 - r / 18; sw += w; svx += w * vxA[j]; svy += w * vyA[j];
              if (r < 7) { const f = 1 - r / 7; prx += dx / r * f; pry += dy / r * f; }
            }
          }
        }
        if (rx === 0 && ry === 0 && ph !== 1) { /* sin vecinos */ }
      }

      let ax = 0, ay = 0;
      // contención suave en bordes
      if (x < -hW + mg) ax += EF * (1 - (x + hW) / mg); else if (x > hW - mg) ax -= EF * (1 - (hW - x) / mg);
      if (y < -hH + mg) ay += EF * (1 - (y + hH) / mg); else if (y > hH - mg) ay -= EF * (1 - (hH - y) / mg);

      if (ph === 4) {                                     // expansión a pantalla completa
        const k = 1 - Math.exp(-10 * dt);
        const dx = (this.bdx[i] - x) * k, dy = (this.bdy[i] - y) * k;
        x += dx; y += dy; vx = dx / dt * 0.5; vy = dy / dt * 0.5;
        timer[i] -= dt;
        if (timer[i] <= 0) { ph = 2; timer[i] = C.apexDelayMs / 1000 * (0.8 + rnd[i] * 0.4); }
        px[i] = x; py[i] = y; vxA[i] = vx; vyA[i] = vy; phase[i] = ph;
        en[i] = Math.min(1, Math.hypot(vx, vy) / 2200) * 0.6;
        continue;
      }

      if (ph === 1) {                                     // FASE 1 — humo inercial (retorno = 0)
        ax += prx * 900 + C.turbulence * Math.sin(y * 0.021 + t * 3.1 + rnd[i] * 6.28) * 1.0;
        ay += pry * 900 + C.turbulence * Math.cos(x * 0.019 + t * 2.7 + rnd[i] * 6.28) * 1.0;
        if (sw > 0.01) { const k = xsphK * Math.min(1, sw); vx += (svx / sw - vx) * k; vy += (svy / sw - vy) * k; }
        vx += ax * dt; vy += ay * dt; vx *= dragK; vy *= dragK;
        t1[i] += dt;
        const sp2 = vx * vx + vy * vy;
        if ((sp2 < C.apexSpeed * C.apexSpeed && t1[i] > 0.1) || t1[i] > C.smokeMax) { ph = 2; timer[i] = C.apexDelayMs / 1000 * (0.85 + rnd[i] * 0.3); }
      } else if (ph === 2) {                              // pausa en el ápice
        vx += ax * dt; vy += ay * dt;
        const k = Math.exp(-14 * dt); vx *= k; vy *= k;
        timer[i] -= dt;
        if (timer[i] <= 0) { ph = 3; heat[i] = 1; arrived[i] = 0; settle[i] = C.settleTime; }
      } else {                                            // 0 reposo / 3 regeneración: objetivo por SDF
        this._eval(x, y, ph === 3);
        const sd = tSd;
        if (tComp >= 0 && sd < 1e8) {
          // color de la figura (se conserva durante el humo)
          if (tComp === 0 || tComp === 2) { arcColor(S, x, y); ccr[i] = oR; ccg[i] = oG; ccb[i] = oB; }
          else if (tComp === 1) {
            if (local) {
              let u = (x - (S.bx - S.bhw)) / (2 * S.bhw), v = ((S.by + S.bhh) - y) / (2 * S.bhh);
              u = u < 0 ? 0 : u > 0.999 ? 0.999 : u; v = v < 0 ? 0 : v > 0.999 ? 0.999 : v;
              const li = ((v * LH | 0) * LW + (u * LW | 0)) * 3;
              ccr[i] = local[li]; ccg[i] = local[li + 1]; ccb[i] = local[li + 2];
            }
          } else if (tComp === 3) { ccr[i] = 0.9; ccg[i] = 0.9; ccb[i] = 0.92; }
          else { ccr[i] = ccg[i] = ccb[i] = 1; }
        }
        if (ph === 0) {
          ax += rx * C.spacing; ay += ry * C.spacing;
          if (sd > 0 && sd < 1e8) { const pull = Math.min(sd + 1, 700); ax -= tGx * C.holdStiffness * pull; ay -= tGy * C.holdStiffness * pull; }
          if (sd > C.relapseDistance && sd < 1e8) { ph = 3; heat[i] = 1; arrived[i] = 0; settle[i] = C.settleTime; }
          vx += ax * dt; vy += ay * dt; vx *= rest; vy *= rest;
        } else if (sd >= 1e8) {                           // sin objetivo: deriva amortiguada
          vx *= rest; vy *= rest;
        } else {                                          // FASE 2 — regeneración violenta con rebote
          const e = sd + inset;
          ax += rx * C.spacing * 0.35; ay += ry * C.spacing * 0.35;
          let K = Kret, c = cRet;
          if (arrived[i]) { K = Kset; c = cSet; }
          else if (Math.abs(e) < arrR) {                   // freno magnético: conserva solo el 20 % de la velocidad normal
            const vn = vx * tGx + vy * tGy;
            vx -= tGx * vn * (1 - C.magneticBrake); vy -= tGy * vn * (1 - C.magneticBrake);
            arrived[i] = 1; K = Kset; c = cSet;
          }
          const an = -K * (e > 700 ? 700 : e < -700 ? -700 : e);
          vx += (ax + tGx * an) * dt; vy += (ay + tGy * an) * dt;
          let vn = vx * tGx + vy * tGy;
          const tx = vx - vn * tGx, ty = vy - vn * tGy;
          vn *= Math.exp(-c * dt);
          const lk = arrived[i] ? 1 : latK;
          vx = tx * lk + vn * tGx; vy = ty * lk + vn * tGy;
          if (arrived[i]) { settle[i] -= dt; if (settle[i] <= 0) ph = 0; }
        }
      }

      const sp2 = vx * vx + vy * vy;
      if (sp2 > vmax2) { const s = C.maxSpeed / Math.sqrt(sp2); vx *= s; vy *= s; }
      x += vx * dt; y += vy * dt;
      // clamping duro: ninguna partícula sale del viewport
      if (x < -hW + 1) { x = -hW + 1; vx = Math.abs(vx) * 0.4; } else if (x > hW - 1) { x = hW - 1; vx = -Math.abs(vx) * 0.4; }
      if (y < -hH + 1) { y = -hH + 1; vy = Math.abs(vy) * 0.4; } else if (y > hH - 1) { y = hH - 1; vy = -Math.abs(vy) * 0.4; }
      px[i] = x; py[i] = y; vxA[i] = vx; vyA[i] = vy; phase[i] = ph;

      if (heat[i] > 0) heat[i] = Math.max(0, heat[i] - dt * 2.6);
      const spd = Math.sqrt(vx * vx + vy * vy) / 2200;
      en[i] = Math.min(1, Math.max(heat[i], spd));
    }

    this._splat(t, massScale);
  }

  _splat(t, massScale) {
    const S = this.S, n = this.n, cs = C.cellSize, gw = this.gw, gh = this.gh, hW = this.W * 0.5, hH = this.H * 0.5;
    const Dm = this.Dm, Dr = this.Dr, Dg = this.Dg, Db = this.Db, De = this.De;
    Dm.fill(0); Dr.fill(0); Dg.fill(0); Db.fill(0); De.fill(0);
    const inv2s = 1 / (2 * C.kernelSigma * C.kernelSigma), w9 = this._w9 || (this._w9 = new Float32Array(9));
    const px = this.px, py = this.py;
    for (let i = 0; i < n; i++) {
      const gx = (px[i] + hW) / cs, gy = (py[i] + hH) / cs, cx = Math.floor(gx), cy = Math.floor(gy);
      let sum = 0, q = 0;
      for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++, q++) {
        const dx = gx - (cx + ox + 0.5), dy = gy - (cy + oy + 0.5);
        const w = Math.exp(-(dx * dx + dy * dy) * inv2s); w9[q] = w; sum += w;
      }
      const inv = 1 / sum, e = this.en[i], r = this.cr[i], g = this.cg[i], b = this.cb[i];
      q = 0;
      for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++, q++) {
        const xx = cx + ox, yy = cy + oy;
        if (xx < 0 || yy < 0 || xx >= gw || yy >= gh) continue;
        const w = w9[q] * inv, gi = yy * gw + xx;
        Dm[gi] += w; Dr[gi] += w * r; Dg[gi] += w * g; Db[gi] += w * b; De[gi] += w * e;
      }
    }
    const out = this.gridData, flick = (t * 7) | 0, size = gw * gh;
    const boxOn = S.boxOn && S.boxD > 0.001;
    const bandW = 2 * S.brb;
    for (let gi = 0; gi < size; gi++) {
      const m = Dm[gi], o = gi * 4;
      if (m < 0.004) { out[o + 3] = 0; continue; }
      const inv = 1 / m, E = De[gi] * inv;
      let L = m * massScale;
      // parpadeo de luminancia (más marcado en nubes dispersas)
      const hs = ihash(gi, flick);
      const amp = 0.2 + 0.6 * (1 - Math.min(1, L));
      L *= 1 - amp * (1 - hs) * 0.6;
      if (boxOn) {                                        // degradado radial hacia el exterior del marco del vídeo
        const wx = ((gi % gw) + 0.5) * cs - hW - S.bx, wy = (((gi / gw) | 0) + 0.5) * cs - hH - S.by;
        const qx = Math.abs(wx) - S.bhw + S.bcr, qy = Math.abs(wy) - S.bhh + S.bcr;
        const mx = qx > 0 ? qx : 0, my = qy > 0 ? qy : 0;
        const sd0 = Math.sqrt(mx * mx + my * my) + Math.min(Math.max(qx, qy), 0) - S.bcr;
        let tt = (sd0 - (S.boff - S.brb)) / bandW; tt = tt < 0 ? 0 : tt > 1 ? 1 : tt;
        const p = 1.35 + (0.18 - 1.35) * tt;
        L *= 1 + (p - 1) * S.boxD;
      }
      L *= 1 + 0.5 * E;
      let f = (L - 0.05) / 1.5; f = f < 0 ? 0 : f > 1 ? 1 : f;
      let gl = Math.pow(f, 0.85) * 8.99 + E * 1.5; if (gl > 8.99) gl = 8.99;
      let al = (L - 0.03) / 0.19; al = al < 0 ? 0 : al > 1 ? 1 : al; al = al * al * (3 - 2 * al);
      const white = Math.min(1, E * 1.35);                // crestas de alta energía → blanco incandescente
      out[o] = Dr[gi] * inv + (1 - Dr[gi] * inv) * white;
      out[o + 1] = Dg[gi] * inv + (1 - Dg[gi] * inv) * white;
      out[o + 2] = Db[gi] * inv + (1 - Db[gi] * inv) * white;
      out[o + 3] = Math.floor(gl) + al * 0.99;
    }
    this.gridTex.needsUpdate = true;
  }
}
