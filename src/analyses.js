(() => {
  /**
   * Defines route-level analysis routines for the advanced analytics module.
   *
   * Each registry entry accepts already-normalised route rows and returns a
   * renderable payload for the UI. When summary data is insufficient, the
   * analyses can call back into `RouteMapsterAPI` to fetch route geometry or
   * spatial metrics.
   */
  const asNumber = (value) => (Number.isFinite(value) ? value : null);
  const utils = window.RouteMapsterUtils || {};
  const formatNumber = utils.formatNumber || ((value, digits = 1) => {
    if (!Number.isFinite(value)) {
      return "";
    }
    if (digits === 0) {
      return String(Math.round(value));
    }
    return value.toFixed(digits);
  });

  const average = (values) => {
    const nums = values.filter((value) => Number.isFinite(value));
    if (nums.length === 0) {
      return null;
    }
    return nums.reduce((sum, value) => sum + value, 0) / nums.length;
  };

  const getOperators = (row) => {
    if (row.operator_names_arr && row.operator_names_arr.length > 0) {
      return row.operator_names_arr;
    }
    return ["Unknown"];
  };

  const isUnknownLike = (value) => {
    const token = String(value || "").trim().toLowerCase();
    if (!token) {
      return true;
    }
    return token === "unknown"
      || token === "unkown"
      || token.startsWith("unknown ")
      || token.startsWith("unkown ")
      || token === "n/a"
      || token === "na";
  };

  const getKnownOperators = (row) => getOperators(row)
    .map((operator) => String(operator || "").trim())
    .filter((operator) => !isUnknownLike(operator));

  const getPrimaryKnownOperator = (row) => getKnownOperators(row)[0] || "";

  const getGarages = (row) => {
    const codes = Array.isArray(row.garage_codes_arr) ? row.garage_codes_arr : [];
    const names = Array.isArray(row.garage_names_arr) ? row.garage_names_arr : [];
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
    return combined.length > 0 ? combined : ["Unknown"];
  };

  const getKnownGarages = (row) => getGarages(row)
    .map((garage) => String(garage || "").trim())
    .filter((garage) => !isUnknownLike(garage));

  const getRouteId = (row) => String(row?.route_id_norm || row?.route_id || "").trim().toUpperCase();

  const getConnectedRouteCounts = (row) => {
    const regular = asNumber(row?.connected_routes_regular);
    const night = asNumber(row?.connected_routes_night);
    const school = asNumber(row?.connected_routes_school);
    const parsedTotal = asNumber(row?.connected_routes_total);
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

  const groupRoutesByPrimaryLabel = (rows, getLabel) => {
    const groups = new Map();
    (Array.isArray(rows) ? rows : []).forEach((row) => {
      const routeId = getRouteId(row);
      if (!routeId) {
        return;
      }
      const label = String(getLabel(row) || "").trim() || "Unknown";
      if (!groups.has(label)) {
        groups.set(label, new Set());
      }
      groups.get(label).add(routeId);
    });
    return Array.from(groups.entries())
      .map(([label, routeSet]) => ({
        label,
        routes: Array.from(routeSet)
          .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      }))
      .sort((a, b) => {
        if (b.routes.length !== a.routes.length) {
          return b.routes.length - a.routes.length;
        }
        return a.label.localeCompare(b.label, undefined, { numeric: true });
      });
  };

  const routeOverlapCoverageCache = {
    key: "",
    promise: null,
    result: null
  };

  /**
   * Estimates how much of each selected route is shared with the comparison set.
   *
   * @param {Array<object>} rows Focus rows to score.
   * @param {{allRows?: Array<object>}} [context={}] Optional comparison universe.
   * @returns {Promise<{scores?: Array<object>, note?: string}>} Coverage scores or a note when geometry is unavailable.
   * Side effects: May fetch route geometry and show the shared loading modal.
   */
  const computeRouteOverlapCoverageScores = async (rows, context = {}) => {
    const api = window.RouteMapsterAPI;
    if (!api || typeof api.loadRouteGeometry !== "function") {
      return {
        note: "Route geometry overlap analysis is unavailable in this build."
      };
    }

    const SAMPLE_STEP_METERS = 40;
    const OVERLAP_TOLERANCE_METERS = 45;
    const ORIENTATION_DOT_MIN = 0.6;

    const toRouteMap = (sourceRows) => {
      const map = new Map();
      (Array.isArray(sourceRows) ? sourceRows : []).forEach((row) => {
        const routeId = String(row?.route_id_norm || row?.route_id || "").trim().toUpperCase();
        if (!routeId) {
          return;
        }
        if (!map.has(routeId)) {
          map.set(routeId, row);
        }
      });
      return map;
    };

    const focusRouteMap = toRouteMap(rows);
    const focusRouteIds = Array.from(focusRouteMap.keys());
    if (focusRouteIds.length === 0) {
      return {
        note: "No routes available for exclusivity analysis."
      };
    }

    const comparisonRows = Array.isArray(context?.allRows) && context.allRows.length > 0
      ? context.allRows
      : rows;
    const comparisonRouteMap = toRouteMap(comparisonRows);
    focusRouteMap.forEach((row, routeId) => {
      if (!comparisonRouteMap.has(routeId)) {
        comparisonRouteMap.set(routeId, row);
      }
    });

    const comparisonRouteIds = Array.from(comparisonRouteMap.keys());
    if (comparisonRouteIds.length < 2) {
      return {
        note: "Need at least two routes to compare geometry overlap."
      };
    }

    const focusRouteSet = new Set(focusRouteIds);
    const selectScoresForFocus = (payload) => {
      if (payload?.note) {
        return payload;
      }
      const allScores = Array.isArray(payload?.scores) ? payload.scores : [];
      const selectedScores = allScores.filter((entry) => focusRouteSet.has(entry.routeId));
      if (selectedScores.length === 0) {
        return {
          note: "No routes with usable geometry points were available for the selected routes."
        };
      }
      return { scores: selectedScores };
    };

    // Cache against the comparison universe because the geometry pass is the
    // expensive part; different filtered subsets can then reuse the same base work.
    const cacheKey = comparisonRouteIds
      .slice()
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      .join("|");
    if (routeOverlapCoverageCache.key === cacheKey && routeOverlapCoverageCache.result) {
      return selectScoresForFocus(routeOverlapCoverageCache.result);
    }
    if (routeOverlapCoverageCache.key === cacheKey && routeOverlapCoverageCache.promise) {
      return routeOverlapCoverageCache.promise.then((result) => selectScoresForFocus(result));
    }

    const promise = (async () => {
      const METERS_PER_MILE = 1609.344;
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

      const buildWeightedSamples = (segments) => {
        if (!Array.isArray(segments)) {
          return { samples: [], totalMeters: 0 };
        }
        const samples = [];
        let totalMeters = 0;
        segments.forEach((segment) => {
          if (!Array.isArray(segment) || segment.length < 2) {
            return;
          }
          for (let i = 1; i < segment.length; i += 1) {
            const a = segment[i - 1];
            const b = segment[i];
            if (!Array.isArray(a) || !Array.isArray(b) || a.length < 2 || b.length < 2) {
              continue;
            }
            const lat1 = Number(a[0]);
            const lon1 = Number(a[1]);
            const lat2 = Number(b[0]);
            const lon2 = Number(b[1]);
            if (![lat1, lon1, lat2, lon2].every(Number.isFinite)) {
              continue;
            }
            const edgeMeters = haversineMeters([lat1, lon1], [lat2, lon2]);
            if (!Number.isFinite(edgeMeters) || edgeMeters <= 0.5) {
              continue;
            }
            totalMeters += edgeMeters;
            const parts = Math.max(1, Math.ceil(edgeMeters / SAMPLE_STEP_METERS));
            const weight = edgeMeters / parts;
            const dLat = lat2 - lat1;
            const dLon = lon2 - lon1;
            for (let part = 0; part < parts; part += 1) {
              const t = (part + 0.5) / parts;
              samples.push({
                lat: lat1 + (dLat * t),
                lon: lon1 + (dLon * t),
                dLat,
                dLon,
                w: weight
              });
            }
          }
        });
        return { samples, totalMeters };
      };

      if (typeof api.setLoadingModalVisible === "function") {
        api.setLoadingModalVisible(true);
      }
      const segmentsByRoute = new Map();
      try {
        const concurrency = 6;
        let index = 0;
        const worker = async () => {
          while (index < comparisonRouteIds.length) {
            const routeId = comparisonRouteIds[index];
            index += 1;
            try {
              const segments = await api.loadRouteGeometry(routeId);
              segmentsByRoute.set(routeId, Array.isArray(segments) ? segments : []);
            } catch (error) {
              segmentsByRoute.set(routeId, []);
            }
          }
        };
        await Promise.all(Array.from({ length: concurrency }, () => worker()));
      } finally {
        if (typeof api.setLoadingModalVisible === "function") {
          api.setLoadingModalVisible(false);
        }
      }

      const sampleBundles = new Map();
      let latSum = 0;
      let latCount = 0;
      comparisonRouteIds.forEach((routeId) => {
        const bundle = buildWeightedSamples(segmentsByRoute.get(routeId));
        if (bundle.samples.length > 0 && bundle.totalMeters > 0) {
          sampleBundles.set(routeId, bundle);
          bundle.samples.forEach((point) => {
            latSum += point.lat;
            latCount += 1;
          });
        }
      });

      const routesWithGeometry = Array.from(sampleBundles.keys());
      if (routesWithGeometry.length < 2) {
        return {
          note: "Insufficient route geometry data for overlap analysis."
        };
      }

      const lat0 = latCount > 0 ? latSum / latCount : 51.5;
      const cosLat0 = Math.max(0.2, Math.cos(toRad(lat0)));
      const metersPerDegLat = 111320;
      const metersPerDegLon = 111320 * cosLat0;
      const thresholdSq = OVERLAP_TOLERANCE_METERS * OVERLAP_TOLERANCE_METERS;
      const gridSize = OVERLAP_TOLERANCE_METERS;

      const grid = new Map();
      const projectedByRoute = new Map();
      routesWithGeometry.forEach((routeId) => {
        const source = sampleBundles.get(routeId);
        const projected = (source?.samples || []).map((point) => {
          const x = point.lon * metersPerDegLon;
          const y = point.lat * metersPerDegLat;
          const vx = point.dLon * metersPerDegLon;
          const vy = point.dLat * metersPerDegLat;
          const vLen = Math.hypot(vx, vy) || 1;
          return {
            routeId,
            x,
            y,
            ux: vx / vLen,
            uy: vy / vLen,
            w: point.w
          };
        });
        projectedByRoute.set(routeId, projected);
        projected.forEach((point) => {
          const key = `${Math.floor(point.x / gridSize)}:${Math.floor(point.y / gridSize)}`;
          if (!grid.has(key)) {
            grid.set(key, []);
          }
          grid.get(key).push(point);
        });
      });

      const scores = [];
      routesWithGeometry.forEach((routeId) => {
        const points = projectedByRoute.get(routeId) || [];
        const totalMeters = sampleBundles.get(routeId)?.totalMeters || 0;
        if (points.length === 0 || !(totalMeters > 0)) {
          return;
        }
        let sharedMeters = 0;
        const peerRoutes = new Set();
        const overlapMetersByPeer = new Map();

        points.forEach((point) => {
          const cellX = Math.floor(point.x / gridSize);
          const cellY = Math.floor(point.y / gridSize);
          let pointShared = false;
          let matchedPeers = null;

          for (let dx = -1; dx <= 1; dx += 1) {
            for (let dy = -1; dy <= 1; dy += 1) {
              const bucket = grid.get(`${cellX + dx}:${cellY + dy}`) || [];
              for (let i = 0; i < bucket.length; i += 1) {
                const candidate = bucket[i];
                if (!candidate || candidate.routeId === routeId) {
                  continue;
                }
                const ddx = candidate.x - point.x;
                const ddy = candidate.y - point.y;
                if ((ddx * ddx) + (ddy * ddy) > thresholdSq) {
                  continue;
                }
                const dirDot = Math.abs((candidate.ux * point.ux) + (candidate.uy * point.uy));
                if (!Number.isFinite(dirDot) || dirDot < ORIENTATION_DOT_MIN) {
                  continue;
                }
                if (!pointShared) {
                  pointShared = true;
                  sharedMeters += point.w;
                }
                if (!matchedPeers) {
                  matchedPeers = new Set();
                }
                if (matchedPeers.has(candidate.routeId)) {
                  continue;
                }
                matchedPeers.add(candidate.routeId);
                peerRoutes.add(candidate.routeId);
                overlapMetersByPeer.set(
                  candidate.routeId,
                  (overlapMetersByPeer.get(candidate.routeId) || 0) + point.w
                );
              }
            }
          }
        });

        let bestPeerId = "";
        let bestPeerOverlapMeters = 0;
        overlapMetersByPeer.forEach((meters, peerId) => {
          if (!Number.isFinite(meters) || meters <= bestPeerOverlapMeters) {
            return;
          }
          bestPeerOverlapMeters = meters;
          bestPeerId = peerId;
        });

        const sharedRatio = Math.max(0, Math.min(1, sharedMeters / totalMeters));
        const exclusiveRatio = Math.max(0, 1 - sharedRatio);
        const exclusiveMeters = Math.max(0, totalMeters - sharedMeters);
        const bestPeerOverlapRatio = bestPeerOverlapMeters > 0
          ? Math.max(0, Math.min(1, bestPeerOverlapMeters / totalMeters))
          : 0;
        const row = focusRouteMap.get(routeId) || comparisonRouteMap.get(routeId) || {};
        scores.push({
          routeId,
          operator: getPrimaryKnownOperator(row),
          peerCount: peerRoutes.size,
          sharedRatio,
          exclusiveRatio,
          totalMeters,
          totalMiles: totalMeters / METERS_PER_MILE,
          exclusiveMeters,
          exclusiveMiles: exclusiveMeters / METERS_PER_MILE,
          bestPeerId,
          bestPeerOverlapMeters,
          bestPeerOverlapMiles: bestPeerOverlapMeters / METERS_PER_MILE,
          bestPeerOverlapRatio
        });
      });

      if (scores.length === 0) {
        return {
          note: "No routes with usable geometry points were available."
        };
      }

      return { scores };
    })();

    routeOverlapCoverageCache.key = cacheKey;
    routeOverlapCoverageCache.promise = promise;
    routeOverlapCoverageCache.result = null;
    try {
      const result = await promise;
      if (routeOverlapCoverageCache.key === cacheKey) {
        routeOverlapCoverageCache.result = result;
        routeOverlapCoverageCache.promise = null;
      }
      return selectScoresForFocus(result);
    } catch (error) {
      if (routeOverlapCoverageCache.key === cacheKey) {
        routeOverlapCoverageCache.promise = null;
        routeOverlapCoverageCache.result = null;
      }
      throw error;
    }
  };

  /**
   * Registry of route analyses exposed to the advanced analytics UI.
   *
   * Keys are treated as stable identifiers across the UI, exported CSVs, and
   * deep links, so new analyses should preserve that contract.
   */
  const analysisRegistry = {
    "routes-by-operator": {
      id: "routes-by-operator",
      label: "Routes by operator",
      run: (rows) => {
        const counts = new Map();
        rows.forEach((row) => {
          getKnownOperators(row).forEach((operator) => {
            counts.set(operator, (counts.get(operator) || 0) + 1);
          });
        });
        const sorted = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
        const groups = groupRoutesByPrimaryLabel(rows, (row) => getPrimaryKnownOperator(row) || "Unknown");
        return {
          type: "table",
          columns: ["Operator", "Routes"],
          rows: sorted.map(([operator, count]) => [operator, count]),
          mapOverlay: {
            type: "grouped-routes",
            key: "operator",
            groups
          }
        };
      }
    },
    "routes-by-garage": {
      id: "routes-by-garage",
      label: "Routes by garage",
      run: (rows) => {
        const counts = new Map();
        rows.forEach((row) => {
          getGarages(row).forEach((garage) => {
            counts.set(garage, (counts.get(garage) || 0) + 1);
          });
        });
        const sorted = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
        const groups = groupRoutesByPrimaryLabel(rows, (row) => {
          const known = getKnownGarages(row);
          if (known.length > 0) {
            return known[0];
          }
          const all = getGarages(row);
          return all[0] || "Unknown";
        });
        return {
          type: "table",
          columns: ["Garage", "Routes"],
          rows: sorted.map(([garage, count]) => [garage, count]),
          mapOverlay: {
            type: "grouped-routes",
            key: "garage",
            groups
          }
        };
      }
    },
    "routes-multi-garage": {
      id: "routes-multi-garage",
      label: "Routes allocated to multiple garages",
      run: (rows) => {
        const matches = rows
          .map((row) => {
            const garages = getKnownGarages(row);
            return {
              routeId: row.route_id || row.route_id_norm,
              operator: getPrimaryKnownOperator(row),
              garages
            };
          })
          .filter((entry) => entry.routeId && entry.garages.length > 1)
          .sort((a, b) => {
            if (b.garages.length !== a.garages.length) {
              return b.garages.length - a.garages.length;
            }
            return String(a.routeId).localeCompare(String(b.routeId), undefined, { numeric: true });
          });
        if (matches.length === 0) {
          return {
            type: "table",
            columns: ["Route", "Operator", "Garage count", "Garages"],
            rows: [["No routes with multiple known garages found", "", "", ""]],
            mapOverlay: {
              type: "route-list",
              routeIds: []
            }
          };
        }
        const routeIds = matches
          .map((entry) => String(entry.routeId || "").trim().toUpperCase())
          .filter(Boolean);
        return {
          type: "table",
          columns: ["Route", "Operator", "Garage count", "Garages"],
          rows: matches.map((entry) => ([
            entry.routeId,
            entry.operator,
            entry.garages.length,
            entry.garages.join(", ")
          ])),
          mapOverlay: {
            type: "route-list",
            routeIds
          }
        };
      }
    },
    "service-type-by-operator": {
      id: "service-type-by-operator",
      label: "Service type breakdown by operator",
      run: (rows) => {
        const summary = new Map();
        const validTypes = new Set(["regular", "night", "school", "twentyfour"]);
        rows.forEach((row) => {
          const type = String(row.route_type || "").toLowerCase();
          if (!validTypes.has(type)) {
            return;
          }
          getKnownOperators(row).forEach((operator) => {
            if (!summary.has(operator)) {
              summary.set(operator, { regular: 0, night: 0, school: 0, twentyfour: 0 });
            }
            const entry = summary.get(operator);
            entry[type] += 1;
          });
        });
        const rowsOut = Array.from(summary.entries())
          .sort((a, b) => {
            const totalA = Object.values(a[1]).reduce((sum, value) => sum + value, 0);
            const totalB = Object.values(b[1]).reduce((sum, value) => sum + value, 0);
            return totalB - totalA;
          })
          .map(([operator, counts]) => {
            const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
            return [
              operator,
              counts.regular,
              counts.night,
              counts.school,
              counts.twentyfour,
              total
            ];
          });
        return {
          type: "table",
          columns: ["Operator", "Regular", "Night", "School", "24hr", "Total"],
          rows: rowsOut
        };
      }
    },
    "fleet-composition-by-operator": {
      id: "fleet-composition-by-operator",
      label: "Fleet composition by operator",
      run: (rows) => {
        const summary = new Map();
        rows.forEach((row) => {
          const vehicle = String(row.vehicle_type || "").trim().toUpperCase();
          if (vehicle !== "SD" && vehicle !== "DD") {
            return;
          }
          getKnownOperators(row).forEach((operator) => {
            if (!summary.has(operator)) {
              summary.set(operator, { SD: 0, DD: 0 });
            }
            const entry = summary.get(operator);
            entry[vehicle] += 1;
          });
        });
        const rowsOut = Array.from(summary.entries())
          .sort((a, b) => {
            const totalA = Object.values(a[1]).reduce((sum, value) => sum + value, 0);
            const totalB = Object.values(b[1]).reduce((sum, value) => sum + value, 0);
            return totalB - totalA;
          })
          .map(([operator, counts]) => {
            const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
            const sdShare = total > 0 ? (counts.SD / total) * 100 : 0;
            const ddShare = total > 0 ? (counts.DD / total) * 100 : 0;
            return [
              operator,
              counts.SD,
              counts.DD,
              total,
              `${formatNumber(sdShare, 0)}%`,
              `${formatNumber(ddShare, 0)}%`
            ];
          });
        return {
          type: "table",
          columns: ["Operator", "SD", "DD", "Total", "SD share", "DD share"],
          rows: rowsOut
        };
      }
    },
    "avg-frequency-by-operator": {
      id: "avg-frequency-by-operator",
      label: "Average frequency by operator",
      run: (rows) => {
        const summary = new Map();
        rows.forEach((row) => {
          getKnownOperators(row).forEach((operator) => {
            if (!summary.has(operator)) {
              summary.set(operator, { peakAm: [], peakPm: [], offpeak: [], weekend: [], overnight: [] });
            }
            const entry = summary.get(operator);
            if (Number.isFinite(row.frequency_peak_am)) {
              entry.peakAm.push(row.frequency_peak_am);
            }
            if (Number.isFinite(row.frequency_peak_pm)) {
              entry.peakPm.push(row.frequency_peak_pm);
            }
            if (Number.isFinite(row.frequency_offpeak)) {
              entry.offpeak.push(row.frequency_offpeak);
            }
            if (Number.isFinite(row.frequency_weekend)) {
              entry.weekend.push(row.frequency_weekend);
            }
            if (Number.isFinite(row.frequency_overnight)) {
              entry.overnight.push(row.frequency_overnight);
            }
          });
        });
        const rowsOut = Array.from(summary.entries())
          .map(([operator, values]) => [
            operator,
            formatNumber(average(values.peakAm)),
            formatNumber(average(values.peakPm)),
            formatNumber(average(values.offpeak)),
            formatNumber(average(values.weekend)),
            formatNumber(average(values.overnight))
          ])
          .sort((a, b) => {
            const aVal = parseFloat(a[1]) || 0;
            const bVal = parseFloat(b[1]) || 0;
            return bVal - aVal;
          });
        return {
          type: "table",
          columns: ["Operator", "Avg Peak AM", "Avg Peak PM", "Avg Offpeak", "Avg Weekend", "Avg Overnight"],
          rows: rowsOut
        };
      }
    },
    "top-routes-peak-am": {
      id: "top-routes-peak-am",
      label: "Top routes by peak AM frequency",
      run: (rows) => {
        const sorted = rows
          .filter((row) => Number.isFinite(row.frequency_peak_am))
          .slice()
          .sort((a, b) => b.frequency_peak_am - a.frequency_peak_am)
          .slice(0, 25);
        const routeIds = sorted
          .map((row) => getRouteId(row))
          .filter(Boolean);
        return {
          type: "table",
          columns: ["Rank", "Route", "Operator", "Peak AM", "Offpeak", "Weekend", "Overnight"],
          rows: sorted.map((row, index) => [
            index + 1,
            row.route_id || row.route_id_norm,
            getPrimaryKnownOperator(row),
            formatNumber(row.frequency_peak_am),
            formatNumber(row.frequency_offpeak),
            formatNumber(row.frequency_weekend),
            formatNumber(row.frequency_overnight)
          ]),
          mapOverlay: {
            type: "route-list",
            routeIds
          }
        };
      }
    },
    "avg-length-by-operator": {
      id: "avg-length-by-operator",
      label: "Average length by operator",
      run: (rows) => {
        const summary = new Map();
        rows.forEach((row) => {
          if (!Number.isFinite(row.length_miles)) {
            return;
          }
          getKnownOperators(row).forEach((operator) => {
            if (!summary.has(operator)) {
              summary.set(operator, []);
            }
            summary.get(operator).push(row.length_miles);
          });
        });
        if (summary.size === 0) {
          return {
            type: "table",
            columns: ["Operator", "Avg length (mi)"],
            rows: [["No length_miles data available", ""]]
          };
        }
        const rowsOut = Array.from(summary.entries())
          .map(([operator, values]) => [operator, formatNumber(average(values), 2)])
          .sort((a, b) => (parseFloat(b[1]) || 0) - (parseFloat(a[1]) || 0));
        return {
          type: "table",
          columns: ["Operator", "Avg length (mi)"],
          rows: rowsOut
        };
      }
    },
    "longest-routes": {
      id: "longest-routes",
      label: "Longest routes",
      run: (rows) => {
        const sorted = rows
          .filter((row) => Number.isFinite(row.length_miles))
          .slice()
          .sort((a, b) => b.length_miles - a.length_miles)
          .slice(0, 25);
        if (sorted.length === 0) {
          return {
            type: "table",
            columns: ["Rank", "Route", "Length (mi)", "Operator", "Garage"],
            rows: [["No length_miles data available", "", "", "", ""]],
            mapOverlay: {
              type: "route-list",
              routeIds: []
            }
          };
        }
        const routeIds = sorted
          .map((row) => getRouteId(row))
          .filter(Boolean);
        return {
          type: "table",
          columns: ["Rank", "Route", "Length (mi)", "Operator", "Garage"],
          rows: sorted.map((row, index) => [
            index + 1,
            row.route_id || row.route_id_norm,
            formatNumber(row.length_miles, 2),
            getPrimaryKnownOperator(row),
            getGarages(row)[0]
          ]),
          mapOverlay: {
            type: "route-list",
            routeIds
          }
        };
      }
    },
    "shortest-routes": {
      id: "shortest-routes",
      label: "Shortest routes",
      run: (rows) => {
        const sorted = rows
          .filter((row) => Number.isFinite(row.length_miles))
          .slice()
          .sort((a, b) => a.length_miles - b.length_miles)
          .slice(0, 25);
        if (sorted.length === 0) {
          return {
            type: "table",
            columns: ["Rank", "Route", "Length (mi)", "Operator", "Garage"],
            rows: [["No length_miles data available", "", "", "", ""]],
            mapOverlay: {
              type: "route-list",
              routeIds: []
            }
          };
        }
        const routeIds = sorted
          .map((row) => getRouteId(row))
          .filter(Boolean);
        return {
          type: "table",
          columns: ["Rank", "Route", "Length (mi)", "Operator", "Garage"],
          rows: sorted.map((row, index) => [
            index + 1,
            row.route_id || row.route_id_norm,
            formatNumber(row.length_miles, 2),
            getPrimaryKnownOperator(row),
            getGarages(row)[0]
          ]),
          mapOverlay: {
            type: "route-list",
            routeIds
          }
        };
      }
    },
    "routes-wholly-within-one-borough": {
      id: "routes-wholly-within-one-borough",
      label: "Routes wholly within one borough",
      run: async (rows) => {
        const filters = window.RouteMapsterAdvancedFilters;
        if (!filters || typeof filters.listRoutesWhollyWithinBoroughs !== "function") {
          return {
            type: "note",
            message: "Borough containment analysis is unavailable in this build."
          };
        }
        const matches = await filters.listRoutesWhollyWithinBoroughs(rows);
        if (!Array.isArray(matches)) {
          return {
            type: "note",
            message: "Borough containment analysis is unavailable in this build."
          };
        }
        const sorted = matches
          .filter((entry) => Array.isArray(entry?.boroughTokens) && entry.boroughTokens.length === 1)
          .slice()
          .sort((a, b) => {
            const lengthA = Number.isFinite(a?.row?.length_miles) ? a.row.length_miles : -Infinity;
            const lengthB = Number.isFinite(b?.row?.length_miles) ? b.row.length_miles : -Infinity;
            if (lengthB !== lengthA) {
              return lengthB - lengthA;
            }
            return String(a?.routeId || "").localeCompare(String(b?.routeId || ""), undefined, { numeric: true });
          });
        if (sorted.length === 0) {
          return {
            type: "table",
            columns: ["Route", "Length (mi)", "Borough"],
            rows: [["No routes wholly within one borough found", "", ""]],
            mapOverlay: {
              type: "route-list",
              routeIds: []
            }
          };
        }
        return {
          type: "table",
          columns: ["Route", "Length (mi)", "Borough"],
          rows: sorted.map((entry) => [
            entry.row?.route_id || entry.row?.route_id_norm || entry.routeId,
            formatNumber(entry.row?.length_miles, 2),
            entry.boroughLabels?.[0] || entry.boroughTokens?.[0] || ""
          ]),
          mapOverlay: {
            type: "route-list",
            routeIds: sorted.map((entry) => entry.routeId).filter(Boolean)
          }
        };
      }
    },
    "most-unique-stops-routes": {
      id: "most-unique-stops-routes",
      label: "Most route-only stops",
      run: (rows) => {
        const sorted = rows
          .filter((row) => Number.isFinite(row.unique_stops))
          .slice()
          .sort((a, b) => b.unique_stops - a.unique_stops)
          .slice(0, 25);
        if (sorted.length === 0) {
          return {
            type: "table",
            columns: ["Rank", "Route", "Route-only stops", "Total stops", "Route-only %", "Operator", "Garage"],
            rows: [["No route-only stop data available", "", "", "", "", "", ""]],
            mapOverlay: {
              type: "route-list",
              routeIds: []
            }
          };
        }
        const routeIds = sorted
          .map((row) => getRouteId(row))
          .filter(Boolean);
        return {
          type: "table",
          columns: ["Rank", "Route", "Route-only stops", "Total stops", "Route-only %", "Operator", "Garage"],
          rows: sorted.map((row, index) => [
            index + 1,
            row.route_id || row.route_id_norm,
            formatNumber(row.unique_stops, 0),
            Number.isFinite(row.total_stops) ? formatNumber(row.total_stops, 0) : "",
            Number.isFinite(row.unique_stops_pct) ? `${formatNumber(row.unique_stops_pct * 100, 0)}%` : "",
            getPrimaryKnownOperator(row),
            getGarages(row)[0]
          ]),
          mapOverlay: {
            type: "route-list",
            routeIds
          }
        };
      }
    },
    "most-stop-connected-routes": {
      id: "most-stop-connected-routes",
      label: "Routes with most interchanges",
      run: (rows) => {
        const sorted = rows
          .map((row) => ({
            row,
            counts: getConnectedRouteCounts(row)
          }))
          .filter((entry) => Number.isFinite(entry.counts.total))
          .slice()
          .sort((a, b) => {
            if (b.counts.total !== a.counts.total) {
              return b.counts.total - a.counts.total;
            }
            if ((b.counts.regular || 0) !== (a.counts.regular || 0)) {
              return (b.counts.regular || 0) - (a.counts.regular || 0);
            }
            if ((b.counts.night || 0) !== (a.counts.night || 0)) {
              return (b.counts.night || 0) - (a.counts.night || 0);
            }
            if ((b.counts.school || 0) !== (a.counts.school || 0)) {
              return (b.counts.school || 0) - (a.counts.school || 0);
            }
            return getRouteId(a.row).localeCompare(getRouteId(b.row), undefined, { numeric: true });
          })
          .slice(0, 25);
        if (sorted.length === 0) {
          return {
            type: "table",
            columns: ["Rank", "Route", "Day routes", "Night", "School", "Total"],
            rows: [["No shared-stop connectivity data available", "", "", "", "", ""]],
            mapOverlay: {
              type: "route-list",
              routeIds: []
            }
          };
        }
        const routeIds = sorted
          .map((entry) => getRouteId(entry.row))
          .filter(Boolean);
        return {
          type: "table",
          columns: ["Rank", "Route", "Day routes", "Night", "School", "Total"],
          rows: sorted.map((entry, index) => ([
            index + 1,
            getRouteId(entry.row),
            Number.isFinite(entry.counts.regular) ? formatNumber(entry.counts.regular, 0) : "",
            Number.isFinite(entry.counts.night) ? formatNumber(entry.counts.night, 0) : "",
            Number.isFinite(entry.counts.school) ? formatNumber(entry.counts.school, 0) : "",
            formatNumber(entry.counts.total, 0)
          ])),
          mapOverlay: {
            type: "route-list",
            routeIds
          }
        };
      }
    },
    "route-geometry-exclusivity": {
      id: "route-geometry-exclusivity",
      label: "Route exclusivity",
      run: async (rows, context) => {
        const TOP_COUNT = 25;
        const computed = await computeRouteOverlapCoverageScores(rows, context);
        if (computed?.note) {
          return { type: "note", message: computed.note };
        }
        const scores = Array.isArray(computed?.scores) ? computed.scores.slice() : [];
        scores.sort((a, b) => {
          if (a.exclusiveRatio !== b.exclusiveRatio) {
            return b.exclusiveRatio - a.exclusiveRatio;
          }
          if (a.exclusiveMeters !== b.exclusiveMeters) {
            return b.exclusiveMeters - a.exclusiveMeters;
          }
          if (a.totalMeters !== b.totalMeters) {
            return b.totalMeters - a.totalMeters;
          }
          return String(a.routeId).localeCompare(String(b.routeId), undefined, { numeric: true });
        });
        const top = scores.slice(0, Math.min(TOP_COUNT, scores.length));
        const routeIds = top
          .map((entry) => String(entry.routeId || "").trim().toUpperCase())
          .filter(Boolean);
        return {
          type: "table",
          columns: ["Rank", "Route", "Operator", "Exclusive %", "Exclusive mi", "Route mi"],
          rows: top.map((entry, index) => ([
            index + 1,
            entry.routeId,
            entry.operator,
            `${formatNumber(entry.exclusiveRatio * 100, 0)}%`,
            formatNumber(entry.exclusiveMiles, 2),
            formatNumber(entry.totalMiles, 2)
          ])),
          mapOverlay: {
            type: "route-list",
            routeIds
          }
        };
      }
    },
    "shared-endpoints": {
      id: "shared-endpoints",
      label: "Routes sharing the same endpoints",
      requiresSpatial: true,
      run: (rows) => {
        const PRIMARY_PRECISION = 3;
        const FALLBACK_PRECISION = 2;
        const MIN_ENDPOINT_DISTANCE_KM = 0.3;
        // Fallback groups (2dp rounding) are only to catch near-identical termini.
        // A tighter spread avoids false positives where only one endpoint is shared
        // and the other terminal is merely nearby (e.g. 231/329).
        const MAX_FALLBACK_SPREAD_KM = 0.25;

        const roundCoord = (value, decimals) => {
          if (!Number.isFinite(value)) {
            return "";
          }
          return Number(value).toFixed(decimals);
        };

        const toRad = (value) => (Number(value) * Math.PI) / 180;

        const distanceKm = (a, b) => {
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
          return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
        };

        const maxDistanceWithin = (points) => {
          if (!Array.isArray(points) || points.length < 2) {
            return 0;
          }
          let max = 0;
          for (let i = 0; i < points.length; i += 1) {
            for (let j = i + 1; j < points.length; j += 1) {
              const dist = distanceKm(points[i], points[j]);
              if (dist > max) {
                max = dist;
              }
              if (max >= MAX_FALLBACK_SPREAD_KM) {
                return max;
              }
            }
          }
          return max;
        };

        const isCircularPair = (startLat, startLon, endLat, endLon) => {
          if (![startLat, startLon, endLat, endLon].every(Number.isFinite)) {
            return false;
          }
          const distance = distanceKm([startLat, startLon], [endLat, endLon]);
          return Number.isFinite(distance) && distance < MIN_ENDPOINT_DISTANCE_KM;
        };

        const orderEndpoints = (startLat, startLon, endLat, endLon) => {
          if (!Number.isFinite(startLat) || !Number.isFinite(startLon) || !Number.isFinite(endLat) || !Number.isFinite(endLon)) {
            return null;
          }
          const a = [startLat, startLon];
          const b = [endLat, endLon];
          if (a[0] === b[0] ? a[1] <= b[1] : a[0] <= b[0]) {
            return { a, b };
          }
          return { a: b, b: a };
        };

        const buildKey = (a, b, precision) => {
          const aKey = `${roundCoord(a[0], precision)},${roundCoord(a[1], precision)}`;
          const bKey = `${roundCoord(b[0], precision)},${roundCoord(b[1], precision)}`;
          if (!aKey || !bKey) {
            return "";
          }
          return aKey < bKey ? `${aKey}|${bKey}` : `${bKey}|${aKey}`;
        };

        const addToGroup = (map, key, routeId, routeType, a, b) => {
          if (!key) {
            return;
          }
          if (!map.has(key)) {
            map.set(key, {
              key,
              routes: new Map(),
              points: [],
              aLatSum: 0,
              aLonSum: 0,
              bLatSum: 0,
              bLonSum: 0,
              count: 0
            });
          }
          const entry = map.get(key);
          if (!entry.routes.has(routeId)) {
            entry.routes.set(routeId, routeType);
            entry.points.push({ a, b });
            entry.aLatSum += a[0];
            entry.aLonSum += a[1];
            entry.bLatSum += b[0];
            entry.bLonSum += b[1];
            entry.count += 1;
          }
        };

        const normalisedRows = rows
          .map((row) => {
            const routeId = String(row.route_id || row.route_id_norm || "").trim().toUpperCase();
            if (!routeId) {
              return null;
            }
            const startLat = row.endpoint_start_lat;
            const startLon = row.endpoint_start_lon;
            const endLat = row.endpoint_end_lat;
            const endLon = row.endpoint_end_lon;
            if (isCircularPair(startLat, startLon, endLat, endLon)) {
              return null;
            }
            const ordered = orderEndpoints(
              startLat,
              startLon,
              endLat,
              endLon
            );
            if (!ordered) {
              return null;
            }
            return { routeId, routeType: row.route_type || "", a: ordered.a, b: ordered.b };
          })
          .filter(Boolean);

        const primaryGroups = new Map();
        normalisedRows.forEach((row) => {
          const key = buildKey(row.a, row.b, PRIMARY_PRECISION);
          addToGroup(primaryGroups, key, row.routeId, row.routeType, row.a, row.b);
        });

        const formatGroup = (entry) => {
          const routes = Array.from(entry.routes.entries()).map(([id, type]) => ({ id, type }));
          const routeIds = Array.from(new Set(
            routes
              .map((route) => String(route?.id || "").trim().toUpperCase())
              .filter(Boolean)
          )).sort();
          return {
            key: entry.key,
            routes,
            count: routeIds.length,
            endpoints: {
              a: [entry.aLatSum / entry.count, entry.aLonSum / entry.count],
              b: [entry.bLatSum / entry.count, entry.bLonSum / entry.count]
            },
            routeIds,
            routeKey: routeIds.join("|")
          };
        };

        const primaryEntries = Array.from(primaryGroups.values())
          .map(formatGroup)
          .filter((entry) => entry.count >= 2);

        const fallbackGroups = new Map();
        normalisedRows.forEach((row) => {
          const key = buildKey(row.a, row.b, FALLBACK_PRECISION);
          addToGroup(fallbackGroups, key, row.routeId, row.routeType, row.a, row.b);
        });

        const fallbackEntries = Array.from(fallbackGroups.values())
          .filter((entry) => {
            const points = entry.points || [];
            if (points.length < 2) {
              return false;
            }
            const aPoints = points.map((point) => point.a);
            const bPoints = points.map((point) => point.b);
            return maxDistanceWithin(aPoints) <= MAX_FALLBACK_SPREAD_KM
              && maxDistanceWithin(bPoints) <= MAX_FALLBACK_SPREAD_KM;
          })
          .map(formatGroup)
          .filter((entry) => entry.count >= 2);

        const entries = [...primaryEntries];
        fallbackEntries.forEach((fallback) => {
          const fallbackSet = new Set(fallback.routeIds || []);
          for (let i = entries.length - 1; i >= 0; i -= 1) {
            const entry = entries[i];
            const entryIds = entry.routeIds || [];
            const isSubset = entryIds.length > 0 && entryIds.every((routeId) => fallbackSet.has(routeId));
            if (isSubset && fallback.count > entry.count) {
              entries.splice(i, 1);
            }
          }
          const alreadyIncluded = entries.some((entry) => entry.routeKey && entry.routeKey === fallback.routeKey);
          if (!alreadyIncluded && fallback.routeKey) {
            entries.push(fallback);
          }
        });

        entries.sort((a, b) => b.count - a.count);

        if (entries.length === 0) {
          return {
            type: "route-pills",
            groups: [],
            emptyMessage: "No shared endpoint pairs found."
          };
        }
        return {
          type: "route-pills",
          groups: entries.map((entry) => ({
            key: entry.key,
            routes: entry.routes,
            endpoints: entry.endpoints
          }))
        };
      }
    },
    "route-families": {
      id: "route-families",
      label: "Route families (heuristic)",
      requiresSpatial: true,
      run: (rows) => {
        const METRIC_WEIGHTS = {
          overlap: 0.7,
          termini: 0.2,
          number_series: 0.1
        };
        const MIN_PAIR_CONFIDENCE = 0.2;
        const ATTACH_MIN_SPATIAL_SCORE = 0.25;
        const ATTACH_MIN_LENGTH_RATIO = 0.5;

        const list = Array.isArray(rows) ? rows : [];
        if (list.length === 0) {
          return {
            type: "route-pills",
            groups: [],
            emptyMessage: "No routes available for family analysis."
          };
        }

        const toRad = (value) => (Number(value) * Math.PI) / 180;
        const distanceKm = (a, b) => {
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
          return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
        };

        const parseRouteId = (value) => {
          const raw = String(value || "").trim().toUpperCase();
          if (!raw) {
            return { raw: "", prefix: "", number: null, suffix2: null, prefixType: "other" };
          }
          const match = raw.match(/^([A-Z]+)?(\d+)(.*)?$/);
          if (!match) {
            return { raw, prefix: "", number: null, suffix2: null, prefixType: "other" };
          }
          const prefix = match[1] || "";
          const number = Number(match[2]);
          const numberStr = match[2] || "";
          const suffix2 = numberStr.length >= 2 ? Number(numberStr.slice(-2)) : null;
          const prefixType = prefix === "" ? "base" : prefix === "N" ? "night" : prefix === "SL" ? "superloop" : "other";
          return {
            raw,
            prefix,
            number: Number.isFinite(number) ? number : null,
            suffix2: Number.isFinite(suffix2) ? suffix2 : null,
            prefixType
          };
        };

        const endpointSimilarity = (a, b) => {
          const startA = [a.endpoint_start_lat, a.endpoint_start_lon];
          const endA = [a.endpoint_end_lat, a.endpoint_end_lon];
          const startB = [b.endpoint_start_lat, b.endpoint_start_lon];
          const endB = [b.endpoint_end_lat, b.endpoint_end_lon];
          const THRESH = 0.55;

          const startStart = distanceKm(startA, startB);
          const endEnd = distanceKm(endA, endB);
          const startEnd = distanceKm(startA, endB);
          const endStart = distanceKm(endA, startB);

          const aligned = (startStart <= THRESH && endEnd <= THRESH) || (startEnd <= THRESH && endStart <= THRESH);
          if (aligned) {
            return 0.4;
          }
          const shared = Math.min(startStart, endEnd, startEnd, endStart) <= THRESH;
          return shared ? 0.2 : 0;
        };

        const endpointMetric = (a, b) => {
          const startA = [a.endpoint_start_lat, a.endpoint_start_lon];
          const endA = [a.endpoint_end_lat, a.endpoint_end_lon];
          const startB = [b.endpoint_start_lat, b.endpoint_start_lon];
          const endB = [b.endpoint_end_lat, b.endpoint_end_lon];
          const THRESH = 0.55;

          const startStart = distanceKm(startA, startB);
          const endEnd = distanceKm(endA, endB);
          const startEnd = distanceKm(startA, endB);
          const endStart = distanceKm(endA, startB);

          const aligned = (startStart <= THRESH && endEnd <= THRESH) || (startEnd <= THRESH && endStart <= THRESH);
          if (aligned) {
            return 1;
          }
          const shared = Math.min(startStart, endEnd, startEnd, endStart) <= THRESH;
          return shared ? 0.5 : 0;
        };

        const bboxOverlapRatio = (a, b) => {
          const aNorth = a.northmost_lat;
          const aSouth = a.southmost_lat;
          const aEast = a.eastmost_lon;
          const aWest = a.westmost_lon;
          const bNorth = b.northmost_lat;
          const bSouth = b.southmost_lat;
          const bEast = b.eastmost_lon;
          const bWest = b.westmost_lon;
          if (![aNorth, aSouth, aEast, aWest, bNorth, bSouth, bEast, bWest].every(Number.isFinite)) {
            return null;
          }
          const north = Math.min(aNorth, bNorth);
          const south = Math.max(aSouth, bSouth);
          const east = Math.min(aEast, bEast);
          const west = Math.max(aWest, bWest);
          if (north <= south || east <= west) {
            return 0;
          }
          const interArea = (north - south) * (east - west);
          const areaA = (aNorth - aSouth) * (aEast - aWest);
          const areaB = (bNorth - bSouth) * (bEast - bWest);
          if (!Number.isFinite(interArea) || !Number.isFinite(areaA) || !Number.isFinite(areaB) || areaA <= 0 || areaB <= 0) {
            return null;
          }
          return Math.max(0, Math.min(1, interArea / Math.min(areaA, areaB)));
        };

        const bboxOverlapScore = (a, b) => {
          const aNorth = a.northmost_lat;
          const aSouth = a.southmost_lat;
          const aEast = a.eastmost_lon;
          const aWest = a.westmost_lon;
          const bNorth = b.northmost_lat;
          const bSouth = b.southmost_lat;
          const bEast = b.eastmost_lon;
          const bWest = b.westmost_lon;
          if (![aNorth, aSouth, aEast, aWest, bNorth, bSouth, bEast, bWest].every(Number.isFinite)) {
            return 0;
          }
          const north = Math.min(aNorth, bNorth);
          const south = Math.max(aSouth, bSouth);
          const east = Math.min(aEast, bEast);
          const west = Math.max(aWest, bWest);
          if (north <= south || east <= west) {
            return 0;
          }
          const interArea = (north - south) * (east - west);
          const areaA = (aNorth - aSouth) * (aEast - aWest);
          const areaB = (bNorth - bSouth) * (bEast - bWest);
          if (!Number.isFinite(interArea) || !Number.isFinite(areaA) || !Number.isFinite(areaB) || areaA <= 0 || areaB <= 0) {
            return 0;
          }
          const overlapRatio = interArea / Math.min(areaA, areaB);
          if (overlapRatio >= 0.65) {
            return 0.4;
          }
          if (overlapRatio >= 0.45) {
            return 0.25;
          }
          return 0;
        };

        const lengthRatio = (a, b) => {
          const lenA = a?.length_miles;
          const lenB = b?.length_miles;
          if (!Number.isFinite(lenA) || !Number.isFinite(lenB) || lenA <= 0 || lenB <= 0) {
            return null;
          }
          const minLen = Math.min(lenA, lenB);
          const maxLen = Math.max(lenA, lenB);
          return maxLen > 0 ? minLen / maxLen : null;
        };

        const getSpatialScores = (a, b) => {
          const endpointScore = endpointSimilarity(a, b);
          const overlapScore = bboxOverlapScore(a, b);
          return {
            endpointScore,
            overlapScore,
            spatialScore: endpointScore + overlapScore
          };
        };

        const isModerateSpatial = (scores) => {
          if (!scores) {
            return false;
          }
          return scores.endpointScore >= 0.2
            || scores.overlapScore >= 0.25
            || scores.spatialScore >= 0.25;
        };

        const spatialLinkStrong = (a, b) => {
          const scores = getSpatialScores(a, b);
          if (!scores) {
            return false;
          }
          return scores.endpointScore >= 0.4 || scores.overlapScore >= 0.4 || scores.spatialScore >= 0.55;
        };

        const isSpecialPrefix = (parsed) => parsed?.prefixType === "other" || parsed?.prefixType === "superloop";

        const numericSimilarity = (a, b) => {
          if (!Number.isFinite(a.number) || !Number.isFinite(b.number)) {
            return 0;
          }
          if (a.number === b.number) {
            const basePair = (a.prefixType === "base" && b.prefixType === "base")
              || (a.prefixType === "night" && b.prefixType === "base")
              || (a.prefixType === "base" && b.prefixType === "night")
              || (a.prefixType === "night" && b.prefixType === "night");
            return basePair ? 0.4 : 0.2;
          }
          if (Number.isFinite(a.suffix2) && Number.isFinite(b.suffix2) && a.suffix2 === b.suffix2) {
            const bothBig = a.number >= 100 && b.number >= 100;
            let score = bothBig ? 0.25 : 0.2;
            if (a.prefixType === "other" || b.prefixType === "other" || a.prefixType === "superloop" || b.prefixType === "superloop") {
              score -= 0.05;
            }
            return Math.max(0.1, score);
          }
          return 0;
        };

        const numericMetric = (a, b) => {
          if (!Number.isFinite(a.number) || !Number.isFinite(b.number)) {
            return 0;
          }
          if (a.number === b.number) {
            const basePair = (a.prefixType === "base" && b.prefixType === "base")
              || (a.prefixType === "night" && b.prefixType === "base")
              || (a.prefixType === "base" && b.prefixType === "night")
              || (a.prefixType === "night" && b.prefixType === "night");
            return basePair ? 1 : 0.6;
          }
          if (Number.isFinite(a.suffix2) && Number.isFinite(b.suffix2) && a.suffix2 === b.suffix2) {
            const bothBig = a.number >= 100 && b.number >= 100;
            let score = bothBig ? 0.7 : 0.6;
            if (a.prefixType === "other" || b.prefixType === "other" || a.prefixType === "superloop" || b.prefixType === "superloop") {
              score -= 0.1;
            }
            return Math.max(0.4, score);
          }
          return 0;
        };

        const computeConfidence = (metrics) => {
          const weightEntries = Object.entries(METRIC_WEIGHTS);
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

        const enriched = list
          .map((row) => {
            const routeId = String(row.route_id || row.route_id_norm || "").trim().toUpperCase();
            if (!routeId) {
              return null;
            }
            const parsed = parseRouteId(routeId);
            return { row, routeId, parsed };
          })
          .filter(Boolean);

        const suffixSeriesCounts = new Map();
        const suffixSeriesMembers = new Map();
        enriched.forEach((entry) => {
          const suffix = entry.parsed.suffix2;
          if (!Number.isFinite(suffix)) {
            return;
          }
          if (entry.parsed.prefixType === "other" || entry.parsed.prefixType === "superloop") {
            return;
          }
          const key = String(suffix).padStart(2, "0");
          suffixSeriesCounts.set(key, (suffixSeriesCounts.get(key) || 0) + 1);
          if (!suffixSeriesMembers.has(key)) {
            suffixSeriesMembers.set(key, []);
          }
          suffixSeriesMembers.get(key).push(entry);
        });

        const suffixSeriesStats = new Map();
        suffixSeriesMembers.forEach((members, key) => {
          let scoreSum = 0;
          let scoreCount = 0;
          const maxByRoute = new Map();
          for (let i = 0; i < members.length; i += 1) {
            for (let j = i + 1; j < members.length; j += 1) {
              const a = members[i];
              const b = members[j];
              const spatialScore = endpointSimilarity(a.row, b.row) + bboxOverlapScore(a.row, b.row);
              if (spatialScore > 0) {
                scoreSum += spatialScore;
                scoreCount += 1;
              }
              const prevA = maxByRoute.get(a.routeId) || 0;
              const prevB = maxByRoute.get(b.routeId) || 0;
              if (spatialScore > prevA) {
                maxByRoute.set(a.routeId, spatialScore);
              }
              if (spatialScore > prevB) {
                maxByRoute.set(b.routeId, spatialScore);
              }
            }
          }
          const cohesion = scoreCount > 0 ? scoreSum / scoreCount : 0;
          suffixSeriesStats.set(key, { cohesion, maxByRoute });
        });

        const parent = new Map();
        const find = (id) => {
          if (!parent.has(id)) {
            parent.set(id, id);
          }
          const root = parent.get(id);
          if (root === id) {
            return id;
          }
          const resolved = find(root);
          parent.set(id, resolved);
          return resolved;
        };
        const union = (a, b) => {
          const rootA = find(a);
          const rootB = find(b);
          if (rootA !== rootB) {
            parent.set(rootB, rootA);
          }
        };

        for (let i = 0; i < enriched.length; i += 1) {
          for (let j = i + 1; j < enriched.length; j += 1) {
            const a = enriched[i];
            const b = enriched[j];
            const numericScore = numericSimilarity(a.parsed, b.parsed);
            const endpointScore = endpointSimilarity(a.row, b.row);
            const overlapScore = bboxOverlapScore(a.row, b.row);
            const spatialScore = endpointScore + overlapScore;
            const score = numericScore + spatialScore;
            const hasSpatial = endpointScore >= 0.2 || overlapScore >= 0.25;
            const strongSpatial = endpointScore >= 0.4 || overlapScore >= 0.4 || spatialScore >= 0.55;
            const allowNightExact = (a.parsed.prefixType === "night" && b.parsed.prefixType === "base")
              || (a.parsed.prefixType === "base" && b.parsed.prefixType === "night");
            const specialPrefixPair = isSpecialPrefix(a.parsed) || isSpecialPrefix(b.parsed);
            const specialPrefixAllowed = endpointScore >= 0.4
              || (overlapScore >= 0.4 && endpointScore >= 0.2)
              || spatialScore >= 0.7;
            const suffixKey = Number.isFinite(a.parsed.suffix2) ? String(a.parsed.suffix2).padStart(2, "0") : "";
            const seriesCount = suffixKey ? suffixSeriesCounts.get(suffixKey) || 0 : 0;
            const seriesStats = suffixKey ? suffixSeriesStats.get(suffixKey) : null;
            const sameSuffixSeries = seriesCount >= 3
              && a.parsed.prefixType !== "other"
              && a.parsed.prefixType !== "superloop"
              && b.parsed.prefixType !== "other"
              && b.parsed.prefixType !== "superloop"
              && Number.isFinite(a.parsed.suffix2)
              && Number.isFinite(b.parsed.suffix2)
              && a.parsed.suffix2 === b.parsed.suffix2;
            const crossMagnitude = (a.parsed.number >= 100) !== (b.parsed.number >= 100);
            const suffixOnly = a.parsed.number !== b.parsed.number
              && Number.isFinite(a.parsed.suffix2)
              && Number.isFinite(b.parsed.suffix2)
              && a.parsed.suffix2 === b.parsed.suffix2;
            const crossMagnitudeSuffixOnly = crossMagnitude && suffixOnly;
            const suffixCohesionOk = seriesStats && seriesStats.cohesion >= 0.2;
            if (
              (numericScore >= 0.4 && hasSpatial) ||
              (strongSpatial && numericScore >= 0.2) ||
              score >= 0.85 ||
              (sameSuffixSeries && numericScore >= 0.2 && suffixCohesionOk && strongSpatial)
            ) {
              if (allowNightExact && !hasSpatial) {
                continue;
              }
              if (specialPrefixPair && !specialPrefixAllowed) {
                continue;
              }
              if (crossMagnitudeSuffixOnly && !strongSpatial) {
                continue;
              }
              union(a.routeId, b.routeId);
            }
          }
        }

        const grouped = new Map();
        enriched.forEach((entry) => {
          const root = find(entry.routeId);
          if (!grouped.has(root)) {
            grouped.set(root, new Map());
          }
          grouped.get(root).set(entry.routeId, entry.row.route_type || "");
        });

        const rawGroups = Array.from(grouped.values())
          .map((routesMap) => {
            const routes = Array.from(routesMap.entries()).map(([id, type]) => ({ id, type }));
            return { routes, count: routes.length };
          })
          .sort((a, b) => b.count - a.count);

        const multiGroups = rawGroups.filter((group) => group.count >= 2);

        const hasNonNight = (group) => group.routes.some((route) => {
          const parsed = parseRouteId(route?.id || route?.routeId || route?.route || "");
          return parsed.prefixType !== "night";
        });
        const hasNight = (group) => group.routes.some((route) => {
          const parsed = parseRouteId(route?.id || route?.routeId || route?.route || "");
          return parsed.prefixType === "night";
        });

        const filteredGroups = multiGroups.filter((group) => {
          if (group.count !== 2) {
            return true;
          }
          return !(hasNight(group) && hasNonNight(group));
        });

        if (filteredGroups.length === 0) {
          return {
            type: "route-pills",
            groups: [],
            emptyMessage: "No route families found with the current heuristic."
          };
        }

        const rowById = new Map(enriched.map((entry) => [entry.routeId, entry]));
        const parsedById = new Map(enriched.map((entry) => [entry.routeId, entry.parsed]));

        const splitGroupBySpatial = (group) => {
          if (!group || group.count < 3) {
            return [group];
          }
          const routes = Array.isArray(group.routes) ? group.routes : [];
          const routeIds = routes
            .map((route) => String(route?.id || route?.routeId || route?.route || "").trim().toUpperCase())
            .filter(Boolean);
          if (routeIds.length < 3) {
            return [group];
          }
          const adjacency = new Map();
          routeIds.forEach((routeId) => {
            adjacency.set(routeId, new Set());
          });
          for (let i = 0; i < routeIds.length; i += 1) {
            for (let j = i + 1; j < routeIds.length; j += 1) {
              const a = rowById.get(routeIds[i]);
              const b = rowById.get(routeIds[j]);
              if (!a || !b) {
                continue;
              }
              if (spatialLinkStrong(a.row, b.row)) {
                adjacency.get(routeIds[i]).add(routeIds[j]);
                adjacency.get(routeIds[j]).add(routeIds[i]);
              }
            }
          }
          const visited = new Set();
          const components = [];
          routeIds.forEach((routeId) => {
            if (visited.has(routeId)) {
              return;
            }
            const stack = [routeId];
            const component = [];
            visited.add(routeId);
            while (stack.length) {
              const current = stack.pop();
              component.push(current);
              adjacency.get(current).forEach((neighbor) => {
                if (!visited.has(neighbor)) {
                  visited.add(neighbor);
                  stack.push(neighbor);
                }
              });
            }
            components.push(component);
          });
          const byIdType = new Map(routes.map((route) => {
            const id = String(route?.id || route?.routeId || route?.route || "").trim().toUpperCase();
            return [id, route?.type || ""];
          }));
          const splitGroups = components
            .map((component) => ({
              routes: component.map((routeId) => ({ id: routeId, type: byIdType.get(routeId) || "" })),
              count: component.length
            }));
          if (splitGroups.length <= 1) {
            return [group];
          }
          return splitGroups;
        };

        const spatialGroups = filteredGroups
          .flatMap((group) => splitGroupBySpatial(group))
          .filter((group) => group);

        const orphanGroups = rawGroups.filter((group) => group.count === 1);
        const candidateGroups = [...spatialGroups, ...orphanGroups];
        const coreGroups = candidateGroups
          .filter((group) => group && group.count >= 2)
          .map((group) => ({
            ...group,
            routes: Array.isArray(group.routes) ? group.routes.slice() : [],
            count: group.count
          }));
        const orphanRoutes = candidateGroups.filter((group) => group && group.count === 1);

        const isSeriesCandidate = (parsed) => Number.isFinite(parsed?.suffix2)
          && parsed.prefixType !== "other"
          && parsed.prefixType !== "superloop";
        const seriesKeyFor = (parsed) => (isSeriesCandidate(parsed) ? String(parsed.suffix2).padStart(2, "0") : "");

        const coreSeries = coreGroups.map((group) => {
          const seriesKeys = new Set();
          group.routes.forEach((route) => {
            const routeId = String(route?.id || route?.routeId || route?.route || "").trim().toUpperCase();
            if (!routeId) {
              return;
            }
            const parsed = parsedById.get(routeId);
            const key = seriesKeyFor(parsed);
            if (key) {
              seriesKeys.add(key);
            }
          });
          return { group, seriesKeys };
        });

        orphanRoutes.forEach((orphanGroup) => {
          const orphanRoute = Array.isArray(orphanGroup.routes) ? orphanGroup.routes[0] : null;
          const orphanId = String(orphanRoute?.id || orphanRoute?.routeId || orphanRoute?.route || "").trim().toUpperCase();
          if (!orphanId) {
            return;
          }
          const orphanParsed = parsedById.get(orphanId);
          const seriesKey = seriesKeyFor(orphanParsed);
          if (!seriesKey) {
            return;
          }
          const orphanEntry = rowById.get(orphanId);
          if (!orphanEntry) {
            return;
          }
          let bestGroup = null;
          let bestScore = 0;
          coreSeries.forEach(({ group, seriesKeys }) => {
            if (!seriesKeys.has(seriesKey)) {
              return;
            }
            let maxScore = 0;
            group.routes.forEach((route) => {
              const routeId = String(route?.id || route?.routeId || route?.route || "").trim().toUpperCase();
              if (!routeId || routeId === orphanId) {
                return;
              }
              const entry = rowById.get(routeId);
              if (!entry) {
                return;
              }
              const candidateParsed = parsedById.get(routeId);
              const scores = getSpatialScores(orphanEntry.row, entry.row);
              if (!isModerateSpatial(scores)) {
                return;
              }
              const ratio = lengthRatio(orphanEntry.row, entry.row);
              if (Number.isFinite(ratio) && ratio < ATTACH_MIN_LENGTH_RATIO) {
                return;
              }
              const specialPrefixPair = isSpecialPrefix(orphanParsed) || isSpecialPrefix(candidateParsed);
              const specialPrefixAllowed = scores.endpointScore >= 0.4
                || (scores.overlapScore >= 0.4 && scores.endpointScore >= 0.2)
                || scores.spatialScore >= 0.7;
              if (specialPrefixPair && !specialPrefixAllowed) {
                return;
              }
              const crossMagnitude = (orphanParsed?.number >= 100) !== (candidateParsed?.number >= 100);
              const suffixOnly = orphanParsed?.number !== candidateParsed?.number
                && Number.isFinite(orphanParsed?.suffix2)
                && Number.isFinite(candidateParsed?.suffix2)
                && orphanParsed?.suffix2 === candidateParsed?.suffix2;
              if (crossMagnitude && suffixOnly && scores.endpointScore < 0.2 && scores.spatialScore < 0.55) {
                return;
              }
              if (scores.spatialScore > maxScore) {
                maxScore = scores.spatialScore;
              }
            });
            if (maxScore > bestScore) {
              bestScore = maxScore;
              bestGroup = group;
            }
          });
          if (bestGroup && bestScore >= ATTACH_MIN_SPATIAL_SCORE) {
            bestGroup.routes.push({ id: orphanId, type: orphanRoute?.type || "" });
            bestGroup.count = bestGroup.routes.length;
          }
        });

        const attachedGroups = coreGroups
          .filter((group) => group && group.count >= 2)
          .sort((a, b) => b.count - a.count);

        if (attachedGroups.length === 0) {
          return {
            type: "route-pills",
            groups: [],
            emptyMessage: "No route families found with the current heuristic."
          };
        }

        const groupsWithMetrics = attachedGroups.map((group) => {
          const routeIds = group.routes
            .map((route) => String(route?.id || route?.routeId || route?.route || "").trim().toUpperCase())
            .filter(Boolean);
          let pairCount = 0;
          let overlapSum = 0;
          let overlapCount = 0;
          let terminiSum = 0;
          let numberSum = 0;
          const perRoute = new Map();
          for (let i = 0; i < routeIds.length; i += 1) {
            for (let j = i + 1; j < routeIds.length; j += 1) {
              const a = rowById.get(routeIds[i]);
              const b = rowById.get(routeIds[j]);
              if (!a || !b) {
                continue;
              }
              pairCount += 1;
              const overlap = bboxOverlapRatio(a.row, b.row);
              if (Number.isFinite(overlap)) {
                overlapSum += overlap;
                overlapCount += 1;
              }
              const termini = endpointMetric(a.row, b.row);
              const numberSeries = numericMetric(a.parsed, b.parsed);
              terminiSum += termini;
              numberSum += numberSeries;

              if (!perRoute.has(a.routeId)) {
                perRoute.set(a.routeId, { overlapSum: 0, overlapCount: 0, terminiSum: 0, numberSum: 0, pairs: 0 });
              }
              if (!perRoute.has(b.routeId)) {
                perRoute.set(b.routeId, { overlapSum: 0, overlapCount: 0, terminiSum: 0, numberSum: 0, pairs: 0 });
              }
              const aEntry = perRoute.get(a.routeId);
              const bEntry = perRoute.get(b.routeId);
              if (Number.isFinite(overlap)) {
                aEntry.overlapSum += overlap;
                aEntry.overlapCount += 1;
                bEntry.overlapSum += overlap;
                bEntry.overlapCount += 1;
              }
              aEntry.terminiSum += termini;
              aEntry.numberSum += numberSeries;
              aEntry.pairs += 1;
              bEntry.terminiSum += termini;
              bEntry.numberSum += numberSeries;
              bEntry.pairs += 1;
            }
          }
          const metrics = {
            overlap: overlapCount > 0 ? overlapSum / overlapCount : null,
            termini: pairCount > 0 ? terminiSum / pairCount : null,
            number_series: pairCount > 0 ? numberSum / pairCount : null
          };
          const confidence = computeConfidence(metrics);
          const perRouteMetrics = routeIds.map((routeId) => {
            const entry = perRoute.get(routeId);
            const overlap = entry && entry.overlapCount > 0 ? entry.overlapSum / entry.overlapCount : null;
            const termini = entry && entry.pairs > 0 ? entry.terminiSum / entry.pairs : null;
            const numberSeries = entry && entry.pairs > 0 ? entry.numberSum / entry.pairs : null;
            const routeMetrics = {
              overlap,
              termini,
              number_series: numberSeries
            };
            return {
              route_id: routeId,
              metrics: routeMetrics,
              confidence: computeConfidence(routeMetrics)
            };
          });
          return {
            ...group,
            metrics,
            confidence,
            weights: METRIC_WEIGHTS,
            per_route: perRouteMetrics
          };
        });

        const filteredByConfidence = groupsWithMetrics.filter((group) => {
          if (group.count > 2) {
            return true;
          }
          const value = Number.isFinite(group.confidence) ? group.confidence : 0;
          return value >= MIN_PAIR_CONFIDENCE;
        });

        if (filteredByConfidence.length === 0) {
          return {
            type: "route-pills",
            groups: [],
            emptyMessage: "No route families found with the current heuristic."
          };
        }

        return {
          type: "route-pills",
          groups: filteredByConfidence
        };
      }
    },
    "route-family-series": {
      id: "route-family-series",
      label: "Route number series ranking (00-99)",
      requiresSpatial: true,
      run: (rows) => {
        const list = Array.isArray(rows) ? rows : [];
        if (list.length === 0) {
          return {
            type: "table",
            columns: ["Series", "Routes", "Avg cohesion", "Best pair", "Example routes"],
            rows: [["No routes available", "", "", "", ""]]
          };
        }

        const toRad = (value) => (Number(value) * Math.PI) / 180;
        const distanceKm = (a, b) => {
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
          return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
        };

        const parseRouteId = (value) => {
          const raw = String(value || "").trim().toUpperCase();
          if (!raw) {
            return { raw: "", prefix: "", number: null, suffix2: null };
          }
          const match = raw.match(/^([A-Z]+)?(\d+)(.*)?$/);
          if (!match) {
            return { raw, prefix: "", number: null, suffix2: null };
          }
          const prefix = match[1] || "";
          const number = Number(match[2]);
          const numberStr = match[2] || "";
          const suffix2 = numberStr.length >= 2 ? Number(numberStr.slice(-2)) : number;
          return {
            raw,
            prefix,
            number: Number.isFinite(number) ? number : null,
            suffix2: Number.isFinite(suffix2) ? suffix2 : null
          };
        };

        const endpointSimilarity = (a, b) => {
          const startA = [a.endpoint_start_lat, a.endpoint_start_lon];
          const endA = [a.endpoint_end_lat, a.endpoint_end_lon];
          const startB = [b.endpoint_start_lat, b.endpoint_start_lon];
          const endB = [b.endpoint_end_lat, b.endpoint_end_lon];
          const THRESH = 0.6;

          const startStart = distanceKm(startA, startB);
          const endEnd = distanceKm(endA, endB);
          const startEnd = distanceKm(startA, endB);
          const endStart = distanceKm(endA, startB);

          const aligned = (startStart <= THRESH && endEnd <= THRESH) || (startEnd <= THRESH && endStart <= THRESH);
          if (aligned) {
            return 0.55;
          }
          const shared = Math.min(startStart, endEnd, startEnd, endStart) <= THRESH;
          return shared ? 0.25 : 0;
        };

        const bboxOverlapScore = (a, b) => {
          const aNorth = a.northmost_lat;
          const aSouth = a.southmost_lat;
          const aEast = a.eastmost_lon;
          const aWest = a.westmost_lon;
          const bNorth = b.northmost_lat;
          const bSouth = b.southmost_lat;
          const bEast = b.eastmost_lon;
          const bWest = b.westmost_lon;
          if (![aNorth, aSouth, aEast, aWest, bNorth, bSouth, bEast, bWest].every(Number.isFinite)) {
            return 0;
          }
          const north = Math.min(aNorth, bNorth);
          const south = Math.max(aSouth, bSouth);
          const east = Math.min(aEast, bEast);
          const west = Math.max(aWest, bWest);
          if (north <= south || east <= west) {
            return 0;
          }
          const interArea = (north - south) * (east - west);
          const areaA = (aNorth - aSouth) * (aEast - aWest);
          const areaB = (bNorth - bSouth) * (bEast - bWest);
          if (!Number.isFinite(interArea) || !Number.isFinite(areaA) || !Number.isFinite(areaB) || areaA <= 0 || areaB <= 0) {
            return 0;
          }
          const overlapRatio = interArea / Math.min(areaA, areaB);
          if (overlapRatio >= 0.6) {
            return 0.45;
          }
          if (overlapRatio >= 0.35) {
            return 0.25;
          }
          return 0;
        };

        const enriched = list
          .map((row) => {
            const routeId = String(row.route_id || row.route_id_norm || "").trim().toUpperCase();
            if (!routeId) {
              return null;
            }
            const parsed = parseRouteId(routeId);
            if (!Number.isFinite(parsed.suffix2)) {
              return null;
            }
            return { row, routeId, parsed };
          })
          .filter(Boolean);

        const seriesMap = new Map();
        enriched.forEach((entry) => {
          const key = String(entry.parsed.suffix2).padStart(2, "0");
          if (!seriesMap.has(key)) {
            seriesMap.set(key, []);
          }
          seriesMap.get(key).push(entry);
        });

        const rowsOut = Array.from(seriesMap.entries()).map(([series, entries]) => {
          let pairCount = 0;
          let scoreSum = 0;
          let bestScore = 0;
          for (let i = 0; i < entries.length; i += 1) {
            for (let j = i + 1; j < entries.length; j += 1) {
              const a = entries[i];
              const b = entries[j];
              const score = endpointSimilarity(a.row, b.row) + bboxOverlapScore(a.row, b.row);
              scoreSum += score;
              pairCount += 1;
              if (score > bestScore) {
                bestScore = score;
              }
            }
          }
          const avgScore = pairCount > 0 ? scoreSum / pairCount : 0;
          const routes = entries.map((entry) => entry.routeId).sort();
          const exampleRoutes = routes.length > 8 ? `${routes.slice(0, 8).join(", ")} +${routes.length - 8}` : routes.join(", ");
          return [
            series,
            routes.length,
            formatNumber(avgScore, 2),
            formatNumber(bestScore, 2),
            exampleRoutes
          ];
        });

        rowsOut.sort((a, b) => (parseFloat(b[2]) || 0) - (parseFloat(a[2]) || 0));

        return {
          type: "table",
          columns: ["Series", "Routes", "Avg cohesion", "Best pair", "Example routes"],
          rows: rowsOut
        };
      }
    }
  };

  /**
   * Runs a single registered analysis.
   *
   * @param {string} analysisId Registry key to execute.
   * @param {Array<object>} rows Route rows within the chosen scope.
   * @param {object} context Additional runtime context for the analysis.
   * @returns {object|null} Analysis payload, or `null` when the id is unknown.
   */
  const runAnalysis = (analysisId, rows, context) => {
    const entry = analysisRegistry[analysisId];
    if (!entry) {
      return null;
    }
    return entry.run(rows || [], context || {});
  };

  /**
   * Lists available analyses for UI population.
   *
   * @returns {Array<object>} Registered analysis descriptors in declaration order.
   */
  const getAnalyses = () => Object.values(analysisRegistry);

  window.RouteMapsterAnalyses = {
    getAnalyses,
    runAnalysis,
    analysisRegistry
  };
})();

