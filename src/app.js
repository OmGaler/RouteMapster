// RouteMapster 
// Initialises Leaflet map 
const GEOCODE_DELAY_MS = 1100;
const LONDON_BOUNDS = {
	minLat: 51.28,
	maxLat: 51.72,
	minLon: -0.55,
	maxLon: 0.35
};

const ROUTE_GEOMETRY_PREFIX = "Route_Geometry_";
const ROUTE_GEOMETRY_MAX_AGE_DAYS = 14;
const ROUTE_GEOMETRY_PROBE_ROUTES = ["1", "25", "73", "100"];
const TFL_ROUTE_GEOMETRY_BASES = ["https://bus.data.tfl.gov.uk/"];
const ROUTE_GEOMETRY_GEOJSON_PREFIX = "/data/route_geometry_";
const ROUTE_GEOMETRY_GEOJSON_SUFFIX = ".geojson";
const BUS_STOPS_GEOJSON_PATH = "/data/bus_stops_20260112.geojson";

const ROUTE_COLORS = {
	regular: "#ef4444",
	twentyFour: "#10b981",
	night: "#f59e0b",
	school: "#3b82f6",
	prefix: "#ec4899"
};

let ROUTE_GEOMETRY_DIR = "/data/Route_Geometry_20251223";
let ROUTE_GEOMETRY_DATE = ROUTE_GEOMETRY_DIR.split("_").pop();
let ROUTE_GEOMETRY_GEOJSON_PATH = `${ROUTE_GEOMETRY_GEOJSON_PREFIX}${ROUTE_GEOMETRY_DATE}${ROUTE_GEOMETRY_GEOJSON_SUFFIX}`;

async function initialiseRouteGeometryPath() {
	const local = await fetchLatestRouteGeometryIndex("/data/");
	if (local) {
		applyRouteGeometryLocation(local.dirUrl, local.dateToken);
	}
	updateSelectedInfo("Using local route geometry GeoJSON.");
}

async function fetchLatestRouteGeometryIndex(baseUrl) {
	try {
		const response = await fetch(baseUrl, { cache: "no-store" });
		if (!response.ok) {
			return null;
		}
		const html = await response.text();
		const parser = new DOMParser();
		const doc = parser.parseFromString(html, "text/html");
		const entry = selectLatestRouteGeometryEntry(doc);
		if (!entry) {
			return null;
		}
		return {
			...entry,
			dirUrl: buildRouteGeometryDirUrl(baseUrl, entry),
			date: parseRouteGeometryDate(entry.dateToken)
		};
	} catch (error) {
		console.warn("Could not fetch latest Route_Geometry index:", error);
		return null;
	}
}

function selectLatestRouteGeometryEntry(doc) {
	const links = Array.from(doc.querySelectorAll("a"))
		.map((link) => (link.getAttribute("href") || link.textContent || "").trim())
		.filter(Boolean);

	const entries = links
		.map(parseRouteGeometryEntry)
		.filter(Boolean)
		.sort((a, b) => b.dateToken.localeCompare(a.dateToken));

	return entries[0] || null;
}

function parseRouteGeometryEntry(raw) {
	const cleaned = raw.split("?")[0].trim();
	if (!cleaned.includes(ROUTE_GEOMETRY_PREFIX)) {
		return null;
	}
	const match = cleaned.match(/Route_Geometry_(\d{8})/);
	if (!match) {
		return null;
	}
	return {
		raw: cleaned,
		dateToken: match[1],
		isZip: cleaned.toLowerCase().endsWith(".zip")
	};
}

function buildRouteGeometryDirUrl(baseUrl, entry) {
	const normalisedBase = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
	const stripped = entry.raw.replace(/\/$/, "");
	if (stripped.startsWith("http://") || stripped.startsWith("https://")) {
		return stripped;
	}
	return `${normalisedBase}${stripped}`;
}

function parseRouteGeometryDate(dateToken) {
	if (!dateToken || !/^\d{8}$/.test(dateToken)) {
		return null;
	}
	const year = Number(dateToken.slice(0, 4));
	const month = Number(dateToken.slice(4, 6));
	const day = Number(dateToken.slice(6, 8));
	const date = new Date(Date.UTC(year, month - 1, day));
	return Number.isNaN(date.getTime()) ? null : date;
}

