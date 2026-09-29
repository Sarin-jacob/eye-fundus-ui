// Simulation mode: a procedurally drawn retina plus a hand-held phone model.
// Used only when "Simulation mode" is on in settings; no hardware is touched.
import { clamp } from './util.js';

const TAU = Math.PI * 2;
const MMPX = 52;    // fundus texture px per mm of misalignment
const FIELD = 0.62; // fraction of texture radius visible in the 45° field

function rng(seed) {
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const fundusCache = {};
export const getFundus = (eye) => fundusCache[eye] || (fundusCache[eye] = makeFundus(eye));

function makeFundus(eye) {
  const N = 1024, R = N / 2, cv = document.createElement('canvas');
  cv.width = cv.height = N;
  const g = cv.getContext('2d'), r = rng(eye === 'OD' ? 20417 : 73901);
  const t = eye === 'OD' ? -1 : 1; // temporal x-direction: OD shows the disc on the right
  const disc = { x: R - t * R * 0.232, y: R - R * 0.02 }, mac = { x: R + t * R * 0.232, y: R + R * 0.03 }, dr = R * 0.092;

  let gr = g.createRadialGradient(mac.x, mac.y, 0, R, R, R);
  gr.addColorStop(0, '#8e2a0e'); gr.addColorStop(0.2, '#b5431a'); gr.addColorStop(0.55, '#cf5e24'); gr.addColorStop(0.8, '#bb4c1c'); gr.addColorStop(1, '#5a1a08');
  g.fillStyle = gr; g.fillRect(0, 0, N, N);

  for (let i = 0; i < 3000; i++) {
    const x = r() * N, y = r() * N, s = 2 + r() * 10;
    g.fillStyle = r() < 0.55 ? `rgba(255,150,80,${0.02 + r() * 0.03})` : `rgba(80,15,0,${0.02 + r() * 0.04})`;
    g.beginPath(); g.ellipse(x, y, s, s * (0.4 + r() * 0.6), r() * Math.PI, 0, TAU); g.fill();
  }

  gr = g.createRadialGradient(mac.x, mac.y, 0, mac.x, mac.y, R * 0.18);
  gr.addColorStop(0, 'rgba(55,8,0,.6)'); gr.addColorStop(0.35, 'rgba(70,12,0,.35)'); gr.addColorStop(1, 'rgba(70,12,0,0)');
  g.fillStyle = gr; g.fillRect(0, 0, N, N);

  gr = g.createRadialGradient(disc.x, disc.y, dr * 0.8, disc.x, disc.y, dr * 1.7);
  gr.addColorStop(0, 'rgba(240,150,90,.5)'); gr.addColorStop(1, 'rgba(240,150,90,0)');
  g.fillStyle = gr; g.fillRect(0, 0, N, N);
  gr = g.createRadialGradient(disc.x, disc.y, 0, disc.x, disc.y, dr);
  gr.addColorStop(0, '#ffe2a6'); gr.addColorStop(0.6, '#f6be76'); gr.addColorStop(0.9, '#e89456'); gr.addColorStop(1, 'rgba(220,120,60,0)');
  g.fillStyle = gr; g.beginPath(); g.ellipse(disc.x, disc.y, dr * 0.92, dr, 0, 0, TAU); g.fill();

  const vessels = [];
  function grow(x, y, a, w, len, curv, type, depth) {
    const pts = [[x, y, w]]; let L = 0, nb = 60 + r() * 90;
    while (L < len && w > 0.7) {
      const dmx = x - mac.x, dmy = y - mac.y, dm = Math.hypot(dmx, dmy);
      if (dm < R * 0.2) { const am = Math.atan2(dmy, dmx); a += Math.atan2(Math.sin(am - a), Math.cos(am - a)) * 0.12 * (1 - dm / (R * 0.2)); }
      a += curv + (r() - 0.5) * 0.14;
      x += Math.cos(a) * 4; y += Math.sin(a) * 4; L += 4; w *= 0.998;
      pts.push([x, y, w]);
      if (L > nb && depth < 3) {
        nb = L + 70 + r() * 110;
        const s = r() < 0.5 ? -1 : 1;
        grow(x, y, a + s * (0.45 + r() * 0.55), w * (0.55 + r() * 0.15), (len - L) * (0.35 + r() * 0.35) + 30, (r() - 0.5) * 0.02, type, depth + 1);
        w *= 0.9;
      }
      if (Math.hypot(x - R, y - R) > R * 1.02) break;
    }
    vessels.push({ pts, type });
  }
  const arcades = [
    [Math.atan2(-1, 0.3 * t), t * 0.0105, R * 1.25, 1],
    [Math.atan2(1, 0.3 * t), -t * 0.0105, R * 1.25, 1],
    [Math.atan2(-1, -0.8 * t), -t * 0.002, R * 0.75, 0.75],
    [Math.atan2(1, -0.8 * t), t * 0.002, R * 0.75, 0.75],
    [Math.atan2(-0.35, t), t * 0.004, R * 0.35, 0.4],
    [Math.atan2(0.35, t), -t * 0.004, R * 0.35, 0.4],
  ];
  for (const [a, c, len, s] of arcades) {
    const o = (r() - 0.5) * 0.15;
    grow(disc.x + Math.cos(a) * dr * 0.2, disc.y + Math.sin(a) * dr * 0.2, a + 0.07 + o, 9 * s, len, c, 'v', 0);
    grow(disc.x + Math.cos(a) * dr * 0.15, disc.y + Math.sin(a) * dr * 0.15, a - 0.07 + o, 6.5 * s, len * 0.97, c * 1.02, 'a', 0);
  }
  const stroke = (p, col, wm) => {
    g.strokeStyle = col; g.lineCap = 'round'; g.lineJoin = 'round';
    for (let i = 1; i < p.length; i++) { g.lineWidth = p[i][2] * wm; g.beginPath(); g.moveTo(p[i - 1][0], p[i - 1][1]); g.lineTo(p[i][0], p[i][1]); g.stroke(); }
  };
  for (const v of vessels) if (v.type === 'v') stroke(v.pts, '#761710', 1);
  for (const v of vessels) if (v.type === 'a') stroke(v.pts, '#b8321a', 1);
  for (const v of vessels) if (v.type === 'a') stroke(v.pts, 'rgba(255,170,130,.3)', 0.28);

  gr = g.createRadialGradient(disc.x, disc.y, 0, disc.x, disc.y, dr);
  gr.addColorStop(0, 'rgba(255,225,170,.55)'); gr.addColorStop(1, 'rgba(255,225,170,0)');
  g.fillStyle = gr; g.fillRect(disc.x - dr, disc.y - dr, dr * 2, dr * 2);
  gr = g.createRadialGradient(disc.x + t * dr * 0.12, disc.y, 0, disc.x + t * dr * 0.12, disc.y, dr * 0.42);
  gr.addColorStop(0, 'rgba(255,248,225,.9)'); gr.addColorStop(1, 'rgba(255,240,210,0)');
  g.fillStyle = gr; g.fillRect(disc.x - dr, disc.y - dr, dr * 2, dr * 2);

  g.fillStyle = 'rgba(255,235,215,.55)'; g.beginPath(); g.arc(mac.x, mac.y, 2.6, 0, TAU); g.fill();
  g.strokeStyle = 'rgba(255,215,190,.035)'; g.lineWidth = 6; g.beginPath(); g.ellipse(mac.x, mac.y, R * 0.13, R * 0.11, 0, 0, TAU); g.stroke();

  gr = g.createRadialGradient(R, R, R * 0.7, R, R, R);
  gr.addColorStop(0, 'rgba(20,4,0,0)'); gr.addColorStop(1, 'rgba(20,4,0,.85)');
  g.fillStyle = gr; g.fillRect(0, 0, N, N);

  return { canvas: cv, disc, mac, c: R };
}

let IRIS = null;
function iris() {
  if (IRIS) return IRIS;
  const N = 512, cv = document.createElement('canvas'); cv.width = cv.height = N;
  const g = cv.getContext('2d'), r = rng(99), c = N / 2;
  let gr = g.createRadialGradient(c, c, N * 0.38, c, c, N * 0.5);
  gr.addColorStop(0, '#b3a79d'); gr.addColorStop(0.6, '#6c625b'); gr.addColorStop(1, '#000');
  g.fillStyle = gr; g.fillRect(0, 0, N, N);
  gr = g.createRadialGradient(c, c, N * 0.13, c, c, N * 0.4);
  gr.addColorStop(0, '#6a5442'); gr.addColorStop(1, '#382a20');
  g.fillStyle = gr; g.beginPath(); g.arc(c, c, N * 0.4, 0, TAU); g.fill();
  for (let i = 0; i < 700; i++) {
    const a = r() * TAU, r0 = N * (0.13 + r() * 0.05), r1 = N * (0.3 + r() * 0.1);
    g.strokeStyle = r() < 0.5 ? `rgba(190,160,120,${0.15 + r() * 0.25})` : `rgba(25,16,10,${0.15 + r() * 0.3})`;
    g.lineWidth = 0.6 + r() * 1.6; g.beginPath();
    g.moveTo(c + Math.cos(a) * r0, c + Math.sin(a) * r0);
    g.quadraticCurveTo(c + Math.cos(a + 0.08) * (r0 + r1) / 2, c + Math.sin(a + 0.08) * (r0 + r1) / 2, c + Math.cos(a) * r1, c + Math.sin(a) * r1);
    g.stroke();
  }
  g.strokeStyle = 'rgba(12,8,6,.85)'; g.lineWidth = N * 0.025; g.beginPath(); g.arc(c, c, N * 0.4, 0, TAU); g.stroke();
  gr = g.createRadialGradient(c, c, 0, c, c, N * 0.155);
  gr.addColorStop(0, '#2a0806'); gr.addColorStop(0.85, '#0a0202'); gr.addColorStop(1, 'rgba(10,2,2,0)');
  g.fillStyle = gr; g.beginPath(); g.arc(c, c, N * 0.155, 0, TAU); g.fill();
  return (IRIS = cv);
}

export const visOf = (z) => clamp(1 - (Math.abs(z) - 0.6) / 2.4, 0, 1);
function fixPoint(eye, fix) {
  const F = getFundus(eye);
  return fix === 'macula' ? F.mac : fix === 'disc' ? F.disc : { x: F.c, y: F.c };
}

// What the lens sees for a given misalignment (mm; z > 0 = too far).
export function renderView(g, W, o) {
  const { x, y, z } = o.align, vis = visOf(z), c = W / 2;
  g.setTransform(1, 0, 0, 1, 0, 0); g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
  g.fillStyle = '#000'; g.fillRect(0, 0, W, W);

  if (vis > 0) {
    const F = getFundus(o.eye), N = F.canvas.width, k = W / (FIELD * N), P = fixPoint(o.eye, o.fix);
    g.globalAlpha = vis;
    g.setTransform(k, 0, 0, k, c - (P.x - x * MMPX) * k, c - (P.y - y * MMPX) * k);
    g.drawImage(F.canvas, 0, 0);
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 1;
    const e = Math.hypot(x, y);
    if (e > 0.08) {
      const ux = x / e, uy = y / e, gx = c + ux * W * 0.18, gy = c + uy * W * 0.18;
      const gr = g.createRadialGradient(gx, gy, W * 0.28, gx, gy, W * 0.62);
      gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(1, `rgba(0,0,0,${Math.min(0.97, e * 0.55)})`);
      g.fillStyle = gr; g.fillRect(0, 0, W, W);
    }
    const vg = g.createRadialGradient(c, c, W * 0.36, c, c, W * 0.5);
    vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,.55)');
    g.fillStyle = vg; g.fillRect(0, 0, W, W);
  }

  if (vis < 1) {
    const far = clamp(z / 8, -1, 1), sc = z > 0 ? 1 - far * 0.55 : 1 - far * 0.4;
    const d = W * 0.95 * sc, ax = c + x * W * 0.09, ay = c + y * W * 0.09;
    g.globalAlpha = 1 - vis;
    g.drawImage(iris(), ax - d / 2, ay - d / 2, d, d);
    g.fillStyle = '#fff';
    for (const dx of [-0.05, 0.05]) { g.beginPath(); g.arc(ax + dx * d - x * W * 0.02, ay - 0.02 * d, W * 0.012 * sc, 0, TAU); g.fill(); }
    g.globalAlpha = 1;
  }

  if (z < -0.6) {
    const a = clamp((-z - 0.6) / 2, 0, 0.85), gr = g.createRadialGradient(c, c, 0, c, c, W * 0.55);
    gr.addColorStop(0, `rgba(255,250,240,${a})`); gr.addColorStop(1, `rgba(255,240,220,${a * 0.25})`);
    g.fillStyle = gr; g.fillRect(0, 0, W, W);
  }
  const ring = clamp(1 - Math.abs(Math.abs(z) - 1.1) / 0.6, 0, 1) * 0.35;
  if (ring > 0) {
    g.strokeStyle = `rgba(255,245,230,${ring})`; g.lineWidth = W * 0.03;
    g.beginPath(); g.arc(c + x * W * 0.03, c + y * W * 0.03, W * 0.34, 0, TAU); g.stroke();
  }
}

