// RouteMapster 
// Initialises Leaflet map 
const GEOCODE_DELAY_MS = 1100;
const LONDON_BOUNDS = {
	minLat: 51.28,
	maxLat: 51.72,
	minLon: -0.55,
	maxLon: 0.35
};

const ROUTE_GEOMETRY_DIR = "/data/processed/routes";
const ROUTE_GEOMETRY_INDEX_PATH = "/data/processed/routes/index.json";
const BUS_STOPS_GEOJSON_PATH = "/data/processed/stops.geojson";
const BUS_STATIONS_GEOJSON_PATH = "/data/processed/bus_stations.geojson";
const GARAGES_GEOJSON_PATH = "/data/processed/garages.geojson";
const VEHICLE_LOOKUP_PATH = "/data/vehicles.json";
const FREQUENCY_DATA_PATH = "/data/processed/frequencies.json";

const ROUTE_COLOURS = {
	regular: "#ef4444",
	twentyFour: "#16b5f0",
	night: "#f59e0b",
	school: "#3b82f6",
	prefix: "#10b981"
};
const DEFAULT_ROUTE_DRAW_ORDER = ["regular", "twentyfour", "prefix", "night", "school"];
// const DEFAULT_ROUTE_DRAW_ORDER = ["school", "night", "prefix", "twentyfour", "regular"];
const ROUTE_PANE = "routes-pane";
const STOP_PANE = "stops-pane";
const STATION_PANE = "stations-pane";
const GARAGE_PANE = "garages-pane";
const HIGHLIGHT_PANE = "highlight-pane";
const MAP_PANE_ORDER = [
	{ name: ROUTE_PANE, zIndex: 410 },
	{ name: STOP_PANE, zIndex: 420 },
	{ name: STATION_PANE, zIndex: 430 },
	{ name: GARAGE_PANE, zIndex: 440 },
	{ name: HIGHLIGHT_PANE, zIndex: 450 }
];

function configureMapPanes(map) {
	if (!map) {
		return;
	}
	MAP_PANE_ORDER.forEach(({ name, zIndex }) => {
		const pane = map.createPane(name);
		if (pane) {
			pane.style.zIndex = String(zIndex);
			if (name === HIGHLIGHT_PANE) {
				// Prevent highlight overlay from blocking interactions with markers/routes.
				pane.style.pointerEvents = "none";
			}
		}
	});
}

async function initialiseRouteGeometryIndex() {
	const routeIds = await loadRouteGeometryRouteIds();
	if (routeIds && routeIds.size) {
		updateSelectedInfo(`Loaded ${routeIds.size} route geometries.`);
		return;
	}
	updateSelectedInfo("Route geometry index unavailable.");
}

function initMap() {
	const map = L.map('map', { preferCanvas: true }).setView([51.5074, -0.1278], 11);

	L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
		attribution: '&copy; OpenStreetMap contributors',
		opacity: 0.85
	}).addTo(map);
	configureMapPanes(map);

	return map;
}

const appState = {
	map: null,
	routes: [],
	stops: [],
	garages: [],
	garagesGeojson: null,
	garageLayer: null,
	garageMarkers: [],
	garageLoadToken: 0,
	busStopsGeojson: null,
	busStationsGeojson: null,
	busStopLayer: null,
	busStopLoadToken: 0,
	busStopFilterDistrict: "",
	busStandLayer: null,
	busStandLoadToken: 0,
	stopRoutesIndex: null,
	stopRoutesFromLines: new Map(),
	stopPointFetches: new Map(),
	routeStopFetches: new Map(),
	vehicleLookup: null,
	vehicleLookupPromise: null,
	busStationLayer: null,
	busStationLoadToken: 0,
	busStationData: null,
	activeBusStationRoutes: null,
	busStationRouteLayer: null,
	busStationRouteLoadToken: 0,
	useRouteTypeColours: false,
	selectedFeature: null,
	busStationHighlightLayer: null,
	routeGeometryCache: new Map(),
	garageRouteLayer: null,
	networkRouteLayer: null,
	focusRouteLayer: null,
	focusRouteId: null,
	focusRouteLoadToken: 0,
	showNetworkRoutes: true,
	suppressNetworkRoutes: false,
	activeGarageRoutes: null,
	routeLoadToken: 0,
	networkRouteLoadToken: 0,
	networkRouteSets: null,
	geometryRouteIds: undefined,
	routeFilterTokens: [],
	frequencyData: null,
	frequencyLoadPromise: null,
	frequencyBand: "peak_am",
	showFrequencyLayer: false,
	frequencySegmentTotals: null,
	frequencyMaxTotal: 0,
	geocodeLastAt: 0,
	selectedFeatureToken: 0,
};


function updateSelectedInfo(text) {
	document.getElementById('selectedInfo').textContent = text;
}

function updateSelectedRouteCount(count) {
	const total = Number.isFinite(count) ? count : 0;
	const label = total === 1 ? "1 route selected" : `${total} routes selected`;
	updateSelectedInfo(label);
}

function getStopName(props) {
	return props?.NAME || props?.STOP_NAME || "";
}

function getStopDisplayName(props) {
	return getStopName(props) || props?.STOP_CODE || props?.NAPTAN_ID || props?.NAPTAN_ATCO || "Bus stop";
}

function getStopRoadName(props) {
	return props?.ROAD_NAME || "";
}

function getStopCode(props) {
	return props?.STOP_CODE || props?.NAPTAN_ID || props?.NAPTAN_ATCO || "";
}

function escapeHtml(value) {
	return String(value || "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

function setInfoPanelVisible(visible) {
	const appRoot = document.getElementById("app");
	if (!appRoot) {
		return;
	}
	appRoot.classList.toggle("has-details", visible);
}

function setInfoPanel({ title, subtitle, bodyHtml }) {
	const titleEl = document.getElementById("infoTitle");
	const subtitleEl = document.getElementById("infoSubtitle");
	const bodyEl = document.getElementById("infoBody");
	if (titleEl) {
		titleEl.textContent = title || "Details";
	}
	if (subtitleEl) {
		if (subtitle) {
			subtitleEl.textContent = subtitle;
			subtitleEl.style.display = "";
		} else {
			subtitleEl.textContent = "";
			subtitleEl.style.display = "none";
		}
	}
	if (bodyEl) {
		bodyEl.innerHTML = bodyHtml || "";
	}
	setInfoPanelVisible(true);
}

function setSelectedFeature(type, data) {
	appState.selectedFeatureToken += 1;
	appState.selectedFeature = { type, data, token: appState.selectedFeatureToken };
}

function clearSelectedFeature() {
	appState.selectedFeature = null;
	appState.selectedFeatureToken += 1;
}

async function refreshSelectedInfoPanel() {
	if (!appState.selectedFeature) {
		return;
	}
	const { type, data, token } = appState.selectedFeature;
	const routeSets = appState.useRouteTypeColours ? await loadNetworkRouteSets() : null;
	if (!appState.selectedFeature || token !== appState.selectedFeature.token) {
		return;
	}
	if (type === "stop") {
		setInfoPanel(buildBusStopInfoHtml(data, routeSets));
		return;
	}
	if (type === "station") {
		setInfoPanel(buildBusStationInfoHtml(data, routeSets));
		return;
	}
	if (type === "garage") {
		setInfoPanel(buildGarageInfoHtml(data, routeSets));
	}
}

function resetInfoPanel() {
	setInfoPanel({
		title: "Details",
		subtitle: "Click a stop, station, or garage to view details.",
		bodyHtml: `
			<div class="info-section">
				<div class="info-label">Status</div>
				<div class="info-empty">No feature selected yet.</div>
			</div>
		`
	});
	setInfoPanelVisible(false);
	clearSelectedFeature();
}

function setLoadingModalVisible(visible) {
	const modal = document.getElementById("loadingModal");
	if (!modal) {
		return;
	}
	modal.classList.toggle("is-visible", visible);
	modal.setAttribute("aria-hidden", visible ? "false" : "true");
}


async function addGaragesLayer(map) {
  const loadToken = appState.garageLoadToken;
  const gj = await loadGaragesGeojson();
  if (loadToken !== appState.garageLoadToken) {
    return null;
  }

  clearGarageMarkers();
  const scaleEnabled = isGarageScaleEnabled();
  const labelsEnabled = isGarageLabelEnabled();
  const filteredGeojson = {
    ...gj,
    features: Array.isArray(gj?.features)
      ? gj.features.filter((feature) => garageHasRoutes(feature))
      : []
  };
  const groups = groupGaragesByLocation(filteredGeojson);
  const maxPercent = scaleEnabled ? getGarageScaleMax(groups) : 0;

  const layerGroup = L.layerGroup();
  groups.forEach((group) => {
    const groupPercent = getGarageGroupPercent(group.features);
    const radius = getGarageMarkerRadius(groupPercent, scaleEnabled, maxPercent);
    const marker = L.circleMarker(group.latlng, {
      radius,
      weight: 1,
      fillOpacity: 0.9,
      pane: GARAGE_PANE
    });
    const hoverHtml = buildGarageHoverHtml(group.features);
    bindHoverPopup(marker, hoverHtml);
    marker.on('click', () => {
      setSelectedFeature("garage", group.features);
      refreshSelectedInfoPanel().catch(() => {});
      selectGarageRoutes(group.features);
    });
    if (labelsEnabled) {
      const labelHtml = buildGarageLabelHtml(group.features);
      if (labelHtml) {
        marker.bindTooltip(labelHtml, {
          permanent: true,
          className: 'garage-label',
          direction: 'top',
          offset: [0, -8]
        });
      }
    }
    marker.addTo(layerGroup);
  });

  layerGroup.addTo(map);
  appState.garageLayer = layerGroup;
  return layerGroup;
}

function clearGarageMarkers() {
	if (appState.garageLayer && appState.map) {
		appState.map.removeLayer(appState.garageLayer);
		appState.garageLayer = null;
	}
}

function clearGarageRoutes() {
	if (appState.garageRouteLayer && appState.map) {
		appState.map.removeLayer(appState.garageRouteLayer);
		appState.garageRouteLayer = null;
	}
}

function clearBusStopsLayer() {
	if (appState.busStopLayer && appState.map) {
		appState.map.removeLayer(appState.busStopLayer);
		appState.busStopLayer = null;
	}
}

function clearBusStandsLayer() {
	if (appState.busStandLayer && appState.map) {
		appState.map.removeLayer(appState.busStandLayer);
		appState.busStandLayer = null;
	}
}

async function addBusStopsLayer(map) {
	if (!map) {
		return null;
	}
	const loadToken = appState.busStopLoadToken;
	const geojson = await loadBusStopsGeojson();
	if (loadToken !== appState.busStopLoadToken) {
		return null;
	}

	clearBusStopsLayer();
	const routeSets = appState.useRouteTypeColours ? await loadNetworkRouteSets() : null;
	const result = filterBusStops(geojson, appState.busStopFilterDistrict);
	const layerGroup = L.layerGroup();

	result.features.forEach((feature) => {
		const coords = feature?.geometry?.coordinates;
		if (!Array.isArray(coords) || coords.length < 2) {
			return;
		}
		const lon = Number(coords[0]);
		const lat = Number(coords[1]);
		if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
			return;
		}
		const marker = L.circleMarker([lat, lon], {
			radius: 4,
			weight: 1,
			color: "#1d4ed8",
			fillColor: "#2563eb",
			fillOpacity: 0.8,
			pane: STOP_PANE
		});
		bindHoverPopup(marker, () => buildBusStopPopup(feature.properties || {}));
		marker.on("click", () => {
			const props = feature.properties || {};
			setSelectedFeature("stop", props);
			refreshSelectedInfoPanel().catch(() => {});
			ensureStopPointRoutes(props)
				.then(() => refreshSelectedInfoPanel().catch(() => {}))
				.catch(() => {});
		});
		marker.addTo(layerGroup);
	});

	layerGroup.addTo(map);
	appState.busStopLayer = layerGroup;
	updateBusStopFilterStatus(result.count, result.district);
	return layerGroup;
}

async function addBusStandsLayer(map) {
	if (!map) {
		return null;
	}
	const loadToken = appState.busStandLoadToken;
	const geojson = await loadBusStopsGeojson();
	if (loadToken !== appState.busStandLoadToken) {
		return null;
	}

	clearBusStandsLayer();
	const result = filterBusStands(geojson);
	const layerGroup = L.layerGroup();

	result.features.forEach((feature) => {
		const coords = feature?.geometry?.coordinates;
		if (!Array.isArray(coords) || coords.length < 2) {
			return;
		}
		const lon = Number(coords[0]);
		const lat = Number(coords[1]);
		if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
			return;
		}
		const marker = L.circleMarker([lat, lon], {
			radius: 4,
			weight: 1,
			color: "#475569",
			fillColor: "#94a3b8",
			fillOpacity: 0.75,
			pane: STOP_PANE
		});
		bindHoverPopup(marker, () => buildBusStopPopup(feature.properties || {}));
		marker.on("click", () => {
			const props = feature.properties || {};
			setSelectedFeature("stop", props);
			refreshSelectedInfoPanel().catch(() => {});
			ensureStopPointRoutes(props)
				.then(() => refreshSelectedInfoPanel().catch(() => {}))
				.catch(() => {});
		});
		marker.addTo(layerGroup);
	});

	layerGroup.addTo(map);
	appState.busStandLayer = layerGroup;
	return layerGroup;
}

async function loadGaragesGeojson() {
	if (appState.garagesGeojson) {
		return appState.garagesGeojson;
	}
	const res = await fetch(GARAGES_GEOJSON_PATH);
	appState.garagesGeojson = await res.json();
	return appState.garagesGeojson;
}

async function loadBusStopsGeojson() {
	if (appState.busStopsGeojson) {
		return appState.busStopsGeojson;
	}
	const res = await fetch(BUS_STOPS_GEOJSON_PATH);
	appState.busStopsGeojson = await res.json();
	if (!appState.stopRoutesIndex) {
		appState.stopRoutesIndex = buildStopRouteIndex(appState.busStopsGeojson);
	}
	return appState.busStopsGeojson;
}

async function loadBusStationsGeojson() {
	if (appState.busStationsGeojson) {
		return appState.busStationsGeojson;
	}
	const res = await fetch(BUS_STATIONS_GEOJSON_PATH);
	appState.busStationsGeojson = await res.json();
	return appState.busStationsGeojson;
}

function normalisePostcodeDistrict(value) {
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
}

function getPostcodeDistrict(props) {
	return normalisePostcodeDistrict(props?.POSTCODE);
}

