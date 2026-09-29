import { $, $$, clamp, lerp, wait, pick, store, stamp, fmtTime, fmtD, fmtMM, pct, haptic, otherEye, toBlob, toast, latest, shutterSound } from './util.js';
import { db } from './db.js';
import { Camera, squareCrop } from './camera.js';
import { analyze, sharpnessOf, resetAnalysis, mask, MASK_SIZE } from './analysis.js';
import * as sim from './sim.js';

const FIX_LABEL = { central: 'Central', macula: 'Macula', disc: 'Disc' };
const PUPIL_LABEL = { non: 'Non-mydriatic', dil: 'Dilated' };
const LIGHT_LABEL = { torch: 'Torch', capture: 'On capture', off: 'Off' };

/* ------------------------------------------------------------------ state */
const SETTINGS_KEYS = ['source', 'camId', 'light', 'flip', 'exposure', 'burst', 'hires', 'overlay', 'zoom', 'auto', 'grid', 'sound', 'assist', 'flash', 'fixation'];
const S = {
  // settings
  source: 'camera', camId: '', light: 'torch', flip: true, exposure: 0, burst: true, hires: false, overlay: false, zoom: 1,
  auto: true, grid: false, sound: true, assist: true, flash: 70, fixation: 'central',
  // patient
  eye: 'OD', pupil: 'non', pid: '', pname: '',
  // runtime
  screen: 'home', captures: [], dbOK: null,
  hw: { state: 'idle', info: null, err: '' }, cams: [], phoneBatt: null, gyro: 0, hasMotion: false, motionAsked: false,
  camError: null, afBusy: false,
  armed: true, readyAt: 0, lockUntil: 0, busy: false,
  // simulation only
  connected: false, batt: 0, mode: 'IR', diopter: 0, refraction: { OD: -2.25, OS: -1.5 },
  align: { x: 0, y: 0, z: 6 }, vel: { x: 0, y: 0, z: 0 }, approach: 6, off: { x: 0, y: 0 }, af: null,
};
Object.assign(S, pick(store.get('fv.settings', {}), SETTINGS_KEYS));
Object.assign(S, pick(store.get('fv.patient', {}), ['pid', 'pname', 'eye', 'pupil']));
if (!LIGHT_LABEL[S.light]) S.light = 'torch';
const saveSettings = () => store.set('fv.settings', pick(S, SETTINGS_KEYS));
const savePatient = () => store.set('fv.patient', pick(S, ['pid', 'pname', 'eye', 'pupil']));
const isSim = () => S.source === 'sim';

const video = $('#cam');
const cam = new Camera(video);
const dz = () => (!isSim() && !cam.hasZoom ? S.zoom : 1); // digital zoom factor

function applyMode() {
  document.body.classList.toggle('sim', isSim());
  document.body.classList.toggle('real', !isSim());
  renderHw(); renderSimDevice(); renderStartHint();
}

/* ------------------------------------------------------------------ storage */
const withUrl = (r) => ({ ...r, url: URL.createObjectURL(r.blob) });

async function loadCaptures() {
  try {
    const old = store.get('fv.captures', null); // v0.1 kept data URLs in localStorage
    if (Array.isArray(old)) {
      for (const s of old) {
        const { img, ...rest } = s;
        await db.put({ ...rest, src: 'sim', details: [['Focus', fmtD(s.D || 0)], ['Flash', (s.flash || 70) + '%']], blob: await (await fetch(img)).blob() });
      }
      store.del('fv.captures');
    }
    S.captures = (await db.all()).sort((a, b) => b.t - a.t).map(withUrl);
    S.dbOK = true;
  } catch (e) {
    S.dbOK = false;
  }
  renderHome(); setThumb(); syncSettingsUI();
}
async function saveShot(rec) {
  S.captures.unshift(withUrl(rec));
  if (S.dbOK === false) { toast('Storage unavailable — image kept for this session only'); return; }
  try { await db.put(rec); } catch (e) { toast('Could not save — storage may be full'); }
}
async function deleteShot(id) {
  const i = S.captures.findIndex((s) => s.id === id);
  if (i < 0) return;
  URL.revokeObjectURL(S.captures[i].url);
  S.captures.splice(i, 1);
  try { await db.del(id); } catch (e) {}
}

/* ------------------------------------------------------------------ navigation */
function show(id) {
  if (id === 'capture' && isSim() && !S.connected) id = 'home';
  $$('.screen').forEach((s) => s.classList.toggle('active', s.id === id));
  const prev = S.screen; S.screen = id;
  if (id === 'capture') enterCapture(); else if (prev === 'capture') leaveCapture();
  if (id === 'review') renderReview();
  if (id === 'home') renderHome();
}
function go(id, replace) {
  const d = (history.state && history.state.d) || 0;
  history[replace ? 'replaceState' : 'pushState']({ id, d: replace ? d : d + 1 }, '', '#' + id);
  show(id);
}
function back() { if (history.state && history.state.d > 0) history.back(); else go('home', true); }
addEventListener('popstate', (e) => { closeViewer(); show((e.state && e.state.id) || 'home'); });

function bindSeg(sel, cb) {
  const el = $(sel);
  const set = (v) => $$('button', el).forEach((b) => b.classList.toggle('on', b.dataset.v === String(v)));
  el.addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b || b.disabled) return; set(b.dataset.v); cb(b.dataset.v); });
  return set;
}

/* ------------------------------------------------------------------ phone hardware */
const shortLabel = (l) => (l || 'Camera').replace(/\s*\([^)]*\)/g, '').replace(/camera2\s*/i, 'Camera ').trim().slice(0, 28) || 'Camera';
const fmtFocus = (v) => (v == null ? '—' : v >= 10 ? '∞' : v < 1 ? Math.round(v * 100) + ' cm' : v.toFixed(2) + ' m');

function camErr(e) {
  const n = e && e.name;
  if (n === 'NotAllowedError' || n === 'SecurityError') return ['Permission denied', 'Camera permission denied. Allow it in the browser’s site settings.'];
  if (n === 'NotFoundError' || n === 'OverconstrainedError') return ['No camera', 'No usable camera was found.'];
  if (n === 'NotReadableError') return ['Camera busy', 'The camera is in use by another app.'];
  return ['Unavailable', 'Camera unavailable' + (n ? ` (${n})` : '')];
}

function describeCam() {
  const c = cam.caps;
  return {
    label: shortLabel(cam.label), res: `${cam.width}×${cam.height}`,
    torch: cam.hasTorch,
    focus: cam.hasManualFocus ? 'Manual + AF' : cam.focusModes.length ? 'Auto only' : 'Not exposed',
    zoom: cam.hasZoom ? `${+c.zoom.min.toFixed(1)}–${+c.zoom.max.toFixed(1)}×` : 'Digital',
    exposure: cam.hasExposure ? { min: c.exposureCompensation.min, max: c.exposureCompensation.max, step: c.exposureCompensation.step || 0.1 } : null,
    hires: !!cam.imageCapture,
  };
}