// Hand-held phone: spring toward the operator's target plus physiological tremor.
export function step(S, dt, t, dragging, zdragging) {
  const A = S.align, V = S.vel;
  if (S.assist && !zdragging) {
    const rate = Math.abs(S.approach) > 2 ? 2.2 : 1.1;
    S.approach -= Math.sign(S.approach) * Math.min(Math.abs(S.approach), rate * dt);
    if (!dragging) { const d = Math.exp(-dt * 0.7); S.off.x *= d; S.off.y *= d; }
  }
  const tr = S.assist ? 0.06 : 0.14;
  const T = {
    x: S.off.x + tr * (Math.sin(t * 1.7) + 0.6 * Math.sin(t * 3.1 + 1.3) + 0.35 * Math.sin(t * 6.3 + 0.4)),
    y: S.off.y + tr * (Math.sin(t * 1.3 + 2) + 0.6 * Math.sin(t * 2.7 + 0.2) + 0.35 * Math.sin(t * 5.9 + 1.1)),
    z: S.approach + (S.assist ? 0.18 : 0.35) * (Math.sin(t * 0.9) + 0.5 * Math.sin(t * 2.2 + 0.7)),
  };
  for (const k of ['x', 'y', 'z']) { V[k] += ((T[k] - A[k]) * 20 - V[k] * 8) * dt; A[k] += V[k] * dt; }
}

