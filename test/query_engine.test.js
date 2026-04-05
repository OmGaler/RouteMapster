/**
 * Covers the browser-side query engine used by route filtering and analysis.
 *
 * The tests validate canonicalisation, filtering, derived metrics, and the
 * lightweight CSV-loading path used by the browser bundle.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadBrowserModule } = require("./helpers/load_browser_module");

/**
 * Load the browser-side query engine with optional mocked globals.
 *
 * @param {{window?: object, fetch?: Function}} [options={}] Optional globals to inject before loading.
 * @returns {object} `RouteMapsterQueryEngine` API exposed by the browser module.
 */
const loadEngine = (options = {}) => {
  const windowRef = loadBrowserModule("src/query_engine.js", options);
  return windowRef.RouteMapsterQueryEngine;
};

const sampleRows = [
  {
    route_id: "12",
    route_id_norm: "12",
    route_type: "regular",
    operator_names_norm: ["operator a"],
    garage_tokens_norm: ["pd", "garage pd"],
    boroughs_norm: ["camden", "westminster"],
    vehicle_type: "DD",
    frequency_peak_am: 8,
    frequency_peak_pm: 10,
    frequency_offpeak: 6,
    frequency_weekend: 5,
    frequency_overnight: 0,
    length_miles: 7.5,
    unique_stops: 41,
    northmost_lat: 51.6,
    southmost_lat: 51.4,
    eastmost_lon: 0.1,
    westmost_lon: -0.2
  },
  {
    route_id: "N12",
    route_id_norm: "N12",
    route_type: "night",
    operator_names_norm: ["operator b"],
    garage_tokens_norm: ["ab", "garage ab"],
    boroughs_norm: ["camden"],
    vehicle_type: "SD",
    frequency_peak_am: 4,
    frequency_peak_pm: 5,
    frequency_offpeak: 4,
    frequency_weekend: 4,
    frequency_overnight: 3,
    length_miles: 9.2,
    unique_stops: 56,
    northmost_lat: 51.7,
    southmost_lat: 51.3,
    eastmost_lon: 0.2,
    westmost_lon: -0.25
  },
  {
    route_id: "SL1",
    route_id_norm: "SL1",
    route_type: "twentyfour",
    operator_names_norm: ["operator c"],
    garage_tokens_norm: ["xy", "garage xy"],
    boroughs_norm: ["hounslow", "ealing"],
    vehicle_type: "DD",
    frequency_peak_am: 12,
    frequency_peak_pm: 11,
    frequency_offpeak: 9,
    frequency_weekend: 8,
    frequency_overnight: 2,
    length_miles: 12.3,
    unique_stops: 29,
    northmost_lat: 51.65,
    southmost_lat: 51.35,
    eastmost_lon: -0.05,
    westmost_lon: -0.4
  }
];

test("normalizeFilterSpec canonicalizes inputs", () => {
  const engine = loadEngine();

  const spec = engine.normalizeFilterSpec({
    route_ids: [" 12 ", "n12"],
    route_prefix: " n ",
    route_types: ["Night", " regular "],
    operators: [" Operator A "],
    garages: [" PD "],
    boroughs: [" City of London "],
    borough_mode: "within",
    vehicle_types: ["dd", " sd "],
    length_miles: { min: 5, max: 10 },
    unique_stops: { min: 20, max: 60 },
    length_rank: { mode: "longest", count: 3 },
    unique_stops_rank: { mode: "most", count: 2 },
    extreme: "north",
    route_series: 12,
    include_prefix_routes: true
  });

  assert.deepEqual(spec.route_ids, ["12", "n12"]);
  assert.equal(spec.route_prefix, "n");
  assert.deepEqual(spec.route_types, ["night", "regular"]);
  assert.deepEqual(spec.operators, ["operator a"]);
  assert.deepEqual(spec.garages, ["pd"]);
  assert.deepEqual(spec.boroughs, ["city of london"]);
  assert.equal(spec.borough_mode, "within");
  assert.deepEqual(spec.vehicle_types, ["DD", "SD"]);
  assert.deepEqual(spec.length_miles, { min: 5, max: 10 });
  assert.deepEqual(spec.unique_stops, { min: 20, max: 60 });
  assert.deepEqual(spec.length_rank, { mode: "longest", count: 3 });
  assert.deepEqual(spec.unique_stops_rank, { mode: "most", count: 2 });
  assert.equal(spec.extreme, "north");
  assert.equal(spec.route_series, 12);
  assert.equal(spec.include_prefix_routes, true);
});

test("normalizeFilterSpec rejects invalid rank and series", () => {
  const engine = loadEngine();

  const spec = engine.normalizeFilterSpec({
    length_rank: { mode: "largest", count: 200 },
    unique_stops_rank: { mode: "highest", count: 99 },
    route_series: 120,
    include_prefix_routes: true
  });

  assert.equal(spec.length_rank, undefined);
  assert.equal(spec.unique_stops_rank, undefined);
  assert.equal(spec.route_series, undefined);
  assert.equal(spec.include_prefix_routes, undefined);
});

