#!/usr/bin/env python3
"""
Build a cached "frequency by time band" dataset for TfL bus lines.

Usage:
  python scripts/build_frequency_cache.py \
    --lines data/processed/lines.json \
    --stops data/processed/stops.geojson \
    --out data/processed/frequencies.json \
    --cache data/raw/timetable_cache.json \
    --bands "am_peak=07:00-10:00,interpeak=10:00-16:00,pm_peak=16:00-19:00,evening=19:00-00:00,overnight=00:00-05:00" \
    --days "weekday,saturday,sunday" \
    --max-lines 0 \
    --verbose

Expected inputs:
- Stops GeoJSON with properties including NAPTAN_ID, NAME, and ROUTES.
- Optional lines JSON array (or {"routes": [...]} or {"lines": [...]}).

Output:
- Simplified JSON mapping line id -> {peak_am, offpeak, peak_pm, overnight, weekend} in bph.
- Values are taken from the first available day (weekday, then saturday, then sunday) and averaged across directions.
- Offpeak prefers interpeak and falls back to evening if interpeak is missing.

Notes:
- Bands can wrap past midnight (e.g. overnight=23:00-05:00).
- Duplicate band labels are allowed; headways are computed per range and merged.
"""

from __future__ import annotations

import argparse
import math
import json
import os
import re
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from statistics import mean
from typing import Any, Dict, Iterable, List, Optional, Sequence, Set, Tuple

import requests
from requests.adapters import HTTPAdapter
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit
from urllib3.util.retry import Retry

try:
    from scripts.utils.route_ids import (
        active_routes_from_geometry,
        is_700_series,
        is_excluded_route_id,
        normalize_route_id,
        reconcile_possible_ghost_night_route,
    )
    from scripts.utils.route_summary import build_route_sets, classify_route
except ModuleNotFoundError:  # pragma: no cover - script execution fallback
    from utils.route_ids import (
        active_routes_from_geometry,
        is_700_series,
        is_excluded_route_id,
        normalize_route_id,
        reconcile_possible_ghost_night_route,
    )
    from utils.route_summary import build_route_sets, classify_route
BASE_URL = "https://api.tfl.gov.uk"
REPO_ROOT = Path(__file__).resolve().parents[1]

DEFAULT_STOPS = REPO_ROOT / "data" / "processed" / "stops.geojson"
DEFAULT_OUT = REPO_ROOT / "data" / "processed" / "frequencies.json"
DEFAULT_CACHE = REPO_ROOT / "data" / "raw" / "timetable_cache.json"
DEFAULT_GARAGES = REPO_ROOT / "data" / "processed" / "garages.geojson"
DEFAULT_BANDS = (
    "am_peak=07:00-10:00,"
    "interpeak=10:00-16:00,"
    "pm_peak=16:00-19:00,"
    "evening=19:00-00:00,"
    "overnight=00:00-05:00"
)
DEFAULT_DAYS = "weekday,saturday,sunday"
DEFAULT_CACHE_MAX_AGE_DAYS = 30
DEFAULT_STOP_ATTEMPTS = 5
WEEKEND_SIGNIFICANT_DIFF = 1.0

TIME_RE = re.compile(r"^(?:[01]?\d|2[0-3]|24):[0-5]\d(?::[0-5]\d)?$")


@dataclass(frozen=True)
class Band:
    """Named time band used when reducing timetable data into headways."""
    label: str
    start_min: int
    end_min: int
    start_str: str
    end_str: str
    wraps: bool


@dataclass(frozen=True)
class StopRecord:
    """Minimal stop metadata used while sampling timetable endpoints."""
    stop_id: str
    name: str
    routes: Set[str]
    route_count: int


def load_dotenv(path: str = ".env") -> None:
    p = (REPO_ROOT / path) if not Path(path).is_absolute() else Path(path)
    if not p.exists():
        return
    for line in p.read_text(encoding="utf-8").splitlines():
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


def resolve_path(value: str) -> Path:
    path = Path(value)
    if path.is_absolute():
        return path
    return REPO_ROOT / path


def make_session() -> requests.Session:
    session = requests.Session()
    session.headers.update({"User-Agent": "routemapster-frequency-cache/1.0"})
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
    return session


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
    response = session.get(url, params=params, timeout=timeout)
    if response.status_code >= 400:
        body = redact_body((response.text or "")[:800])
        safe_url = redact_url(response.url)
        raise requests.HTTPError(f"{response.status_code} {safe_url}\n{body}", response=response)
    return response.json()


def redact_url(url: str) -> str:
    try:
        parts = urlsplit(url)
        if not parts.query:
            return url
        redacted = []
        for key, value in parse_qsl(parts.query, keep_blank_values=True):
            if key.lower() in ("app_id", "app_key"):
                redacted.append((key, "REDACTED"))
            else:
                redacted.append((key, value))
        query = urlencode(redacted)
        return urlunsplit((parts.scheme, parts.netloc, parts.path, query, parts.fragment))
    except Exception:
        return url


def redact_body(text: str) -> str:
    if not text:
        return text
    redacted = re.sub(r"(app_id=)[^&\"\\s]+", r"\\1REDACTED", text, flags=re.IGNORECASE)
    redacted = re.sub(r"(app_key=)[^&\"\\s]+", r"\\1REDACTED", redacted, flags=re.IGNORECASE)
    return redacted


