// particles.js — motor de partículas ASCII sobre grilla fija (splatting), física en dos fases (humo → retorno violento),
// balanceo y regeneración progresiva de huecos, plegado bilateral ALYSAURIO → Aro, ondas contrapuestas en DETAIL_RECT
// e interacción unidireccional desde el interior del vídeo.
import * as THREE from 'three';
import { GRID_FS, QUAD_VS } from './shaders.js';

/* ======================= AJUSTES FÍSICOS CENTRALIZADOS ======================= */
export const PHYSICS_CONFIG = {
  charset: ['.', ':', ';', '=', '+', 'x', '#', '%', '@'],   // rampa Técnica (baja → alta densidad)
  cellSize: 7,                       // px de la grilla ASCII fija (6–7)
  particleCount: { low: 2600, mid: 2900, high: 3200 },   // pool fijo estrictamente conservado
  pushForce: 1.00,                   // impulso del cursor (proporcional a su velocidad)
  previewInnerPushScale: 0.18,       // atenuación del empuje dentro del vídeo del «arito» (15–20 %)
  magneticBrake: 0.20,               // 20 % — leve rebote elástico al encajar
  cursorRadius: 43,                  // px, radio reducido a la mitad (~42–45 px)
  xsphCohesion: 0.30,                // arrastre de vecinas (XSPH) en Fase 1
  dispersionDrag: 0.96,              // fricción viscosa por frame@60fps en Fase 1
  apexDelayMs: 220,                  // pausa en el ápice antes de detonar Fase 2
  returnAcceleration: 72,            // rigidez (1/s²) de la Fase 2: retorno violento en ~220–320 ms
  returnDamping: 0.12,               // amortiguamiento normal de Fase 2
  lateralDamping: 11,                // 1/s, mata la deriva lateral → filamentos afilados
  settleStiffness: 1000, settleDamping: 0.5, settleTime: 0.32,
  arrivalRadius: 30, inset: 6,       // px
  holdStiffness: 450,                // retención en reposo
  relapseDistance: 26,               // distancia a la que una partícula en reposo vuelve a regenerar
  spacing: 1100, spacingScale: 1.15, // repulsión suave de equilibrado
  apexSpeed: 110, smokeMax: 1.7,     // px/s para entrar al ápice; tope de Fase 1 (s)
  turbulence: 140,                   // px/s² de turbulencia suave tipo humo
  burstTime: 0.42,                   // s de expansión a pantalla completa (Aro → Hero)
  foldDuration: 0.40,                // s del plegado bilateral ALYSAURIO → halo anular (~55 % de ~720 ms)
  // regeneración progresiva de huecos (ritmo lento → aceleración cuadrática/cúbica)
  gapRegenBaseRate: 6,               // partículas/s iniciales por hueco
  gapRegenAccel2: 42,                // término cuadrático (gapAge²)
  gapRegenAccel3: 75,                // término cúbico (gapAge³)
  gapHaloMin: 24, gapHaloMax: 55,    // px, halo periférico donde emergen las partículas regenerativas
  // interacción unidireccional en DETAIL_RECT (solo desde el interior y salida rápida)
  rectPushRadius: 78,                // px desde el borde interior para abombamiento suave
  rectInnerBulge: 3000,              // fuerza suave hacia afuera al acercarse al borde desde dentro (~14–20 px de abombamiento)
  rectExitImpulse: 0.65,             // impulso de estela al salir rápido de dentro hacia fuera
  maxSpeed: 4200, edgeMargin: 28, edgeForce: 3500,
  kernelSigma: 0.75, fill: 1.0,
  enableHoldAttraction: false,       // clic mantenido desactivado
};
const C = PHYSICS_CONFIG;
const HC = 16;                       // celda del hash espacial
const TC = 4;                        // celda del campo de distancia del texto
const ROPE_N = 96;
const LW = 24, LH = 14;              // rejilla de color local del vídeo
const RING_BUCKETS = 36, ARITO_BUCKETS = 24, TOTAL_BUCKETS = RING_BUCKETS + ARITO_BUCKETS;
const TWO_PI = Math.PI * 2;
const HALF_PI = Math.PI * 0.5;

export const centerAngle = (k, N) => HALF_PI - k * (TWO_PI / N);
export const boundaryAngle = (j, N) => HALF_PI - (j + 0.5) * (TWO_PI / N);
export function wrapAngle(a) {
  a = (a + Math.PI) % TWO_PI;
  return a < 0 ? a + Math.PI : a - Math.PI;
}
export function segmentAt(angle, N) {
  const seg = TWO_PI / N;
  let u = (HALF_PI + seg / 2 - angle) / seg;
  u = ((u % N) + N) % N;
  const k = Math.floor(u);
  return { k, f: u - k };
}

/* ---------- Parametrización por longitud de arco del rectángulo redondeado (sentido horario desde arriba-centro) ---------- */
export function sampleRoundRect(u, bx, by, hw, hh, cr, off, out) {
  const sx = Math.max(0, hw - cr), sy = Math.max(0, hh - cr), r = Math.max(0.5, cr + off);
  const q = HALF_PI * r, P = 4 * sx + 4 * sy + TWO_PI * r;
  let s = ((u % 1) + 1) % 1 * P;
  let x, y, nx, ny;
  if (s < sx) {
    x = s; y = sy + r; nx = 0; ny = 1;
  } else if ((s -= sx) < q) {
    const a = HALF_PI - s / r; nx = Math.cos(a); ny = Math.sin(a); x = sx + nx * r; y = sy + ny * r;
  } else if ((s -= q) < 2 * sy) {
    x = sx + r; y = sy - s; nx = 1; ny = 0;
  } else if ((s -= 2 * sy) < q) {
    const a = -s / r; nx = Math.cos(a); ny = Math.sin(a); x = sx + nx * r; y = -sy + ny * r;
  } else if ((s -= q) < 2 * sx) {
    x = sx - s; y = -(sy + r); nx = 0; ny = -1;
  } else if ((s -= 2 * sx) < q) {
    const a = -HALF_PI - s / r; nx = Math.cos(a); ny = Math.sin(a); x = -sx + nx * r; y = -sy + ny * r;
  } else if ((s -= q) < 2 * sy) {
    x = -(sx + r); y = -sy + s; nx = -1; ny = 0;
  } else if ((s -= 2 * sy) < q) {
    const a = Math.PI - s / r; nx = Math.cos(a); ny = Math.sin(a); x = -sx + nx * r; y = sy + ny * r;
  } else {
    s -= q; x = -sx + s; y = sy + r; nx = 0; ny = 1;
  }
  out.x = bx + x; out.y = by + y; out.nx = nx; out.ny = ny;
}

