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
      const content = entry.result?.type === "table"
        ? renderTable(entry.result)
        : '<div class="info-empty">Chart rendering not available yet.</div>';
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

      els.presetWrap.addEventListener("click", (event) => {
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
        const results = runAnalyses(preset.analysisId, base, preset.filterSpec);
        renderResults(els.output, results);
      });
    }

    const runSelectedAnalysis = () => {
      const scope = els.scopeSelect?.value || "filtered";
      const base = resolveBaseRows(scope);
      const analysisId = els.analysisSelect?.value;
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
      els.runButton.addEventListener("click", runSelectedAnalysis);
    }

    if (els.scopeSelect) {
      els.scopeSelect.addEventListener("change", () => {
        state.currentScope = els.scopeSelect.value;
        runSelectedAnalysis();
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
        downloadCsv("analysis.csv", entry.result.columns, entry.result.rows);
      });
    }

    document.addEventListener("routeFiltersUpdated", (event) => {
      const detail = event.detail || {};
      state.filteredRows = detail.rows || [];
      if (els.scopeSelect?.value === "filtered") {
        runSelectedAnalysis();
      }
    });

    runSelectedAnalysis();
  };

  window.RouteMapsterAdvancedAnalyses = {
    initAdvancedAnalyses
  };
})();

