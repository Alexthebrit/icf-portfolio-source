#!/usr/bin/env python3
"""
Custom HTTP server for the multi-client portfolio.

  - Serves static files from BOX_ROOT (so manifest paths can resolve).
  - Adds /_api/* POST endpoints used by the Settings panel:
      POST /_api/clients       → add/edit a user-added client
      DELETE /_api/clients     → remove a user-added client
      POST /_api/build         → trigger a build for a client (or 'all')
      GET  /_api/info          → list user-added vs built-in clients

User-added clients live in clients-config.json next to the portfolio
output. Built-in clients (BGE, PSE&G, SMECO, etc.) stay in
build-portfolio.py and cannot be deleted via the API.

Usage (called by watch-and-build.sh):
    python3 serve-portfolio.py
"""
from __future__ import annotations
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import threading
from http.server import HTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlparse

# ---------------------------------------------------------------------------

BOX_ROOT = Path('/Users/36981/Library/CloudStorage/Box-Box')
OUT_ROOT = BOX_ROOT / 'Clients' / 'BGE' / 'portfolio-master'
CONFIG_FILE = OUT_ROOT / 'clients-config.json'
BUILD_SCRIPT = Path(__file__).resolve().parent / 'build-portfolio.py'
PROGRESS_PATH = Path('/tmp/portfolio-build-progress.json')

# Built-in slugs come from build-portfolio.py CLIENTS dict and cannot be
# deleted (they're shared agency clients managed in code). Computed at
# runtime so new built-ins are picked up automatically.
def builtin_slugs() -> set:
    return set(load_builtin_clients().keys())

PORT = 8765
# Bind to 0.0.0.0 (all network interfaces) so teammates on the same LAN
# or VPN can reach the portfolio at http://[your-local-ip]:8765. To go
# back to "only this machine can connect," set HOST = '127.0.0.1' again.
HOST = '0.0.0.0'

# A single in-flight build at a time, identified by slug
_build_lock = threading.Lock()
_build_process: subprocess.Popen | None = None


# ---------------------------------------------------------------------------

def load_builtin_clients() -> dict:
    """Import build-portfolio.py and pull out its CLIENTS dict so we can
    expose built-in client paths through the API (for the Edit form)."""
    try:
        spec = importlib.util.spec_from_file_location('build_portfolio', BUILD_SCRIPT)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return getattr(mod, 'CLIENTS', {})
    except Exception as e:
        print(f'⚠️ couldn\'t import {BUILD_SCRIPT}: {e}')
        return {}


def effective_client_config(slug: str) -> dict | None:
    """Return the current effective config for a client (built-in defaults
    + user-added overrides on top), shaped for the Edit form."""
    builtins = load_builtin_clients()
    cfg = load_config()
    user_cfg = cfg.get('clients', {}).get(slug, {})
    base = builtins.get(slug, {})
    if not base and not user_cfg:
        return None

    # Merge: user config wins where set
    name = user_cfg.get('name') or base.get('name', '')
    projects = user_cfg.get('projects') or (str(base.get('projects')) if base.get('projects') else '')
    logo = user_cfg.get('logo') or (str(base.get('logo_src')) if base.get('logo_src') else '')

    # font_dir: derive from font files if it's a built-in
    font_dir = user_cfg.get('font_dir', '')
    if not font_dir and base.get('font') and base['font'].get('files'):
        font_dir = str(base['font']['files'][0]['src'].parent)

    # colors: user overrides on top of built-in
    base_colors = base.get('colors', {})
    user_colors = user_cfg.get('colors', {})
    merged_colors = {**base_colors, **user_colors}

    return {
        'slug': slug,
        'name': name,
        'projects': projects,
        'logo': logo,
        'font_dir': font_dir,
        'colors': merged_colors,
        'isBuiltin': slug in builtins,
        'hasOverride': slug in cfg.get('clients', {}),
    }


def load_config() -> dict:
    if CONFIG_FILE.exists():
        try:
            return json.loads(CONFIG_FILE.read_text())
        except Exception as e:
            print(f'⚠️ couldn\'t parse {CONFIG_FILE}: {e}')
    return {'clients': {}}


def save_config(cfg: dict) -> None:
    CONFIG_FILE.parent.mkdir(parents=True, exist_ok=True)
    CONFIG_FILE.write_text(json.dumps(cfg, indent=2))


def kick_build(slug: str = 'all') -> None:
    """Run a build in the background. Skips if one is already running."""
    global _build_process
    with _build_lock:
        if _build_process and _build_process.poll() is None:
            print(f'  ↳ build already in flight, queueing skipped')
            return
        cmd = ['python3', str(BUILD_SCRIPT), '--client', slug]
        print(f'  ↳ kicking build: {" ".join(cmd)}')
        _build_process = subprocess.Popen(
            cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
        )