function formatRouteList(routes) {
	const list = Array.isArray(routes) ? routes : Array.from(routes || []);
	const unique = Array.from(new Set(list.map((route) => String(route)).filter(Boolean)));
	if (unique.length === 0) {
		return "Routes: None listed";
	}
	const sorted = sortRouteIds(unique);
	return `Routes: ${sorted.join(", ")}`;
}

function sortRouteIds(routes) {
	const list = Array.isArray(routes) ? routes : Array.from(routes || []);
	return list.slice().sort((a, b) => compareRouteIds(a, b));
}

function compareRouteIds(a, b) {
	const keyA = buildRouteSortKey(a);
	const keyB = buildRouteSortKey(b);
	for (let i = 0; i < keyA.length; i += 1) {
		if (keyA[i] < keyB[i]) {
			return -1;
		}
		if (keyA[i] > keyB[i]) {
			return 1;
		}
	}
	return 0;
}

function buildRouteSortKey(routeId) {
	const raw = String(routeId || "").trim().toUpperCase();
	if (!raw) {
		return [9, "", 0, ""];
	}
	if (/^\d+$/.test(raw)) {
		const value = Number(raw);
		if (value >= 1 && value <= 599) {
			return [0, "", value, raw];
		}
		if (value >= 600 && value <= 699) {
			return [1, "", value, raw];
		}
		return [2, "", value, raw];
	}
	if (raw.startsWith("SL")) {
		return [4, "SL", parsePrefixNumber(raw.slice(2)), raw];
	}
	if (raw.startsWith("N")) {
		return [5, "N", parsePrefixNumber(raw.slice(1)), raw];
	}
	const match = raw.match(/^([A-Z]+)(\d+)?(.*)$/);
	if (match) {
		const prefix = match[1];
		const number = match[2] ? Number(match[2]) : 0;
		const suffix = match[3] || "";
		return [3, prefix, number, suffix];
	}
	return [9, raw, 0, ""];
}

function parsePrefixNumber(value) {
	if (!value) {
		return 0;
	}
	const match = String(value).match(/^\d+/);
	return match ? Number(match[0]) : 0;
}

function getRoutePillClass(routeId, routeSets) {
	const normalised = String(routeId || "").toUpperCase();
	if (isSuperloopRoute(normalised)) {
		return "superloop";
	}
	if (isBakerloopRoute(normalised)) {
		return "bakerloop";
	}
	if (!appState.useRouteTypeColours) {
		return "regular";
	}
	if (normalised.startsWith("N")) {
		return "night";
	}
	const isRegular = routeSets?.regular?.has(normalised);
	const isSchool = routeSets?.school?.has(normalised);
	const isTwentyFour = routeSets?.twentyFour?.has(normalised);
	if (isTwentyFour) {
		return "twentyfour";
	}
	if (isSchool && !isRegular) {
		return "school";
	}
	if (isPrefixRoute(normalised)) {
		return "prefix";
	}
	return "regular";
}

function renderRoutePills(routes, routeSets) {
	const list = Array.isArray(routes) ? routes : Array.from(routes || []);
	const unique = Array.from(new Set(list.map((route) => String(route)).filter(Boolean)))
		.filter((route) => !isExcludedRoute(route));
	if (unique.length === 0) {
		return '<div class="info-empty">No routes listed.</div>';
	}
	const sorted = sortRouteIds(unique);
	const pills = sorted
		.map((route) => {
			const className = getRoutePillClass(route, routeSets);
			return `<span class="route-pill route-pill--${className}" data-route="${escapeHtml(route)}">${escapeHtml(route)}</span>`;
		})
		.join("");
	return `<div class="route-pill-group">${pills}</div>`;
}

function renderStopRoutePills(props, routes, routeSets) {
	const hasInlineRoutes = props?.ROUTES !== null && props?.ROUTES !== undefined;
	const stopId = getStopPointIdFromProps(props);
	const hasCachedRoutes = stopId && appState.stopRoutesFromLines.has(stopId);
	if (!hasInlineRoutes && !hasCachedRoutes && (!routes || routes.length === 0)) {
		return '<div class="info-empty">Routes unavailable.</div>';
	}
	return renderRoutePills(routes, routeSets);
}

function formatStopRoutes(props) {
	const tokens = getStopRouteTokens(props);
	return formatRouteList(tokens);
}

function buildBusStopPopup(props) {
	const name = getStopDisplayName(props);
	const routes = getStopRouteTokens(props);
	const routeSets = appState.useRouteTypeColours ? appState.networkRouteSets : null;
	return `
		<div class="hover-popup__content">
			<div class="hover-popup__title">${escapeHtml(name)}</div>
			<div class="hover-popup__routes">${renderStopRoutePills(props, routes, routeSets)}</div>
		</div>
	`;
}

function buildBusStopInfoHtml(props, routeSets) {
	const name = getStopDisplayName(props);
	const road = getStopRoadName(props);
	const postcode = props?.POSTCODE || "";
	const stopCode = getStopCode(props);
	const details = [
		road ? `Road: ${escapeHtml(road)}` : "",
		postcode ? `Postcode: ${escapeHtml(postcode)}` : "",
		stopCode ? `Stop code: ${escapeHtml(stopCode)}` : ""
	].filter(Boolean);

	const detailLines = details.length > 0
		? details.map((line) => `<div>${line}</div>`).join("")
		: '<div class="info-empty">No extra stop details listed.</div>';

	const routes = getStopRouteTokens(props);
	return {
		title: name,
		subtitle: "Bus stop",
		bodyHtml: `
			<div class="info-section">
				<div class="info-label">Stop details</div>
				${detailLines}
			</div>
			<div class="info-section">
				<div class="info-label">Routes serving</div>
				${renderStopRoutePills(props, routes, routeSets)}
			</div>
		`
	};
}

function isExcludedRoute(routeId) {
	if (!routeId) {
		return false;
	}
	const value = String(routeId).trim().toUpperCase();
	if (!value) {
		return false;
	}
	return value === "SCS" || value.startsWith("UL") || value.startsWith("Y");
}

function getStopPointIdFromProps(props) {
	const atco = String(props?.NAPTAN_ATCO || props?.NAPTAN_ID || "").trim();
	if (atco) {
		return atco;
	}
	const liveUrl = String(props?.LIVE_BUS_ARRIVAL || "");
	const match = liveUrl.match(/\/bus\/stop\/([^/]+)\//i);
	if (match && match[1]) {
		return match[1];
	}
	const stopCode = String(props?.STOP_CODE || props?.NAPTAN_ID || "").trim();
	if (/^\d{8,}$/.test(stopCode)) {
		return stopCode;
	}
	return "";
}

function addRouteToStopCache(stopId, routeId) {
	if (!stopId || !routeId) {
		return;
	}
	const key = String(routeId).toUpperCase();
	if (isExcludedRoute(key)) {
		return;
	}
	let set = appState.stopRoutesFromLines.get(stopId);
	if (!set) {
		set = new Set();
		appState.stopRoutesFromLines.set(stopId, set);
	}
	set.add(key);
	if (appState.stopRoutesIndex) {
		appState.stopRoutesIndex.add(key);
	}
}

function getStopRouteTokens(props) {
	const tokens = new Set(extractRouteTokens(props?.ROUTES).filter((routeId) => !isExcludedRoute(routeId)));
	const stopId = getStopPointIdFromProps(props);
	if (stopId && appState.stopRoutesFromLines.has(stopId)) {
		appState.stopRoutesFromLines.get(stopId).forEach((routeId) => {
			if (!isExcludedRoute(routeId)) {
				tokens.add(routeId);
			}
		});
	}
	return Array.from(tokens);
}

function buildStopRouteIndex(geojson) {
	const features = Array.isArray(geojson?.features) ? geojson.features : [];
	const tokens = new Set();
	features.forEach((feature) => {
		const props = feature?.properties || {};
		extractRouteTokens(props.ROUTES).forEach((routeId) => {
			if (!isExcludedRoute(routeId)) {
				tokens.add(routeId);
			}
		});
	});
	return tokens;
}

async function ensureStopPointRoutes(props) {
	const stopId = getStopPointIdFromProps(props);
	if (!stopId || appState.stopPointFetches.has(stopId)) {
		return;
	}
	if (appState.stopRoutesFromLines.has(stopId)) {
		return;
	}
	const url = `https://api.tfl.gov.uk/StopPoint/${encodeURIComponent(stopId)}`;
	const fetchPromise = fetch(url)
		.then((res) => (res.ok ? res.json() : null))
		.then((data) => {
			if (!data || !Array.isArray(data.lines)) {
				return;
			}
			data.lines.forEach((line) => {
				const mode = String(line?.modeName || "").toLowerCase();
				if (mode && mode !== "bus") {
					return;
				}
				const id = String(line?.id || line?.name || "").trim();
				if (!id || isExcludedRoute(id)) {
					return;
				}
				addRouteToStopCache(stopId, id);
			});
		})
		.catch(() => {});
	appState.stopPointFetches.set(stopId, fetchPromise);
	await fetchPromise;
}

async function ensureRouteStopData(routeId) {
	const normalised = String(routeId || "").trim().toUpperCase();
	if (!normalised || isExcludedRoute(normalised)) {
		return;
	}
	if (appState.stopRoutesIndex?.has(normalised)) {
		return;
	}
	if (appState.routeStopFetches.has(normalised)) {
		return appState.routeStopFetches.get(normalised);
	}
	const url = `https://api.tfl.gov.uk/Line/${encodeURIComponent(normalised)}/StopPoints`;
	const fetchPromise = fetch(url)
		.then((res) => (res.ok ? res.json() : null))
		.then((data) => {
			const stops = Array.isArray(data) ? data : data?.stopPoints;
			if (!Array.isArray(stops)) {
				return;
			}
			stops.forEach((stop) => {
				const stopId = String(stop?.id || stop?.naptanId || stop?.NaptanId || "").trim();
				if (!stopId) {
					return;
				}
				addRouteToStopCache(stopId, normalised);
			});
		})
		.catch(() => {});
	appState.routeStopFetches.set(normalised, fetchPromise);
	return fetchPromise;
}

function hasStopRoutes(props) {
	return getStopRouteTokens(props).length > 0;
}

function filterBusStops(geojson, district) {
	const features = Array.isArray(geojson?.features) ? geojson.features : [];
	const normalised = normalisePostcodeDistrict(district);
	if (!normalised) {
		const withRoutes = features.filter((feature) => {
			const props = feature?.properties || {};
			return hasStopRoutes(props);
		});
		return { features: withRoutes, count: withRoutes.length, district: "" };
	}
	const filtered = features.filter((feature) => {
		const props = feature?.properties || {};
		if (!hasStopRoutes(props)) {
			return false;
		}
		return getPostcodeDistrict(props) === normalised;
	});
	return { features: filtered, count: filtered.length, district: normalised };
}

function filterBusStands(geojson) {
	const features = Array.isArray(geojson?.features) ? geojson.features : [];
	const filtered = features.filter((feature) => {
		const props = feature?.properties || {};
		return !hasStopRoutes(props);
	});
	return { features: filtered, count: filtered.length };
}

function updateBusStopFilterStatus(count, district) {
	const status = document.getElementById("busStopFilterStatus");
	if (!status) {
		return;
	}
	if (district) {
		status.textContent = `Showing ${count} stops in ${district}.`;
	} else {
		status.textContent = "Showing all stops.";
	}
}

async function refreshBusStopFilterStatus() {
	const geojson = await loadBusStopsGeojson();
	const result = filterBusStops(geojson, appState.busStopFilterDistrict);
	updateBusStopFilterStatus(result.count, result.district);
}

function isGarageScaleEnabled() {
	const checkbox = document.getElementById('scaleGarageMarkers');
	return checkbox ? checkbox.checked : true;
}

function isGarageLabelEnabled() {
	const checkbox = document.getElementById('showGarageLabels');
	return checkbox ? checkbox.checked : true;
}

function isRouteTypeEnabled(id) {
	const checkbox = document.getElementById(id);
	return checkbox ? checkbox.checked : false;
}

function garageHasRoutes(feature) {
	if (!feature || !feature.properties) {
		return false;
	}
	const props = feature.properties;
	const tokens = []
		.concat(extractRouteTokens(props["TfL main network routes"]))
		.concat(extractRouteTokens(props["TfL night routes"]))
		.concat(extractRouteTokens(props["TfL school/mobility routes"]))
		.concat(extractRouteTokens(props["Other routes"]));
	return tokens.length > 0;
}

function groupGaragesByLocation(geojson) {
	const groups = [];
	if (!geojson || !Array.isArray(geojson.features)) {
		return [];
	}
	geojson.features.forEach((feature) => {
		const coords = feature?.geometry?.coordinates;
		if (!Array.isArray(coords) || coords.length < 2) {
			return;
		}
		const lon = Number(coords[0]);
		const lat = Number(coords[1]);
		if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
			return;
		}
		const props = feature?.properties || {};
		const nameKey = normaliseGarageNameKey(props);
		const maxDistanceSq = getGarageMergeDistanceSq(nameKey);
		let matched = null;
		for (const group of groups) {
			if (group.nameKey !== nameKey) {
				continue;
			}
			const distanceSq = getDistanceSq(lat, lon, group.lat, group.lon);
			if (distanceSq <= maxDistanceSq) {
				matched = group;
				break;
			}
		}
		if (!matched) {
			matched = {
				nameKey,
				features: [],
				latSum: 0,
				lonSum: 0,
				stopCount: 0,
				lat: lat,
				lon: lon,
				latlng: L.latLng(lat, lon)
			};
			groups.push(matched);
		}
		matched.features.push(feature);
		matched.latSum += lat;
		matched.lonSum += lon;
		matched.stopCount += 1;
		matched.lat = matched.latSum / matched.stopCount;
		matched.lon = matched.lonSum / matched.stopCount;
		matched.latlng = L.latLng(matched.lat, matched.lon);
	});
	return groups;
}

function getGarageMergeDistanceSq(nameKey) {
	if (nameKey === "fulwell") {
		return 0.006 * 0.006;
	}
	return 0.003 * 0.003;
}

function normaliseGarageNameKey(props) {
	const name = String(props?.["Garage name"] || "").trim();
	const code = getGarageCode(props);
	const cleaned = name.replace(/\s*\(.*?\)\s*/g, " ").trim();
	const key = cleaned.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
	if (key) {
		return key;
	}
	return String(code || "").toLowerCase().trim();
}

function buildGarageGroupInfoHtml(features) {
	if (!features || features.length === 0) {
		return '';
	}
	return features.map((feature) => buildGarageSingleInfoHtml(feature)).join('<hr/>');
}