def fetch_line_stops(session: requests.Session, app_id: str, app_key: str, line_id: str) -> List[StopRecord]:
    payload = tfl_get_json(session, app_id, app_key, f"/Line/{line_id}/StopPoints")
    if not isinstance(payload, list):
        return []
    stops: List[StopRecord] = []
    for item in payload:
        if not isinstance(item, dict):
            continue
        stop_id = item.get("id") or item.get("naptanId") or item.get("stopPointId")
        name = item.get("commonName") or item.get("name")
        if not stop_id or not name:
            continue
        stops.append(
            StopRecord(
                stop_id=str(stop_id).strip(),
                name=str(name).strip(),
                routes={normalize_route_id(line_id)},
                route_count=1,
            )
        )
    return stops


def normalize_day_key(raw: str) -> Optional[str]:
    if not raw:
        return None
    key = re.sub(r"[^a-z]", "", raw.lower())
    if key in ("montofri", "mondaytofriday", "mondayfriday", "monfri", "weekdays", "weekday"):
        return "weekday"
    if key in ("sat", "saturday"):
        return "saturday"
    if key in ("sun", "sunday"):
        return "sunday"
    return None


def day_from_name(name: str) -> Optional[str]:
    name = name.lower()
    if "mon" in name and "fri" in name:
        return "weekday"
    if "mon" in name and ("thu" in name or "thurs" in name):
        return "weekday"
    if "weekday" in name:
        return "weekday"
    if "sat" in name:
        return "saturday"
    if "sun" in name:
        return "sunday"
    if "fri" in name:
        return "weekday"
    return None


def parse_time_string(value: Any) -> Optional[int]:
    if not isinstance(value, str):
        return None
    text = value.strip()
    if not TIME_RE.match(text):
        return None
    parts = text.split(":")
    hour = int(parts[0])
    minute = int(parts[1])
    if hour == 24:
        return (24 * 60) + minute
    return hour * 60 + minute


def parse_hour_minute(hour_value: Any, minute_value: Any) -> Optional[int]:
    try:
        hour = int(str(hour_value).strip())
        minute = int(str(minute_value).strip())
    except (TypeError, ValueError):
        return None
    if hour < 0 or hour > 30 or minute < 0 or minute > 59:
        return None
    return hour * 60 + minute


def format_time(minutes: int) -> str:
    minutes = minutes % (24 * 60)
    hour = minutes // 60
    minute = minutes % 60
    return f"{hour:02d}:{minute:02d}"


def normalize_time_string(value: str) -> str:
    minutes = parse_time_string(value)
    if minutes is None:
        raise ValueError(f"Invalid time: {value}")
    return format_time(minutes)


def parse_interval_minutes(value: Any) -> Optional[int]:
    if value is None:
        return None
    if isinstance(value, dict):
        candidates: List[int] = []
        for key in (
            "interval",
            "intervalMinutes",
            "frequency",
            "frequencyMinutes",
            "lowestFrequency",
            "highestFrequency",
            "minimumFrequency",
            "maximumFrequency",
        ):
            if key not in value:
                continue
            parsed = parse_interval_minutes(value.get(key))
            if parsed:
                candidates.append(parsed)
        if candidates:
            return int(round(sum(candidates) / len(candidates)))
        return None
    if isinstance(value, (int, float)):
        minutes = int(round(value))
        return minutes if minutes > 0 else None
    if isinstance(value, str):
        text = value.strip().lower().replace("mins", "").replace("min", "")
        if ":" in text:
            minutes = parse_time_string(text)
            return minutes if minutes and minutes > 0 else None
        try:
            minutes = int(float(text))
            return minutes if minutes > 0 else None
        except ValueError:
            return None
    return None


def parse_time_value(value: Any) -> Optional[int]:
    if value is None:
        return None
    if isinstance(value, dict):
        if "hour" in value and "minute" in value:
            return parse_hour_minute(value.get("hour"), value.get("minute"))
        return None
    if isinstance(value, str):
        parsed = parse_time_string(value)
        if parsed is not None:
            return parsed
        text = value.strip()
        if ":" in text:
            parts = text.split(":")
            if len(parts) >= 2:
                try:
                    hour = int(parts[0])
                    minute = int(parts[1])
                except ValueError:
                    return None
                return parse_hour_minute(hour, minute)
    return None


def expand_interval(start_min: int, end_min: int, interval_min: int) -> List[int]:
    if interval_min <= 0:
        return []
    if end_min < start_min:
        times = expand_interval(start_min, 24 * 60, interval_min)
        times.extend(expand_interval(0, end_min, interval_min))
        return times
    times: List[int] = []
    current = start_min
    while current <= end_min:
        times.append(current)
        current += interval_min
    return times


def extract_interval_times(value: Dict[str, Any]) -> List[int]:
    start_raw = value.get("startTime") or value.get("from") or value.get("start") or value.get("fromTime")
    end_raw = value.get("endTime") or value.get("to") or value.get("end") or value.get("toTime")
    interval_raw = value.get("interval") or value.get("frequency") or value.get("intervalMinutes")
    if start_raw is None or end_raw is None or interval_raw is None:
        return []
    start_min = parse_time_value(start_raw)
    end_min = parse_time_value(end_raw)
    interval_min = parse_interval_minutes(interval_raw)
    if start_min is None or end_min is None or interval_min is None:
        return []
    return expand_interval(start_min, end_min, interval_min)


