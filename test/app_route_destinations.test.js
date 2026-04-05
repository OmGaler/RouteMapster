const test = require("node:test");
const assert = require("node:assert/strict");
const { loadBrowserModule } = require("./helpers/load_browser_module");

function loadAppApi(options = {}) {
  const windowRef = options.window || {};
  global.document = {
    addEventListener: () => {}
  };
  loadBrowserModule("src/app.js", { window: windowRef });
  return windowRef.RouteMapsterAPI;
}

test("route destination display lines keep both standard destinations by default", () => {
  const api = loadAppApi();
  const lines = api.getRouteDestinationDisplayLines({
    destination_outbound: "Crystal Palace",
    destination_outbound_full: "Crystal Palace",
    destination_inbound: "Victoria",
    destination_inbound_full: "Victoria",
    destination_inbound_qualifier: "Victoria Bus Station"
  });

  assert.deepEqual(lines, ["Crystal Palace", "Victoria"]);
});

test("station route destination display lines hide the terminating station end", () => {
  const api = loadAppApi();
  const lines = api.getRouteDestinationDisplayLines(
    {
      destination_outbound: "Crystal Palace",
      destination_outbound_full: "Crystal Palace",
      destination_inbound: "Victoria",
      destination_inbound_full: "Victoria",
      destination_inbound_qualifier: "Victoria Bus Station"
    },
    {
      entityType: "station",
      stationName: "Victoria Bus Station"
    }
  );

  assert.deepEqual(lines, ["Crystal Palace"]);
});

test("station route destination display lines match qualifier-only station names", () => {
  const api = loadAppApi();
  const lines = api.getRouteDestinationDisplayLines(
    {
      destination_outbound: "Canada Water",
      destination_outbound_full: "Canada Water",
      destination_outbound_qualifier: "Canada Water Bus Station",
      destination_inbound: "Hampstead Heath",
      destination_inbound_full: "Hampstead Heath, South End Green"
    },
    {
      entityType: "station",
      stationName: "Canada Water Bus Station"
    }
  );

  assert.deepEqual(lines, ["Hampstead Heath"]);
});

test("bus stop display features return the focused stop when it has coordinates", () => {
  const api = loadAppApi();
  const first = { properties: { NAPTAN_ID: "s1" }, geometry: { coordinates: [-0.1, 51.5] } };
  const second = { properties: { NAPTAN_ID: "s2" }, geometry: { coordinates: [-0.11, 51.51] } };

  const features = api.getBusStopDisplayFeatures([first, second], second);

  assert.equal(features.length, 1);
  assert.equal(features[0], second);
});

test("bus stop display features fall back to all filtered stops when the focused stop is invalid", () => {
  const api = loadAppApi();
  const first = { properties: { NAPTAN_ID: "s1" }, geometry: { coordinates: [-0.1, 51.5] } };
  const second = { properties: { NAPTAN_ID: "s2" }, geometry: { coordinates: [-0.11, 51.51] } };
  const invalid = { properties: { NAPTAN_ID: "sx" }, geometry: { coordinates: [] } };

  const features = api.getBusStopDisplayFeatures([first, second], invalid);

  assert.deepEqual(features, [first, second]);
});

test("endpoint route clusters group nearby termini and deduplicate route ids", () => {
  const api = loadAppApi();
  const clusters = api.buildEndpointRouteClusters(
    [
      { routeId: "12", lat: 51.5000, lon: -0.1000 },
      { routeId: "25", lat: 51.5005, lon: -0.1003 },
      { routeId: "N5", lat: 51.5004, lon: -0.0998 },
      { routeId: "12", lat: 51.5001, lon: -0.1001 },
      { routeId: "99", lat: 51.5100, lon: -0.1200 }
    ],
    { thresholdMeters: 120 }
  );

  assert.equal(clusters.length, 2);
  assert.deepEqual(clusters[0].routeIds, ["12", "25", "N5"]);
  assert.deepEqual(clusters[1].routeIds, ["99"]);
});

test("adaptive endpoint clustering reduces marker count when the target is low", () => {
  const api = loadAppApi();
  const points = [
    { routeId: "1", lat: 51.5000, lon: -0.1000 },
    { routeId: "2", lat: 51.5008, lon: -0.1000 },
    { routeId: "3", lat: 51.5016, lon: -0.1000 },
    { routeId: "4", lat: 51.5024, lon: -0.1000 }
  ];

  const result = api.buildAdaptiveEndpointRouteClusters(points, {
    thresholdMeters: 30,
    maxThresholdMeters: 300,
    targetClusterCount: 2
  });

  assert.equal(result.clusters.length, 2);
  assert.ok(result.thresholdMeters > 30);
});

test("endpoint cluster render limit trims low-zoom overlays", () => {
  const api = loadAppApi();
  const clusters = Array.from({ length: 12 }, (_, index) => ({
    lat: 51.5 + (index * 0.001),
    lon: -0.1,
    routeIds: [`R${index + 1}`]
  }));

  const limited = api.limitEndpointClustersForZoom(clusters, 9);

  assert.equal(limited.length, 6);
  assert.deepEqual(limited[0], clusters[0]);
  assert.deepEqual(limited[5], clusters[5]);
});

