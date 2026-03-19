#!/usr/bin/env python3
"""
Fetch the latest TfL bus route geometry XML files.

Downloads the newest dated Route_Geometry zip from the TfL S3 bucket listing
and extracts XMLs into data/raw/tfl_routes/<YYYYMMDD>/.
"""

from __future__ import annotations

import argparse
import json
import re
import xml.etree.ElementTree as ET
import zipfile
from io import BytesIO
from pathlib import Path
from typing import List, Optional, Tuple

import requests


BUCKET_NAME = "bus.data.tfl.gov.uk"
S3_HOSTNAME = "s3-eu-west-1.amazonaws.com"
LIST_URL = f"https://{S3_HOSTNAME}/{BUCKET_NAME}/?list-type=2&prefix=bus-geometry/"
DOWNLOAD_BASE = "https://bus.data.tfl.gov.uk/"
ROUTE_PREFIX = "Route_Geometry_"
ZIP_RE = re.compile(r"Route_Geometry_(\d{8})\.zip$", re.IGNORECASE)


def fetch_text(session: requests.Session, url: str) -> str:
    resp = session.get(url, timeout=60)
    resp.raise_for_status()
    return resp.text


def parse_date_token(value: str) -> Optional[str]:
    match = ZIP_RE.search(value)
    if not match:
        return None
    return match.group(1)


def iter_s3_keys(session: requests.Session) -> Iterable[str]:
    token = None
    while True:
        url = LIST_URL
        if token:
            url += f"&continuation-token={token}"
        xml_text = fetch_text(session, url)
        root = ET.fromstring(xml_text)
        ns = {"s3": "http://s3.amazonaws.com/doc/2006-03-01/"}
        for item in root.findall("s3:Contents", ns):
            key = item.findtext("s3:Key", default="", namespaces=ns)
            if key:
                yield key
        token = root.findtext("s3:NextContinuationToken", default="", namespaces=ns)
        if not token:
            break


def find_latest_zip(session: requests.Session) -> Optional[Tuple[str, str]]:
    candidates: List[Tuple[str, str]] = []
    for key in iter_s3_keys(session):
        if not key.lower().endswith(".zip"):
            continue
        if ROUTE_PREFIX not in key:
            continue
        date_token = parse_date_token(key)
        if not date_token:
            continue
        candidates.append((date_token, key))
    if not candidates:
        return None
    candidates.sort(key=lambda item: item[0], reverse=True)
    return candidates[0]


def extract_zip(session: requests.Session, key: str, dest_dir: Path, force: bool) -> int:
    dest_dir.mkdir(parents=True, exist_ok=True)
    url = f"{DOWNLOAD_BASE}{key}"
    resp = session.get(url, timeout=180)
    resp.raise_for_status()

    count = 0
    with zipfile.ZipFile(BytesIO(resp.content)) as archive:
        for info in archive.infolist():
            name = info.filename
            if not name.lower().endswith(".xml"):
                continue
            target = dest_dir / Path(name).name
            if target.exists() and not force:
                continue
            with archive.open(info) as source, target.open("wb") as handle:
                handle.write(source.read())
            count += 1
    return count


def write_latest_file(path: Path, date_token: str, zip_key: str, count: int) -> None:
    payload = {
        "date": date_token,
        "zip_key": zip_key,
        "zip_url": f"{DOWNLOAD_BASE}{zip_key}",
        "file_count": count,
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=True, indent=2)


def main() -> int:
    """Download and extract the latest TfL route geometry archive.

    Returns:
        Process exit code for CLI usage.

    Side effects:
        Calls the TfL S3 listing, downloads a ZIP archive, and extracts XML
        files into the raw data directory.
    """
    parser = argparse.ArgumentParser(description="Fetch latest TfL bus route geometry XML files.")
    parser.add_argument(
        "--output-root",
        default="data/raw/tfl_routes",
        help="Root directory for storing raw XML files.",
    )
    parser.add_argument(
        "--latest-file",
        default="data/raw/tfl_routes/latest.json",
        help="Path to write latest metadata JSON.",
    )
    parser.add_argument("--force", action="store_true", help="Re-download files even if they exist.")
    args = parser.parse_args()

    session = requests.Session()
    session.headers.update({"User-Agent": "routemapster-data-pipeline/1.0"})

    latest = find_latest_zip(session)
    if not latest:
        raise SystemExit("Unable to find latest Route_Geometry zip.")

    date_token, zip_key = latest

    output_dir = Path(args.output_root) / date_token
    extracted = extract_zip(session, zip_key, output_dir, args.force)
    if extracted == 0:
        raise SystemExit("No XML files extracted from latest Route_Geometry zip.")
    write_latest_file(Path(args.latest_file), date_token, zip_key, extracted)

    print(f"Fetched route geometry {date_token} to {output_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
