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
const BOROUGHS_GEOJSON_PATH = "/data/boroughs.geojson";
const VEHICLE_LOOKUP_PATH = "/data/vehicles.json";
const FREQUENCY_DATA_PATH = "/data/processed/frequencies.json";
const ABOUT_METADATA_PATH = "/data/processed/last_updated.json";
const EARTH_RADIUS_KM = 6371.0088;
const ENDPOINT_KEY_PRECISION = 3;
const LOADING_MODAL_DEFAULT_TITLE = "Loading route geometry";
const LOADING_MODAL_DEFAULT_SUBTITLE = "Please wait while layers render.";
const BUS_STOP_LOADING_TITLE = "Loading bus stops";
const BUS_STOP_LOADING_SUBTITLE = "Please wait while bus stops load.";
const BUS_STOP_LOADING_MODAL_DELAY_MS = 220;
const BUS_STOP_PREWARM_DELAY_MS = 1200;
const ROUTE_SORT_NUMERIC_RE = /^\d+$/;
const ROUTE_SORT_PREFIX_RE = /^([A-Z]+)(\d+)?(.*)$/;
const ROUTE_TOKEN_SPLIT_RE = /[\s,;/]+/;
const ROUTE_TOKEN_STRIP_RE = /[^A-Za-z0-9]/g;
const ROUTE_SORT_KEY_CACHE_LIMIT = 4096;
const ROUTE_TOKEN_CACHE_LIMIT = 8192;
const routeSortKeyCache = new Map();
const routeTokenCache = new Map();
const DATE_TOKEN_FORMATTER = new Intl.DateTimeFormat("en-GB", {
	day: "2-digit",
	month: "short",
	year: "numeric",
	timeZone: "UTC"
});
const ISO_UTC_FORMATTER = new Intl.DateTimeFormat("en-GB", {
	day: "2-digit",
	month: "short",
	year: "numeric",
	hour: "2-digit",
	minute: "2-digit",
	timeZone: "UTC"
});

const ROUTE_COLOURS = {
	regular: "#ef4444",
	twentyFour: "#16b5f0",
	night: "#f59e0b",
	school: "#3b82f6",
	prefix: "#10b981"
};
const ANALYSIS_GROUP_COLOURS = [
	"#ef4444",
	"#3b82f6",
	"#10b981",
	"#f59e0b",
	"#e11d48",
	"#06b6d4",
	"#84cc16",
	"#f97316",
	"#6366f1",
	"#14b8a6",
	"#a855f7",
	"#0ea5e9"
];
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

const STOP_REGION_LABELS = window.RouteMapsterGeo?.REGION_LABELS || {
	C: "Central London",
	NE: "North East London",
	NW: "North West London",
	SW: "South West London",
	SE: "South East London"
};

const STOP_REGION_BY_BOROUGH = window.RouteMapsterGeo?.REGION_BY_BOROUGH || new Map([
	["city of london", "C"],
	["westminster", "C"],
	["camden", "C"],
	["islington", "C"],
	["kensington & chelsea", "C"],
	["lambeth", "C"],
	["southwark", "C"],
	["hackney", "NE"],
	["tower hamlets", "NE"],
	["newham", "NE"],
	["waltham forest", "NE"],
	["redbridge", "NE"],
	["havering", "NE"],
	["barking & dagenham", "NE"],
	["haringey", "NE"],
	["enfield", "NE"],
	["barnet", "NW"],
	["harrow", "NW"],
	["brent", "NW"],
	["ealing", "NW"],
	["hammersmith & fulham", "NW"],
	["hillingdon", "NW"],
	["wandsworth", "SW"],
	["hounslow", "SW"],
	["richmond upon thames", "SW"],
	["kingston upon thames", "SW"],
	["merton", "SW"],
	["sutton", "SW"],
	["croydon", "SW"],
	["lewisham", "SE"],
	["greenwich", "SE"],
	["bexley", "SE"],
	["bromley", "SE"]
]);

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
			} else {
				pane.style.pointerEvents = "auto";
			}
		}
	});
}

function setStopsPanePriority(enabled) {
	if (!appState.map) {
		return;
	}
	const stopPane = appState.map.getPane(STOP_PANE);
	if (!stopPane) {
		return;
	}
	if (enabled) {
		stopPane.style.zIndex = "445";
	} else {
		const base = MAP_PANE_ORDER.find((entry) => entry.name === STOP_PANE);
		stopPane.style.zIndex = String(base?.zIndex ?? 420);
	}
}

function refreshStopsPanePriority() {
	setStopsPanePriority(false);
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
	busStopsGeojsonPromise: null,
	boroughsGeojson: null,
	boroughIndex: null,
	stopBoroughCache: new Map(),
	busStationsGeojson: null,
	busStopLayer: null,
	busStopLoadToken: 0,
	busStopFilterDistrict: [],
	busStopFilterBoroughs: [],
	busStopFilterRouteCount: "any",
	busStopBoroughLookup: new Map(),
	advancedStopsLayer: null,
	busStopRenderer: null,
	garageRenderer: null,
	stopRoutesIndex: null,
	stopRoutesFromLines: new Map(),
	stopPointFetches: new Map(),
	routeStopFetches: new Map(),
	vehicleLookup: null,
	vehicleLookupPromise: null,
	busStationLayer: null,
	busStationRenderer: null,
	busStationLoadToken: 0,
	busStationData: null,
	activeBusStationRoutes: null,
	busStationRouteLayer: null,
	busStationRouteLoadToken: 0,
	useRouteTypeColours: false,
	selectedFeature: null,
	busStationHighlightLayer: null,
	garageSelectMap: null,
	endpointHighlightLayer: null,
	routeGeometryCache: new Map(),
	routeSpatialCache: new Map(),
	routeSpatialPromises: new Map(),
	filteredRoutesLayer: null,
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
	aboutMetadata: null,
	aboutLoadPromise: null,
	geocodeLastAt: 0,
	selectedFeatureToken: 0,
	advancedFiltersState: null,
	analysisRouteLayer: null,
	analysisRouteLoadToken: 0,
	analysisActive: false,
	analysisPrevSuppress: null,
	advancedFiltersActive: false,
	advancedFiltersPrevSuppress: null,
	omniRouteLayer: null,
	omniStopsLayer: null,
	omniRouteLoadToken: 0,
	omniStopsLoadToken: 0,
	omniSearchIndex: [],
	omniSearchReady: false,
	omniSearchLoadPromise: null,
	omniActive: false,
	omniPrevSuppress: null,
	routeSummaryRows: null,
	routeSummaryIndex: null,
	routeHoverPopup: null,
	routeHoverFrame: null,
	routeHoverLastKey: "",
	infoPanelKind: null,
	infoPanelBackStack: [],
	advancedResultsRouteReturnPending: false,
	loadingModalCount: 0,
	loadingModalTitle: "",
	loadingModalSubtitle: "",
	stopAnalysesInitPromise: null
};

const omniSearchState = {
	elements: null,
	isOpen: false,
	items: [],
	filteredItems: [],
	selectedIndex: 0,
	lastActiveElement: null,
	lastQuery: ""
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
	return getStopName(props) || props?.PLACE_ID || props?.STOP_CODE || props?.NAPTAN_ID || props?.NAPTAN_ATCO || "Bus stop";
}

function getStopRoadName(props) {
	return props?.ROAD_NAME || "";
}

function getStopCode(props) {
	return props?.PLACE_ID || props?.STOP_CODE || props?.NAPTAN_ID || props?.NAPTAN_ATCO || "";
}

function getStopLetter(props) {
	const value = props?.STOP_LETTER || props?.INDICATOR || props?.indicator || "";
	const cleaned = String(value || "").trim().toUpperCase().replace(/\./g, " ");
	if (!cleaned) {
		return "";
	}
	const withoutPrefix = cleaned.startsWith("STOP ") ? cleaned.slice(5).trim() : cleaned;
	const token = withoutPrefix.split(/\s+/)[0] || "";
	if (!token) {
		return "";
	}
	if (token.startsWith("->")) {
		return "";
	}
	if (["OPP", "ADJ", "NR", "O/S", "STAND"].includes(token)) {
		return "";
	}
	if (token.endsWith("-BOUND") || ["NORTHBOUND", "SOUTHBOUND", "EASTBOUND", "WESTBOUND"].includes(token)) {
		return "";
	}
	return /^[A-Z]{1,2}\d?$/.test(token) ? token : "";
}

function normaliseBoroughName(value) {
	if (window.RouteMapsterUtils?.normaliseBoroughToken) {
		return window.RouteMapsterUtils.normaliseBoroughToken(value);
	}
	return String(value || "")
		.replace(/&/g, " and ")
		.trim()
		.toLowerCase()
		.replace(/\s+/g, " ");
}

function getStopRegionTokenFromBorough(borough) {
	if (!borough) {
		return "";
	}
	if (window.RouteMapsterGeo?.getRegionTokenFromBorough) {
		return window.RouteMapsterGeo.getRegionTokenFromBorough(borough);
	}
	return STOP_REGION_BY_BOROUGH.get(normaliseBoroughName(borough)) || "";
}

function getStopRegionLabel(token) {
	if (window.RouteMapsterGeo?.getRegionLabel) {
		return window.RouteMapsterGeo.getRegionLabel(token);
	}
	return STOP_REGION_LABELS[token] || "";
}

function getStopRegionDisplay(props) {
	const borough = props?.borough || props?.BOROUGH || props?.Borough || props?.["Borough"] || "";
	const token = getStopRegionTokenFromBorough(borough)
		|| String(props?.region || "").trim().toUpperCase();
	if (!token || token === "UNKNOWN") {
		return "";
	}
	const label = getStopRegionLabel(token);
	return label ? `${label} (${token})` : token;
}

function escapeHtml(value) {
	if (window.RouteMapsterUtils?.escapeHtml) {
		return window.RouteMapsterUtils.escapeHtml(value);
	}
	return String(value || "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

function isCompactMobileLayout() {
	if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
		return false;
	}
	return window.matchMedia("(max-width: 900px)").matches;
}

function compactOptionText(label, maxChars = 34) {
	const raw = String(label ?? "").trim();
	if (!raw || raw.length <= maxChars) {
		return raw;
	}
	if (maxChars <= 6) {
		return `${raw.slice(0, maxChars)}...`;
	}
	return `${raw.slice(0, maxChars - 3).trimEnd()}...`;
}

function applyMobileSelectOptionCompaction(maxChars = 34) {
	if (typeof document === "undefined") {
		return;
	}
	const compact = isCompactMobileLayout();
	const selects = Array.from(document.querySelectorAll("select.select-field:not([multiple])"));
	selects.forEach((select) => {
		Array.from(select.options).forEach((option) => {
			const baseLabel = option.dataset.fullLabel || option.textContent || "";
			if (!option.dataset.fullLabel) {
				option.dataset.fullLabel = baseLabel;
			}
			if (compact) {
				const compactLabel = compactOptionText(baseLabel, maxChars);
				option.textContent = compactLabel;
				if (compactLabel !== baseLabel) {
					option.title = baseLabel;
				} else {
					option.removeAttribute("title");
				}
			} else {
				option.textContent = baseLabel;
				option.removeAttribute("title");
			}
		});
	});
}

function downloadCsv(filename, columns, rows) {
	if (window.RouteMapsterUtils?.downloadCsv) {
		window.RouteMapsterUtils.downloadCsv(filename, columns, rows);
		return;
	}
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
}

function setInfoPanelVisible(visible) {
	const appRoot = document.getElementById("app");
	if (!appRoot) {
		return;
	}
	appRoot.classList.toggle("has-details", visible);
}

function setInfoPanel({ title, titleHtml, subtitle, bodyHtml }) {
	const titleEl = document.getElementById("infoTitle");
	const subtitleEl = document.getElementById("infoSubtitle");
	const bodyEl = document.getElementById("infoBody");
	if (titleEl) {
		if (titleHtml) {
			titleEl.innerHTML = titleHtml;
		} else {
			titleEl.textContent = title || "Details";
		}
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
		subtitle: "Click a bus stop, station, or garage to view details.",
		bodyHtml: `
			<div class="info-section">
				<div class="info-label">Status</div>
				<div class="info-empty">No feature selected yet.</div>
			</div>
		`
	});
	setInfoPanelVisible(false);
	appState.infoPanelKind = null;
	appState.infoPanelBackStack = [];
	appState.advancedResultsRouteReturnPending = false;
	clearSelectedFeature();
}

function setLoadingModalVisible(visible) {
	const modal = document.getElementById("loadingModal");
	if (!modal) {
		return;
	}
	const titleEl = document.getElementById("loadingModalTitle");
	const subtitleEl = document.getElementById("loadingModalSubtitle");
	if (!Number.isFinite(appState.loadingModalCount)) {
		appState.loadingModalCount = 0;
	}
	if (visible) {
		appState.loadingModalCount += 1;
	} else {
		appState.loadingModalCount = Math.max(0, appState.loadingModalCount - 1);
	}
	const isVisible = appState.loadingModalCount > 0;
	modal.classList.toggle("is-visible", isVisible);
	modal.setAttribute("aria-hidden", isVisible ? "false" : "true");
	if (visible && titleEl && subtitleEl) {
		titleEl.textContent = appState.loadingModalTitle || LOADING_MODAL_DEFAULT_TITLE;
		subtitleEl.textContent = appState.loadingModalSubtitle || LOADING_MODAL_DEFAULT_SUBTITLE;
	}
	if (!isVisible && titleEl && subtitleEl) {
		titleEl.textContent = LOADING_MODAL_DEFAULT_TITLE;
		subtitleEl.textContent = LOADING_MODAL_DEFAULT_SUBTITLE;
		appState.loadingModalTitle = "";
		appState.loadingModalSubtitle = "";
	}
}

function setLoadingModalMessage(title, subtitle) {
	appState.loadingModalTitle = title || LOADING_MODAL_DEFAULT_TITLE;
	appState.loadingModalSubtitle = subtitle || LOADING_MODAL_DEFAULT_SUBTITLE;
	const titleEl = document.getElementById("loadingModalTitle");
	const subtitleEl = document.getElementById("loadingModalSubtitle");
	if (titleEl) {
		titleEl.textContent = appState.loadingModalTitle;
	}
	if (subtitleEl) {
		subtitleEl.textContent = appState.loadingModalSubtitle;
	}
}

function waitForNextUiPaint() {
	return new Promise((resolve) => {
		requestAnimationFrame(() => {
			requestAnimationFrame(() => resolve());
		});
	});
}

function setAboutModalVisible(visible) {
	const modal = document.getElementById("aboutModal");
	if (!modal) {
		return;
	}
	modal.classList.toggle("is-visible", visible);
	modal.setAttribute("aria-hidden", visible ? "false" : "true");
}

function setKeyboardShortcutsModalVisible(visible) {
	const modal = document.getElementById("keyboardShortcutsModal");
	if (!modal) {
		return;
	}
	modal.classList.toggle("is-visible", visible);
	modal.setAttribute("aria-hidden", visible ? "false" : "true");
}

function openKeyboardShortcutsModal() {
	setKeyboardShortcutsModalVisible(true);
}

function closeKeyboardShortcutsModal() {
	setKeyboardShortcutsModalVisible(false);
}

function setupKeyboardShortcutsModal() {
	const modal = document.getElementById("keyboardShortcutsModal");
	const closeButton = document.getElementById("closeKeyboardShortcuts");
	const openButton = document.getElementById("openKeyboardShortcutsFromAbout");
	if (openButton) {
		openButton.addEventListener("click", () => {
			closeAboutModal(false);
			openKeyboardShortcutsModal();
		});
	}
	if (closeButton) {
		closeButton.addEventListener("click", () => {
			closeKeyboardShortcutsModal();
		});
	}
	if (modal) {
		modal.addEventListener("click", (event) => {
			if (event.target === modal) {
				closeKeyboardShortcutsModal();
			}
		});
	}
	document.addEventListener("keydown", (event) => {
		if (event.key !== "Escape") {
			return;
		}
		if (modal && modal.classList.contains("is-visible")) {
			closeKeyboardShortcutsModal();
		}
	});
}

async function loadRouteSummaryRows() {
	if (Array.isArray(appState.routeSummaryRows)) {
		return appState.routeSummaryRows;
	}
	const engine = window.RouteMapsterQueryEngine;
	if (!engine || typeof engine.loadRouteSummary !== "function") {
		appState.routeSummaryRows = [];
		return appState.routeSummaryRows;
	}
	try {
		appState.routeSummaryRows = await engine.loadRouteSummary();
	} catch (error) {
		appState.routeSummaryRows = [];
	}
	return appState.routeSummaryRows;
}

async function ensureRouteSummaryIndex() {
	if (appState.routeSummaryIndex instanceof Map) {
		return appState.routeSummaryIndex;
	}
	const rows = await loadRouteSummaryRows();
	const index = new Map();
	rows.forEach((row) => {
		if (row?.route_id_norm) {
			index.set(row.route_id_norm, row);
		}
	});
	appState.routeSummaryIndex = index;
	return index;
}

function formatRouteTypeLabel(routeType) {
	const token = String(routeType || "").trim().toLowerCase();
	if (!token) {
		return "";
	}
	if (token === "twentyfour" || token === "24hr" || token === "24" || token === "24-hour") {
		return "24-hour";
	}
	if (token === "night") {
		return "Night";
	}
	if (token === "school") {
		return "School";
	}
	if (token === "prefix") {
		return "Prefix";
	}
	if (token === "regular") {
		return "Regular";
	}
	return token.charAt(0).toUpperCase() + token.slice(1);
}

function formatBphValue(value) {
	if (!Number.isFinite(value)) {
		return "";
	}
	const rounded = Math.round(value * 10) / 10;
	return Number.isInteger(rounded) ? String(Math.trunc(rounded)) : rounded.toFixed(1);
}

function parseCentralityValue(value) {
	const num = Number(value);
	return Number.isFinite(num) ? num : null;
}

function formatCentralityValue(value) {
	if (!Number.isFinite(value)) {
		return "";
	}
	const abs = Math.abs(value);
	if (abs > 0 && abs < 0.001) {
		return value.toExponential(2);
	}
	return value.toFixed(4);
}

function buildCentralitySummaryFromProps(props) {
	const betweenness = parseCentralityValue(props?.betweenness_global ?? props?.betweenness);
	const closeness = parseCentralityValue(props?.closeness_topo);
	const eigenvector = parseCentralityValue(props?.eigenvector);
	const parts = [];
	if (Number.isFinite(betweenness)) {
		parts.push(`Betw ${formatCentralityValue(betweenness)}`);
	}
	if (Number.isFinite(closeness)) {
		parts.push(`Close ${formatCentralityValue(closeness)}`);
	}
	if (Number.isFinite(eigenvector)) {
		parts.push(`Eig ${formatCentralityValue(eigenvector)}`);
	}
	return parts.length > 0 ? parts.join(" | ") : "";
}

function buildCentralityDetailLines(props) {
	const entries = [
		["Betweenness", parseCentralityValue(props?.betweenness_global ?? props?.betweenness)],
		["Closeness (topo)", parseCentralityValue(props?.closeness_topo)],
		["Eigenvector", parseCentralityValue(props?.eigenvector)],
		["Degree", parseCentralityValue(props?.degree)],
		["Degree (normalized)", parseCentralityValue(props?.degree_norm)],
		["Route degree", parseCentralityValue(props?.route_degree)]
	];
	return entries
		.filter(([, value]) => Number.isFinite(value))
		.map(([label, value]) => `<div>${escapeHtml(label)}: ${escapeHtml(formatCentralityValue(value))}</div>`);
}

function isSchoolRoute(routeType) {
	return String(routeType || "").trim().toLowerCase() === "school";
}

function buildRouteFrequencySummary(freqs, routeId, routeType) {
	if (isSchoolRoute(routeType)) {
		return "";
	}
	if (!freqs || typeof freqs !== "object") {
		return "";
	}
	const parts = [];
	const peakAm = formatBphValue(freqs.peak_am);
	const peakPm = formatBphValue(freqs.peak_pm);
	const offpeak = formatBphValue(freqs.offpeak);
	const weekend = formatBphValue(freqs.weekend);
	const overnight = formatBphValue(freqs.overnight);
	if (peakAm) {
		parts.push(`AM ${peakAm}`);
	}
	if (peakPm) {
		parts.push(`PM ${peakPm}`);
	}
	if (offpeak) {
		parts.push(`Off ${offpeak}`);
	}
	if (weekend) {
		parts.push(`Weekend ${weekend}`);
	}
	if (overnight) {
		parts.push(`Night ${overnight}`);
	}
	if (parts.length === 0) {
		return "";
	}
	return `${parts.join(" · ")} bph`;
}

function normalisePostcodeValue(value) {
	const cleaned = String(value || "").trim().toUpperCase();
	return cleaned;
}

function buildOmniSearchText(parts) {
	return parts
		.filter(Boolean)
		.map((part) => String(part))
		.join(" ")
		.toLowerCase();
}

function getOmniTypeLabel(type) {
	if (type === "route") {
		return "Route";
	}
	if (type === "station") {
		return "Bus station";
	}
	if (type === "stop") {
		return "Bus stop";
	}
	if (type === "garage") {
		return "Garage";
	}
	if (type === "operator") {
		return "Operator";
	}
	if (type === "postcode") {
		return "Postcode district";
	}
	if (type === "advanced_filters") {
		return "Advanced filters";
	}
	return "Result";
}

function getRouteMetaFromRow(row) {
	if (!row || typeof row !== "object") {
		return {};
	}
	const operator = Array.isArray(row.operator_names_arr) && row.operator_names_arr.length > 0
		? row.operator_names_arr[0]
		: row.operator_names || "";
	const garageCodes = Array.isArray(row.garage_codes_arr) ? row.garage_codes_arr.filter(Boolean) : [];
	const garageNames = Array.isArray(row.garage_names_arr) ? row.garage_names_arr.filter(Boolean) : [];
	const garageList = garageCodes.length > 0
		? garageCodes
		: garageNames.length > 0
			? garageNames
			: [row.garage_codes || row.garage_names || ""].filter(Boolean);
	const garage = garageList.length > 0 ? garageList.join(", ") : "";
	const routeType = row.route_type || "";
	const vehicleType = row.vehicle_type || "";
	const lengthMiles = Number.isFinite(row.length_miles) ? row.length_miles : null;
	const freqs = {
		peak_am: Number.isFinite(row.frequency_peak_am) ? row.frequency_peak_am : null,
		peak_pm: Number.isFinite(row.frequency_peak_pm) ? row.frequency_peak_pm : null,
		offpeak: Number.isFinite(row.frequency_offpeak) ? row.frequency_offpeak : null,
		weekend: Number.isFinite(row.frequency_weekend) ? row.frequency_weekend : null,
		overnight: Number.isFinite(row.frequency_overnight) ? row.frequency_overnight : null
	};
	return { operator, garage, routeType, vehicleType, lengthMiles, freqs };
}

