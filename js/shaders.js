// shaders.js — GLSL + atlas tipográfico. Rampa ordenada por densidad de tinta.
export const GLYPHS = ['·', ':', ';', '=', '+', 'x', '#', '%', '@'];
export const GLYPH_COUNT = GLYPHS.length;

/** Atlas horizontal (1 fila) con los glifos en blanco sobre transparente; se usa el canal alfa. */
export function createGlyphAtlas(THREE, cell = 48) {
  const c = document.createElement('canvas');
  c.width = cell * GLYPH_COUNT; c.height = cell;
  const g = c.getContext('2d');
  g.clearRect(0, 0, c.width, c.height);
  g.fillStyle = '#fff';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.font = `700 ${Math.round(cell * 0.82)}px "JetBrains Mono","Space Mono",monospace`;
  GLYPHS.forEach((ch, i) => g.fillText(ch, i * cell + cell / 2, cell / 2 + cell * 0.04));
  const tex = new THREE.CanvasTexture(c);
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

const COMMON = /* glsl */`
uniform sampler2D tAtlas;
const float GLYPH_N = 9.0;
float glyphAlpha(float g, vec2 f){
  f = clamp(f, 0.04, 0.96);
  return texture2D(tAtlas, vec2((g + f.x) / GLYPH_N, f.y)).a;
}
float hash12(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
// object-fit: cover de un vídeo (aspecto va) dentro de la caja (centro c, semitamaño h) — p en px CSS, y hacia arriba
vec2 coverUV(vec2 p, vec2 c, vec2 h, float va){
  vec2 q = (p - c) / (2.0 * h) + 0.5;
  float ba = h.x / h.y;
  if (ba > va) q.y = 0.5 + (q.y - 0.5) * (va / ba);
  else         q.x = 0.5 + (q.x - 0.5) * (ba / va);
  return q;
}
`;

/* ---------------- Partículas: un punto = un glifo del atlas ---------------- */
export const PARTICLE_VS = /* glsl */`
attribute vec3 aColor;
attribute float aGlyph;
uniform vec2 uRes;
uniform float uCell;
uniform float uDpr;
varying vec3 vColor;
varying float vGlyph;
void main(){
  vec2 p = (floor(position.xy / uCell) + 0.5) * uCell;   // rejilla de celdas (malla ASCII densa)
  gl_Position = vec4(p / (uRes * 0.5), 0.0, 1.0);
  gl_PointSize = uCell * uDpr;
  vColor = aColor; vGlyph = aGlyph;
}`;

export const PARTICLE_FS = /* glsl */`
${COMMON}
varying vec3 vColor;
varying float vGlyph;
void main(){
  float a = glyphAlpha(vGlyph, vec2(gl_PointCoord.x, 1.0 - gl_PointCoord.y));
  if (a < 0.05) discard;
  gl_FragColor = vec4(vColor, min(1.0, a * 1.15));
}`;

export const QUAD_VS = /* glsl */`
varying vec2 vUv;
void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

/* ---------------- Fondo: filtro ASCII/semitono de los clips + tinte ambiental + grano ---------------- */
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
varying vec2 vUv;
void main(){
  vec2 frag = gl_FragCoord.xy / uDpr;
  vec3 base = mix(uBase, uTint, uTintAmt);
  vec3 col = base;
  if (uBgAmt > 0.003) {
    float cs = 9.0 * uSimplify;
    vec2 cc = (floor(frag / cs) + 0.5) * cs;
    vec2 uv = coverUV(cc, uRes * 0.5, uRes * 0.5, uVAspect);
    vec3 v = mix(texture2D(tA, uv).rgb, texture2D(tB, uv).rgb, uMix);
    float lum = dot(v, vec3(0.299, 0.587, 0.114));
    float g = floor(clamp(pow(lum, 0.75) * 1.25, 0.0, 1.0) * 8.99);
    float a = glyphAlpha(g, fract(frag / cs));
    float vig = 1.0 - 0.45 * smoothstep(0.35, 0.95, length((frag / uRes - 0.5) * vec2(1.0, 0.9)) * 1.6);
    col += (v * 0.035 + v * a * 0.30) * uBgAmt * vig;   // baja opacidad, no compite con el título
  }
  col += (hash12(gl_FragCoord.xy + fract(uTime) * 91.7) - 0.5) * 0.05;  // grano ~2.5 %
  gl_FragColor = vec4(col, 1.0);
}`;

/* ---------------- Caja de vídeo: arito / rectángulo + mosaico + lupa ASCII radial ---------------- */
export const BOX_FS = /* glsl */`
${COMMON}
uniform sampler2D tVideo;
uniform vec2 uCenter;
uniform vec2 uHalf;
uniform float uCorner;
uniform float uSoft;
uniform float uMosaic;
uniform float uVAspect;
uniform vec2 uMagPos;
uniform float uMagR;
uniform float uDpr;
uniform float uTime;
uniform float uAlpha;
varying vec2 vUv;

float sdRoundBox(vec2 p, vec2 b, float r){
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}
vec3 vid(vec2 pt){ return texture2D(tVideo, coverUV(pt, uCenter, uHalf, uVAspect)).rgb; }

vec3 asciiAt(vec2 frag, float cs){
  vec2 cc = (floor(frag / cs) + 0.5) * cs;
  vec3 c = vid(cc);
  float lum = dot(c, vec3(0.299, 0.587, 0.114));
  float g = floor(clamp(pow(lum, 0.8) * 1.2, 0.0, 1.0) * 8.99);
  float a = glyphAlpha(g, fract(frag / cs));
  return mix(c * 0.10, c * 1.3, a);
}
vec3 mosaicAt(vec2 frag, float cs){
  return vid((floor(frag / cs) + 0.5) * cs);
}

void main(){
  if (uAlpha <= 0.001) discard;
  vec2 frag = gl_FragCoord.xy / uDpr;
  float sd = sdRoundBox(frag - uCenter, uHalf, uCorner);
  float mask = smoothstep(0.0, uSoft, -sd);          // borde suave hacia el fondo principal
  if (mask < 0.004) discard;

  // mosaico de bloques que se subdividen en pasos (80 → 1 px)
  float lvl = floor((1.0 - uMosaic) * 7.0);
  float block = uMosaic > 0.002 ? 80.0 * exp2(-lvl) : 1.0;
  vec2 origin = uCenter - uHalf;
  vec2 sp = block > 1.5 ? origin + (floor((frag - origin) / block) + 0.5) * block : frag;
  vec3 col = vid(sp);

  if (uMagR > 1.0) {
    float d = length(frag - uMagPos);
    float R = uMagR;
    float wA = 1.0 - smoothstep(0.30 * R, 0.42 * R, d);   // núcleo: ASCII ~6 px
    float wB = 1.0 - smoothstep(0.62 * R, 0.74 * R, d);   // anillo: ASCII ~13 px
    float wC = 1.0 - smoothstep(0.88 * R, 1.00 * R, d);   // exterior: mosaico → vídeo
    col = mix(col, mosaicAt(frag, 14.0), wC);
    col = mix(col, asciiAt(frag, 13.0), wB);
    col = mix(col, asciiAt(frag, 6.0), wA);
  }
  col += (hash12(gl_FragCoord.xy + fract(uTime) * 57.3) - 0.5) * 0.05;   // grano 2–3 %
  gl_FragColor = vec4(col, mask * uAlpha);
}`;
