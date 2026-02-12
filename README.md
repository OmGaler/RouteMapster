
To submit a bug report or  feature request, open a github issue

allow brough filter to ignore spaces e.g. borough:cityoflondon / perhaps fuzzy too



# RouteMapster

RouteMapster is an interactive, map-first explorer for the London bus network. It’s built to make it easy to visualise how routes, stops, stations, garages, operators, and service patterns fit together across London — and to support “explore → filter → analyse → export” workflows without needing a backend.

This repository includes:
- A static web app (Leaflet + vanilla JS) served from `index.html`.
- A data pipeline that produces versioned, browser-ready GeoJSON/JSON under `data/processed/`.
- Analysis modules for routes and bus stops, plus export tools.

## Quick start

RouteMapster loads datasets via `fetch()`, so you’ll get the smoothest results by serving the folder locally.

1) Install Node.js (any recent LTS is fine).
2) Run:

```bash
npm install
npm start
```

3) Open `http://localhost:3000`.

If you truly want “no tooling”, you can also open `index.html` directly, but browser security settings may block data loads depending on your environment.

## What you can explore

### Layers & interactions

- **Routes:** view route geometries, optionally coloured by route type (regular / 24hr / night / school / prefix).
- **Bus stops:** all stops (with hover/click inspection and route-serving highlights).
- **Bus stations:** major hubs loaded from `data/processed/bus_stations.geojson`.
- **Garages:** garage locations with operator metadata and route allocation views.
- **Frequency trunks overlay:** an optional overlay that highlights high-frequency corridors for the selected frequency band.

### Explorer
Omnisearch
The floating search button opens a quick-search UI that helps you jump to routes, stops, stations, and garages without hunting around the map.

You can also build Advanced route filters directly in Explorer with `key:value` tokens.

### Explorer advanced filter syntax

Format:
- Separate tokens with spaces.
- Use quotes for values with spaces, e.g. `operator:"London United"`.
- Multi-value fields can use commas, e.g. `vehicle:DD,SD`.

When Explorer applies Advanced filters:
- It applies when you enter multiple `key:value` tokens.
- It also applies for a single advanced-only token like `vehicle:DD`, `length:10+`, `freq:peak_am:8+`, `spatial:east`.
- For single tokens that are also normal search categories (`route`, `garage`, `operator`), force Advanced mode with `type:any`.
- Optional force prefixes are also supported: `filter:`, `filters:`, `advanced:`, `adv:`.

Accepted keys and values:
- `route`, `routes`, `routeid`, `routeids`, `id`:
`route:12` or `route:N205,SL7`
- `prefix`, `routeprefix`:
`prefix:N`
- `series`, `routeseries`:
`series:40` (00-99), `series:40+` to include prefixed routes
- `include_prefixes`, `includeprefixes`, `series_prefixes`, `seriesprefixes`:
`include_prefixes:true`
- `type`, `routetype`, `routetypes`:
`regular`, `night`, `school`, `prefix`, `24`, `24hr`, `24hour`, `24-hour`, `twentyfour`
- `type:any` or `type:all`:
forces Advanced mode without restricting route type
- `operator`, `operators`:
`operator:"London United"`
- `garage`, `garages`:
`garage:X` or `garage:PD`
- `borough`, `boroughs`:
`borough:camden`
- `borough_mode`, `boroughmode`:
`borough_mode:within` (otherwise default behavior is enter/intersects)
- `vehicle`, `vehicles`, `vehicletype`, `vehicletypes`:
`vehicle:DD` (stored uppercase)
- `spatial`, `extreme`, `extremity`:
`north`, `south`, `east`, `west` (short forms `n/s/e/w` also work)
- `overnight`, `hasovernight`:
boolean: `true/false`, `yes/no`, `on/off`, `1/0`
- `length`, `miles`, `lengthmiles`:
numeric range syntax: `10+`, `5-12`, `>=8`, `<=14`, `12`
- `freq`, `frequency`, `bph`:
`freq:peak_am:8-12`, `freq:weekend:>=6`
- Band-specific frequency keys:
`peakam`, `peak_am`, `peakpm`, `peak_pm`, `offpeak`, `weekend`, `overnightband`
Examples: `peak_pm:>=10`, `offpeak:6-9`
- `length_rank`, `lengthrank`:
`length_rank:longest:10` or `lengthrank:shortest:5`

Examples:
- `garage:PD spatial:east vehicle:DD`
- `route:12 type:any`
- `operator:"London United" borough:camden borough_mode:within`
- `freq:peak_am:8-12 length:10+`
- `type:any garage:X`

## Advanced route filters (module)

The **Advanced route filters** module is designed for “show me all routes that look like X”. Filters don’t apply live — you build up a spec and then click **Apply filters**.

 

### Core filters

- **Route ID search:** type multiple route IDs (comma/space separated), e.g. `12, N205, SL7`.
- **Route prefix:** choose a common prefix (e.g. `N`, `SL`).
- **Route types:** filter by service type (regular / 24hr / night / school / prefix).
- **Garages:** allocated garage(s) for the route.
- **Operators:** operator name(s).
- **Boroughs:** routes associated with selected borough(s).
- **Vehicles:** filter by vehicle type labels where available (e.g. `SD`, `DD`).
- **Most extreme route:** find the single most northerly / southerly / easterly / westerly route in the current subset (uses route geometry; loaded on first apply).