export function reset(S, from = 6) {
  S.approach = from;
  S.off = { x: (Math.random() - 0.5) * 2.4, y: (Math.random() - 0.5) * 2.4 };
  S.align = { x: S.off.x, y: S.off.y, z: from };
  S.vel = { x: 0, y: 0, z: 0 };
}

export function guidance(S) {
  const { x, y, z } = S.align, e = Math.hypot(x, y), fe = Math.abs(S.diopter - S.refraction[S.eye]);
  if (z > 1.2) return ['far', 'Move closer to the eye', 'warn'];
  if (z < -1.2) return ['near', 'Too close — pull back', 'bad'];
  if (e > 0.35) {
    const dir = Math.abs(x) > Math.abs(y) ? (x > 0 ? '→' : '←') : (y > 0 ? '↓' : '↑');
    return ['xy', 'Centre on pupil  ' + dir, 'warn'];
  }
  if (Math.abs(z) > 0.5) return ['z', z > 0 ? 'Slightly closer' : 'Slightly back', 'warn'];
  if (fe > 0.75) return ['focus', 'Adjust focus  (tap AF)', 'warn'];
  return ['ready', 'Aligned — hold steady', 'ok'];
}

export function blurPx(S, W) {
  const fe = Math.abs(S.diopter - S.refraction[S.eye]), vis = visOf(S.align.z);
  return (Math.min(9, fe * 1.5) * vis + (1 - vis) * 1.5) * (W / 360);
}

