// shaders.js — malla ASCII unificada (fuente única GRID_CELL_SIZE), atlas tipográfico y GLSL.
export const GRID_CELL_SIZE = 7;
export const DEFAULT_CHARSET = ['.', ':', ';', '=', '+', 'x', '#', '%', '@'];
export const ATLAS_CELL = 48;

/** Atlas horizontal (1 fila, un glifo por celda) en blanco sobre transparente; se usa el canal alfa. */
export function createGlyphAtlas(THREE, charset = DEFAULT_CHARSET) {
  const cell = ATLAS_CELL;
  const c = document.createElement('canvas');
  c.width = cell * charset.length; c.height = cell;
  const g = c.getContext('2d');
  g.clearRect(0, 0, c.width, c.height);
  g.fillStyle = '#fff'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.font = `700 ${Math.round(cell * 0.84)}px "JetBrains Mono","Space Mono",monospace`;
  charset.forEach((ch, i) => g.fillText(ch, i * cell + cell / 2, cell / 2 + cell * 0.04));
  const tex = new THREE.CanvasTexture(c);
  tex.minFilter = THREE.LinearMipmapLinearFilter; tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true; tex.needsUpdate = true;
  return tex;
}

const COMMON = /* glsl */`
uniform sampler2D tAtlas;
const float GLYPH_N = 9.0;
const float ATLAS_CELL = 48.0;
// cellDev = tamaño de la celda en píxeles de dispositivo → LOD explícito (sin saltos de derivadas en los bordes de celda)
float glyphAlpha(float g, vec2 f, float cellDev){
  f = clamp(f, 0.03, 0.97);
  float lod = max(0.0, log2(ATLAS_CELL / max(cellDev, 1.0)));
  return textureLod(tAtlas, vec2((g + f.x) / GLYPH_N, f.y), lod).a;
}
float hash12(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
vec2 coverUV(vec2 p, vec2 c, vec2 h, float va){
  vec2 q = (p - c) / (2.0 * h) + 0.5;
  float ba = h.x / h.y;
  if (ba > va) q.y = 0.5 + (q.y - 0.5) * (va / ba);
  else         q.x = 0.5 + (q.x - 0.5) * (ba / va);
  return q;
}
`;

