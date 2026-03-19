"""
Regression tests for invariants across committed processed datasets.

These checks guard against accidental pipeline regressions by validating that
route geometry, allocations, vehicles, and cached frequencies remain internally
consistent.
"""
from __future__ import annotations

import json
import math
from functools import lru_cache
from pathlib import Path
from typing import Any, Dict, Iterable, List, Set, Tuple

from scripts import check_route
from scripts.utils.route_ids import (
    active_routes_from_geometry,
    is_700_series,
    is_excluded_route_id,
    normalize_route_id,
)


REPO_ROOT = Path(__file__).resolve().parents[1]
GEOM_DIR = REPO_ROOT / "data" / "processed" / "routes"
GARAGES_PATH = REPO_ROOT / "data" / "processed" / "garages.geojson"
FREQS_PATH = REPO_ROOT / "data" / "processed" / "frequencies.json"
VEHICLES_PATH = REPO_ROOT / "data" / "vehicles.json"

ALLOWED_VEHICLES = {"SD", "DD"}
MAX_BPH = 30


def _load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def _base_route(route: str) -> str:
    text = normalize_route_id(route)
    if len(text) > 1 and text[:-1].isdigit() and text[-1].isalpha():
        return text[:-1]
    return text


def _is_digit_suffix_variant(route: str) -> bool:
    text = normalize_route_id(route)
    return len(text) > 1 and text[:-1].isdigit() and text[-1].isalpha()


def _is_school_frequency_exempt(route: str) -> bool:
    text = _base_route(route)
    if not text.isdigit():
        return False
    value = int(text)
    return 600 <= value <= 699 or 900 <= value <= 999


def _geom_routes() -> List[str]:
    return sorted(active_routes_from_geometry(GEOM_DIR))


@lru_cache(maxsize=1)
def _garages_obj() -> Dict[str, Any]:
    return _load_json(GARAGES_PATH)


def _allocation_sets() -> Dict[str, Set[str]]:
    garages_obj = _garages_obj()
    buckets = {
        "main": "TfL main network routes",
        "night": "TfL night routes",
        "school/mobility": "TfL school/mobility routes",
        "other": "Other routes",
    }
    out: Dict[str, Set[str]] = {key: set() for key in buckets}
    for feat in garages_obj.get("features", []):
        props = feat.get("properties", {}) if isinstance(feat, dict) else {}
        for bucket, field in buckets.items():
            routes = {r for r in check_route.parse_routes_field(props.get(field)) if not is_700_series(r)}
            out[bucket].update(routes)
    return out


@lru_cache(maxsize=1)
def _vehicles_map() -> Dict[str, str]:
    obj = _load_json(VEHICLES_PATH)
    if not isinstance(obj, dict):
        return {}
    return {normalize_route_id(k): str(v).strip().upper() for k, v in obj.items()}


@lru_cache(maxsize=1)
def _freqs_map() -> Dict[str, Dict[str, Any]]:
    obj = _load_json(FREQS_PATH)
    if not isinstance(obj, dict):
        return {}
    out: Dict[str, Dict[str, Any]] = {}
    for key, value in obj.items():
        if not isinstance(value, dict):
            continue
        route_id = normalize_route_id(key)
        if not route_id or is_excluded_route_id(route_id):
            continue
        out[route_id] = value
    return out


def _freqs_for_route(route: str, freqs: Dict[str, Dict[str, Any]]) -> Dict[str, Any]:
    base = _base_route(route)
    return freqs.get(route) or freqs.get(base) or {}


def _route_category(route: str, allocations: Dict[str, Set[str]]) -> str:
    if route.startswith("N"):
        return "night"
    base = _base_route(route)
    in_main = base in allocations["main"]
    in_night = base in allocations["night"]
    if in_main and in_night:
        return "24hr"
    if in_main:
        return "regular"
    if base in allocations["school/mobility"]:
        return "school"
    return "other"


def _freq_values(entry: Dict[str, Any]) -> Tuple[float, float, float, float]:
    def coerce(value: Any) -> float:
        if value is None:
            return 0.0
        try:
            return float(value)
        except (TypeError, ValueError):
            return 0.0

    return (
        coerce(entry.get("peak_am")),
        coerce(entry.get("offpeak")),
        coerce(entry.get("peak_pm")),
        coerce(entry.get("overnight")),
    )


def _nonzero(values: Iterable[float]) -> bool:
    return any(v > 0 for v in values)


def test_routes_with_geometry_are_active() -> None:
    geom_routes = _geom_routes()
    allocations = _allocation_sets()
    inactive: List[str] = []
    for route in geom_routes:
        status = check_route.route_status(route, GEOM_DIR, GARAGES_PATH, FREQS_PATH, VEHICLES_PATH)
        if not status["active"]:
            if route.startswith("N"):
                day = route[1:]
                if day and day in geom_routes:
                    # Check if the day route is 24-hour
                    base_day = _base_route(day)
                    if base_day in allocations["main"] and base_day in allocations["night"]:
                        # It's a phantom N route for a 24-hour base, skip it
                        continue
                    # Also skip if day route is active and N route has no allocation/freq
                    if not status["has_alloc"] and not status["has_freq"]:
                        day_status = check_route.route_status(
                            day,
                            GEOM_DIR,
                            GARAGES_PATH,
                            FREQS_PATH,
                            VEHICLES_PATH,
                        )
                        if day_status["active"]:
                            continue
            missing = {
                name
                for name, flag in (
                    ("geometry", status["has_geom"]),
                    ("allocation", status["has_alloc"]),
                    ("vehicle", status["has_vehicle"]),
                    ("frequency", status["has_freq"] or not status.get("expects_freq", True)),
                )
                if not flag
            }
            if _is_digit_suffix_variant(route):
                base = _base_route(route)
                if base and base in geom_routes and missing.issubset({"allocation", "frequency"}):
                    continue
            inactive.append(f"{route}: missing {', '.join(sorted(missing))}")
    assert not inactive, "Inactive routes with geometry:\n" + "\n".join(inactive[:40])