function buildGarageHoverHtml(features) {
	if (!features || features.length === 0) {
		return "";
	}
	const routeSets = appState.useRouteTypeColours ? appState.networkRouteSets : null;
	return features
		.map((feature) => {
			const p = feature.properties || {};
			const name = p["Garage name"] || p["TfL garage code"] || "Garage";
			const code = getGarageCode(p) || "N/A";
			const operator = p["Company name"] || p["Group name"] || "Operator";
			const routes = [
				...extractRouteTokens(p["TfL main network routes"]),
				...extractRouteTokens(p["TfL night routes"]),
				...extractRouteTokens(p["TfL school/mobility routes"]),
				...extractRouteTokens(p["Other routes"])
			];
			return `
				<div class="hover-popup__content">
					<div class="hover-popup__title">${escapeHtml(name)} <strong>${escapeHtml(code)}</strong></div>
					<div class="hover-popup__meta">${escapeHtml(operator)}</div>
					<div class="hover-popup__routes">${renderRoutePills(routes, routeSets)}</div>
				</div>
			`;
		})
		.join("<hr/>");
}

function buildGarageRouteCategoryHtml(label, tokens, routeSets) {
	if (!tokens || tokens.length === 0) {
		return "";
	}
	return `
		<div class="garage-route-category">
			<div class="info-label">${escapeHtml(label)}</div>
			${renderRoutePills(tokens, routeSets)}
		</div>
	`;
}

function buildGarageInfoHtml(features, routeSets) {
	if (!features || features.length === 0) {
		return {
			title: "Garage details",
			subtitle: "",
			bodyHtml: '<div class="info-section"><div class="info-empty">No garage details found.</div></div>'
		};
	}

	const intro = features.length > 1 ? `${features.length} garages at this location` : "Garage location";
	const sections = features.map((feature) => {
		const p = feature.properties || {};
		const name = p["Garage name"] || p["TfL garage code"] || "Garage";
		const code = getGarageCode(p) || "N/A";
		const operator = p["Company name"] || p["Group name"] || "Operator";
		const pvr = formatGaragePvr(p);

		const mainRoutes = extractRouteTokens(p["TfL main network routes"]);
		const nightRoutes = extractRouteTokens(p["TfL night routes"]);
		const schoolRoutes = extractRouteTokens(p["TfL school/mobility routes"]);
		const otherRoutes = extractRouteTokens(p["Other routes"]);

		const routeBlocks = [
			buildGarageRouteCategoryHtml("Main routes", mainRoutes, routeSets),
			buildGarageRouteCategoryHtml("Night routes", nightRoutes, routeSets),
			buildGarageRouteCategoryHtml("School/mobility routes", schoolRoutes, routeSets),
			buildGarageRouteCategoryHtml("Other routes", otherRoutes, routeSets)
		].filter(Boolean).join("");

		const routeSection = routeBlocks
			? `<div class="info-section"><div class="info-label">Routes</div>${routeBlocks}</div>`
			: '<div class="info-section"><div class="info-label">Routes</div><div class="info-empty">No routes listed.</div></div>';

		return `
			<div class="info-section">
				<div class="info-label">Garage</div>
				<div>${escapeHtml(name)} <strong>${escapeHtml(code)}</strong></div>
				<div>Operator: ${escapeHtml(operator)}</div>
				<div>${escapeHtml(pvr)}</div>
			</div>
			${routeSection}
		`;
	}).join("");

	return {
		title: "Garage details",
		subtitle: intro,
		bodyHtml: sections
	};
}

function buildGarageSingleInfoHtml(feature) {
	const p = feature.properties || {};
	const name = p["Garage name"] || p["TfL garage code"] || "Garage";
	const code = getGarageCode(p) || "N/A";
	const operator = p["Company name"] || p["Group name"] || "Operator";
	const pvr = formatGaragePvr(p);
	const routes = formatGarageRoutes(p);
	return `<div><div>${name} <b>${code}</b></div><div>Operator: ${operator}</div><div>${pvr}</div><div>${routes}</div></div>`;
}

function buildGarageLabelHtml(features) {
	const codes = getGarageCodes(features);
	if (codes.length === 0) {
		return '';
	}
	return codes.map((code) => `<span class="garage-code">${code}</span>`).join('');
}

function getGarageCode(props) {
	return props["TfL garage code"] || props["LBR garage code"] || "";
}

function getGarageCodes(features) {
	const codes = new Set();
	features.forEach((feature) => {
		const code = getGarageCode(feature.properties || {});
		if (code) {
			codes.add(code);
		}
	});
	return Array.from(codes);
}

function clearActiveRouteSelections() {
	if (appState.activeGarageRoutes) {
		appState.routeLoadToken += 1;
		clearGarageRoutes();
		appState.activeGarageRoutes = null;
	}
	if (appState.activeBusStationRoutes) {
		appState.busStationRouteLoadToken += 1;
		clearBusStationRoutes();
		appState.activeBusStationRoutes = null;
		clearBusStationHighlight();
		setBusStationSelectValue("");
	}
}

function selectGarageRoutes(features) {
	if (!appState.suppressNetworkRoutes) {
		appState.suppressNetworkRoutes = true;
	}
	appState.networkRouteLoadToken += 1;
	clearNetworkRoutes();
	clearActiveRouteSelections();
	if (appState.focusRouteId) {
		clearFocusedRoute();
	}
	const showRegular = isRouteTypeEnabled('showRegularRoutes');
	const showNight = isRouteTypeEnabled('showNightRoutes');
	const showSchool = isRouteTypeEnabled('showSchoolRoutes');
	if (!showRegular && !showNight && !showSchool) {
		["showRegularRoutes", "showNightRoutes", "showSchoolRoutes"].forEach((id) => {
			const checkbox = document.getElementById(id);
			if (checkbox) {
				checkbox.checked = true;
			}
		});
	}
	const routeSets = buildGarageRouteSets(features);
	appState.activeGarageRoutes = routeSets;
	appState.routeLoadToken += 1;
	renderGarageRoutes(appState.routeLoadToken);
}

function buildGarageRouteSets(features) {
	const regular = new Set();
	const night = new Set();
	const school = new Set();
	features.forEach((feature) => {
		const p = feature.properties || {};
		addRouteTokens(regular, p["TfL main network routes"]);
		addRouteTokens(night, p["TfL night routes"]);
		addRouteTokens(school, p["TfL school/mobility routes"]);
		addRouteTokens(regular, p["Other routes"]);
	});
	removeOverlappingSchoolRoutes(school, regular, night);
	return { regular, night, school };
}

function removeOverlappingSchoolRoutes(school, ...routeSets) {
	if (!school) {
		return;
	}
	routeSets.forEach((set) => {
		if (!set) {
			return;
		}
		set.forEach((routeId) => school.delete(routeId));
	});
}

function addRouteTokens(set, value) {
	if (!value) {
		return;
	}
	String(value)
		.split(/[\s,;/]+/)
		.map((token) => token.trim())
		.filter(Boolean)
		.forEach((token) => {
			const cleaned = token.replace(/[^A-Za-z0-9]/g, '');
			if (!cleaned) {
				return;
			}
			const normalised = cleaned.toUpperCase();
			if (isExcludedRoute(normalised)) {
				return;
			}
			set.add(normalised);
		});
}

function extractRouteTokens(value) {
	if (!value) {
		return [];
	}
	return String(value)
		.split(/[\s,;/]+/)
		.map((token) => token.trim())
		.filter(Boolean)
		.map((token) => token.replace(/[^A-Za-z0-9]/g, ''))
		.filter(Boolean)
		.map((token) => token.toUpperCase())
		.filter((token) => !isExcludedRoute(token));
}

function buildRouteFilterTokens(query) {
	const tokens = new Set();
	addRouteTokens(tokens, query);
	return Array.from(tokens);
}

async function loadVehicleLookup() {
	if (appState.vehicleLookup) {
		return appState.vehicleLookup;
	}
	if (appState.vehicleLookupPromise) {
		return appState.vehicleLookupPromise;
	}
	appState.vehicleLookupPromise = fetch(VEHICLE_LOOKUP_PATH, { cache: "no-store" })
		.then((res) => {
			if (!res.ok) {
				return null;
			}
			return res.json();
		})
		.then((data) => {
			if (!data || typeof data !== "object") {
				appState.vehicleLookup = null;
				return null;
			}
			const lookup = {};
			Object.entries(data).forEach(([key, value]) => {
				const normalisedKey = String(key || "").trim().toUpperCase();
				const normalisedValue = String(value || "").trim().toUpperCase();
				if (!normalisedKey) {
					return;
				}
				if (normalisedValue !== "SD" && normalisedValue !== "DD") {
					return;
				}
				lookup[normalisedKey] = normalisedValue;
			});
			appState.vehicleLookup = lookup;
			return lookup;
		})
		.catch(() => {
			appState.vehicleLookup = null;
			return null;
		})
		.finally(() => {
			appState.vehicleLookupPromise = null;
		});
	return appState.vehicleLookupPromise;
}

function getDeckFilterMode() {
	const all = isRouteTypeEnabled("showAllDeckers");
	const single = isRouteTypeEnabled("showSingleDecker");
	const double = isRouteTypeEnabled("showDoubleDecker");
	if (all || (!single && !double)) {
		return "all";
	}
	if (single) {
		return "single";
	}
	if (double) {
		return "double";
	}
	return "all";
}

function matchesDeckFilter(routeId) {
	const mode = getDeckFilterMode();
	if (mode === "all") {
		return true;
	}
	const lookup = appState.vehicleLookup;
	if (!lookup) {
		return true;
	}
	const key = String(routeId || "").trim().toUpperCase();
	if (!key) {
		return false;
	}
	const type = lookup[key];
	if (!type) {
		return false;
	}
	return mode === "single" ? type === "SD" : type === "DD";
}

function routeMatchesFilter(routeId, filterTokens, exactMatch) {
	if (!filterTokens || filterTokens.length === 0) {
		return true;
	}
	const normalisedRouteId = routeId.toUpperCase();
	return filterTokens.some((token) => {
		if (normalisedRouteId === token) {
			return true;
		}
		if (exactMatch) {
			return false;
		}
		if (/^\d+$/.test(token)) {
			return normalisedRouteId.startsWith("N") && normalisedRouteId.slice(1) === token;
		}
		if (/^[A-Z]+$/.test(token)) {
			if (token === "N") {
				return false;
			}
			return normalisedRouteId.startsWith(token);
		}
		return false;
	});
}

function filterRouteSet(routes, filterTokens) {
	const exactMatch = isRouteTypeEnabled("showExactRouteMatch");
	return Array.from(routes).filter((routeId) => {
		if (isExcludedRoute(routeId)) {
			return false;
		}
		return routeMatchesFilter(routeId, filterTokens, exactMatch) && matchesDeckFilter(routeId);
	});
}

function isPrefixRoute(routeId) {
	if (!routeId) {
		return false;
	}
	const upper = String(routeId).toUpperCase();
	if (!/^[A-Z]/.test(upper)) {
		return false;
	}
	if (upper.startsWith("N")) {
		return false;
	}
	if (upper.startsWith("BL")) {
		return false;
	}
	if (upper.startsWith("SL")) {
		return false;
	}
	return true;
}

function isSuperloopRoute(routeId) {
	return String(routeId || "").toUpperCase().startsWith("SL");
}

function isBakerloopRoute(routeId) {
	return String(routeId || "").toUpperCase().startsWith("BL");
}

function collectPrefixRoutes(prefixRoutes, routes) {
	if (!routes) {
		return;
	}
	routes.forEach((routeId) => {
		if (isPrefixRoute(routeId)) {
			prefixRoutes.add(routeId);
		}
	});
}

async function loadNetworkRouteSets() {
	if (appState.networkRouteSets) {
		return appState.networkRouteSets;
	}
	const gj = await loadGaragesGeojson();
	const regular = new Set();
	const night = new Set();
	const school = new Set();
	const other = new Set();
	const twentyFour = new Set();
	if (gj && Array.isArray(gj.features)) {
		gj.features.forEach((feature) => {
			const p = feature.properties || {};
			addRouteTokens(regular, p["TfL main network routes"]);
			addRouteTokens(school, p["TfL school/mobility routes"]);
			addRouteTokens(other, p["Other routes"]);

			const nightTokens = extractRouteTokens(p["TfL night routes"]);
			nightTokens.forEach((token) => {
				if (token.startsWith("N")) {
					night.add(token);
				} else {
					twentyFour.add(token);
				}
			});
		});
	}
	removeOverlappingSchoolRoutes(school, regular, night, other, twentyFour);
	appState.networkRouteSets = { regular, night, school, other, twentyFour };
	return appState.networkRouteSets;
}

function extractRouteGeometrySegments(geometry) {
	if (!geometry || !geometry.type) {
		return [];
	}
	if (geometry.type === "LineString") {
		const coords = Array.isArray(geometry.coordinates) ? geometry.coordinates : [];
		const segment = coords
			.map((point) => Array.isArray(point) ? [Number(point[1]), Number(point[0])] : null)
			.filter((point) => Array.isArray(point) && Number.isFinite(point[0]) && Number.isFinite(point[1]));
		return segment.length > 1 ? [segment] : [];
	}
	if (geometry.type === "MultiLineString") {
		const segments = Array.isArray(geometry.coordinates) ? geometry.coordinates : [];
		return segments
			.map((segment) => {
				return Array.isArray(segment)
					? segment
						.map((point) => Array.isArray(point) ? [Number(point[1]), Number(point[0])] : null)
						.filter((point) => Array.isArray(point) && Number.isFinite(point[0]) && Number.isFinite(point[1]))
					: [];
			})
			.filter((segment) => Array.isArray(segment) && segment.length > 1);
	}
	return [];
}

function extractRouteGeometryFromCollection(geojson) {
	const segments = [];
	const features = Array.isArray(geojson?.features) ? geojson.features : [];
	features.forEach((feature) => {
		const featureSegments = extractRouteGeometrySegments(feature?.geometry);
		featureSegments.forEach((segment) => segments.push(segment));
	});
	return segments;
}

async function loadRouteGeometryRouteIds() {
	if (appState.geometryRouteIds instanceof Set) {
		return appState.geometryRouteIds;
	}
	if (appState.geometryRouteIds === null) {
		return null;
	}
	try {
		const res = await fetch(ROUTE_GEOMETRY_INDEX_PATH, { cache: "no-store" });
		if (!res.ok) {
			appState.geometryRouteIds = null;
			return null;
		}
		const data = await res.json();
		const routes = Array.isArray(data?.routes) ? data.routes : [];
		const routeIds = new Set(
			routes
				.map((routeId) => String(routeId).trim().toUpperCase())
				.filter((routeId) => routeId && !isExcludedRoute(routeId))
		);
		appState.geometryRouteIds = routeIds.size > 0 ? routeIds : null;
		return appState.geometryRouteIds;
	} catch (error) {
		appState.geometryRouteIds = null;
		return null;
	}
}

