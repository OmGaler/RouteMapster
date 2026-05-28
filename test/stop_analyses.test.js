/**
 * Covers stop insight map display decisions.
 *
 * The tests keep the browser module isolated from the DOM and focus on the
 * shape passed to the Leaflet overlay renderer.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadBrowserModule } = require("./helpers/load_browser_module");

const loadStopAnalyses = () => {
  const windowRef = {};
  loadBrowserModule("src/shared_utils.js", { window: windowRef });
  loadBrowserModule("src/geo_utils.js", { window: windowRef });
  loadBrowserModule("src/stop_analyses.js", { window: windowRef });
  return windowRef.RouteMapsterStopAnalyses.__test;
};

const resetState = (state) => {
  state.frequencyAvailable = true;
  state.frequencyBand = "peak_am";
  state.centralityAvailable = false;
  state.activeStopNameHighlight = "";
  state.mapMode = "filtered";
  state.mapTopN = 50;
  state.mapTopMetric = "route_count";
  state.mapColourMetric = "route_count";
};

test("heatmap mode passes weighted heatmap options for frequency totals", () => {
  const api = loadStopAnalyses();
  resetState(api.state);
  api.state.mapMode = "heatmap";
  api.state.mapColourMetric = "frequency_total";
  api.state.frequencyBand = "weekend";

  const display = api.buildMapDisplay([
    { id: "A", lat: 51.5, lon: -0.1, route_count: 2, frequency: { weekend: 7 } },
    { id: "B", lat: 51.6, lon: -0.2, route_count: 5, frequency: { weekend: 18 } }
  ]);

  assert.equal(display.stops.length, 2);
  assert.equal(display.showLegend, true);
  assert.deepEqual(display.options, {
    visualisation: "heatmap",
    weightBy: "frequency_total",
    frequencyBand: "weekend"
  });
  assert.match(display.note, /weighted heatmap/);
});

test("heatmap mode falls back to density when no weight metric is selected", () => {
  const api = loadStopAnalyses();
  resetState(api.state);
  api.state.mapMode = "heatmap";
  api.state.mapColourMetric = "";

  const display = api.buildMapDisplay([
    { id: "A", lat: 51.5, lon: -0.1, route_count: 2 },
    { id: "B", lat: 51.6, lon: -0.2, route_count: 5 }
  ]);

  assert.equal(display.showLegend, false);
  assert.deepEqual(display.options, {
    visualisation: "heatmap",
    weightBy: "",
    frequencyBand: "peak_am"
  });
  assert.match(display.note, /heatmap density/);
});

test("frequency weighting is unavailable when frequency data is absent", () => {
  const api = loadStopAnalyses();
  resetState(api.state);
  api.state.frequencyAvailable = false;

  assert.equal(api.resolveMetricSelection("frequency_total", api.state, { allowNone: true }), "");
});

test("stop name suffixes normalise common suffix phrases", () => {
  const api = loadStopAnalyses();

  assert.deepEqual(api.deriveStopNameSuffix("Bromley High Street"), {
    key: "high street",
    label: "High Street"
  });
  assert.deepEqual(api.deriveStopNameSuffix("Highgate High Street"), {
    key: "high street",
    label: "High Street"
  });
  assert.deepEqual(api.deriveStopNameSuffix("King's Cross Station"), {
    key: "station",
    label: "Station"
  });
  assert.deepEqual(api.deriveStopNameSuffix("East Finchley Station"), {
    key: "station",
    label: "Station"
  });
});

test("common stop suffix analysis groups examples and exposes suffix highlighting metadata", () => {
  const api = loadStopAnalyses();
  resetState(api.state);
  api.state.activeStopSuffixHighlight = "high street";

  const [entry] = api.runAnalyses("common-stop-suffixes", [
    { name: "Bromley High Street", borough: "Bromley", route_count: 3 },
    { name: "Highgate High Street", borough: "Haringey", route_count: 4 },
    { name: "King's Cross Station", borough: "Camden", route_count: 8 },
    { name: "East Finchley Station", borough: "Barnet", route_count: 5 }
  ], {
    frequencyAvailable: false,
    centralityAvailable: false
  });

  assert.equal(entry.result.type, "table");
  assert.deepEqual(entry.result.columns, [
    "Rank",
    "Suffix",
    "Bus stops",
    "Names",
    "Boroughs",
    "Avg routes",
    "Examples"
  ]);
  assert.equal(entry.result.rows[0][1], "High Street");
  assert.equal(entry.result.rows[0][2], 2);
  assert.equal(entry.result.rows[0][6].text, "Bromley High Street; Highgate High Street; Boroughs: Bromley, Haringey");
  assert.deepEqual(entry.result.meta.rowMeta[0], { highlightSuffix: "high street" });
  assert.equal(entry.result.meta.activeRowKey, "high street");
});

test("active stop suffix highlight narrows the map display", () => {
  const api = loadStopAnalyses();
  resetState(api.state);
  api.state.activeStopSuffixHighlight = "station";

  const display = api.buildMapDisplay([
    { name: "King's Cross Station", lat: 51.53, lon: -0.12, route_count: 8 },
    { name: "East Finchley Station", lat: 51.59, lon: -0.16, route_count: 5 },
    { name: "Bromley High Street", lat: 51.4, lon: 0.02, route_count: 3 }
  ]);

  assert.equal(display.stops.length, 2);
  assert.match(display.note, /suffix Station/);
});

test("active stop suffix highlight respects heatmap mode", () => {
  const api = loadStopAnalyses();
  resetState(api.state);
  api.state.mapMode = "heatmap";
  api.state.mapColourMetric = "";
  api.state.activeStopSuffixHighlight = "station";

  const display = api.buildMapDisplay([
    { name: "King's Cross Station", lat: 51.53, lon: -0.12, route_count: 8 },
    { name: "East Finchley Station", lat: 51.59, lon: -0.16, route_count: 5 },
    { name: "Bromley High Street", lat: 51.4, lon: 0.02, route_count: 3 }
  ]);

  assert.deepEqual(display.options, {
    visualisation: "heatmap",
    weightBy: "",
    frequencyBand: "peak_am"
  });
});