function buildRouteGarageLabelsFromRow(row) {
	const codes = Array.isArray(row?.garage_codes_arr) ? row.garage_codes_arr.filter(Boolean) : [];
	const names = Array.isArray(row?.garage_names_arr) ? row.garage_names_arr.filter(Boolean) : [];
	const max = Math.max(codes.length, names.length);
	const labels = [];
	const seen = new Set();
	for (let index = 0; index < max; index += 1) {
		const code = String(codes[index] || "").trim();
		const name = String(names[index] || "").trim();
		const label = name && code
			? `${name} (${code})`
			: (name || code);
		if (label && !seen.has(label)) {
			seen.add(label);
			labels.push(label);
		}
	}
	if (labels.length > 0) {
		return labels;
	}
	const fallback = [row?.garage_codes, row?.garage_names]
		.map((value) => String(value || "").trim())
		.filter(Boolean);
	return Array.from(new Set(fallback));
}

function buildRouteDetailsBodyHtml(routeId, row, routeSets, options = {}) {
	const meta = getRouteMetaFromRow(row);
	const operators = Array.isArray(row?.operator_names_arr)
		? Array.from(new Set(row.operator_names_arr.map((value) => String(value || "").trim()).filter(Boolean)))
		: (meta.operator ? [meta.operator] : []);
	const garages = buildRouteGarageLabelsFromRow(row);
	const roadNames = Array.isArray(options.roadNames)
		? Array.from(new Set(options.roadNames.map((value) => String(value || "").trim()).filter(Boolean)))
		: [];
	const detailLines = [
		meta.routeType ? `Type: ${escapeHtml(formatRouteTypeLabel(meta.routeType))}` : "",
		operators.length > 0 ? `Operator${operators.length > 1 ? "s" : ""}: ${escapeHtml(operators.join(" | "))}` : "",
		garages.length > 0 ? `Garage${garages.length > 1 ? "s" : ""}: ${escapeHtml(garages.join(" | "))}` : "",
		meta.vehicleType ? `Vehicle: ${escapeHtml(meta.vehicleType)}` : "",
		Number.isFinite(meta.lengthMiles) ? `Length: ${escapeHtml(meta.lengthMiles.toFixed(2))} mi` : "",
		typeof row?.has_overnight === "boolean" ? `Overnight: ${row.has_overnight ? "Yes" : "No"}` : ""
	].filter(Boolean);

	const uniqueStops = Number.isFinite(row?.unique_stops) ? Math.round(row.unique_stops) : null;
	const totalStops = Number.isFinite(row?.total_stops) ? Math.round(row.total_stops) : null;
	const uniquePct = Number.isFinite(row?.unique_stops_pct) ? Math.round(row.unique_stops_pct * 100) : null;
	const metricLines = [
		Number.isFinite(uniqueStops) ? `Route-only stops: ${escapeHtml(uniqueStops)}` : "",
		Number.isFinite(totalStops) ? `Total stops: ${escapeHtml(totalStops)}` : "",
		Number.isFinite(uniquePct) ? `Route-only stop share: ${escapeHtml(uniquePct)}%` : ""
	].filter(Boolean);

	const frequencyLines = [
		["Peak AM", row?.frequency_peak_am],
		["Peak PM", row?.frequency_peak_pm],
		["Offpeak", row?.frequency_offpeak],
		["Weekend", row?.frequency_weekend],
		["Overnight", row?.frequency_overnight]
	]
		.map(([label, value]) => {
			const formatted = formatBphValue(value);
			return formatted ? `${label}: ${formatted}` : "";
		})
		.filter(Boolean);

	const roadSection = options.includeRoadNames
		? `
			<div class="info-section">
				<div class="info-label">${roadNames.length > 1 ? "Road names" : "Road name"}</div>
				${roadNames.length > 0
					? roadNames.map((name) => `<div>${escapeHtml(name)}</div>`).join("")
					: '<div class="info-empty">Road name unavailable in route geometry data.</div>'}
			</div>
		`
		: "";

	return `
		<div class="info-section">
			<div class="info-label">Route</div>
			${renderRoutePills([routeId], routeSets)}
		</div>
		${roadSection}
		<div class="info-section">
			<div class="info-label">Details</div>
			${detailLines.length > 0
				? detailLines.map((line) => `<div>${line}</div>`).join("")
				: '<div class="info-empty">No route summary details found.</div>'}
		</div>
		${frequencyLines.length > 0 && !isSchoolRoute(meta.routeType)
			? `
				<div class="info-section">
					<div class="info-label">Frequency (BPH)</div>
					${frequencyLines.map((line) => `<div>${escapeHtml(line)}</div>`).join("")}
				</div>
			`
			: ""}
		${metricLines.length > 0
			? `
				<div class="info-section">
					<div class="info-label">Metrics</div>
					${metricLines.map((line) => `<div>${line}</div>`).join("")}
				</div>
			`
			: ""}
	`;
}

async function setRouteInfoPanel(routeId, options = {}) {
	const normalised = String(routeId || "").trim().toUpperCase();
	if (!normalised || isExcludedRoute(normalised)) {
		return;
	}
	const [summaryIndex, routeSets] = await Promise.all([
		ensureRouteSummaryIndex(),
		appState.useRouteTypeColours ? loadNetworkRouteSets().catch(() => null) : Promise.resolve(null)
	]);
	const row = summaryIndex?.get(normalised) || null;
	const title = `Route ${normalised}`;
	const subtitleParts = [];
	if (row) {
		const meta = getRouteMetaFromRow(row);
		const typeLabel = formatRouteTypeLabel(meta.routeType);
		if (typeLabel) {
			subtitleParts.push(typeLabel);
		}
		if (meta.operator) {
			subtitleParts.push(meta.operator);
		}
	}
	setInfoPanel({
		title,
		subtitle: subtitleParts.length > 0 ? subtitleParts.join(" | ") : "Route",
		bodyHtml: buildRouteDetailsBodyHtml(normalised, row, routeSets, options)
	});
	appState.infoPanelKind = "route";
}

async function showRouteDetailsAndFocus(routeId, options = {}) {
	const normalised = String(routeId || "").trim().toUpperCase();
	if (!normalised || isExcludedRoute(normalised)) {
		return;
	}
	if (appState.infoPanelKind !== "route") {
		pushInfoPanelBackSnapshot();
	}
	clearSelectedFeature();
	await setRouteInfoPanel(normalised, options);
	if (options.focusMap !== false) {
		await focusRoute(normalised);
	}
}

function collectGarageGroupRoutes(group) {
	if (!group || !Array.isArray(group.features)) {
		return [];
	}
	const routeSets = buildGarageRouteSets(group.features);
	const combined = new Set();
	[routeSets.regular, routeSets.night, routeSets.school].forEach((set) => {
		if (!set) {
			return;
		}
		set.forEach((route) => combined.add(route));
	});
	return Array.from(combined);
}

function buildPostcodeAggregates(geojson) {
	const districtMap = new Map();
	const features = Array.isArray(geojson?.features) ? geojson.features : [];
	features.forEach((feature) => {
		const props = feature?.properties || {};
		const postcode = normalisePostcodeValue(props?.POSTCODE);
		if (!postcode) {
			return;
		}
		const district = normalisePostcodeDistrict(postcode);
		if (!district) {
			return;
		}
		const coords = feature?.geometry?.coordinates;
		const lon = Array.isArray(coords) ? Number(coords[0]) : null;
		const lat = Array.isArray(coords) ? Number(coords[1]) : null;
		const routes = extractRouteTokens(props?.ROUTES).filter((routeId) => !isExcludedRoute(routeId));

		const ensureEntry = (map, key) => {
			if (!map.has(key)) {
				map.set(key, {
					key,
					district,
					stopCount: 0,
					coordCount: 0,
					latSum: 0,
					lonSum: 0,
					routes: new Set(),
					postcodes: new Set()
				});
			}
			return map.get(key);
		};

		const districtEntry = ensureEntry(districtMap, district);
		districtEntry.stopCount += 1;
		districtEntry.postcodes.add(postcode);
		if (Number.isFinite(lat) && Number.isFinite(lon)) {
			districtEntry.coordCount += 1;
			districtEntry.latSum += lat;
			districtEntry.lonSum += lon;
		}
		routes.forEach((routeId) => districtEntry.routes.add(routeId));
	});
	return { districtMap };
}

function buildGarageGroupDetails(group) {
	if (!group || !Array.isArray(group.features)) {
		return { label: "Garage", subtitle: "Garage", searchTokens: [] };
	}
	const displayFeatures = getUniqueGarageDisplayFeatures(group.features);
	const names = new Set();
	const codes = new Set();
	const operators = new Set();
	displayFeatures.forEach((feature) => {
		const props = feature?.properties || {};
		const name = String(props?.["Garage name"] || "").trim();
		const code = getGarageCode(props);
		const operator = getGarageGroupName(props);
		if (name) {
			names.add(name);
		}
		if (code) {
			codes.add(code);
		}
		if (operator) {
			operators.add(operator);
		}
	});
	const nameList = Array.from(names);
	const codeList = Array.from(codes);
	const operatorList = Array.from(operators);
	const primaryName = nameList[0] || codeList[0] || "Garage";
	const codeLabel = codeList.length > 0
		? codeList.length > 3
			? `${codeList.slice(0, 3).join(", ")} +${codeList.length - 3}`
			: codeList.join(", ")
		: "";
	const label = codeLabel ? `${primaryName} (${codeLabel})` : primaryName;
	const subtitleParts = [];
	if (operatorList.length > 0) {
		subtitleParts.push(operatorList.join(" · "));
	}
	if (nameList.length > 1) {
		subtitleParts.push(`${nameList.length} garages`);
	}
	const subtitle = subtitleParts.length > 0 ? subtitleParts.join(" · ") : "Garage";
	const searchTokens = ["garage", ...nameList, ...codeList, ...operatorList];
	return { label, subtitle, searchTokens, operators: operatorList, codes: codeList };
}

async function buildOmniSearchIndex() {
	const [routeIds, stations, garagesGeojson, summaryRows, stopsGeojson] = await Promise.all([
		loadRouteGeometryRouteIds(),
		loadBusStationData().catch(() => []),
		loadGaragesGeojson().catch(() => null),
		loadRouteSummaryRows(),
		loadBusStopsGeojson().catch(() => null)
	]);

	const summaryIndex = await ensureRouteSummaryIndex();
	const routeSetsForPills = appState.useRouteTypeColours ? await loadNetworkRouteSets() : null;
	const items = [];

	if (routeIds && routeIds.size > 0) {
		Array.from(routeIds).forEach((routeId) => {
			const row = summaryIndex.get(routeId) || null;
			const meta = getRouteMetaFromRow(row);
			const typeLabel = formatRouteTypeLabel(meta.routeType);
			const subtitleParts = [typeLabel, meta.operator, meta.garage, meta.vehicleType].filter(Boolean);
			const subtitle = subtitleParts.length > 0 ? subtitleParts.join(" · ") : "Bus route";
			const freqText = buildRouteFrequencySummary(meta.freqs, routeId, meta.routeType);
			const title = `Route ${routeId}`;
			const searchText = buildOmniSearchText([
				"route",
				routeId,
				meta.operator,
				meta.garage,
				meta.routeType,
				meta.vehicleType
			]);
			items.push({
				id: `route:${routeId}`,
				type: "route",
				typeLabel: getOmniTypeLabel("route"),
				title,
				subtitle,
				freqText,
				searchText,
				titleLower: title.toLowerCase(),
				routeId,
				meta
			});
		});
	}

	if (Array.isArray(stations)) {
		stations.forEach((station) => {
			const name = station?.name || "Bus station";
			const routeCount = Number.isFinite(station?.routes?.size)
				? station.routes.size
				: Number.isFinite(station?.routeCount)
					? station.routeCount
					: 0;
			const subtitle = routeCount > 0 ? `${routeCount} routes` : "Bus station";
			const routes = Array.from(station?.routes || []);
			const routePills = routes.length > 0
				? renderRoutePills(routes, routeSetsForPills)
				: "";
			const searchText = buildOmniSearchText(["station", name, station?.key]);
			items.push({
				id: `station:${station?.key || name}`,
				type: "station",
				typeLabel: getOmniTypeLabel("station"),
				title: name,
				subtitle,
				metaHtml: routePills,
				searchText,
				titleLower: String(name).toLowerCase(),
				station
			});
		});
	}

	if (garagesGeojson && Array.isArray(garagesGeojson.features)) {
		const groups = groupGaragesByLocation(garagesGeojson)
			.filter((group) => group.features.some((feature) => garageHasRoutes(feature)));
		groups.forEach((group) => {
			const details = buildGarageGroupDetails(group);
			const routes = collectGarageGroupRoutes(group);
			const routePills = routes.length > 0
				? renderRoutePills(routes, routeSetsForPills)
				: "";
			const searchText = buildOmniSearchText(details.searchTokens);
			items.push({
				id: `garage:${details.label}`,
				type: "garage",
				typeLabel: getOmniTypeLabel("garage"),
				title: details.label,
				subtitle: details.subtitle,
				metaHtml: routePills,
				searchText,
				titleLower: details.label.toLowerCase(),
				garageGroup: group,
				garageDetails: details
			});
		});
	}

	if (stopsGeojson && Array.isArray(stopsGeojson.features)) {
		stopsGeojson.features.forEach((feature) => {
			const props = feature?.properties || {};
			const name = getStopDisplayName(props);
			const stopCode = getStopCode(props);
			const road = getStopRoadName(props);
			const postcode = normalisePostcodeValue(props?.POSTCODE || props?.postcode);
			const borough = props?.borough || props?.BOROUGH || props?.Borough || props?.["Borough"] || "";
			const coords = feature?.geometry?.coordinates;
			const lon = Array.isArray(coords) ? Number(coords[0]) : null;
			const lat = Array.isArray(coords) ? Number(coords[1]) : null;
			const routes = getStopRouteTokens(props);
			if (routes.length === 0) {
				return;
			}
			const routePills = routes.length > 0
				? renderRoutePills(routes, routeSetsForPills)
				: "";
			const subtitleParts = ["Bus stop"];
			if (road) {
				subtitleParts.push(road);
			}
			if (stopCode) {
				subtitleParts.push(stopCode);
			}
			if (postcode) {
				subtitleParts.push(postcode);
			}
			const subtitle = subtitleParts.join(" · ");
			const searchText = buildOmniSearchText([
				"stop",
				"bus stop",
				name,
				road,
				stopCode,
				postcode,
				borough,
				...routes
			]);
			items.push({
				id: `stop:${stopCode || name}`,
				type: "stop",
				typeLabel: getOmniTypeLabel("stop"),
				title: name,
				subtitle,
				metaHtml: routePills,
				searchText,
				titleLower: String(name).toLowerCase(),
				stopProps: props,
				stopLat: lat,
				stopLon: lon
			});
		});

		const { districtMap } = buildPostcodeAggregates(stopsGeojson);
		const makePostcodeItem = (entry) => {
			if (!entry || entry.stopCount <= 0) {
				return null;
			}
			const coordCount = entry.coordCount || 0;
			const lat = coordCount > 0 ? entry.latSum / coordCount : null;
			const lon = coordCount > 0 ? entry.lonSum / coordCount : null;
			const routes = Array.from(entry.routes || []);
			const routePills = routes.length > 0
				? renderRoutePills(routes, routeSetsForPills)
				: "";
			const subtitleParts = [
				"Postcode district",
				`${entry.stopCount} stops`
			].filter(Boolean);
			const subtitle = subtitleParts.join(" · ");
			const searchText = buildOmniSearchText([
				"postcode district",
				entry.key,
				entry.key.replace(/\s+/g, "")
			]);
			return {
				id: `postcode:${entry.key}`,
				type: "postcode",
				typeLabel: "Postcode district",
				title: `Postcode district ${entry.key}`,
				subtitle,
				metaHtml: routePills,
				searchText,
				titleLower: String(`Postcode district ${entry.key}`).toLowerCase(),
				postcodeData: {
					key: entry.key,
					district: entry.key,
					isDistrict: true,
					stopCount: entry.stopCount,
					routes,
					lat,
					lon
				}
			};
		};

		districtMap.forEach((entry) => {
			const item = makePostcodeItem(entry);
			if (item) {
				items.push(item);
			}
		});
	}

	const operatorMap = new Map();
	if (Array.isArray(summaryRows)) {
		summaryRows.forEach((row) => {
			const routeId = row?.route_id_norm;
			if (!routeId) {
				return;
			}
			const operators = Array.isArray(row.operator_names_arr) ? row.operator_names_arr : [];
			operators.forEach((operator) => {
				const cleaned = String(operator || "").trim();
				if (!cleaned) {
					return;
				}
				const key = cleaned.toLowerCase();
				if (!operatorMap.has(key)) {
					operatorMap.set(key, { name: cleaned, routes: new Set() });
				}
				operatorMap.get(key).routes.add(routeId);
			});
		});
	}

	operatorMap.forEach((entry, key) => {
		const routes = Array.from(entry.routes);
		const subtitle = routes.length > 0 ? `${routes.length} routes` : "No routes listed";
		const searchText = buildOmniSearchText(["operator", entry.name, key]);
		items.push({
			id: `operator:${entry.name}`,
			type: "operator",
			typeLabel: getOmniTypeLabel("operator"),
			title: entry.name,
			subtitle,
			searchText,
			titleLower: entry.name.toLowerCase(),
			operatorName: entry.name,
			operatorRoutes: routes
		});
	});

	return items;
}

async function ensureOmniSearchIndex() {
	if (appState.omniSearchReady && Array.isArray(appState.omniSearchIndex)) {
		return appState.omniSearchIndex;
	}
	if (appState.omniSearchLoadPromise) {
		return appState.omniSearchLoadPromise;
	}
	appState.omniSearchLoadPromise = buildOmniSearchIndex()
		.then((items) => {
			appState.omniSearchIndex = items;
			appState.omniSearchReady = true;
			return items;
		})
		.catch(() => {
			appState.omniSearchIndex = [];
			appState.omniSearchReady = false;
			return appState.omniSearchIndex;
		})
		.finally(() => {
			appState.omniSearchLoadPromise = null;
		});
	return appState.omniSearchLoadPromise;
}

function setOmniSearchVisible(visible) {
	const modal = omniSearchState.elements?.modal;
	if (!modal) {
		return;
	}
	omniSearchState.isOpen = visible;
	modal.classList.toggle("is-visible", visible);
	modal.setAttribute("aria-hidden", visible ? "false" : "true");
	document.body.classList.toggle("omni-open", visible);
}

function setOmniStatus(text) {
	const status = omniSearchState.elements?.status;
	if (!status) {
		return;
	}
	status.textContent = text || "";
}

function renderOmniResults(items, totalCount) {
	const results = omniSearchState.elements?.results;
	if (!results) {
		return;
	}
	if (!items || items.length === 0) {
		results.innerHTML = "";
		return;
	}
	const selectedIndex = omniSearchState.selectedIndex;
	results.innerHTML = items.map((item, index) => {
		const isSelected = index === selectedIndex;
		const subtitle = item.subtitle || "";
		const freqText = item.freqText || "";
		const metaHtml = item.metaHtml || "";
		const subtitleHtml = subtitle ? `<div class="omni-result-subtitle">${escapeHtml(subtitle)}</div>` : "";
		const freqHtml = freqText ? `<div class="omni-result-freq">${escapeHtml(freqText)}</div>` : "";
		const metaBlock = metaHtml ? `<div class="omni-result-meta">${metaHtml}</div>` : "";
		return `
			<button type="button" class="omni-result${isSelected ? " is-selected" : ""}" data-index="${index}"
				role="option" aria-selected="${isSelected ? "true" : "false"}">
				<div class="omni-result-type">${escapeHtml(item.typeLabel || getOmniTypeLabel(item.type))}</div>
				<div class="omni-result-text">
					<div class="omni-result-title">${escapeHtml(item.title || "")}</div>
					${subtitleHtml}
					${freqHtml}
					${metaBlock}
				</div>
			</button>
		`;
	}).join("");

	if (Number.isFinite(totalCount)) {
		setOmniStatus(totalCount > items.length
			? `Showing ${items.length} of ${totalCount} results.`
			: `${totalCount} results.`);
	}

	const selected = results.querySelector(".omni-result.is-selected");
	if (selected) {
		selected.scrollIntoView({ block: "nearest" });
	}
}

function parseOmniQuery(query) {
	const trimmed = String(query || "").trim();
	if (!trimmed) {
		return { type: null, tokens: [], matchMode: "all" };
	}
	const tokenizeOmniTerms = (value) => tokenizeAdvancedFilterQuery(value)
		.flatMap((token) => splitAdvancedFilterValues(token))
		.map((token) => token.toLowerCase())
		.filter(Boolean);
	const resolveScopedType = (rawKey) => {
		const key = String(rawKey || "").trim().toLowerCase();
		if (!key) {
			return null;
		}
		if (key === "district") {
			return "postcode";
		}
		if (["route", "station", "stop", "garage", "operator", "postcode"].includes(key)) {
			return key;
		}
		const keyInfo = normalizeAdvancedFilterKey(key);
		if (!keyInfo) {
			return null;
		}
		if (keyInfo.key === "route_ids") {
			return "route";
		}
		if (keyInfo.key === "operators") {
			return "operator";
		}
		if (keyInfo.key === "garages") {
			return "garage";
		}
		return null;
	};
	const match = trimmed.match(/^([^:\s]+)\s*:\s*(.*)$/i);
	if (match) {
		const type = resolveScopedType(match[1]);
		if (type) {
			const rest = match[2] || "";
			const tokens = tokenizeOmniTerms(rest);
			const isMultiRouteScope = type === "route" && tokens.length > 1;
			return { type, tokens, matchMode: isMultiRouteScope ? "any" : "all" };
		}
	}
	const tokens = tokenizeOmniTerms(trimmed);
	return { type: null, tokens, matchMode: "all" };
}

const ADVANCED_FILTER_FORCE_PREFIX = /^(filters?|advanced|adv)\s*:\s*(.*)$/i;
const ADVANCED_FILTER_OMNI_KEYS = new Set(["route", "station", "stop", "garage", "operator", "postcode", "district"]);
const ADVANCED_FILTER_BANDS = new Map([
	["peakam", "peak_am"],
	["peak", "peak_am"],
	["am", "peak_am"],
	["peakpm", "peak_pm"],
	["pm", "peak_pm"],
	["offpeak", "offpeak"],
	["off", "offpeak"],
	["weekend", "weekend"],
	["wknd", "weekend"],
	["overnight", "overnight"],
	["night", "overnight"]
]);

function tokenizeAdvancedFilterQuery(query) {
	const text = String(query || "").trim();
	if (!text) {
		return [];
	}
	const tokens = [];
	let current = "";
	let quote = null;
	for (let i = 0; i < text.length; i += 1) {
		const char = text[i];
		if (quote) {
			if (char === "\\" && i + 1 < text.length) {
				const next = text[i + 1];
				if (next === quote || next === "\\") {
					current += next;
					i += 1;
					continue;
				}
			}
			if (char === quote) {
				quote = null;
			} else {
				current += char;
			}
			continue;
		}
		if (char === "\"") {
			quote = char;
			continue;
		}
		if (char === "'") {
			const prev = i > 0 ? text[i - 1] : "";
			const isDelimiter = !prev || /\s|[:,=|]/.test(prev);
			if (isDelimiter) {
				quote = char;
				continue;
			}
		}
		if (/\s/.test(char)) {
			if (current) {
				tokens.push(current);
				current = "";
			}
			continue;
		}
		current += char;
	}
	if (current) {
		tokens.push(current);
	}
	return tokens;
}

