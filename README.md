# FundusView: smartphone fundus imaging

A mobile PWA for capturing retinal (fundus) images through a **passive clip-on condensing lens**.
The clip-on is a 3D-printed mount that holds the lens in front of the rear camera and has no electronics.
All imaging, light, focus and processing happen on the phone.

Research prototype. Not a medical device.

## How it uses the phone

| Hardware | Used for | Support |
| --- | --- | --- |
| Rear camera (`getUserMedia`) | Live view and captures; camera picker in Settings | All modern browsers (HTTPS) |
| Flashlight (`torch` constraint) | **Torch** (on continuously), **On capture** (pulsed only for the shot) or **Off** | Chrome on Android. Not available in iOS Safari, so use external light there. |
| Focus (`focusMode` / `focusDistance`) | Manual focus slider, contrast-detection AF sweep, tap-to-focus | Chrome on Android (most devices) |
| Zoom (`zoom` constraint) | Fill the field with the aerial image; falls back to digital zoom | Chrome on Android |
| Exposure compensation | Tame blow-out from the flashlight | Chrome on Android |
| `ImageCapture.takePhoto` | Optional full-resolution still | Chrome on Android |
| Gyroscope (`devicemotion`) | "Hold steady" gating | Android; iOS asks for permission |
| Battery API | Phone battery in the header | Chrome on Android |
| Wake Lock | Keep the screen on while capturing | Most modern browsers |

Every capability is detected at runtime. Anything the browser doesn't expose is shown as unavailable, never faked.

## Live guidance (real camera)

Each preview frame is analysed on-device (`js/analysis.js`):

- **Fill:** fraction of the round field covered by fundus-coloured (red/orange) pixels, i.e. the red reflex / aerial image.
- **Centre:** centroid of those pixels, which drives the reticle dot and the "follow the dot" hint.
- **Glare:** blown-out white pixels from corneal or lens reflections.
- **Focus:** Laplacian variance of the central crop, relative to the recent peak.
- **Steady:** frame-to-frame change plus the gyroscope.

When everything passes, **auto capture** fires after about 0.7 s. **Best of 4** keeps the sharpest frame of a short burst.
The image is rotated 180° by default ("Correct lens inversion") because a condensing lens inverts the retina.
Turn on **Detection overlay** in Settings to see which pixels are classed as retina or glare while tuning thresholds.

## Simulation mode

Settings → Demo → **Simulation mode** swaps in a fully fake setup: a procedurally drawn retina, a pretend "smart" lens module with pairing and IR/white LEDs, and a simulated hand-held approach. No camera or flashlight is touched. It's meant for demos without an eye or lens.

## Run locally

```bash
python -m http.server 8765
```

Open http://localhost:8765 (localhost counts as secure for the camera).
To test on a phone, deploy to GitHub Pages; the camera needs HTTPS.

## Deploy to GitHub Pages

1. Push this repo to GitHub.
2. Go to **Settings → Pages**, choose *Deploy from a branch*, and select `main` / `/ (root)`.
3. Open `https://<user>.github.io/<repo>/` on the phone:
   - Android (Chrome): use *Install app*.
   - iPhone (Safari): use Share → *Add to Home Screen*.

The service worker is network-first, so new deploys show up on the next load. It falls back to the cache offline.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Markup |
| `css/app.css` | Styles |
| `js/app.js` | UI, navigation, capture flow |
| `js/camera.js` | Camera, torch, focus and zoom wrapper |
| `js/analysis.js` | Live frame analysis for guidance |
| `js/sim.js` | Simulation mode (fake retina and module) |
| `js/db.js` | IndexedDB storage for captured JPEGs |
| `js/util.js` | Helpers |
| `sw.js`, `manifest.webmanifest`, `icons/` | PWA |
