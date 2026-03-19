/**
 * Loads a browser-targeted bundle into Node for unit testing.
 *
 * The helper resets `require` cache and wires a synthetic `window` so the
 * browser modules can expose their globals without a real DOM.
 */
const path = require("node:path");

/**
 * Require a browser bundle after preparing the global test harness.
 *
 * @param {string} relativePath Repository-relative path to the browser module.
 * @param {{window?: object, fetch?: Function}} [options={}] Optional globals to inject before loading.
 * @returns {object} The synthetic `window` object populated by the module under test.
 * Side effects: Replaces `global.window`, optionally replaces `global.fetch`, and clears the require cache.
 */
function loadBrowserModule(relativePath, options = {}) {
  const filePath = path.resolve(__dirname, "..", "..", relativePath);
  delete require.cache[filePath];

  const windowValue = options.window || {};
  global.window = windowValue;

  if (Object.prototype.hasOwnProperty.call(options, "fetch")) {
    global.fetch = options.fetch;
  } else {
    delete global.fetch;
  }

  require(filePath);
  return global.window;
}

module.exports = {
  loadBrowserModule
};