test("endpoint markers stay hidden until the minimum zoom threshold", () => {
  const api = loadAppApi();

  assert.equal(api.shouldRenderEndpointMarkers(true, 13), false);
  assert.equal(api.shouldRenderEndpointMarkers(true, 14), true);
  assert.equal(api.shouldRenderEndpointMarkers(false, 15), false);
  assert.equal(api.shouldRenderEndpointMarkers(true, 12, true), true);
  assert.equal(api.shouldRenderEndpointMarkers(true, 16, true, true), false);
});

test("filtered route-set detection ignores the broad all-routes view", () => {
  const api = loadAppApi();

  assert.equal(api.isFilteredRouteSetActive({
    showAllRoutes: true,
    showAllDeckers: true,
    routeTypeToggles: [true, true, true, true, true],
    routeFilterTokens: []
  }), false);

  assert.equal(api.isFilteredRouteSetActive({
    activeBusStopRoutes: ["12", "25"],
    showAllRoutes: true,
    showAllDeckers: true,
    routeTypeToggles: [true, true, true, true, true],
    routeFilterTokens: []
  }), true);

  assert.equal(api.isFilteredRouteSetActive({
    analysisActive: true,
    analysisEndpointMarkerMode: "base-threshold",
    showAllRoutes: true,
    showAllDeckers: true,
    routeTypeToggles: [true, true, true, true, true],
    routeFilterTokens: []
  }), false);

  assert.equal(api.isFilteredRouteSetActive({
    showAllRoutes: false,
    showAllDeckers: true,
    routeTypeToggles: [true, false, true, true, true],
    routeFilterTokens: []
  }), true);
});

test("endpoint pill route ids are collected from visible layer groups", () => {
  const api = loadAppApi();
  const layers = [
    {
      eachLayer(callback) {
        callback({ _routeId: "25" });
        callback({
          eachLayer(innerCallback) {
            innerCallback({ _routeId: "N5" });
            innerCallback({ _routeId: "25" });
          }
        });
      }
    },
    {
      eachLayer(callback) {
        callback({ _routeId: "12" });
      }
    }
  ];

  const routeIds = api.collectEndpointPillRouteIdsFromLayers(layers);

  assert.deepEqual(routeIds, ["12", "25", "N5"]);
});

test("endpoint entries are derived from rendered route layers", () => {
  const api = loadAppApi();
  const layers = [
    {
      eachLayer(callback) {
        callback({
          _routeId: "12",
          getLatLngs() {
            return [
              { lat: 51.5, lng: -0.1 },
              { lat: 51.51, lng: -0.11 }
            ];
          }
        });
        callback({
          _routeId: "25",
          getLatLngs() {
            return [
              { lat: 51.52, lng: -0.12 },
              { lat: 51.53, lng: -0.13 }
            ];
          }
        });
      }
    }
  ];

  const entries = api.collectEndpointEntriesFromLayers(layers);

  assert.deepEqual(entries, [
    { routeId: "12", lat: 51.5, lon: -0.1 },
    { routeId: "12", lat: 51.51, lon: -0.11 },
    { routeId: "25", lat: 51.52, lon: -0.12 },
    { routeId: "25", lat: 51.53, lon: -0.13 }
  ]);
});

test("supports hover interactions when any fine hover pointer is available", () => {
  const api = loadAppApi({
    window: {
      matchMedia(query) {
        if (query === "(any-hover: hover) and (any-pointer: fine)") {
          return { matches: true };
        }
        if (query === "(hover: hover) and (pointer: fine)") {
          return { matches: false };
        }
        return { matches: false };
      }
    }
  });

  assert.equal(api.supportsHoverInteractions(), true);
});

test("supports hover interactions on desktop-width layouts even when hover media queries fail", () => {
  const api = loadAppApi({
    window: {
      matchMedia(query) {
        if (query === "(max-width: 900px)") {
          return { matches: false };
        }
        return { matches: false };
      }
    }
  });

  assert.equal(api.supportsHoverInteractions(), true);
});

test("configure map panes leaves non-highlight panes at Leaflet defaults", () => {
  const api = loadAppApi();
  const panes = new Map();
  const map = {
    createPane(name) {
      const pane = { style: {} };
      panes.set(name, pane);
      return pane;
    }
  };

  api.configureMapPanes(map);

  assert.equal(panes.get("highlight-pane").style.pointerEvents, "none");
  assert.equal(Object.prototype.hasOwnProperty.call(panes.get("routes-pane").style, "pointerEvents"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(panes.get("stops-pane").style, "pointerEvents"), false);
});

test("interactive point renderer does not force pointer events on the root svg", () => {
  const renderer = {
    _container: {
      style: {}
    }
  };
  const api = loadAppApi({
    window: {
      L: {
        svg(options) {
          renderer.options = options;
          return renderer;
        }
      }
    }
  });
  global.L = {
    svg(options) {
      renderer.options = options;
      return renderer;
    }
  };

  const result = api.createInteractivePointRenderer("stops-pane", false);

  assert.equal(result, renderer);
  assert.equal(renderer.options.pane, "stops-pane");
  assert.equal(renderer.options.tolerance, 10);
  assert.equal(Object.prototype.hasOwnProperty.call(renderer._container.style, "pointerEvents"), false);
});
