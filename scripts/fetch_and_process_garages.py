#!/usr/bin/env python3
"""
Fetch London bus garages CSV and convert to slimmed GeoJSON.

Data source:
http://www.londonbusroutes.net/garages.htm
"""

from __future__ import annotations

import argparse
import csv
import json
import logging
import re
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import requests

from geojsonify_garages import (
    POSTCODE_RE,
    apply_route_fixes_to_rows,
    bulk_lookup_postcodes,
    chunks,
    extract_postcode,
    load_cache,
    pick_address,
    save_cache,
)

GARAGES_PAGE = "http://www.londonbusroutes.net/garages.htm"
GARAGES_CSV = "http://www.londonbusroutes.net/garages.csv"
RAW_OUTPUT_DIR = Path("data/raw/garages")
PROCESSED_OUTPUT = Path("data/processed/garages.geojson")
BASE_INPUT = Path("data/garages-base.geojson")

GARAGE_PROPERTIES = [
    "Group name",
    "Company name",
    "LBR garage code",
    "Garage name",
    "Garage address",
    "TfL main network routes",
    "TfL night routes",
    "TfL school/mobility routes",
    "Other routes",
    "PVR",
    "TfL garage code",
    "Proportion of network",
    "_geocode_source",
    "_geocode_postcode",
    "_geocode_admin_district",
    "_geocode_country",
]

ROUTE_FIELDS = {
    "TfL main network routes",
    "TfL night routes",
    "TfL school/mobility routes",
    "Other routes",
}

# For garages already present in the processed GeoJSON, we mostly "lock" properties to preserve
# manual fixes — BUT these specific fields should track upstream changes too.
NON_ROUTE_FIELDS_TO_UPDATE = {
    "PVR",
    "Proportion of network",
}


def setup_logging(verbose: bool) -> None:
    level = logging.DEBUG if verbose else logging.INFO
    logging.basicConfig(
        level=level,
        format="%(asctime)s | %(levelname)s | %(message)s",
        datefmt="%H:%M:%S",
    )


def parse_date_from_text(text: str) -> Optional[str]:
    if not text:
        return None

    match = re.findall(r"(20\d{2})[-_/]?(\d{2})[-_/]?(\d{2})", text)
    if match:
        year, month, day = match[-1]
        return f"{year}{month}{day}"

    match = re.findall(r"(\d{1,2})\s+([A-Za-z]+)\s+(20\d{2})", text)
    if match:
        day_str, month_name, year_str = match[-1]
        months = {
            "jan": 1,
            "january": 1,
            "feb": 2,
            "february": 2,
            "mar": 3,
            "march": 3,
            "apr": 4,
            "april": 4,
            "may": 5,
            "jun": 6,
            "june": 6,
            "jul": 7,
            "july": 7,
            "aug": 8,
            "august": 8,
            "sep": 9,
            "sept": 9,
            "september": 9,
            "oct": 10,
            "october": 10,
            "nov": 11,
            "november": 11,
            "dec": 12,
            "december": 12,
        }
        month = months.get(month_name.lower())
        if month:
            return f"{int(year_str):04d}{month:02d}{int(day_str):02d}"

    return None


def fetch_page_and_date(session: requests.Session, url: str) -> Tuple[str, Optional[str]]:
    resp = session.get(url, timeout=60)
    resp.raise_for_status()
    html = resp.text
    date_token = parse_date_from_text(html)
    return html, date_token


def read_csv_rows(path: Path) -> List[Dict[str, Any]]:
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        return list(reader)


def get_garage_code(row: Dict[str, Any]) -> str:
    code = row.get("TfL garage code") or row.get("LBR garage code") or ""
    return str(code).strip().upper()


def load_existing_map_from_payload(
    data: Any,
) -> Tuple[Dict[str, Dict[str, Any]], List[Dict[str, Any]]]:
    """
    Returns (by_code, unnamed_features):
      by_code: { GARAGE_CODE: {"properties": <dict>, "geometry": <dict>} }
      unnamed_features: [{"properties": <dict>, "geometry": <dict>}, ...] for missing codes
    """
    if not isinstance(data, dict):
        return {}, []

    features = data.get("features") or []
    out: Dict[str, Dict[str, Any]] = {}
    unnamed: List[Dict[str, Any]] = []
    for feature in features:
        props = feature.get("properties") or {}
        geom = feature.get("geometry") or {}
        code = str(props.get("TfL garage code") or props.get("LBR garage code") or "").strip().upper()
        if code:
            out[code] = {"properties": props, "geometry": geom}
        else:
            unnamed.append({"properties": props, "geometry": geom})
    return out, unnamed


