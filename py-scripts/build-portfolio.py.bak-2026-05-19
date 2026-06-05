#!/usr/bin/env python3
"""
Build a multi-client static portfolio. Walks each configured client's
[CLIENT_ROOT]/Projects/**/[YEAR]/[job folders]/ tree and collects every
viewable asset from Release/, WorkingFiles/, VideoExports/, VideoAssets/,
excluding any folder that looks like an OLD/archive folder.

Usage:
  python3 build-portfolio.py                          # default: BGE, current year
  python3 build-portfolio.py --client bge --year 2025
  python3 build-portfolio.py --client pseg --year 2026
  python3 build-portfolio.py --client all --year 2026
  python3 build-portfolio.py --client bge --years all # every year folder found

Outputs (under OUT_ROOT, one shared HTML for all clients):
  index.html
  clients.js              (registry of all clients)
  version.js              (latest build time across clients)
  manifest-bge.js         (per-client manifest, registers on window.PORTFOLIO_CLIENTS)
  manifest-pseg.js
  thumbs/bge/*.jpg
  thumbs/pseg/*.jpg
  logos/bge.png
  logos/pseg.png
"""

from __future__ import annotations
import argparse
import hashlib
import json
import os
import re
import shlex
import subprocess
import sys
import time
import urllib.parse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

# Make sure files we write are world-readable. Alex's shell umask is 0177
# (owner-only), which produces 0600 files that don't sync correctly via Box
# to teammates — they get permission-denied when their app tries to fetch
# clients.js / manifest-*.js via file://. 0o022 → files become 0644.
os.umask(0o022)

# --- config -------------------------------------------------------------

BOX_ROOT = Path('/Users/36981/Library/CloudStorage/Box-Box')
OUT_ROOT = BOX_ROOT / 'Clients' / 'BGE' / 'portfolio-master'

# Build progress is written to a path OUTSIDE Box (avoids syncing dozens
# of writes/second to the cloud). serve-portfolio.py reads from the same
# path to expose progress via the API.
PROGRESS_PATH = Path('/tmp/portfolio-build-progress.json')
# Default scan: a rolling window around the current year. Catches new
# year folders (e.g. 2027 when production starts staging it) and keeps
# recent history (last year) without paying the cost of scanning ancient
# folders Box Drive hasn't materialized.
def _default_years() -> list[int]:
    y = datetime.now().year
    return [y - 1, y, y + 1]
DEFAULT_TARGET_YEARS = _default_years()

# Per-client configuration. Add new clients by extending this dict.
CLIENTS: dict[str, dict] = {
    'bge': {
        'name': 'BGE',
        'projects': BOX_ROOT / 'Clients' / 'BGE' / 'Projects',
        'logo_src': BOX_ROOT / 'Clients' / 'BGE' / 'Assets' / 'Logos'
                    / 'BGE_Exelon_Logo_Endorsement'
                    / 'BGE_Exelon_2025_Registered'
                    / 'bge_logo_hrz_r_wht_rgb.png',
        # Top-level umbrellas in their Projects folder, used for ordering
        'umbrella_order': ['Residential', 'Commercial', 'EVsmart'],
        # Brand colors. All optional. CSS variables set via these:
        #   --umbrella-start / --umbrella-end : top of each umbrella banner
        #   --brand-ink         : sidebar bg
        #   --brand-accent      : active-state highlight (sidebar item, etc)
        #   --brand-button      : primary button bg
        'colors': {
            'umbrella_start': '#170D67',
            'umbrella_end':   '#5431E0',
            'brand_ink':      '#090738',  # ICF deep navy (default sidebar)
            'brand_accent':   '#00E4A5',  # ICF green
            'brand_button':   '#5431E0',  # ICF purple
        },
        'font': {
            'family': 'Diodrum',
            'files': [
                {'weight': 400, 'style': 'normal',
                 'src': BOX_ROOT / 'Clients' / 'BGE' / 'Assets' / 'Fonts'
                        / '~Diodrum_Complete' / 'WEB' / 'fonts'
                        / 'Diodrum-Regular.woff2'},
                {'weight': 400, 'style': 'italic',
                 'src': BOX_ROOT / 'Clients' / 'BGE' / 'Assets' / 'Fonts'
                        / '~Diodrum_Complete' / 'WEB' / 'fonts'
                        / 'Diodrum-RegularItalic.woff2'},
                {'weight': 700, 'style': 'normal',
                 'src': BOX_ROOT / 'Clients' / 'BGE' / 'Assets' / 'Fonts'
                        / '~Diodrum_Complete' / 'WEB' / 'fonts'
                        / 'Diodrum-Bold.woff2'},
                {'weight': 700, 'style': 'italic',
                 'src': BOX_ROOT / 'Clients' / 'BGE' / 'Assets' / 'Fonts'
                        / '~Diodrum_Complete' / 'WEB' / 'fonts'
                        / 'Diodrum-BoldItalic.woff2'},
            ],
        },
    },
    'smeco': {
        'name': 'SMECO',
        'projects': BOX_ROOT / 'Clients' / 'SMECO' / 'Projects',
        'logo_src': BOX_ROOT / 'Clients' / 'SMECO' / 'Assets' / 'Logos'
                    / 'SMECO_logo_rev.png',
        'umbrella_order': [],  # flat program structure
        # Colors from SMECO/EmPOWER Maryland brand guide
        'colors': {
            'umbrella_start': '#185C28',  # SMECO dark green
            'umbrella_end':   '#F0AB00',  # SMECO gold
            'brand_ink':      '#185C28',  # dark green sidebar
            'brand_accent':   '#F0AB00',  # gold highlights
            'brand_button':   '#1F3A5F',  # EmPOWER navy
        },
        'font': {
            'family': 'Gotham',
            'files': [
                {'weight': 400, 'style': 'normal',
                 'src': BOX_ROOT / 'Clients' / 'SMECO' / 'Assets' / 'Font'
                        / 'Gotham-Font' / 'Gotham-Book.otf'},
                {'weight': 400, 'style': 'italic',
                 'src': BOX_ROOT / 'Clients' / 'SMECO' / 'Assets' / 'Font'
                        / 'Gotham-Font' / 'Gotham-BookItalic.otf'},
                {'weight': 700, 'style': 'normal',
                 'src': BOX_ROOT / 'Clients' / 'SMECO' / 'Assets' / 'Font'
                        / 'Gotham-Font' / 'Gotham-Bold.otf'},
                {'weight': 700, 'style': 'italic',
                 'src': BOX_ROOT / 'Clients' / 'SMECO' / 'Assets' / 'Font'
                        / 'Gotham-Font' / 'Gotham-BoldItalic.otf'},
            ],
        },
    },
    'pnm': {
        'name': 'PNM',
        'projects': BOX_ROOT / 'Clients' / 'PNM' / 'Projects',
        'logo_src': BOX_ROOT / 'Clients' / 'PNM' / 'Assets' / 'Logos'
                    / 'PNM-Taglines-KO.png',
        'umbrella_order': [],  # flat — programs auto-discovered from job paths
        # Colors from PNM Brand Evolution Style Guide (June 2025)
        'colors': {
            'umbrella_start': '#0F4F5C',  # Deep PNM teal
            'umbrella_end':   '#F58220',  # PNM orange
            'brand_ink':      '#0F4F5C',  # Teal sidebar
            'brand_accent':   '#F58220',  # Orange highlights
            'brand_button':   '#F58220',
            'brand_em':       '#E8DEC2',  # Cream display italic
        },
        'font': {
            'family': 'Klavika',
            'files': [
                {'weight': 400, 'style': 'normal',
                 'src': BOX_ROOT / 'Clients' / 'PNM' / 'Assets' / 'Fonts'
                        / 'Klavika-Regular.otf'},
                {'weight': 400, 'style': 'italic',
                 'src': BOX_ROOT / 'Clients' / 'PNM' / 'Assets' / 'Fonts'
                        / 'Klavika-RegularItalic.otf'},
                {'weight': 700, 'style': 'normal',
                 'src': BOX_ROOT / 'Clients' / 'PNM' / 'Assets' / 'Fonts'
                        / 'Klavika-Bold.otf'},
                {'weight': 700, 'style': 'italic',
                 'src': BOX_ROOT / 'Clients' / 'PNM' / 'Assets' / 'Fonts'
                        / 'Klavika-BoldItalic.otf'},
            ],
        },
    },
    # Built-in clients above. User-added clients are merged in at runtime
    # from clients-config.json (managed via the Settings panel UI).
    'pseg': {
        'name': 'PSE&G',
        'projects': BOX_ROOT / 'Clients' / 'PSE&G' / 'Projects',
        'logo_src': BOX_ROOT / 'Clients' / 'PSE&G' / 'Assets' / 'Logos'
                    / '_PSE&G_Logos' / '1 Color' / 'PSE&G-logo-rev.png',
        'umbrella_order': [],  # auto-detect alphabetically
        # From PSE&G Web/App Brand Guidelines (Addendum 01, Apr 2025)
        'colors': {
            'umbrella_start': '#142C41',  # Dark Steel Gray
            'umbrella_end':   '#F0512C',  # PSEG Orange
            'brand_ink':      '#F0512C',  # PSEG Orange — full sidebar
            'brand_accent':   '#142C41',  # Dark Steel Gray for active state contrast
            'brand_button':   '#142C41',
        },
        'font': {
            'family': 'Proxima Nova',
            'files': [
                {'weight': 400, 'style': 'normal',
                 'src': BOX_ROOT / 'Clients' / 'PSE&G' / 'Assets'
                        / '_Enterprise_Branding' / '03_PSEG_BrandHub'
                        / '38437_PSEG_Enterprise_Brand_Refresh _Online_Brand_Hub'
                        / 'Fonts' / 'Proxima Nova' / 'Proxima Nova Reg.otf'},
                {'weight': 400, 'style': 'italic',
                 'src': BOX_ROOT / 'Clients' / 'PSE&G' / 'Assets'
                        / '_Enterprise_Branding' / '03_PSEG_BrandHub'
                        / '38437_PSEG_Enterprise_Brand_Refresh _Online_Brand_Hub'
                        / 'Fonts' / 'Proxima Nova' / 'Proxima Nova Reg It.otf'},
                {'weight': 700, 'style': 'normal',
                 'src': BOX_ROOT / 'Clients' / 'PSE&G' / 'Assets'
                        / '_Enterprise_Branding' / '03_PSEG_BrandHub'
                        / '38437_PSEG_Enterprise_Brand_Refresh _Online_Brand_Hub'
                        / 'Fonts' / 'Proxima Nova' / 'Proxima Nova Bold.otf'},
                {'weight': 700, 'style': 'italic',
                 'src': BOX_ROOT / 'Clients' / 'PSE&G' / 'Assets'
                        / '_Enterprise_Branding' / '03_PSEG_BrandHub'
                        / '38437_PSEG_Enterprise_Brand_Refresh _Online_Brand_Hub'
                        / 'Fonts' / 'Proxima Nova' / 'Proxima Nova Bold It.otf'},
            ],
        },
    },
}

