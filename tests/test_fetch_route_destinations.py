"""Unit tests for route destination record selection and fallback rules."""
from scripts.fetch_route_destinations import build_route_destination_record


def test_build_route_destination_record_prefers_vehicle_destination_text() -> None:
    payloads = [
        [
            {
                "lineId": "24",
                "direction": "outbound",
                "vehicleDestinationText": "Hampstead Heath",
                "destinationName": "Royal Free Hospital",
                "isActive": True,
            },
            {
                "lineId": "24",
                "direction": "inbound",
                "vehicleDestinationText": "Pimlico",
                "destinationName": "Grosvenor Road",
                "isActive": True,
            },
        ]
    ]

    record = build_route_destination_record("24", payloads, ["Regular"])

    assert record is not None
    assert record["outbound"]["destination"] == "Hampstead Heath"
    assert record["outbound"]["qualifier"] == "Royal Free Hospital"
    assert record["inbound"]["destination"] == "Pimlico"
    assert record["inbound"]["qualifier"] == "Grosvenor Road"


def test_build_route_destination_record_falls_back_only_when_primary_missing_everywhere() -> None:
    payloads = [
        [
            {
                "lineId": "SL11",
                "direction": "outbound",
                "vehicleDestinationText": "",
                "destinationName": "Gayton Road / Abbey Wood Station",
                "isActive": True,
            },
            {
                "lineId": "SL11",
                "direction": "inbound",
                "vehicleDestinationText": None,
                "destinationName": "North Greenwich Station",
                "isActive": True,
            },
        ]
    ]

    record = build_route_destination_record("SL11", payloads, ["Regular"])

    assert record is not None
    assert record["outbound"]["destination"] == "Gayton Road / Abbey Wood Station"
    assert record["outbound"]["qualifier"] == ""
    assert record["inbound"]["destination"] == "North Greenwich Station"
    assert record["inbound"]["qualifier"] == ""
