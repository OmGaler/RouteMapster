/**
 * Provides browser-side utility helpers shared across RouteMapster modules.
 *
 * The application loads this file early and exposes the helpers on
 * `window.RouteMapsterUtils` so feature modules can reuse consistent escaping,
 * formatting, and token normalisation without duplicating logic.
 */
(() => {
  /**
   * Escapes text for safe HTML insertion.
   *
   * @param {unknown} value Value to render into HTML.
   * @returns {string} Escaped string.
   */
  const escapeHtml = (value) => String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

  /**
   * Formats a finite number for UI display.
   *
   * @param {number} value Numeric value to format.
   * @param {number} [digits=1] Decimal places to retain for non-integer output.
   * @returns {string} Formatted number, or an empty string when the input is invalid.
   */
  const formatNumber = (value, digits = 1) => {
    if (!Number.isFinite(value)) {
      return "";
    }
    return digits === 0 ? String(Math.round(value)) : value.toFixed(digits);
  };

  /**
   * Downloads tabular data as a CSV file.
   *
   * @param {string} filename Suggested download filename.
   * @param {string[]} columns Column headings in output order.
   * @param {Array<Array<unknown>>} rows Data rows to serialise.
   * @returns {void}
   * Side effects: Creates a temporary blob URL, inserts a temporary anchor,
   * and triggers a browser download.
   */
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

  /**
   * Normalises a postcode into its district token for filtering.
   *
   * @param {unknown} value Raw postcode or postcode-like value.
   * @returns {string} Canonical district token, or an empty string when absent.
   */
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

  /**
   * Normalises borough labels into a comparison-friendly token.
   *
   * @param {unknown} value Borough name from UI or dataset input.
   * @returns {string} Lower-case token with stable spacing and `and` handling.
   */
  const normaliseBoroughToken = (value) => {
    if (!value) {
      return "";
    }
    return String(value)
      .replace(/&/g, " and ")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ");
  };

  /**
   * Normalises a London region code used by stop analytics.
   *
   * @param {unknown} value Raw region token.
   * @returns {string} Upper-case region code.
   */
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
