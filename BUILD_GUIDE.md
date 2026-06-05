# ICF Creative Portfolio — Complete Build & Release Guide

**Version:** 1.3
**Last updated:** 2026-06-01
**Maintainer:** Alex Gordon (`amgphotoshop@gmail.com` / `alexthebritgordon@gmail.com`)
**App version at time of writing:** v0.4.15

---

## 1. What This App Is

The **ICF Creative Portfolio** is an Electron desktop app distributed as a notarized macOS DMG. It is a portfolio browser for ICF Next's creative work, used internally by the team.

It has **two roles** depending on who's running it:

| Role | What it does |
|------|--------------|
| **Viewer** (everyone) | Opens the locally-mounted Box folder, displays the portfolio (`index.html`) and all assets. Read-only. |
| **Server** (one designated person at a time) | Runs the Python build pipeline + a local HTTP server in the background. Watches Box for new creative work, regenerates the portfolio, and writes a heartbeat to Box so other machines can see who's "the server." |

Anyone with the app can switch into the Server role from **Settings → Server**. Only one machine should run it at a time; the app enforces this via a Box-level lock file.

---

## 2. Credentials

> **Reality check:** these are all tied to Alex's personal accounts because ICF would not approve internal apps for distribution. If Alex leaves and someone needs to take over, they will need to either set up their own Apple Developer + GitHub accounts, or get the credentials handed off.

### 2.1 Apple — Code Signing & Notarization
- **Apple ID:** `alexthebritgordon@gmail.com`
- **App-Specific Password (for notarytool):** `bhrp-sljp-hlud-outa`
- **Team ID:** `9VRW78GQHM`
- **Developer ID certificate (in macOS Keychain):** `E3C6B97B885843868879D7360252DE1E1EAF732E` — "Developer ID Application: Alex Gordon (9VRW78GQHM)"

A keychain notary profile named `FillThatPDF` is also set up (left over from the FillThatPDF app — same Apple account). The `afterSign` script in `scripts/notarize.js` uses it to notarize the `.app` automatically during build.

