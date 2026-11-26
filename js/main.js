// main.js — orquestador: máquina de estados, scroll, aro/arito deslizable con límites estrictos, DETAIL_RECT y bucle de render.
import * as THREE from 'three';
import { QUAD_VS, BG_FS, BOX_FS, createGlyphAtlas } from './shaders.js';
import { PHYSICS_CONFIG, ParticleSystem, centerAngle, boundaryAngle, segmentAt, wrapAngle } from './particles.js';
import { VideoManager } from './videoManager.js';

/* ===================== CONFIGURACIÓN EDITABLE ===================== */
const CONTACT_EMAIL = '[correo-pendiente@ejemplo.com]';
const BASE_BG = [0x12 / 255, 0x13 / 255, 0x15 / 255];
const CLIP_LEN = 3.5, CROSSFADE = 0.8;       // clips del hero
const HERO_EXIT = 0.18, HERO_ENTER = 0.12;   // umbral de scroll (fracción de viewport)
const ABOUT_ENTER = 1.40, ABOUT_EXIT = 1.30;
const JUNCTION_MARGIN = 0.10;                // 10 % del arco junto a cada frontera
const PREVIEW_OPEN_S = 0.5, DETAIL_OPEN_S = 0.55, SCROLL_COOLDOWN_MS = 650, VIDEO_OPEN_S = 0.42;
const BG_SWITCH_S = 0.6;                     // crossfade del fondo al cambiar de segmento enfocado
const TINT_MAX = 0.07, TINT_RATE = 3.7;      // 6–8 %, ≈ 800 ms
const PREVIEW_R = 0.42;                      // R_preview / R_main nominal (0.40–0.44)
const RING_RB = 17;                          // grosor +30 % (antes 13 → 16.9 ≈ 17)
const PREVIEW_RB = 9.1;                      // grosor +30 % del arito (antes 7 → 9.1), más delgado que el aro principal
const DETAIL_RB = 18, DETAIL_OFF = 18;       // marco perimetral del rectángulo de detalle
const BG_RING_LEVEL = 0.40;                  // visibilidad del fondo en Sección 2 respecto al Hero (35–45 %)
const MAG_RADIUS = 135;                      // px, escáner ASCII graduado

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
  const renderer = new THREE.WebGLRenderer({ canvas, context: gl2, antialias: false, alpha: false });
  renderer.setClearColor(new THREE.Color().setRGB(BASE_BG[0], BASE_BG[1], BASE_BG[2]), 1);
  const dpr = Math.min(window.devicePixelRatio || 1, 1.75);
  renderer.setPixelRatio(dpr);

  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const atlas = createGlyphAtlas(THREE, PHYSICS_CONFIG.charset);
  const videos = new VideoManager(projects);

  // --- fondo (filtro ASCII + tinte + grano) ---
  const bgMat = new THREE.ShaderMaterial({
    vertexShader: QUAD_VS, fragmentShader: BG_FS, depthTest: false, depthWrite: false,
    uniforms: {
      tA: { value: videos.getTexture(0) }, tB: { value: videos.getTexture(0) }, tAtlas: { value: atlas },
      uMix: { value: 0 }, uRes: { value: new THREE.Vector2(1, 1) }, uDpr: { value: dpr }, uTime: { value: 0 },
      uBgAmt: { value: 1 }, uSimplify: { value: 1 }, uBase: { value: new THREE.Vector3(...BASE_BG) },
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

  // --- partículas (pool fijo y conservado) ---
  const cores = navigator.hardwareConcurrency || 4;
  const pc = PHYSICS_CONFIG.particleCount;
  const ps = new ParticleSystem({ atlas, N, count: cores >= 8 ? pc.high : cores >= 4 ? pc.mid : pc.low });
  scene.add(ps.mesh);

  /* ===================== ESTADO ===================== */
  let W = 1, H = 1, R = 300;
  let state = STATE.HERO_TEXT, booted = false;
  let heroOver = false, aboutOver = false, scrollP = 0;
  let previewId = -1, previewWanted = false, previewP = 0, detailP = 0, detailWanted = false, mosaicT = 1;
  // ángulo dinámico del «arito» deslizable dentro del segmento activo
  let previewTheta = Math.PI / 2, previewThetaTarget = Math.PI / 2, previewThetaVel = 0;
  let textPosX = 0, textPosY = 0, textPosInit = false;
  let cursorWasInsideRect = false;
  const junction = { idx: -1 };
  let scrollLockUntil = 0;
  let tintAmt = 0; const tintCol = [...BASE_BG];
  let magX = 0, magY = 0, magR = 0, pulse = 0;
  let focusId = -1, bgFrom = 0, bgTo = 0, bgT = 1, lastShown = 0;
  const cur = { x: 0, y: 0, px: 0, py: 0, sx: 0, sy: 0, vx: 0, vy: 0, speed: 0, valid: false };
  let accDx = 0, accDy = 0, lastClientX = null, lastClientY = null;

  const bodyEl = document.body;
  const detailEl = $('#detail'), detailHint = $('#detail-hint');
  const previewEl = $('#preview-title'), ptTitle = previewEl.querySelector('.pt-title'), ptConcept = previewEl.querySelector('.pt-concept');
  const heroSub = $('#hero-sub'), scrollHint = $('#scroll-hint');

  function setState(s) {
    if (s === state) return;
    const prev = state;
    state = s; bodyEl.dataset.state = s;
    if (!booted) {
      if (s !== STATE.HERO_TEXT) ps.clearExplicitTargets();
      return;
    }
    if (prev === STATE.HERO_TEXT && s !== STATE.HERO_TEXT) {
      // transición específica ALYSAURIO → Aro: plegado bilateral y estiramiento en arco → compactación violenta
      ps.foldHeroToRing(R, RING_RB);
    } else if (prev !== STATE.HERO_TEXT && s === STATE.HERO_TEXT) {
      // retorno Aro → ALYSAURIO: reconstrucción al 100 % de volumen y nitidez
      ps.burstToHero();
    } else if (prev === STATE.DETAIL_RECT && s !== STATE.DETAIL_RECT) {
      ps.clearExplicitTargets();
      cursorWasInsideRect = false;
    } else if (s === STATE.ABOUT_DIVIDER) {
      ps.clearExplicitTargets();
    }
  }

  function resize() {
    W = window.innerWidth; H = window.innerHeight;
    renderer.setSize(W, H, false);
    R = Math.min(Math.min(W, H) * 0.31, 340);
    bgMat.uniforms.uRes.value.set(W, H);
    ps.resize(W, H, dpr);
    ps.buildTextField('ALYSAURIO', FONT);
    previewEl.dataset.id = ''; textPosInit = false;
    onScroll();
  }
  let rzT = 0;
  window.addEventListener('resize', () => { clearTimeout(rzT); rzT = setTimeout(resize, 120); });
  function onScroll() { scrollP = window.scrollY / Math.max(1, window.innerHeight); }
  window.addEventListener('scroll', onScroll, { passive: true });

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

  /* --- geometría paramétrica y límites estrictos del «arito» deslizable --- */
  function previewBounds() {
    const borderMargin = Math.min(0.045, SEG * 0.03);
    const maxHalfArc = Math.max(0.08, SEG * 0.5 - borderMargin);
    let rPrev = PREVIEW_R * R;
    let halfArc = Math.asin(Math.min(0.95, (rPrev + PREVIEW_RB) / R));
    // si N crece y estrecha el segmento, escala R_preview y centra en theta_mid → cero invasión de vecinos
    if (halfArc > maxHalfArc) {
      rPrev = Math.max(22, R * Math.sin(maxHalfArc) - PREVIEW_RB);
      halfArc = maxHalfArc;
    }
    const deltaMax = Math.max(0, SEG * 0.5 - halfArc - borderMargin);
    return { rPrev, halfArc, deltaMax };
  }

  function clampThetaToSegment(id, rawAngle) {
    const mid = centerAngle(id, N);
    const { deltaMax } = previewBounds();
    return mid + clamp(wrapAngle(rawAngle - mid), -deltaMax, deltaMax);
  }

  function aritoGeom(e) {
    const { rPrev } = previewBounds();
    return { x: Math.cos(previewTheta) * R, y: Math.sin(previewTheta) * R, r: rPrev * e };
  }
  function boxGeom() {                   // rectángulo de detalle 16:9, desplazado a la derecha
    const hh = Math.min(H * 0.36, W * 0.30 * 9 / 16), hw = hh * 16 / 9;
    return { x: W * 0.44 - hw, y: 0, hw, hh, cr: 26 };
  }
  function currentBox() {
    if (previewId < 0) return null;
    const e = easeOutCubic(previewP), d = easeInOutCubic(detailP);
    const a = aritoGeom(e), t = boxGeom();
    const hw = lerp(a.r, t.hw, d), hh = lerp(a.r, t.hh, d);
    if (hw < 2 && d < 0.01) return null;
    return { x: lerp(a.x, t.x, d), y: lerp(a.y, t.y, d), hw, hh, cr: Math.min(lerp(a.r, t.cr, d), hw, hh) };
  }
  function cursorInsideBox() {
    const b = currentBox(); if (!b) return false;
    const qx = Math.abs(cur.x - b.x) - b.hw + b.cr, qy = Math.abs(cur.y - b.y) - b.hh + b.cr;
    return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - b.cr < 0;
  }
  function cursorInArito() {
    if (previewId < 0) return false;
    const a = aritoGeom(easeOutCubic(previewP));
    return Math.hypot(cur.x - a.x, cur.y - a.y) < a.r;
  }

  /* --- texto dentro de la cavidad libre del aro, opuesto a theta_preview actual (nunca cruza ningún borde) --- */
  function cavityLayout(id, theta) {
    const { rPrev } = previewBounds();
    const dx = Math.cos(theta), dy = Math.sin(theta);
    const ax = dx * R, ay = dy * R;
    const fsT = clamp(R * 0.085, 13, 26), fsC = clamp(R * 0.04, 10.5, 14);
    const title = projects[id].title || '', concept = projects[id].shortConcept || '';
    const inner = R - RING_RB - 16;
    const aritoClear = rPrev + PREVIEW_RB + 16;
    let best = null;
    for (let wb = R * 1.28; wb >= R * 0.42 && !best; wb -= R * 0.04) {
      if (title.length * fsT * 0.86 > wb) continue;
      const lines = Math.min(3, Math.max(1, Math.ceil(concept.length * fsC * 0.62 / wb)));
      const hb = fsT * 1.4 + 8 + lines * fsC * 1.55;
      for (let s = 0; s <= R * 0.72 && !best; s += R * 0.03) {
        const cx = -dx * s, cy = -dy * s;
        let ok = true;
        for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
          const x = cx + sx * wb / 2, y = cy + sy * hb / 2;
          if (Math.hypot(x, y) > inner || Math.hypot(x - ax, y - ay) < aritoClear) ok = false;
        }
        if (ok) best = { cx, cy, w: wb, fsT, fsC };
      }
    }
    return best || { cx: -dx * R * 0.35, cy: -dy * R * 0.35, w: R * 0.42, fsT, fsC };
  }

  function openDetail() {
    if (previewId < 0) return;
    const p = projects[previewId];
    $('#d-title').textContent = p.title;
    $('#d-desc').textContent = p.fullDescription;
    const wrap = $('#d-repo-wrap'); wrap.textContent = '';
    if (p.repoUrl && p.repoUrl.trim()) {
      const a = document.createElement('a');
      a.id = 'd-repo'; a.href = p.repoUrl; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.textContent = 'REPOSITORIO ↗';
      wrap.appendChild(a);
    } else {
      const s = document.createElement('span'); s.className = 'pending'; s.textContent = 'REPOSITORIO — PRÓXIMAMENTE'; wrap.appendChild(s);
    }
    detailWanted = true; previewWanted = true;
    cursorWasInsideRect = false;
    setState(STATE.DETAIL_RECT);
    // redistribuye el 100 % del pool uniformemente sobre los 4 lados y 4 esquinas del rectángulo
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
      if (e.target.closest && e.target.closest('#d-repo')) return;
      if (!cursorInsideBox()) closeDetail();
      return;
    }
    if (state === STATE.RING_PREVIEW && previewId >= 0 && previewP > 0.35 && cursorInArito()) openDetail();
  });
  window.addEventListener('wheel', (e) => {
    if (state === STATE.DETAIL_RECT) { e.preventDefault(); if (Math.abs(e.deltaY) > 0) closeDetail(); return; }
    if (performance.now() < scrollLockUntil) e.preventDefault();
  }, { passive: false });
  window.addEventListener('touchmove', (e) => { if (state === STATE.DETAIL_RECT || performance.now() < scrollLockUntil) e.preventDefault(); }, { passive: false });
  window.addEventListener('keydown', (e) => {
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
    if (state === STATE.DETAIL_RECT) return;
    const p = scrollP;
    if (!heroOver && p > HERO_EXIT) heroOver = true; else if (heroOver && p < HERO_ENTER) heroOver = false;
    if (!aboutOver && p > ABOUT_ENTER) aboutOver = true; else if (aboutOver && p < ABOUT_EXIT) aboutOver = false;
    if (!heroOver) { setState(STATE.HERO_TEXT); previewWanted = false; junction.idx = -1; }
    else if (aboutOver) { setState(STATE.ABOUT_DIVIDER); previewWanted = false; junction.idx = -1; }
    else if (state === STATE.HERO_TEXT || state === STATE.ABOUT_DIVIDER) setState(STATE.RING_IDLE);
  }

  function ringHitTest() {
    if (!RING_STATES.has(state)) return;
    let want = { type: 'none' };
    if (cur.valid) {
      const x = cur.x, y = cur.y, r = Math.hypot(x, y);
      if (previewId >= 0 && previewWanted && previewP > 0.02) {
        const a = aritoGeom(Math.max(easeOutCubic(previewP), 0.3));
        if (Math.hypot(x - a.x, y - a.y) < a.r + 12) want = { type: 'preview', id: previewId };
      }
      if (want.type === 'none' && Math.abs(r - R) < 0.14 * R + RING_RB) {
        const { k, f } = segmentAt(Math.atan2(y, x), N);
        if (f < JUNCTION_MARGIN || f > 1 - JUNCTION_MARGIN) {
          const a = f < JUNCTION_MARGIN ? (k + N - 1) % N : k, b = f < JUNCTION_MARGIN ? k : (k + 1) % N;
          if (previewWanted && (previewId === a || previewId === b)) want = { type: 'preview', id: previewId };
          else want = { type: 'junction', idx: a };
        } else want = { type: 'preview', id: k };
      }
    }
    if (want.type === 'preview') {
      const curAng = Math.atan2(cur.y, cur.x);
      if (previewId !== want.id) {
        if (previewP < 0.02) previewP = 0;
        previewId = want.id; mosaicT = 0; textPosInit = false;
        previewTheta = previewThetaTarget = clampThetaToSegment(previewId, curAng);
        previewThetaVel = 0;
      } else if (!previewWanted) {
        mosaicT = 0;
        if (previewP < 0.08) {
          previewTheta = previewThetaTarget = clampThetaToSegment(previewId, curAng);
          previewThetaVel = 0;
        }
      }
      previewWanted = true; junction.idx = -1; setState(STATE.RING_PREVIEW);
    } else if (want.type === 'junction') { previewWanted = false; junction.idx = want.idx; setState(STATE.RING_JUNCTION); }
    else { previewWanted = false; junction.idx = -1; setState(STATE.RING_IDLE); }
  }

  /** Actualiza el deslizamiento suave de theta_preview a lo largo de R_main dentro de los límites estrictos del segmento. */
  function updateSlidingArito(dt) {
    if (previewId < 0) return;
    const mid = centerAngle(previewId, N);
    const { rPrev, deltaMax } = previewBounds();

    if (state === STATE.RING_PREVIEW && cur.valid) {
      const e = Math.max(easeOutCubic(previewP), 0.35);
      const rpNow = rPrev * e;
      const ax = Math.cos(previewTheta) * R, ay = Math.sin(previewTheta) * R;
      const dist = Math.hypot(cur.x - ax, cur.y - ay);
      const curAng = Math.atan2(cur.y, cur.x);
      const curDelta = wrapAngle(curAng - mid);

      if (dist < rpNow + 6) {
        // zona libre central + empuje suave cuando el borde del radio reducido del cursor se acerca al límite interno
        const freeAng = Math.max(0.04, (rpNow - PHYSICS_CONFIG.cursorRadius * 1.25) / R);
        const err = wrapAngle(curAng - previewTheta);
        if (Math.abs(err) > freeAng) {
          const desiredDelta = clamp(curDelta - Math.sign(err) * freeAng, -deltaMax, deltaMax);
          previewThetaTarget = mid + desiredDelta;
        }
      } else {
        // cursor sobre el resto del mismo segmento fuera del vídeo → desliza suavemente hacia él
        previewThetaTarget = mid + clamp(curDelta, -deltaMax, deltaMax);
      }
    } else {
      // garantiza límites válidos ante cambios de tamaño
      previewThetaTarget = mid + clamp(wrapAngle(previewThetaTarget - mid), -deltaMax, deltaMax);
    }

    // resorte amortiguado con inercia sedosa + clamping estricto
    const diff = wrapAngle(previewThetaTarget - previewTheta);
    previewThetaVel += (diff * 62 - previewThetaVel * 14) * dt;
    const nextDelta = clamp(wrapAngle(previewTheta - mid) + previewThetaVel * dt, -deltaMax, deltaMax);
    if (Math.abs(nextDelta) >= deltaMax - 1e-4) previewThetaVel *= 0.4;
    previewTheta = mid + nextDelta;
  }

  /* ===================== BUCLE ===================== */
  let last = performance.now(), t = 0, restartedTick = -1;
  const needed = new Set();
  const colorsRef = Array.from({ length: N }, () => [1, 1, 1]);

  function frame(now) {
    requestAnimationFrame(frame);
    const dt = Math.min((now - last) / 1000, 1 / 30); last = now; t += dt;

    // velocidad suavizada del cursor (px/s)
    const kv = expK(25, dt);
    cur.vx += (accDx / dt - cur.vx) * kv; cur.vy += (-accDy / dt - cur.vy) * kv;
    accDx = accDy = 0;
    cur.speed = Math.hypot(cur.vx, cur.vy);
    if (cur.speed < 5) { cur.vx = cur.vy = 0; cur.speed = 0; }

    updateScrollState();
    ringHitTest();
    updateSlidingArito(dt);

    const inArito = state === STATE.RING_PREVIEW && cur.valid && previewP > 0.35 && cursorInArito();
    bodyEl.style.cursor = inArito ? 'pointer' : '';

    previewP = clamp01(previewP + (previewWanted ? dt / PREVIEW_OPEN_S : -dt / 0.35));
    detailP = clamp01(detailP + (detailWanted ? dt / DETAIL_OPEN_S : -dt / DETAIL_OPEN_S));
    mosaicT = clamp01(mosaicT + dt / VIDEO_OPEN_S);
    const e = easeOutCubic(previewP), d = easeInOutCubic(detailP);

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

    needed.clear();
    if (bgAmt > 0.01) { needed.add(bgA); needed.add(bgB); }
    const cb = currentBox();
    const boxOn = !!cb && (previewP > 0 || detailP > 0);
    if (boxOn) needed.add(previewId);
    videos.update(t, dt, needed, boxOn ? previewId : -1);
    for (let k = 0; k < N; k++) colorsRef[k] = videos.getColor(k);

    // --- arcos asimétricos del aro (el «arito» deslizable recorta limpiamente su tramo en «Y») ---
    const arcs = [];
    const ringOn = (RING_STATES.has(state) || state === STATE.DETAIL_RECT) ? (1 - d) : 0;
    if (ringOn > 0.03) {
      const fullHalf = (SEG * 0.5) * 0.992 * ringOn;
      const { rPrev } = previewBounds();
      const rpNow = rPrev * e;
      const gamOpen = (previewId >= 0 && previewP > 0.01) ? 2 * Math.asin(Math.min(0.95, rpNow / (2 * R))) * 0.92 : 0;
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
        x: cb.x, y: cb.y, hw: cb.hw, hh: cb.hh, cr: cb.cr,
        rb: lerp(PREVIEW_RB, DETAIL_RB, d), off: lerp(0, DETAIL_OFF, d), d, local: videos.getLocal(previewId),
      };
    }

    const jn = { x: 0, y: 0, r: 0 };
    if (state === STATE.RING_JUNCTION && junction.idx >= 0) {
      const a = boundaryAngle(junction.idx, N), bx = Math.cos(a) * R, by = Math.sin(a) * R;
      jn.x = bx + clamp((cur.x - bx) * 0.35, -14, 14) + Math.sin(t * 5.3) * 3;
      jn.y = by + clamp((cur.y - by) * 0.35, -14, 14) + Math.cos(t * 4.7) * 3;
      jn.r = 32;
    }

    const curInsideRect = state === STATE.DETAIL_RECT && detailP > 0.85 && cur.valid && cursorInsideBox();
    const inPreviewArea = state === STATE.RING_PREVIEW && cur.valid && cursorInArito();

    ps.setTargets({
      mode: state === STATE.HERO_TEXT ? 0 : 1,
      R, rb: RING_RB, arcs, colors: colorsRef, box, junction: jn,
      lineL: state === STATE.ABOUT_DIVIDER ? H * 0.46 : 0, lrb: 13,
      enabled: RING_STATES.has(state),
      pushScale: inPreviewArea ? PHYSICS_CONFIG.previewInnerPushScale : 1.0,
      ringActive: RING_STATES.has(state),
      isDetail: state === STATE.DETAIL_RECT,
      curInsideRect, curWasInsideRect: cursorWasInsideRect,
    });
    ps.update(dt, t, cur);
    cur.px = cur.x; cur.py = cur.y;
    cursorWasInsideRect = curInsideRect;
    booted = true;

    // --- uniformes de fondo + tinte ---
    const tintTarget = (state === STATE.RING_PREVIEW || state === STATE.DETAIL_RECT) && previewId >= 0 ? 1 : 0;
    tintAmt += (tintTarget - tintAmt) * expK(TINT_RATE, dt);
    if (previewId >= 0) { const tc = colorsRef[previewId], kc = expK(TINT_RATE, dt); for (let c = 0; c < 3; c++) tintCol[c] += (tc[c] - tintCol[c]) * kc; }
    const bu = bgMat.uniforms;
    bu.tA.value = videos.getTexture(bgA); bu.tB.value = videos.getTexture(bgB);
    bu.uMix.value = bgMix; bu.uTime.value = t; bu.uBgAmt.value = bgAmt;
    bu.uSimplify.value = 1 + 0.5 * smooth(0.1, 0.45, scrollP);
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
      u.uSoft.value = lerp(26, 8, d);
      u.uMosaic.value = 1 - easeOutCubic(mosaicT);
      u.uAlpha.value = clamp01(previewP * 4);
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
    heroSub.style.opacity = String(1 - smooth(0.04, 0.2, scrollP));
    scrollHint.style.opacity = String(1 - smooth(0.0, 0.08, scrollP));
    if (previewId >= 0) {
      const o = clamp01((e - 0.6) / 0.4) * (1 - d) * (state === STATE.DETAIL_RECT ? 0 : 1) * (previewWanted ? 1 : 0);
      previewEl.style.opacity = String(o);
      if (o > 0.01) {
        const L = cavityLayout(previewId, previewTheta);
        if (previewEl.dataset.id !== String(previewId)) {
          previewEl.dataset.id = String(previewId);
          ptTitle.textContent = projects[previewId].title; ptConcept.textContent = projects[previewId].shortConcept || '';
          ptTitle.style.fontSize = L.fsT + 'px'; ptConcept.style.fontSize = L.fsC + 'px';
        }
        if (!textPosInit) { textPosX = L.cx; textPosY = L.cy; textPosInit = true; }
        else { const kt = expK(10, dt); textPosX += (L.cx - textPosX) * kt; textPosY += (L.cy - textPosY) * kt; }
        previewEl.style.width = L.w + 'px';
        previewEl.style.transform = `translate(${W / 2 + textPosX}px, ${H / 2 - textPosY}px) translate(-50%,-50%)`;
      }
    } else previewEl.style.opacity = '0';

    renderer.render(scene, camera);
  }

  resize();
  requestAnimationFrame((n) => { last = n; frame(n); });
}

boot();