def test_allocated_routes_have_geometry() -> None:
    allocations = _allocation_sets()
    allocated_routes = set().union(*allocations.values())
    missing: List[str] = []
    for route in sorted(allocated_routes):
        geom_path = check_route.route_geom_path(route, GEOM_DIR)
        has_geom, _ = check_route.geom_is_present(geom_path, route)
        if not has_geom:
            missing.append(route)
    assert not missing, "Allocated routes missing geometry:\n" + ", ".join(missing[:60])


def test_routes_have_valid_vehicle() -> None:
    vehicles = _vehicles_map()
    missing: List[str] = []
    invalid: List[str] = []
    for route in _geom_routes():
        value = vehicles.get(route)
        if not value:
            missing.append(route)
            continue
        if value not in ALLOWED_VEHICLES:
            invalid.append(f"{route}={value}")
    assert not missing, "Routes missing vehicles:\n" + ", ".join(missing[:60])
    assert not invalid, "Routes with invalid vehicles:\n" + ", ".join(invalid[:60])


def test_frequency_values_within_bounds() -> None:
    freqs = _freqs_map()
    violations: List[str] = []
    for route, entry in freqs.items():
        if (
            _is_school_frequency_exempt(route)
            or is_700_series(route)
            or is_excluded_route_id(route)
        ):
            continue
        for key, value in entry.items():
            if value is None:
                continue
            try:
                num = float(value)
            except (TypeError, ValueError):
                continue
            if num > MAX_BPH:
                violations.append(f"{route}.{key}={num}")
    assert not violations, "Frequencies above max bph:\n" + ", ".join(violations[:60])


def test_frequency_rules_by_route_type() -> None:
    allocations = _allocation_sets()
    freqs = _freqs_map()
    geom_routes = set(_geom_routes())
    errors: List[str] = []
    for route in sorted(geom_routes):
        if _is_school_frequency_exempt(route):
            continue
        entry = _freqs_for_route(route, freqs)
        if not isinstance(entry, dict) or not entry:
            if _is_digit_suffix_variant(route):
                base = _base_route(route)
                if base and base in geom_routes:
                    continue
            errors.append(f"{route}: missing frequency entry")
            continue
        peak_am, offpeak, peak_pm, overnight = _freq_values(entry)
        daytime = (peak_am, offpeak, peak_pm)
        total = peak_am + offpeak + peak_pm + overnight
        category = _route_category(route, allocations)

        is_school = category == "school" or _is_school_frequency_exempt(route)
        if math.isclose(total, 0.0) and not is_school:
            errors.append(f"{route}: all-zero frequency")

        if category in {"regular", "24hr"} and not _nonzero(daytime):
            errors.append(f"{route}: no daytime frequency for {category} route")

        if category == "regular" and overnight != 0:
            errors.append(f"{route}: regular route has overnight={overnight}")

        if category == "night":
            if overnight <= 0:
                errors.append(f"{route}: night route missing overnight frequency")
            if _nonzero(daytime):
                errors.append(f"{route}: night route has daytime frequency")

        if category == "24hr":
            if not _nonzero(daytime) or overnight <= 0:
                errors.append(f"{route}: 24hr route missing time band values")
            elif any(v <= 0 for v in (peak_am, offpeak, peak_pm, overnight)):
                errors.append(f"{route}: 24hr route has zero in a time band")

    assert not errors, "Frequency rule violations:\n" + "\n".join(errors[:600])


def test_garage_pvr_percentages_sum_to_100() -> None:
    garages = _garages_obj()
    values: List[float] = []
    for feat in garages.get("features", []):
        props = feat.get("properties", {}) if isinstance(feat, dict) else {}
        raw = props.get("Proportion of network")
        if raw is None:
            continue
        text = str(raw).strip()
        if not text:
            continue
        if text.endswith("%"):
            text = text[:-1].strip()
        try:
            values.append(float(text))
        except ValueError:
            continue
    total = sum(values)
    assert abs(total - 100.0) <= 0.2, f"PVR proportions sum to {total:.2f}%"


def test_garage_allocations_are_consistent() -> None:
    allocations = _allocation_sets()
    main_routes = allocations["main"]
    night_routes = allocations["night"]
    school_routes = allocations["school/mobility"]

    errors: List[str] = []
    for route in sorted(main_routes):
        if route.startswith("N"):
            errors.append(f"{route}: night route listed under main network")

    for route in sorted(night_routes):
        if route.startswith("N"):
            continue
        if route not in main_routes:
            errors.append(f"{route}: night list route not in main network (expected 24hr)")

    for route in sorted(school_routes):
        if route in main_routes:
            continue
        if not _is_school_frequency_exempt(route):
            errors.append(f"{route}: school/mobility route not in 600/900 series")

    assert not errors, "Garage allocation violations:\n" + "\n".join(errors[:60])