def load_existing_map(path: Path) -> Tuple[Dict[str, Dict[str, Any]], List[Dict[str, Any]]]:
    """
    Returns (by_code, unnamed_features):
      by_code: { GARAGE_CODE: {"properties": <dict>, "geometry": <dict>} }
      unnamed_features: [{"properties": <dict>, "geometry": <dict>}, ...] for missing codes
    """
    if not path.exists():
        return {}, []

    with path.open("r", encoding="utf-8") as handle:
        data = json.load(handle)
    return load_existing_map_from_payload(data)




def merge_existing_maps(
    primary: Tuple[Dict[str, Dict[str, Any]], List[Dict[str, Any]]],
    secondary: Tuple[Dict[str, Dict[str, Any]], List[Dict[str, Any]]],
) -> Tuple[Dict[str, Dict[str, Any]], List[Dict[str, Any]]]:
    primary_map, primary_unnamed = primary
    secondary_map, secondary_unnamed = secondary
    merged_map = dict(primary_map)
    for code, entry in secondary_map.items():
        if code and code not in merged_map:
            merged_map[code] = entry
    merged_unnamed = list(primary_unnamed) + list(secondary_unnamed)
    return merged_map, merged_unnamed


_NAME_STOPWORDS = {
    "bus",
    "depot",
    "garage",
    "works",
}


def normalize_name(value: Any) -> str:
    text = str(value or "").strip().lower()
    text = re.sub(r"\([^)]*\)", " ", text)
    text = re.sub(r"[^a-z0-9]+", " ", text)
    parts = [p for p in text.split() if p and p not in _NAME_STOPWORDS]
    return " ".join(parts)


def normalize_address(value: Any) -> str:
    text = str(value or "").strip().lower()
    text = POSTCODE_RE.sub(" ", text)
    text = re.sub(r"[^a-z0-9]+", " ", text)
    return " ".join(text.split())


def token_set(value: Any, *, is_name: bool) -> set[str]:
    text = normalize_name(value) if is_name else normalize_address(value)
    return {token for token in text.split() if token}


def compare_non_route_fields(rows: List[Dict[str, Any]], existing: Dict[str, Dict[str, Any]]) -> None:
    # Warn only for fields we *intend* to remain locked.
    for row in rows:
        code = get_garage_code(row)
        if not code or code not in existing:
            continue
        prev = existing[code]["properties"]
        for key, value in row.items():
            if key in ROUTE_FIELDS:
                continue
            if key in NON_ROUTE_FIELDS_TO_UPDATE:
                # These are expected to change and will be updated.
                continue
            if key not in GARAGE_PROPERTIES:
                continue
            prev_value = prev.get(key)
            if prev_value is None:
                continue
            if str(prev_value).strip() != str(value).strip():
                logging.warning("Non-route field changed for %s: %s", code, key)


