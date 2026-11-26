// main.js — orquestador: máquina de estados, proyección radial del «arito» (+30 % diámetro, escala por posición e independiente),
// acoplamiento del campo de empuje al vídeo del «arito», DETAIL_RECT estable y agujero negro gravitacional en HERO_TEXT.
import * as THREE from 'three';
import { GRID_CELL_SIZE, QUAD_VS, BG_FS, BOX_FS, createGlyphAtlas } from './shaders.js';
import { PHYSICS_CONFIG, ParticleSystem, centerAngle, boundaryAngle, segmentAt, wrapAngle } from './particles.js';
import { VideoManager } from './videoManager.js';

/* ===================== CONFIGURACIÓN EDITABLE ===================== */
const CONTACT_EMAIL = '[correo-pendiente@ejemplo.com]';
const BASE_BG = [0x12 / 255, 0x13 / 255, 0x15 / 255];
const CLIP_LEN = 3.5, CROSSFADE = 0.8;       // clips del hero
const HERO_EXIT = 0.18, HERO_ENTER = 0.12;   // umbral de scroll (fracción de viewport)
const RING_MID = 0.88;                       // punto medio / zona de reposo de Sección 2 (arma la compresión al subir)
const ABOUT_ENTER = 1.40, ABOUT_EXIT = 1.30;
const PREVIEW_OPEN_S = 0.42, DETAIL_OPEN_S = 0.55, SCROLL_COOLDOWN_MS = 650, VIDEO_OPEN_S = 0.42;
const BG_SWITCH_S = 0.6;
const TINT_MAX = 0.07, TINT_RATE = 3.7;
const PREVIEW_R_BASE = 0.42;
const PREVIEW_R_MAX = PREVIEW_R_BASE * 1.30; // +30 % en diámetro máximo en el punto medio del segmento
const MIN_VIDEO_PX = 4;                      // por debajo de 4 px deja de renderizarse el vídeo del arito
const RING_RB = 19.4;                        // grosor +14 % sobre el aro principal anterior
const PREVIEW_RB = 10.4;                     // grosor +14 % sobre el contorno del «arito» (proporcionalmente más fino)
const DETAIL_RB = 18, DETAIL_OFF = 18;
const BG_RING_LEVEL = 0.40;
const MAG_RADIUS = 135;

export const STATE = Object.freeze({
  HERO_TEXT: 'HERO_TEXT', RING_IDLE: 'RING_IDLE', RING_JUNCTION: 'RING_JUNCTION',
  RING_PREVIEW: 'RING_PREVIEW', DETAIL_RECT: 'DETAIL_RECT', ABOUT_DIVIDER: 'ABOUT_DIVIDER',
});
const RING_STATES = new Set([STATE.RING_IDLE, STATE.RING_JUNCTION, STATE.RING_PREVIEW]);

const $ = (s) => document.querySelector(s);
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const clamp01 = (x) => clamp(x, 0, 1);
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const expK = (rate, dt) => 1 - Math.exp(-rate * dt);

function fatal(msg) { const el = $('#fatal'); el.textContent = msg; el.hidden = false; }