function normalizeAdvancedFilterKey(rawKey) {
	const cleaned = String(rawKey || "").trim().toLowerCase();
	if (!cleaned) {
		return null;
	}
	const token = cleaned.replace(/[^a-z0-9_]/g, "");
	const map = {
		route: { key: "route_ids", group: "route" },
		routes: { key: "route_ids", group: "route" },
		routeno: { key: "route_ids", group: "route" },
		route_no: { key: "route_ids", group: "route" },
		routenumber: { key: "route_ids", group: "route" },
		route_number: { key: "route_ids", group: "route" },
		routeid: { key: "route_ids", group: null },
		routeids: { key: "route_ids", group: null },
		id: { key: "route_ids", group: null },
		routeprefix: { key: "route_prefix", group: null },
		prefix: { key: "route_prefix", group: null },
		routeseries: { key: "route_series", group: null },
		series: { key: "route_series", group: null },
		include_prefixes: { key: "include_prefix_routes", group: null },
		includeprefixes: { key: "include_prefix_routes", group: null },
		series_prefixes: { key: "include_prefix_routes", group: null },
		seriesprefixes: { key: "include_prefix_routes", group: null },
		routetype: { key: "route_types", group: null },
		routetypes: { key: "route_types", group: null },
		type: { key: "route_types", group: null },
		operator: { key: "operators", group: "operator" },
		operators: { key: "operators", group: "operator" },
		garage: { key: "garages", group: "garage" },
		garages: { key: "garages", group: "garage" },
		borough: { key: "boroughs", group: null },
		boroughs: { key: "boroughs", group: null },
		boroughmode: { key: "borough_mode", group: null },
		borough_mode: { key: "borough_mode", group: null },
		vehicle: { key: "vehicle_types", group: null },
		vehicles: { key: "vehicle_types", group: null },
		vehicletype: { key: "vehicle_types", group: null },
		vehicletypes: { key: "vehicle_types", group: null },
		spatial: { key: "extreme", group: null },
		extreme: { key: "extreme", group: null },
		extremity: { key: "extreme", group: null },
		overnight: { key: "overnight", group: null },
		hasovernight: { key: "flags_has_overnight", group: null },
		freq: { key: "freq", group: null },
		frequency: { key: "freq", group: null },
		bph: { key: "freq", group: null },
		peakam: { key: "freq_band", group: null, band: "peak_am" },
		peak_am: { key: "freq_band", group: null, band: "peak_am" },
		peakpm: { key: "freq_band", group: null, band: "peak_pm" },
		peak_pm: { key: "freq_band", group: null, band: "peak_pm" },
		offpeak: { key: "freq_band", group: null, band: "offpeak" },
		weekend: { key: "freq_band", group: null, band: "weekend" },
		overnightband: { key: "freq_band", group: null, band: "overnight" },
		length: { key: "length_miles", group: null },
		miles: { key: "length_miles", group: null },
		lengthmiles: { key: "length_miles", group: null },
		length_rank: { key: "length_rank", group: null },
		lengthrank: { key: "length_rank", group: null }
	};
	return map[token] || null;
}

function normalizeFrequencyBand(value) {
	const cleaned = String(value || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
	return ADVANCED_FILTER_BANDS.get(cleaned) || null;
}

function splitAdvancedFilterValues(value) {
	return String(value || "")
		.split(/[,|]+/)
		.map((entry) => entry.trim())
		.filter(Boolean);
}

function parseAdvancedBoolean(value) {
	if (value === undefined || value === null || value === "") {
		return true;
	}
	const token = String(value).trim().toLowerCase();
	if (!token) {
		return true;
	}
	if (["true", "yes", "y", "on", "1"].includes(token)) {
		return true;
	}
	if (["false", "no", "n", "off", "0"].includes(token)) {
		return false;
	}
	return null;
}

function parseAdvancedRange(value) {
	const trimmed = String(value || "").trim();
	if (!trimmed) {
		return null;
	}
	const plusMatch = trimmed.match(/^(-?\d+(?:\.\d+)?)\+$/);
	if (plusMatch) {
		const num = Number(plusMatch[1]);
		return Number.isFinite(num) ? { min: num } : null;
	}
	const betweenMatch = trimmed.match(/^(-?\d+(?:\.\d+)?)\s*-\s*(-?\d+(?:\.\d+)?)$/);
	if (betweenMatch) {
		const min = Number(betweenMatch[1]);
		const max = Number(betweenMatch[2]);
		if (!Number.isFinite(min) || !Number.isFinite(max)) {
			return null;
		}
		return { min, max };
	}
	const cmpMatch = trimmed.match(/^(<=|>=|<|>)(-?\d+(?:\.\d+)?)$/);
	if (cmpMatch) {
		const op = cmpMatch[1];
		const num = Number(cmpMatch[2]);
		if (!Number.isFinite(num)) {
			return null;
		}
		if (op === "<" || op === "<=") {
			return { max: num };
		}
		return { min: num };
	}
	const exactMatch = trimmed.match(/^(-?\d+(?:\.\d+)?)$/);
	if (exactMatch) {
		const num = Number(exactMatch[1]);
		return Number.isFinite(num) ? { min: num } : null;
	}
	return null;
}

function parseAdvancedSeriesValue(value) {
	const token = String(value || "").trim();
	if (!token) {
		return null;
	}
	const num = Number(token);
	if (!Number.isFinite(num) || !Number.isInteger(num)) {
		return null;
	}
	if (num < 0 || num > 99) {
		return null;
	}
	return num;
}

function normalizeAdvancedRouteType(value) {
	const token = String(value || "").trim().toLowerCase();
	if (!token) {
		return "";
	}
	if (token === "any" || token === "all") {
		return "any";
	}
	if (token === "24" || token === "24hr" || token === "24hour" || token === "24-hour") {
		return "twentyfour";
	}
	if (token === "twentyfour" || token === "twenty-four") {
		return "twentyfour";
	}
	return token;
}

function normalizeAdvancedExtreme(value) {
	const token = String(value || "").trim().toLowerCase();
	if (["north", "n"].includes(token)) {
		return "north";
	}
	if (["south", "s"].includes(token)) {
		return "south";
	}
	if (["east", "e"].includes(token)) {
		return "east";
	}
	if (["west", "w"].includes(token)) {
		return "west";
	}
	return "";
}

function parseAdvancedFrequency(value, fallbackBand) {
	const raw = String(value || "").trim();
	if (!raw) {
		return null;
	}
	let band = fallbackBand || null;
	let rangeValue = raw;
	if (raw.includes(":")) {
		const parts = raw.split(":");
		const candidate = normalizeFrequencyBand(parts[0]);
		if (candidate) {
			band = candidate;
			rangeValue = parts.slice(1).join(":");
		}
	} else {
		const bandMatch = raw.match(/^([a-z_]+)(.*)$/i);
		if (bandMatch) {
			const candidate = normalizeFrequencyBand(bandMatch[1]);
			if (candidate) {
				band = candidate;
				rangeValue = bandMatch[2] || "";
			}
		}
	}
	if (!band) {
		band = "peak_am";
	}
	const range = parseAdvancedRange(rangeValue);
	if (!range || (!Number.isFinite(range.min) && !Number.isFinite(range.max))) {
		return null;
	}
	return { band, range };
}

function hasActiveAdvancedFilters(spec) {
	if (!spec || typeof spec !== "object") {
		return false;
	}
	const hasList = (value) => Array.isArray(value) && value.length > 0;
	if (hasList(spec.route_ids)) {
		return true;
	}
	if (spec.route_prefix) {
		return true;
	}
	if (Number.isFinite(spec.route_series)) {
		return true;
	}
	if (hasList(spec.route_types) || hasList(spec.operators) || hasList(spec.garages) || hasList(spec.boroughs) || hasList(spec.vehicle_types)) {
		return true;
	}
	if (spec.freq) {
		const bands = ["peak_am", "peak_pm", "offpeak", "weekend", "overnight"];
		for (const band of bands) {
			const range = spec.freq[band];
			if (range && (Number.isFinite(range.min) || Number.isFinite(range.max))) {
				return true;
			}
		}
	}
	if (spec.flags && typeof spec.flags.has_overnight === "boolean") {
		return true;
	}
	if (spec.length_miles && (Number.isFinite(spec.length_miles.min) || Number.isFinite(spec.length_miles.max))) {
		return true;
	}
	if (spec.length_rank && Number.isFinite(spec.length_rank.count)) {
		return true;
	}
	if (spec.extreme) {
		return true;
	}
	return false;
}

function buildAdvancedFilterSummary(spec) {
	if (!spec || typeof spec !== "object") {
		return "";
	}
	const parts = [];
	if (spec.route_ids?.length) {
		parts.push(`routes: ${spec.route_ids.join(", ")}`);
	}
	if (spec.route_prefix) {
		parts.push(`prefix: ${spec.route_prefix}`);
	}
	if (Number.isFinite(spec.route_series)) {
		parts.push(`series: ${spec.route_series}${spec.include_prefix_routes ? "+" : ""}`);
	}
	if (spec.route_types?.length) {
		parts.push(`types: ${spec.route_types.join(", ")}`);
	}
	if (spec.operators?.length) {
		parts.push(`operators: ${spec.operators.join(", ")}`);
	}
	if (spec.garages?.length) {
		parts.push(`garages: ${spec.garages.join(", ")}`);
	}
	if (spec.boroughs?.length) {
		parts.push(`boroughs: ${spec.boroughs.join(", ")}`);
	}
	if (spec.borough_mode === "within") {
		parts.push("borough mode: within");
	}
	if (spec.vehicle_types?.length) {
		parts.push(`vehicles: ${spec.vehicle_types.join(", ")}`);
	}
	if (spec.extreme) {
		parts.push(`spatial: ${spec.extreme}`);
	}
	if (spec.flags?.has_overnight === true) {
		parts.push("overnight: yes");
	}
	if (spec.length_miles && (Number.isFinite(spec.length_miles.min) || Number.isFinite(spec.length_miles.max))) {
		const hasMin = Number.isFinite(spec.length_miles.min);
		const hasMax = Number.isFinite(spec.length_miles.max);
		const min = hasMin ? spec.length_miles.min : "";
		const max = hasMax ? spec.length_miles.max : "";
		const rangeText = hasMin && hasMax ? `${min}-${max}` : hasMin ? `${min}+` : `<=${max}`;
		parts.push(`length: ${rangeText} mi`);
	}
	if (spec.freq) {
		const freqParts = [];
		const bands = ["peak_am", "peak_pm", "offpeak", "weekend", "overnight"];
		const labels = {
			peak_am: "peak am",
			peak_pm: "peak pm",
			offpeak: "off-peak",
			weekend: "weekend",
			overnight: "overnight"
		};
		bands.forEach((band) => {
			const range = spec.freq?.[band];
			if (!range) {
				return;
			}
			const hasMin = Number.isFinite(range.min);
			const hasMax = Number.isFinite(range.max);
			const min = hasMin ? range.min : "";
			const max = hasMax ? range.max : "";
			const rangeText = hasMin && hasMax ? `${min}-${max}` : hasMin ? `${min}+` : `<=${max}`;
			freqParts.push(`${labels[band]} ${rangeText}`);
		});
		if (freqParts.length) {
			parts.push(`freq: ${freqParts.join(", ")}`);
		}
	}
	return parts.join(" · ");
}

function parseAdvancedFilterQuery(query) {
	const trimmed = String(query || "").trim();
	if (!trimmed) {
		return { active: false };
	}
	let force = false;
	let working = trimmed;
	const forcedMatch = trimmed.match(ADVANCED_FILTER_FORCE_PREFIX);
	if (forcedMatch) {
		force = true;
		working = forcedMatch[2] || "";
	}
	const tokens = tokenizeAdvancedFilterQuery(working);
	const spec = {};
	const freq = {};
	const flags = {};
	const keyStats = { total: 0, nonOmni: 0 };
	let includePrefixRoutes = undefined;
	let hasAnyType = false;

	const addList = (key, values) => {
		if (!values || values.length === 0) {
			return;
		}
		if (!Array.isArray(spec[key])) {
			spec[key] = [];
		}
		spec[key].push(...values);
	};

	tokens.forEach((token) => {
		const idx = token.indexOf(":");
		if (idx <= 0) {
			return;
		}
		const rawKey = token.slice(0, idx);
		const rawValue = token.slice(idx + 1);
		const keyInfo = normalizeAdvancedFilterKey(rawKey);
		if (!keyInfo) {
			return;
		}
		let applied = false;
		const value = String(rawValue || "").trim();
		const valueParts = splitAdvancedFilterValues(value);
		switch (keyInfo.key) {
			case "route_ids": {
				const tokensValue = extractRouteTokens(valueParts.join(" "));
				if (tokensValue.length > 0) {
					addList("route_ids", tokensValue);
					applied = true;
				}
				break;
			}
			case "route_prefix": {
				if (valueParts.length > 0) {
					spec.route_prefix = String(valueParts[0] || "").trim().toUpperCase();
					applied = Boolean(spec.route_prefix);
				}
				break;
			}
			case "route_series": {
				let seriesValue = value;
				if (seriesValue.endsWith("+")) {
					includePrefixRoutes = true;
					seriesValue = seriesValue.slice(0, -1);
				}
				const parsed = parseAdvancedSeriesValue(seriesValue);
				if (parsed !== null) {
					spec.route_series = parsed;
					applied = true;
				}
				break;
			}
			case "include_prefix_routes": {
				const boolValue = parseAdvancedBoolean(value);
				if (boolValue !== null) {
					includePrefixRoutes = boolValue;
					applied = true;
				}
				break;
			}
			case "route_types": {
				const types = valueParts.map(normalizeAdvancedRouteType).filter(Boolean);
				const filtered = types.filter((entry) => entry !== "any");
				if (types.includes("any")) {
					hasAnyType = true;
				}
				if (filtered.length > 0) {
					addList("route_types", filtered);
					applied = true;
				} else if (types.length > 0) {
					applied = true;
				}
				break;
			}
			case "operators": {
				if (valueParts.length > 0) {
					addList("operators", valueParts.map((entry) => entry.toLowerCase()));
					applied = true;
				}
				break;
			}
			case "garages": {
				if (valueParts.length > 0) {
					addList("garages", valueParts.map((entry) => entry.toLowerCase()));
					applied = true;
				}
				break;
			}
			case "boroughs": {
				if (valueParts.length > 0) {
					addList("boroughs", valueParts.map((entry) => entry.toLowerCase()));
					applied = true;
				}
				break;
			}
			case "borough_mode": {
				if (value && value.toLowerCase() === "within") {
					spec.borough_mode = "within";
					applied = true;
				}
				break;
			}
			case "vehicle_types": {
				if (valueParts.length > 0) {
					addList("vehicle_types", valueParts.map((entry) => entry.toUpperCase()));
					applied = true;
				}
				break;
			}
			case "extreme": {
				const extreme = normalizeAdvancedExtreme(value);
				if (extreme) {
					spec.extreme = extreme;
					applied = true;
				}
				break;
			}
			case "length_miles": {
				const range = parseAdvancedRange(value);
				if (range) {
					spec.length_miles = range;
					applied = true;
				}
				break;
			}
			case "freq": {
				const parsed = parseAdvancedFrequency(value, null);
				if (parsed) {
					freq[parsed.band] = parsed.range;
					applied = true;
				}
				break;
			}
			case "freq_band": {
				const band = keyInfo.band || normalizeFrequencyBand(rawKey);
				if (band) {
					const range = parseAdvancedRange(value);
					if (range) {
						freq[band] = range;
						applied = true;
					}
				}
				break;
			}
			case "overnight": {
				const range = parseAdvancedRange(value);
				if (range) {
					freq.overnight = range;
					applied = true;
					break;
				}
				const boolValue = parseAdvancedBoolean(value);
				if (boolValue !== null) {
					flags.has_overnight = boolValue;
					applied = true;
				}
				break;
			}
			case "flags_has_overnight": {
				const boolValue = parseAdvancedBoolean(value);
				if (boolValue !== null) {
					flags.has_overnight = boolValue;
					applied = true;
				}
				break;
			}
			case "length_rank": {
				const segments = value.split(/[:=]/).map((entry) => entry.trim()).filter(Boolean);
				if (segments.length >= 2) {
					const mode = segments[0].toLowerCase();
					const count = Number(segments[1]);
					if ((mode === "shortest" || mode === "longest") && Number.isFinite(count)) {
						spec.length_rank = { mode, count: Math.round(count) };
						applied = true;
					}
				}
				break;
			}
			default:
				break;
		}
		if (applied) {
			keyStats.total += 1;
			if (!keyInfo.group || !ADVANCED_FILTER_OMNI_KEYS.has(keyInfo.group)) {
				keyStats.nonOmni += 1;
			}
		}
	});

	if (Object.keys(freq).length > 0) {
		spec.freq = freq;
	}
	if (Object.keys(flags).length > 0) {
		spec.flags = flags;
	}
	if (includePrefixRoutes !== undefined && Number.isFinite(spec.route_series)) {
		spec.include_prefix_routes = includePrefixRoutes;
	}
	if (hasAnyType) {
		force = true;
	}

	const normalizedSpec = window.RouteMapsterQueryEngine?.normalizeFilterSpec
		? window.RouteMapsterQueryEngine.normalizeFilterSpec(spec)
		: spec;
	const hasFilters = hasActiveAdvancedFilters(normalizedSpec);
	const shouldApply = force || keyStats.nonOmni > 0 || keyStats.total >= 2;
	if (!hasFilters || !shouldApply) {
		return { active: false };
	}
	return {
		active: true,
		spec: normalizedSpec,
		summary: buildAdvancedFilterSummary(normalizedSpec)
	};
}

function scoreOmniItem(item, tokens, rawLower) {
	let score = 0;
	const typeBoost = {
		route: 500,
		station: 400,
		stop: 300,
		garage: 200,
		operator: 150,
		postcode: 0
	};
	score += typeBoost[item.type] ?? 0;
	const titleLower = item.titleLower || String(item.title || "").toLowerCase();
	if (rawLower && titleLower === rawLower) {
		score += 200;
	}
	if (rawLower && titleLower.startsWith(rawLower)) {
		score += 120;
	}
	if (rawLower && item.searchText?.startsWith(rawLower)) {
		score += 80;
	}
	tokens.forEach((token) => {
		if (titleLower.includes(token)) {
			score += 20;
		}
		if (item.searchText?.includes(token)) {
			score += 8;
		}
	});
	if (item.type === "route" && rawLower && item.routeId) {
		if (String(item.routeId).toLowerCase() === rawLower) {
			score += 200;
		}
	}
	if (item.type === "garage" && rawLower && item.garageDetails?.codes) {
		const raw = String(rawLower || "").trim().toLowerCase();
		const codes = item.garageDetails.codes.map((code) => String(code || "").trim().toLowerCase());
		if (codes.some((code) => code === raw)) {
			score += 220;
		} else if (codes.some((code) => code.startsWith(raw))) {
			score += 90;
		}
	}
	if (item.type === "postcode" && rawLower && item.postcodeData?.key) {
		const compact = String(item.postcodeData.key).replace(/\s+/g, "").toLowerCase();
		if (compact === rawLower) {
			score += 180;
		}
		if (item.postcodeData.isDistrict && String(item.postcodeData.key).toLowerCase() === rawLower) {
			score += 140;
		}
	}
	return score;
}

function filterOmniSearchResults(query) {
	omniSearchState.lastQuery = query || "";
	const advanced = parseAdvancedFilterQuery(query);
	if (advanced.active) {
		const summary = advanced.summary || "Apply advanced filters";
		const item = {
			id: "advanced-filters",
			type: "advanced_filters",
			typeLabel: getOmniTypeLabel("advanced_filters"),
			title: "Apply advanced filters",
			subtitle: summary,
			searchText: "",
			filterSpec: advanced.spec
		};
		omniSearchState.filteredItems = [item];
		omniSearchState.selectedIndex = 0;
		renderOmniResults(omniSearchState.filteredItems, 1);
		setOmniStatus("Press Enter to apply advanced filters.");
		return;
	}
	const parsed = parseOmniQuery(query);
	const tokens = parsed.tokens;
	const matchMode = parsed.matchMode === "any" ? "any" : "all";
	const rawLower = tokens.join(" ");
	if (tokens.length === 0) {
		omniSearchState.filteredItems = [];
		omniSearchState.selectedIndex = 0;
		renderOmniResults([], 0);
		setOmniStatus("Start typing to explore routes, stops, stations, garages, or operators.");
		return;
	}
	const matches = omniSearchState.items
		.filter((item) => {
			if (parsed.type && item.type !== parsed.type) {
				return false;
			}
			if (matchMode === "any") {
				return tokens.some((token) => item.searchText?.includes(token));
			}
			return tokens.every((token) => item.searchText?.includes(token));
		})
		.map((item) => {
			let score = 0;
			try {
				score = scoreOmniItem(item, tokens, rawLower);
			} catch (error) {
				score = 0;
			}
			return { item, score };
		})
		.sort((a, b) => b.score - a.score || String(a.item.title).localeCompare(String(b.item.title)))
		.map((entry) => entry.item);

	let results = matches;
	if (parsed.type === "route" && matchMode === "any" && tokens.length > 1) {
		const routeIds = Array.from(
			new Set(
				matches
					.map((item) => String(item?.routeId || "").trim().toUpperCase())
					.filter(Boolean)
			)
		);
		if (routeIds.length > 1) {
			const bulkItem = {
				id: `route-bulk:${routeIds.join(",")}`,
				type: "route_bulk",
				typeLabel: "Route set",
				title: `Show ${routeIds.length} matched routes`,
				subtitle: routeIds.join(", "),
				searchText: "",
				routeIds
			};
			results = [bulkItem, ...matches];
		}
	}

	const totalCount = results.length;
	const limited = results.slice(0, 12);
	omniSearchState.filteredItems = limited;
	omniSearchState.selectedIndex = 0;
	if (limited.length === 0) {
		renderOmniResults([], totalCount);
		setOmniStatus("No matches. Try a different search term.");
		return;
	}
	renderOmniResults(limited, totalCount);
}

function clearOmniStopsLayer() {
	if (appState.omniStopsLayer && appState.map) {
		appState.map.removeLayer(appState.omniStopsLayer);
		appState.omniStopsLayer = null;
	}
}

function clearOmniRouteLayer() {
	if (appState.omniRouteLayer && appState.map) {
		appState.map.removeLayer(appState.omniRouteLayer);
		appState.omniRouteLayer = null;
	}
}

function clearOmniSearchLayers(options = {}) {
	const restoreNetwork = options.restoreNetwork !== false;
	clearOmniRouteLayer();
	clearOmniStopsLayer();
	if (!appState.omniActive) {
		return;
	}
	const previousSuppress = appState.omniPrevSuppress;
	appState.omniActive = false;
	appState.omniPrevSuppress = null;
	if (!restoreNetwork) {
		return;
	}
	appState.suppressNetworkRoutes = Boolean(previousSuppress);
	if (!appState.suppressNetworkRoutes) {
		appState.networkRouteLoadToken += 1;
		renderNetworkRoutes(appState.networkRouteLoadToken);
	}
}

async function showOmniRoutes(routeIds, contextLabel = "Explorer") {
	if (!appState.map) {
		return;
	}
	const routes = Array.isArray(routeIds)
		? Array.from(new Set(routeIds.map((id) => String(id || "").trim().toUpperCase()).filter(Boolean)))
			.filter((routeId) => !isExcludedRoute(routeId))
		: [];
	if (routes.length === 0) {
		clearOmniSearchLayers();
		return;
	}
	if (!appState.omniActive) {
		appState.omniPrevSuppress = appState.suppressNetworkRoutes;
	}
	appState.omniActive = true;
	appState.suppressNetworkRoutes = true;
	appState.networkRouteLoadToken += 1;
	clearNetworkRoutes();
	clearActiveRouteSelections();
	if (appState.focusRouteId) {
		clearFocusedRoute();
	}
	clearOmniRouteLayer();
	const loadToken = appState.omniRouteLoadToken + 1;
	appState.omniRouteLoadToken = loadToken;
	const layerGroup = L.layerGroup().addTo(appState.map);
	appState.omniRouteLayer = layerGroup;
	const routeSets = appState.useRouteTypeColours ? await loadNetworkRouteSets() : null;
	const tasks = routes.map((routeId) => loadRouteGeometry(routeId)
		.then((segments) => {
			if (loadToken !== appState.omniRouteLoadToken) {
				return;
			}
			if (!segments || segments.length === 0) {
				return;
			}
			const color = getFocusedRouteColour(routeId, routeSets);
			segments.forEach((segment) => {
				const line = L.polyline(segment, {
					color,
					weight: 3.4,
					opacity: 0.88,
					interactive: true,
					pane: ROUTE_PANE
				}).addTo(layerGroup);
				line._routeId = routeId;
				bindRouteHoverPopup(line, layerGroup);
			});
		})
		.catch(() => {}));
	await Promise.all(tasks);
	if (loadToken !== appState.omniRouteLoadToken) {
		return;
	}
	updateSelectedInfo(`${contextLabel}: ${routes.length} routes`);
}

async function setOperatorInfoPanel(operatorName, routes) {
	const routeSets = appState.useRouteTypeColours ? await loadNetworkRouteSets() : null;
	const safeRoutes = Array.isArray(routes) ? routes : [];
	const routeHtml = safeRoutes.length > 0
		? renderRoutePills(safeRoutes, routeSets)
		: '<div class="info-empty">No routes listed.</div>';
	setInfoPanel({
		title: operatorName || "Operator",
		subtitle: "Operator",
		bodyHtml: `
			<div class="info-section">
				<div class="info-label">Routes</div>
				${routeHtml}
			</div>
		`
	});
}

async function renderOmniPostcodeStops(data) {
	if (!data) {
		return 0;
	}
	const geojson = await loadBusStopsGeojson().catch(() => null);
	if (!geojson || !Array.isArray(geojson.features)) {
		return Number.isFinite(data.stopCount) ? data.stopCount : 0;
	}
	const districtToken = normalisePostcodeDistrict(data.key || data.district || "");
	const matches = geojson.features.filter((feature) => {
		const props = feature?.properties || {};
		const postcode = normalisePostcodeValue(props?.POSTCODE || props?.postcode);
		if (!postcode) {
			return false;
		}
		return normalisePostcodeDistrict(postcode) === districtToken;
	});
	clearOmniStopsLayer();
	if (!appState.map) {
		return matches.length;
	}
	const layerGroup = L.layerGroup().addTo(appState.map);
	appState.omniStopsLayer = layerGroup;
	matches.forEach((feature) => {
		const coords = feature?.geometry?.coordinates;
		const lon = Array.isArray(coords) ? Number(coords[0]) : null;
		const lat = Array.isArray(coords) ? Number(coords[1]) : null;
		if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
			return;
		}
		const props = feature?.properties || {};
		const marker = L.circleMarker([lat, lon], {
			radius: 4,
			weight: 1,
			color: "#0f766e",
			fillColor: "#22c55e",
			fillOpacity: 0.8,
			pane: STOP_PANE
		});
		bindHoverPopup(marker, () => buildBusStopPopup(props));
		marker.addTo(layerGroup);
	});
	return matches.length;
}

