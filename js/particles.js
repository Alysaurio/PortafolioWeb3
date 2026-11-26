// particles.js — motor de partículas ASCII sobre grilla fija (splatting):
// • Física en dos fases (humo inercial → retorno violento), regeneración acelerada de huecos, plegado bilateral ALYSAURIO → Aro
// • DETAIL_RECT con asentamiento sobreamortiguado (sin rebote), ondas contrapuestas, interacción unidireccional y barrera SDF estricta
// • Agujero negro gravitacional en HERO_TEXT (masa progresiva, disco de acreción, absorción del fondo/textos y explosión restauradora)
import * as THREE from 'three';
import { GRID_FS, QUAD_VS } from './shaders.js';

/* ======================= AJUSTES FÍSICOS CENTRALIZADOS ======================= */
export const PHYSICS_CONFIG = {
  charset: ['.', ':', ';', '=', '+', 'x', '#', '%', '@'],   // rampa Técnica (baja → alta densidad)
  cellSize: 7,                       // px de la grilla ASCII fija (6–7)
  particleCount: { low: 2600, mid: 2900, high: 3200 },   // pool fijo estrictamente conservado
  pushForce: 1.00,                   // impulso del cursor en estado base
  previewInnerPushScale: 0.18,       // empuje suave del círculo del vídeo del «arito»
  magneticBrake: 0.20,               // 20 % — leve rebote elástico en el Aro y Hero
  cursorRadius: 85,                  // px, radio base restaurado (sin «arito» activo)
  xsphCohesion: 0.30,                // arrastre de vecinas (XSPH) en Fase 1
  dispersionDrag: 0.96,              // fricción viscosa por frame@60fps en Fase 1
  apexDelayMs: 220,                  // pausa en el ápice antes de detonar Fase 2
  returnAcceleration: 72,            // rigidez (1/s²) de Fase 2 en Aro / Hero
  returnDamping: 0.12,
  lateralDamping: 11,
  settleStiffness: 1000, settleDamping: 0.5, settleTime: 0.32,
  // asentamiento crítico / sobreamortiguado exclusivo de DETAIL_RECT (sin rebotes ni oscilación)
  detailReturnK: 86,
  detailArrivalBrake: 0.02,          // frena en seco la velocidad entrante al encajar
  detailSettleK: 340, detailSettleDamping: 1.28, detailHoldK: 170, detailHoldDamping: 29,
  arrivalRadius: 30, inset: 6,
  holdStiffness: 450, relapseDistance: 26,
  spacing: 1100, spacingScale: 1.15,
  apexSpeed: 110, smokeMax: 1.7, turbulence: 140,
  burstTime: 0.42,                   // s expansión pantalla completa (Aro → Hero)
  foldDuration: 0.40,                // s plegado bilateral ALYSAURIO → halo anular
  // regeneración progresiva de huecos (tasa lenta → aceleración cuadrática/cúbica)
  gapRegenBaseRate: 6, gapRegenAccel2: 42, gapRegenAccel3: 75,
  gapHaloMin: 24, gapHaloMax: 55,
  // interacción unidireccional en DETAIL_RECT (solo desde el interior y salida rápida)
  rectPushRadius: 78, rectInnerBulge: 2600, rectExitImpulse: 0.65,
  // agujero negro gravitacional en HERO_TEXT
  bhGravityBase: 2.2e7,              // fuerza gravitacional base (escala con mass = 1 + ratio^1.35 * 14)
  bhSoftening: 42,                   // px, suavizado de la ley inversa cuadrática
  bhInitRadius: 240,                 // px, alcance inicial localizado
  bhDetachThreshold: 120,            // px/s², umbral para desprender letras lejanas
  bhEhMin: 12, bhEhMax: 50,          // px, radio del horizonte de eventos (#000000)
  bhClimaxRatio: 0.78,               // umbral de captura para devorar fondo + textos HTML
  bhExplodeTime: 0.19,               // s de expansión explosiva antes de la reconstrucción violenta
  maxSpeed: 4200, edgeMargin: 28, edgeForce: 3500,
  kernelSigma: 0.75, fill: 1.0,
  enableHoldAttraction: false,       // en el Aro el clic mantenido sigue desactivado (exclusivo de HERO_TEXT)
};
const C = PHYSICS_CONFIG;
const HC = 16;
const TC = 4;
const ROPE_N = 96;
const LW = 24, LH = 14;
const RING_BUCKETS = 36, ARITO_BUCKETS = 24, TOTAL_BUCKETS = RING_BUCKETS + ARITO_BUCKETS;
const MAX_EXTRA = 1300;              // pool temporal para fondo ASCII + textos HTML absorbidos en HERO_TEXT
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

/* ---------- Barrera SDF estricta del rectángulo redondeado: proyecta afuera si sd < 0 ---------- */
let pPushX = 0, pPushY = 0, pNx = 0, pNy = 0;
function clampOutsideRoundBox(x, y, bx, by, hw, hh, cr) {
  const wx = x - bx, wy = y - by;
  const ax = Math.abs(wx), ay = Math.abs(wy);
  const sx = Math.max(0, hw - cr), sy = Math.max(0, hh - cr);
  const qx = ax - sx, qy = ay - sy;
  if (qx > 0 && qy > 0) {
    const len = Math.sqrt(qx * qx + qy * qy);
    if (len >= cr) return false;
    const inv = len > 1e-4 ? 1 / len : 0;
    const nx = (wx >= 0 ? 1 : -1) * (len > 1e-4 ? qx * inv : 0.7071);
    const ny = (wy >= 0 ? 1 : -1) * (len > 1e-4 ? qy * inv : 0.7071);
    const push = cr - len + 0.5;
    pNx = nx; pNy = ny; pPushX = x + nx * push; pPushY = y + ny * push;
    return true;
  }
  const dxW = hw - ax, dyW = hh - ay;
  if (dxW <= 0 || dyW <= 0) return false;
  if (dxW < dyW) {
    pNx = wx >= 0 ? 1 : -1; pNy = 0; pPushX = bx + pNx * (hw + 0.5); pPushY = y;
  } else {
    pNx = 0; pNy = wy >= 0 ? 1 : -1; pPushX = x; pPushY = by + pNy * (hh + 0.5);
  }
  return true;
}

