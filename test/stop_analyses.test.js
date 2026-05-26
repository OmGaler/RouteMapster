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