async function loadFrequencyData() {
	if (appState.frequencyData) {
		return appState.frequencyData;
	}
	if (appState.frequencyLoadPromise) {
		return appState.frequencyLoadPromise;
	}
	appState.frequencyLoadPromise = fetch(FREQUENCY_DATA_PATH, { cache: "no-store" })
		.then((response) => response.ok ? response.json() : null)
		.then((data) => {
			appState.frequencyData = data && typeof data === "object" ? data : null;
			return appState.frequencyData;
		})
		.catch(() => {
			appState.frequencyData = null;
			return null;
		})
		.finally(() => {
			appState.frequencyLoadPromise = null;
		});
	return appState.frequencyLoadPromise;
}

function getFrequencyValue(routeId, band) {
	if (!routeId || !band || !appState.frequencyData) {
		return null;
	}
	const key = String(routeId).trim().toUpperCase();
	if (!key) {
		return null;
	}
	const entry = appState.frequencyData[key];
	if (!entry || typeof entry !== "object") {
		return null;
	}
	const value = Number(entry[band]);
	return Number.isFinite(value) ? value : null;
}

function getFrequencyPerHour(headwayMinutes) {
	if (!Number.isFinite(headwayMinutes) || headwayMinutes <= 0) {
		return 0;
	}
	return headwayMinutes;
}

function quantizeLatLng(value) {
	return Number(value).toFixed(5);
}

function buildSegmentKey(a, b) {
	const aKey = `${quantizeLatLng(a[0])},${quantizeLatLng(a[1])}`;
	const bKey = `${quantizeLatLng(b[0])},${quantizeLatLng(b[1])}`;
	return aKey < bKey ? `${aKey}|${bKey}` : `${bKey}|${aKey}`;
}

function getPolylineAverageTotal(segment, segmentTotals) {
	if (!Array.isArray(segment) || segment.length < 2 || !segmentTotals) {
		return null;
	}
	let sum = 0;
	let count = 0;
	for (let i = 1; i < segment.length; i += 1) {
		const start = segment[i - 1];
		const end = segment[i];
		if (!Array.isArray(start) || !Array.isArray(end)) {
			continue;
		}
		const key = buildSegmentKey(start, end);
		const entry = segmentTotals.get(key);
		if (!entry) {
			continue;
		}
		sum += entry.total;
		count += 1;
	}
	return count > 0 ? sum / count : null;
}

function getFrequencyTotalAtLatLng(line, latlng) {
	if (!line || !latlng || !appState.map || !appState.frequencySegmentTotals) {
		return null;
	}
	const map = appState.map;
	const point = map.latLngToLayerPoint(latlng);
	const segments = [];
	collectPolylineSegments(line.getLatLngs(), segments);

	let bestTotal = null;
	let bestDistance = Infinity;
	segments.forEach((segment) => {
		for (let i = 1; i < segment.length; i += 1) {
			const start = segment[i - 1];
			const end = segment[i];
			if (!start || !end) {
				continue;
			}
			const startPoint = map.latLngToLayerPoint(start);
			const endPoint = map.latLngToLayerPoint(end);
			const distance = L.LineUtil.pointToSegmentDistance(point, startPoint, endPoint);
			if (distance >= bestDistance) {
				continue;
			}
			const key = buildSegmentKey([start.lat, start.lng], [end.lat, end.lng]);
			const entry = appState.frequencySegmentTotals.get(key);
			if (!entry) {
				continue;
			}
			bestDistance = distance;
			bestTotal = entry.total;
		}
	});

	return bestDistance <= 12 ? bestTotal : null;
}

function getFrequencyLineWeight(segment, context) {
	if (!context || !context.segmentTotals || context.maxTotal <= 0) {
		return null;
	}
	const total = getPolylineAverageTotal(segment, context.segmentTotals);
	if (!Number.isFinite(total) || total <= 0) {
		return null;
	}
	const t = Math.min(total / context.maxTotal, 1);
	// Emphasize differences near the top end to create a thicker/thinner contrast.
	const scaled = Math.pow(t, 1.5);
	const minWeight = 1.0;
	const maxWeight = 36;
	return minWeight + (maxWeight - minWeight) * scaled;
}

function formatFrequencyValue(total) {
	if (!Number.isFinite(total) || total <= 0) {
		return "";
	}
	const perHour = total;
	const headway = 60 / perHour;
	const headwayText = headway >= 1 ? `${headway.toFixed(1)} min` : `${Math.round(headway * 60)} sec`;
	return `${perHour.toFixed(1)} buses/hr (${headwayText} headway)`;
}

async function buildFrequencyContext(routeIds) {
	if (!appState.showFrequencyLayer) {
		appState.frequencySegmentTotals = null;
		appState.frequencyMaxTotal = 0;
		return null;
	}
	await loadFrequencyData();
	if (!appState.frequencyData) {
		appState.frequencySegmentTotals = null;
		appState.frequencyMaxTotal = 0;
		return null;
	}

	const ids = Array.from(new Set(Array.from(routeIds || [])));
	const segmentTotals = new Map();
	const segmentsByRoute = new Map();
	const band = appState.frequencyBand;

	const tasks = ids.map((routeId) => {
		return loadRouteGeometry(routeId)
			.then((segments) => {
				segmentsByRoute.set(routeId, segments || null);
				const headway = getFrequencyValue(routeId, band);
				const perHour = getFrequencyPerHour(headway);
				if (perHour <= 0 || !segments || segments.length === 0) {
					return;
				}
				const routeKeys = new Set();
				segments.forEach((segment) => {
					for (let i = 1; i < segment.length; i += 1) {
						const start = segment[i - 1];
						const end = segment[i];
						if (!Array.isArray(start) || !Array.isArray(end)) {
							continue;
						}
						routeKeys.add(buildSegmentKey(start, end));
					}
				});
				routeKeys.forEach((key) => {
					const entry = segmentTotals.get(key);
					if (entry) {
						entry.total += perHour;
					} else {
						segmentTotals.set(key, { total: perHour });
					}
				});
			})
			.catch(() => {
				segmentsByRoute.set(routeId, null);
			});
	});

	await Promise.all(tasks);

	let maxTotal = 0;
	segmentTotals.forEach((entry) => {
		if (entry.total > maxTotal) {
			maxTotal = entry.total;
		}
	});
	appState.frequencySegmentTotals = segmentTotals.size > 0 ? segmentTotals : null;
	appState.frequencyMaxTotal = maxTotal;

	return {
		segmentTotals: appState.frequencySegmentTotals,
		maxTotal,
		segmentsByRoute
	};
}

async function renderGarageRoutes(loadToken) {
	if (appState.focusRouteId) {
		return;
	}
	clearGarageRoutes();
	if (!appState.map || !appState.activeGarageRoutes) {
		return;
	}
	const categories = getSelectedRouteCategories();
	if (categories.length === 0) {
		updateSelectedRouteCount(0);
		return;
	}

	const filteredCategories = categories.map((category) => {
		const filteredRoutes = filterRouteSet(category.routes, appState.routeFilterTokens);
		return { ...category, filteredRoutes };
	});
	const initialSelectedRoutes = new Set();
	filteredCategories.forEach((category) => {
		category.filteredRoutes.forEach((routeId) => initialSelectedRoutes.add(routeId));
	});
	if (initialSelectedRoutes.size === 0) {
		updateSelectedRouteCount(0);
		return;
	}

	let frequencyContext = null;
	if (appState.showFrequencyLayer) {
		frequencyContext = await buildFrequencyContext(initialSelectedRoutes);
		if (loadToken !== appState.routeLoadToken) {
			return;
		}
	} else {
		appState.frequencySegmentTotals = null;
		appState.frequencyMaxTotal = 0;
	}

	let displayCategories = filteredCategories;
	let displayRoutes = initialSelectedRoutes;
	if (appState.showFrequencyLayer && appState.frequencyData) {
		const band = appState.frequencyBand || "peak_am";
		displayCategories = filteredCategories
			.map((category) => {
				const activeRoutes = filterRoutesByFrequency(category.filteredRoutes, band);
				return { ...category, filteredRoutes: activeRoutes };
			})
			.filter((category) => category.filteredRoutes.length > 0);
		displayRoutes = new Set();
		displayCategories.forEach((category) => {
			category.filteredRoutes.forEach((routeId) => displayRoutes.add(routeId));
		});
	}
	if (displayRoutes.size === 0) {
		updateSelectedRouteCount(0);
		return;
	}
	updateSelectedRouteCount(displayRoutes.size);

	const layerGroup = L.layerGroup().addTo(appState.map);
	appState.garageRouteLayer = layerGroup;
	const hasFrequency = Boolean(frequencyContext?.segmentTotals && frequencyContext.maxTotal > 0);
	const baseWeight = hasFrequency ? 1.8 : 4;

	const tasks = displayCategories.flatMap((category) => {
		if (category.filteredRoutes.length === 0) {
			return [];
		}
		return category.filteredRoutes.map((routeId) => {
			const segmentPromise = frequencyContext?.segmentsByRoute?.has(routeId)
				? Promise.resolve(frequencyContext.segmentsByRoute.get(routeId))
				: loadRouteGeometry(routeId);
			return segmentPromise
				.then((segments) => {
					if (loadToken !== appState.routeLoadToken) {
						return;
					}
					if (!segments || segments.length === 0) {
						return;
					}
					segments.forEach((segment) => {
						const weighted = hasFrequency ? getFrequencyLineWeight(segment, frequencyContext) : null;
						const line = L.polyline(segment, {
							color: resolveRouteColour(category.color),
							weight: weighted ?? baseWeight,
							opacity: 0.85,
							pane: ROUTE_PANE
						}).addTo(layerGroup);
						line._routeId = routeId;
						bindRouteHoverPopup(line, layerGroup);
					});
				})
				.catch(() => {});
		});
	});

	await Promise.all(tasks);
}

function getSelectedRouteCategories() {
	const categories = [];
	if (isRouteTypeEnabled('showRegularRoutes') && appState.activeGarageRoutes?.regular) {
		categories.push({ type: "regular", color: ROUTE_COLOURS.regular, routes: appState.activeGarageRoutes.regular });
	}
	if (isRouteTypeEnabled('showNightRoutes') && appState.activeGarageRoutes?.night) {
		categories.push({ type: "night", color: ROUTE_COLOURS.night, routes: appState.activeGarageRoutes.night });
	}
	if (isRouteTypeEnabled('showSchoolRoutes') && appState.activeGarageRoutes?.school) {
		categories.push({ type: "school", color: ROUTE_COLOURS.school, routes: appState.activeGarageRoutes.school });
	}
	return orderRouteCategories(categories);
}

function clearNetworkRoutes() {
	if (appState.networkRouteLayer && appState.map) {
		appState.map.removeLayer(appState.networkRouteLayer);
		appState.networkRouteLayer = null;
	}
}

async function getSelectedNetworkCategories() {
	const showAll = isRouteTypeEnabled("showAllRoutes");
	const showRegular = showAll || isRouteTypeEnabled("showNetworkRegularRoutes");
	const showNight = showAll || isRouteTypeEnabled("showNetworkNightRoutes");
	const showSchool = showAll || isRouteTypeEnabled("showNetworkSchoolRoutes");
	const separateTwentyFour = isRouteTypeEnabled("showNetwork24hrRoutes") && !showAll;
	const separatePrefix = isRouteTypeEnabled("showNetworkPrefixRoutes") && !showAll;

	const routeSets = await loadNetworkRouteSets();
	const geometryRoutes = showAll || separatePrefix ? await loadRouteGeometryRouteIds() : null;
	let regularRoutes = new Set(routeSets.regular);
	const twentyFourRoutes = new Set(routeSets.twentyFour);
	const nightRoutes = new Set(routeSets.night);
	const schoolRoutes = new Set(routeSets.school);
	if (showAll) {
		routeSets.other.forEach((routeId) => regularRoutes.add(routeId));
		if (geometryRoutes) {
			geometryRoutes.forEach((routeId) => regularRoutes.add(routeId));
		}
	}

	if (separateTwentyFour && twentyFourRoutes.size > 0) {
		twentyFourRoutes.forEach((routeId) => regularRoutes.delete(routeId));
	}

	const prefixRoutes = new Set();
	if (separatePrefix) {
		if (geometryRoutes && geometryRoutes.size > 0) {
			collectPrefixRoutes(prefixRoutes, geometryRoutes);
		} else {
			collectPrefixRoutes(prefixRoutes, routeSets.regular);
			collectPrefixRoutes(prefixRoutes, routeSets.other);
			collectPrefixRoutes(prefixRoutes, twentyFourRoutes);
			collectPrefixRoutes(prefixRoutes, nightRoutes);
			collectPrefixRoutes(prefixRoutes, schoolRoutes);
		}
		prefixRoutes.forEach((routeId) => {
			regularRoutes.delete(routeId);
			twentyFourRoutes.delete(routeId);
			nightRoutes.delete(routeId);
			schoolRoutes.delete(routeId);
		});
	}

	const categories = [];
	if (showRegular && regularRoutes.size > 0) {
		categories.push({ type: "regular", color: ROUTE_COLOURS.regular, routes: regularRoutes });
	}
	if (separatePrefix && prefixRoutes.size > 0) {
		categories.push({ type: "prefix", color: ROUTE_COLOURS.prefix, routes: prefixRoutes });
	}
	if (separateTwentyFour && twentyFourRoutes.size > 0) {
		categories.push({ type: "twentyfour", color: ROUTE_COLOURS.twentyFour, routes: twentyFourRoutes });
	}
	if (showNight && nightRoutes.size > 0) {
		categories.push({ type: "night", color: ROUTE_COLOURS.night, routes: nightRoutes });
	}
	if (showSchool && schoolRoutes.size > 0) {
		categories.push({ type: "school", color: ROUTE_COLOURS.school, routes: schoolRoutes });
	}
	return orderRouteCategories(categories);
}