async function applyOmniRouteSelection(item) {
	const routeId = item?.routeId;
	if (!routeId) {
		return;
	}
	clearOmniSearchLayers({ restoreNetwork: false });
	clearAdvancedStopsLayer();
	clearOmniStopsLayer();
	await showRouteDetailsAndFocus(routeId);
}

function applyOmniStationSelection(item) {
	const station = item?.station;
	if (!station) {
		return;
	}
	clearOmniSearchLayers({ restoreNetwork: false });
	clearAdvancedStopsLayer();
	clearOmniStopsLayer();
	ensureBusStationsVisible();
	setBusStationSelectValue(station.key || "");
	const select = document.getElementById("busStationSelect");
	if (select) {
		select.dispatchEvent(new Event("change"));
	}
}

function applyOmniGarageSelection(item) {
	const group = item?.garageGroup;
	if (!group?.features) {
		return;
	}
	clearOmniSearchLayers({ restoreNetwork: false });
	clearAdvancedStopsLayer();
	clearOmniStopsLayer();
	ensureGaragesVisible();
	const key = buildGarageSelectKey(group.features);
	setGarageSelectValue(key);
	const select = document.getElementById("garageSelect");
	if (select) {
		select.dispatchEvent(new Event("change"));
	}
}

async function applyOmniAdvancedFilterSelection(item) {
	const spec = item?.filterSpec;
	if (!spec) {
		return;
	}
	closeOmniSearch();
	clearOmniSearchLayers({ restoreNetwork: false });
	clearAdvancedStopsLayer();
	clearOmniStopsLayer();
	const module = document.querySelector('[data-module="advanced-filters"]');
	if (module) {
		module.open = true;
	}
	if (module && window.RouteMapsterAdvancedFilters?.initAdvancedFilters) {
		await window.RouteMapsterAdvancedFilters.initAdvancedFilters(module, appState);
	}
	if (window.RouteMapsterAdvancedFilters?.applyFilterSpec) {
		await window.RouteMapsterAdvancedFilters.applyFilterSpec(spec, appState, { openModule: true });
		updateSelectedInfo("Advanced filters applied.");
	}
}
async function applyOmniOperatorSelection(item) {
	const operatorName = item?.operatorName;
	const routes = Array.isArray(item?.operatorRoutes) ? item.operatorRoutes : [];
	if (!operatorName || routes.length === 0) {
		return;
	}
	clearOmniSearchLayers({ restoreNetwork: false });
	clearAdvancedStopsLayer();
	await showOmniRoutes(routes, operatorName);
	await setOperatorInfoPanel(operatorName, routes);
}

async function applyOmniPostcodeSelection(item) {
	const data = item?.postcodeData;
	if (!data) {
		return;
	}
	clearOmniSearchLayers({ restoreNetwork: false });
	clearAdvancedStopsLayer();
	const stopCount = await renderOmniPostcodeStops(data);
	const routeSets = appState.useRouteTypeColours ? await loadNetworkRouteSets() : null;
	const routes = Array.isArray(data.routes) ? data.routes : [];
	const routeHtml = routes.length > 0
		? renderRoutePills(routes, routeSets)
		: '<div class="info-empty">No routes listed.</div>';
	const title = `Postcode district ${data.key}`;
	const subtitle = "Postcode district";
	setInfoPanel({
		title,
		subtitle,
		bodyHtml: `
			<div class="info-section">
				<div class="info-label">Stops</div>
				<div>${stopCount} stops matched.</div>
			</div>
			<div class="info-section">
				<div class="info-label">Routes serving</div>
				${routeHtml}
			</div>
		`
	});
	if (appState.map && Number.isFinite(data.lat) && Number.isFinite(data.lon)) {
		appState.map.flyTo([data.lat, data.lon], Math.max(appState.map.getZoom(), 13));
	}
	updateSelectedInfo(`${title} · ${stopCount} stops`);
}

async function applyOmniStopSelection(item) {
	const props = item?.stopProps;
	if (!props) {
		return;
	}
	clearOmniSearchLayers({ restoreNetwork: false });
	clearAdvancedStopsLayer();
	clearOmniStopsLayer();
	const loadToken = appState.omniStopsLoadToken + 1;
	appState.omniStopsLoadToken = loadToken;
	const layerGroup = L.layerGroup();
	const lat = Number(item?.stopLat);
	const lon = Number(item?.stopLon);
	if (Number.isFinite(lat) && Number.isFinite(lon)) {
		const marker = L.circleMarker([lat, lon], {
			radius: 5,
			weight: 1.2,
			color: "#0f766e",
			fillColor: "#22c55e",
			fillOpacity: 0.9,
			pane: STOP_PANE
		});
		bindHoverPopup(marker, () => buildBusStopPopup(props));
		marker.on("click", () => {
			setSelectedFeature("stop", props);
			refreshSelectedInfoPanel().catch(() => {});
			ensureStopPointRoutes(props)
				.then(() => refreshSelectedInfoPanel().catch(() => {}))
				.catch(() => {});
		});
		marker.addTo(layerGroup);
	}
	if (loadToken !== appState.omniStopsLoadToken) {
		return;
	}
	if (appState.map) {
		layerGroup.addTo(appState.map);
		appState.omniStopsLayer = layerGroup;
		if (Number.isFinite(lat) && Number.isFinite(lon)) {
			appState.map.flyTo([lat, lon], Math.max(appState.map.getZoom(), 14));
		}
	}
	setSelectedFeature("stop", props);
	await refreshSelectedInfoPanel().catch(() => {});
	await ensureStopPointRoutes(props).then(() => refreshSelectedInfoPanel().catch(() => {})).catch(() => {});
	updateSelectedInfo(getStopDisplayName(props));
}

function handleOmniSelection(item) {
	if (!item) {
		return;
	}
	closeOmniSearch();
	if (item.type === "route_bulk") {
		showOmniRoutes(item.routeIds, "Explorer").catch(() => {});
		return;
	}
	if (item.type === "route") {
		applyOmniRouteSelection(item).catch(() => {});
		return;
	}
	if (item.type === "station") {
		applyOmniStationSelection(item);
		return;
	}
	if (item.type === "stop") {
		applyOmniStopSelection(item).catch(() => {});
		return;
	}
	if (item.type === "garage") {
		applyOmniGarageSelection(item);
		return;
	}
	if (item.type === "operator") {
		applyOmniOperatorSelection(item).catch(() => {});
		return;
	}
	if (item.type === "postcode") {
		applyOmniPostcodeSelection(item).catch(() => {});
		return;
	}
	if (item.type === "advanced_filters") {
		applyOmniAdvancedFilterSelection(item).catch(() => {});
	}
}

function openOmniSearch() {
	const els = omniSearchState.elements;
	if (!els) {
		return;
	}
	omniSearchState.lastActiveElement = document.activeElement;
	setOmniSearchVisible(true);
	els.input.value = "";
	els.input.disabled = true;
	omniSearchState.filteredItems = [];
	omniSearchState.selectedIndex = 0;
	els.results.innerHTML = "";
	setOmniStatus("Loading Explorer catalog...");
	ensureOmniSearchIndex()
		.then((items) => {
			omniSearchState.items = items;
			els.input.disabled = false;
			els.input.focus();
			setOmniStatus("Start typing to explore routes, stops, stations, garages, or operators.");
		})
		.catch(() => {
			els.input.disabled = false;
			setOmniStatus("Search catalog unavailable.");
		});
}

function closeOmniSearch() {
	const els = omniSearchState.elements;
	if (!els) {
		return;
	}
	setOmniSearchVisible(false);
	const last = omniSearchState.lastActiveElement;
	if (last && typeof last.focus === "function") {
		last.focus();
	}
}

function setupOmniSearch() {
	const modal = document.getElementById("omniSearchModal");
	const input = document.getElementById("omniSearchInput");
	const results = document.getElementById("omniSearchResults");
	const status = document.getElementById("omniSearchStatus");
	const openButton = document.getElementById("openOmniSearch");
	if (!modal || !input || !results || !status || !openButton) {
		return;
	}
	omniSearchState.elements = { modal, input, results, status, openButton };

	openButton.addEventListener("click", () => {
		openOmniSearch();
	});

	modal.addEventListener("click", (event) => {
		if (event.target === modal) {
			closeOmniSearch();
		}
	});

	results.addEventListener("click", (event) => {
		const button = event.target.closest(".omni-result");
		if (!button) {
			return;
		}
		const index = Number(button.dataset.index || 0);
		const item = omniSearchState.filteredItems[index];
		if (item) {
			handleOmniSelection(item);
		}
	});

	const handleOmniEnter = (event) => {
		if (event.defaultPrevented) {
			return;
		}
		if (event.key !== "Enter" && event.key !== "NumpadEnter") {
			return;
		}
		if (event.isComposing) {
			return;
		}
		const button = event.target?.closest?.(".omni-result");
		const index = button ? Number(button.dataset.index || 0) : omniSearchState.selectedIndex;
		const item = omniSearchState.filteredItems[index];
		if (!item) {
			return;
		}
		event.preventDefault();
		handleOmniSelection(item);
	};

	results.addEventListener("keydown", handleOmniEnter);
	modal.addEventListener("keydown", handleOmniEnter);

	input.addEventListener("input", () => {
		filterOmniSearchResults(input.value);
	});

	input.addEventListener("keydown", (event) => {
		if (event.key === "ArrowDown") {
			event.preventDefault();
			const next = Math.min(
				omniSearchState.selectedIndex + 1,
				omniSearchState.filteredItems.length - 1
			);
			omniSearchState.selectedIndex = Math.max(next, 0);
			renderOmniResults(omniSearchState.filteredItems, omniSearchState.filteredItems.length);
			return;
		}
		if (event.key === "ArrowUp") {
			event.preventDefault();
			const next = Math.max(omniSearchState.selectedIndex - 1, 0);
			omniSearchState.selectedIndex = next;
			renderOmniResults(omniSearchState.filteredItems, omniSearchState.filteredItems.length);
			return;
		}
		if (event.key === "Enter" || event.key === "NumpadEnter") {
			handleOmniEnter(event);
			return;
		}
		if (event.key === "Escape") {
			event.preventDefault();
			closeOmniSearch();
		}
	});

	document.addEventListener("keydown", (event) => {
		const isFind = (event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "f";
		if (isFind) {
			event.preventDefault();
			openOmniSearch();
		}
		if (event.key === "Escape" && omniSearchState.isOpen) {
			event.preventDefault();
			closeOmniSearch();
		}
	});
}

function formatDateToken(token) {
	if (!token) {
		return "-";
	}
	const text = String(token).trim();
	if (!/^\d{8}$/.test(text)) {
		return text;
	}
	const year = Number(text.slice(0, 4));
	const month = Number(text.slice(4, 6)) - 1;
	const day = Number(text.slice(6, 8));
	const date = new Date(Date.UTC(year, month, day));
	if (Number.isNaN(date.getTime())) {
		return text;
	}
	return DATE_TOKEN_FORMATTER.format(date);
}

function formatIsoUtc(value) {
	if (!value) {
		return "-";
	}
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) {
		return String(value);
	}
	return `${ISO_UTC_FORMATTER.format(date)} UTC`;
}

function setAboutValue(id, value) {
	const el = document.getElementById(id);
	if (el) {
		el.textContent = value || "-";
	}
}

function getAboutNavigationTargets() {
	const isFile = window.location.protocol === "file:" || window.location.pathname.endsWith(".html");
	if (isFile) {
		return {
			aboutPath: `${window.location.pathname}#about`,
			homePath: window.location.pathname
		};
	}
	const basePath = window.location.pathname.replace(/\/about\/?$/, "").replace(/\/$/, "");
	return {
		aboutPath: `${basePath || ""}/about`,
		homePath: basePath || "/"
	};
}

async function loadAboutMetadata() {
	if (appState.aboutMetadata) {
		return appState.aboutMetadata;
	}
	if (appState.aboutLoadPromise) {
		return appState.aboutLoadPromise;
	}
	appState.aboutLoadPromise = Promise.all([
		fetch(ABOUT_METADATA_PATH)
			.then((res) => res.ok ? res.json() : null)
			.catch(() => null),
		fetch(ROUTE_GEOMETRY_INDEX_PATH)
			.then((res) => res.ok ? res.json() : null)
			.catch(() => null)
	])
		.then(([meta, index]) => {
			appState.aboutMetadata = { meta, index };
			return appState.aboutMetadata;
		})
		.finally(() => {
			appState.aboutLoadPromise = null;
		});
	return appState.aboutLoadPromise;
}

async function refreshAboutModal() {
	const payload = await loadAboutMetadata();
	const meta = payload?.meta || {};
	const index = payload?.index || {};
	const geometryDate = meta.routes_geometry_date || index.date;

	setAboutValue("aboutRoutesGeometryDate", formatDateToken(geometryDate));
	setAboutValue("aboutUpdatedGarages", formatIsoUtc(meta.garages));
	setAboutValue("aboutUpdatedStops", formatIsoUtc(meta.stops));
	setAboutValue("aboutUpdatedStations", formatIsoUtc(meta.bus_stations));
	setAboutValue("aboutUpdatedFrequencies", formatIsoUtc(meta.frequencies));
	setAboutValue("aboutUpdatedRouteSummary", formatIsoUtc(meta.route_summary));
}

function openAboutModal(pushState = true) {
	setAboutModalVisible(true);
	refreshAboutModal().catch(() => {});
	if (pushState) {
		const { aboutPath } = getAboutNavigationTargets();
		window.history.pushState({ about: true }, "", aboutPath);
	}
}

function closeAboutModal(pushState = true) {
	setAboutModalVisible(false);
	if (pushState) {
		const { homePath } = getAboutNavigationTargets();
		window.history.pushState({ about: false }, "", homePath);
	}
}

function syncAboutFromLocation() {
	const pathname = window.location.pathname;
	const hash = window.location.hash;
	const show = hash === "#about" || pathname.endsWith("/about");
	if (show) {
		openAboutModal(false);
	} else {
		closeAboutModal(false);
	}
}

function setupAboutModal() {
	const openButton = document.getElementById("openAbout");
	const closeButton = document.getElementById("closeAbout");
	const modal = document.getElementById("aboutModal");
	if (openButton) {
		openButton.addEventListener("click", () => openAboutModal(true));
	}
	if (closeButton) {
		closeButton.addEventListener("click", () => closeAboutModal(true));
	}
	if (modal) {
		modal.addEventListener("click", (event) => {
			if (event.target === modal) {
				closeAboutModal(true);
			}
		});
	}
	document.addEventListener("keydown", (event) => {
		if (event.key === "Escape") {
			const isVisible = modal && modal.classList.contains("is-visible");
			if (isVisible) {
				closeAboutModal(true);
			}
		}
	});
	window.addEventListener("popstate", () => {
		syncAboutFromLocation();
	});
	syncAboutFromLocation();
}


