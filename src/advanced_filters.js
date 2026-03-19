(() => {
  /**
   * Coordinates the advanced route filter UI, result panel, and map highlights.
   *
   * The module sits between the DOM, `RouteMapsterQueryEngine`, geographic
   * helpers, and the main application API. It is responsible for translating
   * user input into canonical filter specs and keeping the filtered route
   * subset in sync with map state.
   */
  const FILTER_HASH_KEY = "filters";
  const MAP_HIGHLIGHT_COLOUR = "#10b981";
  const MAP_HIGHLIGHT_WEIGHT = 4;
  const MAP_HIGHLIGHT_OPACITY = 0.9;
  const SHOW_ALL_CAP = Number.POSITIVE_INFINITY;
  const LIST_CAP = Number.POSITIVE_INFINITY;
  const SHOW_ALL_MAP_CONCURRENCY = 4;
  const BUS_STOPS_GEOJSON_PATH = "/data/processed/stops.geojson";
  const BOROUGHS_GEOJSON_PATH = "/data/boroughs.geojson";

  const utils = window.RouteMapsterUtils || {};
  const escapeHtml = utils.escapeHtml || ((value) => String(value || ""));
  const formatNumber = utils.formatNumber || ((value, digits = 1) => {
    if (!Number.isFinite(value)) {
      return "";
    }
    return digits === 0 ? String(Math.round(value)) : value.toFixed(digits);
  });
  const downloadCsv = utils.downloadCsv || (() => {});
  const normaliseBoroughToken = utils.normaliseBoroughToken || ((value) => String(value || "").trim().toLowerCase());
  const geo = window.RouteMapsterGeo || {};

  const isUnknown = (value) => {
    if (!value) {
      return false;
    }
    return String(value).trim().toLowerCase() === "unknown";
  };

  const cleanMetaValue = (value) => {
    if (!value || isUnknown(value)) {
      return "";
    }
    return value;
  };

  const getRouteDestinationSummaryText = (row) => {
    const api = window.RouteMapsterAPI;
    if (api && typeof api.getRouteDestinationSummaryText === "function") {
      return api.getRouteDestinationSummaryText(row);
    }
    const values = [
      String(row?.destination_outbound || "").trim(),
      String(row?.destination_inbound || "").trim()
    ].filter(Boolean);
    return Array.from(new Set(values)).join(" / ");
  };

  const isSchoolRoute = (value) => String(value || "").trim().toLowerCase() === "school";

  const parseTokens = (value) => {
    if (!value) {
      return [];
    }
    return String(value)
      .split(/[\s,]+/)
      .map((entry) => entry.trim())
      .filter(Boolean);
  };

  const getStopBoroughToken = (props) => {
    return normaliseBoroughToken(props?.borough || props?.BOROUGH || props?.Borough || props?.["Borough"]);
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

  const getSelectedValues = (select) => {
    if (!select) {
      return [];
    }
    return Array.from(select.selectedOptions).map((option) => option.value).filter(Boolean);
  };

  const parseNumberInput = (input) => {
    if (!input || input.value === "") {
      return null;
    }
    const num = Number(input.value);
    return Number.isFinite(num) ? num : null;
  };

  const parseSeriesInput = (input) => {
    const num = parseNumberInput(input);
    if (!Number.isFinite(num) || !Number.isInteger(num)) {
      return null;
    }
    if (num < 0 || num > 99) {
      return null;
    }
    return num;
  };

  const sortRouteIds = (ids) => {
    const api = window.RouteMapsterAPI;
    if (api && typeof api.sortRouteIds === "function") {
      return api.sortRouteIds(ids);
    }
    return ids.slice().sort();
  };

  const getRoutePillClass = (routeId, appState) => {
    const api = window.RouteMapsterAPI;
    if (api && typeof api.getRoutePillClass === "function") {
      return api.getRoutePillClass(routeId, appState?.networkRouteSets || null);
    }
    return "regular";
  };

  const renderRoutePill = (routeId, appState) => {
    const className = getRoutePillClass(routeId, appState);
    return `<span class="route-pill route-pill--${escapeHtml(className)}" data-route="${escapeHtml(routeId)}">${escapeHtml(routeId)}</span>`;
  };

  const buildPrefixOptions = (rows) => {
    const prefixes = new Set();
    rows.forEach((row) => {
      const id = String(row.route_id_norm || "");
      if (!id) {
        return;
      }
      if (id.startsWith("SL")) {
        prefixes.add("SL");
      }
      if (id.startsWith("N")) {
        prefixes.add("N");
      }
      const match = id.match(/^[A-Z]+/);
      if (match && match[0]) {
        prefixes.add(match[0]);
      }
    });
    const list = Array.from(prefixes).sort((a, b) => a.localeCompare(b));
    return list;
  };

  const setSelectOptions = (selectEl, options) => {
    if (!selectEl) {
      return selectEl;
    }
    const optionList = Array.isArray(options) ? options : [];
    const selected = new Set(
      Array.from(selectEl.selectedOptions || [])
        .map((option) => String(option?.value ?? ""))
        .filter(Boolean)
    );
    while (selectEl.options.length > 0) {
      selectEl.remove(0);
    }
    optionList.forEach((entry) => {
      const value = entry && entry.value !== undefined ? entry.value : "";
      const label = entry && entry.label !== undefined ? entry.label : value;
      const valueText = String(value ?? "");
      const option = new Option(String(label ?? ""), valueText, false, selected.has(valueText));
      selectEl.add(option);
    });
    return selectEl;
  };

  const isIosWebKit = () => {
    if (typeof navigator === "undefined") {
      return false;
    }
    const ua = String(navigator.userAgent || "");
    const platform = String(navigator.platform || "");
    const maxTouchPoints = Number(navigator.maxTouchPoints || 0);
    const isIOS = /iPad|iPhone|iPod/.test(ua) || (platform === "MacIntel" && maxTouchPoints > 1);
    return isIOS && /AppleWebKit/i.test(ua);
  };

  const shouldUseMobileMultiFallback = () => isIosWebKit();

  const getFallbackLabel = (selectEl) => {
    if (!selectEl || !state.container) {
      return "Options";
    }
    const label = state.container.querySelector(`label[for="${selectEl.id}"]`);
    return String(label?.textContent || "Options").trim() || "Options";
  };

  const updateMobileFallbackSummary = (entry, selectEl) => {
    if (!entry || !selectEl) {
      return;
    }
    const options = Array.from(selectEl.options || []);
    const totalCount = options.length;
    const selectedCount = options.filter((option) => option.selected).length;
    const label = getFallbackLabel(selectEl);
    if (totalCount === 0) {
      entry.summary.textContent = `${label} (0 options)`;
      return;
    }
    entry.summary.textContent = selectedCount > 0
      ? `${label} (${selectedCount}/${totalCount} selected)`
      : `${label} (${totalCount} options)`;
  };

  const ensureMobileMultiFallback = (selectEl) => {
    if (!selectEl || !selectEl.multiple || !selectEl.id) {
      return;
    }
    if (!shouldUseMobileMultiFallback()) {
      const existing = state.mobileMultiFallback.get(selectEl.id);
      if (existing?.host?.isConnected) {
        existing.host.remove();
      }
      if (state.container) {
        Array.from(state.container.querySelectorAll(".mobile-multi"))
          .filter((host) => host.dataset.for === selectEl.id)
          .forEach((host) => host.remove());
      }
      state.mobileMultiFallback.delete(selectEl.id);
      selectEl.style.display = "";
      selectEl.removeAttribute("aria-hidden");
      return;
    }
    let entry = state.mobileMultiFallback.get(selectEl.id);
    const parentField = selectEl.closest(".field");
    if (parentField) {
      Array.from(parentField.querySelectorAll(".mobile-multi"))
        .filter((host) => host !== entry?.host)
        .forEach((host) => host.remove());
    }
    if (state.container) {
      Array.from(state.container.querySelectorAll(".mobile-multi"))
        .filter((host) => host.dataset.for === selectEl.id && host !== entry?.host)
        .forEach((host) => host.remove());
    }
    if (entry?.host?.isConnected && entry.select !== selectEl) {
      entry.host.remove();
      state.mobileMultiFallback.delete(selectEl.id);
      entry = null;
    }
    if (!entry || !entry.host || !entry.host.isConnected || entry.select !== selectEl) {
      const host = document.createElement("details");
      host.className = "mobile-multi";
      host.dataset.for = selectEl.id;
      const summary = document.createElement("summary");
      summary.className = "mobile-multi-summary";
      const list = document.createElement("div");
      list.className = "mobile-multi-list";
      host.append(summary, list);
      selectEl.insertAdjacentElement("afterend", host);
      entry = { select: selectEl, host, summary, list };
      state.mobileMultiFallback.set(selectEl.id, entry);
    } else {
      entry.select = selectEl;
    }
    selectEl.style.display = "none";
    selectEl.setAttribute("aria-hidden", "true");
    entry.list.innerHTML = "";
    const options = Array.from(selectEl.options || []);
    if (options.length === 0) {
      const empty = document.createElement("div");
      empty.className = "mobile-multi-empty";
      empty.textContent = "No options available";
      entry.list.appendChild(empty);
      updateMobileFallbackSummary(entry, selectEl);
      return;
    }
    const selectedValues = new Set(
      options.filter((option) => option.selected).map((option) => String(option.value ?? ""))
    );
    options.forEach((option) => {
      const value = String(option.value ?? "");
      const item = document.createElement("label");
      item.className = "mobile-multi-item";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.value = value;
      checkbox.checked = selectedValues.has(value);
      checkbox.disabled = Boolean(selectEl.disabled);
      checkbox.addEventListener("change", () => {
        const target = Array.from(selectEl.options || []).find((candidate) => String(candidate.value ?? "") === value);
        if (target) {
          target.selected = checkbox.checked;
        }
        updateMobileFallbackSummary(entry, selectEl);
      });
      const text = document.createElement("span");
      text.textContent = option.textContent || option.label || value;
      item.append(checkbox, text);
      entry.list.appendChild(item);
    });
    updateMobileFallbackSummary(entry, selectEl);
  };

  const refreshMobileMultiFallbacks = (els) => {
    [
      els?.routeTypes,
      els?.operators,
      els?.garages,
      els?.boroughs,
      els?.vehicles
    ].forEach((selectEl) => ensureMobileMultiFallback(selectEl));
  };

  const buildGarageLabels = (row) => {
    const codes = Array.isArray(row?.garage_codes_arr) ? row.garage_codes_arr : [];
    const names = Array.isArray(row?.garage_names_arr) ? row.garage_names_arr : [];
    const max = Math.max(codes.length, names.length);
    const combined = [];
    const seen = new Set();
    for (let i = 0; i < max; i += 1) {
      const code = codes[i];
      const name = names[i];
      let label = "";
      if (name && code) {
        label = `${name} (${code})`;
      } else if (name) {
        label = name;
      } else if (code) {
        label = code;
      }
      if (label && !seen.has(label)) {
        seen.add(label);
        combined.push(label);
      }
    }
    return combined;
  };

  const buildGarageOptions = (rows) => {
    const codeToName = new Map();
    const nameOnly = new Set();
    rows.forEach((row) => {
      const codes = Array.isArray(row.garage_codes_arr) ? row.garage_codes_arr : [];
      const names = Array.isArray(row.garage_names_arr) ? row.garage_names_arr : [];
      if (codes.length > 0) {
        codes.forEach((code, index) => {
          const token = String(code || "").trim();
          if (!token) {
            return;
          }
          const name = String(names[index] || names[0] || "").trim();
          if (!codeToName.has(token)) {
            codeToName.set(token, name);
          }
        });
        return;
      }
      names.forEach((name) => {
        const token = String(name || "").trim();
        if (token) {
          nameOnly.add(token);
        }
      });
    });

    const knownNames = new Set(
      Array.from(codeToName.values())
        .filter((value) => value)
        .map((value) => String(value).trim().toLowerCase())
    );

    const options = [];
    codeToName.forEach((name, code) => {
      const label = name ? `${name} (${code})` : code;
      options.push({ value: code, label });
    });

    nameOnly.forEach((name) => {
      if (knownNames.has(String(name).trim().toLowerCase())) {
        return;
      }
      options.push({ value: name, label: name });
    });

    return options.sort((a, b) => a.label.localeCompare(b.label));
  };

  const loadBoroughsGeojson = async () => {
    const res = await fetch(BOROUGHS_GEOJSON_PATH);
    if (!res.ok) {
      return null;
    }
    return res.json();
  };

  const hydrateStopBoroughs = async (geojson) => {
    if (!geojson || !Array.isArray(geojson.features)) {
      return;
    }
    const needsBorough = geojson.features.some((feature) => {
      const props = feature?.properties || {};
      return !(props?.borough || props?.BOROUGH || props?.Borough || props?.["Borough"]);
    });
    if (!needsBorough) {
      return;
    }
    const boroughs = await loadBoroughsGeojson();
    if (!boroughs || !geo.buildBoroughIndex || !geo.findBoroughForPoint) {
      return;
    }
    const index = geo.buildBoroughIndex(boroughs);
    if (!index || index.length === 0) {
      return;
    }
    geojson.features.forEach((feature) => {
      const props = feature?.properties || {};
      const existing = props?.borough || props?.BOROUGH || props?.Borough || props?.["Borough"];
      if (existing) {
        return;
      }
      const coords = feature?.geometry?.coordinates;
      if (!Array.isArray(coords) || coords.length < 2) {
        return;
      }
      const lon = Number(coords[0]);
      const lat = Number(coords[1]);
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
        return;
      }
      const borough = geo.findBoroughForPoint(lon, lat, index);
      if (borough) {
        props.BOROUGH = borough;
        feature.properties = props;
      }
    });
  };

  const loadStopsGeojson = async () => {
    const api = window.RouteMapsterAPI;
    if (api?.appState?.busStopsGeojson) {
      return api.appState.busStopsGeojson;
    }
    const res = await fetch(BUS_STOPS_GEOJSON_PATH);
    if (!res.ok) {
      return null;
    }
    const data = await res.json();
    await hydrateStopBoroughs(data).catch(() => {});
    if (api?.appState && data) {
      api.appState.busStopsGeojson = data;
    }
    return data;
  };

  /**
   * Derives route-to-borough coverage from the stop dataset.
   *
   * @param {GeoJSON.FeatureCollection|object|null} geojson Stop GeoJSON with borough-enriched properties.
   * @returns {{routeBoroughs: Map<string, Set<string>>, boroughLookup: Map<string, string>}} Borough tokens keyed by route.
   */
  const buildRouteBoroughIndex = (geojson) => {
    const routeBoroughs = new Map();
    const boroughLookup = new Map();
    const features = Array.isArray(geojson?.features) ? geojson.features : [];
    features.forEach((feature) => {
      const props = feature?.properties || {};
      const rawBorough = props?.borough || props?.BOROUGH || props?.Borough || props?.["Borough"];
      if (!rawBorough) {
        return;
      }
      const display = String(rawBorough).trim();
      if (!display) {
        return;
      }
      const boroughToken = normaliseBoroughToken(display);
      if (!boroughToken) {
        return;
      }
      const routes = extractRouteTokens(props?.ROUTES || props?.Routes || props?.routes);
      if (routes.length === 0) {
        return;
      }
      if (!boroughLookup.has(boroughToken)) {
        boroughLookup.set(boroughToken, display);
      }
      routes.forEach((routeId) => {
        if (!routeId) {
          return;
        }
        const key = String(routeId).trim().toUpperCase();
        if (!key || isExcludedRoute(key)) {
          return;
        }
        let set = routeBoroughs.get(key);
        if (!set) {
          set = new Set();
          routeBoroughs.set(key, set);
        }
        set.add(boroughToken);
      });
    });
    return { routeBoroughs, boroughLookup };
  };

  const state = {
    rows: [],
    derivedRows: [],
    filteredRows: [],
    filterSpec: {},
    rowLookup: new Map(),
    mapLayerGroup: null,
    routeLayers: new Map(),
    visibleRoutes: new Set(),
    elements: null,
    container: null,
    initPromise: null,
    moduleOpen: false,
    spatialReady: false,
    spatialPromise: null,
    boroughOptions: [],
    boroughsReady: false,
    boroughIndex: null,
    geometryBoroughCache: new Map(),
    mobileMultiFallback: new Map(),
    resultsDismissed: false
  };

  const loadBoroughIndex = async () => {
    if (state.boroughIndex) {
      return state.boroughIndex;
    }
    const boroughs = await loadBoroughsGeojson();
    if (!boroughs || !geo.buildBoroughIndex) {
      return null;
    }
    const index = geo.buildBoroughIndex(boroughs);
    state.boroughIndex = index && index.length > 0 ? index : null;
    return state.boroughIndex;
  };

  const ensureLayerGroup = (appState) => {
    if (!appState || !appState.map) {
      return null;
    }
    if (!appState.filteredRoutesLayer) {
      appState.filteredRoutesLayer = L.layerGroup().addTo(appState.map);
    }
    return appState.filteredRoutesLayer;
  };

  const clearLayerGroup = (appState) => {
    if (appState?.filteredRoutesLayer) {
      appState.filteredRoutesLayer.clearLayers();
    }
  };

  const buildRoutePopupHtml = (row) => {
    const routeId = row.route_id_norm || row.route_id || "";
    const operator = cleanMetaValue(row.operator_names_arr?.[0] || "");
    const garageLabels = buildGarageLabels(row);
    const garage = cleanMetaValue(garageLabels[0] || "");
    const routeType = cleanMetaValue(row.route_type || "");
    const meta = [routeType, operator, garage].filter(Boolean).join(" · ");
    return `
      <div class="hover-popup__content">
        <div class="hover-popup__title">Route ${escapeHtml(routeId)}</div>
        <div class="hover-popup__meta">${escapeHtml(meta)}</div>
        <button type="button" class="route-zoom-btn" data-route="${escapeHtml(routeId)}">Zoom to</button>
      </div>
    `;
  };

  const showRouteOnMap = async (appState, routeId) => {
    if (!routeId || state.visibleRoutes.has(routeId)) {
      return;
    }
    const api = window.RouteMapsterAPI;
    if (!api || typeof api.loadRouteGeometry !== "function") {
      return;
    }
    const row = state.rowLookup.get(routeId) || {};
    state.visibleRoutes.add(routeId);
    const layerGroup = ensureLayerGroup(appState);
    if (!layerGroup) {
      state.visibleRoutes.delete(routeId);
      return;
    }
    const segments = await api.loadRouteGeometry(routeId);
    if (!state.visibleRoutes.has(routeId)) {
      return;
    }
    if (!segments || segments.length === 0) {
      state.visibleRoutes.delete(routeId);
      return;
    }
    const lines = [];
    segments.forEach((segment) => {
      const line = L.polyline(segment, {
        color: MAP_HIGHLIGHT_COLOUR,
        weight: MAP_HIGHLIGHT_WEIGHT,
        opacity: MAP_HIGHLIGHT_OPACITY,
        pane: "routes-pane"
      });
      line.bindPopup(buildRoutePopupHtml(row), { className: "hover-popup" });
      line.on("click", () => {
        line.openPopup();
      });
      line.addTo(layerGroup);
      lines.push(line);
    });
    state.routeLayers.set(routeId, { group: layerGroup, lines });
  };

  const hideRouteOnMap = (appState, routeId) => {
    if (!routeId || !state.visibleRoutes.has(routeId)) {
      return;
    }
    const entry = state.routeLayers.get(routeId);
    if (entry && entry.lines) {
      entry.lines.forEach((line) => {
        if (appState?.filteredRoutesLayer) {
          appState.filteredRoutesLayer.removeLayer(line);
        }
      });
    }
    state.routeLayers.delete(routeId);
    state.visibleRoutes.delete(routeId);
  };

  const clearMapHighlights = (appState) => {
    state.visibleRoutes.forEach((routeId) => hideRouteOnMap(appState, routeId));
    state.visibleRoutes.clear();
    state.routeLayers.clear();
    clearLayerGroup(appState);
    if (state.elements) {
      renderRouteList(state.filteredRows, state.elements);
    }
  };

  /**
   * Draws every currently filtered route on the map, subject to safety caps.
   *
   * @param {object} els Cached DOM elements for the module.
   * @param {object} appState Shared application state from `app.js`.
   * @returns {Promise<void>}
   * Side effects: Loads route geometries, mutates visible map layers, and updates warning text.
   */
  const showAllFilteredRoutes = async (els, appState) => {
    if (!els || !appState) {
      return;
    }
    if (els.mapWarning) {
      els.mapWarning.textContent = "";
    }
    const list = state.filteredRows
      .map((row) => row.route_id_norm)
      .filter((routeId) => routeId);
    const sorted = sortRouteIds(list);
    if (Number.isFinite(SHOW_ALL_CAP) && sorted.length > SHOW_ALL_CAP) {
      if (els.mapWarning) {
        els.mapWarning.textContent = `Showing first ${SHOW_ALL_CAP} of ${sorted.length} routes. Refine filters for more.`;
      }
    }
    const toShow = Number.isFinite(SHOW_ALL_CAP) ? sorted.slice(0, SHOW_ALL_CAP) : sorted.slice();
    if (toShow.length > 0) {
      let index = 0;
      const concurrency = Math.max(1, Math.min(SHOW_ALL_MAP_CONCURRENCY, toShow.length));
      // Batching geometry fetches keeps the UI responsive without serialising
      // every route draw when the filtered subset is large.
      const worker = async () => {
        while (index < toShow.length) {
          const routeId = toShow[index];
          index += 1;
          await showRouteOnMap(appState, routeId);
        }
      };
      await Promise.all(Array.from({ length: concurrency }, () => worker()));
    }
    renderRouteList(state.filteredRows, els);
  };

  const loadSpatialStatsForRows = async (rows) => {
    const api = window.RouteMapsterAPI;
    if (!api || typeof api.loadRouteSpatialStats !== "function") {
      return;
    }
    const rowById = new Map();
    rows.forEach((row) => {
      const routeId = row.route_id_norm || row.route_id;
      if (routeId) {
        rowById.set(routeId, row);
      }
    });

    const pending = Array.from(rowById.keys()).filter((routeId) => {
      const row = rowById.get(routeId);
      return !Number.isFinite(row?.northmost_lat)
        || !Number.isFinite(row?.southmost_lat)
        || !Number.isFinite(row?.eastmost_lon)
        || !Number.isFinite(row?.westmost_lon);
    });

    if (pending.length === 0) {
      return;
    }

    if (typeof api.setLoadingModalVisible === "function") {
      api.setLoadingModalVisible(true);
    }

    const concurrency = 6;
    let index = 0;
    const worker = async () => {
      while (index < pending.length) {
        const routeId = pending[index];
        index += 1;
        const stats = await api.loadRouteSpatialStats(routeId);
        if (stats) {
          const row = rowById.get(routeId);
          if (row) {
            Object.assign(row, stats);
          }
        }
      }
    };

    try {
      await Promise.all(Array.from({ length: concurrency }, () => worker()));
    } finally {
      if (typeof api.setLoadingModalVisible === "function") {
        api.setLoadingModalVisible(false);
      }
    }
  };

  const computeRouteGeometryCoverage = async (routeId, boroughIndex) => {
    if (!routeId) {
      return null;
    }
    if (state.geometryBoroughCache.has(routeId)) {
      return state.geometryBoroughCache.get(routeId);
    }
    const api = window.RouteMapsterAPI;
    if (!api || typeof api.loadRouteGeometry !== "function" || !geo.findBoroughForPoint) {
      state.geometryBoroughCache.set(routeId, null);
      return null;
    }
    const segments = await api.loadRouteGeometry(routeId);
    if (!Array.isArray(segments) || segments.length === 0) {
      state.geometryBoroughCache.set(routeId, null);
      return null;
    }
    const tokens = new Set();
    let hasOutside = false;
    segments.forEach((segment) => {
      if (!Array.isArray(segment)) {
        return;
      }
      segment.forEach((point) => {
        if (!Array.isArray(point) || point.length < 2) {
          return;
        }
        const lat = Number(point[0]);
        const lon = Number(point[1]);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
          return;
        }
        const borough = geo.findBoroughForPoint(lon, lat, boroughIndex || []);
        if (borough) {
          const token = normaliseBoroughToken(borough);
          if (token) {
            tokens.add(token);
          }
        } else {
          hasOutside = true;
        }
      });
    });
    const coverage = {
      tokens: Array.from(tokens),
      hasOutside
    };
    state.geometryBoroughCache.set(routeId, coverage);
    return coverage;
  };

  const listRoutesWhollyWithinBoroughs = async (rows) => {
    const boroughIndex = await loadBoroughIndex();
    if (!boroughIndex || boroughIndex.length === 0) {
      return null;
    }
    const api = window.RouteMapsterAPI;
    if (!api || typeof api.loadRouteGeometry !== "function") {
      return null;
    }
    const boroughLabels = new Map();
    boroughIndex.forEach((entry) => {
      const label = String(entry?.name || "").trim();
      const token = normaliseBoroughToken(label);
      if (token && label && !boroughLabels.has(token)) {
        boroughLabels.set(token, label);
      }
    });
    if (typeof api.setLoadingModalVisible === "function") {
      api.setLoadingModalVisible(true);
    }
    const routeRows = (Array.isArray(rows) ? rows : [])
      .map((row) => ({
        row,
        routeId: String(row?.route_id_norm || row?.route_id || "").trim().toUpperCase()
      }))
      .filter((entry) => entry.routeId);
    const matches = [];
    const concurrency = 6;
    let index = 0;
    const worker = async () => {
      while (index < routeRows.length) {
        const entry = routeRows[index];
        index += 1;
        const coverage = await computeRouteGeometryCoverage(entry.routeId, boroughIndex);
        if (!coverage || coverage.hasOutside) {
          continue;
        }
        const tokens = Array.isArray(coverage.tokens)
          ? coverage.tokens.map((token) => String(token || "").trim().toLowerCase()).filter(Boolean)
          : [];
        if (tokens.length === 0) {
          continue;
        }
        matches.push({
          row: entry.row,
          routeId: entry.routeId,
          boroughTokens: tokens,
          boroughLabels: tokens.map((token) => boroughLabels.get(token) || token)
        });
      }
    };
    try {
      await Promise.all(Array.from({ length: concurrency }, () => worker()));
    } finally {
      if (typeof api.setLoadingModalVisible === "function") {
        api.setLoadingModalVisible(false);
      }
    }
    return matches;
  };

  const computeRoutesWhollyWithin = async (rows, boroughSet) => {
    if (!boroughSet || boroughSet.size === 0) {
      return null;
    }
    const matches = await listRoutesWhollyWithinBoroughs(rows);
    if (!Array.isArray(matches)) {
      return null;
    }
    const allowed = new Set();
    matches.forEach((match) => {
      const tokens = Array.isArray(match?.boroughTokens) ? match.boroughTokens : [];
      if (tokens.length > 0 && tokens.every((token) => boroughSet.has(String(token).toLowerCase()))) {
        allowed.add(match.routeId);
      }
    });
    return allowed;
  };

  const ensureSpatialMetrics = async (els, appState) => {
    if (state.spatialReady) {
      return;
    }
    if (state.spatialPromise) {
      return state.spatialPromise;
    }
    state.spatialPromise = loadSpatialStatsForRows(state.rows)
      .then(() => {
        state.spatialReady = true;
        const engine = window.RouteMapsterQueryEngine;
        if (engine) {
          state.derivedRows = engine.computeDerivedFields(state.rows);
        }
      })
      .finally(() => {
        state.spatialPromise = null;
      });
    return state.spatialPromise;
  };

  const ensureRowsLoaded = async (engine) => {
    if (Array.isArray(state.rows) && state.rows.length > 0) {
      return;
    }
    const loaded = await engine.loadRouteSummary();
    if (!Array.isArray(loaded) || loaded.length === 0) {
      state.rows = [];
      state.derivedRows = [];
      return;
    }
    state.rows = loaded;
    await hydrateRouteBoroughs().catch(() => {});
    state.derivedRows = engine.computeDerivedFields(state.rows);
  };

  const hydrateRouteBoroughs = async () => {
    state.boroughOptions = [];
    state.boroughsReady = false;
    const geojson = await loadStopsGeojson();
    if (!geojson || !Array.isArray(geojson.features)) {
      return;
    }
    const { routeBoroughs, boroughLookup } = buildRouteBoroughIndex(geojson);
    if (!boroughLookup || boroughLookup.size === 0) {
      return;
    }
    state.boroughOptions = Array.from(boroughLookup.entries())
      .map(([value, label]) => ({ value, label }))
      .sort((a, b) => a.label.localeCompare(b.label));
    state.boroughsReady = state.boroughOptions.length > 0;
    state.rows.forEach((row) => {
      const routeId = row.route_id_norm;
      if (!routeId) {
        row.boroughs_norm = [];
        return;
      }
      const set = routeBoroughs.get(routeId);
      row.boroughs_norm = set ? Array.from(set) : [];
    });
  };

  const buildFilterSpecFromUI = (els) => {
    const routeIds = parseTokens(els.routeSearch?.value || "");
    let prefixValue = "";
    if (els.routePrefix?.value && els.routePrefix.value !== "any") {
      prefixValue = els.routePrefix.value;
    }
    const seriesValue = parseSeriesInput(els.routeSeries);
    const includePrefixRoutes = Boolean(els.seriesIncludePrefixes?.checked);

    const freq = {};
    const band = String(els.frequencyBand?.value || "peak_am");
    const bandMin = parseNumberInput(els.frequencyMin);
    const bandMax = parseNumberInput(els.frequencyMax);
    if (bandMin !== null || bandMax !== null) {
      freq[band] = { min: bandMin ?? undefined, max: bandMax ?? undefined };
    }

    const flags = {};
    if (els.hasOvernight?.checked) {
      flags.has_overnight = true;
    }
    const uniqueStopsMinRaw = parseNumberInput(els.uniqueStopsMin);
    const uniqueStopsMaxRaw = parseNumberInput(els.uniqueStopsMax);
    const uniqueStopsMin = Number.isFinite(uniqueStopsMinRaw) ? Math.round(uniqueStopsMinRaw) : null;
    const uniqueStopsMax = Number.isFinite(uniqueStopsMaxRaw) ? Math.round(uniqueStopsMaxRaw) : null;
    const uniqueStops = uniqueStopsMin !== null || uniqueStopsMax !== null
      ? { min: uniqueStopsMin ?? undefined, max: uniqueStopsMax ?? undefined }
      : undefined;
    const uniqueStopsRankMode = String(els.uniqueStopsRankMode?.value || "").trim().toLowerCase();
    const uniqueStopsRankCountRaw = parseNumberInput(els.uniqueStopsRankCount);
    const uniqueStopsRankCount = Number.isFinite(uniqueStopsRankCountRaw) ? Math.round(uniqueStopsRankCountRaw) : null;
    const uniqueStopsRank = (uniqueStopsRankMode === "least" || uniqueStopsRankMode === "most") && uniqueStopsRankCount !== null
      && uniqueStopsRankCount >= 1 && uniqueStopsRankCount <= 25
      ? { mode: uniqueStopsRankMode, count: uniqueStopsRankCount }
      : undefined;
    const lengthMin = parseNumberInput(els.lengthMin);
    const lengthMax = parseNumberInput(els.lengthMax);
    const length = lengthMin !== null || lengthMax !== null
      ? { min: lengthMin ?? undefined, max: lengthMax ?? undefined }
      : undefined;
    const lengthRankMode = String(els.lengthRankMode?.value || "").trim().toLowerCase();
    const lengthRankCountRaw = parseNumberInput(els.lengthRankCount);
    const lengthRankCount = Number.isFinite(lengthRankCountRaw) ? Math.round(lengthRankCountRaw) : null;
    const lengthRank = (lengthRankMode === "shortest" || lengthRankMode === "longest") && lengthRankCount !== null
      && lengthRankCount >= 1 && lengthRankCount <= 25
      ? { mode: lengthRankMode, count: lengthRankCount }
      : undefined;

    const extreme = String(els.extremeSelect?.value || "").trim().toLowerCase();
    const boroughs = state.boroughsReady ? getSelectedValues(els.boroughs) : [];
    const boroughModeRaw = String(els.boroughMode?.value || "enter").trim().toLowerCase();
    const boroughMode = boroughModeRaw === "within" ? "within" : "enter";

    return {
      route_ids: routeIds.length > 0 ? routeIds : undefined,
      route_prefix: prefixValue ? prefixValue.toUpperCase() : undefined,
      route_series: seriesValue !== null ? seriesValue : undefined,
      include_prefix_routes: seriesValue !== null ? includePrefixRoutes : undefined,
      route_types: getSelectedValues(els.routeTypes),
      operators: getSelectedValues(els.operators),
      garages: getSelectedValues(els.garages),
      boroughs: boroughs.length > 0 ? boroughs : undefined,
      borough_mode: boroughs.length > 0 ? boroughMode : undefined,
      vehicle_types: getSelectedValues(els.vehicles),
      freq: Object.keys(freq).length > 0 ? freq : undefined,
      flags: Object.keys(flags).length > 0 ? flags : undefined,
      unique_stops: uniqueStops,
      unique_stops_rank: uniqueStopsRank,
      length_miles: length,
      length_rank: lengthRank,
      extreme: extreme || undefined
    };
  };

  const applyFilterSpecToUI = (spec, els) => {
    const normalized = window.RouteMapsterQueryEngine.normalizeFilterSpec(spec || {});
    if (els.routeSearch) {
      els.routeSearch.value = (normalized.route_ids || []).join(" ");
    }
    if (els.routePrefix) {
      const prefix = normalized.route_prefix || "";
      if (prefix && Array.from(els.routePrefix.options).some((option) => option.value === prefix)) {
        els.routePrefix.value = prefix;
      } else {
        els.routePrefix.value = "any";
      }
    }
    if (els.routeSeries) {
      els.routeSeries.value = Number.isFinite(normalized.route_series) ? normalized.route_series : "";
    }
    if (els.seriesIncludePrefixes) {
      els.seriesIncludePrefixes.checked = normalized.include_prefix_routes === true;
    }

    const setMulti = (select, values, normalizer) => {
      if (!select) {
        return;
      }
      const normalize = typeof normalizer === "function"
        ? normalizer
        : (value) => String(value ?? "").trim();
      const set = new Set((values || []).map((value) => normalize(value)).filter(Boolean));
      Array.from(select.options).forEach((option) => {
        const exactValue = String(option.value ?? "").trim();
        const normalizedValue = normalize(option.value);
        option.selected = set.has(exactValue) || set.has(normalizedValue);
      });
    };

    setMulti(els.routeTypes, normalized.route_types || []);
    setMulti(els.operators, normalized.operators || [], (value) => String(value ?? "").trim().toLowerCase());
    setMulti(els.garages, normalized.garages || [], (value) => String(value ?? "").trim().toLowerCase());
    if (state.boroughsReady) {
      setMulti(els.boroughs, normalized.boroughs || [], (value) => String(value ?? "").trim().toLowerCase());
    } else {
      setMulti(els.boroughs, []);
    }
    if (els.boroughMode) {
      const mode = normalized.borough_mode || "enter";
      if (Array.from(els.boroughMode.options).some((option) => option.value === mode)) {
        els.boroughMode.value = mode;
      } else {
        els.boroughMode.value = "enter";
      }
      els.boroughMode.disabled = !state.boroughsReady;
    }
    setMulti(els.vehicles, normalized.vehicle_types || []);

    const setRange = (range, minEl, maxEl) => {
      if (minEl) {
        minEl.value = Number.isFinite(range?.min) ? range.min : "";
      }
      if (maxEl) {
        maxEl.value = Number.isFinite(range?.max) ? range.max : "";
      }
    };

    const freqBands = ["peak_am", "peak_pm", "offpeak", "weekend", "overnight"];
    let activeBand = "peak_am";
    let activeRange = null;
    for (const band of freqBands) {
      const range = normalized.freq?.[band];
      if (range && (Number.isFinite(range.min) || Number.isFinite(range.max))) {
        activeBand = band;
        activeRange = range;
        break;
      }
    }

    if (els.frequencyBand) {
      els.frequencyBand.value = activeBand;
    }
    setRange(activeRange, els.frequencyMin, els.frequencyMax);

    if (els.hasOvernight) {
      els.hasOvernight.checked = normalized.flags?.has_overnight === true;
    }
    if (els.uniqueStopsMin) {
      els.uniqueStopsMin.value = Number.isFinite(normalized.unique_stops?.min) ? normalized.unique_stops.min : "";
    }
    if (els.uniqueStopsMax) {
      els.uniqueStopsMax.value = Number.isFinite(normalized.unique_stops?.max) ? normalized.unique_stops.max : "";
    }
    if (els.uniqueStopsRankMode) {
      els.uniqueStopsRankMode.value = normalized.unique_stops_rank?.mode || "";
    }
    if (els.uniqueStopsRankCount) {
      els.uniqueStopsRankCount.value = Number.isFinite(normalized.unique_stops_rank?.count) ? normalized.unique_stops_rank.count : "";
    }
    if (els.lengthMin) {
      els.lengthMin.value = Number.isFinite(normalized.length_miles?.min) ? normalized.length_miles.min : "";
    }
    if (els.lengthMax) {
      els.lengthMax.value = Number.isFinite(normalized.length_miles?.max) ? normalized.length_miles.max : "";
    }
    if (els.lengthRankMode) {
      els.lengthRankMode.value = normalized.length_rank?.mode || "";
    }
    if (els.lengthRankCount) {
      els.lengthRankCount.value = Number.isFinite(normalized.length_rank?.count) ? normalized.length_rank.count : "";
    }
    if (els.extremeSelect) {
      els.extremeSelect.value = normalized.extreme || "";
    }
    refreshMobileMultiFallbacks(els);
  };

  const clearFilterHash = () => {
    const hash = window.location.hash.replace(/^#/, "");
    if (!hash || !hash.includes(FILTER_HASH_KEY)) {
      return;
    }
    const params = new URLSearchParams(hash);
    if (!params.has(FILTER_HASH_KEY)) {
      return;
    }
    params.delete(FILTER_HASH_KEY);
    const nextHash = params.toString();
    if (nextHash === hash) {
      return;
    }
    if (nextHash) {
      history.replaceState(null, "", `#${nextHash}`);
    } else {
      history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
    }
  };

  const getHashSpec = () => {
    clearFilterHash();
    return {};
  };

  const hasActiveFilters = (spec) => {
    const normalized = window.RouteMapsterQueryEngine.normalizeFilterSpec(spec || {});
    const hasList = (value) => Array.isArray(value) && value.length > 0;
    if (hasList(normalized.route_ids)) {
      return true;
    }
    if (normalized.route_prefix) {
      return true;
    }
    if (Number.isFinite(normalized.route_series)) {
      return true;
    }
    if (hasList(normalized.route_types) || hasList(normalized.operators) || hasList(normalized.garages) || hasList(normalized.boroughs) || hasList(normalized.vehicle_types)) {
      return true;
    }
    if (normalized.freq) {
      const bands = ["peak_am", "peak_pm", "offpeak", "weekend", "overnight"];
      for (const band of bands) {
        const range = normalized.freq[band];
        if (range && (Number.isFinite(range.min) || Number.isFinite(range.max))) {
          return true;
        }
      }
    }
    if (normalized.flags) {
      if (typeof normalized.flags.has_overnight === "boolean") {
        return true;
      }
      if (Number.isFinite(normalized.flags.peaky?.min_delta)) {
        return true;
      }
    }
    if (normalized.length_miles && (Number.isFinite(normalized.length_miles.min) || Number.isFinite(normalized.length_miles.max))) {
      return true;
    }
    if (normalized.unique_stops && (Number.isFinite(normalized.unique_stops.min) || Number.isFinite(normalized.unique_stops.max))) {
      return true;
    }
    if (normalized.length_rank && Number.isFinite(normalized.length_rank.count)) {
      return true;
    }
    if (normalized.unique_stops_rank && Number.isFinite(normalized.unique_stops_rank.count)) {
      return true;
    }
    if (normalized.extreme) {
      return true;
    }
    return false;
  };

  const hasSpatialFilters = (spec) => {
    const normalized = window.RouteMapsterQueryEngine.normalizeFilterSpec(spec || {});
    return Boolean(normalized.extreme);
  };

  const updateResultsVisibility = (els, isActive, isOpen) => {
    const panel = els?.resultsPanel;
    const appRoot = document.getElementById("app");
    const shouldShow = Boolean(panel && isActive && isOpen && !state.resultsDismissed);
    if (panel) {
      panel.classList.toggle("is-visible", shouldShow);
    }
    if (appRoot) {
      appRoot.classList.toggle("has-advanced-results", shouldShow);
    }
  };

  /**
   * Hides the results panel and optionally clears map highlights.
   *
   * @param {{restoreMap?: boolean}} [options={}] Whether to remove map highlights and reset route-return state.
   * @returns {void}
   * Side effects: Mutates module state, DOM visibility, map overlays, and dispatches `routeFiltersUpdated`.
   */
  const dismissResults = (options = {}) => {
    const restoreMap = options && options.restoreMap === true;
    state.resultsDismissed = true;
    const appState = state.elements?.appState || null;
    if (appState && restoreMap) {
      clearMapHighlights(appState);
      appState.advancedResultsRouteReturnPending = false;
      document.dispatchEvent(new CustomEvent("routeFiltersUpdated", { detail: { rows: [], filterSpec: {} } }));
    }
    if (state.elements) {
      updateResultsVisibility(state.elements, hasActiveFilters(state.filterSpec), state.moduleOpen);
    }
  };

  /**
   * Re-opens the results panel after a previous dismissal.
   *
   * @returns {void}
   * Side effects: Updates module state and DOM visibility.
   */
  const showResults = () => {
    state.resultsDismissed = false;
    if (state.elements) {
      updateResultsVisibility(state.elements, hasActiveFilters(state.filterSpec), state.moduleOpen);
    }
  };

  const updateHash = () => {
    clearFilterHash();
  };

  const renderRouteList = (rows, els) => {
    if (!els.routeList) {
      return;
    }
    if (!rows || rows.length === 0) {
      const hasFilters = hasActiveFilters(state.filterSpec);
      els.routeList.innerHTML = hasFilters
        ? '<div class="info-empty">No routes matched.</div>'
        : '<div class="info-empty">No filters applied yet.</div>';
      return;
    }
    const list = Number.isFinite(LIST_CAP) ? rows.slice(0, LIST_CAP) : rows.slice();
    const html = list.map((row) => {
      const routeId = row.route_id_norm || row.route_id;
      const operator = cleanMetaValue(row.operator_names_arr?.[0] || "");
      const garage = cleanMetaValue(row.garage_codes_arr?.[0] || row.garage_names_arr?.[0] || "");
      const routeType = cleanMetaValue(row.route_type || "");
      const vehicle = row.vehicle_type || "";
      const peakAm = formatNumber(row.frequency_peak_am);
      const peakPm = formatNumber(row.frequency_peak_pm);
      const offpeak = formatNumber(row.frequency_offpeak);
      const weekend = formatNumber(row.frequency_weekend);
      const overnight = formatNumber(row.frequency_overnight);
      const showFrequencies = !isSchoolRoute(row.route_type);
      const hasOvernight = row.has_overnight ? "Yes" : "No";
      const uniqueStops = Number.isFinite(row.unique_stops) ? formatNumber(row.unique_stops, 0) : "";
      const totalStops = Number.isFinite(row.total_stops) ? formatNumber(row.total_stops, 0) : "";
      const uniqueStopsPct = Number.isFinite(row.unique_stops_pct) ? formatNumber(row.unique_stops_pct * 100, 0) : "";
      const lengthMiles = Number.isFinite(row.length_miles) ? formatNumber(row.length_miles, 2) : "";
      const destinationSummary = getRouteDestinationSummaryText(row);
      const isVisible = state.visibleRoutes.has(routeId);
      const metaParts = [routeType, operator, garage, cleanMetaValue(vehicle)]
        .filter(Boolean)
        .join(" · ");
      const uniqueStopsText = uniqueStops
        ? `${uniqueStops} route-only${totalStops ? ` / ${totalStops} total${uniqueStopsPct ? ` (${uniqueStopsPct}%)` : ""}` : ""}`
        : "–";
      const lengthText = lengthMiles ? `${lengthMiles} mi` : "–";
      return `
        <div class="route-card" data-route="${escapeHtml(routeId)}">
          <div class="route-card__header">
            <div class="route-card__title">${renderRoutePill(routeId, els.appState)}</div>
            <button type="button" class="ghost-button tiny route-map-toggle" data-route="${escapeHtml(routeId)}">
              ${isVisible ? "Hide" : "Show"}
            </button>
          </div>
          <div class="route-card__meta">${escapeHtml(metaParts)}</div>
          ${destinationSummary ? `<div class="route-card__meta">Destinations: ${escapeHtml(destinationSummary)}</div>` : ""}
          ${showFrequencies ? `<div class="route-card__freq">Frequency (BPH): Peak AM: ${peakAm || "–"} · Peak PM: ${peakPm || "–"} · Offpeak: ${offpeak || "–"} · Weekend: ${weekend || "–"} · Overnight: ${overnight || "–"}</div>` : ""}
          <div class="route-card__kpi">Unique stops: ${uniqueStopsText} · Length: ${lengthText} · Overnight: ${hasOvernight}</div>
        </div>
      `;
    }).join("");
    const more = Number.isFinite(LIST_CAP) && rows.length > LIST_CAP
      ? `<div class="module-note">Showing ${LIST_CAP} of ${rows.length} routes. Refine filters for full list.</div>`
      : "";
    els.routeList.innerHTML = html + more;
  };

  const updateResultCount = (count, els) => {
    if (!els.routeCount) {
      return;
    }
    els.routeCount.textContent = `${count} routes found`;
  };

  const refreshRouteLookup = (rows) => {
    state.rowLookup = new Map();
    rows.forEach((row) => {
      if (row.route_id_norm) {
        state.rowLookup.set(row.route_id_norm, row);
      }
    });
  };

  const syncVisibleRoutes = (appState, rows) => {
    const allowed = new Set(rows.map((row) => row.route_id_norm));
    Array.from(state.visibleRoutes).forEach((routeId) => {
      if (!allowed.has(routeId)) {
        hideRouteOnMap(appState, routeId);
      }
    });
  };

  /**
   * Applies a filter specification to the loaded route dataset and refreshes the UI.
   *
   * @param {object} appState Shared application state from `app.js`.
   * @param {object} els Cached DOM elements for the module.
   * @param {{filterSpec?: object, applySpec?: object, baseRows?: Array<object>}} [options={}] Optional precomputed filter inputs.
   * @returns {void}
   * Side effects: Mutates module state, redraws the results list, updates map layers, and dispatches `routeFiltersUpdated`.
   */
  const applyFilters = (appState, els, options = {}) => {
    const filterSpec = options.filterSpec || buildFilterSpecFromUI(els);
    const normalizedSpec = window.RouteMapsterQueryEngine.normalizeFilterSpec(filterSpec);
    const applySpec = options.applySpec
      ? window.RouteMapsterQueryEngine.normalizeFilterSpec(options.applySpec)
      : normalizedSpec;
    const baseRows = Array.isArray(options.baseRows) ? options.baseRows : state.rows;
    const isActive = hasActiveFilters(normalizedSpec);
    if (!isActive) {
      state.resultsDismissed = false;
      state.filteredRows = [];
      state.filterSpec = {};
      refreshRouteLookup([]);
      updateResultCount(0, els);
      renderRouteList([], els);
      syncVisibleRoutes(appState, []);
      updateHash({});
      updateResultsVisibility(els, false, state.moduleOpen);
      if (appState) {
        appState.advancedFiltersState = {
          rows: [],
          filterSpec: {}
        };
      }
      document.dispatchEvent(new CustomEvent("routeFiltersUpdated", { detail: { rows: [], filterSpec: {} } }));
      return;
    }
    const filtered = window.RouteMapsterQueryEngine.applyFilters(baseRows, applySpec);
    const derived = window.RouteMapsterQueryEngine.computeDerivedFields(filtered);
    state.resultsDismissed = false;
    state.filteredRows = derived;
    state.filterSpec = normalizedSpec;
    refreshRouteLookup(derived);
    updateResultCount(derived.length, els);
    renderRouteList(derived, els);
    syncVisibleRoutes(appState, derived);
    updateHash(normalizedSpec);
    updateResultsVisibility(els, true, state.moduleOpen);

    if (appState) {
      appState.advancedFiltersState = {
        rows: derived,
        filterSpec: normalizedSpec
      };
    }

    document.dispatchEvent(new CustomEvent("routeFiltersUpdated", { detail: { rows: derived, filterSpec: normalizedSpec } }));
  };

  /**
   * Builds a filter spec from the current form state and applies it.
   *
   * @param {object} appState Shared application state from `app.js`.
   * @param {object} els Cached DOM elements for the module.
   * @returns {Promise<void>}
   * Side effects: May load spatial metrics, mutate filter state, and redraw the map.
   */
  const applyFromUI = async (appState, els) => {
    const engine = window.RouteMapsterQueryEngine;
    if (!engine) {
      return;
    }
    const spec = buildFilterSpecFromUI(els);
    const normalized = engine.normalizeFilterSpec(spec);
    let baseRows = null;
    let applySpec = spec;
    if (normalized.borough_mode === "within" && Array.isArray(normalized.boroughs) && normalized.boroughs.length > 0) {
      // "Wholly within" cannot be inferred from stop coverage alone, so switch
      // to geometry-based membership before reapplying the remaining filters.
      const boroughSet = new Set(normalized.boroughs.map((token) => String(token).toLowerCase()));
      const allowed = await computeRoutesWhollyWithin(state.rows, boroughSet);
      if (allowed instanceof Set) {
        baseRows = state.rows.filter((row) => row?.route_id_norm && allowed.has(row.route_id_norm));
        applySpec = {
          ...spec,
          boroughs: undefined,
          borough_mode: undefined
        };
      } else {
        baseRows = null;
      }
    }
    if (normalized.extreme && !state.spatialReady) {
      await ensureSpatialMetrics(els, appState);
    }
    applyFilters(appState, els, { baseRows, filterSpec: spec, applySpec });
    if (hasActiveFilters(normalized)) {
      await showAllFilteredRoutes(els, appState);
    }
  };

  const populateSelects = (rows, els) => {
    const engine = window.RouteMapsterQueryEngine;
    const routeTypes = engine.getUniqueValues(rows, (row) => row.route_type, (value) => String(value || "").toLowerCase())
      .filter((value) => !isUnknown(value));
    if (els.routeTypes) {
      els.routeTypes = setSelectOptions(
        els.routeTypes,
        routeTypes.map((value) => ({ value, label: value }))
      );
    }
    const operators = engine.getUniqueValues(rows, (row) => row.operator_names_arr || [], (value) => String(value || ""));
    if (els.operators) {
      const operatorValues = operators.filter((value) => !isUnknown(value));
      els.operators = setSelectOptions(
        els.operators,
        operatorValues
          .slice()
          .sort((a, b) => String(a).localeCompare(String(b)))
          .map((value) => ({ value, label: value }))
      );
    }
    if (els.garages) {
      const garages = buildGarageOptions(rows)
        .filter((option) => option.label && !isUnknown(option.label));
      els.garages = setSelectOptions(els.garages, garages);
    }
    if (els.boroughs) {
      if (state.boroughsReady) {
        els.boroughs = setSelectOptions(els.boroughs, state.boroughOptions);
      } else {
        els.boroughs = setSelectOptions(els.boroughs, []);
      }
      els.boroughs.disabled = !state.boroughsReady;
    }
    if (els.boroughMode) {
      els.boroughMode.disabled = !state.boroughsReady;
    }
    if (els.boroughsSelectAll) {
      els.boroughsSelectAll.disabled = !state.boroughsReady;
    }
    if (els.boroughNote) {
      els.boroughNote.textContent = state.boroughsReady
        ? "Based on stops that serve each route."
        : "Borough data unavailable in the stop dataset.";
    }
    const vehicles = engine.getUniqueValues(rows, (row) => row.vehicle_type, (value) => String(value || "").toUpperCase());
    if (els.vehicles) {
      const vehicleValues = vehicles.filter((value) => !isUnknown(value));
      els.vehicles = setSelectOptions(
        els.vehicles,
        vehicleValues
          .slice()
          .sort((a, b) => String(a).localeCompare(String(b)))
          .map((value) => ({ value, label: value }))
      );
    }
    if (els.routePrefix) {
      const prefixes = buildPrefixOptions(rows);
      const options = [
        { value: "any", label: "Any" },
        ...prefixes.map((prefix) => ({ value: prefix, label: prefix }))
      ];
      els.routePrefix = setSelectOptions(els.routePrefix, options);
    }
    refreshMobileMultiFallbacks(els);
  };

  /**
   * Applies a provided filter spec, typically from Explorer or a preset.
   *
   * @param {object} filterSpec Filter specification to mirror into the UI.
   * @param {object} appState Shared application state from `app.js`.
   * @param {{openModule?: boolean}} [options={}] Optional UI behaviour flags.
   * @returns {Promise<void>}
   * Side effects: Updates form controls, filter state, results, and map overlays.
   */
  const applyFilterSpec = async (filterSpec, appState, options = {}) => {
    const engine = window.RouteMapsterQueryEngine;
    if (!engine) {
      return;
    }
    if (!state.elements && state.initPromise) {
      await state.initPromise;
    }
    if (!state.elements) {
      return;
    }
    const els = state.elements;
    const normalized = engine.normalizeFilterSpec(filterSpec || {});
    applyFilterSpecToUI(normalized, els);

    if (options.openModule && state.container) {
      state.container.open = true;
    }
    state.moduleOpen = Boolean(state.container?.open);

    let baseRows = null;
    let applySpec = normalized;
    if (normalized.borough_mode === "within" && Array.isArray(normalized.boroughs) && normalized.boroughs.length > 0) {
      // Reuse the same geometry-backed path as manual UI application so deep
      // links and presets behave identically.
      const boroughSet = new Set(normalized.boroughs.map((token) => String(token).toLowerCase()));
      const allowed = await computeRoutesWhollyWithin(state.rows, boroughSet);
      if (allowed instanceof Set) {
        baseRows = state.rows.filter((row) => row?.route_id_norm && allowed.has(row.route_id_norm));
        applySpec = {
          ...normalized,
          boroughs: undefined,
          borough_mode: undefined
        };
      }
    }
    if (normalized.extreme && !state.spatialReady) {
      await ensureSpatialMetrics(els, appState);
    }
    applyFilters(appState, els, { baseRows, filterSpec: normalized, applySpec });
    if (hasActiveFilters(normalized)) {
      await showAllFilteredRoutes(els, appState);
    }
  };

  /**
   * Initialises the advanced filter module once and wires all DOM events.
   *
   * @param {HTMLElement} container `<details>` container hosting the filter controls.
   * @param {object} appState Shared application state from `app.js`.
   * @returns {Promise<void>}
   * Side effects: Loads datasets, caches DOM references, binds event listeners, and updates global app state.
   */
  const initAdvancedFilters = async (container, appState) => {
    const engine = window.RouteMapsterQueryEngine;
    if (!container || !engine) {
      return;
    }
    if (state.initPromise) {
      return state.initPromise;
    }

    state.initPromise = (async () => {
      const els = {
        routeSearch: container.querySelector("#advancedRouteSearch"),
        routePrefix: container.querySelector("#advancedRoutePrefix"),
        routeSeries: container.querySelector("#advancedRouteSeries"),
        seriesIncludePrefixes: container.querySelector("#advancedSeriesIncludePrefixes"),
        routeTypes: container.querySelector("#advancedRouteTypes"),
        routeTypesSelectAll: container.querySelector("#advancedRouteTypesSelectAll"),
        operators: container.querySelector("#advancedOperators"),
        operatorsSelectAll: container.querySelector("#advancedOperatorsSelectAll"),
        garages: container.querySelector("#advancedGarages"),
        garagesSelectAll: container.querySelector("#advancedGaragesSelectAll"),
        boroughs: container.querySelector("#advancedBoroughs"),
        boroughMode: container.querySelector("#advancedBoroughMode"),
        boroughsSelectAll: container.querySelector("#advancedBoroughsSelectAll"),
        boroughNote: container.querySelector("#advancedBoroughsNote"),
        vehicles: container.querySelector("#advancedVehicles"),
        vehiclesSelectAll: container.querySelector("#advancedVehiclesSelectAll"),
        frequencyBand: container.querySelector("#advancedFrequencyBand"),
        frequencyMin: container.querySelector("#advancedFrequencyMin"),
        frequencyMax: container.querySelector("#advancedFrequencyMax"),
        hasOvernight: container.querySelector("#advancedHasOvernight"),
        uniqueStopsMin: container.querySelector("#advancedUniqueStopsMin"),
        uniqueStopsMax: container.querySelector("#advancedUniqueStopsMax"),
        uniqueStopsRankMode: container.querySelector("#advancedUniqueStopsRankMode"),
        uniqueStopsRankCount: container.querySelector("#advancedUniqueStopsRankCount"),
        lengthMin: container.querySelector("#advancedLengthMin"),
        lengthMax: container.querySelector("#advancedLengthMax"),
        lengthRankMode: container.querySelector("#advancedLengthRankMode"),
        lengthRankCount: container.querySelector("#advancedLengthRankCount"),
        extremeSelect: container.querySelector("#advancedExtremeSelect"),
        applyButton: container.querySelector("#advancedApplyFilters"),
        expandAllSubsections: container.querySelector("#advancedExpandAllSubsections"),
        collapseAllSubsections: container.querySelector("#advancedCollapseAllSubsections"),
        routeCount: document.getElementById("advancedRouteCount"),
        routeList: document.getElementById("advancedRouteList"),
        showAllOnMap: document.getElementById("advancedShowAllOnMap"),
        clearMap: document.getElementById("advancedClearMap"),
        exportCsv: document.getElementById("advancedExportCsv"),
        mapWarning: document.getElementById("advancedMapWarning"),
        resultsPanel: document.getElementById("advancedResultsPanel"),
        closeResults: document.getElementById("advancedCloseResults"),
        clearButton: container.querySelector("#advancedClearFilters"),
        uniqueStopsWrap: container.querySelector("#advancedUniqueStopsWrap"),
        lengthWrap: container.querySelector("#advancedLengthWrap")
      };
      els.appState = appState;
      state.elements = els;
      state.container = container;
      state.moduleOpen = Boolean(container.open);
      updateResultsVisibility(els, false, state.moduleOpen);

      await ensureRowsLoaded(engine);

      populateSelects(state.derivedRows, els);

      const hasLength = state.derivedRows.some((row) => Number.isFinite(row.length_miles));
      const hasUniqueStops = state.derivedRows.some((row) => Number.isFinite(row.unique_stops));
      if (els.uniqueStopsWrap) {
        els.uniqueStopsWrap.style.display = hasUniqueStops ? "" : "none";
      }
      if (els.lengthWrap) {
        els.lengthWrap.style.display = hasLength ? "" : "none";
      }

      const hashSpec = getHashSpec();
      const hasHashSpec = Object.keys(hashSpec).length > 0;
      if (hasSpatialFilters(hashSpec)) {
        await ensureSpatialMetrics(els, appState);
      }
      applyFilterSpecToUI(hasHashSpec ? hashSpec : {}, els);

      container.addEventListener("toggle", () => {
        state.moduleOpen = Boolean(container.open);
        if (!state.moduleOpen) {
          updateResultsVisibility(els, hasActiveFilters(state.filterSpec), state.moduleOpen);
          return;
        }
        ensureRowsLoaded(engine)
          .then(() => {
            populateSelects(state.derivedRows, els);
            applyFilterSpecToUI(state.filterSpec, els);
          })
          .catch(() => {})
          .finally(() => {
            updateResultsVisibility(els, hasActiveFilters(state.filterSpec), state.moduleOpen);
          });
      });

    const setSubsectionsOpen = (open) => {
      const subsections = Array.from(container.querySelectorAll("details.submodule"));
      subsections.forEach((section) => {
        section.open = Boolean(open);
      });
    };

    const selectAll = (selectEl) => {
      if (!selectEl) {
        return;
      }
      Array.from(selectEl.options).forEach((option) => {
        option.selected = true;
      });
      refreshMobileMultiFallbacks(els);
      selectEl.dispatchEvent(new Event("change", { bubbles: true }));
    };

    const handleEnterApply = (event) => {
      if (event.key !== "Enter" || event.isComposing) {
        return;
      }
      event.preventDefault();
      applyFromUI(appState, els).catch(() => {});
    };

    const bindEnterApply = (input) => {
      if (!input) {
        return;
      }
      input.addEventListener("keydown", handleEnterApply);
    };

    [
      els.routeSearch,
      els.routeSeries,
      els.frequencyMin,
      els.frequencyMax,
      els.uniqueStopsMin,
      els.uniqueStopsMax,
      els.lengthMin,
      els.lengthMax,
      els.uniqueStopsRankCount,
      els.lengthRankCount
    ].forEach(bindEnterApply);

    if (els.routeTypesSelectAll) {
      els.routeTypesSelectAll.addEventListener("click", () => selectAll(els.routeTypes));
    }
    if (els.operatorsSelectAll) {
      els.operatorsSelectAll.addEventListener("click", () => selectAll(els.operators));
    }
    if (els.garagesSelectAll) {
      els.garagesSelectAll.addEventListener("click", () => selectAll(els.garages));
    }
    if (els.boroughsSelectAll) {
      els.boroughsSelectAll.addEventListener("click", () => selectAll(els.boroughs));
    }
    if (els.vehiclesSelectAll) {
      els.vehiclesSelectAll.addEventListener("click", () => selectAll(els.vehicles));
    }

    if (els.applyButton) {
      els.applyButton.addEventListener("click", () => {
        applyFromUI(appState, els).catch(() => {});
      });
    }
    if (els.expandAllSubsections) {
      els.expandAllSubsections.addEventListener("click", () => {
        setSubsectionsOpen(true);
      });
    }
    if (els.collapseAllSubsections) {
      els.collapseAllSubsections.addEventListener("click", () => {
        setSubsectionsOpen(false);
      });
    }
    if (els.clearButton) {
      els.clearButton.addEventListener("click", () => {
        applyFilterSpecToUI({}, els);
        applyFilters(appState, els);
      });
    }

    if (els.showAllOnMap) {
      els.showAllOnMap.addEventListener("click", async () => {
        await showAllFilteredRoutes(els, appState);
      });
    }

    if (els.closeResults) {
      els.closeResults.addEventListener("click", () => {
        dismissResults({ restoreMap: true });
      });
    }

    if (els.clearMap) {
      els.clearMap.addEventListener("click", () => {
        clearMapHighlights(appState);
        renderRouteList(state.filteredRows, els);
      });
    }

    if (els.exportCsv) {
      els.exportCsv.addEventListener("click", () => {
        const rows = state.filteredRows;
        if (!rows || rows.length === 0) {
          return;
        }
        const columns = [
          "route_id",
          "route_type",
          "operators",
          "garages",
          "vehicle",
          "frequency_peak_am",
          "frequency_peak_pm",
          "frequency_offpeak",
          "frequency_weekend",
          "frequency_overnight",
          "unique_stops",
          "total_stops",
          "unique_stops_pct",
          "length_miles"
        ];
        const csvRows = rows.map((row) => [
          row.route_id_norm || row.route_id,
          row.route_type,
          (row.operator_names_arr || []).join("; "),
          buildGarageLabels(row).join("; "),
          row.vehicle_type,
          row.frequency_peak_am,
          row.frequency_peak_pm,
          row.frequency_offpeak,
          row.frequency_weekend,
          row.frequency_overnight,
          row.unique_stops,
          row.total_stops,
          Number.isFinite(row.unique_stops_pct) ? row.unique_stops_pct : "",
          row.length_miles
        ]);
        downloadCsv("filtered_routes.csv", columns, csvRows);
      });
    }

    if (els.routeList) {
      els.routeList.addEventListener("click", (event) => {
        const pill = event.target.closest(".route-pill");
        if (pill) {
          const routeId = String(pill.dataset.route || "").trim().toUpperCase();
          if (!routeId) {
            return;
          }
          event.preventDefault();
          if (appState) {
            appState.advancedResultsRouteReturnPending = true;
          }
          dismissResults({ restoreMap: false });
          if (typeof window.showRouteDetailsAndFocus === "function") {
            window.showRouteDetailsAndFocus(routeId).catch(() => {});
          }
          return;
        }
        const toggle = event.target.closest(".route-map-toggle");
        if (!toggle) {
          return;
        }
        const routeId = toggle.dataset.route;
        if (!routeId) {
          return;
        }
        if (state.visibleRoutes.has(routeId)) {
          hideRouteOnMap(appState, routeId);
        } else {
          showRouteOnMap(appState, routeId);
        }
        renderRouteList(state.filteredRows, els);
      });
    }

    document.addEventListener("click", (event) => {
      const button = event.target.closest(".route-zoom-btn");
      if (!button) {
        return;
      }
      const routeId = button.dataset.route;
      if (!routeId) {
        return;
      }
      const entry = state.routeLayers.get(routeId);
      if (!entry || !entry.lines || !appState?.map) {
        return;
      }
      const bounds = entry.lines.reduce((acc, line) => {
        const lineBounds = line.getBounds();
        return acc ? acc.extend(lineBounds) : lineBounds;
      }, null);
      if (bounds) {
        appState.map.fitBounds(bounds.pad(0.1));
      }
    });

      if (hasHashSpec) {
        await applyFromUI(appState, els);
      } else {
        applyFilters(appState, els);
      }
    })();
    return state.initPromise;
  };

  window.RouteMapsterAdvancedFilters = {
    initAdvancedFilters,
    clearMapHighlights: (appState) => clearMapHighlights(appState),
    getCurrentFilterSpec: () => state.filterSpec,
    getCurrentRows: () => state.filteredRows,
    listRoutesWhollyWithinBoroughs,
    applyFilterSpec,
    dismissResults,
    showResults
  };
})();