async function renderNetworkRoutes(loadToken) {
	if (appState.focusRouteId || appState.suppressNetworkRoutes) {
		clearNetworkRoutes();
		return;
	}
	clearNetworkRoutes();
	if (!appState.map) {
		return;
	}
	const categories = await getSelectedNetworkCategories();
	if (loadToken !== appState.networkRouteLoadToken) {
		return;
	}
	if (categories.length === 0) {
		appState.showNetworkRoutes = false;
		updateSelectedRouteCount(0);
		appState.frequencySegmentTotals = null;
		appState.frequencyMaxTotal = 0;
		return;
	}

	const filteredCategories = categories.map((category) => {
		const filteredRoutes = filterRouteSet(category.routes, appState.routeFilterTokens);
		return { ...category, filteredRoutes };
	});
	if (
		appState.routeFilterTokens.length > 0
		&& filteredCategories.every((category) => category.filteredRoutes.length === 0)
	) {
		filteredCategories.forEach((category) => {
			category.filteredRoutes = filterRouteSet(category.routes, []);
		});
	}
	const initialSelectedRoutes = new Set();
	filteredCategories.forEach((category) => {
		category.filteredRoutes.forEach((routeId) => initialSelectedRoutes.add(routeId));
	});

	let frequencyContext = null;
	if (appState.showFrequencyLayer) {
		frequencyContext = await buildFrequencyContext(initialSelectedRoutes);
		if (loadToken !== appState.networkRouteLoadToken) {
			return;
		}
	} else {
		appState.frequencySegmentTotals = null;
		appState.frequencyMaxTotal = 0;
	}

	let displayCategories = filteredCategories;
	let displayRoutes = initialSelectedRoutes;
	if (appState.showFrequencyLayer && appState.frequencyData) {
		const band = appState.frequencyBand || "peak_am";
		displayCategories = filteredCategories
			.map((category) => {
				const activeRoutes = filterRoutesByFrequency(category.filteredRoutes, band);
				return { ...category, filteredRoutes: activeRoutes };
			})
			.filter((category) => category.filteredRoutes.length > 0);
		displayRoutes = new Set();
		displayCategories.forEach((category) => {
			category.filteredRoutes.forEach((routeId) => displayRoutes.add(routeId));
		});
	}
	if (displayRoutes.size === 0) {
		appState.showNetworkRoutes = false;
		updateSelectedRouteCount(0);
		appState.frequencySegmentTotals = null;
		appState.frequencyMaxTotal = 0;
		return;
	}
	updateSelectedRouteCount(displayRoutes.size);

	appState.showNetworkRoutes = true;
	const layerGroup = L.layerGroup().addTo(appState.map);
	appState.networkRouteLayer = layerGroup;
	const hasFrequency = Boolean(frequencyContext?.segmentTotals && frequencyContext.maxTotal > 0);
	const baseWeight = hasFrequency ? 1.6 : 3;

	const tasks = displayCategories.flatMap((category) => {
		if (category.filteredRoutes.length === 0) {
			return [];
		}
		return category.filteredRoutes.map((routeId) => {
			const segmentPromise = frequencyContext?.segmentsByRoute?.has(routeId)
				? Promise.resolve(frequencyContext.segmentsByRoute.get(routeId))
				: loadRouteGeometry(routeId);
			return segmentPromise
				.then((segments) => {
					if (loadToken !== appState.networkRouteLoadToken) {
						return;
					}
					if (!segments || segments.length === 0) {
						return;
					}
					segments.forEach((segment) => {
						const weighted = hasFrequency ? getFrequencyLineWeight(segment, frequencyContext) : null;
						const line = L.polyline(segment, {
							color: resolveRouteColour(category.color),
							weight: weighted ?? baseWeight,
							opacity: 0.7,
							pane: ROUTE_PANE
						}).addTo(layerGroup);
						line._routeId = routeId;
						bindRouteHoverPopup(line, layerGroup);
					});
				})
				.catch(() => {});
		});
	});

	await Promise.all(tasks);
}

async function loadRouteGeometry(routeId) {
	const normalised = String(routeId || "").toUpperCase();
	if (!normalised || isExcludedRoute(normalised)) {
		return null;
	}
	if (appState.routeGeometryCache.has(normalised)) {
		return appState.routeGeometryCache.get(normalised);
	}
	let segments = null;
	try {
		const response = await fetch(`${ROUTE_GEOMETRY_DIR}/${encodeURIComponent(normalised)}.geojson`, { cache: "no-store" });
		if (response.ok) {
			const geojson = await response.json();
			const extracted = extractRouteGeometryFromCollection(geojson);
			segments = extracted.length > 0 ? extracted : null;
		}
	} catch (error) {
		segments = null;
	}
	appState.routeGeometryCache.set(normalised, segments);
	return segments;
}

function formatGaragePvr(props) {
	const value = props["PVR"];
	const trimmed = value === undefined || value === null ? '' : String(value).trim();
	return `PVR: ${trimmed || 'N/A'}`;
}

function formatGarageRoutes(props) {
	const routeFields = [
		{ label: 'Main', key: 'TfL main network routes' },
		{ label: 'Night', key: 'TfL night routes' },
		{ label: 'School/Mobility', key: 'TfL school/mobility routes' },
		{ label: 'Other', key: 'Other routes' }
	];

	const lines = routeFields
		.map((field) => {
			const raw = props[field.key];
			if (!raw) {
				return null;
			}
			const value = String(raw).trim();
			if (!value) {
				return null;
			}
			return `${field.label}: ${value}`;
		})
		.filter(Boolean);

	if (lines.length === 0) {
		return 'Routes: None listed';
	}

	return `Routes:<br/>${lines.join('<br/>')}`;
}

function bindHoverPopup(layer, html) {
	if (!layer || !html) {
		return;
	}
	const getContent = typeof html === "function" ? html : () => html;
	const initialContent = getContent();
	layer.bindPopup(initialContent || "", {
		className: "hover-popup",
		closeButton: false,
		autoClose: false,
		closeOnClick: false,
		autoPan: false,
		offset: [0, -12]
	});
	layer.on("mouseover", (event) => {
		const content = getContent(event);
		if (content !== undefined) {
			layer.setPopupContent(content);
		}
		layer.openPopup(event?.latlng);
	});
	layer.on("mouseout", () => {
		layer.closePopup();
	});
	layer.on("click", () => {
		layer.closePopup();
	});
}

function collectPolylineSegments(latlngs, segments) {
	if (!Array.isArray(latlngs) || latlngs.length === 0) {
		return;
	}
	const first = latlngs[0];
	if (first && typeof first.lat === "number" && typeof first.lng === "number") {
		segments.push(latlngs);
		return;
	}
	latlngs.forEach((segment) => collectPolylineSegments(segment, segments));
}

function isPointNearLatLngSegment(point, latlngs, map, tolerance) {
	if (!Array.isArray(latlngs) || latlngs.length < 2) {
		return false;
	}
	let prev = map.latLngToLayerPoint(latlngs[0]);
	for (let i = 1; i < latlngs.length; i += 1) {
		const next = map.latLngToLayerPoint(latlngs[i]);
		const distance = L.LineUtil.pointToSegmentDistance(point, prev, next);
		if (distance <= tolerance) {
			return true;
		}
		prev = next;
	}
	return false;
}

function isPointNearPolyline(point, line, map, tolerance) {
	const segments = [];
	collectPolylineSegments(line.getLatLngs(), segments);
	return segments.some((segment) => isPointNearLatLngSegment(point, segment, map, tolerance));
}

function collectRoutesNearLatLng(layerGroup, latlng, seedRouteId, tolerance = 8) {
	const routes = new Set();
	if (seedRouteId) {
		routes.add(seedRouteId);
	}
	if (!layerGroup || !latlng || !appState.map) {
		return sortRouteIds(Array.from(routes));
	}
	const map = appState.map;
	const point = map.latLngToLayerPoint(latlng);
	layerGroup.eachLayer((layer) => {
		if (!layer || typeof layer.getLatLngs !== "function" || !layer._routeId) {
			return;
		}
		if (layer.getBounds && !layer.getBounds().contains(latlng)) {
			return;
		}
		if (isPointNearPolyline(point, layer, map, tolerance)) {
			routes.add(layer._routeId);
		}
	});
	return sortRouteIds(Array.from(routes));
}

function getFrequencyPerHourForRoute(routeId, band) {
	const headway = getFrequencyValue(routeId, band);
	return getFrequencyPerHour(headway);
}

function filterRoutesByFrequency(routes, band) {
	if (!Array.isArray(routes) || routes.length === 0) {
		return [];
	}
	if (!appState.frequencyData) {
		return routes;
	}
	return routes.filter((routeId) => getFrequencyPerHourForRoute(routeId, band) > 0);
}

function getFrequencyTotalForRoutes(routes, band) {
	if (!Array.isArray(routes) || routes.length === 0) {
		return null;
	}
	let total = 0;
	routes.forEach((routeId) => {
		const perHour = getFrequencyPerHourForRoute(routeId, band);
		if (perHour > 0) {
			total += perHour;
		}
	});
	return total > 0 ? total : null;
}

function buildRouteGeometryHoverHtml(routes, routeSets, frequencyTotal) {
	const frequencyLine = Number.isFinite(frequencyTotal) && frequencyTotal > 0
		? `<div class="hover-popup__meta">Combined frequency: ${formatFrequencyValue(frequencyTotal)}</div>`
		: "";
	return `
		<div class="hover-popup__content">
			<div class="hover-popup__title">Routes here</div>
			${frequencyLine}
			<div class="hover-popup__routes">${renderRoutePills(routes, routeSets)}</div>
		</div>
	`;
}

function bindRouteHoverPopup(line, layerGroup) {
	if (!line) {
		return;
	}
	bindHoverPopup(line, (event) => {
		const tolerance = appState.showFrequencyLayer ? 16 : 8;
		const routes = collectRoutesNearLatLng(layerGroup, event?.latlng, line._routeId, tolerance);
		const routeSets = appState.useRouteTypeColours ? appState.networkRouteSets : null;
		let displayRoutes = routes;
		let frequencyTotal = null;
		if (appState.showFrequencyLayer) {
			const band = appState.frequencyBand || "peak_am";
			displayRoutes = filterRoutesByFrequency(routes, band);
			frequencyTotal = getFrequencyTotalForRoutes(displayRoutes, band);
		}
		return buildRouteGeometryHoverHtml(displayRoutes, routeSets, frequencyTotal);
	});
}

function isBusStationStop(props) {
	const stopName = getStopName(props);
	const roadName = getStopRoadName(props);
	return /bus station/i.test(stopName) || /bus station/i.test(roadName);
}

function isBusStationCoreStop(props) {
	const stopName = String(getStopName(props) || "");
	const roadName = String(getStopRoadName(props) || "");
	if (/bus station/i.test(roadName)) {
		return true;
	}
	if (!/bus station/i.test(stopName)) {
		return false;
	}
	return !stopName.includes("/");
}

function shouldExcludeStationStop(props) {
	const stopName = String(getStopName(props) || "");
	const roadName = String(getStopRoadName(props) || "");
	return stopName.includes("/") && !/bus station/i.test(roadName);
}

function cleanStationName(value) {
	if (!value) {
		return "";
	}
	const trimmed = String(value).trim();
	if (!trimmed) {
		return "";
	}
	const withoutParens = trimmed.replace(/\s*\(.*?\)\s*/g, " ").trim();
	return withoutParens.replace(/\s+/g, " ");
}

function normaliseBusStationBase(value) {
	const cleaned = cleanStationName(value);
	if (!cleaned) {
		return "";
	}
	const match = cleaned.match(/^(.*?bus station)\b/i);
	return match ? match[1].trim() : cleaned;
}

function formatStationName(value) {
	const cleaned = normaliseBusStationBase(value);
	if (!cleaned) {
		return "";
	}
	const letters = cleaned.replace(/[^A-Za-z]/g, "");
	if (letters && letters === letters.toUpperCase()) {
		return cleaned.toLowerCase().replace(/\b\w/g, (char) => char.toUpperCase());
	}
	return cleaned;
}

function deriveBusStationName(props) {
	const stopName = getStopName(props);
	const roadName = getStopRoadName(props);
	if (/bus station/i.test(roadName)) {
		return formatStationName(roadName);
	}
	if (/bus station/i.test(stopName)) {
		return formatStationName(stopName);
	}
	return formatStationName(stopName || roadName);
}

function buildBusStationKey(name) {
	return normaliseBusStationBase(name).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function getBusStationDisplayName(props) {
	const display = cleanStationName(props?.display_name || "");
	if (display) {
		return display;
	}
	const name = cleanStationName(props?.name || "");
	return name || "Bus station";
}

function getBusStationStopIds(props) {
	const stops = Array.isArray(props?.stops) ? props.stops : [];
	return stops.map((stopId) => String(stopId).trim()).filter(Boolean);
}

function parseBusStationCoordinates(coords) {
	if (!Array.isArray(coords) || coords.length < 2) {
		return null;
	}
	const first = Number(coords[0]);
	const second = Number(coords[1]);
	if (!Number.isFinite(first) || !Number.isFinite(second)) {
		return null;
	}
	const looksLikeLatLon = Math.abs(first) > 20 && Math.abs(second) <= 5;
	const looksLikeLonLat = Math.abs(second) > 20 && Math.abs(first) <= 5;
	if (looksLikeLatLon && !looksLikeLonLat) {
		return { lat: first, lon: second };
	}
	return { lat: second, lon: first };
}

function getStopRouteTokensFromProps(props) {
	return extractRouteTokens(props?.ROUTES);
}

function buildStopRoutesLookup(geojson) {
	const lookup = new Map();
	const features = Array.isArray(geojson?.features) ? geojson.features : [];
	features.forEach((feature) => {
		const props = feature?.properties || {};
		const stopId = getStopPointIdFromProps(props);
		if (!stopId) {
			return;
		}
		const routes = getStopRouteTokensFromProps(props);
		if (!routes || routes.length === 0) {
			return;
		}
		let set = lookup.get(stopId);
		if (!set) {
			set = new Set();
			lookup.set(stopId, set);
		}
		routes.forEach((routeId) => set.add(routeId));
	});
	return lookup;
}

function buildStopCoordinateLookup(geojson) {
	const lookup = new Map();
	const features = Array.isArray(geojson?.features) ? geojson.features : [];
	features.forEach((feature) => {
		const props = feature?.properties || {};
		const stopId = getStopPointIdFromProps(props);
		if (!stopId || lookup.has(stopId)) {
			return;
		}
		const coords = feature?.geometry?.coordinates;
		if (!Array.isArray(coords) || coords.length < 2) {
			return;
		}
		const lon = Number(coords[0]);
		const lat = Number(coords[1]);
		if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
			return;
		}
		lookup.set(stopId, { lat, lon });
	});
	return lookup;
}

function getStationCoordsFromStops(stopIds, stopCoordLookup) {
	if (!stopIds || stopIds.size === 0 || !stopCoordLookup) {
		return null;
	}
	let latSum = 0;
	let lonSum = 0;
	let count = 0;
	stopIds.forEach((stopId) => {
		const coords = stopCoordLookup.get(stopId);
		if (!coords) {
			return;
		}
		latSum += coords.lat;
		lonSum += coords.lon;
		count += 1;
	});
	if (count === 0) {
		return null;
	}
	return { lat: latSum / count, lon: lonSum / count };
}