export function quality(S, s) {
  const fe = Math.abs(s.D - S.refraction[s.eye]), e = Math.hypot(s.align.x, s.align.y), z = Math.abs(s.align.z);
  const q = 98 - fe * 16 - Math.max(0, e - 0.1) * 45 - Math.max(0, z - 0.2) * 18 - Math.abs(s.flash - 70) * 0.35;
  return Math.round(clamp(q, 3, 99));
}

const FILTER_OK = (() => { const g = document.createElement('canvas').getContext('2d'); g.filter = 'blur(1px)'; return g.filter === 'blur(1px)'; })();

// Colour still at the moment of the (simulated) flash.
export function capture(S, s, W = 1024) {
  const tmp = document.createElement('canvas'), out = document.createElement('canvas');
  tmp.width = tmp.height = out.width = out.height = W;
  renderView(tmp.getContext('2d'), W, { eye: s.eye, align: s.align, fix: s.fix });
  const g = out.getContext('2d');
  g.fillStyle = '#000'; g.fillRect(0, 0, W, W);
  const fe = Math.abs(s.D - S.refraction[s.eye]);
  const px = Math.min(9, fe * 1.5) * visOf(s.align.z) * (W / 360);
  if (px < 0.3) g.drawImage(tmp, 0, 0);
  else if (FILTER_OK) { g.filter = `blur(${px}px)`; g.drawImage(tmp, 0, 0); g.filter = 'none'; }
  else {
    const sz = Math.max(16, Math.round(W / (1 + px / 2))), t = document.createElement('canvas');
    t.width = t.height = sz; t.getContext('2d').drawImage(tmp, 0, 0, sz, sz);
    g.drawImage(t, 0, 0, W, W);
  }
  const ex = (s.flash - 70) / 100;
  if (ex < 0) { g.fillStyle = `rgba(0,0,0,${Math.min(0.85, -ex * 1.6)})`; g.fillRect(0, 0, W, W); }
  else if (ex > 0) { g.globalCompositeOperation = 'lighter'; g.fillStyle = `rgba(255,190,150,${ex * 0.55})`; g.fillRect(0, 0, W, W); g.globalCompositeOperation = 'source-over'; }
  return out;
}

export function prewarm() { getFundus('OD'); getFundus('OS'); iris(); }
