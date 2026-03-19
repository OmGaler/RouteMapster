#!/usr/bin/env python3
"""
geojsonify_garages.py

Create a GeoJSON FeatureCollection (Point per garage) from a CSV.
Geocode UK addresses primarily via postcodes.io (bulk, no API key) with caching.

Also applies route data hygiene fixes before exporting:
  Fix 1: Copy numeric (plain) routes found in "TfL night routes" into "TfL main network routes".

Usage:
  python geojsonify_garages.py input.csv output.geojson
  python geojsonify_garages.py input.csv output.geojson --cache geocode_cache.json
"""

from __future__ import annotations

import argparse, csv, io, json, logging, re, time, requests
from pathlib import Path
from typing import Any, Dict, Optional, List, Callable

try:
    from scripts.utils.route_ids import is_excluded_route_id, normalize_route_id
except ModuleNotFoundError:  # pragma: no cover - script execution fallback
    from utils.route_ids import is_excluded_route_id, normalize_route_id


POSTCODES_URL = "https://api.postcodes.io/postcodes"


# UK postcode regex
POSTCODE_RE = re.compile(
    r"\b([A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2})\b", re.IGNORECASE
)

# Route token matcher: captures things like 6, 113, N113, C11, SL1, W19, SCS, etc.
ROUTE_TOKEN_RE = re.compile(r"[A-Za-z0-9]+")


def setup_logging(verbose: bool) -> None:
    level = logging.DEBUG if verbose else logging.INFO
    logging.basicConfig(
        level=level,
        format="%(asctime)s | %(levelname)s | %(message)s",
        datefmt="%H:%M:%S",
    )


def load_cache(cache_path: Path) -> Dict[str, Dict[str, Any]]:
    if cache_path.exists():
        try:
            with cache_path.open("r", encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, dict):
                return data
        except Exception:
            logging.warning("Could not read cache file; starting with empty cache.")
    return {}


def save_cache(cache_path: Path, cache: Dict[str, Dict[str, Any]]) -> None:
    tmp = cache_path.with_suffix(cache_path.suffix + ".tmp")
    with tmp.open("w", encoding="utf-8") as f:
        json.dump(cache, f, ensure_ascii=False, indent=2)
    tmp.replace(cache_path)


