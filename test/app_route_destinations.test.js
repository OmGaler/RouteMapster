const test = require("node:test");
const assert = require("node:assert/strict");
const { loadBrowserModule } = require("./helpers/load_browser_module");

function loadAppApi() {
  const windowRef = {};
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