function roundRectU(wx, wy, hw, hh, cr, off) {
  const sx = Math.max(0, hw - cr), sy = Math.max(0, hh - cr), r = Math.max(0.5, cr + off);
  const q = HALF_PI * r, P = 4 * sx + 4 * sy + TWO_PI * r;
  let s;
  if (Math.abs(wx) <= sx && wy >= 0) s = wx >= 0 ? wx : P + wx;
  else if (wx > sx && wy > sy) s = sx + (HALF_PI - Math.atan2(wy - sy, wx - sx)) * r;
  else if (wx >= 0 && Math.abs(wy) <= sy) s = sx + q + (sy - wy);
  else if (wx > sx && wy < -sy) s = sx + q + 2 * sy + (-Math.atan2(wy + sy, wx - sx)) * r;
  else if (Math.abs(wx) <= sx && wy < 0) s = sx + 2 * q + 2 * sy + (sx - wx);
  else if (wx < -sx && wy < -sy) s = 3 * sx + 2 * q + 2 * sy + (-HALF_PI - Math.atan2(wy + sy, wx + sx)) * r;
  else if (wx < 0 && Math.abs(wy) <= sy) s = 3 * sx + 3 * q + 2 * sy + (wy + sy);
  else s = 3 * sx + 3 * q + 4 * sy + (Math.PI - Math.atan2(wy - sy, wx + sx)) * r;
  return (((s % P) + P) % P) / P;
}

/* ---------- Ondas simbióticas contrapuestas sobre el perímetro de DETAIL_RECT ---------- */
let wSum = 0, wCol = 0;
function wrapU(a, b) { let d = (a - b) % 1; if (d < -0.5) d += 1; else if (d > 0.5) d -= 1; return d; }
function evalRectWaves(u, t) {
  // velocidades no armónicas en sentidos opuestos (2 horarias + 1 antihoraria)
  const d0 = wrapU(u, (t * 0.137) % 1) / 0.056;
  const d1 = wrapU(u, (1 - (t * 0.173) % 1) % 1) / 0.048;
  const d2 = wrapU(u, (0.41 + t * 0.089) % 1) / 0.064;
  const w0 = 0.56 * Math.exp(-0.5 * d0 * d0);
  const w1 = 0.54 * Math.exp(-0.5 * d1 * d1);
  const w2 = 0.42 * Math.exp(-0.5 * d2 * d2);
  const fwd = w0 + w2, bwd = w1;
  wSum = fwd + bwd;
  wCol = Math.min(1.4, fwd * bwd * 2.9);    // pico constructivo cuando colisionan paquetes contrapuestos
}

/* ------------------------- SDF de la escena ------------------------- */
let tSd = 0, tGx = 0, tGy = 1, tComp = -1;

