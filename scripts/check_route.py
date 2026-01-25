#!/usr/bin/env python3
"""
scripts/check_route.py

Given a route number/id:
A) checks it exists:
   - route exists if it has (1) route geometry AND (2) an allocation in garages.geojson
   - if neither: "No active Route X found."
   - if only one: prints which piece is missing
B) regardless, prints what it can:
   - Vehicle (SD/DD) from vehicles.json (if present)
   - Operator + allocation (if present)
   - Frequency bands from frequencies.json (if present)

Exit codes:
  0 = active (geometry + allocation)
  2 = neither geometry nor allocation
  3 = geometry only
  4 = allocation only
"""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple


def repo_root() -> Path:
    return Path(__file__).resolve().parents[1]


def load_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def norm_route(route: str) -> str:
    return route.strip().lower()


def display_route(route: str) -> str:
    r = route.strip()
    if any(c.isalpha() for c in r):
        return "".join(c.upper() if c.isalpha() else c for c in r)
    return r


def route_geom_path(route: str, geom_dir: Path) -> Path:
    return geom_dir / f"{route}.geojson"


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
        meta_id = str(meta.get("routeId")).strip().lower()
        if meta_id != route:
            return False, obj

    return True, obj


ROUTE_TOKEN_RE = re.compile(r"[A-Za-z0-9]+")


def parse_routes_field(value: Any) -> List[str]:
    if value is None:
        return []
    s = str(value).strip().lower()
    if not s:
        return []
    return [m.group(0).lower() for m in ROUTE_TOKEN_RE.finditer(s)]


def find_allocation(garages_obj: Any, route: str) -> Optional[Dict[str, str]]:
    if not isinstance(garages_obj, dict):
        return None
    feats = garages_obj.get("features")
    if not isinstance(feats, list):
        return None

    buckets = [
        ("main", "TfL main network routes"),
        ("night", "TfL night routes"),
        ("school/mobility", "TfL school/mobility routes"),
        ("other", "Other routes"),
    ]

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
                return {"operator": operator, "garage": garage, "code": code, "bucket": bucket_key}

    return None


def load_vehicle(vehicles_path: Path, route: str) -> Optional[str]:
    if not vehicles_path.exists():
        return None
    obj = load_json(vehicles_path)
    if not isinstance(obj, dict):
        return None
    v = obj.get(route) or obj.get(route.upper()) or obj.get(route.lower())
    if not v:
        return None
    vv = str(v).strip().upper()
    return vv if vv in {"SD", "DD"} else vv


def load_freqs(freqs_path: Path, route: str) -> Optional[Dict[str, Any]]:
    if not freqs_path.exists():
        return None
    obj = load_json(freqs_path)
    if not isinstance(obj, dict):
        return None
    entry = obj.get(route) or obj.get(route.upper()) or obj.get(route.lower())
    if not isinstance(entry, dict):
        return None

    return {
        "am peak": entry.get("peak_am"),
        "pm peak": entry.get("peak_pm"),
        "day off-peak": entry.get("offpeak"),
        "overnight": entry.get("overnight"),
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("route", help="Route id (e.g. 1, 100, sl10)")
    ap.add_argument("--geom-dir", default=str(repo_root() / "data" / "processed" / "routes"))
    ap.add_argument("--garages", default=str(repo_root() / "data" / "garages.geojson"))
    ap.add_argument("--freqs", default=str(repo_root() / "data" / "processed" / "frequencies.json"))
    ap.add_argument("--vehicles", default=str(repo_root() / "data" / "vehicles.json"))
    args = ap.parse_args()

    route = norm_route(args.route)
    route_disp = display_route(args.route)

    geom_dir = Path(args.geom_dir)
    garages_path = Path(args.garages)
    freqs_path = Path(args.freqs)
    vehicles_path = Path(args.vehicles)

    # ---- gather facts ----
    geom_path = route_geom_path(route, geom_dir)
    has_geom, geom_obj = geom_is_present(geom_path, route)

    garages_obj = load_json(garages_path) if garages_path.exists() else None
    alloc = find_allocation(garages_obj, route) if garages_obj is not None else None
    has_alloc = alloc is not None

    vehicle = load_vehicle(vehicles_path, route) or "Unknown"
    freqs = load_freqs(freqs_path, route)

    # ---- status line + notes ----
    notes: List[str] = []
    if not has_geom:
        notes.append("no route geometry")
    if not has_alloc:
        notes.append("no allocation")

    active = has_geom and has_alloc

    if active:
        print(f"Route {route_disp} active")
    else:
        # Match your earlier wording if neither present
        if not has_geom and not has_alloc:
            print(f"No active Route {route_disp} found.")
        else:
            print(f"Route {route_disp} inactive.")
        print("Note: " + ", ".join(notes))

    # ---- print the rest no matter what ----
    print(f"Vehicle: {vehicle}")

    if alloc:
        code = f" ({alloc['code']})" if alloc.get("code") else ""
        print(f"Allocation: operated by {alloc['operator']}, allocated to {alloc['garage']}{code}")
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
        print("Frequency: (missing frequencies.json entry)")

    # (optional nice extra: show where geometry file would be)
    if not has_geom:
        print(f"Geometry file: (missing) expected at {geom_path}")

    # ---- exit code ----
    if active:
        return 0
    if not has_geom and not has_alloc:
        return 2
    if has_geom and not has_alloc:
        return 3
    return 4  # allocation only


if __name__ == "__main__":
    raise SystemExit(main())
