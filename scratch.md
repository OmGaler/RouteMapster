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


change main routes to reg. routes 

<!-- todo --> 

check brixton BN bus garage
cromwell road bus station, incorrect routes
83


<!-- todo -->
bus stops - https://gis-tfl.opendata.arcgis.com/datasets/bus-stops/explore
bus geoms lines - data.bus.api.tfl ...

weird school routes eg 163


<!-- TODO -->
open gov license 
preprocess data - remove unneded garabage from garages.geojson, when updating data only touch routes, not postcode or location

bus stops.geojson
ash grove incorrectly infers existence of 550 from N550
<!-- todo -->
colour routes by type should apply to filtered routes too 


GH actions - 

notify with any changes - e.g. added route N118, removed route 283
                            or 96 moved from DF to W

<!-- todo -->
write github action that keep route geometries, bus stops, bus garages up to date
<!-- todo -->

optimisation

<!-- Todo: -->
Write tests:
Check bus stations dispalyed in drop down list matches bus_stations.txt
...
Check data works


filter routes by postcode- possibly more than one, e.g. all routes in NW4,NW2



169 and w13 shouldnt be school routes 


https://tfl.gov.uk/corporate/terms-and-conditions/transport-data-service


link bus stations to their stops - that way if they update then the stations will update too 


bus stands broken - probably not available in the tfl api :/



somehow update PVR and proportion of network


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

```bash
TFL_APP_ID=your_app_id
TFL_APP_KEY=your_app_key
```

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


1. Ive added an svg rouetmapster logo in assets/, replace the placeholder RM logo
2. when routes are drawn (e.g. through display only 24 hour routes, or filter or from clicking a garage), display 'x routes selected' in the info box at the top of the module sidebar 
3. change the display/route pill colours - 24hr= tuquoise (16b5f0), prefix routes= the green we currently use for 24hr routes. keep the other colours as they are1.Update bus stop names, the attribute name has changed in the file 
4. bus stop popup route pills always appear in one column - format them to wrap like the garage popups
5. Bus garaegs do not show allocated routes when clicked even though they should
6. Remove load data intake/load placeholder