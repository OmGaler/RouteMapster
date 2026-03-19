(() => {
  /**
   * Defines canned filter and analysis combinations for the UI.
   *
   * Presets provide quick entry points into common RouteMapster workflows
   * without hard-coding those combinations inside the advanced filter or
   * analytics modules.
   */
  const PRESETS = [
    {
      id: "peak-hour-demand",
      name: "Peak Hour Demand",
      description: "Regular routes with strong AM frequency.",
      icon: "??",
      filterSpec: {
        route_types: ["regular"],
        freq: { peak_am: { min: 8 } }
      },
      analysisId: ["avg-frequency-by-operator", "top-routes-peak-am"]
    },
    {
      id: "night-service-overview",
      name: "Night Service Overview",
      description: "Night routes and overnight service coverage.",
      icon: "??",
      filterSpec: {
        route_types: ["night"],
        flags: { has_overnight: true }
      },
      analysisId: ["routes-by-operator", "routes-by-garage"]
    },
    {
      id: "garage-portfolio",
      name: "Garage Portfolio",
      description: "Routes and frequency profile per garage.",
      icon: "??",
      filterSpec: {},
      analysisId: ["routes-by-garage", "avg-frequency-by-operator"]
    }
  ];

  /**
   * Returns a shallow copy of the preset catalogue.
   *
   * @returns {Array<object>} Preset metadata safe for callers to iterate without mutating the source array.
   */
  const getPresets = () => PRESETS.slice();

  window.RouteMapsterPresets = {
    getPresets
  };
})();

