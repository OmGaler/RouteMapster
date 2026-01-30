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
          if (!Number.isFinite(row.length_km)) {
            return;
          }
          getOperators(row).forEach((operator) => {
            if (!summary.has(operator)) {
              summary.set(operator, []);
            }
            summary.get(operator).push(row.length_km);
          });
        });
        if (summary.size === 0) {
          return {
            type: "table",
            columns: ["Operator", "Avg length (km)"],
            rows: [["No length_km data available", ""]]
          };
        }
        const rowsOut = Array.from(summary.entries())
          .map(([operator, values]) => [operator, formatNumber(average(values), 2)])
          .sort((a, b) => (parseFloat(b[1]) || 0) - (parseFloat(a[1]) || 0));
        return {
          type: "table",
          columns: ["Operator", "Avg length (km)"],
          rows: rowsOut
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

