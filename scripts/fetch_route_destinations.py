#!/usr/bin/env python3
"""
Fetch and cache passenger-facing route destination labels from the TfL API.

The resulting JSON is consumed by the browser application and route summary
builder so route detail panels can show outbound and inbound destination text
without calling the live API at runtime.
"""
from __future__ import annotations

import argparse
import json
import os
import time
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

try:
    from scripts.utils.route_ids import normalize_route_id
except ModuleNotFoundError:  # pragma: no cover - script execution fallback
    from utils.route_ids import normalize_route_id


BASE_URL = "https://api.tfl.gov.uk"


def repo_root() -> Path:
    return Path(__file__).resolve().parents[1]


def load_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=True, indent=2, sort_keys=True)
        handle.write("\n")


def load_dotenv(path: str = ".env") -> None:
    full_path = (repo_root() / path) if not Path(path).is_absolute() else Path(path)
    if not full_path.exists():
        return
    for line in full_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


def require_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise SystemExit(f"Missing {name}. Set it in your environment or .env.")
    return value


def make_session() -> requests.Session:
    session = requests.Session()
    retry = Retry(
        total=6,
        backoff_factor=0.8,
        status_forcelist=(429, 500, 502, 503, 504),
        allowed_methods=("GET",),
        raise_on_status=False,
    )
    adapter = HTTPAdapter(max_retries=retry, pool_connections=10, pool_maxsize=10)
    session.mount("https://", adapter)
    session.mount("http://", adapter)
    session.headers.update({"User-Agent": "routemapster-data-pipeline/1.0"})
    return session


def normalize_routes(routes: Iterable[str]) -> List[str]:
    output: List[str] = []
    seen = set()
    for route in routes:
        normalized = normalize_route_id(route)
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        output.append(normalized)
    return output


def load_routes_from_index(path: Path) -> List[str]:
    if not path.exists():
        return []
    payload = load_json(path)
    routes = payload.get("routes") if isinstance(payload, dict) else None
    if not isinstance(routes, list):
        return []
    return normalize_routes(str(route) for route in routes)


def clean_text(value: Any) -> str:
    text = str(value or "").replace("\u00a0", " ")
    text = " ".join(text.split()).strip()
    text = text.lstrip(".").strip()
    if not text:
        return ""
    lowered = text.lower()
    if lowered in {"unknown", "unkown", "n/a", "na", "null"}:
        return ""
    return text


def normalize_direction(value: Any) -> str:
    token = str(value or "").strip().lower()
    if token in {"outbound", "out", "1"}:
        return "outbound"
    if token in {"inbound", "in", "2"}:
        return "inbound"
    return token or "unknown"


def normalize_compare_key(value: str) -> str:
    return "".join(ch for ch in value.lower() if ch.isalnum())


def build_full_destination(primary: str, qualifier: str) -> str:
    main = clean_text(primary)
    extra = clean_text(qualifier)
    if not main:
        return ""
    if not extra:
        return main
    main_key = normalize_compare_key(main)
    extra_key = normalize_compare_key(extra)
    if not extra_key or extra_key == main_key or extra_key in main_key or main_key in extra_key:
        return main
    return f"{main}, {extra}"


def sort_counter_items(counter: Counter[Tuple[str, str]]) -> List[Tuple[Tuple[str, str], int]]:
    return sorted(
        counter.items(),
        key=lambda item: (-item[1], item[0][0].lower(), item[0][1].lower()),
    )


def fetch_json(
    session: requests.Session,
    url: str,
    app_key: str,
    app_id: Optional[str],
) -> Any:
    params: Dict[str, Any] = {"app_key": app_key}
    if app_id:
        params["app_id"] = app_id
    response = session.get(url, params=params, timeout=(10.0, 60.0))
    if response.status_code >= 400:
        raise requests.HTTPError(f"{response.status_code} {response.url}\n{response.text[:300]}", response=response)
    return response.json()


def extract_route_context(payload: Any) -> Tuple[List[str], List[str]]:
    lines = payload if isinstance(payload, list) else [payload]
    stop_ids: List[str] = []
    seen_stop_ids = set()
    service_types = set()
    for line in lines:
        if not isinstance(line, dict):
            continue
        for section in line.get("routeSections") or []:
            if not isinstance(section, dict):
                continue
            service_type = clean_text(section.get("serviceType"))
            if service_type:
                service_types.add(service_type)
            for raw_stop_id in (section.get("originator"), section.get("destination")):
                stop_id = clean_text(raw_stop_id)
                if not stop_id or stop_id in seen_stop_ids:
                    continue
                seen_stop_ids.add(stop_id)
                stop_ids.append(stop_id)
    return stop_ids, sorted(service_types)


