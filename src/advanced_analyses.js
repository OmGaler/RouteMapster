(() => {
  const escapeHtml = (value) => String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

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

  const renderTable = (result) => {
    const columns = result.columns || [];
    const rows = result.rows || [];
    const header = columns.map((col) => `<th>${escapeHtml(col)}</th>`).join("");
    const body = rows.map((row) => {
      const cells = row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("");
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

  const getRoutePillClass = (routeId) => {
    const api = window.RouteMapsterAPI;
    if (api && typeof api.getRoutePillClass === "function") {
      return api.getRoutePillClass(routeId, api.appState?.networkRouteSets || null);
    }
    return "regular";
  };

  const renderRoutePill = (routeId) => {
    const className = getRoutePillClass(routeId);
    return `<span class="route-pill route-pill--${escapeHtml(className)}">${escapeHtml(routeId)}</span>`;
  };

  const renderRoutePillList = (result) => {
    const groups = Array.isArray(result.groups) ? result.groups : [];
    if (groups.length === 0) {
      return `<div class="info-empty">${escapeHtml(result.emptyMessage || "No shared endpoint pairs found.")}</div>`;
    }
    const buildSortKey = (route) => {
      const rawId = String(route?.id || route?.routeId || route?.route || route || "").trim().toUpperCase();
      const type = String(route?.type || route?.route_type || "").trim().toLowerCase();
      if (!rawId) {
        return [9, "", 0, ""];
      }
      if (/^\d+$/.test(rawId)) {
        const value = Number(rawId);
        if (type === "school" || (value >= 600 && value <= 699)) {
          return [1, "", value, rawId];
        }
        return [0, "", value, rawId];
      }
      if (rawId.startsWith("SL")) {
        const num = Number(rawId.slice(2)) || 0;
        return [3, "SL", num, rawId];
      }
      if (rawId.startsWith("N") || type === "night") {
        const num = Number(rawId.slice(1)) || 0;
        return [4, "N", num, rawId];
      }
      if (type === "school") {
        const match = rawId.match(/^([A-Z]+)(\d+)?(.*)$/);
        if (match) {
          return [1, match[1], Number(match[2] || 0), match[3] || ""];
        }
        return [1, rawId, 0, ""];
      }
      const match = rawId.match(/^([A-Z]+)(\d+)?(.*)$/);
      if (match) {
        return [2, match[1], Number(match[2] || 0), match[3] || ""];
      }
      return [9, rawId, 0, ""];
    };

    const compareRoutes = (a, b) => {
      const keyA = buildSortKey(a);
      const keyB = buildSortKey(b);
      const len = Math.max(keyA.length, keyB.length);
      for (let i = 0; i < len; i += 1) {
        if (keyA[i] < keyB[i]) {
          return -1;
        }
        if (keyA[i] > keyB[i]) {
          return 1;
        }
      }
      return 0;
    };

    const formatEndpointAttr = (endpoint) => {
      if (!Array.isArray(endpoint) || endpoint.length < 2) {
        return "";
      }
      const lat = Number(endpoint[0]);
      const lon = Number(endpoint[1]);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        return "";
      }
      return `${lat},${lon}`;
    };
    const rows = groups.map((group) => {
      const routes = Array.isArray(group?.routes) ? group.routes : Array.isArray(group) ? group : [];
      const sortedRoutes = routes.slice().sort(compareRoutes);
      const pills = sortedRoutes
        .map((route) => renderRoutePill(route?.id || route?.routeId || route?.route || route))
        .join("");
      const endpointA = formatEndpointAttr(group?.endpoints?.a);
      const endpointB = formatEndpointAttr(group?.endpoints?.b);
      const endpointKey = group?.key ? String(group.key) : "";
      return `
        <div class="analysis-pill-row" data-endpoint-a="${escapeHtml(endpointA)}" data-endpoint-b="${escapeHtml(endpointB)}" data-endpoint-key="${escapeHtml(endpointKey)}">
          <div class="route-pill-group">${pills}</div>
        </div>
      `;
    }).join("");
    return `<div class="analysis-pill-list">${rows}</div>`;
  };

  const state = {
    allRows: [],
    filteredRows: [],
    resultsByKey: new Map(),
    currentScope: "filtered"
  };

  const resolveBaseRows = (scope) => {
    if (scope === "all") {
      return state.allRows;
    }
    if (state.filteredRows && state.filteredRows.length > 0) {
      return state.filteredRows;
    }
    return state.allRows;
  };

  const runAnalyses = (analysisIds, baseRows, filterSpec) => {
    const engine = window.RouteMapsterQueryEngine;
    const registry = window.RouteMapsterAnalyses?.analysisRegistry || {};
    let rows = baseRows;
    if (filterSpec && engine) {
      rows = engine.computeDerivedFields(engine.applyFilters(baseRows, filterSpec));
    }
    const ids = Array.isArray(analysisIds) ? analysisIds : [analysisIds];
    return ids
      .map((analysisId) => {
        const entry = registry[analysisId];
        if (!entry) {
          return null;
        }
        const result = entry.run(rows);
        return { id: analysisId, title: entry.label, result };
      })
      .filter(Boolean);
  };

  const ensureSpatialForRows = async (rows) => {
    const api = window.RouteMapsterAPI;
    if (!api || typeof api.loadRouteSpatialStats !== "function") {
      return;
    }
    const pending = rows.filter((row) => {
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
        const row = pending[index];
        index += 1;
        const routeId = row.route_id_norm || row.route_id;
        if (!routeId) {
          continue;
        }
        const stats = await api.loadRouteSpatialStats(routeId);
        if (stats) {
          Object.assign(row, stats);
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

  const ensureSpatialForAnalyses = async (analysisIds, baseRows) => {
    const registry = window.RouteMapsterAnalyses?.analysisRegistry || {};
    const ids = Array.isArray(analysisIds) ? analysisIds : [analysisIds];
    const requiresSpatial = ids.some((analysisId) => registry[analysisId]?.requiresSpatial);
    if (requiresSpatial) {
      await ensureSpatialForRows(baseRows);
    }
  };

  const renderResults = (container, results) => {
    state.resultsByKey.clear();
    if (!container) {
      return;
    }
    const api = window.RouteMapsterAPI;
    if (api && typeof api.clearEndpointHighlight === "function") {
      api.clearEndpointHighlight();
    }
    if (!results || results.length === 0) {
      container.innerHTML = '<div class="info-empty">No analysis results yet.</div>';
      if (api && typeof api.clearAnalysisRoutes === "function") {
        api.clearAnalysisRoutes();
      }
      return;
    }
    const blocks = results.map((entry, index) => {
      const key = `${entry.id}-${index}`;
      state.resultsByKey.set(key, entry);
      const exportBtn = entry.result?.type === "table"
        ? `<button type="button" class="ghost-button compact analysis-export" data-analysis-key="${escapeHtml(key)}">Export CSV</button>`
        : "";
      let content = '<div class="info-empty">Chart rendering not available yet.</div>';
      if (entry.result?.type === "table") {
        content = renderTable(entry.result);
      } else if (entry.result?.type === "route-pills") {
        content = renderRoutePillList(entry.result);
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
    if (api && typeof api.showAnalysisRoutes === "function") {
      const shared = results.find((entry) => entry.id === "shared-endpoints" && entry.result?.type === "route-pills");
      if (shared) {
        const routeIds = new Set();
        const groups = Array.isArray(shared.result.groups) ? shared.result.groups : [];
        groups.forEach((group) => {
          const routes = Array.isArray(group?.routes) ? group.routes : Array.isArray(group) ? group : [];
          routes.forEach((route) => {
            const id = route?.id || route?.routeId || route?.route || route;
            if (id) {
              routeIds.add(id);
            }
          });
        });
        api.showAnalysisRoutes(Array.from(routeIds));
      } else if (typeof api.clearAnalysisRoutes === "function") {
        api.clearAnalysisRoutes();
      }
    }
  };

  const initAdvancedAnalyses = async (container, appState) => {
    const engine = window.RouteMapsterQueryEngine;
    const analyses = window.RouteMapsterAnalyses;
    if (!container || !engine || !analyses) {
      return;
    }

    const els = {
      scopeSelect: container.querySelector("#analysisScope"),
      presetWrap: container.querySelector("#analysisPresets"),
      analysisSelect: container.querySelector("#analysisSelect"),
      runButton: container.querySelector("#runAnalysis"),
      output: container.querySelector("#analysisOutput"),
      scopeNote: container.querySelector("#analysisScopeNote")
    };

    const baseRows = await engine.loadRouteSummary();
    state.allRows = engine.computeDerivedFields(baseRows);

    const analysisOptions = analyses.getAnalyses();
    if (els.analysisSelect) {
      els.analysisSelect.innerHTML = analysisOptions
        .map((analysis) => `<option value="${escapeHtml(analysis.id)}">${escapeHtml(analysis.label)}</option>`)
        .join("");
    }

    if (els.presetWrap && window.RouteMapsterPresets) {
      const presets = window.RouteMapsterPresets.getPresets();
      els.presetWrap.innerHTML = presets.map((preset) => {
        return `
          <button type="button" class="preset-card" data-preset="${escapeHtml(preset.id)}">
            <div class="preset-card__icon">${escapeHtml(preset.icon)}</div>
            <div class="preset-card__title">${escapeHtml(preset.name)}</div>
            <div class="preset-card__desc">${escapeHtml(preset.description)}</div>
          </button>
        `;
      }).join("");

      els.presetWrap.addEventListener("click", async (event) => {
        const card = event.target.closest(".preset-card");
        if (!card) {
          return;
        }
        const presetId = card.dataset.preset;
        const preset = presets.find((item) => item.id === presetId);
        if (!preset) {
          return;
        }
        const scope = els.scopeSelect?.value || "filtered";
        const base = resolveBaseRows(scope);
        await ensureSpatialForAnalyses(preset.analysisId, base);
        const results = runAnalyses(preset.analysisId, base, preset.filterSpec);
        renderResults(els.output, results);
      });
    }

    const runSelectedAnalysis = async () => {
      const scope = els.scopeSelect?.value || "filtered";
      const base = resolveBaseRows(scope);
      const analysisId = els.analysisSelect?.value;
      await ensureSpatialForAnalyses(analysisId, base);
      const results = runAnalyses(analysisId, base, null);
      renderResults(els.output, results);
      if (els.scopeNote) {
        const count = base.length || 0;
        els.scopeNote.textContent = scope === "all"
          ? `Analyzing all routes (${count}).`
          : `Analyzing filtered subset (${count}).`;
      }
    };

    if (els.runButton) {
      els.runButton.addEventListener("click", () => {
        runSelectedAnalysis().catch(() => {});
      });
    }

    if (els.scopeSelect) {
      els.scopeSelect.addEventListener("change", () => {
        state.currentScope = els.scopeSelect.value;
        runSelectedAnalysis().catch(() => {});
      });
    }

    if (els.output) {
      els.output.addEventListener("click", (event) => {
        const button = event.target.closest(".analysis-export");
        if (!button) {
          const row = event.target.closest(".analysis-pill-row");
          if (!row) {
            return;
          }
          const endpointA = row.dataset.endpointA || "";
          const endpointB = row.dataset.endpointB || "";
          const parseEndpoint = (value) => {
            if (!value) {
              return null;
            }
            const parts = value.split(",").map((token) => Number(token));
            if (parts.length < 2 || !Number.isFinite(parts[0]) || !Number.isFinite(parts[1])) {
              return null;
            }
            return [parts[0], parts[1]];
          };
          const a = parseEndpoint(endpointA);
          const b = parseEndpoint(endpointB);
          if (!a && !b) {
            return;
          }
          const api = window.RouteMapsterAPI;
          if (!api || typeof api.showEndpointPairOnMap !== "function") {
            return;
          }
          const active = row.classList.contains("is-active");
          Array.from(els.output.querySelectorAll(".analysis-pill-row.is-active")).forEach((el) => {
            el.classList.remove("is-active");
          });
          if (active) {
            if (typeof api.clearEndpointHighlight === "function") {
              api.clearEndpointHighlight();
            }
            return;
          }
          row.classList.add("is-active");
          api.showEndpointPairOnMap({ a, b });
          return;
        }
        const key = button.dataset.analysisKey;
        const entry = state.resultsByKey.get(key);
        if (!entry || entry.result?.type !== "table") {
          return;
        }
        downloadCsv("analysis.csv", entry.result.columns, entry.result.rows);
      });
    }

    document.addEventListener("routeFiltersUpdated", (event) => {
      const detail = event.detail || {};
      state.filteredRows = detail.rows || [];
      if (els.scopeSelect?.value === "filtered") {
        runSelectedAnalysis().catch(() => {});
      }
    });

    runSelectedAnalysis().catch(() => {});
  };

  window.RouteMapsterAdvancedAnalyses = {
    initAdvancedAnalyses
  };
})();