test("applyFilters filters by route ids, prefix, operators and garages", () => {
  const engine = loadEngine();

  const result = engine.applyFilters(sampleRows, {
    route_ids: ["12", "SL1"],
    route_prefix: "S",
    operators: ["operator c"],
    garages: ["xy"]
  });

  assert.equal(result.length, 1);
  assert.equal(result[0].route_id_norm, "SL1");
});

test("applyFilters supports series logic with and without prefixed routes", () => {
  const engine = loadEngine();

  const withoutPrefixes = engine.applyFilters(sampleRows, {
    route_series: 12,
    include_prefix_routes: false
  });
  const withPrefixes = engine.applyFilters(sampleRows, {
    route_series: 12,
    include_prefix_routes: true
  });

  assert.deepEqual(withoutPrefixes.map((row) => row.route_id_norm), ["12", "N12"]);
  assert.deepEqual(withPrefixes.map((row) => row.route_id_norm), ["12", "N12"]);
});

test("applyFilters excludes SL routes from series matching", () => {
  const engine = loadEngine();

  const result = engine.applyFilters(sampleRows, { route_series: 1, include_prefix_routes: true });
  assert.deepEqual(result.map((row) => row.route_id_norm), []);
});

test("applyFilters handles borough enter mode with loose matching", () => {
  const engine = loadEngine();

  const result = engine.applyFilters(sampleRows, { boroughs: ["cityoflondon", "hounslow"] });
  assert.deepEqual(result.map((row) => row.route_id_norm), ["SL1"]);
});

test("applyFilters handles borough within mode", () => {
  const engine = loadEngine();

  const result = engine.applyFilters(sampleRows, {
    boroughs: ["camden"],
    borough_mode: "within"
  });
  assert.deepEqual(result.map((row) => row.route_id_norm), ["N12"]);
});

test("applyFilters handles frequency and flags constraints", () => {
  const engine = loadEngine();

  const result = engine.applyFilters(sampleRows, {
    freq: {
      peak_am: { min: 4 },
      weekend: { max: 5 }
    },
    flags: {
      has_overnight: false,
      high_frequency_any: 9
    }
  });

  assert.deepEqual(result.map((row) => row.route_id_norm), ["12"]);
});

test("applyFilters handles length range", () => {
  const engine = loadEngine();

  const result = engine.applyFilters(sampleRows, {
    length_miles: { min: 8, max: 13 }
  });

  assert.deepEqual(result.map((row) => row.route_id_norm), ["N12", "SL1"]);
});

test("applyFilters handles unique stop range", () => {
  const engine = loadEngine();

  const result = engine.applyFilters(sampleRows, {
    unique_stops: { min: 30, max: 50 }
  });

  assert.deepEqual(result.map((row) => row.route_id_norm), ["12"]);
});

test("applyFilters handles extreme and rank selectors", () => {
  const engine = loadEngine();

  const north = engine.applyFilters(sampleRows, { extreme: "north" });
  const shortestTwo = engine.applyFilters(sampleRows, {
    length_rank: { mode: "shortest", count: 2 }
  });
  const mostStopsTwo = engine.applyFilters(sampleRows, {
    unique_stops_rank: { mode: "most", count: 2 }
  });
  const leastStopsOne = engine.applyFilters(sampleRows, {
    unique_stops_rank: { mode: "least", count: 1 }
  });

  assert.deepEqual(north.map((row) => row.route_id_norm), ["N12"]);
  assert.deepEqual(shortestTwo.map((row) => row.route_id_norm), ["12", "N12"]);
  assert.deepEqual(mostStopsTwo.map((row) => row.route_id_norm), ["N12", "12"]);
  assert.deepEqual(leastStopsOne.map((row) => row.route_id_norm), ["SL1"]);
});

test("computeDerivedFields computes overnight and peakiness", () => {
  const engine = loadEngine();

  const [first, second] = engine.computeDerivedFields(sampleRows);
  assert.equal(first.has_overnight, false);
  assert.equal(second.has_overnight, true);
  assert.equal(first.peakiness_index, 3);
});

test("serializeFilterSpec and parseFilterSpec round-trip", () => {
  const engine = loadEngine();
  const spec = {
    route_ids: ["12"],
    route_types: ["night"],
    unique_stops: { min: 10 },
    freq: { peak_am: { min: 5 } },
    flags: { has_overnight: true }
  };

  const encoded = engine.serializeFilterSpec(spec);
  const decoded = engine.parseFilterSpec(encoded);

  assert.deepEqual(decoded.route_ids, ["12"]);
  assert.deepEqual(decoded.route_types, ["night"]);
  assert.deepEqual(decoded.unique_stops, { min: 10 });
  assert.deepEqual(decoded.freq, { peak_am: { min: 5 } });
  assert.deepEqual(decoded.flags, { has_overnight: true });
});

test("parseFilterSpec returns empty object for invalid payload", () => {
  const engine = loadEngine();
  assert.deepEqual(engine.parseFilterSpec("%7Bbad-json"), {});
});