### Frequency ranges (buses/hour)

Set min/max ranges per band:
- **Peak AM**, **Peak PM**, **Off-peak**, **Overnight**.

### Flags (service patterns)

- **Has overnight service:** include only routes with non-zero overnight service.
- **High frequency (>= threshold):** include routes that meet/exceed a buses/hour threshold in any band.

### Length

- **Length (miles):** min/max range from derived route geometry stats.

### Results & export

Filtered routes appear in the right-hand “Filtered routes” panel:
- **Show all on map** highlights the filtered set.
- **Export CSV** downloads the filtered table for offline work.

Advanced filter state is serialised into the URL hash so you can bookmark/share a filter setup.

## Advanced route analyses (module)

The **Advanced route analyses** module runs diagnostics/summaries either over:
- **Current filtered subset** (from Advanced route filters), or
- **All routes**.

Available analyses include:
- **Routes by operator**
- **Routes by garage**
- **Service type breakdown by operator**
- **Fleet composition by operator** (e.g. SD/DD share)
- **Average frequency by operator**
- **Top routes by Peak AM frequency**
- **Average length by operator**
- **Routes sharing the same endpoints** (click results to highlight endpoints/routes on the map)
- **Route families (heuristic)** (grouping/ranking helpers)
- **Route number series ranking (00–99)** (optional “series” view)

Most table outputs support CSV export.

## Bus stop analyses (module)

The **Bus stop analyses** module runs analyses over bus stops (a stop-level dataset enriched with route counts, districts/boroughs, and optional frequency + centrality fields).

 

### Filters (bus stops)

- **Scope:** all bus stops.
- **Postcode district filter** (multi-token entry).
- **Borough filter** (multi-token entry).
- **Region filter:** Central / NE / NW / SW / SE.
- **Min/Max route count** thresholds.

### Map overlays (top-N)

Show the **top N bus stops** on the map by:
- **Routes per stop**, or (if centrality data is present) **betweenness**, **closeness**, **eigenvector**, **degree**, and related metrics.

### Analyses

Built-in analyses include:
- Top bus stops by **route count**
- Top bus stops by **combined frequency** (selected band)
- Bus stop summary by **postcode district**
- **Coverage gaps** by district (low average routes, with minimum sample size)
- **Routes-per-stop distribution**
- Top bus stops by **betweenness / closeness / eigenvector** (when centrality data is available)
  
Outputs can be exported as CSV.

## Data pipeline (Python)

Processed datasets are committed under `data/processed/` and are regenerated by scripts in `scripts/`. A GitHub Action (`.github/workflows/refresh-data.yml`) refreshes the data on a schedule and can be run manually.

The scheduled refresh currently runs weekly (Sunday 04:00 UTC).

Typical local refresh (Python 3.11 recommended):

```bash
python -m pip install -r scripts/requirements-dev.txt
python scripts/fetch_bus_routes.py
python scripts/process_routes_xml_to_geojson.py
python scripts/fetch_bus_stops.py
python scripts/fetch_stop_sequences.py
python scripts/build_frequency_cache.py
python scripts/fetch_and_process_garages.py --base data/garages-base.geojson
python scripts/build_route_summary.py
```

Some steps (notably timetable frequency/sequence fetches) use the TfL Unified API and may require credentials:
- `TFL_APP_ID`
- `TFL_APP_KEY`

You can put these in a `.env` file in the repo root.

## Project layout

- `index.html`: UI shell and module layout.
- `src/app.js`: main application logic and map interactions.
- `src/advanced_filters.js`, `src/query_engine.js`, `src/analyses.js`, `src/stop_analyses.js`: feature modules.
- `scripts/`: fetch + processing pipeline (routes, stops, sequences, frequencies, garages).
- `data/processed/`: browser-ready outputs (GeoJSON/JSON).

## Scope (what this is / isn’t)

RouteMapster is:
- A visual exploration + inspection tool for structure, geography, and relationships.
- A “data product” style project: processed outputs are committed so the app stays fully static.

RouteMapster is not:
- An official TfL product.
- A journey planner, real-time tracker, or replacement for TfL live tools.

## Keyboard shortcuts

- `G`: toggle garages (opens Garages module)
- `B`: toggle bus stops (opens Stops module)
- `S`: toggle bus stations (opens Stations module)
- `F`: toggle frequency overlay (opens Frequencies module)
- `R`: show routes (opens Routes module + enables “Show all routes”)
- `A`: open Advanced route filters
- `N`: open Advanced route analyses
- `P`: open Bus stop analyses
- `C`: clear all (layers + route highlights)

## Attribution & disclaimer

RouteMapster is an independent project and is not affiliated with or endorsed by Transport for London.

Data is derived primarily from TfL Open Data / Unified API and other public sources (e.g. garage allocation references), and is used under their respective terms (commonly the Open Government Licence v3.0 for TfL open data — review the upstream terms before reuse).

Code licensing: see `LICENSE.md`.
