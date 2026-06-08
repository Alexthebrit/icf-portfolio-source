# S3 Sync Handoff — Taking Over While Alex Is Away

## Prerequisites

Before starting, confirm both of these work on your Mac:

**1. Box Sync — you see the portfolio-master folder**

```bash
ls ~/Library/CloudStorage/Box-Box/Clients/BGE/portfolio-master
```
You should see a list of client folders (BGE, Delmarva, etc.).

**2. AWS SSO — you can access the S3 bucket**

```bash
aws sts get-caller-identity --profile sso-profile
```
You should see your name and account `103457025906`. If this fails, you haven't been granted SSO access yet — ask Alex to have IT add you.

---

## Setup (one time — 2 minutes)

```bash
# 1. Clone the project to your Desktop
cd ~/Desktop
git clone https://github.com/Alexthebrit/icf-portfolio-source.git "ICF Portfolio App/v0.5.1"

# 2. Install the auto-refresh LaunchAgent
cd "ICF Portfolio App/v0.5.1"
bash scripts/install-aws-autorefresh.sh
```

> **Note:** This clone is read-only. The sync pipeline is **Box → S3** — your local copy of the scripts never sends anything to GitHub. Nothing from your Desktop gets pushed unless you explicitly `git push`.

The LaunchAgent keeps your SSO session valid by re-authenticating every 6 hours (before the 8-hour expiry kicks in). When it opens a browser tab, just click **Allow** — that's it.

To confirm it's running:
```bash
launchctl list com.icf.aws-sso-refresh
```

---

## How to sync (whenever you want)

```bash
bash ~/Desktop/"ICF Portfolio App/v0.5.1"/scripts/sync-to-s3.sh
```

It will:
1. Check your AWS credentials (opens a browser if expired — click Allow, wait a few seconds)
2. Sync the portfolio-master folder to the S3 web bucket
3. Show `Sync complete — web version updated` when done

That's the complete replacement for Cyberduck.

---

## Running Server mode (for auto-syncs)

The auto-syncs only happen when the Electron app's **Build server** is toggled on. Here's how:

1. Open the **ICF Creative Portfolio** app from your Applications folder
2. Go to the **Server** tab
3. Click the **Build server** toggle to turn it on (it will auto-discover your Box folder)
4. Leave the app running in the background — that's it

The app will now watch for file changes and sync to S3 automatically. You can close the window, just don't **Quit** the app.

If another machine is already running the server, the app will ask if you want to take over. Click **Yes** — their lock will expire and your machine takes over.

> **Note:** The server can only run on **one machine at a time**. The `.builder-active.json` lock file prevents conflicts. If you see "another machine is running the server", either wait for them to finish or take over.

### How often the web version updates automatically

While Server mode is running with the toggle on:

- **fswatch** detects file changes in Box → builds → syncs to S3 (every ~60s during active work)
- **Heartbeat** every 3 minutes as a safety net (builds even if nothing changed)
- Each successful build immediately syncs to S3

The website is always at most ~3 minutes stale while Server mode is on.

If Server mode is off, just run the manual sync command above.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `aws: command not found` | Run: `brew install awscli` |
| `Operation not permitted` | Run the install script again: `bash scripts/install-aws-autorefresh.sh` |
| Login timed out | Run manually: `aws sso login --profile sso-profile`, then retry sync |
| `portfolio-master not found` | Check Box is synced: `ls ~/Library/CloudStorage/Box-Box/Clients/BGE/portfolio-master` |

---

## After Alex returns

No cleanup needed. The LaunchAgent can stay — it only opens a browser when credentials are within 90 minutes of expiry, so most runs are silent. To remove it:

```bash
launchctl unload ~/Library/LaunchAgents/com.icf.aws-sso-refresh.plist
rm ~/Library/LaunchAgents/com.icf.aws-sso-refresh.plist
```