# Slugs of built-in clients (above) — these can't be deleted via the API
BUILTIN_SLUGS = set(CLIENTS.keys())


def merge_user_clients() -> None:
    """Read clients-config.json and apply each entry as an override on
    top of the built-in CLIENTS dict (or as a brand-new client if the
    slug isn't built-in). Empty/missing fields in the config preserve
    the built-in default.
    """
    config_path = OUT_ROOT / 'clients-config.json'
    if not config_path.exists():
        return
    try:
        cfg = json.loads(config_path.read_text())
    except Exception as e:
        print(f'⚠️ couldn\'t parse {config_path}: {e}')
        return
    for slug, c in cfg.get('clients', {}).items():
        # Build the overlay shape (paths converted to Path; font assembled)
        overlay: dict = {}
        if c.get('name'):
            overlay['name'] = c['name']
        if c.get('projects'):
            overlay['projects'] = Path(c['projects'])
        if c.get('logo'):
            overlay['logo_src'] = Path(c['logo'])
        if c.get('umbrella_order'):
            overlay['umbrella_order'] = c['umbrella_order']

        font_files = c.get('font_files') or []
        if font_files:
            overlay['font'] = {
                'family': c.get('font_family') or _guess_family_from_files(font_files),
                'files': [
                    {'weight': f['weight'], 'style': f['style'], 'src': Path(f['src'])}
                    for f in font_files
                ],
            }

        if slug in CLIENTS:
            # Override on top of built-in. Colors merge field-by-field so
            # a user changing one color doesn't blow away the rest.
            base = dict(CLIENTS[slug])
            base.update({k: v for k, v in overlay.items() if k != 'colors'})
            new_colors = c.get('colors') or {}
            if new_colors:
                base['colors'] = {**(base.get('colors') or {}), **new_colors}
            CLIENTS[slug] = base
            print(f'  ↳ override applied to built-in "{slug}"')
        else:
            # Brand new user-added client — must have all required fields
            if 'projects' not in overlay or 'logo_src' not in overlay or 'name' not in overlay:
                print(f'⚠️ "{slug}" missing required fields, skipping')
                continue
            CLIENTS[slug] = {
                'name': overlay['name'],
                'projects': overlay['projects'],
                'logo_src': overlay['logo_src'],
                'umbrella_order': overlay.get('umbrella_order', []),
                'colors': c.get('colors') or {},
                'font': overlay.get('font'),
            }


def _guess_family_from_files(font_files: list[dict]) -> str:
    """Best-effort: pull the family name from the first font filename."""
    if not font_files:
        return 'Sans'
    stem = Path(font_files[0]['src']).stem
    # Strip common weight/style suffixes
    for suf in ('-Regular', '-Bold', '-Italic', '_Regular', '_Bold', ' Regular', ' Bold'):
        if stem.endswith(suf):
            return stem[:-len(suf)]
    parts = stem.replace('_', '-').split('-')
    return parts[0] if parts else stem


MAX_WALK_DEPTH = 8
SKIP_FOLDERS = {
    'Assets', 'EditorUseOnly', 'Reference', 'WorkingFiles',
    'Copy', 'RequestedRevisions', 'VideoAssets', 'VideoExports', 'Archive',
}
ASSET_EXTS = {
    # Static / video
    'jpg', 'jpeg', 'png', 'gif', 'webp', 'pdf', 'mp4', 'mov', 'm4v',
    # Office release deliverables (Word, Excel, PowerPoint — old + new format)
    'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
}
SKIP_EXTS = {'zip', 'rtf'}
OFFICE_EXTS = {'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx'}

