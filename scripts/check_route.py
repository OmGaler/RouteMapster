#!/usr/bin/env python3
"""
scripts/check_route.py

Adds route type summary:
  - regular route / night route / school or mobility route / other route
  - and "24hr route" if the route appears under both main + night allocations
"""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

try:
    from scripts.utils.route_ids import is_excluded_route_id, normalize_route_id
except ModuleNotFoundError:  # pragma: no cover - script execution fallback
    from utils.route_ids import is_excluded_route_id, normalize_route_id

def repo_root() -> Path:
    return Path(__file__).resolve().parents[1]


def load_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def norm_route(route: str) -> str:
    return normalize_route_id(route)


def display_route(route: str) -> str:
    return normalize_route_id(route)


def route_geom_path(route: str, geom_dir: Path) -> Path:
    return geom_dir / f"{normalize_route_id(route)}.geojson"


def base_route(route: str) -> str:
    r = normalize_route_id(route)
    if r.endswith("D") and len(r) > 1 and r[-2].isdigit():
        return r[:-1]
    return r


def is_school_frequency_exempt(route: str) -> bool:
    r = base_route(route)
    if not r.isdigit():
        return False
    value = int(r)
    return 600 <= value <= 699 or 900 <= value <= 999


def geom_is_present(geom_path: Path, route: str) -> Tuple[bool, Optional[Dict[str, Any]]]:
    if not geom_path.exists():
        return False, None
    try:
        obj = load_json(geom_path)
    except Exception:
        return False, None

    if not isinstance(obj, dict):
        return False, obj
    if obj.get("type") != "FeatureCollection":
        return False, obj

    feats = obj.get("features")
    if not isinstance(feats, list) or len(feats) == 0:
        return False, obj

    meta = obj.get("metadata")
    if isinstance(meta, dict) and meta.get("routeId") is not None:
        meta_id = normalize_route_id(meta.get("routeId"))
        if meta_id != route:
            return False, obj

    return True, obj


ROUTE_TOKEN_RE = re.compile(r"[A-Za-z0-9]+")


def parse_routes_field(value: Any) -> List[str]:
    if value is None:
        return []
    s = str(value).strip()
    if not s:
        return []
    tokens: List[str] = []
    for match in ROUTE_TOKEN_RE.finditer(s):
        token = normalize_route_id(match.group(0))
        if token and not is_excluded_route_id(token):
            tokens.append(token)
    return tokens


def find_allocations(garages_obj: Any, route: str) -> List[Dict[str, str]]:
    """
    Returns ALL matches (not just first).

    Each result:
      {
        "operator": "...",   # Group name
        "garage": "...",     # Garage name
        "code": "...",       # LBR garage code (fallback TfL garage code)
        "bucket": "main|night|school/mobility|other"
      }
    """
    if not isinstance(garages_obj, dict):
        return []
    feats = garages_obj.get("features")
    if not isinstance(feats, list):
        return []

    buckets = [
        ("main", "TfL main network routes"),
        ("night", "TfL night routes"),
        ("school/mobility", "TfL school/mobility routes"),
        ("other", "Other routes"),
    ]

    matches: List[Dict[str, str]] = []

    for feat in feats:
        if not isinstance(feat, dict):
            continue
        props = feat.get("properties")
        if not isinstance(props, dict):
            continue

        for bucket_key, field in buckets:
            tokens = parse_routes_field(props.get(field))
            if route in tokens:
                operator = str(props.get("Group name", "Unknown")).strip()
                garage = str(props.get("Garage name", "Unknown")).strip()
                code = str(props.get("LBR garage code") or props.get("TfL garage code") or "").strip()
                matches.append(
                    {"operator": operator, "garage": garage, "code": code, "bucket": bucket_key}
                )

    # de-dup identical rows
    uniq: List[Dict[str, str]] = []
    seen = set()
    for m in matches:
        key = (m["operator"], m["garage"], m["code"], m["bucket"])
        if key not in seen:
            seen.add(key)
            uniq.append(m)
    return uniq


def bucket_to_type(bucket: str) -> str:
    return {
        "main": "regular route",
        "night": "night route",
        "school/mobility": "school or mobility route",
        "other": "other route",
    }.get(bucket, bucket)


def derive_route_type(allocs: List[Dict[str, str]]) -> str:
    """
    Best-effort classification from which allocation lists the route appears in.

    If appears in BOTH main + night -> "24hr route"
    else return a comma-separated list of distinct types.
    """
    buckets = {a.get("bucket") for a in allocs if a.get("bucket")}
    if "main" in buckets and "night" in buckets:
        return "24hr route"
    types = [bucket_to_type(b) for b in ("main", "night", "school/mobility", "other") if b in buckets]
    return ", ".join(types) if types else "unknown"


def load_vehicle(vehicles_path: Path, route: str) -> Optional[str]:
    if not vehicles_path.exists():
        return None
    obj = load_json(vehicles_path)
    if not isinstance(obj, dict):
        return None
    key = normalize_route_id(route)
    v = obj.get(key) or obj.get(key.lower()) or obj.get(key.upper())
    if not v:
        return None
    vv = str(v).strip().upper()
    return vv if vv in {"SD", "DD"} else None


