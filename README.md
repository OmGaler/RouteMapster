# RouteMapster

![RouteMapster logo](assets/routemapster.png)

RouteMapster is an interactive, map-based explorer for the London bus network. RouteMapster makes it easy to see how routes, stops, stations, garages, operators, and service patterns all fit together within the network — with quick search, flexible filters, and exportable analyses. Independent, open-source, non-commercial and not in any way affiliated with Transport for London (TfL).

## What you can explore

- **Routes**, coloured by service type (regular / 24‑hour / night / school / prefix).  
- **Bus stops** and stations with hover/click details on routes that serve them.  
- **Garages** with operator and route allocations.
- **Frequencies** view showing combined frequencies along shared corridors.  
- **Explorer** quick search (`Ctrl+F`) to jump to routes, stops, stations, garages.  
- **Advanced filters and analyses** for complex queries.  
- **CSV exports** from filters and analyses.

## Using the app

- **Explorer:** Click the search button or use `Ctrl+F` to invoke Explorer, then type a route/stop/garage, and press enter to focus a result from the list.  
- **Toggle layers:** Use the sidebar buttons or shortcuts to switch between routes, stops, stations, garages and frequencies.  

## Keyboard shortcuts

- `Ctrl+F` / `Cmd+F` open Explorer search
- `G` toggle garages (opens Garages module)
- `B` toggle bus stops (opens Stops module)
- `S` toggle bus stations (opens Bus Stations module)
- `F` toggle frequency overlay (opens Frequencies module)
- `R` show routes (opens Routes module + enables "Show all routes")
- `A` show all routes
- `0` show 24 hour routes only
- `N` show night routes only
- `P` show prefix routes only
- `H` show school routes only
- `X` open Advanced route filters
- `Y` open Advanced route analyses
- `Z` open Bus stop analyses
- `C` clear all (layers + highlighted routes)
- `?` open Keyboard Shortcuts list
- `Esc` close Explorer/details panel/advanced filter results
## Modules

### Advanced route filters

RouteMapster provides the ability to construct custom queries that present the user with a list of all routes that satisfy given conditions." Build a compound query, then click **Apply filters**.

Core filters

- Route number search: supports multiple routes separated by commas or spaces (e.g., `12, N205, SL7`).
- Route number series: return all routes that belong to a given series (00–99), e.g. for 25: 25, 125, 225, 325, 425, 625, N25, and optionally, H25 (if prefix routes are included).
- Route prefix: filter routes by their letter prefix, e.g. `C`, `N`, `SL`, etc.
- Route types: regular / 24hr / night / school / prefix.
- Garages: allocated garage(s).
- Operators: operator name(s).
- Boroughs: routes wholly within or that enter selected borough(s).
- Vehicles: single- vs double-decker.
- Spatial extremities: most northerly / southerly / easterly / westerly route in the current subset.

Length

- Min/max route length in miles, derived from the route geometry (indicative, non-exact).

Frequency ranges (in buses per hour)

- Set min/max per band: Peak AM, Peak PM, Off-peak, Weekend, Overnight.
- Filter routes that run overnight.

Results & export

- Filtered routes show in the right panel; "Show all on map" highlights them; "Export CSV" downloads the table in a spreadsheet-compatible format.

---

#### Advanced filters Syntax

- Advanced filters can also be constructed directly from Explorer, using the following syntax:
- Format: `key:value` tokens separated by spaces; use quotes for values with spaces and separate multiple values with commas (`vehicle:DD,SD`).  
- Triggered when: multiple tokens, or a single advanced-only key (`vehicle:DD`, `length:10+`, `freq:peak_am:8+`, `spatial:east`). 
- Force advanced mode with `type:any`. Optional prefixes: `filter:`, `filters:`, `advanced:`, `adv:`.
- **Combine filters:** For example, `garage:PD spatial:east vehicle:DD` returns the easternmost double‑deck route allocated to Plumstead Bus Garage.

Valid keys:
- `route` / `routeno` / `route#` / `routeid` — `route:N205,SL7`
- `prefix` — `prefix:N`
- `series` — `series:40` or `series:40+`, `include_prefixes:true`
- `type` — `regular`, `night`, `school`, `prefix`, `24`, `24hr`, `24hour`, `24-hour`, `twentyfour`
- `operator` — `operator:"Metroline"`
- `garage` — `garage:PD`
- `borough` — `borough:camden` (optional `borough_mode:within`)
- `vehicle` — `vehicle:DD`
- `spatial` — `north/south/east/west` or `n/s/e/w`
- `overnight` — boolean (`overnight:true`) or overnight frequency band (`overnight:4+`)
- `length` ranges — `10+`, `5-12`, `>=8`, `<=14`
- `freq` ranges — `freq:peak_am:8-12`, `freq:weekend:>=6`; bands: `peakam`, `peakpm`, `offpeak`, `weekend`, `overnight`
- `length_rank` — `length_rank:longest:10`, `lengthrank:shortest:5`

Example combinations:
- `operator:"Go Ahead" borough:camden borough_mode:within`
- `freq:peak_am:8-12 length:10+`
- `type:any garage:X`

### Advanced route analyses

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
- Route exclusivity (proportion of route not shared with any other route)
- Routes sharing the same endpoints
- Route families (heuristic grouping)

Most result tables support CSV export.

## Bus stop filters and analyses

Runs analyses over a bus stop dataset enriched with route counts, postcodes, and boroughs.

Filters
- Postcode district filter (multi-select, e.g., W1, EC1, SW1).
- Borough filter (choose one or more borough(s)).
- Region filter: Central / NE / NW / SW / SE.
- Filter by route count.

Map overlays

- Top N bus stops by routes per stop.

Analyses

- Top bus stops by route count
- Top bus stops by combined frequency (selected band)
- Bus stop summary by postcode district
- Coverage gaps by postcode district (fewest average routes per stop)
- Routes-per-stop distribution

CSV export supported.

## Data freshness

Data is derived from TfL Open Data and the TfL Unified API and public garage references. Processed outputs are committed under `data/processed/` and refreshed weekly using GitHub Actions.

## Project layout

- `index.html` — UI shell and module layout  
- `src/app.js` — main application logic and map interactions  
- `src/advanced_filters.js`, `src/query_engine.js` — search and filter logic  
- `src/analyses.js`, `src/stop_analyses.js` — analytics modules  
- `scripts/` — data fetch and processing pipeline (routes, stops, frequencies, garages)  
- `data/processed/` — processed geodatasets
### Disclaimers 
RouteMapster is not:
- An official TfL product.
- A journey planner, real-time tracker, or replacement for TfL live tools.

---

## Contact / Support

Feedback and nitpicks are welcome, and whilst every effort has been made to ensure information is correct, should you find any errors, please do bring them to attention by opening a [GitHub issue](https://github.com/OmGaler/RouteMapster/issues).
Please also submit any bug reports or feature requests by opening a GitHub issue at the link above.

For anything else, email route-mapster [a] omergaler [dot] com

## License & attribution

RouteMapster is an independent project and is not affiliated with or endorsed by Transport for London.  
Data uses TfL Open Data / Unified API and other public sources under their respective terms (commonly the Open Government Licence v3.0).  
Code licensing: see `LICENSE.md` (RouteMapster Non-Commercial Software License, modified MPL 2.0; commercial use requires explicit permission).