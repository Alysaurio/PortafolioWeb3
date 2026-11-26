// particles.js — motor de partículas ASCII sobre grilla fija (splatting):
// • Física en dos fases (humo inercial → retorno violento), regeneración acelerada de huecos, plegado bilateral ALYSAURIO → Aro
// • DETAIL_RECT con asentamiento sobreamortiguado (sin rebote), ondas contrapuestas, interacción unidireccional y barrera SDF estricta
// • Agujero negro gravitacional en HERO_TEXT (masa progresiva, disco de acreción, absorción del fondo/textos y explosión restauradora)
import * as THREE from 'three';
import { GRID_CELL_SIZE, GRID_FS, QUAD_VS } from './shaders.js';
export { GRID_CELL_SIZE };

/* ======================= AJUSTES FÍSICOS CENTRALIZADOS ======================= */
export const PHYSICS_CONFIG = {
  charset: ['.', ':', ';', '=', '+', 'x', '#', '%', '@'],   // rampa Técnica (baja → alta densidad)
  cellSize: GRID_CELL_SIZE,          // fuente única compartida con BG_FS y GRID_FS (7 px CSS)
  particleCount: { low: 2600, mid: 2900, high: 3200 },   // pool fijo estrictamente conservado
  pushForce: 0.52,                   // impulso recalibrado en estado base (controlado y elegante)
  maxDispersionSpeed: 460,           // px/s, tope de velocidad en dispersión de humo (420–480 px/s)
  previewPushMultiplier: 0.40,       // multiplicador relativo con «arito» activo (efectivo ~0.21)
  dwellBaseDurationMs: 350,          // ms para conquistar y abrir el «arito» con el cursor estático
  dwellMovingSlowdown: 2.8,          // ralentización mientras el cursor se mueve jugando con el humo (~0.98 s)
  dwellSpeedRefPxPerSec: 260,        // px/s, velocidad de referencia para interpolar quieto ↔ en movimiento
  dwellRetractDurationMs: 280,       // ms de retroceso suave del contador y líneas al salir del segmento
  ringColorMode: 'vibrantAccent',    // calibración cromática del aro: 'vibrantAccent' | 'complementary'
  magneticBrake: 0.20,               // 20 % — leve rebote elástico en el Aro y Hero
  cursorRadius: 85,                  // px, radio base restaurado (sin «arito» activo)
  xsphCohesion: 0.30,                // arrastre de vecinas (XSPH)
  dispersionDrag: 0.94,              // fricción atmosférica progresiva en Fase 1 (0.935–0.945)
  smokeCurlStrength: 340,            // px/s², turbulencia curl-noise 2D tipo aro de humo
  smokeMaxSplatRadius: 2.45,         // celdas, expansión volumétrica del splatting durante dispersión (1.0 → ~2.45)
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
  // regeneración progresiva de huecos en micro-cúmulos periféricos (tasa lenta → aceleración cuadrática/cúbica)
  gapRegenBaseRate: 7, gapRegenAccel2: 46, gapRegenAccel3: 82,
  gapHaloMin: 55, gapHaloMax: 115,   // px, halo periférico exterior donde nacen los micro-cúmulos
  gapClusterMin: 8, gapClusterMax: 16,
  gapClusterRadiusMin: 10, gapClusterRadiusMax: 18,
  gapClusterStaggerMs: 65,           // ms de escalonamiento dentro de cada micro-cúmulo
  gapPreviewRateMult: 1.55,          // 1.5× aceleración de regeneración con «arito» activo
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
const MAX_EXTRA = 16000;             // pool plano O(N) para captura 1:1 del fondo ASCII + textos HTML (60 FPS)
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

let oR = 1, oG = 1, oB = 1, oW = 0;
function arcColor(S, x, y) {
  const N = S.N, col = S.colors;
  const ang = Math.atan2(y, x);
  const { k, f } = segmentAt(ang, N);
  const c = col[k % N];
  let r = c[0], g = c[1], b = c[2];
  oW = 0;

  // degradado cromático orgánico estrecho (~7° totales = ±3.5°) entre segmentos adyacentes
  if (N >= 2) {
    const segRad = TWO_PI / N;
    const gradHalf = 3.5 * Math.PI / 180;
    const d0 = f * segRad, d1 = (1 - f) * segRad;
    if (d0 < gradHalf) {
      const prev = col[(k + N - 1) % N];
      const t = 0.5 + 0.5 * (d0 / gradHalf);
      const w = t * t * (3 - 2 * t);
      r = prev[0] + (r - prev[0]) * w;
      g = prev[1] + (g - prev[1]) * w;
      b = prev[2] + (b - prev[2]) * w;
    } else if (d1 < gradHalf) {
      const next = col[(k + 1) % N];
      const t = 0.5 + 0.5 * (d1 / gradHalf);
      const w = t * t * (3 - 2 * t);
      r = next[0] + (r - next[0]) * w;
      g = next[1] + (g - next[1]) * w;
      b = next[2] + (b - next[2]) * w;
    }
  }

  // onda de conquista integrada al material ASCII: degradado móvil (~6° = ±3°) + sutil pulso luminoso en la cresta
  if (S.conqSeg >= 0 && S.conqP > 0.001) {
    const frontHalf = 3.0 * Math.PI / 180;
    const halfSpan = Math.PI / N;
    const conqHalf = halfSpan + S.conqP * (Math.PI + frontHalf - halfSpan);
    const ad = Math.abs(wrapAngle(ang - centerAngle(S.conqSeg, N)));
    let u = (conqHalf + frontHalf - ad) / (2 * frontHalf);
    u = u < 0 ? 0 : u > 1 ? 1 : u;
    const fi = S.conqP < 0.06 ? (S.conqP / 0.06) : 1;
    const cw = (u * u * (3 - 2 * u)) * (fi * fi * (3 - 2 * fi));
    const cc = col[S.conqSeg % N];
    r += (cc[0] - r) * cw;
    g += (cc[1] - g) * cw;
    b += (cc[2] - b) * cw;

    const rawP = S.conqRawP;
    if (rawP > 0.02 && rawP < 0.96) {
      const dFront = Math.abs(ad - conqHalf);
      if (dFront < frontHalf) {
        let s0 = (rawP - 0.02) / 0.12; s0 = s0 < 0 ? 0 : s0 > 1 ? 1 : s0; s0 = s0 * s0 * (3 - 2 * s0);
        let s1 = (0.96 - rawP) / 0.12; s1 = s1 < 0 ? 0 : s1 > 1 ? 1 : s1; s1 = s1 * s1 * (3 - 2 * s1);
        const cf = 1 - dFront / frontHalf;
        const crest = (cf * cf * (3 - 2 * cf)) * s0 * s1;
        const boost = 0.22 * crest;
        r += (1 - r) * boost;
        g += (1 - g) * boost;
        b += (1 - b) * boost;
        oW = 0.15 * crest;
      }
    }
  }

  oR = r; oG = g; oB = b;
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
    this.puff = new Float32Array(n);         // factor de expansión volumétrica de humo [0..1] (1.0 → ~2.45 celdas)
    this.bhPulled = new Uint8Array(n);       // partículas de ALYSAURIO ya desprendidas por el agujero negro
    this.hasTarget = new Uint8Array(n);
    this.clusterFlight = new Uint8Array(n);  // micro-cúmulo regenerativo en vuelo (cohesión XSPH + leve curvatura)
    this.clusterCurve = new Float32Array(n);
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

    // pool plano O(N) para captura 1:1 del fondo ASCII y textos HTML en el agujero negro (cero SPH, 60 FPS)
    this.extraCount = 0;
    this.exX = new Float32Array(MAX_EXTRA); this.exY = new Float32Array(MAX_EXTRA);
    this.exOx = new Float32Array(MAX_EXTRA); this.exOy = new Float32Array(MAX_EXTRA);
    this.exVx = new Float32Array(MAX_EXTRA); this.exVy = new Float32Array(MAX_EXTRA);
    this.exR0 = new Float32Array(MAX_EXTRA); this.exG0 = new Float32Array(MAX_EXTRA); this.exB0 = new Float32Array(MAX_EXTRA);
    this.exR = new Float32Array(MAX_EXTRA); this.exG = new Float32Array(MAX_EXTRA); this.exB = new Float32Array(MAX_EXTRA);
    this.exLum = new Float32Array(MAX_EXTRA); this.exE = new Float32Array(MAX_EXTRA);
    this.exRnd = new Float32Array(MAX_EXTRA);
    this.exIsBg = new Uint8Array(MAX_EXTRA);
    for (let i = 0; i < MAX_EXTRA; i++) this.exRnd[i] = Math.random();

    // estado interno del agujero negro
    this.bh = { active: false, releasing: false, x: 0, y: 0, time: 0, bgTime: 0, bgCaptured: false, relTime: 0, ratio: 0, ratioSm: 0, ehR: 0, ehVis: 0, rim: 0, warm: 0 };
    this.heroNoBounce = false;
    this.heroNoBounceTimer = 0;

    for (let i = 0; i < n; i++) { this.rnd[i] = Math.random(); this.rectU[i] = i / n; this.rectOff[i] = (Math.random() - 0.5) * 1.5; }

    this.material = new THREE.ShaderMaterial({
      vertexShader: QUAD_VS, fragmentShader: GRID_FS, transparent: true, depthTest: false, depthWrite: false,
      uniforms: {
        tGrid: { value: null }, tAtlas: { value: atlas }, uGrid: { value: new THREE.Vector2(1, 1) },
        uRes: { value: new THREE.Vector2(1, 1) }, uCell: { value: C.cellSize }, uDpr: { value: 1 },
        uBhPos: { value: new THREE.Vector2() }, uBhR: { value: 0 }, uBhRim: { value: 0 }, uBhWarm: { value: 0 },
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
      ringActive: false, charge: 0, conqSeg: -1, conqP: 0, conqRawP: 0,
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
    u.tGrid.value = this.gridTex; u.uGrid.value.set(this.gw, this.gh); u.uRes.value.set(W, H); u.uDpr.value = dpr;
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
    this.heroNoBounce = false; this.heroNoBounceTimer = 0;
    this.clusterFlight.fill(0); this.puff.fill(0);
    for (let i = 0; i < this.n; i++) {
      this.bdx[i] = pts[i][0]; this.bdy[i] = pts[i][1];
      this.phase[i] = 4; this.timer[i] = C.burstTime * (0.85 + this.rnd[i] * 0.3);
      this.arrived[i] = 0; this.emerge[i] = 1;
    }
    this.gapAge.fill(0); this.spawnAcc.fill(0);
  }

  /** Detonación explosiva desde el aro comprimido al 50 % → nube expansiva → reconstrucción limpia sin elasticidad en ALYSAURIO. */
  detonateToHero() {
    this._assignTextTargets();
    this.heroNoBounce = true; this.heroNoBounceTimer = 1.15;
    this.clusterFlight.fill(0);
    for (let i = 0; i < this.n; i++) {
      const ang = Math.atan2(this.py[i], this.px[i]) + (this.rnd[i] - 0.5) * 0.44;
      const sp = 1450 + 1750 * Math.random();
      this.vx[i] = Math.cos(ang) * sp;
      this.vy[i] = Math.sin(ang) * sp;
      this.phase[i] = 6;
      this.timer[i] = 0.16 + 0.05 * this.rnd[i];   // 160–210 ms de expansión radial
      this.arrived[i] = 0; this.heat[i] = 1.0; this.emerge[i] = 1;
    }
    this.gapAge.fill(0); this.spawnAcc.fill(0);
  }

  foldHeroToRing(R, rb) {
    this.heroNoBounce = false; this.heroNoBounceTimer = 0;
    this.clusterFlight.fill(0); this.puff.fill(0);
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
    bh.time = 0; bh.bgTime = 0; bh.bgCaptured = false; bh.relTime = 0; bh.ratio = 0; bh.ratioSm = 0;
    bh.ehR = C.bhEhMin; bh.ehVis = 4; bh.rim = 0.55; bh.warm = 0;
    this.heroNoBounce = false;
    this.bhPulled.fill(0);
    this.extraCount = 0;
  }

  /** Añade partículas temporales (isBg=true para captura 1:1 del fondo ASCII, false para textos HTML). */
  addExtraParticles(list, isBg = false) {
    let k = this.extraCount;
    for (let i = 0; i < list.length && k < MAX_EXTRA; i++, k++) {
      const p = list[i];
      this.exX[k] = this.exOx[k] = p.x;
      this.exY[k] = this.exOy[k] = p.y;
      this.exVx[k] = 0; this.exVy[k] = 0;
      this.exR0[k] = this.exR[k] = p.r;
      this.exG0[k] = this.exG[k] = p.g;
      this.exB0[k] = this.exB[k] = p.b;
      this.exLum[k] = p.lum;
      this.exE[k] = 0;
      this.exIsBg[k] = isBg ? 1 : 0;
    }
    this.extraCount = k;
    if (isBg) { this.bh.bgCaptured = true; this.bh.bgTime = 0; }
  }

  clearExtraParticles() { this.extraCount = 0; }

  /** Suelta el clic: dispersión por pantalla (estilo Aro → ALYSAURIO) + reconstrucción limpia sin elasticidad. */
  releaseBlackHole() {
    const bh = this.bh;
    if (!bh.active) return;
    bh.active = false; bh.releasing = true; bh.relTime = 0;
    this.heroNoBounce = true;
    const bx = bh.x, by = bh.y, n = this.n;
    const pts = this._stratified();
    const wideSpread = bh.ratioSm > 0.14;
    this._assignTextTargets();
    for (let i = 0; i < n; i++) {
      const dx = this.px[i] - bx, dy = this.py[i] - by;
      const d = Math.hypot(dx, dy);
      if (wideSpread || this.bhPulled[i] || d < 260) {
        this.bdx[i] = pts[i][0]; this.bdy[i] = pts[i][1];
        const ang = d > 1 ? Math.atan2(dy, dx) : this.rnd[i] * TWO_PI;
        const kick = 550 + 650 * this.rnd[i];
        this.vx[i] = Math.cos(ang) * kick; this.vy[i] = Math.sin(ang) * kick;
        this.phase[i] = 4;
        this.timer[i] = 0.28 + 0.12 * this.rnd[i];
        this.arrived[i] = 0; this.heat[i] = 0.85;
      }
      this.bhPulled[i] = 0;
    }
    const power = 750 + 950 * Math.max(0.25, bh.ratioSm);
    for (let k = 0; k < this.extraCount; k++) {
      const dx = this.exX[k] - bx, dy = this.exY[k] - by, d = Math.hypot(dx, dy);
      const ang = d > 1 ? Math.atan2(dy, dx) : this.exRnd[k] * TWO_PI;
      const sp = power * (0.65 + 0.65 * this.exRnd[k]);
      this.exVx[k] = Math.cos(ang) * sp; this.exVy[k] = Math.sin(ang) * sp;
      this.exE[k] = 0.65;
    }
  }

  getBlackHoleState() {
    return { active: this.bh.active, releasing: this.bh.releasing, ratio: this.bh.ratioSm, relTime: this.bh.relTime, x: this.bh.x, y: this.bh.y };
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
    S.charge = t.charge || 0;
    S.conqSeg = t.conqSeg !== undefined ? t.conqSeg : -1;
    S.conqP = t.conqP || 0;
    S.conqRawP = t.conqRawP || 0;
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

    const px = this.px, py = this.py, phase = this.phase, clF = this.clusterFlight;
    for (let i = 0; i < n; i++) {
      const ph = phase[i];
      const isClWait = ph === 2 && clF[i];
      if (ph !== 0 && ph !== 3 && !isClWait) continue;
      const x = ((ph === 3 || isClWait) && this.hasTarget[i]) ? this.tx[i] : px[i];
      const y = ((ph === 3 || isClWait) && this.hasTarget[i]) ? this.ty[i] : py[i];
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
    const aritoAng = aritoOn ? Math.atan2(by, bx) : 0;
    const staggerS = C.gapClusterStaggerMs / 1000;

    for (let b = 0; b < TOTAL_BUCKETS; b++) {
      if (!bActive[b] || bIdeal[b] < 2) { this.gapAge[b] = 0; this.spawnAcc[b] = 0; continue; }
      const ratio = bCount[b] / bIdeal[b];
      if (ratio < 0.80 || (this.gapAge[b] > 0 && ratio < 0.94)) {
        const isAritoBucket = b >= RING_BUCKETS;
        // prioridad ágil en el contorno del arito y su estela inmediata en el aro principal
        let nearWake = false;
        if (aritoOn && !isAritoBucket) {
          const bAng = (b + 0.5) / RING_BUCKETS * TWO_PI;
          nearWake = Math.abs(wrapAngle(bAng - aritoAng)) < 0.85;
        }
        const agile = aritoOn && (isAritoBucket || nearWake);
        // latencia inicial reducida a la mitad con «arito» activo (0.07 s vs 0.14 s)
        const latency = agile ? 0.07 : 0.14;
        const prevAge = this.gapAge[b];
        const age = (this.gapAge[b] += dt * (agile ? 1.25 : 1.0));
        if (age < latency) continue;

        const effAge = age - latency;
        const mult = agile ? (isAritoBucket ? C.gapPreviewRateMult * 1.15 : C.gapPreviewRateMult) : 1.0;
        const rate = (C.gapRegenBaseRate + C.gapRegenAccel2 * effAge * effAge + C.gapRegenAccel3 * effAge * effAge * effAge) * mult;
        // pre-carga discreta al vencer la latencia para lanzar enseguida el primer micro-cúmulo
        if (prevAge < latency) this.spawnAcc[b] += agile ? 6.5 : 3.5;
        this.spawnAcc[b] += rate * dt;

        const deficit = Math.max(0, Math.ceil(bIdeal[b] * 0.96 - bCount[b]));
        const minBatch = Math.min(deficit, C.gapClusterMin);
        if (this.spawnAcc[b] < minBatch || deficit <= 0) continue;

        // forma 1–2 micro-cúmulos compactos (8–16 partículas cada uno, 2–4 en huecos amplios a lo largo de varios frames)
        const batchTarget = Math.min(deficit, Math.min(C.gapClusterMax, Math.max(minBatch, this.spawnAcc[b] | 0)));
        this.spawnAcc[b] = Math.max(0, this.spawnAcc[b] - batchTarget);

        const numClusters = batchTarget >= 14 ? 2 : 1;
        let remaining = batchTarget;
        for (let cl = 0; cl < numClusters && remaining > 0; cl++) {
          const cSize = cl === numClusters - 1 ? remaining : Math.ceil(remaining / (numClusters - cl));
          remaining -= cSize;

          // foco compacto del micro-cúmulo en el halo exterior (55–115 px hacia afuera del tramo vacío)
          let fx, fy, fAng, fNx, fNy;
          if (!isAritoBucket) {
            fAng = (b + 0.18 + Math.random() * 0.64) / RING_BUCKETS * TWO_PI;
            fNx = Math.cos(fAng); fNy = Math.sin(fAng);
            const hDist = hMin + Math.random() * hSpan;
            fx = fNx * (R + hDist); fy = fNy * (R + hDist);
          } else {
            const ab = b - RING_BUCKETS;
            fAng = (ab + 0.18 + Math.random() * 0.64) / ARITO_BUCKETS * TWO_PI;
            fNx = Math.cos(fAng); fNy = Math.sin(fAng);
            const hDist = hMin + Math.random() * hSpan;
            fx = bx + fNx * (rp + hDist); fy = by + fNy * (rp + hDist);
          }
          const cRad = C.gapClusterRadiusMin + Math.random() * (C.gapClusterRadiusMax - C.gapClusterRadiusMin);
          const curveDir = (Math.random() < 0.5 ? 1 : -1) * (agile ? 1.25 : 1.0);

          for (let m = 0; m < cSize && bCount[b] < bIdeal[b] * 0.96; m++) {
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

            let tx, ty;
            if (!isAritoBucket) {
              const ang = (b + Math.random()) / RING_BUCKETS * TWO_PI;
              const rr = R + (Math.random() - 0.5) * 1.45 * rb;
              tx = Math.cos(ang) * rr; ty = Math.sin(ang) * rr;
              arcColor(S, tx, ty); this.cr[i] = oR; this.cg[i] = oG; this.cb[i] = oB;
            } else {
              const ab = b - RING_BUCKETS;
              const ang = (ab + Math.random()) / ARITO_BUCKETS * TWO_PI;
              const rr = rp + brb * (0.35 + Math.random() * 0.85);
              tx = bx + Math.cos(ang) * rr; ty = by + Math.sin(ang) * rr;
              arcColor(S, bx, by); this.cr[i] = oR; this.cg[i] = oG; this.cb[i] = oB;
            }

            // empaquetado dentro del radio compacto del micro-cúmulo (~10–18 px)
            const oa = Math.random() * TWO_PI, or = Math.sqrt(Math.random()) * cRad;
            px[i] = Math.max(-hW + 4, Math.min(hW - 4, fx + Math.cos(oa) * or));
            py[i] = Math.max(-hH + 4, Math.min(hH - 4, fy + Math.sin(oa) * or));

            this.vx[i] = 0; this.vy[i] = 0;
            this.tx[i] = tx; this.ty[i] = ty; this.hasTarget[i] = 1;
            this.clusterFlight[i] = 1; this.clusterCurve[i] = curveDir;
            // ligero escalonamiento temporal (0–65 ms) para estirar el micro-cúmulo como filamento coalescente
            const delay = (m / Math.max(1, cSize)) * staggerS * (0.7 + 0.3 * Math.random());
            if (delay > 0.004) {
              this.phase[i] = 2; this.timer[i] = delay;
            } else {
              // empuje inicial con leve curvatura hacia el tramo vacío (1.5× más decidido con arito activo)
              const dx = tx - px[i], dy = ty - py[i], dl = Math.hypot(dx, dy) || 1;
              const nx = dx / dl, ny = dy / dl, kick = agile ? 420 : 280;
              this.vx[i] = nx * kick - ny * curveDir * 170;
              this.vy[i] = ny * kick + nx * curveDir * 170;
              this.phase[i] = 3;
            }
            this.arrived[i] = 0; this.settle[i] = C.settleTime;
            this.heat[i] = 0.78; this.emerge[i] = 0.18;
          }
        }
      } else if (ratio >= 0.94) {
        this.gapAge[b] = 0; this.spawnAcc[b] = 0;
      }
    }
  }

  /** Actualiza la física gravitacional: arrastre de marco (cero desfase), espiral cercana (sin segundo anillo) y dispersión exterior. */
  _updateBlackHole(dt, cur) {
    const bh = this.bh, n = this.n, hW = this.W * 0.5, hH = this.H * 0.5;
    const px = this.px, py = this.py, vxA = this.vx, vyA = this.vy;
    const pulled = this.bhPulled, rnd = this.rnd;

    if (bh.active) {
      bh.time += dt;
      const prevX = bh.x, prevY = bh.y;
      if (cur.valid) {
        const k = 1 - Math.exp(-18 * dt);
        bh.x += (cur.x - bh.x) * k; bh.y += (cur.y - bh.y) * k;
      }
      const dBhX = bh.x - prevX, dBhY = bh.y - prevY;
      const moved = (dBhX * dBhX + dBhY * dBhY) > 1e-6;

      // cuenta partículas atrapadas en la región de acreción → masa progresiva
      const capR = Math.max(135, bh.ehR * 3.4), capR2 = capR * capR;
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
      bh.rim = 0.52 + 0.48 * Math.min(1, bh.ratioSm * 1.4);

      const diag = Math.hypot(this.W, this.H);
      const rInf = C.bhInitRadius + Math.pow(bh.ratioSm, 0.65) * diag * 0.95 + Math.min(280, bh.time * 65);
      const soft2 = C.bhSoftening * C.bhSoftening;
      const gConst = C.bhGravityBase * mass;
      const ehMin = bh.ehVis + 1.0;
      const rInnerWell = ehMin * 2.6;
      const rAccOuter = ehMin * 3.8 + 46;
      const diskSpread = 52 + bh.ratioSm * 42;
      const vTangBase = 410 + 490 * (0.25 + 0.75 * bh.ratioSm);
      const dragDen = Math.max(1, rAccOuter - ehMin * 1.15);

      for (let i = 0; i < n; i++) {
        let x = px[i], y = py[i], vx = vxA[i], vy = vyA[i];

        // arrastre de marco (Frame-Dragging): disco interno y horizonte viajan unidos sin huecos en media luna
        if (pulled[i] && moved) {
          const distPrev = Math.hypot(x - prevX, y - prevY);
          let tD = (rAccOuter - distPrev) / dragDen;
          tD = tD < 0 ? 0 : tD > 1 ? 1 : tD;
          const drag = tD * tD * (3 - 2 * tD) * 0.94;
          x += dBhX * drag; y += dBhY * drag;
        }

        const dx = bh.x - x, dy = bh.y - y;
        const d2 = dx * dx + dy * dy, d = Math.sqrt(d2) + 1e-4;
        const att = d < rInf ? Math.pow(1 - d / rInf, 1.45) : 0;
        let gAcc = (gConst / (d2 + soft2)) * att;

        // pozo interno exponencial / inverso cúbico (R_horizon a R_horizon * 2.6)
        if (d < rInnerWell) {
          const uIn = Math.max(0, 1 - (d - ehMin) / Math.max(1, rInnerWell - ehMin));
          gAcc += (3800 + 2600 * bh.ratioSm) * (uIn * uIn * uIn + 0.45 * Math.exp(2.4 * uIn - 2.4));
        }

        if (!pulled[i]) {
          if (gAcc > C.bhDetachThreshold || d < ehMin + 34) {
            pulled[i] = 1; this.phase[i] = 1; this.hasTarget[i] = 0;
          } else {
            vx *= Math.exp(-12 * dt); vy *= Math.exp(-12 * dt);
            vxA[i] = vx; vyA[i] = vy;
            this.cr[i] = this.cg[i] = this.cb[i] = 1;
            this.en[i] = Math.max(0, this.en[i] - dt * 3);
            continue;
          }
        }

        const nx = dx / d, ny = dy / d;            // radial hacia adentro
        const tx = -ny, ty = nx;                  // tangente orbital
        // distribución radial asimétrica: núcleo denso junto al horizonte y dispersión nebulosa progresiva hacia afuera
        const rSlot = ehMin + 2 + Math.pow(rnd[i], 2.25) * diskSpread;
        // velocidad tangencial diferencial: ω ∝ r^-1.15 → v = ω·r ∝ r^-0.15
        const vTangTarget = vTangBase * Math.pow(ehMin / Math.max(d, ehMin), 0.15) * (0.86 + 0.28 * rnd[i]);
        const vt = vx * tx + vy * ty;
        const vr = vx * nx + vy * ny;             // positivo = cayendo hacia adentro

        let ax = 0, ay = 0;
        if (d > rSlot + 16) {
          // espiral entrante continua (sin órbita lejana estable → cero segundo anillo)
          const vInTarget = Math.min(1850, 250 + 520 * bh.ratioSm + Math.sqrt(Math.min(gAcc, 14000)) * 9.5);
          const pullR = (vInTarget - vr) * 5.2 + Math.min(gAcc, 6500) * 0.45;
          const pullT = (vTangTarget * Math.min(1, (rAccOuter * 1.4) / Math.max(d, ehMin)) - vt) * 3.8;
          ax = nx * pullR + tx * pullT;
          ay = ny * pullR + ty * pullT;
        } else {
          // dentro del disco de acreción: rotación rápida con caída de densidad y leve dispersión periférica
          const jitter = Math.sin(bh.time * 2.6 + rnd[i] * 18.0) * (3 + 10 * rnd[i] * rnd[i]);
          const err = d - (rSlot + jitter);
          const pullR = err * 30 - vr * 5.8 + (d < rInnerWell ? Math.min(gAcc, 4500) * 0.15 : 0);
          const pullT = (vTangTarget - vt) * 7.5;
          ax = nx * pullR + tx * pullT;
          ay = ny * pullR + ty * pullT;
        }

        vx = (vx + ax * dt) * Math.exp(-0.75 * dt);
        vy = (vy + ay * dt) * Math.exp(-0.75 * dt);
        const sp2 = vx * vx + vy * vy;
        if (sp2 > 7.5e6) { const s = 2740 / Math.sqrt(sp2); vx *= s; vy *= s; }
        x += vx * dt; y += vy * dt;

        // núcleo negro hueco estricto
        const ox = x - bh.x, oy = y - bh.y, od = Math.hypot(ox, oy);
        if (od < ehMin) {
          const onx = od > 1e-4 ? ox / od : Math.cos(rnd[i] * TWO_PI);
          const ony = od > 1e-4 ? oy / od : Math.sin(rnd[i] * TWO_PI);
          x = bh.x + onx * ehMin; y = bh.y + ony * ehMin;
          const vn = vx * onx + vy * ony;
          if (vn < 0) { vx -= onx * vn; vy -= ony * vn; }
        }
        x = Math.max(-hW + 1, Math.min(hW - 1, x)); y = Math.max(-hH + 1, Math.min(hH - 1, y));
        px[i] = x; py[i] = y; vxA[i] = vx; vyA[i] = vy;
        // sutil reflejo cálido-blanco en ALYSAURIO cuando el fondo se mezcla en el disco de acreción
        const eRad = Math.pow(Math.max(0, 1 - (d - ehMin) / (diskSpread * 1.15)), 1.55);
        const wMix = bh.warm * eRad * 0.22;
        this.cr[i] = 1; this.cg[i] = 1 - 0.06 * wMix; this.cb[i] = 1 - 0.16 * wMix;
        this.en[i] = Math.min(1, Math.max(eRad, Math.sqrt(sp2) / 3400 * 0.45));
      }

      // física gravitacional O(N) pura (mismo giro horario, pozo interno y arrastre de marco) + fusión cromática cálida
      if (bh.bgCaptured) bh.bgTime += dt;
      const bgBaseLift = bh.bgCaptured ? Math.min(1, bh.bgTime / 0.35) : 1;
      const exDamp = Math.exp(-0.8 * dt);
      const proxOuter = rAccOuter * 1.45, proxInner = ehMin * 1.15;
      const proxDen = Math.max(1, proxOuter - proxInner);
      const innerSpan = Math.max(1, rInnerWell - ehMin);
      const exX = this.exX, exY = this.exY, exVx = this.exVx, exVy = this.exVy;
      const exR0 = this.exR0, exG0 = this.exG0, exB0 = this.exB0;
      const exR = this.exR, exG = this.exG, exB = this.exB;
      const exRnd = this.exRnd, exIsBg = this.exIsBg, exE = this.exE;
      const bhX = bh.x, bhY = bh.y, ratioSm = bh.ratioSm;
      let bgNear = 0, bgTotal = 0;

      for (let k = 0; k < this.extraCount; k++) {
        let x = exX[k], y = exY[k], vx = exVx[k], vy = exVy[k];
        if (moved) {
          const distPrev = Math.hypot(x - prevX, y - prevY);
          let tD = (rAccOuter - distPrev) / dragDen;
          tD = tD < 0 ? 0 : tD > 1 ? 1 : tD;
          const drag = tD * tD * (3 - 2 * tD) * 0.94;
          x += dBhX * drag; y += dBhY * drag;
        }
        const dx = bhX - x, dy = bhY - y, d2 = dx * dx + dy * dy, d = Math.sqrt(d2) + 1e-4;
        const nx = dx / d, ny = dy / d, tx = -ny, ty = nx;
        const rn = exRnd[k];
        const rSlot = ehMin + 3 + rn * rn * diskSpread;
        const invR = ehMin / (d > ehMin ? d : ehMin);
        const vTangTarget = vTangBase * (0.78 + 0.22 * Math.sqrt(invR)) * (0.86 + 0.28 * rn);
        const vt = vx * tx + vy * ty, vr = vx * nx + vy * ny;

        let gLocal = gConst / (d2 + soft2);
        if (d < rInnerWell) {
          const uIn = 1 - (d - ehMin) / innerSpan;
          if (uIn > 0) gLocal += (3800 + 2600 * ratioSm) * (uIn * uIn * uIn + 0.35 * uIn);
        }

        let ax, ay;
        if (d > rSlot + 16) {
          const vIn = 340 + 580 * ratioSm + Math.sqrt(gLocal < 14000 ? gLocal : 14000) * 8.5;
          const pullR = ((vIn < 1950 ? vIn : 1950) - vr) * 5.2 + (gLocal < 6000 ? gLocal : 6000) * 0.38;
          const tAtt = (rAccOuter * 1.35) / (d > ehMin ? d : ehMin);
          const pullT = (vTangTarget * (tAtt < 1 ? tAtt : 1) - vt) * 3.8;
          ax = nx * pullR + tx * pullT; ay = ny * pullR + ty * pullT;
        } else {
          const pullR = (d - rSlot) * 28 - vr * 5.6;
          const pullT = (vTangTarget - vt) * 7.4;
          ax = nx * pullR + tx * pullT; ay = ny * pullR + ty * pullT;
        }
        vx = (vx + ax * dt) * exDamp; vy = (vy + ay * dt) * exDamp;
        const sp2 = vx * vx + vy * vy;
        if (sp2 > 7.5e6) { const s = 2740 / Math.sqrt(sp2); vx *= s; vy *= s; }
        x += vx * dt; y += vy * dt;

        const ox = x - bhX, oy = y - bhY, od = Math.hypot(ox, oy);
        if (od < ehMin) {
          const onx = od > 1e-4 ? ox / od : Math.cos(rn * TWO_PI);
          const ony = od > 1e-4 ? oy / od : Math.sin(rn * TWO_PI);
          x = bhX + onx * ehMin; y = bhY + ony * ehMin;
          const vn = vx * onx + vy * ony; if (vn < 0) { vx -= onx * vn; vy -= ony * vn; }
        }
        exX[k] = x; exY[k] = y; exVx[k] = vx; exVy[k] = vy;

        // proximidad radial al horizonte + velocidad orbital → realce progresivo y fusión cromática cálida
        let pt = (proxOuter - d) / proxDen;
        pt = pt < 0 ? 0 : pt > 1 ? 1 : pt;
        const prox = pt * pt * (3 - 2 * pt);
        const spd = Math.sqrt(sp2);

        if (exIsBg[k]) {
          bgTotal++;
          if (d < rAccOuter * 1.15) bgNear++;
          // realce suave de brillo y saturación desde la opacidad tenue del fondo hasta nitidez de ALYSAURIO (~350 ms)
          const lift = Math.min(1, bgBaseLift + Math.min(0.55, spd / 1100));
          const r0 = exR0[k], g0 = exG0[k], b0 = exB0[k];
          const avg = (r0 + g0 + b0) * 0.3333;
          const sat = 1 + 0.38 * lift;
          const bri = 0.44 + 0.68 * lift;
          let cr = Math.min(1, Math.max(0, (avg + (r0 - avg) * sat) * bri));
          let cg = Math.min(1, Math.max(0, (avg + (g0 - avg) * sat) * bri));
          let cb = Math.min(1, Math.max(0, (avg + (b0 - avg) * sat) * bri));

          // fusión cromática: color original → oro/ámbar suave (#FFE1B0 / #FFD28E) → blanco cálido (#FFF7EA → #FFFFFF)
          const mixP = Math.min(1, prox + Math.min(0.20, spd / 2600) * prox);
          if (mixP > 0.005) {
            if (mixP < 0.55) {
              const t1 = mixP / 0.55;
              cr += (1.00 - cr) * t1; cg += (0.86 - cg) * t1; cb += (0.64 - cb) * t1;
            } else {
              const t2 = (mixP - 0.55) / 0.45;
              // oro/ámbar suave → blanco cálido incandescente pegado al horizonte
              const wr = 1.00, wg = 0.86 + (0.985 - 0.86) * t2, wb = 0.64 + (0.955 - 0.64) * t2;
              cr = wr; cg = wg; cb = wb;
            }
          }
          exR[k] = cr; exG[k] = cg; exB[k] = cb;
        } else {
          // textos HTML: blanco/gris limpio que se funde hacia blanco-cálido junto al horizonte
          const tW = prox * 0.85;
          exR[k] = exR0[k] + (1.0 - exR0[k]) * tW;
          exG[k] = exG0[k] + (0.975 - exG0[k]) * tW;
          exB[k] = exB0[k] + (0.92 - exB0[k]) * tW;
        }
        const eU = Math.max(0, 1 - (d - ehMin) / (diskSpread * 1.25));
        exE[k] = eU * eU * 0.78;
      }

      const warmTarget = bgTotal > 20 ? Math.min(1, (bgNear / Math.max(1, bgTotal * 0.35))) : 0;
      bh.warm += (warmTarget - bh.warm) * (1 - Math.exp(-4 * dt));
    } else if (bh.releasing) {
      bh.relTime += dt;
      bh.ehVis = Math.max(0, bh.ehVis - dt * 520);
      bh.rim = Math.max(0, bh.rim - dt * 4.8);
      bh.warm = Math.max(0, bh.warm - dt * 2.5);
      // réplicas temporales se dispersan y se disipan hacia sus orígenes mientras el fondo y textos vuelven limpiamente
      const fadeOut = Math.max(0, 1 - Math.max(0, bh.relTime - 0.14) / 0.55);
      const dkExpl = Math.pow(0.94, dt * 60), dkRet = Math.exp(-11 * dt), dkE = Math.exp(-4.5 * dt);
      for (let k = 0; k < this.extraCount; k++) {
        let x = this.exX[k], y = this.exY[k], vx = this.exVx[k], vy = this.exVy[k];
        if (bh.relTime < 0.22) {
          vx *= dkExpl; vy *= dkExpl; x += vx * dt; y += vy * dt;
        } else {
          const ax = (this.exOx[k] - x) * 38, ay = (this.exOy[k] - y) * 38;
          vx = (vx + ax * dt) * dkRet; vy = (vy + ay * dt) * dkRet;
          x += vx * dt; y += vy * dt;
        }
        this.exX[k] = Math.max(-hW + 1, Math.min(hW - 1, x));
        this.exY[k] = Math.max(-hH + 1, Math.min(hH - 1, y));
        this.exVx[k] = vx; this.exVy[k] = vy;
        this.exE[k] *= dkE;
      }
      this._extraAlpha = fadeOut;
      if (bh.relTime >= 1.05) {
        bh.releasing = false; bh.ehVis = 0; bh.rim = 0; bh.warm = 0; bh.bgCaptured = false;
        this.extraCount = 0; this.heroNoBounce = false;
      }
    }

    // actualiza uniformes del horizonte de eventos en GRID_FS
    const u = this.material.uniforms;
    u.uBhPos.value.set(hW + bh.x, hH + bh.y);
    u.uBhR.value = bh.ehVis;
    u.uBhRim.value = bh.rim;
    u.uBhWarm.value = bh.warm;
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
      this.material.uniforms.uBhWarm.value = 0;
      this._extraAlpha = 0;
      if (this.heroNoBounceTimer > 0) {
        this.heroNoBounceTimer -= dt;
        if (this.heroNoBounceTimer <= 0) this.heroNoBounce = false;
      }
    }

    // --- suavizado de unión y cuerda ---
    const kj = 1 - Math.exp(-14 * dt), kl = 1 - Math.exp(-5 * dt);
    if (S.jr < 1.5 && S.jtr > 1.5) { S.jx = S.jtx; S.jy = S.jty; }
    S.jx += (S.jtx - S.jx) * kj; S.jy += (S.jty - S.jy) * kj; S.jr += (S.jtr - S.jr) * kj;
    S.L += (S.LT - S.L) * kl;
    this._rope(dt, cur);

    // --- balanceo y regeneración progresiva de huecos (aro + arito) ---
    this._rebalanceGaps(dt);

    // --- volumen objetivo → espaciado y masa de splatting (durante compresión se conserva la densidad creciente del pool) ---
    const area = this._area();
    this.areaSm += (area - this.areaSm) * (1 - Math.exp(-6 * dt));
    const h = Math.max(5, Math.min(16, Math.sqrt(this.areaSm / n) * C.spacingScale));
    const massScale = (this.areaSm / (cs * cs * n) * C.fill) * (1 + 0.65 * S.charge);

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
    const hasT = this.hasTarget, txA = this.tx, tyA = this.ty, emerge = this.emerge, puff = this.puff;
    const clFlight = this.clusterFlight, clCurve = this.clusterCurve;
    const charge = S.ringActive && !S.isDetail ? S.charge : 0;
    const c2 = charge * charge, cFreq = 18 + 38 * charge;
    const dragK = Math.pow(C.dispersionDrag, dt * 60), xsphK = C.xsphCohesion * Math.min(1, dt * 60);
    const dispVmax = C.maxDispersionSpeed, dispVmax2 = dispVmax * dispVmax;
    const puffGrowK = 1 - Math.exp(-6.5 * dt), puffCompK = 1 - Math.exp(-13 * dt), puffDecay = Math.exp(-13 * dt);
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
      let ph = phase[i], waveE = 0;
      if (emerge[i] < 1) emerge[i] = Math.min(1, emerge[i] + dt * 6.5);

      // 1) impulso del cursor o del círculo del «arito» (expansión radial/lateral tipo aro de humo + tope contenido)
      if (capActive) {
        const l = ((x - ppx) * sx + (y - ppy) * sy) / sl2, s = l < 0 ? 0 : l > 1 ? 1 : l;
        const dx = x - (ppx + sx * s), dy = y - (ppy + sy * s), d2 = dx * dx + dy * dy;
        if (d2 < cr2) {
          const d = Math.sqrt(d2) + 1e-4, f = 1 - d / cr0, f2 = f * f;
          const side = (ux * dy - uy * dx) >= 0 ? 1 : -1;
          const rdx = dx / d, rdy = dy / d;
          const mag = Math.min(cspeed, 2400) * 0.55 * pushMul * f2;
          // apertura radial/lateral + dispersión gaseosa en vez de empujar en hilo compacto
          const angJ = rnd[i] * TWO_PI + t * 1.3;
          vx += ux * mag * 0.68 + rdx * mag * 0.42 - uy * side * mag * 0.36 + Math.cos(angJ) * mag * 0.28;
          vy += uy * mag * 0.68 + rdy * mag * 0.42 + ux * side * mag * 0.36 + Math.sin(angJ) * mag * 0.28;
          const v2 = vx * vx + vy * vy;
          if (v2 > dispVmax2) { const sc = dispVmax / Math.sqrt(v2); vx *= sc; vy *= sc; }
          ph = 1; t1[i] = 0; arrived[i] = 0; hasT[i] = 0; clFlight[i] = 0;
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
            if (ph === 1 || (ph === 3 && clFlight[i])) {
              const w = 1 - r / 18; sw += w; svx += w * vxA[j]; svy += w * vyA[j];
              if (ph === 1 && r < 7) { const f = 1 - r / 7; prx += dx / r * f; pry += dy / r * f; }
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
      } else if (ph === 1) {                              // FASE 1 — expansión volumétrica tipo «aro de humo» (retorno = 0 %)
        if (isDetail) {
          // conserva intacta la estela de salida en DETAIL_RECT
          ax += prx * 900 + C.turbulence * Math.sin(y * 0.021 + t * 3.1 + rnd[i] * 6.28);
          ay += pry * 900 + C.turbulence * Math.cos(x * 0.019 + t * 2.7 + rnd[i] * 6.28);
          if (sw > 0.01) { const k = xsphK * Math.min(1, sw); vx += (svx / sw - vx) * k; vy += (svy / sw - vy) * k; }
          vx += ax * dt; vy += ay * dt; vx *= dragK; vy *= dragK;
          puff[i] *= puffDecay;
        } else {
          // curl noise 2D libre de divergencia (volutas suaves) + presión de expansión lateral/radial
          const p1x = 0.017 * x + 1.3 * t, p1y = 0.017 * y - 1.1 * t;
          const p2 = 0.031 * y - 0.023 * x + 2.1 * t;
          const c2cos = Math.cos(p2);
          const curlX = (-Math.sin(p1x) * Math.sin(p1y) + 0.95 * c2cos) * C.smokeCurlStrength;
          const curlY = (-Math.cos(p1x) * Math.cos(p1y) + 0.72 * c2cos) * C.smokeCurlStrength;
          // expansión gaseosa: empuje de presión de vecinos + divergencia radial suave
          ax += prx * 1450 + rx * 420 + curlX;
          ay += pry * 1450 + ry * 420 + curlY;
          // cohesión direccional XSPH reducida al dispersarse rápido (evita «hilos» rígidos)
          if (sw > 0.01) {
            const xScale = 0.16 + 0.24 * Math.min(1, t1[i] / 0.55);
            const k = xsphK * xScale * Math.min(1, sw);
            vx += (svx / sw - vx) * k; vy += (svy / sw - vy) * k;
          }
          vx += ax * dt; vy += ay * dt; vx *= dragK; vy *= dragK;
          const spNow2 = vx * vx + vy * vy;
          if (spNow2 > dispVmax2) { const sc = dispVmax / Math.sqrt(spNow2); vx *= sc; vy *= sc; }
          // aumenta el volumen de splatting (puffFactor 0 → 1) conforme se expande lejos del aro
          const dRing = Math.abs(Math.hypot(x, y) - S.R);
          const pTgt = Math.min(1, t1[i] * 2.2 + Math.max(0, dRing - S.rb * 0.8) / 72);
          puff[i] += (pTgt - puff[i]) * puffGrowK;
        }
        t1[i] += dt;
        const sp2 = vx * vx + vy * vy;
        if ((sp2 < C.apexSpeed * C.apexSpeed && t1[i] > 0.1) || t1[i] > C.smokeMax) {
          ph = 2; timer[i] = C.apexDelayMs / 1000 * (0.85 + rnd[i] * 0.3);
        }
      } else if (ph === 2) {                              // pausa en el ápice (o escalonamiento 0–65 ms de micro-cúmulo)
        vx += ax * dt; vy += ay * dt;
        const k = Math.exp(-14 * dt); vx *= k; vy *= k;
        if (!isDetail && S.ringActive && !clFlight[i]) {
          puff[i] += (Math.min(1, puff[i] + 0.12) - puff[i]) * puffGrowK;
        } else {
          puff[i] *= puffDecay;
        }
        timer[i] -= dt;
        if (timer[i] <= 0) {
          ph = 3; heat[i] = 1; arrived[i] = 0; settle[i] = C.settleTime;
          if (clFlight[i] && hasT[i]) {
            const dx = txA[i] - x, dy = tyA[i] - y, dl = Math.hypot(dx, dy) || 1;
            const nx = dx / dl, ny = dy / dl, cv = clCurve[i];
            const kick = Math.abs(cv) > 1.1 ? 420 : 280;
            vx = nx * kick - ny * cv * 165;
            vy = ny * kick + nx * cv * 165;
          }
        }
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
          if (comp === 0 || comp === 2) {
            if (ph === 0 || arrived[i]) {
              arcColor(S, x, y); ccr[i] = oR; ccg[i] = oG; ccb[i] = oB; waveE = oW;
            } else if (hasT[i]) {
              // micro-cúmulos y objetivos explícitos evalúan su ángulo destino sobre el aro (cero cambios al cruzar fronteras)
              arcColor(S, txA[i], tyA[i]); ccr[i] = oR; ccg[i] = oG; ccb[i] = oB; waveE = oW;
            } else if (sd < S.rb * 2.2) {
              // humo libre regresando: mantiene su color intacto en el aire y se reintegra suavemente al tocar el aro
              arcColor(S, x, y);
              const ck = 1 - Math.exp(-8 * dt);
              ccr[i] += (oR - ccr[i]) * ck; ccg[i] += (oG - ccg[i]) * ck; ccb[i] += (oB - ccb[i]) * ck;
              waveE = oW * 0.5;
            }
          } else if (comp === 1) {
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
          if (puff[i] > 0) { puff[i] *= puffDecay; if (puff[i] < 0.02) puff[i] = 0; }
          ax += rx * C.spacing; ay += ry * C.spacing;
          if (isDetail) {
            // anclaje sobreamortiguado en DETAIL_RECT: cero oscilaciones, sigue ondas y abombamiento interno suave
            ax += (txA[i] - x) * C.detailHoldK;
            ay += (tyA[i] - y) * C.detailHoldK;
            vx = (vx + ax * dt) * detRest; vy = (vy + ay * dt) * detRest;
          } else {
            // energía cinética acumulada durante la compresión reversible al subir hacia ALYSAURIO
            if (charge > 0.002) {
              const rLen = Math.hypot(x, y) || 1, rnx = x / rLen, rny = y / rLen;
              const nRad = Math.sin(t * cFreq + rnd[i] * 73.1) + 0.6 * Math.cos(t * cFreq * 1.73 + i * 1.9);
              const nTan = Math.cos(t * cFreq * 1.29 + rnd[i] * 51.7) + 0.5 * Math.sin(t * cFreq * 2.11 + i * 2.7);
              const jAmp = 1450 * c2 + 2500 * c2 * charge;
              ax += (rnx * nRad - rny * nTan * 0.65) * jAmp;
              ay += (rny * nRad + rnx * nTan * 0.65) * jAmp;
              if (charge > 0.60 && Math.random() < (charge - 0.60) * 0.045) {
                const spk = 280 + 380 * charge;
                vx += rnx * spk; vy += rny * spk; heat[i] = 1;
              }
            }
            if (sd > 0 && sd < 1e8) { const pull = Math.min(sd + 1, 700); ax -= gx * C.holdStiffness * pull; ay -= gy * C.holdStiffness * pull; }
            if (sd > C.relapseDistance && sd < 1e8) { ph = 3; heat[i] = 1; arrived[i] = 0; settle[i] = C.settleTime; }
            vx = (vx + ax * dt) * rest; vy = (vy + ay * dt) * rest;
          }
        } else if (sd >= 1e8) {
          vx *= rest; vy *= rest;
        } else if (isDetail || (S.mode === 0 && this.heroNoBounce)) {
          // FASE 2 sobreamortiguada: DETAIL_RECT y restauración de agujero negro (encaja en seco sin elasticidad ni rebotes)
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
          if (arrived[i]) { settle[i] -= dt; if (settle[i] <= 0 || sd < 2.5) { ph = 0; if (!isDetail) hasT[i] = 0; } }
        } else {
          // FASE 2 simbiótica violenta con freno magnético al 20 % (Aro / Hero / Arito)
          const e = hasT[i] ? sd : (sd + inset);
          // compresión volumétrica al retornar hacia el aro (splatRadius se contrae rápidamente hacia 1.0)
          if (puff[i] > 0) {
            const targetPuff = arrived[i] ? 0 : Math.min(0.7, Math.max(0, sd / 100)) * 0.65;
            puff[i] += (targetPuff - puff[i]) * puffCompK;
            if (puff[i] < 0.02) puff[i] = 0;
          }
          ax += rx * C.spacing * 0.35; ay += ry * C.spacing * 0.35;
          // cohesión XSPH ligera en micro-cúmulos regenerativos → forma gotas/filamentos coalescentes
          if (clFlight[i] && !arrived[i] && sw > 0.01) {
            const ck = xsphK * 0.42 * Math.min(1, sw);
            vx += (svx / sw - vx) * ck; vy += (svy / sw - vy) * ck;
          }
          let K = Kret, c = cRet;
          if (arrived[i]) { K = Kset; c = cSet; }
          else if (Math.abs(e) < arrR) {
            const vn = vx * gx + vy * gy;
            vx -= gx * vn * (1 - C.magneticBrake); vy -= gy * vn * (1 - C.magneticBrake);
            arrived[i] = 1; clFlight[i] = 0; K = Kset; c = cSet;
          }
          const an = -K * (e > 700 ? 700 : e < -700 ? -700 : e);
          vx += (ax + gx * an) * dt; vy += (ay + gy * an) * dt;
          let vn = vx * gx + vy * gy;
          const ttx = vx - vn * gx, tty = vy - vn * gy;
          vn *= Math.exp(-c * dt);
          const lk = arrived[i] ? 1 : latK;
          vx = ttx * lk + vn * gx; vy = tty * lk + vn * gy;
          if (arrived[i]) { settle[i] -= dt; if (settle[i] <= 0) { ph = 0; hasT[i] = 0; clFlight[i] = 0; } }
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
      en[i] = Math.min(1, Math.max(heat[i], spd, waveE));
    }

    this._splat(t, massScale);
  }

  _splat(t, massScale) {
    const S = this.S, n = this.n, cs = C.cellSize, gw = this.gw, gh = this.gh, hW = this.W * 0.5, hH = this.H * 0.5;
    const Dm = this.Dm, Dr = this.Dr, Dg = this.Dg, Db = this.Db, De = this.De;
    Dm.fill(0); Dr.fill(0); Dg.fill(0); Db.fill(0); De.fill(0);
    const inv2s = 1 / (2 * C.kernelSigma * C.kernelSigma);
    const w9 = this._w9 || (this._w9 = new Float32Array(9));
    const w25 = this._w25 || (this._w25 = new Float32Array(25));
    const px = this.px, py = this.py, emerge = this.emerge, puff = this.puff;
    const puffSpan = Math.max(0.2, C.smokeMaxSplatRadius - 1.0);

    for (let i = 0; i < n; i++) {
      // origen superior-izquierdo unificado con BG_FS y GRID_FS
      const gx = (px[i] + hW) / cs, gy = (hH - py[i]) / cs, cx = Math.floor(gx), cy = Math.floor(gy);
      const pf = S.ringActive && !S.isDetail ? puff[i] : 0;
      const e = this.en[i], r = this.cr[i], g = this.cg[i], b = this.cb[i];
      if (pf <= 0.05) {
        // estado cohesionado: splatRadius = 1.0 (huella compacta 3×3 nítida)
        let sum = 0, q = 0;
        for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++, q++) {
          const dx = gx - (cx + ox + 0.5), dy = gy - (cy + oy + 0.5);
          const w = Math.exp(-(dx * dx + dy * dy) * inv2s); w9[q] = w; sum += w;
        }
        const inv = emerge[i] / sum;
        q = 0;
        for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++, q++) {
          const xx = cx + ox, yy = cy + oy;
          if (xx < 0 || yy < 0 || xx >= gw || yy >= gh) continue;
          const w = w9[q] * inv, gi = yy * gw + xx;
          Dm[gi] += w; Dr[gi] += w * r; Dg[gi] += w * g; Db[gi] += w * b; De[gi] += w * e;
        }
      } else {
        // dispersión tipo «aro de humo»: amplía splatRadius (1.0 → ~2.45 celdas) sobre huella 5×5 distribuyendo masa
        const rad = 1.0 + pf * puffSpan;
        const sig = C.kernelSigma * rad, inv2sP = 1 / (2 * sig * sig);
        let sum = 0, q = 0;
        for (let oy = -2; oy <= 2; oy++) for (let ox = -2; ox <= 2; ox++, q++) {
          const dx = gx - (cx + ox + 0.5), dy = gy - (cy + oy + 0.5);
          const w = Math.exp(-(dx * dx + dy * dy) * inv2sP); w25[q] = w; sum += w;
        }
        // ligero realce de masa (+22 %) para que la nube esponjosa (+ = ; : .) conserve presencia sin volverse invisible
        const inv = (emerge[i] * (1.0 + 0.22 * pf)) / sum;
        q = 0;
        for (let oy = -2; oy <= 2; oy++) for (let ox = -2; ox <= 2; ox++, q++) {
          const xx = cx + ox, yy = cy + oy;
          if (xx < 0 || yy < 0 || xx >= gw || yy >= gh) continue;
          const w = w25[q] * inv, gi = yy * gw + xx;
          Dm[gi] += w; Dr[gi] += w * r; Dg[gi] += w * g; Db[gi] += w * b; De[gi] += w * e;
        }
      }
    }

    // splat directo O(N) de partículas capturadas 1:1 del fondo ASCII y textos HTML sobre la misma grilla fija
    const exN = this.extraCount, exA = this._extraAlpha || 0;
    if (exN > 0 && exA > 0.01) {
      const invMs = exA / Math.max(massScale, 0.14);
      const lift = this.bh.bgCaptured ? Math.min(1, this.bh.bgTime / 0.35) : 1;
      const bgScale = (0.30 + 0.95 * lift) * invMs;
      const txtScale = 0.85 * invMs;
      const exX = this.exX, exY = this.exY, exR = this.exR, exG = this.exG, exB = this.exB;
      const exLum = this.exLum, exE = this.exE, exIsBg = this.exIsBg;
      for (let k = 0; k < exN; k++) {
        const cx = Math.floor((exX[k] + hW) / cs), cy = Math.floor((hH - exY[k]) / cs);
        if (cx < 0 || cy < 0 || cx >= gw || cy >= gh) continue;
        const w = exIsBg[k] ? (exLum[k] * bgScale) : (exLum[k] * txtScale);
        const gi = cy * gw + cx;
        Dm[gi] += w; Dr[gi] += w * exR[k]; Dg[gi] += w * exG[k]; Db[gi] += w * exB[k]; De[gi] += w * exE[k];
      }
    }

    const out = this.gridData, size = gw * gh;
    const ch = S.ringActive && !S.isDetail ? S.charge : 0;
    const flick = (t * (7 + 48 * ch * ch)) | 0;
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
        const wx = ((gi % gw) + 0.5) * cs - hW - S.bx, wy = hH - (((gi / gw) | 0) + 0.5) * cs - S.by;
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
      let flash = 0;
      if (ch > 0.005) {
        // mutación frenética de glifos hacia x # % @ + calentamiento incandescente pulsante irregular
        const wx = ((gi % gw) + 0.5) * cs - hW, wy = hH - (((gi / gw) | 0) + 0.5) * cs;
        const ang = Math.atan2(wy, wx);
        const p1 = Math.sin(ang * 3.0 + t * 9.5) * Math.sin(ang * 5.0 - t * 13.2);
        const p2 = Math.cos(ang * 7.0 - t * 17.4 + hs * 2.4);
        const hot = Math.max(0, 0.5 + 0.5 * (p1 * 0.6 + p2 * 0.4));
        flash = Math.min(1, ch * ch * (0.42 + 0.88 * hot * hot) + (ch > 0.72 ? (ch - 0.72) * 1.4 : 0));
        E = Math.min(1, E + flash * 0.85);
      }
      L *= 1 + 0.5 * E;
      let f = (L - 0.05) / 1.5; f = f < 0 ? 0 : f > 1 ? 1 : f;
      let gl = Math.pow(f, 0.85) * 8.99 + E * 1.5 + (ch > 0.005 ? ch * (1.6 + 2.6 * hs) : 0);
      if (gl > 8.99) gl = 8.99;
      let al = (L - 0.03) / 0.19; al = al < 0 ? 0 : al > 1 ? 1 : al; al = al * al * (3 - 2 * al);
      const white = Math.min(1, Math.max(E * 1.35, flash));
      out[o] = Dr[gi] * inv + (1 - Dr[gi] * inv) * white;
      out[o + 1] = Dg[gi] * inv + (1 - Dg[gi] * inv) * white;
      out[o + 2] = Db[gi] * inv + (1 - Db[gi] * inv) * white;
      out[o + 3] = Math.floor(gl) + al * 0.99;
    }
    this.gridTex.needsUpdate = true;
  }
}
