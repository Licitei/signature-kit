const ditherScript = `
const canvas = document.querySelector("canvas");
const context = canvas.getContext("2d");
const source = new Image();
source.src = "/landing/hero-chapada.webp";
const bayer = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((value) => (value + 0.5) / 16);
const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
source.decode().then(() => {
  const width = 240;
  const height = Math.round((width * innerHeight) / innerWidth);
  canvas.width = width;
  canvas.height = height;
  const sample = document.createElement("canvas");
  sample.width = width;
  sample.height = height;
  const sampleContext = sample.getContext("2d");
  sampleContext.filter = "blur(1.2px)";
  const scale = Math.max(width / source.width, height / source.height);
  sampleContext.drawImage(source, (width - source.width * scale) / 2, height - source.height * scale, source.width * scale, source.height * scale);
  const pixels = sampleContext.getImageData(0, 0, width, height).data;
  const light = new Float32Array(width * height);
  for (let index = 0; index < light.length; index++)
    light[index] = (0.2126 * pixels[index * 4] + 0.7152 * pixels[index * 4 + 1] + 0.0722 * pixels[index * 4 + 2]) / 255;
  const frame = context.createImageData(width, height);
  const palette = [[7, 28, 38], [11, 82, 117], [246, 96, 19], [250, 250, 247]];
  const draw = (time) => {
    const wave = time / 1400;
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const index = y * width + x;
        const shimmer = 0.07 * Math.sin(x / 9 + wave) * Math.cos(y / 11 - wave * 0.7);
        const level = Math.min(0.999, Math.max(0, light[index] + shimmer)) * 3;
        const base = Math.floor(level);
        const color = palette[Math.min(3, base + (level - base > bayer[(y % 4) * 4 + (x % 4)] ? 1 : 0))];
        frame.data[index * 4] = color[0];
        frame.data[index * 4 + 1] = color[1];
        frame.data[index * 4 + 2] = color[2];
        frame.data[index * 4 + 3] = 255;
      }
    context.putImageData(frame, 0, 0);
    if (!still) setTimeout(() => requestAnimationFrame(draw), 66);
  };
  requestAnimationFrame(draw);
});
`;

export const notFoundPage = (fontUrl: string) => `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Página não encontrada | SignatureKit</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<style>
@font-face { font-family: "Geist Variable"; src: url("${fontUrl}") format("woff2"); font-weight: 100 900; font-display: swap; }
html, body { margin: 0; height: 100%; }
body { position: relative; overflow: hidden; background: #071c26; color: #fff; font-family: "Geist Variable", ui-sans-serif, system-ui, sans-serif; letter-spacing: -0.011em; }
canvas { position: fixed; inset: 0; width: 100%; height: 100%; image-rendering: pixelated; }
.shade { position: fixed; inset: 0; background: linear-gradient(180deg, rgba(6, 30, 43, 0.92) 0%, rgba(6, 30, 43, 0.75) 45%, rgba(6, 30, 43, 0) 80%); }
main { position: relative; display: grid; justify-items: start; gap: 14px; max-width: 30rem; padding: 32px 24px; margin: 0 auto; padding-top: 18vh; }
.brand { display: inline-flex; align-items: center; gap: 8px; margin-bottom: 40px; color: inherit; text-decoration: none; font-weight: 600; }
.code { margin: 0; color: #FFB089; font-size: clamp(4rem, 14vw, 7rem); font-weight: 600; line-height: 0.9; letter-spacing: -0.06em; }
h1 { margin: 0; font-size: 1.75rem; font-weight: 600; letter-spacing: -0.035em; }
p { margin: 0; color: rgba(255, 255, 255, 0.86); line-height: 1.55; }
nav { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 14px; }
nav a { display: inline-flex; align-items: center; height: 42px; padding: 0 16px; border-radius: 10px; color: #fff; text-decoration: none; font-weight: 500; }
nav a:first-child { background: #C9460A; }
nav a:last-child { background: rgba(6, 30, 43, 0.6); box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.4); }
a:focus-visible { outline: 2px solid #FF884B; outline-offset: 3px; border-radius: 6px; }
</style>
</head>
<body>
<canvas aria-hidden="true"></canvas>
<div class="shade" aria-hidden="true"></div>
<main>
<a class="brand" href="/"><svg width="30" height="20" viewBox="0 0 34 22" aria-hidden="true"><path d="M2 15c3 0 4-10 7-10s-2 12 2 12 3-8 6-8-1 6 2 6 3-4 6-4 2 2 4 2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="31.5" cy="13" r="2" fill="#FF884B"/></svg>SignatureKit</a>
<p class="code">404</p>
<h1>Esta página não existe.</h1>
<p>O endereço pode ter mudado. Volte ao início ou procure na documentação.</p>
<nav aria-label="Atalhos"><a href="/">Página inicial</a><a href="/docs">Documentação</a></nav>
</main>
<script type="module">${ditherScript}</script>
</body>
</html>`;