def parse_times_from_value(value: Any) -> List[int]:
    times: List[int] = []
    if value is None:
        return times
    if isinstance(value, str):
        parsed = parse_time_string(value)
        if parsed is None:
            parsed = parse_time_value(value)
        if parsed is not None:
            times.append(parsed)
        return times
    if isinstance(value, (int, float)):
        return times
    if isinstance(value, list):
        for item in value:
            times.extend(parse_times_from_value(item))
        return times
    if isinstance(value, dict):
        if "hour" in value and "minute" in value:
            type_hint = str(value.get("$type") or "").lower()
            if "knownjourney" in type_hint or "intervalId" in value:
                parsed = parse_hour_minute(value.get("hour"), value.get("minute"))
                if parsed is not None:
                    times.append(parsed)
                    return times
        interval_times = extract_interval_times(value)
        if interval_times:
            return interval_times
        found = False
        for key in (
            "time",
            "departureTime",
            "departingTime",
            "arrivalTime",
            "scheduledDepartureTime",
            "scheduledTime",
        ):
            if key in value:
                parsed = parse_time_string(value.get(key))
                if parsed is not None:
                    times.append(parsed)
                found = True
        for key in ("times", "departures", "scheduledDepartures", "intervals"):
            if key in value:
                times.extend(parse_times_from_value(value.get(key)))
                found = True
        if found:
            return times
        for item in value.values():
            times.extend(parse_times_from_value(item))
    return times


def collect_day_times(obj: Any, out: Dict[str, List[int]], depth: int = 0) -> None:
    if depth > 8:
        return
    if isinstance(obj, dict):
        for key, value in obj.items():
            day = normalize_day_key(key)
            if day:
                out[day].extend(parse_times_from_value(value))
            else:
                collect_day_times(value, out, depth + 1)
    elif isinstance(obj, list):
        for item in obj:
            collect_day_times(item, out, depth + 1)


def normalize_times(times: Iterable[int]) -> List[int]:
    normalized: List[int] = []
    for value in times:
        try:
            minutes = int(round(value))
        except (TypeError, ValueError):
            continue
        if minutes < 0:
            continue
        minutes = minutes % (24 * 60)
        normalized.append(minutes)
    return sorted(set(normalized))


def matches_stop_id(node: Dict[str, Any], stop_id: str) -> bool:
    if not stop_id:
        return False
    stop_id = stop_id.strip()
    for key in ("id", "stopId", "stopPointId", "naptanId", "naptanID"):
        value = node.get(key)
        if value and str(value).strip() == stop_id:
            return True
    nested = node.get("stopPoint")
    if isinstance(nested, dict):
        for key in ("id", "stopPointId", "naptanId", "naptanID"):
            value = nested.get(key)
            if value and str(value).strip() == stop_id:
                return True
    intervals = node.get("intervals")
    if isinstance(intervals, list):
        for interval in intervals:
            if not isinstance(interval, dict):
                continue
            value = interval.get("stopId") or interval.get("stopPointId") or interval.get("naptanId")
            if value and str(value).strip() == stop_id:
                return True
    return False


def schedule_times(schedule: Dict[str, Any]) -> List[int]:
    known = schedule.get("knownJourneys")
    if isinstance(known, list) and known:
        return parse_times_from_value(known)
    periods = schedule.get("periods")
    if isinstance(periods, list) and periods:
        return parse_times_from_value(periods)
    return parse_times_from_value(schedule)


def extract_schedule_times_by_day(container: Dict[str, Any]) -> Dict[str, List[int]]:
    out: Dict[str, List[int]] = {"weekday": [], "saturday": [], "sunday": []}
    schedules = container.get("schedules")
    if not isinstance(schedules, list):
        return out
    best: Dict[str, List[int]] = {"weekday": [], "saturday": [], "sunday": []}
    for schedule in schedules:
        if not isinstance(schedule, dict):
            continue
        name = str(schedule.get("name") or schedule.get("dayType") or "")
        day = normalize_day_key(name) or day_from_name(name)
        if not day:
            continue
        times = schedule_times(schedule)
        if len(times) > len(best[day]):
            best[day] = times
    for day, times in best.items():
        out[day] = normalize_times(times)
    return out


def extract_times_by_day(container: Dict[str, Any], stop_id: Optional[str]) -> Dict[str, List[int]]:
    out: Dict[str, List[int]] = {"weekday": [], "saturday": [], "sunday": []}
    intervals = container.get("stationIntervals")
    if isinstance(intervals, list) and intervals and stop_id:
        # Only process stationIntervals if we're filtering by a specific stop_id
        matched = [item for item in intervals if isinstance(item, dict) and matches_stop_id(item, stop_id)]
        if matched:
            for item in matched:
                collect_day_times(item, out)
            if any(out.values()):
                return {day: normalize_times(times) for day, times in out.items()}
    schedule_times = extract_schedule_times_by_day(container)
    if any(schedule_times.values()):
        return schedule_times
    collect_day_times(container, out)
    return {day: normalize_times(times) for day, times in out.items()}


def find_first_string(obj: Any, keys: Sequence[str], depth: int = 0) -> Optional[str]:
    if depth > 6:
        return None
    if isinstance(obj, dict):
        for key in keys:
            value = obj.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
        for value in obj.values():
            found = find_first_string(value, keys, depth + 1)
            if found:
                return found
    elif isinstance(obj, list):
        for item in obj:
            found = find_first_string(item, keys, depth + 1)
            if found:
                return found
    return None


def normalize_direction(value: Optional[str]) -> str:
    if not value:
        return "unknown"
    text = str(value).strip().lower()
    if "inbound" in text:
        return "inbound"
    if "outbound" in text:
        return "outbound"
    return "unknown"


