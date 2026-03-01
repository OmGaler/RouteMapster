Remove unused data/ files from gh

To submit a bug report or  feature request, open a github issue



# RouteMapster

RouteMapster is an interactive explorer for the London bus network. It's primary purpose is to make it easy to visualise how routes, stops, stations, garages, operators, and service patterns fit together across London and to provide the ability to explore and combine advanced complex filters and analyses.

The app includes:

- A web app providing an interactive map-based interface
- A data pipeline that obtains up-to-date geographic datasets 
- Analysis modules for routes and bus stops, and export tools

## Quick start

To run locally: 

1) Install Node.js 
2) Run:

```bash
npm install
npm start
```

3) Open `http://localhost:3000`.


## What you can explore

### Layers & interactions

- **Routes:** view route geometries, optionally differentiated by colour by route type (regular / 24hr / night / school / prefix)
- **Bus stops:** all stops (with hover/click inspection and information on what routes serve them)
- **Bus stations:** bus stations (as far as I can tell there isn't an official or publicaly accessible TfL defintion of what counts as a bus station, so this is up to my personal discretion - you're welcome to tell me why you think I'm wrong..)
- **Garages:** garage locations with information on operators and route allocations
- **Frequency:** an overlay that visualises combined frequencies along corridors (that is, additive frequencies of all bus routes operating that trunk) 

### Explorer

The search button (also accessible through Ctrl+F) opens a quick-search UI that helps you jump to routes, stops, stations, and garages without hunting around the map.

You can also build Advanced route filters directly in Explorer with `key:value` syntax.

### Explorer advanced filter syntax

Format:
- Separate tokens with spaces.
- Use quotes for values with spaces, e.g. `operator:"London United"`.
- Use commas to separate multiple values, e.g. `vehicle:DD,SD`.

When Explorer applies Advanced filters:
- It applies when you enter multiple `key:value` tokens.
- It also applies for a single advanced-only token like `vehicle:DD`, `length:10+`, `freq:peak_am:8+`, `spatial:east`.
- For single tokens that are also normal search categories (`route`, `garage`, `operator`), you can force Advanced mode with `type:any`.
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
    - returns the double-decker route that runs furthest east, and is allocated to Plumstead bus garage
- `route:12 type:any` - delete
- `operator:"London United" borough:camden borough_mode:within`
    - returns all bus routes that are operated by London United and fully within the borough of Camden
- `freq:peak_am:8-12 length:10+`
    - returns all bus routes that have a morning peak frequency of between 8 and 12 bph, and have a length greater than 10 miles
- `type:any garage:X`
    - returns all routes allocated to Westbourne Park bus garage

## Advanced route filters (module)

The **Advanced route filters** module is designed for "show all routes that satisfy all these conditions". Filters don’t apply live — you build up a compound query by combining conditions and then click **Apply filters**.

### Core filters

- **Route number series ranking (00–99)** (optional “series” view)


- **Route number search:** type multiple route numbers (comma/space separated), e.g. `12, N205, SL7`.
- **Route prefix:** choose a prefix (e.g. `N` for night routes, `SL` for superloop routes).
- **Route types:** filter by service type (regular / 24hr / night / school / prefix).
- **Garages:** allocated garage(s) for the route.
- **Operators:** operator name(s).
- **Boroughs:** routes associated with selected borough(s). Can be set to filter by routes wholly within, or routes that enter a borough.
- **Vehicles:** filter by single-decker or double-decker vehicle type.
- **Spatial extremities:** find the single most northerly / southerly / easterly / westerly route in the current subset.

### Frequency ranges (buses/hour)

Set min/max ranges per band:
- **Peak AM**, **Peak PM**, **Off-peak**, **Overnight**.
- **Has overnight service:** include only routes with an overnight service (night buses or 24hr routes).

### Length
- **Length (miles):** min/max range from derived route geometry stats (due to nature of the route geometries, there is likely to be some discrepency in these lengths and should be taken as indicative only, rather than absolute truth).

### Results & export

Filtered routes appear in the right-hand “Filtered routes” panel:
- **Show all on map** highlights the filtered set.
- **Export CSV** downloads the filtered table in a spreadsheet-compatible format.

## Advanced route analyses

The **Advanced route analyses** module runs analytic summaries either over:
- **All routes** or
- **Current filtered subset** (from Advanced route filters)

Available analyses include:
- **Routes by operator**
- **Routes by garage**
- **Service type breakdown by operator**
- **Fleet composition by operator** (e.g. SD/DD share)
- **Average frequency by operator**
- **Top routes by Peak AM frequency**
- **Average length by operator**
- **Longest and shortest routes** 
- **Most route-only stops** (routes with the greatest number of stops which are served by only that route)
- **Route exclusivity**: (routes with the greatest proportion of their route not being shared with other routes)
- **Routes sharing the same endpoints** (routes that run between the same exact two endpoints)
- **Route families (heuristic)** (group routes into "route families" based on numbering series, shared routings and destinations)

Most table outputs support CSV export.

## Bus stop analyses (module)

The **Bus stop analyses** module runs analyses over bus stops (a stop-level dataset enriched with route counts, postcodes and boroughs).

### Filters (bus stops)

- **Scope:** all bus stops.
- **Postcode district filter** (can select multiple postcode districts (e.g. W1, EC1, SW1)).
- **Borough filter** (can be set to one or multiple borough(s)).
- **Region filter:** Central / NE / NW / SW / SE.
- **Min/Max route count** thresholds.

### Map overlays (top-N)

Show the **top N bus stops** on the map by:
- **Routes per stop**.

### Analyses

Built-in analyses include:
- Top bus stops by **route count**
- Top bus stops by **combined frequency** (selected band)
- Bus stop summary by **postcode district**
- **Coverage gaps** by postcode district (show postcode districts with fewest average routes per stop)
- **Routes-per-stop distribution**

Outputs can be exported as CSV.

## Data pipeline (Python)
Given the everchanging nature of the London bus network, RouteMapster periodically refreshes its data to ensure information presented is up-to-date.
Processed datasets are committed under `data/processed/` and are regenerated by scripts in `scripts/`. A GitHub Action refreshes the data on a schedule, but can be run manually.

The scheduled refresh currently runs weekly (Sunday 04:00 UTC).

Typical local refresh (Python 3.11 recommended):

```bash
python -m pip install -r scripts/requirements-dev.txt
python scripts/fetch_bus_routes.py
python scripts/process_routes_xml_to_geojson.py
python scripts/fetch_bus_stops.py
python scripts/build_frequency_cache.py
python scripts/fetch_and_process_garages.py --base data/garages-base.geojson
python scripts/build_route_summary.py
```

Some steps (notably timetable frequency fetches) use the TfL Unified API and may require credentials:
- `TFL_APP_ID`
- `TFL_APP_KEY`

You can put these in a `.env` file in the repo root.

## Project layout

- `index.html`: UI shell and module layout.
- `src/app.js`: main application logic and map interactions.
- `src/advanced_filters.js`, `src/query_engine.js`, `src/analyses.js`, `src/stop_analyses.js`: feature modules.
- `scripts/`: fetch + processing pipeline (routes, stops, frequencies, garages).
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
- `A`: show all routes
- `0`: show 24 hour routes only
- `N`: show night routes only
- `P`: show prefix routes only
- `H`: show school routes only
- `X`: open Advanced route filters
- `Y`: open Advanced route analyses
- `Z`: open Bus stop analyses
- `C`: clear all (layers + route highlights)

## Attribution & disclaimer

RouteMapster is an independent project and is not affiliated with or endorsed by Transport for London.

Data is derived primarily from TfL Open Data / Unified API and other public sources (e.g. garage allocation references), and is used under their respective terms (commonly the Open Government Licence v3.0 for TfL open data — review the upstream terms before reuse).

Code licensing: see `LICENSE.md`.