async function boot() {
  let projects;
  try {
    const res = await fetch('data/projects.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(res.status);
    projects = await res.json();
  } catch (e) {
    fatal('No se pudo cargar data/projects.json. Sirve el sitio por HTTP (GitHub Pages o un servidor local), no con file://.');
    return;
  }
  const canvas = $('#gl');
  const gl2 = canvas.getContext('webgl2', { antialias: false, alpha: false, powerPreference: 'high-performance' });
  if (!gl2) { fatal('Este portafolio necesita WebGL2.'); return; }
  const FONT = '"JetBrains Mono","Space Mono",monospace';
  try { await Promise.race([Promise.all([document.fonts.load(`800 64px ${FONT}`), document.fonts.load(`700 32px ${FONT}`)]), new Promise(r => setTimeout(r, 2500))]); } catch (e) { /* fallback */ }
  start(projects, canvas, gl2, FONT);
}

function start(projects, canvas, gl2, FONT) {
  const N = projects.length;
  const SEG = (Math.PI * 2) / N;
  const BORDER_DEAD_RAD = 3.5 * Math.PI / 180;         // ±3.5° exclusiva para la delgada frontera divisoria
  const BORDER_DEAD_F = BORDER_DEAD_RAD / SEG;
  const ACTIVE_HALF = SEG * 0.5 - BORDER_DEAD_RAD;     // rango angular activo original [thetaStart_k, thetaEnd_k] del segmento

  const renderer = new THREE.WebGLRenderer({ canvas, context: gl2, antialias: false, alpha: false });
  renderer.setClearColor(new THREE.Color().setRGB(BASE_BG[0], BASE_BG[1], BASE_BG[2]), 1);
  const dpr = Math.min(window.devicePixelRatio || 1, 1.75);
  renderer.setPixelRatio(dpr);

  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const atlas = createGlyphAtlas(THREE, PHYSICS_CONFIG.charset);
  const videos = new VideoManager(projects);

  // --- fondo (malla ASCII unificada con GRID_CELL_SIZE, sin warp UV) ---
  const bgMat = new THREE.ShaderMaterial({
    vertexShader: QUAD_VS, fragmentShader: BG_FS, depthTest: false, depthWrite: false,
    uniforms: {
      tA: { value: videos.getTexture(0) }, tB: { value: videos.getTexture(0) }, tAtlas: { value: atlas },
      uMix: { value: 0 }, uRes: { value: new THREE.Vector2(1, 1) }, uCell: { value: GRID_CELL_SIZE }, uDpr: { value: dpr }, uTime: { value: 0 },
      uBgAmt: { value: 1 }, uBgLive: { value: 1 }, uBase: { value: new THREE.Vector3(...BASE_BG) },
      uTint: { value: new THREE.Vector3(...BASE_BG) }, uTintAmt: { value: 0 }, uVAspect: { value: 16 / 9 },
    },
  });
  const bgMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), bgMat);
  bgMesh.frustumCulled = false; bgMesh.renderOrder = 0;
  scene.add(bgMesh);

  // --- caja de vídeo (arito / rectángulo) ---
  const boxMat = new THREE.ShaderMaterial({
    vertexShader: QUAD_VS, fragmentShader: BOX_FS, transparent: true, depthTest: false, depthWrite: false,
    uniforms: {
      tVideo: { value: videos.getTexture(0) }, tAtlas: { value: atlas },
      uCenter: { value: new THREE.Vector2() }, uHalf: { value: new THREE.Vector2(1, 1) }, uCorner: { value: 0 },
      uSoft: { value: 24 }, uMosaic: { value: 1 }, uVAspect: { value: 16 / 9 },
      uMagPos: { value: new THREE.Vector2() }, uMagR: { value: 0 }, uPulse: { value: 0 },
      uGridCell: { value: PHYSICS_CONFIG.cellSize }, uDpr: { value: dpr }, uTime: { value: 0 }, uAlpha: { value: 0 },
    },
  });
  const boxMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), boxMat);
  boxMesh.frustumCulled = false; boxMesh.renderOrder = 1; boxMesh.visible = false;
  scene.add(boxMesh);

  // --- partículas ---
  const cores = navigator.hardwareConcurrency || 4;
  const pc = PHYSICS_CONFIG.particleCount;
  const ps = new ParticleSystem({ atlas, N, count: cores >= 8 ? pc.high : cores >= 4 ? pc.mid : pc.low });
  scene.add(ps.mesh);

  /* ===================== ESTADO ===================== */
  let W = 1, H = 1, R_base = 300, R = 300;
  let state = STATE.HERO_TEXT, booted = false;
  let heroOver = false, aboutOver = false, scrollP = 0;
  let hasReachedRingMidpoint = false, compressP = 0, chargeSm = 0;
  let previewId = -1, previewWanted = false, detailP = 0, detailWanted = false, mosaicT = 1;
  // escala de apertura independiente por proyecto (evita heredar tamaño residual al cambiar rápido entre segmentos)
  const entryScale = new Float32Array(N);
  let previewTheta = Math.PI / 2, previewThetaTarget = Math.PI / 2;
  let prevAritoX = 0, prevAritoY = 0, prevAritoOn = false;
  // temporizador adaptativo por velocidad y conquista visual del aro (dwellProgress ∈ [0, 1])
  let hoveredSegmentId = -1, dwellProgress = 0, cursorOnHoveredSeg = false;
  let textPosX = 0, textPosY = 0, textPosInit = false;
  let cursorWasInsideRect = false;
  const junction = { idx: -1 };
  let scrollLockUntil = 0;
  let tintAmt = 0; const tintCol = [...BASE_BG];
  let magX = 0, magY = 0, magR = 0, pulse = 0;
  let focusId = -1, bgFrom = 0, bgTo = 0, bgT = 1, lastShown = 0;
  let curBgA = 0, curBgB = 0, curBgMix = 0;

  // estado del agujero negro en HERO_TEXT
  let bhMode = 'idle';          // 'idle' | 'active' | 'restoring'
  let bhBgCaptured = false, bhDomCaptured = false;
  let bhBgLive = 1;             // 1 → fondo vivo normal, 0 → vacío #000000 al sustituirse por partículas 1:1
  let bhDomAlpha = 1;           // opacidad multiplicativa de #hero-sub y #scroll-hint

  const cur = { x: 0, y: 0, px: 0, py: 0, sx: 0, sy: 0, vx: 0, vy: 0, speed: 0, valid: false };
  let accDx = 0, accDy = 0, lastClientX = null, lastClientY = null;

  const bodyEl = document.body;
  const detailEl = $('#detail'), detailHint = $('#detail-hint');
  const previewEl = $('#preview-title'), ptTitle = previewEl.querySelector('.pt-title'), ptConcept = previewEl.querySelector('.pt-concept');
  const heroSub = $('#hero-sub'), scrollHint = $('#scroll-hint');
  let scrollHintLabel = 'SCROLL ↓', scrollHintFade = 1;

  const isScrollLocked = () => state === STATE.DETAIL_RECT || bhMode !== 'idle' || performance.now() < scrollLockUntil;

  function setState(s) {
    if (s === state) return;
    const prev = state;
    state = s; bodyEl.dataset.state = s;
    if (!booted) {
      if (s !== STATE.HERO_TEXT) ps.clearExplicitTargets();
      return;
    }
    if (prev === STATE.HERO_TEXT && s !== STATE.HERO_TEXT) {
      // bajada ALYSAURIO → Aro: siempre a 100 % del radio normal sin compresión previa
      ps.foldHeroToRing(R_base, RING_RB);
    } else if (prev !== STATE.HERO_TEXT && s === STATE.HERO_TEXT) {
      if (hasReachedRingMidpoint) {
        // detonación explosiva desde el aro comprimido al 50 % → reconstrucción limpia sin elasticidad
        hasReachedRingMidpoint = false; compressP = 0; chargeSm = 0; R = R_base;
        previewWanted = false; previewId = -1; entryScale.fill(0); junction.idx = -1;
        hoveredSegmentId = -1; dwellProgress = 0;
        ps.detonateToHero();
      } else {
        ps.burstToHero();
      }
    } else if (prev === STATE.DETAIL_RECT && s !== STATE.DETAIL_RECT) {
      ps.clearExplicitTargets();
      cursorWasInsideRect = false;
    } else if (s === STATE.ABOUT_DIVIDER) {
      updateAboutBounds();
      ps.distributeCandle(aboutHalfL, aboutMidY);
    } else if (prev === STATE.ABOUT_DIVIDER) {
      ps.clearExplicitTargets();
    }
  }

  let aboutHalfL = 240, aboutMidY = 0;
  function updateAboutBounds() {
    // anclaje preciso justo sobre SCROLL ↑ (scrollRect.top - 18, respaldo seguro H - 82 px)
    const rect = scrollHint ? scrollHint.getBoundingClientRect() : null;
    const baseCss = (rect && rect.height > 1 && rect.top > 40) ? Math.min(H - 82, rect.top - 18) : (H - 82);
    const topCss = H * 0.11;
    const flameBaseY = H * 0.5 - baseCss;
    const flameTopY = H * 0.5 - topCss;
    aboutHalfL = Math.max(90, (flameTopY - flameBaseY) * 0.5);
    aboutMidY = (flameTopY + flameBaseY) * 0.5;
  }

  function resize() {
    W = window.innerWidth; H = window.innerHeight;
    renderer.setSize(W, H, false);
    R_base = Math.min(Math.min(W, H) * 0.31, 340);
    R = R_base * (1 - 0.50 * chargeSm);
    bgMat.uniforms.uRes.value.set(W, H);
    ps.resize(W, H, dpr);
    ps.buildTextField('ALYSAURIO', FONT);
    updateAboutBounds();
    previewEl.dataset.id = ''; textPosInit = false;
    onScroll();
  }
  let rzT = 0;
  window.addEventListener('resize', () => { clearTimeout(rzT); rzT = setTimeout(resize, 120); });
  function onScroll() { if (bhMode === 'idle') scrollP = window.scrollY / Math.max(1, window.innerHeight); }
  window.addEventListener('scroll', onScroll, { passive: true });

  /* ===================== AGUJERO NEGRO EN HERO_TEXT ===================== */
  /** Captura 1:1 del fondo ASCII sobre la grilla compartida (gridCols × gridRows) con el mismo recorte coverUV que BG_FS. */
  function spawnHeroBgReplicas() {
    const cs = GRID_CELL_SIZE;
    const gw = Math.ceil(W / cs), gh = Math.ceil(H / cs);
    const cv = document.createElement('canvas'); cv.width = gw; cv.height = gh;
    const g = cv.getContext('2d', { willReadFrequently: true });
    const va = 16 / 9, ba = W / Math.max(1, H);
    const drawCover = (src) => {
      if (!src) return null;
      const sw0 = src.videoWidth || src.width || 512, sh0 = src.videoHeight || src.height || 288;
      let sx = 0, sy = 0, sw = sw0, sh = sh0;
      if (ba > va) { sh = sh0 * (va / ba); sy = (sh0 - sh) * 0.5; }
      else         { sw = sw0 * (ba / va); sx = (sw0 - sw) * 0.5; }
      try { g.drawImage(src, sx, sy, sw, sh, 0, 0, gw, gh); return g.getImageData(0, 0, gw, gh).data; }
      catch (e) { return null; }
    };
    const dataA = drawCover(videos.getSource(curBgA));
    const dataB = (curBgMix > 0.02 && curBgB !== curBgA) ? drawCover(videos.getSource(curBgB)) : null;

    // 1a pasada: recoge celdas visibles (omite celdas oscuras)
    const visible = [];
    for (let row = 0; row < gh; row++) {
      const syCss = row * cs + cs * 0.5;
      const ny = (H - syCss) / Math.max(1, H);
      for (let col = 0; col < gw; col++) {
        const idx = (row * gw + col) * 4;
        let r = dataA ? dataA[idx] / 255 : 0.22, gg = dataA ? dataA[idx + 1] / 255 : 0.22, b = dataA ? dataA[idx + 2] / 255 : 0.25;
        if (dataB) {
          r = lerp(r, dataB[idx] / 255, curBgMix);
          gg = lerp(gg, dataB[idx + 1] / 255, curBgMix);
          b = lerp(b, dataB[idx + 2] / 255, curBgMix);
        }
        const sxCss = col * cs + cs * 0.5;
        const nx = sxCss / Math.max(1, W);
        const vig = 1 - 0.45 * smooth(0.35, 0.95, Math.hypot(nx - 0.5, (ny - 0.5) * 0.9) * 1.6);
        const lum = (0.299 * r + 0.587 * gg + 0.114 * b) * vig;
        if (lum < 0.055) continue;
        visible.push({ x: sxCss - W * 0.5, y: H * 0.5 - syCss, r, g: gg, b, lum });
      }
    }
    // límite de seguridad para 60 FPS en resoluciones muy altas (p. ej. 4K) sin patrón de tablero
    const maxBg = 15200;
    let chosen = visible;
    if (visible.length > maxBg) {
      chosen = [];
      const keep = maxBg / visible.length;
      for (let i = 0; i < visible.length; i++) if (Math.random() < keep) chosen.push(visible[i]);
    }
    ps.addExtraParticles(chosen, true);
    // apaga el fondo vivo en el MISMO fotograma → transición 1:1 invisible hacia partículas reales
    bhBgLive = 0;
  }

  /** Rasteriza subtítulo y SCROLL ↓ en sus coordenadas reales en pantalla y los oculta inmediatamente del DOM. */
  function spawnHeroTextReplicas() {
    const out = [];
    const rasterEl = (el, maxPts) => {
      const rect = el.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) return;
      const cs = getComputedStyle(el);
      const tc = document.createElement('canvas');
      tc.width = Math.ceil(rect.width + 12); tc.height = Math.ceil(rect.height + 8);
      const tg = tc.getContext('2d', { willReadFrequently: true });
      tg.fillStyle = cs.color || '#9A9A9A';
      tg.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      if ('letterSpacing' in tg && cs.letterSpacing && cs.letterSpacing !== 'normal') tg.letterSpacing = cs.letterSpacing;
      tg.textAlign = 'center'; tg.textBaseline = 'top';
      const fs = parseFloat(cs.fontSize) || 16;
      const lh = parseFloat(cs.lineHeight) || fs * 1.5;
      const words = (el.textContent || '').trim().split(/\s+/);
      const lines = [];
      let line = '';
      for (const w of words) {
        const test = line ? `${line} ${w}` : w;
        if (line && tg.measureText(test).width > rect.width) { lines.push(line); line = w; }
        else line = test;
      }
      if (line) lines.push(line);
      const startY = Math.max(0, (tc.height - lines.length * lh) * 0.5);
      lines.forEach((ln, idx) => tg.fillText(ln, tc.width * 0.5, startY + idx * lh));
      const d = tg.getImageData(0, 0, tc.width, tc.height).data;
      const pts = [];
      const step = 4;
      for (let py = 0; py < tc.height; py += step) for (let px = 0; px < tc.width; px += step) {
        const a = d[(py * tc.width + px) * 4 + 3];
        if (a > 60) {
          pts.push({
            x: rect.left - 6 + px - W * 0.5,
            y: H * 0.5 - (rect.top - 4 + py),
            r: 0.80, g: 0.80, b: 0.82, lum: 0.95,
          });
        }
      }
      const stride = pts.length > maxPts ? pts.length / maxPts : 1;
      for (let i = 0; i < pts.length; i += stride) out.push(pts[i | 0]);
    };
    rasterEl(heroSub, 340);
    rasterEl(scrollHint, 120);
    ps.addExtraParticles(out, false);
    bhDomAlpha = 0;
    bodyEl.classList.add('bh-hide-dom');
    scrollHint.style.animation = 'none';
  }

  function releaseBlackHole() {
    if (bhMode !== 'active') return;
    bhMode = 'restoring';
    ps.releaseBlackHole();
  }

  /* ===================== INTERACCIÓN ===================== */
  window.addEventListener('pointermove', (e) => {
    cur.x = e.clientX - W / 2; cur.y = H / 2 - e.clientY; cur.sx = e.clientX; cur.sy = e.clientY;
    if (!cur.valid || lastClientX === null) { cur.px = cur.x; cur.py = cur.y; }
    else { accDx += e.clientX - lastClientX; accDy += e.clientY - lastClientY; }
    lastClientX = e.clientX; lastClientY = e.clientY; cur.valid = true;
  }, { passive: true });
  document.documentElement.addEventListener('mouseleave', () => {
    cur.valid = false; lastClientX = null; cursorWasInsideRect = false;
  });

  window.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    if (state === STATE.HERO_TEXT && scrollP < 0.08 && bhMode === 'idle') {
      if (e.target && e.target.closest && e.target.closest('a,button')) return;
      cur.x = e.clientX - W / 2; cur.y = H / 2 - e.clientY; cur.sx = e.clientX; cur.sy = e.clientY; cur.valid = true;
      bhMode = 'active'; bhBgCaptured = false; bhDomCaptured = false; bhBgLive = 1;
      bodyEl.classList.add('bh-active');
      ps.startBlackHole(cur.x, cur.y);
    }
  });
  window.addEventListener('pointerup', releaseBlackHole);
  window.addEventListener('mouseup', releaseBlackHole);
  window.addEventListener('pointercancel', releaseBlackHole);
  window.addEventListener('blur', releaseBlackHole);
  document.addEventListener('visibilitychange', () => { if (document.hidden) releaseBlackHole(); });

  /* --- proyección radial y escala dinámica del «arito» --- */
  function targetVideoRadiusFor(id, theta) {
    if (id < 0) return 0;
    const mid = centerAngle(id, N);
    const delta = wrapAngle(theta - mid);
    const u = clamp01((delta + ACTIVE_HALF) / (2 * ACTIVE_HALF));
    const posScale = Math.pow(Math.sin(u * Math.PI), 0.72);
    const rVideoMax = PREVIEW_R_MAX * R;
    const prevRb = PREVIEW_RB * lerp(1.0, 0.72, chargeSm);
    const distToSegBorder = Math.max(0, SEG * 0.5 - Math.abs(delta));
    const rGeoLimit = Math.max(0, R * Math.sin(Math.min(Math.PI * 0.49, distToSegBorder)) - prevRb);
    return Math.min(rVideoMax * posScale, rGeoLimit);
  }

  function currentVideoRadius() {
    if (previewId < 0) return 0;
    return targetVideoRadiusFor(previewId, previewTheta) * easeOutCubic(entryScale[previewId]);
  }

  function aritoGeom() {
    return { x: Math.cos(previewTheta) * R, y: Math.sin(previewTheta) * R, r: currentVideoRadius() };
  }
  function boxGeom() {                   // rectángulo de detalle 16:9, desplazado a la derecha
    const hh = Math.min(H * 0.36, W * 0.30 * 9 / 16), hw = hh * 16 / 9;
    return { x: W * 0.44 - hw, y: 0, hw, hh, cr: 26 };
  }
  function currentBox() {
    if (previewId < 0) return null;
    const d = easeInOutCubic(detailP);
    const a = aritoGeom(), t = boxGeom();
    const hw = lerp(a.r, t.hw, d), hh = lerp(a.r, t.hh, d);
    if (d < 0.01 && a.r < MIN_VIDEO_PX) return null;
    if (hw < 2 && d < 0.01) return null;
    return { x: lerp(a.x, t.x, d), y: lerp(a.y, t.y, d), hw, hh, cr: Math.min(lerp(a.r, t.cr, d), hw, hh), vidR: a.r };
  }
  function cursorInsideBox() {
    const b = currentBox(); if (!b) return false;
    const qx = Math.abs(cur.x - b.x) - b.hw + b.cr, qy = Math.abs(cur.y - b.y) - b.hh + b.cr;
    return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - b.cr < 0;
  }
  function cursorInArito() {
    if (previewId < 0) return false;
    const a = aritoGeom();
    return a.r >= MIN_VIDEO_PX && Math.hypot(cur.x - a.x, cur.y - a.y) < a.r;
  }

  /* --- texto dentro de la cavidad libre del aro, opuesto a theta_preview actual (soporta títulos largos multilínea +2 px) --- */
  function cavityLayout(id, theta, aritoR) {
    const dx = Math.cos(theta), dy = Math.sin(theta);
    const ax = dx * R, ay = dy * R;
    const title = projects[id].title || '', concept = projects[id].shortConcept || '';
    const maxWord = title.split(/\s+/).reduce((m, w) => Math.max(m, w.length), 1);
    const inner = R - RING_RB - 16;
    const aritoClear = aritoR + PREVIEW_RB + 16;
    const baseT = clamp(R * 0.088 + 2, 15, 27);
    const baseC = clamp(R * 0.042 + 2, 12.5, 15.5);

    for (let scale = 1.0; scale >= 0.72; scale -= 0.08) {
      const fsT = baseT * scale, fsC = Math.max(12, baseC * (0.5 + 0.5 * scale));
      for (let wb = R * 1.26; wb >= R * 0.48; wb -= R * 0.04) {
        if (maxWord * fsT * 0.66 > wb && scale > 0.75) continue;
        const tLines = Math.max(1, Math.ceil((title.length * fsT * 0.68) / wb));
        const cLines = Math.min(4, Math.max(1, Math.ceil((concept.length * fsC * 0.62) / wb)));
        const hb = tLines * fsT * 1.32 + 10 + cLines * fsC * 1.52;
        for (let s = 0; s <= R * 0.74; s += R * 0.03) {
          const cx = -dx * s, cy = -dy * s;
          let ok = true;
          for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
            const x = cx + sx * wb / 2, y = cy + sy * hb / 2;
            if (Math.hypot(x, y) > inner || Math.hypot(x - ax, y - ay) < aritoClear) ok = false;
          }
          if (ok) return { cx, cy, w: wb, fsT, fsC };
        }
      }
    }
    return { cx: -dx * R * 0.36, cy: -dy * R * 0.36, w: R * 0.56, fsT: baseT * 0.72, fsC: 12.5 };
  }

  function openDetail() {
    if (previewId < 0) return;
    const p = projects[previewId];
    $('#d-title').textContent = p.title;
    $('#d-desc').textContent = p.fullDescription;
    const wrap = $('#d-repo-wrap'); wrap.textContent = '';
    const addLink = (url, label) => {
      if (!url || !url.trim()) return;
      const a = document.createElement('a');
      a.href = url.trim(); a.target = '_blank'; a.rel = 'noopener noreferrer';
      a.textContent = `${label} ↗`;
      wrap.appendChild(a);
    };
    addLink(p.playUrl, (p.playLabel && p.playLabel.trim()) || 'JUGAR');
    addLink(p.repoUrl, (p.repoLabel && p.repoLabel.trim()) || 'REPOSITORIO GITHUB');
    detailWanted = true; previewWanted = true;
    cursorWasInsideRect = false;
    setState(STATE.DETAIL_RECT);
    ps.distributeRect(boxGeom(), DETAIL_OFF, DETAIL_RB);
    detailEl.classList.add('open'); detailHint.classList.add('open'); detailEl.setAttribute('aria-hidden', 'false');
  }
  function closeDetail() {
    if (state !== STATE.DETAIL_RECT) return;
    detailWanted = false;
    scrollLockUntil = performance.now() + SCROLL_COOLDOWN_MS;
    detailEl.classList.remove('open'); detailHint.classList.remove('open'); detailEl.setAttribute('aria-hidden', 'true');
    setState(STATE.RING_IDLE);
  }

  window.addEventListener('click', (e) => {
    if (state === STATE.DETAIL_RECT) {
      if (e.target.closest && e.target.closest('#d-repo-wrap a')) return;
      if (!cursorInsideBox()) closeDetail();
      return;
    }
    if (state === STATE.RING_PREVIEW && previewId >= 0 && entryScale[previewId] > 0.35 && cursorInArito()) {
      openDetail();
    } else if (state === STATE.RING_IDLE && cursorOnHoveredSeg && hoveredSegmentId >= 0 && cur.valid) {
      // atajo por clic sobre un segmento en RING_IDLE → completa la conquista y abre RING_PREVIEW al instante
      dwellProgress = 1.0;
      openPreviewSegment(hoveredSegmentId);
    }
  });
  window.addEventListener('wheel', (e) => {
    if (bhMode !== 'idle') { e.preventDefault(); return; }
    if (state === STATE.DETAIL_RECT) { e.preventDefault(); if (Math.abs(e.deltaY) > 0) closeDetail(); return; }
    if (performance.now() < scrollLockUntil) e.preventDefault();
  }, { passive: false });
  window.addEventListener('touchmove', (e) => { if (isScrollLocked()) e.preventDefault(); }, { passive: false });
  window.addEventListener('keydown', (e) => {
    if (bhMode !== 'idle' && [' ', 'PageDown', 'PageUp', 'ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) { e.preventDefault(); return; }
    if (e.key === 'Escape') { closeDetail(); return; }
    if (state === STATE.DETAIL_RECT && [' ', 'PageDown', 'PageUp', 'ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) { e.preventDefault(); closeDetail(); }
  });

  $('#email-text').textContent = CONTACT_EMAIL;
  const status = $('#copy-status'); let stT = 0;
  $('#copy-email').addEventListener('click', async () => {
    let ok = false;
    try { await navigator.clipboard.writeText(CONTACT_EMAIL); ok = true; } catch (e) {
      const ta = document.createElement('textarea'); ta.value = CONTACT_EMAIL; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select(); try { ok = document.execCommand('copy'); } catch (_) { /* noop */ } ta.remove();
    }
    status.textContent = ok ? 'COPIADO ✓' : 'NO SE PUDO COPIAR'; status.classList.add('show');
    clearTimeout(stT); stT = setTimeout(() => status.classList.remove('show'), 1700);
  });

  /* ===================== MÁQUINA DE ESTADOS ===================== */
  function updateScrollState() {
    if (state === STATE.DETAIL_RECT || bhMode !== 'idle') return;
    const p = scrollP;
    if (p >= RING_MID) hasReachedRingMidpoint = true;
    if (!heroOver && p > HERO_EXIT) heroOver = true; else if (heroOver && p < HERO_ENTER) heroOver = false;
    if (!aboutOver && p > ABOUT_ENTER) aboutOver = true; else if (aboutOver && p < ABOUT_EXIT) aboutOver = false;
    if (!heroOver) { setState(STATE.HERO_TEXT); previewWanted = false; junction.idx = -1; compressP = 0; }
    else if (aboutOver) { setState(STATE.ABOUT_DIVIDER); previewWanted = false; junction.idx = -1; compressP = 0; }
    else {
      if (state === STATE.HERO_TEXT || state === STATE.ABOUT_DIVIDER) setState(STATE.RING_IDLE);
      // ventana reversible de compresión (solo al subir desde el punto medio de Sección 2 hacia Hero)
      if (hasReachedRingMidpoint && p < RING_MID && p > HERO_ENTER) {
        compressP = clamp01((RING_MID - p) / (RING_MID - HERO_ENTER));
      } else {
        compressP = 0;
      }
    }
  }

  function openPreviewSegment(id) {
    const mid = centerAngle(id, N);
    const proj = mid + clamp(wrapAngle(Math.atan2(cur.y, cur.x) - mid), -ACTIVE_HALF, ACTIVE_HALF);
    if (previewId !== id) {
      previewId = id;
      entryScale[previewId] = 0;
      mosaicT = 0; textPosInit = false; prevAritoOn = false;
      previewTheta = previewThetaTarget = proj;
    } else if (!previewWanted) {
      entryScale[previewId] = 0;
      mosaicT = 0;
      previewTheta = previewThetaTarget = proj;
    }
    previewWanted = true; junction.idx = -1;
    hoveredSegmentId = id; dwellProgress = 1.0;
    setState(STATE.RING_PREVIEW);
  }

  function ringHitTest(dt) {
    if (!RING_STATES.has(state)) {
      cursorOnHoveredSeg = false;
      if (state !== STATE.DETAIL_RECT) { hoveredSegmentId = -1; dwellProgress = 0; }
      return;
    }
    let want = { type: 'none' };
    if (cur.valid) {
      const x = cur.x, y = cur.y, r = Math.hypot(x, y);
      // 1) dentro de la corona activa del aro (límites lógicos originales en reposo; solo excluye ±3.5° de frontera)
      const inBand = Math.abs(r - R) < 0.14 * R + RING_RB;
      if (inBand) {
        const { k, f } = segmentAt(Math.atan2(y, x), N);
        if (f < BORDER_DEAD_F || f > 1 - BORDER_DEAD_F) {
          const jIdx = f < BORDER_DEAD_F ? (k + N - 1) % N : k;
          want = { type: 'junction', idx: jIdx };
        } else {
          want = { type: 'preview', id: k };
        }
      }
      // 2) o dentro del área circular actual del vídeo del «arito» abierto
      if (want.type === 'none' && previewId >= 0 && previewWanted) {
        const a = aritoGeom();
        if (a.r >= MIN_VIDEO_PX && Math.hypot(x - a.x, y - a.y) < a.r + 4) {
          want = { type: 'preview', id: previewId };
        }
      }
    }

    if (want.type === 'preview') {
      cursorOnHoveredSeg = true;
      // si RING_PREVIEW ya está activo en este mismo segmento, mantiene conquista 100 % y «arito» abierto
      if (state === STATE.RING_PREVIEW && previewWanted && previewId === want.id) {
        hoveredSegmentId = want.id; dwellProgress = 1.0;
        return;
      }
      // si cambió de segmento, cierra el anterior y reinicia el contador desde 0 para el nuevo segmento
      if (state === STATE.RING_PREVIEW && previewId !== want.id) {
        previewWanted = false;
        setState(STATE.RING_IDLE);
      }
      if (hoveredSegmentId !== want.id) { hoveredSegmentId = want.id; dwellProgress = 0; }
      // contador continuo de velocidad adaptativa: quieto = 0.35 s, en movimiento ≈ 2.8× más lento
      const moveFactor = clamp01(cur.speed / PHYSICS_CONFIG.dwellSpeedRefPxPerSec);
      const rate = lerp(1.0, 1.0 / PHYSICS_CONFIG.dwellMovingSlowdown, moveFactor);
      dwellProgress = Math.min(1.0, dwellProgress + (dt * 1000 / PHYSICS_CONFIG.dwellBaseDurationMs) * rate);

      if (dwellProgress >= 1.0) {
        // activación automática de RING_PREVIEW al completar la conquista sin requerir clic
        openPreviewSegment(want.id);
      } else {
        previewWanted = false; junction.idx = -1; setState(STATE.RING_IDLE);
      }
    } else {
      cursorOnHoveredSeg = false;
      previewWanted = false;
      // retroceso suave del contador y líneas divisorias hacia sus fronteras originales
      dwellProgress = Math.max(0, dwellProgress - (dt * 1000 / PHYSICS_CONFIG.dwellRetractDurationMs));
      if (dwellProgress <= 0.001) { dwellProgress = 0; hoveredSegmentId = -1; }
      if (want.type === 'junction') {
        junction.idx = want.idx; setState(STATE.RING_JUNCTION);
      } else {
        junction.idx = -1; setState(STATE.RING_IDLE);
      }
    }
  }

  /** Proyección radial casi inmediata sobre R_main restringida a [thetaMin, thetaMax] del segmento activo. */
  function updateRadialProjection(dt) {
    if (previewId < 0) return;
    const mid = centerAngle(previewId, N);
    if (state === STATE.RING_PREVIEW && cur.valid) {
      const curDelta = wrapAngle(Math.atan2(cur.y, cur.x) - mid);
      previewThetaTarget = mid + clamp(curDelta, -ACTIVE_HALF, ACTIVE_HALF);
    } else {
      previewThetaTarget = mid + clamp(wrapAngle(previewThetaTarget - mid), -ACTIVE_HALF, ACTIVE_HALF);
    }
    const k = 1 - Math.exp(-32 * dt);
    const nextDelta = clamp(wrapAngle(previewTheta - mid) + wrapAngle(previewThetaTarget - previewTheta) * k, -ACTIVE_HALF, ACTIVE_HALF);
    previewTheta = mid + nextDelta;
  }

  /* ===================== BUCLE ===================== */
  let last = performance.now(), t = 0, restartedTick = -1;
  const needed = new Set();
  const colorsRef = Array.from({ length: N }, () => [1, 1, 1]);

  function frame(now) {
    requestAnimationFrame(frame);
    // protege dt > 0 en el primer frame para evitar 0/0 = NaN en cur.vx/cur.speed
    const dt = Math.max(1 / 240, Math.min((now - last) / 1000, 1 / 30)); last = now; t += dt;

    // velocidad suavizada del cursor (px/s)
    const kv = expK(25, dt);
    if (!Number.isFinite(cur.vx)) cur.vx = 0;
    if (!Number.isFinite(cur.vy)) cur.vy = 0;
    cur.vx += (accDx / dt - cur.vx) * kv; cur.vy += (-accDy / dt - cur.vy) * kv;
    accDx = accDy = 0;
    cur.speed = Math.hypot(cur.vx, cur.vy);
    if (cur.speed < 5) { cur.vx = cur.vy = 0; cur.speed = 0; }

    updateScrollState();
    // compresión progresiva reversible del radio principal (hasta 50 %) conservando el grosor constante
    const chargeTarget = RING_STATES.has(state) ? Math.pow(compressP, 1.35) : 0;
    chargeSm += (chargeTarget - chargeSm) * expK(18, dt);
    if (chargeSm < 0.001 && chargeTarget === 0) chargeSm = 0;
    R = R_base * (1.0 - 0.50 * chargeSm);
    const previewRbNow = PREVIEW_RB * lerp(1.0, 0.72, chargeSm);

    ringHitTest(dt);
    updateRadialProjection(dt);

    // actualiza escalas de apertura independientes por proyecto
    for (let k = 0; k < N; k++) {
      const active = previewWanted && k === previewId;
      entryScale[k] = clamp01(entryScale[k] + (active ? dt / PREVIEW_OPEN_S : -dt / 0.22));
    }
    detailP = clamp01(detailP + (detailWanted ? dt / DETAIL_OPEN_S : -dt / DETAIL_OPEN_S));
    mosaicT = clamp01(mosaicT + dt / VIDEO_OPEN_S);
    const d = easeInOutCubic(detailP);
    const vidR = currentVideoRadius();

    const conqP = easeInOutCubic(dwellProgress);
    const aritoClickable = state === STATE.RING_PREVIEW && cur.valid && previewId >= 0 && entryScale[previewId] > 0.35 && cursorInArito();
    bodyEl.style.cursor = (aritoClickable || (state === STATE.RING_IDLE && cursorOnHoveredSeg && hoveredSegmentId >= 0)) ? 'pointer' : '';

    // --- fondo reactivo por sección ---
    const bgAmt = (1 - (1 - BG_RING_LEVEL) * smooth(0.14, 0.5, scrollP)) * (1 - smooth(1.15, 1.55, scrollP));
    const bi = Math.floor(t / CLIP_LEN) % N, bj = (bi + 1) % N, local = t % CLIP_LEN;
    const cross = N > 1 ? smooth(CLIP_LEN - CROSSFADE, CLIP_LEN, local) : 0;
    let bgA, bgB, bgMix;
    if (state === STATE.HERO_TEXT) {
      bgA = bi; bgB = bj; bgMix = cross; lastShown = cross > 0.5 ? bj : bi; bgFrom = bgTo = lastShown; bgT = 1; focusId = -1;
      const tick = Math.floor(t / CLIP_LEN);
      if (N > 1 && local >= CLIP_LEN - CROSSFADE && restartedTick !== tick) { restartedTick = tick; videos.restart(bj); }
    } else {
      if (focusId < 0) focusId = lastShown;
      if (previewWanted && previewId >= 0) focusId = previewId;
      if (focusId !== bgTo) { bgFrom = bgTo; bgTo = focusId; bgT = 0; }
      bgT = clamp01(bgT + dt / BG_SWITCH_S);
      bgA = bgFrom; bgB = bgTo; bgMix = easeInOutCubic(bgT);
    }
    curBgA = bgA; curBgB = bgB; curBgMix = bgMix;

    needed.clear();
    if (bgAmt > 0.01 && bhBgLive > 0.01) { needed.add(bgA); needed.add(bgB); }
    const cb = currentBox();
    const boxOn = !!cb && (vidR >= MIN_VIDEO_PX || detailP > 0.01);
    if (boxOn) needed.add(previewId);
    videos.update(t, dt, needed, boxOn ? previewId : -1, PHYSICS_CONFIG.ringColorMode);
    for (let k = 0; k < N; k++) colorsRef[k] = videos.getColor(k);

    // --- cascada temprana de absorción en HERO_TEXT (Etapa 2: textos >= 0.22 · Etapa 3: fondo 1:1 >= 0.55) ---
    const bhs = ps.getBlackHoleState();
    if (bhMode === 'active') {
      if (!bhDomCaptured && bhs.ratio >= 0.22) {
        bhDomCaptured = true;
        spawnHeroTextReplicas();
      }
      if (!bhBgCaptured && bhs.ratio >= 0.55) {
        bhBgCaptured = true;
        spawnHeroBgReplicas();
      }
    } else if (bhMode === 'restoring') {
      const rt = bhs.relTime;
      if (bhBgCaptured) {
        bhBgLive = easeOutCubic(clamp01((rt - 0.24) / 0.62));
      }
      if (bhDomCaptured && rt >= 0.42) {
        bodyEl.classList.remove('bh-hide-dom');
        bhDomAlpha = easeOutCubic(clamp01((rt - 0.42) / 0.48));
      }
      if (!bhs.releasing) {
        bhMode = 'idle'; bhBgCaptured = false; bhDomCaptured = false; bhBgLive = 1; bhDomAlpha = 1;
        bodyEl.classList.remove('bh-active', 'bh-hide-dom');
        scrollHint.style.animation = '';
      }
    }

    // --- arcos asimétricos del aro (el «arito» recorta su tramo en «Y» según su radio dinámico actual) ---
    const arcs = [];
    const ringOn = (RING_STATES.has(state) || state === STATE.DETAIL_RECT) ? (1 - d) : 0;
    if (ringOn > 0.03) {
      const fullHalf = (SEG * 0.5) * 0.992 * ringOn;
      const gamOpen = (previewId >= 0 && vidR >= MIN_VIDEO_PX) ? 2 * Math.asin(Math.min(0.95, vidR / (2 * R))) * 0.92 : 0;
      for (let k = 0; k < N; k++) {
        const mid = centerAngle(k, N);
        if (k === previewId && gamOpen > 0.02) {
          const segStart = mid - fullHalf, segEnd = mid + fullHalf;
          const pOff = mid + wrapAngle(previewTheta - mid);
          const holeL = pOff - gamOpen, holeR = pOff + gamOpen;
          if (holeL - segStart > 0.03) arcs.push({ mid: (segStart + holeL) * 0.5, half: (holeL - segStart) * 0.5 });
          if (segEnd - holeR > 0.03) arcs.push({ mid: (holeR + segEnd) * 0.5, half: (segEnd - holeR) * 0.5 });
        } else {
          arcs.push({ mid, half: fullHalf });
        }
      }
    }

    let box = null;
    if (boxOn) {
      box = {
        x: cb.x, y: cb.y, hw: cb.hw, hh: cb.hh, cr: cb.cr, vidR: cb.vidR,
        rb: lerp(previewRbNow, DETAIL_RB, d), off: lerp(0, DETAIL_OFF, d), d, local: videos.getLocal(previewId),
      };
    }

    const jn = { x: 0, y: 0, r: 0 };
    if (state === STATE.RING_JUNCTION && junction.idx >= 0) {
      const a = boundaryAngle(junction.idx, N), bx = Math.cos(a) * R, by = Math.sin(a) * R;
      jn.x = bx + clamp((cur.x - bx) * 0.35, -14, 14) + Math.sin(t * 5.3) * 3;
      jn.y = by + clamp((cur.y - by) * 0.35, -14, 14) + Math.cos(t * 4.7) * 3;
      jn.r = 32;
    }

    // --- campo de interacción física: acoplado al vídeo del «arito» cuando es visible (> 1 px), o al cursor (~85 px) ---
    let pusher = null;
    const aritoPusherOn = RING_STATES.has(state) && detailP < 0.01 && previewId >= 0 && vidR > 1;
    if (aritoPusherOn) {
      const ax = Math.cos(previewTheta) * R, ay = Math.sin(previewTheta) * R;
      if (!prevAritoOn) { prevAritoX = ax; prevAritoY = ay; }
      const aSpd = Math.min(Math.hypot(ax - prevAritoX, ay - prevAritoY) / Math.max(dt, 1e-3), 4000);
      const aPush = PHYSICS_CONFIG.previewPushMultiplier * (1 + Math.min(0.24, aSpd / 2400));
      pusher = { x: ax, y: ay, px: prevAritoX, py: prevAritoY, radius: vidR, pushScale: aPush };
      prevAritoX = ax; prevAritoY = ay; prevAritoOn = true;
    } else {
      prevAritoOn = false;
      if (RING_STATES.has(state) && cur.valid) {
        const cSpd = Math.min(Math.hypot(cur.x - cur.px, cur.y - cur.py) / Math.max(dt, 1e-3), 6000);
        pusher = { x: cur.x, y: cur.y, px: cur.px, py: cur.py, radius: PHYSICS_CONFIG.cursorRadius + Math.min(cSpd * 0.01, 25), pushScale: 1.0 };
      }
    }

    const curInsideRect = state === STATE.DETAIL_RECT && detailP > 0.85 && cur.valid && cursorInsideBox();

    // límites verticales anclados sobre SCROLL ↑ (calculados en updateAboutBounds)
    const aboutL = state === STATE.ABOUT_DIVIDER ? aboutHalfL : 0;

    ps.setTargets({
      mode: state === STATE.HERO_TEXT ? 0 : 1,
      R, rb: RING_RB, arcs, colors: colorsRef, box, junction: jn,
      lineL: aboutL, lineY: aboutMidY, lrb: 16,
      enabled: RING_STATES.has(state),
      pusher,
      ringActive: RING_STATES.has(state),
      charge: RING_STATES.has(state) ? chargeSm : 0,
      conqSeg: hoveredSegmentId, conqP, conqRawP: dwellProgress,
      isDetail: state === STATE.DETAIL_RECT,
      curInsideRect, curWasInsideRect: cursorWasInsideRect,
    });
    ps.update(dt, t, cur);
    cur.px = cur.x; cur.py = cur.y;
    cursorWasInsideRect = curInsideRect;
    booted = true;

    // --- uniformes de fondo + tinte ambiental (acompaña también la fase de conquista del segmento) ---
    const tintSeg = state === STATE.DETAIL_RECT ? previewId : (hoveredSegmentId >= 0 && dwellProgress > 0.02 ? hoveredSegmentId : (state === STATE.RING_PREVIEW ? previewId : -1));
    const tintTarget = tintSeg >= 0 ? (state === STATE.RING_IDLE ? clamp01(conqP * 0.9) : 1) : 0;
    tintAmt += (tintTarget - tintAmt) * expK(TINT_RATE, dt);
    if (tintSeg >= 0) { const tc = colorsRef[tintSeg], kc = expK(TINT_RATE, dt); for (let c = 0; c < 3; c++) tintCol[c] += (tc[c] - tintCol[c]) * kc; }
    const bu = bgMat.uniforms;
    bu.tA.value = videos.getTexture(bgA); bu.tB.value = videos.getTexture(bgB);
    bu.uMix.value = bgMix; bu.uTime.value = t; bu.uBgAmt.value = bgAmt;
    bu.uBgLive.value = bhBgLive;
    bu.uTint.value.set(tintCol[0], tintCol[1], tintCol[2]);
    bu.uTintAmt.value = tintAmt * TINT_MAX;

    // --- caja de vídeo + escáner ASCII graduado ---
    if (boxOn) {
      boxMesh.visible = true;
      const u = boxMat.uniforms;
      u.tVideo.value = videos.getTexture(previewId);
      u.uCenter.value.set(W / 2 + cb.x, H / 2 + cb.y);
      u.uHalf.value.set(Math.max(cb.hw, 1), Math.max(cb.hh, 1));
      u.uCorner.value = cb.cr;
      u.uSoft.value = lerp(Math.min(26, Math.max(4, cb.vidR * 0.25)), 8, d);
      u.uMosaic.value = 1 - easeOutCubic(mosaicT);
      u.uAlpha.value = d > 0.01 ? 1 : smooth(MIN_VIDEO_PX, MIN_VIDEO_PX + 10, vidR);
      u.uTime.value = t;
      const magOn = state === STATE.DETAIL_RECT && detailP > 0.95 && curInsideRect ? 1 : 0;
      const tx = cur.sx, ty = H - cur.sy;
      if (magR < 2) { magX = tx; magY = ty; }
      const kk = expK(9, dt);
      magX += (tx - magX) * kk; magY += (ty - magY) * kk;
      magR += ((magOn ? MAG_RADIUS : 0) - magR) * kk;
      if (magR < 0.5) magR = 0;
      pulse += (clamp01(cur.speed / 1400) - pulse) * expK(8, dt);
      u.uMagPos.value.set(magX, magY); u.uMagR.value = magR; u.uPulse.value = pulse;
    } else { boxMesh.visible = false; magR = 0; }

    // --- DOM ---
    const heroDomMul = bhDomCaptured ? bhDomAlpha : 1;
    heroSub.style.opacity = String((1 - smooth(0.04, 0.2, scrollP)) * heroDomMul);
    const targetHint = state === STATE.HERO_TEXT ? 'SCROLL ↓' : (state === STATE.ABOUT_DIVIDER ? 'SCROLL ↑' : 'SCROLL ↑↓');
    if (targetHint !== scrollHintLabel) {
      scrollHintFade = Math.max(0, scrollHintFade - dt / 0.09);
      if (scrollHintFade <= 0.001) {
        scrollHintLabel = targetHint;
        scrollHint.textContent = scrollHintLabel;
      }
    } else if (scrollHintFade < 1) {
      scrollHintFade = Math.min(1, scrollHintFade + dt / 0.14);
    }
    const detailHintHide = 1 - smooth(0.0, 0.35, detailP);
    scrollHint.style.opacity = String((state === STATE.HERO_TEXT ? heroDomMul : 1) * detailHintHide * scrollHintFade);
    if (previewId >= 0) {
      const es = entryScale[previewId];
      // si la compresión estrecha la cavidad interior (p > 0.30), atenúa y reduce el texto para evitar cualquier cruce
      const compTextFade = 1 - smooth(0.30, 0.62, compressP);
      const compTextScale = lerp(0.84, 1.0, compTextFade);
      const o = clamp01((es - 0.35) / 0.45) * smooth(MIN_VIDEO_PX, MIN_VIDEO_PX + 24, vidR) * (1 - d) * (state === STATE.DETAIL_RECT ? 0 : 1) * (previewWanted ? 1 : 0) * compTextFade;
      previewEl.style.opacity = String(o);
      if (o > 0.01) {
        const L = cavityLayout(previewId, previewTheta, vidR);
        if (previewEl.dataset.id !== String(previewId)) {
          previewEl.dataset.id = String(previewId);
          ptTitle.textContent = projects[previewId].title; ptConcept.textContent = projects[previewId].shortConcept || '';
        }
        ptTitle.style.fontSize = L.fsT + 'px'; ptConcept.style.fontSize = L.fsC + 'px';
        if (!textPosInit) { textPosX = L.cx; textPosY = L.cy; textPosInit = true; }
        else { const kt = expK(12, dt); textPosX += (L.cx - textPosX) * kt; textPosY += (L.cy - textPosY) * kt; }
        previewEl.style.width = L.w + 'px';
        previewEl.style.maxWidth = L.w + 'px';
        previewEl.style.transform = `translate(${W / 2 + textPosX}px, ${H / 2 - textPosY}px) translate(-50%,-50%) scale(${compTextScale})`;
      }
    } else previewEl.style.opacity = '0';

    renderer.render(scene, camera);
  }

  resize();
  requestAnimationFrame((n) => { last = n; frame(n); });
}

boot();