def extract_direction_entries(payload: Dict[str, Any], stop_id: Optional[str]) -> List[Dict[str, Any]]:
    timetable = payload.get("timetable") if isinstance(payload, dict) else None
    routes = None
    if isinstance(timetable, dict):
        routes = timetable.get("routes")
    if not isinstance(routes, list):
        routes = payload.get("routes") if isinstance(payload, dict) else None
    if not isinstance(routes, list):
        routes = [payload] if isinstance(payload, dict) else []

    directions: Dict[str, Dict[str, Any]] = {}
    for route in routes:
        if not isinstance(route, dict):
            continue
        direction_raw = route.get("direction") or find_first_string(route, ["direction"])
        direction = normalize_direction(direction_raw)
        direction_key = direction
        if direction == "unknown":
            direction_key = f"unknown_{len(directions) + 1}"
        towards = find_first_string(
            route,
            ["towards", "destination", "destinationName", "destinationStation", "destinationText"],
        )
        times_by_day = extract_times_by_day(route, stop_id)
        existing = directions.get(direction_key)
        if not existing:
            existing = {"direction": direction, "towards": None, "times": {"weekday": [], "saturday": [], "sunday": []}}
            directions[direction_key] = existing
        if towards and not existing["towards"]:
            existing["towards"] = towards
        for day, times in times_by_day.items():
            existing["times"][day].extend(times)

    entries: List[Dict[str, Any]] = []
    for direction, data in directions.items():
        data["times"] = {day: normalize_times(times) for day, times in data["times"].items()}
        entries.append(data)
    return entries


def parse_routes_value(value: Any, active_routes: Optional[Set[str]] = None) -> Set[str]:
    if not value:
        return set()
    if isinstance(value, list):
        tokens = [str(item).strip() for item in value if str(item).strip()]
    else:
        text = str(value).replace(",", " ")
        tokens = [token.strip() for token in text.split() if token.strip()]

    routes: Set[str] = set()
    for token in tokens:
        normalized = normalize_route_id(token)
        if not normalized:
            continue
        if is_excluded_route_id(normalized):
            continue
        if active_routes is not None:
            normalized = reconcile_possible_ghost_night_route(normalized, active_routes)
            if not normalized:
                continue
        routes.add(normalized)
    return routes


def load_stops(path: Path, active_routes: Optional[Set[str]] = None) -> List[StopRecord]:
    if not path.exists():
        raise FileNotFoundError(f"Stops file not found: {path}")
    payload = json.loads(path.read_text(encoding="utf-8"))
    features = payload.get("features", []) if isinstance(payload, dict) else []
    stops: List[StopRecord] = []
    for feature in features:
        props = feature.get("properties", {}) if isinstance(feature, dict) else {}
        stop_id = props.get("NAPTAN_ID") or props.get("naptanId") or props.get("stopPointId")
        name = props.get("NAME") or props.get("name") or props.get("commonName")
        routes = parse_routes_value(
            props.get("ROUTES") or props.get("routes") or "",
            active_routes=active_routes,
        )
        if not stop_id or not name:
            continue
        stops.append(
            StopRecord(
                stop_id=str(stop_id).strip(),
                name=str(name).strip(),
                routes=routes,
                route_count=len(routes),
            )
        )
    return stops


def score_stop(stop: StopRecord) -> int:
    name = stop.name.lower()
    score = min(stop.route_count, 60) * 5
    if "bus station" in name:
        score += 50
    if "bus stand" in name:
        score += 40
    if "station" in name:
        score += 20
    if "interchange" in name:
        score += 15
    if "stand" in name:
        score += 10
    if "terminal" in name:
        score += 10
    return score


def candidates_for_line(stops: Sequence[StopRecord], line_id: str) -> List[StopRecord]:
    line_id = normalize_route_id(line_id)
    candidates = [stop for stop in stops if line_id in stop.routes]
    candidates.sort(
        key=lambda stop: (score_stop(stop), stop.route_count, stop.name, stop.stop_id),
        reverse=True,
    )
    return candidates


def sort_candidates(
    candidates: List[StopRecord],
    cache_entries: Dict[str, Any],
    line_id: str,
    prefer_cache: bool,
) -> None:
    if prefer_cache:
        candidates.sort(
            key=lambda stop: (
                cache_key(line_id, stop.stop_id) in cache_entries,
                score_stop(stop),
                stop.route_count,
                stop.name,
                stop.stop_id,
            ),
            reverse=True,
        )
    else:
        candidates.sort(
            key=lambda stop: (score_stop(stop), stop.route_count, stop.name, stop.stop_id),
            reverse=True,
        )


def load_lines_from_file(path: Path) -> List[str]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(payload, list):
        out: List[str] = []
        for item in payload:
            normalized = normalize_route_id(item)
            if normalized:
                out.append(normalized)
        return out
    if isinstance(payload, dict):
        for key in ("routes", "lines"):
            if isinstance(payload.get(key), list):
                out: List[str] = []
                for item in payload[key]:
                    normalized = normalize_route_id(item)
                    if normalized:
                        out.append(normalized)
                return out
    return []


def derive_lines_from_stops(stops: Sequence[StopRecord]) -> List[str]:
    routes: Set[str] = set()
    for stop in stops:
        routes.update(stop.routes)
    return sorted(routes, key=lambda value: (len(value), value))


def load_routes_index(path: Path) -> List[str]:
    if not path.exists():
        return []
    payload = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(payload, dict) and isinstance(payload.get("routes"), list):
        out: List[str] = []
        for item in payload["routes"]:
            normalized = normalize_route_id(item)
            if normalized:
                out.append(normalized)
        return out
    return []


