#!/usr/bin/env python3
"""
Fetch ALL TfL bus StopPoints and write a GeoJSON FeatureCollection.

Changes vs original:
- Writes raw to <repo>/data/raw/stops/
- Writes processed to <repo>/data/processed/stops.geojson
- Filters to *actual bus stops* only (stopType + modes)
- Ensures every exported stop has a postcode (reverse geocode via postcodes.io)
  - Anything without a postcode after lookup is excluded from processed output.
- Uses a persistent postcode cache to avoid hammering reverse-geocode.
"""

from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

BASE_URL = "https://api.tfl.gov.uk"
POSTCODES_IO_REVERSE_URL = "https://api.postcodes.io/postcodes"

# scripts/fetch_stops.py -> repo root is one level up
REPO_ROOT = Path(__file__).resolve().parents[1]

RAW_STOPS_DIR = REPO_ROOT / "data" / "raw" / "stops"
RAW_STOPS_PATH = RAW_STOPS_DIR / "stop_points.json"
POSTCODE_CACHE_PATH = RAW_STOPS_DIR / "postcode_cache.json"

PROCESSED_DIR = REPO_ROOT / "data" / "processed"
PROCESSED_PATH = PROCESSED_DIR / "stops.geojson"


def load_dotenv(path: str = ".env") -> None:
    # expects .env in repo root (you call load_dotenv(".env") from scripts; that's fine)
    p = (REPO_ROOT / path) if not Path(path).is_absolute() else Path(path)
    if not p.exists():
        return
    for line in p.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        k = k.strip()
        v = v.strip().strip('"').strip("'")
        if k and k not in os.environ:
            os.environ[k] = v


@dataclass
class Config:
    page_delay: float = 0.05
    timeout: Tuple[float, float] = (10.0, 60.0)  # (connect, read)
    max_pages: int = 500
    stop_after_empty_pages: int = 1
    output_path: Path = PROCESSED_PATH

    # postcode enrichment
    postcode_timeout: Tuple[float, float] = (5.0, 20.0)
    postcode_delay: float = 0.02  # be polite
    postcode_radius_m: int = 200  # reverse lookup radius
    postcode_cache_path: Path = POSTCODE_CACHE_PATH


def require_env(name: str) -> str:
    v = os.environ.get(name, "").strip()
    if not v:
        raise SystemExit(f"Missing {name}. Set it in your environment or .env.")
    return v


def make_session() -> requests.Session:
    s = requests.Session()
    s.headers.update({"User-Agent": "routemapster-stops-export/1.1"})

    retry = Retry(
        total=6,
        backoff_factor=0.8,
        status_forcelist=(429, 500, 502, 503, 504),
        allowed_methods=("GET",),
        raise_on_status=False,
    )
    adapter = HTTPAdapter(max_retries=retry, pool_connections=10, pool_maxsize=10)
    s.mount("https://", adapter)
    s.mount("http://", adapter)
    return s


def tfl_get_json(
    session: requests.Session,
    app_id: str,
    app_key: str,
    path: str,
    params: Optional[Dict[str, Any]] = None,
    timeout: Tuple[float, float] = (10.0, 60.0),
) -> Any:
    params = dict(params or {})
    params["app_id"] = app_id
    params["app_key"] = app_key

    url = f"{BASE_URL}{path}"
    r = session.get(url, params=params, timeout=timeout)
    if r.status_code >= 400:
        body = (r.text or "")[:800]
        raise requests.HTTPError(f"{r.status_code} {r.url}\n{body}", response=r)
    return r.json()


def extract_stop_points(payload: Any) -> List[Dict[str, Any]]:
    if isinstance(payload, list):
        return payload
    if isinstance(payload, dict):
        sp = payload.get("stopPoints")
        if isinstance(sp, list):
            return sp
    return []


def extract_routes(sp: Dict[str, Any]) -> Set[str]:
    routes: Set[str] = set()
    for line in sp.get("lines", []) or []:
        rid = line.get("id") or line.get("name")
        if rid:
            routes.add(str(rid))

    if not routes:
        for lg in sp.get("lineGroups", []) or []:
            for ident in lg.get("lineIdentifier", []) or []:
                if ident:
                    routes.add(str(ident))

    return routes


def additional_prop(sp: Dict[str, Any], key: str) -> Optional[str]:
    for ap in sp.get("additionalProperties", []) or []:
        if (ap.get("key") or "").strip().lower() == key.lower():
            return ap.get("value")
    return None


def sort_routes(routes: Set[str]) -> List[str]:
    return sorted(routes, key=lambda x: (len(x), x))


def is_actual_bus_stop(sp: Dict[str, Any]) -> bool:
    """
    TfL /StopPoint/Mode/bus can include interchanges and other facilities.
    Keep only real bus stop points.
    """
    stop_type = (sp.get("stopType") or "").strip()
    modes = sp.get("modes") or []
    # Keep roadside bus stops. (This stopType name is what you see on bus stop StopPoints.)
    if stop_type != "NaptanPublicBusCoachTram":
        return False
    if "bus" not in modes:
        return False
    return True


def fetch_all_bus_stop_points(
    session: requests.Session,
    app_id: str,
    app_key: str,
    cfg: Config,
) -> List[Dict[str, Any]]:
    stops: List[Dict[str, Any]] = []
    seen: Set[str] = set()

    empty_pages = 0
    for page in range(1, cfg.max_pages + 1):
        payload = tfl_get_json(
            session,
            app_id,
            app_key,
            "/StopPoint/Mode/bus",
            params={"page": page},
            timeout=cfg.timeout,
        )
        batch = extract_stop_points(payload)

        added = 0
        for sp in batch:
            sid = sp.get("naptanId") or sp.get("id")
            if not sid or sid in seen:
                continue
            seen.add(sid)
            stops.append(sp)
            added += 1

        print(f"page {page}: received {len(batch)} items, +{added} new, total {len(stops)}", flush=True)

        if added == 0:
            empty_pages += 1
            if empty_pages >= cfg.stop_after_empty_pages:
                break
        else:
            empty_pages = 0

        time.sleep(cfg.page_delay)

    return stops


