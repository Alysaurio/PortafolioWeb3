// shaders.js — atlas tipográfico + GLSL: capa ASCII fija (+ horizonte de eventos), fondo ASCII (+ blackout) y escáner graduado.
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

/* Capa ASCII de grilla fija + horizonte de eventos (núcleo hueco #000000 con borde incandescente sutil en HERO_TEXT). */
export const GRID_FS = /* glsl */`
${COMMON}
uniform sampler2D tGrid;
uniform vec2 uGrid;
uniform float uCell;
uniform float uDpr;
uniform vec2 uBhPos;        // coords CSS (y hacia arriba)
uniform float uBhR;         // radio del horizonte de eventos (0 = inactivo)
uniform float uBhRim;       // intensidad del aro fotónico exterior
varying vec2 vUv;
void main(){
  vec2 frag = gl_FragCoord.xy / uDpr;
  vec2 c = floor(frag / uCell);
  vec4 d = texture2D(tGrid, (c + 0.5) / uGrid);
  float g = floor(d.a);
  float al = (d.a - g) / 0.99;
  float ga = glyphAlpha(g, fract(frag / uCell), uCell * uDpr);
  float a = clamp(ga * al * 1.25, 0.0, 1.0);
  vec3 col = d.rgb;

  if (uBhR > 0.5) {
    float db = length(frag - uBhPos);
    // núcleo hueco negro puro (#000000)
    float hole = 1.0 - smoothstep(uBhR - 1.5, uBhR + 0.8, db);
    // borde exterior sutilmente incandescente en blanco
    float rim = exp(-pow((db - (uBhR + 1.2)) / 3.4, 2.0)) * uBhRim;
    if (hole > 0.005 || rim > 0.01) {
      vec3 gRgb = col * a;
      vec3 outRgb = mix(gRgb + vec3(rim), vec3(0.0), hole);
      float outA = max(hole, clamp(a + rim, 0.0, 1.0));
      if (outA < 0.02) discard;
      gl_FragColor = vec4(outRgb / max(outA, 0.001), outA);
      return;
    }
  }
  if (a < 0.03) discard;
  gl_FragColor = vec4(col, a);
}`;

/* Fondo: filtro ASCII/semitono del vídeo (con crossfade A→B) + tinte ambiental + grano + blackout del agujero negro. */
export const BG_FS = /* glsl */`
${COMMON}
uniform sampler2D tA;
uniform sampler2D tB;
uniform float uMix;
uniform vec2 uRes;
uniform float uDpr;
uniform float uTime;
uniform float uBgAmt;
uniform float uSimplify;
uniform vec3 uBase;
uniform vec3 uTint;
uniform float uTintAmt;
uniform float uVAspect;
uniform float uBlackout;    // 0 = normal, 1 = vacío negro puro (#000000) durante el clímax del agujero negro
varying vec2 vUv;
void main(){
  vec2 frag = gl_FragCoord.xy / uDpr;
  vec3 col = mix(uBase, uTint, uTintAmt);
  float vis = 1.0 - uBlackout;
  if (uBgAmt > 0.003 && vis > 0.003) {
    float cs = 9.0 * uSimplify;
    vec2 cc = (floor(frag / cs) + 0.5) * cs;
    vec2 uv = coverUV(cc, uRes * 0.5, uRes * 0.5, uVAspect);
    vec3 v = mix(texture2D(tA, uv).rgb, texture2D(tB, uv).rgb, uMix);
    float lum = dot(v, vec3(0.299, 0.587, 0.114));
    float g = floor(clamp(pow(lum, 0.75) * 1.25, 0.0, 1.0) * 8.99);
    float a = glyphAlpha(g, fract(frag / cs), cs * uDpr);
    float vig = 1.0 - 0.45 * smoothstep(0.35, 0.95, length((frag / uRes - 0.5) * vec2(1.0, 0.9)) * 1.6);
    col += (v * 0.035 + v * a * 0.30) * uBgAmt * vig;
  }
  col += (hash12(gl_FragCoord.xy + fract(uTime) * 91.7) - 0.5) * 0.05;   // grano ~2.5 %
  col *= vis;
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
