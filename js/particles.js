// particles.js — sistema de partículas ASCII (instancias como THREE.Points con atlas tipográfico),
// campos de atracción por SDF/campo de distancia, fluido del cursor, repulsión por densidad y cuerda del divisor.
import * as THREE from 'three';
import { PARTICLE_VS, PARTICLE_FS } from './shaders.js';

export const CELL = 5;          // px de celda de glifo
const GRID = 6;                 // px de celda de la rejilla de densidad
const TC = 4;                   // px de celda del campo de distancia del texto
const ROPE_N = 96;
const K_SPRING = 48, K_REP = 22, DAMP = 7.5;
const TOPO = [[0.24, 0.34, 0.62], [0.27, 0.64, 0.66], [0.93, 0.74, 0.36], [0.97, 0.95, 0.90]];

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

let compId = -1, arcId = -1;
/** SDF de la escena (unión de arcos del aro, caja redondeada de contorno, bolita de unión y línea-cuerda). */
function sdfScene(S, x, y) {
  let d = 1e9; compId = -1; arcId = -1;
  const N = S.N, R = S.R, rb = S.rb;
  for (let k = 0; k < N; k++) {
    if (S.ap[k] < 0.03) continue;
    const c = S.cosC[k], s = S.sinC[k];
    const py = x * c + y * s, px = Math.abs(-x * s + y * c);
    const sa = S.sinA[k], ca = S.cosA[k];
    let dd;
    if (ca * px > sa * py) { const ex = px - sa * R, ey = py - ca * R; dd = Math.sqrt(ex * ex + ey * ey) - rb; }
    else dd = Math.abs(Math.sqrt(px * px + py * py) - R) - rb;
    if (dd < d) { d = dd; compId = 0; arcId = k; }
  }
  if (S.boxOn) {
    const qx = Math.abs(x - S.bx) - S.bhw + S.bcr, qy = Math.abs(y - S.by) - S.bhh + S.bcr;
    const mx = qx > 0 ? qx : 0, my = qy > 0 ? qy : 0;
    const sd = Math.sqrt(mx * mx + my * my) + Math.min(Math.max(qx, qy), 0) - S.bcr;
    const dd = Math.abs(sd) - S.brb;
    if (dd < d) { d = dd; compId = 1; }
  }
  if (S.jr > 1.5) {
    const ex = x - S.jx, ey = y - S.jy;
    const dd = Math.sqrt(ex * ex + ey * ey) - S.jr;
    if (dd < d) { d = dd; compId = 2; }
  }
  if (S.L > 2) {
    let f = (y + S.ropeH) / (2 * S.ropeH) * (ROPE_N - 1);
    f = f < 0 ? 0 : f > ROPE_N - 1.001 ? ROPE_N - 1.001 : f;
    const i0 = f | 0, fr = f - i0;
    const off = S.ro[i0] * (1 - fr) + S.ro[i0 + 1] * fr;
    const ex = Math.abs(x - off), ay = Math.abs(y) - S.L, ey = ay > 0 ? ay : 0;
    const dd = Math.sqrt(ex * ex + ey * ey) - S.lrb;
    if (dd < d) { d = dd; compId = 3; }
  }
  return d;
}

let oR = 1, oG = 1, oB = 1;
function arcColor(S, x, y) {
  const N = S.N, col = S.colors;
  const { k, f } = segmentAt(Math.atan2(y, x), N);
  let c = col[k % N];
  if (f < 0.14) { const t = 0.5 + f / 0.28, p = col[(k + N - 1) % N]; oR = p[0] + (c[0] - p[0]) * t; oG = p[1] + (c[1] - p[1]) * t; oB = p[2] + (c[2] - p[2]) * t; }
  else if (f > 0.86) { const t = (f - 0.86) / 0.28, q = col[(k + 1) % N]; oR = c[0] + (q[0] - c[0]) * t; oG = c[1] + (q[1] - c[1]) * t; oB = c[2] + (q[2] - c[2]) * t; }
  else { oR = c[0]; oG = c[1]; oB = c[2]; }
}