def is_school_series_route(line_id: str) -> bool:
    text = normalize_route_id(line_id)
    if not text.isdigit():
        return False
    value = int(text)
    return 600 <= value <= 699 or 900 <= value <= 999


def base_route_id(line_id: str) -> str:
    text = normalize_route_id(line_id)
    if len(text) > 1 and text.endswith("D") and text[-2].isdigit():
        return text[:-1]
    return text


def line_id_fallbacks(line_id: str) -> List[str]:
    text = normalize_route_id(line_id)
    fallbacks = [text] if text else []
    if text.startswith("N") and len(text) > 1:
        base = text[1:]
        if base and base not in fallbacks:
            fallbacks.append(base)
    return fallbacks


def is_double_deck_variant(line_id: str) -> bool:
    text = normalize_route_id(line_id)
    return len(text) > 1 and text.endswith("D") and text[-2].isdigit()


def should_skip_frequency(line_id: str) -> bool:
    return is_school_series_route(line_id) or is_double_deck_variant(line_id)


def parse_bands(value: str) -> List[Band]:
    bands: List[Band] = []
    pattern = re.compile(
        r"^(?:(?P<label>[A-Za-z0-9_]+)\s*[:=]\s*)?(?P<start>\d{1,2}:\d{2})\s*-\s*(?P<end>\d{1,2}:\d{2})$"
    )
    for raw in value.split(","):
        token = raw.strip()
        if not token:
            continue
        match = pattern.match(token)
        if not match:
            raise ValueError(f"Invalid band: {token}")
        label = match.group("label")
        start_raw = match.group("start")
        end_raw = match.group("end")
        start_str = normalize_time_string(start_raw)
        end_str = normalize_time_string(end_raw)
        start_min = parse_time_string(start_str)
        end_min = parse_time_string(end_str)
        if start_min is None or end_min is None:
            raise ValueError(f"Invalid band times: {token}")
        wraps = end_min < start_min
        if not label:
            label = f"{start_str.replace(':', '')}_{end_str.replace(':', '')}"
        bands.append(
            Band(
                label=label,
                start_min=start_min,
                end_min=end_min,
                start_str=start_str,
                end_str=end_str,
                wraps=wraps,
            )
        )
    if not bands:
        raise ValueError("No bands provided.")
    return bands


def parse_days(value: str) -> List[str]:
    days: List[str] = []
    for raw in value.split(","):
        token = raw.strip()
        if not token:
            continue
        day = normalize_day_key(token) or day_from_name(token)
        if not day:
            raise ValueError(f"Unsupported day: {token}")
        if day not in days:
            days.append(day)
    if not days:
        raise ValueError("No days provided.")
    return days


def compute_band_headways(times: List[int], bands: Sequence[Band]) -> Dict[str, Optional[float]]:
    metrics: Dict[str, Optional[float]] = {}
    for band in bands:
        if band.wraps:
            band_times = [t for t in times if t >= band.start_min or t < band.end_min]
            ordered = sorted(t if t >= band.start_min else t + (24 * 60) for t in band_times)
            band_minutes = (24 * 60 - band.start_min) + band.end_min
        else:
            band_times = [t for t in times if band.start_min <= t < band.end_min]
            ordered = sorted(band_times)
            band_minutes = band.end_min - band.start_min

        headways: List[int] = []
        if len(ordered) >= 2:
            headways = [ordered[i + 1] - ordered[i] for i in range(len(ordered) - 1)]

        count_bph: Optional[float] = None
        if band_minutes > 0 and band_times:
            count_bph = len(band_times) / (band_minutes / 60)

        headway_bph: Optional[float] = None
        if headways:
            avg = mean(headways)
            if avg > 0:
                headway_bph = 60.0 / avg

        effective_bph: Optional[float]
        if count_bph is None:
            effective_bph = headway_bph
        elif headway_bph is None:
            effective_bph = count_bph
        else:
            if len(band_times) < 6 or headway_bph > count_bph * 1.25:
                effective_bph = count_bph
            else:
                effective_bph = headway_bph

        if not effective_bph:
            metrics[band.label] = None
            continue

        effective_headway = 60.0 / effective_bph
        metrics[band.label] = math.floor(effective_headway * 2 + 0.5) / 2
    return metrics


def compute_day_headways(times: List[int], bands: Sequence[Band]) -> Dict[str, Optional[float]]:
    return compute_band_headways(times, bands)


def headway_to_bph(value: Optional[float]) -> Optional[float]:
    if value is None:
        return None
    try:
        minutes = float(value)
    except (TypeError, ValueError):
        return None
    if minutes <= 0:
        return None
    return 60.0 / minutes


def mean_or_none(values: Sequence[float]) -> Optional[float]:
    if not values:
        return None
    return sum(values) / len(values)


def normalize_bph(value: Optional[float]) -> float:
    if value is None:
        return 0
    return max(0.0, round(value * 2) / 2)


def weekend_day_value(day_metrics: Dict[str, Optional[float]]) -> Optional[float]:
    if not day_metrics:
        return None
    if day_metrics.get("offpeak") is not None:
        return day_metrics.get("offpeak")
    candidates = [day_metrics.get("peak_am"), day_metrics.get("peak_pm")]
    candidates = [value for value in candidates if value is not None]
    if candidates:
        return mean_or_none(candidates)
    return day_metrics.get("overnight")