function requestMotionPermission() {
  S.motionAsked = true;
  try {
    if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') DeviceMotionEvent.requestPermission().catch(() => {});
  } catch (e) {}
}
addEventListener('devicemotion', (e) => {
  const r = e.rotationRate;
  if (!r || r.alpha == null) return;
  S.hasMotion = true;
  S.gyro = S.gyro * 0.8 + Math.hypot(r.alpha || 0, r.beta || 0, r.gamma || 0) * 0.2;
});

if (navigator.getBattery) {
  navigator.getBattery().then((b) => {
    const u = () => { S.phoneBatt = Math.round(b.level * 100); renderHw(); updateBatt(); };
    u(); b.addEventListener('levelchange', u);
  }).catch(() => {});
}

async function checkHardware() {
  requestMotionPermission();
  if (!Camera.supported()) {
    S.hw = { state: 'blocked', info: null, err: window.isSecureContext ? 'No camera API' : 'Needs HTTPS' };
    renderHw(); toast(window.isSecureContext ? 'This browser has no camera API.' : 'The camera needs HTTPS (GitHub Pages is fine).');
    return false;
  }
  S.hw = { ...S.hw, state: 'busy' }; renderHw();
  try {
    await cam.open(S.camId);
  } catch (e) {
    const [short, long] = camErr(e);
    S.hw = { state: 'blocked', info: null, err: short }; renderHw(); toast(long);
    return false;
  }
  const info = describeCam();
  if (S.screen !== 'capture') cam.close();
  S.cams = await Camera.list();
  S.hw = { state: info.torch ? 'ok' : 'limited', info, err: '' };
  renderHw(); syncSettingsUI();
  return true;
}

async function testLight() {
  const opened = !cam.active;
  if (opened) { try { await cam.open(S.camId); } catch (e) { toast(camErr(e)[1]); return; } }
  if (!(await cam.setTorch(true))) toast('This browser can’t control the flashlight');
  await wait(900);
  await cam.setTorch(false);
  if (opened) cam.close();
}

/* ------------------------------------------------------------------ home */
const pidEl = $('#pid'), pnameEl = $('#pname');
pidEl.value = S.pid; pnameEl.value = S.pname;
pidEl.addEventListener('input', () => { S.pid = pidEl.value.trim(); savePatient(); });
pnameEl.addEventListener('input', () => { S.pname = pnameEl.value.trim(); savePatient(); });
const setEyeSeg = bindSeg('#eyeSeg', (v) => { S.eye = v; savePatient(); });
const setPupilSeg = bindSeg('#pupilSeg', (v) => { S.pupil = v; savePatient(); });
setEyeSeg(S.eye); setPupilSeg(S.pupil);

function renderHw() {
  const h = S.hw, i = h.info || {};
  const states = { idle: ['Not checked', ''], busy: ['Checking…', 'busy'], ok: ['Ready', 'ok'], limited: ['Ready · no flashlight', 'warn'], blocked: [h.err || 'Unavailable', 'bad'] };
  const [txt, cls] = states[h.state] || states.idle;
  const pill = $('#hwPill'); pill.className = 'pill dot ' + cls; pill.textContent = txt;
  const yn = (v) => (v == null ? ['—', ''] : v ? ['Yes', 'yes'] : ['No', 'no']);
  const rows = [
    ['Camera', [i.label || '—', '']], ['Resolution', [i.res || '—', '']],
    ['Flashlight', yn(h.info ? i.torch : null)], ['Focus', [i.focus || '—', '']], ['Zoom', [i.zoom || '—', '']],
    ['Motion', S.hasMotion ? ['Gyro', 'yes'] : [S.motionAsked ? 'None' : '—', S.motionAsked ? 'no' : '']],
    ['Battery', [S.phoneBatt == null ? '—' : S.phoneBatt + '%', '']],
  ];
  const dl = $('#hwSpecs'); dl.innerHTML = '';
  for (const [k, [v, c]] of rows) {
    const dt = document.createElement('dt'), dd = document.createElement('dd');
    dt.textContent = k; dd.textContent = v; if (c) dd.className = c; dl.append(dt, dd);
  }
  $('#btnTestLight').disabled = !i.torch;
  $('#btnCheck').textContent = h.state === 'ok' || h.state === 'limited' ? 'Re-check' : 'Check camera';
  $('#btnCheck').disabled = h.state === 'busy';
  renderStartHint();
}

function renderSimDevice() {
  const pill = $('#devPill'), on = S.connected;
  pill.className = 'pill dot' + (on ? ' ok' : ''); pill.textContent = on ? 'Connected' : 'Disconnected';
  $('#devArt').classList.toggle('on', on);
  $('#spModel').textContent = on ? 'FV-20D (sim)' : '—';
  $('#spOptics').textContent = on ? '20 D · 45° field' : '—';
  $('#spLight').textContent = on ? 'IR 850 nm / 5600 K' : '—';
  $('#spBatt').textContent = on ? S.batt + '%' : '—';
  $('#btnConnect').textContent = on ? 'Disconnect' : 'Connect';
  $('#btnConnect').classList.toggle('primary', !on);
  $('#btnConnect').disabled = false;
  $('#btnTestFlash').disabled = !on;
  renderStartHint();
}

function renderStartHint() {
  const start = $('#btnStart'), hint = $('#startHint');
  if (isSim()) {
    start.disabled = !S.connected;
    hint.textContent = S.connected ? 'Simulation · no hardware is used' : 'Connect the simulated module to begin';
    return;
  }
  start.disabled = S.hw.state === 'busy';
  hint.textContent = {
    idle: 'Camera permission will be requested',
    busy: 'Checking camera…',
    ok: 'Clip the lens onto the camera and face the patient',
    limited: 'Flashlight not controllable here, so use external light',
    blocked: 'Camera unavailable: ' + S.hw.err,
  }[S.hw.state];
}

$('#btnCheck').addEventListener('click', checkHardware);
$('#btnTestLight').addEventListener('click', testLight);
$('#btnConnect').addEventListener('click', async () => {
  const btn = $('#btnConnect'), pill = $('#devPill');
  if (S.connected) { S.connected = false; renderSimDevice(); toast('Simulated module disconnected'); return; }
  btn.disabled = true;
  pill.className = 'pill dot busy'; pill.textContent = 'Scanning…';
  await wait(1000);
  pill.textContent = 'Pairing…';
  await wait(800);
  S.connected = true; S.batt = 78 + Math.floor(Math.random() * 18);
  renderSimDevice(); haptic(20);
});
$('#btnTestFlash').addEventListener('click', () => { fireScreenFlash(); if (S.sound) shutterSound(); });
$('#btnStart').addEventListener('click', async () => {
  if (!S.pid) { S.pid = 'PT-' + String(Math.floor(1000 + Math.random() * 9000)); pidEl.value = S.pid; savePatient(); }
  if (!isSim() && S.hw.state !== 'ok' && S.hw.state !== 'limited' && !(await checkHardware())) return;
  go('capture');
});
$('#homeGallery').addEventListener('click', () => go('review'));
$('#openReview').addEventListener('click', () => go('review'));
$('#homeSettings').addEventListener('click', openSheet);

