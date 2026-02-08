#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import subprocess
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Set

try:
    from scripts.utils.route_ids import is_excluded_route_id, normalize_route_id
except ModuleNotFoundError:  # pragma: no cover - script execution fallback
    from utils.route_ids import is_excluded_route_id, normalize_route_id

ROUTES_DIR = Path("data/processed/routes")
STOPS_FILE = Path("data/processed/stops.geojson")


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


def parse_route_tokens(val: object) -> List[str]:
    if not val:
        return []
    s = str(val).replace(",", " ")
    tokens: List[str] = []
    for raw in s.split():
        normalized = normalize_route_id(raw)
        if normalized and not is_excluded_route_id(normalized):
            tokens.append(normalized)
    return tokens


def extract_stop_ids(gj: dict) -> Set[str]:
    ids: Set[str] = set()
    for feat in gj.get("features", []):
        props = feat.get("properties", {}) or {}
        sid = props.get("NAPTAN_ID") or props.get("naptanId") or props.get("stopPointId")
        if sid:
            ids.add(str(sid))
    return ids


def extract_routes_for_stops(gj: dict, stop_ids: Set[str]) -> Set[str]:
    routes: Set[str] = set()
    if not stop_ids:
        return routes
    for feat in gj.get("features", []):
        props = feat.get("properties", {}) or {}
        sid = props.get("NAPTAN_ID") or props.get("naptanId") or props.get("stopPointId")
        if not sid or str(sid) not in stop_ids:
            continue
        tokens = parse_route_tokens(props.get("ROUTES"))
        routes.update(tokens)
    return routes


def main() -> int:
    parser = argparse.ArgumentParser(description="Detect changes that require stop sequence refetch.")
    parser.add_argument(
        "--output",
        default="data/processed/stop_analysis/route_sequences_changes.json",
        help="Output JSON path.",
    )
    args = parser.parse_args()

    old_routes = git_ls_routes("HEAD")
    new_routes = {p.stem for p in ROUTES_DIR.glob("*.geojson")}
    routes_added = sorted(new_routes - old_routes)
    routes_removed = sorted(old_routes - new_routes)

    old_stops = load_json_from_git("HEAD", STOPS_FILE)
    new_stops = load_json_from_fs(STOPS_FILE)

    stops_added: List[str] = []
    stops_removed: List[str] = []
    routes_from_stop_changes: Set[str] = set()
    if old_stops and new_stops:
        old_ids = extract_stop_ids(old_stops)
        new_ids = extract_stop_ids(new_stops)
        stops_added = sorted(new_ids - old_ids)
        stops_removed = sorted(old_ids - new_ids)
        if stops_added:
            routes_from_stop_changes.update(extract_routes_for_stops(new_stops, set(stops_added)))
        if stops_removed:
            routes_from_stop_changes.update(extract_routes_for_stops(old_stops, set(stops_removed)))

    trigger = bool(stops_added or stops_removed or routes_added or routes_removed)

    routes_to_fetch: Set[str] = set()
    if trigger:
        routes_to_fetch.update(routes_added)
        routes_to_fetch.update(routes_from_stop_changes)
    routes_to_fetch.difference_update(routes_removed)

    payload = {
        "stops_added": len(stops_added),
        "stops_removed": len(stops_removed),
        "routes_added": routes_added,
        "routes_removed": routes_removed,
        "routes_from_stop_changes": sorted(routes_from_stop_changes),
        "routes_to_fetch": sorted(routes_to_fetch),
        "routes_to_drop": routes_removed,
        "trigger": trigger,
    }

    out_path = Path(args.output)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(payload, ensure_ascii=True, separators=(",", ":"), sort_keys=True), encoding="utf-8")
    print(json.dumps(payload, ensure_ascii=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
