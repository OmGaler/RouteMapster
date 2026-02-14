(() => {
  const ROUTE_SUMMARY_PATH = "/route_summary.csv";
  const KM_TO_MILES = 0.621371;
  let cachedRows = null;
  let loadPromise = null;

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
    if (["regular", "night", "school", "twentyfour", "unknown"].includes(token)) {
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
    const match = token.match(/^([A-Z]*)(\d+)([A-Z]*)$/);
    if (!match) {
      return null;
    }
    const num = Number(match[2]);
    if (!Number.isFinite(num)) {
      return null;
    }
    return { prefix: match[1] || "", number: num, suffix: match[3] || "" };
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

  const loadRouteSummary = async () => {
    if (cachedRows) {
      return cachedRows;
    }
    if (loadPromise) {
      return loadPromise;
    }
    loadPromise = fetch(ROUTE_SUMMARY_PATH, { cache: "no-store" })
      .then((response) => response.ok ? response.text() : "")
      .then((text) => {
        if (!text) {
          cachedRows = [];
          return cachedRows;
        }
        const parsed = parseCsv(text);
        const objects = toObjects(parsed);
        cachedRows = objects.map((row) => normaliseRow(row));
        return cachedRows;
      })
      .catch(() => {
        cachedRows = [];
        return cachedRows;
      })
      .finally(() => {
        loadPromise = null;
      });
    return loadPromise;
  };

  const average = (values) => {
    const nums = values.filter((value) => Number.isFinite(value));
    if (nums.length === 0) {
      return null;
    }
    return nums.reduce((sum, value) => sum + value, 0) / nums.length;
  };

  const computeDerivedFields = (rows) => {
    const list = Array.isArray(rows) ? rows : [];
    return list.map((row) => {
      const peakAvg = average([row.frequency_peak_am, row.frequency_peak_pm]);
      const offpeak = row.frequency_offpeak;
      const overnight = row.frequency_overnight;
      let weightedSum = 0;
      let weightTotal = 0;
      if (Number.isFinite(row.frequency_peak_am)) {
        weightedSum += row.frequency_peak_am * 0.4;
        weightTotal += 0.4;
      }
      if (Number.isFinite(row.frequency_peak_pm)) {
        weightedSum += row.frequency_peak_pm * 0.35;
        weightTotal += 0.35;
      }
      if (Number.isFinite(offpeak)) {
        weightedSum += offpeak * 0.2;
        weightTotal += 0.2;
      }
      if (Number.isFinite(overnight)) {
        weightedSum += overnight * 0.05;
        weightTotal += 0.05;
      }
      return {
        ...row,
        peakiness_index: Number.isFinite(peakAvg) && Number.isFinite(offpeak) ? peakAvg - offpeak : null,
        has_overnight: Number.isFinite(overnight) ? overnight > 0 : false
      };
    });
  };

  const normalizeFilterSpec = (filterSpec) => {
    const spec = filterSpec && typeof filterSpec === "object" ? filterSpec : {};
    const lengthSpec = spec.length_miles && typeof spec.length_miles === "object"
      ? spec.length_miles
      : spec.length_km && typeof spec.length_km === "object"
        ? spec.length_km
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
      length_rank: lengthRank,
      extreme
    };
    return normalised;
  };

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
      if (routeTypeSet && !routeTypeSet.has(String(row.route_type || "").toLowerCase())) {
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
      if (boroughMatchers) {
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
      if (spec.freq) {
        const bands = [
          { key: "peak_am", value: row.frequency_peak_am },
          { key: "peak_pm", value: row.frequency_peak_pm },
          { key: "offpeak", value: row.frequency_offpeak },
          { key: "weekend", value: row.frequency_weekend },
          { key: "overnight", value: row.frequency_overnight }
        ];
        for (const band of bands) {
          const range = spec.freq[band.key];
          if (!range) {
            continue;
          }
          const value = band.value;
          if (!Number.isFinite(value)) {
            return false;
          }
          if (range.min !== undefined && Number.isFinite(range.min) && value < range.min) {
            return false;
          }
          if (range.max !== undefined && Number.isFinite(range.max) && value > range.max) {
            return false;
          }
        }
      }
      if (spec.flags) {
        if (typeof spec.flags.has_overnight === "boolean") {
          const hasOvernight = Number.isFinite(row.frequency_overnight) ? row.frequency_overnight > 0 : false;
          if (spec.flags.has_overnight !== hasOvernight) {
            return false;
          }
        }
        if (Number.isFinite(spec.flags.high_frequency_any)) {
          const threshold = spec.flags.high_frequency_any;
          const values = [
            row.frequency_peak_am,
            row.frequency_peak_pm,
            row.frequency_offpeak,
            row.frequency_weekend,
            row.frequency_overnight
          ];
          const meets = values.some((value) => Number.isFinite(value) && value >= threshold);
          if (!meets) {
            return false;
          }
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
      return true;
    });
    if (spec.extreme) {
      const fieldByExtreme = {
        north: "northmost_lat",
        south: "southmost_lat",
        east: "eastmost_lon",
        west: "westmost_lon"
      };
      const field = fieldByExtreme[spec.extreme];
      const values = filtered
        .map((row) => row?.[field])
        .filter((value) => Number.isFinite(value));
      if (values.length === 0) {
        return [];
      }
      const target = (spec.extreme === "north" || spec.extreme === "east")
        ? Math.max(...values)
        : Math.min(...values);
      const epsilon = 1e-6;
      filtered = filtered.filter((row) => Number.isFinite(row?.[field]) && Math.abs(row[field] - target) <= epsilon);
    }
    if (spec.length_rank) {
      const direction = spec.length_rank.mode === "longest" ? "longest" : "shortest";
      const limit = Number.isFinite(spec.length_rank.count) ? Math.round(spec.length_rank.count) : 0;
      if (limit > 0) {
        const ranked = filtered
          .filter((row) => Number.isFinite(row.length_miles))
          .slice()
          .sort((a, b) => direction === "longest"
            ? b.length_miles - a.length_miles
            : a.length_miles - b.length_miles)
          .slice(0, limit);
        return ranked;
      }
      return [];
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
    if (spec.length_rank && typeof spec.length_rank === "object") {
      const mode = spec.length_rank.mode;
      const count = spec.length_rank.count;
      if ((mode === "shortest" || mode === "longest") && Number.isFinite(count)) {
        cleaned.length_rank = { mode, count };
      }
    }
    if (spec.extreme) {
      cleaned.extreme = spec.extreme;
    }
    return cleaned;
  };

  const serializeFilterSpec = (filterSpec) => {
    const compact = compactFilterSpec(filterSpec);
    return encodeURIComponent(JSON.stringify(compact));
  };

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

  const getUniqueValues = (rows, selector, normaliser) => {
    const list = Array.isArray(rows) ? rows : [];
    const set = new Set();
    list.forEach((row) => {
      const values = selector(row);
      if (!values) {
        return;
      }
      (Array.isArray(values) ? values : [values]).forEach((value) => {
        const token = normaliser ? normaliser(value) : normaliseToken(value);
        if (token) {
          set.add(token);
        }
      });
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