function isOlderThanDays(date, days) {
	if (!date) {
		return false;
	}
	const ageMs = Date.now() - date.getTime();
	return ageMs > days * 24 * 60 * 60 * 1000;
}

function applyRouteGeometryLocation(dirUrl, dateToken) {
	if (!dirUrl || !dateToken) {
		return;
	}
	ROUTE_GEOMETRY_DIR = dirUrl;
	ROUTE_GEOMETRY_DATE = dateToken;
	ROUTE_GEOMETRY_GEOJSON_PATH = `${ROUTE_GEOMETRY_GEOJSON_PREFIX}${ROUTE_GEOMETRY_DATE}${ROUTE_GEOMETRY_GEOJSON_SUFFIX}`;
	appState.routeGeometryGeojson = null;
	appState.routeGeometryIndex = null;
	appState.routeGeometryGeojsonPromise = null;
	appState.geometryRouteIds = undefined;
	appState.routeGeometryCache.clear();
}

async function tryRefreshRouteGeometryFromTfL(localDate) {
	for (const baseUrl of TFL_ROUTE_GEOMETRY_BASES) {
		const remote = await fetchLatestRouteGeometryIndex(baseUrl);
		if (!remote || !remote.date) {
			continue;
		}
		if (localDate && remote.date <= localDate) {
			updateSelectedInfo("Local route geometry is the latest available.");
			return;
		}
		if (remote.isZip) {
			updateSelectedInfo("Latest TfL route geometry is a zip. Using local copy.");
			return;
		}

		const canUseRemote = await probeRouteGeometryFiles(remote.dirUrl, remote.dateToken);
		if (!canUseRemote) {
			continue;
		}

		applyRouteGeometryLocation(remote.dirUrl, remote.dateToken);
		updateSelectedInfo(`Using TfL route geometry ${remote.dateToken}.`);
		return;
	}

	updateSelectedInfo("Could not refresh route geometry from TfL. Using local copy.");
}

async function probeRouteGeometryFiles(dirUrl, dateToken) {
	for (const routeId of ROUTE_GEOMETRY_PROBE_ROUTES) {
		const probeUrl = `${dirUrl}/Route_Geometry_${routeId}_${dateToken}.xml`;
		try {
			const response = await fetch(probeUrl, { method: "GET" });
			if (response.ok) {
				return true;
			}
		} catch (error) {
			continue;
		}
	}
	return false;
}

function initMap() {
	const map = L.map('map', { preferCanvas: true }).setView([51.5074, -0.1278], 11);

	L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
		attribution: '&copy; OpenStreetMap contributors',
		opacity: 0.85
	}).addTo(map);

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
	busStopLayer: null,
	busStopLoadToken: 0,
	busStopFilterDistrict: "",
	busStationLayer: null,
	busStationLoadToken: 0,
	busStationData: null,
	activeBusStationRoutes: null,
	busStationRouteLayer: null,
	busStationRouteLoadToken: 0,
	useRouteTypeColors: false,
	selectedFeature: null,
	busStationHighlightLayer: null,
	routeGeometryCache: new Map(),
	routeGeometryGeojson: null,
	routeGeometryIndex: null,
	routeGeometryGeojsonPromise: null,
	garageRouteLayer: null,
	networkRouteLayer: null,
	activeGarageRoutes: null,
	routeLoadToken: 0,
	networkRouteLoadToken: 0,
	networkRouteSets: null,
	geometryRouteIds: undefined,
	routeFilterTokens: [],
	geocodeLastAt: 0
};

function updateSelectedInfo(text) {
	document.getElementById('selectedInfo').textContent = text;
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
	appState.selectedFeature = { type, data };
}

function clearSelectedFeature() {
	appState.selectedFeature = null;
}

