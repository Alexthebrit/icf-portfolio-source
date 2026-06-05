# How to Start the Dev App

## Start (with DevTools open)

```bash
cd "<this folder>"
npm run dev &
```

- `npm run dev` runs `env -u ELECTRON_RUN_AS_NODE electron . --dev`
- **Must use `&`** to background it; Electron runs until the window is closed
- **Must `cd` into the app folder first** — `electron .` reads `main` from the local `package.json`

## Kill before restarting

```bash
pkill -f "electron.*<folder name>"
```

## Restart in one line

```bash
pkill -f "electron.*<folder name>" 2>/dev/null; sleep 1; cd "<this folder>" && npm run dev &
```

## Why `env -u ELECTRON_RUN_AS_NODE`

VS Code (and the Continue extension) set `ELECTRON_RUN_AS_NODE=1` in all child
processes. This makes Electron behave like plain Node.js — so `require('electron')`
returns undefined and the app crashes immediately with:

  TypeError: Cannot read properties of undefined (reading 'whenReady')

The `env -u ELECTRON_RUN_AS_NODE` prefix unsets that variable before launching,
so Electron runs as a proper desktop app. **Always include it when launching from
VS Code terminals.**

## Notes

- `npm start` launches without DevTools (also uses `env -u ELECTRON_RUN_AS_NODE`)
- The `Autofill.enable` console errors on startup are harmless Chromium/DevTools noise