function renderHome() {
  const od = S.captures.filter((s) => s.eye === 'OD').length, os = S.captures.length - od;
  const qs = S.captures.map((s) => s.q).filter((q) => q != null);
  $('#stOD').textContent = od; $('#stOS').textContent = os;
  $('#stQ').textContent = qs.length ? Math.round(qs.reduce((a, b) => a + b, 0) / qs.length) : '—';
  const rec = $('#recent'); rec.innerHTML = '';
  S.captures.slice(0, 4).forEach((s) => {
    const im = new Image(); im.src = s.url; im.alt = s.eye;
    im.addEventListener('click', () => { go('review'); openViewer(s.id); });
    rec.appendChild(im);
  });
  if (S.captures.length > 4) { const m = document.createElement('div'); m.className = 'more'; m.textContent = '+' + (S.captures.length - 4); rec.appendChild(m); }
  if (!S.captures.length) rec.innerHTML = '<small style="color:var(--muted)">No images captured yet.</small>';
  updateBadge();
}
function updateBadge() { const b = $('#galBadge'); b.hidden = !S.captures.length; b.textContent = S.captures.length; }

let deferredPrompt = null;
addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault(); deferredPrompt = e;
  $('#installCard').hidden = false; $('#installBtn').hidden = false;
});
$('#installBtn').addEventListener('click', async () => {
  if (!deferredPrompt) return;
  deferredPrompt.prompt(); await deferredPrompt.userChoice.catch(() => {});
  deferredPrompt = null; $('#installCard').hidden = true;
});
if (/iphone|ipad|ipod/i.test(navigator.userAgent) && !(matchMedia('(display-mode: standalone)').matches || navigator.standalone)) {
  $('#installCard').hidden = false;
  $('#installText').textContent = 'For full-screen capture, tap Share → Add to Home Screen.';
}

/* ------------------------------------------------------------------ capture screen */
const vp = $('#viewport'), cv = $('#view'), ctx = cv.getContext('2d'), ov = $('#ov'), og = ov.getContext('2d');
const statusEl = $('#status'), shutter = $('#shutter'), shutProg = $('#shutProg');
const SHUT_C = 2 * Math.PI * 37;
let raf = 0, last = 0, lastAn = 0, lastFilter = '', lastStatus = '', wakeLock = null, camStarting = false;

function enterCapture() {
  S.readyAt = 0; S.armed = true; S.af = null;
  hidePost(); updateCapHeader(); syncCaptureChips(); setThumb();
  layout();
  if (isSim()) { cam.close(); vp.classList.remove('cam'); vpMsg(null); sim.reset(S); configureControls(); }
  else startCamera();
  if (!raf) { last = performance.now(); raf = requestAnimationFrame(loop); }
  try { navigator.wakeLock && navigator.wakeLock.request('screen').then((l) => (wakeLock = l)).catch(() => {}); } catch (e) {}
}
function leaveCapture() {
  cancelAnimationFrame(raf); raf = 0;
  S.afBusy = false;
  cam.close(); vp.classList.remove('cam');
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
}
function rearm() {
  S.readyAt = 0; S.armed = true;
  if (isSim()) sim.reset(S, S.assist ? 4.5 : S.approach);
}

async function startCamera() {
  if (camStarting) return;
  camStarting = true;
  vpMsg('Starting camera…');
  try {
    await cam.open(S.camId);
  } catch (e) {
    camStarting = false;
    S.camError = camErr(e)[1];
    vpMsg(S.camError + ' Tap to retry.');
    return;
  }
  camStarting = false;
  if (S.screen !== 'capture' || isSim()) { cam.close(); return; }
  S.camError = null; vpMsg(null); vp.classList.add('cam');
  resetAnalysis(); resetMetrics();
  if (cam.hasZoom) { S.zoom = clamp(S.zoom, cam.caps.zoom.min, cam.caps.zoom.max); await cam.setZoom(S.zoom); }
  else S.zoom = clamp(S.zoom, 1, 4);
  if (cam.hasExposure && S.exposure) await cam.setExposure(S.exposure);
  await applyLight();
  const info = describeCam();
  S.hw = { state: info.torch ? 'ok' : 'limited', info, err: '' };
  if (!S.cams.length) S.cams = await Camera.list();
  configureControls(); updateVideoTransform(); syncCaptureChips(); syncSettingsUI();
  if (!cam.hasTorch && S.light !== 'off') toast('This browser can’t control the flashlight. Use external light.', 3500);
}
async function applyLight() { if (cam.active) await cam.setTorch(S.light === 'torch'); }
function vpMsg(t) { const m = $('#vpMsg'); m.hidden = !t; m.textContent = t || ''; }
function updateVideoTransform() {
  video.style.transform = `${S.flip ? 'rotate(180deg) ' : ''}scale(${dz()})`;
  ov.hidden = isSim() || !S.overlay;
  updateTags();
}

function layout() {
  const st = $('.stage');
  if (!st.clientHeight) return;
  const s = Math.floor(clamp(Math.min(st.clientWidth - 64, st.clientHeight - 96), 160, 560));
  document.documentElement.style.setProperty('--vp', s + 'px');
  const px = Math.round(s * Math.min(devicePixelRatio || 1, 2));
  if (cv.width !== px) cv.width = cv.height = px;
}
addEventListener('resize', () => { if (S.screen === 'capture') layout(); });

document.addEventListener('visibilitychange', () => {
  if (S.screen !== 'capture' || isSim()) return;
  if (document.hidden) { S.afBusy = false; cam.close(); vp.classList.remove('cam'); }
  else if (!cam.active) startCamera();
});

