# ci data 
1. garages data (garages.csv from lbr.net -? geojson)
2. bus route geometries (xml from tfl -> geojson)
3. bus stop data (from tfl api)
4. frequencies
5. single/double deckers

# route families
# garages

reload garages.csv from londonbusroutes.net every so often
reload route geometries from tfl everyso often..

# combined frequencies along corridors
# postcode analysis
# night buses/school buses/ prefix buses
# bus stop centrality
# bus route similarity


https://tfl.gov.uk/corporate/terms-and-conditions/transport-data-service

vercel



# RouteMapster — Skeleton

This repository contains a minimal skeleton for a bus-routes visualiser focused on London. It includes a Leaflet map, UI sidebars, and a fully automated data pipeline that refreshes processed GeoJSON outputs.

Quick start

Open `index.html` in a browser (no build step required). For local development with live reload, serve the folder using a static server (e.g., `npx serve`).

If you want a simple static server instead, run:

```bash
npm start
```

Processed datasets live under `data/processed/` and are safe to commit. Raw upstream files are fetched into `data/raw/` and ignored by git.

Data pipeline

The data refresh pipeline lives in `scripts/` and is automated via GitHub Actions. To run it manually:

```bash
python -m pip install -r scripts/requirements.txt
python scripts/fetch_tfl_routes.py
python scripts/process_routes_xml_to_geojson.py
python scripts/fetch_bus_stops.py
python scripts/fetch_and_process_garages.py
```

Bus stop fetches use the TfL Unified API. Provide credentials via environment variables or a `.env` file
in the repo root:


What to implement next
- Replace `loadPlaceholderData()` in `src/index.js` with fetches to real TfL/Open Data endpoints.
- Implement data models for routes, stops, garages, and frequency aggregations.
- Add analytical modules for centrality and route-family grouping.

TfL / data sources to consider
- TfL Unified API: https://api.tfl.gov.uk — vehicle arrivals, line and stop data, timetables
- TfL Open Data feeds (CSV/GTFS): stops, routes, shapes
- OpenStreetMap basemaps (used via Leaflet) for geometry and context

Attribution

Bus route geometry, stops, and garage data are sourced from TfL Open Data and LondonBusRoutes, made available under the Open Government Licence v3.0. See `DATA_LICENSE.md` for details.

# Data License

Processed datasets in this repository are derived from the following sources:

- TfL bus route geometry (https://bus.data.tfl.gov.uk/bus-geometry/)
- TfL Open GIS Hub bus stops datasets (ArcGIS Hub)
- LondonBusRoutes garage allocations (http://www.londonbusroutes.net/garages.htm)

These sources are made available under the Open Government Licence v3.0:
https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/

The data has been modified for this project, including conversion to GeoJSON,
geometry simplification, and attribute slimming. Raw source files are not
versioned in this repository.
--



---

further steps

1. Network structure & topology

Stop centrality

Degree: number of routes serving each stop

Weighted degree: number of buses per hour serving the stop

Betweenness: stops that sit on many shortest paths (transfer importance)

Route overlap

Count shared stop sequences between routes

Identify trunk corridors (many routes sharing the same geometry)

Measure “uniqueness” of routes (percentage of stops not shared)

Interchange analysis

Stops served by ≥ N routes

Proximity-based interchanges (stops within X metres)

Cross-platform or paired-interchange analogues for rail-style data

Graph metrics

Convert stops → nodes, route segments → edges

Average path length across the network

Network fragmentation if a stop/edge is removed

2. Spatial & geographic analysis

Catchment analysis

Stops per km² by borough or zone

Population-per-stop (if census data is joined)

Walkable access: stops within 400 m of another stop

Service density

Bus frequency heatmaps along corridors

Stops with high service vs poor coverage areas

Route km per borough / zone

Edge length statistics

Average inter-stop spacing by route

Identify routes with irregular spacing (often legacy or rural)

3. Frequency, service level & reliability (if data exists)

Frequency aggregation

Buses per hour per stop

Peak vs off-peak service ratios

Night vs day route coverage

Corridor capacity

Aggregate frequency for shared road segments

Identify over-served vs under-served corridors

Service span

First bus / last bus per route

Stops with no late-night coverage

4. Equity & accessibility analysis

Service equity

Frequency per capita by area

Coverage of essential locations (hospitals, schools, hubs)

Zone fairness

Average journey length within each fare zone

Cross-zone dependency analysis

Accessibility scoring

Number of jobs / POIs reachable within X minutes

Stops reachable with ≤ 1 interchange

5. Operational & planning insights

Route efficiency

Route length vs number of stops

Frequency per km (resource intensity)

Duplication detection

Routes ≥ 80% identical in geometry or stop sequence

Candidate routes for interlining or consolidation

Resilience testing

Remove a major hub stop and recalculate reachability

Identify single-point-of-failure stops

6. Time-based & longitudinal analysis

Change detection

Compare two snapshots of routes (before/after changes)

Stops added / removed over time

Geometry drift detection

Network growth

Route km added per year

New stops per borough over time

7. Classification & modelling

Stop typologies

Cluster stops by:

Routes served

Frequency

Interchange count

E.g. local stop vs feeder vs hub

Route typologies

Radial / orbital / feeder / trunk

Express vs local based on stop spacing

Anomaly detection

Stops with unusually high/low service

Routes with inconsistent inter-stop distances

8. Practical applications (beyond analysis)

User-facing

Journey time estimators

“Best stop to use” recommendations

Identify fastest corridor rather than route

Planning tools

Candidate stops for upgrades (shelters, bus lanes)

Where to add limited-stop or express overlays

Visual products

Ranked tables (top 20 busiest stops)

Borough service scorecards

Corridor frequency bands

9. DataFrame patterns you’d naturally use

groupby(stop_id).agg() → stop importance

explode(route_stops) → stop-level analysis

merge() with boroughs / zones / census

rolling() for time-based service patterns

networkx.from_pandas_edgelist() for graph work