const path = require("node:path");

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
