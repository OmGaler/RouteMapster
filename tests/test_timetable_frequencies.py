"""Unit tests for timetable-to-frequency conversion rules."""
from __future__ import annotations

from scripts.utils import timetable_frequencies as tf


def test_calculate_route_frequencies_weekday_only_and_bands() -> None:
    timetable_data = {
        "timetable": {
            "routes": [
                {
                    "schedules": [
                        {
                            "name": "Mon-Fri",
                            "knownJourneys": [
                                {"hour": 4, "minute": 30},
                                {"hour": 5, "minute": 0},
                                {"hour": 7, "minute": 0},
                                {"hour": 10, "minute": 0},
                                {"hour": 16, "minute": 30},
                                {"hour": 19, "minute": 30},
                                {"hour": 25, "minute": 15},
                                {"hour": "bad", "minute": 10},
                                {"hour": 12, "minute": 61},
                            ],
                        },
                        {
                            "name": "Saturday",
                            "knownJourneys": [{"hour": 7, "minute": 30}],
                        },
                    ]
                }
            ]
        }
    }

    freqs = tf.calculate_route_frequencies(timetable_data, route_type="24hr")
    assert freqs == {
        "am_peak": 0.3,
        "pm_peak": 0.3,
        "offpeak_day": 0.2,
        "overnight": 0.4,
    }


def test_calculate_route_frequencies_filters_by_route_type() -> None:
    timetable_data = {
        "timetable": {
            "routes": [
                {
                    "schedules": [
                        {
                            "name": "Weekdays",
                            "knownJourneys": [{"hour": 1, "minute": 0}, {"hour": 8, "minute": 0}],
                        }
                    ]
                }
            ]
        }
    }

    night = tf.calculate_route_frequencies(timetable_data, route_type="night")
    assert night == {"overnight": 0.2}

    regular = tf.calculate_route_frequencies(timetable_data, route_type="regular")
    assert regular == {"am_peak": 0.3, "pm_peak": 0.0, "offpeak_day": 0.0}
