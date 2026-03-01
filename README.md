# RouteMapster

![RouteMapster logo](assets/routemapster.svg)
---
RouteMapster is an interactive, map-based explorer for the London bus network. RouteMapster makes it easy to see how routes, stops, stations, garages, operators, and service patterns all fit together within the network — with quick search, flexible filters, and exportable analyses. Independent, open-source, non-commercial and not in any way affiliated with Transport for London (TfL).

## What you can explore

- Routes, coloured by service type (regular / 24‑hour / night / school / prefix).  
- Bus stops and stations with hover/click details on serving routes.  
- Garages with operator + route allocations.  
- Frequency overlay showing combined corridor frequencies.  
- Quick search (`Ctrl+F`) to jump to routes, stops, stations, garages.  
- Advanced filters using `key:value` syntax for complex queries.  
- CSV exports from filters and analyses.

---

## Using the app

- **Search:** Click the search button or press `Ctrl+F`, type a route/stop/garage, press Enter to zoom.  
- **Toggle layers:** Sidebar buttons or shortcuts switch routes, stops, stations, garages, and the frequency overlay.  
- **Run an advanced filter:** Example `garage:PD spatial:east vehicle:DD` → easternmost double‑deck route allocated to Plumstead; click **Apply filters**.  
- **Review results:** Filtered routes appear in the right panel; **Show all on map** highlights them; **Export CSV** saves the table.

**Shortcuts (most useful)**
- `G` garages • `B` stops • `S` stations  
- `F` frequency overlay • `R` show routes  
- `X` advanced filters • `Y` route analyses  
- `C` clear all

---

## Advanced filters (concise reference)

Format: `key:value` tokens separated by spaces; quote values with spaces; commas allow multiple values (`vehicle:DD,SD`).  
Triggered when: multiple tokens, or a single advanced-only key (`vehicle:DD`, `length:10+`, `freq:peak_am:8+`, `spatial:east`). Force advanced mode with `type:any`. Optional prefixes: `filter:`, `filters:`, `advanced:`, `adv:`.

Common keys:
- `route` / `routeno` / `route#` / `routeid` — `route:N205,SL7`
- `prefix` — `prefix:N`
- `series` — `series:40` or `series:40+`
- `include_prefixes:true`
- `type` — `regular`, `night`, `school`, `prefix`, `24`, `24hr`, `24hour`, `24-hour`, `twentyfour`
- `operator` — `operator:"London United"`
- `garage` — `garage:PD`
- `borough` — `borough:camden` (optional `borough_mode:within`)
- `vehicle` — `vehicle:DD`
- `spatial` — `north/south/east/west` or `n/s/e/w`
- `overnight` — boolean (`overnight:true`) or overnight frequency band (`overnight:4+`)
- `length` ranges — `10+`, `5-12`, `>=8`, `<=14`
- `freq` ranges — `freq:peak_am:8-12`, `freq:weekend:>=6`; bands: `peakam`, `peakpm`, `offpeak`, `weekend`, `overnight`
- `length_rank` — `length_rank:longest:10`, `lengthrank:shortest:5`

Example combinations:
- `operator:"London United" borough:camden borough_mode:within`
- `freq:peak_am:8-12 length:10+`
- `type:any garage:X`

---

## Advanced route filters (module)

Designed for “show all routes that satisfy all these conditions.” Build a compound query, then click **Apply filters**.

Core filters
- Route number series ranking (00–99) with optional “series” view.
- Route number search: multiple numbers separated by comma/space (e.g., `12, N205, SL7`).
- Route prefix: choose `N`, `SL`, etc.
- Route types: regular / 24hr / night / school / prefix.
- Garages: allocated garage(s).
- Operators: operator name(s).
- Boroughs: routes wholly within or that enter selected borough(s).
- Vehicles: single- vs double-decker.
- Spatial extremities: most northerly / southerly / easterly / westerly route in the current subset.

Frequency ranges (buses/hour)
- Set min/max per band: Peak AM, Peak PM, Off-peak, Overnight.
- Has overnight service toggle.

Length
- Min/max (miles) from derived geometry stats (indicative, not exact).

