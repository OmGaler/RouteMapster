(() => {
  /**
   * Loads and normalises the route summary dataset used across RouteMapster.
   *
   * This module is the canonical source for turning raw CSV and stop GeoJSON
   * into stable route rows, derived metrics, and serialisable filter
   * specifications. Browser UI modules call into it through
   * `window.RouteMapsterQueryEngine`.
   */
  const ROUTE_SUMMARY_PATHS = [
    "/data/processed/route_summary.csv",
    "/route_summary.csv",
    "/routesummary.csv"
  ];
  const STOPS_GEOJSON_PATH = "/data/processed/stops.geojson";
  const KM_TO_MILES = 0.621371;
  const ROUTE_ID_PARTS_RE = /^([A-Z]*)(\d+)([A-Z]*)$/;
  const KNOWN_ROUTE_TYPES = new Set(["regular", "night", "school", "twentyfour", "unknown"]);
  let cachedRows = null;
  let loadPromise = null;
  let routeStopStatsCache = null;
  let routeStopStatsPromise = null;
  const routeIdPartsCache = new Map();

  /**
   * Parses the small route summary CSV without pulling a browser CSV dependency.
   *
   * @param {string} text Raw CSV text.
   * @returns {string[][]} Parsed rows in source order.
   */
  const parseCsv = (text) => {
    const rows = [];
    let row = [];
    let field = "";
    let inQuotes = false;
    for (let i = 0; i < text.length; i += 1) {
      const char = text[i];
      if (inQuotes) {
        if (char === '"') {
          const next = text[i + 1];
          if (next === '"') {
            field += '"';
            i += 1;
          } else {
            inQuotes = false;
          }
        } else {
          field += char;
        }
        continue;
      }
      if (char === '"') {
        inQuotes = true;
        continue;
      }
      if (char === ',') {
        row.push(field);
        field = "";
        continue;
      }
      if (char === '\n') {
        row.push(field);
        rows.push(row);
        row = [];
        field = "";
        continue;
      }
      if (char === '\r') {
        continue;
      }
      field += char;
    }
    if (field.length > 0 || row.length > 0) {
      row.push(field);
      rows.push(row);
    }
    return rows;
  };

  const toObjects = (rows) => {
    if (!rows || rows.length === 0) {
      return [];
    }
    const headers = rows[0].map((header) => String(header || "").trim());
    return rows.slice(1).map((values) => {
      const row = {};
      headers.forEach((header, index) => {
        if (!header) {
          return;
        }
        row[header] = values[index] !== undefined ? values[index] : "";
      });
      return row;
    });
  };

  const parseNumber = (value) => {
    if (value === null || value === undefined) {
      return null;
    }
    const cleaned = String(value).trim();
    if (!cleaned) {
      return null;
    }
    const num = Number(cleaned);
    return Number.isFinite(num) ? num : null;
  };

  const isExcludedRoute = (routeId) => {
    const value = String(routeId || "").trim().toUpperCase();
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

  const getStopKey = (props) => {
    if (!props || typeof props !== "object") {
      return "";
    }
    const raw = props.NAPTAN_ID ?? props.NaptanId ?? props.stop_id ?? props.stopId ?? props.ATCOCODE ?? props.ATCOCode;
    return String(raw || "").trim();
  };

  /**
   * Counts total and route-only stops for each route in the stop dataset.
   *
   * @param {GeoJSON.FeatureCollection|object|null} geojson Stop GeoJSON payload.
   * @returns {{totalCounts: Map<string, number>, exclusiveCounts: Map<string, number>, connectedRoutesByRoute: Map<string, Set<string>>}} Aggregated stop counts and route adjacency by route.
   */
  const buildRouteStopStats = (geojson) => {
    const features = Array.isArray(geojson?.features) ? geojson.features : [];
    const stopRoutesByKey = new Map();
    features.forEach((feature) => {
      const props = feature?.properties || {};
      const stopKey = getStopKey(props);
      if (!stopKey) {
        return;
      }
      const routes = extractRouteTokens(props.ROUTES ?? props.Routes ?? props.routes);
      let set = stopRoutesByKey.get(stopKey);
      if (!set) {
        set = new Set();
        stopRoutesByKey.set(stopKey, set);
      }
      routes.forEach((routeId) => {
        if (routeId) {
          set.add(routeId);
        }
      });
    });
    const totalCounts = new Map();
    const exclusiveCounts = new Map();
    const connectedRoutesByRoute = new Map();
    stopRoutesByKey.forEach((routes) => {
      const routeList = Array.from(routes)
        .map((routeIdRaw) => String(routeIdRaw || "").trim().toUpperCase())
        .filter(Boolean);
      routeList.forEach((routeId) => {
        totalCounts.set(routeId, (totalCounts.get(routeId) || 0) + 1);
      });
      if (routeList.length === 1) {
        const [onlyRoute] = routeList;
        exclusiveCounts.set(onlyRoute, (exclusiveCounts.get(onlyRoute) || 0) + 1);
        return;
      }
      routeList.forEach((routeId) => {
        let connected = connectedRoutesByRoute.get(routeId);
        if (!connected) {
          connected = new Set();
          connectedRoutesByRoute.set(routeId, connected);
        }
        routeList.forEach((peerRouteId) => {
          if (peerRouteId !== routeId) {
            connected.add(peerRouteId);
          }
        });
      });
    });
    return { totalCounts, exclusiveCounts, connectedRoutesByRoute };
  };

  const normaliseConnectedRouteCounts = (row) => {
    const regular = Number.isFinite(row?.connected_routes_regular) ? row.connected_routes_regular : null;
    const night = Number.isFinite(row?.connected_routes_night) ? row.connected_routes_night : null;
    const school = Number.isFinite(row?.connected_routes_school) ? row.connected_routes_school : null;
    const parsedTotal = Number.isFinite(row?.connected_routes_total) ? row.connected_routes_total : null;
    const total = Number.isFinite(parsedTotal)
      ? parsedTotal
      : [regular, night, school].every(Number.isFinite)
        ? regular + night + school
        : null;
    return {
      regular,
      night,
      school,
      total
    };
  };

  const applyStopDerivedRouteMetrics = (rows, routeStopStats) => {
    const list = Array.isArray(rows) ? rows : [];
    const totalCounts = routeStopStats?.totalCounts;
    const exclusiveCounts = routeStopStats?.exclusiveCounts;
    const connectedRoutesByRoute = routeStopStats?.connectedRoutesByRoute;
    const hasStopData = routeStopStats?.hasData === true;
    const canApplyStopCounts = hasStopData
      && totalCounts && typeof totalCounts.get === "function"
      && exclusiveCounts && typeof exclusiveCounts.get === "function";
    const canApplyConnections = hasStopData
      && connectedRoutesByRoute && typeof connectedRoutesByRoute.get === "function";
    const rowsById = new Map();
    list.forEach((row) => {
      const routeId = String(row?.route_id_norm || "").trim().toUpperCase();
      if (routeId) {
        rowsById.set(routeId, row);
      }
    });

    const classifyConnectedRoute = (routeId) => {
      const normalisedRouteId = String(routeId || "").trim().toUpperCase();
      if (!normalisedRouteId || isExcludedRoute(normalisedRouteId)) {
        return "";
      }
      const routeType = normaliseRouteType(rowsById.get(normalisedRouteId)?.route_type || "");
      if (routeType === "night" || normalisedRouteId.startsWith("N")) {
        return "night";
      }
      if (routeType === "school") {
        return "school";
      }
      return "regular";
    };

    list.forEach((row) => {
      const routeId = String(row?.route_id_norm || "").trim().toUpperCase();
      if (!routeId) {
        row.unique_stops = null;
        row.total_stops = null;
        row.unique_stops_pct = null;
        row.connected_routes_regular = null;
        row.connected_routes_night = null;
        row.connected_routes_school = null;
        row.connected_routes_total = null;
        return;
      }

      if (canApplyStopCounts) {
        const totalStops = totalCounts.get(routeId) ?? 0;
        const uniqueStops = exclusiveCounts.get(routeId) ?? 0;
        row.unique_stops = uniqueStops;
        row.total_stops = totalStops;
        row.unique_stops_pct = totalStops > 0 ? uniqueStops / totalStops : 0;
      } else {
        if (!Number.isFinite(row.unique_stops)) {
          row.unique_stops = null;
        }
        if (!Number.isFinite(row.total_stops)) {
          row.total_stops = null;
        }
        if (!Number.isFinite(row.unique_stops_pct)) {
          row.unique_stops_pct = Number.isFinite(row.unique_stops) && Number.isFinite(row.total_stops) && row.total_stops > 0
            ? row.unique_stops / row.total_stops
            : null;
        }
      }

      if (canApplyConnections) {
        let regular = 0;
        let night = 0;
        let school = 0;
        const connectedRoutes = connectedRoutesByRoute.get(routeId);
        connectedRoutes?.forEach((peerRouteId) => {
          switch (classifyConnectedRoute(peerRouteId)) {
            case "night":
              night += 1;
              break;
            case "school":
              school += 1;
              break;
            case "regular":
              regular += 1;
              break;
            default:
              break;
          }
        });
        row.connected_routes_regular = regular;
        row.connected_routes_night = night;
        row.connected_routes_school = school;
        row.connected_routes_total = regular + night + school;
        return;
      }

      const fallbackCounts = normaliseConnectedRouteCounts(row);
      row.connected_routes_regular = fallbackCounts.regular;
      row.connected_routes_night = fallbackCounts.night;
      row.connected_routes_school = fallbackCounts.school;
      row.connected_routes_total = fallbackCounts.total;
    });
  };

  /**
   * Loads and caches stop-based route statistics used by downstream analyses.
   *
   * @returns {Promise<{totalCounts: Map<string, number>, exclusiveCounts: Map<string, number>, connectedRoutesByRoute: Map<string, Set<string>>, hasData: boolean}>} Cached stop statistics.
   * Side effects: Fetches the stop GeoJSON once and memoises the result.
   */
  const loadRouteStopStats = async () => {
    if (routeStopStatsCache) {
      return routeStopStatsCache;
    }
    if (routeStopStatsPromise) {
      return routeStopStatsPromise;
    }
    routeStopStatsPromise = fetch(STOPS_GEOJSON_PATH)
      .then((response) => response.ok ? response.json() : null)
      .then((geojson) => {
        routeStopStatsCache = {
          ...buildRouteStopStats(geojson),
          hasData: Boolean(geojson)
        };
        return routeStopStatsCache;
      })
      .catch(() => {
        routeStopStatsCache = {
          totalCounts: new Map(),
          exclusiveCounts: new Map(),
          connectedRoutesByRoute: new Map(),
          hasData: false
        };
        return routeStopStatsCache;
      })
      .finally(() => {
        routeStopStatsPromise = null;
      });
    return routeStopStatsPromise;
  };

  const splitList = (value) => {
    if (!value) {
      return [];
    }
    return String(value)
      .split(';')
      .map((entry) => entry.trim())
      .filter(Boolean);
  };

  const normaliseRouteType = (value) => {
    const token = String(value || "").trim().toLowerCase();
    if (!token) {
      return "unknown";
    }
    if (token === "24hr" || token === "24 hour" || token === "24-hour" || token === "24hour" || token === "24") {
      return "twentyfour";
    }
    if (token === "twentyfour" || token === "twenty-four") {
      return "twentyfour";
    }
    if (KNOWN_ROUTE_TYPES.has(token)) {
      return token;
    }
    return token;
  };

  const normaliseToken = (value) => String(value || "").trim();
  const normaliseLower = (value) => normaliseToken(value).toLowerCase();
  const normaliseLooseToken = (value) => normaliseLower(value).replace(/[^a-z0-9]/g, "");
  const normaliseEndpointKey = (value) => normaliseToken(value).replace(/\s+/g, "");
  const buildBoroughMatcher = (value) => {
    const lower = normaliseLower(value);
    const loose = normaliseLooseToken(value);
    return { lower, loose };
  };
  const boroughTokenMatches = (value, matcher) => {
    if (!matcher || (!matcher.lower && !matcher.loose)) {
      return false;
    }
    const lower = normaliseLower(value);
    if (matcher.lower && lower.includes(matcher.lower)) {
      return true;
    }
    if (!matcher.loose) {
      return false;
    }
    const loose = normaliseLooseToken(value);
    return Boolean(loose) && loose.includes(matcher.loose);
  };
  const parseRouteIdParts = (value) => {
    const token = normaliseToken(value).toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (!token) {
      return null;
    }
    if (routeIdPartsCache.has(token)) {
      return routeIdPartsCache.get(token);
    }
    const match = token.match(ROUTE_ID_PARTS_RE);
    if (!match) {
      routeIdPartsCache.set(token, null);
      return null;
    }
    const num = Number(match[2]);
    if (!Number.isFinite(num)) {
      routeIdPartsCache.set(token, null);
      return null;
    }
    const parts = { prefix: match[1] || "", number: num, suffix: match[3] || "" };
    routeIdPartsCache.set(token, parts);
    return parts;
  };

  const normaliseSeriesValue = (value) => {
    if (value === null || value === undefined || value === "") {
      return undefined;
    }
    const num = Number(value);
    if (!Number.isFinite(num) || !Number.isInteger(num)) {
      return undefined;
    }
    if (num < 0 || num > 99) {
      return undefined;
    }
    return num;
  };

  const routeMatchesSeries = (routeId, seriesValue, includePrefixes) => {
    if (!Number.isFinite(seriesValue)) {
      return true;
    }
    const parts = parseRouteIdParts(routeId);
    if (!parts) {
      return false;
    }
    if (parts.prefix === "SL") {
      return false;
    }
    if (parts.number % 100 !== seriesValue) {
      return false;
    }
    if (!includePrefixes && parts.prefix && parts.prefix !== "N") {
      return false;
    }
    return true;
  };

  const resolveField = (row, keys) => {
    for (const key of keys) {
      if (row[key] !== undefined) {
        return row[key];
      }
    }
    return "";
  };

  const normaliseRow = (row) => {
    const routeIdRaw = resolveField(row, ["route_id", "route", "routeId", "routeid"]);
    const routeId = normaliseToken(routeIdRaw);
    const routeIdNorm = routeId.toUpperCase();
    const routeTypeRaw = resolveField(row, ["route_type", "routeType", "type"]);
    const operatorsRaw = resolveField(row, ["operator_names", "operators", "operator"]);
    const garagesCodesRaw = resolveField(row, ["garage_codes", "garage_code", "garageCodes", "garage"]);
    const garagesNamesRaw = resolveField(row, ["garage_names", "garage_name", "garageNames"]);
    const vehicleRaw = resolveField(row, ["vehicle_type", "vehicle", "vehicleType"]);
    const lengthKm = parseNumber(resolveField(row, ["length_km", "lengthKm", "length"]));
    const lengthMilesRaw = parseNumber(resolveField(row, ["length_miles", "lengthMiles", "length_mi", "lengthMi"]));
    const uniqueStops = parseNumber(resolveField(row, ["unique_stops", "uniqueStops", "stop_count", "stopCount"]));
    const totalStops = parseNumber(resolveField(row, ["total_stops", "totalStops", "route_stop_count", "routeStopCount"]));
    const uniqueStopsPct = parseNumber(resolveField(row, ["unique_stops_pct", "uniqueStopsPct", "exclusive_stop_pct", "exclusiveStopPct"]));
    const connectedRoutesRegular = parseNumber(resolveField(row, ["connected_routes_regular", "connectedRoutesRegular", "shared_stop_routes_regular", "sharedStopRoutesRegular"]));
    const connectedRoutesNight = parseNumber(resolveField(row, ["connected_routes_night", "connectedRoutesNight", "shared_stop_routes_night", "sharedStopRoutesNight"]));
    const connectedRoutesSchool = parseNumber(resolveField(row, ["connected_routes_school", "connectedRoutesSchool", "shared_stop_routes_school", "sharedStopRoutesSchool"]));
    const connectedRoutesTotal = parseNumber(resolveField(row, ["connected_routes_total", "connectedRoutesTotal", "shared_stop_routes_total", "sharedStopRoutesTotal"]));
    const lengthMiles = Number.isFinite(lengthMilesRaw)
      ? lengthMilesRaw
      : Number.isFinite(lengthKm)
        ? lengthKm * KM_TO_MILES
        : null;
    const northmostLat = parseNumber(resolveField(row, ["northmost_lat", "northmostLat", "north_lat", "northLat"]));
    const southmostLat = parseNumber(resolveField(row, ["southmost_lat", "southmostLat", "south_lat", "southLat"]));
    const eastmostLon = parseNumber(resolveField(row, ["eastmost_lon", "eastmostLon", "east_lon", "eastLon"]));
    const westmostLon = parseNumber(resolveField(row, ["westmost_lon", "westmostLon", "west_lon", "westLon"]));
    const endpointStartLat = parseNumber(resolveField(row, ["endpoint_start_lat", "start_lat", "startLat"]));
    const endpointStartLon = parseNumber(resolveField(row, ["endpoint_start_lon", "start_lon", "startLon"]));
    const endpointEndLat = parseNumber(resolveField(row, ["endpoint_end_lat", "end_lat", "endLat"]));
    const endpointEndLon = parseNumber(resolveField(row, ["endpoint_end_lon", "end_lon", "endLon"]));
    const endpointPairKey = normaliseEndpointKey(resolveField(row, ["endpoint_pair_key", "endpointPair", "endpoint_pair"]));
    const destinationOutbound = normaliseToken(resolveField(row, ["destination_outbound", "destinationOutbound"]));
    const destinationInbound = normaliseToken(resolveField(row, ["destination_inbound", "destinationInbound"]));
    const destinationOutboundQualifier = normaliseToken(resolveField(row, ["destination_outbound_qualifier", "destinationOutboundQualifier"]));
    const destinationInboundQualifier = normaliseToken(resolveField(row, ["destination_inbound_qualifier", "destinationInboundQualifier"]));
    const destinationOutboundFull = normaliseToken(resolveField(row, ["destination_outbound_full", "destinationOutboundFull"]));
    const destinationInboundFull = normaliseToken(resolveField(row, ["destination_inbound_full", "destinationInboundFull"]));

    const operatorList = splitList(operatorsRaw);
    const operatorNorm = operatorList.map(normaliseLower);
    const garageCodes = splitList(garagesCodesRaw);
    const garageNames = splitList(garagesNamesRaw);
    const garageTokens = [...garageCodes, ...garageNames];
    const garageNorm = garageTokens.map(normaliseLower);

    const vehicleType = normaliseToken(vehicleRaw);

    return {
      route_id: routeId,
      route_id_norm: routeIdNorm,
      route_type: normaliseRouteType(routeTypeRaw),
      operator_names: operatorsRaw ? normaliseToken(operatorsRaw) : "",
      operator_names_arr: operatorList,
      operator_names_norm: operatorNorm,
      garage_codes: garagesCodesRaw ? normaliseToken(garagesCodesRaw) : "",
      garage_names: garagesNamesRaw ? normaliseToken(garagesNamesRaw) : "",
      garage_codes_arr: garageCodes,
      garage_names_arr: garageNames,
      garage_tokens_norm: garageNorm,
      vehicle_type: vehicleType ? vehicleType.toUpperCase() : "",
      additional_journeys: parseNumber(resolveField(row, ["additional_journeys", "additionalJourneys"])),
      frequency_peak_am: parseNumber(resolveField(row, ["frequency_peak_am", "peak_am", "peakAm"])),
      frequency_peak_pm: parseNumber(resolveField(row, ["frequency_peak_pm", "peak_pm", "peakPm"])),
      frequency_offpeak: parseNumber(resolveField(row, ["frequency_offpeak", "offpeak", "offPeak"])),
      frequency_weekend: parseNumber(resolveField(row, ["frequency_weekend", "weekend"])),
      frequency_overnight: parseNumber(resolveField(row, ["frequency_overnight", "overnight"])),
      length_km: lengthKm,
      length_miles: lengthMiles,
      destination_outbound: destinationOutbound,
      destination_inbound: destinationInbound,
      destination_outbound_qualifier: destinationOutboundQualifier,
      destination_inbound_qualifier: destinationInboundQualifier,
      destination_outbound_full: destinationOutboundFull,
      destination_inbound_full: destinationInboundFull,
      unique_stops: uniqueStops,
      total_stops: totalStops,
      unique_stops_pct: uniqueStopsPct,
      connected_routes_regular: connectedRoutesRegular,
      connected_routes_night: connectedRoutesNight,
      connected_routes_school: connectedRoutesSchool,
      connected_routes_total: connectedRoutesTotal,
      northmost_lat: northmostLat,
      southmost_lat: southmostLat,
      eastmost_lon: eastmostLon,
      westmost_lon: westmostLon,
      endpoint_start_lat: endpointStartLat,
      endpoint_start_lon: endpointStartLon,
      endpoint_end_lat: endpointEndLat,
      endpoint_end_lon: endpointEndLon,
      endpoint_pair_key: endpointPairKey
    };
  };

  /**
   * Loads, normalises, and enriches the route summary rows.
   *
   * @returns {Promise<Array<object>>} Normalised route rows ready for filtering and analysis.
   * Side effects: Fetches CSV and stop datasets, then updates the module cache.
   */
  const loadRouteSummary = async () => {
    if (Array.isArray(cachedRows) && cachedRows.length > 0) {
      return cachedRows;
    }
    if (loadPromise) {
      return loadPromise;
    }
    const loadSummaryText = async () => {
      for (const path of ROUTE_SUMMARY_PATHS) {
        try {
          const response = await fetch(path);
          if (!response.ok) {
            continue;
          }
          const text = await response.text();
          if (text && text.trim()) {
            return text;
          }
        } catch (_) {
          // The repository serves the summary from different paths in local and deployed builds.
        }
      }
      return "";
    };
    loadPromise = Promise.all([
      loadSummaryText(),
      loadRouteStopStats().catch(() => ({
        totalCounts: new Map(),
        exclusiveCounts: new Map(),
        connectedRoutesByRoute: new Map(),
        hasData: false
      }))
    ])
      .then(([text, routeStopStats]) => {
        if (!text) {
          return [];
        }
        const parsed = parseCsv(text);
        const objects = toObjects(parsed);
        const rows = objects.map((row) => normaliseRow(row));
        applyStopDerivedRouteMetrics(rows, routeStopStats);
        if (rows.length > 0) {
          cachedRows = rows;
        }
        return rows;
      })
      .catch(() => {
        return Array.isArray(cachedRows) ? cachedRows : [];
      })
      .finally(() => {
        loadPromise = null;
      });
    return loadPromise;
  };

  const average = (values) => {
    let sum = 0;
    let count = 0;
    for (let i = 0; i < values.length; i += 1) {
      const value = values[i];
      if (!Number.isFinite(value)) {
        continue;
      }
      sum += value;
      count += 1;
    }
    if (count === 0) {
      return null;
    }
    return sum / count;
  };

  /**
   * Computes lightweight derived fields that several filters and analyses share.
   *
   * @param {Array<object>} rows Normalised route rows.
   * @returns {Array<object>} New row objects with derived metrics appended.
   */
  const computeDerivedFields = (rows) => {
    const list = Array.isArray(rows) ? rows : [];
    return list.map((row) => {
      const peakAvg = average([row.frequency_peak_am, row.frequency_peak_pm]);
      const offpeak = row.frequency_offpeak;
      const overnight = row.frequency_overnight;
      const totalStops = Number.isFinite(row.total_stops) ? row.total_stops : null;
      const uniqueStops = Number.isFinite(row.unique_stops) ? row.unique_stops : null;
      const uniqueStopsPct = Number.isFinite(uniqueStops) && Number.isFinite(totalStops) && totalStops > 0
        ? uniqueStops / totalStops
        : Number.isFinite(row.unique_stops_pct)
          ? row.unique_stops_pct
          : null;
      return {
        ...row,
        peakiness_index: Number.isFinite(peakAvg) && Number.isFinite(offpeak) ? peakAvg - offpeak : null,
        has_overnight: Number.isFinite(overnight) ? overnight > 0 : false,
        unique_stops_pct: uniqueStopsPct
      };
    });
  };

  /**
   * Canonicalises a filter specification from UI, presets, or query text.
   *
   * @param {object} filterSpec Untrusted filter input with possible aliases.
   * @returns {object} Normalised filter spec with consistent keys and value shapes.
   */
  const normalizeFilterSpec = (filterSpec) => {
    const spec = filterSpec && typeof filterSpec === "object" ? filterSpec : {};
    const lengthSpec = spec.length_miles && typeof spec.length_miles === "object"
      ? spec.length_miles
      : spec.length_km && typeof spec.length_km === "object"
        ? spec.length_km
        : undefined;
    const uniqueStopsSpec = spec.unique_stops && typeof spec.unique_stops === "object"
      ? spec.unique_stops
      : spec.uniqueStops && typeof spec.uniqueStops === "object"
        ? spec.uniqueStops
        : spec.stop_count && typeof spec.stop_count === "object"
          ? spec.stop_count
          : undefined;
    const lengthRankRaw = spec.length_rank && typeof spec.length_rank === "object"
      ? spec.length_rank
      : spec.lengthRank && typeof spec.lengthRank === "object"
        ? spec.lengthRank
        : undefined;
    const lengthRankModeRaw = lengthRankRaw?.mode ?? lengthRankRaw?.direction ?? lengthRankRaw?.order;
    const lengthRankMode = ["shortest", "longest"].includes(String(lengthRankModeRaw || "").toLowerCase())
      ? String(lengthRankModeRaw).toLowerCase()
      : undefined;
    const lengthRankCountRaw = parseNumber(lengthRankRaw?.count ?? lengthRankRaw?.n ?? lengthRankRaw?.limit);
    const lengthRankCount = Number.isFinite(lengthRankCountRaw) ? Math.round(lengthRankCountRaw) : null;
    const lengthRank = lengthRankMode && Number.isFinite(lengthRankCount) && lengthRankCount >= 1 && lengthRankCount <= 25
      ? { mode: lengthRankMode, count: lengthRankCount }
      : undefined;
    const uniqueStopsRankRaw = spec.unique_stops_rank && typeof spec.unique_stops_rank === "object"
      ? spec.unique_stops_rank
      : spec.uniqueStopsRank && typeof spec.uniqueStopsRank === "object"
        ? spec.uniqueStopsRank
        : spec.stop_count_rank && typeof spec.stop_count_rank === "object"
          ? spec.stop_count_rank
          : undefined;
    const uniqueStopsRankModeRaw = uniqueStopsRankRaw?.mode ?? uniqueStopsRankRaw?.direction ?? uniqueStopsRankRaw?.order;
    const uniqueStopsRankMode = ["least", "most"].includes(String(uniqueStopsRankModeRaw || "").toLowerCase())
      ? String(uniqueStopsRankModeRaw).toLowerCase()
      : undefined;
    const uniqueStopsRankCountRaw = parseNumber(uniqueStopsRankRaw?.count ?? uniqueStopsRankRaw?.n ?? uniqueStopsRankRaw?.limit);
    const uniqueStopsRankCount = Number.isFinite(uniqueStopsRankCountRaw) ? Math.round(uniqueStopsRankCountRaw) : null;
    const uniqueStopsRank = uniqueStopsRankMode && Number.isFinite(uniqueStopsRankCount) && uniqueStopsRankCount >= 1 && uniqueStopsRankCount <= 25
      ? { mode: uniqueStopsRankMode, count: uniqueStopsRankCount }
      : undefined;
    const extreme = spec.extreme && ["north", "south", "east", "west"].includes(String(spec.extreme).toLowerCase())
      ? String(spec.extreme).toLowerCase()
      : undefined;
    const boroughModeRaw = spec.borough_mode || spec.boroughMode || "";
    const boroughMode = String(boroughModeRaw || "").trim().toLowerCase() === "within" ? "within" : undefined;
    const seriesValue = normaliseSeriesValue(spec.route_series ?? spec.routeSeries ?? spec.series);
    const includePrefixRoutes = seriesValue !== undefined
      ? Boolean(spec.include_prefix_routes ?? spec.includePrefixRoutes)
      : undefined;

    const normalised = {
      route_ids: Array.isArray(spec.route_ids) ? spec.route_ids.map(normaliseToken).filter(Boolean) : undefined,
      route_prefix: spec.route_prefix ? normaliseToken(spec.route_prefix) : undefined,
      route_series: seriesValue,
      include_prefix_routes: includePrefixRoutes,
      route_types: Array.isArray(spec.route_types) ? spec.route_types.map(normaliseLower).filter(Boolean) : undefined,
      operators: Array.isArray(spec.operators) ? spec.operators.map(normaliseLower).filter(Boolean) : undefined,
      garages: Array.isArray(spec.garages) ? spec.garages.map(normaliseLower).filter(Boolean) : undefined,
      boroughs: Array.isArray(spec.boroughs) ? spec.boroughs.map(normaliseLower).filter(Boolean) : undefined,
      borough_mode: boroughMode,
      vehicle_types: Array.isArray(spec.vehicle_types) ? spec.vehicle_types.map((value) => normaliseToken(value).toUpperCase()).filter(Boolean) : undefined,
      freq: spec.freq && typeof spec.freq === "object" ? spec.freq : undefined,
      flags: spec.flags && typeof spec.flags === "object" ? spec.flags : undefined,
      length_miles: lengthSpec,
      unique_stops: uniqueStopsSpec,
      length_rank: lengthRank,
      unique_stops_rank: uniqueStopsRank,
      extreme
    };
    return normalised;
  };

  /**
   * Applies the current filter specification to a set of route rows.
   *
   * @param {Array<object>} rows Candidate route rows.
   * @param {object} filterSpec Filter specification from UI or deep link state.
   * @returns {Array<object>} Rows that satisfy every active filter.
   */
  const applyFilters = (rows, filterSpec) => {
    const list = Array.isArray(rows) ? rows : [];
    const spec = normalizeFilterSpec(filterSpec);
    const routeIdsSet = spec.route_ids && spec.route_ids.length > 0
      ? new Set(spec.route_ids.map((value) => value.toUpperCase()))
      : null;
    const routePrefix = spec.route_prefix ? spec.route_prefix.toUpperCase() : null;
    const seriesValue = Number.isFinite(spec.route_series) ? spec.route_series : null;
    const includePrefixRoutes = spec.include_prefix_routes === true;
    const routeTypeSet = spec.route_types && spec.route_types.length > 0
      ? new Set(spec.route_types)
      : null;
    const operatorSet = spec.operators && spec.operators.length > 0
      ? new Set(spec.operators)
      : null;
    const garageSet = spec.garages && spec.garages.length > 0
      ? new Set(spec.garages)
      : null;
    const boroughMatchers = spec.boroughs && spec.boroughs.length > 0
      ? spec.boroughs.map((value) => buildBoroughMatcher(value)).filter((matcher) => matcher.lower || matcher.loose)
      : null;
    const boroughMode = spec.borough_mode === "within" ? "within" : "enter";
    const vehicleSet = spec.vehicle_types && spec.vehicle_types.length > 0
      ? new Set(spec.vehicle_types)
      : null;
    const freqChecks = spec.freq
      ? ["peak_am", "peak_pm", "offpeak", "weekend", "overnight"]
        .map((key) => {
          const range = spec.freq[key];
          if (!range) {
            return null;
          }
          return {
            key,
            min: Number.isFinite(range.min) ? range.min : null,
            max: Number.isFinite(range.max) ? range.max : null
          };
        })
        .filter(Boolean)
      : null;
    const requireHasOvernight = typeof spec.flags?.has_overnight === "boolean"
      ? spec.flags.has_overnight
      : null;
    const highFrequencyThreshold = Number.isFinite(spec.flags?.high_frequency_any)
      ? spec.flags.high_frequency_any
      : null;
    const hasBoroughMatchers = Array.isArray(boroughMatchers) && boroughMatchers.length > 0;

    // Apply inexpensive attribute filters first; ranking and extremity filters
    // are resolved afterwards against the narrowed subset.
    let filtered = list.filter((row) => {
      if (!row || !row.route_id_norm) {
        return false;
      }
      if (routeIdsSet && !routeIdsSet.has(row.route_id_norm)) {
        return false;
      }
      if (routePrefix && !row.route_id_norm.startsWith(routePrefix)) {
        return false;
      }
      if (!routeMatchesSeries(row.route_id_norm, seriesValue, includePrefixRoutes)) {
        return false;
      }
      if (routeTypeSet && !routeTypeSet.has(row.route_type)) {
        return false;
      }
      if (operatorSet) {
        const matchesOperator = row.operator_names_norm.some((name) => operatorSet.has(name));
        if (!matchesOperator) {
          return false;
        }
      }
      if (garageSet) {
        const matchesGarage = row.garage_tokens_norm.some((name) => garageSet.has(name));
        if (!matchesGarage) {
          return false;
        }
      }
      if (hasBoroughMatchers) {
        const boroughs = Array.isArray(row.boroughs_norm) ? row.boroughs_norm : [];
        const matchesAnyBorough = (token) => boroughMatchers.some((matcher) => boroughTokenMatches(token, matcher));
        if (boroughMode === "within") {
          if (boroughs.length === 0) {
            return false;
          }
          const allInside = boroughs.every((token) => matchesAnyBorough(token));
          if (!allInside) {
            return false;
          }
        } else {
          const matchesBorough = boroughs.some((token) => matchesAnyBorough(token));
          if (!matchesBorough) {
            return false;
          }
        }
      }
      if (vehicleSet && !vehicleSet.has(row.vehicle_type)) {
        return false;
      }
      if (freqChecks) {
        for (let i = 0; i < freqChecks.length; i += 1) {
          const range = freqChecks[i];
          let value = null;
          if (range.key === "peak_am") {
            value = row.frequency_peak_am;
          } else if (range.key === "peak_pm") {
            value = row.frequency_peak_pm;
          } else if (range.key === "offpeak") {
            value = row.frequency_offpeak;
          } else if (range.key === "weekend") {
            value = row.frequency_weekend;
          } else {
            value = row.frequency_overnight;
          }
          if (!Number.isFinite(value)) {
            return false;
          }
          if (range.min !== null && value < range.min) {
            return false;
          }
          if (range.max !== null && value > range.max) {
            return false;
          }
        }
      }
      if (requireHasOvernight !== null) {
        const hasOvernight = Number.isFinite(row.frequency_overnight) ? row.frequency_overnight > 0 : false;
        if (requireHasOvernight !== hasOvernight) {
          return false;
        }
      }
      if (highFrequencyThreshold !== null) {
        const meets = (Number.isFinite(row.frequency_peak_am) && row.frequency_peak_am >= highFrequencyThreshold)
          || (Number.isFinite(row.frequency_peak_pm) && row.frequency_peak_pm >= highFrequencyThreshold)
          || (Number.isFinite(row.frequency_offpeak) && row.frequency_offpeak >= highFrequencyThreshold)
          || (Number.isFinite(row.frequency_weekend) && row.frequency_weekend >= highFrequencyThreshold)
          || (Number.isFinite(row.frequency_overnight) && row.frequency_overnight >= highFrequencyThreshold);
        if (!meets) {
          return false;
        }
      }
      if (spec.length_miles) {
        const value = row.length_miles;
        if (Number.isFinite(value)) {
          if (spec.length_miles.min !== undefined && Number.isFinite(spec.length_miles.min) && value < spec.length_miles.min) {
            return false;
          }
          if (spec.length_miles.max !== undefined && Number.isFinite(spec.length_miles.max) && value > spec.length_miles.max) {
            return false;
          }
        }
      }
      if (spec.unique_stops) {
        const value = row.unique_stops;
        if (!Number.isFinite(value)) {
          return false;
        }
        if (spec.unique_stops.min !== undefined && Number.isFinite(spec.unique_stops.min) && value < spec.unique_stops.min) {
          return false;
        }
        if (spec.unique_stops.max !== undefined && Number.isFinite(spec.unique_stops.max) && value > spec.unique_stops.max) {
          return false;
        }
      }
      return true;
    });
    if (spec.extreme) {
      // Extremity filters are relative to the already filtered subset rather than
      // the whole network, which matches how the UI describes "most easterly" etc.
      const fieldByExtreme = {
        north: "northmost_lat",
        south: "southmost_lat",
        east: "eastmost_lon",
        west: "westmost_lon"
      };
      const field = fieldByExtreme[spec.extreme];
      let target = null;
      for (let i = 0; i < filtered.length; i += 1) {
        const value = filtered[i]?.[field];
        if (!Number.isFinite(value)) {
          continue;
        }
        if (target === null) {
          target = value;
          continue;
        }
        if ((spec.extreme === "north" || spec.extreme === "east") && value > target) {
          target = value;
        }
        if ((spec.extreme === "south" || spec.extreme === "west") && value < target) {
          target = value;
        }
      }
      if (!Number.isFinite(target)) {
        return [];
      }
      const epsilon = 1e-6;
      filtered = filtered.filter((row) => Number.isFinite(row?.[field]) && Math.abs(row[field] - target) <= epsilon);
    }
    if (spec.length_rank) {
      // Ranking filters deliberately replace the existing order with a strict
      // top-N slice so callers get deterministic results.
      const direction = spec.length_rank.mode === "longest" ? "longest" : "shortest";
      const limit = Number.isFinite(spec.length_rank.count) ? Math.round(spec.length_rank.count) : 0;
      if (limit > 0) {
        filtered = filtered
          .filter((row) => Number.isFinite(row.length_miles))
          .slice()
          .sort((a, b) => direction === "longest"
            ? b.length_miles - a.length_miles
            : a.length_miles - b.length_miles)
          .slice(0, limit);
      } else {
        filtered = [];
      }
    }
    if (spec.unique_stops_rank) {
      const direction = spec.unique_stops_rank.mode === "most" ? "most" : "least";
      const limit = Number.isFinite(spec.unique_stops_rank.count) ? Math.round(spec.unique_stops_rank.count) : 0;
      if (limit > 0) {
        filtered = filtered
          .filter((row) => Number.isFinite(row.unique_stops))
          .slice()
          .sort((a, b) => direction === "most"
            ? b.unique_stops - a.unique_stops
            : a.unique_stops - b.unique_stops)
          .slice(0, limit);
      } else {
        filtered = [];
      }
    }
    return filtered;
  };

  const compactFilterSpec = (spec) => {
    if (!spec || typeof spec !== "object") {
      return {};
    }
    const cleaned = {};
    if (Array.isArray(spec.route_ids) && spec.route_ids.length > 0) {
      cleaned.route_ids = spec.route_ids;
    }
    if (spec.route_prefix) {
      cleaned.route_prefix = spec.route_prefix;
    }
    if (Number.isFinite(spec.route_series)) {
      cleaned.route_series = spec.route_series;
      if (spec.include_prefix_routes === true) {
        cleaned.include_prefix_routes = true;
      }
    }
    if (Array.isArray(spec.route_types) && spec.route_types.length > 0) {
      cleaned.route_types = spec.route_types;
    }
    if (Array.isArray(spec.operators) && spec.operators.length > 0) {
      cleaned.operators = spec.operators;
    }
    if (Array.isArray(spec.garages) && spec.garages.length > 0) {
      cleaned.garages = spec.garages;
    }
    if (Array.isArray(spec.boroughs) && spec.boroughs.length > 0) {
      cleaned.boroughs = spec.boroughs;
    }
    if (spec.borough_mode === "within") {
      cleaned.borough_mode = "within";
    }
    if (Array.isArray(spec.vehicle_types) && spec.vehicle_types.length > 0) {
      cleaned.vehicle_types = spec.vehicle_types;
    }
    if (spec.freq && typeof spec.freq === "object") {
      const freq = {};
      ["peak_am", "peak_pm", "offpeak", "weekend", "overnight"].forEach((key) => {
        const range = spec.freq[key];
        if (range && (Number.isFinite(range.min) || Number.isFinite(range.max))) {
          freq[key] = {
            ...(Number.isFinite(range.min) ? { min: range.min } : {}),
            ...(Number.isFinite(range.max) ? { max: range.max } : {})
          };
        }
      });
      if (Object.keys(freq).length > 0) {
        cleaned.freq = freq;
      }
    }
    if (spec.flags && typeof spec.flags === "object") {
      const flags = {};
      if (typeof spec.flags.has_overnight === "boolean") {
        flags.has_overnight = spec.flags.has_overnight;
      }
      if (Number.isFinite(spec.flags.high_frequency_any)) {
        flags.high_frequency_any = spec.flags.high_frequency_any;
      }
      if (Object.keys(flags).length > 0) {
        cleaned.flags = flags;
      }
    }
    if (spec.length_miles && (Number.isFinite(spec.length_miles.min) || Number.isFinite(spec.length_miles.max))) {
      cleaned.length_miles = {
        ...(Number.isFinite(spec.length_miles.min) ? { min: spec.length_miles.min } : {}),
        ...(Number.isFinite(spec.length_miles.max) ? { max: spec.length_miles.max } : {})
      };
    }
    if (spec.unique_stops && (Number.isFinite(spec.unique_stops.min) || Number.isFinite(spec.unique_stops.max))) {
      cleaned.unique_stops = {
        ...(Number.isFinite(spec.unique_stops.min) ? { min: spec.unique_stops.min } : {}),
        ...(Number.isFinite(spec.unique_stops.max) ? { max: spec.unique_stops.max } : {})
      };
    }
    if (spec.length_rank && typeof spec.length_rank === "object") {
      const mode = spec.length_rank.mode;
      const count = spec.length_rank.count;
      if ((mode === "shortest" || mode === "longest") && Number.isFinite(count)) {
        cleaned.length_rank = { mode, count };
      }
    }
    if (spec.unique_stops_rank && typeof spec.unique_stops_rank === "object") {
      const mode = spec.unique_stops_rank.mode;
      const count = spec.unique_stops_rank.count;
      if ((mode === "least" || mode === "most") && Number.isFinite(count)) {
        cleaned.unique_stops_rank = { mode, count };
      }
    }
    if (spec.extreme) {
      cleaned.extreme = spec.extreme;
    }
    return cleaned;
  };

  /**
   * Serialises a filter spec for URL-safe storage.
   *
   * @param {object} filterSpec Filter specification to encode.
   * @returns {string} Percent-encoded JSON payload.
   */
  const serializeFilterSpec = (filterSpec) => {
    const compact = compactFilterSpec(filterSpec);
    return encodeURIComponent(JSON.stringify(compact));
  };

  /**
   * Parses a serialised filter spec from the URL hash.
   *
   * @param {string} value Encoded JSON payload.
   * @returns {object} Normalised filter specification, or an empty object on failure.
   */
  const parseFilterSpec = (value) => {
    if (!value) {
      return {};
    }
    try {
      const decoded = decodeURIComponent(value);
      const parsed = JSON.parse(decoded);
      return normalizeFilterSpec(parsed);
    } catch (error) {
      return {};
    }
  };

  /**
   * Collects distinct values from a row set using a selector and optional normaliser.
   *
   * @param {Array<object>} rows Source rows.
   * @param {(row: object) => unknown} selector Extracts one value or an array of values from each row.
   * @param {(value: unknown) => string} [normaliser] Optional value normaliser.
   * @returns {string[]} Distinct non-empty values.
   */
  const getUniqueValues = (rows, selector, normaliser) => {
    const list = Array.isArray(rows) ? rows : [];
    const set = new Set();
    list.forEach((row) => {
      const values = selector(row);
      if (!values) {
        return;
      }
      if (Array.isArray(values)) {
        values.forEach((value) => {
          const token = normaliser ? normaliser(value) : normaliseToken(value);
          if (token) {
            set.add(token);
          }
        });
        return;
      }
      const token = normaliser ? normaliser(values) : normaliseToken(values);
      if (token) {
        set.add(token);
      }
    });
    return Array.from(set);
  };

  window.RouteMapsterQueryEngine = {
    loadRouteSummary,
    applyFilters,
    computeDerivedFields,
    serializeFilterSpec,
    parseFilterSpec,
    normalizeFilterSpec,
    getUniqueValues
  };
})();