test("getUniqueValues deduplicates from scalar and array selectors", () => {
  const engine = loadEngine();

  const routes = engine.getUniqueValues(sampleRows, (row) => row.route_type, (value) => String(value));
  const operators = engine.getUniqueValues(sampleRows, (row) => row.operator_names_norm, (value) => String(value));

  assert.deepEqual(routes.sort(), ["night", "regular", "twentyfour"]);
  assert.deepEqual(operators.sort(), ["operator a", "operator b", "operator c"]);
});

test("loadRouteSummary parses CSV and caches result", async () => {
  let fetchCalls = 0;
  const engine = loadEngine({
    fetch: async (url) => {
      fetchCalls += 1;
      if (String(url).includes("/data/processed/stops.geojson")) {
        return {
          ok: true,
          json: async () => ({
            features: [
              { properties: { NAPTAN_ID: "s1", ROUTES: "12" } },
              { properties: { NAPTAN_ID: "s2", ROUTES: "12, 55" } },
              { properties: { NAPTAN_ID: "s3", ROUTES: "12" } }
            ]
          })
        };
      }
      return {
        ok: true,
        text: async () => [
          "route_id,route_type,operator_names,frequency_peak_am,length_km,unique_stops,destination_outbound,destination_inbound,destination_outbound_qualifier,destination_inbound_qualifier",
          "12,regular,Operator A,8,10,44,Hampstead Heath,Pimlico,Royal Free Hospital,Grosvenor Road"
        ].join("\n")
      };
    }
  });

  const first = await engine.loadRouteSummary();
  const second = await engine.loadRouteSummary();

  assert.equal(fetchCalls, 2);
  assert.equal(first.length, 1);
  assert.equal(second.length, 1);
  assert.equal(first[0].route_id_norm, "12");
  assert.equal(first[0].length_miles.toFixed(3), (10 * 0.621371).toFixed(3));
  assert.equal(first[0].unique_stops, 2);
  assert.equal(first[0].total_stops, 3);
  assert.equal(first[0].unique_stops_pct, 2 / 3);
  assert.equal(first[0].destination_outbound, "Hampstead Heath");
  assert.equal(first[0].destination_inbound, "Pimlico");
  assert.equal(first[0].destination_outbound_qualifier, "Royal Free Hospital");
  assert.equal(first[0].destination_inbound_qualifier, "Grosvenor Road");
});

test("loadRouteSummary derives shared-stop connected route breakdowns", async () => {
  const engine = loadEngine({
    fetch: async (url) => {
      if (String(url).includes("/data/processed/stops.geojson")) {
        return {
          ok: true,
          json: async () => ({
            features: [
              { properties: { NAPTAN_ID: "s1", ROUTES: "12, C3, N12" } },
              { properties: { NAPTAN_ID: "s2", ROUTES: "12, 618" } },
              { properties: { NAPTAN_ID: "s3", ROUTES: "12, 88" } },
              { properties: { NAPTAN_ID: "s4", ROUTES: "618" } },
              { properties: { NAPTAN_ID: "s5", ROUTES: "N12" } }
            ]
          })
        };
      }
      return {
        ok: true,
        text: async () => [
          "route_id,route_type,operator_names",
          "12,regular,Operator A",
          "C3,regular,Operator B",
          "N12,night,Operator C",
          "618,school,Operator D",
          "88,twentyfour,Operator E"
        ].join("\n")
      };
    }
  });

  const rows = await engine.loadRouteSummary();
  const byId = new Map(rows.map((row) => [row.route_id_norm, row]));

  assert.deepEqual(
    {
      regular: byId.get("12").connected_routes_regular,
      night: byId.get("12").connected_routes_night,
      school: byId.get("12").connected_routes_school,
      total: byId.get("12").connected_routes_total
    },
    { regular: 2, night: 1, school: 1, total: 4 }
  );
  assert.deepEqual(
    {
      regular: byId.get("C3").connected_routes_regular,
      night: byId.get("C3").connected_routes_night,
      school: byId.get("C3").connected_routes_school,
      total: byId.get("C3").connected_routes_total
    },
    { regular: 1, night: 1, school: 0, total: 2 }
  );
  assert.deepEqual(
    {
      regular: byId.get("618").connected_routes_regular,
      night: byId.get("618").connected_routes_night,
      school: byId.get("618").connected_routes_school,
      total: byId.get("618").connected_routes_total
    },
    { regular: 1, night: 0, school: 0, total: 1 }
  );
  assert.equal(byId.get("12").total_stops, 3);
  assert.equal(byId.get("12").unique_stops, 0);
  assert.equal(byId.get("618").total_stops, 2);
  assert.equal(byId.get("618").unique_stops, 1);
});

test("loadRouteSummary returns empty list on fetch failure", async () => {
  const engine = loadEngine({
    fetch: async () => {
      throw new Error("network down");
    }
  });

  const rows = await engine.loadRouteSummary();
  assert.deepEqual(rows, []);
});