def build_features(
    rows: List[Dict[str, Any]],
    cache: Dict[str, Dict[str, Any]],
    existing_map: Dict[str, Dict[str, Any]],
    unnamed_existing: List[Dict[str, Any]],
    address_col: str,
    fallback_address_col: str,
    precision: int,
) -> List[Dict[str, Any]]:
    features: List[Dict[str, Any]] = []
    used_existing: set[int] = set()

    name_index: Dict[str, List[Dict[str, Any]]] = {}
    existing_entries = list(existing_map.values()) + list(unnamed_existing)
    for entry in existing_entries:
        name = normalize_name(entry.get("properties", {}).get("Garage name"))
        if name:
            name_index.setdefault(name, []).append(entry)

    for row in rows:
        code = get_garage_code(row)
        existing = existing_map.get(code) if code else None
        if not existing:
            name_key = normalize_name(row.get("Garage name"))
            candidates = name_index.get(name_key) or []
            existing = next((entry for entry in candidates if id(entry) not in used_existing), None)

        if not existing:
            row_name_tokens = token_set(row.get("Garage name"), is_name=True)
            row_addr_tokens = token_set(row.get(address_col), is_name=False) | token_set(
                row.get(fallback_address_col), is_name=False
            )
            best_entry = None
            best_score = 0.0
            for entry in existing_entries:
                if id(entry) in used_existing:
                    continue
                props = entry.get("properties", {})
                entry_name_tokens = token_set(props.get("Garage name"), is_name=True)
                name_score = 0.0
                if row_name_tokens and entry_name_tokens:
                    name_intersection = row_name_tokens & entry_name_tokens
                    name_union = row_name_tokens | entry_name_tokens
                    name_score = len(name_intersection) / len(name_union)

                entry_addr_tokens = token_set(props.get("Garage address"), is_name=False)
                addr_union = row_addr_tokens | entry_addr_tokens
                if row_addr_tokens and entry_addr_tokens and addr_union:
                    addr_score = len(row_addr_tokens & entry_addr_tokens) / len(addr_union)
                else:
                    addr_score = 0.0

                candidate_score = max(name_score, addr_score)
                if name_score >= 0.5 or (addr_score >= 0.7 and name_score >= 0.2):
                    if candidate_score > best_score:
                        best_score = candidate_score
                        best_entry = entry
            if best_entry:
                existing = best_entry

        # If we already have this garage in the processed GeoJSON:
        # LOCK geometry + non-route fields (preserve manual fixes),
        # update route allocations and selected metrics (PVR / % network).
        if existing:
            props = dict(existing["properties"])

            # Always refresh route fields from upstream CSV
            for rf in ROUTE_FIELDS:
                props[rf] = (row.get(rf) or "").strip()

            # Refresh selected non-route fields from upstream CSV
            for k in NON_ROUTE_FIELDS_TO_UPDATE:
                if k in row:
                    props[k] = (row.get(k) or "").strip()

            features.append(
                {
                    "type": "Feature",
                    "geometry": existing["geometry"],
                    "properties": props,
                }
            )
            used_existing.add(id(existing))
            continue

        # Otherwise this is a genuinely new garage: geocode + create full props.
        addr = pick_address(row, address_col, fallback_address_col)
        postcode = extract_postcode(addr or "")
        if not postcode:
            logging.warning("Skipping NEW row without postcode: %s", row.get("Garage name") or code)
            continue

        entry = cache.get(postcode)
        if not entry or entry.get("_failed"):
            logging.warning("Skipping NEW row with failed geocode: %s (%s)", row.get("Garage name"), postcode)
            continue

        lon = round(float(entry["lon"]), precision)
        lat = round(float(entry["lat"]), precision)
        if lon == -0.0:
            lon = 0.0
        if lat == -0.0:
            lat = 0.0

        props = {key: row.get(key, "") for key in GARAGE_PROPERTIES if not key.startswith("_geocode_")}
        props["_geocode_source"] = "postcodes.io"
        props["_geocode_postcode"] = postcode
        props["_geocode_admin_district"] = entry.get("admin_district")
        props["_geocode_country"] = entry.get("country")

        features.append(
            {
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": [lon, lat]},
                "properties": props,
            }
        )

    features.sort(key=lambda feat: get_garage_code(feat.get("properties", {})))

    for entry in list(existing_map.values()) + list(unnamed_existing):
        if id(entry) in used_existing:
            continue
        features.append(
            {
                "type": "Feature",
                "geometry": entry.get("geometry"),
                "properties": entry.get("properties", {}),
            }
        )
    features.sort(key=lambda feat: get_garage_code(feat.get("properties", {})))
    return features


def write_geojson(path: Path, features: List[Dict[str, Any]], metadata: Dict[str, Any]) -> None:
    payload = {"type": "FeatureCollection", "metadata": metadata, "features": features}
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=True, separators=(",", ":"))