async function refreshSelectedInfoPanel() {
	if (!appState.selectedFeature) {
		return;
	}
	const { type, data } = appState.selectedFeature;
	const routeSets = appState.useRouteTypeColors ? await loadNetworkRouteSets() : null;
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
  const groups = groupGaragesByLocation(gj);
  const maxPercent = scaleEnabled ? getGarageScaleMax(groups) : 0;

  const layerGroup = L.layerGroup();
  groups.forEach((group) => {
    const groupPercent = getGarageGroupPercent(group.features);
    const radius = getGarageMarkerRadius(groupPercent, scaleEnabled, maxPercent);
    const marker = L.circleMarker(group.latlng, { radius, weight: 1, fillOpacity: 0.9 });
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
			fillOpacity: 0.8
		});
		marker.on("click", () => {
			const props = feature.properties || {};
			setSelectedFeature("stop", props);
			refreshSelectedInfoPanel().catch(() => {});
		});
		marker.addTo(layerGroup);
	});

	layerGroup.addTo(map);
	appState.busStopLayer = layerGroup;
	updateBusStopFilterStatus(result.count, result.district);
	return layerGroup;
}

async function loadGaragesGeojson() {
	if (appState.garagesGeojson) {
		return appState.garagesGeojson;
	}
	const res = await fetch("/data/garages.geojson");
	appState.garagesGeojson = await res.json();
	return appState.garagesGeojson;
}

async function loadBusStopsGeojson() {
	if (appState.busStopsGeojson) {
		return appState.busStopsGeojson;
	}
	const res = await fetch(BUS_STOPS_GEOJSON_PATH);
	appState.busStopsGeojson = await res.json();
	return appState.busStopsGeojson;
}

function normalizePostcodeDistrict(value) {
	if (!value) {
		return "";
	}
	const cleaned = String(value).toUpperCase().trim();
	if (!cleaned) {
		return "";
	}
	const token = cleaned.split(/\s+/)[0];
	const normalized = token.replace(/[^A-Z0-9]/g, "");
	const match = normalized.match(/^([A-Z]{1,2}\d{1,2})/);
	return match ? match[1] : normalized;
}

function getPostcodeDistrict(props) {
	return normalizePostcodeDistrict(props?.POSTCODE);
}

function formatRouteList(routes) {
	const list = Array.isArray(routes) ? routes : Array.from(routes || []);
	const unique = Array.from(new Set(list.map((route) => String(route)).filter(Boolean)));
	if (unique.length === 0) {
		return "Routes: None listed";
	}
	const sorted = unique
		.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
	return `Routes: ${sorted.join(", ")}`;
}

function getRoutePillClass(routeId, routeSets) {
	const normalized = String(routeId || "").toUpperCase();
	if (!appState.useRouteTypeColors) {
		return "regular";
	}
	if (normalized.startsWith("N")) {
		return "night";
	}
	if (routeSets?.school?.has(normalized)) {
		return "school";
	}
	if (routeSets?.twentyFour?.has(normalized)) {
		return "twentyfour";
	}
	if (isPrefixRoute(normalized)) {
		return "prefix";
	}
	return "regular";
}

function renderRoutePills(routes, routeSets) {
	const list = Array.isArray(routes) ? routes : Array.from(routes || []);
	const unique = Array.from(new Set(list.map((route) => String(route)).filter(Boolean)));
	if (unique.length === 0) {
		return '<div class="info-empty">No routes listed.</div>';
	}
	const sorted = unique.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
	const pills = sorted
		.map((route) => {
			const className = getRoutePillClass(route, routeSets);
			return `<span class="route-pill route-pill--${className}">${escapeHtml(route)}</span>`;
		})
		.join("");
	return `<div class="route-pill-group">${pills}</div>`;
}

function formatStopRoutes(props) {
	const tokens = getStopRouteTokens(props);
	return formatRouteList(tokens);
}

function buildBusStopPopup(props) {
	const name = props?.STOP_NAME || props?.STOP_CODE || "Bus stop";
	const routes = formatStopRoutes(props);
	return `<div><div>${name}</div><div>${routes}</div></div>`;
}

