export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export const wait = (ms) => new Promise((r) => setTimeout(r, ms));
export const pick = (o, keys) => { const r = {}; for (const k of keys) if (o && k in o) r[k] = o[k]; return r; };

export const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } },
  del(k) { try { localStorage.removeItem(k); } catch (e) {} },
};

const pad = (n) => String(n).padStart(2, '0');
export const stamp = (t) => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
export const fmtTime = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
export const fmtD = (v) => (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(2) + ' D';
export const fmtMM = (v) => (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(2);
export const pct = (v) => Math.round(clamp(v, 0, 1) * 100) + '%';
export const haptic = (ms) => { try { navigator.vibrate && navigator.vibrate(ms); } catch (e) {} };
export const otherEye = (e) => (e === 'OD' ? 'OS' : 'OD');
export const toBlob = (canvas, type = 'image/jpeg', q = 0.92) => new Promise((r) => canvas.toBlob(r, type, q));

let toastT;
export function toast(msg, ms = 2400) {
  const t = $('#toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), ms);
}

// Coalesces rapid calls to an async setter (e.g. slider -> applyConstraints) so only the latest value is applied.
export function latest(fn) {
  let busy = false, pending;
  return async (v) => {
    pending = v;
    if (busy) return;
    busy = true;
    while (pending !== undefined) { const x = pending; pending = undefined; try { await fn(x); } catch (e) {} }
    busy = false;
  };
}

let AC = null;
export function shutterSound() {
  try {
    AC = AC || new (window.AudioContext || window.webkitAudioContext)();
    const n = Math.floor(AC.sampleRate * 0.09), b = AC.createBuffer(1, n, AC.sampleRate), d = b.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 3);
    const src = AC.createBufferSource(), f = AC.createBiquadFilter(), gn = AC.createGain();
    src.buffer = b; f.type = 'highpass'; f.frequency.value = 1200; gn.gain.value = 0.45;
    src.connect(f).connect(gn).connect(AC.destination); src.start();
  } catch (e) {}
}
