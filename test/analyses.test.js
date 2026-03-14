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