function buildBusStationsFromAnchors(stationGeojson, busStopsGeojson) {
	const features = Array.isArray(stationGeojson?.features) ? stationGeojson.features : [];
	if (features.length === 0) {
		return [];
	}
	const stopRoutesLookup = buildStopRoutesLookup(busStopsGeojson);
	const stopCoordLookup = buildStopCoordinateLookup(busStopsGeojson);
	return features
		.map((feature, index) => {
			const props = feature?.properties || {};
			const name = getBusStationDisplayName(props);
			const stopIds = new Set(getBusStationStopIds(props));
			const routes = new Set();
			stopIds.forEach((stopId) => {
				const stopRoutes = stopRoutesLookup.get(stopId);
				if (!stopRoutes) {
					return;
				}
				stopRoutes.forEach((routeId) => routes.add(routeId));
			});
			const coords = feature?.geometry?.coordinates;
			const parsed = parseBusStationCoordinates(coords);
			const stopCoords = getStationCoordsFromStops(stopIds, stopCoordLookup);
			const lat = stopCoords?.lat ?? parsed?.lat;
			const lon = stopCoords?.lon ?? parsed?.lon;
			if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
				return null;
			}
			const keyBase = buildBusStationKey(name);
			const key = keyBase || `station-${index + 1}`;
			return {
				name,
				key,
				stopIds,
				stopCount: stopIds.size,
				routes,
				routeCount: routes.size,
				lat,
				lon,
				latlng: L.latLng(lat, lon),
				postcode: String(props?.postcode || "").trim()
			};
		})
		.filter(Boolean);
}

function getStationBaseName(name) {
	const cleaned = cleanStationName(name);
	if (!cleaned) {
		return "";
	}
	const withoutBusStation = cleaned.replace(/\bbus station\b.*$/i, "").trim();
	const base = withoutBusStation || cleaned;
	const withoutStation = base.replace(/\bstation\b/i, "").trim();
	return withoutStation || base;
}

function getStopIdentity(feature) {
	const props = feature?.properties || {};
	const coords = feature?.geometry?.coordinates;
	if (props.NAPTAN_ID) {
		return String(props.NAPTAN_ID);
	}
	if (props.NAPTAN_ATCO) {
		return String(props.NAPTAN_ATCO);
	}
	if (props.STOP_CODE) {
		return String(props.STOP_CODE);
	}
	if (props.OBJECTID !== undefined && props.OBJECTID !== null) {
		return String(props.OBJECTID);
	}
	if (Array.isArray(coords) && coords.length >= 2) {
		return `${Number(coords[1]).toFixed(6)},${Number(coords[0]).toFixed(6)}`;
	}
	return "";
}

function addBusStationStop(station, feature) {
	const coords = feature?.geometry?.coordinates;
	if (!Array.isArray(coords) || coords.length < 2) {
		return;
	}
	const lon = Number(coords[0]);
	const lat = Number(coords[1]);
	if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
		return;
	}
	const id = getStopIdentity(feature);
	if (id && station.stopIds.has(id)) {
		return;
	}
	if (id) {
		station.stopIds.add(id);
	}
	station.latSum += lat;
	station.lonSum += lon;
	station.stopCount += 1;
	const props = feature?.properties || {};
	getStopRouteTokensFromProps(props).forEach((routeId) => station.routes.add(routeId));
}

function getDistanceSq(lat1, lon1, lat2, lon2) {
	const avgLat = (lat1 + lat2) * 0.5;
	const latScale = Math.cos(avgLat * (Math.PI / 180));
	const dx = (lon1 - lon2) * latScale;
	const dy = lat1 - lat2;
	return dx * dx + dy * dy;
}

function setStationLatLng(station) {
	if (!station || station.stopCount <= 0) {
		return;
	}
	station.lat = station.latSum / station.stopCount;
	station.lon = station.lonSum / station.stopCount;
	station.latlng = L.latLng(station.lat, station.lon);
}

function buildBusStationClusters(geojson) {
	const stations = new Map();
	if (!geojson || !Array.isArray(geojson.features)) {
		return [];
	}
	const features = geojson.features;
	const maxDistanceSq = 0.0025 * 0.0025;
	features.forEach((feature) => {
		const props = feature?.properties || {};
		if (!isBusStationCoreStop(props)) {
			return;
		}
		const name = deriveBusStationName(props);
		if (!name) {
			return;
		}
		const coords = feature?.geometry?.coordinates;
		if (!Array.isArray(coords) || coords.length < 2) {
			return;
		}
		const lon = Number(coords[0]);
		const lat = Number(coords[1]);
		if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
			return;
		}
		const key = buildBusStationKey(name);
		if (!key) {
			return;
		}
		let station = stations.get(key);
		if (!station) {
			const baseName = getStationBaseName(name);
			station = {
				name,
				key,
				baseName,
				baseNameUpper: baseName.toUpperCase(),
				routes: new Set(),
				stopIds: new Set(),
				latSum: 0,
				lonSum: 0,
				stopCount: 0
			};
			stations.set(key, station);
		}
		addBusStationStop(station, feature);
	});

	if (stations.size > 0) {
		const stationList = Array.from(stations.values());
		stationList.forEach((station) => setStationLatLng(station));
		features.forEach((feature) => {
			const props = feature?.properties || {};
			if (isBusStationCoreStop(props) || shouldExcludeStationStop(props)) {
				return;
			}
			const stopName = String(getStopName(props) || "").trim();
			if (!stopName || !/station/i.test(stopName)) {
				return;
			}
			const upper = stopName.toUpperCase();
			stationList.forEach((station) => {
				if (!station.baseNameUpper) {
					return;
				}
				if (!upper.includes(station.baseNameUpper)) {
					return;
				}
				const coords = feature?.geometry?.coordinates;
				if (!Array.isArray(coords) || coords.length < 2 || !station.latlng) {
					return;
				}
				const lon = Number(coords[0]);
				const lat = Number(coords[1]);
				if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
					return;
				}
				const distanceSq = getDistanceSq(lat, lon, station.lat, station.lon);
				if (distanceSq > maxDistanceSq) {
					return;
				}
				addBusStationStop(station, feature);
			});
		});
	}

	return Array.from(stations.values()).map((station) => {
		setStationLatLng(station);
		station.routeCount = station.routes.size;
		return station;
	});
}

async function loadBusStationData() {
	if (appState.busStationData) {
		return appState.busStationData;
	}
	const [stationsGeojson, stopsGeojson] = await Promise.all([
		loadBusStationsGeojson(),
		loadBusStopsGeojson()
	]);
	const stations = buildBusStationsFromAnchors(stationsGeojson, stopsGeojson);
	appState.busStationData = stations;
	return stations;
}

function buildBusStationPopup(station) {
	const routes = Array.from(station.routes || []);
	const routeSets = appState.useRouteTypeColours ? appState.networkRouteSets : null;
	return `
		<div class="hover-popup__content">
			<div class="hover-popup__title">${escapeHtml(station.name)}</div>
			<div class="hover-popup__routes">${renderRoutePills(routes, routeSets)}</div>
		</div>
	`;
}

function buildBusStationInfoHtml(station, routeSets) {
	const routes = Array.from(station.routes || []);
	const stopCount = Number.isFinite(station.stopCount) ? station.stopCount : 0;
	const subtitle = stopCount > 0 ? `${stopCount} stops` : "Bus station";
	return {
		title: station.name || "Bus station",
		subtitle,
		bodyHtml: `
			<div class="info-section">
				<div class="info-label">Routes serving</div>
				${renderRoutePills(routes, routeSets)}
			</div>
		`
	};
}

function clearBusStationsLayer() {
	if (appState.busStationLayer && appState.map) {
		appState.map.removeLayer(appState.busStationLayer);
		appState.busStationLayer = null;
	}
}

function clearBusStationHighlight() {
	if (appState.busStationHighlightLayer && appState.map) {
		appState.map.removeLayer(appState.busStationHighlightLayer);
		appState.busStationHighlightLayer = null;
	}
}

function highlightBusStation(station) {
	if (!appState.map || !station?.latlng) {
		return;
	}
	clearBusStationHighlight();
	const layer = L.layerGroup();
	L.circleMarker(station.latlng, {
		radius: 12,
		weight: 3,
		color: "#f97316",
		fillColor: "#fdba74",
		fillOpacity: 0.35,
		interactive: false,
		pane: HIGHLIGHT_PANE
	}).addTo(layer);
	layer.addTo(appState.map);
	appState.busStationHighlightLayer = layer;
}

function clearBusStationRoutes() {
	if (appState.busStationRouteLayer && appState.map) {
		appState.map.removeLayer(appState.busStationRouteLayer);
		appState.busStationRouteLayer = null;
	}
}

function clearFocusedRouteLayer() {
	if (appState.focusRouteLayer && appState.map) {
		appState.map.removeLayer(appState.focusRouteLayer);
		appState.focusRouteLayer = null;
	}
}

function getFocusedRouteColour(routeId, routeSets) {
	const className = getRoutePillClass(routeId, routeSets);
	if (className === "night") {
		return ROUTE_COLOURS.night;
	}
	if (className === "school") {
		return ROUTE_COLOURS.school;
	}
	if (className === "twentyfour") {
		return ROUTE_COLOURS.twentyFour;
	}
	if (className === "prefix") {
		return ROUTE_COLOURS.prefix;
	}
	return ROUTE_COLOURS.regular;
}

async function focusRoute(routeId) {
	if (!appState.map) {
		return;
	}
	const normalised = String(routeId || "").trim().toUpperCase();
	if (!normalised || isExcludedRoute(normalised)) {
		return;
	}
	ensureRouteStopData(normalised)
		.then(() => {
			if (appState.selectedFeature?.type === "stop") {
				refreshSelectedInfoPanel().catch(() => {});
			}
		})
		.catch(() => {});
	clearFocusedRouteLayer();
	appState.focusRouteId = normalised;
	appState.focusRouteLoadToken += 1;
	const loadToken = appState.focusRouteLoadToken;

	appState.routeLoadToken += 1;
	appState.busStationRouteLoadToken += 1;
	appState.networkRouteLoadToken += 1;
	clearGarageRoutes();
	clearBusStationRoutes();
	clearNetworkRoutes();

	const routeSets = appState.useRouteTypeColours ? await loadNetworkRouteSets() : null;
	const segments = await loadRouteGeometry(normalised);
	if (loadToken !== appState.focusRouteLoadToken || !segments || segments.length === 0) {
		return;
	}
	const layerGroup = L.layerGroup().addTo(appState.map);
	appState.focusRouteLayer = layerGroup;
	const color = getFocusedRouteColour(normalised, routeSets);
	segments.forEach((segment) => {
		const line = L.polyline(segment, {
			color,
			weight: 4,
			opacity: 0.9,
			pane: ROUTE_PANE
		}).addTo(layerGroup);
		line._routeId = normalised;
		bindRouteHoverPopup(line, layerGroup);
	});
	updateSelectedInfo(`Focused route: ${normalised}`);
}

function clearFocusedRoute() {
	if (!appState.focusRouteId) {
		return;
	}
	appState.focusRouteId = null;
	appState.focusRouteLoadToken += 1;
	clearFocusedRouteLayer();
	updateSelectedInfo("Route focus cleared.");
	if (appState.activeGarageRoutes) {
		appState.routeLoadToken += 1;
		renderGarageRoutes(appState.routeLoadToken);
	}
	if (appState.activeBusStationRoutes) {
		appState.busStationRouteLoadToken += 1;
		renderBusStationRoutes(appState.busStationRouteLoadToken);
	}
	if (appState.showNetworkRoutes) {
		appState.networkRouteLoadToken += 1;
		renderNetworkRoutes(appState.networkRouteLoadToken);
	}
}

function getBusStationRouteColour(routeId, routeSets) {
	if (!appState.useRouteTypeColours || !routeSets) {
		return ROUTE_COLOURS.regular;
	}
	const normalised = String(routeId || "").toUpperCase();
	if (normalised.startsWith("N")) {
		return ROUTE_COLOURS.night;
	}
	const isRegular = routeSets.regular?.has(normalised);
	const isSchool = routeSets.school?.has(normalised);
	const isTwentyFour = routeSets.twentyFour?.has(normalised);
	if (isTwentyFour) {
		return ROUTE_COLOURS.twentyFour;
	}
	if (isSchool && !isRegular) {
		return ROUTE_COLOURS.school;
	}
	if (isPrefixRoute(normalised)) {
		return ROUTE_COLOURS.prefix;
	}
	return ROUTE_COLOURS.regular;
}

function resolveRouteColour(defaultColor) {
	return appState.useRouteTypeColours ? defaultColor : ROUTE_COLOURS.regular;
}

function getRouteDrawOrderFromDom() {
	const container = document.getElementById("networkFilters");
	if (!container) {
		return DEFAULT_ROUTE_DRAW_ORDER;
	}
	const types = Array.from(container.querySelectorAll("label.toggle[data-route-type]"))
		.map((label) => label.dataset.routeType)
		.filter(Boolean);
	if (types.length === 0) {
		return DEFAULT_ROUTE_DRAW_ORDER;
	}
	return types.slice().reverse();
}

function orderRouteCategories(categories) {
	const order = getRouteDrawOrderFromDom();
	const orderIndex = new Map(order.map((type, index) => [type, index]));
	return categories
		.slice()
		.sort((a, b) => (orderIndex.get(a.type) ?? 99) - (orderIndex.get(b.type) ?? 99));
}

function isBusStationScaleEnabled() {
	const checkbox = document.getElementById("scaleBusStationMarkers");
	return checkbox ? checkbox.checked : false;
}

function getBusStationScaleMax(stations) {
	if (!Array.isArray(stations)) {
		return 0;
	}
	return stations.reduce((max, station) => {
		const count = Number(station?.routes?.size || station?.routeCount || 0);
		return count > max ? count : max;
	}, 0);
}

function getBusStationMarkerRadius(routeCount, scaleEnabled, maxCount) {
	const uniformRadius = 7;
	if (!scaleEnabled || maxCount <= 0) {
		return uniformRadius;
	}
	const minRadius = 6;
	const maxRadius = 18;
	const t = Math.min(routeCount / maxCount, 1);
	return minRadius + (maxRadius - minRadius) * t;
}

