#!/usr/bin/env python3
"""
Summarise data changes between two RouteMapster revisions.

This CLI compares route geometry, garage allocations, and cached frequency
values so maintainers can quickly review what changed between pipeline runs.
It depends on the processed datasets already committed in the repository and
uses Git for historical lookups.
"""
from __future__ import annotations

import argparse
import json
import math
import subprocess
from pathlib import Path
from typing import Dict, Set, List, Tuple, Optional

try:
    from scripts.utils.route_ids import is_excluded_route_id, normalize_route_id
except ModuleNotFoundError:  # pragma: no cover - script execution fallback
    from utils.route_ids import is_excluded_route_id, normalize_route_id
ROUTES_DIR = Path("data/processed/routes")
GARAGES_FILE = Path("data/processed/garages.geojson")
FREQS_FILE = Path("data/processed/frequencies.json")
DESTINATIONS_FILE = Path("data/processed/route_destinations.json")

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
    tokens: List[str] = []
    for raw in s.split():
        normalized = normalize_route_id(raw)
        if normalized and not is_excluded_route_id(normalized):
            tokens.append(normalized)
    return tokens

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
            if r:
                out[r] = garage
    return out

def normalize_bph(value: object) -> Optional[float]:
    if value is None:
        return None
    try:
        num = float(value)
    except (TypeError, ValueError):
        return None
    if math.isnan(num):
        return None
    return round(num, 1)

FREQ_BANDS: List[Tuple[str, str]] = [
    ("peak_am", "am peak"),
    ("peak_pm", "pm peak"),
    ("offpeak", "offpeak"),
    ("overnight", "overnight"),
    ("weekend", "weekend"),
]

def build_frequency_changes(old_freqs: dict, new_freqs: dict) -> List[str]:
    changes: List[str] = []
    if not isinstance(old_freqs, dict):
        old_freqs = {}
    if not isinstance(new_freqs, dict):
        new_freqs = {}
    route_ids = sorted(set(old_freqs.keys()) | set(new_freqs.keys()))
    for route_id in route_ids:
        old_entry = old_freqs.get(route_id) or {}
        new_entry = new_freqs.get(route_id) or {}
        for key, label in FREQ_BANDS:
            old_val = normalize_bph(old_entry.get(key))
            new_val = normalize_bph(new_entry.get(key))
            if old_val == new_val:
                continue
            if old_val is None and new_val is None:
                continue
            if old_val is None:
                changes.append(f"{route_id} {label} added at {new_val} bph")
            elif new_val is None:
                changes.append(f"{route_id} {label} removed (was {old_val} bph)")
            else:
                direction = "increased" if new_val > old_val else "decreased"
                changes.append(f"{route_id} {label} {direction} from {old_val} to {new_val} bph")
    return changes

# ---- ROUTE ADDS / REMOVES ----
old_routes = git_ls_routes("HEAD")
new_routes = {
    p.stem for p in (ROUTES_DIR).glob("*.geojson")
}

added = sorted(new_routes - old_routes)
removed = sorted(old_routes - new_routes)

# ---- ALLOCATION MOVES ----
moves: List[Tuple[str, str, str]] = []
alloc_added: List[Tuple[str, str]] = []
alloc_removed: List[Tuple[str, str]] = []
old_g = load_json_from_git("HEAD", GARAGES_FILE)
new_g = load_json_from_fs(GARAGES_FILE)


if old_g and new_g:
    old_map = extract_allocations_from_garages(old_g)
    new_map = extract_allocations_from_garages(new_g)
    for r in sorted(old_map.keys() & new_map.keys()):
        if old_map[r] != new_map[r]:
            moves.append((r, old_map[r], new_map[r]))
    for r in sorted(new_map.keys() - old_map.keys()):
        alloc_added.append((r, new_map[r]))
    for r in sorted(old_map.keys() - new_map.keys()):
        alloc_removed.append((r, old_map[r]))

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

# ---- FREQUENCY CHANGES ----
old_freqs = load_json_from_git("HEAD", FREQS_FILE) or {}
new_freqs = load_json_from_fs(FREQS_FILE) or {}
freq_changes = build_frequency_changes(old_freqs, new_freqs)