function updateCapHeader() {
  $('#eyeChip').textContent = S.eye;
  $('#capPid').textContent = (S.pid || '—') + (S.pname ? ' · ' + S.pname : '');
  $('#capMeta').textContent = isSim()
    ? `${PUPIL_LABEL[S.pupil]} · Fixation ${FIX_LABEL[S.fixation]}`
    : `${PUPIL_LABEL[S.pupil]} · Light ${LIGHT_LABEL[S.light].toLowerCase()}`;
  $('#pNext').textContent = 'Capture ' + otherEye(S.eye);
  updateBatt();
}
function updateBatt() {
  $('#capBatt').textContent = isSim() ? (S.connected ? S.batt + '%' : '—') : S.phoneBatt == null ? '' : S.phoneBatt + '%';
}
function updateTags() {
  if (isSim()) {
    $('#tagTop').textContent = S.mode === 'IR' ? 'SIM · IR 850 nm' : 'SIM · WHITE 5600 K';
    $('#tagBot').textContent = '45° FOV';
  } else {
    $('#tagTop').textContent = cam.active ? `${cam.width}×${cam.height}` : '';
    $('#tagBot').textContent = `${S.zoom.toFixed(1)}×${cam.hasZoom ? '' : ' DIGITAL'}${S.flip ? ' · INV' : ''}`;
  }
}
function syncCaptureChips() {
  const mc = $('#modeChip');
  mc.textContent = S.mode === 'IR' ? 'IR' : 'WHITE';
  mc.classList.toggle('ir', S.mode === 'IR'); mc.classList.toggle('on', S.mode !== 'IR');
  const lc = $('#lightChip'), noTorch = cam.active && !cam.hasTorch;
  $('span', lc).textContent = noTorch ? 'No flashlight' : S.light === 'torch' ? 'Torch' : S.light === 'capture' ? 'On capture' : 'Light off';
  lc.classList.toggle('amber', !noTorch && S.light === 'torch');
  lc.classList.toggle('on', !noTorch && S.light === 'capture');
  lc.style.opacity = noTorch ? 0.5 : '';
  $('#tAuto').classList.toggle('on', S.auto);
  $('#tAssist').classList.toggle('on', S.assist);
  $('#tFlip').classList.toggle('on', S.flip);
  $('#tBurst').classList.toggle('on', S.burst);
  $('#tFix').textContent = 'Fixation · ' + FIX_LABEL[S.fixation];
  $('#tFlash').textContent = 'Flash ' + S.flash + '%';
  $('#rGrid').style.display = S.grid ? '' : 'none';
  const real = !isSim();
  [['l1', 'X', 'FILL'], ['l2', 'Y', 'GLARE'], ['l3', 'WD', 'FOCUS'], ['l4', 'ΔF', 'STEADY']].forEach(([id, a, b]) => { $('#' + id).textContent = real ? b : a; });
  $('#zTop').textContent = real ? 'FILL' : 'FAR';
  $('#zBot').textContent = real ? '' : 'NEAR';
  const zone = $('#zZone');
  zone.style.top = real ? '0%' : '43.75%';
  zone.style.height = real ? '66.7%' : '12.5%';
  $('#zcol').classList.toggle('drag', !real);
  updateTags(); updateCapHeader();
}

function configureControls() {
  const f = $('#focus'), fo = $('#focusOut');
  if (isSim()) {
    f.min = -15; f.max = 15; f.step = 0.25; f.disabled = false; f.value = S.diopter; fo.textContent = fmtD(S.diopter);
    return;
  }
  if (cam.hasManualFocus) {
    const r = cam.caps.focusDistance, v = cam.settings.focusDistance != null ? cam.settings.focusDistance : (r.min + r.max) / 2;
    f.min = r.min; f.max = r.max; f.step = r.step || (r.max - r.min) / 100; f.disabled = false; f.value = v; fo.textContent = fmtFocus(v);
  } else {
    f.disabled = true; fo.textContent = cam.focusModes.length ? 'Auto' : 'Fixed';
  }
  const z = $('#zoom');
  if (cam.hasZoom) { const r = cam.caps.zoom; z.min = r.min; z.max = r.max; z.step = r.step || 0.1; }
  else { z.min = 1; z.max = 4; z.step = 0.1; }
  z.value = S.zoom; $('#zoomOut').textContent = S.zoom.toFixed(1) + '×';
}

function setDiopter(v) { S.diopter = v; $('#focus').value = v; $('#focusOut').textContent = fmtD(v); }
function setThumb() { const s = S.captures[0]; $('#lastThumb').style.backgroundImage = s ? `url(${s.url})` : ''; }

const applyFocus = latest((v) => cam.setFocusDistance(v));
const applyZoom = latest((v) => cam.setZoom(v));

$('#capBack').addEventListener('click', back);
$('#eyeChip').addEventListener('click', () => {
  S.eye = otherEye(S.eye); savePatient(); setEyeSeg(S.eye); updateCapHeader(); rearm(); hidePost();
  toast(S.eye === 'OD' ? 'Right eye (OD)' : 'Left eye (OS)');
});
$('#modeChip').addEventListener('click', () => { S.mode = S.mode === 'IR' ? 'WHITE' : 'IR'; syncCaptureChips(); });
$('#lightChip').addEventListener('click', async () => {
  if (cam.active && !cam.hasTorch) { toast('This browser can’t control the flashlight'); return; }
  const order = ['torch', 'capture', 'off'];
  S.light = order[(order.indexOf(S.light) + 1) % order.length];
  saveSettings(); syncCaptureChips(); syncSettingsUI();
  await applyLight();
});
$('#focus').addEventListener('input', (e) => {
  const v = +e.target.value;
  if (isSim()) { S.af = null; $('#btnAF').classList.remove('on'); setDiopter(v); return; }
  $('#focusOut').textContent = fmtFocus(v); applyFocus(v);
});
$('#zoom').addEventListener('input', (e) => {
  S.zoom = +e.target.value; saveSettings();
  $('#zoomOut').textContent = S.zoom.toFixed(1) + '×';
  if (cam.hasZoom) applyZoom(S.zoom); else { updateVideoTransform(); resetAnalysis(); }
  updateTags();
});
$('#btnZoom1').addEventListener('click', () => {
  const z = $('#zoom'); z.value = z.min; z.dispatchEvent(new Event('input'));
});
$('#btnAF').addEventListener('click', () => (isSim() ? startSimAF() : realAF()));
$('#tAuto').addEventListener('click', () => { S.auto = !S.auto; saveSettings(); syncCaptureChips(); syncSettingsUI(); });
$('#tAssist').addEventListener('click', () => { S.assist = !S.assist; saveSettings(); syncCaptureChips(); syncSettingsUI(); });
$('#tFlip').addEventListener('click', () => { S.flip = !S.flip; saveSettings(); syncCaptureChips(); syncSettingsUI(); updateVideoTransform(); resetAnalysis(); });
$('#tBurst').addEventListener('click', () => { S.burst = !S.burst; saveSettings(); syncCaptureChips(); syncSettingsUI(); });
$('#tFix').addEventListener('click', () => {
  const order = ['central', 'macula', 'disc'];
  S.fixation = order[(order.indexOf(S.fixation) + 1) % order.length];
  saveSettings(); syncCaptureChips(); syncSettingsUI();
});
$('#tFlash').addEventListener('click', () => {
  const steps = [40, 55, 70, 85, 100], i = steps.findIndex((v) => v > S.flash);
  S.flash = i < 0 ? steps[0] : steps[i]; saveSettings(); syncCaptureChips(); syncSettingsUI();
});
$('#lastThumb').addEventListener('click', () => { if (S.captures.length) go('review'); });
$('#capSettings').addEventListener('click', openSheet);
shutter.addEventListener('click', () => capture('manual'));

/* pointer: sim = move the phone; real = tap to focus */
let drag = null, zdrag = false;
const vpSize = () => vp.clientWidth || 300;
vp.addEventListener('pointerdown', (e) => {
  vp.setPointerCapture(e.pointerId);
  drag = { x: e.clientX, y: e.clientY, ox: S.off.x, oy: S.off.y, moved: false };
});
vp.addEventListener('pointermove', (e) => {
  if (!drag) return;
  if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 8) drag.moved = true;
  if (isSim()) {
    const mmPx = vpSize() * 0.09;
    S.off.x = clamp(drag.ox + (e.clientX - drag.x) / mmPx, -4, 4);
    S.off.y = clamp(drag.oy + (e.clientY - drag.y) / mmPx, -4, 4);
  }
});
vp.addEventListener('pointerup', (e) => { if (drag && !drag.moved && !isSim()) tapFocus(e); drag = null; });
vp.addEventListener('pointercancel', () => { drag = null; });
vp.addEventListener('wheel', (e) => { if (!isSim()) return; e.preventDefault(); S.approach = clamp(S.approach + e.deltaY * 0.01, -4, 8); }, { passive: false });

