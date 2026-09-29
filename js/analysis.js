// Live frame analysis for alignment guidance on the real camera feed.
//
// With a condensing lens in front of the camera, the retina shows up as a bright
// orange/red disc (the red reflex / aerial image) on a dark background. From a small
// downsampled frame we estimate:
//   fill   - fraction of the circular field covered by fundus-coloured pixels
//   cx, cy - centroid of those pixels (-1..1, display orientation)
//   glare  - fraction of blown-out white pixels (corneal / lens reflections)
//   lum    - mean luminance of the fundus pixels (exposure)
//   motion - mean absolute frame-to-frame change (hand shake)
//   sharp  - std-dev of the Laplacian over the central crop (focus metric; relative only)

const A = 96;           // analysis resolution for colour / geometry
const F = 160;          // resolution for the focus metric
const ac = document.createElement('canvas'); ac.width = ac.height = A;
const ag = ac.getContext('2d', { willReadFrequently: true });
const fc = document.createElement('canvas'); fc.width = fc.height = F;
const fg = fc.getContext('2d', { willReadFrequently: true });

let prev = null;
export const mask = new Uint8Array(A * A); // 0 none, 1 fundus, 2 glare
export const MASK_SIZE = A;

export function resetAnalysis() { prev = null; }

export function isFundus(r, g, b) { return r > 50 && r > g * 1.3 && r > b * 1.45; }
export function isGlare(r, g, b) { return r > 245 && g > 235 && b > 220; }

export function laplacianStd(data, w, h) {
  let s = 0, s2 = 0, k = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = (y * w + x) * 4 + 1; // green channel carries most retinal detail
      const l = 4 * data[i] - data[i - 4] - data[i + 4] - data[i - w * 4] - data[i + w * 4];
      s += l; s2 += l * l; k++;
    }
  }
  const m = s / k;
  return Math.sqrt(Math.max(0, s2 / k - m * m));
}

export function analyze(video, zoom, flip) {
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh || video.readyState < 2) return null;
  const m = Math.min(vw, vh) / zoom;

  ag.save();
  if (flip) { ag.translate(A, A); ag.rotate(Math.PI); }
  ag.drawImage(video, (vw - m) / 2, (vh - m) / 2, m, m, 0, 0, A, A);
  ag.restore();
  const d = ag.getImageData(0, 0, A, A).data;

  const R = A / 2, R2 = R * R, cur = new Uint8Array(A * A);
  let n = 0, cnt = 0, sx = 0, sy = 0, glare = 0, flum = 0, lum = 0, diff = 0;
  for (let y = 0; y < A; y++) {
    for (let x = 0; x < A; x++) {
      const j = y * A + x, dx = x + 0.5 - R, dy = y + 0.5 - R;
      mask[j] = 0;
      if (dx * dx + dy * dy > R2) continue;
      const i = j * 4, r = d[i], g = d[i + 1], b = d[i + 2];
      const L = (r * 77 + g * 150 + b * 29) >> 8;
      cur[j] = L; n++; lum += L;
      if (prev) diff += Math.abs(L - prev[j]);
      if (isGlare(r, g, b)) { glare++; mask[j] = 2; continue; }
      if (isFundus(r, g, b)) { cnt++; sx += dx; sy += dy; flum += L; mask[j] = 1; }
    }
  }
  const hadPrev = !!prev;
  prev = cur;

  const fm = m * 0.5;
  fg.drawImage(video, (vw - fm) / 2, (vh - fm) / 2, fm, fm, 0, 0, F, F);
  const sharp = laplacianStd(fg.getImageData(0, 0, F, F).data, F, F);

  return {
    fill: cnt / n,
    cx: cnt ? sx / cnt / R : 0,
    cy: cnt ? sy / cnt / R : 0,
    glare: glare / n,
    lum: cnt ? flum / cnt : lum / n,
    motion: hadPrev ? diff / n / 255 : 0,
    sharp,
  };
}

// Focus metric of an arbitrary canvas (used to pick the sharpest frame of a burst).
export function sharpnessOf(canvas) {
  const s = canvas.width, m = s * 0.5;
  fg.drawImage(canvas, (s - m) / 2, (s - m) / 2, m, m, 0, 0, F, F);
  return laplacianStd(fg.getImageData(0, 0, F, F).data, F, F);
}
