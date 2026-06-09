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
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

try:
    from scripts.utils.route_ids import normalize_route_id
except ModuleNotFoundError:  # pragma: no cover - script execution fallback
    from utils.route_ids import normalize_route_id


BASE_URL = "https://api.tfl.gov.uk"
GENERIC_DESTINATION_TOKENS = {
    "bus",
    "end",
    "road",
    "st",
    "station",
    "stop",
    "street",
    "stn",
    "the",
}


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


def destination_tokens(value: str) -> List[str]:
    cleaned = "".join(ch.lower() if ch.isalnum() else " " for ch in value)
    return [token for token in cleaned.split() if token and token not in GENERIC_DESTINATION_TOKENS]


def distinctive_destination_tokens(value: str, context: Mapping[str, Any]) -> List[str]:
    token_counts = context.get("route_sequence_token_counts")
    tokens = destination_tokens(value)
    if not isinstance(token_counts, Mapping):
        return tokens
    distinctive = [token for token in tokens if int(token_counts.get(token, 0)) < 3]
    return distinctive or tokens


def destination_text_matches_context(primary: str, context: Mapping[str, Any]) -> bool:
    tokens = distinctive_destination_tokens(primary, context)
    if not tokens:
        return False
    context_text = " ".join(
        clean_text(context.get(key))
        for key in ("route_section_name", "destination_name")
    )
    context_tokens = set(distinctive_destination_tokens(context_text, context))
    return any(token in context_tokens for token in tokens)


def destination_text_matches_intermediate_stop(primary: str, stop_names: Sequence[str]) -> bool:
    tokens = set(destination_tokens(primary))
    if not tokens:
        return False
    for stop_name in stop_names:
        stop_tokens = set(destination_tokens(clean_text(stop_name)))
        if tokens & stop_tokens:
            return True
    return False


def destination_text_matches_final_approach(primary: str, context: Mapping[str, Any]) -> bool:
    tokens = set(distinctive_destination_tokens(primary, context))
    if not tokens:
        return False

    stop_names = context.get("final_approach_stop_names")
    if isinstance(stop_names, Sequence) and not isinstance(stop_names, str):
        for stop_name in stop_names:
            if tokens & set(destination_tokens(clean_text(stop_name))):
                return True

    towards_values = context.get("final_approach_towards")
    if not isinstance(towards_values, Sequence) or isinstance(towards_values, str):
        return False
    hit_count = 0
    for towards in towards_values:
        if tokens & set(destination_tokens(clean_text(towards))):
            hit_count += 1
    return hit_count >= 2


def should_replace_destination_text(primary: str, context: Mapping[str, Any]) -> bool:
    if destination_text_matches_context(primary, context):
        return False
    if destination_text_matches_final_approach(primary, context):
        return False
    stop_names = context.get("intermediate_stop_names")
    if isinstance(stop_names, Sequence) and not isinstance(stop_names, str):
        if destination_text_matches_intermediate_stop(primary, [str(name) for name in stop_names]):
            return True
    return True


def concise_terminal_label(value: str) -> str:
    text = clean_text(value)
    if not text:
        return ""
    parts = [clean_text(part) for part in text.split("/") if clean_text(part)]
    if parts:
        # Prefer the most distinctive slash-delimited part; on ties, later
        # parts usually carry the better locality name.
        text = sorted(
            enumerate(parts),
            key=lambda item: (len(destination_tokens(item[1])), item[0]),
            reverse=True,
        )[0][1]
    replacements = {
        " Bus Station": "",
        " Interchange": "",
        " Station": "",
        " Stn": "",
    }
    for suffix, replacement in replacements.items():
        if text.endswith(suffix):
            text = text[: -len(suffix)] + replacement
            break
    return clean_text(text)


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


def extract_route_context(payload: Any) -> Tuple[List[str], List[str], Dict[str, Dict[str, Any]]]:
    lines = payload if isinstance(payload, list) else [payload]
    stop_ids: List[str] = []
    seen_stop_ids = set()
    service_types = set()
    route_contexts: Dict[str, Dict[str, Any]] = {}
    for line in lines:
        if not isinstance(line, dict):
            continue
        for section in line.get("routeSections") or []:
            if not isinstance(section, dict):
                continue
            service_type = clean_text(section.get("serviceType"))
            if service_type:
                service_types.add(service_type)
            direction = normalize_direction(section.get("direction"))
            destination_name = clean_text(section.get("destinationName"))
            route_section_name = clean_text(section.get("name"))
            if direction in {"outbound", "inbound"} and destination_name:
                route_contexts[direction] = {
                    "destination_name": destination_name,
                    "origination_name": clean_text(section.get("originationName")),
                    "route_section_name": route_section_name,
                }
            for raw_stop_id in (section.get("originator"), section.get("destination")):
                stop_id = clean_text(raw_stop_id)
                if not stop_id or stop_id in seen_stop_ids:
                    continue
                seen_stop_ids.add(stop_id)
                stop_ids.append(stop_id)
    return stop_ids, sorted(service_types), route_contexts