def main() -> int:
    """Fetch garage source data and rebuild the processed garage GeoJSON.

    Returns:
        Process exit code for CLI usage.

    Side effects:
        Downloads upstream garage data, refreshes geocoding cache entries, and
        writes raw and processed outputs to disk.
    """
    parser = argparse.ArgumentParser(description="Fetch and process London bus garages data.")
    parser.add_argument("--page-url", default=GARAGES_PAGE, help="Source page URL for garages data.")
    parser.add_argument("--csv-url", default=GARAGES_CSV, help="CSV download URL for garages data.")
    parser.add_argument("--input", default="", help="Local garages CSV file (skip download).")
    parser.add_argument(
        "--base",
        default="",
        help="Base GeoJSON to preserve manual fixes (defaults to data/garages-base.geojson if present, else output file).",
    )
    parser.add_argument("--output", default=str(PROCESSED_OUTPUT), help="Output GeoJSON path.")
    parser.add_argument("--cache", default="scripts/geocode_cache.json", help="Geocode cache path.")
    parser.add_argument("--address-col", default="Garage address", help="Primary address column.")
    parser.add_argument("--fallback-address-col", default="Company address", help="Fallback address column.")
    parser.add_argument("--bulk-size", type=int, default=100, help="Bulk lookup size for postcodes.io.")
    parser.add_argument("--pause", type=float, default=0.2, help="Pause between bulk requests.")
    parser.add_argument("--precision", type=int, default=6, help="Coordinate precision.")
    parser.add_argument("--force", action="store_true", help="Process even if source date is unchanged.")
    parser.add_argument("--verbose", action="store_true", help="Verbose logging.")
    args = parser.parse_args()

    setup_logging(args.verbose)

    session = requests.Session()
    session.headers.update({"User-Agent": "routemapster-data-pipeline/1.0"})

    source_date = None
    if not args.input:
        _, source_date = fetch_page_and_date(session, args.page_url)
        logging.info("Garages source date: %s", source_date or "unknown")
    existing_path = Path(args.output)
    if existing_path.exists() and source_date and not args.force:
        with existing_path.open("r", encoding="utf-8") as handle:
            existing = json.load(handle)
        prev_date = existing.get("metadata", {}).get("source_date") or existing.get("date")
        if prev_date and str(prev_date) >= str(source_date):
            logging.info("Garages data is not newer than existing output. Skipping.")
            return 0

    if args.input:
        csv_path = Path(args.input)
    else:
        RAW_OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
        csv_path = RAW_OUTPUT_DIR / "garages.csv"
        resp = session.get(args.csv_url, timeout=60)
        resp.raise_for_status()
        csv_path.write_bytes(resp.content)

    rows = read_csv_rows(csv_path)
    apply_route_fixes_to_rows(rows)

    base_path = Path(args.base) if args.base else (BASE_INPUT if BASE_INPUT.exists() else existing_path)
    base_map = load_existing_map(base_path) if base_path.exists() else ({}, [])
    existing_map, unnamed_existing = load_existing_map(existing_path)
    existing_map, unnamed_existing = merge_existing_maps(base_map, (existing_map, unnamed_existing))
    if existing_map:
        compare_non_route_fields(rows, existing_map)

    cache_path = Path(args.cache)
    cache = load_cache(cache_path)

    postcodes = []
    for row in rows:
        addr = pick_address(row, args.address_col, args.fallback_address_col)
        pc = extract_postcode(addr or "")
        if pc:
            postcodes.append(pc)

    missing = sorted({pc for pc in postcodes if pc and pc not in cache})
    for batch in chunks(missing, args.bulk_size):
        logging.info("Bulk lookup %d postcodes via postcodes.io", len(batch))
        try:
            results = bulk_lookup_postcodes(session, batch, timeout=20)
        except Exception as exc:
            logging.error("Bulk lookup failed: %s", exc)
            for pc in batch:
                cache.setdefault(pc, {"_failed": True, "_reason": f"bulk_lookup_error: {exc}"})
            save_cache(cache_path, cache)
            continue

        for pc, res in results.items():
            if res:
                cache[pc] = {
                    "lon": float(res["longitude"]),
                    "lat": float(res["latitude"]),
                    "postcode": res.get("postcode", pc),
                    "admin_district": res.get("admin_district"),
                    "parish": res.get("parish"),
                    "country": res.get("country"),
                }
            else:
                cache[pc] = {"_failed": True, "_reason": "postcode_not_found"}

        save_cache(cache_path, cache)

    features = build_features(
        rows,
        cache,
        existing_map,
        unnamed_existing,
        args.address_col,
        args.fallback_address_col,
        args.precision,
    )

    metadata = {
        "source": args.page_url,
        "csv_url": args.csv_url,
        "source_date": source_date or "unknown",
        "licence": "Open Government Licence v3.0",
    }
    write_geojson(Path(args.output), features, metadata)
    logging.info("Wrote %d garage features to %s", len(features), args.output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
