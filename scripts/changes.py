#!/usr/bin/env python3
from __future__ import annotations

import json
import subprocess
from pathlib import Path
from typing import Dict, Set, List, Tuple, Optional

ROUTES_DIR = Path("data/processed/routes")
GARAGES_FILE = Path("data/processed/garages.geojson")


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


def load_garages(ref: str) -> Optional[dict]:
    try:
        raw = subprocess.check_output(
            ["git", "show", f"{ref}:{GARAGES_FILE.as_posix()}"],
            stderr=subprocess.DEVNULL,
        )
        return json.loads(raw)
    except subprocess.CalledProcessError:
        return None


def extract_allocations(gj: dict) -> Dict[str, str]:
    out = {}
    for f in gj.get("features", []):
        p = f.get("properties", {})
        garage = p.get("code") or p.get("garage_code") or p.get("Garage")
        routes = p.get("routes")
        if not garage or not routes:
            continue
        if isinstance(routes, str):
            routes = [r.strip() for r in routes.split(",")]
        for r in routes:
            out[str(r)] = str(garage)
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
old_g = load_garages("HEAD")
new_g = load_garages("")

if old_g and new_g:
    old_map = extract_allocations(old_g)
    new_map = extract_allocations(new_g)
    for r in sorted(old_map.keys() & new_map.keys()):
        if old_map[r] != new_map[r]:
            moves.append((r, old_map[r], new_map[r]))

# ---- BUILD COMMIT MESSAGE ----
lines = []

if added:
    lines.append(f"Added routes: {', '.join(added)}")

if removed:
    lines.append(f"Removed routes: {', '.join(removed)}")

if moves:
    for r, a, b in moves:
        lines.append(f"Route {r} moved {a} → {b}")

if not lines:
    lines.append("Processed data update")

print(" | ".join(lines))
