const { test, expect } = require('@playwright/test');
const {
  firstOptionValue,
  getFirstMarkerPoint,
  getRouteHoverPoint,
  gotoApp,
  hoverMapPoint,
  openModule,
  stubExternalAssets,
  waitForLayer
} = require('./helpers/app');

test.beforeEach(async ({ page }) => {
  await stubExternalAssets(page);
  await gotoApp(page);
});

test('shows route hover and route geometry details', async ({ page }) => {
  const point = await getRouteHoverPoint(page);

  await hoverMapPoint(page, point);

  const popup = page.locator('.leaflet-popup.hover-popup').last();
  await expect(popup).toBeVisible();
  await expect(popup.locator('.hover-popup__title')).toContainText(/Route|Routes here/);

  const mapBox = await page.locator('#map').boundingBox();
  await page.mouse.click(mapBox.x + point.x, mapBox.y + point.y);

  await expect(page.locator('#infoSubtitle')).toHaveText('Route geometry');
  await expect(page.locator('#infoBody')).toContainText('Routes here');
});

test('shows and selects bus stops', async ({ page }) => {
  await openModule(page, 'stops');
  await page.locator('#showBusStops').check();
  await waitForLayer(page, () => Boolean(window.RouteMapsterAPI?.appState?.busStopLayer));

  const point = await getFirstMarkerPoint(page, 'busStopLayer');

  const mapBox = await page.locator('#map').boundingBox();
  await page.mouse.click(mapBox.x + point.x, mapBox.y + point.y);

  await page.waitForFunction(() => window.RouteMapsterAPI?.appState?.infoPanelKind === 'stop');
  await expect(page.locator('#infoTitle')).not.toHaveText('Details');
  await expect(page.locator('#infoBody')).toContainText('Routes');
});

test('selects a bus station from the station module', async ({ page }) => {
  await openModule(page, 'stations');
  await waitForLayer(page, () => {
    const select = document.getElementById('busStationSelect');
    return Boolean(select && select.options.length > 1);
  });

  const value = await firstOptionValue(page, '#busStationSelect');
  await page.locator('#busStationSelect').selectOption(value);

  await page.waitForFunction(() => window.RouteMapsterAPI?.appState?.infoPanelKind === 'station');
  await expect(page.locator('#infoBody')).toContainText('Routes');
});

test('selects a garage from the garage module', async ({ page }) => {
  await openModule(page, 'garages');
  await waitForLayer(page, () => {
    const select = document.getElementById('garageSelect');
    return Boolean(select && select.options.length > 1);
  });

  const value = await firstOptionValue(page, '#garageSelect');
  await page.locator('#garageSelect').selectOption(value);

  await page.waitForFunction(() => window.RouteMapsterAPI?.appState?.infoPanelKind === 'garage');
  await expect(page.locator('#infoBody')).toContainText('Routes');
});

test('shows combined frequency hover details when the overlay is enabled', async ({ page }) => {
  await openModule(page, 'frequencies');
  await page.locator('#showFrequencyOverlay').check();
  await waitForLayer(page, () => window.RouteMapsterAPI?.appState?.showFrequencyLayer === true);
  await page.waitForTimeout(1_000);

  const point = await getRouteHoverPoint(page);
  await hoverMapPoint(page, point);

  const popup = page.locator('.leaflet-popup.hover-popup').last();
  await expect(popup).toBeVisible();
  await expect(popup).toContainText('Combined frequency');
});

test('applies an advanced route filter and shows results', async ({ page }) => {
  await openModule(page, 'advanced-filters');
  await page.locator('#advancedRouteSearch').fill('12');
  await page.locator('#advancedApplyFilters').click();

  await expect(page.locator('#advancedRouteCount')).not.toHaveText('0 routes found');
  await expect(page.locator('#advancedRouteList .route-card').first()).toBeVisible({ timeout: 15_000 });
});

test('returns omni search results for a route query', async ({ page }) => {
  await page.locator('#openOmniSearch').click();
  await expect(page.locator('#omniSearchModal')).toHaveAttribute('aria-hidden', 'false');

  const input = page.locator('#omniSearchInput');
  await input.fill('12');

  const results = page.locator('#omniSearchResults .omni-result');
  await expect(results.first()).toBeVisible();
  await expect(results.first()).toContainText('12');
});