def build_route_destination_record(route_id: str, stop_payloads: Sequence[Any], service_types: Sequence[str]) -> Optional[Dict[str, Any]]:
    """Build the cached destination record for one route.

    Args:
        route_id: Normalised route id being summarised.
        stop_payloads: Route payloads fetched for the route's origin and destination stops.
        service_types: Service types discovered while fetching the route context.

    Returns:
        A serialisable destination summary, or `None` when no usable text is available.
    """
    direction_pairs: Dict[str, Counter[Tuple[str, str]]] = defaultdict(Counter)
    fallback_pairs: Dict[str, Counter[Tuple[str, str]]] = defaultdict(Counter)
    for payload in stop_payloads:
        entries = payload if isinstance(payload, list) else []
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            line_id = normalize_route_id(entry.get("lineId") or entry.get("lineName") or "")
            if line_id != route_id:
                continue
            if entry.get("isActive") is False:
                continue
            direction = normalize_direction(entry.get("direction"))
            primary = clean_text(entry.get("vehicleDestinationText"))
            qualifier = clean_text(entry.get("destinationName"))
            if primary:
                if normalize_compare_key(primary) == normalize_compare_key(qualifier):
                    qualifier = ""
                direction_pairs[direction][(primary, qualifier)] += 1
                continue
            if qualifier:
                fallback_pairs[direction][(qualifier, "")] += 1

    # Prefer passenger-facing blind text when it exists anywhere; only fall
    # back to stop destination names when no better wording is available.
    active_pairs = direction_pairs if any(direction_pairs.values()) else fallback_pairs

    directions: Dict[str, Dict[str, str]] = {}
    for direction in ("outbound", "inbound"):
        counter = active_pairs.get(direction)
        if not counter:
            continue
        (primary, qualifier), _count = sort_counter_items(counter)[0]
        directions[direction] = {
            "destination": primary,
            "qualifier": qualifier,
            "full": build_full_destination(primary, qualifier),
        }

    if not directions:
        return None

    return {
        "service_types": list(service_types),
        **directions,
    }


def load_existing_routes(path: Path) -> Dict[str, Any]:
    if not path.exists():
        return {}
    payload = load_json(path)
    if not isinstance(payload, dict):
        return {}
    routes = payload.get("routes")
    if isinstance(routes, dict):
        return {normalize_route_id(key): value for key, value in routes.items() if normalize_route_id(key)}
    return {}


def main() -> int:
    """Fetch route destination text and refresh the cached JSON file.

    Returns:
        Process exit code for CLI usage.

    Side effects:
        Calls the TfL API, merges with any existing cache, and writes the
        destination cache back to disk.
    """
    parser = argparse.ArgumentParser(description="Fetch cached passenger-facing route destinations from TfL.")
    parser.add_argument("--routes-index", default=str(repo_root() / "data" / "processed" / "routes" / "index.json"))
    parser.add_argument("--output", default=str(repo_root() / "data" / "processed" / "route_destinations.json"))
    parser.add_argument("--line-ids", help="Comma-separated route ids to fetch.")
    parser.add_argument("--sleep", type=float, default=0.05)
    parser.add_argument("--max-lines", type=int)
    parser.add_argument("--checkpoint-every", type=int, default=25)
    parser.add_argument("--replace-existing", action="store_true", default=False)
    parser.add_argument("--resume", action="store_true", default=True)
    parser.add_argument("--no-resume", action="store_false", dest="resume")
    args = parser.parse_args()

    load_dotenv()
    app_key = require_env("TFL_APP_KEY")
    app_id = os.environ.get("TFL_APP_ID", "").strip() or None

    if args.line_ids is not None:
        routes = normalize_routes(part.strip() for part in args.line_ids.split(",") if part.strip())
    else:
        routes = load_routes_from_index(Path(args.routes_index))
    if args.max_lines:
        routes = routes[: max(0, int(args.max_lines))]
    if not routes:
        raise SystemExit("No routes to fetch. Provide --line-ids or ensure routes index exists.")

    output_path = Path(args.output)
    existing_routes = load_existing_routes(output_path) if args.resume and not args.replace_existing else {}
    route_payloads = {} if args.replace_existing else dict(existing_routes)

    session = make_session()
    stop_route_cache: Dict[str, Any] = {}
    fetched = 0

    def write_checkpoint() -> None:
        payload = {
            "generated_at_utc": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
            "route_count": len(route_payloads),
            "routes": {route_key: route_payloads[route_key] for route_key in sorted(route_payloads)},
        }
        write_json(output_path, payload)

    for index, route_id in enumerate(routes, start=1):
        if route_id in route_payloads and not args.replace_existing:
            continue
        line_url = f"{BASE_URL}/Line/{route_id}/Route"
        try:
            line_payload = fetch_json(session, line_url, app_key=app_key, app_id=app_id)
            stop_ids, service_types = extract_route_context(line_payload)
            stop_payloads: List[Any] = []
            for stop_id in stop_ids:
                if stop_id not in stop_route_cache:
                    stop_url = f"{BASE_URL}/StopPoint/{stop_id}/Route"
                    stop_route_cache[stop_id] = fetch_json(session, stop_url, app_key=app_key, app_id=app_id)
                    if args.sleep > 0:
                        time.sleep(args.sleep)
                stop_payloads.append(stop_route_cache.get(stop_id))
            record = build_route_destination_record(route_id, stop_payloads, service_types)
            if record:
                route_payloads[route_id] = record
            elif route_id in route_payloads:
                route_payloads.pop(route_id, None)
            fetched += 1
            if args.checkpoint_every > 0 and fetched % args.checkpoint_every == 0:
                write_checkpoint()
            if args.sleep > 0:
                time.sleep(args.sleep)
        except Exception as exc:
            print(f"[{index}/{len(routes)}] {route_id}: failed ({exc})")
            continue
        print(f"[{index}/{len(routes)}] {route_id}: ok")

    write_checkpoint()
    print(f"Wrote {len(route_payloads)} route destinations to {output_path} ({fetched} fetched this run)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
