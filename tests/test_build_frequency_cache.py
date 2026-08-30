"""Tests for resilience of the timetable frequency cache builder."""

from scripts.build_frequency_cache import retain_cached_frequencies_for_active_routes


def test_retains_cached_frequencies_when_an_active_route_has_no_fresh_result() -> None:
    frequencies = {"1": {"peak_am": 8.0}}
    cached = {
        "1": {"peak_am": 7.0},
        "2": {"peak_am": 6.0},
        "N3": {"overnight": 4.0},
    }

    retained = retain_cached_frequencies_for_active_routes(
        frequencies,
        cached,
        {"1", "2"},
    )

    assert frequencies == {
        "1": {"peak_am": 8.0},
        "2": {"peak_am": 6.0},
    }
    assert retained == ["2"]


def test_does_not_retain_cached_frequencies_for_a_deleted_route() -> None:
    frequencies = {}
    cached = {"2": {"peak_am": 6.0}}

    retained = retain_cached_frequencies_for_active_routes(frequencies, cached, {"1"})

    assert frequencies == {}
    assert retained == []