JOB_PREFIX_RE = re.compile(r'^(\d{3,6})[\s_\-]')
RELEASE_SUFFIX_RE = re.compile(r'(?:^|[_\s\-])release$', re.IGNORECASE)


def is_release_file(filename: str) -> bool:
    """True if the filename's stem ends with '_RELEASE' / ' Release' / etc."""
    stem = filename.rsplit('.', 1)[0] if '.' in filename else filename
    return bool(RELEASE_SUFFIX_RE.search(stem))

# --- helpers ------------------------------------------------------------


def is_skip_folder(name: str) -> bool:
    n = name.strip().lower()
    if name.startswith('.') or name.startswith('_'):
        return True
    if n == 'release':
        return True
    if is_old_folder(name):
        return True
    return any(n == s.lower() for s in SKIP_FOLDERS)


def find_year_folders(root: Path, target_years: Optional[set[int]]):
    """Recursively find all folders named like a year. If target_years is
    given, only return matches in that set; if None, return every year
    folder found (2000–2100 sanity range)."""
    results: list[tuple[Path, list[str], int]] = []  # (year_dir, programPath, year)

    def walk(p: Path, program_path: list[str], depth: int):
        if depth > MAX_WALK_DEPTH:
            return
        try:
            entries = list(p.iterdir())
        except (OSError, PermissionError):
            return
        for e in entries:
            if not e.is_dir():
                continue
            name = e.name
            if re.fullmatch(r'\d{4}', name):
                year = int(name)
                if 2000 <= year <= 2100:
                    if target_years is None or year in target_years:
                        results.append((e, program_path[:], year))
                continue
            if is_skip_folder(name):
                continue
            if JOB_PREFIX_RE.match(name):
                continue
            walk(e, program_path + [name], depth + 1)

    walk(root, [], 0)
    return results


def find_jobs_below(year_dir: Path, max_depth: int = 4) -> list[tuple[Path, list[str]]]:
    """Recursively find every job folder beneath a year folder.

    BGE: year/[job folder]              (depth 0 — direct children)
    PSE&G: year/sub-program/[job folder] (depth 1 — one level deeper)

    Returns (job_dir, extra_program_path) where extra_program_path is the
    list of folder names between the year folder and the job folder.
    """
    out: list[tuple[Path, list[str]]] = []

    def walk(p: Path, sub_path: list[str], depth: int):
        if depth > max_depth:
            return
        try:
            children = list(p.iterdir())
        except (OSError, PermissionError):
            return
        for e in children:
            if not e.is_dir():
                continue
            name = e.name
            if name.startswith('.') or name.startswith('_'):
                continue
            if is_old_folder(name):
                continue
            if JOB_PREFIX_RE.match(name):
                # Don't recurse into job folders — sub-jobs (58993-A, 58993-B)
                # are merged INTO the parent's assets by collect_job_release_assets,
                # so the parent appears as a single tile under the correct program.
                out.append((e, sub_path[:]))
            else:
                walk(e, sub_path + [name], depth + 1)

    walk(year_dir, [], 0)
    return out


BRAND_GUIDE_EXTS = {'pdf', 'docx', 'pptx', 'doc', 'ppt'}


def find_brand_guides(projects_dir: Path) -> list[dict]:
    """Look in [client]/Assets/BrandGuidelines/ for brand guide docs.
    Recursive one level to also pull from sub-folders (e.g. PSE&G has
    Multicultural Research/, WorryFree/, etc.). Skips z_old/_OLD."""
    # Derive Assets path from Projects path
    assets_dir = projects_dir.parent / 'Assets' / 'BrandGuidelines'
    if not assets_dir.is_dir():
        return []
    out: list[tuple[Path, list[str]]] = []  # (path, sub-folder hint)
    try:
        # Top level
        for f in assets_dir.iterdir():
            if f.is_file() and _is_brand_guide_file(f):
                out.append((f, []))
            elif f.is_dir() and not is_old_folder(f.name):
                # One level deep for sub-folders (style guide / multicultural / etc.)
                try:
                    for ff in f.iterdir():
                        if ff.is_file() and _is_brand_guide_file(ff):
                            out.append((ff, [f.name]))
                except (OSError, PermissionError):
                    continue
    except (OSError, PermissionError):
        return []
    out.sort(key=lambda x: (x[1], x[0].name.lower()))
    return [
        {
            'name': _prettify_guide_name(p, sub),
            'href': str(p),  # absolute path; converted to relative by build
        }
        for p, sub in out
    ]


def _is_brand_guide_file(p: Path) -> bool:
    ext = p.suffix.lower().lstrip('.')
    if ext not in BRAND_GUIDE_EXTS:
        return False
    if p.name.startswith('.') or p.name.startswith('~'):
        return False
    return True


def _prettify_guide_name(p: Path, sub: list[str]) -> str:
    stem = p.stem.strip('_').strip()
    # Strip the leading "###_" job-style prefix if present
    stem = re.sub(r'^\d{3,6}[_\s\-]', '', stem)
    # Replace underscores with spaces
    stem = stem.replace('_', ' ')
    # Collapse multiple spaces
    stem = re.sub(r'\s+', ' ', stem)
    if sub:
        return f'{stem}  ·  {sub[-1].replace("_", " ")}'
    return stem


_OLD_TOKEN_RE = re.compile(
    r'(^|[_\s\-])(old|olds|archive|archived|deprecated|legacy)([_\s\-]|$)',
    re.IGNORECASE,
)


def is_old_folder(name: str) -> bool:
    """True if a folder name marks it as archived/old work we should skip.

    Catches: 'OLD', '_OLD', 'z_old', 'zz_old', 'zold', 'Z_Old_Programs',
    '_OLD_', 'Old Files', 'Archive', 'archived', 'deprecated', 'legacy', etc.
    Does NOT match 'older', 'holder', 'holdings' (avoids false positives).
    """
    n = name.strip()
    if not n:
        return False
    if _OLD_TOKEN_RE.search(n):
        return True
    lo = n.lower()
    if lo.startswith('zold') or lo == 'z' or lo == 'zz':
        return True
    return False


def _filter_release_named(files: list[Path]) -> list[Path]:
    """Keep only files whose stem contains 'release' (case-insensitive).
    Used for folders like Copy/ that mix drafts with final release files —
    we want only the explicitly-marked release deliverables.
    """
    return [f for f in files if 'release' in f.stem.lower()]


def collect_assets_recursive(
    root: Path, max_depth: int = 8, depth: int = 0
) -> list[Path]:
    """Walk root recursively collecting valid asset files. Skips:
       - hidden / underscore folders (except things that look like job/year)
       - any folder whose name matches OLD pattern
       - files with non-asset extensions (working files, zips, etc.)
    """
    out: list[Path] = []
    if depth > max_depth:
        return out
    try:
        entries = list(root.iterdir())
    except (OSError, PermissionError):
        return out

    for e in entries:
        if e.is_dir():
            if is_old_folder(e.name):
                continue
            if e.name.startswith('.'):
                continue
            out.extend(collect_assets_recursive(e, max_depth, depth + 1))
        elif e.is_file():
            if e.name.startswith('.'):
                continue
            ext = e.suffix.lower().lstrip('.')
            if ext in SKIP_EXTS:
                continue
            if ext not in ASSET_EXTS:
                continue
            out.append(e)
    return out


