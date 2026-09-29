// Thin wrapper over getUserMedia / MediaStreamTrack constraints: torch, zoom, focus, exposure.
// Support varies a lot: Chrome on Android exposes most of these, iOS Safari exposes little
// (no torch). Every setter reports whether the device accepted it.

export class Camera {
  constructor(video) {
    this.video = video;
    this.stream = null;
    this.track = null;
    this.caps = {};
    this.settings = {};
    this.torchOn = false;
    this.imageCapture = null;
  }

  get active() { return !!this.stream; }
  get label() { return (this.track && this.track.label) || 'Camera'; }
  get width() { return this.video.videoWidth || this.settings.width || 0; }
  get height() { return this.video.videoHeight || this.settings.height || 0; }
  get hasTorch() { return !!this.caps.torch; }
  get focusModes() { return Array.isArray(this.caps.focusMode) ? this.caps.focusMode : []; }
  get hasManualFocus() { return this.focusModes.includes('manual') && !!this.caps.focusDistance && this.caps.focusDistance.max > this.caps.focusDistance.min; }
  get hasZoom() { return !!this.caps.zoom && this.caps.zoom.max > this.caps.zoom.min; }
  get hasExposure() { return !!this.caps.exposureCompensation && this.caps.exposureCompensation.max > this.caps.exposureCompensation.min; }
  get hasPointsOfInterest() {
    try { return !!navigator.mediaDevices.getSupportedConstraints().pointsOfInterest; } catch (e) { return false; }
  }

  static supported() { return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia); }

  static async list() {
    try { return (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput'); } catch (e) { return []; }
  }

  async open(deviceId) {
    this.close();
    const video = deviceId ? { deviceId: { exact: deviceId } } : { facingMode: { ideal: 'environment' } };
    Object.assign(video, { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } });
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
    } catch (e) {
      // A remembered camera may have disappeared; fall back to any rear camera.
      if (deviceId && (e.name === 'OverconstrainedError' || e.name === 'NotFoundError')) return this.open('');
      throw e;
    }
    this.stream = stream;
    this.track = stream.getVideoTracks()[0];
    this.video.muted = true;
    this.video.playsInline = true;
    this.video.srcObject = stream;
    await this.video.play().catch(() => {});
    await this.firstFrame();
    this.refresh();
    try { this.imageCapture = 'ImageCapture' in window ? new ImageCapture(this.track) : null; } catch (e) { this.imageCapture = null; }
    return this;
  }

  firstFrame() {
    return new Promise((res) => {
      if (this.video.videoWidth) return res();
      const done = () => { this.video.removeEventListener('loadedmetadata', done); res(); };
      this.video.addEventListener('loadedmetadata', done);
      setTimeout(done, 3000);
    });
  }

  refresh() {
    if (!this.track) return;
    try { this.caps = this.track.getCapabilities ? this.track.getCapabilities() : {}; } catch (e) { this.caps = {}; }
    try { this.settings = this.track.getSettings ? this.track.getSettings() : {}; } catch (e) { this.settings = {}; }
  }

  close() {
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    this.stream = null; this.track = null; this.imageCapture = null; this.torchOn = false;
    this.video.srcObject = null;
  }

  async apply(c) {
    if (!this.track) return false;
    try {
      await this.track.applyConstraints({ advanced: [c] });
      this.settings = this.track.getSettings ? this.track.getSettings() : this.settings;
      return true;
    } catch (e) { return false; }
  }

  async setTorch(on) {
    if (!this.hasTorch) return false;
    const ok = await this.apply({ torch: !!on });
    if (ok) this.torchOn = !!on;
    return ok;
  }
  setZoom(z) { return this.apply({ zoom: z }); }
  setExposure(v) { return this.apply({ exposureMode: 'continuous', exposureCompensation: v }); }
  setFocusDistance(d) { return this.apply({ focusMode: 'manual', focusDistance: d }); }

  // Let the device autofocus, optionally at a point (normalised 0..1 video coordinates).
  async autoFocus(point) {
    const c = {};
    if (point && this.hasPointsOfInterest) c.pointsOfInterest = [point];
    if (this.focusModes.includes('single-shot')) c.focusMode = 'single-shot';
    else if (this.focusModes.includes('continuous')) c.focusMode = 'continuous';
    if (!Object.keys(c).length) return false;
    return this.apply(c);
  }

  // Full-resolution still via ImageCapture (Chrome/Android). Returns an ImageBitmap or null.
  async photo() {
    if (!this.imageCapture) return null;
    try {
      const blob = await this.imageCapture.takePhoto();
      return await createImageBitmap(blob);
    } catch (e) { return null; }
  }
}

// Square centre crop of any image source, with digital zoom and optional 180° rotation
// (a condensing lens forms an inverted aerial image of the retina).
export function squareCrop(src, sw, sh, size, zoom = 1, flip = false, canvas) {
  const c = canvas || document.createElement('canvas');
  if (c.width !== size) c.width = c.height = size;
  const g = c.getContext('2d');
  const m = Math.min(sw, sh) / zoom;
  g.save();
  g.fillStyle = '#000'; g.fillRect(0, 0, size, size);
  if (flip) { g.translate(size, size); g.rotate(Math.PI); }
  try { g.drawImage(src, (sw - m) / 2, (sh - m) / 2, m, m, 0, 0, size, size); } catch (e) {}
  g.restore();
  return c;
}
