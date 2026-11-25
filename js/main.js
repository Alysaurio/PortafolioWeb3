// main.js — orquestador: máquina de estados, scroll, hit-testing del aro, UI y bucle de render.
import * as THREE from 'three';
import { QUAD_VS, BG_FS, BOX_FS, createGlyphAtlas } from './shaders.js';
import { ParticleSystem, centerAngle, boundaryAngle, segmentAt } from './particles.js';
import { VideoManager } from './videoManager.js';

/* ===================== CONFIGURACIÓN EDITABLE ===================== */
const CONTACT_EMAIL = '[correo-pendiente@ejemplo.com]';
const BASE_BG = [0x12 / 255, 0x13 / 255, 0x15 / 255];
const CLIP_LEN = 3.5, CROSSFADE = 0.8;       // clips del hero
const HERO_EXIT = 0.18, HERO_ENTER = 0.12;   // umbral de scroll (fracción de viewport)
const ABOUT_ENTER = 1.40, ABOUT_EXIT = 1.30;
const JUNCTION_MARGIN = 0.10;                // 10 % del arco junto a cada frontera
const PREVIEW_OPEN_S = 0.5, DETAIL_OPEN_S = 0.55, SCROLL_COOLDOWN_MS = 650;
const TINT_MAX = 0.07, TINT_RATE = 3.7;      // ≈ 800 ms hasta ~95 %

export const STATE = Object.freeze({
  HERO_TEXT: 'HERO_TEXT', RING_IDLE: 'RING_IDLE', RING_JUNCTION: 'RING_JUNCTION',
  RING_PREVIEW: 'RING_PREVIEW', DETAIL_RECT: 'DETAIL_RECT', ABOUT_DIVIDER: 'ABOUT_DIVIDER',
});
const RING_STATES = new Set([STATE.RING_IDLE, STATE.RING_JUNCTION, STATE.RING_PREVIEW]);

const $ = (s) => document.querySelector(s);
const clamp01 = (x) => Math.min(1, Math.max(0, x));
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const expK = (rate, dt) => 1 - Math.exp(-rate * dt);

function fatal(msg) {
  const el = $('#fatal'); el.textContent = msg; el.hidden = false;
}

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
  try { await Promise.race([Promise.all([document.fonts.load(`800 64px ${FONT}`), document.fonts.load(`700 32px ${FONT}`)]), new Promise(r => setTimeout(r, 2500))]); } catch (e) { /* usa fallback */ }

  start(projects, canvas, gl2, FONT);
}