const zcol = $('#zcol');
const zFromPointer = (e) => {
  const b = $('.zbar', zcol).getBoundingClientRect();
  S.approach = clamp((0.5 - (e.clientY - b.top) / b.height) * 8, -4, 4);
};
zcol.addEventListener('pointerdown', (e) => { if (!isSim()) return; zdrag = true; zcol.setPointerCapture(e.pointerId); zFromPointer(e); });
zcol.addEventListener('pointermove', (e) => { if (zdrag) zFromPointer(e); });
['pointerup', 'pointercancel'].forEach((ev) => zcol.addEventListener(ev, () => { zdrag = false; }));

function tapFocus(e) {
  if (S.camError && !cam.active) { startCamera(); return; }
  if (!cam.active) return;
  const r = vp.getBoundingClientRect();
  let px = (e.clientX - r.left) / r.width - 0.5, py = (e.clientY - r.top) / r.height - 0.5;
  const ring = $('#tapring');
  ring.style.left = (px + 0.5) * 100 + '%'; ring.style.top = (py + 0.5) * 100 + '%';
  ring.classList.remove('go'); void ring.offsetWidth; ring.classList.add('go');
  px /= dz(); py /= dz();
  if (S.flip) { px = -px; py = -py; }
  const m = Math.min(cam.width, cam.height);
  cam.autoFocus({ x: clamp(0.5 + (px * m) / cam.width, 0, 1), y: clamp(0.5 + (py * m) / cam.height, 0, 1) })
    .then((ok) => { if (!ok) toast('Tap-to-focus isn’t supported on this camera'); });
}

/* ------------------------------------------------------------------ live loop */
const M = {};
function resetMetrics() { Object.assign(M, { fill: 0, cx: 0, cy: 0, glare: 0, lum: 0, motion: 0, sharp: 0, peak: 0, valid: false }); }
resetMetrics();
function ingest(m) {
  for (const k of ['fill', 'cx', 'cy', 'glare', 'lum', 'motion', 'sharp']) M[k] = M.valid ? M[k] + (m[k] - M[k]) * 0.35 : m[k];
  M.valid = true;
  M.peak = Math.max(M.peak * 0.995, M.sharp);
}

const oimg = og.createImageData(MASK_SIZE, MASK_SIZE);
function drawOverlay() {
  const d = oimg.data;
  for (let j = 0; j < mask.length; j++) {
    const i = j * 4, v = mask[j];
    if (v === 1) { d[i] = 45; d[i + 1] = 212; d[i + 2] = 191; d[i + 3] = 255; }
    else if (v === 2) { d[i] = 255; d[i + 1] = 60; d[i + 2] = 200; d[i + 3] = 255; }
    else d[i + 3] = 0;
  }
  og.putImageData(oimg, 0, 0);
}

function loop(now) {
  raf = requestAnimationFrame(loop);
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  if (isSim()) {
    sim.step(S, dt, now / 1000, !!(drag && drag.moved), zdrag);
    stepSimAF(now);
    drawSim();
  } else if (cam.active && !S.afBusy && now - lastAn > 80) {
    lastAn = now;
    const m = analyze(video, dz(), S.flip);
    if (m) { ingest(m); if (S.overlay) drawOverlay(); }
  }
  updateHUD(now);
}

function drawSim() {
  sim.renderView(ctx, cv.width, { eye: S.eye, align: S.align, fix: S.fixation });
  const f = (S.mode === 'IR' ? 'grayscale(1) contrast(1.15) brightness(1.05) ' : '') + `blur(${sim.blurPx(S, vpSize()).toFixed(1)}px)`;
  if (f !== lastFilter) { cv.style.filter = f; lastFilter = f; }
}

const focusOK = () => M.peak > 3 && M.sharp >= 0.75 * M.peak;
const steady = () => M.motion < 0.04 && S.gyro < 25;

function realGuidance() {
  if (S.camError) return ['err', 'Camera unavailable', 'bad'];
  if (!cam.active || !M.valid) return ['wait', 'Starting camera…', 'info'];
  if (S.afBusy) return ['af', 'Focusing…', 'info'];
  if (M.fill < 0.04) {
    return ['none', S.light === 'torch' || !cam.hasTorch ? 'No red reflex — align lens with pupil' : 'No red reflex — try Torch light', 'warn'];
  }
  if (M.glare > 0.025) return ['glare', 'Glare — tilt slightly or pull back', 'bad'];
  const e = Math.hypot(M.cx, M.cy);
  if (e > 0.28) {
    const dir = Math.abs(M.cx) > Math.abs(M.cy) ? (M.cx > 0 ? '→' : '←') : (M.cy > 0 ? '↓' : '↑');
    return ['xy', 'Off-centre — follow the dot ' + dir, 'warn'];
  }
  if (M.fill < 0.3) return ['fill', 'Small view — adjust distance to fill', 'warn'];
  if (M.lum < 35) return ['dark', 'Too dark', 'warn'];
  if (M.lum > 228) return ['bright', 'Overexposed — lower exposure', 'warn'];
  if (!focusOK()) return ['focus', 'Adjust focus (tap AF)', 'warn'];
  if (!steady()) return ['move', 'Hold steady', 'warn'];
  return ['ready', 'Aligned — hold steady', 'ok'];
}

function setStatus(msg, cls) {
  const key = cls + msg;
  if (key === lastStatus) return;
  lastStatus = key; statusEl.className = 'status ' + cls; $('span', statusEl).textContent = msg;
}