# Subfolders inside WorkingFiles to recurse into. Split into two groups:
# - DEDICATED: explicit release folders — every file is included
# - MIXED: generic export/output folders — only files with "RELEASE" in
#          the name are included (these dirs often contain working files
#          mixed with final exports)
WORKING_DEDICATED_RELEASE = {'release', 'releases', 'final', 'finals'}
WORKING_MIXED_EXPORTS = {'exports', 'export', 'output', 'outputs'}
WORKING_RELEASE_SUBFOLDERS = WORKING_DEDICATED_RELEASE | WORKING_MIXED_EXPORTS | {'html'}


def collect_release_pdfs_recursive(
    root: Path, max_depth: int = 6, depth: int = 0
) -> list[Path]:
    """Like collect_assets_recursive but RELEASE-named PDFs only. Used for
    email/html folders where we only want the final rendered email PDF
    (not the dozens of fragment PNGs / per-section assets)."""
    out: list[Path] = []
    if depth > max_depth:
        return out
    try:
        entries = list(root.iterdir())
    except (OSError, PermissionError):
        return out
    for e in entries:
        if e.is_dir():
            if is_old_folder(e.name) or e.name.startswith('.'):
                continue
            out.extend(collect_release_pdfs_recursive(e, max_depth, depth + 1))
        elif e.is_file():
            if e.name.startswith('.'):
                continue
            if e.suffix.lower() != '.pdf':
                continue
            if 'release' not in e.stem.lower():
                continue
            out.append(e)
    return out


def list_assets_flat(d: Path) -> list[Path]:
    """Just the asset files at the top level of d — no recursion."""
    out = []
    try:
        for f in d.iterdir():
            if not f.is_file():
                continue
            if f.name.startswith('.'):
                continue
            ext = f.suffix.lower().lstrip('.')
            if ext in SKIP_EXTS or ext not in ASSET_EXTS:
                continue
            out.append(f)
    except (OSError, PermissionError):
        pass
    return out


def collect_job_release_assets(job_dir: Path) -> list[Path]:
    """All viewable assets for a job. Looks in:
       - [job]/Release/               (recursive)
       - [job]/Copy/                  (recursive — copywriter deliverables)
       - [job]/WorkingFiles/Release/  (recursive)
       - [job]/WorkingFiles/html/     (recursive — email mockups)
       - [job]/WorkingFiles/Exports/  (recursive)
       - [job]/VideoExports/Release/  (recursive)
       - [job]/VideoAssets/Release/   (recursive)
    Anything in OLD folders is excluded.
    Other folders inside WorkingFiles (raw working files, scratch) are
    NOT scanned — keeps the build fast on Box Drive.
    """
    found: list[Path] = []
    try:
        children = list(job_dir.iterdir())
    except (OSError, PermissionError):
        return found

    # Track Copy/ separately so we can dedupe AGAINST WorkingFiles — when
    # the same filename exists in both, WorkingFiles wins (Copy/ is treated
    # as a fallback source, e.g. when WorkingFiles version is missing).
    copy_found: list[Path] = []

    for child in children:
        if not child.is_dir():
            continue
        n = child.name.strip().lower()
        if is_old_folder(child.name):
            continue
        if n == 'release':
            found.extend(collect_assets_recursive(child))
        elif n == 'copy':
            # Copy/ folders contain copywriter drafts (v2.docx, v3.docx, etc.)
            # plus the final release-marked file. We ONLY include files whose
            # name contains "RELEASE" (case-insensitive) — and skip any
            # filename that's already present from WorkingFiles below.
            copy_found.extend(_filter_release_named(collect_assets_recursive(child)))
        elif n in ('workingfiles', 'videoexports', 'videoassets'):
            # Look one level deeper for release-style subfolders AND for
            # RELEASE-marked files that live directly in WorkingFiles.
            try:
                grandchildren = list(child.iterdir())
            except (OSError, PermissionError):
                continue
            for grand in grandchildren:
                if grand.is_file():
                    # File at the root of WorkingFiles — accept only if its
                    # filename has RELEASE in it (case-insensitive).
                    if grand.name.startswith('.'):
                        continue
                    ext = grand.suffix.lower().lstrip('.')
                    if ext in SKIP_EXTS or ext not in ASSET_EXTS:
                        continue
                    if 'release' not in grand.stem.lower():
                        continue
                    found.append(grand)
                    continue
                if not grand.is_dir():
                    continue
                gn = grand.name.strip().lower()
                if is_old_folder(grand.name):
                    continue
                if gn == 'html':
                    # Only the final email PDF, not all the fragment PNGs
                    found.extend(collect_release_pdfs_recursive(grand))
                elif gn in WORKING_DEDICATED_RELEASE:
                    # release/, releases/, final/, finals/ — every file is
                    # implicitly the released version
                    found.extend(collect_assets_recursive(grand))
                elif gn in WORKING_MIXED_EXPORTS:
                    # exports/, output/ etc. often mix working files with
                    # release-marked final exports. Filter to RELEASE-named
                    # files only (same convention as Copy/).
                    found.extend(_filter_release_named(
                        collect_assets_recursive(grand)
                    ))

    # Merge Copy/ files in — but skip any filename already covered by
    # WorkingFiles/Release/. WorkingFiles wins on filename conflicts because
    # production treats it as the authoritative source.
    existing_names = {p.name.lower() for p in found}
    for p in copy_found:
        if p.name.lower() not in existing_names:
            found.append(p)
            existing_names.add(p.name.lower())

    # If parent has no direct assets, this might be a "bundle" job whose
    # actual deliverables live in sub-job folders (e.g., 58993-A_Email,
    # 58993-B_Direct Mail). Merge their assets into the parent so the
    # bundle appears as ONE tile under the correct program.
    if not found:
        for child in children:
            if not child.is_dir():
                continue
            if is_old_folder(child.name):
                continue
            if not JOB_PREFIX_RE.match(child.name):
                continue
            # Recurse one level into the sub-job to grab its release assets
            found.extend(_collect_subjob_assets(child))

    # De-dupe by absolute path first (same file path appearing twice from
    # different scan paths), then by filename (same filename from different
    # folders). On filename conflict, keep the first occurrence — which by
    # our scan order is the WorkingFiles version.
    seen_paths = set()
    seen_names: set[str] = set()
    deduped = []
    for p in sorted(found, key=lambda x: x.name.lower()):
        path_key = str(p)
        name_key = p.name.lower()
        if path_key in seen_paths:
            continue
        if name_key in seen_names:
            continue
        seen_paths.add(path_key)
        seen_names.add(name_key)
        deduped.append(p)
    return deduped