function sdfScene(S, x, y) {
  let d = 1e9; tComp = -1;
  const R = S.R, rb = S.rb, ac = S.arcCount;
  for (let k = 0; k < ac; k++) {
    const c = S.aCosM[k], s = S.aSinM[k];
    const py = x * c + y * s, px = Math.abs(-x * s + y * c);
    const sa = S.aSinH[k], ca = S.aCosH[k];
    let dd;
    if (ca * px > sa * py) { const ex = px - sa * R, ey = py - ca * R; dd = Math.sqrt(ex * ex + ey * ey) - rb; }
    else dd = Math.abs(Math.sqrt(px * px + py * py) - R) - rb;
    if (dd < d) { d = dd; tComp = 0; }
  }
  if (S.boxOn) {
    const wx = x - S.bx, wy = y - S.by;
    const qx = Math.abs(wx) - S.bhw + S.bcr, qy = Math.abs(wy) - S.bhh + S.bcr;
    const mx = qx > 0 ? qx : 0, my = qy > 0 ? qy : 0;
    const sd0 = Math.sqrt(mx * mx + my * my) + Math.min(Math.max(qx, qy), 0) - S.bcr;
    let bulge = 0, extraRb = 0;
    if (S.boxD > 0.15) {
      evalRectWaves(roundRectU(wx, wy, S.bhw, S.bhh, S.bcr, S.boff), S.time);
      bulge = (wSum * 4.5 + wCol * 9.5) * S.boxD;
      extraRb = wCol * 2.5 * S.boxD;
    }
    const dd = Math.abs(sd0 - (S.boff + bulge)) - (S.brb + extraRb);
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
    // 0 reposo · 1 humo · 2 ápice · 3 regeneración violenta · 4 expansión pantalla · 5 plegado bilateral Hero→Aro
    this.phase = new Uint8Array(n);
    this.timer = new Float32Array(n); this.t1 = new Float32Array(n); this.settle = new Float32Array(n);
    this.arrived = new Uint8Array(n); this.heat = new Float32Array(n); this.rnd = new Float32Array(n);
    this.emerge = new Float32Array(n).fill(1);
    // objetivos explícitos (regeneración de huecos, distribución 360° en DETAIL_RECT, reconstrucción de ALYSAURIO)
    this.hasTarget = new Uint8Array(n);
    this.tx = new Float32Array(n); this.ty = new Float32Array(n);
    this.rectU = new Float32Array(n); this.rectOff = new Float32Array(n);
    // expansión (phase 4) y curva cuadrática de plegado bilateral (phase 5)
    this.bdx = new Float32Array(n); this.bdy = new Float32Array(n);
    this.fx0 = new Float32Array(n); this.fy0 = new Float32Array(n);
    this.fx1 = new Float32Array(n); this.fy1 = new Float32Array(n);
    this.fx2 = new Float32Array(n); this.fy2 = new Float32Array(n);
    this.foldDur = new Float32Array(n);

    this.cr = new Float32Array(n).fill(1); this.cg = new Float32Array(n).fill(1); this.cb = new Float32Array(n).fill(1);
    this.en = new Float32Array(n);
    this.hItems = new Int32Array(n); this.hCell = new Int32Array(n);
    // cubetas para balanceo y regeneración progresiva de huecos (O(N), cero asignaciones por frame)
    this.bHead = new Int32Array(TOTAL_BUCKETS); this.bNext = new Int32Array(n);
    this.bCount = new Int32Array(TOTAL_BUCKETS); this.bIdeal = new Float32Array(TOTAL_BUCKETS);
    this.bActive = new Uint8Array(TOTAL_BUCKETS);
    this.gapAge = new Float32Array(TOTAL_BUCKETS); this.spawnAcc = new Float32Array(TOTAL_BUCKETS);

    for (let i = 0; i < n; i++) { this.rnd[i] = Math.random(); this.rectU[i] = i / n; this.rectOff[i] = (Math.random() - 0.5) * 1.5; }

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
    this.tgw = 1; this.tgh = 1; this.tMask = new Uint8Array(1);
    this.tIn = null; this.tOut = null; this.textArea = 20000; this.textHalfW = 300;
    this.textSamplesX = new Float32Array(0); this.textSamplesY = new Float32Array(0);
    this.cursorEnabled = false;
    this.areaSm = 20000;
    this.inited = false;
    this._pt = { x: 0, y: 0, nx: 0, ny: 1 };
  }

  setProjects(N) {
    const maxArcs = N + 2;
    this.S = {
      N, mode: 1, R: 300, rb: 17, time: 0, pushScale: 1,
      arcCount: 0,
      aMid: new Float32Array(maxArcs), aHalf: new Float32Array(maxArcs),
      aCosM: new Float32Array(maxArcs), aSinM: new Float32Array(maxArcs),
      aCosH: new Float32Array(maxArcs), aSinH: new Float32Array(maxArcs),
      colors: Array.from({ length: N }, () => [1, 1, 1]),
      boxOn: false, bx: 0, by: 0, bhw: 0, bhh: 0, bcr: 0, brb: 9, boff: 0, boxD: 0, local: null, isDetail: false,
      curInsideRect: false, curWasInsideRect: false,
      jx: 0, jy: 0, jr: 0, jtx: 0, jty: 0, jtr: 0,
      L: 0, LT: 0, lrb: 13, ropeH: 400, ro: null,
      ringActive: false,
    };
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

  /** Asigna objetivos uniformes sobre todo el volumen interior de ALYSAURIO (garantiza 100 % nitidez y volumen). */
  _assignTextTargets() {
    const m = this.textSamplesX.length;
    if (m === 0) { this.hasTarget.fill(0); return; }
    for (let i = 0; i < this.n; i++) {
      const j = (Math.random() * m) | 0;
      this.tx[i] = this.textSamplesX[j] + (Math.random() - 0.5) * TC;
      this.ty[i] = this.textSamplesY[j] + (Math.random() - 0.5) * TC;
      this.hasTarget[i] = 1;
    }
  }

  /** Carga/recarga: partículas por todo el viewport, parpadean un instante y detonan hacia la figura inicial. */
  scatter(toHero = true) {
    const pts = this._stratified();
    for (let i = 0; i < this.n; i++) {
      this.px[i] = pts[i][0]; this.py[i] = pts[i][1]; this.vx[i] = this.vy[i] = 0;
      this.phase[i] = 2; this.timer[i] = 0.35 + this.rnd[i] * 0.48; this.heat[i] = 0; this.emerge[i] = 1;
    }
    if (toHero && this.textSamplesX.length > 0) this._assignTextTargets();
    else this.hasTarget.fill(0);
  }

  /** Retorno Aro → Hero: expansión breve a pantalla completa y colapso violento reconstruyendo 100 % de ALYSAURIO. */
  burstToHero() {
    const pts = this._stratified();
    this._assignTextTargets();
    for (let i = 0; i < this.n; i++) {
      this.bdx[i] = pts[i][0]; this.bdy[i] = pts[i][1];
      this.phase[i] = 4; this.timer[i] = C.burstTime * (0.85 + this.rnd[i] * 0.3);
      this.arrived[i] = 0; this.emerge[i] = 1;
    }
    this.gapAge.fill(0); this.spawnAcc.fill(0);
  }

  /** Transición específica ALYSAURIO → Aro:
   *  El centro (u≈0) asciende hacia la cúspide superior; extremo izquierdo (u→-1) curva antihorario por el flanco izquierdo;
   *  extremo derecho (u→+1) curva horario por el flanco derecho hasta cerrar por debajo en un halo anular que compacta violentamente. */
  foldHeroToRing(R, rb) {
    const halfW = Math.max(80, this.textHalfW);
    const n = this.n;
    for (let i = 0; i < n; i++) {
      const x0 = this.px[i], y0 = this.py[i];
      const u = Math.max(-1, Math.min(1, x0 / halfW));
      // en coords centradas (Y arriba): u=0 → +π/2 (arriba); u>0 → horario (derecha→abajo); u<0 → antihorario (izquierda→abajo)
      const ang = HALF_PI - u * Math.PI + (this.rnd[i] - 0.5) * 0.16;
      const ca = Math.cos(ang), sa = Math.sin(ang);
      // destino final sobre el aro nítido (para Fase 2 tras el halo)
      const rFinal = R + (Math.random() - 0.5) * 1.65 * rb;
      this.tx[i] = ca * rFinal; this.ty[i] = sa * rFinal; this.hasTarget[i] = 1;
      // halo anular difuso (~55 % de la transición): nube circular sin invadir esquinas lejanas
      const rHalo = R + (this.rnd[i] - 0.5) * (rb * 4.8) + (Math.random() - 0.5) * 28;
      this.fx0[i] = x0; this.fy0[i] = y0;
      this.fx2[i] = ca * rHalo; this.fy2[i] = sa * rHalo;
      // punto de control cuadrático: eleva el centro y arquea ambos brazos por los flancos exteriores
      const ctrlAng = HALF_PI - u * Math.PI * 0.52;
      const ctrlR = R * (1.15 + 0.10 * Math.abs(u)) + (this.rnd[i] - 0.5) * 28;
      this.fx1[i] = Math.cos(ctrlAng) * ctrlR; this.fy1[i] = Math.sin(ctrlAng) * ctrlR;
      this.phase[i] = 5; this.timer[i] = 0;
      this.foldDur[i] = C.foldDuration * (0.88 + this.rnd[i] * 0.24);
      this.arrived[i] = 0; this.emerge[i] = 1;
    }
    this.gapAge.fill(0); this.spawnAcc.fill(0);
  }

  /** Entrada a DETAIL_RECT: redistribuye el 100 % del pool uniformemente por longitud de arco sobre los 4 lados y 4 esquinas. */
  distributeRect(box, off, brb) {
    const n = this.n, bx = box.x, by = box.y;
    // ordena las partículas por ángulo horario desde arriba-centro alrededor del rectángulo para minimizar cruces
    const order = new Array(n);
    const angs = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      order[i] = i;
      let a = (HALF_PI - Math.atan2(this.py[i] - by, this.px[i] - bx)) % TWO_PI;
      if (a < 0) a += TWO_PI;
      angs[i] = a;
    }
    order.sort((a, b) => angs[a] - angs[b]);
    const pt = this._pt;
    for (let rank = 0; rank < n; rank++) {
      const i = order[rank];
      const u = (rank + Math.random()) / n;
      const ro = (Math.random() - 0.5) * 1.55;
      this.rectU[i] = u; this.rectOff[i] = ro;
      sampleRoundRect(u, bx, by, box.hw, box.hh, box.cr, off, pt);
      this.tx[i] = pt.x + pt.nx * ro * brb; this.ty[i] = pt.y + pt.ny * ro * brb;
      this.hasTarget[i] = 1; this.phase[i] = 3;
      this.arrived[i] = 0; this.settle[i] = C.settleTime;
      this.heat[i] = 0.65; this.emerge[i] = 1;
    }
    this.gapAge.fill(0); this.spawnAcc.fill(0);
  }

  clearExplicitTargets() { this.hasTarget.fill(0); }

  buildTextField(text, fontFamily) {
    const W = this.W, H = this.H;
    const gw = Math.ceil(W / TC), gh = Math.ceil(H / TC);
    const cv = document.createElement('canvas'); cv.width = gw; cv.height = gh;
    const g = cv.getContext('2d', { willReadFrequently: true });
    g.scale(1 / TC, 1 / TC);
    g.fillStyle = '#fff'; g.textAlign = 'center'; g.textBaseline = 'alphabetic';
    g.font = `800 200px ${fontFamily}`;
    const m0 = g.measureText(text);
    const fs = Math.min(200 * (W * 0.84) / m0.width, H * 0.36);
    g.font = `800 ${fs}px ${fontFamily}`;
    const asc = g.measureText(text).actualBoundingBoxAscent || fs * 0.73;
    g.fillText(text, W / 2, H * 0.44 + asc / 2);
    const data = g.getImageData(0, 0, gw, gh).data;
    const inside = new Uint8Array(gw * gh), outside = new Uint8Array(gw * gh);
    const sx = [], sy = [];
    const hW = W * 0.5, hH = H * 0.5;
    let minX = hW, maxX = -hW;
    for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
      const i = y * gw + x;
      const v = data[i * 4 + 3] > 110 ? 1 : 0;
      inside[i] = v; outside[i] = 1 - v;
      if (v) {
        const wx = (x + 0.5) * TC - hW, wy = hH - (y + 0.5) * TC;
        sx.push(wx); sy.push(wy);
        if (wx < minX) minX = wx; if (wx > maxX) maxX = wx;
      }
    }
    this.tgw = gw; this.tgh = gh;
    this.tIn = propagate(inside, gw, gh);
    this.tOut = propagate(outside, gw, gh);
    this.tMask = inside;
    this.textSamplesX = new Float32Array(sx); this.textSamplesY = new Float32Array(sy);
    this.textArea = Math.max(5000, sx.length * TC * TC);
    this.textHalfW = maxX > minX ? Math.max(Math.abs(minX), Math.abs(maxX)) : W * 0.42;
    // en la carga inicial, asigna objetivos uniformes de ALYSAURIO (si el scroll inicial es otra sección, main.js los limpia)
    if (this.frame < 2) this._assignTextTargets();
  }

  _textEval(x, y) {
    const gw = this.tgw, gh = this.tgh, hW = this.W * 0.5, hH = this.H * 0.5;
    const cx = x + hW, cy = hH - y;
    let gx = (cx / TC) | 0, gy = (cy / TC) | 0;
    gx = gx < 0 ? 0 : gx >= gw ? gw - 1 : gx; gy = gy < 0 ? 0 : gy >= gh ? gh - 1 : gy;
    const i = gy * gw + gx; tComp = 4;
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
    const d = sdfScene(S, x, y); const comp = tComp;
    tSd = d;
    if (d > 1e8) { tGx = 0; tGy = 1; return; }
    if (needGrad || d > 0) {
      const e = 2, gx = (sdfScene(S, x + e, y) - d) / e, gy = (sdfScene(S, x, y + e) - d) / e;
      const l = Math.sqrt(gx * gx + gy * gy) || 1; tGx = gx / l; tGy = gy / l;
    }
    tComp = comp;
  }

  /** t: {mode, R, rb, arcs:[{mid,half}], colors, box, junction, lineL, lrb, enabled, pushScale, ringActive, isDetail, curInsideRect, curWasInsideRect} */
  setTargets(t) {
    const S = this.S;
    S.mode = t.mode; S.R = t.R; S.rb = t.rb;
    S.pushScale = t.pushScale !== undefined ? t.pushScale : 1;
    S.ringActive = !!t.ringActive;
    S.isDetail = !!t.isDetail;
    S.curInsideRect = !!t.curInsideRect;
    S.curWasInsideRect = !!t.curWasInsideRect;
    const ac = Math.min(t.arcs.length, S.aMid.length);
    S.arcCount = ac;
    for (let k = 0; k < ac; k++) {
      const m = t.arcs[k].mid, h = t.arcs[k].half;
      S.aMid[k] = m; S.aHalf[k] = h;
      S.aCosM[k] = Math.cos(m); S.aSinM[k] = Math.sin(m);
      S.aCosH[k] = Math.cos(h); S.aSinH[k] = Math.sin(h);
    }
    S.colors = t.colors;
    if (t.box) {
      S.boxOn = true; S.bx = t.box.x; S.by = t.box.y; S.bhw = t.box.hw; S.bhh = t.box.hh;
      S.bcr = t.box.cr; S.brb = t.box.rb; S.boff = t.box.off; S.boxD = t.box.d; S.local = t.box.local;
    } else S.boxOn = false;
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
    for (let k = 0; k < S.arcCount; k++) a += 2 * S.aHalf[k] * S.R * 2 * S.rb;
    if (S.boxOn) {
      const per = 2 * (2 * S.bhw + 2 * S.bhh) - 8 * S.bcr + TWO_PI * S.bcr + TWO_PI * Math.max(0, S.boff);
      a += per * 2 * S.brb;
    }
    if (S.jr > 1.5) a += Math.PI * S.jr * S.jr;
    if (S.L > 2) a += 2 * S.L * 2 * S.lrb;
    return Math.max(a, 3000);
  }

  /** Evalúa cobertura ideal del aro + arito (O(N)) y condensa partículas alrededor de huecos con tasa creciente. */
  _rebalanceGaps(dt) {
    const S = this.S;
    if (!S.ringActive || S.mode === 0 || S.isDetail || S.boxD > 0.08) { this.gapAge.fill(0); this.spawnAcc.fill(0); return; }

    const bActive = this.bActive, bIdeal = this.bIdeal, bCount = this.bCount, bHead = this.bHead, bNext = this.bNext;
    bActive.fill(0); bIdeal.fill(0); bCount.fill(0); bHead.fill(-1);

    const R = S.R, rb = S.rb, ac = S.arcCount;
    const aritoOn = S.boxOn && S.boxD < 0.05 && S.bhw > 18;
    const bx = S.bx, by = S.by, rp = S.bhw, brb = S.brb;

    let totalArea = 0;
    const ringBucketArea = (TWO_PI / RING_BUCKETS) * R * (2 * rb);
    for (let b = 0; b < RING_BUCKETS; b++) {
      const ang = (b + 0.5) / RING_BUCKETS * TWO_PI;
      let on = false;
      for (let k = 0; k < ac; k++) {
        if (Math.abs(wrapAngle(ang - S.aMid[k])) <= S.aHalf[k]) { on = true; break; }
      }
      if (on) { bActive[b] = 1; bIdeal[b] = ringBucketArea; totalArea += ringBucketArea; }
    }
    if (aritoOn) {
      const aritoBucketArea = (TWO_PI / ARITO_BUCKETS) * rp * (2 * brb);
      for (let ab = 0; ab < ARITO_BUCKETS; ab++) {
        const b = RING_BUCKETS + ab;
        bActive[b] = 1; bIdeal[b] = aritoBucketArea; totalArea += aritoBucketArea;
      }
    }
    if (totalArea < 100) return;

    const n = this.n;
    for (let b = 0; b < TOTAL_BUCKETS; b++) bIdeal[b] = bActive[b] ? (bIdeal[b] / totalArea) * n : 0;

    // clasifica partículas asentadas (phase 0) y retornando hacia el objetivo (phase 3) en cubetas O(N)
    const px = this.px, py = this.py, phase = this.phase;
    for (let i = 0; i < n; i++) {
      const ph = phase[i];
      if (ph !== 0 && ph !== 3) continue;
      // si ya tiene un objetivo de regeneración, cuenta en el destino para no sobresolicitar el mismo hueco
      const x = (ph === 3 && this.hasTarget[i]) ? this.tx[i] : px[i];
      const y = (ph === 3 && this.hasTarget[i]) ? this.ty[i] : py[i];
      const dRing = Math.abs(Math.hypot(x, y) - R) - rb;
      let dArito = 1e9;
      if (aritoOn) dArito = Math.abs(Math.hypot(x - bx, y - by) - rp) - brb;
      let b = -1;
      if (aritoOn && dArito < dRing && dArito < 34) {
        let a = Math.atan2(y - by, x - bx); if (a < 0) a += TWO_PI;
        b = RING_BUCKETS + Math.min(ARITO_BUCKETS - 1, (a / TWO_PI * ARITO_BUCKETS) | 0);
      } else if (dRing < 34) {
        let a = Math.atan2(y, x); if (a < 0) a += TWO_PI;
        b = Math.min(RING_BUCKETS - 1, (a / TWO_PI * RING_BUCKETS) | 0);
      }
      if (b >= 0 && bActive[b]) {
        bCount[b]++;
        // solo partículas en reposo (phase 0) son candidatas a cederse desde sectores sobresaturados
        if (ph === 0) { bNext[i] = bHead[b]; bHead[b] = i; }
      }
    }

    // actualiza gapAge y condensa partículas alrededor de cada hueco a ritmo crecientemente acelerado
    const hW = this.W * 0.5, hH = this.H * 0.5;
    const hMin = C.gapHaloMin, hSpan = C.gapHaloMax - C.gapHaloMin;
    for (let b = 0; b < TOTAL_BUCKETS; b++) {
      if (!bActive[b] || bIdeal[b] < 2) { this.gapAge[b] = 0; this.spawnAcc[b] = 0; continue; }
      const ratio = bCount[b] / bIdeal[b];
      if (ratio < 0.80 || (this.gapAge[b] > 0 && ratio < 0.94)) {
        const age = (this.gapAge[b] += dt);
        const rate = C.gapRegenBaseRate + C.gapRegenAccel2 * age * age + C.gapRegenAccel3 * age * age * age;
        this.spawnAcc[b] += rate * dt;
        let toSpawn = Math.min(8, this.spawnAcc[b] | 0);
        if (toSpawn <= 0) continue;
        this.spawnAcc[b] -= toSpawn;

        while (toSpawn > 0 && bCount[b] < bIdeal[b] * 0.96) {
          // busca el sector más sobresaturado con partículas disponibles
          let src = -1, bestExcess = 1.04;
          for (let s = 0; s < TOTAL_BUCKETS; s++) {
            if (!bActive[s] || bHead[s] < 0 || bIdeal[s] < 1) continue;
            const ex = bCount[s] / bIdeal[s];
            if (ex > bestExcess) { bestExcess = ex; src = s; }
          }
          if (src < 0) break;

          const i = bHead[src];
          bHead[src] = bNext[i];
          bCount[src]--; bCount[b]++;
          toSpawn--;

          // punto objetivo dentro del tramo vacío + halo periférico (24–55 px hacia afuera/alrededor)
          let tx, ty, nx, ny;
          if (b < RING_BUCKETS) {
            const ang = (b + Math.random()) / RING_BUCKETS * TWO_PI;
            nx = Math.cos(ang); ny = Math.sin(ang);
            const rr = R + (Math.random() - 0.5) * 1.45 * rb;
            tx = nx * rr; ty = ny * rr;
            const side = Math.random() < 0.72 ? 1 : -1;
            const dist = hMin + Math.random() * hSpan;
            const tang = (Math.random() - 0.5) * 18;
            px[i] = Math.max(-hW + 4, Math.min(hW - 4, tx + nx * side * dist - ny * tang));
            py[i] = Math.max(-hH + 4, Math.min(hH - 4, ty + ny * side * dist + nx * tang));
            arcColor(S, tx, ty); this.cr[i] = oR; this.cg[i] = oG; this.cb[i] = oB;
          } else {
            const ab = b - RING_BUCKETS;
            const ang = (ab + Math.random()) / ARITO_BUCKETS * TWO_PI;
            nx = Math.cos(ang); ny = Math.sin(ang);
            const rr = rp + (Math.random() - 0.5) * 1.4 * brb;
            tx = bx + nx * rr; ty = by + ny * rr;
            // en el arito emergen hacia afuera para no aparecer encima del vídeo
            const dist = hMin + Math.random() * hSpan;
            const tang = (Math.random() - 0.5) * 14;
            px[i] = Math.max(-hW + 4, Math.min(hW - 4, tx + nx * dist - ny * tang));
            py[i] = Math.max(-hH + 4, Math.min(hH - 4, ty + ny * dist + nx * tang));
            arcColor(S, bx, by); this.cr[i] = oR; this.cg[i] = oG; this.cb[i] = oB;
          }

          this.vx[i] = 0; this.vy[i] = 0;
          this.tx[i] = tx; this.ty[i] = ty; this.hasTarget[i] = 1;
          this.phase[i] = 3; this.arrived[i] = 0; this.settle[i] = C.settleTime;
          this.heat[i] = 0.72; this.emerge[i] = 0.16;     // nace pequeña en el halo y entra de inmediato en Fase 2
        }
      } else if (ratio >= 0.94) {
        this.gapAge[b] = 0; this.spawnAcc[b] = 0;
      }
    }
  }

  /** cur: {x,y,px,py,vx,vy,speed,valid} coords centradas (y arriba), px/s */
  update(dt, t, cur) {
    const S = this.S, W = this.W, H = this.H, n = this.n, cs = C.cellSize;
    const hW = W * 0.5, hH = H * 0.5;
    this.frame++;
    S.time = t;

    // --- suavizado de unión y cuerda ---
    const kj = 1 - Math.exp(-14 * dt), kl = 1 - Math.exp(-5 * dt);
    if (S.jr < 1.5 && S.jtr > 1.5) { S.jx = S.jtx; S.jy = S.jty; }
    S.jx += (S.jtx - S.jx) * kj; S.jy += (S.jty - S.jy) * kj; S.jr += (S.jtr - S.jr) * kj;
    S.L += (S.LT - S.L) * kl;
    this._rope(dt, cur);

    // --- balanceo y regeneración progresiva de huecos (aro + arito) ---
    this._rebalanceGaps(dt);

    // --- volumen objetivo → espaciado y masa de splatting ---
    const area = this._area();
    this.areaSm += (area - this.areaSm) * (1 - Math.exp(-6 * dt));
    const h = Math.max(5, Math.min(16, Math.sqrt(this.areaSm / n) * C.spacingScale));
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

    // --- cápsula barrida del cursor (aro/arito) ---
    const capOn = this.cursorEnabled && cur.valid;
    const sx = cur.x - cur.px, sy = cur.y - cur.py, sl2 = sx * sx + sy * sy, sl = Math.sqrt(sl2);
    const cspeed = Math.min(sl / Math.max(dt, 1e-3), 6000);
    const capActive = capOn && sl > 0.6 && cspeed > 60;
    const ux = sl > 1e-4 ? sx / sl : 0, uy = sl > 1e-4 ? sy / sl : 0;
    const cr0 = C.cursorRadius + Math.min(cspeed * 0.005, 12), cr2 = cr0 * cr0;
    const pushMul = C.pushForce * S.pushScale;

    // --- interacción unidireccional en DETAIL_RECT (solo desde dentro y salida rápida) ---
    const detailInner = S.isDetail && S.boxOn && cur.valid && S.curInsideRect && S.curWasInsideRect;
    const detailExit = S.isDetail && S.boxOn && cur.valid && !S.curInsideRect && S.curWasInsideRect && sl > 1.5 && cspeed > 130;
    const rPush2 = C.rectPushRadius * C.rectPushRadius;
    const exitR = 64, exitR2 = exitR * exitR;

    const phase = this.phase, timer = this.timer, t1 = this.t1, settle = this.settle, arrived = this.arrived;
    const heat = this.heat, rnd = this.rnd, en = this.en, ccr = this.cr, ccg = this.cg, ccb = this.cb;
    const hasT = this.hasTarget, txA = this.tx, tyA = this.ty, emerge = this.emerge;
    const dragK = Math.pow(C.dispersionDrag, dt * 60), xsphK = C.xsphCohesion * Math.min(1, dt * 60);
    const Kret = C.returnAcceleration, wRet = Math.sqrt(Kret), cRet = 2 * C.returnDamping * wRet;
    const Kset = C.settleStiffness, cSet = 2 * C.settleDamping * Math.sqrt(Kset);
    const latK = Math.exp(-C.lateralDamping * dt), rest = Math.exp(-9 * dt);
    const h2 = h * h, NR2 = 18 * 18, vmax2 = C.maxSpeed * C.maxSpeed;
    const mg = C.edgeMargin, EF = C.edgeForce, inset = C.inset, arrR = C.arrivalRadius;
    const local = S.local, isDetail = S.isDetail && S.boxOn;
    const pt = this._pt;

    for (let i = 0; i < n; i++) {
      let x = px[i], y = py[i], vx = vxA[i], vy = vyA[i];
      let ph = phase[i];
      if (emerge[i] < 1) emerge[i] = Math.min(1, emerge[i] + dt * 6.5);

      // 1) impulso del cursor en Aro / Arito (también interrumpe plegado en vuelo)
      if (capActive) {
        const l = ((x - cur.px) * sx + (y - cur.py) * sy) / sl2, s = l < 0 ? 0 : l > 1 ? 1 : l;
        const dx = x - (cur.px + sx * s), dy = y - (cur.py + sy * s), d2 = dx * dx + dy * dy;
        if (d2 < cr2) {
          const d = Math.sqrt(d2), f = 1 - d / cr0, f2 = f * f;
          const side = (ux * dy - uy * dx) >= 0 ? 1 : -1;
          const mag = cspeed * 0.55 * pushMul * f2;
          vx += ux * mag - uy * side * mag * 0.30 + (rnd[i] - 0.5) * mag * 0.25;
          vy += uy * mag + ux * side * mag * 0.30 + (Math.random() - 0.5) * mag * 0.25;
          ph = 1; t1[i] = 0; arrived[i] = 0; hasT[i] = 0;
        }
      }

      // 2) estela de salida rápida en DETAIL_RECT (solo si el cursor venía de DENTRO y acaba de salir)
      if (detailExit) {
        const l = ((x - cur.px) * sx + (y - cur.py) * sy) / sl2, s = l < 0 ? 0 : l > 1 ? 1 : l;
        const dx = x - (cur.px + sx * s), dy = y - (cur.py + sy * s), d2 = dx * dx + dy * dy;
        if (d2 < exitR2) {
          const d = Math.sqrt(d2), f = 1 - d / exitR, f2 = f * f;
          const mag = Math.min(cspeed, 2800) * C.rectExitImpulse * f2;
          vx += ux * mag + (rnd[i] - 0.5) * mag * 0.22;
          vy += uy * mag + (Math.random() - 0.5) * mag * 0.22;
          ph = 1; t1[i] = 0; arrived[i] = 0;
        }
      }

      // vecinos (hash espacial O(N))
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
      }

      let ax = 0, ay = 0;
      // contención suave en bordes del viewport
      if (x < -hW + mg) ax += EF * (1 - (x + hW) / mg); else if (x > hW - mg) ax -= EF * (1 - (hW - x) / mg);
      if (y < -hH + mg) ay += EF * (1 - (y + hH) / mg); else if (y > hH - mg) ay -= EF * (1 - (hH - y) / mg);

      // 3) abombamiento suave desde el interior del vídeo en DETAIL_RECT (cuando cursor está dentro y se acerca al borde)
      if (detailInner && (ph === 0 || (ph === 3 && arrived[i]))) {
        const dx = x - cur.x, dy = y - cur.y, d2 = dx * dx + dy * dy;
        if (d2 < rPush2 && d2 > 1) {
          const d = Math.sqrt(d2), f = 1 - d / C.rectPushRadius, f2 = f * f;
          const ox = x - S.bx, oy = y - S.by, ol = Math.sqrt(ox * ox + oy * oy) || 1;
          ax += (ox / ol) * C.rectInnerBulge * f2 + (dx / d) * C.rectInnerBulge * 0.45 * f2;
          ay += (oy / ol) * C.rectInnerBulge * f2 + (dy / d) * C.rectInnerBulge * 0.45 * f2;
        }
      }

      if (ph === 5) {                                     // FASE 5 — plegado bilateral ALYSAURIO → halo anular
        timer[i] += dt;
        const s = Math.min(1, timer[i] / this.foldDur[i]);
        const e = s < 0.5 ? 2 * s * s : 1 - Math.pow(-2 * s + 2, 2) * 0.5;
        const om = 1 - e;
        const nx = om * om * this.fx0[i] + 2 * om * e * this.fx1[i] + e * e * this.fx2[i];
        const ny = om * om * this.fy0[i] + 2 * om * e * this.fy1[i] + e * e * this.fy2[i];
        vx = (nx - x) / Math.max(dt, 1e-3); vy = (ny - y) / Math.max(dt, 1e-3);
        x = nx; y = ny;
        // mezcla gradual de blanco → color del segmento destino durante la segunda mitad del arqueo
        if (s > 0.35) {
          arcColor(S, txA[i], tyA[i]);
          const ck = 1 - Math.exp(-dt * 8);
          ccr[i] += (oR - ccr[i]) * ck; ccg[i] += (oG - ccg[i]) * ck; ccb[i] += (oB - ccb[i]) * ck;
        }
        if (s >= 1) { ph = 3; hasT[i] = 0; heat[i] = 0.85; arrived[i] = 0; settle[i] = C.settleTime; }
        px[i] = x; py[i] = y; vxA[i] = vx; vyA[i] = vy; phase[i] = ph;
        en[i] = Math.min(1, 0.25 + Math.hypot(vx, vy) / 2400);
        continue;
      }

      if (ph === 4) {                                     // FASE 4 — expansión a pantalla completa (Aro → Hero)
        const k = 1 - Math.exp(-10 * dt);
        const dx = (this.bdx[i] - x) * k, dy = (this.bdy[i] - y) * k;
        x += dx; y += dy; vx = dx / dt * 0.5; vy = dy / dt * 0.5;
        timer[i] -= dt;
        if (timer[i] <= 0) { ph = 2; timer[i] = C.apexDelayMs / 1000 * (0.75 + rnd[i] * 0.4); }
        px[i] = x; py[i] = y; vxA[i] = vx; vyA[i] = vy; phase[i] = ph;
        en[i] = Math.min(1, Math.hypot(vx, vy) / 2200) * 0.6;
        continue;
      }

      if (ph === 1) {                                     // FASE 1 — humo inercial (retorno = 0 %)
        ax += prx * 900 + C.turbulence * Math.sin(y * 0.021 + t * 3.1 + rnd[i] * 6.28);
        ay += pry * 900 + C.turbulence * Math.cos(x * 0.019 + t * 2.7 + rnd[i] * 6.28);
        if (sw > 0.01) { const k = xsphK * Math.min(1, sw); vx += (svx / sw - vx) * k; vy += (svy / sw - vy) * k; }
        vx += ax * dt; vy += ay * dt; vx *= dragK; vy *= dragK;
        t1[i] += dt;
        const sp2 = vx * vx + vy * vy;
        if ((sp2 < C.apexSpeed * C.apexSpeed && t1[i] > 0.1) || t1[i] > C.smokeMax) {
          ph = 2; timer[i] = C.apexDelayMs / 1000 * (0.85 + rnd[i] * 0.3);
        }
      } else if (ph === 2) {                              // pausa en el ápice
        vx += ax * dt; vy += ay * dt;
        const k = Math.exp(-14 * dt); vx *= k; vy *= k;
        timer[i] -= dt;
        if (timer[i] <= 0) { ph = 3; heat[i] = 1; arrived[i] = 0; settle[i] = C.settleTime; }
      } else {                                            // 0 reposo / 3 regeneración violenta
        // en DETAIL_RECT, actualiza el objetivo dinámico por longitud de arco + ondas contrapuestas
        if (isDetail) {
          evalRectWaves(this.rectU[i], t);
          const waveBulge = (wSum * 4.5 + wCol * 9.5) * S.boxD;
          sampleRoundRect(this.rectU[i], S.bx, S.by, S.bhw, S.bhh, S.bcr, S.boff + waveBulge, pt);
          txA[i] = pt.x + pt.nx * this.rectOff[i] * (S.brb + wCol * 2.5 * S.boxD);
          tyA[i] = pt.y + pt.ny * this.rectOff[i] * (S.brb + wCol * 2.5 * S.boxD);
          if (ph === 3) hasT[i] = 1;
        }

        let sd, gx, gy, comp;
        if (ph === 3 && hasT[i]) {
          // atracción directa hacia el punto objetivo exacto (hueco, rectángulo 360°, plegado o ALYSAURIO)
          const dx = x - txA[i], dy = y - tyA[i], dist = Math.sqrt(dx * dx + dy * dy);
          sd = dist;
          if (dist > 1e-4) { gx = dx / dist; gy = dy / dist; } else { gx = 0; gy = 1; }
          comp = isDetail ? 1 : (S.mode === 0 ? 4 : 0);
        } else {
          this._eval(x, y, ph === 3);
          sd = tSd; gx = tGx; gy = tGy; comp = tComp;
        }

        // coloración por figura / borde local del vídeo
        if (isDetail && local) {
          let lu = (x - (S.bx - S.bhw)) / (2 * S.bhw), lv = ((S.by + S.bhh) - y) / (2 * S.bhh);
          lu = lu < 0 ? 0 : lu > 0.999 ? 0.999 : lu; lv = lv < 0 ? 0 : lv > 0.999 ? 0.999 : lv;
          const li = ((lv * LH | 0) * LW + (lu * LW | 0)) * 3;
          ccr[i] = local[li]; ccg[i] = local[li + 1]; ccb[i] = local[li + 2];
        } else if (comp >= 0 && sd < 1e8) {
          if (comp === 0 || comp === 2) { arcColor(S, x, y); ccr[i] = oR; ccg[i] = oG; ccb[i] = oB; }
          else if (comp === 1) {
            // en RING_PREVIEW conserva el color del segmento; al expandirse a DETAIL_RECT acopla el color local del vídeo
            arcColor(S, S.bx, S.by);
            let rr = oR, gg = oG, bb = oB;
            if (local && S.boxD > 0.01) {
              let lu = (x - (S.bx - S.bhw)) / (2 * S.bhw), lv = ((S.by + S.bhh) - y) / (2 * S.bhh);
              lu = lu < 0 ? 0 : lu > 0.999 ? 0.999 : lu; lv = lv < 0 ? 0 : lv > 0.999 ? 0.999 : lv;
              const li = ((lv * LH | 0) * LW + (lu * LW | 0)) * 3;
              const bd = S.boxD;
              rr += (local[li] - rr) * bd; gg += (local[li + 1] - gg) * bd; bb += (local[li + 2] - bb) * bd;
            }
            ccr[i] = rr; ccg[i] = gg; ccb[i] = bb;
          } else if (comp === 3) { ccr[i] = 0.9; ccg[i] = 0.9; ccb[i] = 0.92; }
          else if (comp === 4) { ccr[i] = ccg[i] = ccb[i] = 1; }
        }

        if (ph === 0) {
          ax += rx * C.spacing; ay += ry * C.spacing;
          if (isDetail) {
            // anclaje elástico al slot perimetral + ondas contrapuestas (permite abombamiento interno suave)
            const dx = txA[i] - x, dy = tyA[i] - y;
            ax += dx * 170; ay += dy * 170;
          } else {
            if (sd > 0 && sd < 1e8) { const pull = Math.min(sd + 1, 700); ax -= gx * C.holdStiffness * pull; ay -= gy * C.holdStiffness * pull; }
            if (sd > C.relapseDistance && sd < 1e8) { ph = 3; heat[i] = 1; arrived[i] = 0; settle[i] = C.settleTime; }
          }
          vx += ax * dt; vy += ay * dt; vx *= rest; vy *= rest;
        } else if (sd >= 1e8) {
          vx *= rest; vy *= rest;
        } else {                                          // FASE 2 — regeneración simbiótica violenta con freno magnético al 20 %
          const e = hasT[i] ? sd : (sd + inset);
          ax += rx * C.spacing * 0.35; ay += ry * C.spacing * 0.35;
          let K = Kret, c = cRet;
          if (arrived[i]) { K = Kset; c = cSet; }
          else if (Math.abs(e) < arrR) {
            const vn = vx * gx + vy * gy;
            vx -= gx * vn * (1 - C.magneticBrake); vy -= gy * vn * (1 - C.magneticBrake);
            arrived[i] = 1; K = Kset; c = cSet;
          }
          const an = -K * (e > 700 ? 700 : e < -700 ? -700 : e);
          vx += (ax + gx * an) * dt; vy += (ay + gy * an) * dt;
          let vn = vx * gx + vy * gy;
          const ttx = vx - vn * gx, tty = vy - vn * gy;
          vn *= Math.exp(-c * dt);
          const lk = arrived[i] ? 1 : latK;
          vx = ttx * lk + vn * gx; vy = tty * lk + vn * gy;
          if (arrived[i]) { settle[i] -= dt; if (settle[i] <= 0) { ph = 0; if (!isDetail) hasT[i] = 0; } }
        }
      }

      const sp2 = vx * vx + vy * vy;
      if (sp2 > vmax2) { const s = C.maxSpeed / Math.sqrt(sp2); vx *= s; vy *= s; }
      x += vx * dt; y += vy * dt;
      // contención estricta en el viewport (clamping duro)
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
    const px = this.px, py = this.py, emerge = this.emerge;
    for (let i = 0; i < n; i++) {
      const gx = (px[i] + hW) / cs, gy = (py[i] + hH) / cs, cx = Math.floor(gx), cy = Math.floor(gy);
      let sum = 0, q = 0;
      for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++, q++) {
        const dx = gx - (cx + ox + 0.5), dy = gy - (cy + oy + 0.5);
        const w = Math.exp(-(dx * dx + dy * dy) * inv2s); w9[q] = w; sum += w;
      }
      const inv = emerge[i] / sum, e = this.en[i], r = this.cr[i], g = this.cg[i], b = this.cb[i];
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
    const bandW = Math.max(1, 2 * S.brb);
    for (let gi = 0; gi < size; gi++) {
      const m = Dm[gi], o = gi * 4;
      if (m < 0.004) { out[o + 3] = 0; continue; }
      const inv = 1 / m;
      let E = De[gi] * inv;
      let L = m * massScale;
      const hs = ihash(gi, flick);
      const amp = 0.2 + 0.6 * (1 - Math.min(1, L));
      L *= 1 - amp * (1 - hs) * 0.6;
      if (boxOn) {                                        // degradado radial exterior + crestas de ondas contrapuestas
        const wx = ((gi % gw) + 0.5) * cs - hW - S.bx, wy = (((gi / gw) | 0) + 0.5) * cs - hH - S.by;
        const qx = Math.abs(wx) - S.bhw + S.bcr, qy = Math.abs(wy) - S.bhh + S.bcr;
        const mx = qx > 0 ? qx : 0, my = qy > 0 ? qy : 0;
        const sd0 = Math.sqrt(mx * mx + my * my) + Math.min(Math.max(qx, qy), 0) - S.bcr;
        evalRectWaves(roundRectU(wx, wy, S.bhw, S.bhh, S.bcr, S.boff), t);
        let tt = (sd0 - (S.boff - S.brb)) / (bandW + wCol * 5 * S.boxD);
        tt = tt < 0 ? 0 : tt > 1 ? 1 : tt;
        const p = (1.35 + (0.18 - 1.35) * tt) * (0.90 + 0.28 * wSum + 0.68 * wCol);
        L *= 1 + (p - 1) * S.boxD;
        E = Math.min(1, E + (wCol * 0.42 + wSum * 0.06) * S.boxD);
      }
      L *= 1 + 0.5 * E;
      let f = (L - 0.05) / 1.5; f = f < 0 ? 0 : f > 1 ? 1 : f;
      let gl = Math.pow(f, 0.85) * 8.99 + E * 1.5; if (gl > 8.99) gl = 8.99;
      let al = (L - 0.03) / 0.19; al = al < 0 ? 0 : al > 1 ? 1 : al; al = al * al * (3 - 2 * al);
      const white = Math.min(1, E * 1.35);
      out[o] = Dr[gi] * inv + (1 - Dr[gi] * inv) * white;
      out[o + 1] = Dg[gi] * inv + (1 - Dg[gi] * inv) * white;
      out[o + 2] = Db[gi] * inv + (1 - Db[gi] * inv) * white;
      out[o + 3] = Math.floor(gl) + al * 0.99;
    }
    this.gridTex.needsUpdate = true;
  }
}