async function addGaragesLayer(map) {
  const loadToken = appState.garageLoadToken;
  const gj = await loadGaragesGeojson();
  if (loadToken !== appState.garageLoadToken) {
    return null;
  }

  clearGarageMarkers();
  if (appState.garageRenderer && appState.map) {
    appState.map.removeLayer(appState.garageRenderer);
    appState.garageRenderer = null;
  }
  const renderer = L.svg({ pane: GARAGE_PANE });
  if (renderer._container) {
    renderer._container.style.pointerEvents = "auto";
  }
  appState.garageRenderer = renderer;
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
      pane: GARAGE_PANE,
      renderer,
      interactive: true
    });
    const hoverHtml = buildGarageHoverHtml(group.features);
    bindHoverPopup(marker, hoverHtml);
    marker.on('click', () => {
      setGarageSelectValue(buildGarageSelectKey(group.features));
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
	if (appState.garageRenderer && appState.map) {
		appState.map.removeLayer(appState.garageRenderer);
		appState.garageRenderer = null;
	}
}

function clearGarageRoutes() {
	if (appState.garageRouteLayer && appState.map) {
		appState.map.removeLayer(appState.garageRouteLayer);
		appState.garageRouteLayer = null;
	}
	closeRouteHoverPopup();
}

function clearBusStopsLayer() {
	if (appState.busStopLayer && appState.map) {
		appState.map.removeLayer(appState.busStopLayer);
		appState.busStopLayer = null;
	}
	if (appState.busStopRenderer && appState.map) {
		appState.map.removeLayer(appState.busStopRenderer);
		appState.busStopRenderer = null;
	}
}

function hideBusStopsIfVisible() {
	const showBusStops = document.getElementById("showBusStops");
	if (!showBusStops || !showBusStops.checked) {
		return false;
	}
	showBusStops.checked = false;
	appState.busStopLoadToken += 1;
	clearBusStopsLayer();
	refreshStopsPanePriority();
	updateBusStopVisibilityNote();
	if (appState.selectedFeature?.type === "stop") {
		resetInfoPanel();
	}
	return true;
}

function clearAdvancedStopsLayer() {
	if (appState.advancedStopsLayer && appState.map) {
		appState.map.removeLayer(appState.advancedStopsLayer);
		appState.advancedStopsLayer = null;
	}
}

const ADVANCED_STOP_METRIC_LABELS = {
	route_count: "Routes per stop",
	name_count: "Stops sharing this name"
};
const ADVANCED_STOP_GRADIENT = {
	steps: ["#2c7bb6", "#5aa4d6", "#abd9e9", "#fee090", "#fdae61", "#d7191c"],
	fallback: "#e2e8f0",
	fallbackStroke: "#94a3b8"
};

function getAdvancedStopMetricValue(stop, metric) {
	if (!stop || !metric) {
		return null;
	}
	const value = stop[metric];
	const num = Number(value);
	return Number.isFinite(num) ? num : null;
}

function formatAdvancedStopMetricValue(metric, value) {
	if (!Number.isFinite(value)) {
		return "";
	}
	if (metric === "route_count" || metric === "name_count") {
		return String(Math.round(value));
	}
	return formatCentralityValue(value);
}

function hexToRgb(hex) {
	const cleaned = String(hex || "").replace("#", "");
	if (cleaned.length !== 6) {
		return null;
	}
	const r = parseInt(cleaned.slice(0, 2), 16);
	const g = parseInt(cleaned.slice(2, 4), 16);
	const b = parseInt(cleaned.slice(4, 6), 16);
	if ([r, g, b].some((value) => Number.isNaN(value))) {
		return null;
	}
	return { r, g, b };
}

function lerp(a, b, t) {
	return a + (b - a) * t;
}

function lerpColor(lowHex, highHex, t) {
	const low = hexToRgb(lowHex);
	const high = hexToRgb(highHex);
	if (!low || !high) {
		return lowHex;
	}
	const clamped = Math.min(1, Math.max(0, t));
	const r = Math.round(lerp(low.r, high.r, clamped));
	const g = Math.round(lerp(low.g, high.g, clamped));
	const b = Math.round(lerp(low.b, high.b, clamped));
	return `rgb(${r}, ${g}, ${b})`;
}

function getAdvancedStopMetricRange(stops, metric) {
	let min = Number.POSITIVE_INFINITY;
	let max = Number.NEGATIVE_INFINITY;
	let found = false;
	stops.forEach((stop) => {
		const value = getAdvancedStopMetricValue(stop, metric);
		if (!Number.isFinite(value)) {
			return;
		}
		found = true;
		if (value < min) {
			min = value;
		}
		if (value > max) {
			max = value;
		}
	});
	return found ? { min, max } : null;
}

function getAdvancedStopMetricT(metric, value, range) {
	if (!Number.isFinite(value) || !range) {
		return null;
	}
	if (metric === "name_count") {
		const min = Math.log1p(Math.max(0, range.min));
		const max = Math.log1p(Math.max(0, range.max));
		const current = Math.log1p(Math.max(0, value));
		return max === min ? 1 : (current - min) / (max - min);
	}
	return range.max === range.min ? 1 : (value - range.min) / (range.max - range.min);
}

function buildStopPropsFromAdvancedStop(stop) {
	const routes = Array.isArray(stop?.routes) ? stop.routes : [];
	return {
		NAME: stop?.name || "",
		PLACE_ID: stop?.id || "",
		NAPTAN_ID: stop?.id || "",
		POSTCODE: stop?.postcode || "",
		BOROUGH: stop?.borough || "",
		region: stop?.region || "",
		STOP_LETTER: stop?.stop_letter || "",
		ROUTES: routes.join(", "),
		URL: stop?.url || "",
		child_stop_count: stop?.child_stop_count
	};
}

function buildAdvancedStopPopup(stop, options = {}) {
	const name = stop?.name || "Bus stop";
	const routes = Array.isArray(stop?.routes) ? stop.routes : [];
	const routeSets = appState.useRouteTypeColours ? appState.networkRouteSets : null;
	const metaParts = [];
	const metricKey = options?.colorBy || "";
	if (metricKey) {
		const value = getAdvancedStopMetricValue(stop, metricKey);
		if (Number.isFinite(value)) {
			const label = ADVANCED_STOP_METRIC_LABELS[metricKey] || metricKey;
			const formatted = formatAdvancedStopMetricValue(metricKey, value);
			if (formatted) {
				metaParts.push(`${label}: ${formatted}`);
			}
		}
	}
	if (stop?.borough && stop?.borough !== "Unknown") {
		metaParts.push(String(stop.borough));
	}
	const regionDisplay = getStopRegionDisplay(stop);
	if (regionDisplay) {
		metaParts.push(`Region ${regionDisplay}`);
	}
	const metaLine = metaParts.length > 0
		? `<div class="hover-popup__meta">${escapeHtml(metaParts.join(" | "))}</div>`
		: "";
	return `
		<div class="hover-popup__content">
			<div class="hover-popup__title">${escapeHtml(name)}</div>
			<div class="hover-popup__routes">${renderRoutePills(routes, routeSets)}</div>
			${metaLine}
		</div>
	`;
}

function renderAdvancedStopsLayer(stops, options = {}) {
	if (!appState.map) {
		return;
	}
	clearAdvancedStopsLayer();
	if (!Array.isArray(stops) || stops.length === 0) {
		return;
	}
	const colorMetric = options?.colorBy || "";
	const metricRange = colorMetric ? getAdvancedStopMetricRange(stops, colorMetric) : null;
	const layerGroup = L.layerGroup();
	stops.forEach((stop) => {
		const lat = Number(stop?.lat);
		const lon = Number(stop?.lon);
		if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
			return;
		}
		let fillColor = "#14b8a6";
		let strokeColor = "#0f766e";
		let radius = 4;
		if (colorMetric && metricRange) {
			const value = getAdvancedStopMetricValue(stop, colorMetric);
			if (Number.isFinite(value)) {
				const t = getAdvancedStopMetricT(colorMetric, value, metricRange);
				const palette = ADVANCED_STOP_GRADIENT.steps;
				const idx = Math.min(
					palette.length - 1,
					Math.max(0, Math.round((t ?? 0) * (palette.length - 1)))
				);
				fillColor = palette[idx];
				strokeColor = "#334155";
				radius = 3.5 + ((t ?? 0) * 2.5);
			} else {
				fillColor = ADVANCED_STOP_GRADIENT.fallback;
				strokeColor = ADVANCED_STOP_GRADIENT.fallbackStroke;
			}
		}
		const marker = L.circleMarker([lat, lon], {
			radius,
			weight: 1,
			color: strokeColor,
			fillColor,
			fillOpacity: 0.88,
			pane: STOP_PANE,
			interactive: true
		});
		bindHoverPopup(marker, () => buildAdvancedStopPopup(stop, options));
		marker.on("click", () => {
			const props = buildStopPropsFromAdvancedStop(stop);
			setSelectedFeature("stop", props);
			refreshSelectedInfoPanel().catch(() => {});
			updateSelectedInfo(getStopDisplayName(props));
		});
		marker.addTo(layerGroup);
	});
	layerGroup.addTo(appState.map);
	appState.advancedStopsLayer = layerGroup;
}

async function addBusStopsLayer(map, options = {}) {
	if (!map) {
		return null;
	}
	const showLoadingModal = options?.showLoadingModal !== false;
	if (showLoadingModal) {
		setLoadingModalMessage(BUS_STOP_LOADING_TITLE, BUS_STOP_LOADING_SUBTITLE);
		setLoadingModalVisible(true);
	}
	try {
		if (showLoadingModal) {
			await waitForNextUiPaint();
		}
		const loadToken = appState.busStopLoadToken;
		const geojson = await loadBusStopsGeojson();
		if (loadToken !== appState.busStopLoadToken) {
			return null;
		}

		clearBusStopsLayer();
		const routeSets = appState.useRouteTypeColours ? await loadNetworkRouteSets() : null;
		const result = filterBusStops(
			geojson,
			appState.busStopFilterDistrict,
			appState.busStopFilterBoroughs,
			appState.busStopFilterRouteCount
		);
		const renderer = L.svg({ pane: STOP_PANE });
		if (renderer._container) {
			renderer._container.style.pointerEvents = "auto";
		}
		appState.busStopRenderer = renderer;
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
				pane: STOP_PANE,
				renderer,
				interactive: true
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
			if (typeof marker.bringToFront === "function") {
				marker.bringToFront();
			}
		});

		layerGroup.addTo(map);
		appState.busStopLayer = layerGroup;
		updateBusStopFilterStatus(result.count, result.district, result.borough, appState.busStopFilterRouteCount);
		return layerGroup;
	} finally {
		if (showLoadingModal) {
			setLoadingModalVisible(false);
		}
	}
}

async function loadGaragesGeojson() {
	if (appState.garagesGeojson) {
		return appState.garagesGeojson;
	}
	const res = await fetch(GARAGES_GEOJSON_PATH);
	appState.garagesGeojson = await res.json();
	return appState.garagesGeojson;
}

async function loadBoroughsGeojson() {
	if (appState.boroughsGeojson) {
		return appState.boroughsGeojson;
	}
	const res = await fetch(BOROUGHS_GEOJSON_PATH, { cache: "no-store" });
	if (!res.ok) {
		appState.boroughsGeojson = null;
		return null;
	}
	appState.boroughsGeojson = await res.json();
	return appState.boroughsGeojson;
}

async function waitForBusStopsGeojsonPromise(promise, showLoadingModal) {
	if (!showLoadingModal) {
		return promise;
	}
	let modalShown = false;
	const modalTimer = window.setTimeout(() => {
		modalShown = true;
		setLoadingModalMessage(BUS_STOP_LOADING_TITLE, BUS_STOP_LOADING_SUBTITLE);
		setLoadingModalVisible(true);
	}, BUS_STOP_LOADING_MODAL_DELAY_MS);
	try {
		return await promise;
	} finally {
		window.clearTimeout(modalTimer);
		if (modalShown) {
			setLoadingModalVisible(false);
		}
	}
}

async function loadBusStopsGeojson(options = {}) {
	if (appState.busStopsGeojson) {
		return appState.busStopsGeojson;
	}
	const showLoadingModal = Boolean(options?.showLoadingModal);
	if (appState.busStopsGeojsonPromise) {
		return waitForBusStopsGeojsonPromise(appState.busStopsGeojsonPromise, showLoadingModal);
	}
	appState.busStopsGeojsonPromise = (async () => {
		try {
			const res = await fetch(BUS_STOPS_GEOJSON_PATH, { cache: "no-store" });
			if (!res.ok) {
				appState.busStopsGeojson = null;
				return null;
			}
			appState.busStopsGeojson = await res.json();
			if (!appState.stopRoutesIndex) {
				appState.stopRoutesIndex = buildStopRouteIndex(appState.busStopsGeojson);
			}
			const boroughs = await loadBoroughsGeojson();
			if (boroughs && !appState.boroughIndex) {
				appState.boroughIndex = buildBoroughIndex(boroughs);
			}
			appState.busStopBoroughLookup = buildStopBoroughLookup(appState.busStopsGeojson);
			return appState.busStopsGeojson;
		} finally {
			appState.busStopsGeojsonPromise = null;
		}
	})();
	return waitForBusStopsGeojsonPromise(appState.busStopsGeojsonPromise, showLoadingModal);
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
	if (window.RouteMapsterUtils?.normalisePostcodeDistrict) {
		return window.RouteMapsterUtils.normalisePostcodeDistrict(value);
	}
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

function normaliseBoroughToken(value) {
	if (window.RouteMapsterUtils?.normaliseBoroughToken) {
		return window.RouteMapsterUtils.normaliseBoroughToken(value);
	}
	if (!value) {
		return "";
	}
	return String(value)
		.replace(/&/g, " and ")
		.trim()
		.toLowerCase()
		.replace(/\s+/g, " ");
}

function buildRingBBox(ring) {
	if (window.RouteMapsterGeo?.buildRingBBox) {
		return window.RouteMapsterGeo.buildRingBBox(ring);
	}
	let minLon = Infinity;
	let minLat = Infinity;
	let maxLon = -Infinity;
	let maxLat = -Infinity;
	ring.forEach((point) => {
		const lon = point[0];
		const lat = point[1];
		if (lon < minLon) {
			minLon = lon;
		}
		if (lon > maxLon) {
			maxLon = lon;
		}
		if (lat < minLat) {
			minLat = lat;
		}
		if (lat > maxLat) {
			maxLat = lat;
		}
	});
	return [minLon, minLat, maxLon, maxLat];
}

function pointInRing(lon, lat, ring) {
	if (window.RouteMapsterGeo?.pointInRing) {
		return window.RouteMapsterGeo.pointInRing(lon, lat, ring);
	}
	let inside = false;
	let j = ring.length - 1;
	for (let i = 0; i < ring.length; i += 1) {
		const xi = ring[i][0];
		const yi = ring[i][1];
		const xj = ring[j][0];
		const yj = ring[j][1];
		const intersects = (yi > lat) !== (yj > lat)
			&& lon < ((xj - xi) * (lat - yi)) / ((yj - yi) || 1e-12) + xi;
		if (intersects) {
			inside = !inside;
		}
		j = i;
	}
	return inside;
}

function pointInPolygon(lon, lat, polygon) {
	if (window.RouteMapsterGeo?.pointInPolygon) {
		return window.RouteMapsterGeo.pointInPolygon(lon, lat, polygon);
	}
	if (!polygon || polygon.length === 0) {
		return false;
	}
	if (!pointInRing(lon, lat, polygon[0])) {
		return false;
	}
	for (let i = 1; i < polygon.length; i += 1) {
		if (pointInRing(lon, lat, polygon[i])) {
			return false;
		}
	}
	return true;
}

function buildBoroughIndex(geojson) {
	if (window.RouteMapsterGeo?.buildBoroughIndex) {
		return window.RouteMapsterGeo.buildBoroughIndex(geojson);
	}
	const features = Array.isArray(geojson?.features) ? geojson.features : [];
	const index = [];
	features.forEach((feature) => {
		const props = feature?.properties || {};
		const name = props.BOROUGH || props.Borough || props.borough;
		if (!name) {
			return;
		}
		const geometry = feature?.geometry || {};
		const geomType = geometry.type;
		const coords = geometry.coordinates;
		if (geomType === "Polygon" && Array.isArray(coords) && coords[0]) {
			index.push({
				name: String(name).trim(),
				coords,
				bbox: buildRingBBox(coords[0])
			});
			return;
		}
		if (geomType === "MultiPolygon" && Array.isArray(coords)) {
			coords.forEach((polygon) => {
				if (!Array.isArray(polygon) || !polygon[0]) {
					return;
				}
				index.push({
					name: String(name).trim(),
					coords: polygon,
					bbox: buildRingBBox(polygon[0])
				});
			});
		}
	});
	return index.filter((entry) => entry.name);
}

function findBoroughForPoint(lon, lat, index) {
	if (window.RouteMapsterGeo?.findBoroughForPoint) {
		return window.RouteMapsterGeo.findBoroughForPoint(lon, lat, index);
	}
	for (let i = 0; i < index.length; i += 1) {
		const entry = index[i];
		const [minLon, minLat, maxLon, maxLat] = entry.bbox;
		if (lon < minLon || lon > maxLon || lat < minLat || lat > maxLat) {
			continue;
		}
		if (pointInPolygon(lon, lat, entry.coords)) {
			return entry.name;
		}
	}
	return "";
}

async function hydrateStopBoroughs(geojson) {
	if (!geojson || !Array.isArray(geojson.features)) {
		return;
	}
	const boroughs = await loadBoroughsGeojson();
	if (!boroughs) {
		return;
	}
	if (!appState.boroughIndex) {
		appState.boroughIndex = buildBoroughIndex(boroughs);
	}
	const index = appState.boroughIndex || [];
	if (!index.length) {
		return;
	}
	geojson.features.forEach((feature) => {
		const props = feature?.properties || {};
		const existing = props?.borough || props?.BOROUGH || props?.Borough;
		if (existing) {
			return;
		}
		const coords = feature?.geometry?.coordinates;
		if (!Array.isArray(coords) || coords.length < 2) {
			return;
		}
		const lon = Number(coords[0]);
		const lat = Number(coords[1]);
		if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
			return;
		}
		const borough = findBoroughForPoint(lon, lat, index);
		if (borough) {
			props.BOROUGH = borough;
			feature.properties = props;
		}
	});
}

function normaliseBoroughTokens(value) {
	if (!value) {
		return [];
	}
	const tokens = Array.isArray(value)
		? value
		: String(value).split(/[;,]+/);
	const cleaned = tokens
		.map((token) => normaliseBoroughToken(token))
		.filter(Boolean);
	return Array.from(new Set(cleaned));
}

function formatBoroughToken(token) {
	const normalised = normaliseBoroughToken(token);
	if (!normalised) {
		return "";
	}
	const lookup = appState.busStopBoroughLookup;
	if (lookup && lookup.has(normalised)) {
		return lookup.get(normalised);
	}
	return normalised
		.split(/\s+/)
		.map((word) => (word ? word[0].toUpperCase() + word.slice(1) : ""))
		.join(" ");
}

function getStopBoroughToken(props) {
	return normaliseBoroughToken(props?.borough || props?.BOROUGH || props?.Borough || props?.["Borough"]);
}

function getStopBoroughTokenFromFeature(feature) {
	const props = feature?.properties || {};
	const existing = getStopBoroughToken(props);
	if (existing) {
		return existing;
	}
	const coords = feature?.geometry?.coordinates;
	if (!Array.isArray(coords) || coords.length < 2) {
		return "";
	}
	const lon = Number(coords[0]);
	const lat = Number(coords[1]);
	if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
		return "";
	}
	const cacheKey = props?.NAPTAN_ID || `${lon},${lat}`;
	if (appState.stopBoroughCache?.has(cacheKey)) {
		return appState.stopBoroughCache.get(cacheKey);
	}
	const index = appState.boroughIndex || [];
	if (!index.length) {
		return "";
	}
	const name = findBoroughForPoint(lon, lat, index);
	const token = normaliseBoroughToken(name);
	if (token) {
		props.BOROUGH = name;
		feature.properties = props;
		appState.stopBoroughCache.set(cacheKey, token);
	}
	return token;
}

function normalisePostcodeDistrictTokens(value) {
	if (!value) {
		return [];
	}
	const tokens = Array.isArray(value)
		? value
		: String(value).split(/[\s,]+/);
	const cleaned = tokens
		.map((token) => normalisePostcodeDistrict(token))
		.filter(Boolean);
	return Array.from(new Set(cleaned));
}

function buildStopBoroughLookup(geojson) {
	const lookup = new Map();
	const features = Array.isArray(geojson?.features) ? geojson.features : [];
	features.forEach((feature) => {
		const props = feature?.properties || {};
		if (!hasStopRoutes(props)) {
			return;
		}
		const raw = props?.borough || props?.BOROUGH || props?.Borough || props?.["Borough"];
		if (!raw) {
			return;
		}
		const display = String(raw).trim();
		if (!display) {
			return;
		}
		const token = normaliseBoroughToken(display);
		if (!token) {
			return;
		}
		if (!lookup.has(token)) {
			lookup.set(token, display);
		}
	});
	return lookup;
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
	return list.slice().sort(compareRouteIds);
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
	if (routeSortKeyCache.has(raw)) {
		return routeSortKeyCache.get(raw);
	}
	let key;
	if (ROUTE_SORT_NUMERIC_RE.test(raw)) {
		const value = Number(raw);
		if (value >= 1 && value <= 599) {
			key = [0, "", value, raw];
		} else if (value >= 600 && value <= 699) {
			key = [1, "", value, raw];
		} else {
			key = [2, "", value, raw];
		}
	} else if (raw.startsWith("SL")) {
		key = [4, "SL", parsePrefixNumber(raw.slice(2)), raw];
	} else if (raw.startsWith("N")) {
		key = [5, "N", parsePrefixNumber(raw.slice(1)), raw];
	} else {
		const match = raw.match(ROUTE_SORT_PREFIX_RE);
		if (match) {
			const prefix = match[1];
			const number = match[2] ? Number(match[2]) : 0;
			const suffix = match[3] || "";
			key = [3, prefix, number, suffix];
		} else {
			key = [9, raw, 0, ""];
		}
	}
	if (routeSortKeyCache.size >= ROUTE_SORT_KEY_CACHE_LIMIT) {
		routeSortKeyCache.clear();
	}
	routeSortKeyCache.set(raw, key);
	return key;
}

function parsePrefixNumber(value) {
	if (!value) {
		return 0;
	}
	const text = String(value);
	let end = 0;
	while (end < text.length) {
		const code = text.charCodeAt(end);
		if (code < 48 || code > 57) {
			break;
		}
		end += 1;
	}
	if (end === 0) {
		return 0;
	}
	return Number(text.slice(0, end));
}

function setBoundedCacheValue(cache, key, value, limit) {
	if (!cache) {
		return value;
	}
	if (cache.size >= limit) {
		cache.clear();
	}
	cache.set(key, value);
	return value;
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
	const centrality = buildCentralitySummaryFromProps(props);
	const metaLine = centrality
		? `<div class="hover-popup__meta">Centrality: ${escapeHtml(centrality)}</div>`
		: "";
	return `
		<div class="hover-popup__content">
			<div class="hover-popup__title">${escapeHtml(name)}</div>
			<div class="hover-popup__routes">${renderStopRoutePills(props, routes, routeSets)}</div>
			${metaLine}
		</div>
	`;
}