def _collect_subjob_assets(job_dir: Path) -> list[Path]:
    """Same scan as collect_job_release_assets, but without the bundle
    fallback — used to grab a sub-job's assets to merge into the parent."""
    found: list[Path] = []
    try:
        children = list(job_dir.iterdir())
    except (OSError, PermissionError):
        return found
    for child in children:
        if not child.is_dir():
            continue
        n = child.name.strip().lower()
        if is_old_folder(child.name):
            continue
        if n == 'release':
            found.extend(collect_assets_recursive(child))
        elif n in ('workingfiles', 'videoexports', 'videoassets'):
            try:
                grandchildren = list(child.iterdir())
            except (OSError, PermissionError):
                continue
            for grand in grandchildren:
                if grand.is_file():
                    if grand.name.startswith('.'):
                        continue
                    ext = grand.suffix.lower().lstrip('.')
                    if ext in SKIP_EXTS or ext not in ASSET_EXTS:
                        continue
                    if 'release' not in grand.stem.lower():
                        continue
                    found.append(grand)
                    continue
                if not grand.is_dir():
                    continue
                gn = grand.name.strip().lower()
                if is_old_folder(grand.name):
                    continue
                if gn == 'html':
                    found.extend(collect_release_pdfs_recursive(grand))
                elif gn in WORKING_DEDICATED_RELEASE:
                    found.extend(collect_assets_recursive(grand))
                elif gn in WORKING_MIXED_EXPORTS:
                    found.extend(_filter_release_named(
                        collect_assets_recursive(grand)
                    ))
    return found


def find_release_signal_paths(job_dir: Path) -> list[Path]:
    """The folders we use to derive the 'release date' (mtime) for a job.
    Same set as collect_job_release_assets walks, top-level only."""
    out: list[Path] = []
    try:
        for child in job_dir.iterdir():
            if not child.is_dir():
                continue
            if is_old_folder(child.name):
                continue
            n = child.name.strip().lower()
            if n in ('release', 'workingfiles', 'videoexports', 'videoassets'):
                out.append(child)
    except (OSError, PermissionError):
        pass
    return out


def make_thumb(src: Path, dst: Path, ext: str) -> bool:
    # Skip if thumb already exists AND is at least as new as the source.
    # If the source was updated in-place (Box overwrites file), the source
    # mtime will be newer than the thumb mtime, and we regenerate.
    if dst.exists():
        try:
            if dst.stat().st_mtime >= src.stat().st_mtime:
                return True
        except OSError:
            pass
        # Source is newer — delete and regenerate.
        try:
            dst.unlink()
        except OSError:
            pass
    dst.parent.mkdir(parents=True, exist_ok=True)
    try:
        if ext in ('jpg', 'jpeg', 'png', 'gif', 'webp', 'pdf'):
            subprocess.run(
                ['sips', '-s', 'format', 'jpeg', '-Z', '800',
                 str(src), '--out', str(dst)],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                check=False,
                timeout=60,
            )
        elif ext in ('mp4', 'mov', 'm4v'):
            subprocess.run(
                ['ffmpeg', '-y', '-i', str(src), '-ss', '00:00:01',
                 '-vframes', '1', '-vf', 'scale=800:-1', str(dst)],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                check=False,
                timeout=60,
            )
        elif ext in OFFICE_EXTS:
            # macOS QuickLook generates a thumbnail for Office files.
            # qlmanage writes "<src.name>.png" into -o output dir.
            tmpdir = dst.parent / '.qltmp'
            tmpdir.mkdir(exist_ok=True)
            subprocess.run(
                ['qlmanage', '-t', '-s', '800', '-o', str(tmpdir), str(src)],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                check=False,
                timeout=120,
            )
            generated = tmpdir / (src.name + '.png')
            if generated.exists():
                # Convert PNG → JPG so all thumbs share extension
                subprocess.run(
                    ['sips', '-s', 'format', 'jpeg', str(generated),
                     '--out', str(dst)],
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                    check=False, timeout=30,
                )
                generated.unlink(missing_ok=True)
            # Clean up tmpdir if empty
            try:
                if tmpdir.exists() and not any(tmpdir.iterdir()):
                    tmpdir.rmdir()
            except OSError:
                pass
    except subprocess.TimeoutExpired:
        return False
    except Exception:
        return False
    return dst.exists()


def file_url(p: Path) -> str:
    quoted = urllib.parse.quote(str(p), safe='/')
    return 'file://' + quoted


def relative_url(asset_path: Path, out_dir: Path) -> str:
    """Relative path from out_dir to asset_path, URL-encoded.
    Lets the portfolio open the original file regardless of which user's
    Mac is viewing the page (as long as the relative folder layout matches)."""
    rel = os.path.relpath(asset_path, out_dir)
    return urllib.parse.quote(rel, safe='/')


# Category detection: maps a category label to keywords (substrings, lowercase)
# that signal a job/asset belongs to that creative type. A job can match
# multiple categories. Order matters — the FIRST matching category in a list
# wins for tie-breaks, so order from most specific to most generic.
# Keywords are matched as word-ish substrings on a normalized form of the
# combined campaign name + asset filenames.
CATEGORY_KEYWORDS: list[tuple[str, tuple[str, ...]]] = [
    ('Email', ('email', 'edm', 'enewsletter', 'e-newsletter', 'e newsletter')),
    ('Postcard / Direct Mail', ('postcard', 'pstcrd', 'direct mail', 'directmail')),
    ('Doorhanger', ('doorhanger', 'door hanger', 'door-hanger', 'doortag')),
    ('Billboard / OOH', ('billboard', 'dooh', 'ooh', 'cinema')),
    ('Print Ad', ('newspaper', 'magazine', 'print ad', 'printad', 'print-ad')),
    ('Banner / Display Ad', (
        'banner', 'banners', 'display ad', 'displayad', 'naics',
        'mobile banner', 'inapp', 'in-app', 'in app', 'rich media',
        'native dsply', 'native display',
    )),
    ('Social Media', (
        'facebook', ' fb ', '_fb_', '-fb-', 'instagram', ' ig ', '_ig_', '-ig-',
        'reddit', 'linkedin', 'tiktok', 'tik tok', 'tik-tok',
        'twitter', 'meta ', 'paid social', 'paidsocial', 'social media',
    )),
    ('Video / TV / CTV', (
        'video', ' ctv', '_ctv', '-ctv', 'tv spot', 'tvspot',
        'ott', 'youtube', 'yt ', '_yt_', 'broadcast tv',
    )),
    ('Photography', ('photography', ' photo ', '_photo_', '-photo-', 'imagery', 'stills', 'lifestyle shoot')),
    ('Factsheet / Flyer', ('factsheet', 'fact sheet', 'fact-sheet', 'flyer', 'brochure', 'leave behind', 'leave-behind')),
    ('POP', ('point of purchase', 'in-store', 'in store', 'pop display', 'retail display', ' pop ', '_pop_', '-pop-')),
    ('Landing Page', ('landing page', 'landingpage', 'landing-page', 'microsite', ' lp ', '_lp_', '-lp-')),
    ('Radio / Audio', ('radio', 'spotify', 'pandora', 'audio spot', 'audiospot')),
    ('Paid Search', ('paid search', 'paidsearch', ' sem ', '_sem_', '-sem-', 'google search', 'ppc')),
]


def _category_haystack(*parts: str) -> str:
    """Build a lowercased, space-padded haystack that's easy to do substring
    keyword matching against. Underscores and hyphens are normalized to
    spaces so keywords match either form."""
    text = ' '.join(p for p in parts if p).lower()
    text = text.replace('_', ' ').replace('-', ' ')
    return f' {text} '


def _match_categories(haystack: str) -> list[str]:
    matched: list[str] = []
    for label, kws in CATEGORY_KEYWORDS:
        for kw in kws:
            if kw.lower() in haystack:
                matched.append(label)
                break
    return matched


