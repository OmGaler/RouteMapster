/**
 * Covers the browser-side route analysis registry.
 *
 * The tests exercise analysis output in isolation by loading the browser
 * module into a minimal simulated `window` object.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadBrowserModule } = require("./helpers/load_browser_module");

const boroughsGeojson = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      properties: { BOROUGH: "Camden" },
      geometry: {
        type: "Polygon",
        coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]]
      }
    },
    {
      type: "Feature",
      properties: { BOROUGH: "Westminster" },
      geometry: {
        type: "Polygon",
        coordinates: [[[1, 0], [2, 0], [2, 1], [1, 1], [1, 0]]]
      }
    }
  ]
};

/**
 * Load the analysis registry with the browser globals it depends on.
 *
 * @returns {object} `RouteMapsterAnalyses` registry exposed by the browser module.
 */
const loadAnalyses = () => {
  const windowRef = {};
  loadBrowserModule("src/shared_utils.js", { window: windowRef });
  loadBrowserModule("src/geo_utils.js", { window: windowRef });
  loadBrowserModule("src/analyses.js", { window: windowRef });
  loadBrowserModule("src/advanced_filters.js", {
    window: windowRef,
    fetch: async () => ({
      ok: true,
      json: async () => boroughsGeojson
    })
  });
  return windowRef.RouteMapsterAnalyses;
};

test("routes wholly within one borough analysis sorts by descending length and shows borough", async () => {
  const routeGeometries = new Map([
    ["R2", [[[0.4, 0.2], [0.6, 0.3], [0.8, 0.4]]]],
    ["R1", [[[0.2, 1.2], [0.4, 1.4], [0.6, 1.5]]]],
    ["R3", [[[0.4, 0.8], [0.5, 1.2], [0.6, 1.5]]]]
  ]);

  const analyses = loadAnalyses();
  global.window.RouteMapsterAPI = {
    loadRouteGeometry: async (routeId) => routeGeometries.get(routeId) || [],
    setLoadingModalVisible: () => {}
  };

  const result = await analyses.runAnalysis("routes-wholly-within-one-borough", [
    { route_id: "R1", route_id_norm: "R1", length_miles: 7.2 },
    { route_id: "R2", route_id_norm: "R2", length_miles: 9.1 },
    { route_id: "R3", route_id_norm: "R3", length_miles: 12.4 }
  ]);

  assert.equal(result.type, "table");
  assert.deepEqual(result.columns, ["Route", "Length (mi)", "Borough"]);
  assert.deepEqual(result.rows, [
    ["R2", "9.10", "Camden"],
    ["R1", "7.20", "Westminster"]
  ]);
  assert.deepEqual(result.mapOverlay, {
    type: "route-list",
    routeIds: ["R2", "R1"]
  });
});

test("most stop-connected routes analysis ranks by shared-stop totals", async () => {
  const analyses = loadAnalyses();

  const result = await analyses.runAnalysis("most-stop-connected-routes", [
    {
      route_id: "12",
      route_id_norm: "12",
      connected_routes_regular: 5,
      connected_routes_night: 2,
      connected_routes_school: 1,
      connected_routes_total: 8
    },
    {
      route_id: "N12",
      route_id_norm: "N12",
      connected_routes_regular: 4,
      connected_routes_night: 0,
      connected_routes_school: 0,
      connected_routes_total: 4
    },
    {
      route_id: "618",
      route_id_norm: "618",
      connected_routes_regular: 2,
      connected_routes_night: 0,
      connected_routes_school: 1,
      connected_routes_total: 3
    }
  ]);

  assert.equal(result.type, "table");
  assert.deepEqual(result.columns, ["Rank", "Route", "Day routes", "Night", "School", "Total"]);
  assert.deepEqual(result.rows, [
    [1, "12", "5", "2", "1", "8"],
    [2, "N12", "4", "0", "0", "4"],
    [3, "618", "2", "0", "1", "3"]
  ]);
  assert.deepEqual(result.mapOverlay, {
    type: "route-list",
    routeIds: ["12", "N12", "618"]
  });
});
