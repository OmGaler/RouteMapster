const fs = require('fs');
const path = require('path');
const { expect } = require('@playwright/test');

const leafletDistDir = path.resolve(__dirname, '..', '..', '..', 'node_modules', 'leaflet', 'dist');

async function stubExternalAssets(page) {
  await page.route('https://unpkg.com/leaflet@1.9.4/dist/leaflet.css', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/css',
      body: fs.readFileSync(path.join(leafletDistDir, 'leaflet.css'), 'utf8')
    });
  });

  await page.route('https://unpkg.com/leaflet@1.9.4/dist/leaflet.js', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/javascript',
      body: fs.readFileSync(path.join(leafletDistDir, 'leaflet.js'), 'utf8')
    });
  });

  await page.route(/https:\/\/unpkg\.com\/leaflet@1\.9\.4\/dist\/images\/.+/, async (route) => {
    const url = new URL(route.request().url());
    const fileName = path.basename(url.pathname);
    const filePath = path.join(leafletDistDir, 'images', fileName);
    await route.fulfill({
      status: 200,
      contentType: getContentType(fileName),
      body: fs.readFileSync(filePath)
    });
  });

  await page.route(/https:\/\/[abc]\.tile\.openstreetmap\.org\/.*/, async (route) => {
    await route.fulfill({ status: 204, body: '' });
  });

  await page.route(/https:\/\/fonts\.(googleapis|gstatic)\.com\/.*/, async (route) => {
    await route.fulfill({ status: 204, body: '' });
  });

  await page.route('**/_vercel/insights/script.js', async (route) => {
    await route.fulfill({ status: 204, body: '' });
  });
}

async function gotoApp(page) {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => {
    return Boolean(window.RouteMapsterAPI?.appState?.map && window.RouteMapsterAPI?.appState?.networkRouteLayer);
  });
  await page.waitForTimeout(1_000);
}

async function openModule(page, moduleName) {
  const module = page.locator(`details[data-module="${moduleName}"]`);
  await expect(module).toHaveCount(1);
  const isOpen = await module.evaluate((node) => node.open);
  if (!isOpen) {
    await module.locator(':scope > summary').click();
  }
}

async function waitForLayer(page, expression) {
  await page.waitForFunction(expression);
}

async function firstOptionValue(page, selector) {
  return page.locator(`${selector} option:not([value=""])`).first().getAttribute('value');
}

async function getRouteHoverPoint(page) {
  return page.evaluate(() => {
    const api = window.RouteMapsterAPI;
    let firstRoute = null;
    api.appState.networkRouteLayer.eachLayer((layer) => {
      if (!firstRoute && typeof layer.getLatLngs === 'function') {
        firstRoute = layer;
      }
    });
    const latlngs = firstRoute?.getLatLngs?.();
    const firstSegment = Array.isArray(latlngs?.[0]) ? latlngs[0] : latlngs;
    const center = Array.isArray(firstSegment) && firstSegment.length
      ? firstSegment[Math.floor(firstSegment.length / 2)]
      : null;
    if (!center) {
      return null;
    }
    const point = api.appState.map.latLngToContainerPoint(center);
    return { x: point.x, y: point.y };
  });
}

async function getFirstMarkerPoint(page, layerKey) {
  return page.evaluate((key) => {
    const api = window.RouteMapsterAPI;
    const layerGroup = api.appState[key];
    const bounds = api.appState.map?.getBounds?.();
    let marker = null;
    layerGroup?.eachLayer((layer) => {
      const latlng = layer?.getLatLng?.();
      if (!marker && latlng && (!bounds || bounds.contains(latlng))) {
        marker = layer;
      }
    });
    const latlng = marker?.getLatLng?.();
    if (!latlng) {
      return null;
    }
    const point = api.appState.map.latLngToContainerPoint(latlng);
    return { x: point.x, y: point.y };
  }, layerKey);
}

async function hoverMapPoint(page, point) {
  const mapBox = await page.locator('#map').boundingBox();
  if (!mapBox || !point) {
    throw new Error('Map point unavailable for hover');
  }
  const offsets = [
    [0, 0],
    [3, 0],
    [-3, 0],
    [0, 3],
    [0, -3],
    [6, 0],
    [-6, 0],
    [0, 6],
    [0, -6]
  ];

  for (const [dx, dy] of offsets) {
    await page.mouse.move(mapBox.x + point.x + dx, mapBox.y + point.y + dy);
    await page.waitForTimeout(150);
    const popup = page.locator('.leaflet-popup.hover-popup').last();
    if (await popup.isVisible().catch(() => false)) {
      return;
    }
  }

  throw new Error('Hover popup did not appear near the expected map point');
}

function getContentType(fileName) {
  const extension = path.extname(fileName).toLowerCase();
  if (extension === '.png') {
    return 'image/png';
  }
  if (extension === '.svg') {
    return 'image/svg+xml';
  }
  return 'application/octet-stream';
}

module.exports = {
  firstOptionValue,
  getFirstMarkerPoint,
  getRouteHoverPoint,
  gotoApp,
  hoverMapPoint,
  openModule,
  stubExternalAssets,
  waitForLayer
};