def extract_sequence_stop_points(payload: Any) -> List[Dict[str, Any]]:
    longest: List[Dict[str, Any]] = []
    for sequence in (payload or {}).get("stopPointSequences") or []:
        if not isinstance(sequence, dict):
            continue
        stops = [stop for stop in sequence.get("stopPoint") or [] if isinstance(stop, dict)]
        if len(stops) > len(longest):
            longest = stops
    return longest


def extract_intermediate_stop_names(payload: Any) -> List[str]:
    stop_names: List[str] = []
    for stop in extract_sequence_stop_points(payload)[1:-1]:
        name = clean_text(stop.get("name"))
        if name:
            stop_names.append(name)
    return stop_names


def extract_final_approach_context(payload: Any, window: int = 8) -> Dict[str, List[str]]:
    stops = extract_sequence_stop_points(payload)
    final_stops = stops[-window:] if window > 0 else []
    return {
        "final_approach_stop_names": [
            clean_text(stop.get("name"))
            for stop in final_stops
            if clean_text(stop.get("name"))
        ],
        "final_approach_towards": [
            clean_text(stop.get("towards"))
            for stop in final_stops
            if clean_text(stop.get("towards"))
        ],
    }


def extract_sequence_token_counts(payload: Any) -> Dict[str, int]:
    counter: Counter[str] = Counter()
    for stop in extract_sequence_stop_points(payload):
        tokens = set(destination_tokens(clean_text(stop.get("name"))))
        towards = clean_text(stop.get("towards"))
        if towards:
            tokens.update(destination_tokens(towards))
        counter.update(tokens)
    return dict(counter)


def build_route_destination_record(
    route_id: str,
    stop_payloads: Sequence[Any],
    service_types: Sequence[str],
    route_contexts: Optional[Mapping[str, Mapping[str, Any]]] = None,
) -> Optional[Dict[str, Any]]:
    """Build the cached destination record for one route.

    Args:
        route_id: Normalised route id being summarised.
        stop_payloads: Route payloads fetched for the route's origin and destination stops.
        service_types: Service types discovered while fetching the route context.
        route_contexts: Current line route section names keyed by direction, used
            to reject stale or off-route blind text from stop route records.

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
                context = (route_contexts or {}).get(direction)
                if context and should_replace_destination_text(primary, context):
                    primary = concise_terminal_label(clean_text(context.get("destination_name")))
                    qualifier = clean_text(context.get("destination_name")) or qualifier
                    if not primary:
                        primary = qualifier
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

    refresh_selected_routes = args.line_ids is not None

    for index, route_id in enumerate(routes, start=1):
        if route_id in route_payloads and not args.replace_existing and not refresh_selected_routes:
            continue
        line_url = f"{BASE_URL}/Line/{route_id}/Route"
        try:
            line_payload = fetch_json(session, line_url, app_key=app_key, app_id=app_id)
            stop_ids, service_types, route_contexts = extract_route_context(line_payload)
            for direction, context in route_contexts.items():
                sequence_url = f"{BASE_URL}/Line/{route_id}/Route/Sequence/{direction}"
                try:
                    sequence_payload = fetch_json(session, sequence_url, app_key=app_key, app_id=app_id)
                    context["intermediate_stop_names"] = extract_intermediate_stop_names(sequence_payload)
                    context.update(extract_final_approach_context(sequence_payload))
                    context["route_sequence_token_counts"] = extract_sequence_token_counts(sequence_payload)
                except Exception:
                    context["intermediate_stop_names"] = []
                    context["final_approach_stop_names"] = []
                    context["final_approach_towards"] = []
                    context["route_sequence_token_counts"] = {}
            stop_payloads: List[Any] = []
            for stop_id in stop_ids:
                if stop_id not in stop_route_cache:
                    stop_url = f"{BASE_URL}/StopPoint/{stop_id}/Route"
                    stop_route_cache[stop_id] = fetch_json(session, stop_url, app_key=app_key, app_id=app_id)
                    if args.sleep > 0:
                        time.sleep(args.sleep)
                stop_payloads.append(stop_route_cache.get(stop_id))
            record = build_route_destination_record(route_id, stop_payloads, service_types, route_contexts)
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