### 2.2 GitHub — Auto-Update Distribution
- **Account:** `Alexthebrit` (Alex's personal GitHub)
- **Releases repo:** `Alexthebrit/icf-portfolio-releases` (public, releases-only)
- **`gh` CLI auth:** already set up on Alex's Mac. Two accounts are configured (`Alexthebrit` and `FillThatPDF`); `gh auth switch --user Alexthebrit` activates the right one.
- **Update channel:** `electron-updater` reads `latest-mac.yml` from the releases repo's "latest" tag. The app now auto-checks shortly after launch, **after the Box-hosted renderer has finished loading**, and still keeps the **Check for updates** button in Settings → About for manual retries.

### 2.2a Why the startup check is deferred
Early auto-update attempts (v0.2.0–v0.2.3) ran `checkForUpdatesAndNotify()` a few seconds after window creation. On some ICF Macs, that overlapped with fragile startup work and could leave the window invisible if GitHub was slow or blocked. The current fix is to wait for the renderer's `did-finish-load` event, then add a short delay before checking. That keeps the startup UI path separate from the network call while still giving users the FillThatPDF-style "download in background, then click Restart to update" flow. **Manual Box DMG installs remain the fallback** (`Clients/BGE/portfolio-master/ICF Creative Portfolio-X.Y.Z-arm64.dmg`) for any machine whose network cannot reach GitHub Releases.

### 2.3 Why "personal" credentials for an ICF tool
ICF's Box admin disabled OAuth app integrations and IT does not approve internal apps for codesigning under the corporate Apple account. Personal credentials were the only path. The app does not transmit anything to external services beyond Apple's notary service and GitHub Releases — no telemetry, no analytics.

---

## 3. Directory Structure

Two top-level directories matter on Alex's Mac. Both are also archived in Box at `Clients/BGE/portfolio-master/Source/` for handoff to future maintainers (see § 12).

### 3.1 App source (electron-builder project)
**`/Users/36981/Desktop/ICF Portfolio App/v0.4.15/`** — the Electron app source.

> **Folder name note:** The folder is now named `v0.4.15` to match the current release. Future releases should update this path.

```
v0.4.15/
├── BUILD_GUIDE.md          ← this document
├── README.md               ← quickstart and architecture overview
├── main.js                 ← Electron main process (Box folder picker, dev override,
│                              server mgmt, auto-updater, IPC handlers)
├── preload.js              ← exposes window.icfPortfolio.* API to renderer
├── package.json            ← version, publish config, build settings
├── renderer/
│   └── index.html          ← THE ENTIRE UI (sidebar, viewer, CSS, JS — all inline).
│                              Edit this for any UI/UX change. Must be published to Box.
├── assets/
│   └── icon.png            ← app icon
├── build/
│   └── entitlements.mac.plist
├── scripts/
│   └── notarize.js         ← afterSign hook for Apple notarization
├── py-scripts/             ← bundled inside the .app via extraResources
│   ├── build-portfolio.py  ← Python build engine (called by the in-app Server toggle)
│   └── serve-portfolio.py  ← local HTTP server on :8765
├── docs/
│   ├── ICF_Portfolio_User_Guide.html
│   └── ICF_Portfolio_User_Guide.pdf
├── node_modules/
└── dist/                   ← build output (DMG, ZIP, latest-mac.yml). gitignored.
```

### 3.2 Portfolio output (lives in Box, sync'd to colleagues)
**`/Users/36981/Library/CloudStorage/Box-Box/Clients/BGE/portfolio-master/`** — the built portfolio + shared distribution surface.

```
portfolio-master/
├── index.html              ← Production UI. Loaded by all colleagues' apps.
├── dev-index.html          ← Dev UI. Loaded by the developer's own installed app
│                              (auto-generated from renderer/index.html on each launch).
│                              MUST be kept in sync with index.html — see §7.
├── clients.js              ← client registry (generated by build-portfolio.py)
├── clients-config.json     ← user-added client config (logos, colors, fonts, paths).
│                              Edit this to add new clients without rebuilding the DMG.
├── manifest-{slug}.js      ← per-client project/asset manifests (generated)
├── version.js              ← build timestamp (used by the auto-refresh toast)
├── thumbs/{slug}/          ← generated thumbnails per client
├── fonts/{slug}/           ← per-client brand fonts (generated)
├── logos/                  ← per-client logos (generated)
├── favorites.json          ← user's starred assets AND starred jobs
├── .builder-active.json    ← server heartbeat (deleted on quit, stale >2 min = safe to take over)
└── ICF Creative Portfolio-X.Y.Z-arm64.dmg
    ← the current DMG, distributed to colleagues via Box shared link
```

> **Why is the UI in Box and not bundled in the app?**
> Two reasons: (1) historical — the portfolio existed as a Chrome-bookmarked page before the desktop app, and (2) practical — UI changes ship instantly to all viewers without a new DMG. The app is essentially a Chromium shell that loads this `index.html` over `file://`.

### 3.3 Standalone watcher (legacy / fallback)
**`/Users/36981/Desktop/ICF Portfolio Site/`** — the original Python scripts. Kept in sync with `v0.4.15/py-scripts/` as a backup. Can be run from terminal via `bash watch-and-build.sh` if the in-app Server mode is broken.

```
ICF Portfolio Site/
├── build-portfolio.py      ← canonical copy; this is what gets copied into py-scripts/
├── serve-portfolio.py      ← canonical copy
└── watch-and-build.sh      ← terminal entry point (fswatch + serve + heartbeat builds)
```

**Important:** when you change the Python scripts, edit them in `ICF Portfolio Site/` first, then copy into `v0.4.15/py-scripts/`. The build script picks up `py-scripts/` for bundling.

---

## 4. Prerequisites (One-Time Setup)

Skip this section if Alex's machine is the build machine — it's already done. Read it if you're a new person taking over the role.

### 4.1 Tools

```bash
# Node + npm (via nvm preferred)
node --version   # >= 18
npm --version    # >= 9

# GitHub CLI
brew install gh
gh auth login    # log in as Alexthebrit

# Optional: fswatch (lets the Server toggle react in 60s instead of 3 min)
brew install fswatch

# Python 3 — comes with macOS, no install needed
python3 --version  # >= 3.9
```

### 4.2 Apple Developer setup
1. Apple Developer Program membership ($99/year) on `alexthebritgordon@gmail.com`.
2. Generate a Developer ID Application certificate at developer.apple.com → Certificates, IDs & Profiles. Download and double-click to install in Keychain.
3. Confirm with: `security find-identity -v -p codesigning | grep 'Developer ID Application'`. The hash listed there is the value used in `package.json` → `build.mac.identity`.
4. Generate an app-specific password at appleid.apple.com → Sign-In and Security → App-Specific Passwords. Save it.
5. Store a notary profile in keychain:
   ```bash
   xcrun notarytool store-credentials "FillThatPDF" \
     --apple-id "alexthebritgordon@gmail.com" \
     --team-id "9VRW78GQHM" \
     --password "bhrp-sljp-hlud-outa"
   ```
   (The profile name "FillThatPDF" is hardcoded in `scripts/notarize.js`. Rename only if you also edit that script.)

### 4.3 GitHub setup
1. Create the releases repo if it doesn't exist:
   ```bash
   gh repo create Alexthebrit/icf-portfolio-releases --public \
     --description "Auto-update releases for ICF Creative Portfolio"
   ```
2. Seed it with at least one commit (GitHub refuses to host releases on truly empty repos). A README.md is enough.

### 4.4 GitHub source repo for Windows builds (optional, see §5.9)
```bash
gh repo create Alexthebrit/icf-portfolio-source --private --description "Source for ICF Creative Portfolio (GitHub Actions)"
```

### 4.5 Local clone of this project
```bash
cd "/Users/36981/Desktop/ICF Portfolio App/v0.4.15"
npm install
```

---

## 5. Step-by-Step: New Version Release

This is the canonical flow. Every release follows these steps.

### 5.1 Make your code changes
Edit `main.js`, `preload.js`, the Python scripts under `py-scripts/`, or — most commonly — `index.html` in the Box folder.

**Rule of thumb for what to edit where:**
- **App look & feel** (sidebar, settings panel, layout, search, filters, viewer) → `Box-Box/Clients/BGE/portfolio-master/index.html`. Does NOT require a new DMG.
- **App behavior** (file pickers, IPC, child-process management, auto-update logic, menus) → `main.js` / `preload.js`. Requires a new DMG.
- **Build engine logic** (thumbnail generation, category detection, manifest format) → `ICF Portfolio Site/build-portfolio.py`, then copy to `v0.1.0/py-scripts/build-portfolio.py`. Requires a new DMG.
- **HTTP server / API endpoints** → same as above but `serve-portfolio.py`.

### 5.2 Sync Python scripts (if you changed them)
```bash
cp "/Users/36981/Desktop/ICF Portfolio App/ICF Portfolio Site/build-portfolio.py" \
   "/Users/36981/Desktop/ICF Portfolio App/ICF Portfolio Site/serve-portfolio.py" \
   "/Users/36981/Desktop/ICF Portfolio App/v0.1.0/py-scripts/"
```

> **Symlink note (added 2026-05-19):** `v0.1.0/py-scripts/{build,serve}-portfolio.py` are symlinks pointing back to `ICF Portfolio Site/` so spawned dev servers pick up edits live. **electron-builder bundles symlinks literally**, and codesign then rejects symlinks pointing outside the .app — so before each release build you MUST replace the symlinks with real copies (`rm` then `cp`), then re-symlink after the build:
> ```bash
> PYSCRIPTS="$HOME/Desktop/ICF Portfolio App/v0.1.0/py-scripts"
> SRC="$HOME/Desktop/ICF Portfolio App/ICF Portfolio Site"
> # Before build:
> rm "$PYSCRIPTS/build-portfolio.py" "$PYSCRIPTS/serve-portfolio.py"
> cp "$SRC/build-portfolio.py" "$SRC/serve-portfolio.py" "$PYSCRIPTS/"
> # ... run electron-builder ...
> # After build:
> rm "$PYSCRIPTS/build-portfolio.py" "$PYSCRIPTS/serve-portfolio.py"
> ln -s "$SRC/build-portfolio.py" "$PYSCRIPTS/build-portfolio.py"
> ln -s "$SRC/serve-portfolio.py" "$PYSCRIPTS/serve-portfolio.py"
> ```

### 5.3 Bump the version
In `package.json`, increment the `version` field. Use semver:
- **Patch** (0.2.0 → 0.2.1): bugfixes only.
- **Minor** (0.2.0 → 0.3.0): new features, backward compatible.
- **Major** (0.2.0 → 1.0.0): breaking changes — would require all users to manually reinstall.

### 5.4 Build the DMG and ZIP
```bash
cd "/Users/36981/Desktop/ICF Portfolio App/v0.4.15"
export APPLE_ID="alexthebritgordon@gmail.com"
export APPLE_APP_SPECIFIC_PASSWORD="bhrp-sljp-hlud-outa"
export APPLE_TEAM_ID="9VRW78GQHM"
export GH_TOKEN=$(gh auth token --user Alexthebrit)

rm -rf dist/
npm run build:mac
```

Look for these expected log lines:
```
• signing      identity=E3C6B97B885843868879D7360252DE1E1EAF732E
🔐 Notarizing ICF Creative Portfolio via keychain profile "FillThatPDF"...
✅ Notarization complete!
• building     target=DMG arch=arm64 file=dist/ICF Creative Portfolio-X.Y.Z-arm64.dmg
```

> **Note:** electron-builder notarizes the `.app` inside the DMG via `afterSign`, but the DMG itself isn't notarized yet — that's the next step.

### 5.5 Notarize and staple the DMG
```bash
xcrun notarytool submit "dist/ICF Creative Portfolio-X.Y.Z-arm64.dmg" \
  --apple-id "$APPLE_ID" \
  --password "$APPLE_APP_SPECIFIC_PASSWORD" \
  --team-id "$APPLE_TEAM_ID" \
  --wait

xcrun stapler staple "dist/ICF Creative Portfolio-X.Y.Z-arm64.dmg"
```

The `--wait` flag blocks until Apple finishes (~1–5 minutes). You should see `status: Accepted`.

`stapler staple` attaches the notarization ticket to the DMG so Gatekeeper accepts it offline. If stapling fails with "Record not found," wait 30 seconds and retry — there's a propagation delay.

### 5.6 Publish to GitHub Releases (optional, for any users on open networks)
```bash
gh release create "vX.Y.Z" \
  --repo Alexthebrit/icf-portfolio-releases \
  --title "vX.Y.Z — short description" \
  --notes "What changed in this release…" \
  "dist/ICF Creative Portfolio-X.Y.Z-arm64.dmg" \
  "dist/ICF Creative Portfolio-X.Y.Z-arm64.dmg.blockmap" \
  "dist/ICF Creative Portfolio-X.Y.Z-arm64.zip" \
  "dist/ICF Creative Portfolio-X.Y.Z-arm64.zip.blockmap" \
  "dist/latest-mac.yml"
```

> [!WARNING]
> **CRITICAL AUTO-UPDATER PITFALLS:**
> 1. **Do not forget the `.zip` file!** macOS auto-updates (via Squirrel.Mac) actually download and extract the `.zip` file in the background, not the `.dmg`. If you only upload the DMG, auto-updates will silently fail or get stuck on "Downloading...".
> 2. **Hash mismatches after Stapling:** When you run `xcrun stapler staple` on the `.dmg` in step 5.5, macOS attaches a ticket to the file, which **changes its file size and SHA512 hash**. Because `latest-mac.yml` was generated *before* stapling, it expects the original un-stapled hash. This doesn't break macOS auto-updates (since they use the `.zip`), but if you ever rely on the DMG for auto-updates (like on Windows/Linux), you must re-generate the `latest-mac.yml` or just let `electron-builder` publish the un-stapled DMG directly.

All five artifacts are required:
- `*.dmg` — the installer (for manual Box downloads)
- `*.zip` — what electron-updater downloads for in-place background updates on Mac
- `*.blockmap` files — delta update support
- `latest-mac.yml` — manifest electron-updater reads to discover new versions

> **Trigger the Windows build:** After publishing the macOS release, push the source to GitHub to automatically kick off the Windows build (see §5.9). The Windows installer will appear in this same release once the CI workflow finishes.

Users on networks where GitHub is reachable can hit Settings → About → "Check for updates" to pull the new version. ICF colleagues on restrictive corporate networks won't see anything happen — they install from Box directly (next step).

### 5.7 Copy the DMG to Box (PRIMARY distribution channel)
```bash
cp "dist/ICF Creative Portfolio-X.Y.Z-arm64.dmg" \
   "/Users/36981/Library/CloudStorage/Box-Box/Clients/BGE/portfolio-master/"

# Remove the previous version's DMG to avoid confusion:
rm "/Users/36981/Library/CloudStorage/Box-Box/Clients/BGE/portfolio-master/ICF Creative Portfolio-X.Y.W-arm64.dmg"
```

> [!IMPORTANT]
> **BOX FOLDER ONLY NEEDS THE DMG!** 
> Do NOT copy the `.zip`, `.blockmap`, or `latest-mac.yml` files into the `portfolio-master` folder on Box. Those files are only used by the auto-updater and must be uploaded to GitHub Releases. Placing them in the Box folder wastes bandwidth and clutters the directory for the entire team. The Box folder is purely for manual, initial installations.

**The Box-hosted DMG is the source of truth for distribution.** All colleagues install from it. Existing users get the upgrade by quitting the app, dragging the new DMG out of Box, opening it, and replacing the app in /Applications. Their stored settings (Box folder, view preferences) are preserved across upgrades.

### 5.8 Verify the release
1. In the app: **Settings → About → "Check for updates"**. Should show the new version is available (or "up to date" if you're on it).
2. On GitHub: https://github.com/Alexthebrit/icf-portfolio-releases/releases — confirm all five files attached.
3. Optional: trash the local copy of the app, mount the Box DMG, install, launch. Verify it picks up auto-updates correctly.

### 5.9 Build the Windows Installer (automatic via GitHub Actions)

The Windows installer (NSIS `.exe`) is built automatically by GitHub Actions whenever you push source to `Alexthebrit/icf-portfolio-source`. There are no PyInstaller binaries — the Python scripts are bundled as raw `.py` files in `extraResources`, and Windows users need Python installed (the app uses `python` on Windows vs `python3` on macOS).

**Setup (one-time — already done for v0.4.15):**

1. Create a private source repo:
   ```bash
   gh repo create Alexthebrit/icf-portfolio-source --private
   ```

2. Set up a `RELEASE_TOKEN` secret in the source repo (GitHub → Settings → Secrets and variables → Actions):
   - Create a GitHub Personal Access Token (classic, `repo` scope) at https://github.com/settings/tokens
   - Add it as a secret named `RELEASE_TOKEN` in the source repo's Action secrets
   - This token needs write access to `Alexthebrit/icf-portfolio-releases`

**Per-release (the automatic flow):**

1. Complete steps 5.1–5.5 as normal (code changes → bump version → build macOS DMG → notarize)
2. Push the version-bumped source to GitHub — this triggers the Windows build automatically:
   ```bash
   cd "/Users/36981/Desktop/ICF Portfolio App/v0.X.Y"
   git add -A && git commit -m "vX.Y.Z"
   git push
   ```
3. While the Windows build runs in CI, publish the macOS DMG to GitHub Releases (step 5.6):
   ```bash
   gh release create "vX.Y.Z" --repo Alexthebrit/icf-portfolio-releases ...
   ```
4. The Windows build, when it finishes, will detect the release already exists and upload `ICF-Creative-Portfolio-X.Y.Z-Setup.exe` + `latest.yml` alongside the macOS artifacts.

> **Order doesn't matter:** If the Windows build finishes first, it creates the release with just the `.exe`. When you then run `gh release create` for macOS, it will upload the DMGs and the Windows assets stay in place. If macOS publishes first, the Windows build appends its files to the existing release.

**What the workflow does:**
1. Checks out the source on `windows-latest`
2. Runs `npm ci` to install Node dependencies
3. Runs `npx electron-builder --win nsis --x64` to produce `ICF-Creative-Portfolio-X.Y.Z-Setup.exe` + `latest.yml`
4. Uploads both files to the matching GitHub release on `Alexthebrit/icf-portfolio-releases`

Users running the Windows version will see auto-update prompts from `electron-updater` reading `latest.yml`.

> **Note:** The macOS auto-updater reads `latest-mac.yml`; Windows reads `latest.yml`. Both manifests are now published to the same GitHub release, so auto-updates work on both platforms.

---

## 6. The Build / Server Pipeline (Python)

When a user toggles **Settings → Server → "Run build server on this machine"**, the Electron main process spawns three child processes:

| Process | What it does |
|---------|--------------|
| `python3 serve-portfolio.py` | Local HTTP server on `:8765`. Serves the Box folder root (so `file://` relative paths in `index.html` and `/_api/` endpoints both work). |
| `python3 build-portfolio.py --client all` | One-shot build: scans `Box/Clients/*/Projects/`, generates thumbnails, writes `manifest.js` and `version.js`. |
| `fswatch -o --latency 60 Box/Clients` | Optional. When files land in any client's folder, triggers a rebuild. Falls back to a 3-minute heartbeat if `fswatch` isn't installed. |

**Coordination across machines** — `.builder-active.json` in `portfolio-master/`:
- The active builder writes `{ machine, user, pid, appVersion, lastSeen }` every 30 seconds.
- When another user opens **Settings → Server**, the app reads this file to display "Active: $machine."
- If `lastSeen` is older than 2 minutes, the lock is considered stale and any other machine can take over.
- On graceful app quit, the file is deleted so handoff is immediate.

**To edit the build logic**: edit `build-portfolio.py` (the canonical copy in `ICF Portfolio Site/`), then copy to `v0.1.0/py-scripts/`. The next DMG release will ship the new logic. **Existing copies of the app keep using their bundled version** — the Python scripts ship with the DMG, not with auto-updates of `index.html`. That's why bumping the app version is the right way to ship Python changes.

---

## 7. Editing the UI Without Rebuilding the App

The portfolio's UI (sidebar, settings panel, project viewer, search bar, filters, compare mode, etc.) is all in **one file** on the developer's machine:

```
/Users/36981/Desktop/ICF Portfolio App/v0.4.15/renderer/index.html
```

Edits to this file appear immediately on every viewer's next app launch (or after **⌘R** reload). No DMG rebuild needed.

### ⚠️ CRITICAL: Always publish BOTH Box files

Because of the dev override in `main.js` (lines 304–321), the developer's own installed app **does not** load `portfolio-master/index.html` — it detects `renderer/index.html` next to `main.js` and instead copies it to `dev-index.html` and loads that. This means:

- If you only copy to `index.html` → colleagues see the update, but you don't
- If you only copy to `dev-index.html` → you see the update, but colleagues don't
- **Always copy to both:**

```bash
cp "renderer/index.html" "/Users/36981/Library/CloudStorage/Box-Box/Clients/BGE/portfolio-master/index.html"
cp "renderer/index.html" "/Users/36981/Library/CloudStorage/Box-Box/Clients/BGE/portfolio-master/dev-index.html"
```

> **Caveat:** if your edit introduces a new IPC call or browser API that requires changes in `main.js` or `preload.js`, you DO need to rebuild the DMG. The renderer ↔ main bridge is defined in `preload.js` and pre-baked into each user's installed copy.

---

## 8. Troubleshooting

### `Error 65 — The staple and validate action failed!`
Apple's CloudKit hasn't propagated the notarization ticket yet. Wait 30 seconds and re-run `xcrun stapler staple ...`.

### `HTTP 422: Repository is empty` on `gh release create`
GitHub refuses to host releases on a fresh repo with zero commits. Push a README.md first:
```bash
cd /tmp && git init && git checkout -b main
echo "# ICF Portfolio Releases" > README.md
git add . && git commit -m "Initial commit"
git remote add origin https://github.com/Alexthebrit/icf-portfolio-releases.git
git push -u origin main
```

### `Notarization failed`
Run `xcrun notarytool log <submission-id> --apple-id "$APPLE_ID" --password "$APPLE_APP_SPECIFIC_PASSWORD" --team-id "$APPLE_TEAM_ID"` to see Apple's specific complaint. Usually one of:
- An unsigned binary inside the `.app` (electron-updater's helper binaries; should be signed automatically by electron-builder)
- Hardened Runtime missing on a sub-binary
- Expired certificate

### The app hangs on startup with no window
This has bitten us twice in different forms. If you see it again:

1. **Check `findPortfolioIndex()` for recursive `fs.readdirSync`.** That was v0.1.1's bug — the Box folder picker was walking online-only Box stubs and blocking indefinitely. The function now uses a fixed list of candidate paths.

2. **Check when auto-update is running.** The safe pattern is: create the window, wait for `did-finish-load`, then call `autoUpdater.checkForUpdatesAndNotify()` after a short delay. The older v0.2.x approach fired too early (5 seconds after window creation) and could interfere with rendering on some ICF Macs when GitHub was blocked.

3. **Check `webPreferences.show`.** Set to `true`, not `false`. Waiting for `ready-to-show` is a footgun: if the initial page never renders cleanly, the window stays hidden forever. Better to show an empty window than no window.

### The app shows a blank UI (empty Client dropdown, no projects)
This is Box's online-only file stubs. The renderer's `<script src="clients.js">` fetches a 0-byte stub and `window.PORTFOLIO_CLIENTS_LIST` ends up undefined. No console errors.

User-side fix: right-click `portfolio-master/` in Finder → "Make Available Offline."

Build-script side fix: `build-portfolio.py` now sets `os.umask(0o022)` so output files are mode `0644` (world-readable). Earlier builds were writing `0600` files which compounded the issue when synced through Box.

### Windows installer not uploaded to release
Check that the `RELEASE_TOKEN` secret is set in the source repo and has write access to `Alexthebrit/icf-portfolio-releases`. If the token is scoped to a single repo, create a new PAT with broader scope.

### `python3` not found on Windows
The `main.js` `getPythonCommand()` function returns `python` on Windows. If users get "Python not found" errors, they need to install Python 3 from python.org and ensure it's on their PATH. This only affects the Server mode (build/serve pipeline), not the viewer role.

### `gh auth status` shows the wrong account active
```bash
gh auth switch --user Alexthebrit
```
The releases repo lives under Alexthebrit. FillThatPDF is a separate account, also configured in the same `gh` install.

### Box hasn't materialized files yet → build is missing assets
After a Box Drive reset, files are online-only stubs. The build script's first few passes will produce incomplete manifests until Box re-hydrates everything. **Don't rebuild the DMG against partial output.** Wait until job counts stabilize, or right-click each `Clients/<NAME>` folder in Finder → "Make Available Offline" to force materialization.

### Two machines accidentally running the server simultaneously
The heartbeat lock should prevent this, but if it happens (e.g., one machine crashed mid-build and left a stale lock the other one took over before it cleared):
1. Have both users toggle Server off.
2. Manually delete `Box-Box/Clients/BGE/portfolio-master/.builder-active.json`.
3. Have ONE person toggle Server on. The other should see "Active: $name" and leave it off.

### Auto-update isn't downloading new versions
1. Check **Settings → About** — what version does it say? If it matches the latest release, you're up to date.
2. Click "Check for updates." Check the app's log at `~/Library/Logs/ICF Creative Portfolio/main.log`.
3. Confirm `latest-mac.yml` is attached to the GitHub release. Without it, electron-updater can't discover new versions.
4. Confirm the GitHub release isn't marked as "pre-release" or "draft" — electron-updater only sees published, non-prerelease releases.

---

## 9. Key Files Cheat Sheet

| Need to change… | Edit this file | Rebuild DMG? |
|---|---|---|
| Sidebar, viewer, settings UI, search, filters, favorites | `v0.4.15/renderer/index.html` → publish both Box files (see §7) | No |
| Color scheme, layout, CSS | Same (it's all inline) | No |
| Add/edit a client | `portfolio-master/clients-config.json` + run `build-portfolio.py --client <slug>` | No |
| Client logos, fonts, colors | `clients-config.json` entries | No |
| App window size, menu items, Box folder picker | `v0.4.15/main.js` | **Yes** |
| What `window.icfPortfolio.*` exposes to the UI | `v0.4.15/preload.js` | **Yes** |
| Build engine: thumb generation, categories, manifest schema | `ICF Portfolio Site/build-portfolio.py` → copy to `v0.4.15/py-scripts/` | **Yes** |
| HTTP API endpoints (`/_api/...`) | `ICF Portfolio Site/serve-portfolio.py` → copy to `v0.4.15/py-scripts/` | **Yes** |
| App icon | `v0.4.15/assets/icon.png` | **Yes** |
| Notarization or signing cert | `v0.4.15/package.json` → `build.mac.identity` + keychain profile | **Yes** |
| GitHub releases destination | `v0.4.15/package.json` → `build.publish.repo` | **Yes** (publish config gets baked in) |
| Windows build pipeline | `v0.4.15/.github/workflows/build-windows.yml` | No (runs on GitHub Actions) |
| Windows installer config | `v0.4.15/package.json` → `build.win` / `build.nsis` | **Yes** |
| Windows Python fallback | `v0.4.15/main.js` → `getPythonCommand()` | **Yes** |

---

## 9b. Active Clients Reference

### Built-in clients (defined in `build-portfolio.py` → `CLIENTS` dict)

| Slug | Display Name | Brand Font | Notes |
|------|-------------|------------|-------|
| `bge` | BGE | Diodrum | Primary client; portfolio-master lives in BGE's Box folder |
| `smeco` | SMECO | Gotham | |
| `pnm` | PNM | Klavika | |
| `pseg` | PSE&G | Proxima Nova | |
| `ameren` | Ameren | Scout Condensed | |
| `avangrid` | Avangrid | IberPangea | |
| `centralhudson` | Central Hudson | Myriad Pro | |
| `conedison` | ConEdison | Open Sans | Logo is from Z_Old (2021); update when 2025 PNG available |
| `consumersenergy` | Consumers Energy | Boston | |
| `dte` | DTE | (system fallback) | Good Pro license not in Assets yet |
| `phi` | PHI | Diodrum | Exelon umbrella (Pepco/Delmarva/ACE); reuses BGE fonts |

### User-added clients (defined in `portfolio-master/clients-config.json`)

| Slug | Display Name | Brand Font | Notes |
|------|-------------|------------|-------|
| `socalren` | SoCalREN | Avenir | |
| `socalgas` | SoCalGas | Interstate | |
| `evergy` | Evergy | (system fallback) | No font files in Assets yet |
| `comed` | ComEd | (system fallback) | No font/color config yet |
| `eal` | EAL | (system fallback) | Entergy Solutions |
| `nmgc` | NMGC | Codec Pro Heavy / Helvetica Neue | New Mexico Gas Company |
| `mass_save` | Mass Save | Gotham | |
| `washington_gas` | Washington Gas | Typo Gotika (woff2) | AltaGas brand; Wonder Unit Sans also available |

### Adding a new client
1. Add an entry to `portfolio-master/clients-config.json` (no DMG rebuild needed)
2. Run: `python3 py-scripts/build-portfolio.py --client <slug> --force`
3. Check the output for job/asset counts and any warnings
4. Test in the app by switching to the new client in the CLIENT dropdown

---

## 9c. UI Features Reference (as of v0.4.15)

### Favorites & Awards System
- **Per-asset:** ⭐🏆 circular buttons (22×22px, dark bg) on each thumbnail in Cards, List, and Matrix views. Shown at `opacity: 0.4`, full on hover/active.
- **Per-job:** ⭐🏆 buttons on job/project card headers. In **Cards/List** view: 22×22px, horizontal, underneath the program name in the `proj-card-meta` row. In **Matrix mini** view: 16×16px, stacked vertically, absolutely positioned top-right of the row header.
- **Favorites filter behavior:** the ⭐ Favorites sidebar button shows (a) individually starred assets AND (b) ALL assets belonging to any job that was starred at the job level.
- **Storage:** `portfolio-master/favorites.json` and `portfolio-master/awards.json`.

### Performance — Never Use `backdrop-filter` on Repeated Elements
The tile memory limit crash (which causes the app window to suddenly disappear/close) is caused by `backdrop-filter: blur()` on elements that render hundreds of times simultaneously. This was discovered and fixed in v0.4.15 (removed from per-row Matrix buttons, per-asset `.ca-kind` badges, and `.is-video::after` play buttons). **Do not add `backdrop-filter` back to any button or badge that appears once per asset or job in list/matrix views.** Modal overlays (`.modal-bg`, `.settings-bg`, etc.) are fine since only one renders at a time.

---

## 10. If You're Taking Over This Project

Welcome. A few practical things:

1. **Read this file end-to-end** before changing anything.
2. **Test the Server toggle on your Mac first.** Make sure the heartbeat appears in Box and disappears on quit before you trust it to keep the team's builds going.
3. **You will probably need your own Apple Developer account** ($99/year) unless Alex transfers his. If you generate a new certificate, update `build.mac.identity` in `package.json` and re-create the notary keychain profile.
4. **Repo ownership transfer**: ask Alex to transfer `Alexthebrit/icf-portfolio-releases` to your account, or fork it and update `package.json` → `build.publish.owner` accordingly. Existing users running v0.2.0+ will follow auto-updates from wherever `publish` points.
5. **Test a dummy release on a non-production version number** (e.g., v9.9.9) before shipping a real one. Confirm the in-app updater picks it up.
6. **For UI-only changes** (the most common case), you don't need any of this — just edit `index.html` directly.

---

## 11. Reference Links

- Electron auto-update docs: https://www.electron.build/auto-update
- Apple notarytool: https://developer.apple.com/documentation/security/notarizing_macos_software_before_distribution/customizing_the_notarization_workflow
- GitHub CLI release docs: https://cli.github.com/manual/gh_release_create
- This guide lives at:
  - `Box-Box/Clients/BGE/portfolio-master/Source/BUILD_GUIDE.md` (canonical, accessible to the team)
  - `/Users/36981/Desktop/ICF Portfolio App/v0.1.0/BUILD_GUIDE.md` (working copy on Alex's Mac)
- Source archive in Box: `Box-Box/Clients/BGE/portfolio-master/Source/`
- Releases repo: https://github.com/Alexthebrit/icf-portfolio-releases
- User-facing guide (PDF): `Box-Box/Clients/BGE/portfolio-master/ICF_Portfolio_User_Guide.pdf`

---

## 12. Box Source Archive — Handoff Path

The full source code is mirrored to Box at:

```
Box-Box/Clients/BGE/portfolio-master/Source/
├── BUILD_GUIDE.md           ← top-level copy of this guide
├── README.md                ← quickstart for newcomers
├── electron-app/            ← rsync of Alex's v0.1.0/ folder (no node_modules, no dist)
└── python-engine/           ← rsync of Alex's ICF Portfolio Site/ folder (scripts only)
```

This means **anyone on the team with Box access can take over the project** without needing Alex's Mac.

### Keeping it in sync

After every release (and any time you make meaningful changes to `main.js`, `preload.js`, `build-portfolio.py`, `serve-portfolio.py`, etc.), run:

```bash
bash "/Users/36981/Desktop/ICF Portfolio App/v0.1.0/scripts/sync-source-to-box.sh"
```

This `rsync`s the canonical Desktop locations into Box, excluding `node_modules`, `dist`, `__pycache__`, build caches, and the local `portfolio-master/` output dir that lives inside `ICF Portfolio Site/`. The script is idempotent and safe to re-run.

### For someone inheriting the project

```bash
# 1. Pull source from Box
cp -R "$HOME/Library/CloudStorage/Box-Box/Clients/BGE/portfolio-master/Source" \
      "$HOME/Desktop/ICF-Portfolio-Source"
cd "$HOME/Desktop/ICF-Portfolio-Source/electron-app"

# 2. Install dependencies
npm install

# 3. Read the build guide
open ../BUILD_GUIDE.md

# 4. Set up Apple Developer + GitHub credentials (see § 2 of this guide)
```

The Box archive is a **snapshot**, not a live working tree. To actively develop you'll want to keep your local copy on your own Desktop. If you want the source to keep flowing back into Box for the team, set up `sync-source-to-box.sh` on your machine too — adjust the `ELECTRON_SRC` and `PYTHON_SRC` paths at the top to point to wherever you put the source.

---

*End of build guide. Questions go to Alex at `amgphotoshop@gmail.com` while he's still around.*

---

*Section 12 added on 2026-05-15 to document the Box `Source/` archive for project handoff.*