# ---- DESTINATION CHANGES ----
def load_destination_routes(payload: Optional[dict]) -> Dict[str, dict]:
    if not isinstance(payload, dict):
        return {}
    routes = payload.get("routes")
    if not isinstance(routes, dict):
        return {}
    return {
        normalize_route_id(route_id): value
        for route_id, value in routes.items()
        if normalize_route_id(route_id) and isinstance(value, dict)
    }


def destination_value(entry: dict, direction: str, key: str) -> str:
    section = entry.get(direction)
    if not isinstance(section, dict):
        return ""
    return str(section.get(key) or "").strip()


def build_destination_changes(old_destinations: dict, new_destinations: dict) -> List[str]:
    changes: List[str] = []
    old_routes = load_destination_routes(old_destinations)
    new_routes = load_destination_routes(new_destinations)
    for route_id in sorted(set(old_routes) | set(new_routes)):
        old_entry = old_routes.get(route_id, {})
        new_entry = new_routes.get(route_id, {})
        if route_id not in old_routes:
            changes.append(f"{route_id} destinations added")
            continue
        if route_id not in new_routes:
            changes.append(f"{route_id} destinations removed")
            continue
        for direction in ("outbound", "inbound"):
            old_value = destination_value(old_entry, direction, "destination")
            new_value = destination_value(new_entry, direction, "destination")
            if old_value != new_value:
                changes.append(f"{route_id} {direction} destination changed from {old_value or '<blank>'} to {new_value or '<blank>'}")
    return changes


def build_destination_refresh_routes(added_routes: List[str], geometry_updated_routes: List[str]) -> List[str]:
    return sorted(set(added_routes) | set(geometry_updated_routes))


old_destinations = load_json_from_git("HEAD", DESTINATIONS_FILE) or {}
new_destinations = load_json_from_fs(DESTINATIONS_FILE) or {}
destination_changes = build_destination_changes(old_destinations, new_destinations)


# ---- GEOMETRY UPDATES ----
def git_diff_names(path: str) -> List[str]:
    out = subprocess.check_output(["git", "diff", "--name-only", "HEAD", "--", path]).decode()
    return [line.strip() for line in out.splitlines() if line.strip()]


def normalise_route_geometry(payload: Optional[dict]) -> List[dict]:
    """Return the route shape in a form which excludes refresh metadata."""
    if not isinstance(payload, dict):
        return []

    normalised: List[dict] = []
    for feature in payload.get("features", []):
        if not isinstance(feature, dict):
            continue
        properties = feature.get("properties")
        geometry = feature.get("geometry")
        if not isinstance(properties, dict) or not isinstance(geometry, dict):
            continue

        geometry_type = geometry.get("type")
        coordinates = geometry.get("coordinates")
        if geometry_type == "MultiLineString" and isinstance(coordinates, list):
            coordinates = sorted(coordinates, key=lambda segment: json.dumps(segment, separators=(",", ":")))

        normalised.append(
            {
                "direction": str(properties.get("direction") or ""),
                "geometry": {"type": geometry_type, "coordinates": coordinates},
            }
        )

    return sorted(
        normalised,
        key=lambda feature: json.dumps(feature, sort_keys=True, separators=(",", ":")),
    )


def route_terminal_signature(payload: Optional[dict], precision: int = 4) -> List[dict]:
    """Return stable route termini, ignoring non-terminal geometry variations.

    TfL can reorder, duplicate, or make small edits to intermediate geometry
    segments between refreshes. Those changes do not affect a passenger-facing
    destination, so they must not trigger a destination API lookup.
    """
    if not isinstance(payload, dict):
        return []

    normalised: List[dict] = []
    for feature in payload.get("features", []):
        if not isinstance(feature, dict):
            continue
        properties = feature.get("properties")
        geometry = feature.get("geometry")
        if not isinstance(properties, dict) or not isinstance(geometry, dict):
            continue

        coordinates = geometry.get("coordinates")
        geometry_type = geometry.get("type")
        if geometry_type == "LineString":
            segments = [coordinates]
        elif geometry_type == "MultiLineString":
            segments = coordinates
        else:
            continue

        terminals = set()
        for segment in segments if isinstance(segments, list) else []:
            if not isinstance(segment, list) or len(segment) < 2:
                continue
            try:
                start = tuple(round(float(value), precision) for value in segment[0][:2])
                end = tuple(round(float(value), precision) for value in segment[-1][:2])
            except (IndexError, TypeError, ValueError):
                continue
            terminals.add(tuple(sorted((start, end))))

        if not terminals:
            continue

        normalised.append(
            {
                "direction": str(properties.get("direction") or ""),
                "terminals": sorted(terminals),
            }
        )

    return sorted(
        normalised,
        key=lambda feature: json.dumps(feature, sort_keys=True, separators=(",", ":")),
    )