export const QUAD_VS = /* glsl */`
varying vec2 vUv;
void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

/* Capa ASCII de grilla fija (origen superior-izquierdo unificado con BG_FS). */
export const GRID_FS = /* glsl */`
${COMMON}
uniform sampler2D tGrid;
uniform vec2 uGrid;
uniform vec2 uRes;
uniform float uCell;
uniform float uDpr;
varying vec2 vUv;
void main(){
  vec2 frag = gl_FragCoord.xy / uDpr;
  // origen común (0,0) en esquina superior izquierda — alineación exacta al píxel con BG_FS
  vec2 screenCss = vec2(frag.x, uRes.y - frag.y);
  vec2 cellId = floor(screenCss / uCell);
  vec2 cellFrac = fract(screenCss / uCell);
  vec4 d = texture2D(tGrid, (cellId + 0.5) / uGrid);
  float g = floor(d.a);
  float al = (d.a - g) / 0.99;
  float ga = glyphAlpha(g, vec2(cellFrac.x, 1.0 - cellFrac.y), uCell * uDpr);
  float a = clamp(ga * al * 1.25, 0.0, 1.0);
  if (a < 0.03) discard;
  gl_FragColor = vec4(d.rgb, a);
}`;

/* Capa 1 del agujero negro — brillo exterior puramente aditivo (AdditiveBlending / lighter), cero negro ni gris. */
export const BH_GLOW_FS = /* glsl */`
uniform vec2 uBhPos;
uniform float uBhR;
uniform float uBhGlow;
uniform float uBhTime;
uniform float uDpr;
varying vec2 vUv;
void main(){
  if (uBhR <= 0.5 || uBhGlow <= 0.002) discard;
  vec2 frag = gl_FragCoord.xy / uDpr;
  vec2 dv = frag - uBhPos;
  float db = length(dv);
  // alcance radial corto apoyado sobre la primera corona ASCII incandescente (R_drawBlack → R_drawBlack * 1.60)
  if (db > uBhR * 1.66) discard;
  float outerClip = 1.0 - smoothstep(uBhR * 1.32, uBhR * 1.60, db);
  if (outerClip <= 0.002) discard;

  float bt = uBhTime;
  float ang = atan(dv.y, dv.x);
  // titileo orgánico irregular (3 ondas no armónicas, ±20–22 %)
  float fl1 = sin(bt * 7.3) * 0.45 + sin(bt * 13.7 + 1.9) * 0.35 + sin(bt * 21.1 + 4.2) * 0.20;
  float fl2 = sin(bt * 6.1 + 2.7) * 0.45 + sin(bt * 15.3 + 0.6) * 0.35 + sin(bt * 23.7 + 3.1) * 0.20;

  // 2 halos aditivos cálidos ligeramente descentrados (1.5–3.2 px) en giro horario
  float a1 = -bt * 1.15;
  float off1 = clamp(uBhR * 0.065, 1.5, 3.2);
  float d1 = length(dv - vec2(cos(a1), sin(a1)) * off1);
  float t1 = clamp((d1 - uBhR * 0.98) / max(uBhR * 0.62, 7.0), 0.0, 1.0);
  float w1 = pow(1.0 - t1, 2.2) * outerClip * (1.0 + 0.20 * fl1) * 0.19;

  float a2 = -bt * 0.78 + 2.35;
  float off2 = clamp(uBhR * 0.055, 1.5, 2.8);
  float d2 = length(dv - vec2(cos(a2), sin(a2)) * off2);
  float t2 = clamp((d2 - uBhR * 0.98) / max(uBhR * 0.60, 7.0), 0.0, 1.0);
  float w2 = pow(1.0 - t2, 2.4) * outerClip * (1.0 + 0.22 * fl2) * 0.10;

  // tonos saturados y limpios coherentes con el fuego adyacente (cero gris ni complementarios)
  vec3 cInner = vec3(1.000, 0.961, 0.863); // #FFF5DC blanco cálido
  vec3 cAmber = vec3(1.000, 0.659, 0.204); // #FFA834 ámbar dorado
  vec3 cFire  = vec3(1.000, 0.408, 0.125); // #FF6820 naranja fuego
  vec3 cCoral = vec3(1.000, 0.451, 0.278); // leve deriva coral temporal
  float drift = 0.5 + 0.5 * sin(bt * 1.85 + ang * 0.5);
  vec3 cOuter = mix(cFire, cCoral, drift * 0.35);
  vec3 col1 = t1 < 0.35
    ? mix(cInner, cAmber, smoothstep(0.0, 0.35, t1))
    : mix(cAmber, cOuter, smoothstep(0.35, 1.0, t1));
  vec3 col2 = mix(cInner, cAmber, smoothstep(0.0, 0.65, t2));

  float alpha = clamp((w1 + w2) * uBhGlow, 0.0, 0.32);
  if (alpha <= 0.002) discard;
  vec3 rgb = (col1 * w1 + col2 * w2) / max(w1 + w2, 0.0001);
  gl_FragColor = vec4(rgb, alpha);
}`;

/* Capa 2 del agujero negro — núcleo negro absoluto (#000000) encima en source-over con borde nítido (~1 px AA). */
export const BH_CORE_FS = /* glsl */`
uniform vec2 uBhPos;
uniform float uBhR;
uniform float uDpr;
varying vec2 vUv;
void main(){
  if (uBhR <= 0.5) discard;
  vec2 frag = gl_FragCoord.xy / uDpr;
  float db = length(frag - uBhPos);
  float a = 1.0 - smoothstep(uBhR - 0.6, uBhR + 0.4, db);
  if (a <= 0.004) discard;
  gl_FragColor = vec4(0.0, 0.0, 0.0, a);
}`;

/* Fondo ASCII alineado a la misma malla global (GRID_CELL_SIZE, origen superior-izquierdo), sin warp UV. */
export const BG_FS = /* glsl */`
${COMMON}
uniform sampler2D tA;
uniform sampler2D tB;
uniform float uMix;
uniform vec2 uRes;
uniform float uCell;
uniform float uDpr;
uniform float uTime;
uniform float uBgAmt;
uniform float uBgLive;      // 1 = fondo vivo normal, 0 = vacío #000000 al sustituirse por partículas capturadas
uniform vec3 uBase;
uniform vec3 uTint;
uniform float uTintAmt;
uniform float uVAspect;
varying vec2 vUv;
void main(){
  vec2 frag = gl_FragCoord.xy / uDpr;
  vec3 col = mix(uBase, uTint, uTintAmt);

  if (uBgAmt > 0.003 && uBgLive > 0.003) {
    // misma cuadrícula exacta (0,0 arriba-izquierda) y misma rampa Técnica que GRID_FS
    vec2 screenCss = vec2(frag.x, uRes.y - frag.y);
    vec2 cellId = floor(screenCss / uCell);
    vec2 cellFrac = fract(screenCss / uCell);
    vec2 cellCenterCss = (cellId + 0.5) * uCell;
    vec2 cellCenterUp = vec2(cellCenterCss.x, uRes.y - cellCenterCss.y);
    vec2 uv = coverUV(cellCenterUp, uRes * 0.5, uRes * 0.5, uVAspect);
    vec3 v = mix(texture2D(tA, uv).rgb, texture2D(tB, uv).rgb, uMix);
    float lum = dot(v, vec3(0.299, 0.587, 0.114));
    float g = floor(clamp(pow(lum, 0.75) * 1.25, 0.0, 1.0) * 8.99);
    float a = glyphAlpha(g, vec2(cellFrac.x, 1.0 - cellFrac.y), uCell * uDpr);
    float vig = 1.0 - 0.45 * smoothstep(0.35, 0.95, length((cellCenterUp / uRes - 0.5) * vec2(1.0, 0.9)) * 1.6);
    col += (v * 0.035 + v * a * 0.30) * uBgAmt * vig;
  }
  col += (hash12(gl_FragCoord.xy + fract(uTime) * 91.7) - 0.5) * 0.05;   // grano ~2.5 %
  col *= uBgLive;
  gl_FragColor = vec4(col, 1.0);
}`;

/* Caja de vídeo (arito / rectángulo): apertura micro-ASCII → vídeo y escáner ASCII graduado
   (micro-caracteres densos ~3.6 px en el borde exterior → transición intermedia ~5.2 px → núcleo igual a uGridCell ~7 px). */
export const BOX_FS = /* glsl */`
${COMMON}
uniform sampler2D tVideo;
uniform vec2 uCenter;
uniform vec2 uHalf;
uniform float uCorner;
uniform float uSoft;
uniform float uMosaic;      // 1 → todo micro-ASCII, 0 → vídeo nítido
uniform float uVAspect;
uniform vec2 uMagPos;
uniform float uMagR;
uniform float uPulse;
uniform float uGridCell;    // iguala PHYSICS_CONFIG.cellSize (~7 px) en el núcleo de la lupa
uniform float uDpr;
uniform float uTime;
uniform float uAlpha;
varying vec2 vUv;

