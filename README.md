# ALYSAURIO — Portafolio interactivo

Sitio 100 % estático (HTML + CSS + ES Modules + Three.js por CDN con `importmap`). Sin build.

## Ejecutar
- **GitHub Pages:** sube el repo y activa Pages sobre la rama principal (`/` root). Ya incluye `.nojekyll`.
- **Local:** necesita HTTP (los módulos y `fetch` no funcionan con `file://`), p. ej. `npx serve .` o `python -m http.server`.

## Editar contenido
- Proyectos: `data/projects.json` (añade entradas y el aro se divide en N segmentos automáticamente).
- Vídeos: `assets/videos/proyectoN.mp4`. Si falta alguno se usa un vídeo procedural de respaldo (`js/videoManager.js`).
- Correo: constante `CONTACT_EMAIL` al inicio de `js/main.js` (y el texto inicial en `index.html`).

## Estructura
- `js/main.js` — máquina de estados (`HERO_TEXT`, `RING_IDLE`, `RING_JUNCTION`, `RING_PREVIEW`, `DETAIL_RECT`, `ABOUT_DIVIDER`), scroll, hit-testing, UI.
- `js/particles.js` — 12k–25k partículas (un `THREE.Points` + atlas tipográfico), SDF, fluido del cursor, densidad, cuerda.
- `js/videoManager.js` — carga de vídeo, respaldo procedural, paleta dominante (8×8 a ~7 Hz).
- `js/shaders.js` — filtro ASCII de fondo, mosaico→vídeo y lupa ASCII radial multiescala.
