/**
 * Covers the browser-side geographic helper module.
 *
 * The tests focus on borough lookup and polygon containment because those
 * routines feed both the UI filters and the stop analytics pipeline.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadBrowserModule } = require("./helpers/load_browser_module");

/**
 * Load the geographic helpers with the minimal shared utilities they expect.
 *
 * @returns {object} `RouteMapsterGeo` API exposed by the browser module.
 */
const loadGeo = () => {
  const windowRef = loadBrowserModule("src/geo_utils.js", {
    window: {
      RouteMapsterUtils: {
        normaliseBoroughToken: (value) => String(value || "").trim().toLowerCase()
      }
    }
  });
  return windowRef.RouteMapsterGeo;
};

test("region lookup includes Hounslow as SW", () => {
  const geo = loadGeo();

  assert.equal(geo.getRegionTokenFromBorough("Hounslow"), "SW");
  assert.equal(geo.getRegionLabel("SW"), "South West London");
});

test("region lookup normalises borough casing and spacing", () => {
  const geo = loadGeo();

  assert.equal(geo.getRegionTokenFromBorough("  City of London  "), "C");
  assert.equal(geo.getRegionTokenFromBorough("unknown-borough"), "");
});

test("pointInRing identifies inside and outside points", () => {
  const geo = loadGeo();
  const ring = [
    [0, 0],
    [2, 0],
    [2, 2],
    [0, 2],
    [0, 0]
  ];

  assert.equal(geo.pointInRing(1, 1, ring), true);
  assert.equal(geo.pointInRing(3, 3, ring), false);
});

test("pointInPolygon respects holes", () => {
  const geo = loadGeo();
  const polygon = [
    [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
      [0, 0]
    ],
    [
      [2, 2],
      [8, 2],
      [8, 8],
      [2, 8],
      [2, 2]
    ]
  ];

  assert.equal(geo.pointInPolygon(1, 1, polygon), true);
  assert.equal(geo.pointInPolygon(5, 5, polygon), false);
});

test("buildBoroughIndex indexes Polygon and MultiPolygon", () => {
  const geo = loadGeo();
  const boroughs = {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: { BOROUGH: "A" },
        geometry: {
          type: "Polygon",
          coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]]
        }
      },
      {
        type: "Feature",
        properties: { BOROUGH: "B" },
        geometry: {
          type: "MultiPolygon",
          coordinates: [
            [[[2, 2], [3, 2], [3, 3], [2, 3], [2, 2]]],
            [[[4, 4], [5, 4], [5, 5], [4, 5], [4, 4]]]
          ]
        }
      }
    ]
  };

  const index = geo.buildBoroughIndex(boroughs);
  assert.equal(index.length, 3);
  assert.equal(index[0].name, "A");
  assert.equal(index[1].name, "B");
  assert.equal(index[2].name, "B");
});

test("findBoroughForPoint uses bbox and polygon inclusion", () => {
  const geo = loadGeo();
  const index = geo.buildBoroughIndex({
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: { BOROUGH: "Alpha" },
        geometry: {
          type: "Polygon",
          coordinates: [[[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]]]
        }
      },
      {
        type: "Feature",
        properties: { BOROUGH: "Beta" },
        geometry: {
          type: "Polygon",
          coordinates: [[[3, 3], [5, 3], [5, 5], [3, 5], [3, 3]]]
        }
      }
    ]
  });

  assert.equal(geo.findBoroughForPoint(1, 1, index), "Alpha");
  assert.equal(geo.findBoroughForPoint(4, 4, index), "Beta");
  assert.equal(geo.findBoroughForPoint(10, 10, index), "");
});