def select_weekend_frequency(
    saturday: Optional[float],
    sunday: Optional[float],
    threshold: float = WEEKEND_SIGNIFICANT_DIFF,
) -> float:
    if saturday is None and sunday is None:
        return 0
    if sunday is None:
        return normalize_bph(saturday)
    if saturday is None:
        return normalize_bph(sunday)
    if abs(sunday - saturday) >= threshold:
        return normalize_bph(sunday)
    return normalize_bph((sunday + saturday) / 2)


def load_allocations(garages_path: Path) -> Dict[str, Set[str]]:
    if not garages_path.exists():
        return {"main": set(), "night": set(), "school/mobility": set(), "other": set()}
    payload = json.loads(garages_path.read_text(encoding="utf-8"))
    features = payload.get("features", []) if isinstance(payload, dict) else []
    buckets = {
        "main": "TfL main network routes",
        "night": "TfL night routes",
        "school/mobility": "TfL school/mobility routes",
        "other": "Other routes",
    }
    out: Dict[str, Set[str]] = {key: set() for key in buckets}
    for feat in features:
        props = feat.get("properties", {}) if isinstance(feat, dict) else {}
        for bucket, field in buckets.items():
            routes = {r for r in parse_routes_value(props.get(field)) if not is_700_series(r)}
            out[bucket].update(routes)
    return out


def load_route_sets(garages_path: Path) -> Dict[str, Set[str]]:
    if not garages_path.exists():
        return {"regular": set(), "night": set(), "school": set(), "other": set(), "twentyfour": set()}
    payload = json.loads(garages_path.read_text(encoding="utf-8"))
    features = payload.get("features", []) if isinstance(payload, dict) else []
    return build_route_sets(features)


def route_category(line_id: str, route_sets: Dict[str, Set[str]]) -> Optional[str]:
    if not route_sets:
        return None
    category = classify_route(line_id, route_sets)
    if category == "twentyfour":
        return "24hr"
    return category


def simplify_lines(
    lines_out: Dict[str, Any],
    bands: Sequence[Band],
    days: Sequence[str],
    route_sets: Optional[Dict[str, Set[str]]] = None,
) -> Dict[str, Dict[str, float]]:
    band_by_label = {band.label: band for band in bands}
    simplified: Dict[str, Dict[str, float]] = {}

    for line_id, line_data in lines_out.items():
        if "directions" in line_data:
            direction_entries = list(line_data["directions"].values())
        else:
            direction_entries = [line_data]

        day_simple: Dict[str, Dict[str, Optional[float]]] = {}
        for day in days:
            band_bph: Dict[str, Optional[float]] = {}
            for label in band_by_label.keys():
                values: List[float] = []
                for entry in direction_entries:
                    metrics = entry.get(day) or {}
                    bph = headway_to_bph(metrics.get(label))
                    if bph is not None:
                        values.append(bph)
                band_bph[label] = mean_or_none(values)

            # Combine interpeak + evening into a single offpeak bucket.
            # Prefer interpeak for offpeak; fall back to evening if needed.
            offpeak_bph = band_bph.get("interpeak")
            if offpeak_bph is None:
                offpeak_bph = band_bph.get("evening")
            day_simple[day] = {
                "peak_am": band_bph.get("am_peak"),
                "offpeak": offpeak_bph,
                "peak_pm": band_bph.get("pm_peak"),
                "overnight": band_bph.get("overnight"),
            }

        aggregated: Dict[str, float] = {}
        for key in ("peak_am", "offpeak", "peak_pm", "overnight"):
            selected: Optional[float] = None
            for day in days:
                value = day_simple[day][key]
                if value is not None:
                    selected = value
                    break
            aggregated[key] = normalize_bph(selected)

        weekend = select_weekend_frequency(
            weekend_day_value(day_simple.get("saturday", {})),
            weekend_day_value(day_simple.get("sunday", {})),
        )

        # Apply route-type-specific frequency rules using allocations when available.
        route_name = normalize_route_id(line_id)
        category = route_category(route_name, route_sets or {}) if route_sets else None
        if not category:
            category = "night" if route_name.startswith("N") else "regular"

        if category == "night":
            # Night routes: only have overnight frequency.
            aggregated = {
                "peak_am": 0,
                "offpeak": 0,
                "peak_pm": 0,
                "overnight": aggregated.get("overnight", 0),
            }
        elif category == "24hr":
            # Keep all bands as computed for 24-hour routes.
            pass
        else:
            # Regular / school / other routes: force overnight to zero.
            aggregated["overnight"] = 0

        aggregated["weekend"] = weekend
        simplified[line_id] = aggregated

    return simplified


def cache_key(line_id: str, stop_id: str) -> str:
    return f"{normalize_route_id(line_id)}::{stop_id}"


def load_cache(path: Path) -> Dict[str, Any]:
    if not path.exists():
        return {"version": 1, "entries": {}}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {"version": 1, "entries": {}}
    if isinstance(payload, dict) and "entries" in payload and isinstance(payload["entries"], dict):
        return {"version": payload.get("version", 1), "entries": payload["entries"]}
    if isinstance(payload, dict):
        return {"version": 1, "entries": payload}
    return {"version": 1, "entries": {}}


def save_cache(path: Path, cache: Dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(cache, ensure_ascii=True, separators=(",", ":"), sort_keys=True),
        encoding="utf-8",
    )


def parse_timestamp(value: str) -> Optional[datetime]:
    if not value:
        return None
    text = value.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        return datetime.fromisoformat(text)
    except ValueError:
        return None