export class ParticleSystem {
  constructor({ atlas, N, count = 16000, maxCount = 25000 }) {
    this.max = maxCount; this.count = Math.min(count, maxCount);
    this.W = 1; this.H = 1;
    const m = maxCount;
    this.px = new Float32Array(m); this.py = new Float32Array(m);
    this.vx = new Float32Array(m); this.vy = new Float32Array(m);
    this.rnd = new Float32Array(m); this.cell = new Int32Array(m);
    this.pos = new Float32Array(m * 3); this.col = new Float32Array(m * 3); this.gl = new Float32Array(m);
    for (let i = 0; i < m; i++) { this.rnd[i] = Math.random(); this.px[i] = (Math.random() - 0.5) * 1600; this.py[i] = (Math.random() - 0.5) * 900; }

    const geo = new THREE.BufferGeometry();
    this.aPos = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.aCol = new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage);
    this.aGl = new THREE.BufferAttribute(this.gl, 1).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.aPos); geo.setAttribute('aColor', this.aCol); geo.setAttribute('aGlyph', this.aGl);
    geo.setDrawRange(0, this.count);
    this.geometry = geo;
    this.material = new THREE.ShaderMaterial({
      vertexShader: PARTICLE_VS, fragmentShader: PARTICLE_FS,
      uniforms: { uRes: { value: new THREE.Vector2(1, 1) }, uCell: { value: CELL }, uDpr: { value: 1 }, tAtlas: { value: atlas } },
      transparent: true, depthTest: false, depthWrite: false,
    });
    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false; this.points.renderOrder = 3;

    this.setProjects(N);
    this.ropeO = new Float32Array(ROPE_N); this.ropeV = new Float32Array(ROPE_N);
    this.S.ro = this.ropeO;
    // campo de distancia del texto
    this.tgw = 1; this.tgh = 1; this.tnx = new Int16Array(1); this.tny = new Int16Array(1);
    this.cursorEnabled = false;
  }

  setProjects(N) {
    this.S = {
      N, mode: 1, R: 300, rb: 13,
      ap: new Float32Array(N), apT: new Float32Array(N), sinA: new Float32Array(N), cosA: new Float32Array(N).fill(1),
      cosC: new Float32Array(N), sinC: new Float32Array(N),
      colors: Array.from({ length: N }, () => [1, 1, 1]),
      boxOn: false, bx: 0, by: 0, bhw: 0, bhh: 0, bcr: 0, brb: 6, boxColor: [1, 1, 1],
      jx: 0, jy: 0, jr: 0, jtx: 0, jty: 0, jtr: 0,
      L: 0, LT: 0, lrb: 13, ropeH: 400, ro: null,
    };
    for (let k = 0; k < N; k++) { const a = centerAngle(k, N); this.S.cosC[k] = Math.cos(a); this.S.sinC[k] = Math.sin(a); }
  }

  resize(W, H, dpr) {
    this.W = W; this.H = H;
    this.material.uniforms.uRes.value.set(W, H);
    this.material.uniforms.uDpr.value = dpr;
    this.gw = Math.ceil(W / GRID) + 3; this.gh = Math.ceil(H / GRID) + 3;
    this.D0 = new Float32Array(this.gw * this.gh); this.D1 = new Float32Array(this.gw * this.gh); this.D = new Float32Array(this.gw * this.gh);
    this.S.ropeH = H * 0.46;
  }

  /** Campo de distancia (punto más cercano) del texto, calculado por propagación de dos pasadas. */
  buildTextField(text, fontFamily) {
    const W = this.W, H = this.H;
    const gw = Math.ceil(W / TC), gh = Math.ceil(H / TC);
    const cv = document.createElement('canvas'); cv.width = gw; cv.height = gh;
    const g = cv.getContext('2d', { willReadFrequently: true });
    g.scale(1 / TC, 1 / TC);
    g.fillStyle = '#fff'; g.textAlign = 'center'; g.textBaseline = 'alphabetic';
    g.font = `800 200px ${fontFamily}`;
    const m0 = g.measureText(text);
    let fs = 200 * (W * 0.84) / m0.width;
    fs = Math.min(fs, H * 0.36);
    g.font = `800 ${fs}px ${fontFamily}`;
    const m = g.measureText(text);
    const asc = m.actualBoundingBoxAscent || fs * 0.73;
    const cy = H * 0.44;                       // centro del título (algo por encima del centro)
    g.fillText(text, W / 2, cy + asc / 2);
    const data = g.getImageData(0, 0, gw, gh).data;

    const nx = new Int16Array(gw * gh).fill(-1), ny = new Int16Array(gw * gh).fill(-1);
    for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) if (data[(y * gw + x) * 4 + 3] > 110) { nx[y * gw + x] = x; ny[y * gw + x] = y; }
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
    this.tgw = gw; this.tgh = gh; this.tnx = nx; this.tny = ny;
  }

  setCount(n) { this.count = Math.max(1, Math.min(this.max, n | 0)); this.geometry.setDrawRange(0, this.count); }

  /** t: {mode:0|1, R, rb, ap[], colors[], box:{x,y,hw,hh,cr,rb,color}|null, junction:{x,y,r}, lineL, enabled} */
  setTargets(t) {
    const S = this.S;
    S.mode = t.mode; S.R = t.R; S.rb = t.rb;
    for (let k = 0; k < S.N; k++) S.apT[k] = t.ap[k];
    S.colors = t.colors;
    if (t.box) { S.boxOn = true; S.bx = t.box.x; S.by = t.box.y; S.bhw = t.box.hw; S.bhh = t.box.hh; S.bcr = t.box.cr; S.brb = t.box.rb; S.boxColor = t.box.color; }
    else S.boxOn = false;
    S.jtx = t.junction.x; S.jty = t.junction.y; S.jtr = t.junction.r;
    S.LT = t.lineL; S.lrb = t.lrb || 13;
    this.cursorEnabled = t.enabled;
  }

  _rope(dt, cur) {
    const S = this.S, n = ROPE_N, o = this.ropeO, v = this.ropeV;
    const dy = (2 * S.ropeH) / (n - 1), c2 = (620 / dy) ** 2;
    const steps = 3, h = dt / steps;
    if (cur.valid && S.LT > 50) {
      const cyy = cur.y, cxx = cur.x;
      for (let k = 0; k < n; k++) {
        const ky = -S.ropeH + k * dy, ddy = Math.abs(ky - cyy);
        if (ddy > 130) continue;
        const w = (1 - ddy / 130) ** 2, prox = Math.max(0, 1 - Math.abs(cxx - o[k]) / 170);
        const wp = w * prox;
        v[k] += cur.vx * 0.16 * wp;
        v[k] += (Math.max(-170, Math.min(170, cxx)) - o[k]) * 14 * wp * dt;
      }
    }
    const damp = Math.exp(-1.4 * h);
    for (let s = 0; s < steps; s++) {
      for (let k = 1; k < n - 1; k++) v[k] += (c2 * (o[k - 1] + o[k + 1] - 2 * o[k]) - 5 * o[k]) * h;
      for (let k = 1; k < n - 1; k++) { v[k] *= damp; o[k] += v[k] * h; }
      o[0] = o[n - 1] = 0; v[0] = v[n - 1] = 0;
    }
  }

  /** cur: {x,y,vx,vy,speed,valid} en coordenadas centradas (y hacia arriba), px/s */
  update(dt, t, cur) {
    const S = this.S, W = this.W, H = this.H, n = this.count;
    const ka = 1 - Math.exp(-8 * dt), kj = 1 - Math.exp(-14 * dt), kl = 1 - Math.exp(-5 * dt);
    for (let k = 0; k < S.N; k++) {
      S.ap[k] += (S.apT[k] - S.ap[k]) * ka;
      S.sinA[k] = Math.sin(S.ap[k]); S.cosA[k] = Math.cos(S.ap[k]);
    }
    if (S.jr < 1.5 && S.jtr > 1.5) { S.jx = S.jtx; S.jy = S.jty; }
    S.jx += (S.jtx - S.jx) * kj; S.jy += (S.jty - S.jy) * kj; S.jr += (S.jtr - S.jr) * kj;
    S.L += (S.LT - S.L) * kl;
    this._rope(dt, cur);

    // --- rejilla de densidad ---
    const gw = this.gw, gh = this.gh, D0 = this.D0, D1 = this.D1, D = this.D;
    D0.fill(0);
    const hW = W * 0.5, hH = H * 0.5, px = this.px, py = this.py, vxA = this.vx, vyA = this.vy, cell = this.cell;
    for (let i = 0; i < n; i++) {
      let gx = ((px[i] + hW) / GRID | 0) + 1, gy = ((py[i] + hH) / GRID | 0) + 1;
      gx = gx < 1 ? 1 : gx > gw - 2 ? gw - 2 : gx; gy = gy < 1 ? 1 : gy > gh - 2 ? gh - 2 : gy;
      const ci = gy * gw + gx; cell[i] = ci; D0[ci]++;
    }
    for (let y = 0; y < gh; y++) for (let x = 1; x < gw - 1; x++) { const i = y * gw + x; D1[i] = D0[i - 1] + 2 * D0[i] + D0[i + 1]; }
    for (let y = 1; y < gh - 1; y++) for (let x = 0; x < gw; x++) { const i = y * gw + x; D[i] = (D1[i - gw] + 2 * D1[i] + D1[i + gw]) * 0.0625; }

    // --- parámetros por frame ---
    const mode = S.mode, damp = Math.exp(-DAMP * dt);
    const cursorOn = this.cursorEnabled && cur.valid && cur.speed > 15;
    const crad = 70 + Math.min(cur.speed * 0.05, 140), crad2 = crad * crad;
    const tgw = this.tgw, tgh = this.tgh, tnx = this.tnx, tny = this.tny;
    const pos = this.pos, col = this.col, gl = this.gl, rnd = this.rnd;
    const white = [1, 1, 1];

    for (let i = 0; i < n; i++) {
      const x = px[i], y = py[i];
      let vx = vxA[i], vy = vyA[i], ax = 0, ay = 0;
      const ci = cell[i], dens = D[ci];

      // repulsión local por gradiente de densidad
      ax -= K_REP * (D[ci + 1] - D[ci - 1]) * 0.5;
      ay -= K_REP * (D[ci + gw] - D[ci - gw]) * 0.5;
      ax += (Math.random() - 0.5) * 36; ay += (Math.random() - 0.5) * 36;

      // atracción hacia el punto más cercano de la geometría objetivo (sin hogar fijo)
      let dist = 0, comp = -1, aId = -1;
      if (mode === 0) {
        let gx = ((x + hW) / TC) | 0, gy = ((hH - y) / TC) | 0;
        gx = gx < 0 ? 0 : gx >= tgw ? tgw - 1 : gx; gy = gy < 0 ? 0 : gy >= tgh ? tgh - 1 : gy;
        const ti = gy * tgw + gx, sx = tnx[ti];
        comp = 4;
        if (sx >= 0) {
          const sy = tny[ti];
          if (sx !== gx || sy !== gy) {
            const dx = (sx + 0.5) * TC - hW - x, dy = hH - (sy + 0.5) * TC - y;
            dist = Math.sqrt(dx * dx + dy * dy);
            const inv = Math.min(dist, 700) / (dist || 1);
            ax += K_SPRING * dx * inv; ay += K_SPRING * dy * inv;
          }
        }
      } else {
        const d = sdfScene(S, x, y);
        comp = compId; aId = arcId;
        if (d < 1e8) {
          if (d > 0) {
            const e = 2, gx = (sdfScene(S, x + e, y) - d) / e, gy = (sdfScene(S, x, y + e) - d) / e;
            const gl_ = Math.sqrt(gx * gx + gy * gy) || 1;
            const pull = Math.min(d + 1, 700);
            ax -= K_SPRING * (gx / gl_) * pull; ay -= K_SPRING * (gy / gl_) * pull;
            dist = d;
          }
        } else comp = -1;
      }

      // fluido del cursor: velocidad direccional + radial proporcional a su rapidez
      if (cursorOn) {
        const dx = x - cur.x, dy = y - cur.y, r2 = dx * dx + dy * dy;
        if (r2 < crad2) {
          const r = Math.sqrt(r2) + 0.001, f = 1 - r / crad, f2 = f * f;
          const rad = cur.speed * 0.28 * f2 / r;
          vx += cur.vx * 0.55 * f2 + dx * rad; vy += cur.vy * 0.55 * f2 + dy * rad;
        }
      }

      vx = (vx + ax * dt) * damp; vy = (vy + ay * dt) * damp;
      const sp2 = vx * vx + vy * vy;
      if (sp2 > 9e6) { const s = 3000 / Math.sqrt(sp2); vx *= s; vy *= s; }
      let nx = x + vx * dt, ny = y + vy * dt;
      const lim = Math.max(W, H) * 1.6;
      if (nx > lim || nx < -lim) { nx = Math.max(-lim, Math.min(lim, nx)); vx *= -0.3; }
      if (ny > lim || ny < -lim) { ny = Math.max(-lim, Math.min(lim, ny)); vy *= -0.3; }
      px[i] = nx; py[i] = ny; vxA[i] = vx; vyA[i] = vy;
      pos[i * 3] = nx; pos[i * 3 + 1] = ny;

      // color: cohesionado → color de la figura/segmento; disperso → coloración topográfica por densidad
      let cr, cg, cb;
      if (comp === 0) { arcColor(S, nx, ny); cr = oR; cg = oG; cb = oB; }
      else if (comp === 1) { const bc = S.boxColor; cr = bc[0]; cg = bc[1]; cb = bc[2]; }
      else if (comp === 2) { arcColor(S, nx, ny); cr = oR; cg = oG; cb = oB; }
      else if (comp === 3) { cr = 0.88; cg = 0.88; cb = 0.9; }
      else { cr = cg = cb = 1; }
      let coh = 1 - (dist - 6) / 70; coh = coh < 0 ? 0 : coh > 1 ? 1 : coh; coh = coh * coh * (3 - 2 * coh);
      if (coh < 0.999) {
        let tt = (dens - 0.5) / 9; tt = tt < 0 ? 0 : tt > 1 ? 1 : tt;
        const sc = tt * 3, si = Math.min(2, sc | 0), sf = sc - si, a = TOPO[si], b = TOPO[si + 1];
        const tr = a[0] + (b[0] - a[0]) * sf, tg = a[1] + (b[1] - a[1]) * sf, tb = a[2] + (b[2] - a[2]) * sf;
        cr = tr + (cr - tr) * coh; cg = tg + (cg - tg) * coh; cb = tb + (cb - tb) * coh;
      }
      col[i * 3] = cr; col[i * 3 + 1] = cg; col[i * 3 + 2] = cb;

      // glifo según densidad de tinta local
      let gi = dens * 0.55 + rnd[i] * 5;
      gl[i] = gi > 8.99 ? 8 : gi | 0;
    }
    this.aPos.needsUpdate = true; this.aCol.needsUpdate = true; this.aGl.needsUpdate = true;
  }
}