Results & export
- Filtered routes show in the right panel; “Show all on map” highlights them; “Export CSV” downloads the table.

---

## Advanced route analyses

Runs summaries over all routes or the current filtered subset. Available analyses include:
- Routes by operator
- Routes by garage
- Service type breakdown by operator
- Fleet composition by operator (SD/DD share)
- Average frequency by operator
- Top routes by Peak AM frequency
- Average length by operator
- Longest and shortest routes
- Most route-only stops (stops served by only that route)
- Route exclusivity (share of route not shared with others)
- Routes sharing the same endpoints
- Route families (heuristic grouping)

Most tables support CSV export.

---

## Bus stop analyses

Runs analyses over a stop-level dataset enriched with route counts, postcodes, and boroughs.

Filters
- Scope: all bus stops.
- Postcode district filter (multi-select, e.g., W1, EC1, SW1).
- Borough filter (single or multiple).
- Region filter: Central / NE / NW / SW / SE.
- Min/Max route count thresholds.

Map overlays
- Top N bus stops by routes per stop.

Analyses
- Top bus stops by route count
- Top bus stops by combined frequency (selected band)
- Bus stop summary by postcode district
- Coverage gaps by postcode district (fewest average routes per stop)
- Routes-per-stop distribution

CSV export supported.

---

## Data freshness (minimal)

Data is derived from TfL Open Data / TfL Unified API and public garage references. Processed outputs are committed under `data/processed/` and refreshed weekly via Python scripts in `scripts/`. If you need to rebuild locally, set `TFL_APP_ID` and `TFL_APP_KEY` (see `.env`) and run the scripts; otherwise rely on the committed datasets.

---

## Project layout

- `index.html` — UI shell and module layout  
- `src/app.js` — main application logic and map interactions  
- `src/advanced_filters.js`, `src/query_engine.js` — search + filter logic  
- `src/analyses.js`, `src/stop_analyses.js` — analytics modules  
- `scripts/` — data fetch + processing pipeline (routes, stops, frequencies, garages)  
- `data/processed/` — browser-ready GeoJSON/JSON outputs

---

## Scope (what this is / isn’t)

RouteMapster is:
- A visual exploration and inspection tool for structure, geography, and relationships.
- A “data product” style project: processed outputs are committed so the app stays fully static.

RouteMapster is not:
- An official TfL product.
- A journey planner, real-time tracker, or replacement for TfL live tools.

---

## Contributing / support

Bug reports or feature requests: open a GitHub issue.  
Quick checks: `npm test`.  
PRs are welcome, respecting the Non-Commercial license.

---

## Keyboard shortcuts (full list)

- `Ctrl+F` / `Cmd+F` open Explorer search
- `G` toggle garages (opens Garages module)
- `B` toggle bus stops (opens Stops module)
- `S` toggle bus stations (opens Stations module)
- `F` toggle frequency overlay (opens Frequencies module)
- `R` show routes (opens Routes module + enables “Show all routes”)
- `A` show all routes
- `0` show 24 hour routes only
- `N` show night routes only
- `P` show prefix routes only
- `H` show school routes only
- `X` open Advanced route filters
- `Y` open Advanced route analyses
- `Z` open Bus stop analyses
- `C` clear all (layers + route highlights)
- `?` open Keyboard Shortcuts modal
- `Esc` close Explorer/About/Keyboard Shortcuts modals
- `Esc` close details panel or advanced filter results (when no modal is open)

Explorer modal keys:
- `ArrowUp` / `ArrowDown` move through results
- `Enter` select highlighted result
- `Esc` close Explorer

---

## License & attribution

RouteMapster is an independent project and is not affiliated with or endorsed by Transport for London.  
Data uses TfL Open Data / Unified API and other public sources under their respective terms (commonly the Open Government Licence v3.0).  
Code licensing: see `LICENSE.md` (RouteMapster Non-Commercial Software License, modified MPL 2.0; commercial use requires explicit permission).

---

## Optional visuals

Add screenshots or a short GIF here when available (e.g., home view, advanced filter in action).

---

Feedback and nitpicks are welcome.