function updateHUD(now) {
  const real = !isSim();
  let [key, msg, cls] = real ? realGuidance() : sim.guidance(S);
  const locked = now < S.lockUntil;
  if (S.busy) { msg = 'Capturing…'; cls = 'info'; }
  else if (locked) { msg = `Pupil recovery · ${Math.ceil((S.lockUntil - now) / 1000)} s`; cls = 'info'; }
  setStatus(msg, cls);

  const dot = $('#rDot'), zm = $('#zmark');
  if (real) {
    const seen = M.valid && M.fill >= 0.04, e = Math.hypot(M.cx, M.cy);
    dot.setAttribute('cx', (clamp(M.cx, -1, 1) * 88).toFixed(1));
    dot.setAttribute('cy', (clamp(M.cy, -1, 1) * 88).toFixed(1));
    dot.setAttribute('fill', !seen ? 'transparent' : e < 0.28 ? '#34d399' : '#fbbf24');
    zm.style.top = ((1 - clamp(M.fill / 0.9, 0, 1)) * 100).toFixed(1) + '%';
    zm.classList.toggle('ok', M.fill >= 0.3);
    $('#r1').textContent = M.valid ? pct(M.fill) : '—';
    $('#r2').textContent = M.valid ? (M.glare * 100).toFixed(1) + '%' : '—';
    $('#r3').textContent = M.valid && M.peak ? pct(M.sharp / M.peak) : '—';
    $('#r4').textContent = M.valid ? (steady() ? 'yes' : 'no') : '—';
  } else {
    const A = S.align, e = Math.hypot(A.x, A.y);
    dot.setAttribute('cx', clamp(A.x * 25, -88, 88).toFixed(1));
    dot.setAttribute('cy', clamp(A.y * 25, -88, 88).toFixed(1));
    dot.setAttribute('fill', e < 0.35 ? '#34d399' : '#fbbf24');
    zm.style.top = (clamp(0.5 - A.z / 8, 0.02, 0.98) * 100).toFixed(1) + '%';
    zm.classList.toggle('ok', Math.abs(A.z) < 0.5);
    $('#r1').textContent = fmtMM(A.x);
    $('#r2').textContent = fmtMM(A.y);
    $('#r3').textContent = (22 + A.z).toFixed(1) + 'mm';
    $('#r4').textContent = fmtD(S.diopter - S.refraction[S.eye]);
  }

  const ready = key === 'ready' && !locked && !S.busy;
  vp.classList.toggle('ready', ready);
  shutter.classList.toggle('ready', ready);
  shutter.classList.toggle('locked', locked || S.busy);

  let p = 0;
  if (ready && S.auto && S.armed) {
    if (!S.readyAt) S.readyAt = now;
    p = clamp((now - S.readyAt) / (real ? 700 : 900), 0, 1);
    if (p >= 1) capture('auto');
  } else S.readyAt = 0;
  shutProg.setAttribute('stroke-dashoffset', (SHUT_C * (1 - p)).toFixed(1));
}

/* ------------------------------------------------------------------ focus */
function startSimAF() {
  const tgt = S.refraction[S.eye], from = S.diopter, s = Math.sign(tgt - from) || 1;
  S.af = { t0: performance.now(), dur: 1100, pts: [from, tgt + 1.5 * s, tgt - 0.6 * s, tgt + 0.2 * s, tgt] };
  $('#btnAF').classList.add('on');
}
function stepSimAF(now) {
  if (!S.af) return;
  const { t0, dur, pts } = S.af, p = clamp((now - t0) / dur, 0, 1), n = pts.length - 1;
  const f = p * n, i = Math.min(n - 1, Math.floor(f)), u = f - i, e = u * u * (3 - 2 * u);
  setDiopter(lerp(pts[i], pts[i + 1], e));
  if (p >= 1) { S.af = null; setDiopter(pts[n]); $('#btnAF').classList.remove('on'); }
}

// Contrast-detection sweep over the lens focus range, then a fine pass around the best step.
async function realAF() {
  if (!cam.active || S.afBusy) return;
  if (!cam.hasManualFocus) {
    toast((await cam.autoFocus()) ? 'Refocusing…' : 'This camera doesn’t expose focus control');
    return;
  }
  S.afBusy = true;
  const btn = $('#btnAF'); btn.classList.add('on');
  const r = cam.caps.focusDistance, N = 14, span = r.max - r.min;
  let best = -1, bestD = r.min;
  const measure = async (d) => {
    await cam.setFocusDistance(d);
    await wait(170);
    let s = 0;
    for (let k = 0; k < 2; k++) { const m = analyze(video, dz(), S.flip); s += m ? m.sharp : 0; await wait(40); }
    return s / 2;
  };
  try {
    for (let i = 0; i <= N && S.afBusy; i++) {
      const d = r.min + (span * i) / N, s = await measure(d);
      if (s > best) { best = s; bestD = d; }
    }
    for (const k of [-2, -1, 1, 2]) {
      if (!S.afBusy) break;
      const d = clamp(bestD + (k * span) / N / 3, r.min, r.max), s = await measure(d);
      if (s > best) { best = s; bestD = d; }
    }
    if (S.afBusy) {
      await cam.setFocusDistance(bestD);
      $('#focus').value = bestD; $('#focusOut').textContent = fmtFocus(bestD);
      M.peak = best; M.sharp = best;
    }
  } finally {
    S.afBusy = false; btn.classList.remove('on'); resetAnalysis();
  }
}

/* ------------------------------------------------------------------ capture */
function fireScreenFlash() { const f = $('#flash'); f.classList.remove('go'); void f.offsetWidth; f.classList.add('go'); }
function fireVpFlash() { const f = $('#vpflash'); f.classList.remove('go'); void f.offsetWidth; f.classList.add('go'); }

async function capture(trigger) {
  if (S.busy || performance.now() < S.lockUntil) return;
  if (isSim()) return captureSim(trigger);
  if (!cam.active) { toast('Camera is not running'); return; }
  return captureReal(trigger);
}

// Round field mask plus burned-in labels, like a fundus camera export.
function finishFrame(c, eye, line) {
  const W = c.width, g = c.getContext('2d');
  g.globalCompositeOperation = 'destination-in';
  g.beginPath(); g.arc(W / 2, W / 2, W / 2 - W * 0.006, 0, Math.PI * 2); g.fill();
  g.globalCompositeOperation = 'destination-over'; g.fillStyle = '#000'; g.fillRect(0, 0, W, W);
  g.globalCompositeOperation = 'source-over';
  const fs = Math.round(W * 0.032);
  g.fillStyle = 'rgba(255,255,255,.88)'; g.textBaseline = 'alphabetic';
  g.font = `700 ${Math.round(fs * 1.6)}px system-ui,-apple-system,sans-serif`; g.textAlign = 'left';
  g.fillText(eye, fs, fs * 2.2);
  g.font = `500 ${fs}px ui-monospace,Menlo,Consolas,monospace`;
  g.fillText(stamp(Date.now()), fs, W - fs);
  g.textAlign = 'right';
  g.fillText(S.pid || '—', W - fs, fs * 1.9);
  g.fillText(line, W - fs, W - fs);
}

async function storeShot(c, info) {
  const rec = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    pid: S.pid || '—', name: S.pname, eye: info.eye, t: Date.now(), pupil: S.pupil,
    src: info.src, trigger: info.trigger, q: info.q, details: info.details,
    blob: await toBlob(c, 'image/jpeg', 0.92),
  };
  await saveShot(rec);
  S.lockUntil = performance.now() + (S.pupil === 'dil' ? 1500 : 5000);
  S.armed = false;
  setThumb(); updateBadge(); showPost(S.captures[0]);
}

async function captureSim(trigger) {
  if (trigger === 'manual' && S.align.z > 2.5) { toast('Eye not in view — move closer'); return; }
  S.busy = true; S.readyAt = 0;
  try {
    const snap = { align: { ...S.align }, D: S.diopter, eye: S.eye, fix: S.fixation, flash: S.flash };
    fireScreenFlash(); if (S.sound) shutterSound(); haptic(35);
    await wait(70);
    const c = sim.capture(S, snap);
    finishFrame(c, snap.eye, `45° · ${fmtD(snap.D)} · F${snap.flash}`);
    await storeShot(c, {
      eye: snap.eye, trigger, src: 'sim', q: sim.quality(S, snap),
      details: [['Focus', fmtD(snap.D)], ['Flash', snap.flash + '%'], ['Fixation', FIX_LABEL[snap.fix]]],
    });
  } finally { S.busy = false; }
}