def now_utc() -> datetime:
    return datetime.now(timezone.utc).replace(microsecond=0)


def should_refresh(entry: Dict[str, Any], max_age_days: int) -> bool:
    fetched_at = entry.get("fetched_at")
    if not fetched_at:
        return True
    ts = parse_timestamp(str(fetched_at))
    if not ts:
        return True
    age = now_utc() - ts
    return age.total_seconds() > max_age_days * 86400


def fetch_timetable(
    session: requests.Session,
    app_id: str,
    app_key: str,
    line_id: str,
    stop_id: str,
) -> Any:
    path = f"/Line/{line_id}/Timetable/{stop_id}"
    return tfl_get_json(session, app_id, app_key, path)


def build_sample(stop: StopRecord, direction_entry: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "stopPointId": stop.stop_id,
        "stopName": stop.name,
        "towards": direction_entry.get("towards"),
        "direction": direction_entry.get("direction", "unknown"),
    }


def log(message: str, verbose: bool, always: bool = False) -> None:
    if verbose or always:
        print(message, flush=True)


def main() -> int:
    """Build the cached frequency dataset from route timetables.

    Returns:
        Process exit code for CLI usage.

    Side effects:
        Reads processed inputs, calls the TfL API, updates the local timetable
        cache, and writes the frequency JSON output.
    """
    parser = argparse.ArgumentParser(description="Build cached TfL timetable frequency bands.")
    parser.add_argument("--lines", help="Path to JSON array of line IDs (optional).")
    parser.add_argument("--stops", default=str(DEFAULT_STOPS), help="Path to stops GeoJSON.")
    parser.add_argument("--out", default=str(DEFAULT_OUT), help="Output JSON path.")
    parser.add_argument("--cache", default=str(DEFAULT_CACHE), help="Raw timetable cache JSON path.")
    parser.add_argument("--garages", default=str(DEFAULT_GARAGES), help="Garages GeoJSON path.")
    parser.add_argument("--bands", default=DEFAULT_BANDS, help="Comma-separated time bands.")
    parser.add_argument("--days", default=DEFAULT_DAYS, help="Comma-separated day types.")
    parser.add_argument("--max-lines", type=int, default=0, help="Process only first N lines (0 = all).")
    parser.add_argument("--refresh", action="store_true", help="Refresh cached timetables.")
    parser.add_argument("--cache-only", action="store_true", help="Use cached timetables only (no API fetch).")
    parser.add_argument(
        "--cache-max-age-days",
        type=int,
        default=DEFAULT_CACHE_MAX_AGE_DAYS,
        help="Cache staleness threshold in days.",
    )
    parser.add_argument("--verbose", action="store_true", help="Verbose logging.")
    args = parser.parse_args()

    load_dotenv(".env")
    app_id = ""
    app_key = ""
    if not args.cache_only:
        app_id = require_env("TFL_APP_ID")
        app_key = require_env("TFL_APP_KEY")

    stops_path = resolve_path(args.stops)
    out_path = resolve_path(args.out)
    cache_path = resolve_path(args.cache)
    garages_path = resolve_path(args.garages)

    active_routes = active_routes_from_geometry()
    try:
        stops = load_stops(stops_path, active_routes=active_routes)
    except Exception as exc:
        raise SystemExit(f"Failed to load stops: {exc}")

    line_ids: List[str] = []
    if args.lines:
        lines_path = resolve_path(args.lines)
        if not lines_path.exists():
            raise SystemExit(f"Lines file not found: {lines_path}")
        line_ids = load_lines_from_file(lines_path)

    if not line_ids:
        line_ids = derive_lines_from_stops(stops)

    routes_index = REPO_ROOT / "data" / "processed" / "routes" / "index.json"
    index_ids = load_routes_index(routes_index)
    if index_ids:
        line_ids = sorted(set(line_ids).union(index_ids), key=lambda value: (len(value), value))

    if not line_ids:
        line_ids = index_ids

    if not line_ids:
        raise SystemExit("No line IDs found.")

    line_ids = [line_id for line_id in line_ids if line_id and not should_skip_frequency(line_id)]

    if args.max_lines and args.max_lines > 0:
        line_ids = line_ids[: args.max_lines]

    try:
        bands = parse_bands(args.bands)
    except ValueError as exc:
        raise SystemExit(str(exc))
    try:
        days = parse_days(args.days)
    except ValueError as exc:
        raise SystemExit(str(exc))

    cache = load_cache(cache_path)
    entries = cache.setdefault("entries", {})
    if args.cache_only and not args.lines:
        line_ids = sorted({normalize_route_id(key.split("::")[0]) for key in entries.keys() if "::" in key})
        line_ids = [line_id for line_id in line_ids if not should_skip_frequency(line_id)]
        if not line_ids:
            raise SystemExit("No cached line IDs found.")

    session = make_session() if not args.cache_only else None

    lines_out: Dict[str, Any] = {}
    errors: Dict[str, str] = {}

    total = len(line_ids)
    for idx, line_id in enumerate(line_ids, start=1):
        line_id = normalize_route_id(line_id)
        if not line_id:
            continue
        candidates = candidates_for_line(stops, line_id)
        candidate_sets: List[Tuple[str, str, List[StopRecord]]] = []
        if candidates:
            candidate_sets.append(("stops dataset", line_id, candidates))

        line_stop_attempted: Set[str] = set()
        line_stop_errors: List[str] = []

        def add_line_stop_candidates(api_line_id: str) -> None:
            if session is None or api_line_id in line_stop_attempted:
                return
            line_stop_attempted.add(api_line_id)
            try:
                api_candidates = fetch_line_stops(session, app_id, app_key, api_line_id)
            except Exception as exc:
                line_stop_errors.append(f"{api_line_id}: {exc}")
                return
            if not api_candidates:
                return
            candidate_sets.append(("line stop points", api_line_id, api_candidates))
            if api_line_id == line_id:
                log(
                    f"[{idx}/{total}] {line_id}: using line stop points ({len(api_candidates)})",
                    args.verbose,
                    always=True,
                )
            else:
                log(
                    f"[{idx}/{total}] {line_id}: using line stop points from {api_line_id} ({len(api_candidates)})",
                    args.verbose,
                    always=True,
                )

        if not candidate_sets:
            for api_line_id in line_id_fallbacks(line_id):
                add_line_stop_candidates(api_line_id)

        chosen_entry: Optional[Dict[str, Any]] = None
        chosen_stop: Optional[StopRecord] = None
        fail_reason = ""

        source_index = 0
        while True:
            while source_index < len(candidate_sets):
                _source_label, query_line_id, source_candidates = candidate_sets[source_index]
                source_index += 1
                sort_candidates(source_candidates, entries, query_line_id, args.cache_only)
                for attempt, stop in enumerate(source_candidates[:DEFAULT_STOP_ATTEMPTS], start=1):
                    label = line_id
                    if query_line_id != line_id:
                        label = f"{line_id} (via {query_line_id})"
                    log(
                        f"[{idx}/{total}] {label}: try stop {stop.stop_id} ({stop.name})",
                        args.verbose,
                        always=True if attempt == 1 else False,
                    )

                    key = cache_key(query_line_id, stop.stop_id)
                    payload = None
                    if not args.refresh and key in entries and not should_refresh(entries[key], args.cache_max_age_days):
                        payload = entries[key].get("payload")
                        log(f"{label}: cache hit for {stop.stop_id}", args.verbose)

                    if payload is None:
                        if args.cache_only:
                            fail_reason = f"no cached timetable ({stop.stop_id})"
                            log(f"{label}: {fail_reason}", args.verbose, always=True)
                            continue
                        try:
                            payload = fetch_timetable(session, app_id, app_key, query_line_id, stop.stop_id)
                            entries[key] = {
                                "fetched_at": now_utc().isoformat().replace("+00:00", "Z"),
                                "payload": payload,
                            }
                            if args.verbose:
                                log(f"{label}: fetched timetable for {stop.stop_id}", args.verbose)
                            time.sleep(0.15)
                        except Exception as exc:
                            fail_reason = f"timetable fetch failed ({stop.stop_id}): {exc}"
                            log(f"{label}: {fail_reason}", args.verbose, always=True)
                            continue

                    try:
                        direction_entries = extract_direction_entries(payload, stop.stop_id)
                    except Exception as exc:
                        fail_reason = f"parse error ({stop.stop_id}): {exc}"
                        log(f"{label}: {fail_reason}", args.verbose, always=True)
                        continue

                    usable = [entry for entry in direction_entries if any(entry["times"].values())]
                    if not usable:
                        fail_reason = f"no departures found ({stop.stop_id})"
                        log(f"{label}: {fail_reason}", args.verbose, always=True)
                        continue

                    chosen_entry = usable[0]
                    chosen_stop = stop
                    direction_entries = usable

                    log(
                        f"[{idx}/{total}] {label}: selected stop {stop.stop_id} ({stop.name})",
                        args.verbose,
                        always=True,
                    )
                    if len(direction_entries) == 1:
                        line_data: Dict[str, Any] = {"sample": build_sample(chosen_stop, direction_entries[0])}
                        for day in days:
                            line_data[day] = compute_day_headways(direction_entries[0]["times"].get(day, []), bands)
                    else:
                        line_data = {"sample": build_sample(chosen_stop, direction_entries[0]), "directions": {}}
                        for entry in direction_entries:
                            direction_key = entry.get("direction", "unknown")
                            direction_data: Dict[str, Any] = {"sample": build_sample(chosen_stop, entry)}
                            for day in days:
                                direction_data[day] = compute_day_headways(entry["times"].get(day, []), bands)
                            line_data["directions"][direction_key] = direction_data

                    lines_out[line_id] = line_data
                    break

                if chosen_entry is not None:
                    break

            if chosen_entry is not None:
                break

            if session is None:
                break

            prev_len = len(candidate_sets)
            for api_line_id in line_id_fallbacks(line_id):
                add_line_stop_candidates(api_line_id)
            if len(candidate_sets) == prev_len:
                break

        if chosen_entry is None:
            if not candidate_sets:
                if line_stop_errors:
                    fail_reason = f"no stop candidates (line stop fetch failed: {line_stop_errors[-1]})"
                else:
                    fail_reason = "no stop with this line in stops dataset"
            errors[line_id] = fail_reason or "failed to build timetable"

    route_sets = load_route_sets(garages_path)
    simplified = simplify_lines(lines_out, bands, days, route_sets=route_sets)

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(
        json.dumps(simplified, ensure_ascii=True, separators=(",", ":"), sort_keys=True),
        encoding="utf-8",
    )
    save_cache(cache_path, cache)

    log(f"Wrote {len(lines_out)} lines to {out_path}", args.verbose, always=True)
    if errors:
        log(f"{len(errors)} lines failed; see console output for details.", args.verbose, always=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
