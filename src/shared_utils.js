(() => {
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

  const normaliseBoroughToken = (value) => {
    if (!value) {
      return "";
    }
    return String(value).trim().toLowerCase();
  };

  const normaliseRegionToken = (value) => String(value || "").trim().toUpperCase();

  window.RouteMapsterUtils = {
    escapeHtml,
    formatNumber,
    downloadCsv,
    normalisePostcodeDistrict,
    normaliseBoroughToken,
    normaliseRegionToken
  };
})();