def load_freqs(freqs_path: Path, route: str) -> Optional[Dict[str, Any]]:
    if not freqs_path.exists():
        return None
    obj = load_json(freqs_path)
    if not isinstance(obj, dict):
        return None
    key = normalize_route_id(route)
    entry = obj.get(key) or obj.get(key.lower()) or obj.get(key.upper())
    if not isinstance(entry, dict):
        return None

    return {
        "am peak": entry.get("peak_am"),
        "pm peak": entry.get("peak_pm"),
        "day off-peak": entry.get("offpeak"),
        "overnight": entry.get("overnight"),
    }


def route_status(
    route: str,
    geom_dir: Path,
    garages_path: Path,
    freqs_path: Path,
    vehicles_path: Path,
) -> Dict[str, Any]:
    norm = norm_route(route)
    alloc_route = base_route(norm)
    geom_path = route_geom_path(norm, geom_dir)
    has_geom, _geom_obj = geom_is_present(geom_path, norm)

    garages_obj = load_json(garages_path) if garages_path.exists() else None
    allocs = find_allocations(garages_obj, alloc_route) if garages_obj is not None else []
    has_alloc = len(allocs) > 0

    vehicle = load_vehicle(vehicles_path, norm)
    has_vehicle = vehicle is not None

    freqs = load_freqs(freqs_path, alloc_route)
    has_freq = freqs is not None
    expects_freq = not is_school_frequency_exempt(norm)

    return {
        "route": norm,
        "geom_path": geom_path,
        "has_geom": has_geom,
        "has_alloc": has_alloc,
        "has_vehicle": has_vehicle,
        "has_freq": has_freq,
        "expects_freq": expects_freq,
        "allocs": allocs,
        "vehicle": vehicle or "Unknown",
        "freqs": freqs,
        "active": has_geom and has_alloc and has_vehicle and (has_freq or not expects_freq),
    }


def main() -> int:
    """Inspect one route across the processed RouteMapster datasets.

    Returns:
        Process exit code for CLI usage.

    Side effects:
        Reads processed files from disk and prints a human-readable report.
    """
    ap = argparse.ArgumentParser()
    ap.add_argument("route", help="Route id (e.g. 1, 100, sl10)")
    ap.add_argument("--geom-dir", default=str(repo_root() / "data" / "processed" / "routes"))
    ap.add_argument("--garages", default=str(repo_root() / "data" / "processed" / "garages.geojson"))
    ap.add_argument("--freqs", default=str(repo_root() / "data" / "processed" / "frequencies.json"))
    ap.add_argument("--vehicles", default=str(repo_root() / "data" / "vehicles.json"))
    args = ap.parse_args()

    route = norm_route(args.route)
    route_disp = display_route(args.route)

    geom_dir = Path(args.geom_dir)
    garages_path = Path(args.garages)
    freqs_path = Path(args.freqs)
    vehicles_path = Path(args.vehicles)

    status = route_status(route, geom_dir, garages_path, freqs_path, vehicles_path)
    has_geom = status["has_geom"]
    has_alloc = status["has_alloc"]
    has_vehicle = status["has_vehicle"]
    has_freq = status["has_freq"]
    expects_freq = status["expects_freq"]
    allocs = status["allocs"]
    vehicle = status["vehicle"]
    freqs = status["freqs"]

    # ---- status + notes ----
    notes: List[str] = []
    if not has_geom:
        notes.append("no route geometry")
    if not has_alloc:
        notes.append("no allocation")
    if not has_vehicle:
        notes.append("no vehicle")
    if expects_freq and not has_freq:
        notes.append("no frequency")

    active = has_geom and has_alloc and has_vehicle and (has_freq or not expects_freq)

    if active:
        print(f"Route {route_disp} active")
    else:
        if not has_geom and not has_alloc:
            print(f"No active Route {route_disp} found.")
        else:
            print(f"Route {route_disp} inactive.")
        print("Note: " + ", ".join(notes))

    # ---- route type summary ----
    route_type = derive_route_type(allocs) if allocs else "unknown"
    print(f"Type: {route_type}")

    # ---- rest of info ----
    print(f"Vehicle: {vehicle}")

    if allocs:
        print("Allocation(s):")
        for a in allocs:
            code = f" ({a['code']})" if a.get("code") else ""
            t = bucket_to_type(a.get("bucket", "unknown"))
            print(f"  - {t}: operated by {a['operator']}, allocated to {a['garage']}{code}")
    else:
        print("Allocation: (missing)")

    if freqs:
        def show(v: Any) -> str:
            return "missing" if v is None else str(v)

        print("Frequency:")
        print(f"  am peak: {show(freqs.get('am peak'))} bph")
        print(f"  pm peak: {show(freqs.get('pm peak'))} bph")
        print(f"  day off-peak: {show(freqs.get('day off-peak'))} bph")
        print(f"  overnight: {show(freqs.get('overnight'))} bph")
    else:
        if expects_freq:
            print("Frequency: (missing frequencies.json entry)")
        else:
            print("Frequency: (skipped for school-route series)")

    if not has_geom:
        print(f"Geometry file: (missing) expected at {geom_path}")

    # ---- exit code ----
    if active:
        return 0
    if not has_geom and not has_alloc:
        return 2
    if has_geom and not has_alloc:
        return 3
    if not has_geom and has_alloc:
        return 4
    return 5


if __name__ == "__main__":
    raise SystemExit(main())
