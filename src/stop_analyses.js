(() => {
  /**
   * Provides the bus stop analytics module and its map overlays.
   *
   * This file owns the stop-level dataset loading, filter state, summary
   * calculations, and analysis registry for the dedicated bus stop panel. It
   * depends on shared utilities, geographic helpers, and selected callbacks
   * exposed by the main application API.
   */
  const STOP_GEOJSON_PATH = "/data/processed/stops.geojson";
  const BOROUGHS_GEOJSON_PATH = "/data/boroughs.geojson";
  const FREQUENCY_DATA_PATH = "/data/processed/frequencies.json";
  const DEBOUNCE_MS = 160;
  const FREQUENCY_BANDS = [
    { key: "peak_am", label: "Peak AM" },
    { key: "peak_pm", label: "Peak PM" },
    { key: "offpeak", label: "Off-peak" },
    { key: "weekend", label: "Weekend" },
    { key: "overnight", label: "Overnight" }
  ];
  const REGION_OPTIONS = [
    { value: "", label: "All regions" },
    { value: "C", label: "Central London (C)" },
    { value: "NE", label: "North East London (NE)" },
    { value: "NW", label: "North West London (NW)" },
    { value: "SW", label: "South West London (SW)" },
    { value: "SE", label: "South East London (SE)" }
  ];
  const DEFAULT_MAP_TOP_N = 50;
  const MAP_METRICS = [
    { value: "route_count", label: "Routes per stop" },
    { value: "name_count", label: "Stops with this name" }
  ];

  const utils = window.RouteMapsterUtils || {};
  const geo = window.RouteMapsterGeo || {};
  const escapeHtml = utils.escapeHtml || ((value) => String(value || ""));
  const formatNumber = utils.formatNumber || ((value, digits = 1) => {
    if (!Number.isFinite(value)) {
      return "";
    }
    return digits === 0 ? String(Math.round(value)) : value.toFixed(digits);
  });
  const downloadCsv = utils.downloadCsv || (() => {});
  const normalisePostcodeDistrict = utils.normalisePostcodeDistrict || ((value) => {
    if (!value) {
      return "";
    }
    const cleaned = String(value).toUpperCase().trim();
    if (!cleaned) {
      return "";
    }
    const token = cleaned.split(/\s+/)[0];
    const normalised = token.replace(/[^A-Z0-9]/g, "");
    const match = normalised.match(/^([A-Z]{1,2}\d{1,2})/);
    return match ? match[1] : normalised;
  });
  const normaliseBoroughToken = utils.normaliseBoroughToken || ((value) => String(value || "").trim().toLowerCase());
  const normaliseRegionToken = utils.normaliseRegionToken || ((value) => String(value || "").trim().toUpperCase());

  const formatFrequencyValue = (perHour) => {
    if (!Number.isFinite(perHour)) {
      return "";
    }
    return formatNumber(perHour, 1);
  };

  const parseCentralityValue = (value) => {
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
  };

  const formatCentralityValue = (value) => {
    if (!Number.isFinite(value)) {
      return "";
    }
    const abs = Math.abs(value);
    if (abs > 0 && abs < 0.001) {
      return value.toExponential(2);
    }
    return formatNumber(value, 4);
  };

  const getMetricConfig = (metric) => MAP_METRICS.find((entry) => entry.value === metric) || null;

  const isMetricAvailable = (metric, context) => {
    if (!metric) {
      return false;
    }
    const entry = getMetricConfig(metric);
    if (!entry) {
      return false;
    }
    if (entry.requiresCentrality && !context?.centralityAvailable) {
      return false;
    }
    return true;
  };

  const getMetricLabel = (metric) => getMetricConfig(metric)?.label || metric || "Metric";

  const getMetricValue = (row, metric) => {
    if (!row || !metric) {
      return null;
    }
    const value = row[metric];
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
  };


  const formatMetricValue = (metric, value) => {
    if (!Number.isFinite(value)) {
      return "";
    }
    if (metric === "route_count" || metric === "name_count") {
      return formatNumber(value, 0);
    }
    return formatCentralityValue(value);
  };

  const isExcludedRoute = (routeId) => {
    if (!routeId) {
      return false;
    }
    const value = String(routeId).trim().toUpperCase();
    if (!value) {
      return false;
    }
    return value === "SCS" || value.startsWith("UL") || value.startsWith("Y");
  };

  const extractRouteTokens = (value) => {
    if (!value) {
      return [];
    }
    return String(value)
      .split(/[\s,;/]+/)
      .map((token) => token.trim())
      .filter(Boolean)
      .map((token) => token.replace(/[^A-Za-z0-9]/g, ""))
      .filter(Boolean)
      .map((token) => token.toUpperCase())
      .filter((token) => !isExcludedRoute(token));
  };

  const isNightRoute = (routeId) => /^N\d/.test(String(routeId || "").trim().toUpperCase());

  const extractNightRoutes = (routes) => {
    if (!Array.isArray(routes) || routes.length === 0) {
      return [];
    }
    return routes.filter((routeId) => isNightRoute(routeId));
  };

  const parseNumberInput = (input) => {
    if (!input || input.value === "") {
      return null;
    }
    const num = Number(input.value);
    return Number.isFinite(num) ? num : null;
  };

  const parseDistrictTokens = (value) => {
    if (!value) {
      return [];
    }
    const tokens = String(value)
      .split(/[\s,]+/)
      .map((token) => normalisePostcodeDistrict(token))
      .filter(Boolean);
    return Array.from(new Set(tokens));
  };

  const getRegionFromBorough = (borough) => {
    if (!borough) {
      return "";
    }
    if (geo.getRegionTokenFromBorough) {
      return geo.getRegionTokenFromBorough(borough);
    }
    return "";
  };

  const parseBoroughTokens = (value) => {
    if (!value) {
      return [];
    }
    const tokens = String(value)
      .split(/[;,]+/)
      .map((token) => normaliseBoroughToken(token))
      .filter(Boolean);
    return Array.from(new Set(tokens));
  };

  const parseRegionToken = (value) => normaliseRegionToken(value || "");

  const sortRouteIds = (routes) => {
    const api = window.RouteMapsterAPI;
    if (api && typeof api.sortRouteIds === "function") {
      return api.sortRouteIds(routes);
    }
    return routes.slice().sort((a, b) => String(a).localeCompare(String(b)));
  };

  const normaliseFrequencyKey = (routeId) => {
    const value = String(routeId || "").trim().toUpperCase();
    if (!value) {
      return "";
    }
    if (value.length > 1 && value.endsWith("D") && /\d/.test(value[value.length - 2])) {
      return value.slice(0, -1);
    }
    return value;
  };

  const getStopName = (props) => props?.NAME || props?.STOP_NAME || props?.NAPTAN_NAME || "";
  const getStopId = (props) => props?.PLACE_ID || props?.NAPTAN_ID || props?.STOP_CODE || props?.NAPTAN_ATCO || "";
  const getStopLetter = (props) => {
    const value = props?.STOP_LETTER || props?.INDICATOR || props?.indicator || "";
    const cleaned = String(value || "").trim().toUpperCase().replace(/\./g, " ");
    if (!cleaned) {
      return "";
    }
    const withoutPrefix = cleaned.startsWith("STOP ") ? cleaned.slice(5).trim() : cleaned;
    const token = withoutPrefix.split(/\s+/)[0] || "";
    if (!token) {
      return "";
    }
    if (token.startsWith("->")) {
      return "";
    }
    if (["OPP", "ADJ", "NR", "O/S", "STAND"].includes(token)) {
      return "";
    }
    if (token.endsWith("-BOUND") || ["NORTHBOUND", "SOUTHBOUND", "EASTBOUND", "WESTBOUND"].includes(token)) {
      return "";
    }
    return /^[A-Z]{1,2}\d?$/.test(token) ? token : "";
  };

  const formatStopLabel = (row) => {
    const name = row.name || "Bus stop";
    const id = row.id || "";
    return id ? `${name} (${id})` : name;
  };

  const formatRouteList = (routes, limit = 8) => {
    const list = Array.isArray(routes) ? routes : [];
    if (list.length === 0) {
      return "None";
    }
    const sorted = sortRouteIds(list);
    const slice = sorted.slice(0, limit);
    const remainder = sorted.length - slice.length;
    return remainder > 0 ? `${slice.join(", ")} +${remainder}` : slice.join(", ");
  };

  const buildRouteListHtml = (listString, limit = 8) => {
    if (!listString) {
      return "";
    }
    const tokens = String(listString)
      .split(",")
      .map((token) => token.trim())
      .filter(Boolean);
    const summary = tokens.length <= limit ? listString : formatRouteList(tokens, limit);
    return `<span title="${escapeHtml(listString)}">${escapeHtml(summary)}</span>`;
  };

  const buildFrequencyTotals = (routes, frequencyData) => {
    if (!frequencyData) {
      return null;
    }
    let matched = 0;
    const totals = {};
    FREQUENCY_BANDS.forEach((band) => {
      totals[band.key] = 0;
    });
    routes.forEach((routeId) => {
      const key = normaliseFrequencyKey(routeId);
      const entry = frequencyData[key];
      if (!entry || typeof entry !== "object") {
        return;
      }
      matched += 1;
      FREQUENCY_BANDS.forEach((band) => {
        const value = Number(entry[band.key]);
        if (Number.isFinite(value)) {
          totals[band.key] += value;
        }
      });
    });
    return matched > 0 ? totals : null;
  };

  const buildCentralitySummary = (row) => {
    const parts = [];
    if (Number.isFinite(row.betweenness)) {
      parts.push(`Betw ${formatCentralityValue(row.betweenness)}`);
    }
    if (Number.isFinite(row.closeness_topo)) {
      parts.push(`Close ${formatCentralityValue(row.closeness_topo)}`);
    }
    if (Number.isFinite(row.eigenvector)) {
      parts.push(`Eig ${formatCentralityValue(row.eigenvector)}`);
    }
    return parts.length > 0 ? parts.join(" | ") : "";
  };

  const resolveMetricSelection = (metric, context, options = {}) => {
    const allowNone = Boolean(options.allowNone);
    if (!metric && allowNone) {
      return "";
    }
    if (isMetricAvailable(metric, context)) {
      return metric;
    }
    if (allowNone) {
      return "";
    }
    const fallback = MAP_METRICS.find((entry) => !entry.requiresCentrality || context?.centralityAvailable);
    return fallback ? fallback.value : "";
  };

  const buildMetricOptions = (selectEl, context, options = {}) => {
    if (!selectEl) {
      return;
    }
    const includeNone = Boolean(options.includeNone);
    const items = [];
    if (includeNone) {
      items.push({ value: "", label: "None", disabled: false });
    }
    MAP_METRICS.forEach((entry) => {
      items.push({ value: entry.value, label: entry.label, disabled: false });
    });
    selectEl.innerHTML = items
      .map((item) => `<option value="${escapeHtml(item.value)}"${item.disabled ? " disabled" : ""}>${escapeHtml(item.label)}</option>`)
      .join("");
  };

  const normaliseTopN = (value) => {
    if (!Number.isFinite(value)) {
      return DEFAULT_MAP_TOP_N;
    }
    const rounded = Math.round(value);
    return rounded > 0 ? rounded : DEFAULT_MAP_TOP_N;
  };

  const getTopStopsByMetric = (rows, metric, topN) => {
    if (!metric) {
      return [];
    }
    const limit = normaliseTopN(topN);
    const candidates = rows
      .map((row) => ({ row, value: getMetricValue(row, metric) }))
      .filter((entry) => Number.isFinite(entry.value));
    if (candidates.length === 0) {
      return [];
    }
    candidates.sort((a, b) => b.value - a.value);
    return candidates.slice(0, limit).map((entry) => entry.row);
  };

  const buildMetricStats = (rows, metric) => {
    if (!metric) {
      return null;
    }
    const values = rows
      .map((row) => getMetricValue(row, metric))
      .filter((value) => Number.isFinite(value))
      .sort((a, b) => a - b);
    if (values.length === 0) {
      return null;
    }
    const mid = Math.floor(values.length / 2);
    return {
      min: values[0],
      max: values[values.length - 1],
      median: values[mid],
      count: values.length,
      total: rows.length
    };
  };

  const resolveStopBorough = (props, lon, lat, boroughIndex, cache) => {
    const raw = props?.borough || props?.BOROUGH || props?.Borough || "";
    const cleaned = String(raw || "").trim();
    if (cleaned) {
      return cleaned;
    }
    if (!boroughIndex || boroughIndex.length === 0) {
      return "Unknown";
    }
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
      return "Unknown";
    }
    const cacheKey = props?.NAPTAN_ID || props?.PLACE_ID || `${lon.toFixed(6)},${lat.toFixed(6)}`;
    if (cache && cache.has(cacheKey)) {
      return cache.get(cacheKey);
    }
    const borough = geo.findBoroughForPoint ? geo.findBoroughForPoint(lon, lat, boroughIndex) : "";
    const resolved = borough || "Unknown";
    if (cache) {
      cache.set(cacheKey, resolved);
    }
    return resolved;
  };

  const buildStopRow = (feature, frequencyData, boroughIndex, boroughCache) => {
    const props = feature?.properties || {};
    const coords = feature?.geometry?.coordinates;
    const lon = Array.isArray(coords) ? Number(coords[0]) : null;
    const lat = Array.isArray(coords) ? Number(coords[1]) : null;
    const name = String(getStopName(props) || "").trim();
    const id = String(props?.PLACE_ID || getStopId(props) || "").trim();
    const postcode = String(props?.POSTCODE || "").trim();
    const district = normalisePostcodeDistrict(postcode) || "Unknown";
    const borough = resolveStopBorough(props, lon, lat, boroughIndex, boroughCache);
    const region = getRegionFromBorough(borough) || normaliseRegionToken(props?.region || "") || "Unknown";
    const stop_letter = getStopLetter(props);
    const routes = extractRouteTokens(props?.ROUTES);
    const nightRoutes = extractNightRoutes(routes);
    const frequency = buildFrequencyTotals(routes, frequencyData);
    const betweenness = parseCentralityValue(props?.betweenness_global ?? props?.betweenness);
    const closeness_topo = parseCentralityValue(props?.closeness_topo);
    const closeness_dist = null;
    const eigenvector = parseCentralityValue(props?.eigenvector);
    const degree = parseCentralityValue(props?.degree);
    const degree_norm = parseCentralityValue(props?.degree_norm);
    const route_degree = parseCentralityValue(props?.route_degree);
    const child_stop_count = parseCentralityValue(props?.child_stop_count ?? props?.CHILD_STOP_COUNT);
    const in_lcc = Boolean(props?.in_lcc);
    return {
      id,
      name: name || "Bus stop",
      postcode,
      district,
      borough,
      region,
      stop_letter,
      routes,
      night_routes: nightRoutes,
      route_count: routes.length,
      night_route_count: nightRoutes.length,
      lat: Number.isFinite(lat) ? lat : null,
      lon: Number.isFinite(lon) ? lon : null,
      frequency,
      betweenness,
      closeness_topo,
      closeness_dist,
      eigenvector,
      degree,
      degree_norm,
      route_degree,
      child_stop_count,
      in_lcc,
      centralitySummary: buildCentralitySummary({
        betweenness,
        closeness_topo,
        eigenvector
      }),
      url: props?.URL || ""
    };
  };

  const loadStopsGeojson = async () => {
    const res = await fetch(STOP_GEOJSON_PATH);
    if (!res.ok) {
      return null;
    }
    const base = await res.json();
    return { geojson: base, source: "base" };
  };

  const loadBoroughsGeojson = async () => {
    const res = await fetch(BOROUGHS_GEOJSON_PATH);
    if (!res.ok) {
      return null;
    }
    return res.json();
  };

  const loadFrequencyData = async () => {
    const res = await fetch(FREQUENCY_DATA_PATH);
    if (!res.ok) {
      return null;
    }
    const data = await res.json();
    if (!data || typeof data !== "object") {
      return null;
    }
    const normalised = {};
    Object.entries(data).forEach(([key, value]) => {
      const token = normaliseFrequencyKey(key);
      if (!token || typeof value !== "object") {
        return;
      }
      normalised[token] = value;
    });
    return normalised;
  };

  const buildStopsFromGeojson = (geojson, frequencyData, boroughIndex) => {
    if (!geojson || !Array.isArray(geojson.features)) {
      return [];
    }
    const cache = new Map();
    const rows = geojson.features
      .map((feature) => buildStopRow(feature, frequencyData, boroughIndex, cache))
      .filter((row) => row && (row.name || row.id) && row.route_count > 0);
    const nameCounts = new Map();
    rows.forEach((row) => {
      const key = String(row.name || "").trim();
      if (!key) {
        return;
      }
      nameCounts.set(key, (nameCounts.get(key) || 0) + 1);
    });
    rows.forEach((row) => {
      const key = String(row.name || "").trim();
      row.name_count = key ? (nameCounts.get(key) || 0) : 0;
    });
    return rows;
  };

  /**
   * Renders a stop-analysis table, including optional row metadata hooks.
   *
   * @param {object} result Table-shaped analysis result.
   * @returns {string} HTML fragment for the analysis output panel.
   */
  const renderTable = (result) => {
    const columns = result.columns || [];
    const rows = result.rows || [];
    const rowMeta = Array.isArray(result?.meta?.rowMeta) ? result.meta.rowMeta : [];
    const activeRowKey = String(result?.meta?.activeRowKey || "");
    const expandRouteIndex = Number.isInteger(result?.meta?.expandRouteIndex)
      ? result.meta.expandRouteIndex
      : null;
    const firstColumn = String(columns[0] || "").trim().toLowerCase();
    const secondColumn = String(columns[1] || "").trim().toLowerCase();
    const tableClasses = ["analysis-table"];
    if (firstColumn === "rank") {
      tableClasses.push("analysis-table--ranked");
    }
    if (firstColumn === "rank" && secondColumn === "route") {
      tableClasses.push("analysis-table--ranked-route");
    }
    const tableClass = tableClasses.join(" ");
    const header = columns.map((col) => `<th>${escapeHtml(col)}</th>`).join("");
    const body = rows.map((row, rowIndex) => {
      const meta = rowMeta[rowIndex] || null;
      const attrs = [];
      if (meta?.highlightName) {
        attrs.push(`data-highlight-name="${escapeHtml(meta.highlightName)}"`);
        attrs.push('class="is-clickable' + (activeRowKey && activeRowKey === String(meta.highlightName) ? ' is-active' : '') + '"');
      }
      const cells = row.map((cell, index) => {
        if (expandRouteIndex === index && typeof cell === "string") {
          return `<td>${buildRouteListHtml(cell)}</td>`;
        }
        return `<td>${escapeHtml(cell)}</td>`;
      }).join("");
      return `<tr ${attrs.join(" ")}>${cells}</tr>`;
    }).join("");
    return `
      <div class="analysis-table-shell">
        <div class="analysis-scroll-cue" aria-hidden="true">▸</div>
        <div class="analysis-table-wrap">
          <table class="${tableClass}">
            <thead><tr>${header}</tr></thead>
            <tbody>${body}</tbody>
          </table>
        </div>
      </div>
    `;
  };

  const syncTableOverflowCue = (shell) => {
    if (!shell) {
      return;
    }
    const wrap = shell.querySelector(".analysis-table-wrap");
    if (!wrap) {
      return;
    }
    const wrapTop = wrap.offsetTop || 0;
    const wrapBottom = Math.max(0, (shell.clientHeight || 0) - wrapTop - (wrap.offsetHeight || 0));
    shell.style.setProperty("--analysis-wrap-top", `${wrapTop}px`);
    shell.style.setProperty("--analysis-wrap-bottom", `${wrapBottom}px`);
    const overflowSlack = Math.max(0, wrap.scrollWidth - wrap.clientWidth);
    const hasOverflow = overflowSlack > 2;
    const remainingRight = Math.max(0, wrap.scrollWidth - wrap.clientWidth - wrap.scrollLeft);
    const isScrollEnd = !hasOverflow || remainingRight <= 2;
    shell.classList.toggle("has-x-overflow", hasOverflow);
    shell.classList.toggle("is-scroll-end", isScrollEnd);
  };

  const attachTableOverflowCues = (root) => {
    if (!root) {
      return;
    }
    root.querySelectorAll(".analysis-table-shell").forEach((shell) => {
      const wrap = shell.querySelector(".analysis-table-wrap");
      if (!wrap) {
        return;
      }
      if (wrap.dataset.overflowCueBound !== "1") {
        const sync = () => syncTableOverflowCue(shell);
        wrap.addEventListener("scroll", sync, { passive: true });
        if (typeof ResizeObserver === "function") {
          const observer = new ResizeObserver(sync);
          observer.observe(wrap);
          const table = wrap.querySelector("table");
          if (table) {
            observer.observe(table);
          }
          wrap.__overflowCueObserver = observer;
        }
        wrap.__overflowCueSync = sync;
        wrap.dataset.overflowCueBound = "1";
      }
      const syncFn = wrap.__overflowCueSync;
      if (typeof syncFn === "function") {
        syncFn();
        if (typeof window.requestAnimationFrame === "function") {
          window.requestAnimationFrame(syncFn);
        }
      } else {
        syncTableOverflowCue(shell);
      }
    });
  };

  const buildDistribution = (rows) => {
    const buckets = [
      { label: "0 routes", min: 0, max: 0 },
      { label: "1 route", min: 1, max: 1 },
      { label: "2 routes", min: 2, max: 2 },
      { label: "3-4 routes", min: 3, max: 4 },
      { label: "5-7 routes", min: 5, max: 7 },
      { label: "8+ routes", min: 8, max: Number.POSITIVE_INFINITY }
    ];
    const counts = buckets.map(() => 0);
    rows.forEach((row) => {
      const count = Number.isFinite(row.route_count) ? row.route_count : 0;
      const index = buckets.findIndex((bucket) => count >= bucket.min && count <= bucket.max);
      if (index >= 0) {
        counts[index] += 1;
      }
    });
    return buckets.map((bucket, index) => [bucket.label, counts[index]]);
  };

  const buildGroupedStopRows = (rows, keyFn) => {
    const summary = new Map();
    rows.forEach((row) => {
      const key = keyFn(row);
      if (!key) {
        return;
      }
      if (!summary.has(key)) {
        summary.set(key, {
          count: 0,
          routeTotal: 0,
          districts: new Set()
        });
      }
      const entry = summary.get(key);
      entry.count += 1;
      entry.routeTotal += row.route_count || 0;
      if (row.district && row.district !== "Unknown") {
        entry.districts.add(row.district);
      }
    });
    return Array.from(summary.entries());
  };

  /**
   * Registry of stop analyses exposed to the bus stop analytics UI.
   *
   * Each entry returns a renderable payload and may declare additional dataset
   * requirements such as frequency availability.
   */
  const analysisRegistry = {
    "top-stops-routes": {
      id: "top-stops-routes",
      label: "Top bus stops by route count",
      run: (rows) => {
        const sorted = rows
          .filter((row) => row.route_count > 0)
          .slice()
          .sort((a, b) => b.route_count - a.route_count)
          .slice(0, 25);
        return {
          type: "table",
          columns: ["Rank", "Bus stop", "District", "Routes", "Route list"],
          rows: sorted.map((row, index) => {
            const fullList = sortRouteIds(row.routes || []).join(", ");
            return [
              index + 1,
              formatStopLabel(row),
              row.district,
              row.route_count,
              fullList
            ];
          }),
          meta: { expandRouteIndex: 4 }
        };
      }
    },
    "top-stops-night-routes": {
      id: "top-stops-night-routes",
      label: "Top bus stops by night route count",
      run: (rows) => {
        const sorted = rows
          .filter((row) => row.night_route_count > 0)
          .slice()
          .sort((a, b) => b.night_route_count - a.night_route_count || b.route_count - a.route_count)
          .slice(0, 25);
        if (sorted.length === 0) {
          return { type: "note", message: "No night routes were found in the selected bus stops." };
        }
        return {
          type: "table",
          columns: ["Rank", "Bus stop", "District", "Night routes", "All routes", "Night route list"],
          rows: sorted.map((row, index) => {
            const fullList = sortRouteIds(row.night_routes || []).join(", ");
            return [
              index + 1,
              formatStopLabel(row),
              row.district,
              row.night_route_count,
              row.route_count,
              fullList
            ];
          }),
          meta: { expandRouteIndex: 5 }
        };
      }
    },
    "top-stops-frequency": {
      id: "top-stops-frequency",
      label: "Top bus stops by combined frequency",
      requiresFrequency: true,
      run: (rows, context) => {
        const band = context?.frequencyBand || "peak_am";
        const label = FREQUENCY_BANDS.find((entry) => entry.key === band)?.label || band;
        const candidates = rows.filter((row) => row.frequency && Number.isFinite(row.frequency[band]));
        if (candidates.length === 0) {
          return { type: "note", message: "Frequency totals are unavailable for the selected bus stops." };
        }
        const sorted = candidates
          .slice()
          .sort((a, b) => (b.frequency[band] || 0) - (a.frequency[band] || 0))
          .slice(0, 25);
        return {
          type: "table",
          columns: ["Rank", "Bus stop", "District", `${label} (buses/hr)`, "Routes"],
          rows: sorted.map((row, index) => [
            index + 1,
            formatStopLabel(row),
            row.district,
            formatFrequencyValue(row.frequency[band]),
            row.route_count
          ])
        };
      }
    },
    "district-stop-counts": {
      id: "district-stop-counts",
      label: "Bus stops by postcode district",
      run: (rows, context) => {
        const band = context?.frequencyBand || "peak_am";
        const label = FREQUENCY_BANDS.find((entry) => entry.key === band)?.label || band;
        const summary = new Map();
        rows.forEach((row) => {
          const district = row.district || "Unknown";
          if (!summary.has(district)) {
            summary.set(district, { count: 0, routeTotal: 0, freqTotal: 0, freqCount: 0 });
          }
          const entry = summary.get(district);
          entry.count += 1;
          entry.routeTotal += row.route_count;
          if (row.frequency && Number.isFinite(row.frequency[band])) {
            entry.freqTotal += row.frequency[band];
            entry.freqCount += 1;
          }
        });
        const rowsOut = Array.from(summary.entries())
          .map(([district, entry]) => {
            const avgRoutes = entry.count > 0 ? entry.routeTotal / entry.count : 0;
            const avgFreq = entry.freqCount > 0 ? entry.freqTotal / entry.freqCount : null;
            return [
              district,
              entry.count,
              formatNumber(avgRoutes, 2),
              avgFreq === null ? "" : formatNumber(avgFreq, 1)
            ];
          })
          .sort((a, b) => (b[1] || 0) - (a[1] || 0));
        return {
          type: "table",
          columns: ["District", "Bus stops", "Avg routes", `Avg ${label}`],
          rows: rowsOut
        };
      }
    },
    "district-coverage-gaps": {
      id: "district-coverage-gaps",
      label: "Coverage gaps by district",
      run: (rows) => {
        const summary = new Map();
        rows.forEach((row) => {
          const district = row.district || "Unknown";
          if (!summary.has(district)) {
            summary.set(district, { count: 0, routeTotal: 0 });
          }
          const entry = summary.get(district);
          entry.count += 1;
          entry.routeTotal += row.route_count;
        });
        const minStops = 15;
        const rowsOut = Array.from(summary.entries())
          .filter(([, entry]) => entry.count >= minStops)
          .map(([district, entry]) => {
            const avgRoutes = entry.count > 0 ? entry.routeTotal / entry.count : 0;
            return [district, entry.count, formatNumber(avgRoutes, 2)];
          })
          .sort((a, b) => (parseFloat(a[2]) || 0) - (parseFloat(b[2]) || 0))
          .slice(0, 30);
        return {
          type: "table",
          columns: ["District", "Bus stops", "Avg routes"],
          rows: rowsOut
        };
      }
    },
    "routes-per-stop-distribution": {
      id: "routes-per-stop-distribution",
      label: "Routes per stop distribution",
      run: (rows) => {
        return {
          type: "table",
          columns: ["Routes per stop", "Bus stops"],
          rows: buildDistribution(rows)
        };
      }
    },
    "common-stop-names": {
      id: "common-stop-names",
      label: "Most common bus stop names",
      run: (rows) => {
        const grouped = buildGroupedStopRows(rows, (row) => String(row.name || "").trim());
        if (grouped.length === 0) {
          return { type: "note", message: "No bus stop names were found in the selected bus stops." };
        }
        const rowsOut = grouped
          .map(([name, entry]) => [
            name,
            entry.count,
            formatNumber(entry.count > 0 ? entry.routeTotal / entry.count : 0, 2)
          ])
          .sort((a, b) => (b[1] || 0) - (a[1] || 0) || String(a[0]).localeCompare(String(b[0])))
          .slice(0, 25);
        return {
          type: "table",
          columns: ["Rank", "Bus stop name", "Bus stops", "Avg routes"],
          rows: rowsOut.map((row, index) => [index + 1, ...row]),
          meta: {
            rowMeta: rowsOut.map((row) => ({ highlightName: row[0] })),
            activeRowKey: state.activeStopNameHighlight || ""
          }
        };
      }
    },
    "common-stop-letters": {
      id: "common-stop-letters",
      label: "Most common bus stop letters",
      run: (rows) => {
        const grouped = buildGroupedStopRows(rows, (row) => row.stop_letter);
        if (grouped.length === 0) {
          return { type: "note", message: "No bus stop letters are available in the selected bus stops." };
        }
        const rowsOut = grouped
          .map(([letter, entry]) => [
            letter,
            entry.count,
            formatNumber(entry.count > 0 ? entry.routeTotal / entry.count : 0, 2)
          ])
          .sort((a, b) => (b[1] || 0) - (a[1] || 0) || String(a[0]).localeCompare(String(b[0])))
          .slice(0, 25);
        return {
          type: "table",
          columns: ["Rank", "Stop letter", "Bus stops", "Avg routes"],
          rows: rowsOut.map((row, index) => [index + 1, ...row])
        };
      }
    }
  };

  const state = {
    stops: [],
    filteredStops: [],
    frequencyBand: "peak_am",
    frequencyAvailable: false,
    centralityAvailable: false,
    currentAnalysisIds: [],
    activeStopNameHighlight: "",
    resultsByKey: new Map(),
    debounceHandle: null,
    districtTokens: [],
    boroughToken: "",
    regionToken: "",
    stopLetterToken: "",
    moduleOpen: true,
    mapMode: "filtered",
    mapTopN: DEFAULT_MAP_TOP_N,
    mapTopMetric: "route_count",
    mapColourMetric: "",
    suppressedBaseStops: false,
    suppressedBaseStopsPrev: null
  };

  const getHighlightedNameStops = (rows) => {
    const name = String(state.activeStopNameHighlight || "").trim();
    if (!name) {
      return [];
    }
    return rows.filter((row) => String(row.name || "").trim() === name);
  };

  const buildFilterSpec = (els) => {
    const districts = state.districtTokens.slice();
    const boroughs = state.boroughToken ? [state.boroughToken] : [];
    const region = parseRegionToken(els.regionSelect?.value || "");
    const stopLetter = getStopLetter({ STOP_LETTER: els.stopLetterInput?.value || state.stopLetterToken });
    return {
      districts,
      boroughs,
      region,
      stopLetter
    };
  };

  const applyFilters = (rows, spec) => {
    const list = Array.isArray(rows) ? rows : [];
    const districtSet = spec.districts && spec.districts.length > 0
      ? new Set(spec.districts)
      : null;
    const boroughSet = spec.boroughs && spec.boroughs.length > 0
      ? new Set(spec.boroughs)
      : null;
    const regionToken = spec.region || "";
    const stopLetterToken = String(spec.stopLetter || "").trim().toUpperCase();
    return list.filter((row) => {
      if (districtSet && !districtSet.has(row.district)) {
        return false;
      }
      if (boroughSet && !boroughSet.has(normaliseBoroughToken(row.borough))) {
        return false;
      }
      if (regionToken && regionToken !== "ALL" && row.region !== regionToken) {
        return false;
      }
      if (stopLetterToken && row.stop_letter !== stopLetterToken) {
        return false;
      }
      return true;
    });
  };

  const renderSummary = (container, rows, context) => {
    if (!container) {
      return;
    }
    const total = rows.length;
    const routeTotal = rows.reduce((sum, row) => sum + row.route_count, 0);
    const avgRoutes = total > 0 ? routeTotal / total : 0;
    const routeCounts = rows.map((row) => row.route_count).sort((a, b) => a - b);
    const medianRoutes = routeCounts.length > 0
      ? routeCounts[Math.floor(routeCounts.length / 2)]
      : 0;
    const band = context?.frequencyBand || "peak_am";
    const label = FREQUENCY_BANDS.find((entry) => entry.key === band)?.label || band;
    let avgFreq = null;
    if (context?.frequencyAvailable) {
      const values = rows
        .map((row) => row.frequency && Number.isFinite(row.frequency[band]) ? row.frequency[band] : null)
        .filter((value) => Number.isFinite(value));
      if (values.length > 0) {
        avgFreq = values.reduce((sum, value) => sum + value, 0) / values.length;
      }
    }

    const summaryLines = [
      { label: "Total bus stops", value: total },
      { label: "Avg routes per stop", value: formatNumber(avgRoutes, 2) },
      { label: "Median routes per stop", value: medianRoutes }
    ];
    if (context?.frequencyAvailable) {
      summaryLines.push({
        label: `Avg ${label}`,
        value: avgFreq === null ? "n/a" : formatNumber(avgFreq, 1)
      });
    }
    if (context?.centralityAvailable) {
      summaryLines.push({ label: "Centrality data", value: "Available" });
    }

    container.innerHTML = `
      <div class="analysis-block">
        <div class="analysis-block__header">
          <div class="analysis-block__title">Summary</div>
        </div>
        <div class="analysis-summary">
          ${summaryLines.map((item) => `<div><strong>${escapeHtml(item.label)}:</strong> ${escapeHtml(item.value)}</div>`).join("")}
        </div>
      </div>
    `;
  };

  /**
   * Runs one or more registered stop analyses against the filtered stop set.
   *
   * @param {string|string[]} analysisIds Analysis identifier or identifiers.
   * @param {Array<object>} rows Stop rows in scope.
   * @param {object} context Runtime context such as frequency availability.
   * @returns {Array<object>} Render-ready result wrappers.
   */
  const runAnalyses = (analysisIds, rows, context) => {
    const ids = Array.isArray(analysisIds) ? analysisIds : [analysisIds];
    return ids
      .map((analysisId) => {
        const entry = analysisRegistry[analysisId];
        if (!entry) {
          return null;
        }
        if (entry.requiresFrequency && !context?.frequencyAvailable) {
          return {
            id: analysisId,
            title: entry.label,
            result: { type: "note", message: "Frequency dataset is unavailable in this build." }
          };
        }
        if (entry.requiresCentrality && !context?.centralityAvailable) {
          return {
            id: analysisId,
            title: entry.label,
            result: { type: "note", message: "Centrality metrics are unavailable in this build." }
          };
        }
        const result = entry.run(rows, context);
        return { id: analysisId, title: entry.label, result };
      })
      .filter(Boolean);
  };

  /**
   * Renders the current stop-analysis results into the output container.
   *
   * @param {HTMLElement} container Output container element.
   * @param {Array<object>} results Completed analysis result wrappers.
   * @returns {void}
   * Side effects: Rewrites DOM content and refreshes the local export lookup.
   */
  const renderResults = (container, results) => {
    state.resultsByKey.clear();
    if (!container) {
      return;
    }
    if (!results || results.length === 0) {
      container.innerHTML = '<div class="info-empty">No analysis results yet.</div>';
      return;
    }
    const blocks = results.map((entry, index) => {
      const key = `${entry.id}-${index}`;
      state.resultsByKey.set(key, entry);
      const exportBtn = entry.result?.type === "table"
        ? `<button type="button" class="ghost-button compact analysis-export" data-analysis-key="${escapeHtml(key)}">Export CSV</button>`
        : "";
      let content = '<div class="info-empty">No result data.</div>';
      if (entry.result?.type === "table") {
        content = renderTable(entry.result);
      } else if (entry.result?.type === "note") {
        content = `<div class="info-empty">${escapeHtml(entry.result.message || "No data.")}</div>`;
      }
      return `
        <div class="analysis-block">
          <div class="analysis-block__header">
            <div class="analysis-block__title">${escapeHtml(entry.title)}</div>
            ${exportBtn}
          </div>
          ${content}
        </div>
      `;
    }).join("");
    container.innerHTML = blocks;
    attachTableOverflowCues(container);
  };

  const renderPresetCards = (container) => {
    if (!container) {
      return;
    }
    container.innerHTML = PRESETS.map((preset) => {
      const disabled = preset.analysisIds.some((analysisId) => {
        const entry = analysisRegistry[analysisId];
        if (entry?.requiresFrequency && !state.frequencyAvailable) {
          return true;
        }
        if (entry?.requiresCentrality && !state.centralityAvailable) {
          return true;
        }
        return false;
      });
      return `
        <button type="button" class="preset-card${disabled ? " is-disabled" : ""}" data-preset="${escapeHtml(preset.id)}" ${disabled ? "disabled" : ""}>
          <div class="preset-card__icon">${escapeHtml(preset.icon)}</div>
          <div class="preset-card__title">${escapeHtml(preset.name)}</div>
          <div class="preset-card__desc">${escapeHtml(preset.description)}</div>
        </button>
      `;
    }).join("");
  };

  const buildAnalysisOptions = (selectEl) => {
    if (!selectEl) {
      return;
    }
    const options = Object.values(analysisRegistry).map((entry) => {
      let suffix = "";
      if (entry.requiresFrequency && !state.frequencyAvailable) {
        suffix = " (needs frequency data)";
      }
      return `<option value="${escapeHtml(entry.id)}">${escapeHtml(entry.label + suffix)}</option>`;
    });
    selectEl.innerHTML = options.join("");
  };

  const updateScopeNote = (noteEl, count) => {
    if (!noteEl) {
      return;
    }
    noteEl.textContent = `Analysing ${count} bus stops.`;
  };

  const syncMapControlState = (els) => {
    if (!els) {
      return;
    }
    if (els.mapMode) {
      els.mapMode.value = state.mapMode;
    }
    if (els.mapTopN && (!els.mapTopN.value || els.mapTopN.value === "0")) {
      if (document.activeElement !== els.mapTopN) {
        els.mapTopN.value = String(state.mapTopN);
      }
    }
    if (els.mapTopMetric) {
      els.mapTopMetric.value = state.mapTopMetric;
    }
    if (els.mapColourMetric) {
      els.mapColourMetric.value = state.mapColourMetric;
    }
    if (els.mapTopWrap) {
      els.mapTopWrap.style.display = state.mapMode === "top" ? "" : "none";
    }
  };

  const updateMapStateFromEls = (els) => {
    if (!els) {
      return;
    }
    if (els.mapMode) {
      state.mapMode = els.mapMode.value || "filtered";
    }
    if (els.mapTopN) {
      state.mapTopN = normaliseTopN(parseNumberInput(els.mapTopN));
    }
    if (els.mapTopMetric) {
      state.mapTopMetric = resolveMetricSelection(
        els.mapTopMetric.value,
        state,
        { allowNone: false }
      );
    }
    if (els.mapColourMetric) {
      state.mapColourMetric = resolveMetricSelection(
        els.mapColourMetric.value,
        state,
        { allowNone: true }
      );
    }
  };

  /**
   * Derives the stop subset and legend state for the current map mode.
   *
   * @param {Array<object>} rows Filtered stop rows.
   * @returns {{stops: Array<object>, note: string, showLegend: boolean, options: object}} Map display configuration.
   */
  const buildMapDisplay = (rows) => {
    const highlightedNameStops = getHighlightedNameStops(rows);
    if (highlightedNameStops.length > 0) {
      const colorMetric = resolveMetricSelection(state.mapColourMetric, state, { allowNone: true });
      const note = `Highlighting ${highlightedNameStops.length} stops named ${state.activeStopNameHighlight}.`;
      return {
        stops: highlightedNameStops,
        note,
        showLegend: Boolean(colorMetric),
        options: { colorBy: colorMetric || "" }
      };
    }
    if (state.mapMode === "off") {
      return { stops: [], note: "Map overlay is off.", showLegend: false, options: { colorBy: "" } };
    }
    const baseStops = Array.isArray(rows) ? rows : [];
    let displayStops = baseStops;
    let notePrefix = `Showing ${baseStops.length} filtered bus stops.`;
    if (state.mapMode === "top") {
      const topMetric = resolveMetricSelection(state.mapTopMetric, state, { allowNone: false });
      const topStops = getTopStopsByMetric(baseStops, topMetric, state.mapTopN);
      displayStops = topStops;
      const metricLabel = getMetricLabel(topMetric);
      notePrefix = `Showing top ${displayStops.length} by ${metricLabel}.`;
    }
    if (displayStops.length === 0) {
      return { stops: [], note: "No bus stops matched the current map view.", showLegend: false, options: { colorBy: "" } };
    }
    const colorMetric = resolveMetricSelection(state.mapColourMetric, state, { allowNone: true });
    if (!colorMetric) {
      return {
        stops: displayStops,
        note: `${notePrefix} Using default marker colour.`,
        showLegend: false,
        options: { colorBy: "" }
      };
    }
    const stats = buildMetricStats(displayStops, colorMetric);
    if (!stats) {
      return {
        stops: displayStops,
        note: `${notePrefix} ${getMetricLabel(colorMetric)} values are missing in this selection.`,
        showLegend: false,
        options: { colorBy: colorMetric }
      };
    }
    const rangeText = `${formatMetricValue(colorMetric, stats.min)}-${formatMetricValue(colorMetric, stats.max)}`;
    const note = `${notePrefix} ${getMetricLabel(colorMetric)} range ${rangeText} (n=${stats.count}).`;
    return {
      stops: displayStops,
      note,
      showLegend: true,
      options: { colorBy: colorMetric }
    };
  };

  const syncMapStops = (els) => {
    const api = window.RouteMapsterAPI;
    if (!api) {
      return;
    }
    const showStopsToggle = document.getElementById("showBusStops");
    const setBaseStopsVisible = (visible) => {
      if (!showStopsToggle || showStopsToggle.checked === visible) {
        return;
      }
      showStopsToggle.checked = visible;
      showStopsToggle.dispatchEvent(new Event("change"));
    };
    const restoreBaseStops = () => {
      if (!state.suppressedBaseStops) {
        return;
      }
      if (state.suppressedBaseStopsPrev) {
        setBaseStopsVisible(true);
      }
      state.suppressedBaseStops = false;
      state.suppressedBaseStopsPrev = null;
    };
    if (!state.moduleOpen) {
      if (typeof api.clearAdvancedStops === "function") {
        api.clearAdvancedStops();
      }
      if (els?.mapLegend) {
        els.mapLegend.style.display = "none";
      }
      if (els?.mapNote) {
        els.mapNote.textContent = "Map overlay paused while this panel is closed.";
      }
      restoreBaseStops();
      return;
    }
    const baseStops = Array.isArray(state.filteredStops) ? state.filteredStops : [];
    const display = buildMapDisplay(baseStops);
    const hasStops = Boolean(display && Array.isArray(display.stops) && display.stops.length > 0);
    if (!hasStops) {
      if (typeof api.clearAdvancedStops === "function") {
        api.clearAdvancedStops();
      }
      restoreBaseStops();
    } else if (typeof api.showAdvancedStops === "function") {
      api.showAdvancedStops(display.stops, display.options);
      if (showStopsToggle && showStopsToggle.checked) {
        state.suppressedBaseStops = true;
        state.suppressedBaseStopsPrev = true;
        setBaseStopsVisible(false);
      }
    }
    if (els?.mapNote) {
      let noteText = display?.note || "";
      if (state.suppressedBaseStops) {
        noteText = noteText ? `${noteText} Base stop layer hidden.` : "Base stop layer hidden.";
      }
      els.mapNote.textContent = noteText;
    }
    if (els?.mapLegend) {
      els.mapLegend.style.display = display.showLegend ? "" : "none";
    }
  };

  const applyFiltersAndRefresh = (els) => {
    updateMapStateFromEls(els);
    syncMapControlState(els);
    const spec = buildFilterSpec(els);
    const filtered = applyFilters(state.stops, spec);
    state.filteredStops = filtered;
    if (state.activeStopNameHighlight && getHighlightedNameStops(filtered).length === 0) {
      state.activeStopNameHighlight = "";
    }
    renderSummary(els.summary, filtered, {
      frequencyBand: state.frequencyBand,
      frequencyAvailable: state.frequencyAvailable,
      centralityAvailable: state.centralityAvailable
    });
    updateScopeNote(els.scopeNote, filtered.length);
    if (state.currentAnalysisIds.length > 0) {
      const results = runAnalyses(state.currentAnalysisIds, filtered, {
        frequencyBand: state.frequencyBand,
        frequencyAvailable: state.frequencyAvailable,
        centralityAvailable: state.centralityAvailable
      });
      renderResults(els.output, results);
    }
    syncMapStops(els);
  };

  const scheduleRefresh = (els) => {
    if (state.debounceHandle) {
      window.clearTimeout(state.debounceHandle);
    }
    state.debounceHandle = window.setTimeout(() => {
      applyFiltersAndRefresh(els);
    }, DEBOUNCE_MS);
  };

  /**
   * Initialises the stop analytics panel and wires its controls.
   *
   * @param {HTMLElement} container Module container element.
   * @returns {Promise<void>}
   * Side effects: Loads stop datasets, binds DOM events, updates map overlays, and mutates module state.
   */
  const initStopAnalyses = async (container) => {
    if (!container) {
      return;
    }
    const target = container.querySelector ? (container.querySelector("#stopAnalysesContainer") || container) : container;
    target.innerHTML = `
      <div class="module-note">Bus stop insights using stop, route, and frequency data.</div>
      <div class="module-note" id="stopAnalysisStatus">Loading bus stop datasets...</div>
      <div class="module-section">
        <div class="section-title">Scope</div>
        <div id="stopScopeNote" class="module-note">Analysing 0 bus stops.</div>
      </div>
      <div class="module-section">
        <div class="section-title">Filters</div>
        <div class="field">
          <label for="stopDistrictEntry">Postcode districts</label>
          <div class="tag-input" id="stopDistrictInput">
            <div class="tag-list" id="stopDistrictTags"></div>
            <input id="stopDistrictEntry" type="search" placeholder="e.g. N1, SW1" autocomplete="off" list="stopDistrictOptions" />
          </div>
          <datalist id="stopDistrictOptions"></datalist>
          <div class="module-note">Use commas or spaces to add multiple districts.</div>
        </div>
        <div class="field">
          <label for="stopBoroughSelect">Borough</label>
          <select id="stopBoroughSelect" class="select-field">
            <option value="">All boroughs</option>
          </select>
        </div>
        <div class="field">
          <label for="stopRegionSelect">Region</label>
          <select id="stopRegionSelect" class="select-field"></select>
        </div>
        <div class="field">
          <label for="stopLetterInput">Stop letter</label>
          <input id="stopLetterInput" class="select-field" type="search" placeholder="e.g. C" autocomplete="off" list="stopLetterOptions" />
          <datalist id="stopLetterOptions"></datalist>
          <div class="module-note">Leave blank to include stops with and without letters.</div>
        </div>
        <div class="button-row">
          <button id="clearStopAnalysisFilters" class="ghost-button compact" type="button">Clear filters</button>
        </div>
      </div>
      <div class="module-section">
        <div class="section-title">Frequency band</div>
        <div class="field">
          <label for="stopFrequencyBand">Use band</label>
          <select id="stopFrequencyBand" class="select-field"></select>
        </div>
        <div id="stopFrequencyNote" class="module-note"></div>
      </div>
      <div class="module-section">
        <div class="section-title">Summary</div>
        <div id="stopAnalysisSummary"></div>
      </div>
      <div class="module-section">
        <div class="section-title">Map visualisation</div>
        <div class="field">
          <label for="stopMapMode">Show on map</label>
          <select id="stopMapMode" class="select-field">
            <option value="filtered">Filtered bus stops (all)</option>
            <option value="top">Top N by metric</option>
            <option value="off">Off</option>
          </select>
        </div>
        <div class="field" id="stopMapTopWrap">
          <label for="stopMapTopN">Top N</label>
          <div class="field-row">
            <input id="stopMapTopN" type="number" min="5" step="5" placeholder="50" />
            <select id="stopMapTopMetric" class="select-field"></select>
          </div>
          <div class="module-note">Uses current filters and scope.</div>
        </div>
        <div class="field">
          <label for="stopMapColourMetric">Colour by</label>
          <select id="stopMapColourMetric" class="select-field"></select>
        </div>
        <div id="stopMapLegend" class="map-legend">
          <span>Low</span>
          <div class="map-legend__bar"></div>
          <span>High</span>
        </div>
        <div id="stopMapNote" class="module-note"></div>
      </div>
      <div class="module-section">
        <div class="section-title">Insight tools</div>
        <div class="analysis-toolbar">
          <select id="stopAnalysisSelect" class="select-field"></select>
          <button id="runStopAnalysis" class="ghost-button compact" type="button">Run analysis</button>
        </div>
        <div id="stopAnalysisOutput" class="analysis-output"></div>
      </div>
    `;

    const els = {
      status: target.querySelector("#stopAnalysisStatus"),
      scopeNote: target.querySelector("#stopScopeNote"),
      districtEntry: target.querySelector("#stopDistrictEntry"),
      districtTags: target.querySelector("#stopDistrictTags"),
      districtOptions: target.querySelector("#stopDistrictOptions"),
      boroughSelect: target.querySelector("#stopBoroughSelect"),
      regionSelect: target.querySelector("#stopRegionSelect"),
      stopLetterInput: target.querySelector("#stopLetterInput"),
      stopLetterOptions: target.querySelector("#stopLetterOptions"),
      clearFiltersButton: target.querySelector("#clearStopAnalysisFilters"),
      frequencyBand: target.querySelector("#stopFrequencyBand"),
      frequencyNote: target.querySelector("#stopFrequencyNote"),
      summary: target.querySelector("#stopAnalysisSummary"),
      mapMode: target.querySelector("#stopMapMode"),
      mapTopWrap: target.querySelector("#stopMapTopWrap"),
      mapTopN: target.querySelector("#stopMapTopN"),
      mapTopMetric: target.querySelector("#stopMapTopMetric"),
      mapColourMetric: target.querySelector("#stopMapColourMetric"),
      mapLegend: target.querySelector("#stopMapLegend"),
      mapNote: target.querySelector("#stopMapNote"),
      analysisSelect: target.querySelector("#stopAnalysisSelect"),
      runButton: target.querySelector("#runStopAnalysis"),
      output: target.querySelector("#stopAnalysisOutput")
    };

    const moduleEl = target.closest("details");
    state.moduleOpen = moduleEl ? moduleEl.open : true;
    if (moduleEl) {
      moduleEl.addEventListener("toggle", () => {
        state.moduleOpen = moduleEl.open;
        syncMapStops(els);
      });
    }

    const syncDistrictTags = () => {
      if (!els.districtTags) {
        return;
      }
      els.districtTags.innerHTML = state.districtTokens
        .map((token) => {
          const safe = token.replace(/"/g, "&quot;");
          return `<span class="tag-chip" data-token="${safe}">
            <span>${safe}</span>
            <button type="button" class="tag-remove" aria-label="Remove ${safe}">x</button>
          </span>`;
        })
        .join("");
    };

    const clearFilters = () => {
      state.districtTokens = [];
      state.boroughToken = "";
      state.regionToken = "";
      state.stopLetterToken = "";
      if (els.districtEntry) {
        els.districtEntry.value = "";
      }
      if (els.boroughSelect) {
        els.boroughSelect.value = "";
      }
      if (els.regionSelect) {
        els.regionSelect.value = "";
      }
      if (els.stopLetterInput) {
        els.stopLetterInput.value = "";
      }
      syncDistrictTags();
      applyFiltersAndRefresh(els);
    };

    const addDistrictTokensFromValue = (value) => {
      const newTokens = parseDistrictTokens(value);
      if (newTokens.length === 0) {
        return;
      }
      const tokenSet = new Set(state.districtTokens);
      newTokens.forEach((token) => {
        if (!tokenSet.has(token)) {
          state.districtTokens.push(token);
          tokenSet.add(token);
        }
      });
      syncDistrictTags();
      scheduleRefresh(els);
    };

    const commitDistrictInput = () => {
      const value = els.districtEntry?.value?.trim();
      if (!value) {
        return;
      }
      addDistrictTokensFromValue(value);
      if (els.districtEntry) {
        els.districtEntry.value = "";
      }
    };

    if (els.districtEntry) {
      els.districtEntry.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " " || event.key === "Spacebar") {
          event.preventDefault();
          commitDistrictInput();
          return;
        }
        if (event.key === "Backspace" && els.districtEntry.value.trim() === "" && state.districtTokens.length > 0) {
          event.preventDefault();
          state.districtTokens = state.districtTokens.slice(0, -1);
          syncDistrictTags();
          scheduleRefresh(els);
        }
      });
      els.districtEntry.addEventListener("blur", () => {
        commitDistrictInput();
      });
    }

    if (els.districtTags) {
      els.districtTags.addEventListener("click", (event) => {
        const button = event.target.closest(".tag-remove");
        if (!button) {
          return;
        }
        const chip = button.closest(".tag-chip");
        if (!chip) {
          return;
        }
        const token = chip.getAttribute("data-token");
        if (!token) {
          return;
        }
        state.districtTokens = state.districtTokens.filter((entry) => entry !== token);
        syncDistrictTags();
        scheduleRefresh(els);
      });
    }

    syncDistrictTags();

    if (els.boroughSelect) {
      els.boroughSelect.addEventListener("change", () => {
        state.boroughToken = normaliseBoroughToken(els.boroughSelect.value || "");
        scheduleRefresh(els);
      });
    }

    if (els.regionSelect) {
      els.regionSelect.innerHTML = REGION_OPTIONS
        .map((option) => `<option value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</option>`)
        .join("");
      els.regionSelect.value = state.regionToken;
      els.regionSelect.addEventListener("change", () => {
        state.regionToken = parseRegionToken(els.regionSelect.value);
        scheduleRefresh(els);
      });
    }

    if (els.stopLetterInput) {
      els.stopLetterInput.addEventListener("input", () => {
        state.stopLetterToken = getStopLetter({ STOP_LETTER: els.stopLetterInput.value || "" });
      });
      els.stopLetterInput.addEventListener("change", () => {
        const normalised = getStopLetter({ STOP_LETTER: els.stopLetterInput.value || "" });
        state.stopLetterToken = normalised;
        els.stopLetterInput.value = normalised;
        scheduleRefresh(els);
      });
      els.stopLetterInput.addEventListener("blur", () => {
        const normalised = getStopLetter({ STOP_LETTER: els.stopLetterInput.value || "" });
        state.stopLetterToken = normalised;
        els.stopLetterInput.value = normalised;
        scheduleRefresh(els);
      });
    }

    if (els.clearFiltersButton) {
      els.clearFiltersButton.addEventListener("click", clearFilters);
    }

    FREQUENCY_BANDS.forEach((band) => {
      if (els.frequencyBand) {
        els.frequencyBand.innerHTML += `<option value="${escapeHtml(band.key)}">${escapeHtml(band.label)}</option>`;
      }
    });

    try {
      const [stopsResult, frequencyData, boroughs] = await Promise.all([
        loadStopsGeojson(),
        loadFrequencyData().catch(() => null),
        loadBoroughsGeojson().catch(() => null)
      ]);

      const geojson = stopsResult?.geojson || null;
      const boroughIndex = geo.buildBoroughIndex && boroughs ? geo.buildBoroughIndex(boroughs) : [];
      state.frequencyAvailable = Boolean(frequencyData);
      state.stops = buildStopsFromGeojson(geojson, frequencyData, boroughIndex);
      state.centralityAvailable = state.stops.some((row) => (
        Number.isFinite(row.betweenness) ||
        Number.isFinite(row.closeness_topo) ||
        Number.isFinite(row.eigenvector)
      ));

      const districtSet = new Set(state.stops.map((row) => row.district).filter(Boolean));
      if (els.districtOptions) {
        const options = Array.from(districtSet)
          .sort((a, b) => String(a).localeCompare(String(b)))
          .map((district) => `<option value="${escapeHtml(district)}"></option>`)
          .join("");
        els.districtOptions.innerHTML = options;
      }

      const boroughSet = new Set(
        state.stops
          .map((row) => row.borough)
          .filter((borough) => borough && borough !== "Unknown")
      );
      if (els.boroughSelect) {
        const options = Array.from(boroughSet)
          .sort((a, b) => String(a).localeCompare(String(b)))
          .map((borough) => `<option value="${escapeHtml(borough)}">${escapeHtml(borough)}</option>`)
          .join("");
        els.boroughSelect.innerHTML = `<option value="">All boroughs</option>${options}`;
      }
      const letterSet = new Set(
        state.stops
          .map((row) => row.stop_letter)
          .filter(Boolean)
      );
      if (els.stopLetterOptions) {
        els.stopLetterOptions.innerHTML = Array.from(letterSet)
          .sort((a, b) => String(a).localeCompare(String(b)))
          .map((letter) => `<option value="${escapeHtml(letter)}"></option>`)
          .join("");
      }

      if (els.frequencyBand) {
        els.frequencyBand.value = state.frequencyBand;
        els.frequencyBand.disabled = !state.frequencyAvailable;
      }
      if (els.frequencyNote) {
        els.frequencyNote.textContent = state.frequencyAvailable
          ? "Totals are based on route frequency data."
          : "Frequency dataset not available.";
      }
      if (els.status) {
        els.status.textContent = `Loaded ${state.stops.length} bus stops.`;
      }
    } catch (error) {
      state.stops = [];
      state.frequencyAvailable = false;
      state.centralityAvailable = false;
      if (els.status) {
        els.status.textContent = "Failed to load bus stop datasets.";
      }
    }

    state.mapTopMetric = resolveMetricSelection(state.mapTopMetric, state, { allowNone: false });
    state.mapColourMetric = resolveMetricSelection(
      state.mapColourMetric || "route_count",
      state,
      { allowNone: true }
    );
    buildMetricOptions(els.mapTopMetric, state, { includeNone: false });
    buildMetricOptions(els.mapColourMetric, state, { includeNone: true });
    syncMapControlState(els);

    state.filteredStops = state.stops.slice();
    buildAnalysisOptions(els.analysisSelect);
    renderSummary(els.summary, state.filteredStops, {
      frequencyBand: state.frequencyBand,
      frequencyAvailable: state.frequencyAvailable,
      centralityAvailable: state.centralityAvailable
    });
    updateScopeNote(els.scopeNote, state.filteredStops.length);
    updateMapStateFromEls(els);
    syncMapControlState(els);
    syncMapStops(els);

    const runSelectedAnalysis = () => {
      if (!els.analysisSelect) {
        return;
      }
      const analysisId = els.analysisSelect.value;
      if (analysisId !== "common-stop-names") {
        state.activeStopNameHighlight = "";
      }
      state.currentAnalysisIds = [analysisId];
      const results = runAnalyses(state.currentAnalysisIds, state.filteredStops, {
        frequencyBand: state.frequencyBand,
        frequencyAvailable: state.frequencyAvailable,
        centralityAvailable: state.centralityAvailable
      });
      renderResults(els.output, results);
      syncMapStops(els);
    };

    if (els.runButton) {
      els.runButton.addEventListener("click", runSelectedAnalysis);
    }

    if (els.analysisSelect) {
      els.analysisSelect.addEventListener("change", runSelectedAnalysis);
    }

    if (els.output) {
      els.output.addEventListener("click", (event) => {
        const button = event.target.closest(".analysis-export");
        if (button) {
          const key = button.dataset.analysisKey;
          const entry = state.resultsByKey.get(key);
          if (!entry || entry.result?.type !== "table") {
            return;
          }
          downloadCsv("bus_stop_analysis.csv", entry.result.columns, entry.result.rows);
          return;
        }
        const row = event.target.closest("tr[data-highlight-name]");
        if (!row) {
          return;
        }
        const highlightName = String(row.dataset.highlightName || "").trim();
        if (!highlightName) {
          return;
        }
        state.activeStopNameHighlight = state.activeStopNameHighlight === highlightName ? "" : highlightName;
        const results = runAnalyses(state.currentAnalysisIds, state.filteredStops, {
          frequencyBand: state.frequencyBand,
          frequencyAvailable: state.frequencyAvailable,
          centralityAvailable: state.centralityAvailable
        });
        renderResults(els.output, results);
        syncMapStops(els);
      });
    }

    if (els.frequencyBand) {
      els.frequencyBand.addEventListener("change", (event) => {
        state.frequencyBand = event.target.value || "peak_am";
        renderSummary(els.summary, state.filteredStops, {
          frequencyBand: state.frequencyBand,
          frequencyAvailable: state.frequencyAvailable,
          centralityAvailable: state.centralityAvailable
        });
        if (state.currentAnalysisIds.length > 0) {
          const results = runAnalyses(state.currentAnalysisIds, state.filteredStops, {
            frequencyBand: state.frequencyBand,
            frequencyAvailable: state.frequencyAvailable,
            centralityAvailable: state.centralityAvailable
          });
          renderResults(els.output, results);
        }
        syncMapStops(els);
      });
    }

    const inputs = target.querySelectorAll("input, select");
    inputs.forEach((input) => {
      if (
        input === els.frequencyBand ||
        input === els.analysisSelect ||
        input === els.districtEntry ||
        input === els.boroughSelect ||
        input === els.regionSelect
      ) {
        return;
      }
      input.addEventListener("input", () => scheduleRefresh(els));
      input.addEventListener("change", () => scheduleRefresh(els));
    });

    runSelectedAnalysis();
  };

  window.RouteMapsterStopAnalyses = {
    initStopAnalyses
  };
})();
