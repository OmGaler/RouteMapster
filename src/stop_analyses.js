(() => {
  const STOP_GEOJSON_PATH = "/data/processed/stops.geojson";
  const FREQUENCY_DATA_PATH = "/data/processed/frequencies.json";
  const DEBOUNCE_MS = 160;
  const FREQUENCY_BANDS = [
    { key: "peak_am", label: "Peak AM" },
    { key: "peak_pm", label: "Peak PM" },
    { key: "offpeak", label: "Off-peak" },
    { key: "overnight", label: "Overnight" }
  ];

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

  const formatFrequencyValue = (perHour) => {
    if (!Number.isFinite(perHour)) {
      return "";
    }
    return formatNumber(perHour, 1);
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

  const normalisePostcodeDistrict = (value) => {
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
  const getStopId = (props) => props?.NAPTAN_ID || props?.STOP_CODE || props?.NAPTAN_ATCO || "";

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
    if (tokens.length <= limit) {
      return escapeHtml(listString);
    }
    const summary = formatRouteList(tokens, limit);
    return `
      <details class="route-list-details">
        <summary>${escapeHtml(summary)}</summary>
        <div class="route-list-full">${escapeHtml(listString)}</div>
      </details>
    `;
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

  const buildStopRow = (feature, frequencyData) => {
    const props = feature?.properties || {};
    const coords = feature?.geometry?.coordinates;
    const lon = Array.isArray(coords) ? Number(coords[0]) : null;
    const lat = Array.isArray(coords) ? Number(coords[1]) : null;
    const name = String(getStopName(props) || "").trim();
    const id = String(getStopId(props) || "").trim();
    const postcode = String(props?.POSTCODE || "").trim();
    const district = normalisePostcodeDistrict(postcode) || "Unknown";
    const routes = extractRouteTokens(props?.ROUTES);
    const frequency = buildFrequencyTotals(routes, frequencyData);
    return {
      id,
      name: name || "Bus stop",
      postcode,
      district,
      routes,
      route_count: routes.length,
      lat: Number.isFinite(lat) ? lat : null,
      lon: Number.isFinite(lon) ? lon : null,
      frequency,
      url: props?.URL || ""
    };
  };

  const loadStopsGeojson = async () => {
    const res = await fetch(STOP_GEOJSON_PATH, { cache: "no-store" });
    if (!res.ok) {
      return null;
    }
    return res.json();
  };

  const loadFrequencyData = async () => {
    const res = await fetch(FREQUENCY_DATA_PATH, { cache: "no-store" });
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

  const buildStopsFromGeojson = (geojson, frequencyData) => {
    if (!geojson || !Array.isArray(geojson.features)) {
      return [];
    }
    return geojson.features
      .map((feature) => buildStopRow(feature, frequencyData))
      .filter((row) => row && (row.name || row.id) && row.route_count > 0);
  };

  const renderTable = (result) => {
    const columns = result.columns || [];
    const rows = result.rows || [];
    const expandRouteIndex = Number.isInteger(result?.meta?.expandRouteIndex)
      ? result.meta.expandRouteIndex
      : null;
    const header = columns.map((col) => `<th>${escapeHtml(col)}</th>`).join("");
    const body = rows.map((row) => {
      const cells = row.map((cell, index) => {
        if (expandRouteIndex === index && typeof cell === "string") {
          return `<td>${buildRouteListHtml(cell)}</td>`;
        }
        return `<td>${escapeHtml(cell)}</td>`;
      }).join("");
      return `<tr>${cells}</tr>`;
    }).join("");
    return `
      <div class="analysis-table-wrap">
        <table class="analysis-table">
          <thead><tr>${header}</tr></thead>
          <tbody>${body}</tbody>
        </table>
      </div>
    `;
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

  const analysisRegistry = {
    "top-stops-routes": {
      id: "top-stops-routes",
      label: "Top stops by route count",
      run: (rows) => {
        const sorted = rows
          .filter((row) => row.route_count > 0)
          .slice()
          .sort((a, b) => b.route_count - a.route_count)
          .slice(0, 25);
        return {
          type: "table",
          columns: ["Rank", "Stop", "District", "Routes", "Route list"],
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
    "top-stops-frequency": {
      id: "top-stops-frequency",
      label: "Top stops by combined frequency",
      requiresFrequency: true,
      run: (rows, context) => {
        const band = context?.frequencyBand || "peak_am";
        const label = FREQUENCY_BANDS.find((entry) => entry.key === band)?.label || band;
        const candidates = rows.filter((row) => row.frequency && Number.isFinite(row.frequency[band]));
        if (candidates.length === 0) {
          return { type: "note", message: "Frequency totals are unavailable for the selected stops." };
        }
        const sorted = candidates
          .slice()
          .sort((a, b) => (b.frequency[band] || 0) - (a.frequency[band] || 0))
          .slice(0, 25);
        return {
          type: "table",
          columns: ["Rank", "Stop", "District", `${label} (buses/hr)`, "Routes"],
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
      label: "Stops by postcode district",
      run: (rows, context) => {
        const band = context?.frequencyBand || "peak_am";
        const label = FREQUENCY_BANDS.find((entry) => entry.key === band)?.label || band;
        const summary = new Map();
        rows.forEach((row) => {
          const district = row.district || "Unknown";
          if (!summary.has(district)) {
            summary.set(district, { count: 0, withRoutes: 0, routeTotal: 0, freqTotal: 0, freqCount: 0 });
          }
          const entry = summary.get(district);
          entry.count += 1;
          entry.routeTotal += row.route_count;
          if (row.route_count > 0) {
            entry.withRoutes += 1;
          }
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
              entry.withRoutes,
              formatNumber(avgRoutes, 2),
              avgFreq === null ? "" : formatNumber(avgFreq, 1)
            ];
          })
          .sort((a, b) => (b[1] || 0) - (a[1] || 0));
        return {
          type: "table",
          columns: ["District", "Stops", "Stops w/ routes", "Avg routes", `Avg ${label}`],
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
          columns: ["District", "Stops", "Avg routes"],
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
          columns: ["Routes per stop", "Stops"],
          rows: buildDistribution(rows)
        };
      }
    }
  };

  const PRESETS = [
    {
      id: "connectivity-hotspots",
      name: "Connectivity hotspots",
      description: "Top connected stops and frequency leaders.",
      icon: "++",
      analysisIds: ["top-stops-routes", "top-stops-frequency"]
    },
    {
      id: "coverage-gaps",
      name: "Coverage gaps",
      description: "Areas with low route density.",
      icon: "--",
      analysisIds: ["district-coverage-gaps"]
    },
    {
      id: "district-overview",
      name: "District overview",
      description: "Stops, routes, and distribution snapshot.",
      icon: "##",
      analysisIds: ["district-stop-counts", "routes-per-stop-distribution"]
    }
  ];

  const state = {
    stops: [],
    filteredStops: [],
    frequencyBand: "peak_am",
    frequencyAvailable: false,
    currentAnalysisIds: [],
    resultsByKey: new Map(),
    debounceHandle: null,
    districtTokens: [],
    moduleOpen: true
  };

  const buildFilterSpec = (els) => {
    const scope = els.scopeSelect?.value || "all";
    const districts = state.districtTokens.slice();
    const minRoutes = parseNumberInput(els.minRoutes);
    const maxRoutes = parseNumberInput(els.maxRoutes);
    return {
      scope,
      districts,
      minRoutes,
      maxRoutes
    };
  };

  const applyFilters = (rows, spec) => {
    const list = Array.isArray(rows) ? rows : [];
    const districtSet = spec.districts && spec.districts.length > 0
      ? new Set(spec.districts)
      : null;
    return list.filter((row) => {
      if (spec.scope === "with_routes" && row.route_count <= 0) {
        return false;
      }
      if (districtSet && !districtSet.has(row.district)) {
        return false;
      }
      if (Number.isFinite(spec.minRoutes) && row.route_count < spec.minRoutes) {
        return false;
      }
      if (Number.isFinite(spec.maxRoutes) && row.route_count > spec.maxRoutes) {
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
    const withRoutes = rows.filter((row) => row.route_count > 0).length;
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
      { label: "Total stops", value: total },
      { label: "Stops with routes", value: withRoutes },
      { label: "Avg routes per stop", value: formatNumber(avgRoutes, 2) },
      { label: "Median routes per stop", value: medianRoutes }
    ];
    if (context?.frequencyAvailable) {
      summaryLines.push({
        label: `Avg ${label}`,
        value: avgFreq === null ? "n/a" : formatNumber(avgFreq, 1)
      });
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
        const result = entry.run(rows, context);
        return { id: analysisId, title: entry.label, result };
      })
      .filter(Boolean);
  };

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
  };

  const renderPresetCards = (container) => {
    if (!container) {
      return;
    }
    container.innerHTML = PRESETS.map((preset) => {
      const disabled = preset.analysisIds.some((analysisId) => {
        const entry = analysisRegistry[analysisId];
        return entry?.requiresFrequency && !state.frequencyAvailable;
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
      const suffix = entry.requiresFrequency && !state.frequencyAvailable ? " (needs frequency data)" : "";
      return `<option value="${escapeHtml(entry.id)}">${escapeHtml(entry.label + suffix)}</option>`;
    });
    selectEl.innerHTML = options.join("");
  };

  const updateScopeNote = (noteEl, count) => {
    if (!noteEl) {
      return;
    }
    noteEl.textContent = `Analyzing ${count} stops.`;
  };

  const syncMapStops = () => {
    const api = window.RouteMapsterAPI;
    if (!api) {
      return;
    }
    if (!state.moduleOpen || !state.filteredStops || state.filteredStops.length === 0) {
      if (typeof api.clearAdvancedStops === "function") {
        api.clearAdvancedStops();
      }
      return;
    }
    if (typeof api.showAdvancedStops === "function") {
      api.showAdvancedStops(state.filteredStops);
    }
  };

  const applyFiltersAndRefresh = (els) => {
    const spec = buildFilterSpec(els);
    const filtered = applyFilters(state.stops, spec);
    state.filteredStops = filtered;
    renderSummary(els.summary, filtered, {
      frequencyBand: state.frequencyBand,
      frequencyAvailable: state.frequencyAvailable
    });
    updateScopeNote(els.scopeNote, filtered.length);
    if (state.currentAnalysisIds.length > 0) {
      const results = runAnalyses(state.currentAnalysisIds, filtered, {
        frequencyBand: state.frequencyBand,
        frequencyAvailable: state.frequencyAvailable
      });
      renderResults(els.output, results);
    }
    syncMapStops();
  };

  const scheduleRefresh = (els) => {
    if (state.debounceHandle) {
      window.clearTimeout(state.debounceHandle);
    }
    state.debounceHandle = window.setTimeout(() => {
      applyFiltersAndRefresh(els);
    }, DEBOUNCE_MS);
  };

  const initStopAnalyses = async (container) => {
    if (!container) {
      return;
    }
    const target = container.querySelector ? (container.querySelector("#stopAnalysesContainer") || container) : container;
    target.innerHTML = `
      <div class="module-note" id="stopAnalysisStatus">Loading stop datasets...</div>
      <div class="module-section">
        <div class="section-title">Scope</div>
        <div class="field">
          <label for="stopScope">Stop scope</label>
          <select id="stopScope" class="select-field">
            <option value="all">All stops</option>
            <option value="with_routes">Stops with routes</option>
          </select>
        </div>
        <div id="stopScopeNote" class="module-note">Analyzing 0 stops.</div>
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
          <label>Routes per stop</label>
          <div class="field-row">
            <input id="stopMinRoutes" type="number" min="0" step="1" placeholder="Min" />
            <input id="stopMaxRoutes" type="number" min="0" step="1" placeholder="Max" />
          </div>
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
        <div class="section-title">Presets</div>
        <div id="stopAnalysisPresets" class="preset-grid"></div>
      </div>
      <div class="module-section">
        <div class="section-title">Summary</div>
        <div id="stopAnalysisSummary"></div>
      </div>
      <div class="module-section">
        <div class="section-title">Analysis tools</div>
        <div class="analysis-toolbar">
          <select id="stopAnalysisSelect" class="select-field"></select>
          <button id="runStopAnalysis" class="ghost-button compact" type="button">Run analysis</button>
        </div>
        <div id="stopAnalysisOutput" class="analysis-output"></div>
      </div>
    `;

    const els = {
      status: target.querySelector("#stopAnalysisStatus"),
      scopeSelect: target.querySelector("#stopScope"),
      scopeNote: target.querySelector("#stopScopeNote"),
      districtEntry: target.querySelector("#stopDistrictEntry"),
      districtTags: target.querySelector("#stopDistrictTags"),
      districtOptions: target.querySelector("#stopDistrictOptions"),
      minRoutes: target.querySelector("#stopMinRoutes"),
      maxRoutes: target.querySelector("#stopMaxRoutes"),
      frequencyBand: target.querySelector("#stopFrequencyBand"),
      frequencyNote: target.querySelector("#stopFrequencyNote"),
      presets: target.querySelector("#stopAnalysisPresets"),
      summary: target.querySelector("#stopAnalysisSummary"),
      analysisSelect: target.querySelector("#stopAnalysisSelect"),
      runButton: target.querySelector("#runStopAnalysis"),
      output: target.querySelector("#stopAnalysisOutput")
    };

    const moduleEl = target.closest("details");
    state.moduleOpen = moduleEl ? moduleEl.open : true;
    if (moduleEl) {
      moduleEl.addEventListener("toggle", () => {
        state.moduleOpen = moduleEl.open;
        syncMapStops();
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

    FREQUENCY_BANDS.forEach((band) => {
      if (els.frequencyBand) {
        els.frequencyBand.innerHTML += `<option value="${escapeHtml(band.key)}">${escapeHtml(band.label)}</option>`;
      }
    });

    try {
      const [geojson, frequencyData] = await Promise.all([
        loadStopsGeojson(),
        loadFrequencyData().catch(() => null)
      ]);

      state.frequencyAvailable = Boolean(frequencyData);
      state.stops = buildStopsFromGeojson(geojson, frequencyData);

      const districtSet = new Set(state.stops.map((row) => row.district).filter(Boolean));
      if (els.districtOptions) {
        const options = Array.from(districtSet)
          .sort((a, b) => String(a).localeCompare(String(b)))
          .map((district) => `<option value="${escapeHtml(district)}"></option>`)
          .join("");
        els.districtOptions.innerHTML = options;
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
        els.status.textContent = `Loaded ${state.stops.length} stops.`;
      }
    } catch (error) {
      state.stops = [];
      if (els.status) {
        els.status.textContent = "Failed to load stop datasets.";
      }
    }

    state.filteredStops = state.stops.slice();
    buildAnalysisOptions(els.analysisSelect);
    renderPresetCards(els.presets);
    renderSummary(els.summary, state.filteredStops, {
      frequencyBand: state.frequencyBand,
      frequencyAvailable: state.frequencyAvailable
    });
    updateScopeNote(els.scopeNote, state.filteredStops.length);
    syncMapStops();

    const runSelectedAnalysis = () => {
      if (!els.analysisSelect) {
        return;
      }
      const analysisId = els.analysisSelect.value;
      state.currentAnalysisIds = [analysisId];
      const results = runAnalyses(state.currentAnalysisIds, state.filteredStops, {
        frequencyBand: state.frequencyBand,
        frequencyAvailable: state.frequencyAvailable
      });
      renderResults(els.output, results);
    };

    if (els.runButton) {
      els.runButton.addEventListener("click", runSelectedAnalysis);
    }

    if (els.analysisSelect) {
      els.analysisSelect.addEventListener("change", runSelectedAnalysis);
    }

    if (els.presets) {
      els.presets.addEventListener("click", (event) => {
        const card = event.target.closest(".preset-card");
        if (!card) {
          return;
        }
        const presetId = card.dataset.preset;
        const preset = PRESETS.find((entry) => entry.id === presetId);
        if (!preset) {
          return;
        }
        state.currentAnalysisIds = preset.analysisIds.slice();
        const results = runAnalyses(state.currentAnalysisIds, state.filteredStops, {
          frequencyBand: state.frequencyBand,
          frequencyAvailable: state.frequencyAvailable
        });
        renderResults(els.output, results);
      });
    }

    if (els.output) {
      els.output.addEventListener("click", (event) => {
        const button = event.target.closest(".analysis-export");
        if (!button) {
          return;
        }
        const key = button.dataset.analysisKey;
        const entry = state.resultsByKey.get(key);
        if (!entry || entry.result?.type !== "table") {
          return;
        }
        downloadCsv("stop_analysis.csv", entry.result.columns, entry.result.rows);
      });
    }

    if (els.frequencyBand) {
      els.frequencyBand.addEventListener("change", (event) => {
        state.frequencyBand = event.target.value || "peak_am";
        renderSummary(els.summary, state.filteredStops, {
          frequencyBand: state.frequencyBand,
          frequencyAvailable: state.frequencyAvailable
        });
        if (state.currentAnalysisIds.length > 0) {
          const results = runAnalyses(state.currentAnalysisIds, state.filteredStops, {
            frequencyBand: state.frequencyBand,
            frequencyAvailable: state.frequencyAvailable
          });
          renderResults(els.output, results);
        }
      });
    }

    const inputs = target.querySelectorAll("input, select");
    inputs.forEach((input) => {
      if (input === els.frequencyBand || input === els.analysisSelect || input === els.districtEntry) {
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
