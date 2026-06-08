# ICF Creative Portfolio — Desktop App

Electron wrapper around the portfolio web app, so teammates can browse ICF Next's Box content with no URL, no server, no IT involvement.
**Current version:** v0.5.3

**Source location:** `/Users/36981/Desktop/ICF Portfolio App/v0.5.3/`
**Portfolio output:** `/Users/36981/Library/CloudStorage/Box-Box/Clients/BGE/portfolio-master/`

---

## How it works

1. App launches → auto-detects `~/Library/CloudStorage/Box-Box` (or prompts to pick)
2. **Dev override:** If `renderer/index.html` exists next to `main.js`, the app copies it to `portfolio-master/dev-index.html` in Box and loads **that** instead of `index.html`. This means the installed production app on the developer's Mac always runs the latest local code.
3. For all other users (colleagues), the app loads `portfolio-master/index.html` directly from Box
4. `webSecurity: false` lets the renderer load cross-directory `file://` assets (PDFs, images, etc.) — which a normal browser blocks

> **⚠️ Critical publishing rule:** Whenever you edit `renderer/index.html`, you must copy it to **both** files in Box:
> ```bash
> cp "renderer/index.html" "/Users/36981/Library/CloudStorage/Box-Box/Clients/BGE/portfolio-master/index.html"
> cp "renderer/index.html" "/Users/36981/Library/CloudStorage/Box-Box/Clients/BGE/portfolio-master/dev-index.html"
> ```
> If you only copy to `index.html`, the developer's own app will still load the old `dev-index.html` and appear to not receive the update.

---

## Running in dev

```bash
cd "/Users/36981/Desktop/ICF Portfolio App/v0.5.3"
npm install
npm start
```

First run will prompt for your Box folder. Pick the top-level Box folder (usually `Box-Box`, inside `~/Library/CloudStorage/`).

---

## Building a .dmg

See `BUILD_GUIDE.md` for the full release process. Quick reference:

```bash
cd "/Users/36981/Desktop/ICF Portfolio App/v0.5.3"
export APPLE_ID="alexthebritgordon@gmail.com"
export APPLE_APP_SPECIFIC_PASSWORD="bhrp-sljp-hlud-outa"
export APPLE_TEAM_ID="9VRW78GQHM"
export GH_TOKEN=$(gh auth token --user Alexthebrit)

rm -rf dist/
npm run build:mac
```

---

## Architecture notes

- `main.js` — Electron main. Box folder detection, dev override logic, IPC handlers, auto-updater
- `preload.js` — IPC bridge exposing `window.icfPortfolio.*` to the renderer
- `renderer/index.html` — **The entire UI** (sidebar, filters, viewer, Settings, CSS, JS — all inline). This is the primary file you'll edit for UI changes. Must be published to Box to take effect (see above).
- `py-scripts/build-portfolio.py` — Python build engine. Walks Box client folders, generates thumbnails, writes manifest JS files
- `py-scripts/serve-portfolio.py` — Local HTTP server on `:8765` for the Server role
- `assets/icon.png` — App icon
- `build/entitlements.mac.plist` — Hardened-runtime entitlements for code signing

---

## Active clients

Clients are configured in two places:

**Built-in** (in `py-scripts/build-portfolio.py` → `CLIENTS` dict):
`bge`, `smeco`, `pnm`, `pseg`, `ameren`, `avangrid`, `centralhudson`, `conedison`, `consumersenergy`, `dte`, `phi`

**User-added** (in `portfolio-master/clients-config.json` — no DMG rebuild needed):
`socalren`, `socalgas`, `evergy`, `comed`, `eal`, `nmgc`, `mass_save`, `washington_gas`

To add a new client, add an entry to `clients-config.json` and run:
```bash
python3 py-scripts/build-portfolio.py --client <slug> --force
```

---

## Key UI features (as of v0.5.3)

- **Per-asset favorites & awards** — ⭐🏆 buttons on each thumbnail (Cards, List, Matrix views)
- **Per-job favorites & awards** — ⭐🏆 buttons on job/project headers, stacked vertically (Cards and List views), and small 16×16px stacked vertically on the right in Matrix mini rows
- **Favoriting a job** marks the whole job in `favorites.json`; the ⭐ Favorites sidebar filter shows both individually-starred assets AND all assets from starred jobs
- **Matrix view** — dense thumbnail grid, absolutely no `backdrop-filter` CSS on any buttons or per-asset badges (prevents Chromium tile memory limit crashes)
- **Brand theming** — each client has custom colors, fonts, and logo loaded from `clients-config.json` or the built-in `CLIENTS` dict

---

## Performance notes

- **Never use `backdrop-filter: blur()` on elements that render hundreds of times** (e.g., per-asset type badges `.ca-kind`, video play buttons, or per-row buttons in Matrix view). This creates GPU compositing layers for every instance and crashes Chromium with "tile memory limits exceeded" (the window will just suddenly disappear/close). Removed from all per-asset and button styles in v0.4.15/v0.5.3 (modal overlays are fine since only one renders at a time).