def validate_client_payload(p: dict, is_edit: bool) -> tuple[bool, str]:
    """Return (ok, error message). When editing, paths are optional —
    blank fields mean 'don't change this'. When adding, all required."""
    if not p.get('slug'):
        return False, 'Missing slug'
    if not p.get('name'):
        return False, 'Missing display name'
    slug = p['slug']
    if not slug.replace('_', '').replace('-', '').isalnum():
        return False, 'Slug must be alphanumeric (plus _ or -)'
    if not is_edit:
        for k in ['projects', 'logo']:
            if not p.get(k):
                return False, f'Missing required field: {k}'
    # Whatever paths are provided must actually exist
    if p.get('projects') and not Path(p['projects']).is_dir():
        return False, f'Projects path is not a folder: {p["projects"]}'
    if p.get('logo') and not Path(p['logo']).is_file():
        return False, f'Logo path is not a file: {p["logo"]}'
    if p.get('font_dir') and not Path(p['font_dir']).is_dir():
        return False, f'Font folder is not a folder: {p["font_dir"]}'
    return True, ''


def autodetect_fonts(font_dir: Path) -> list[dict]:
    """Find Regular/Italic/Bold/BoldItalic-style fonts in a folder."""
    if not font_dir or not font_dir.is_dir():
        return []
    weight_map = {'normal': None, 'italic': None, 'bold': None, 'bold_italic': None}
    candidates = sorted(
        [p for p in font_dir.iterdir() if p.is_file() and p.suffix.lower() in ('.otf', '.ttf', '.woff2', '.woff')],
        key=lambda p: (
            # Prefer woff2 > woff > otf > ttf
            {'.woff2': 0, '.woff': 1, '.otf': 2, '.ttf': 3}[p.suffix.lower()],
            p.name,
        ),
    )

    def classify(stem: str) -> str | None:
        s = stem.lower().replace(' ', '').replace('-', '').replace('_', '')
        is_italic = 'italic' in s or s.endswith('it') or s.endswith('ital')
        is_bold = 'bold' in s or 'heavy' in s or 'black' in s
        is_regular = 'regular' in s or 'book' in s or 'normal' in s or 'roman' in s
        if is_bold and is_italic:
            return 'bold_italic'
        if is_bold:
            return 'bold'
        if is_italic and not is_bold:
            return 'italic'
        if is_regular:
            return 'normal'
        return None

    for p in candidates:
        kind = classify(p.stem)
        if kind and not weight_map[kind]:
            weight_map[kind] = p

    out = []
    if weight_map['normal']:
        out.append({'weight': 400, 'style': 'normal', 'src': str(weight_map['normal'])})
    if weight_map['italic']:
        out.append({'weight': 400, 'style': 'italic', 'src': str(weight_map['italic'])})
    if weight_map['bold']:
        out.append({'weight': 700, 'style': 'normal', 'src': str(weight_map['bold'])})
    if weight_map['bold_italic']:
        out.append({'weight': 700, 'style': 'italic', 'src': str(weight_map['bold_italic'])})
    return out


def remove_client_artifacts(slug: str) -> None:
    """Delete a user-added client's manifest, thumbs, fonts, and logo."""
    for f in [
        OUT_ROOT / f'manifest-{slug}.js',
        OUT_ROOT / f'manifest-{slug}.json',
    ]:
        if f.exists():
            f.unlink()
    for d in [
        OUT_ROOT / 'thumbs' / slug,
        OUT_ROOT / 'fonts' / slug,
    ]:
        if d.exists():
            shutil.rmtree(d, ignore_errors=True)
    # Delete logo files matching slug.*
    logos_dir = OUT_ROOT / 'logos'
    if logos_dir.exists():
        for logo in logos_dir.glob(f'{slug}.*'):
            logo.unlink()
    # Update clients.js to drop the entry
    clients_js = OUT_ROOT / 'clients.js'
    if clients_js.exists():
        import re
        text = clients_js.read_text()
        m = re.search(r'window\.PORTFOLIO_CLIENTS_LIST\s*=\s*(\[.*\])\s*;?', text, re.DOTALL)
        if m:
            arr = json.loads(m.group(1))
            arr = [c for c in arr if c.get('slug') != slug]
            new_text = (
                'window.PORTFOLIO_CLIENTS_LIST = '
                + json.dumps(arr) + ';\n'
            )
            clients_js.write_text(new_text)


# ---------------------------------------------------------------------------