/* ---------- Ondas simbióticas contrapuestas sobre el perímetro de DETAIL_RECT ---------- */
let wSum = 0, wCol = 0;
function wrapU(a, b) { let d = (a - b) % 1; if (d < -0.5) d += 1; else if (d > 0.5) d -= 1; return d; }
function evalRectWaves(u, t) {
  const d0 = wrapU(u, (t * 0.137) % 1) / 0.056;
  const d1 = wrapU(u, (1 - (t * 0.173) % 1) % 1) / 0.048;
  const d2 = wrapU(u, (0.41 + t * 0.089) % 1) / 0.064;
  const w0 = 0.56 * Math.exp(-0.5 * d0 * d0);
  const w1 = 0.54 * Math.exp(-0.5 * d1 * d1);
  const w2 = 0.42 * Math.exp(-0.5 * d2 * d2);
  const fwd = w0 + w2, bwd = w1;
  wSum = fwd + bwd;
  wCol = Math.min(1.4, fwd * bwd * 2.9);
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
    // 0 reposo · 1 humo · 2 ápice · 3 regeneración violenta · 4 expansión pantalla · 5 plegado Hero→Aro · 6 explosión BH
    this.phase = new Uint8Array(n);
    this.timer = new Float32Array(n); this.t1 = new Float32Array(n); this.settle = new Float32Array(n);
    this.arrived = new Uint8Array(n); this.heat = new Float32Array(n); this.rnd = new Float32Array(n);
    this.emerge = new Float32Array(n).fill(1);
    this.bhPulled = new Uint8Array(n);       // partículas de ALYSAURIO ya desprendidas por el agujero negro
    this.hasTarget = new Uint8Array(n);
    this.tx = new Float32Array(n); this.ty = new Float32Array(n);
    this.rectU = new Float32Array(n); this.rectOff = new Float32Array(n);
    this.bdx = new Float32Array(n); this.bdy = new Float32Array(n);
    this.fx0 = new Float32Array(n); this.fy0 = new Float32Array(n);
    this.fx1 = new Float32Array(n); this.fy1 = new Float32Array(n);
    this.fx2 = new Float32Array(n); this.fy2 = new Float32Array(n);
    this.foldDur = new Float32Array(n);

    this.cr = new Float32Array(n).fill(1); this.cg = new Float32Array(n).fill(1); this.cb = new Float32Array(n).fill(1);
    this.en = new Float32Array(n);
    this.hItems = new Int32Array(n); this.hCell = new Int32Array(n);
    this.bHead = new Int32Array(TOTAL_BUCKETS); this.bNext = new Int32Array(n);
    this.bCount = new Int32Array(TOTAL_BUCKETS); this.bIdeal = new Float32Array(TOTAL_BUCKETS);
    this.bActive = new Uint8Array(TOTAL_BUCKETS);
    this.gapAge = new Float32Array(TOTAL_BUCKETS); this.spawnAcc = new Float32Array(TOTAL_BUCKETS);

    // pool temporal ligero para réplicas absorbidas del fondo ASCII y los textos HTML en el clímax del agujero negro
    this.extraCount = 0;
    this.exX = new Float32Array(MAX_EXTRA); this.exY = new Float32Array(MAX_EXTRA);
    this.exOx = new Float32Array(MAX_EXTRA); this.exOy = new Float32Array(MAX_EXTRA);
    this.exVx = new Float32Array(MAX_EXTRA); this.exVy = new Float32Array(MAX_EXTRA);
    this.exR = new Float32Array(MAX_EXTRA); this.exG = new Float32Array(MAX_EXTRA); this.exB = new Float32Array(MAX_EXTRA);
    this.exW = new Float32Array(MAX_EXTRA); this.exE = new Float32Array(MAX_EXTRA);
    this.exRnd = new Float32Array(MAX_EXTRA);
    for (let i = 0; i < MAX_EXTRA; i++) this.exRnd[i] = Math.random();

    // estado interno del agujero negro
    this.bh = { active: false, releasing: false, x: 0, y: 0, time: 0, relTime: 0, ratio: 0, ratioSm: 0, ehR: 0, ehVis: 0, rim: 0 };

    for (let i = 0; i < n; i++) { this.rnd[i] = Math.random(); this.rectU[i] = i / n; this.rectOff[i] = (Math.random() - 0.5) * 1.5; }

    this.material = new THREE.ShaderMaterial({
      vertexShader: QUAD_VS, fragmentShader: GRID_FS, transparent: true, depthTest: false, depthWrite: false,
      uniforms: {
        tGrid: { value: null }, tAtlas: { value: atlas }, uGrid: { value: new THREE.Vector2(1, 1) },
        uCell: { value: C.cellSize }, uDpr: { value: 1 },
        uBhPos: { value: new THREE.Vector2() }, uBhR: { value: 0 }, uBhRim: { value: 0 },
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
      N, mode: 1, R: 300, rb: 17, time: 0,
      arcCount: 0,
      aMid: new Float32Array(maxArcs), aHalf: new Float32Array(maxArcs),
      aCosM: new Float32Array(maxArcs), aSinM: new Float32Array(maxArcs),
      aCosH: new Float32Array(maxArcs), aSinH: new Float32Array(maxArcs),
      colors: Array.from({ length: N }, () => [1, 1, 1]),
      boxOn: false, bx: 0, by: 0, bhw: 0, bhh: 0, bcr: 0, brb: 9, boff: 0, boxD: 0, vidR: 0, local: null, isDetail: false,
      curInsideRect: false, curWasInsideRect: false,
      pusher: null,
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

  _stratified() {
    const n = this.n, W = this.W, H = this.H;
    const cols = Math.ceil(Math.sqrt(n * W / H)), rows = Math.ceil(n / cols);
    const pts = [];
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) pts.push([((c + Math.random()) / cols - 0.5) * W, ((r + Math.random()) / rows - 0.5) * H]);
    for (let i = pts.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [pts[i], pts[j]] = [pts[j], pts[i]]; }
    return pts;
  }

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

  scatter(toHero = true) {
    const pts = this._stratified();
    for (let i = 0; i < this.n; i++) {
      this.px[i] = pts[i][0]; this.py[i] = pts[i][1]; this.vx[i] = this.vy[i] = 0;
      this.phase[i] = 2; this.timer[i] = 0.35 + this.rnd[i] * 0.48; this.heat[i] = 0; this.emerge[i] = 1;
    }
    if (toHero && this.textSamplesX.length > 0) this._assignTextTargets();
    else this.hasTarget.fill(0);
  }

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

  foldHeroToRing(R, rb) {
    const halfW = Math.max(80, this.textHalfW);
    const n = this.n;
    for (let i = 0; i < n; i++) {
      const x0 = this.px[i], y0 = this.py[i];
      const u = Math.max(-1, Math.min(1, x0 / halfW));
      const ang = HALF_PI - u * Math.PI + (this.rnd[i] - 0.5) * 0.16;
      const ca = Math.cos(ang), sa = Math.sin(ang);
      const rFinal = R + (Math.random() - 0.5) * 1.65 * rb;
      this.tx[i] = ca * rFinal; this.ty[i] = sa * rFinal; this.hasTarget[i] = 1;
      const rHalo = R + (this.rnd[i] - 0.5) * (rb * 4.8) + (Math.random() - 0.5) * 28;
      this.fx0[i] = x0; this.fy0[i] = y0;
      this.fx2[i] = ca * rHalo; this.fy2[i] = sa * rHalo;
      const ctrlAng = HALF_PI - u * Math.PI * 0.52;
      const ctrlR = R * (1.15 + 0.10 * Math.abs(u)) + (this.rnd[i] - 0.5) * 28;
      this.fx1[i] = Math.cos(ctrlAng) * ctrlR; this.fy1[i] = Math.sin(ctrlAng) * ctrlR;
      this.phase[i] = 5; this.timer[i] = 0;
      this.foldDur[i] = C.foldDuration * (0.88 + this.rnd[i] * 0.24);
      this.arrived[i] = 0; this.emerge[i] = 1;
    }
    this.gapAge.fill(0); this.spawnAcc.fill(0);
  }

  distributeRect(box, off, brb) {
    const n = this.n, bx = box.x, by = box.y;
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
      this.arrived[i] = 0; this.settle[i] = 0.45;
      this.heat[i] = 0.65; this.emerge[i] = 1;
    }
    this.gapAge.fill(0); this.spawnAcc.fill(0);
  }

  clearExplicitTargets() { this.hasTarget.fill(0); }

  /* ==================== AGUJERO NEGRO EN HERO_TEXT ==================== */
  startBlackHole(x, y) {
    const bh = this.bh;
    bh.active = true; bh.releasing = false; bh.x = x; bh.y = y;
    bh.time = 0; bh.relTime = 0; bh.ratio = 0; bh.ratioSm = 0;
    bh.ehR = C.bhEhMin; bh.ehVis = 4; bh.rim = 0.55;
    this.bhPulled.fill(0);
    this.extraCount = 0;
  }

  /** Añade partículas temporales (réplicas del fondo ASCII y textos HTML) para absorberlas sin cortes en el clímax. */
  addExtraParticles(list) {
    let k = this.extraCount;
    for (let i = 0; i < list.length && k < MAX_EXTRA; i++, k++) {
      const p = list[i];
      this.exX[k] = this.exOx[k] = p.x;
      this.exY[k] = this.exOy[k] = p.y;
      this.exVx[k] = 0; this.exVy[k] = 0;
      this.exR[k] = p.r; this.exG[k] = p.g; this.exB[k] = p.b;
      this.exW[k] = p.w; this.exE[k] = 0;
    }
    this.extraCount = k;
  }

  clearExtraParticles() { this.extraCount = 0; }

  /** Suelta el clic: explosión centrífuga violenta + retorno reconstruyendo 100 % de ALYSAURIO y réplicas. */
  releaseBlackHole() {
    const bh = this.bh;
    if (!bh.active) return;
    bh.active = false; bh.releasing = true; bh.relTime = 0;
    const bx = bh.x, by = bh.y, n = this.n;
    const power = 1100 + 1350 * Math.max(0.25, bh.ratioSm);
    this._assignTextTargets();
    for (let i = 0; i < n; i++) {
      const dx = this.px[i] - bx, dy = this.py[i] - by;
      const d = Math.hypot(dx, dy);
      if (this.bhPulled[i] || d < 280) {
        const ang = d > 1 ? Math.atan2(dy, dx) : this.rnd[i] * TWO_PI;
        const ca = Math.cos(ang), sa = Math.sin(ang);
        const sp = power * (0.65 + 0.65 * this.rnd[i]) * (d < 160 ? 1.15 : 0.75);
        // impulso radial centrífugo + leve giro residual
        this.vx[i] = ca * sp - sa * sp * 0.18;
        this.vy[i] = sa * sp + ca * sp * 0.18;
        this.phase[i] = 6;
        this.timer[i] = C.bhExplodeTime * (0.85 + 0.3 * this.rnd[i]);
        this.arrived[i] = 0; this.heat[i] = 1.0;
      }
      this.bhPulled[i] = 0;
    }
    for (let k = 0; k < this.extraCount; k++) {
      const dx = this.exX[k] - bx, dy = this.exY[k] - by, d = Math.hypot(dx, dy);
      const ang = d > 1 ? Math.atan2(dy, dx) : this.exRnd[k] * TWO_PI;
      const sp = power * (0.75 + 0.65 * this.exRnd[k]);
      this.exVx[k] = Math.cos(ang) * sp; this.exVy[k] = Math.sin(ang) * sp;
      this.exE[k] = 0.85;
    }
  }

  getBlackHoleState() {
    return { active: this.bh.active, releasing: this.bh.releasing, ratio: this.bh.ratioSm, relTime: this.bh.relTime };
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

  setTargets(t) {
    const S = this.S;
    S.mode = t.mode; S.R = t.R; S.rb = t.rb;
    S.ringActive = !!t.ringActive;
    S.isDetail = !!t.isDetail;
    S.curInsideRect = !!t.curInsideRect;
    S.curWasInsideRect = !!t.curWasInsideRect;
    S.pusher = t.pusher || null;
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
      S.bcr = t.box.cr; S.brb = t.box.rb; S.boff = t.box.off; S.boxD = t.box.d; S.vidR = t.box.vidR || 0; S.local = t.box.local;
    } else { S.boxOn = false; S.vidR = 0; }
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

  _rebalanceGaps(dt) {
    const S = this.S;
    if (!S.ringActive || S.mode === 0 || S.isDetail || S.boxD > 0.08) { this.gapAge.fill(0); this.spawnAcc.fill(0); return; }

    const bActive = this.bActive, bIdeal = this.bIdeal, bCount = this.bCount, bHead = this.bHead, bNext = this.bNext;
    bActive.fill(0); bIdeal.fill(0); bCount.fill(0); bHead.fill(-1);

    const R = S.R, rb = S.rb, ac = S.arcCount;
    const aritoOn = S.boxOn && S.boxD < 0.05 && S.vidR > 18;
    const bx = S.bx, by = S.by, rp = S.vidR, brb = S.brb;

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

    const px = this.px, py = this.py, phase = this.phase;
    for (let i = 0; i < n; i++) {
      const ph = phase[i];
      if (ph !== 0 && ph !== 3) continue;
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
        if (ph === 0) { bNext[i] = bHead[b]; bHead[b] = i; }
      }
    }

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
            const rr = rp + brb * (0.35 + Math.random() * 0.85);
            tx = bx + nx * rr; ty = by + ny * rr;
            const dist = hMin + Math.random() * hSpan;
            const tang = (Math.random() - 0.5) * 14;
            px[i] = Math.max(-hW + 4, Math.min(hW - 4, tx + nx * dist - ny * tang));
            py[i] = Math.max(-hH + 4, Math.min(hH - 4, ty + ny * dist + nx * tang));
            arcColor(S, bx, by); this.cr[i] = oR; this.cg[i] = oG; this.cb[i] = oB;
          }

          this.vx[i] = 0; this.vy[i] = 0;
          this.tx[i] = tx; this.ty[i] = ty; this.hasTarget[i] = 1;
          this.phase[i] = 3; this.arrived[i] = 0; this.settle[i] = C.settleTime;
          this.heat[i] = 0.72; this.emerge[i] = 0.16;
        }
      } else if (ratio >= 0.94) {
        this.gapAge[b] = 0; this.spawnAcc[b] = 0;
      }
    }
  }

  /** Actualiza la física gravitacional y disco de acreción del agujero negro en HERO_TEXT. */
  _updateBlackHole(dt, cur) {
    const bh = this.bh, n = this.n, hW = this.W * 0.5, hH = this.H * 0.5;
    const px = this.px, py = this.py, vxA = this.vx, vyA = this.vy;
    const pulled = this.bhPulled, rnd = this.rnd;

    if (bh.active) {
      bh.time += dt;
      if (cur.valid) {
        const k = 1 - Math.exp(-14 * dt);
        bh.x += (cur.x - bh.x) * k; bh.y += (cur.y - bh.y) * k;
      }
      // cuenta partículas atrapadas cerca de la singularidad → masa progresiva
      const capR = Math.max(115, bh.ehR * 3.1), capR2 = capR * capR;
      let captured = 0;
      for (let i = 0; i < n; i++) {
        const dx = bh.x - px[i], dy = bh.y - py[i];
        if (dx * dx + dy * dy < capR2) captured++;
      }
      bh.ratio = captured / n;
      bh.ratioSm += (bh.ratio - bh.ratioSm) * (1 - Math.exp(-7 * dt));

      const mass = 1 + Math.pow(bh.ratioSm, 1.35) * 14;
      bh.ehR = C.bhEhMin + Math.pow(bh.ratioSm, 0.85) * (C.bhEhMax - C.bhEhMin);
      bh.ehVis += (bh.ehR - bh.ehVis) * (1 - Math.exp(-12 * dt));
      bh.rim = 0.48 + 0.52 * Math.min(1, bh.ratioSm * 1.4);

      const diag = Math.hypot(this.W, this.H);
      // alcance inicial localizado que crece progresivamente con la masa acumulada hasta abarcar toda la pantalla
      const rInf = C.bhInitRadius + Math.pow(bh.ratioSm, 0.65) * diag * 0.95 + Math.min(280, bh.time * 65);
      const soft2 = C.bhSoftening * C.bhSoftening;
      const gConst = C.bhGravityBase * mass;
      const orbActive = bh.ratioSm >= 0.15;
      const orbBand = 16 + bh.ratioSm * 26;
      const ehMin = bh.ehVis + 1.5;

      for (let i = 0; i < n; i++) {
        let x = px[i], y = py[i], vx = vxA[i], vy = vyA[i];
        const dx = bh.x - x, dy = bh.y - y;
        const d2 = dx * dx + dy * dy, d = Math.sqrt(d2) + 1e-4;
        const att = d < rInf ? Math.pow(1 - d / rInf, 1.45) : 0;
        const gAcc = (gConst / (d2 + soft2)) * att;

        if (!pulled[i]) {
          if (gAcc > C.bhDetachThreshold || d < ehMin + 34) {
            pulled[i] = 1; this.phase[i] = 1; this.hasTarget[i] = 0;
          } else {
            // letras lejanas permanecen tranquilas en su lugar
            vx *= Math.exp(-12 * dt); vy *= Math.exp(-12 * dt);
            vxA[i] = vx; vyA[i] = vy;
            this.cr[i] = this.cg[i] = this.cb[i] = 1;
            this.en[i] = Math.max(0, this.en[i] - dt * 3);
            continue;
          }
        }

        const nx = dx / d, ny = dy / d;            // dirección radial hacia la singularidad
        const tx = -ny, ty = nx;                  // tangente orbital antihoraria
        const rOrb = ehMin + 4 + rnd[i] * orbBand;
        let ax = nx * Math.min(gAcc, 6500), ay = ny * Math.min(gAcc, 6500);

        // disco de acreción: al acercarse al horizonte adquiere velocidad tangencial orbital en vez de colapsar al centro
        const swirlR = ehMin + orbBand * 2.4;
        if (d < swirlR) {
          const w = 1 - d / swirlR;
          const vOrb = (360 + 540 * (orbActive ? 0.5 + 0.5 * bh.ratioSm : 0.35)) * (0.85 + 0.3 * rnd[i]);
          const vt = vx * tx + vy * ty;
          ax += tx * (vOrb - vt) * (4.5 + 6 * w);
          ay += ty * (vOrb - vt) * (4.5 + 6 * w);
          // muelle radial hacia la banda de acreción
          const radialErr = d - rOrb;
          ax += nx * radialErr * 34; ay += ny * radialErr * 34;
          // amortigua velocidad radial para estabilizar la órbita
          const vr = vx * nx + vy * ny;
          ax -= nx * vr * 5.2; ay -= ny * vr * 5.2;
        } else {
          // leve componente espiral al caer desde lejos
          ax += tx * Math.min(gAcc, 2200) * 0.24;
          ay += ty * Math.min(gAcc, 2200) * 0.24;
        }

        vx = (vx + ax * dt) * Math.exp(-0.9 * dt);
        vy = (vy + ay * dt) * Math.exp(-0.9 * dt);
        const sp2 = vx * vx + vy * vy;
        if (sp2 > 6.5e6) { const s = 2550 / Math.sqrt(sp2); vx *= s; vy *= s; }
        x += vx * dt; y += vy * dt;

        // núcleo hueco estricto: ninguna partícula ocupa el interior negro del horizonte de eventos
        const ox = x - bh.x, oy = y - bh.y, od = Math.hypot(ox, oy);
        if (od < ehMin) {
          const onx = od > 1e-4 ? ox / od : Math.cos(rnd[i] * TWO_PI);
          const ony = od > 1e-4 ? oy / od : Math.sin(rnd[i] * TWO_PI);
          x = bh.x + onx * ehMin; y = bh.y + ony * ehMin;
          const vr = vx * onx + vy * ony;
          if (vr < 0) { vx -= onx * vr; vy -= ony * vr; }
        }
        x = Math.max(-hW + 1, Math.min(hW - 1, x)); y = Math.max(-hH + 1, Math.min(hH - 1, y));
        px[i] = x; py[i] = y; vxA[i] = vx; vyA[i] = vy;
        this.cr[i] = this.cg[i] = this.cb[i] = 1;
        this.en[i] = d < swirlR ? Math.min(1, 0.55 + 0.45 * (1 - d / swirlR)) : Math.min(1, Math.sqrt(sp2) / 1800);
      }

      // física gravitacional para las réplicas temporales (fondo ASCII + textos HTML)
      for (let k = 0; k < this.extraCount; k++) {
        let x = this.exX[k], y = this.exY[k], vx = this.exVx[k], vy = this.exVy[k];
        const dx = bh.x - x, dy = bh.y - y, d2 = dx * dx + dy * dy, d = Math.sqrt(d2) + 1e-4;
        const nx = dx / d, ny = dy / d, tx = -ny, ty = nx;
        const gAcc = Math.min(6800, (gConst * 1.15) / (d2 + soft2) + 750);
        let ax = nx * gAcc + tx * gAcc * 0.28, ay = ny * gAcc + ty * gAcc * 0.28;
        const swirlR = ehMin + orbBand * 2.2;
        if (d < swirlR) {
          const vOrb = (420 + 480 * bh.ratioSm) * (0.85 + 0.3 * this.exRnd[k]);
          const vt = vx * tx + vy * ty, vr = vx * nx + vy * ny;
          ax += tx * (vOrb - vt) * 7 - nx * vr * 5 + nx * (d - (ehMin + 6 + this.exRnd[k] * orbBand)) * 30;
          ay += ty * (vOrb - vt) * 7 - ny * vr * 5 + ny * (d - (ehMin + 6 + this.exRnd[k] * orbBand)) * 30;
        }
        vx = (vx + ax * dt) * Math.exp(-0.85 * dt); vy = (vy + ay * dt) * Math.exp(-0.85 * dt);
        x += vx * dt; y += vy * dt;
        const ox = x - bh.x, oy = y - bh.y, od = Math.hypot(ox, oy);
        if (od < ehMin) {
          const onx = od > 1e-4 ? ox / od : Math.cos(this.exRnd[k] * TWO_PI);
          const ony = od > 1e-4 ? oy / od : Math.sin(this.exRnd[k] * TWO_PI);
          x = bh.x + onx * ehMin; y = bh.y + ony * ehMin;
          const vr = vx * onx + vy * ony; if (vr < 0) { vx -= onx * vr; vy -= ony * vr; }
        }
        this.exX[k] = x; this.exY[k] = y; this.exVx[k] = vx; this.exVy[k] = vy;
        this.exE[k] = d < swirlR ? 0.75 : Math.min(0.8, Math.hypot(vx, vy) / 2000);
      }
    } else if (bh.releasing) {
      bh.relTime += dt;
      bh.ehVis = Math.max(0, bh.ehVis - dt * 620);          // colapso rápido del horizonte al soltar
      bh.rim = Math.max(0, bh.rim - dt * 5.5);
      // réplicas temporales: explotan ~0.16 s y vuelven hacia sus orígenes mientras se funden con la restauración real
      const fadeOut = Math.max(0, 1 - Math.max(0, bh.relTime - 0.14) / 0.40);
      for (let k = 0; k < this.extraCount; k++) {
        let x = this.exX[k], y = this.exY[k], vx = this.exVx[k], vy = this.exVy[k];
        if (bh.relTime < 0.16) {
          const dk = Math.pow(0.93, dt * 60);
          vx *= dk; vy *= dk; x += vx * dt; y += vy * dt;
        } else {
          const ax = (this.exOx[k] - x) * 58, ay = (this.exOy[k] - y) * 58;
          const dk = Math.exp(-11 * dt);
          vx = (vx + ax * dt) * dk; vy = (vy + ay * dt) * dk;
          x += vx * dt; y += vy * dt;
        }
        this.exX[k] = Math.max(-hW + 1, Math.min(hW - 1, x));
        this.exY[k] = Math.max(-hH + 1, Math.min(hH - 1, y));
        this.exVx[k] = vx; this.exVy[k] = vy;
        this.exE[k] *= Math.exp(-4 * dt);
      }
      this._extraAlpha = fadeOut;
      if (bh.relTime >= 0.56) {
        bh.releasing = false; bh.ehVis = 0; bh.rim = 0; this.extraCount = 0;
      }
    }

    // actualiza uniformes del horizonte de eventos en GRID_FS
    const u = this.material.uniforms;
    u.uBhPos.value.set(hW + bh.x, hH + bh.y);
    u.uBhR.value = bh.ehVis;
    u.uBhRim.value = bh.rim;
  }

  /** cur: {x,y,px,py,vx,vy,speed,valid} coords centradas (y arriba), px/s */
  update(dt, t, cur) {
    const S = this.S, W = this.W, H = this.H, n = this.n, cs = C.cellSize;
    const hW = W * 0.5, hH = H * 0.5;
    this.frame++;
    S.time = t;

    // si el agujero negro está activo en HERO_TEXT, toma el control físico completo
    if (this.bh.active) {
      this._extraAlpha = 1;
      this._updateBlackHole(dt, cur);
      const area = this._area();
      this.areaSm += (area - this.areaSm) * (1 - Math.exp(-6 * dt));
      this._splat(t, this.areaSm / (cs * cs * n) * C.fill);
      return;
    }
    if (this.bh.releasing) this._updateBlackHole(dt, cur);
    else {
      this.material.uniforms.uBhR.value = 0;
      this.material.uniforms.uBhRim.value = 0;
      this._extraAlpha = 0;
    }

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

    // --- cápsula barrida (cursor con radio ~85 px en estado base, o círculo del vídeo del «arito» cuando está visible) ---
    const P = S.pusher;
    const capOn = this.cursorEnabled && !!P;
    const ppx = P ? P.px : 0, ppy = P ? P.py : 0;
    const sx = P ? P.x - P.px : 0, sy = P ? P.y - P.py : 0, sl2 = sx * sx + sy * sy, sl = Math.sqrt(sl2);
    const cspeed = Math.min(sl / Math.max(dt, 1e-3), 6000);
    const capActive = capOn && sl > 0.6 && cspeed > 45;
    const ux = sl > 1e-4 ? sx / sl : 0, uy = sl > 1e-4 ? sy / sl : 0;
    const cr0 = P ? P.radius : C.cursorRadius, cr2 = cr0 * cr0;
    const pushMul = P ? C.pushForce * P.pushScale : C.pushForce;

    // --- interacción unidireccional en DETAIL_RECT (solo desde dentro y salida rápida) ---
    const curSx = cur.x - cur.px, curSy = cur.y - cur.py, curSl2 = curSx * curSx + curSy * curSy, curSl = Math.sqrt(curSl2);
    const curSp = Math.min(curSl / Math.max(dt, 1e-3), 6000);
    const curUx = curSl > 1e-4 ? curSx / curSl : 0, curUy = curSl > 1e-4 ? curSy / curSl : 0;
    const detailInner = S.isDetail && S.boxOn && cur.valid && S.curInsideRect && S.curWasInsideRect;
    const detailExit = S.isDetail && S.boxOn && cur.valid && !S.curInsideRect && S.curWasInsideRect && curSl > 1.5 && curSp > 130;
    const rPush2 = C.rectPushRadius * C.rectPushRadius;
    const exitR = 64, exitR2 = exitR * exitR;

    const phase = this.phase, timer = this.timer, t1 = this.t1, settle = this.settle, arrived = this.arrived;
    const heat = this.heat, rnd = this.rnd, en = this.en, ccr = this.cr, ccg = this.cg, ccb = this.cb;
    const hasT = this.hasTarget, txA = this.tx, tyA = this.ty, emerge = this.emerge;
    const dragK = Math.pow(C.dispersionDrag, dt * 60), xsphK = C.xsphCohesion * Math.min(1, dt * 60);
    const Kret = C.returnAcceleration, wRet = Math.sqrt(Kret), cRet = 2 * C.returnDamping * wRet;
    const Kset = C.settleStiffness, cSet = 2 * C.settleDamping * Math.sqrt(Kset);
    // parámetros sobreamortiguados para DETAIL_RECT (cero rebote)
    const KdetRet = C.detailReturnK, cDetRet = 2 * 0.45 * Math.sqrt(KdetRet);
    const KdetSet = C.detailSettleK, cDetSet = 2 * C.detailSettleDamping * Math.sqrt(KdetSet);
    const detRest = Math.exp(-C.detailHoldDamping * dt);
    const latK = Math.exp(-C.lateralDamping * dt), rest = Math.exp(-9 * dt);
    const h2 = h * h, NR2 = 18 * 18, vmax2 = C.maxSpeed * C.maxSpeed;
    const mg = C.edgeMargin, EF = C.edgeForce, inset = C.inset, arrR = C.arrivalRadius;
    const local = S.local, isDetail = S.isDetail && S.boxOn;
    const aritoBarrier = !isDetail && S.boxOn && S.vidR > 1;
    const pt = this._pt;

    for (let i = 0; i < n; i++) {
      let x = px[i], y = py[i], vx = vxA[i], vy = vyA[i];
      let ph = phase[i];
      if (emerge[i] < 1) emerge[i] = Math.min(1, emerge[i] + dt * 6.5);

      // 1) impulso del cursor o del círculo del «arito» (cápsula barrida)
      if (capActive) {
        const l = ((x - ppx) * sx + (y - ppy) * sy) / sl2, s = l < 0 ? 0 : l > 1 ? 1 : l;
        const dx = x - (ppx + sx * s), dy = y - (ppy + sy * s), d2 = dx * dx + dy * dy;
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
        const l = ((x - cur.px) * curSx + (y - cur.py) * curSy) / curSl2, s = l < 0 ? 0 : l > 1 ? 1 : l;
        const dx = x - (cur.px + curSx * s), dy = y - (cur.py + curSy * s), d2 = dx * dx + dy * dy;
        if (d2 < exitR2) {
          const d = Math.sqrt(d2), f = 1 - d / exitR, f2 = f * f;
          const mag = Math.min(curSp, 2800) * C.rectExitImpulse * f2;
          vx += curUx * mag + (rnd[i] - 0.5) * mag * 0.22;
          vy += curUy * mag + (Math.random() - 0.5) * mag * 0.22;
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
      if (x < -hW + mg) ax += EF * (1 - (x + hW) / mg); else if (x > hW - mg) ax -= EF * (1 - (hW - x) / mg);
      if (y < -hH + mg) ay += EF * (1 - (y + hH) / mg); else if (y > hH - mg) ay -= EF * (1 - (hH - y) / mg);

      // 3) abombamiento suave desde el interior del vídeo en DETAIL_RECT
      if (detailInner && (ph === 0 || (ph === 3 && arrived[i]))) {
        const dx = x - cur.x, dy = y - cur.y, d2 = dx * dx + dy * dy;
        if (d2 < rPush2 && d2 > 1) {
          const d = Math.sqrt(d2), f = 1 - d / C.rectPushRadius, f2 = f * f;
          const ox = x - S.bx, oy = y - S.by, ol = Math.sqrt(ox * ox + oy * oy) || 1;
          ax += (ox / ol) * C.rectInnerBulge * f2 + (dx / d) * C.rectInnerBulge * 0.45 * f2;
          ay += (oy / ol) * C.rectInnerBulge * f2 + (dy / d) * C.rectInnerBulge * 0.45 * f2;
        }
      }

      if (ph === 6) {                                     // FASE 6 — expansión explosiva tras soltar el agujero negro
        const dk = Math.pow(0.94, dt * 60);
        vx = (vx + ax * dt) * dk; vy = (vy + ay * dt) * dk;
        timer[i] -= dt;
        if (timer[i] <= 0) { ph = 3; heat[i] = 1; arrived[i] = 0; settle[i] = C.settleTime; }
      } else if (ph === 5) {                              // FASE 5 — plegado bilateral ALYSAURIO → halo anular
        timer[i] += dt;
        const s = Math.min(1, timer[i] / this.foldDur[i]);
        const e = s < 0.5 ? 2 * s * s : 1 - Math.pow(-2 * s + 2, 2) * 0.5;
        const om = 1 - e;
        const nx = om * om * this.fx0[i] + 2 * om * e * this.fx1[i] + e * e * this.fx2[i];
        const ny = om * om * this.fy0[i] + 2 * om * e * this.fy1[i] + e * e * this.fy2[i];
        vx = (nx - x) / Math.max(dt, 1e-3); vy = (ny - y) / Math.max(dt, 1e-3);
        x = nx; y = ny;
        if (s > 0.35) {
          arcColor(S, txA[i], tyA[i]);
          const ck = 1 - Math.exp(-dt * 8);
          ccr[i] += (oR - ccr[i]) * ck; ccg[i] += (oG - ccg[i]) * ck; ccb[i] += (oB - ccb[i]) * ck;
        }
        if (s >= 1) { ph = 3; hasT[i] = 0; heat[i] = 0.85; arrived[i] = 0; settle[i] = C.settleTime; }
        px[i] = x; py[i] = y; vxA[i] = vx; vyA[i] = vy; phase[i] = ph;
        en[i] = Math.min(1, 0.25 + Math.hypot(vx, vy) / 2400);
        continue;
      } else if (ph === 4) {                              // FASE 4 — expansión pantalla completa (Aro → Hero)
        const k = 1 - Math.exp(-10 * dt);
        const dx = (this.bdx[i] - x) * k, dy = (this.bdy[i] - y) * k;
        x += dx; y += dy; vx = dx / dt * 0.5; vy = dy / dt * 0.5;
        timer[i] -= dt;
        if (timer[i] <= 0) { ph = 2; timer[i] = C.apexDelayMs / 1000 * (0.75 + rnd[i] * 0.4); }
        px[i] = x; py[i] = y; vxA[i] = vx; vyA[i] = vy; phase[i] = ph;
        en[i] = Math.min(1, Math.hypot(vx, vy) / 2200) * 0.6;
        continue;
      } else if (ph === 1) {                              // FASE 1 — humo inercial (retorno = 0 %)
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
      } else {                                            // 0 reposo / 3 regeneración
        if (isDetail) {
          evalRectWaves(this.rectU[i], t);
          const waveBulge = (wSum * 4.5 + wCol * 9.5) * S.boxD;
          sampleRoundRect(this.rectU[i], S.bx, S.by, S.bhw, S.bhh, S.bcr, S.boff + waveBulge, pt);
          // garantiza que el destino radial nunca quede dentro del vídeo (ro > -0.85)
          const radOff = Math.max(-S.boff + 2, this.rectOff[i] * (S.brb + wCol * 2.5 * S.boxD));
          txA[i] = pt.x + pt.nx * radOff;
          tyA[i] = pt.y + pt.ny * radOff;
          if (ph === 3) hasT[i] = 1;
        }

        let sd, gx, gy, comp;
        if (ph === 3 && hasT[i]) {
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
            // anclaje sobreamortiguado en DETAIL_RECT: cero oscilaciones, sigue ondas y abombamiento interno suave
            ax += (txA[i] - x) * C.detailHoldK;
            ay += (tyA[i] - y) * C.detailHoldK;
            vx = (vx + ax * dt) * detRest; vy = (vy + ay * dt) * detRest;
          } else {
            if (sd > 0 && sd < 1e8) { const pull = Math.min(sd + 1, 700); ax -= gx * C.holdStiffness * pull; ay -= gy * C.holdStiffness * pull; }
            if (sd > C.relapseDistance && sd < 1e8) { ph = 3; heat[i] = 1; arrived[i] = 0; settle[i] = C.settleTime; }
            vx = (vx + ax * dt) * rest; vy = (vy + ay * dt) * rest;
          }
        } else if (sd >= 1e8) {
          vx *= rest; vy *= rest;
        } else if (isDetail) {
          // FASE 2 sobreamortiguada exclusiva para DETAIL_RECT: rápida y decidida, encaja en seco sin rebotes
          ax += rx * C.spacing * 0.25; ay += ry * C.spacing * 0.25;
          let K = KdetRet, c = cDetRet;
          if (arrived[i]) { K = KdetSet; c = cDetSet; }
          else if (sd < arrR) {
            const vn = vx * gx + vy * gy;
            vx -= gx * vn * (1 - C.detailArrivalBrake); vy -= gy * vn * (1 - C.detailArrivalBrake);
            arrived[i] = 1; K = KdetSet; c = cDetSet;
          }
          const an = -K * Math.min(sd, 700);
          vx += (ax + gx * an) * dt; vy += (ay + gy * an) * dt;
          let vn = vx * gx + vy * gy;
          const ttx = vx - vn * gx, tty = vy - vn * gy;
          vn *= Math.exp(-c * dt);
          const lk = arrived[i] ? Math.exp(-16 * dt) : latK;
          vx = ttx * lk + vn * gx; vy = tty * lk + vn * gy;
          if (arrived[i]) { settle[i] -= dt; if (settle[i] <= 0 || sd < 2.5) ph = 0; }
        } else {
          // FASE 2 simbiótica violenta con freno magnético al 20 % (Aro / Hero / Arito)
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
          if (arrived[i]) { settle[i] -= dt; if (settle[i] <= 0) { ph = 0; hasT[i] = 0; } }
        }
      }

      const sp2 = vx * vx + vy * vy;
      if (sp2 > vmax2) { const s = C.maxSpeed / Math.sqrt(sp2); vx *= s; vy *= s; }
      x += vx * dt; y += vy * dt;

      // BARRERA GEOMÉTRICA ESTRICTA (hard SDF clamp) contra invasión del interior de los vídeos
      if (isDetail) {
        if (clampOutsideRoundBox(x, y, S.bx, S.by, S.bhw, S.bhh, S.bcr)) {
          x = pPushX; y = pPushY;
          const vn = vx * pNx + vy * pNy;
          if (vn < 0) { vx -= pNx * vn; vy -= pNy * vn; }
        }
      } else if (aritoBarrier) {
        const dx = x - S.bx, dy = y - S.by, dist = Math.hypot(dx, dy);
        if (dist < S.vidR) {
          const nx = dist > 1e-4 ? dx / dist : Math.cos(rnd[i] * TWO_PI);
          const ny = dist > 1e-4 ? dy / dist : Math.sin(rnd[i] * TWO_PI);
          x = S.bx + nx * (S.vidR + 0.5); y = S.by + ny * (S.vidR + 0.5);
          const vn = vx * nx + vy * ny;
          if (vn < 0) { vx -= nx * vn; vy -= ny * vn; }
        }
      }

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

    // splat ligero de partículas temporales del agujero negro (réplicas del fondo ASCII + textos HTML)
    const exN = this.extraCount, exA = this._extraAlpha || 0;
    if (exN > 0 && exA > 0.01) {
      for (let k = 0; k < exN; k++) {
        const cx = Math.floor((this.exX[k] + hW) / cs), cy = Math.floor((this.exY[k] + hH) / cs);
        if (cx < 0 || cy < 0 || cx >= gw || cy >= gh) continue;
        const w = this.exW[k] * exA, gi = cy * gw + cx;
        Dm[gi] += w; Dr[gi] += w * this.exR[k]; Dg[gi] += w * this.exG[k]; Db[gi] += w * this.exB[k]; De[gi] += w * this.exE[k];
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
      if (boxOn) {
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