// Estimated from the live metrics at the moment of capture; zero when no retina is in view.
function realQuality() {
  if (!M.valid) return null;
  const sr = M.peak ? M.sharp / M.peak : 0, e = Math.hypot(M.cx, M.cy);
  const base = 40 * clamp((sr - 0.5) / 0.5, 0, 1) + 30 * (1 - clamp(M.glare / 0.05, 0, 1)) + 30 * (1 - clamp(e / 0.5, 0, 1));
  return Math.round(clamp(base * Math.sqrt(clamp(M.fill / 0.5, 0, 1)), 0, 99));
}

async function captureReal(trigger) {
  S.busy = true; S.readyAt = 0;
  const eye = S.eye, q = realQuality(), zoom = dz();
  const pulse = S.light === 'capture' && cam.hasTorch;
  let frameKind = S.burst ? 'Best of 4' : 'Video frame';
  try {
    if (pulse) { await cam.setTorch(true); await wait(450); } // give auto-exposure time to settle
    fireVpFlash(); if (S.sound) shutterSound(); haptic(35);

    let out = null;
    if (S.hires && cam.imageCapture) {
      const bmp = await cam.photo();
      if (bmp) {
        out = squareCrop(bmp, bmp.width, bmp.height, Math.round(clamp(Math.min(bmp.width, bmp.height) / zoom, 720, 2048)), zoom, S.flip);
        frameKind = 'Full-res still';
        bmp.close && bmp.close();
      }
    }
    if (!out) {
      const vw = cam.width, vh = cam.height, size = Math.round(clamp(Math.min(vw, vh) / zoom, 720, 2048));
      let best = -1;
      for (let i = 0, n = S.burst ? 4 : 1; i < n; i++) {
        const c = squareCrop(video, vw, vh, size, zoom, S.flip), s = sharpnessOf(c);
        if (s > best) { best = s; out = c; }
        if (i < n - 1) await wait(80);
      }
    }
    if (pulse) await cam.setTorch(false);

    finishFrame(out, eye, `${zoom.toFixed(1)}× · ${out.width}px`);
    await storeShot(out, {
      eye, trigger, src: 'camera', q,
      details: [
        ['Camera', shortLabel(cam.label)], ['Frame', frameKind],
        ['Flashlight', LIGHT_LABEL[S.light] + (cam.hasTorch ? '' : ' (unsupported)')],
        ['Focus', cam.hasManualFocus ? fmtFocus(cam.settings.focusDistance) : cam.focusModes.length ? 'Auto' : 'Fixed'],
        ['Zoom', `${(cam.hasZoom ? S.zoom : zoom).toFixed(1)}×${cam.hasZoom ? '' : ' digital'}`],
        ['Resolution', `${out.width}×${out.height}`],
      ],
    });
  } catch (e) {
    toast('Capture failed: ' + (e && e.message ? e.message : e));
    if (pulse) cam.setTorch(false);
  } finally { S.busy = false; }
}

const qClass = (q) => (q == null ? 'na' : q >= 80 ? 'good' : q >= 55 ? 'fair' : 'poor');
const qLabel = (q) => (q == null ? 'Ungraded' : q >= 80 ? 'Good' : q >= 55 ? 'Fair' : 'Poor');

function showPost(s) {
  $('#postImg').src = s.url;
  $('#postTitle').textContent = `Captured · ${s.eye}`;
  $('#postMeta').textContent = s.q == null ? 'Ungraded' : `${s.src === 'camera' ? 'Est. quality' : 'Quality'} ${s.q} · ${qLabel(s.q)}${s.q < 55 ? ' — consider retaking' : ''}`;
  $('#post').classList.add('show');
}
function hidePost() { $('#post').classList.remove('show'); }
$('#pRetake').addEventListener('click', async () => {
  if (S.captures[0]) await deleteShot(S.captures[0].id);
  setThumb(); updateBadge(); hidePost(); rearm();
});
$('#pNext').addEventListener('click', () => {
  S.eye = otherEye(S.eye); savePatient(); setEyeSeg(S.eye); updateCapHeader(); hidePost(); rearm();
});
$('#pReview').addEventListener('click', () => { hidePost(); go('review'); });

/* ------------------------------------------------------------------ review */
let revFilter = 'all';
bindSeg('#revTabs', (v) => { revFilter = v; renderReview(); })(revFilter);
$('#revBack').addEventListener('click', back);

function renderReview() {
  const list = S.captures.filter((s) => revFilter === 'all' || s.eye === revFilter);
  $('#revSub').textContent = `${S.captures.length} image${S.captures.length === 1 ? '' : 's'}`;
  const grid = $('#grid'); grid.innerHTML = '';
  $('#empty').hidden = list.length > 0;
  for (const s of list) {
    const b = document.createElement('button'); b.className = 'shot';
    b.innerHTML = `<img alt=""><div class="meta"><span></span><span class="q ${qClass(s.q)}">${s.q == null ? '—' : 'Q' + s.q}</span></div><small></small>`;
    $('img', b).src = s.url;
    $('.meta span', b).textContent = `${s.eye} · ${fmtTime(s.t)}${s.src === 'sim' ? ' · sim' : ''}`;
    $('small', b).textContent = s.pid + (s.name ? ' · ' + s.name : '');
    b.addEventListener('click', () => openViewer(s.id));
    grid.appendChild(b);
  }
}