function start(projects, canvas, gl2, FONT) {
  const N = projects.length;
  const renderer = new THREE.WebGLRenderer({ canvas, context: gl2, antialias: false, alpha: false });
  renderer.setClearColor(new THREE.Color().setRGB(BASE_BG[0], BASE_BG[1], BASE_BG[2]), 1);
  const dpr = Math.min(window.devicePixelRatio || 1, 1.75);
  renderer.setPixelRatio(dpr);

  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const atlas = createGlyphAtlas(THREE);
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

  // --- caja de vídeo (arito / rectángulo) con mosaico y lupa ASCII ---
  const boxMat = new THREE.ShaderMaterial({
    vertexShader: QUAD_VS, fragmentShader: BOX_FS, transparent: true, depthTest: false, depthWrite: false,
    uniforms: {
      tVideo: { value: videos.getTexture(0) }, tAtlas: { value: atlas },
      uCenter: { value: new THREE.Vector2() }, uHalf: { value: new THREE.Vector2(1, 1) }, uCorner: { value: 0 },
      uSoft: { value: 24 }, uMosaic: { value: 1 }, uVAspect: { value: 16 / 9 },
      uMagPos: { value: new THREE.Vector2() }, uMagR: { value: 0 }, uDpr: { value: dpr }, uTime: { value: 0 }, uAlpha: { value: 0 },
    },
  });
  const boxMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), boxMat);
  boxMesh.frustumCulled = false; boxMesh.renderOrder = 1; boxMesh.visible = false;
  scene.add(boxMesh);

  // --- partículas ---
  const cores = navigator.hardwareConcurrency || 4;
  const startCount = cores >= 12 ? 22000 : cores >= 8 ? 18000 : 14000;
  const ps = new ParticleSystem({ atlas, N, count: startCount, maxCount: 25000 });
  ps.points.renderOrder = 3;
  scene.add(ps.points);

  /* ===================== ESTADO ===================== */
  let W = 1, H = 1, R = 300;
  let state = STATE.HERO_TEXT;
  let heroOver = false, aboutOver = false;
  let scrollP = 0;
  let previewId = -1, previewWanted = false, previewP = 0, detailP = 0, detailWanted = false, mosaicT = 1;
  let junction = { idx: -1 };
  let scrollLockUntil = 0;
  let tintAmt = 0; const tintCol = [...BASE_BG];
  let magX = 0, magY = 0, magR = 0;
  const cur = { x: 0, y: 0, sx: 0, sy: 0, vx: 0, vy: 0, speed: 0, valid: false, enabled: false };
  let accDx = 0, accDy = 0, lastClientX = null, lastClientY = null;

  const bodyEl = document.body;
  const detailEl = $('#detail'), detailHint = $('#detail-hint');
  const previewEl = $('#preview-title');
  const heroSub = $('#hero-sub'), scrollHint = $('#scroll-hint');

  function setState(s) {
    if (s === state) return;
    state = s; bodyEl.dataset.state = s;
  }

  function resize() {
    W = window.innerWidth; H = window.innerHeight;
    renderer.setSize(W, H, false);
    R = Math.min(Math.min(W, H) * 0.31, 340);
    bgMat.uniforms.uRes.value.set(W, H);
    ps.resize(W, H, dpr);
    ps.buildTextField('ALYSAURIO', FONT);
    onScroll();
  }
  let rzT = 0;
  window.addEventListener('resize', () => { clearTimeout(rzT); rzT = setTimeout(resize, 120); });

  function onScroll() { scrollP = window.scrollY / Math.max(1, window.innerHeight); }
  window.addEventListener('scroll', onScroll, { passive: true });

  /* ===================== INTERACCIÓN ===================== */
  window.addEventListener('pointermove', (e) => {
    if (lastClientX !== null) { accDx += e.clientX - lastClientX; accDy += e.clientY - lastClientY; }
    lastClientX = e.clientX; lastClientY = e.clientY;
    cur.sx = e.clientX; cur.sy = e.clientY; cur.valid = true;
    cur.x = e.clientX - W / 2; cur.y = H / 2 - e.clientY;
  }, { passive: true });
  document.addEventListener('pointerleave', () => { cur.valid = false; });
  document.documentElement.addEventListener('mouseleave', () => { cur.valid = false; });

  function boxGeom() {
    // caja de detalle: 16:9 desplazada hacia la derecha
    const hh = Math.min(H * 0.36, W * 0.30 * 9 / 16), hw = hh * 16 / 9;
    return { x: W * 0.44 - hw, y: 0, hw, hh, cr: 26 };
  }
  function aritoGeom(id, e) {
    const a = centerAngle(id, N), rp = 0.62 * R * e;
    return { x: Math.cos(a) * R * 0.28, y: Math.sin(a) * R * 0.28, r: rp };
  }
  function cursorInsideBox() {
    const b = currentBox(); if (!b) return false;
    const qx = Math.abs(cur.x - b.x) - b.hw + b.cr, qy = Math.abs(cur.y - b.y) - b.hh + b.cr;
    const sd = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - b.cr;
    return sd < 0;
  }
  function currentBox() {
    if (previewId < 0) return null;
    const e = easeOutCubic(previewP), d = easeInOutCubic(detailP);
    const a = aritoGeom(previewId, e), t = boxGeom();
    const hw = lerp(a.r, t.hw, d), hh = lerp(a.r, t.hh, d);
    if (hw < 2 && d < 0.01) return null;
    return { x: lerp(a.x, t.x, d), y: lerp(a.y, t.y, d), hw, hh, cr: Math.min(lerp(a.r, t.cr, d), hw, hh) };
  }

  function openDetail() {
    if (previewId < 0) return;
    const p = projects[previewId];
    $('#d-title').textContent = p.title;
    $('#d-desc').textContent = p.fullDescription;
    const wrap = $('#d-repo-wrap'); wrap.textContent = '';
    if (p.repoUrl && p.repoUrl.trim()) {
      const a = document.createElement('a');
      a.id = 'd-repo'; a.href = p.repoUrl; a.target = '_blank'; a.rel = 'noopener noreferrer';
      a.textContent = 'REPOSITORIO ↗'; wrap.appendChild(a);
    } else {
      const s = document.createElement('span'); s.className = 'pending'; s.textContent = 'REPOSITORIO — PRÓXIMAMENTE'; wrap.appendChild(s);
    }
    detailWanted = true; previewWanted = true;
    setState(STATE.DETAIL_RECT);
    detailEl.classList.add('open'); detailHint.classList.add('open'); detailEl.setAttribute('aria-hidden', 'false');
  }
  function closeDetail() {
    if (state !== STATE.DETAIL_RECT) return;
    detailWanted = false;
    scrollLockUntil = performance.now() + SCROLL_COOLDOWN_MS;
    detailEl.classList.remove('open'); detailHint.classList.remove('open'); detailEl.setAttribute('aria-hidden', 'true');
    setState(STATE.RING_IDLE);   // el hit-test del siguiente frame decide si cae directo en otro RING_PREVIEW
  }

  window.addEventListener('click', (e) => {
    if (state === STATE.DETAIL_RECT) {
      if (e.target.closest && e.target.closest('#d-repo')) return;      // el enlace del repo no cierra
      if (!cursorInsideBox()) closeDetail();
      return;
    }
    if (state === STATE.RING_PREVIEW && previewId >= 0 && previewP > 0.35) {
      const a = aritoGeom(previewId, easeOutCubic(previewP));
      if (Math.hypot(cur.x - a.x, cur.y - a.y) < a.r) openDetail();
    }
  });

  window.addEventListener('wheel', (e) => {
    if (state === STATE.DETAIL_RECT) {
      e.preventDefault();
      if (Math.abs(e.deltaY) > 0) closeDetail();
      return;
    }
    if (performance.now() < scrollLockUntil) e.preventDefault();          // absorbe inercia del ratón/trackpad
  }, { passive: false });
  window.addEventListener('touchmove', (e) => { if (state === STATE.DETAIL_RECT || performance.now() < scrollLockUntil) e.preventDefault(); }, { passive: false });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeDetail(); return; }
    if (state === STATE.DETAIL_RECT && [' ', 'PageDown', 'PageUp', 'ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) { e.preventDefault(); closeDetail(); }
  });

  // copiar correo
  const emailText = $('#email-text'); emailText.textContent = CONTACT_EMAIL;
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
    if (state === STATE.DETAIL_RECT) return;               // bloqueado mientras el detalle está activo
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
      // 1) dentro del «arito» abierto (o abriéndose)
      if (previewId >= 0 && previewWanted && previewP > 0.02) {
        const a = aritoGeom(previewId, Math.max(easeOutCubic(previewP), 0.25));
        if (Math.hypot(x - a.x, y - a.y) < a.r + 10) want = { type: 'preview', id: previewId };
      }
      // 2) sobre el aro
      if (want.type === 'none' && Math.abs(r - R) < 0.14 * R + 13) {
        const { k, f } = segmentAt(Math.atan2(y, x), N);
        if (f < JUNCTION_MARGIN || f > 1 - JUNCTION_MARGIN) {
          const a = f < JUNCTION_MARGIN ? (k + N - 1) % N : k, b = f < JUNCTION_MARGIN ? k : (k + 1) % N;
          if (previewWanted && (previewId === a || previewId === b)) want = { type: 'preview', id: previewId };
          else want = { type: 'junction', idx: a };
        } else want = { type: 'preview', id: k };
      }
    }
    if (want.type === 'preview') {
      if (previewId !== want.id) { if (previewP < 0.02) previewP = 0; previewId = want.id; mosaicT = 0; }
      else if (!previewWanted) mosaicT = 0;
      previewWanted = true; junction.idx = -1; setState(STATE.RING_PREVIEW);
    } else if (want.type === 'junction') {
      previewWanted = false; junction.idx = want.idx; setState(STATE.RING_JUNCTION);
    } else { previewWanted = false; junction.idx = -1; setState(STATE.RING_IDLE); }
  }

  /* ===================== BUCLE ===================== */
  let last = performance.now(), t = 0;
  let frameAcc = 0, frameN = 0;
  const needed = new Set();
  let restartedTick = -1;
  const colorsRef = Array.from({ length: N }, () => [1, 1, 1]);

  function frame(now) {
    requestAnimationFrame(frame);
    const rawDt = (now - last) / 1000; last = now;
    const dt = Math.min(rawDt, 1 / 30); t += dt;

    // rendimiento adaptativo (reduce partículas si baja de ~48 fps)
    frameAcc += rawDt; frameN++;
    if (frameN >= 90) {
      if (frameAcc / frameN > 0.0215 && ps.count > 12000) ps.setCount(Math.max(12000, ps.count * 0.85));
      frameAcc = 0; frameN = 0;
    }

    // velocidad del cursor (px/s, suavizada; decae si no hay movimiento)
    const kv = expK(25, dt);
    cur.vx += (accDx / dt - cur.vx) * kv; cur.vy += (-accDy / dt - cur.vy) * kv;
    accDx = accDy = 0;
    cur.speed = Math.hypot(cur.vx, cur.vy);
    if (cur.speed < 5) { cur.vx = cur.vy = 0; cur.speed = 0; }

    updateScrollState();
    ringHitTest();
    bodyEl.style.cursor = state === STATE.RING_PREVIEW && cur.valid && previewP > 0.35 && (() => { const a = aritoGeom(previewId, easeOutCubic(previewP)); return Math.hypot(cur.x - a.x, cur.y - a.y) < a.r; })() ? 'pointer' : '';

    // tweens interrumpibles
    previewP = clamp01(previewP + (previewWanted ? dt / PREVIEW_OPEN_S : -dt / 0.35));
    detailP = clamp01(detailP + (detailWanted ? dt / DETAIL_OPEN_S : -dt / DETAIL_OPEN_S));
    mosaicT = clamp01(mosaicT + dt / 0.6);

    const e = easeOutCubic(previewP), d = easeInOutCubic(detailP);

    // --- vídeo y paleta ---
    needed.clear();
    const bgAmt = 1 - smooth(0.14, 0.5, scrollP);
    const bi = Math.floor(t / CLIP_LEN) % N, local = t % CLIP_LEN;
    const cross = N > 1 ? smooth(CLIP_LEN - CROSSFADE, CLIP_LEN, local) : 0;
    const bj = (bi + 1) % N;
    if (bgAmt > 0.01) { needed.add(bi); needed.add(bj); }
    if (previewId >= 0 && (previewP > 0 || detailP > 0)) needed.add(previewId);
    videos.update(t, dt, needed);
    for (let k = 0; k < N; k++) { const c = videos.getColor(k); colorsRef[k] = c; }
    const clipTick = Math.floor(t / CLIP_LEN);
    if (bgAmt > 0.01 && N > 1 && local >= CLIP_LEN - CROSSFADE && restartedTick !== clipTick) { restartedTick = clipTick; videos.restart(bj); }

    // --- objetivos para partículas ---
    const full = Math.PI / N * 0.992;
    const ringOn = RING_STATES.has(state) || state === STATE.DETAIL_RECT ? 1 : 0;
    const ap = new Array(N);
    for (let k = 0; k < N; k++) ap[k] = full * ringOn * (1 - (k === previewId ? e : 0)) * (1 - d);

    let box = null;
    const cb = currentBox();
    if (cb && (previewP > 0 || detailP > 0)) {
      box = { x: cb.x, y: cb.y, hw: cb.hw, hh: cb.hh, cr: cb.cr, rb: lerp(6, 7, d), color: colorsRef[previewId] };
    }

    const jn = { x: 0, y: 0, r: 0 };
    if (state === STATE.RING_JUNCTION && junction.idx >= 0) {
      const a = boundaryAngle(junction.idx, N), bx = Math.cos(a) * R, by = Math.sin(a) * R;
      const ox = Math.max(-14, Math.min(14, (cur.x - bx) * 0.35)) + Math.sin(t * 5.3) * 3;
      const oy = Math.max(-14, Math.min(14, (cur.y - by) * 0.35)) + Math.cos(t * 4.7) * 3;
      jn.x = bx + ox; jn.y = by + oy; jn.r = 28;
    }

    cur.enabled = RING_STATES.has(state);
    ps.setTargets({
      mode: state === STATE.HERO_TEXT ? 0 : 1, R, rb: 13, ap, colors: colorsRef, box, junction: jn,
      lineL: state === STATE.ABOUT_DIVIDER ? H * 0.46 : 0, lrb: 13, enabled: cur.enabled,
    });
    ps.update(dt, t, cur);

    // --- fondo + tinte ambiental ---
    const tintTarget = (state === STATE.RING_PREVIEW || state === STATE.DETAIL_RECT) && previewId >= 0 ? 1 : 0;
    tintAmt += (tintTarget - tintAmt) * expK(TINT_RATE, dt);
    if (previewId >= 0) { const tc = colorsRef[previewId]; const kc = expK(TINT_RATE, dt); for (let c = 0; c < 3; c++) tintCol[c] += (tc[c] - tintCol[c]) * kc; }
    const bu = bgMat.uniforms;
    bu.tA.value = videos.getTexture(bi); bu.tB.value = videos.getTexture(bj);
    bu.uMix.value = cross; bu.uTime.value = t; bu.uBgAmt.value = bgAmt;
    bu.uSimplify.value = 1 + 1.6 * smooth(0.1, 0.4, scrollP);
    bu.uTint.value.set(tintCol[0], tintCol[1], tintCol[2]);
    bu.uTintAmt.value = tintAmt * TINT_MAX;

    // --- caja de vídeo ---
    if (box) {
      boxMesh.visible = true;
      const u = boxMat.uniforms;
      u.tVideo.value = videos.getTexture(previewId);
      u.uCenter.value.set(W / 2 + box.x, H / 2 + box.y);
      u.uHalf.value.set(Math.max(box.hw, 1), Math.max(box.hh, 1));
      u.uCorner.value = box.cr;
      u.uSoft.value = lerp(30, 10, d);
      u.uMosaic.value = 1 - easeOutCubic(mosaicT);
      u.uAlpha.value = clamp01(previewP * 4);
      u.uTime.value = t;
      // lupa ASCII radial con inercia: solo con el rectángulo formado y el cursor dentro
      const magOn = state === STATE.DETAIL_RECT && detailP > 0.95 && cursorInsideBox() ? 1 : 0;
      const tx = cur.sx, ty = H - cur.sy;
      if (magR < 2) { magX = tx; magY = ty; }
      const kk = expK(9, dt);
      magX += (tx - magX) * kk; magY += (ty - magY) * kk;
      magR += ((magOn ? Math.min(150, W * 0.09) : 0) - magR) * expK(9, dt);
      if (magR < 0.5) magR = 0;
      u.uMagPos.value.set(magX, magY); u.uMagR.value = magR;
    } else { boxMesh.visible = false; magR = 0; }

    // --- DOM ---
    heroSub.style.opacity = String(1 - smooth(0.04, 0.2, scrollP));
    scrollHint.style.opacity = String(1 - smooth(0.0, 0.08, scrollP));
    if (previewId >= 0) {
      const a = centerAngle(previewId, N);
      const o = clamp01((e - 0.5) / 0.5) * (1 - d) * (state === STATE.DETAIL_RECT ? 0 : 1);
      previewEl.style.opacity = String(o);
      previewEl.style.transform = `translate(${W / 2 + Math.cos(a) * R * 1.0}px, ${H / 2 - Math.sin(a) * R * 1.0}px) translate(-50%,-50%)`;
      if (previewEl.dataset.id !== String(previewId)) { previewEl.dataset.id = String(previewId); previewEl.querySelector('.pt-title').textContent = projects[previewId].title; }
    } else previewEl.style.opacity = '0';

    renderer.render(scene, camera);
  }

  resize();
  requestAnimationFrame((n) => { last = n; frame(n); });
}

boot();