def load_postcode_cache(path: Path) -> Dict[str, str]:
    if not path.exists():
        return {}
    try:
        obj = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(obj, dict):
            # stored as { "<key>": "SW1A 1AA", ... }
            return {str(k): str(v) for k, v in obj.items() if v}
    except Exception:
        pass
    return {}


def save_postcode_cache(path: Path, cache: Dict[str, str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(cache, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")


def reverse_geocode_postcode(
    session: requests.Session,
    lat: float,
    lon: float,
    radius_m: int,
    timeout: Tuple[float, float],
) -> Optional[str]:
    # postcodes.io reverse lookup: /postcodes?lon=...&lat=...&radius=...
    r = session.get(
        POSTCODES_IO_REVERSE_URL,
        params={"lon": lon, "lat": lat, "radius": radius_m},
        timeout=timeout,
    )
    if r.status_code >= 400:
        return None
    try:
        payload = r.json()
    except ValueError:
        return None

    results = payload.get("result")
    if not isinstance(results, list) or not results:
        return None
    pc = results[0].get("postcode")
    return str(pc).strip() if pc else None


def postcode_key(lat: float, lon: float) -> str:
    # cache by rounded coordinate to avoid millions of keys
    return f"{lat:.5f},{lon:.5f}"


def get_or_lookup_postcode(
    session: requests.Session,
    sp: Dict[str, Any],
    cache: Dict[str, str],
    cfg: Config,
) -> Optional[str]:
    # 1) TfL provided postcode?
    pc = additional_prop(sp, "Postcode") or additional_prop(sp, "postcode")
    if pc:
        return pc.strip()

    # 2) Reverse geocode
    lat = sp.get("lat")
    lon = sp.get("lon")
    if lat is None or lon is None:
        return None

    key = postcode_key(float(lat), float(lon))
    if key in cache:
        return cache[key]

    pc = reverse_geocode_postcode(
        session=session,
        lat=float(lat),
        lon=float(lon),
        radius_m=cfg.postcode_radius_m,
        timeout=cfg.postcode_timeout,
    )
    if pc:
        cache[key] = pc
        return pc

    return None


def to_geojson(
    stops: List[Dict[str, Any]],
    session: requests.Session,
    cfg: Config,
) -> Dict[str, Any]:
    features: List[Dict[str, Any]] = []

    cache = load_postcode_cache(cfg.postcode_cache_path)

    total = len(stops)
    kept = 0
    dropped_non_bus_stop = 0
    dropped_no_postcode = 0

    for i, sp in enumerate(stops, start=1):
        if not is_actual_bus_stop(sp):
            dropped_non_bus_stop += 1
            continue

        sid = sp.get("naptanId") or sp.get("id")
        name = sp.get("commonName") or sp.get("name")
        lat = sp.get("lat")
        lon = sp.get("lon")
        if not sid or not name or lat is None or lon is None:
            dropped_non_bus_stop += 1
            continue

        postcode = get_or_lookup_postcode(session, sp, cache, cfg)
        if not postcode:
            dropped_no_postcode += 1
            continue

        routes = extract_routes(sp)

        props = {
            "NAPTAN_ID": str(sid),
            "NAME": str(name),
            "POSTCODE": postcode,
            "ROUTES": ", ".join(sort_routes(routes)) if routes else "",
            "URL": f"https://tfl.gov.uk/bus/stop/{sid}/",
        }
        props = {k: v for k, v in props.items() if v}

        features.append(
            {
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": [float(lon), float(lat)]},
                "properties": props,
            }
        )
        kept += 1

        if cfg.postcode_delay:
            time.sleep(cfg.postcode_delay)

        if i % 1000 == 0:
            print(f"postcode enrich {i}/{total} | kept {kept} | cache {len(cache)}", flush=True)
            save_postcode_cache(cfg.postcode_cache_path, cache)

    save_postcode_cache(cfg.postcode_cache_path, cache)

    features.sort(key=lambda f: (f["properties"].get("NAPTAN_ID", ""), f["properties"].get("NAME", "")))

    print(
        f"Done. Input {total} | kept {kept} | dropped non-bus-stop {dropped_non_bus_stop} | dropped no-postcode {dropped_no_postcode}",
        flush=True,
    )

    return {"type": "FeatureCollection", "features": features}


def main() -> None:
    load_dotenv(".env")
    app_id = require_env("TFL_APP_ID")
    app_key = require_env("TFL_APP_KEY")

    cfg = Config()

    session = make_session()

    RAW_STOPS_DIR.mkdir(parents=True, exist_ok=True)
    PROCESSED_DIR.mkdir(parents=True, exist_ok=True)

    stops = fetch_all_bus_stop_points(session, app_id, app_key, cfg)

    # write raw
    RAW_STOPS_PATH.write_text(json.dumps(stops, ensure_ascii=False), encoding="utf-8")
    print(f"Wrote raw StopPoints to {RAW_STOPS_PATH}", flush=True)

    # write processed
    fc = to_geojson(stops, session=session, cfg=cfg)
    PROCESSED_PATH.write_text(json.dumps(fc, ensure_ascii=False), encoding="utf-8")
    print(f"Wrote {len(fc['features'])} processed stops to {PROCESSED_PATH}", flush=True)


if __name__ == "__main__":
    main()