async function addBusStationsLayer(map) {
	if (!map) {
		return null;
	}
	const loadToken = appState.busStationLoadToken;
	const stations = await loadBusStationData();
	if (loadToken !== appState.busStationLoadToken) {
		return null;
	}

	clearBusStationsLayer();
	if (appState.useRouteTypeColours) {
		await loadNetworkRouteSets();
	}
	const scaleEnabled = isBusStationScaleEnabled();
	const maxRoutes = scaleEnabled ? getBusStationScaleMax(stations) : 0;
	const layerGroup = L.layerGroup();
	stations.forEach((station) => {
		if (!station.latlng) {
			return;
		}
		const routeCount = Number(station?.routes?.size || station?.routeCount || 0);
		const radius = getBusStationMarkerRadius(routeCount, scaleEnabled, maxRoutes);
		const marker = L.circleMarker(station.latlng, {
			radius,
			weight: 2,
			color: "#0f766e",
			fillColor: "#14b8a6",
			fillOpacity: 0.85,
			pane: GARAGE_PANE
		});
		bindHoverPopup(marker, buildBusStationPopup(station));
		marker.on("click", () => {
			setSelectedFeature("station", station);
			refreshSelectedInfoPanel().catch(() => {});
			highlightBusStation(station);
			setBusStationSelectValue(station.key);
			selectBusStationRoutes(station);
		});
		marker.addTo(layerGroup);
	});
	layerGroup.addTo(map);
	appState.busStationLayer = layerGroup;
	return layerGroup;
}

function selectBusStationRoutes(station) {
	if (!appState.suppressNetworkRoutes) {
		appState.suppressNetworkRoutes = true;
	}
	appState.networkRouteLoadToken += 1;
	clearNetworkRoutes();
	clearActiveRouteSelections();
	if (appState.focusRouteId) {
		clearFocusedRoute();
	}
	appState.activeBusStationRoutes = station.routes;
	appState.busStationRouteLoadToken += 1;
	renderBusStationRoutes(appState.busStationRouteLoadToken);
	updateSelectedInfo(`Bus station: ${station.name}`);
}

function ensureBusStationsVisible() {
	const checkbox = document.getElementById("showBusStations");
	if (!checkbox) {
		return;
	}
	if (!checkbox.checked) {
		checkbox.checked = true;
		appState.busStationLoadToken += 1;
		addBusStationsLayer(appState.map).catch(() => {});
	}
}

function setBusStationSelectValue(key) {
	const select = document.getElementById("busStationSelect");
	if (!select) {
		return;
	}
	select.value = key || "";
}

async function renderBusStationRoutes(loadToken) {
	if (appState.focusRouteId) {
		return;
	}
	clearBusStationRoutes();
	if (!appState.map || !appState.activeBusStationRoutes) {
		return;
	}
	const filteredRoutes = filterRouteSet(appState.activeBusStationRoutes, appState.routeFilterTokens);
	if (filteredRoutes.length === 0 && appState.routeFilterTokens.length > 0) {
		filteredRoutes.splice(0, filteredRoutes.length, ...filterRouteSet(appState.activeBusStationRoutes, []));
	}
	const initialSelectedRoutes = new Set(filteredRoutes);
	if (initialSelectedRoutes.size === 0) {
		updateSelectedRouteCount(0);
		return;
	}

	let frequencyContext = null;
	if (appState.showFrequencyLayer) {
		frequencyContext = await buildFrequencyContext(initialSelectedRoutes);
		if (loadToken !== appState.busStationRouteLoadToken) {
			return;
		}
	} else {
		appState.frequencySegmentTotals = null;
		appState.frequencyMaxTotal = 0;
	}

	let displayRoutes = filteredRoutes;
	if (appState.showFrequencyLayer && appState.frequencyData) {
		const band = appState.frequencyBand || "peak_am";
		displayRoutes = filterRoutesByFrequency(filteredRoutes, band);
	}
	const selectedRoutes = new Set(displayRoutes);
	if (selectedRoutes.size === 0) {
		updateSelectedRouteCount(0);
		return;
	}
	updateSelectedRouteCount(selectedRoutes.size);

	const routeSets = appState.useRouteTypeColours ? await loadNetworkRouteSets() : null;
	const layerGroup = L.layerGroup().addTo(appState.map);
	appState.busStationRouteLayer = layerGroup;
	const hasFrequency = Boolean(frequencyContext?.segmentTotals && frequencyContext.maxTotal > 0);
	const baseWeight = hasFrequency ? 1.8 : 4;

	const tasks = displayRoutes.map((routeId) => {
		const segmentPromise = frequencyContext?.segmentsByRoute?.has(routeId)
			? Promise.resolve(frequencyContext.segmentsByRoute.get(routeId))
			: loadRouteGeometry(routeId);
		return segmentPromise
			.then((segments) => {
				if (loadToken !== appState.busStationRouteLoadToken) {
					return;
				}
				if (!segments || segments.length === 0) {
					return;
				}
				segments.forEach((segment) => {
					const weighted = hasFrequency ? getFrequencyLineWeight(segment, frequencyContext) : null;
					const line = L.polyline(segment, {
						color: getBusStationRouteColour(routeId, routeSets),
						weight: weighted ?? baseWeight,
						opacity: 0.85,
						pane: ROUTE_PANE
					}).addTo(layerGroup);
					line._routeId = routeId;
					bindRouteHoverPopup(line, layerGroup);
				});
			})
			.catch(() => {});
	});

	await Promise.all(tasks);
}

function parseNetworkPercentage(props) {
	const raw = props["Proportion of network"];
	if (raw === undefined || raw === null) {
		return 0;
	}
	const value = Number.parseFloat(String(raw).replace('%', '').trim());
	return Number.isFinite(value) ? value : 0;
}

function getGarageScaleMax(geojson) {
	if (!Array.isArray(geojson)) {
		return 0;
	}
	return geojson.reduce((max, group) => {
		const value = getGarageGroupPercent(group.features || []);
		return value > max ? value : max;
	}, 0);
}

function getGarageGroupPercent(features) {
	return features.reduce((sum, feature) => {
		return sum + parseNetworkPercentage(feature.properties || {});
	}, 0);
}

function getGarageMarkerRadius(value, scaleEnabled, maxPercent) {
	const uniformRadius = 6;
	if (!scaleEnabled || maxPercent <= 0) {
		return uniformRadius;
	}
	const minRadius = 4;
	const maxRadius = 16;
	const t = Math.min(value / maxPercent, 1);
	return minRadius + (maxRadius - minRadius) * t;
}


function setupUI() {
	setupModuleAccordion();
	setupFrequencyModule();
	setupRouteFilterInput();
	setupBusStopFilterInput();
	setupBusStationSelect();
	setupNetworkFilterDrag();

	document.getElementById('showGarages').addEventListener('change', (e) => {
		if (e.target.checked) {
			appState.garageLoadToken += 1;
			addGaragesLayer(appState.map);
			return;
		}
		appState.garageLoadToken += 1;
		clearGarageMarkers();
		clearGarageRoutes();
		appState.activeGarageRoutes = null;
		if (appState.suppressNetworkRoutes && !appState.activeBusStationRoutes) {
			appState.suppressNetworkRoutes = false;
			appState.networkRouteLoadToken += 1;
			renderNetworkRoutes(appState.networkRouteLoadToken);
		}
		updateSelectedInfo('Garages hidden.');
		if (appState.selectedFeature?.type === "garage") {
			resetInfoPanel();
		}
	});

	const showBusStops = document.getElementById("showBusStops");
	if (showBusStops) {
		showBusStops.addEventListener("change", (event) => {
			appState.busStopLoadToken += 1;
			if (event.target.checked) {
				addBusStopsLayer(appState.map).catch(() => {});
				return;
			}
			clearBusStopsLayer();
			updateSelectedInfo("Bus stops hidden.");
			if (appState.selectedFeature?.type === "stop") {
				resetInfoPanel();
			}
		});
	}

	const showBusStands = document.getElementById("showBusStands");
	if (showBusStands) {
		showBusStands.addEventListener("change", (event) => {
			appState.busStandLoadToken += 1;
			if (event.target.checked) {
				addBusStandsLayer(appState.map).catch(() => {});
				return;
			}
			clearBusStandsLayer();
			updateSelectedInfo("Bus stands hidden.");
			if (appState.selectedFeature?.type === "stop") {
				resetInfoPanel();
			}
		});
	}

	const showBusStations = document.getElementById("showBusStations");
	if (showBusStations) {
		showBusStations.addEventListener("change", (event) => {
			appState.busStationLoadToken += 1;
			if (event.target.checked) {
				addBusStationsLayer(appState.map).catch(() => {});
				return;
			}
			clearBusStationsLayer();
			clearBusStationHighlight();
			clearBusStationRoutes();
			appState.activeBusStationRoutes = null;
			if (appState.suppressNetworkRoutes && !appState.activeGarageRoutes) {
				appState.suppressNetworkRoutes = false;
				appState.networkRouteLoadToken += 1;
				renderNetworkRoutes(appState.networkRouteLoadToken);
			}
			updateSelectedInfo("Bus stations hidden.");
			setBusStationSelectValue("");
			if (appState.selectedFeature?.type === "station") {
				resetInfoPanel();
			}
		});
	}

	const scaleBusStations = document.getElementById("scaleBusStationMarkers");
	if (scaleBusStations) {
		scaleBusStations.addEventListener("change", () => {
			const showStations = document.getElementById("showBusStations");
			if (!showStations || !showStations.checked) {
				return;
			}
			appState.busStationLoadToken += 1;
			addBusStationsLayer(appState.map).catch(() => {});
		});
	}

	const colourRoutesByType = document.getElementById("colourRoutesByType");
	if (colourRoutesByType) {
		appState.useRouteTypeColours = colourRoutesByType.checked;
		colourRoutesByType.addEventListener("change", (event) => {
			appState.useRouteTypeColours = event.target.checked;
			if (appState.activeGarageRoutes) {
				appState.routeLoadToken += 1;
				renderGarageRoutes(appState.routeLoadToken);
			}
			if (appState.activeBusStationRoutes) {
				appState.busStationRouteLoadToken += 1;
				renderBusStationRoutes(appState.busStationRouteLoadToken);
			}
			if (appState.showNetworkRoutes) {
				appState.networkRouteLoadToken += 1;
				renderNetworkRoutes(appState.networkRouteLoadToken);
			}
			const showStops = document.getElementById("showBusStops");
			if (showStops && showStops.checked) {
				appState.busStopLoadToken += 1;
				addBusStopsLayer(appState.map).catch(() => {});
			}
			const showStations = document.getElementById("showBusStations");
			if (showStations && showStations.checked) {
				appState.busStationLoadToken += 1;
				addBusStationsLayer(appState.map).catch(() => {});
			}
			refreshSelectedInfoPanel().catch(() => {});
		});
	}

	document.getElementById('scaleGarageMarkers').addEventListener('change', () => {
		if (!document.getElementById('showGarages').checked) {
			return;
		}
		appState.garageLoadToken += 1;
		addGaragesLayer(appState.map);
	});

	document.getElementById('showGarageLabels').addEventListener('change', () => {
		if (!document.getElementById('showGarages').checked) {
			return;
		}
		appState.garageLoadToken += 1;
		addGaragesLayer(appState.map);
	});

	['showRegularRoutes', 'showNightRoutes', 'showSchoolRoutes'].forEach((id) => {
		const checkbox = document.getElementById(id);
		if (!checkbox) {
			return;
		}
		checkbox.addEventListener('change', () => {
			if (!appState.activeGarageRoutes) {
				return;
			}
			appState.routeLoadToken += 1;
			renderGarageRoutes(appState.routeLoadToken);
		});
	});

	const networkFilterIds = [
		"showNetworkRegularRoutes",
		"showNetworkPrefixRoutes",
		"showNetwork24hrRoutes",
		"showNetworkNightRoutes",
		"showNetworkSchoolRoutes"
	];

	const showAllCheckbox = document.getElementById("showAllRoutes");
	const syncNetworkFilters = () => {
		if (!showAllCheckbox) {
			return;
		}
		const showAll = showAllCheckbox.checked;
		networkFilterIds.forEach((id) => {
			const checkbox = document.getElementById(id);
			if (!checkbox) {
				return;
			}
			const label = checkbox.closest("label");
			if (showAll) {
				checkbox.dataset.prevChecked = checkbox.checked ? "true" : "false";
				checkbox.checked = true;
				checkbox.disabled = true;
				if (label) {
					label.classList.add("is-disabled");
				}
				return;
			}
			checkbox.disabled = false;
			if (checkbox.dataset.prevChecked !== undefined) {
				checkbox.checked = checkbox.dataset.prevChecked === "true";
				delete checkbox.dataset.prevChecked;
			}
			if (label) {
				label.classList.remove("is-disabled");
			}
		});
	};

	if (showAllCheckbox) {
		showAllCheckbox.addEventListener("change", () => {
			syncNetworkFilters();
			appState.networkRouteLoadToken += 1;
			renderNetworkRoutes(appState.networkRouteLoadToken);
		});
	}

	networkFilterIds.forEach((id) => {
		const checkbox = document.getElementById(id);
		if (!checkbox) {
			return;
		}
		checkbox.addEventListener("change", () => {
			appState.networkRouteLoadToken += 1;
			renderNetworkRoutes(appState.networkRouteLoadToken);
		});
	});

	const deckFilterIds = ["showAllDeckers", "showSingleDecker", "showDoubleDecker"];
	const handleDeckFilterChange = () => {
		loadVehicleLookup()
			.then(() => {
				if (appState.activeGarageRoutes) {
					appState.routeLoadToken += 1;
					renderGarageRoutes(appState.routeLoadToken);
				}
				if (appState.activeBusStationRoutes) {
					appState.busStationRouteLoadToken += 1;
					renderBusStationRoutes(appState.busStationRouteLoadToken);
				}
				if (appState.showNetworkRoutes) {
					appState.networkRouteLoadToken += 1;
					renderNetworkRoutes(appState.networkRouteLoadToken);
				}
			})
			.catch(() => {});
	};

	deckFilterIds.forEach((id) => {
		const checkbox = document.getElementById(id);
		if (!checkbox) {
			return;
		}
		checkbox.addEventListener("change", handleDeckFilterChange);
	});

	const resetRouteCheckboxes = () => {
		const ids = [
			"showAllRoutes",
			"showNetworkRegularRoutes",
			"showNetworkPrefixRoutes",
			"showNetwork24hrRoutes",
			"showNetworkNightRoutes",
			"showNetworkSchoolRoutes",
			"showAllDeckers",
			"showSingleDecker",
			"showDoubleDecker",
			"showRegularRoutes",
			"showNightRoutes",
			"showSchoolRoutes"
		];
		ids.forEach((id) => {
			const checkbox = document.getElementById(id);
			if (!checkbox) {
				return;
			}
			checkbox.checked = id === "showAllDeckers";
			checkbox.disabled = false;
			delete checkbox.dataset.prevChecked;
			const label = checkbox.closest("label");
			if (label) {
				label.classList.remove("is-disabled");
			}
		});
	};

	const clearAllLayers = document.getElementById("clearAllLayers");
	if (clearAllLayers) {
		clearAllLayers.addEventListener("click", () => {
			clearFocusedRoute();
			resetRouteCheckboxes();
			syncNetworkFilters();
			appState.garageLoadToken += 1;
			appState.busStopLoadToken += 1;
			appState.busStandLoadToken += 1;
			appState.busStationLoadToken += 1;
			appState.busStationRouteLoadToken += 1;
			appState.networkRouteLoadToken += 1;

			const toggles = ["showGarages", "showBusStops", "showBusStands", "showBusStations"];
			toggles.forEach((id) => {
				const checkbox = document.getElementById(id);
				if (checkbox) {
					checkbox.checked = false;
				}
			});
			const frequencyToggle = document.getElementById("showFrequencyOverlay");
			if (frequencyToggle) {
				frequencyToggle.checked = false;
			}
			appState.showFrequencyLayer = false;

			clearGarageMarkers();
			clearGarageRoutes();
			clearBusStopsLayer();
			clearBusStandsLayer();
			clearBusStationsLayer();
			clearBusStationHighlight();
			clearBusStationRoutes();
			clearNetworkRoutes();
			appState.frequencySegmentTotals = null;
			appState.frequencyMaxTotal = 0;
			appState.showNetworkRoutes = false;
			appState.activeGarageRoutes = null;
			appState.activeBusStationRoutes = null;
			appState.suppressNetworkRoutes = false;
			updateSelectedInfo("All layers cleared.");
			setBusStationSelectValue("");
			resetInfoPanel();
		});
	}

	const clearAllRoutes = document.getElementById("clearAllRoutes");
	if (clearAllRoutes) {
		clearAllRoutes.addEventListener("click", () => {
			clearFocusedRoute();
			resetRouteCheckboxes();
			syncNetworkFilters();
			appState.routeLoadToken += 1;
			appState.busStationRouteLoadToken += 1;
			appState.networkRouteLoadToken += 1;

			clearGarageRoutes();
			clearBusStationRoutes();
			clearNetworkRoutes();
			appState.frequencySegmentTotals = null;
			appState.frequencyMaxTotal = 0;
			appState.activeGarageRoutes = null;
			appState.activeBusStationRoutes = null;
			appState.showNetworkRoutes = false;
			appState.suppressNetworkRoutes = false;
			updateSelectedInfo("All routes cleared.");
		});
	}

	const exactMatchCheckbox = document.getElementById("showExactRouteMatch");
	if (exactMatchCheckbox) {
		exactMatchCheckbox.addEventListener("change", () => {
			clearFocusedRoute();
			if (appState.activeGarageRoutes) {
				appState.routeLoadToken += 1;
				renderGarageRoutes(appState.routeLoadToken);
			}
			if (appState.activeBusStationRoutes) {
				appState.busStationRouteLoadToken += 1;
				renderBusStationRoutes(appState.busStationRouteLoadToken);
			}
			appState.networkRouteLoadToken += 1;
			renderNetworkRoutes(appState.networkRouteLoadToken);
		});
	}
	syncNetworkFilters();

	const infoBody = document.getElementById("infoBody");
	if (infoBody) {
		infoBody.addEventListener("click", (event) => {
			const target = event.target.closest(".route-pill");
			if (!target) {
				return;
			}
			const routeId = target.dataset.route;
			if (!routeId) {
				return;
			}
			event.preventDefault();
			focusRoute(routeId);
		});
	}

	if (appState.map) {
		appState.map.on("click", () => {
			if (appState.focusRouteId) {
				clearFocusedRoute();
			}
		});
	}
}

