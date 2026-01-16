#!/usr/bin/env python3
from __future__ import annotations

import json
import subprocess
from pathlib import Path
from typing import Dict, Set, List, Tuple, Optional

ROUTES_DIR = Path("data/processed/routes")
GARAGES_FILE = Path("data/processed/garages.geojson")

STOPS_FILE = Path("data/processed/stops.geojson")
ROUTES_INDEX = Path("data/processed/routes/index.json")


def git_ls_routes(ref: str) -> Set[str]:
    try:
        out = subprocess.check_output(
            ["git", "ls-tree", "-r", "--name-only", ref, ROUTES_DIR.as_posix()],
            stderr=subprocess.DEVNULL,
        ).decode()
    except subprocess.CalledProcessError:
        return set()

    return {
        Path(p).stem
        for p in out.splitlines()
        if p.endswith(".geojson")
    }

def load_json_from_git(ref: str, path: Path) -> Optional[dict]:
    try:
        raw = subprocess.check_output(
            ["git", "show", f"{ref}:{path.as_posix()}"],
            stderr=subprocess.DEVNULL,
        )
        return json.loads(raw)
    except subprocess.CalledProcessError:
        return None

def load_json_from_fs(path: Path) -> Optional[dict]:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None

def parse_route_tokens(val: object) -> List[str]:
    if not val:
        return []
    s = str(val).replace(",", " ")
    return [t.strip() for t in s.split() if t.strip()]

def extract_allocations_from_garages(gj: dict) -> Dict[str, str]:
    """
    Build route -> garage code mapping from your garages.geojson schema:
    uses "TfL garage code" (fallback "LBR garage code") and the 4 route fields.
    """
    out: Dict[str, str] = {}
    for f in gj.get("features", []):
        p = f.get("properties", {}) or {}
        garage = (p.get("TfL garage code") or p.get("LBR garage code") or "").strip().upper()
        if not garage:
            continue

        tokens: List[str] = []
        tokens += parse_route_tokens(p.get("TfL main network routes"))
        tokens += parse_route_tokens(p.get("TfL night routes"))
        tokens += parse_route_tokens(p.get("TfL school/mobility routes"))
        tokens += parse_route_tokens(p.get("Other routes"))

        for r in tokens:
            out[r.upper()] = garage
    return out

# ---- ROUTE ADDS / REMOVES ----
old_routes = git_ls_routes("HEAD")
new_routes = {
    p.stem for p in (ROUTES_DIR).glob("*.geojson")
}

added = sorted(new_routes - old_routes)
removed = sorted(old_routes - new_routes)

# ---- ALLOCATION MOVES ----
moves: List[Tuple[str, str, str]] = []
old_g = load_json_from_git("HEAD", GARAGES_FILE)
new_g = load_json_from_fs(GARAGES_FILE)


if old_g and new_g:
    old_map = extract_allocations_from_garages(old_g)
    new_map = extract_allocations_from_garages(new_g)
    for r in sorted(old_map.keys() & new_map.keys()):
        if old_map[r] != new_map[r]:
            moves.append((r, old_map[r], new_map[r]))

# ---- STOP ADDS / REMOVES ----
def extract_stop_ids(gj: dict) -> Set[str]:
    ids: Set[str] = set()
    for f in gj.get("features", []):
        p = f.get("properties", {}) or {}
        sid = p.get("NAPTAN_ID")
        if sid:
            ids.add(str(sid))
    return ids

old_stops = load_json_from_git("HEAD", STOPS_FILE)
new_stops = load_json_from_fs(STOPS_FILE)

stops_added: List[str] = []
stops_removed: List[str] = []
if old_stops and new_stops:
    old_ids = extract_stop_ids(old_stops)
    new_ids = extract_stop_ids(new_stops)
    stops_added = sorted(new_ids - old_ids)
    stops_removed = sorted(old_ids - new_ids)


# ---- GEOMETRY UPDATES ----
def git_diff_names(path: str) -> List[str]:
    out = subprocess.check_output(["git", "diff", "--name-only", "HEAD", "--", path]).decode()
    return [line.strip() for line in out.splitlines() if line.strip()]

route_changed_files = [
    p for p in git_diff_names(ROUTES_DIR.as_posix())
    if p.endswith(".geojson") and not p.endswith("/index.json")
]
# exclude pure additions/removals already counted
changed_route_ids = sorted({Path(p).stem for p in route_changed_files})
geom_updated = sorted(set(changed_route_ids) - set(added) - set(removed))



# ---- BUILD COMMIT MESSAGE ----
def cap_list(items: List[str], n: int = 10) -> str:
    if len(items) <= n:
        return ", ".join(items)
    return ", ".join(items[:n]) + f" …(+{len(items)-n} more)"

lines: List[str] = []

if added or removed or geom_updated:
    parts = []
    if added:
        parts.append(f"+{len(added)}")
    if removed:
        parts.append(f"-{len(removed)}")
    if geom_updated:
        parts.append(f"~{len(geom_updated)}")
    lines.append(f"Routes ({' '.join(parts)})")

if stops_added or stops_removed:
    lines.append(f"Stops (+{len(stops_added)} -{len(stops_removed)})")

if moves:
    move_strings = [f"{r} {a}→{b}" for (r, a, b) in moves]
    lines.append("Alloc: " + cap_list(move_strings, 12))

if not lines:
    lines.append("Processed data update")

print(" | ".join(lines))