def read_csv_rows(csv_path: Path) -> list[dict[str, Any]]:
    with csv_path.open("r", encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        return list(reader)


def read_csv_rows_from_text(csv_text: str) -> list[dict[str, Any]]:
    reader = csv.DictReader(io.StringIO(csv_text))
    return list(reader)


def pick_address(row: Dict[str, Any], address_col: str, fallback_col: str) -> str:
    addr = (row.get(address_col) or "").strip()
    if not addr:
        addr = (row.get(fallback_col) or "").strip()
    return addr


def extract_postcode(address: str) -> Optional[str]:
    if not address:
        return None
    m = POSTCODE_RE.search(address)
    if not m:
        return None
    # Normalise spacing and case: "e84rh" -> "E8 4RH"
    pc = m.group(1).upper().replace(" ", "")
    return pc[:-3] + " " + pc[-3:]


def feature(lon: float, lat: float, properties: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "type": "Feature",
        "geometry": {"type": "Point", "coordinates": [lon, lat]},
        "properties": properties,
    }


def chunks(lst: List[str], n: int) -> List[List[str]]:
    return [lst[i : i + n] for i in range(0, len(lst), n)]


def bulk_lookup_postcodes(
    session: requests.Session, postcodes: List[str], timeout: int
) -> Dict[str, Optional[Dict[str, Any]]]:
    """
    Returns dict: postcode -> result (postcodes.io 'result' object) OR None if not found.
    Uses the /postcodes bulk endpoint.
    """
    payload = {"postcodes": postcodes}
    r = session.post(POSTCODES_URL, json=payload, timeout=timeout)
    r.raise_for_status()
    data = r.json()

    out: Dict[str, Optional[Dict[str, Any]]] = {}
    for item in data.get("result", []) or []:
        q = item.get("query")
        res = item.get("result")  # None if not found
        if q:
            # Normalise query to a normalised format too
            qn = q.upper().replace(" ", "")
            qn = qn[:-3] + " " + qn[-3:]
            out[qn] = res
    # Ensure keys exist for all asked postcodes
    for pc in postcodes:
        out.setdefault(pc, None)
    return out


# --------------------
# Route hygiene helpers
# --------------------

def parse_routes(val: Any) -> List[str]:
    if not val:
        return []
    tokens: List[str] = []
    for token in ROUTE_TOKEN_RE.findall(str(val)):
        normalized = normalize_route_id(token)
        if normalized and not is_excluded_route_id(normalized):
            tokens.append(normalized)
    return tokens


def format_routes(routes: List[str]) -> str:
    # stable-ish ordering: plain numbers, then N###, then everything else lexicographically
    def key(r: str):
        if r.isdigit():
            return (0, int(r), r)
        if r.startswith("N") and r[1:].isdigit():
            return (1, int(r[1:]), r)
        return (2, 10**9, r)

    uniq = sorted(set(routes), key=key)
    # your original CSV seems to have trailing spaces in these fields; keep it consistent-ish
    return (" ".join(uniq) + (" " if uniq else "")).strip() + (" " if uniq else "")


def apply_route_fixes_to_rows(rows: List[Dict[str, Any]]) -> None:
    """
    Mutates rows in-place:
      - Fix 1: numeric tokens in night routes are also added to main routes for that row
    """

    MAIN_COL = "TfL main network routes"
    NIGHT_COL = "TfL night routes"
    for row in rows:
        main = parse_routes(row.get(MAIN_COL))
        night = parse_routes(row.get(NIGHT_COL))

        main_set = set(main)
        night_set = set(night)

        warnings: List[str] = []

        # Fix 1: copy numeric night routes into main
        numeric_to_copy = [r for r in night_set if r.isdigit() and r not in main_set]
        if numeric_to_copy:
            # keep deterministic order in message
            numeric_sorted = sorted(numeric_to_copy, key=int)
            main_set.update(numeric_sorted)
            warnings.append(f"Copied numeric night routes into main: {', '.join(numeric_sorted)}")

        # Write back to row
        row[MAIN_COL] = format_routes(list(main_set))
        row[NIGHT_COL] = format_routes(list(night_set))

        if warnings:
            # preserve existing warnings if present
            existing = row.get("route_data_warnings")
            if isinstance(existing, list):
                row["route_data_warnings"] = existing + warnings
            elif isinstance(existing, str) and existing.strip():
                row["route_data_warnings"] = [existing.strip()] + warnings
            else:
                row["route_data_warnings"] = warnings


def garages_csv_to_features(
    csv_text: str,
    geocode_fn: Callable[[str], Optional[tuple[float, float, str]]],
) -> List[Dict[str, Any]]:
    rows = read_csv_rows_from_text(csv_text)
    apply_route_fixes_to_rows(rows)

    address_col = getattr(geocode_fn, "address_col", "Garage address")
    fallback_col = getattr(geocode_fn, "fallback_address_col", "Company address")
    meta_lookup = getattr(geocode_fn, "meta", {})

    features: List[Dict[str, Any]] = []
    for row in rows:
        addr = pick_address(row, address_col, fallback_col)
        if not addr:
            continue

        pc = extract_postcode(addr)
        if not pc:
            continue

        geocode = geocode_fn(pc)
        if not geocode:
            continue

        lon, lat, resolved_pc = geocode
        props = dict(row)
        props["_geocode_source"] = "postcodes.io"
        props["_geocode_postcode"] = resolved_pc or pc

        meta = meta_lookup.get(pc) if isinstance(meta_lookup, dict) else None
        props["_geocode_admin_district"] = meta.get("admin_district") if isinstance(meta, dict) else None
        props["_geocode_country"] = meta.get("country") if isinstance(meta, dict) else None

        features.append(feature(float(lon), float(lat), props))

    return features


def features_to_feature_collection(features: List[Dict[str, Any]]) -> Dict[str, Any]:
    return {"type": "FeatureCollection", "features": features}


def main() -> int:
    """Convert a garage CSV file into a geocoded GeoJSON FeatureCollection.

    Returns:
        Process exit code for CLI usage.

    Side effects:
        Reads CSV input, performs postcode lookups, updates the cache, and
        writes the GeoJSON output file.
    """
    ap = argparse.ArgumentParser()
    ap.add_argument("input_csv", type=str, help="Input CSV path")
    ap.add_argument("output_geojson", type=str, help="Output GeoJSON path")
    ap.add_argument("--cache", type=str, default="geocode_cache.json", help="Cache JSON file path")
    ap.add_argument("--failed", type=str, default="failed_geocodes.csv", help="Failed geocodes CSV path")
    ap.add_argument("--address-col", type=str, default="Garage address", help="Primary address column name")
    ap.add_argument("--fallback-address-col", type=str, default="Company address", help="Fallback address column name")
    ap.add_argument("--timeout", type=int, default=20, help="HTTP timeout seconds")
    ap.add_argument("--bulk-size", type=int, default=100, help="Bulk postcodes lookup size (postcodes.io supports up to 100)")
    ap.add_argument("--pause", type=float, default=0.2, help="Small pause between bulk calls (seconds)")
    ap.add_argument("--verbose", action="store_true", help="Verbose logging")
    args = ap.parse_args()

    setup_logging(args.verbose)

    in_path = Path(args.input_csv)
    out_path = Path(args.output_geojson)
    cache_path = Path(args.cache)
    failed_path = Path(args.failed)

    csv_text = in_path.read_text(encoding="utf-8-sig")
    rows = read_csv_rows_from_text(csv_text)
    logging.info("Loaded %d rows from %s", len(rows), in_path)

    # ---- APPLY ROUTE FIXES HERE (prior to building GeoJSON) ----
    apply_route_fixes_to_rows(rows)
    logging.info("Applied route hygiene fixes to CSV rows (Fix 1).")

    cache = load_cache(cache_path)
    logging.info("Loaded %d cached geocodes from %s", len(cache), cache_path)

    session = requests.Session()
    session.headers.update({"User-Agent": "geojsonify-garages/1.0"})

    # Build mapping: row index -> postcode (or None)
    row_postcodes: List[Optional[str]] = []
    for row in rows:
        addr = pick_address(row, args.address_col, args.fallback_address_col)
        row_postcodes.append(extract_postcode(addr))

    # Determine which postcodes we need to lookup (not cached)
    needed = sorted({pc for pc in row_postcodes if pc and pc not in cache})

    logging.info("Need to look up %d uncached postcodes (of %d rows)", len(needed), len(rows))

    # Bulk lookup in chunks
    for batch in chunks(needed, args.bulk_size):
        logging.info("Bulk lookup %d postcodes via postcodes.io ...", len(batch))
        try:
            results = bulk_lookup_postcodes(session, batch, timeout=args.timeout)
        except Exception as e:
            logging.error("Bulk lookup failed for this batch: %s", e)
            # mark these as failed in cache to avoid infinite repeats unless you want otherwise
            for pc in batch:
                cache.setdefault(pc, {"_failed": True, "_reason": f"bulk_lookup_error: {e}"})
            save_cache(cache_path, cache)
            continue

        # Store in cache
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

        time.sleep(max(0.0, args.pause))

    geocode_memo: Dict[str, Optional[tuple[float, float, str]]] = {}

    def geocode_fn(postcode: str) -> Optional[tuple[float, float, str]]:
        if postcode in geocode_memo:
            return geocode_memo[postcode]
        entry = cache.get(postcode)
        if not entry or entry.get("_failed"):
            geocode_memo[postcode] = None
            return None
        result = (float(entry["lon"]), float(entry["lat"]), postcode)
        geocode_memo[postcode] = result
        return result

    geocode_fn.meta = cache
    geocode_fn.address_col = args.address_col
    geocode_fn.fallback_address_col = args.fallback_address_col

    features = garages_csv_to_features(csv_text, geocode_fn)
    failed_rows = []

    for i, (row, pc) in enumerate(zip(rows, row_postcodes), start=1):
        garage_name = (row.get("Garage name") or row.get("TfL garage code") or f"row {i}").strip()
        addr = pick_address(row, args.address_col, args.fallback_address_col)

        if not addr:
            logging.warning("[%d/%d] %s | No address found -> FAIL", i, len(rows), garage_name)
            failed_rows.append({**row, "_reason": "missing_address"})
            continue

        if not pc:
            logging.warning("[%d/%d] %s | No UK postcode detected in address -> FAIL | %s", i, len(rows), garage_name, addr)
            failed_rows.append({**row, "_reason": "no_postcode_detected", "_address": addr})
            continue

        entry = cache.get(pc)
        if not entry or entry.get("_failed"):
            logging.warning("[%d/%d] %s | Postcode lookup failed -> FAIL | %s", i, len(rows), garage_name, pc)
            failed_rows.append({**row, "_reason": entry.get("_reason", "postcode_lookup_failed") if entry else "no_cache_entry", "_postcode": pc})
            continue

        lon = entry["lon"]
        lat = entry["lat"]
        logging.info("[%d/%d] %s | OK | %s -> (%.6f, %.6f)", i, len(rows), garage_name, pc, lon, lat)

    geojson = features_to_feature_collection(features)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open("w", encoding="utf-8") as f:
        json.dump(geojson, f, ensure_ascii=False, indent=2)

    logging.info("Wrote %d features to %s", len(features), out_path)

    if failed_rows:
        failed_path.parent.mkdir(parents=True, exist_ok=True)
        fieldnames = list(rows[0].keys()) if rows else []
        extras = ["_reason", "_postcode", "_address"]
        for e in extras:
            if e not in fieldnames:
                fieldnames.append(e)

        with failed_path.open("w", encoding="utf-8", newline="") as f:
            w = csv.DictWriter(f, fieldnames=fieldnames, extrasaction="ignore")
            w.writeheader()
            w.writerows(failed_rows)
        logging.warning("Wrote %d failed rows to %s", len(failed_rows), failed_path)
    else:
        logging.info("No failed geocodes.")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