def categorize_asset(asset_name: str, folder_name: str) -> list[str]:
    """Categorize a single asset by its filename, with the job folder name
    as fallback context. Asset filename wins — if it says "Email" we trust
    that, regardless of where the file lives. If the filename has no
    category keywords, we fall back to the folder name so generic-named
    files in an obviously-emails folder still get tagged."""
    asset_cats = _match_categories(_category_haystack(asset_name))
    if asset_cats:
        return asset_cats
    return _match_categories(_category_haystack(folder_name))


def categorize_job(folder_name: str, campaign: str, asset_names: list[str]) -> list[str]:
    """Return the list of creative categories that match this job. We OR
    together: any keyword in the folder name, campaign, or any asset name
    counts. Powers the "BY TYPE" filter in the sidebar."""
    hay = _category_haystack(folder_name, campaign, *asset_names)
    return _match_categories(hay)


def parse_job_folder(folder_name: str):
    m = JOB_PREFIX_RE.match(folder_name)
    if not m:
        return None
    job_num = m.group(1)
    rest = folder_name[len(m.group(0)):]
    campaign = re.sub(r'[\s_]+', ' ', rest).strip()
    return job_num, campaign


# --- main ---------------------------------------------------------------


def parse_args():
    p = argparse.ArgumentParser(description='Build a static portfolio')
    p.add_argument('--client', default='bge',
                   help=f"Client slug to build. One of: "
                        f"{', '.join(CLIENTS)}, or 'all' for every client.")
    p.add_argument('--force', action='store_true',
                   help='Bypass the 90-second debounce that prevents '
                        'back-to-back rebuilds. Use after manual edits.')
    g = p.add_mutually_exclusive_group()
    g.add_argument('--year', type=int, action='append',
                   help='Year to scan (repeatable). Default: current year.')
    g.add_argument('--years', nargs='+',
                   help="Multiple years (e.g. '--years 2024 2025 2026'), "
                        "or 'all' to scan every year folder found.")
    return p.parse_args()


def resolve_target_years(args) -> Optional[set[int]]:
    if args.year:
        return set(args.year)
    if args.years:
        if len(args.years) == 1 and args.years[0].lower() == 'all':
            return None
        try:
            return {int(y) for y in args.years}
        except ValueError:
            print(f'Invalid --years value: {args.years}', file=sys.stderr)
            sys.exit(2)
    return set(DEFAULT_TARGET_YEARS)


_progress_lock = threading.Lock() if (threading := __import__('threading')) else None


def write_progress(slug: str, **fields) -> None:
    """Atomically write per-client progress to PROGRESS_PATH. Other
    clients' progress entries are preserved."""
    try:
        with _progress_lock:
            existing = {}
            if PROGRESS_PATH.exists():
                try:
                    existing = json.loads(PROGRESS_PATH.read_text())
                except Exception:
                    existing = {}
            existing[slug] = {
                **existing.get(slug, {}),
                **fields,
                'updatedAt': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
            }
            tmp = PROGRESS_PATH.with_suffix('.json.tmp')
            tmp.write_text(json.dumps(existing))
            tmp.replace(PROGRESS_PATH)
    except Exception:
        pass  # progress is best-effort; never block the build