const viewer = $('#viewer'), vCanvas = $('#vCanvas'), vImg = new Image();
let vShot = null, vMode = 'color';
const setVF = bindSeg('#vFilter', (v) => { vMode = v; drawViewer(); });
vImg.onload = () => { const n = Math.min(2048, vImg.naturalWidth || 1024); vCanvas.width = vCanvas.height = n; drawViewer(); };
function openViewer(id) {
  vShot = S.captures.find((s) => s.id === id);
  if (!vShot) return;
  $('#vTitle').textContent = `${vShot.eye} · ${vShot.pid}`;
  $('#vSub').textContent = stamp(vShot.t);
  const rows = [
    [vShot.src === 'camera' ? 'Est. quality' : 'Quality', vShot.q == null ? 'Ungraded' : `${vShot.q} · ${qLabel(vShot.q)}`],
    ...(vShot.details || []),
    ['Pupil', PUPIL_LABEL[vShot.pupil] || '—'],
    ['Trigger', vShot.trigger === 'auto' ? 'Auto' : 'Manual'],
    ['Source', vShot.src === 'camera' ? 'Phone camera' : 'Simulation'],
  ];
  const dl = $('#vSpecs'); dl.innerHTML = '';
  for (const [k, v] of rows) { const dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = k; dd.textContent = v; dl.append(dt, dd); }
  vMode = 'color'; setVF('color'); vCanvas.classList.remove('zoom');
  vImg.src = vShot.url;
  viewer.classList.add('show');
}
function closeViewer() { viewer.classList.remove('show'); vShot = null; }
function drawViewer() {
  if (!vShot || !vImg.complete) return;
  const g = vCanvas.getContext('2d'), W = vCanvas.width;
  g.drawImage(vImg, 0, 0, W, W);
  if (vMode === 'color') return;
  const d = g.getImageData(0, 0, W, W), p = d.data;
  for (let i = 0; i < p.length; i += 4) {
    if (vMode === 'redfree') { const v = clamp((p[i + 1] - 25) * 1.9, 0, 255); p[i] = v * 0.92; p[i + 1] = v; p[i + 2] = v * 0.92; }
    else for (let k = 0; k < 3; k++) p[i + k] = clamp((p[i + k] - 95) * 1.45 + 110, 0, 255);
  }
  g.putImageData(d, 0, 0);
}
vCanvas.addEventListener('dblclick', (e) => {
  const r = vCanvas.getBoundingClientRect();
  vCanvas.style.transformOrigin = `${((e.clientX - r.left) / r.width) * 100}% ${((e.clientY - r.top) / r.height) * 100}%`;
  vCanvas.classList.toggle('zoom');
});
$('#vClose').addEventListener('click', closeViewer);
$('#vDel').addEventListener('click', async () => {
  if (!vShot || !confirm('Delete this image?')) return;
  await deleteShot(vShot.id);
  closeViewer(); renderReview(); updateBadge(); setThumb();
});
$('#vShare').addEventListener('click', async () => {
  if (!vShot) return;
  const name = `${vShot.eye}_${String(vShot.pid).replace(/\W+/g, '-')}_${stamp(vShot.t).replace(/\D/g, '')}.jpg`;
  const file = new File([vShot.blob], name, { type: 'image/jpeg' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); } catch (e) {}
    return;
  }
  const a = document.createElement('a'); a.href = vShot.url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
});

/* ------------------------------------------------------------------ settings sheet */
const sheet = $('#sheet'), scrim = $('#scrim');
function openSheet() { syncSettingsUI(); sheet.classList.add('show'); scrim.classList.add('show'); }
function closeSheet() { sheet.classList.remove('show'); scrim.classList.remove('show'); }
scrim.addEventListener('click', closeSheet);
$('#sheetDone').addEventListener('click', closeSheet);

const setLightSeg = bindSeg('#setLight', async (v) => { S.light = v; saveSettings(); syncCaptureChips(); await applyLight(); });
const setFixSeg = bindSeg('#setFix', (v) => { S.fixation = v; saveSettings(); syncCaptureChips(); });
const switches = { setFlip: 'flip', setBurst: 'burst', setHires: 'hires', setOverlay: 'overlay', setAuto: 'auto', setGrid: 'grid', setSound: 'sound', setAssist: 'assist' };
for (const [id, key] of Object.entries(switches)) {
  $('#' + id).addEventListener('click', () => {
    S[key] = !S[key]; saveSettings(); syncSettingsUI(); syncCaptureChips();
    if (key === 'flip' || key === 'overlay') { updateVideoTransform(); resetAnalysis(); }
  });
}
$('#setSim').addEventListener('click', () => {
  S.source = isSim() ? 'camera' : 'sim';
  saveSettings(); applyMode(); syncSettingsUI();
  if (S.screen === 'capture') {
    if (isSim() && !S.connected) { S.connected = true; S.batt = 86; renderSimDevice(); }
    leaveCapture(); enterCapture();
  }
});
$('#setCam').addEventListener('change', (e) => {
  S.camId = e.target.value; saveSettings();
  S.hw = { state: 'idle', info: null, err: '' }; renderHw();
  if (S.screen === 'capture' && !isSim()) startCamera();
});
$('#setExp').addEventListener('input', (e) => {
  S.exposure = +e.target.value; saveSettings();
  $('#setExpOut').textContent = (S.exposure > 0 ? '+' : '') + S.exposure.toFixed(1);
  if (cam.active) cam.setExposure(S.exposure);
});
$('#setFlash').addEventListener('input', (e) => { S.flash = +e.target.value; saveSettings(); syncSettingsUI(); syncCaptureChips(); });
$('#setClear').addEventListener('click', async () => {
  if (!S.captures.length || !confirm(`Delete all ${S.captures.length} captured images?`)) return;
  S.captures.forEach((s) => URL.revokeObjectURL(s.url));
  S.captures = [];
  try { await db.clear(); } catch (e) {}
  syncSettingsUI(); setThumb(); updateBadge();
  if (S.screen === 'review') renderReview(); if (S.screen === 'home') renderHome();
});

function syncSettingsUI() {
  setLightSeg(S.light); setFixSeg(S.fixation);
  for (const [id, key] of Object.entries(switches)) $('#' + id).setAttribute('aria-pressed', String(!!S[key]));
  $('#setSim').setAttribute('aria-pressed', String(isSim()));
  $('#setFlash').value = S.flash; $('#setFlashOut').textContent = S.flash + '%';

  const info = S.hw.info;
  const noTorch = info && !info.torch;
  $('#lightNote').textContent = noTorch
    ? 'This browser can’t control the flashlight (e.g. iOS Safari). Use external light.'
    : 'Torch: on continuously · On capture: pulses only when taking the photo';
  $('#rowHires').hidden = !(info && info.hires);
  const ex = info && info.exposure;
  $('#rowExp').hidden = !ex;
  if (ex) {
    const r = $('#setExp'); r.min = ex.min; r.max = ex.max; r.step = ex.step; r.value = S.exposure;
    $('#setExpOut').textContent = (S.exposure > 0 ? '+' : '') + S.exposure.toFixed(1);
  }

  const sel = $('#setCam');
  sel.innerHTML = '<option value="">Default rear camera</option>';
  S.cams.forEach((c, i) => { const o = document.createElement('option'); o.value = c.deviceId; o.textContent = shortLabel(c.label) || `Camera ${i + 1}`; sel.appendChild(o); });
  sel.value = S.cams.some((c) => c.deviceId === S.camId) ? S.camId : '';

  const bytes = S.captures.reduce((a, s) => a + (s.blob ? s.blob.size : 0), 0), kb = Math.round(bytes / 1024);
  $('#storeInfo').textContent = `${S.captures.length} image${S.captures.length === 1 ? '' : 's'} · ${kb > 1024 ? (kb / 1024).toFixed(1) + ' MB' : kb + ' KB'}${S.dbOK === false ? ' · session only' : ''}`;
}

/* ------------------------------------------------------------------ boot */
applyMode(); renderHome(); syncSettingsUI(); syncCaptureChips();
history.replaceState({ id: 'home', d: 0 }, '', '#home');
loadCaptures();
(window.requestIdleCallback || ((f) => setTimeout(f, 300)))(() => { if (isSim()) sim.prewarm(); });
// Camera labels are only readable once permission was granted; fill the picker if so (without opening the camera).
Camera.list().then((c) => { if (c.some((d) => d.label)) { S.cams = c; syncSettingsUI(); } });

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