class Handler(SimpleHTTPRequestHandler):
    def log_message(self, format: str, *args) -> None:  # noqa: A002
        # Quieter logs — only show our API hits
        if '_api' in (args[0] if args else ''):
            super().log_message(format, *args)

    def end_headers(self) -> None:
        # Always send no-store for HTML and JS so Chrome stops serving stale
        # builds during active development. (Thumbnails / images get the
        # default caching, which is fine — they're content-addressed by mtime
        # via the rebuilds.)
        path = urlparse(self.path).path.lower()
        if path.endswith(('.html', '.js', '/')) or path == '':
            self.send_header('Cache-Control', 'no-store, must-revalidate')
            self.send_header('Pragma', 'no-cache')
            self.send_header('Expires', '0')
        # CORS: allow the Electron app (file:// origin) and any other local
        # client to call the API. Server only binds to 0.0.0.0 on this Mac,
        # so this widens reach only within whoever's already on the LAN.
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        super().end_headers()

    def do_OPTIONS(self) -> None:  # noqa: N802
        # CORS preflight — browsers send OPTIONS before POST/DELETE/etc
        # with non-simple headers. Reply 204 + the standard Allow headers.
        self.send_response(204)
        self.end_headers()

    def _json(self, code: int, payload: dict) -> None:
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def _read_body(self) -> dict:
        length = int(self.headers.get('Content-Length', '0'))
        raw = self.rfile.read(length) if length else b''
        if not raw:
            return {}
        try:
            return json.loads(raw.decode('utf-8'))
        except Exception:
            return {}

    # GET --------------------------------------------------------------------

    def do_GET(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        if path == '/_api/info':
            return self._handle_info()
        if path == '/_api/build-status':
            return self._handle_build_status()
        if path.startswith('/_api/clients/'):
            slug = path.rsplit('/', 1)[-1]
            return self._handle_get_client(slug)
        return super().do_GET()

    def _handle_build_status(self) -> None:
        if not PROGRESS_PATH.exists():
            return self._json(200, {})
        try:
            data = json.loads(PROGRESS_PATH.read_text())
        except Exception:
            return self._json(200, {})
        return self._json(200, data)

    def _handle_get_client(self, slug: str) -> None:
        cfg = effective_client_config(slug)
        if not cfg:
            return self._json(404, {'error': f'Unknown client: {slug}'})
        return self._json(200, cfg)

    def _handle_info(self) -> None:
        cfg = load_config()
        user = list(cfg.get('clients', {}).keys())
        return self._json(200, {
            'builtin': sorted(builtin_slugs()),
            'user': sorted(user),
        })

    # POST -------------------------------------------------------------------

    def do_POST(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        if path == '/_api/clients':
            return self._handle_add_client()
        if path == '/_api/build':
            return self._handle_build()
        self._json(404, {'error': 'unknown endpoint'})

    def _handle_add_client(self) -> None:
        body = self._read_body()
        slug = body.get('slug', '')
        builtins = load_builtin_clients()
        cfg = load_config()
        cfg.setdefault('clients', {})
        is_edit = slug in cfg['clients'] or slug in builtins

        ok, err = validate_client_payload(body, is_edit=is_edit)
        if not ok:
            return self._json(400, {'error': err})

        # Build the config entry — blank fields are dropped when editing,
        # so the build script's merge falls back to the built-in default.
        entry = cfg['clients'].get(slug, {}) if is_edit else {}
        entry['name'] = body['name']
        if body.get('projects'):
            entry['projects'] = body['projects']
        if body.get('logo'):
            entry['logo'] = body['logo']
        # Colors merge field-by-field
        new_colors = body.get('colors') or {}
        if new_colors:
            existing_colors = entry.get('colors') or {}
            entry['colors'] = {**existing_colors, **new_colors}

        font_files = []
        if body.get('font_dir'):
            entry['font_dir'] = body['font_dir']
            font_files = autodetect_fonts(Path(body['font_dir']))
            if font_files:
                entry['font_files'] = font_files

        cfg['clients'][slug] = entry
        save_config(cfg)
        kick_build(slug)
        action = 'Updated' if is_edit else 'Added'
        return self._json(200, {
            'ok': True,
            'slug': slug,
            'fonts_found': len(font_files),
            'isEdit': is_edit,
            'message': f'{action} "{body["name"]}". Build kicked off — '
                       f'refresh in a minute or two.',
        })

    def do_DELETE(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        if path != '/_api/clients':
            return self._json(404, {'error': 'unknown endpoint'})
        body = self._read_body()
        slug = body.get('slug')
        if not slug:
            return self._json(400, {'error': 'Missing slug'})
        if slug in builtin_slugs():
            return self._json(403, {'error': 'Cannot delete a built-in client'})
        cfg = load_config()
        if slug not in cfg.get('clients', {}):
            return self._json(404, {'error': f'Client "{slug}" not found'})
        del cfg['clients'][slug]
        save_config(cfg)
        remove_client_artifacts(slug)
        return self._json(200, {'ok': True, 'message': f'Removed "{slug}".'})

    def _handle_build(self) -> None:
        body = self._read_body()
        slug = body.get('slug', 'all')
        kick_build(slug)
        return self._json(200, {'ok': True, 'message': f'Build started for "{slug}".'})


# ---------------------------------------------------------------------------


def main() -> None:
    os.chdir(BOX_ROOT)
    print(f'🌐 Serving {BOX_ROOT}  →  http://{HOST}:{PORT}/')
    print(f'   Portfolio:  http://{HOST}:{PORT}/Alex%20Gordon/portfolio-master/index.html')
    print(f'   API:        /_api/info, /_api/clients, /_api/build')
    print()
    server = HTTPServer((HOST, PORT), Handler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\nbye.')


if __name__ == '__main__':
    main()
