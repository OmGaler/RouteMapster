/**
 * Covers the small shared utility bundle exposed to browser modules.
 *
 * The focus is on token normalisation and HTML escaping because those helpers
 * are reused widely across the application.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadBrowserModule } = require("./helpers/load_browser_module");

test("normalisePostcodeDistrict extracts area and district", () => {
  const windowRef = loadBrowserModule("src/shared_utils.js");
  const { normalisePostcodeDistrict } = windowRef.RouteMapsterUtils;

  assert.equal(normalisePostcodeDistrict("sw1a 1aa"), "SW1");
  assert.equal(normalisePostcodeDistrict(" N22 5XF "), "N22");
  assert.equal(normalisePostcodeDistrict("ec1a-1bb"), "EC1");
});

test("normalisePostcodeDistrict returns cleaned token when no district match", () => {
  const windowRef = loadBrowserModule("src/shared_utils.js");
  const { normalisePostcodeDistrict } = windowRef.RouteMapsterUtils;

  assert.equal(normalisePostcodeDistrict("WC"), "WC");
  assert.equal(normalisePostcodeDistrict(""), "");
  assert.equal(normalisePostcodeDistrict(null), "");
});

test("normaliseBoroughToken trims and lowercases", () => {
  const windowRef = loadBrowserModule("src/shared_utils.js");
  const { normaliseBoroughToken } = windowRef.RouteMapsterUtils;

  assert.equal(normaliseBoroughToken("  City Of London  "), "city of london");
  assert.equal(normaliseBoroughToken("Barking & Dagenham"), "barking and dagenham");
  assert.equal(normaliseBoroughToken(""), "");
  assert.equal(normaliseBoroughToken(undefined), "");
});

test("normaliseRegionToken trims and uppercases", () => {
  const windowRef = loadBrowserModule("src/shared_utils.js");
  const { normaliseRegionToken } = windowRef.RouteMapsterUtils;

  assert.equal(normaliseRegionToken(" sw "), "SW");
  assert.equal(normaliseRegionToken("ne"), "NE");
  assert.equal(normaliseRegionToken(undefined), "");
});

test("escapeHtml escapes critical characters", () => {
  const windowRef = loadBrowserModule("src/shared_utils.js");
  const { escapeHtml } = windowRef.RouteMapsterUtils;

  assert.equal(
    escapeHtml('<div class="x">Tom & Jerry\'s</div>'),
    "&lt;div class=&quot;x&quot;&gt;Tom &amp; Jerry&#39;s&lt;/div&gt;"
  );
});

test("escapeHtml preserves zero values", () => {
  const windowRef = loadBrowserModule("src/shared_utils.js");
  const { escapeHtml } = windowRef.RouteMapsterUtils;

  assert.equal(escapeHtml(0), "0");
  assert.equal(escapeHtml("0"), "0");
});
