# Kusurino Debug Scanner

This repository contains a plain JavaScript browser app built from the Kusurino barcode scanner TSX flow.

It uses the local Cortex Decoder SDK package in this folder:

- `codecorp-web_sdk-3.0.0.tgz`

The app keeps the core scanner behavior and adds a small debug UI for:

- license entry
- scan mode selection
- camera resolution switching
- live performance diagnostics
- Android device testing

## Requirements

- Node.js and npm
- Google Chrome or another Chromium-based browser
- For Android USB testing: Android platform-tools with `adb`

## Project Files

- `src/main.js`: scanner logic and diagnostics UI behavior
- `src/styles.css`: UI styling
- `index.html`: app shell
- `scripts/copy-sdk-assets.mjs`: copies SDK WASM assets into `public/wasm`
- `vite.config.js`: Vite server config, fixed to port `5173`

## Install

From the repo root, run:

```powershell
npm install
```

This installs the local SDK tarball and the app dependencies.

## Run Locally

Start the development server:

```powershell
npm run dev
```

Then open:

```text
http://localhost:5173
```

Notes:

- The `predev` script automatically copies the Cortex Decoder WASM file into `public/wasm`.
- The Vite dev server is configured to use port `5173` and bind to `0.0.0.0`.
- Camera access requires a secure context. `localhost` is treated as secure by the browser.

## Build

Create a production build:

```powershell
npm run build
```

Preview the production build locally:

```powershell
npm run preview
```

## How To Use The App

1. Start the app with `npm run dev`.
2. Open `http://localhost:5173`.
3. Paste a valid license key into the UI.
4. Choose scan mode and camera resolution.
5. Tap `Initialize and start`.
6. Allow camera access when the browser prompts.

## Android USB Testing With `adb reverse`

This is the recommended way to test on an Android phone.

### 1. Enable USB Debugging On The Phone

On the Android device:

1. Enable `Developer options`.
2. Enable `USB debugging`.
3. Connect the phone to the PC with a USB cable.
4. Accept the USB debugging authorization prompt on the phone.

### 2. Confirm The Device Is Connected

On the PC, run:

```powershell
adb devices
```

You should see a device listed with status `device`.

### 3. Start The Dev Server

From the repo root:

```powershell
npm run dev
```

Keep this terminal running.

### 4. Reverse The Port Over USB

In another terminal, run:

```powershell
adb reverse tcp:5173 tcp:5173
```

This makes the phone's `localhost:5173` point to the PC's Vite dev server.

### 5. Open The App On The Phone

On the Android device, open Chrome and go to:

```text
http://localhost:5173
```

If needed, also try:

```text
http://127.0.0.1:5173
```

### 6. Grant Camera Permission

When Chrome asks for camera permission, allow it.

## Verify `adb reverse`

To check active reverse rules:

```powershell
adb reverse --list
```

To remove the reverse rule later:

```powershell
adb reverse --remove tcp:5173
```

## Troubleshooting

### The phone cannot open `localhost:5173`

Check these in order:

1. Make sure `npm run dev` is still running.
2. Run `adb devices` and confirm the device is still connected.
3. Run `adb reverse --list` and confirm `tcp:5173 tcp:5173` is present.
4. Open `http://localhost:5173` on the PC and confirm the app loads there.
5. On the phone, try both `http://localhost:5173` and `http://127.0.0.1:5173`.
6. If Chrome is showing a stale error page, fully close the tab or retry in Incognito mode.

### `npm run dev` exits immediately

Check whether port `5173` is already in use. The Vite config uses `strictPort: true`, so it will fail instead of choosing a different port.

### The phone does not appear in `adb devices`

Check:

- the USB cable
- the USB mode on the device
- whether the device prompt for USB debugging authorization was accepted
- whether Android platform-tools is installed correctly

### Camera access is denied

Check:

- Chrome camera permission on the phone
- site permission settings for `localhost`
- Android app-level camera permissions if the browser has been blocked

## Notes About Diagnostics

The debug UI includes:

- resolution selection
- performance metrics
- threshold coloring
- a threshold reference section

This is meant for comparing behavior across Android devices, especially older phones where preview smoothness and decode responsiveness may differ by resolution.