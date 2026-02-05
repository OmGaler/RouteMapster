(() => {
  const asNumber = (value) => (Number.isFinite(value) ? value : null);
  const formatNumber = (value, digits = 1) => {
    if (!Number.isFinite(value)) {
      return "";
    }
    if (digits === 0) {
      return String(Math.round(value));
    }
    return value.toFixed(digits);
  };

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

  const getGarages = (row) => {
    const list = [];
    if (row.garage_codes_arr && row.garage_codes_arr.length > 0) {
      list.push(...row.garage_codes_arr);
    }
    if (row.garage_names_arr && row.garage_names_arr.length > 0) {
      list.push(...row.garage_names_arr);
    }
    return list.length > 0 ? list : ["Unknown"];
  };

  const analysisRegistry = {
    "routes-by-operator": {
      id: "routes-by-operator",
      label: "Routes by operator",
      run: (rows) => {
        const counts = new Map();
        rows.forEach((row) => {
          getOperators(row).forEach((operator) => {
            counts.set(operator, (counts.get(operator) || 0) + 1);
          });
        });
        const sorted = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
        return {
          type: "table",
          columns: ["Operator", "Routes"],
          rows: sorted.map(([operator, count]) => [operator, count])
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
        return {
          type: "table",
          columns: ["Garage", "Routes"],
          rows: sorted.map(([garage, count]) => [garage, count])
        };
      }
    },
    "service-type-by-operator": {
      id: "service-type-by-operator",
      label: "Service type breakdown by operator",
      run: (rows) => {
        const summary = new Map();
        rows.forEach((row) => {
          getOperators(row).forEach((operator) => {
            if (!summary.has(operator)) {
              summary.set(operator, { regular: 0, night: 0, school: 0, twentyfour: 0, unknown: 0 });
            }
            const entry = summary.get(operator);
            const type = String(row.route_type || "unknown").toLowerCase();
            if (entry[type] !== undefined) {
              entry[type] += 1;
            } else {
              entry.unknown += 1;
            }
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
              counts.unknown,
              total
            ];
          });
        return {
          type: "table",
          columns: ["Operator", "Regular", "Night", "School", "24hr", "Unknown", "Total"],
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
          const vehicle = row.vehicle_type || "";
          const bucket = vehicle === "SD" ? "SD" : vehicle === "DD" ? "DD" : "Other";
          getOperators(row).forEach((operator) => {
            if (!summary.has(operator)) {
              summary.set(operator, { SD: 0, DD: 0, Other: 0 });
            }
            const entry = summary.get(operator);
            entry[bucket] += 1;
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
              counts.Other,
              total,
              `${formatNumber(sdShare, 0)}%`,
              `${formatNumber(ddShare, 0)}%`
            ];
          });
        return {
          type: "table",
          columns: ["Operator", "SD", "DD", "Other", "Total", "SD share", "DD share"],
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
          getOperators(row).forEach((operator) => {
            if (!summary.has(operator)) {
              summary.set(operator, { peakAm: [], peakPm: [], offpeak: [], overnight: [] });
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
            formatNumber(average(values.overnight))
          ])
          .sort((a, b) => {
            const aVal = parseFloat(a[1]) || 0;
            const bVal = parseFloat(b[1]) || 0;
            return bVal - aVal;
          });
        return {
          type: "table",
          columns: ["Operator", "Avg Peak AM", "Avg Peak PM", "Avg Offpeak", "Avg Overnight"],
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
        return {
          type: "table",
          columns: ["Rank", "Route", "Operator", "Peak AM", "Offpeak", "Overnight"],
          rows: sorted.map((row, index) => [
            index + 1,
            row.route_id || row.route_id_norm,
            getOperators(row)[0],
            formatNumber(row.frequency_peak_am),
            formatNumber(row.frequency_offpeak),
            formatNumber(row.frequency_overnight)
          ])
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
          getOperators(row).forEach((operator) => {
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
    "shared-endpoints": {
      id: "shared-endpoints",
      label: "Routes sharing the same endpoints",
      requiresSpatial: true,
      run: (rows) => {
        const PRIMARY_PRECISION = 3;
        const FALLBACK_PRECISION = 2;
        const MIN_ENDPOINT_DISTANCE_KM = 0.3;

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
          }
          entry.aLatSum += a[0];
          entry.aLonSum += a[1];
          entry.bLatSum += b[0];
          entry.bLonSum += b[1];
          entry.count += 1;
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
    }
  };

  const runAnalysis = (analysisId, rows) => {
    const entry = analysisRegistry[analysisId];
    if (!entry) {
      return null;
    }
    return entry.run(rows || []);
  };

  const getAnalyses = () => Object.values(analysisRegistry);

  window.RouteMapsterAnalyses = {
    getAnalyses,
    runAnalysis,
    analysisRegistry
  };
})();