def route_geometry_changed(route_id: str) -> bool:
    path = ROUTES_DIR / f"{route_id}.geojson"
    old_payload = load_json_from_git("HEAD", path)
    new_payload = load_json_from_fs(path)
    return route_terminal_signature(old_payload) != route_terminal_signature(new_payload)


route_changed_files = [
    p for p in git_diff_names(ROUTES_DIR.as_posix())
    if p.endswith(".geojson") and not p.endswith("/index.json")
]
# exclude pure additions/removals already counted
changed_route_ids = sorted({Path(p).stem for p in route_changed_files})
geom_updated = [
    route_id
    for route_id in changed_route_ids
    if route_id not in added and route_id not in removed and route_geometry_changed(route_id)
]



# ---- BUILD COMMIT MESSAGE ----
def cap_list(items: List[str], n: int = 10) -> str:
    if len(items) <= n:
        return ", ".join(items)
    return ", ".join(items[:n]) + f" ...(+{len(items)-n} more)"

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

if freq_changes:
    lines.append(f"Freq (~{len(freq_changes)})")

if destination_changes:
    lines.append(f"Dest (~{len(destination_changes)})")

alloc_messages: List[str] = []
if moves:
    alloc_messages.extend([f"{r} {a} -> {b}" for (r, a, b) in moves])
if alloc_added:
    alloc_messages.extend([f"{r} allocated to {g}" for (r, g) in alloc_added])
if alloc_removed:
    alloc_messages.extend([f"{r} removed from {g}" for (r, g) in alloc_removed])
if alloc_messages:
    lines.append("Alloc: " + cap_list(alloc_messages, 12))

if not lines:
    lines.append("Processed data update")

summary_line = " | ".join(lines)

def print_details() -> None:
    print("### Data update")
    print(f"- {summary_line}")

    if added or removed or geom_updated:
        print("\n### Route geometry changes")
        if added:
            print(f"- Added routes: {cap_list(added, 40)}")
        if removed:
            print(f"- Removed routes: {cap_list(removed, 40)}")
        if geom_updated:
            print(f"- Updated route geometries: {cap_list(geom_updated, 60)}")

    if stops_added or stops_removed:
        print("\n### Stop changes")
        if stops_added:
            print(f"- Added stops: {cap_list(stops_added, 40)}")
        if stops_removed:
            print(f"- Removed stops: {cap_list(stops_removed, 40)}")

    if freq_changes:
        print("\n### Frequency changes")
        limit = 30
        for line in freq_changes[:limit]:
            print(f"- {line}")
        if len(freq_changes) > limit:
            print(f"- ...and {len(freq_changes) - limit} more")

    if destination_changes:
        print("\n### Destination changes")
        limit = 60
        for line in destination_changes[:limit]:
            print(f"- {line}")
        if len(destination_changes) > limit:
            print(f"- ...and {len(destination_changes) - limit} more")

    if alloc_messages:
        print("\n### Allocation changes")
        limit = 60
        for line in alloc_messages[:limit]:
            print(f"- {line}")
        if len(alloc_messages) > limit:
            print(f"- ...and {len(alloc_messages) - limit} more")


def main() -> None:
    """Print a change summary for the requested repository comparison.

    Side effects:
        Reads processed files from disk, shells out to Git, and writes the
        summary to stdout.
    """
    parser = argparse.ArgumentParser(description="Summarize processed data changes.")
    parser.add_argument("--summary", action="store_true", help="Print one-line summary.")
    parser.add_argument("--details", action="store_true", help="Print detailed change log.")
    parser.add_argument(
        "--destination-refresh-routes",
        action="store_true",
        help="Print comma-separated route ids whose destinations should be refreshed.",
    )
    args = parser.parse_args()

    if not args.summary and not args.details and not args.destination_refresh_routes:
        args.summary = True

    if args.summary:
        print(summary_line)
    if args.details:
        print_details()
    if args.destination_refresh_routes:
        print(",".join(build_destination_refresh_routes(added, geom_updated)))


if __name__ == "__main__":
    main()
