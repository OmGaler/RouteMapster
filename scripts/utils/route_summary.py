"""
Build route-level summary data from processed RouteMapster inputs.

This module underpins the route summary script and several tests by combining
garage allocations, vehicle metadata, cached destinations, and route geometry
into a single row-oriented representation.
"""
from __future__ import annotations

import json
import math
import re
from pathlib import Path
from statistics import mean
from typing import Any, Dict, Iterable, List, Optional, Sequence, Set, Tuple, Union

from .route_ids import is_excluded_route_id, is_700_series, normalize_route_id

GARAGE_FIELDS = (
    "TfL main network routes",
    "TfL night routes",
    "TfL school/mobility routes",
    "Other routes",
)
SUFFIX_ROUTE_RE = re.compile(r"^(\d+)([A-Z]+)$")
KM_TO_MILES = 0.621371


def is_tram_feature(props: Dict[str, Any]) -> bool:
    """Return whether a garage feature belongs to the tram network."""
    company = str(props.get("Company name") or "").strip().lower()
    group = str(props.get("Group name") or "").strip().lower()
    garage = str(props.get("Garage name") or "").strip().lower()
    if "tram" in company or "tram" in group:
        return True
    if "therapia lane" in garage:
        return True
    return False


def parse_route_tokens(value: Any) -> List[str]:
    """Parse and normalise route ids from a free-text allocation field.

    Args:
        value: Raw field value containing one or more route tokens.

    Returns:
        Normalised route ids in source order, excluding unsupported routes.
    """
    if not value:
        return []
    tokens: List[str] = []
    for raw in re.split(r"[\s,;/]+", str(value)):
        cleaned = re.sub(r"[^A-Za-z0-9]", "", raw.strip())
        if not cleaned:
            continue
        normalized = normalize_route_id(cleaned)
        if not normalized:
            continue
        if is_excluded_route_id(normalized) or is_700_series(normalized):
            continue
        tokens.append(normalized)
    return tokens


def build_route_sets(features: Sequence[Dict[str, Any]]) -> Dict[str, Set[str]]:
    """Group allocated routes into the categories used by RouteMapster.

    Args:
        features: Garage GeoJSON features with allocation properties.

    Returns:
        Route id sets keyed by category, including a helper set for school overlaps.
    """
    regular: Set[str] = set()
    night: Set[str] = set()
    school: Set[str] = set()
    other: Set[str] = set()
    twentyfour: Set[str] = set()
    school_overlaps: Set[str] = set()

    for feature in features:
        props = feature.get("properties") or {}
        if is_tram_feature(props):
            continue
        main_tokens = set(parse_route_tokens(props.get("TfL main network routes")))
        school_tokens = set(parse_route_tokens(props.get("TfL school/mobility routes")))
        regular.update(main_tokens)
        school.update(school_tokens)
        school_overlaps.update(main_tokens.intersection(school_tokens))
        other.update(parse_route_tokens(props.get("Other routes")))

        night_tokens = parse_route_tokens(props.get("TfL night routes"))
        for token in night_tokens:
            if token.startswith("N"):
                night.add(token)
            else:
                twentyfour.add(token)

    for route in list(school):
        if route in regular or route in night or route in other or route in twentyfour:
            school.discard(route)

    return {
        "regular": regular,
        "night": night,
        "school": school,
        "other": other,
        "twentyfour": twentyfour,
        "school_overlaps": school_overlaps,
    }


def build_route_garage_map(features: Sequence[Dict[str, Any]]) -> Dict[str, Set[Tuple[str, str, str]]]:
    """Map each route id to the garages and operators that claim it."""
    route_map: Dict[str, Set[Tuple[str, str, str]]] = {}
    for feature in features:
        props = feature.get("properties") or {}
        if is_tram_feature(props):
            continue
        code = (props.get("TfL garage code") or props.get("LBR garage code") or "").strip().upper()
        if not code:
            continue
        name = str(props.get("Garage name") or "").strip()
        operator = str(props.get("Group name") or "").strip()

        for field in GARAGE_FIELDS:
            for route_id in parse_route_tokens(props.get(field)):
                route_map.setdefault(route_id, set()).add((code, name, operator))
    return route_map


def classify_route(route_id: str, route_sets: Dict[str, Set[str]]) -> str:
    """Classify a route using the precomputed route-category sets."""
    route = normalize_route_id(route_id)
    if route.startswith("N"):
        return "night"
    if route in route_sets.get("twentyfour", set()):
        return "twentyfour"
    if route in route_sets.get("school", set()):
        return "school"
    if route in route_sets.get("regular", set()):
        return "regular"
    if route in route_sets.get("other", set()):
        return "other"
    return "unknown"


