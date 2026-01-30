(() => {
  const FILTER_HASH_KEY = "filters";
  const MAP_HIGHLIGHT_COLOUR = "#10b981";
  const MAP_HIGHLIGHT_WEIGHT = 4;
  const MAP_HIGHLIGHT_OPACITY = 0.9;
  const SHOW_ALL_CAP = Number.POSITIVE_INFINITY;
  const LIST_CAP = Number.POSITIVE_INFINITY;
  const DEBOUNCE_MS = 180;

  const escapeHtml = (value) => String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

  const formatNumber = (value, digits = 1) => {
    if (!Number.isFinite(value)) {
      return "";
    }
    return digits === 0 ? String(Math.round(value)) : value.toFixed(digits);
  };

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

  const parseTokens = (value) => {
    if (!value) {
      return [];
    }
    return String(value)
      .split(/[\s,]+/)
      .map((entry) => entry.trim())
      .filter(Boolean);
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
    return `<span class="route-pill route-pill--${escapeHtml(className)}">${escapeHtml(routeId)}</span>`;
  };

  const downloadCsv = (filename, columns, rows) => {
    const header = columns.map((col) => `"${String(col).replace(/"/g, '""')}"`).join(",");
    const body = rows
      .map((row) => row.map((value) => `"${String(value ?? "").replace(/"/g, '""')}"`).join(","))
      .join("\n");
    const csv = [header, body].filter(Boolean).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
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

  const buildOptionHtml = (values) => {
    return values
      .slice()
      .sort((a, b) => String(a).localeCompare(String(b)))
      .map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`)
      .join("");
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

  const state = {
    rows: [],
    derivedRows: [],
    filteredRows: [],
    filterSpec: {},
    rowLookup: new Map(),
    mapLayerGroup: null,
    routeLayers: new Map(),
    visibleRoutes: new Set(),
    debounceHandle: null,
    lastHash: "",
    elements: null,
    moduleOpen: false
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
    const garage = cleanMetaValue(row.garage_codes_arr?.[0] || row.garage_names_arr?.[0] || "");
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

  const buildFilterSpecFromUI = (els) => {
    const routeIds = parseTokens(els.routeSearch?.value || "");
    let prefixValue = "";
    if (els.routePrefix?.value && els.routePrefix.value !== "any" && els.routePrefix.value !== "custom") {
      prefixValue = els.routePrefix.value;
    }
    if (els.routePrefix?.value === "custom") {
      prefixValue = els.routePrefixCustom?.value || "";
    }
    if (!prefixValue && els.routePrefixCustom?.value && els.routePrefix?.value === "custom") {
      prefixValue = els.routePrefixCustom.value;
    }

    const freq = {};
    const peakAmMin = parseNumberInput(els.peakAmMin);
    const peakAmMax = parseNumberInput(els.peakAmMax);
    if (peakAmMin !== null || peakAmMax !== null) {
      freq.peak_am = { min: peakAmMin ?? undefined, max: peakAmMax ?? undefined };
    }
    const peakPmMin = parseNumberInput(els.peakPmMin);
    const peakPmMax = parseNumberInput(els.peakPmMax);
    if (peakPmMin !== null || peakPmMax !== null) {
      freq.peak_pm = { min: peakPmMin ?? undefined, max: peakPmMax ?? undefined };
    }
    const offpeakMin = parseNumberInput(els.offpeakMin);
    const offpeakMax = parseNumberInput(els.offpeakMax);
    if (offpeakMin !== null || offpeakMax !== null) {
      freq.offpeak = { min: offpeakMin ?? undefined, max: offpeakMax ?? undefined };
    }
    const overnightMin = parseNumberInput(els.overnightMin);
    const overnightMax = parseNumberInput(els.overnightMax);
    if (overnightMin !== null || overnightMax !== null) {
      freq.overnight = { min: overnightMin ?? undefined, max: overnightMax ?? undefined };
    }

    const flags = {};
    if (els.hasOvernight?.checked) {
      flags.has_overnight = true;
    }
    if (els.highFrequencyToggle?.checked) {
      const value = parseNumberInput(els.highFrequencyValue);
      if (value !== null) {
        flags.high_frequency_any = value;
      }
    }
    const peakiness = parseNumberInput(els.peakinessMin);
    if (peakiness !== null) {
      flags.peaky = { min_delta: peakiness };
    }

    const lengthMin = parseNumberInput(els.lengthMin);
    const lengthMax = parseNumberInput(els.lengthMax);
    const length = lengthMin !== null || lengthMax !== null
      ? { min: lengthMin ?? undefined, max: lengthMax ?? undefined }
      : undefined;

    return {
      route_ids: routeIds.length > 0 ? routeIds : undefined,
      route_prefix: prefixValue ? prefixValue.toUpperCase() : undefined,
      route_types: getSelectedValues(els.routeTypes),
      operators: getSelectedValues(els.operators),
      garages: getSelectedValues(els.garages),
      vehicle_types: getSelectedValues(els.vehicles),
      freq: Object.keys(freq).length > 0 ? freq : undefined,
      flags: Object.keys(flags).length > 0 ? flags : undefined,
      length_miles: length
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
        if (els.routePrefixCustom) {
          els.routePrefixCustom.value = "";
        }
      } else if (prefix) {
        els.routePrefix.value = "custom";
        if (els.routePrefixCustom) {
          els.routePrefixCustom.value = prefix;
        }
      } else {
        els.routePrefix.value = "any";
        if (els.routePrefixCustom) {
          els.routePrefixCustom.value = "";
        }
      }
    }

    const setMulti = (select, values) => {
      if (!select) {
        return;
      }
      const set = new Set(values || []);
      Array.from(select.options).forEach((option) => {
        option.selected = set.has(option.value);
      });
    };

    setMulti(els.routeTypes, normalized.route_types || []);
    setMulti(els.operators, normalized.operators || []);
    setMulti(els.garages, normalized.garages || []);
    setMulti(els.vehicles, normalized.vehicle_types || []);

    const setRange = (range, minEl, maxEl) => {
      if (minEl) {
        minEl.value = Number.isFinite(range?.min) ? range.min : "";
      }
      if (maxEl) {
        maxEl.value = Number.isFinite(range?.max) ? range.max : "";
      }
    };

    setRange(normalized.freq?.peak_am, els.peakAmMin, els.peakAmMax);
    setRange(normalized.freq?.peak_pm, els.peakPmMin, els.peakPmMax);
    setRange(normalized.freq?.offpeak, els.offpeakMin, els.offpeakMax);
    setRange(normalized.freq?.overnight, els.overnightMin, els.overnightMax);

    if (els.hasOvernight) {
      els.hasOvernight.checked = normalized.flags?.has_overnight === true;
    }
    if (els.highFrequencyToggle) {
      els.highFrequencyToggle.checked = Number.isFinite(normalized.flags?.high_frequency_any);
    }
    if (els.highFrequencyValue) {
      els.highFrequencyValue.value = Number.isFinite(normalized.flags?.high_frequency_any)
        ? normalized.flags.high_frequency_any
        : "";
    }
    if (els.peakinessMin) {
      els.peakinessMin.value = Number.isFinite(normalized.flags?.peaky?.min_delta)
        ? normalized.flags.peaky.min_delta
        : "";
    }
    if (els.lengthMin) {
      els.lengthMin.value = Number.isFinite(normalized.length_miles?.min) ? normalized.length_miles.min : "";
    }
    if (els.lengthMax) {
      els.lengthMax.value = Number.isFinite(normalized.length_miles?.max) ? normalized.length_miles.max : "";
    }
  };

  const getHashSpec = () => {
    const hash = window.location.hash.replace(/^#/, "");
    if (!hash) {
      return {};
    }
    const params = new URLSearchParams(hash);
    if (!params.has(FILTER_HASH_KEY)) {
      return {};
    }
    const value = params.get(FILTER_HASH_KEY);
    if (!value) {
      return {};
    }
    return window.RouteMapsterQueryEngine.parseFilterSpec(value);
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
    if (hasList(normalized.route_types) || hasList(normalized.operators) || hasList(normalized.garages) || hasList(normalized.vehicle_types)) {
      return true;
    }
    if (normalized.freq) {
      const bands = ["peak_am", "peak_pm", "offpeak", "overnight"];
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
      if (Number.isFinite(normalized.flags.high_frequency_any)) {
        return true;
      }
      if (Number.isFinite(normalized.flags.peaky?.min_delta)) {
        return true;
      }
    }
    if (normalized.length_miles && (Number.isFinite(normalized.length_miles.min) || Number.isFinite(normalized.length_miles.max))) {
      return true;
    }
    return false;
  };

  const updateResultsVisibility = (els, isActive, isOpen) => {
    const panel = els?.resultsPanel;
    const appRoot = document.getElementById("app");
    const shouldShow = Boolean(panel && isActive && isOpen);
    if (panel) {
      panel.classList.toggle("is-visible", shouldShow);
    }
    if (appRoot) {
      appRoot.classList.toggle("has-advanced-results", shouldShow);
    }
  };

  const updateHash = (spec) => {
    const params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    if (!hasActiveFilters(spec)) {
      params.delete(FILTER_HASH_KEY);
    } else {
      const encoded = window.RouteMapsterQueryEngine.serializeFilterSpec(spec);
      params.set(FILTER_HASH_KEY, encoded);
    }
    const nextHash = params.toString();
    if (nextHash === state.lastHash) {
      return;
    }
    state.lastHash = nextHash;
    history.replaceState(null, "", `#${nextHash}`);
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
      const offpeak = formatNumber(row.frequency_offpeak);
      const overnight = formatNumber(row.frequency_overnight);
      const intensity = formatNumber(row.service_intensity_score, 2);
      const peakiness = formatNumber(row.peakiness_index, 2);
      const hasOvernight = row.has_overnight ? "Yes" : "No";
      const isVisible = state.visibleRoutes.has(routeId);
      const metaParts = [routeType, operator, garage, cleanMetaValue(vehicle)]
        .filter(Boolean)
        .join(" · ");
      return `
        <div class="route-card" data-route="${escapeHtml(routeId)}">
          <div class="route-card__header">
            <div class="route-card__title">${renderRoutePill(routeId, els.appState)}</div>
            <button type="button" class="ghost-button tiny route-map-toggle" data-route="${escapeHtml(routeId)}">
              ${isVisible ? "Hide" : "Show"}
            </button>
          </div>
          <div class="route-card__meta">${escapeHtml(metaParts)}</div>
          <div class="route-card__freq">Peak AM: ${peakAm || "–"} · Offpeak: ${offpeak || "–"} · Overnight: ${overnight || "–"}</div>
          <div class="route-card__kpi">Intensity: ${intensity || "–"} · Peakiness: ${peakiness || "–"} · Overnight: ${hasOvernight}</div>
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

  const applyFilters = (appState, els) => {
    const filterSpec = buildFilterSpecFromUI(els);
    const normalizedSpec = window.RouteMapsterQueryEngine.normalizeFilterSpec(filterSpec);
    const isActive = hasActiveFilters(normalizedSpec);
    if (!isActive) {
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
    const filtered = window.RouteMapsterQueryEngine.applyFilters(state.rows, normalizedSpec);
    const derived = window.RouteMapsterQueryEngine.computeDerivedFields(filtered);
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

  const scheduleApplyFilters = (appState, els) => {
    if (state.debounceHandle) {
      window.clearTimeout(state.debounceHandle);
    }
    state.debounceHandle = window.setTimeout(() => {
      applyFilters(appState, els);
    }, DEBOUNCE_MS);
  };

  const populateSelects = (rows, els) => {
    const engine = window.RouteMapsterQueryEngine;
    const routeTypes = engine.getUniqueValues(rows, (row) => row.route_type, (value) => String(value || "").toLowerCase())
      .filter((value) => !isUnknown(value));
    if (els.routeTypes) {
      els.routeTypes.innerHTML = buildOptionHtml(routeTypes);
    }
    const operators = engine.getUniqueValues(rows, (row) => row.operator_names_arr || [], (value) => String(value || ""));
    if (els.operators) {
      els.operators.innerHTML = buildOptionHtml(operators.filter((value) => !isUnknown(value)));
    }
    if (els.garages) {
      const garages = buildGarageOptions(rows)
        .filter((option) => option.label && !isUnknown(option.label));
      els.garages.innerHTML = garages
        .map((option) => `<option value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</option>`)
        .join("");
    }
    const vehicles = engine.getUniqueValues(rows, (row) => row.vehicle_type, (value) => String(value || "").toUpperCase());
    if (els.vehicles) {
      els.vehicles.innerHTML = buildOptionHtml(vehicles.filter((value) => !isUnknown(value)));
    }
    if (els.routePrefix) {
      const prefixes = buildPrefixOptions(rows);
      const options = [
        { value: "any", label: "Any" },
        ...prefixes.map((prefix) => ({ value: prefix, label: prefix })),
        { value: "custom", label: "Custom..." }
      ];
      els.routePrefix.innerHTML = options
        .map((option) => `<option value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</option>`)
        .join("");
    }
  };

  const renderPresets = (container, els, appState) => {
    if (!container || !window.RouteMapsterPresets) {
      return;
    }
    const presets = window.RouteMapsterPresets.getPresets();
    container.innerHTML = presets.map((preset) => {
      return `
        <button type="button" class="preset-card" data-preset="${escapeHtml(preset.id)}">
          <div class="preset-card__icon">${escapeHtml(preset.icon)}</div>
          <div class="preset-card__title">${escapeHtml(preset.name)}</div>
          <div class="preset-card__desc">${escapeHtml(preset.description)}</div>
        </button>
      `;
    }).join("");

    container.addEventListener("click", (event) => {
      const card = event.target.closest(".preset-card");
      if (!card) {
        return;
      }
      const presetId = card.dataset.preset;
      const preset = presets.find((item) => item.id === presetId);
      if (!preset) {
        return;
      }
      applyFilterSpecToUI(preset.filterSpec || {}, els);
      scheduleApplyFilters(appState, els);
    });
  };

  const initAdvancedFilters = async (container, appState) => {
    const engine = window.RouteMapsterQueryEngine;
    if (!container || !engine) {
      return;
    }

    const els = {
      routeSearch: container.querySelector("#advancedRouteSearch"),
      routePrefix: container.querySelector("#advancedRoutePrefix"),
      routePrefixCustom: container.querySelector("#advancedRoutePrefixCustom"),
      routeTypes: container.querySelector("#advancedRouteTypes"),
      routeTypesSelectAll: container.querySelector("#advancedRouteTypesSelectAll"),
      operators: container.querySelector("#advancedOperators"),
      operatorsSelectAll: container.querySelector("#advancedOperatorsSelectAll"),
      garages: container.querySelector("#advancedGarages"),
      garagesSelectAll: container.querySelector("#advancedGaragesSelectAll"),
      vehicles: container.querySelector("#advancedVehicles"),
      vehiclesSelectAll: container.querySelector("#advancedVehiclesSelectAll"),
      peakAmMin: container.querySelector("#advancedPeakAmMin"),
      peakAmMax: container.querySelector("#advancedPeakAmMax"),
      peakPmMin: container.querySelector("#advancedPeakPmMin"),
      peakPmMax: container.querySelector("#advancedPeakPmMax"),
      offpeakMin: container.querySelector("#advancedOffpeakMin"),
      offpeakMax: container.querySelector("#advancedOffpeakMax"),
      overnightMin: container.querySelector("#advancedOvernightMin"),
      overnightMax: container.querySelector("#advancedOvernightMax"),
      hasOvernight: container.querySelector("#advancedHasOvernight"),
      highFrequencyToggle: container.querySelector("#advancedHighFrequencyToggle"),
      highFrequencyValue: container.querySelector("#advancedHighFrequencyValue"),
      peakinessMin: container.querySelector("#advancedPeakinessMin"),
      lengthMin: container.querySelector("#advancedLengthMin"),
      lengthMax: container.querySelector("#advancedLengthMax"),
      routeCount: document.getElementById("advancedRouteCount"),
      routeList: document.getElementById("advancedRouteList"),
      showAllOnMap: document.getElementById("advancedShowAllOnMap"),
      clearMap: document.getElementById("advancedClearMap"),
      exportCsv: document.getElementById("advancedExportCsv"),
      mapWarning: document.getElementById("advancedMapWarning"),
      resultsPanel: document.getElementById("advancedResultsPanel"),
      presets: container.querySelector("#advancedFilterPresets"),
      lengthWrap: container.querySelector("#advancedLengthWrap")
    };
    els.appState = appState;
    state.elements = els;
    state.moduleOpen = Boolean(container.open);
    updateResultsVisibility(els, false, state.moduleOpen);

    state.rows = await engine.loadRouteSummary();
    state.derivedRows = engine.computeDerivedFields(state.rows);

    populateSelects(state.derivedRows, els);

    const hasLength = state.derivedRows.some((row) => Number.isFinite(row.length_miles));
    if (els.lengthWrap) {
      els.lengthWrap.style.display = hasLength ? "" : "none";
    }

    renderPresets(els.presets, els, appState);

    const hashSpec = getHashSpec();
    if (Object.keys(hashSpec).length > 0) {
      applyFilterSpecToUI(hashSpec, els);
    } else {
      applyFilterSpecToUI({}, els);
    }

    const inputs = container.querySelectorAll("input, select");
    inputs.forEach((input) => {
      input.addEventListener("input", () => scheduleApplyFilters(appState, els));
      input.addEventListener("change", () => scheduleApplyFilters(appState, els));
    });

    container.addEventListener("toggle", () => {
      state.moduleOpen = Boolean(container.open);
      updateResultsVisibility(els, hasActiveFilters(state.filterSpec), state.moduleOpen);
    });

    const selectAll = (selectEl) => {
      if (!selectEl) {
        return;
      }
      Array.from(selectEl.options).forEach((option) => {
        option.selected = true;
      });
      scheduleApplyFilters(appState, els);
    };

    if (els.routeTypesSelectAll) {
      els.routeTypesSelectAll.addEventListener("click", () => selectAll(els.routeTypes));
    }
    if (els.operatorsSelectAll) {
      els.operatorsSelectAll.addEventListener("click", () => selectAll(els.operators));
    }
    if (els.garagesSelectAll) {
      els.garagesSelectAll.addEventListener("click", () => selectAll(els.garages));
    }
    if (els.vehiclesSelectAll) {
      els.vehiclesSelectAll.addEventListener("click", () => selectAll(els.vehicles));
    }

    if (els.routePrefix) {
      els.routePrefix.addEventListener("change", () => {
        if (els.routePrefix.value !== "custom" && els.routePrefixCustom) {
          els.routePrefixCustom.value = "";
        }
        scheduleApplyFilters(appState, els);
      });
    }

    if (els.showAllOnMap) {
      els.showAllOnMap.addEventListener("click", async () => {
        if (els.mapWarning) {
          els.mapWarning.textContent = "";
        }
        const list = state.filteredRows.map((row) => row.route_id_norm);
        const sorted = sortRouteIds(list);
        if (Number.isFinite(SHOW_ALL_CAP) && sorted.length > SHOW_ALL_CAP) {
          if (els.mapWarning) {
            els.mapWarning.textContent = `Showing first ${SHOW_ALL_CAP} of ${sorted.length} routes. Refine filters for more.`;
          }
        }
        const toShow = Number.isFinite(SHOW_ALL_CAP) ? sorted.slice(0, SHOW_ALL_CAP) : sorted.slice();
        for (const routeId of toShow) {
          await showRouteOnMap(appState, routeId);
        }
        renderRouteList(state.filteredRows, els);
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
          "frequency_overnight",
          "service_intensity_score",
          "peakiness_index"
        ];
        const csvRows = rows.map((row) => [
          row.route_id_norm || row.route_id,
          row.route_type,
          (row.operator_names_arr || []).join("; "),
          [...(row.garage_codes_arr || []), ...(row.garage_names_arr || [])].join("; "),
          row.vehicle_type,
          row.frequency_peak_am,
          row.frequency_peak_pm,
          row.frequency_offpeak,
          row.frequency_overnight,
          formatNumber(row.service_intensity_score, 2),
          formatNumber(row.peakiness_index, 2)
        ]);
        downloadCsv("filtered_routes.csv", columns, csvRows);
      });
    }

    if (els.routeList) {
      els.routeList.addEventListener("click", (event) => {
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

    window.addEventListener("hashchange", () => {
      const spec = getHashSpec();
      applyFilterSpecToUI(spec, els);
      scheduleApplyFilters(appState, els);
    });

    applyFilters(appState, els);
  };

  window.RouteMapsterAdvancedFilters = {
    initAdvancedFilters,
    clearMapHighlights: (appState) => clearMapHighlights(appState),
    getCurrentFilterSpec: () => state.filterSpec,
    getCurrentRows: () => state.filteredRows
  };
})();

