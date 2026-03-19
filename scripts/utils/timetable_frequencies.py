"""
Derive route frequencies from cached TfL timetable payloads.

The helpers in this module intentionally stay lightweight so scripts and tests
can share the same frequency-band logic without pulling in the larger pipeline
entry points.
"""
from __future__ import annotations

import re
from typing import Any, Dict, Iterable, Optional


BAND_HOURS = {
    "am_peak": 3.0,  # 07:00-10:00
    "pm_peak": 3.0,  # 16:30-19:30
    "offpeak_day": 13.0,  # 05:00-07:00, 10:00-16:30, 19:30-00:00
    "overnight": 5.0,  # 00:00-05:00
}


def _is_weekday_name(name: str) -> bool:
    """Return whether a schedule label describes a weekday service."""
    text = re.sub(r"[^a-z]", "", name.lower())
    if "weekday" in text or "weekdays" in text:
        return True
    return "mon" in text and "fri" in text


def _extract_schedules(timetable_data: Dict[str, Any]) -> Iterable[Dict[str, Any]]:
    """Yield schedule dictionaries from the supported TfL timetable shapes."""
    schedules = []
    timetable = timetable_data.get("timetable")
    if isinstance(timetable, dict):
        routes = timetable.get("routes")
        if isinstance(routes, list):
            for route in routes:
                if not isinstance(route, dict):
                    continue
                route_schedules = route.get("schedules")
                if isinstance(route_schedules, list):
                    schedules.extend([s for s in route_schedules if isinstance(s, dict)])
    if not schedules:
        routes = timetable_data.get("routes")
        if isinstance(routes, list):
            for route in routes:
                if not isinstance(route, dict):
                    continue
                route_schedules = route.get("schedules")
                if isinstance(route_schedules, list):
                    schedules.extend([s for s in route_schedules if isinstance(s, dict)])
    if not schedules:
        route_schedules = timetable_data.get("schedules")
        if isinstance(route_schedules, list):
            schedules.extend([s for s in route_schedules if isinstance(s, dict)])
    return schedules


def _parse_journey_minutes(hour_value: Any, minute_value: Any) -> Optional[int]:
    """Parse a timetable hour/minute pair into minutes after midnight."""
    try:
        hour = int(str(hour_value).strip())
        minute = int(str(minute_value).strip())
    except (TypeError, ValueError):
        return None
    if hour < 0 or hour >= 48 or minute < 0 or minute > 59:
        return None
    hour = hour % 24
    return hour * 60 + minute


def _classify_band(minutes: int) -> Optional[str]:
    """Map minutes after midnight onto the RouteMapster reporting bands."""
    if 0 <= minutes < 300:
        return "overnight"  # 00:00-05:00
    if 300 <= minutes < 420:
        return "offpeak_day"  # 05:00-07:00
    if 420 <= minutes < 600:
        return "am_peak"  # 07:00-10:00
    if 600 <= minutes < 990:
        return "offpeak_day"  # 10:00-16:30
    if 990 <= minutes < 1170:
        return "pm_peak"  # 16:30-19:30
    if 1170 <= minutes < 1440:
        return "offpeak_day"  # 19:30-00:00
    return None


def _normalize_route_type(route_type: str) -> str:
    """Collapse route type spellings into a comparison-friendly token."""
    if not route_type:
        return ""
    return re.sub(r"[\s\-]", "", route_type.strip().lower())


def _filter_bands_for_route_type(frequencies: Dict[str, float], route_type: str) -> Dict[str, float]:
    """Drop irrelevant bands for route types that only run in certain periods."""
    key = _normalize_route_type(route_type)
    if key in ("night", "nightroute"):
        return {"overnight": frequencies.get("overnight", 0.0)}
    if key in ("regular", "day", "daytime"):
        return {
            "am_peak": frequencies.get("am_peak", 0.0),
            "pm_peak": frequencies.get("pm_peak", 0.0),
            "offpeak_day": frequencies.get("offpeak_day", 0.0),
        }
    if key in ("24hour", "24hours", "24hr", "24h", "twentyfour"):
        return frequencies
    return frequencies


def calculate_route_frequencies(timetable_data: Dict[str, Any], route_type: str) -> Dict[str, float]:
    """Calculate buses-per-hour by time band from a TfL timetable payload.

    Args:
        timetable_data: TfL timetable payload in one of the supported shapes.
        route_type: Route type label used to drop irrelevant bands.

    Returns:
        Buses-per-hour values keyed by RouteMapster time band.

    Side effects:
        None.

    Notes:
        Uses only the Monday-to-Friday schedule, wraps hour values beyond 24,
        and treats band boundaries as start-inclusive and end-exclusive.
    """
    counts = {band: 0 for band in BAND_HOURS}
    schedules = _extract_schedules(timetable_data if isinstance(timetable_data, dict) else {})
    for schedule in schedules:
        name = str(schedule.get("name") or schedule.get("dayType") or "")
        if not _is_weekday_name(name):
            continue
        journeys = schedule.get("knownJourneys") or []
        if not isinstance(journeys, list):
            continue
        for journey in journeys:
            if not isinstance(journey, dict):
                continue
            minutes = _parse_journey_minutes(journey.get("hour"), journey.get("minute"))
            if minutes is None:
                continue
            band = _classify_band(minutes)
            if band:
                counts[band] += 1

    frequencies: Dict[str, float] = {}
    for band, hours in BAND_HOURS.items():
        if hours <= 0:
            frequencies[band] = 0.0
            continue
        value = counts[band] / hours
        frequencies[band] = round(value, 1)

    return _filter_bands_for_route_type(frequencies, route_type)