def parse_routes_index(path: Path) -> List[str]:
    """Load the canonical route list from the processed routes index."""
    if not path.exists():
        return []
    payload = json.loads(path.read_text(encoding="utf-8"))
    routes = payload.get("routes")
    if isinstance(routes, list):
        return [normalize_route_id(route) for route in routes if normalize_route_id(route)]
    return []


def parse_prefix_number(value: str) -> int:
    match = re.match(r"^\d+", value)
    return int(match.group(0)) if match else 0


def route_sort_key(route_id: str) -> Tuple[int, str, int, str]:
    """Build a stable sort key matching the application's route ordering."""
    raw = normalize_route_id(route_id)
    if not raw:
        return (9, "", 0, "")
    if raw.isdigit():
        value = int(raw)
        if 1 <= value <= 599:
            return (0, "", value, raw)
        if 600 <= value <= 699:
            return (1, "", value, raw)
        return (2, "", value, raw)
    if raw.startswith("SL"):
        return (4, "SL", parse_prefix_number(raw[2:]), raw)
    if raw.startswith("N"):
        return (5, "N", parse_prefix_number(raw[1:]), raw)
    match = re.match(r"^([A-Z]+)(\d+)?(.*)$", raw)
    if match:
        prefix, number, suffix = match.groups()
        number_val = int(number) if number else 0
        return (3, prefix, number_val, suffix or "")
    return (9, raw, 0, "")


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Return the great-circle distance between two coordinates in kilometres."""
    radius = 6371.0088
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2
    return 2 * radius * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def line_length_km(coords: Iterable[Any]) -> float:
    """Measure the length of a GeoJSON line in kilometres."""
    points: List[Tuple[float, float]] = []
    for point in coords:
        if not isinstance(point, (list, tuple)) or len(point) < 2:
            continue
        lon = float(point[0])
        lat = float(point[1])
        if not math.isfinite(lat) or not math.isfinite(lon):
            continue
        points.append((lat, lon))
    if len(points) < 2:
        return 0.0
    total = 0.0
    for i in range(1, len(points)):
        lat1, lon1 = points[i - 1]
        lat2, lon2 = points[i]
        total += haversine_km(lat1, lon1, lat2, lon2)
    return total


def geometry_length_km(geometry: Dict[str, Any]) -> float:
    """Measure a GeoJSON line or multiline geometry in kilometres."""
    if not geometry or "type" not in geometry:
        return 0.0
    geom_type = geometry.get("type")
    if geom_type == "LineString":
        coords = geometry.get("coordinates") or []
        return line_length_km(coords)
    if geom_type == "MultiLineString":
        longest = 0.0
        for segment in geometry.get("coordinates") or []:
            longest = max(longest, line_length_km(segment))
        return longest
    return 0.0


def route_length_km(route_geojson: Dict[str, Any]) -> Optional[float]:
    """Estimate a route length from the mean length of its line features."""
    features = route_geojson.get("features")
    if not isinstance(features, list):
        return None
    lengths = []
    for feature in features:
        if not isinstance(feature, dict):
            continue
        length = geometry_length_km(feature.get("geometry") or {})
        if length > 0:
            lengths.append(length)
    if not lengths:
        return None
    return mean(lengths)


def format_join(values: Iterable[str]) -> str:
    """Join unique non-empty strings with the project-standard separator."""
    uniq = sorted({value for value in values if value})
    return "; ".join(uniq)


def collect_route_ids(
    routes_dir: Path,
    routes_index: Path,
    frequencies: Dict[str, Any],
    route_garages: Dict[str, Set[Tuple[str, str, str]]],
    vehicles: Optional[Dict[str, str]] = None,
) -> Set[str]:
    """Collect the complete route universe from processed pipeline inputs."""
    route_ids: Set[str] = set()
    route_ids.update(parse_routes_index(routes_index))
    route_ids.update(normalize_route_id(route_id) for route_id in frequencies.keys())
    route_ids.update(route_garages.keys())
    if vehicles:
        route_ids.update(vehicles.keys())

    if routes_dir.exists():
        for path in routes_dir.glob("*.geojson"):
            route_id = normalize_route_id(path.stem)
            if route_id:
                route_ids.add(route_id)
    return route_ids


def load_vehicles_map(path: Path) -> Dict[str, str]:
    """Load the route-to-vehicle lookup from the committed vehicle mapping."""
    if not path.exists():
        return {}
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        return {}
    out: Dict[str, str] = {}
    for key, value in payload.items():
        route_id = normalize_route_id(key)
        if not route_id:
            continue
        out[route_id] = str(value).strip().upper()
    return out


def load_route_destinations_map(path: Path) -> Dict[str, Dict[str, str]]:
    """Load cached route destination text keyed by normalised route id."""
    if not path.exists():
        return {}
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        return {}
    routes_payload = payload.get("routes")
    routes = routes_payload if isinstance(routes_payload, dict) else payload
    out: Dict[str, Dict[str, str]] = {}
    for key, value in routes.items():
        route_id = normalize_route_id(key)
        if not route_id or not isinstance(value, dict):
            continue
        out[route_id] = {
            "destination_outbound": str(value.get("outbound", {}).get("destination") or "").strip(),
            "destination_inbound": str(value.get("inbound", {}).get("destination") or "").strip(),
            "destination_outbound_qualifier": str(value.get("outbound", {}).get("qualifier") or "").strip(),
            "destination_inbound_qualifier": str(value.get("inbound", {}).get("qualifier") or "").strip(),
            "destination_outbound_full": str(value.get("outbound", {}).get("full") or "").strip(),
            "destination_inbound_full": str(value.get("inbound", {}).get("full") or "").strip(),
        }
    return out


def split_suffix_route(route_id: str) -> Tuple[str, str]:
    """Split route ids such as `108D` into base and suffix components."""
    match = SUFFIX_ROUTE_RE.match(route_id)
    if not match:
        return route_id, ""
    return match.group(1), match.group(2)


def build_route_summary_rows(
    garages_path: Path,
    frequencies_path: Path,
    routes_dir: Path,
    routes_index_path: Path,
    vehicles_path: Path,
    destinations_path: Path,
    include_excluded: bool = False,
    include_length: bool = True,
) -> List[Dict[str, Any]]:
    """Build route summary rows from processed pipeline artefacts.

    Args:
        garages_path: Path to processed garage allocations.
        frequencies_path: Path to cached per-band frequency values.
        routes_dir: Directory containing processed route geometries.
        routes_index_path: Path to the processed route index.
        vehicles_path: Path to the vehicle lookup JSON.
        destinations_path: Path to cached route destination text.
        include_excluded: Whether to keep excluded special routes.
        include_length: Whether to calculate route length from geometry.

    Returns:
        Route summary rows ready for DataFrame conversion or CSV export.

    Side effects:
        Reads several processed JSON and GeoJSON files from disk.
    """
    if garages_path.exists():
        garages = json.loads(garages_path.read_text(encoding="utf-8"))
        features = garages.get("features") or []
    else:
        features = []

    route_sets = build_route_sets(features)
    route_garages = build_route_garage_map(features)
    vehicles = load_vehicles_map(vehicles_path)
    destinations = load_route_destinations_map(destinations_path)

    if frequencies_path.exists():
        frequencies = json.loads(frequencies_path.read_text(encoding="utf-8"))
        if not isinstance(frequencies, dict):
            frequencies = {}
    else:
        frequencies = {}

    route_ids = collect_route_ids(routes_dir, routes_index_path, frequencies, route_garages, vehicles)
    additional_journeys: Dict[str, Set[str]] = {}

    candidates = set(route_ids)
    candidates.update(vehicles.keys())

    filtered_route_ids: Set[str] = set()
    for route_id in candidates:
        base, suffix = split_suffix_route(route_id)
        if suffix:
            # Suffix variants are counted as additional journeys on the base route
            # so the summary keeps one primary row per public route id.
            additional_journeys.setdefault(base, set()).add(route_id)
            filtered_route_ids.add(base)
        else:
            filtered_route_ids.add(route_id)
    route_ids = {route_id for route_id in filtered_route_ids if route_id}

    for route_id in route_sets.get("school_overlaps", set()):
        additional_journeys.setdefault(route_id, set()).add(f"{route_id}S")
        route_ids.add(route_id)

    ghost_filtered: Set[str] = set()
    night_routes = route_sets.get("night", set())
    twentyfour_routes = route_sets.get("twentyfour", set())
    for route_id in route_ids:
        if route_id.startswith("N"):
            base = route_id[1:]
            if route_id not in night_routes and base in twentyfour_routes:
                continue
        ghost_filtered.add(route_id)
    route_ids = ghost_filtered

    rows: List[Dict[str, Any]] = []
    for route_id in sorted(route_ids, key=route_sort_key):
        if not route_id:
            continue
        if not include_excluded and (is_excluded_route_id(route_id) or is_700_series(route_id)):
            continue

        garage_entries = route_garages.get(route_id, set())
        garage_codes = format_join(entry[0] for entry in garage_entries)
        garage_names = format_join(entry[1] for entry in garage_entries)
        operators = format_join(entry[2] for entry in garage_entries)

        freq = frequencies.get(route_id) if isinstance(frequencies, dict) else None
        peak_am = freq.get("peak_am") if isinstance(freq, dict) else None
        peak_pm = freq.get("peak_pm") if isinstance(freq, dict) else None
        offpeak = freq.get("offpeak") if isinstance(freq, dict) else None
        overnight = freq.get("overnight") if isinstance(freq, dict) else None
        weekend = freq.get("weekend") if isinstance(freq, dict) else None
        if weekend is None:
            weekend = 0
        vehicle = vehicles.get(route_id)
        destination_data = destinations.get(route_id, {})
        additional = format_join(additional_journeys.get(route_id, set()))

        length_km = None
        length_miles = None
        if include_length:
            route_file = routes_dir / f"{route_id}.geojson"
            if route_file.exists():
                payload = json.loads(route_file.read_text(encoding="utf-8"))
                raw_length_km = route_length_km(payload)
                if raw_length_km is not None:
                    length_km = round(raw_length_km, 3)
                    length_miles = round(raw_length_km * KM_TO_MILES, 3)

        rows.append(
            {
                "route": route_id,
                "route_type": classify_route(route_id, route_sets),
                "garage_code": garage_codes,
                "garage_name": garage_names,
                "operator": operators,
                "vehicle": vehicle,
                "destination_outbound": destination_data.get("destination_outbound", ""),
                "destination_inbound": destination_data.get("destination_inbound", ""),
                "destination_outbound_qualifier": destination_data.get("destination_outbound_qualifier", ""),
                "destination_inbound_qualifier": destination_data.get("destination_inbound_qualifier", ""),
                "destination_outbound_full": destination_data.get("destination_outbound_full", ""),
                "destination_inbound_full": destination_data.get("destination_inbound_full", ""),
                "additional_journeys": additional,
                "frequency_peak_am": peak_am,
                "frequency_peak_pm": peak_pm,
                "frequency_offpeak": offpeak,
                "frequency_overnight": overnight,
                "frequency_weekend": weekend,
                "length_km": length_km,
                "length_miles": length_miles,
            }
        )

    return rows


def build_route_summary_df(
    garages_path: Union[Path, str] = "data/processed/garages.geojson",
    frequencies_path: Union[Path, str] = "data/processed/frequencies.json",
    routes_dir: Union[Path, str] = "data/processed/routes",
    routes_index_path: Union[Path, str] = "data/processed/routes/index.json",
    vehicles_path: Union[Path, str] = "data/vehicles.json",
    destinations_path: Union[Path, str] = "data/processed/route_destinations.json",
    include_excluded: bool = False,
    include_length: bool = True,
) -> pd.DataFrame:
    """Build the route summary as a pandas DataFrame.

    Args:
        garages_path: Path to processed garage allocations.
        frequencies_path: Path to cached per-band frequency values.
        routes_dir: Directory containing processed route geometries.
        routes_index_path: Path to the processed route index.
        vehicles_path: Path to the vehicle lookup JSON.
        destinations_path: Path to cached route destination text.
        include_excluded: Whether to keep excluded special routes.
        include_length: Whether to calculate route length from geometry.

    Returns:
        A DataFrame with stable columns used by the browser application.

    Side effects:
        Imports `pandas` lazily and reads processed pipeline artefacts from disk.
    """
    import pandas as pd

    garages = Path(garages_path)
    frequencies = Path(frequencies_path)
    routes = Path(routes_dir)
    routes_index = Path(routes_index_path)
    vehicles = Path(vehicles_path)
    destinations = Path(destinations_path)

    rows = build_route_summary_rows(
        garages,
        frequencies,
        routes,
        routes_index,
        vehicles,
        destinations,
        include_excluded=include_excluded,
        include_length=include_length,
    )

    columns = [
        "route",
        "route_type",
        "garage_code",
        "garage_name",
        "operator",
        "vehicle",
        "destination_outbound",
        "destination_inbound",
        "destination_outbound_qualifier",
        "destination_inbound_qualifier",
        "destination_outbound_full",
        "destination_inbound_full",
        "additional_journeys",
        "frequency_peak_am",
        "frequency_peak_pm",
        "frequency_offpeak",
        "frequency_overnight",
        "frequency_weekend",
        "length_km",
        "length_miles",
    ]
    df = pd.DataFrame(rows)
    if df.empty:
        return df
    return df.reindex(columns=columns)
