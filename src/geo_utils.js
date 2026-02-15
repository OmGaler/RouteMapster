(() => {
  const REGION_LABELS = {
    C: "Central London",
    NE: "North East London",
    NW: "North West London",
    SW: "South West London",
    SE: "South East London"
  };

  const REGION_BY_BOROUGH = new Map([
    ["city of london", "C"],
    ["westminster", "C"],
    ["camden", "C"],
    ["islington", "C"],
    ["kensington and chelsea", "C"],
    ["lambeth", "C"],
    ["southwark", "C"],
    ["hackney", "NE"],
    ["tower hamlets", "NE"],
    ["newham", "NE"],
    ["waltham forest", "NE"],
    ["redbridge", "NE"],
    ["havering", "NE"],
    ["barking and dagenham", "NE"],
    ["haringey", "NE"],
    ["enfield", "NE"],
    ["barnet", "NW"],
    ["harrow", "NW"],
    ["brent", "NW"],
    ["ealing", "NW"],
    ["hammersmith and fulham", "NW"],
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

  const normaliseBoroughToken = (value) => {
    if (window.RouteMapsterUtils?.normaliseBoroughToken) {
      return window.RouteMapsterUtils.normaliseBoroughToken(value);
    }
    if (!value) {
      return "";
    }
    return String(value).trim().toLowerCase();
  };

  const getRegionTokenFromBorough = (borough) => {
    if (!borough) {
      return "";
    }
    return REGION_BY_BOROUGH.get(normaliseBoroughToken(borough)) || "";
  };

  const getRegionLabel = (token) => REGION_LABELS[token] || "";

  const buildRingBBox = (ring) => {
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
  };

  const pointInRing = (lon, lat, ring) => {
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
  };

  const pointInPolygon = (lon, lat, polygon) => {
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
  };

  const buildBoroughIndex = (geojson) => {
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
  };

  const findBoroughForPoint = (lon, lat, index) => {
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
  };

  window.RouteMapsterGeo = {
    REGION_LABELS,
    REGION_BY_BOROUGH,
    getRegionTokenFromBorough,
    getRegionLabel,
    buildRingBBox,
    pointInRing,
    pointInPolygon,
    buildBoroughIndex,
    findBoroughForPoint
  };
})();