function buildBusStopInfoHtml(props, routeSets) {
	const name = props?.STOP_NAME || props?.STOP_CODE || "Bus stop";
	const road = props?.ROAD_NAME || "";
	const postcode = props?.POSTCODE || "";
	const stopCode = props?.STOP_CODE || "";
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
				${renderRoutePills(routes, routeSets)}
			</div>
		`
	};
}

function isExcludedStopRoute(routeId) {
	if (!routeId) {
		return false;
	}
	return /^UL/i.test(routeId) || /^Y/i.test(routeId);
}

function getStopRouteTokens(props) {
	return extractRouteTokens(props?.ROUTES).filter((routeId) => !isExcludedStopRoute(routeId));
}

function filterBusStops(geojson, district) {
	const features = Array.isArray(geojson?.features) ? geojson.features : [];
	const normalized = normalizePostcodeDistrict(district);
	if (!normalized) {
		return { features, count: features.length, district: "" };
	}
	const filtered = features.filter((feature) => {
		const props = feature?.properties || {};
		return getPostcodeDistrict(props) === normalized;
	});
	return { features: filtered, count: filtered.length, district: normalized };
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

function groupGaragesByLocation(geojson) {
	const groups = new Map();
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
		const key = `${lat.toFixed(6)},${lon.toFixed(6)}`;
		let group = groups.get(key);
		if (!group) {
			group = { latlng: L.latLng(lat, lon), features: [] };
			groups.set(key, group);
		}
		group.features.push(feature);
	});
	return Array.from(groups.values());
}

function buildGarageGroupInfoHtml(features) {
	if (!features || features.length === 0) {
		return '';
	}
	return features.map((feature) => buildGarageSingleInfoHtml(feature)).join('<hr/>');
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

function selectGarageRoutes(features) {
	appState.activeGarageRoutes = buildGarageRouteSets(features);
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
	});
	return { regular, night, school };
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
			if (cleaned) {
				set.add(cleaned.toUpperCase());
			}
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
		.map((token) => token.toUpperCase());
}

function buildRouteFilterTokens(query) {
	const tokens = new Set();
	addRouteTokens(tokens, query);
	return Array.from(tokens);
}

function routeMatchesFilter(routeId, filterTokens, exactMatch) {
	if (!filterTokens || filterTokens.length === 0) {
		return true;
	}
	const normalizedRouteId = routeId.toUpperCase();
	return filterTokens.some((token) => {
		if (normalizedRouteId === token) {
			return true;
		}
		if (exactMatch) {
			return false;
		}
		if (/^\d+$/.test(token)) {
			return normalizedRouteId.startsWith("N") && normalizedRouteId.slice(1) === token;
		}
		if (/^[A-Z]+$/.test(token)) {
			if (token === "N") {
				return false;
			}
			return normalizedRouteId.startsWith(token);
		}
		return false;
	});
}

function filterRouteSet(routes, filterTokens) {
	const exactMatch = isRouteTypeEnabled("showExactRouteMatch");
	return Array.from(routes).filter((routeId) => routeMatchesFilter(routeId, filterTokens, exactMatch));
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
	appState.networkRouteSets = { regular, night, school, other, twentyFour };
	return appState.networkRouteSets;
}

function normalizeRouteGeometryDirUrl(dirUrl) {
	if (!dirUrl) {
		return "";
	}
	return dirUrl.endsWith("/") ? dirUrl : `${dirUrl}/`;
}

function parseRouteGeometryIndex(html) {
	const parser = new DOMParser();
	const doc = parser.parseFromString(html, "text/html");
	const routeIds = new Set();
	Array.from(doc.querySelectorAll("a")).forEach((link) => {
		const raw = (link.getAttribute("href") || link.textContent || "").trim();
		const cleaned = raw.split("?")[0].split("#")[0];
		const match = cleaned.match(/Route_Geometry_([A-Za-z0-9]+)_\d{8}\.xml/i);
		if (match && match[1]) {
			routeIds.add(match[1].toUpperCase());
		}
	});
	return routeIds;
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

function buildRouteGeometryIndex(geojson) {
	const index = new Map();
	const features = Array.isArray(geojson?.features) ? geojson.features : [];
	features.forEach((feature) => {
		const props = feature?.properties || {};
		const rawRouteId = props.routeId || feature?.id || props.ROUTE_ID || "";
		const routeId = String(rawRouteId).trim().toUpperCase();
		if (!routeId) {
			return;
		}
		const segments = extractRouteGeometrySegments(feature.geometry);
		if (segments.length === 0) {
			return;
		}
		index.set(routeId, segments);
	});
	return index;
}

async function loadRouteGeometryGeojson() {
	if (appState.routeGeometryGeojson) {
		return appState.routeGeometryGeojson;
	}
	if (appState.routeGeometryGeojsonPromise) {
		return appState.routeGeometryGeojsonPromise;
	}
	appState.routeGeometryGeojsonPromise = fetch(ROUTE_GEOMETRY_GEOJSON_PATH, { cache: "no-store" })
		.then((res) => {
			if (!res.ok) {
				return null;
			}
			return res.json();
		})
		.then((geojson) => {
			if (!geojson) {
				appState.routeGeometryGeojson = null;
				appState.routeGeometryIndex = null;
				return null;
			}
			appState.routeGeometryGeojson = geojson;
			appState.routeGeometryIndex = buildRouteGeometryIndex(geojson);
			return geojson;
		})
		.finally(() => {
			appState.routeGeometryGeojsonPromise = null;
		});
	return appState.routeGeometryGeojsonPromise;
}

async function loadRouteGeometryRouteIds() {
	if (appState.geometryRouteIds instanceof Set) {
		return appState.geometryRouteIds;
	}
	if (appState.geometryRouteIds === null) {
		return null;
	}
	try {
		const geojson = await loadRouteGeometryGeojson();
		if (appState.routeGeometryIndex) {
			const routeIds = new Set(appState.routeGeometryIndex.keys());
			appState.geometryRouteIds = routeIds.size > 0 ? routeIds : null;
			return appState.geometryRouteIds;
		}
		if (!geojson) {
			appState.geometryRouteIds = null;
			return null;
		}
		const routeIds = new Set();
		const features = Array.isArray(geojson.features) ? geojson.features : [];
		features.forEach((feature) => {
			const props = feature?.properties || {};
			const rawRouteId = props.routeId || feature?.id || props.ROUTE_ID || "";
			const routeId = String(rawRouteId).trim().toUpperCase();
			if (routeId) {
				routeIds.add(routeId);
			}
		});
		appState.geometryRouteIds = routeIds.size > 0 ? routeIds : null;
		return appState.geometryRouteIds;
	} catch (error) {
		appState.geometryRouteIds = null;
		return null;
	}
}

async function renderGarageRoutes(loadToken) {
	clearGarageRoutes();
	if (!appState.map || !appState.activeGarageRoutes) {
		return;
	}
	const categories = getSelectedRouteCategories();
	if (categories.length === 0) {
		return;
	}

	const layerGroup = L.layerGroup().addTo(appState.map);
	appState.garageRouteLayer = layerGroup;

	const tasks = categories.flatMap((category) => {
		const filteredRoutes = filterRouteSet(category.routes, appState.routeFilterTokens);
		return filteredRoutes.map((routeId) => {
			return loadRouteGeometry(routeId)
				.then((segments) => {
					if (loadToken !== appState.routeLoadToken) {
						return;
					}
					if (!segments || segments.length === 0) {
						return;
					}
					segments.forEach((segment) => {
						const line = L.polyline(segment, {
							color: resolveRouteColor(category.color),
							weight: 4,
							opacity: 0.85
						}).addTo(layerGroup);
						line.bindTooltip(routeId, { sticky: true });
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
		categories.push({ color: ROUTE_COLORS.regular, routes: appState.activeGarageRoutes.regular });
	}
	if (isRouteTypeEnabled('showNightRoutes') && appState.activeGarageRoutes?.night) {
		categories.push({ color: ROUTE_COLORS.night, routes: appState.activeGarageRoutes.night });
	}
	if (isRouteTypeEnabled('showSchoolRoutes') && appState.activeGarageRoutes?.school) {
		categories.push({ color: ROUTE_COLORS.school, routes: appState.activeGarageRoutes.school });
	}
	return categories;
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
		categories.push({ color: ROUTE_COLORS.regular, routes: regularRoutes });
	}
	if (separatePrefix && prefixRoutes.size > 0) {
		categories.push({ color: ROUTE_COLORS.prefix, routes: prefixRoutes });
	}
	if (separateTwentyFour && twentyFourRoutes.size > 0) {
		categories.push({ color: ROUTE_COLORS.twentyFour, routes: twentyFourRoutes });
	}
	if (showNight && nightRoutes.size > 0) {
		categories.push({ color: ROUTE_COLORS.night, routes: nightRoutes });
	}
	if (showSchool && schoolRoutes.size > 0) {
		categories.push({ color: ROUTE_COLORS.school, routes: schoolRoutes });
	}
	return categories;
}

async function renderNetworkRoutes(loadToken) {
	clearNetworkRoutes();
	if (!appState.map) {
		return;
	}
	const categories = await getSelectedNetworkCategories();
	if (loadToken !== appState.networkRouteLoadToken) {
		return;
	}
	if (categories.length === 0) {
		return;
	}

	const layerGroup = L.layerGroup().addTo(appState.map);
	appState.networkRouteLayer = layerGroup;

	const tasks = categories.flatMap((category) => {
		const filteredRoutes = filterRouteSet(category.routes, appState.routeFilterTokens);
		return filteredRoutes.map((routeId) => {
			return loadRouteGeometry(routeId)
				.then((segments) => {
					if (loadToken !== appState.networkRouteLoadToken) {
						return;
					}
					if (!segments || segments.length === 0) {
						return;
					}
					segments.forEach((segment) => {
						const line = L.polyline(segment, {
							color: resolveRouteColor(category.color),
							weight: 3,
							opacity: 0.7
						}).addTo(layerGroup);
						line.bindTooltip(routeId, { sticky: true });
					});
				})
				.catch(() => {});
		});
	});

	await Promise.all(tasks);
}

async function loadRouteGeometry(routeId) {
	const normalized = String(routeId || "").toUpperCase();
	if (appState.routeGeometryCache.has(normalized)) {
		return appState.routeGeometryCache.get(normalized);
	}
	await loadRouteGeometryGeojson();
	const segments = appState.routeGeometryIndex?.get(normalized) || null;
	appState.routeGeometryCache.set(normalized, segments);
	return segments;
}

function buildRouteGeometryPath(routeId) {
	return `${ROUTE_GEOMETRY_DIR}/Route_Geometry_${routeId}_${ROUTE_GEOMETRY_DATE}.xml`;
}

function parseRouteGeometryXml(xmlText) {
	const parser = new DOMParser();
	const doc = parser.parseFromString(xmlText, 'application/xml');
	const nodes = Array.from(doc.getElementsByTagName('Route_Geometry'));
	const groups = new Map();

	nodes.forEach((node) => {
		const seq = Number(node.getAttribute('aSequence_No') || 0);
		const run = node.getAttribute('aLBSL_Run_No') || '';
		const directionNode = node.getElementsByTagName('Direction')[0];
		const direction = directionNode ? directionNode.textContent.trim() : '';
		const latNode = node.getElementsByTagName('Location_Latitude')[0];
		const lonNode = node.getElementsByTagName('Location_Longitude')[0];
		const lat = latNode ? Number.parseFloat(latNode.textContent) : NaN;
		const lon = lonNode ? Number.parseFloat(lonNode.textContent) : NaN;
		if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
			return;
		}
		const key = `${run}-${direction}`;
		if (!groups.has(key)) {
			groups.set(key, []);
		}
		groups.get(key).push({ seq, lat, lon });
	});

	const segments = [];
	groups.forEach((points) => {
		points.sort((a, b) => a.seq - b.seq);
		const latlngs = points.map((point) => [point.lat, point.lon]);
		if (latlngs.length > 1) {
			segments.push(latlngs);
		}
	});
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

function bindHoverPopup(layer) {
	layer._popupPinned = false;
	layer.on("mouseover", () => {
		if (!layer._popupPinned) {
			layer.openPopup();
		}
	});
	layer.on("mouseout", () => {
		if (!layer._popupPinned) {
			layer.closePopup();
		}
	});
	layer.on("click", () => {
		layer._popupPinned = true;
		layer.openPopup();
	});
	layer.on("popupclose", () => {
		layer._popupPinned = false;
	});
}

function bindGarageHoverPopup(layer) {
	bindHoverPopup(layer);
}

function isBusStationStop(props) {
	const stopName = props?.STOP_NAME || "";
	const roadName = props?.ROAD_NAME || "";
	return /bus station/i.test(stopName) || /bus station/i.test(roadName);
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

function normalizeBusStationBase(value) {
	const cleaned = cleanStationName(value);
	if (!cleaned) {
		return "";
	}
	const match = cleaned.match(/^(.*?bus station)\b/i);
	return match ? match[1].trim() : cleaned;
}

function formatStationName(value) {
	const cleaned = normalizeBusStationBase(value);
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
	const stopName = props?.STOP_NAME || "";
	const roadName = props?.ROAD_NAME || "";
	if (/bus station/i.test(stopName)) {
		return formatStationName(stopName);
	}
	if (/bus station/i.test(roadName)) {
		return formatStationName(roadName);
	}
	return formatStationName(stopName || roadName);
}

function buildBusStationKey(name) {
	return normalizeBusStationBase(name).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function buildBusStationClusters(geojson) {
	const stations = new Map();
	if (!geojson || !Array.isArray(geojson.features)) {
		return [];
	}
	geojson.features.forEach((feature) => {
		const props = feature?.properties || {};
		if (!isBusStationStop(props)) {
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
			station = {
				name,
				key,
				routes: new Set(),
				latSum: 0,
				lonSum: 0,
				stopCount: 0
			};
			stations.set(key, station);
		}
		station.latSum += lat;
		station.lonSum += lon;
		station.stopCount += 1;
		getStopRouteTokens(props).forEach((routeId) => station.routes.add(routeId));
	});
	return Array.from(stations.values()).map((station) => {
		station.latlng = L.latLng(station.latSum / station.stopCount, station.lonSum / station.stopCount);
		return station;
	});
}

async function loadBusStationData() {
	if (appState.busStationData) {
		return appState.busStationData;
	}
	const geojson = await loadBusStopsGeojson();
	const stations = buildBusStationClusters(geojson);
	appState.busStationData = stations;
	return stations;
}

function buildBusStationPopup(station) {
	const routes = formatRouteList(Array.from(station.routes || []));
	return `<div><div>${station.name}</div><div>${routes}</div></div>`;
}

function buildBusStationInfoHtml(station, routeSets) {
	const routes = Array.from(station.routes || []);
	const stopCount = Number.isFinite(station.stopCount) ? station.stopCount : 0;
	const subtitle = stopCount > 0 ? `${stopCount} stops clustered` : "Bus station";
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
		fillOpacity: 0.35
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

function getBusStationRouteColor(routeId, routeSets) {
	if (!appState.useRouteTypeColors || !routeSets) {
		return ROUTE_COLORS.regular;
	}
	const normalized = String(routeId || "").toUpperCase();
	if (normalized.startsWith("N")) {
		return ROUTE_COLORS.night;
	}
	if (routeSets.school?.has(normalized)) {
		return ROUTE_COLORS.school;
	}
	if (routeSets.twentyFour?.has(normalized)) {
		return ROUTE_COLORS.twentyFour;
	}
	if (isPrefixRoute(normalized)) {
		return ROUTE_COLORS.prefix;
	}
	return ROUTE_COLORS.regular;
}

function resolveRouteColor(defaultColor) {
	return appState.useRouteTypeColors ? defaultColor : ROUTE_COLORS.regular;
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
	const layerGroup = L.layerGroup();
	stations.forEach((station) => {
		if (!station.latlng) {
			return;
		}
		const marker = L.circleMarker(station.latlng, {
			radius: 7,
			weight: 2,
			color: "#0f766e",
			fillColor: "#14b8a6",
			fillOpacity: 0.85
		});
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
	clearBusStationRoutes();
	if (!appState.map || !appState.activeBusStationRoutes) {
		return;
	}
	const filteredRoutes = filterRouteSet(appState.activeBusStationRoutes, appState.routeFilterTokens);
	if (filteredRoutes.length === 0) {
		return;
	}

	const routeSets = appState.useRouteTypeColors ? await loadNetworkRouteSets() : null;
	const layerGroup = L.layerGroup().addTo(appState.map);
	appState.busStationRouteLayer = layerGroup;

	const tasks = filteredRoutes.map((routeId) => {
		return loadRouteGeometry(routeId)
			.then((segments) => {
				if (loadToken !== appState.busStationRouteLoadToken) {
					return;
				}
				if (!segments || segments.length === 0) {
					return;
				}
				segments.forEach((segment) => {
					const line = L.polyline(segment, {
						color: getBusStationRouteColor(routeId, routeSets),
						weight: 4,
						opacity: 0.85
					}).addTo(layerGroup);
					line.bindTooltip(routeId, { sticky: true });
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
	setupRouteFilterInput();
	setupBusStopFilterInput();
	setupBusStationSelect();

	document.getElementById('loadData').addEventListener('click', () => {
		// Placeholder: the real loader will fetch TfL data
		loadPlaceholderData();
	});

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
		updateSelectedInfo('Garages hidden.');
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
			updateSelectedInfo("Bus stations hidden.");
		});
	}

	const colorRoutesByType = document.getElementById("colorRoutesByType");
	if (colorRoutesByType) {
		appState.useRouteTypeColors = colorRoutesByType.checked;
		colorRoutesByType.addEventListener("change", (event) => {
			appState.useRouteTypeColors = event.target.checked;
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
			refreshSelectedInfoPanel().catch(() => {});
		});
	}

	const clearAllLayers = document.getElementById("clearAllLayers");
	if (clearAllLayers) {
		clearAllLayers.addEventListener("click", () => {
			appState.garageLoadToken += 1;
			appState.busStopLoadToken += 1;
			appState.busStationLoadToken += 1;
			appState.busStationRouteLoadToken += 1;
			appState.networkRouteLoadToken += 1;

			const toggles = ["showGarages", "showBusStops", "showBusStations"];
			toggles.forEach((id) => {
				const checkbox = document.getElementById(id);
				if (checkbox) {
					checkbox.checked = false;
				}
			});

			clearGarageMarkers();
			clearGarageRoutes();
			clearBusStopsLayer();
			clearBusStationsLayer();
			clearBusStationHighlight();
			clearBusStationRoutes();
			clearNetworkRoutes();
			appState.activeGarageRoutes = null;
			appState.activeBusStationRoutes = null;
			updateSelectedInfo("All layers cleared.");
			setBusStationSelectValue("");
			resetInfoPanel();
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

	const exactMatchCheckbox = document.getElementById("showExactRouteMatch");
	if (exactMatchCheckbox) {
		exactMatchCheckbox.addEventListener("change", () => {
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
		appState.busStopFilterDistrict = normalizePostcodeDistrict(value);
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

function loadPlaceholderData() {
	// Add a sample route polyline and few stops to the map for layout testing.
	const sampleLine = [[51.5074, -0.1278], [51.515, -0.12], [51.52, -0.1]];
	const poly = L.polyline(sampleLine, { color: 'blue' }).addTo(appState.map);

	const stops = [
		{ id: 'S1', name: 'Stop 1', lat: 51.5074, lon: -0.1278 },
		{ id: 'S2', name: 'Stop 2', lat: 51.515, lon: -0.12 }
	];

	stops.forEach(s => {
		L.circleMarker([s.lat, s.lon], { radius: 6 }).bindPopup(s.name).addTo(appState.map);
	});

	document.getElementById('selectedInfo').textContent = 'Sample route loaded';
}

async function start() {
	setLoadingModalVisible(true);
	try {
		appState.map = initMap();
		await initialiseRouteGeometryPath();
		setupUI();
		resetInfoPanel();
		appState.networkRouteLoadToken += 1;
		await renderNetworkRoutes(appState.networkRouteLoadToken);
	} finally {
		setLoadingModalVisible(false);
	}
}
document.addEventListener('DOMContentLoaded', start);