def build_for_client(slug: str, cfg: dict, target_years: Optional[set[int]]):
    out_root = OUT_ROOT
    thumbs_root = out_root / 'thumbs' / slug
    logos_dir = out_root / 'logos'
    fonts_dir = out_root / 'fonts' / slug
    out_root.mkdir(parents=True, exist_ok=True)
    thumbs_root.mkdir(parents=True, exist_ok=True)
    logos_dir.mkdir(parents=True, exist_ok=True)
    fonts_dir.mkdir(parents=True, exist_ok=True)

    label = (
        'every year' if target_years is None
        else ', '.join(str(y) for y in sorted(target_years))
    )
    write_progress(slug, name=cfg['name'], status='scanning',
                   phase='Walking year folders…', progress=0, total=0,
                   startedAt=datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'))
    print(f'\n=== {cfg["name"]} ({slug}) — {label} ===')
    print(f'Walking {cfg["projects"]}…')
    year_folders = find_year_folders(cfg['projects'], target_years)
    print(f'Found {len(year_folders)} year folders')
    write_progress(slug, phase=f'Found {len(year_folders)} year folders, walking jobs…')

    jobs_out = []
    thumb_tasks: list[tuple[Path, Path, str]] = []

    # Copy the client logo into the portfolio (so it's portable)
    import shutil
    logo_rel = None
    src_logo = cfg.get('logo_src')
    if src_logo and src_logo.exists():
        ext = src_logo.suffix.lower()
        dst_logo = logos_dir / f'{slug}{ext}'
        try:
            shutil.copy2(src_logo, dst_logo)
            logo_rel = f'logos/{dst_logo.name}'
        except Exception as ex:
            print(f'  ⚠️ logo copy failed: {ex}')

    # Copy font files into fonts/{slug}/ (so the portfolio is portable)
    font_info = None
    font_cfg = cfg.get('font')
    if font_cfg and font_cfg.get('files'):
        ext_to_format = {
            '.woff2': 'woff2', '.woff': 'woff',
            '.ttf': 'truetype', '.otf': 'opentype',
        }
        faces = []
        for f in font_cfg['files']:
            src = f['src']
            if not src.exists():
                print(f'  ⚠️ font missing: {src}')
                continue
            # Sanitize destination name (strip spaces, keep weight/style hint)
            stem = src.stem.replace(' ', '_').replace('&', 'and')
            dst = fonts_dir / f'{stem}{src.suffix.lower()}'
            try:
                shutil.copy2(src, dst)
            except Exception as ex:
                print(f'  ⚠️ font copy failed: {ex}')
                continue
            faces.append({
                'weight': f['weight'],
                'style': f['style'],
                'src': f'fonts/{slug}/{dst.name}',
                'format': ext_to_format.get(src.suffix.lower(), 'opentype'),
            })
        if faces:
            font_info = {'family': font_cfg['family'], 'faces': faces}

    for year_dir, program_path, year_int in year_folders:
        # Walk inside the year folder to find all job folders.
        # PSE&G nests further (year/sub-program/job) so a flat iter isn't enough.
        nested_jobs = find_jobs_below(year_dir, max_depth=4)
        for job_dir, extra_program_path in nested_jobs:
            parsed = parse_job_folder(job_dir.name)
            if not parsed:
                continue
            job_num, campaign = parsed
            # Combine the program path above the year folder with any extra
            # program nesting between the year folder and the job folder.
            full_program_path = program_path + extra_program_path

            assets = collect_job_release_assets(job_dir)
            release_dirs = find_release_signal_paths(job_dir)
            if not assets:
                continue

            asset_entries = []
            max_mtime = 0.0
            for rd in release_dirs:
                try:
                    rd_st = rd.stat()
                    cand = max(rd_st.st_mtime, getattr(rd_st, 'st_birthtime', 0))
                    if cand > max_mtime:
                        max_mtime = cand
                except OSError:
                    pass
            for i, asset_path in enumerate(assets):
                st = asset_path.stat()
                mtime = max(st.st_mtime, getattr(st, 'st_birthtime', 0))
                if mtime > max_mtime:
                    max_mtime = mtime
                ext = asset_path.suffix.lower().lstrip('.')
                # Content-addressed thumb name: hash of the asset's relative
                # path. Each unique asset gets its OWN thumb file, so reorder
                # or file replacement never causes "thumb shows wrong
                # content" bugs (which happened with the previous
                # index-based naming like {job_num}_{i}.jpg). Orphan thumbs
                # from removed/renamed assets are pruned later (see thumb
                # cleanup pass).
                rel_for_hash = str(asset_path).encode('utf-8', errors='replace')
                asset_hash = hashlib.md5(rel_for_hash).hexdigest()[:10]
                thumb_name = f'{job_num}_{asset_hash}.jpg'
                thumb_path = thumbs_root / thumb_name
                thumb_tasks.append((asset_path, thumb_path, ext))
                # Cache-bust by asset mtime — if the underlying file gets
                # replaced (Box updates), the URL changes and browser refetches.
                ver = int(mtime)
                asset_cats = categorize_asset(asset_path.name, job_dir.name)
                asset_entries.append({
                    'name': asset_path.name,
                    'kind': ext,
                    'thumb': f'thumbs/{slug}/{thumb_name}?v={ver}',
                    'href': relative_url(asset_path, out_root),
                    'categories': asset_cats,
                })

            release_dt = datetime.fromtimestamp(max_mtime, tz=timezone.utc)
            # Clamp future dates. File mtimes occasionally drift forward (clock
            # weirdness, Box re-sync metadata writes) and producing a "Dec 2026"
            # bucket in May 2026 is confusing — it shouldn't be possible to have
            # release dates in the future.
            now_utc = datetime.now(tz=timezone.utc)
            if release_dt > now_utc:
                release_dt = now_utc
            program_label = ' / '.join(full_program_path).replace('_', ' ')
            # Job-level categories = union of per-asset categories (the
            # sidebar's "BY TYPE" count needs job-level info). Per-asset
            # categories are already set above and let the frontend filter
            # down to just the matching assets when a type is selected.
            seen_cats: set[str] = set()
            categories: list[str] = []
            for a in asset_entries:
                for c in a.get('categories', []):
                    if c not in seen_cats:
                        seen_cats.add(c)
                        categories.append(c)
            # Also include any job-level keyword matches (folder/campaign
            # name) so a job named "Email_Bundle" still tags as Email even
            # if individual asset filenames don't say "Email".
            for c in categorize_job(job_dir.name, campaign, []):
                if c not in seen_cats:
                    seen_cats.add(c)
                    categories.append(c)
            jobs_out.append({
                'id': slug + '/' + '/'.join(full_program_path) + '/' + str(year_int) + '/' + job_dir.name,
                'jobNumber': job_num,
                'folderName': job_dir.name,
                'campaign': campaign,
                'programPath': full_program_path,
                'programLabel': program_label,
                # Use release_dt for BOTH year and month so they're coherent.
                # Previously we used the folder year (year_int) here, but file
                # mtimes can land in a different year than the folder label
                # (e.g., a 2026 campaign folder created in late 2025). Mixing
                # folder-year with mtime-month produced ghost buckets like
                # "Dec 2026" for jobs actually worked on in Dec 2025.
                # `folderYear` is kept separately for anyone who needs the
                # campaign-year label, but UI grouping uses year+month.
                'year': release_dt.year,
                'month': release_dt.month,
                'folderYear': year_int,
                'releaseDate': release_dt.strftime('%Y-%m-%dT%H:%M:%SZ'),
                'categories': categories,
                'assets': asset_entries,
            })

    total_thumbs = len(thumb_tasks)
    print(f'  Collected {len(jobs_out)} jobs · generating {total_thumbs} thumbnails…')
    write_progress(slug, status='thumbnailing',
                   phase=f'Generating {total_thumbs} thumbnails',
                   progress=0, total=total_thumbs,
                   jobsFound=len(jobs_out))

    with ThreadPoolExecutor(max_workers=6) as pool:
        futures = [pool.submit(make_thumb, s, d, e) for s, d, e in thumb_tasks]
        done = 0
        for f in futures:
            f.result()
            done += 1
            # Update progress every 5 thumbs to keep file writes manageable
            if done % 5 == 0 or done == total_thumbs:
                write_progress(slug, progress=done, total=total_thumbs)
            if done % 50 == 0:
                print(f'    thumbs: {done}/{total_thumbs}')

    # Prune orphan thumbs: any .jpg in thumbs_root not referenced by the
    # current build's manifest is from a removed/renamed asset and can go.
    # Important because we just migrated from index-based ({job_num}_0.jpg)
    # to hash-based ({job_num}_{hash}.jpg) naming — without this, the old
    # index-named files would persist forever.
    referenced = {d.name for _, d, _ in thumb_tasks}
    if thumbs_root.exists():
        pruned = 0
        for f in thumbs_root.iterdir():
            if f.is_file() and f.suffix.lower() == '.jpg' and f.name not in referenced:
                try:
                    f.unlink()
                    pruned += 1
                except OSError:
                    pass
        if pruned:
            print(f'  Pruned {pruned} orphan thumbnail(s)')

    for job in jobs_out:
        for a in job['assets']:
            # Strip any cache-bust query (`?v=...`) before the filesystem check.
            thumb_path_only = a['thumb'].split('?', 1)[0]
            tp = out_root / thumb_path_only
            if not tp.exists():
                a['thumb'] = ''

    jobs_out.sort(
        key=lambda j: (j['programLabel'], -j['year'], -j['month'], j['jobNumber'])
    )

    build_time = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    years_in_data = sorted({j['year'] for j in jobs_out})

    # Auto-discover brand guides in [client]/Assets/BrandGuidelines/
    brand_guides_raw = find_brand_guides(cfg['projects'])
    brand_guides = [
        {'name': g['name'], 'href': relative_url(Path(g['href']), out_root)}
        for g in brand_guides_raw
    ]

    # Per-client manifest. Registers itself on window.PORTFOLIO_CLIENTS.
    manifest_js = out_root / f'manifest-{slug}.js'
    with open(manifest_js, 'w') as f:
        f.write('window.PORTFOLIO_CLIENTS = window.PORTFOLIO_CLIENTS || {};\n')
        f.write(f'window.PORTFOLIO_CLIENTS[{json.dumps(slug)}] = ')
        json.dump({
            'slug': slug,
            'name': cfg['name'],
            'logo': logo_rel,
            'colors': cfg.get('colors') or {},
            'font': font_info,
            'umbrellaOrder': cfg.get('umbrella_order') or [],
            'brandGuides': brand_guides,
            'buildTime': build_time,
            'years': years_in_data,
            'jobs': jobs_out,
        }, f)
        f.write(';\n')

    # Also write a JSON copy for inspection
    with open(out_root / f'manifest-{slug}.json', 'w') as f:
        json.dump({
            'slug': slug, 'name': cfg['name'], 'buildTime': build_time,
            'years': years_in_data, 'jobs': jobs_out,
        }, f, indent=2)

    by_program: dict[str, int] = {}
    for j in jobs_out:
        by_program[j['programLabel']] = by_program.get(j['programLabel'], 0) + 1
    n_jobs = len(jobs_out)
    n_assets = sum(len(j['assets']) for j in jobs_out)
    print(f'  ✅ {cfg["name"]}: {n_jobs} jobs · {n_assets} assets · '
          f'{len(by_program)} programs')
    write_progress(slug, status='done', phase=f'Done — {n_jobs} jobs · {n_assets} assets',
                   jobsFound=n_jobs, assetsFound=n_assets,
                   finishedAt=datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'))

    return {
        'slug': slug,
        'name': cfg['name'],
        'logo': logo_rel,
        'buildTime': build_time,
        'jobs_count': len(jobs_out),
        'assets_count': sum(len(j['assets']) for j in jobs_out),
        'years': years_in_data,
    }


def write_clients_index(client_summaries: list[dict]):
    """Write clients.js — the registry the HTML uses to populate the dropdown."""
    out_root = OUT_ROOT
    listing = [{
        'slug': c['slug'],
        'name': c['name'],
        'logo': c['logo'],
        'buildTime': c['buildTime'],
        'jobs': c['jobs_count'],
        'assets': c['assets_count'],
        'years': c['years'],
    } for c in client_summaries]
    with open(out_root / 'clients.js', 'w') as f:
        f.write('window.PORTFOLIO_CLIENTS_LIST = ')
        json.dump(listing, f)
        f.write(';\n')

    # Top-level version.js: only bump it when source content actually
    # changed, not just because the script ran. Otherwise Box Drive's
    # constant mtime nudging makes fswatch fire builds back-to-back, each
    # bumping version.js, triggering browser auto-reloads every few seconds.
    #
    # We hash the actual content of all manifests we just wrote — if that
    # hash matches the previous build, leave version.js alone.
    content_hash = _hash_current_manifests(out_root)
    stamp_path = out_root / '.content-hash'
    prev_hash = ''
    try:
        prev_hash = stamp_path.read_text().strip()
    except OSError:
        pass

    version_path = out_root / 'version.js'
    if content_hash != prev_hash or not version_path.exists():
        latest = max((c['buildTime'] for c in client_summaries), default=
                     datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'))
        with open(version_path, 'w') as f:
            f.write(f'window.LATEST_BUILD_TIME = {json.dumps(latest)};\n')
        try:
            stamp_path.write_text(content_hash)
        except OSError:
            pass
        if prev_hash:
            print(f'  Content changed → version.js bumped to {latest}')
    else:
        print('  No content changes — version.js left as-is')


_BUILDTIME_RE = re.compile(r'"buildTime":\s*"[^"]*"')
_THUMB_VER_RE = re.compile(r'(\.jpg)\?v=\d+')


def _hash_current_manifests(out_root: Path) -> str:
    """Hash every manifest-*.js to detect whether the build actually
    produced different content. We strip out the per-build noise fields
    (buildTime stamps, thumb ?v=mtime cache-bust params) so the hash
    reflects ONLY meaningful content — asset list, names, categories, etc.
    If two consecutive builds produce the same content, version.js is
    left alone and the browser doesn't reload."""
    h = hashlib.sha256()
    try:
        files = sorted(out_root.glob('manifest-*.js'))
    except OSError:
        return ''
    for p in files:
        try:
            text = p.read_text()
        except OSError:
            continue
        # Normalize away things that change every build but aren't real edits
        text = _BUILDTIME_RE.sub('"buildTime":""', text)
        text = _THUMB_VER_RE.sub(r'\1', text)
        h.update(p.name.encode('utf-8'))
        h.update(b'\x00')
        h.update(text.encode('utf-8'))
        h.update(b'\x00')
    return h.hexdigest()


def merge_existing_clients(new_summaries: list[dict]) -> list[dict]:
    """When you build only one client, leave other clients' entries in
    clients.js intact by reading the previous file."""
    existing = {}
    clients_js = OUT_ROOT / 'clients.js'
    if clients_js.exists():
        try:
            text = clients_js.read_text()
            m = re.search(r'window\.PORTFOLIO_CLIENTS_LIST\s*=\s*(\[.*\])\s*;?',
                          text, re.DOTALL)
            if m:
                # Listing format uses jobs/assets; normalize to internal *_count keys
                for c in json.loads(m.group(1)):
                    existing[c['slug']] = {
                        'slug': c['slug'],
                        'name': c['name'],
                        'logo': c.get('logo'),
                        'buildTime': c.get('buildTime'),
                        'jobs_count': c.get('jobs', 0),
                        'assets_count': c.get('assets', 0),
                        'years': c.get('years', []),
                    }
        except Exception:
            pass
    for c in new_summaries:
        existing[c['slug']] = c
    return list(existing.values())


def main():
    args = parse_args()
    target_years = resolve_target_years(args)

    # Debounce: skip if another build ran recently (within 90s). Prevents
    # back-to-back rebuilds when Box Drive touches multiple files in quick
    # succession and fswatch fires repeatedly. Use --force to override.
    min_gap_seconds = 90
    stamp = OUT_ROOT / '.last-build-time'
    pidfile = OUT_ROOT / '.build.pid'

    # 1. Concurrency guard: if another build is already running, exit immediately.
    #    Box folders are slow enough that the heartbeat-triggered build can fire
    #    while a previous build is still scanning, causing both to compete for
    #    Box I/O AND clobber each other's manifest writes. Detect via PID file.
    if not getattr(args, 'force', False) and pidfile.exists():
        try:
            other_pid = int(pidfile.read_text().strip())
            # Check if that PID is actually still running
            os.kill(other_pid, 0)  # raises OSError if not running
            print(f'Skipping build — another build is already running (PID {other_pid}).')
            return
        except (OSError, ValueError):
            # Stale pidfile (process died without cleanup) — fall through and proceed
            pass

    # 2. Time-based debounce: skip if a build completed recently
    if not getattr(args, 'force', False):
        try:
            last = float(stamp.read_text().strip())
            elapsed = time.time() - last
            if elapsed < min_gap_seconds:
                print(f'Skipping build — last build was {int(elapsed)}s ago '
                      f'(< {min_gap_seconds}s debounce). Use --force to override.')
                return
        except (OSError, ValueError):
            pass

    # 3. Claim the lock and the timestamp
    try:
        stamp.parent.mkdir(parents=True, exist_ok=True)
        stamp.write_text(str(time.time()))
        pidfile.write_text(str(os.getpid()))
    except OSError:
        pass

    # Make sure we clean up the pidfile no matter how we exit
    import atexit
    def _cleanup_pidfile():
        try:
            if pidfile.exists() and int(pidfile.read_text().strip()) == os.getpid():
                pidfile.unlink()
        except (OSError, ValueError):
            pass
    atexit.register(_cleanup_pidfile)

    # Merge in user-added clients from clients-config.json
    merge_user_clients()

    if args.client == 'all':
        slugs = list(CLIENTS.keys())
    elif args.client in CLIENTS:
        slugs = [args.client]
    else:
        print(f'Unknown client {args.client!r}. Available: '
              f'{", ".join(CLIENTS)} or "all"', file=sys.stderr)
        sys.exit(2)

    summaries = []
    for slug in slugs:
        cfg = CLIENTS[slug]
        if not cfg['projects'].exists():
            print(f'⚠️  Skipping {slug}: projects folder not found at {cfg["projects"]}')
            continue
        summary = build_for_client(slug, cfg, target_years)
        if summary['jobs_count'] > 0:
            summaries.append(summary)

    if not summaries:
        print('\nNothing built — no clients had jobs.')
        return

    full_listing = merge_existing_clients(summaries)
    write_clients_index(full_listing)
    print(f'\nClients in registry: {", ".join(c["slug"] for c in full_listing)}')
    print(f'Output: {OUT_ROOT}')


if __name__ == '__main__':
    main()
