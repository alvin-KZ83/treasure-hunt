/* Geometry helpers. Points are [lat, lng] arrays or {lat, lng} objects; distances in metres. */
(function () {
  'use strict';

  const R = 6371008.8;
  const rad = (d) => (d * Math.PI) / 180;
  const deg = (r) => (r * 180) / Math.PI;
  const ll = (p) => (Array.isArray(p) ? { lat: p[0], lng: p[1] } : p);

  function distance(a, b) {
    a = ll(a); b = ll(b);
    const dLat = rad(b.lat - a.lat);
    const dLng = rad(b.lng - a.lng);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  // Initial compass bearing from a to b, 0–360° (0 = north).
  function bearing(a, b) {
    a = ll(a); b = ll(b);
    const y = Math.sin(rad(b.lng - a.lng)) * Math.cos(rad(b.lat));
    const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) -
      Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lng - a.lng));
    return (deg(Math.atan2(y, x)) + 360) % 360;
  }

  function compass(bearingDeg) {
    return ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'][
      Math.round(bearingDeg / 45) % 8
    ];
  }

  // Ray casting; poly = [[lat, lng], ...]
  function insidePolygon(p, poly) {
    p = ll(p);
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [yi, xi] = poly[i];
      const [yj, xj] = poly[j];
      if (yi > p.lat !== yj > p.lat && p.lng < ((xj - xi) * (p.lat - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  // Closest point on the polygon outline. Uses a local flat projection,
  // which is accurate for hunt-sized areas (a few km).
  function nearestOnPolygon(p, poly) {
    p = ll(p);
    const kx = rad(1) * R * Math.cos(rad(p.lat));
    const ky = rad(1) * R;
    const xy = ([lat, lng]) => [(lng - p.lng) * kx, (lat - p.lat) * ky];
    let best = null;
    for (let i = 0; i < poly.length; i++) {
      const [ax, ay] = xy(poly[i]);
      const [bx, by] = xy(poly[(i + 1) % poly.length]);
      const dx = bx - ax, dy = by - ay;
      const len2 = dx * dx + dy * dy;
      const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
      const x = ax + t * dx, y = ay + t * dy;
      const d = Math.hypot(x, y);
      if (!best || d < best.distance) best = { lat: p.lat + y / ky, lng: p.lng + x / kx, distance: d };
    }
    return best;
  }

  function formatDistance(m) {
    if (m < 1000) return `${Math.round(m)} m`;
    return `${(m / 1000).toFixed(m < 10000 ? 2 : 1)} km`;
  }

  // REGION is either [[lat, lng], ...] or GeoJSON pasted from geojson.io
  // ([lng, lat] order). The first Polygon / MultiPolygon outer edge is used; a
  // LineString drawn around the area also works (it is closed automatically).
  // Returns [[lat, lng], ...] without the repeated closing point. Throws a
  // readable message if it can't be used.
  const RING_OF = {
    Polygon: (c) => c[0],
    MultiPolygon: (c) => c[0][0],
    LineString: (c) => c,
    MultiLineString: (c) => c[0],
  };

  function parseRegion(region) {
    let ring;
    if (Array.isArray(region)) {
      ring = region;
    } else if (region && typeof region === 'object') {
      const geoms = region.type === 'FeatureCollection' ? (region.features || []).map((f) => f && f.geometry)
        : region.type === 'Feature' ? [region.geometry] : [region];
      const g = geoms.find((x) => x && /Polygon$/.test(x.type)) || geoms.find((x) => x && /LineString$/.test(x.type));
      if (!g) throw new Error('REGION: the GeoJSON has no shape in it. On geojson.io, draw around the area with the polygon tool.');
      ring = RING_OF[g.type](g.coordinates).map((p) => [p[1], p[0]]);
    } else {
      throw new Error('REGION is missing.');
    }
    ring = ring.map((p) => (Array.isArray(p) ? [Number(p[0]), Number(p[1])] : [NaN, NaN]));
    if (ring.some(([lat, lng]) => !Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180)) {
      throw new Error('REGION has a point that is not a valid [lat, lng] pair.');
    }
    const [first, last] = [ring[0], ring[ring.length - 1]];
    if (ring.length > 1 && first[0] === last[0] && first[1] === last[1]) ring = ring.slice(0, -1);
    if (ring.length < 3) throw new Error('REGION needs at least 3 corner points.');
    return ring;
  }

  // Flat x/y in metres, good enough over a few km.
  function projector(lat0) {
    const kx = rad(1) * R * Math.cos(rad(lat0));
    const ky = rad(1) * R;
    return ([lat, lng]) => [lng * kx, lat * ky];
  }

  function segmentDistance(p, a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2)) : 0;
    return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
  }

  // Douglas–Peucker for a closed ring [[lat, lng], ...]: drops every corner whose
  // removal moves the outline by less than toleranceM metres.
  function simplifyRing(ring, toleranceM) {
    const n = ring.length;
    const copy = () => ring.map((p) => [p[0], p[1]]);
    if (n <= 4) return copy();
    const xy = ring.map(projector(ring[0][0]));
    const from0 = (i) => Math.hypot(xy[i][0] - xy[0][0], xy[i][1] - xy[0][1]);
    let far = 1;
    for (let i = 2; i < n; i++) if (from0(i) > from0(far)) far = i;
    const keep = new Array(n).fill(false);
    keep[0] = keep[far] = true;
    const run = (chain) => { // chain: indices along the outline, both ends kept
      const stack = [[0, chain.length - 1]];
      while (stack.length) {
        const [s, e] = stack.pop();
        let worst = 0, at = -1;
        for (let i = s + 1; i < e; i++) {
          const d = segmentDistance(xy[chain[i]], xy[chain[s]], xy[chain[e]]);
          if (d > worst) { worst = d; at = i; }
        }
        if (worst > toleranceM) { keep[chain[at]] = true; stack.push([s, at], [at, e]); }
      }
    };
    const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
    run(range(0, far));
    run([...range(far, n - 1), 0]);
    const out = ring.filter((_, i) => keep[i]).map((p) => [p[0], p[1]]);
    return out.length >= 3 ? out : copy();
  }

  // Pairs of edges [i, j] that cross each other. A usable boundary has none.
  function crossings(ring) {
    const xy = ring.map(projector(ring[0][0]));
    const n = xy.length;
    const out = [];
    const side = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    for (let i = 0; i < n; i++) {
      for (let j = i + 2; j < n; j++) {
        if (i === 0 && j === n - 1) continue; // neighbours through the closing edge
        const a = xy[i], b = xy[(i + 1) % n], c = xy[j], d = xy[(j + 1) % n];
        if ((side(c, d, a) > 0) !== (side(c, d, b) > 0) && (side(a, b, c) > 0) !== (side(a, b, d) > 0)) out.push([i, j]);
      }
    }
    return out;
  }

  window.Geo = { distance, bearing, compass, insidePolygon, nearestOnPolygon, formatDistance, parseRegion, simplifyRing, crossings };
})();
