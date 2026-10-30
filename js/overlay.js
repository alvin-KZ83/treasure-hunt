/* An image laid over the map and pinned by three of its corners: top-left,
 * top-right and bottom-left (the fourth follows). This lets a drawing be
 * moved, scaled, rotated and slightly skewed to match the map exactly.
 * Used by the app (HUNT_CONFIG.OVERLAY) and by tools/align-drawing.html. */
(function () {
  'use strict';

  L.CornerImageOverlay = L.ImageOverlay.extend({
    initialize(url, corners, options) {
      this._corners = corners.map((c) => L.latLng(c));
      L.ImageOverlay.prototype.initialize.call(this, url, this._cornerBounds(), options);
      this.on('load', () => this._map && this._reset()); // the image's size is only known once it has loaded
    },

    getCorners() {
      return this._corners.slice();
    },

    setCorners(corners) {
      this._corners = corners.map((c) => L.latLng(c));
      this._bounds = this._cornerBounds();
      if (this._map) this._reset();
      return this;
    },

    _cornerBounds() {
      const [tl, tr, bl] = this._corners;
      return L.latLngBounds([tl, tr, bl, [tr.lat + bl.lat - tl.lat, tr.lng + bl.lng - tl.lng]]);
    },

    _reset() {
      this._place((ll) => this._map.latLngToLayerPoint(ll));
    },

    _animateZoom(e) {
      this._place((ll) => this._map._latLngToNewLayerPoint(ll, e.zoom, e.center));
    },

    // Draw the image at its natural size, then map its corners onto the three
    // map points with one CSS matrix: (0,0)→tl, (w,0)→tr, (0,h)→bl.
    _place(toPoint) {
      const img = this._image;
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      if (!w || !h) return;
      const [tl, tr, bl] = this._corners.map(toPoint);
      img.style.width = `${w}px`;
      img.style.height = `${h}px`;
      img.style.transformOrigin = '0 0';
      img.style.transform = `matrix(${(tr.x - tl.x) / w}, ${(tr.y - tl.y) / w}, ${(bl.x - tl.x) / h}, ${(bl.y - tl.y) / h}, ${tl.x}, ${tl.y})`;
    },
  });

  /* A drawing bent to fit the map. Warp points [across, down, lat, lng] pin
   * spots of the picture (across/down from 0 to 1; 0,0 = top-left) to places
   * on the map. The four corners must be among them. The picture is cut into
   * triangles between the points (Delaunay, in picture pixels) and each one is
   * stretched flat onto the map, so moving a point only bends the triangles
   * that touch it. The result is painted once onto a canvas, which Leaflet
   * then pans and zooms like any image: Web Mercator is linear at every zoom,
   * so the fit stays exact. Used by the app's debug view and by
   * HUNT_CONFIG.OVERLAY.warp. */
  const CRS = L.CRS.EPSG3857;
  const Z = 20;                                   // warp maths in Web Mercator pixels at zoom 20
  const FULL = { pixels: 12e6, side: 8192 };      // canvas limits (12 Mpx ≈ 48 MB)
  const PREVIEW = { pixels: 1.5e6, side: 2048 };  // while a point is being dragged

  const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
  const cross = (a, b) => a.x * b.y - a.y * b.x;

  function circumcircle(a, b, c) {
    const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
    const a2 = a.x * a.x + a.y * a.y, b2 = b.x * b.x + b.y * b.y, c2 = c.x * c.x + c.y * c.y;
    const x = (a2 * (b.y - c.y) + b2 * (c.y - a.y) + c2 * (a.y - b.y)) / d;
    const y = (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / d;
    return { x, y, r2: (a.x - x) ** 2 + (a.y - y) ** 2 };
  }

  // Delaunay triangulation of points inside the picture (Bowyer–Watson,
  // starting from the picture split into two triangles). pts: [{x, y, u, v}]
  // with the corners at 0/1. Returns triangles as index triples into pts.
  function triangulate(pts) {
    const corner = (u, v) => pts.findIndex((p) => p.u === u && p.v === v);
    const make = (i, j, k) => ({ v: [i, j, k], c: circumcircle(pts[i], pts[j], pts[k]) });
    const [tl, tr, bl, br] = [corner(0, 0), corner(1, 0), corner(0, 1), corner(1, 1)];
    let tris = [make(tl, tr, bl), make(tr, br, bl)];
    // Points that share a side of the picture (a point dropped on that side splits it).
    const sides = (p) => [p.u === 0, p.u === 1, p.v === 0, p.v === 1];
    const sameSide = (i, j, k) => sides(pts[i]).some((s, n) => s && sides(pts[j])[n] && sides(pts[k])[n]);
    const order = pts.map((_, i) => i).filter((i) => ![tl, tr, bl, br].includes(i))
      .sort((i, j) => pts[i].v - pts[j].v || pts[i].u - pts[j].u); // fixed order, so the same points always give the same mesh
    const used = [tl, tr, bl, br];
    for (const i of order) {
      const p = pts[i];
      if (used.some((j) => Math.abs(pts[j].x - p.x) < 0.01 && Math.abs(pts[j].y - p.y) < 0.01)) continue; // duplicate
      used.push(i);
      const bad = tris.filter((t) => (p.x - t.c.x) ** 2 + (p.y - t.c.y) ** 2 < t.c.r2 * (1 - 1e-10));
      if (!bad.length) continue;
      const edges = new Map();
      for (const t of bad) {
        for (const [a, b] of [[t.v[0], t.v[1]], [t.v[1], t.v[2]], [t.v[2], t.v[0]]]) {
          const key = a < b ? `${a},${b}` : `${b},${a}`;
          edges.set(key, edges.has(key) ? null : [a, b]);
        }
      }
      tris = tris.filter((t) => !bad.includes(t));
      for (const e of edges.values()) {
        if (!e || sameSide(e[0], e[1], i)) continue;
        if (Math.abs(cross(sub(pts[e[0]], p), sub(pts[e[1]], p))) < 1e-9) continue; // no zero-area slivers
        tris.push(make(e[0], e[1], i));
      }
    }
    return tris.map((t) => t.v);
  }

  // Matrix [a, b, c, d, e, f] (as for canvas setTransform) taking s0,s1,s2 to d0,d1,d2.
  function affine([s0, s1, s2], [d0, d1, d2]) {
    const p = sub(s1, s0), q = sub(s2, s0), m = sub(d1, d0), n = sub(d2, d0);
    const det = cross(p, q);
    const a = (m.x * q.y - n.x * p.y) / det, c = (n.x * p.x - m.x * q.x) / det;
    const b = (m.y * q.y - n.y * p.y) / det, d = (n.y * p.x - m.y * q.x) / det;
    return [a, b, c, d, d0.x - a * s0.x - c * s0.y, d0.y - b * s0.x - d * s0.y];
  }

  function barycentric(p, a, b, c) {
    const det = (b.y - c.y) * (a.x - c.x) + (c.x - b.x) * (a.y - c.y);
    const l1 = ((b.y - c.y) * (p.x - c.x) + (c.x - b.x) * (p.y - c.y)) / det;
    const l2 = ((c.y - a.y) * (p.x - c.x) + (a.x - c.x) * (p.y - c.y)) / det;
    return [l1, l2, 1 - l1 - l2];
  }

  L.WarpedImageOverlay = L.ImageOverlay.extend({
    initialize(url, warp, options) {
      L.setOptions(this, options);
      this._url = url;
      this._warp = warp;
      this._bounds = L.latLngBounds(warp.map((p) => [p[2], p[3]]));
    },

    getWarp() {
      return this._warp;
    },

    // preview: quick low-resolution paint, for live dragging.
    setWarp(warp, preview) {
      this._warp = warp;
      this._schedule(preview);
      return this;
    },

    // The mesh once the picture has loaded: { w, h, src: picture px, dst: zoom-20 px, tris }.
    mesh() {
      const img = this._src;
      if (!img || !img.naturalWidth) return null;
      const w = img.naturalWidth, h = img.naturalHeight;
      const key = `${w}x${h}:${this._warp.map((p) => `${p[0]},${p[1]}`).join(';')}`;
      if (!this._mesh || this._mesh.key !== key) {
        const src = this._warp.map((p) => ({ x: p[0] * w, y: p[1] * h, u: p[0], v: p[1] }));
        this._mesh = { key, w, h, src, tris: triangulate(src) };
      }
      this._mesh.dst = this._warp.map((p) => CRS.latLngToPoint(L.latLng(p[2], p[3]), Z));
      return this._mesh;
    },

    // Mesh edges as index pairs (each once).
    edges() {
      const m = this.mesh();
      if (!m) return [];
      const seen = new Map();
      for (const [i, j, k] of m.tris) for (const [a, b] of [[i, j], [j, k], [k, i]]) seen.set(a < b ? `${a},${b}` : `${b},${a}`, [a, b]);
      return [...seen.values()];
    },

    // Where a map position falls in the picture: [across, down], or null if off the drawing.
    uvAt(latlng) {
      const m = this.mesh();
      if (!m) return null;
      const p = CRS.latLngToPoint(L.latLng(latlng), Z);
      for (const t of m.tris) {
        const l = barycentric(p, ...t.map((i) => m.dst[i]));
        if (l.every((x) => x >= -1e-9)) return [0, 1].map((n) => l.reduce((s, li, k) => s + li * [m.src[t[k]].u, m.src[t[k]].v][n], 0));
      }
      return null;
    },

    // Where a spot of the picture is on the map.
    latLngAt(u, v) {
      const m = this.mesh();
      if (!m) return null;
      const p = { x: u * m.w, y: v * m.h };
      for (const t of m.tris) {
        const l = barycentric(p, ...t.map((i) => m.src[i]));
        if (l.every((x) => x >= -1e-9)) {
          return CRS.pointToLatLng(L.point(l.reduce((s, li, k) => s + li * m.dst[t[k]].x, 0), l.reduce((s, li, k) => s + li * m.dst[t[k]].y, 0)), Z);
        }
      }
      return null;
    },

    // Triangles turned inside out (a point dragged across a neighbouring edge).
    folds() {
      const m = this.mesh();
      if (!m) return 0;
      return m.tris.filter(([i, j, k]) => Math.sign(cross(sub(m.src[j], m.src[i]), sub(m.src[k], m.src[i])))
        !== Math.sign(cross(sub(m.dst[j], m.dst[i]), sub(m.dst[k], m.dst[i])))).length;
    },

    _initImage() {
      const canvas = (this._image = L.DomUtil.create('canvas', 'leaflet-image-layer'));
      if (this._zoomAnimated) L.DomUtil.addClass(canvas, 'leaflet-zoom-animated');
      if (this.options.className) L.DomUtil.addClass(canvas, this.options.className);
      if (this.options.zIndex) this._updateZIndex();
      const src = (this._src = new Image());
      src.onload = () => {
        this._paint(false);
        this.fire('load');
      };
      src.onerror = () => this.fire('error');
      src.src = this._url;
    },

    _schedule(preview) {
      this._wantPreview = this._raf ? this._wantPreview && preview : preview;
      if (this._raf) return;
      this._raf = requestAnimationFrame(() => {
        this._raf = null;
        this._paint(this._wantPreview);
      });
    },

    _paint(preview) {
      const m = this.mesh();
      if (!m || !this._image) return;
      const { w, h, src, dst, tris } = m;
      let min = L.point(Infinity, Infinity), max = L.point(-Infinity, -Infinity);
      for (const p of dst) {
        min = L.point(Math.min(min.x, p.x), Math.min(min.y, p.y));
        max = L.point(Math.max(max.x, p.x), Math.max(max.y, p.y));
      }
      // Canvas pixels per zoom-20 pixel: twice the picture's own detail (it
      // is resampled once more on screen), within the canvas limits.
      const corner = (u, v) => dst[src.findIndex((p) => p.u === u && p.v === v)];
      const across = (corner(0, 0).distanceTo(corner(1, 1)) + corner(1, 0).distanceTo(corner(0, 1))) / 2;
      const span = max.subtract(min);
      const lim = preview ? PREVIEW : FULL;
      let k = (2 * Math.hypot(w, h)) / across;
      k = Math.min(k, Math.sqrt(lim.pixels / (span.x * span.y)), lim.side / span.x, lim.side / span.y);

      const canvas = this._image;
      canvas.width = Math.max(1, Math.ceil(span.x * k));
      canvas.height = Math.max(1, Math.ceil(span.y * k));
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      const at = (p) => ({ x: (p.x - min.x) * k, y: (p.y - min.y) * k });
      for (const t of tris) {
        const s = t.map((i) => src[i]);
        const d = t.map((i) => at(dst[i]));
        // Clip to the triangle grown by ~1 px, so neighbours overlap instead of leaving hairline seams.
        const cx = (d[0].x + d[1].x + d[2].x) / 3, cy = (d[0].y + d[1].y + d[2].y) / 3;
        ctx.save();
        ctx.beginPath();
        d.forEach((p, n) => {
          const len = Math.hypot(p.x - cx, p.y - cy) || 1;
          ctx[n ? 'lineTo' : 'moveTo'](p.x + (p.x - cx) / len, p.y + (p.y - cy) / len);
        });
        ctx.closePath();
        ctx.clip();
        ctx.setTransform(...affine(s, d));
        const sx = Math.max(0, Math.floor(Math.min(s[0].x, s[1].x, s[2].x)) - 2);
        const sy = Math.max(0, Math.floor(Math.min(s[0].y, s[1].y, s[2].y)) - 2);
        const ex = Math.min(w, Math.ceil(Math.max(s[0].x, s[1].x, s[2].x)) + 2);
        const ey = Math.min(h, Math.ceil(Math.max(s[0].y, s[1].y, s[2].y)) + 2);
        if (ex > sx && ey > sy) ctx.drawImage(this._src, sx, sy, ex - sx, ey - sy, sx, sy, ex - sx, ey - sy);
        ctx.restore();
      }
      const end = min.add(L.point(canvas.width / k, canvas.height / k)); // whole canvas pixels, so no stretch
      this._bounds = L.latLngBounds(CRS.pointToLatLng(min, Z), CRS.pointToLatLng(end, Z));
      if (this._map) this._reset();
    },
  });
})();
