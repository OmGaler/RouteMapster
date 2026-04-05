(() => {
  /**
   * Renders advanced route analyses and synchronises their map overlays.
   *
   * This module consumes the analysis registry, formats tables and pill-based
   * outputs, and translates analysis-specific overlay metadata into calls back
   * into `RouteMapsterAPI`.
   */
  const utils = window.RouteMapsterUtils || {};
  const escapeHtml = utils.escapeHtml || ((value) => String(value || ""));
  const downloadCsv = utils.downloadCsv || (() => {});

  const normaliseOverlayLabel = (value) => String(value || "").trim().toLowerCase();

  const isSafeCssColour = (value) => {
    const token = String(value || "").trim();
    return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(token)
      || /^rgb\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\)$/i.test(token)
      || /^hsl\(\s*\d+(?:\.\d+)?\s*,\s*\d+(?:\.\d+)?%\s*,\s*\d+(?:\.\d+)?%\s*\)$/i.test(token);
  };

  const resolveOperatorBrandColour = (label) => {
    const token = normaliseOverlayLabel(label).replace(/[^\w\s-]/g, " ");
    if (!token) {
      return "";
    }
    if (token.includes("metroline")) {
      return "#e53935";
    }
    if (token.includes("arriva")) {
      return "#14b8c4";
    }
    if (token.includes("go-ahead") || token.includes("go ahead")) {
      return "#facc15";
    }
    if (token.includes("first")) {
      return "#8b5cf6";
    }
    if (token.includes("stagecoach")) {
      return "#f59e0b";
    }
    if (token.includes("transport uk")) {
      return "#6b7280";
    }
    if (token.includes("uno")) {
      return "#ec4899";
    }
    return "";
  };

  const buildAnalysisGroupColour = (index = 0) => {
    const safeIndex = Number.isFinite(index) ? Math.max(0, Math.floor(index)) : 0;
    const hue = (safeIndex * 137.508) % 360;
    const saturationCycle = [84, 74, 92, 78];
    const lightnessCycle = [42, 50, 38, 56];
    const saturation = saturationCycle[safeIndex % saturationCycle.length];
    const lightness = lightnessCycle[Math.floor(safeIndex / saturationCycle.length) % lightnessCycle.length];
    return `hsl(${hue.toFixed(1)}, ${saturation}%, ${lightness}%)`;
  };

  /**
   * Normalises grouped-route overlays into a consistent renderable shape.
   *
   * @param {Array<object>} groups Overlay group definitions from an analysis result.
   * @param {string} [overlayKey=""] Overlay grouping key such as `operator`.
   * @returns {Array<object>} Sanitised groups with labels, route ids, and safe colours.
   */
  const normaliseOverlayGroups = (groups, overlayKey = "") => {
    const key = normaliseOverlayLabel(overlayKey);
    return (Array.isArray(groups) ? groups : [])
      .map((group, index) => {
        const label = String(group?.label || group?.name || "").trim();
        const routes = Array.isArray(group?.routes)
          ? Array.from(new Set(group.routes.map((routeId) => String(routeId || "").trim().toUpperCase()).filter(Boolean)))
          : [];
        const providedColor = String(group?.color || "").trim();
        const brandColor = key === "operator" ? resolveOperatorBrandColour(label) : "";
        const color = isSafeCssColour(providedColor)
          ? providedColor
          : isSafeCssColour(brandColor)
            ? brandColor
            : buildAnalysisGroupColour(index);
        return {
          ...group,
          label,
          routes,
          color
        };
      })
      .filter((group) => group.label && group.routes.length > 0);
  };

  /**
   * Builds a lookup of overlay label to colour for result-table decoration.
   *
   * @param {object} result Analysis result payload.
   * @returns {Map<string, string>|null} Lower-cased label-to-colour map, or `null` when no grouped overlay exists.
   */
  const buildOverlayLegendByLabel = (result) => {
    const overlay = result?.mapOverlay;
    if (!overlay || overlay.type !== "grouped-routes") {
      return null;
    }
    const overlayKey = String(overlay?.key || "").trim();
    const groups = normaliseOverlayGroups(overlay.groups, overlayKey);
    const coloursByLabel = new Map();
    groups.forEach((group) => {
      const label = String(group?.label || "").trim();
      if (!label) {
        return;
      }
      const color = String(group?.color || "").trim();
      coloursByLabel.set(normaliseOverlayLabel(label), color);
    });
    return coloursByLabel;
  };

  /**
   * Renders a generic analysis table with optional overlay colour markers.
   *
   * @param {object} result Table-shaped analysis result.
   * @param {string} [analysisId=""] Active analysis identifier.
   * @returns {string} HTML fragment for insertion into the analysis panel.
   */
  const renderTable = (result, analysisId = "") => {
    const columns = result.columns || [];
    const rows = result.rows || [];
    const firstColumn = String(columns[0] || "").trim().toLowerCase();
    const secondColumn = String(columns[1] || "").trim().toLowerCase();
    const showOverlayDots = analysisId === "routes-by-operator";
    const overlayLegend = showOverlayDots ? buildOverlayLegendByLabel(result) : null;
    const tableClasses = ["analysis-table"];
    if (firstColumn === "rank") {
      tableClasses.push("analysis-table--ranked");
    }
    if (firstColumn === "rank" && secondColumn === "route") {
      tableClasses.push("analysis-table--ranked-route");
    }
    const tableClass = tableClasses.join(" ");
    const header = columns.map((col) => `<th>${escapeHtml(col)}</th>`).join("");
    const body = rows.map((row) => {
      const rowCells = Array.isArray(row) ? row : [row];
      const cells = rowCells.map((cell, cellIndex) => {
        const cellText = String(cell ?? "");
        if (cellIndex === 0 && overlayLegend && overlayLegend.size > 0) {
          const color = overlayLegend.get(normaliseOverlayLabel(cellText));
          if (color) {
            return `<td><span class="analysis-group-cell"><span class="analysis-group-dot" style="--analysis-group-dot:${escapeHtml(color)}" aria-hidden="true"></span><span>${escapeHtml(cellText)}</span></span></td>`;
          }
        }
        return `<td>${escapeHtml(cellText)}</td>`;
      }).join("");
      return `<tr>${cells}</tr>`;
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

  const formatPercent = (value) => {
    if (!Number.isFinite(value)) {
      return "";
    }
    return `${Math.round(value * 100)}%`;
  };

  const toRad = (value) => (Number(value) * Math.PI) / 180;

  const haversineMeters = (a, b) => {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length < 2 || b.length < 2) {
      return Infinity;
    }
    const lat1 = Number(a[0]);
    const lon1 = Number(a[1]);
    const lat2 = Number(b[0]);
    const lon2 = Number(b[1]);
    if (![lat1, lon1, lat2, lon2].every(Number.isFinite)) {
      return Infinity;
    }
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const rLat1 = toRad(lat1);
    const rLat2 = toRad(lat2);
    const sinLat = Math.sin(dLat / 2);
    const sinLon = Math.sin(dLon / 2);
    const h = sinLat * sinLat + Math.cos(rLat1) * Math.cos(rLat2) * sinLon * sinLon;
    return 2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(h)));
  };

  const flattenSegments = (segments) => {
    if (!Array.isArray(segments)) {
      return [];
    }
    const points = [];
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
        if (Number.isFinite(lat) && Number.isFinite(lon)) {
          points.push([lat, lon]);
        }
      });
    });
    return points;
  };

  const samplePoints = (points, maxPoints = 200) => {
    if (!Array.isArray(points) || points.length <= maxPoints) {
      return points || [];
    }
    const step = Math.ceil(points.length / maxPoints);
    const sampled = [];
    for (let i = 0; i < points.length; i += step) {
      sampled.push(points[i]);
    }
    return sampled;
  };

  const computeOverlapRatio = (pointsA, pointsB, thresholdMeters = 100) => {
    if (!pointsA || !pointsB || pointsA.length === 0 || pointsB.length === 0) {
      return null;
    }
    const sampledA = samplePoints(pointsA);
    const sampledB = samplePoints(pointsB);
    const matchRatio = (source, target) => {
      let matches = 0;
      for (let i = 0; i < source.length; i += 1) {
        const point = source[i];
        let matched = false;
        for (let j = 0; j < target.length; j += 1) {
          if (haversineMeters(point, target[j]) <= thresholdMeters) {
            matched = true;
            break;
          }
        }
        if (matched) {
          matches += 1;
        }
      }
      return source.length > 0 ? matches / source.length : 0;
    };
    const ratioA = matchRatio(sampledA, sampledB);
    const ratioB = matchRatio(sampledB, sampledA);
    return (ratioA + ratioB) / 2;
  };

  const computeConfidence = (metrics, weights) => {
    const weightEntries = Object.entries(weights || {});
    let sum = 0;
    let weightSum = 0;
    weightEntries.forEach(([key, weight]) => {
      const value = metrics[key];
      if (!Number.isFinite(value)) {
        return;
      }
      sum += value * weight;
      weightSum += weight;
    });
    if (weightSum <= 0) {
      return 0;
    }
    return Math.max(0, Math.min(1, sum / weightSum));
  };

  /**
   * Lazily fills in geometry-based confidence metrics for route family rows.
   *
   * @param {HTMLElement} rowEl Rendered pill row element.
   * @param {object} group Route family group metadata from the analysis result.
   * @returns {Promise<void>}
   * Side effects: Fetches route geometry, updates loading UI, and mutates DOM content in-place.
   */
  const hydrateRouteFamilyGeometry = async (rowEl, group) => {
    if (!rowEl || !group) {
      return;
    }
    if (rowEl.dataset.geometryReady === "true") {
      return;
    }
    const api = window.RouteMapsterAPI;
    if (!api || typeof api.loadRouteGeometry !== "function") {
      return;
    }
    const routeIds = (group.routes || [])
      .map((route) => route?.id || route?.routeId || route?.route || route)
      .filter(Boolean)
      .map((routeId) => String(routeId).trim().toUpperCase())
      .filter(Boolean);
    if (routeIds.length === 0) {
      return;
    }
    rowEl.dataset.geometryReady = "loading";
    if (typeof api.setLoadingModalVisible === "function") {
      api.setLoadingModalVisible(true);
    }
    const segmentsByRoute = new Map();
    try {
      const concurrency = 4;
      let index = 0;
      const worker = async () => {
        while (index < routeIds.length) {
          const routeId = routeIds[index];
          index += 1;
          const segments = await api.loadRouteGeometry(routeId);
          segmentsByRoute.set(routeId, Array.isArray(segments) ? segments : []);
        }
      };
      await Promise.all(Array.from({ length: concurrency }, () => worker()));
    } finally {
      if (typeof api.setLoadingModalVisible === "function") {
        api.setLoadingModalVisible(false);
      }
    }
    const pointsByRoute = new Map();
    routeIds.forEach((routeId) => {
      pointsByRoute.set(routeId, flattenSegments(segmentsByRoute.get(routeId)));
    });
    const perRoute = new Map();
    let pairCount = 0;
    let overlapSum = 0;
    for (let i = 0; i < routeIds.length; i += 1) {
      for (let j = i + 1; j < routeIds.length; j += 1) {
        const routeA = routeIds[i];
        const routeB = routeIds[j];
        const pointsA = pointsByRoute.get(routeA) || [];
        const pointsB = pointsByRoute.get(routeB) || [];
        const overlap = computeOverlapRatio(pointsA, pointsB);
        if (!Number.isFinite(overlap)) {
          continue;
        }
        pairCount += 1;
        overlapSum += overlap;
        if (!perRoute.has(routeA)) {
          perRoute.set(routeA, []);
        }
        if (!perRoute.has(routeB)) {
          perRoute.set(routeB, []);
        }
        perRoute.get(routeA).push(overlap);
        perRoute.get(routeB).push(overlap);
      }
    }
    const groupOverlap = pairCount > 0 ? overlapSum / pairCount : null;
    const weights = group.weights || {};
    const analysisId = rowEl.dataset.analysisId || "";
    const allowGeometryConfidence = analysisId !== "route-families";

    const updateMetric = (container, key, value) => {
      if (!container) {
        return;
      }
      const metric = container.querySelector(`.analysis-metric[data-metric="${key}"] strong`);
      if (metric) {
        metric.textContent = Number.isFinite(value) ? `${Math.round(value * 100)}%` : "N/A";
      }
    };

    const details = rowEl.querySelector(".analysis-pill-details");
    if (details && allowGeometryConfidence) {
      updateMetric(details, "overlap", groupOverlap);
      const metrics = {
        overlap: groupOverlap,
        termini: group.metrics?.termini ?? null,
        number_series: group.metrics?.number_series ?? null
      };
      const confidence = computeConfidence(metrics, weights);
      const scorePill = rowEl.querySelector(".analysis-pill-score");
      if (scorePill && Number.isFinite(confidence)) {
        scorePill.textContent = `${Math.round(confidence * 100)}% confidence`;
      }
    }

    const perRouteNodes = rowEl.querySelectorAll(".analysis-route-metric-row[data-route-id]");
    perRouteNodes.forEach((node) => {
      const routeId = String(node.dataset.routeId || "").trim().toUpperCase();
      const overlaps = perRoute.get(routeId) || [];
      const overlapValue = overlaps.length > 0
        ? overlaps.reduce((sum, value) => sum + value, 0) / overlaps.length
        : null;
      updateMetric(node, "overlap", overlapValue);
      const metrics = {
        overlap: overlapValue,
        termini: group.per_route?.find((entry) => entry.route_id === routeId)?.metrics?.termini ?? null,
        number_series: group.per_route?.find((entry) => entry.route_id === routeId)?.metrics?.number_series ?? null
      };
      const confidence = computeConfidence(metrics, weights);
      updateMetric(node, "confidence", confidence);
    });

    rowEl.dataset.geometryReady = "true";
  };

  const renderMetricRow = (label, value, key) => {
    const display = Number.isFinite(value) ? `${(value * 100).toFixed(0)}%` : "N/A";
    const metricKey = key ? ` data-metric="${escapeHtml(key)}"` : "";
    return `<div class="analysis-metric"${metricKey}><span>${escapeHtml(label)}</span><strong>${escapeHtml(display)}</strong></div>`;
  };

  const renderRouteMetricRow = (routeId, metrics, confidence) => {
    return `
      <div class="analysis-route-metric-row" data-route-id="${escapeHtml(routeId)}">
        <div class="analysis-route-metric-id">${renderRoutePill(routeId)}</div>
        <div class="analysis-route-metric">${renderMetricRow("Overlap", metrics?.overlap, "overlap")}</div>
        <div class="analysis-route-metric">${renderMetricRow("Termini", metrics?.termini, "termini")}</div>
        <div class="analysis-route-metric">${renderMetricRow("Number series", metrics?.number_series, "number_series")}</div>
        <div class="analysis-route-metric">${renderMetricRow("Confidence", confidence, "confidence")}</div>
      </div>
    `;
  };

  const getRouteSummaryRow = (routeId) => {
    const normalised = String(routeId || "").trim().toUpperCase();
    if (!normalised) {
      return null;
    }
    const rows = Array.isArray(state.allRows) ? state.allRows : [];
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const candidate = String(row?.route_id_norm || row?.route_id || "").trim().toUpperCase();
      if (candidate === normalised) {
        return row;
      }
    }
    return null;
  };

  const cleanDestinationLabel = (value) => {
    const text = String(value || "")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^\.+/, "")
      .trim();
    if (!text) {
      return "";
    }
    const lowered = text.toLowerCase();
    if (lowered === "unknown" || lowered === "unkown" || lowered === "n/a" || lowered === "na" || lowered === "null") {
      return "";
    }
    return text;
  };

  const getRouteDestinationLines = (row) => {
    if (!row || typeof row !== "object") {
      return [];
    }
    const values = [
      cleanDestinationLabel(row.destination_outbound),
      cleanDestinationLabel(row.destination_inbound)
    ].filter(Boolean);
    return Array.from(new Set(values));
  };

  const renderSharedEndpointDetails = (routeIds) => {
    const routes = (Array.isArray(routeIds) ? routeIds : [])
      .map((routeId) => String(routeId || "").trim().toUpperCase())
      .filter(Boolean);
    if (routes.length === 0) {
      return "";
    }
    const rows = routes.map((routeId) => {
      const row = getRouteSummaryRow(routeId);
      const destinations = getRouteDestinationLines(row);
      const operator = String(row?.operator_names_arr?.[0] || row?.operator_name || "").trim();
      const routeType = String(row?.route_type || "").trim();
      const meta = [routeType, operator].filter(Boolean).join(" · ");
      return `
        <div class="analysis-route-detail-row">
          <div class="analysis-route-detail-head">
            <div class="analysis-route-detail-id">${renderRoutePill(routeId)}</div>
            ${meta ? `<div class="analysis-route-detail-meta">${escapeHtml(meta)}</div>` : ""}
          </div>
          <div class="analysis-route-destination-list">
            ${destinations.length > 0
              ? destinations.map((line) => `<div>${escapeHtml(line)}</div>`).join("")
              : '<div class="analysis-route-destination-empty">No destination summary available.</div>'}
          </div>
        </div>
      `;
    }).join("");
    return `
      <div class="analysis-pill-details" hidden>
        <div class="analysis-route-detail-list">
          ${rows}
        </div>
      </div>
    `;
  };

  const renderRoutePillList = (result, analysisId) => {
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
    const rows = groups.map((group, index) => {
      const routes = Array.isArray(group?.routes) ? group.routes : Array.isArray(group) ? group : [];
      const routeIds = routes
        .map((route) => route?.id || route?.routeId || route?.route || route)
        .filter(Boolean)
        .map((routeId) => String(routeId).trim().toUpperCase())
        .filter(Boolean);
      const sortedRoutes = routes.slice().sort(compareRoutes);
      const pills = sortedRoutes
        .map((route) => renderRoutePill(route?.id || route?.routeId || route?.route || route))
        .join("");
      const endpointA = formatEndpointAttr(group?.endpoints?.a);
      const endpointB = formatEndpointAttr(group?.endpoints?.b);
      const endpointKey = group?.key ? String(group.key) : "";
      const confidence = Number.isFinite(group?.confidence) ? formatPercent(group.confidence) : "";
      const metrics = group?.metrics || {};
      const perRoute = Array.isArray(group?.per_route) ? group.per_route : [];
      let details = "";
      if (metrics && Object.keys(metrics).length > 0) {
        details = `
          <div class="analysis-pill-details" hidden>
            <div class="analysis-metric-grid">
              ${renderMetricRow("Overlap", metrics.overlap, "overlap")}
              ${renderMetricRow("Termini", metrics.termini, "termini")}
              ${renderMetricRow("Number series", metrics.number_series, "number_series")}
            </div>
            <div class="module-note">Confidence is a weighted heuristic based on the metrics above.</div>
            ${perRoute.length > 0
              ? `
                <div class="analysis-route-metrics">
                  ${perRoute.map((entry) => renderRouteMetricRow(entry.route_id, entry.metrics, entry.confidence)).join("")}
                </div>
              `
              : ""
            }
          </div>
        `;
      } else if (analysisId === "shared-endpoints") {
        details = renderSharedEndpointDetails(
          sortedRoutes.map((route) => route?.id || route?.routeId || route?.route || route)
        );
      }
      return `
        <div class="analysis-pill-row" data-endpoint-a="${escapeHtml(endpointA)}" data-endpoint-b="${escapeHtml(endpointB)}" data-endpoint-key="${escapeHtml(endpointKey)}" data-route-ids="${escapeHtml(routeIds.join("|"))}" data-analysis-id="${escapeHtml(analysisId || "")}" data-group-index="${escapeHtml(String(index))}">
          <div class="analysis-pill-row__header">
            <div class="route-pill-group">${pills}</div>
            ${confidence ? `<span class="analysis-pill-score">${escapeHtml(confidence)} confidence</span>` : ""}
          </div>
          ${details}
        </div>
      `;
    }).join("");
    return `<div class="analysis-pill-list">${rows}</div>`;
  };

  const state = {
    allRows: [],
    filteredRows: [],
    resultsByKey: new Map(),
    analysisById: new Map(),
    currentScope: "filtered",
    hasRun: false
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

  /**
   * Runs one or more registered analyses against the chosen scope.
   *
   * @param {string|string[]} analysisIds Analysis identifier or identifiers.
   * @param {Array<object>} baseRows Rows for the chosen scope.
   * @param {object|null} filterSpec Optional additional filter spec applied before analysis.
   * @param {object} [context={}] Additional runtime context shared with analyses.
   * @returns {Promise<Array<object>>} Render-ready analysis result wrappers.
   */
  const runAnalyses = async (analysisIds, baseRows, filterSpec, context = {}) => {
    const engine = window.RouteMapsterQueryEngine;
    const registry = window.RouteMapsterAnalyses?.analysisRegistry || {};
    let rows = baseRows;
    if (filterSpec && engine) {
      rows = engine.computeDerivedFields(engine.applyFilters(baseRows, filterSpec));
    }
    const ids = Array.isArray(analysisIds) ? analysisIds : [analysisIds];
    const results = await Promise.all(ids.map(async (analysisId) => {
        const entry = registry[analysisId];
        if (!entry) {
          return null;
        }
        try {
          const result = await entry.run(rows, context);
          return { id: analysisId, title: entry.label, result };
        } catch (error) {
          return {
            id: analysisId,
            title: entry.label,
            result: { type: "note", message: "Analysis failed." }
          };
        }
      }));
    return results.filter(Boolean);
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

  /**
   * Renders analysis output blocks and mirrors their overlays onto the map.
   *
   * @param {HTMLElement} container Output container element.
   * @param {Array<object>} results Completed analysis result wrappers.
   * @returns {void}
   * Side effects: Rewrites DOM content, updates local caches, and may redraw map overlays.
   */
  const renderResults = (container, results) => {
    state.resultsByKey.clear();
    state.analysisById.clear();
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
      state.analysisById.set(entry.id, entry);
      const exportBtn = entry.result?.type === "table"
        ? `<button type="button" class="ghost-button compact analysis-export" data-analysis-key="${escapeHtml(key)}">Export CSV</button>`
        : "";
      let content = '<div class="info-empty">Chart rendering not available yet.</div>';
      if (entry.result?.type === "table") {
        content = renderTable(entry.result, entry.id);
      } else if (entry.result?.type === "note") {
        content = `<div class="module-note">${escapeHtml(entry.result.message || "No result.")}</div>`;
      } else if (entry.result?.type === "route-pills") {
        content = renderRoutePillList(entry.result, entry.id);
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
    if (api && typeof api.showAnalysisRoutes === "function") {
      const groupedResult = results.find((entry) => entry?.result?.mapOverlay?.type === "grouped-routes");
      if (groupedResult?.result?.mapOverlay) {
        const grouped = groupedResult.result.mapOverlay;
        const overlayKey = normaliseOverlayLabel(grouped.key || "group");
        const groups = normaliseOverlayGroups(grouped.groups, overlayKey);
        const routeIds = new Set();
        groups.forEach((group) => {
          const routes = Array.isArray(group?.routes) ? group.routes : [];
          routes.forEach((routeId) => {
            if (!routeId) {
              return;
            }
            routeIds.add(String(routeId).trim().toUpperCase());
          });
        });
        if (routeIds.size > 0) {
          if (overlayKey === "garage") {
            api.showAnalysisRoutes(Array.from(routeIds), {
              endpointMarkerMode: "base-threshold"
            });
          } else {
            api.showAnalysisRoutes(Array.from(routeIds), {
              groups,
              groupLabel: grouped.key || "group",
              endpointMarkerMode: overlayKey === "operator" ? "base-threshold" : "filtered"
            });
          }
        } else if (typeof api.clearAnalysisRoutes === "function") {
          api.clearAnalysisRoutes();
        }
        return;
      }

      const routeListResult = results.find((entry) => entry?.result?.mapOverlay?.type === "route-list");
      if (routeListResult?.result?.mapOverlay) {
        const overlay = routeListResult.result.mapOverlay;
        const routeIds = Array.isArray(overlay.routeIds)
          ? Array.from(new Set(
            overlay.routeIds
              .map((routeId) => String(routeId || "").trim().toUpperCase())
              .filter(Boolean)
          ))
          : [];
        if (routeIds.length > 0) {
          api.showAnalysisRoutes(routeIds);
        } else if (typeof api.clearAnalysisRoutes === "function") {
          api.clearAnalysisRoutes();
        }
        return;
      }

      const routeIds = new Set();
      let endpointMarkerMode = "filtered";
      results.forEach((entry) => {
        if (entry?.result?.type !== "route-pills") {
          return;
        }
        if (entry?.id === "route-families") {
          endpointMarkerMode = "base-threshold";
        }
        const groups = Array.isArray(entry.result.groups) ? entry.result.groups : [];
        groups.forEach((group) => {
          const routes = Array.isArray(group?.routes) ? group.routes : Array.isArray(group) ? group : [];
          routes.forEach((route) => {
            const id = route?.id || route?.routeId || route?.route || route;
            if (id) {
              routeIds.add(id);
            }
          });
        });
      });
      if (routeIds.size > 0) {
        api.showAnalysisRoutes(Array.from(routeIds), { endpointMarkerMode });
      } else if (typeof api.clearAnalysisRoutes === "function") {
        api.clearAnalysisRoutes();
      }
    }
  };

  /**
   * Initialises the advanced analyses panel and wires its event handlers.
   *
   * @param {HTMLElement} container Module container element.
   * @param {object} appState Shared application state from `app.js`.
   * @returns {Promise<void>}
   * Side effects: Loads route summary data, binds DOM events, and updates analysis/map state.
   */
  const initAdvancedAnalyses = async (container, appState) => {
    const engine = window.RouteMapsterQueryEngine;
    const analyses = window.RouteMapsterAnalyses;
    if (!container || !engine || !analyses) {
      return;
    }

    const els = {
      scopeSelect: container.querySelector("#analysisScope"),
      analysisSelect: container.querySelector("#analysisSelect"),
      runButton: container.querySelector("#runAnalysis"),
      clearButton: container.querySelector("#clearAnalysisHighlights"),
      output: container.querySelector("#analysisOutput"),
      scopeNote: container.querySelector("#analysisScopeNote")
    };

    const baseRows = await engine.loadRouteSummary();
    state.allRows = engine.computeDerivedFields(baseRows);

    const analysisOptions = analyses.getAnalyses()
      .filter((analysis) => analysis.id !== "route-family-series");
    if (els.analysisSelect) {
      els.analysisSelect.innerHTML = analysisOptions
        .map((analysis) => `<option value="${escapeHtml(analysis.id)}">${escapeHtml(analysis.label)}</option>`)
        .join("");
    }
    if (els.output && !String(els.output.innerHTML || "").trim()) {
      els.output.innerHTML = '<div class="info-empty">No analysis results yet.</div>';
    }

    const updateScopeNote = () => {
      if (!els.scopeNote) {
        return;
      }
      const scope = els.scopeSelect?.value || "filtered";
      const base = resolveBaseRows(scope);
      const count = base.length || 0;
      els.scopeNote.textContent = scope === "all"
        ? `Ready to analyse all routes (${count}).`
        : `Ready to analyse filtered subset (${count}).`;
    };

    const runSelectedAnalysis = async () => {
      const scope = els.scopeSelect?.value || "filtered";
      const base = resolveBaseRows(scope);
      const analysisId = els.analysisSelect?.value;
      await ensureSpatialForAnalyses(analysisId, base);
      const results = await runAnalyses(analysisId, base, null, { allRows: state.allRows });
      renderResults(els.output, results);
      state.hasRun = true;
      if (els.scopeNote) {
        const count = base.length || 0;
        els.scopeNote.textContent = scope === "all"
          ? `Analysing all routes (${count}).`
          : `Analysing filtered subset (${count}).`;
      }
    };

    const clearMapHighlights = () => {
      const api = window.RouteMapsterAPI;
      if (api && typeof api.clearAnalysisRoutes === "function") {
        api.clearAnalysisRoutes();
      }
      if (api && typeof api.clearEndpointHighlight === "function") {
        api.clearEndpointHighlight();
      }
      if (!els.output) {
        return;
      }
      Array.from(els.output.querySelectorAll(".analysis-pill-row")).forEach((row) => {
        row.classList.remove("is-active");
        const details = row.querySelector(".analysis-pill-details");
        if (details) {
          details.hidden = true;
        }
      });
    };

    if (els.runButton) {
      els.runButton.addEventListener("click", () => {
        runSelectedAnalysis().catch(() => {});
      });
    }

    if (els.clearButton) {
      els.clearButton.addEventListener("click", () => {
        clearMapHighlights();
      });
    }

    if (els.scopeSelect) {
      els.scopeSelect.addEventListener("change", () => {
        state.currentScope = els.scopeSelect.value;
        if (state.hasRun) {
          runSelectedAnalysis().catch(() => {});
          return;
        }
        updateScopeNote();
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
          const routeIdsRaw = row.dataset.routeIds || "";
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
          const api = window.RouteMapsterAPI;
          if (!api) {
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
            if (typeof api.clearAnalysisRoutes === "function") {
              api.clearAnalysisRoutes();
            }
            const details = row.querySelector(".analysis-pill-details");
            if (details) {
              details.hidden = true;
            }
            return;
          }
          row.classList.add("is-active");
          const details = row.querySelector(".analysis-pill-details");
          if (details) {
            details.hidden = false;
          }
          const analysisId = row.dataset.analysisId || "";
          const groupIndex = Number(row.dataset.groupIndex);
          if (analysisId === "route-families" && Number.isFinite(groupIndex)) {
            const entry = state.analysisById.get(analysisId);
            const group = entry?.result?.groups?.[groupIndex];
            if (group) {
              hydrateRouteFamilyGeometry(row, group).catch(() => {});
            }
          }
          if (a || b) {
            if (typeof api.showEndpointPairOnMap === "function") {
              api.showEndpointPairOnMap({ a, b });
            }
          } else if (routeIdsRaw) {
            const routeIds = routeIdsRaw.split("|").map((token) => token.trim()).filter(Boolean);
            if (routeIds.length > 0 && typeof api.showAnalysisRoutes === "function") {
              api.showAnalysisRoutes(routeIds, {
                endpointMarkerMode: analysisId === "route-families" ? "base-threshold" : "filtered"
              });
            }
          }
          Array.from(els.output.querySelectorAll(".analysis-pill-row")).forEach((el) => {
            if (el === row) {
              return;
            }
            el.classList.remove("is-active");
            const siblingDetails = el.querySelector(".analysis-pill-details");
            if (siblingDetails) {
              siblingDetails.hidden = true;
            }
          });
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
      if (els.scopeSelect?.value === "filtered" && state.hasRun) {
        runSelectedAnalysis().catch(() => {});
        return;
      }
      updateScopeNote();
    });

    updateScopeNote();
  };

  window.RouteMapsterAdvancedAnalyses = {
    initAdvancedAnalyses
  };
})();