function setupRouteFilterInput() {
	const input = document.getElementById("routeFilterEntry");
	const list = document.getElementById("routeFilterTags");
	const clearButton = document.getElementById("clearRouteFilter");
	if (!input || !list || !clearButton) {
		return;
	}

	let tokens = [];

	const syncTags = () => {
		list.innerHTML = tokens
			.map((token) => {
				const safe = token.replace(/"/g, "&quot;");
				return `<span class="tag-chip" data-token="${safe}">
					<span>${safe}</span>
					<button type="button" class="tag-remove" aria-label="Remove ${safe}">x</button>
				</span>`;
			})
			.join("");
		clearButton.disabled = tokens.length === 0;
	};

	const applyTokens = () => {
		appState.routeFilterTokens = tokens;
		if (tokens.length > 0) {
			updateSelectedInfo(`Filter: ${tokens.join(", ")}`);
		} else {
			updateSelectedInfo("No filter");
		}
		tokens.forEach((token) => {
			ensureRouteStopData(token).catch(() => {});
		});
		if (appState.activeGarageRoutes) {
			appState.routeLoadToken += 1;
			renderGarageRoutes(appState.routeLoadToken);
		}
		if (appState.activeBusStationRoutes) {
			appState.busStationRouteLoadToken += 1;
			renderBusStationRoutes(appState.busStationRouteLoadToken);
		}
		appState.networkRouteLoadToken += 1;
		renderNetworkRoutes(appState.networkRouteLoadToken);
	};

	const addTokensFromValue = (value) => {
		const newTokens = buildRouteFilterTokens(value);
		if (newTokens.length === 0) {
			return;
		}
		const tokenSet = new Set(tokens);
		newTokens.forEach((token) => {
			if (!tokenSet.has(token)) {
				tokens.push(token);
				tokenSet.add(token);
			}
		});
		syncTags();
		applyTokens();
	};

	const commitInput = () => {
		const value = input.value.trim();
		if (!value) {
			return;
		}
		addTokensFromValue(value);
		input.value = "";
	};

	input.addEventListener("keydown", (event) => {
		if (event.key === "Enter" || event.key === " " || event.key === "Spacebar") {
			event.preventDefault();
			commitInput();
			return;
		}
		if (event.key === "Backspace" && input.value.trim() === "" && tokens.length > 0) {
			event.preventDefault();
			tokens = tokens.slice(0, -1);
			syncTags();
			applyTokens();
		}
	});

	input.addEventListener("blur", () => {
		commitInput();
	});

	list.addEventListener("click", (event) => {
		const button = event.target.closest(".tag-remove");
		if (!button) {
			return;
		}
		const chip = button.closest(".tag-chip");
		if (!chip) {
			return;
		}
		const token = chip.getAttribute("data-token");
		if (!token) {
			return;
		}
		tokens = tokens.filter((entry) => entry !== token);
		syncTags();
		applyTokens();
	});

	clearButton.addEventListener("click", () => {
		tokens = [];
		syncTags();
		applyTokens();
	});

	syncTags();
}

function setupBusStopFilterInput() {
	const input = document.getElementById("busStopDistrict");
	const applyButton = document.getElementById("applyBusStopFilter");
	const clearButton = document.getElementById("clearBusStopFilter");
	if (!input || !applyButton || !clearButton) {
		return;
	}

	const applyFilter = async (value) => {
		appState.busStopFilterDistrict = normalisePostcodeDistrict(value);
		await refreshBusStopFilterStatus();
		const showStops = document.getElementById("showBusStops");
		if (showStops && showStops.checked) {
			appState.busStopLoadToken += 1;
			addBusStopsLayer(appState.map).catch(() => {});
		}
	};

	const runFilter = (value) => {
		applyFilter(value).catch(() => {});
	};

	applyButton.addEventListener("click", () => {
		runFilter(input.value.trim());
	});

	clearButton.addEventListener("click", () => {
		input.value = "";
		runFilter("");
	});

	input.addEventListener("keydown", (event) => {
		if (event.key === "Enter") {
			event.preventDefault();
			runFilter(input.value.trim());
		}
	});
}

function setupNetworkFilterDrag() {
	const container = document.getElementById("networkFilters");
	if (!container) {
		return;
	}
	const getLabels = () => Array.from(container.querySelectorAll("label.toggle[data-route-type]"));
	const refreshRoutesForOrder = () => {
		if (!appState.useRouteTypeColours || appState.focusRouteId) {
			return;
		}
		if (appState.activeGarageRoutes) {
			appState.routeLoadToken += 1;
			renderGarageRoutes(appState.routeLoadToken);
		}
		if (appState.activeBusStationRoutes) {
			appState.busStationRouteLoadToken += 1;
			renderBusStationRoutes(appState.busStationRouteLoadToken);
		}
		if (appState.showNetworkRoutes) {
			appState.networkRouteLoadToken += 1;
			renderNetworkRoutes(appState.networkRouteLoadToken);
		}
	};

	let dragState = null;

	const clearDragState = () => {
		if (!dragState) {
			return;
		}
		dragState.label.classList.remove("is-dragging");
		if (dragState.moved) {
			dragState.label.dataset.dragJust = "true";
			refreshRoutesForOrder();
			setTimeout(() => {
				delete dragState.label.dataset.dragJust;
			}, 0);
		}
		dragState = null;
	};

	container.addEventListener("pointerdown", (event) => {
		const label = event.target.closest("label.toggle[data-route-type]");
		if (!label || label.parentElement !== container || event.button !== 0) {
			return;
		}
		dragState = {
			label,
			startY: event.clientY,
			moved: false
		};
		label.setPointerCapture(event.pointerId);
	});

	container.addEventListener("pointermove", (event) => {
		if (!dragState) {
			return;
		}
		const label = dragState.label;
		const deltaY = event.clientY - dragState.startY;
		if (!dragState.moved && Math.abs(deltaY) < 4) {
			return;
		}
		if (!dragState.moved) {
			dragState.moved = true;
			label.classList.add("is-dragging");
		}
		const target = document.elementFromPoint(event.clientX, event.clientY);
		const targetLabel = target ? target.closest("label.toggle[data-route-type]") : null;
		if (!targetLabel || targetLabel === label || targetLabel.parentElement !== container) {
			return;
		}
		const rect = targetLabel.getBoundingClientRect();
		if (event.clientY > rect.top + rect.height / 2) {
			container.insertBefore(label, targetLabel.nextSibling);
		} else {
			container.insertBefore(label, targetLabel);
		}
	});

	container.addEventListener("pointerup", () => {
		clearDragState();
	});

	container.addEventListener("pointercancel", () => {
		clearDragState();
	});

	container.addEventListener("click", (event) => {
		const label = event.target.closest("label.toggle[data-route-type]");
		if (!label) {
			return;
		}
		if (label.dataset.dragJust) {
			event.preventDefault();
			event.stopPropagation();
		}
	});
}

function setupBusStationSelect() {
	const select = document.getElementById("busStationSelect");
	if (!select) {
		return;
	}

	const populate = (stations) => {
		const options = stations
			.slice()
			.sort((a, b) => a.name.localeCompare(b.name))
			.map((station) => `<option value="${escapeHtml(station.key)}">${escapeHtml(station.name)}</option>`)
			.join("");
		select.innerHTML = `<option value="">Choose a station</option>${options}`;
	};

	loadBusStationData()
		.then((stations) => {
			if (stations && stations.length > 0) {
				populate(stations);
			}
		})
		.catch(() => {});

	select.addEventListener("change", () => {
		const key = select.value;
		if (!key) {
			clearBusStationHighlight();
			clearSelectedFeature();
			resetInfoPanel();
			return;
		}
		const stations = appState.busStationData || [];
		const station = stations.find((entry) => entry.key === key);
		if (!station) {
			return;
		}
		ensureBusStationsVisible();
		highlightBusStation(station);
		setSelectedFeature("station", station);
		refreshSelectedInfoPanel().catch(() => {});
		selectBusStationRoutes(station);
		if (appState.map && station.latlng) {
			appState.map.flyTo(station.latlng, Math.max(appState.map.getZoom(), 13));
		}
	});
}

function setupModuleAccordion() {
	const modules = Array.from(document.querySelectorAll('.module'));
	modules.forEach((module) => {
		module.addEventListener('toggle', () => {
			if (!module.open) {
				return;
			}
			modules.forEach((other) => {
				if (other !== module) {
					other.open = false;
				}
			});
		});
	});
}

function setupFrequencyModule() {
	const bandSelect = document.getElementById("frequencyBand");
	const overlayToggle = document.getElementById("showFrequencyOverlay");
	if (!bandSelect || !overlayToggle) {
		return;
	}

	appState.frequencyBand = bandSelect.value || "peak_am";
	appState.showFrequencyLayer = overlayToggle.checked;

	const ensureFrequencyRoutesVisible = () => {
		if (!appState.showFrequencyLayer) {
			return;
		}
		const hasVisibleRoutes = Boolean(
			appState.activeGarageRoutes || appState.activeBusStationRoutes || appState.showNetworkRoutes
		);
		if (hasVisibleRoutes) {
			return;
		}
		const showAllCheckbox = document.getElementById("showAllRoutes");
		if (showAllCheckbox) {
			if (!showAllCheckbox.checked) {
				showAllCheckbox.checked = true;
			}
			showAllCheckbox.dispatchEvent(new Event("change"));
			return;
		}
		appState.networkRouteLoadToken += 1;
		renderNetworkRoutes(appState.networkRouteLoadToken);
	};

	const refreshFrequencyRoutes = () => {
		ensureFrequencyRoutesVisible();
		if (appState.activeGarageRoutes) {
			appState.routeLoadToken += 1;
			renderGarageRoutes(appState.routeLoadToken);
		}
		if (appState.activeBusStationRoutes) {
			appState.busStationRouteLoadToken += 1;
			renderBusStationRoutes(appState.busStationRouteLoadToken);
		}
		if (appState.showNetworkRoutes) {
			appState.networkRouteLoadToken += 1;
			renderNetworkRoutes(appState.networkRouteLoadToken);
		}
	};

	bandSelect.addEventListener("change", (event) => {
		appState.frequencyBand = event.target.value || "peak_am";
		refreshFrequencyRoutes();
	});

	overlayToggle.addEventListener("change", (event) => {
		appState.showFrequencyLayer = event.target.checked;
		refreshFrequencyRoutes();
	});
}

async function start() {
	setLoadingModalVisible(true);
	try {
		appState.map = initMap();
		await initialiseRouteGeometryIndex();
		setupUI();
		resetInfoPanel();
		appState.networkRouteLoadToken += 1;
		await renderNetworkRoutes(appState.networkRouteLoadToken);
	} finally {
		setLoadingModalVisible(false);
	}
}
document.addEventListener('DOMContentLoaded', start);