float sdRoundBox(vec2 p, vec2 b, float r){
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}
vec3 vid(vec2 pt){ return texture2D(tVideo, coverUV(pt, uCenter, uHalf, uVAspect)).rgb; }

// celda ASCII anclada al espacio del vídeo (origin = esquina del rectángulo) → sin temblor al mover el cursor
vec4 asciiSample(vec2 frag, vec2 origin, float cs, float boost){
  vec2 rel = frag - origin;
  vec2 cell = floor(rel / cs);
  vec3 c = vid(origin + (cell + 0.5) * cs);
  float lum = dot(c, vec3(0.299, 0.587, 0.114));
  lum = clamp((lum - 0.03) * 1.32, 0.0, 1.0);
  float gf = pow(lum, 0.85) * 8.99 + boost * (0.55 + hash12(cell + floor(uTime * 12.0)));
  float g = floor(clamp(gf, 0.0, 8.99));
  float a = glyphAlpha(g, fract(rel / cs), cs * uDpr);
  float dense = step(5.5, g);                                   // # % @ → sutil realce fósforo
  vec3 gc = c * (1.12 + 0.28 * dense) + dense * vec3(0.015, 0.06, 0.025);
  return vec4(gc, a);
}

void main(){
  if (uAlpha <= 0.001) discard;
  vec2 frag = gl_FragCoord.xy / uDpr;
  float sd = sdRoundBox(frag - uCenter, uHalf, uCorner);
  float mask = smoothstep(0.0, uSoft, -sd);
  if (mask < 0.004) discard;
  vec2 origin = uCenter - uHalf;
  vec3 col = vid(frag);

  // apertura: micro-caracteres técnicos que se disuelven celda a celda hasta el vídeo nítido
  if (uMosaic > 0.002) {
    vec2 cell = floor((frag - origin) / 4.5);
    float r = hash12(cell);
    float amt = smoothstep(r * 0.55, r * 0.55 + 0.45, uMosaic);
    vec4 s = asciiSample(frag, origin, 4.5, 0.0);
    col = mix(col, mix(vec3(0.07), s.rgb, s.a), amt);
  }

  // escáner ASCII graduado hacia el cursor:
  // borde exterior (~3.6 px denso) → transición intermedia (~5.2 px) → núcleo (~uGridCell = 7 px, igual al marco exterior)
  if (uMagR > 1.0) {
    vec2 dv = frag - uMagPos;
    float d = length(dv), ang = atan(dv.y, dv.x);
    float n = 0.5 * sin(ang * 7.0 + uTime * 1.7) + 0.5 * sin(ang * 13.0 - uTime * 2.3);
    float scan = 0.5 + 0.5 * sin(ang * 36.0 + uTime * 5.2);
    float Rn = uMagR * (1.0 + 0.065 * n + 0.02 * scan);
    float rNorm = clamp(d / max(Rn, 1.0), 0.0, 1.0);
    float wEnv = pow(1.0 - smoothstep(0.42, 1.0, rNorm), 1.15);

    if (wEnv > 0.002) {
      float boost = uPulse * (0.9 + 0.35 * sin(uTime * 18.0 - d * 0.11));
      float wCore = 1.0 - smoothstep(0.20, 0.48, rNorm);
      float wOuter = smoothstep(0.50, 0.80, rNorm);
      float wMid = max(0.0, 1.0 - wCore - wOuter);

      float csCore = max(uGridCell, 5.0);
      float csMid  = csCore * 0.74;
      float csOut  = max(3.5, csCore * 0.51);

      vec3 gColSum = vec3(0.0);
      float gAlp = 0.0;
      if (wCore > 0.001) {
        vec4 s2 = asciiSample(frag, origin, csCore, boost);
        gColSum += s2.rgb * s2.a * wCore; gAlp += s2.a * wCore;
      }
      if (wMid > 0.001) {
        vec4 s1 = asciiSample(frag, origin, csMid, boost * 0.85);
        gColSum += s1.rgb * s1.a * wMid; gAlp += s1.a * wMid;
      }
      if (wOuter > 0.001) {
        vec4 s0 = asciiSample(frag, origin, csOut, boost * 0.65);
        gColSum += s0.rgb * s0.a * wOuter; gAlp += s0.a * wOuter;
      }
      vec3 gCol = gAlp > 0.001 ? gColSum / gAlp : col;
      vec3 base = col * (1.0 - 0.16 * wEnv);
      col = mix(base, gCol, clamp(gAlp * wEnv * 1.12, 0.0, 1.0));
    }
  }
  col += (hash12(gl_FragCoord.xy + fract(uTime) * 57.3) - 0.5) * 0.05;
  gl_FragColor = vec4(col, mask * uAlpha);
}`;