function buildBusStopInfoHtml(props, routeSets) {
	const name = getStopDisplayName(props);
	const road = getStopRoadName(props);
	const postcode = props?.POSTCODE || "";
	const stopCode = getStopCode(props);
	const stopLetter = getStopLetter(props);
	const titleHtml = stopLetter
		? `${escapeHtml(name)} <span class="info-title-badge">${escapeHtml(stopLetter)}</span>`
		: escapeHtml(name);
	const placeId = props?.PLACE_ID || "";
	const childStopCount = props?.child_stop_count ?? props?.CHILD_STOP_COUNT;
	const borough = props?.borough || props?.BOROUGH || "";
	const region = getStopRegionDisplay(props);
	const details = [
		road ? `Road: ${escapeHtml(road)}` : "",
		postcode ? `Postcode: ${escapeHtml(postcode)}` : "",
		placeId ? `Stop ID: ${escapeHtml(placeId)}` : (stopCode ? `Stop code: ${escapeHtml(stopCode)}` : ""),
		Number.isFinite(Number(childStopCount)) ? `Child stops: ${escapeHtml(Number(childStopCount))}` : "",
		borough ? `Borough: ${escapeHtml(borough)}` : "",
		region ? `Region: ${escapeHtml(region)}` : ""
	].filter(Boolean);

	const detailLines = details.length > 0
		? details.map((line) => `<div>${line}</div>`).join("")
		: '<div class="info-empty">No extra stop details listed.</div>';

	const routes = getStopRouteTokens(props);
	const centralityLines = buildCentralityDetailLines(props);
	const centralitySection = centralityLines.length > 0
		? `
			<div class="info-section">
				<div class="info-label">Centrality</div>
				${centralityLines.join("")}
			</div>
		`
		: "";
	return {
		title: name,
		titleHtml,
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
			${centralitySection}
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
	const tokens = new Set(extractRouteTokens(props?.ROUTES));
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

function getStopRouteCount(props) {
	return getStopRouteTokens(props).length;
}

function normaliseStopRouteCountValue(value) {
	const token = String(value ?? "").trim();
	if (!token || token === "any") {
		return "any";
	}
	if (token === "8+") {
		return "8";
	}
	const num = Number(token);
	if (Number.isFinite(num) && num > 0) {
		return String(Math.floor(num));
	}
	return "any";
}

function parseStopRouteCountFilter(value) {
	const token = normaliseStopRouteCountValue(value);
	if (token === "any") {
		return null;
	}
	const num = Number(token);
	if (Number.isFinite(num) && num > 0) {
		if (num >= 8) {
			return { min: num, max: null, label: `${num}+` };
		}
		return { min: num, max: num, label: String(num) };
	}
	return null;
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
	return getStopRouteCount(props) > 0;
}

function filterBusStops(geojson, district, boroughs, routeCountFilter) {
	const features = Array.isArray(geojson?.features) ? geojson.features : [];
	const districts = normalisePostcodeDistrictTokens(district);
	const boroughTokens = normaliseBoroughTokens(boroughs);
	const needsDistrict = districts.length > 0;
	const needsBorough = boroughTokens.length > 0;
	const routeCountSpec = parseStopRouteCountFilter(routeCountFilter);
	const needsRouteCount = Boolean(routeCountSpec);
	if (!needsDistrict && !needsBorough && !needsRouteCount) {
		const withRoutes = features.filter((feature) => {
			const props = feature?.properties || {};
			return hasStopRoutes(props);
		});
		return { features: withRoutes, count: withRoutes.length, district: [], borough: [], routeCount: null };
	}
	const districtSet = needsDistrict ? new Set(districts) : null;
	const boroughSet = needsBorough ? new Set(boroughTokens) : null;
	const filtered = features.filter((feature) => {
		const props = feature?.properties || {};
		const routeCount = getStopRouteCount(props);
		if (routeCount === 0) {
			return false;
		}
		if (needsRouteCount) {
			if (routeCount < routeCountSpec.min) {
				return false;
			}
			if (routeCountSpec.max !== null && routeCount > routeCountSpec.max) {
				return false;
			}
		}
		if (districtSet && !districtSet.has(getPostcodeDistrict(props))) {
			return false;
		}
		if (boroughSet) {
			const token = getStopBoroughTokenFromFeature(feature);
			if (!token || !boroughSet.has(token)) {
				return false;
			}
		}
		return true;
	});
	return { features: filtered, count: filtered.length, district: districts, borough: boroughTokens, routeCount: routeCountSpec };
}

function updateBusStopFilterStatus(count, district, boroughs, routeCountFilter) {
	const status = document.getElementById("busStopFilterStatus");
	if (!status) {
		return;
	}
	const districts = normalisePostcodeDistrictTokens(district);
	const boroughTokens = normaliseBoroughTokens(boroughs);
	const routeCountSpec = parseStopRouteCountFilter(routeCountFilter);
	const unitLabel = "stops";
	const parts = [];
	if (districts.length > 0) {
		parts.push(districts.length > 3 ? `${districts.length} districts` : districts.join(", "));
	}
	if (boroughTokens.length > 0) {
		const label = boroughTokens.length > 3
			? `${boroughTokens.length} boroughs`
			: boroughTokens.map((token) => formatBoroughToken(token)).join(", ");
		parts.push(label);
	}
	if (routeCountSpec) {
		const label = routeCountSpec.max === null
			? `${routeCountSpec.label} routes`
			: `${routeCountSpec.label} route${routeCountSpec.label === "1" ? "" : "s"}`;
		parts.push(label);
	}
	if (parts.length > 0) {
		status.textContent = `Showing ${count} ${unitLabel} matching ${parts.join(" + ")}.`;
	} else {
		status.textContent = `Showing all ${unitLabel}.`;
	}
}

function updateBusStopVisibilityNote() {
	const note = document.getElementById("busStopVisibilityNote");
	if (!note) {
		return;
	}
	const showStops = document.getElementById("showBusStops");
	if (!showStops || !showStops.checked) {
		note.textContent = "Bus stops are hidden. Enable \"Show bus stops\" to see filtered results.";
		return;
	}
	note.textContent = "";
}

function updateRouteFilterVisibilityNote() {
	const note = document.getElementById("routeFilterStatus");
	if (!note) {
		return;
	}
	if (appState.suppressNetworkRoutes || appState.focusRouteId) {
		note.textContent = "Network routes are hidden while another layer is in focus.";
		return;
	}
	const showAll = document.getElementById("showAllRoutes")?.checked;
	const routeTypeIds = [
		"showNetworkRegularRoutes",
		"showNetworkPrefixRoutes",
		"showNetwork24hrRoutes",
		"showNetworkNightRoutes",
		"showNetworkSchoolRoutes"
	];
	const anyRouteType = Boolean(showAll) || routeTypeIds.some((id) => document.getElementById(id)?.checked);
	if (!anyRouteType) {
		note.textContent = "All network route types are disabled. Enable one to see results.";
		return;
	}
	if (!appState.showNetworkRoutes) {
		note.textContent = appState.routeFilterTokens.length > 0
			? "No routes match the current filter."
			: "No network routes are currently visible with these filters.";
		return;
	}
	note.textContent = "";
}

async function refreshBusStopFilterStatus() {
	const geojson = await loadBusStopsGeojson();
	const result = filterBusStops(
		geojson,
		appState.busStopFilterDistrict,
		appState.busStopFilterBoroughs,
		appState.busStopFilterRouteCount
	);
	updateBusStopFilterStatus(result.count, result.district, result.borough, appState.busStopFilterRouteCount);
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

function getGarageGroupName(props) {
	return String(props?.["Group name"] || props?.["Company name"] || "").trim();
}

function getUniqueGarageDisplayFeatures(features) {
	if (!Array.isArray(features)) {
		return [];
	}
	const seen = new Set();
	const unique = [];
	features.forEach((feature) => {
		const props = feature?.properties || {};
		const code = getGarageCode(props);
		const name = String(props?.["Garage name"] || "").trim().toLowerCase();
		const group = getGarageGroupName(props).toLowerCase();
		const key = code ? `code:${code}` : `name:${name}|${group}`;
		if (seen.has(key)) {
			return;
		}
		seen.add(key);
		unique.push(feature);
	});
	return unique;
}

function buildGarageSelectKey(features) {
	const unique = getUniqueGarageDisplayFeatures(features);
	const codes = unique
		.map((feature) => getGarageCode(feature?.properties || {}))
		.filter(Boolean)
		.sort();
	if (codes.length > 0) {
		return `codes:${codes.join("|")}`;
	}
	const names = unique
		.map((feature) => String(feature?.properties?.["Garage name"] || "").trim())
		.filter(Boolean)
		.sort();
	if (names.length > 0) {
		return `names:${names.join("|")}`;
	}
	return "";
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
	const displayFeatures = getUniqueGarageDisplayFeatures(features);
	return displayFeatures.map((feature) => buildGarageSingleInfoHtml(feature)).join('<hr/>');
}

function buildGarageHoverHtml(features) {
	if (!features || features.length === 0) {
		return "";
	}
	const displayFeatures = getUniqueGarageDisplayFeatures(features);
	const routeSets = appState.useRouteTypeColours ? appState.networkRouteSets : null;
	return displayFeatures
		.map((feature) => {
			const p = feature.properties || {};
			const name = p["Garage name"] || p["TfL garage code"] || "Garage";
			const code = getGarageCode(p) || "N/A";
			const operator = getGarageGroupName(p) || "Operator";
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

	const displayFeatures = getUniqueGarageDisplayFeatures(features);
	const intro = displayFeatures.length > 1
		? `${displayFeatures.length} garages at this location`
		: "Garage location";
	const sections = displayFeatures.map((feature) => {
		const p = feature.properties || {};
		const name = p["Garage name"] || p["TfL garage code"] || "Garage";
		const code = getGarageCode(p) || "N/A";
		const operator = getGarageGroupName(p) || "Operator";
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
				<div>Group: ${escapeHtml(operator)}</div>
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
	const operator = getGarageGroupName(p) || "Operator";
	const pvr = formatGaragePvr(p);
	const routes = formatGarageRoutes(p);
	return `<div><div>${name} <b>${code}</b></div><div>Group: ${operator}</div><div>${pvr}</div><div>${routes}</div></div>`;
}

function buildGarageLabelHtml(features) {
	const displayFeatures = getUniqueGarageDisplayFeatures(features);
	const codes = getGarageCodes(displayFeatures);
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

function clearDetailsRouteHighlights() {
	clearFocusedRoute();
	clearActiveRouteSelections();
	clearOmniSearchLayers({ restoreNetwork: true });
	setGarageSelectValue("");
	if (appState.analysisActive) {
		clearAnalysisRoutes();
	}
	if (appState.suppressNetworkRoutes && !appState.advancedFiltersActive && !appState.analysisActive && !appState.omniActive) {
		appState.suppressNetworkRoutes = false;
	}
	if (!appState.suppressNetworkRoutes && appState.showNetworkRoutes) {
		appState.networkRouteLoadToken += 1;
		renderNetworkRoutes(appState.networkRouteLoadToken);
	}
	updateRouteFilterVisibilityNote();
}

function selectGarageRoutes(features) {
	clearOmniSearchLayers({ restoreNetwork: false });
	hideBusStopsIfVisible();
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
	extractRouteTokens(value).forEach((token) => set.add(token));
}

function extractRouteTokens(value) {
	if (!value) {
		return [];
	}
	const raw = String(value);
	if (routeTokenCache.has(raw)) {
		return routeTokenCache.get(raw);
	}
	const parts = raw.split(ROUTE_TOKEN_SPLIT_RE);
	const tokens = [];
	for (let i = 0; i < parts.length; i += 1) {
		const part = parts[i];
		if (!part) {
			continue;
		}
		const cleaned = part.trim().replace(ROUTE_TOKEN_STRIP_RE, '');
		if (!cleaned) {
			continue;
		}
		const token = cleaned.toUpperCase();
		if (isExcludedRoute(token)) {
			continue;
		}
		tokens.push(token);
	}
	return setBoundedCacheValue(routeTokenCache, raw, tokens, ROUTE_TOKEN_CACHE_LIMIT);
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
	const summaryRows = await loadRouteSummaryRows();
	const gj = await loadGaragesGeojson();
	const regular = new Set();
	const night = new Set();
	const school = new Set();
	const other = new Set();
	const twentyFour = new Set();
	if (Array.isArray(summaryRows)) {
		summaryRows.forEach((row) => {
			const routeId = String(row?.route_id_norm || row?.route_id || "").trim().toUpperCase();
			if (!routeId || isExcludedRoute(routeId)) {
				return;
			}
			const type = String(row?.route_type || "").trim().toLowerCase();
			if (type === "night") {
				night.add(routeId);
				return;
			}
			if (type === "school") {
				school.add(routeId);
				return;
			}
			if (type === "twentyfour") {
				twentyFour.add(routeId);
				return;
			}
			regular.add(routeId);
		});
	}
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

function toRadians(value) {
	return (Number(value) * Math.PI) / 180;
}

function haversineKm(lat1, lon1, lat2, lon2) {
	const phi1 = toRadians(lat1);
	const phi2 = toRadians(lat2);
	const dphi = toRadians(lat2 - lat1);
	const dlambda = toRadians(lon2 - lon1);
	const a = Math.sin(dphi / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dlambda / 2) ** 2;
	return 2 * EARTH_RADIUS_KM * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function segmentLengthKm(segment) {
	if (!Array.isArray(segment) || segment.length < 2) {
		return 0;
	}
	let total = 0;
	for (let i = 1; i < segment.length; i += 1) {
		const prev = segment[i - 1];
		const next = segment[i];
		if (!Array.isArray(prev) || !Array.isArray(next)) {
			continue;
		}
		total += haversineKm(prev[0], prev[1], next[0], next[1]);
	}
	return total;
}

function roundCoord(value, decimals = ENDPOINT_KEY_PRECISION) {
	if (!Number.isFinite(value)) {
		return "";
	}
	return Number(value).toFixed(decimals);
}

function buildEndpointPairKey(start, end) {
	if (!Array.isArray(start) || !Array.isArray(end)) {
		return "";
	}
	const startKey = `${roundCoord(start[0])},${roundCoord(start[1])}`;
	const endKey = `${roundCoord(end[0])},${roundCoord(end[1])}`;
	if (!startKey || !endKey) {
		return "";
	}
	return startKey < endKey ? `${startKey}|${endKey}` : `${endKey}|${startKey}`;
}

function computeSpatialStats(segments) {
	if (!Array.isArray(segments) || segments.length === 0) {
		return null;
	}
	let north = -Infinity;
	let south = Infinity;
	let east = -Infinity;
	let west = Infinity;
	let longest = null;
	let longestLength = 0;

	segments.forEach((segment) => {
		if (!Array.isArray(segment) || segment.length === 0) {
			return;
		}
		const length = segmentLengthKm(segment);
		if (length > longestLength) {
			longestLength = length;
			longest = segment;
		}
		segment.forEach((point) => {
			if (!Array.isArray(point) || point.length < 2) {
				return;
			}
			const lat = Number(point[0]);
			const lon = Number(point[1]);
			if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
				return;
			}
			if (lat > north) {
				north = lat;
			}
			if (lat < south) {
				south = lat;
			}
			if (lon > east) {
				east = lon;
			}
			if (lon < west) {
				west = lon;
			}
		});
	});

	if (!Number.isFinite(north) || !Number.isFinite(south) || !Number.isFinite(east) || !Number.isFinite(west)) {
		return null;
	}

	let start = null;
	let end = null;
	if (Array.isArray(longest) && longest.length > 0) {
		start = longest[0];
		end = longest[longest.length - 1];
	}

	return {
		northmost_lat: north,
		southmost_lat: south,
		eastmost_lon: east,
		westmost_lon: west,
		endpoint_start_lat: Array.isArray(start) ? Number(start[0]) : null,
		endpoint_start_lon: Array.isArray(start) ? Number(start[1]) : null,
		endpoint_end_lat: Array.isArray(end) ? Number(end[0]) : null,
		endpoint_end_lon: Array.isArray(end) ? Number(end[1]) : null,
		endpoint_pair_key: buildEndpointPairKey(start, end)
	};
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
		let summaryIndex = null;
		try {
			summaryIndex = await ensureRouteSummaryIndex();
		} catch (error) {
			summaryIndex = null;
		}
		const isTwentyFourSummaryRoute = (row) => {
			const token = String(row?.route_type || "").trim().toLowerCase();
			return token === "twentyfour" || token === "24hr" || token === "24hour" || token === "24-hour";
		};
		const isGhostNightVariantOfTwentyFour = (routeId) => {
			if (!summaryIndex || !(summaryIndex instanceof Map) || !routeId || !routeId.startsWith("N")) {
				return false;
			}
			if (summaryIndex.has(routeId)) {
				return false;
			}
			const baseRouteId = routeId.slice(1);
			if (!baseRouteId) {
				return false;
			}
			const baseRow = summaryIndex.get(baseRouteId);
			return isTwentyFourSummaryRoute(baseRow);
		};
		const routeIds = new Set(
			routes
				.map((routeId) => String(routeId).trim().toUpperCase())
				.filter((routeId) => routeId && !isExcludedRoute(routeId))
				.filter((routeId) => !isGhostNightVariantOfTwentyFour(routeId))
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
						interactive: true,
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
	const showRegular = isRouteTypeEnabled('showRegularRoutes');
	const showNight = isRouteTypeEnabled('showNightRoutes');
	const showSchool = isRouteTypeEnabled('showSchoolRoutes');
	const regularRoutes = appState.activeGarageRoutes?.regular
		? new Set(appState.activeGarageRoutes.regular)
		: null;
	const nightRoutes = appState.activeGarageRoutes?.night
		? new Set(appState.activeGarageRoutes.night)
		: null;
	const schoolRoutes = appState.activeGarageRoutes?.school
		? new Set(appState.activeGarageRoutes.school)
		: null;
	if (nightRoutes && regularRoutes) {
		nightRoutes.forEach((routeId) => regularRoutes.delete(routeId));
	}
	if (showRegular && regularRoutes && regularRoutes.size > 0) {
		categories.push({ type: "regular", color: ROUTE_COLOURS.regular, routes: regularRoutes });
	}
	if (showNight && nightRoutes && nightRoutes.size > 0) {
		categories.push({ type: "night", color: ROUTE_COLOURS.night, routes: nightRoutes });
	}
	if (showSchool && schoolRoutes && schoolRoutes.size > 0) {
		categories.push({ type: "school", color: ROUTE_COLOURS.school, routes: schoolRoutes });
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
		appState.showNetworkRoutes = false;
		updateRouteFilterVisibilityNote();
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
		updateRouteFilterVisibilityNote();
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
		updateRouteFilterVisibilityNote();
		return;
	}
	updateSelectedRouteCount(displayRoutes.size);

	appState.showNetworkRoutes = true;
	updateRouteFilterVisibilityNote();
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
							interactive: true,
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
			if (segments) {
				appState.routeGeometryCache.set(normalised, segments);
			}
			return segments;
		}
		if (response.status === 404) {
			appState.routeGeometryCache.set(normalised, null);
		}
	} catch (error) {
		segments = null;
	}
	return segments;
}

async function loadRouteSpatialStats(routeId) {
	const normalised = String(routeId || "").toUpperCase();
	if (!normalised || isExcludedRoute(normalised)) {
		return null;
	}
	if (appState.routeSpatialCache.has(normalised)) {
		return appState.routeSpatialCache.get(normalised);
	}
	if (appState.routeSpatialPromises.has(normalised)) {
		return appState.routeSpatialPromises.get(normalised);
	}
	const promise = loadRouteGeometry(normalised)
		.then((segments) => {
			const stats = computeSpatialStats(segments || []);
			if (stats) {
				appState.routeSpatialCache.set(normalised, stats);
			}
			return stats;
		})
		.catch(() => {
			return null;
		})
		.finally(() => {
			appState.routeSpatialPromises.delete(normalised);
		});
	appState.routeSpatialPromises.set(normalised, promise);
	return promise;
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
	const openPopupAtEvent = (event) => {
		const content = getContent(event);
		if (content !== undefined) {
			layer.setPopupContent(content);
		}
		const latlng = event?.latlng || (layer.getBounds ? layer.getBounds().getCenter() : null);
		if (latlng) {
			layer.openPopup(latlng);
		} else {
			layer.openPopup();
		}
	};
	layer.on("mouseover", openPopupAtEvent);
	if (typeof layer.getLatLngs === "function") {
		layer.on("mousemove", openPopupAtEvent);
	}
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

function getRouteGeometrySelection(line, layerGroup, latlng) {
	const tolerance = appState.showFrequencyLayer ? 16 : 8;
	let routes = collectRoutesNearLatLng(layerGroup, latlng, line?._routeId, tolerance);
	if ((!routes || routes.length === 0) && line?._routeId) {
		routes = [line._routeId];
	}
	const routeSets = appState.useRouteTypeColours ? appState.networkRouteSets : null;
	let displayRoutes = routes;
	let frequencyTotal = null;
	if (appState.showFrequencyLayer) {
		const band = appState.frequencyBand || "peak_am";
		displayRoutes = filterRoutesByFrequency(routes, band);
		frequencyTotal = getFrequencyTotalForRoutes(displayRoutes, band);
	}
	return {
		tolerance,
		routes,
		displayRoutes,
		frequencyTotal,
		routeSets
	};
}

function buildRouteGeometryHoverHtml(routes, routeSets, frequencyTotal) {
	const frequencyLine = Number.isFinite(frequencyTotal) && frequencyTotal > 0
		? `<div class="hover-popup__meta">Combined frequency: ${formatFrequencyValue(frequencyTotal)}</div>`
		: "";
	const title = routes && routes.length === 1
		? `Route ${escapeHtml(routes[0])}`
		: "Routes here";
	return `
		<div class="hover-popup__content">
			<div class="hover-popup__title">${title}</div>
			${frequencyLine}
			<div class="hover-popup__routes">${renderRoutePills(routes, routeSets)}</div>
		</div>
	`;
}

function setRouteGeometryInfoPanel({ routes, routeSets, frequencyTotal }) {
	const safeRoutes = Array.isArray(routes) ? routes : [];
	const title = safeRoutes.length === 1 ? `Route ${safeRoutes[0]}` : "Routes here";
	setInfoPanel({
		title,
		subtitle: "Route geometry",
		bodyHtml: `
			${Number.isFinite(frequencyTotal) && frequencyTotal > 0
				? `
					<div class="info-section">
						<div class="info-label">Combined frequency</div>
						<div>${escapeHtml(formatFrequencyValue(frequencyTotal))}</div>
					</div>
				`
				: ""}
			<div class="info-section">
				<div class="info-label">Routes here</div>
				${renderRoutePills(safeRoutes, routeSets)}
			</div>
		`
	});
	setInfoPanelVisible(true);
	appState.infoPanelKind = "route-geometry";
}

function captureInfoPanelSnapshot() {
	const appRoot = document.getElementById("app");
	const titleEl = document.getElementById("infoTitle");
	const subtitleEl = document.getElementById("infoSubtitle");
	const bodyEl = document.getElementById("infoBody");
	return {
		title: titleEl?.textContent || "Details",
		titleHtml: titleEl?.innerHTML || "",
		subtitle: subtitleEl && subtitleEl.style.display !== "none" ? (subtitleEl.textContent || "") : "",
		bodyHtml: bodyEl?.innerHTML || "",
		visible: Boolean(appRoot?.classList.contains("has-details")),
		kind: appState.infoPanelKind || null,
		selectedFeature: appState.selectedFeature || null
	};
}

function restoreInfoPanelSnapshot(snapshot) {
	if (!snapshot) {
		return;
	}
	setInfoPanel({
		title: snapshot.title || "Details",
		titleHtml: snapshot.titleHtml || "",
		subtitle: snapshot.subtitle || "",
		bodyHtml: snapshot.bodyHtml || ""
	});
	setInfoPanelVisible(snapshot.visible !== false);
	appState.infoPanelKind = snapshot.kind || null;
	appState.selectedFeature = snapshot.selectedFeature || null;
}

function pushInfoPanelBackSnapshot() {
	const snapshot = captureInfoPanelSnapshot();
	if (!snapshot.visible) {
		return;
	}
	if (!Array.isArray(appState.infoPanelBackStack)) {
		appState.infoPanelBackStack = [];
	}
	appState.infoPanelBackStack.push(snapshot);
	if (appState.infoPanelBackStack.length > 12) {
		appState.infoPanelBackStack = appState.infoPanelBackStack.slice(-12);
	}
}

function popInfoPanelBackSnapshot() {
	if (!Array.isArray(appState.infoPanelBackStack) || appState.infoPanelBackStack.length === 0) {
		return null;
	}
	return appState.infoPanelBackStack.pop() || null;
}

async function openRouteGeometryInfoPanel(line, layerGroup, event) {
	const selection = getRouteGeometrySelection(line, layerGroup, event?.latlng);
	const routesForPanel = Array.isArray(selection.displayRoutes) && selection.displayRoutes.length > 0
		? selection.displayRoutes
		: selection.routes;
	if (!Array.isArray(routesForPanel) || routesForPanel.length === 0) {
		return;
	}
	const routeSets = appState.useRouteTypeColours
		? (appState.networkRouteSets || await loadNetworkRouteSets().catch(() => null))
		: null;
	clearSelectedFeature();
	setRouteGeometryInfoPanel({
		routes: routesForPanel,
		routeSets,
		frequencyTotal: selection.frequencyTotal
	});
}

function bindRouteHoverPopup(line, layerGroup) {
	if (!line) {
		return;
	}
	bindHoverPopup(line, (event) => {
		const { displayRoutes, routeSets, frequencyTotal } = getRouteGeometrySelection(line, layerGroup, event?.latlng);
		return buildRouteGeometryHoverHtml(displayRoutes, routeSets, frequencyTotal);
	});
	line.on("click", (event) => {
		if (event?.originalEvent && window.L?.DomEvent?.stop) {
			window.L.DomEvent.stop(event.originalEvent);
		}
		openRouteGeometryInfoPanel(line, layerGroup, event).catch(() => {});
	});
}

function ensureRouteHoverPopup() {
	if (!appState.map) {
		return null;
	}
	if (!appState.routeHoverPopup) {
		appState.routeHoverPopup = L.popup({
			className: "hover-popup",
			closeButton: false,
			autoClose: false,
			closeOnClick: false,
			autoPan: false,
			offset: [0, -12]
		});
	}
	return appState.routeHoverPopup;
}

function closeRouteHoverPopup() {
	if (!appState.routeHoverPopup || !appState.map) {
		appState.routeHoverLastKey = "";
		return;
	}
	appState.map.closePopup(appState.routeHoverPopup);
	appState.routeHoverLastKey = "";
}

function shouldUseRouteHoverFallback() {
	if (!appState.map || appState.focusRouteId) {
		return false;
	}
	if (appState.analysisActive && appState.analysisRouteLayer) {
		return true;
	}
	if (appState.activeGarageRoutes && appState.garageRouteLayer) {
		return true;
	}
	if (appState.activeBusStationRoutes && appState.busStationRouteLayer) {
		return true;
	}
	return false;
}

function getActiveHoverLayerGroup() {
	if (appState.analysisActive && appState.analysisRouteLayer) {
		return appState.analysisRouteLayer;
	}
	if (appState.activeGarageRoutes && appState.garageRouteLayer) {
		return appState.garageRouteLayer;
	}
	if (appState.activeBusStationRoutes && appState.busStationRouteLayer) {
		return appState.busStationRouteLayer;
	}
	return null;
}

function updateRouteHoverPopup(latlng) {
	if (!shouldUseRouteHoverFallback()) {
		closeRouteHoverPopup();
		return;
	}
	const layerGroup = getActiveHoverLayerGroup();
	if (!layerGroup || !latlng) {
		closeRouteHoverPopup();
		return;
	}
	if (appState.useRouteTypeColours && !appState.networkRouteSets) {
		loadNetworkRouteSets().catch(() => {});
	}
	const tolerance = appState.showFrequencyLayer ? 16 : 8;
	let routes = collectRoutesNearLatLng(layerGroup, latlng, null, tolerance);
	if (!routes || routes.length === 0) {
		closeRouteHoverPopup();
		return;
	}
	const routeSets = appState.useRouteTypeColours ? appState.networkRouteSets : null;
	let displayRoutes = routes;
	let frequencyTotal = null;
	if (appState.showFrequencyLayer) {
		const band = appState.frequencyBand || "peak_am";
		displayRoutes = filterRoutesByFrequency(routes, band);
		frequencyTotal = getFrequencyTotalForRoutes(displayRoutes, band);
	}
	if (!displayRoutes || displayRoutes.length === 0) {
		closeRouteHoverPopup();
		return;
	}
	const popup = ensureRouteHoverPopup();
	if (!popup) {
		return;
	}
	const key = `${displayRoutes.join(",")}|${appState.frequencyBand || ""}|${frequencyTotal ?? ""}`;
	if (key !== appState.routeHoverLastKey) {
		popup.setContent(buildRouteGeometryHoverHtml(displayRoutes, routeSets, frequencyTotal));
		appState.routeHoverLastKey = key;
	}
	popup.setLatLng(latlng);
	if (!popup.isOpen || !popup.isOpen()) {
		popup.openOn(appState.map);
	} else if (!appState.map.hasLayer(popup)) {
		popup.openOn(appState.map);
	} else {
		popup.update();
	}
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
		.filter((station) => station && station.stopCount > 0 && station.routeCount > 0);
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
	if (appState.busStationRenderer && appState.map) {
		appState.map.removeLayer(appState.busStationRenderer);
		appState.busStationRenderer = null;
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

function clearEndpointHighlight() {
	if (appState.endpointHighlightLayer && appState.map) {
		appState.map.removeLayer(appState.endpointHighlightLayer);
		appState.endpointHighlightLayer = null;
	}
}

function showEndpointPairOnMap(pair) {
	if (!appState.map) {
		return;
	}
	const points = [];
	if (Array.isArray(pair?.a) && Number.isFinite(pair.a[0]) && Number.isFinite(pair.a[1])) {
		points.push(L.latLng(pair.a[0], pair.a[1]));
	}
	if (Array.isArray(pair?.b) && Number.isFinite(pair.b[0]) && Number.isFinite(pair.b[1])) {
		points.push(L.latLng(pair.b[0], pair.b[1]));
	}
	if (points.length === 0) {
		return;
	}
	clearEndpointHighlight();
	const layer = L.layerGroup().addTo(appState.map);
	const styles = [
		{ color: "#0ea5e9", fill: "#7dd3fc" },
		{ color: "#f97316", fill: "#fdba74" }
	];
	points.forEach((latlng, index) => {
		const style = styles[index % styles.length];
		L.circleMarker(latlng, {
			radius: 10,
			weight: 3,
			color: style.color,
			fillColor: style.fill,
			fillOpacity: 0.5,
			interactive: false,
			pane: HIGHLIGHT_PANE
		}).addTo(layer);
	});
	appState.endpointHighlightLayer = layer;
	if (points.length > 1) {
		const bounds = L.latLngBounds(points).pad(0.25);
		appState.map.fitBounds(bounds);
	} else {
		appState.map.setView(points[0], 13);
	}
}

function clearAnalysisRoutes() {
	if (appState.analysisRouteLayer && appState.map) {
		appState.map.removeLayer(appState.analysisRouteLayer);
		appState.analysisRouteLayer = null;
	}
	closeRouteHoverPopup();
	appState.analysisRouteLoadToken += 1;
	if (!appState.analysisActive) {
		return;
	}
	const restoreSuppress = appState.analysisPrevSuppress;
	appState.analysisActive = false;
	appState.analysisPrevSuppress = null;
	appState.suppressNetworkRoutes = Boolean(restoreSuppress);
	if (!appState.suppressNetworkRoutes) {
		appState.networkRouteLoadToken += 1;
		renderNetworkRoutes(appState.networkRouteLoadToken);
	}
}

async function showAnalysisRoutes(routeIds, options = {}) {
	if (!appState.map) {
		return;
	}
	const normaliseAnalysisRouteId = (value) => String(value || "").trim().toUpperCase();
	const list = Array.isArray(routeIds)
		? Array.from(new Set(routeIds.map((id) => normaliseAnalysisRouteId(id)).filter(Boolean)))
		: [];
	if (list.length === 0) {
		clearAnalysisRoutes();
		return;
	}

	const buildAnalysisGroupColour = (label, fallbackIndex = 0) => {
		const token = String(label || "").trim();
		if (!token) {
			return ANALYSIS_GROUP_COLOURS[fallbackIndex % ANALYSIS_GROUP_COLOURS.length];
		}
		let hash = 0;
		for (let i = 0; i < token.length; i += 1) {
			hash = ((hash << 5) - hash) + token.charCodeAt(i);
			hash |= 0;
		}
		return ANALYSIS_GROUP_COLOURS[Math.abs(hash) % ANALYSIS_GROUP_COLOURS.length];
	};

	const normaliseAnalysisGroups = (groups) => {
		if (!Array.isArray(groups)) {
			return [];
		}
		return groups.map((group, index) => {
			const label = String(group?.label || group?.name || "").trim() || `Group ${index + 1}`;
			const routes = Array.isArray(group?.routes)
				? Array.from(new Set(group.routes.map((routeId) => normaliseAnalysisRouteId(routeId)).filter(Boolean)))
				: [];
			const color = String(group?.color || "").trim() || buildAnalysisGroupColour(label, index);
			return { label, routes, color };
		}).filter((group) => group.routes.length > 0);
	};

	const groupedRoutes = normaliseAnalysisGroups(options.groups);
	const routeColourLookup = new Map();
	groupedRoutes.forEach((group, index) => {
		const color = group.color || buildAnalysisGroupColour(group.label, index);
		group.routes.forEach((routeId) => {
			if (!routeColourLookup.has(routeId)) {
				routeColourLookup.set(routeId, color);
			}
		});
	});

	if (!appState.analysisActive) {
		appState.analysisPrevSuppress = appState.suppressNetworkRoutes;
	}
	appState.analysisActive = true;
	appState.suppressNetworkRoutes = true;
	appState.networkRouteLoadToken += 1;
	clearNetworkRoutes();
	clearActiveRouteSelections();
	if (appState.focusRouteId) {
		appState.focusRouteId = null;
		appState.focusRouteLoadToken += 1;
		clearFocusedRouteLayer();
	}
	if (appState.filteredRoutesLayer) {
		appState.filteredRoutesLayer.clearLayers();
	}
	if (appState.analysisRouteLayer && appState.map) {
		appState.map.removeLayer(appState.analysisRouteLayer);
		appState.analysisRouteLayer = null;
	}
	const loadToken = appState.analysisRouteLoadToken + 1;
	appState.analysisRouteLoadToken = loadToken;
	const layerGroup = L.layerGroup().addTo(appState.map);
	appState.analysisRouteLayer = layerGroup;

	const routeSets = routeColourLookup.size === 0 && appState.useRouteTypeColours
		? await loadNetworkRouteSets()
		: null;
	const concurrency = 6;
	let index = 0;
	const worker = async () => {
		while (index < list.length) {
			const routeId = list[index];
			index += 1;
			const segments = await loadRouteGeometry(routeId);
			if (loadToken !== appState.analysisRouteLoadToken) {
				return;
			}
			if (!segments || segments.length === 0) {
				continue;
			}
			const color = routeColourLookup.get(routeId) || getFocusedRouteColour(routeId, routeSets);
			segments.forEach((segment) => {
				const line = L.polyline(segment, {
					color,
					weight: 3.2,
					opacity: 0.85,
					interactive: true,
					pane: ROUTE_PANE
				}).addTo(layerGroup);
				line._routeId = routeId;
				bindRouteHoverPopup(line, layerGroup);
			});
		}
	};
	await Promise.all(Array.from({ length: concurrency }, () => worker()));
	if (loadToken === appState.analysisRouteLoadToken) {
		if (groupedRoutes.length > 0) {
			const groupLabel = String(options.groupLabel || "group").trim();
			const suffix = groupedRoutes.length === 1 ? "" : "s";
			updateSelectedInfo(`Analysis routes: ${list.length} across ${groupedRoutes.length} ${groupLabel}${suffix}.`);
		} else {
			updateSelectedInfo(`Shared endpoint routes: ${list.length}`);
		}
	}
}

function clearBusStationRoutes() {
	if (appState.busStationRouteLayer && appState.map) {
		appState.map.removeLayer(appState.busStationRouteLayer);
		appState.busStationRouteLayer = null;
	}
	closeRouteHoverPopup();
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
	clearOmniSearchLayers({ restoreNetwork: false });
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
	clearOmniStopsLayer();
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
	if (appState.busStationRenderer && appState.map) {
		appState.map.removeLayer(appState.busStationRenderer);
		appState.busStationRenderer = null;
	}
	if (appState.useRouteTypeColours) {
		await loadNetworkRouteSets();
	}
	const renderer = L.svg({ pane: STATION_PANE });
	if (renderer._container) {
		renderer._container.style.pointerEvents = "auto";
	}
	appState.busStationRenderer = renderer;
	const scaleEnabled = isBusStationScaleEnabled();
	const maxRoutes = scaleEnabled ? getBusStationScaleMax(stations) : 0;
	const layerGroup = L.layerGroup();
	stations.forEach((station) => {
		if (!station.latlng || !Number.isFinite(station.stopCount) || station.stopCount <= 0 || !station.routeCount) {
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
			pane: STATION_PANE,
			renderer,
			interactive: true
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
	clearOmniSearchLayers({ restoreNetwork: false });
	hideBusStopsIfVisible();
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

function ensureGaragesVisible() {
	const checkbox = document.getElementById("showGarages");
	if (!checkbox) {
		return;
	}
	if (!checkbox.checked) {
		checkbox.checked = true;
		appState.garageLoadToken += 1;
		addGaragesLayer(appState.map).catch(() => {});
	}
}

function setBusStationSelectValue(key) {
	const select = document.getElementById("busStationSelect");
	if (!select) {
		return;
	}
	select.value = key || "";
}

function setGarageSelectValue(key) {
	const select = document.getElementById("garageSelect");
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
						interactive: true,
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

function setupSidebarResize() {
	const sidebar = document.getElementById("sidebar");
	const handle = document.getElementById("sidebarResizeHandle");
	if (!sidebar || !handle) {
		return;
	}
	const parsePx = (value, fallback) => {
		const num = Number.parseFloat(String(value || "").trim());
		return Number.isFinite(num) ? num : fallback;
	};
	let startX = 0;
	let startWidth = 0;
	let minWidth = 0;
	let maxWidth = 0;
	let isResizing = false;

	const refreshBounds = () => {
		const rootStyles = getComputedStyle(document.documentElement);
		minWidth = parsePx(rootStyles.getPropertyValue("--sidebar-min"), 300);
		maxWidth = parsePx(rootStyles.getPropertyValue("--sidebar-max"), 480);
	};

	const applyWidth = (clientX) => {
		const delta = clientX - startX;
		const next = Math.min(maxWidth, Math.max(minWidth, startWidth + delta));
		document.documentElement.style.setProperty("--sidebar-width", `${Math.round(next)}px`);
	};

	const onMouseMove = (event) => {
		if (!isResizing) {
			return;
		}
		applyWidth(event.clientX);
	};

	const onTouchMove = (event) => {
		if (!isResizing || !event.touches || event.touches.length === 0) {
			return;
		}
		applyWidth(event.touches[0].clientX);
		event.preventDefault();
	};

	const stopResize = () => {
		if (!isResizing) {
			return;
		}
		isResizing = false;
		document.body.classList.remove("is-resizing");
		window.removeEventListener("mousemove", onMouseMove);
		window.removeEventListener("mouseup", stopResize);
		window.removeEventListener("touchmove", onTouchMove);
		window.removeEventListener("touchend", stopResize);
		window.removeEventListener("touchcancel", stopResize);
	};

	const startResize = (clientX) => {
		refreshBounds();
		startX = clientX;
		startWidth = sidebar.getBoundingClientRect().width;
		isResizing = true;
		document.body.classList.add("is-resizing");
		window.addEventListener("mousemove", onMouseMove);
		window.addEventListener("mouseup", stopResize, { once: true });
		window.addEventListener("touchmove", onTouchMove, { passive: false });
		window.addEventListener("touchend", stopResize, { once: true });
		window.addEventListener("touchcancel", stopResize, { once: true });
	};

	handle.addEventListener("mousedown", (event) => {
		if (event.button !== 0 || isResizing) {
			return;
		}
		event.preventDefault();
		startResize(event.clientX);
	});

	handle.addEventListener(
		"touchstart",
		(event) => {
			if (!event.touches || event.touches.length !== 1 || isResizing) {
				return;
			}
			startResize(event.touches[0].clientX);
			event.preventDefault();
		},
		{ passive: false }
	);
}


function setupUI() {
	setupModuleAccordion();
	setupFrequencyModule();
	setupRouteFilterInput();
	setupBusStopFilterInput();
	setupBusStationSelect();
	setupGarageSelect();
	setupNetworkFilterDrag();
	setupKeyboardShortcutsModal();
	setupKeyboardShortcuts();
	setupAboutModal();
	setupOmniSearch();
	setupSidebarResize();
	applyMobileSelectOptionCompaction();
	window.addEventListener("resize", () => applyMobileSelectOptionCompaction());
	window.addEventListener("orientationchange", () => applyMobileSelectOptionCompaction());
	document.addEventListener("focusin", (event) => {
		if (event.target?.closest?.("select.select-field")) {
			applyMobileSelectOptionCompaction();
		}
	});
	document.addEventListener(
		"touchstart",
		(event) => {
			if (event.target?.closest?.("select.select-field")) {
				applyMobileSelectOptionCompaction();
			}
		},
		{ passive: true }
	);

	const closeInfoPanel = document.getElementById("closeInfoPanel");
	const closeInfoPanelAction = () => {
		if (appState.advancedResultsRouteReturnPending && window.RouteMapsterAdvancedFilters?.showResults) {
			clearDetailsRouteHighlights();
			resetInfoPanel();
			appState.advancedResultsRouteReturnPending = false;
			window.RouteMapsterAdvancedFilters.showResults();
			return;
		}
		clearDetailsRouteHighlights();
		resetInfoPanel();
	};
	if (closeInfoPanel) {
		closeInfoPanel.addEventListener("click", closeInfoPanelAction);
	}
	document.addEventListener("keydown", (event) => {
		if (event.key !== "Escape" || event.defaultPrevented) {
			return;
		}
		const appRoot = document.getElementById("app");
		if (!appRoot) {
			return;
		}
		const hasDetails = appRoot.classList.contains("has-details");
		const hasAdvancedResults = appRoot.classList.contains("has-advanced-results");
		if (!hasDetails && !hasAdvancedResults) {
			return;
		}
		const modalIds = ["omniSearchModal", "aboutModal", "keyboardShortcutsModal", "loadingModal"];
		const hasVisibleModal = modalIds.some((id) => {
			const modal = document.getElementById(id);
			return Boolean(modal && modal.classList.contains("is-visible"));
		});
		if (hasVisibleModal) {
			return;
		}
		event.preventDefault();
		if (hasDetails) {
			if (appState.infoPanelKind === "route") {
				if (appState.advancedResultsRouteReturnPending && window.RouteMapsterAdvancedFilters?.showResults) {
					closeInfoPanelAction();
					return;
				}
				const previous = popInfoPanelBackSnapshot();
				if (previous) {
					restoreInfoPanelSnapshot(previous);
					return;
				}
			}
			closeInfoPanelAction();
			return;
		}
		if (hasAdvancedResults && window.RouteMapsterAdvancedFilters?.dismissResults) {
			window.RouteMapsterAdvancedFilters.dismissResults({ restoreMap: true });
		}
	});

	const advancedFiltersModule = document.querySelector('[data-module="advanced-filters"]');
	if (advancedFiltersModule && window.RouteMapsterAdvancedFilters?.initAdvancedFilters) {
		window.RouteMapsterAdvancedFilters
			.initAdvancedFilters(advancedFiltersModule, appState)
			.then(() => applyMobileSelectOptionCompaction())
			.catch(() => {});
	}

	document.addEventListener("routeFiltersUpdated", (event) => {
		const detail = event?.detail || {};
		const spec = detail.filterSpec && typeof detail.filterSpec === "object" ? detail.filterSpec : {};
		const isActive = Object.keys(spec).length > 0;
		if (isActive) {
			if (!appState.advancedFiltersActive) {
				appState.advancedFiltersPrevSuppress = appState.suppressNetworkRoutes;
			}
			appState.advancedFiltersActive = true;
			if (!appState.suppressNetworkRoutes) {
				appState.suppressNetworkRoutes = true;
			}
			appState.networkRouteLoadToken += 1;
			clearNetworkRoutes();
			updateRouteFilterVisibilityNote();
			return;
		}

		if (appState.advancedFiltersActive) {
			appState.advancedFiltersActive = false;
			appState.suppressNetworkRoutes = Boolean(appState.advancedFiltersPrevSuppress);
			appState.advancedFiltersPrevSuppress = null;
			if (window.RouteMapsterAdvancedFilters?.clearMapHighlights) {
				window.RouteMapsterAdvancedFilters.clearMapHighlights(appState);
			}
			if (!appState.suppressNetworkRoutes) {
				appState.networkRouteLoadToken += 1;
				renderNetworkRoutes(appState.networkRouteLoadToken);
			}
			updateRouteFilterVisibilityNote();
		}
	});

	const advancedAnalysesModule = document.querySelector('[data-module="advanced-analyses"]');
	if (advancedAnalysesModule && window.RouteMapsterAdvancedAnalyses?.initAdvancedAnalyses) {
		window.RouteMapsterAdvancedAnalyses.initAdvancedAnalyses(advancedAnalysesModule, appState).catch(() => {});
	}

	const stopAnalysesModule = document.querySelector('[data-module="stop-analyses"]');
	if (stopAnalysesModule && window.RouteMapsterStopAnalyses?.initStopAnalyses) {
		const stopContainer = stopAnalysesModule.querySelector("#stopAnalysesContainer");
		const initStopAnalyses = () => {
			if (appState.stopAnalysesInitPromise) {
				return;
			}
			let modalShown = false;
			const modalTimer = window.setTimeout(() => {
				modalShown = true;
				setLoadingModalMessage(BUS_STOP_LOADING_TITLE, BUS_STOP_LOADING_SUBTITLE);
				setLoadingModalVisible(true);
			}, BUS_STOP_LOADING_MODAL_DELAY_MS);
			appState.stopAnalysesInitPromise = Promise.resolve(
				window.RouteMapsterStopAnalyses.initStopAnalyses(stopContainer || stopAnalysesModule, appState)
			)
				.catch(() => {})
				.finally(() => {
					window.clearTimeout(modalTimer);
					if (modalShown) {
						setLoadingModalVisible(false);
					}
				});
		};
		if (stopAnalysesModule.open) {
			initStopAnalyses();
		}
		stopAnalysesModule.addEventListener("toggle", () => {
			if (stopAnalysesModule.open) {
				initStopAnalyses();
			}
		});
	}

	const runAdvancedAnalysisById = (analysisId) => {
		const moduleEl = document.querySelector('[data-module="advanced-analyses"]');
		if (moduleEl) {
			moduleEl.open = true;
		}
		const select = document.getElementById("analysisSelect");
		if (select) {
			select.value = analysisId;
		}
		const runButton = document.getElementById("runAnalysis");
		if (runButton) {
			runButton.click();
			return;
		}
		const output = document.getElementById("analysisOutput");
		if (output) {
			output.innerHTML = '<div class="info-empty">Advanced analyses module unavailable.</div>';
		}
	};

	const clearAdvancedAnalysisOutput = () => {
		const output = document.getElementById("analysisOutput");
		if (output) {
			output.innerHTML = '<div class="info-empty">No analysis results yet.</div>';
		}
		if (window.RouteMapsterAPI?.clearAnalysisRoutes) {
			window.RouteMapsterAPI.clearAnalysisRoutes();
		}
		if (window.RouteMapsterAPI?.clearEndpointHighlight) {
			window.RouteMapsterAPI.clearEndpointHighlight();
		}
	};

	if (appState.map) {
		appState.map.on("mousemove", (event) => {
			if (!event?.latlng) {
				return;
			}
			if (appState.routeHoverFrame) {
				cancelAnimationFrame(appState.routeHoverFrame);
			}
			appState.routeHoverFrame = requestAnimationFrame(() => {
				appState.routeHoverFrame = null;
				updateRouteHoverPopup(event.latlng);
			});
		});
		["mouseout", "dragstart", "zoomstart", "click"].forEach((eventName) => {
			appState.map.on(eventName, () => {
				closeRouteHoverPopup();
			});
		});
	}

	document.getElementById('showGarages').addEventListener('change', (e) => {
		if (e.target.checked) {
			appState.garageLoadToken += 1;
			addGaragesLayer(appState.map);
			refreshStopsPanePriority();
			return;
		}
		appState.garageLoadToken += 1;
		clearGarageMarkers();
		clearGarageRoutes();
		refreshStopsPanePriority();
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
				refreshStopsPanePriority();
				addBusStopsLayer(appState.map).catch(() => {});
				updateBusStopVisibilityNote();
				return;
			}
			clearBusStopsLayer();
			refreshStopsPanePriority();
			updateSelectedInfo("Bus stops hidden.");
			updateBusStopVisibilityNote();
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
				refreshStopsPanePriority();
				addBusStationsLayer(appState.map).catch(() => {});
				return;
			}
			clearBusStationsLayer();
			clearBusStationHighlight();
			clearBusStationRoutes();
			refreshStopsPanePriority();
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

	refreshStopsPanePriority();

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

	const showRouteFamilies = document.getElementById("showRouteFamilies");
	if (showRouteFamilies) {
		showRouteFamilies.addEventListener("change", () => {
			if (showRouteFamilies.checked) {
				runAdvancedAnalysisById("route-families");
				return;
			}
			clearAdvancedAnalysisOutput();
		});
	}

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
			"showSchoolRoutes",
			"showRouteFamilies"
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
		clearAdvancedAnalysisOutput();
	};

	const clearAllLayers = document.getElementById("clearAllLayers");
	if (clearAllLayers) {
		clearAllLayers.addEventListener("click", () => {
			clearFocusedRoute();
			resetRouteCheckboxes();
			syncNetworkFilters();
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
			const frequencyToggle = document.getElementById("showFrequencyOverlay");
			if (frequencyToggle) {
				frequencyToggle.checked = false;
			}
			appState.showFrequencyLayer = false;

			clearGarageMarkers();
			clearGarageRoutes();
			clearBusStopsLayer();
			clearAdvancedStopsLayer();
			clearBusStationsLayer();
			clearBusStationHighlight();
			clearBusStationRoutes();
			clearNetworkRoutes();
			clearOmniSearchLayers({ restoreNetwork: false });
			if (window.RouteMapsterAdvancedFilters?.clearMapHighlights) {
				window.RouteMapsterAdvancedFilters.clearMapHighlights(appState);
			}
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
			clearOmniSearchLayers({ restoreNetwork: false });
			if (window.RouteMapsterAdvancedFilters?.clearMapHighlights) {
				window.RouteMapsterAdvancedFilters.clearMapHighlights(appState);
			}
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
			showRouteDetailsAndFocus(routeId).catch(() => {});
		});
	}

	if (appState.map) {
		const mapContainer = appState.map.getContainer();
		if (mapContainer) {
			mapContainer.addEventListener("click", (event) => {
				const target = event.target.closest(".hover-popup .route-pill");
				if (!target) {
					return;
				}
				const routeId = target.dataset.route;
				if (!routeId) {
					return;
				}
				event.preventDefault();
				event.stopPropagation();
				showRouteDetailsAndFocus(routeId).catch(() => {});
			});
		}
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
		updateRouteFilterVisibilityNote();
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
	updateRouteFilterVisibilityNote();
}

function setupBusStopFilterInput() {
	const districtInput = document.getElementById("busStopDistrictEntry");
	const districtList = document.getElementById("busStopDistrictTags");
	const boroughInput = document.getElementById("busStopBoroughEntry");
	const boroughList = document.getElementById("busStopBoroughTags");
	const boroughOptions = document.getElementById("busStopBoroughOptions");
	const routeCountInput = document.getElementById("busStopRouteCount");
	const applyButton = document.getElementById("applyBusStopFilter");
	const clearButton = document.getElementById("clearBusStopFilter");
	const exportButton = document.getElementById("exportBusStopFilterCsv");
	if (!districtInput || !districtList || !applyButton || !clearButton) {
		return;
	}

	let districtTokens = normalisePostcodeDistrictTokens(appState.busStopFilterDistrict);
	let boroughTokens = normaliseBoroughTokens(appState.busStopFilterBoroughs);
	let routeCount = normaliseStopRouteCountValue(appState.busStopFilterRouteCount);
	let boroughOptionsLoaded = false;
	let boroughOptionsLoadPromise = null;

	const renderTagList = (tokens, listEl, formatter) => {
		if (!listEl) {
			return;
		}
		listEl.innerHTML = tokens
			.map((token) => {
				const label = formatter ? formatter(token) : token;
				const safeToken = escapeHtml(token);
				const safeLabel = escapeHtml(label);
				return `<span class="tag-chip" data-token="${safeToken}">
					<span>${safeLabel}</span>
					<button type="button" class="tag-remove" aria-label="Remove ${safeLabel}">x</button>
				</span>`;
			})
			.join("");
	};

	const syncTags = () => {
		renderTagList(districtTokens, districtList, (token) => token);
		renderTagList(boroughTokens, boroughList, (token) => formatBoroughToken(token));
		if (routeCountInput) {
			routeCountInput.value = routeCount === "any" ? "" : routeCount;
		}
		clearButton.disabled = districtTokens.length === 0 && boroughTokens.length === 0 && routeCount === "any";
	};

	const applyTokens = async () => {
		appState.busStopFilterDistrict = districtTokens.slice();
		appState.busStopFilterBoroughs = boroughTokens.slice();
		appState.busStopFilterRouteCount = routeCount;
		await refreshBusStopFilterStatus();
		const showStops = document.getElementById("showBusStops");
		if (showStops && showStops.checked) {
			appState.busStopLoadToken += 1;
			addBusStopsLayer(appState.map, {
				showLoadingModal: !appState.busStopsGeojson
			}).catch(() => {});
		}
	};

	const applyAndRefresh = () => {
		applyTokens().catch(() => {});
	};

	const ensureBoroughOptionsLoaded = () => {
		if (!boroughOptions || boroughOptionsLoaded) {
			return Promise.resolve();
		}
		if (boroughOptionsLoadPromise) {
			return boroughOptionsLoadPromise;
		}
		boroughOptionsLoadPromise = loadBusStopsGeojson({ showLoadingModal: true })
			.then(() => {
				const lookup = appState.busStopBoroughLookup || buildStopBoroughLookup(appState.busStopsGeojson);
				appState.busStopBoroughLookup = lookup;
				const options = Array.from(lookup.entries())
					.map(([token, label]) => ({ token, label }))
					.sort((a, b) => a.label.localeCompare(b.label));
				if (options.length === 0 && appState.boroughIndex && appState.boroughIndex.length > 0) {
					const names = Array.from(new Set(appState.boroughIndex.map((entry) => entry.name)))
						.filter(Boolean)
						.sort((a, b) => a.localeCompare(b));
					boroughOptions.innerHTML = names
						.map((name) => `<option value="${escapeHtml(name)}"></option>`)
						.join("");
				} else {
					boroughOptions.innerHTML = options
						.map((option) => `<option value="${escapeHtml(option.label)}"></option>`)
						.join("");
				}
				boroughOptionsLoaded = true;
				syncTags();
			})
			.catch(() => {})
			.finally(() => {
				boroughOptionsLoadPromise = null;
			});
		return boroughOptionsLoadPromise;
	};

	const addDistrictTokensFromValue = (value) => {
		const newTokens = normalisePostcodeDistrictTokens(value);
		if (newTokens.length === 0) {
			return;
		}
		const tokenSet = new Set(districtTokens);
		newTokens.forEach((token) => {
			if (!tokenSet.has(token)) {
				districtTokens.push(token);
				tokenSet.add(token);
			}
		});
		syncTags();
		applyAndRefresh();
	};

	const addBoroughTokensFromValue = (value) => {
		const newTokens = normaliseBoroughTokens(value);
		if (newTokens.length === 0) {
			return { added: 0 };
		}
		const tokenSet = new Set(boroughTokens);
		let added = 0;
		newTokens.forEach((token) => {
			if (!tokenSet.has(token)) {
				boroughTokens.push(token);
				tokenSet.add(token);
				added += 1;
			}
		});
		if (added > 0) {
			syncTags();
			applyAndRefresh();
		}
		return { added };
	};

	const getKnownBoroughTokenSet = () => {
		const tokenSet = new Set();
		const lookup = appState.busStopBoroughLookup;
		if (lookup instanceof Map && lookup.size > 0) {
			lookup.forEach((_, token) => {
				const normalised = normaliseBoroughToken(token);
				if (normalised) {
					tokenSet.add(normalised);
				}
			});
		}
		if (tokenSet.size === 0 && Array.isArray(appState.boroughIndex) && appState.boroughIndex.length > 0) {
			appState.boroughIndex.forEach((entry) => {
				const token = normaliseBoroughToken(entry?.name);
				if (token) {
					tokenSet.add(token);
				}
			});
		}
		return tokenSet;
	};

	const parseBoroughInputTokens = (value) => {
		if (!value) {
			return [];
		}
		return String(value)
			.split(/[;,]+/)
			.map((token) => String(token || "").trim())
			.filter(Boolean);
	};

	const validateBoroughInputTokens = async (value) => {
		await ensureBoroughOptionsLoaded().catch(() => {});
		const rawTokens = parseBoroughInputTokens(value);
		if (rawTokens.length === 0) {
			return { valid: [], invalid: [] };
		}
		const known = getKnownBoroughTokenSet();
		const validSet = new Set();
		const invalidSet = new Set();
		rawTokens.forEach((raw) => {
			const token = normaliseBoroughToken(raw);
			if (!token) {
				return;
			}
			if (known.size > 0 && !known.has(token)) {
				invalidSet.add(raw);
				return;
			}
			validSet.add(token);
		});
		return { valid: Array.from(validSet), invalid: Array.from(invalidSet) };
	};

	const commitDistrictInput = () => {
		const value = districtInput.value.trim();
		if (!value) {
			return;
		}
		addDistrictTokensFromValue(value);
		districtInput.value = "";
	};

	const commitBoroughInput = async () => {
		if (!boroughInput) {
			return true;
		}
		const value = boroughInput.value.trim();
		if (!value) {
			boroughInput.setCustomValidity("");
			return true;
		}
		const parsed = await validateBoroughInputTokens(value);
		if (parsed.invalid.length > 0) {
			const label = parsed.invalid.join(", ");
			boroughInput.setCustomValidity(`Unknown borough: ${label}. Choose from the borough list.`);
			boroughInput.reportValidity();
			return false;
		}
		boroughInput.setCustomValidity("");
		addBoroughTokensFromValue(parsed.valid);
		boroughInput.value = "";
		return true;
	};

	applyButton.addEventListener("click", async () => {
		commitDistrictInput();
		const boroughOk = await commitBoroughInput();
		if (!boroughOk) {
			return;
		}
		if (routeCountInput) {
			routeCount = normaliseStopRouteCountValue(routeCountInput.value);
		}
		applyAndRefresh();
	});

	clearButton.addEventListener("click", () => {
		districtTokens = [];
		boroughTokens = [];
		routeCount = "any";
		districtInput.value = "";
		if (boroughInput) {
			boroughInput.value = "";
		}
		if (routeCountInput) {
			routeCountInput.value = "";
		}
		syncTags();
		applyAndRefresh();
	});

	districtInput.addEventListener("keydown", (event) => {
		if (event.key === "Enter" || event.key === " " || event.key === "Spacebar") {
			event.preventDefault();
			commitDistrictInput();
			return;
		}
		if (event.key === "Backspace" && districtInput.value.trim() === "" && districtTokens.length > 0) {
			event.preventDefault();
			districtTokens = districtTokens.slice(0, -1);
			syncTags();
			applyAndRefresh();
		}
	});

	districtInput.addEventListener("blur", () => {
		commitDistrictInput();
	});

	districtList.addEventListener("click", (event) => {
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
		districtTokens = districtTokens.filter((entry) => entry !== token);
		syncTags();
		applyAndRefresh();
	});

	if (boroughInput) {
		boroughInput.addEventListener("keydown", (event) => {
			if (event.key === "Enter") {
				event.preventDefault();
				commitBoroughInput().catch(() => {});
				return;
			}
			if (event.key === "Backspace" && boroughInput.value.trim() === "" && boroughTokens.length > 0) {
				event.preventDefault();
				boroughTokens = boroughTokens.slice(0, -1);
				syncTags();
				applyAndRefresh();
			}
		});

		boroughInput.addEventListener("blur", () => {
			commitBoroughInput().catch(() => {});
		});
		boroughInput.addEventListener("focus", () => {
			boroughInput.setCustomValidity("");
			ensureBoroughOptionsLoaded().catch(() => {});
		});
	}

	if (boroughList) {
		boroughList.addEventListener("click", (event) => {
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
			boroughTokens = boroughTokens.filter((entry) => entry !== token);
			syncTags();
			applyAndRefresh();
		});
	}

	if (routeCountInput) {
		routeCountInput.addEventListener("change", () => {
			routeCount = normaliseStopRouteCountValue(routeCountInput.value);
			syncTags();
			applyAndRefresh();
		});
	}

	if (exportButton) {
		exportButton.addEventListener("click", async () => {
			const geojson = await loadBusStopsGeojson();
			const result = filterBusStops(
				geojson,
				appState.busStopFilterDistrict,
				appState.busStopFilterBoroughs,
				appState.busStopFilterRouteCount
			);
			const features = result.features || [];
			if (features.length === 0) {
				return;
			}
			const columns = [
				"stop_id",
				"name",
				"routes_count",
				"routes",
				"borough",
				"district",
				"postcode",
				"lat",
				"lon"
			];
			const rows = features.map((feature) => {
				const props = feature?.properties || {};
				const coords = feature?.geometry?.coordinates || [];
				const lon = Number(coords[0]);
				const lat = Number(coords[1]);
				const routes = getStopRouteTokens(props);
				return [
					getStopPointIdFromProps(props),
					getStopDisplayName(props),
					routes.length,
					routes.join(" "),
					props?.borough || props?.BOROUGH || "",
					getPostcodeDistrict(props),
					props?.POSTCODE || "",
					Number.isFinite(lat) ? lat : "",
					Number.isFinite(lon) ? lon : ""
				];
			});
			downloadCsv("filtered_stops.csv", columns, rows);
		});
	}

	updateBusStopVisibilityNote();
	syncTags();
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

function setupKeyboardShortcuts() {
	const isEditableTarget = (target) => {
		if (!target) {
			return false;
		}
		const tag = target.tagName;
		if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
			return true;
		}
		if (target.isContentEditable) {
			return true;
		}
		return false;
	};

	const isModalOpen = () => {
		const omni = document.getElementById("omniSearchModal");
		if (omni && omni.classList.contains("is-visible")) {
			return true;
		}
		const about = document.getElementById("aboutModal");
		if (about && about.classList.contains("is-visible")) {
			return true;
		}
		const shortcuts = document.getElementById("keyboardShortcutsModal");
		if (shortcuts && shortcuts.classList.contains("is-visible")) {
			return true;
		}
		const loading = document.getElementById("loadingModal");
		if (loading && loading.classList.contains("is-visible")) {
			return true;
		}
		return false;
	};

	const openModule = (moduleId) => {
		const details = document.querySelector(`[data-module="${moduleId}"]`);
		if (details) {
			details.open = true;
			const summary = details.querySelector("summary") || details;
			const scrollHost = details.closest(".sidebar-scroll");
			if (scrollHost) {
				const hostRect = scrollHost.getBoundingClientRect();
				const summaryRect = summary.getBoundingClientRect();
				const targetTop = scrollHost.scrollTop + (summaryRect.top - hostRect.top) - 12;
				scrollHost.scrollTo({
					top: Math.max(0, targetTop),
					behavior: "smooth"
				});
			} else {
				summary.scrollIntoView({ behavior: "smooth", block: "start", inline: "nearest" });
			}
		}
	};

	const toggleCheckbox = (id, moduleId) => {
		const checkbox = document.getElementById(id);
		if (!checkbox) {
			return;
		}
		const next = !checkbox.checked;
		checkbox.checked = next;
		checkbox.dispatchEvent(new Event("change"));
		if (next && moduleId) {
			openModule(moduleId);
		}
	};

	const setNetworkRouteFilters = ({ showAll, regular, prefix, twentyfour, night, school }) => {
		openModule("routes");
		const showAllCheckbox = document.getElementById("showAllRoutes");
		if (showAll) {
			if (showAllCheckbox && !showAllCheckbox.checked) {
				showAllCheckbox.checked = true;
				showAllCheckbox.dispatchEvent(new Event("change"));
				return;
			}
			appState.networkRouteLoadToken += 1;
			renderNetworkRoutes(appState.networkRouteLoadToken);
			return;
		}

		if (showAllCheckbox && showAllCheckbox.checked) {
			showAllCheckbox.checked = false;
			showAllCheckbox.dispatchEvent(new Event("change"));
		}

		const entries = [
			["regular", "showNetworkRegularRoutes"],
			["prefix", "showNetworkPrefixRoutes"],
			["twentyfour", "showNetwork24hrRoutes"],
			["night", "showNetworkNightRoutes"],
			["school", "showNetworkSchoolRoutes"]
		];
		entries.forEach(([key, id]) => {
			const checkbox = document.getElementById(id);
			if (!checkbox) {
				return;
			}
			checkbox.disabled = false;
			delete checkbox.dataset.prevChecked;
			const label = checkbox.closest("label");
			if (label) {
				label.classList.remove("is-disabled");
			}
			checkbox.checked = Boolean({ regular, prefix, twentyfour, night, school }[key]);
		});

		appState.networkRouteLoadToken += 1;
		renderNetworkRoutes(appState.networkRouteLoadToken);
	};

	const showRoutes = () => {
		openModule("routes");
		const showAll = document.getElementById("showAllRoutes");
		if (showAll && !showAll.checked) {
			showAll.checked = true;
			showAll.dispatchEvent(new Event("change"));
			return;
		}
		appState.networkRouteLoadToken += 1;
		renderNetworkRoutes(appState.networkRouteLoadToken);
	};

	const clearAll = () => {
		const clearLayers = document.getElementById("clearAllLayers");
		if (clearLayers) {
			clearLayers.click();
		}
		const clearRoutes = document.getElementById("clearAllRoutes");
		if (clearRoutes) {
			clearRoutes.click();
		}
	};

	document.addEventListener("keydown", (event) => {
		if (event.defaultPrevented) {
			return;
		}
		if (event.ctrlKey || event.metaKey || event.altKey) {
			return;
		}
		if (isEditableTarget(event.target) || isModalOpen()) {
			return;
		}
		const key = String(event.key || "").toLowerCase();
		if (!key) {
			return;
		}

		switch (key) {
			case "g":
				event.preventDefault();
				toggleCheckbox("showGarages", "garages");
				break;
			case "b":
				event.preventDefault();
				toggleCheckbox("showBusStops", "stops");
				break;
			case "s":
				event.preventDefault();
				toggleCheckbox("showBusStations", "stations");
				break;
			case "f":
				event.preventDefault();
				toggleCheckbox("showFrequencyOverlay", "frequencies");
				break;
			case "r":
				event.preventDefault();
				showRoutes();
				break;
			case "a":
				event.preventDefault();
				setNetworkRouteFilters({
					showAll: true,
					regular: true,
					prefix: true,
					twentyfour: true,
					night: true,
					school: true
				});
				break;
			case "n":
				event.preventDefault();
				setNetworkRouteFilters({
					showAll: false,
					regular: false,
					prefix: false,
					twentyfour: false,
					night: true,
					school: false
				});
				break;
			case "p":
				event.preventDefault();
				setNetworkRouteFilters({
					showAll: false,
					regular: false,
					prefix: true,
					twentyfour: false,
					night: false,
					school: false
				});
				break;
			case "0":
			case "numpad0":
				event.preventDefault();
				setNetworkRouteFilters({
					showAll: false,
					regular: false,
					prefix: false,
					twentyfour: true,
					night: false,
					school: false
				});
				break;
			case "h":
				event.preventDefault();
				setNetworkRouteFilters({
					showAll: false,
					regular: false,
					prefix: false,
					twentyfour: false,
					night: false,
					school: true
				});
				break;
			case "x":
				event.preventDefault();
				openModule("advanced-filters");
				break;
			case "y":
				event.preventDefault();
				openModule("advanced-analyses");
				break;
			case "z":
				event.preventDefault();
				openModule("stop-analyses");
				break;
			case "c":
				event.preventDefault();
				clearAll();
				break;
			case "?":
				event.preventDefault();
				openKeyboardShortcutsModal();
				break;
			default:
				break;
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
			.filter((station) => Number.isFinite(station.stopCount) && station.stopCount > 0 && station.routeCount > 0)
			.slice()
			.sort((a, b) => a.name.localeCompare(b.name))
			.map((station) => `<option value="${escapeHtml(station.key)}">${escapeHtml(station.name)}</option>`)
			.join("");
		select.innerHTML = `<option value="">Choose a station</option>${options}`;
		applyMobileSelectOptionCompaction();
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

function setupGarageSelect() {
	const select = document.getElementById("garageSelect");
	if (!select) {
		return;
	}

	const populate = (entries) => {
		const options = entries
			.slice()
			.sort((a, b) => a.details.label.localeCompare(b.details.label))
			.map((entry) => `<option value="${escapeHtml(entry.selectKey)}">${escapeHtml(entry.details.label)}</option>`)
			.join("");
		select.innerHTML = `<option value="">Choose a garage</option>${options}`;
		applyMobileSelectOptionCompaction();
	};

	loadGaragesGeojson()
		.then((gj) => {
			if (!gj) {
				return;
			}
			const filteredGeojson = {
				...gj,
				features: Array.isArray(gj?.features)
					? gj.features.filter((feature) => garageHasRoutes(feature))
					: []
			};
			const groups = groupGaragesByLocation(filteredGeojson);
			const entries = groups
				.map((group) => {
					const details = buildGarageGroupDetails(group);
					const selectKey = buildGarageSelectKey(group.features);
					return { group, details, selectKey };
				})
				.filter((entry) => entry.selectKey);
			appState.garageSelectMap = new Map(entries.map((entry) => [entry.selectKey, entry.group]));
			if (entries.length > 0) {
				populate(entries);
			}
		})
		.catch(() => {});

	select.addEventListener("change", () => {
		const key = select.value;
		if (!key) {
			clearSelectedFeature();
			resetInfoPanel();
			return;
		}
		const group = appState.garageSelectMap?.get(key);
		if (!group) {
			return;
		}
		ensureGaragesVisible();
		setSelectedFeature("garage", group.features);
		refreshSelectedInfoPanel().catch(() => {});
		selectGarageRoutes(group.features);
		if (appState.map && group.latlng) {
			appState.map.flyTo(group.latlng, Math.max(appState.map.getZoom(), 12));
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

window.RouteMapsterAPI = {
	appState,
	loadRouteGeometry,
	loadRouteSpatialStats,
	sortRouteIds,
	compareRouteIds,
	getRoutePillClass,
	escapeHtml,
	setLoadingModalVisible,
	showEndpointPairOnMap,
	clearEndpointHighlight,
	showAnalysisRoutes,
	clearAnalysisRoutes,
	showAdvancedStops: (stops, options) => renderAdvancedStopsLayer(stops, options),
	clearAdvancedStops: () => clearAdvancedStopsLayer()
};

async function start() {
	setLoadingModalMessage(LOADING_MODAL_DEFAULT_TITLE, LOADING_MODAL_DEFAULT_SUBTITLE);
	setLoadingModalVisible(true);
	try {
		appState.map = initMap();
		await initialiseRouteGeometryIndex();
		setupUI();
		resetInfoPanel();
		appState.networkRouteLoadToken += 1;
		await renderNetworkRoutes(appState.networkRouteLoadToken);
		window.setTimeout(() => {
			if (appState.busStopsGeojson || appState.busStopsGeojsonPromise) {
				return;
			}
			loadBusStopsGeojson().catch(() => {});
		}, BUS_STOP_PREWARM_DELAY_MS);
	} finally {
		setLoadingModalVisible(false);
	}
}
document.addEventListener('DOMContentLoaded', start);
