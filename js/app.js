/* Treasure Hunt navigator — main application.
 * Plain browser JavaScript, no build step. Needs Leaflet, HUNT_CONFIG (config.js), Geo and Store. */
(function () {
  'use strict';

  const C = window.HUNT_CONFIG;
  const fatal = (text) => {
    const p = document.createElement('p');
    p.className = 'fatal';
    p.textContent = text;
    document.body.prepend(p);
  };
  if (!C || !window.L) {
    fatal(!C
      ? 'js/config.js could not be read — it probably has a typo (a missing comma or bracket). Open Chrome DevTools → Console to see the line.'
      : 'Could not load the map library. Check your internet connection and reload.');
    return;
  }
  // Edits from the debug view, once "applied", replace the boundary, spots
  // and drawing warp from config.js on this phone only, and only while
  // DEBUG_TOOLS is on.
  const DRAFT_KEY = 'hunt-debug-draft';
  const CONFIG_FILE = JSON.parse(JSON.stringify({ ORIGIN: C.ORIGIN, POIS: C.POIS, WARP: C.OVERLAY?.warp ?? null })); // as written in config.js
  let DRAFT_APPLIED = false;
  if (C.DEBUG_TOOLS) {
    try {
      const d = JSON.parse(localStorage.getItem(DRAFT_KEY));
      if (d?.applied) {
        C.REGION = d.region;
        C.ORIGIN = { ...C.ORIGIN, ...d.origin };
        C.POIS = C.POIS.map((p) => (d.pois[p.id] ? { ...p, ...d.pois[p.id] } : p));
        if (d.overlay && C.OVERLAY && d.overlay.url === C.OVERLAY.url) C.OVERLAY = { ...C.OVERLAY, warp: d.overlay.warp };
        DRAFT_APPLIED = true;
      }
    } catch (e) { /* unreadable draft: ignore it */ }
  }
  if (C.OVERLAY?.warp) C.OVERLAY.warp = normWarp(C.OVERLAY.warp);

  let REGION;
  try {
    REGION = Geo.parseRegion(C.REGION);
  } catch (e) {
    fatal(`Problem in js/config.js: ${e.message}`);
    return;
  }
  const APP_VERSION = '2.0.0';
  const SIM = !!C.SIMULATE_GPS || new URLSearchParams(location.search).has('sim');

  // ---------------------------------------------------------------- utils
  const $ = (sel) => document.querySelector(sel);
  const round = (v, d = 6) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);
  const nowIso = () => new Date().toISOString();
  const pad = (n) => String(n).padStart(2, '0');
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const fileStamp = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const clockTime = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function duration(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
  }

  const loadScript = (src) => new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`could not load ${src}`));
    document.head.append(s);
  });

  // -------------------------------------------------------------- targets
  const ITEMS = C.POIS.map((p, i) => ({ ...p, index: i + 1, radius: p.radius || C.PROXIMITY_RADIUS_M, code: String(p.code || p.id) }));
  const ORIGIN = { id: 'origin', ...C.ORIGIN, radius: C.ORIGIN.radius || C.PROXIMITY_RADIUS_M };
  const itemById = (id) => ITEMS.find((p) => p.id === id);

  // Codes match ignoring case, spaces and punctuation, so a typed "k7q2-xm" counts.
  const normCode = (s) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const BY_CODE = new Map();
  for (const p of ITEMS) if (normCode(p.code) && !BY_CODE.has(normCode(p.code))) BY_CODE.set(normCode(p.code), p);
  const itemForCode = (text) => BY_CODE.get(normCode(text)) || null;

  const state = {
    session: null,       // persisted in IndexedDB under meta/session
    pos: null,           // latest GPS fix
    lastFixAt: 0,
    proximity: null,     // THE PROXIMITY VARIABLE, see TREASURE SIGNAL below
    signalLevel: -1,
    outside: false,
    outsideStreak: 0,
    lastOutsideAlert: 0,
    follow: true,
    watchId: null,
    wakeLock: null,
    hiddenAt: 0,
    timers: [],
    preStart: [],        // events logged before Start / Resume, flushed into the session
  };

  const running = () => state.session?.phase === 'running';
  const isFound = (id) => !!state.session?.items[id]?.foundAt;
  const foundCount = () => ITEMS.filter((p) => isFound(p.id)).length;
  const saveSession = () => Store.put('meta', state.session, 'session');

  // =========================================================== LOGGING
  // Every record carries the map viewport at that moment, so the log alone
  // reconstructs what the player was looking at.
  function viewSnapshot() {
    if (!mapReady) return null;
    const c = map.getCenter();
    const b = map.getBounds();
    return {
      zoom: round(map.getZoom(), 2), lat: round(c.lat), lng: round(c.lng),
      bounds: [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()].map((v) => round(v)),
    };
  }

  function log(type, data) {
    const ts = Date.now();
    const rec = { ts, iso: new Date(ts).toISOString(), type, ...data, view: viewSnapshot() };
    const s = state.session;
    if (!s) {
      // Scouting in the debug view before a hunt isn't part of any team's log.
      const scouting = debug.on || type.startsWith('debug_') || String(data?.control).startsWith('debug');
      if (state.preStart.length < 5000 && !scouting) state.preStart.push(rec);
    } else if (s.phase === 'running') {
      Store.add('events', rec).catch((e) => console.error('log write failed', e));
    }
    if (SIM) console.debug('[log]', type, data || '');
  }

  function flushPreStart() {
    // Adds are queued in order, so the buffered events keep their position in the log.
    for (const rec of state.preStart.splice(0)) Store.add('events', { ...rec, buffered: true });
  }

  // =============================================================== MAP
  let map, maskRenderer, userMarker, accCircle, guideLine;
  let mapReady = false;
  const regionBounds = L.latLngBounds(REGION);
  // Everything worth seeing: the hunt area plus the drawing (if any).
  const viewBounds = L.latLngBounds(REGION);
  for (const p of C.OVERLAY ? C.OVERLAY.warp || cornerWarp() || [] : []) viewBounds.extend([p[2], p[3]]);
  const padMetres = (b, m) => {
    const dLat = m / 111320, dLng = m / (111320 * Math.cos((b.getCenter().lat * Math.PI) / 180));
    return L.latLngBounds([b.getSouth() - dLat, b.getWest() - dLng], [b.getNorth() + dLat, b.getEast() + dLng]);
  };
  const pins = {};

  // Programmatic moves are tagged so the log can tell them apart from the player's gestures.
  let appAction = null;   // { source, at }
  let currentMove = null; // { source }
  let zoomInfo = null;    // { from, trigger }
  const gesture = { pointers: new Set(), maxPointers: 0, lastUp: 0, lastWheel: 0, lastTap: 0, lastDoubleTap: 0 };
  const appSource = () => (appAction && Date.now() - appAction.at < 1500 ? appAction.source : null);
  const markApp = (source) => { appAction = { source, at: Date.now() }; };

  function initMap() {
    map = L.map('map', {
      zoomControl: false,
      maxBounds: padMetres(viewBounds, 300), // panning stops 300 m past the area / drawing
      maxBoundsViscosity: 1,
      maxZoom: C.MAX_ZOOM,
      zoomSnap: 0.25,
      bounceAtZoomLimits: false,
    });
    map.fitBounds(regionBounds);
    updateMinZoom();

    map.createPane('drawing').style.zIndex = 350; // your drawing: over the street map, under rings and markers
    map.createPane('mask').style.zIndex = 450;    // boundary line, outside shading, GPS circle: above tiles/overlays, below markers
    map.createPane('me').style.zIndex = 640;      // the player's dot sits above everything

    const O = C.OVERLAY;
    if (!O || O.streetMap !== false) {
      L.tileLayer(C.TILE_URL, {
        attribution: C.TILE_ATTRIBUTION,
        maxZoom: C.MAX_ZOOM,
        maxNativeZoom: Math.min(C.MAX_ZOOM, 19),
        crossOrigin: true,
        keepBuffer: 4,
      }).addTo(map);
    }
    if (O) showDrawing(O.warp || null);

    // Optional shading = the whole world with the hunt area cut out as a hole.
    maskRenderer = L.svg({ pane: 'mask', padding: 1 });
    const shade = Math.min(1, Math.max(0, C.OUTSIDE_SHADE ?? 0));
    if (shade > 0) {
      const world = [[-85, -180], [-85, 180], [85, 180], [85, -180]];
      L.polygon([world, REGION], {
        renderer: maskRenderer, stroke: false, fillColor: C.MASK_COLOR, fillOpacity: shade, interactive: false,
      }).addTo(map);
    }
    L.polygon(REGION, {
      renderer: maskRenderer, color: C.BOUNDARY_COLOR, weight: 3, dashArray: '10 8', fill: false, interactive: false,
    }).addTo(map);

    addPins();
    bindMapLogging();
    mapReady = true;
  }

  function updateMinZoom() {
    map.setMinZoom(Math.max(0, map.getBoundsZoom(viewBounds) - 0.25));
  }

  // --------------------------------------------------------- your drawing
  // Warp points are [across, down, lat, lng]: across/down 0–1 in the picture
  // (0, 0 = top-left corner). These are its corners as config.js places them;
  // the bottom-right one follows from the other three.
  function cornerWarp() {
    const O = C.OVERLAY;
    const [tl, tr, bl] = [O.topLeft, O.topRight, O.bottomLeft].map((c) => (c ? L.latLng(c) : null));
    if (!tl || !tr || !bl) return null;
    return [[0, 0, tl.lat, tl.lng], [1, 0, tr.lat, tr.lng], [0, 1, bl.lat, bl.lng], [1, 1, tr.lat + bl.lat - tl.lat, tr.lng + bl.lng - tl.lng]];
  }

  // OVERLAY.warp, tidied up: inside the picture, and all four corners present
  // (missing ones come from topLeft/topRight/bottomLeft). null if unusable.
  function normWarp(list) {
    const clamp = (x) => Math.min(1, Math.max(0, x));
    const out = (Array.isArray(list) ? list : [])
      .filter((p) => Array.isArray(p) && p.length >= 4 && p.slice(0, 4).every(Number.isFinite))
      .map(([u, v, lat, lng]) => [clamp(u), clamp(v), lat, lng]);
    for (const c of cornerWarp() || []) if (!out.some((p) => p[0] === c[0] && p[1] === c[1])) out.push(c);
    return [[0, 0], [1, 0], [0, 1], [1, 1]].every(([u, v]) => out.some((p) => p[0] === u && p[1] === v)) ? out : null;
  }

  // The drawing pinned by its corners, or bent by warp points.
  let drawing = null;
  let drawingKey = '';     // the warp last fully painted ('' = only a quick preview)
  let drawingFailed = false;
  function showDrawing(warp, opacity) {
    const O = C.OVERLAY;
    const Type = warp ? L.WarpedImageOverlay : L.CornerImageOverlay;
    const key = JSON.stringify(warp);
    if (!(drawing instanceof Type)) {
      drawing?.remove();
      const opts = { pane: 'drawing', opacity: O.opacity ?? 1 };
      drawing = warp ? new L.WarpedImageOverlay(O.url, warp, opts) : new L.CornerImageOverlay(O.url, [O.topLeft, O.topRight, O.bottomLeft], opts);
      drawing.on('error', () => {
        if (drawingFailed) return;
        drawingFailed = true;
        log('overlay_error', { url: O.url });
        $('#start-warnings').insertAdjacentHTML('beforeend', `<p>⚠️ The drawing “${esc(O.url)}” could not be loaded. Check OVERLAY.url in js/config.js and that the file was uploaded.</p>`);
      });
      drawing.on('load', () => warpEditing() && drawDebug()); // the warp handles need the picture's size
      drawing.addTo(map);
    } else if (warp && key !== drawingKey) {
      drawing.setWarp(warp);
    }
    drawingKey = key;
    drawing.setOpacity(opacity ?? O.opacity ?? 1);
  }

  function previewDrawing(warp) { // quick repaint while a warp point is dragged
    drawing.setWarp(warp.map((p) => p.slice()), true);
    drawingKey = '';
  }

  function pinIcon(p) {
    const origin = p === ORIGIN;
    const done = !origin && isFound(p.id);
    const label = origin ? '🏁' : done ? '✓' : p.index;
    return L.divIcon({
      className: 'pin-icon',
      html: `<div class="poi-pin${origin ? ' origin' : ''}${done ? ' done' : ''}">${label}</div>`,
      iconSize: [34, 34], iconAnchor: [17, 17], popupAnchor: [0, -16],
    });
  }

  function popupHtml(p) {
    const status = p === ORIGIN ? 'Start &amp; finish point' : isFound(p.id) ? '✓ Found' : 'Not found yet';
    const dist = state.pos ? ` · ${Geo.formatDistance(Geo.distance(state.pos, p))} away` : '';
    return `<strong>${esc(p.name)}</strong><br><small>${status}${dist}</small>${p.hint ? `<br>${esc(p.hint)}` : ''}`;
  }

  function addPin(p) {
    if (p !== ORIGIN && C.REVEAL_POIS) {
      L.circle([p.lat, p.lng], { radius: p.radius, color: '#ea580c', weight: 1, fillOpacity: 0.08, interactive: false }).addTo(map);
    }
    const m = L.marker([p.lat, p.lng], { icon: pinIcon(p), title: p.name, keyboard: false });
    m.bindPopup(() => popupHtml(p));
    m.on('click', () => log('poi_tap', { poiId: p.id }));
    pins[p.id] = m.addTo(map);
  }

  function addPins() {
    for (const p of C.REVEAL_POIS ? [ORIGIN, ...ITEMS] : [ORIGIN]) addPin(p);
  }

  // Hidden treasures only get a marker once they are found.
  function refreshPins() {
    for (const p of [ORIGIN, ...ITEMS]) {
      if (pins[p.id]) pins[p.id].setIcon(pinIcon(p));
      else if (isFound(p.id)) addPin(p);
    }
  }

  function bindMapLogging() {
    const el = map.getContainer();
    el.addEventListener('pointerdown', (e) => {
      if (!gesture.pointers.size) gesture.maxPointers = 0;
      gesture.pointers.add(e.pointerId);
      gesture.maxPointers = Math.max(gesture.maxPointers, gesture.pointers.size);
    }, true);
    const up = (e) => { gesture.pointers.delete(e.pointerId); gesture.lastUp = Date.now(); };
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', up, true);
    el.addEventListener('wheel', () => { gesture.lastWheel = Date.now(); }, { capture: true, passive: true });
    el.addEventListener('click', () => {
      const t = Date.now();
      if (t - gesture.lastTap < 400) gesture.lastDoubleTap = t;
      gesture.lastTap = t;
    }, true);
    el.addEventListener('dblclick', () => { gesture.lastDoubleTap = Date.now(); }, true);

    const gestureTrigger = () => {
      const t = Date.now();
      if (gesture.maxPointers >= 2 && (gesture.pointers.size >= 2 || t - gesture.lastUp < 800)) return 'pinch';
      if (t - gesture.lastWheel < 500) return 'wheel';
      if (t - gesture.lastDoubleTap < 800) return 'double_tap';
      return 'other';
    };

    map.on('movestart', () => { currentMove = { source: appSource() || 'user' }; });
    map.on('moveend', () => {
      if (!currentMove) return; // Leaflet fires a bare moveend for zero-length pans
      log('view_change', { source: currentMove.source });
      currentMove = null;
      appAction = null;
    });
    map.on('zoomstart', () => { zoomInfo = { from: map.getZoom(), trigger: appSource() || gestureTrigger() }; });
    map.on('zoomend', () => {
      const to = map.getZoom();
      if (zoomInfo && to !== zoomInfo.from) log('zoom', { from: round(zoomInfo.from, 2), to: round(to, 2), trigger: zoomInfo.trigger });
      zoomInfo = null;
    });
    map.on('dragstart', () => {
      log('pan_start');
      setFollow(false, 'drag');
    });
    map.on('dragend', (e) => log('pan_end', { distancePx: Math.round(e.distance || 0) }));
    map.on('click', (e) => {
      log('map_tap', { lat: round(e.latlng.lat), lng: round(e.latlng.lng) });
      if (SIM && (running() || debug.on) && !warpEditing()) simulateFix(e.latlng); // taps add warp points there instead
    });
    map.on('contextmenu', (e) => log('map_long_press', { lat: round(e.latlng.lat), lng: round(e.latlng.lng) }));
    map.on('popupclose', () => log('popup_close'));
    map.on('autopanstart', () => markApp('popup_autopan'));
    map.on('resize', () => {
      updateMinZoom();
      const s = map.getSize();
      log('map_resize', { width: s.x, height: s.y });
    });
  }

  function setFollow(on, reason) {
    if (state.follow === on) return;
    state.follow = on;
    $('#btn-locate').classList.toggle('active', on);
    log(on ? 'follow_on' : 'follow_off', { reason });
  }

  function followUser(fix) {
    if (!state.follow || zoomInfo || gesture.pointers.size) return;
    const pt = map.latLngToContainerPoint([fix.lat, fix.lng]);
    if (pt.distanceTo(map.getSize().divideBy(2)) < 30) return; // ignore GPS jitter
    markApp('follow');
    map.panTo([fix.lat, fix.lng], { animate: true, duration: 0.6 });
  }

  function locateMe() {
    if (!state.pos) return toast('Waiting for a GPS fix…', 'info');
    setFollow(true, 'locate_button');
    markApp('locate_button');
    map.setView([state.pos.lat, state.pos.lng], Math.max(map.getZoom(), 17));
  }

  function drawUser(fix) {
    const at = [fix.lat, fix.lng];
    if (!userMarker) {
      userMarker = L.marker(at, {
        pane: 'me', interactive: false, keyboard: false,
        icon: L.divIcon({ className: 'me-icon', html: '<div class="me-dot"></div>', iconSize: [22, 22], iconAnchor: [11, 11] }),
      }).addTo(map);
      accCircle = L.circle(at, {
        renderer: maskRenderer, radius: fix.acc, color: '#2563eb', weight: 1, opacity: 0.5,
        fillColor: '#3b82f6', fillOpacity: 0.12, interactive: false,
      }).addTo(map);
    } else {
      userMarker.setLatLng(at);
      accCircle.setLatLng(at).setRadius(fix.acc);
    }
    setGpsPill(fix.sim ? 'sim' : fix.acc <= 15 ? 'good' : fix.acc <= C.MAX_ACCURACY_M ? 'fair' : 'poor', fix.acc);
  }

  function drawGuide(fix, edge) {
    if (state.outside && edge) {
      const pts = [[fix.lat, fix.lng], [edge.lat, edge.lng]];
      if (guideLine) guideLine.setLatLngs(pts);
      else guideLine = L.polyline(pts, { renderer: maskRenderer, color: '#ef4444', weight: 4, dashArray: '2 9', lineCap: 'round', interactive: false }).addTo(map);
    } else if (guideLine) {
      guideLine.remove();
      guideLine = null;
    }
  }

  // ======================================================== GPS + GEOFENCE
  function startGps() {
    if (SIM) {
      setGpsPill('sim');
      if (!state.pos && running()) simulateFix(L.latLng(ORIGIN.lat, ORIGIN.lng));
      return;
    }
    if (state.watchId !== null) return; // already on (the debug view may have started it)
    if (!('geolocation' in navigator)) {
      setGpsPill('off');
      showModal({ id: 'no_gps', title: 'No GPS', body: 'This browser does not support location. Please open the hunt in Google Chrome.' });
      return;
    }
    setGpsPill('search');
    state.watchId = navigator.geolocation.watchPosition(onPosition, onGeoError, {
      enableHighAccuracy: true, maximumAge: 0, timeout: 30000,
    });
    log('gps_watch_start');
  }

  function stopGps() {
    if (state.watchId === null) return;
    navigator.geolocation.clearWatch(state.watchId);
    state.watchId = null;
    log('gps_watch_stop');
  }

  function onPosition(p) {
    const c = p.coords;
    onFix({
      ts: p.timestamp || Date.now(), lat: c.latitude, lng: c.longitude, acc: c.accuracy,
      alt: c.altitude, altAcc: c.altitudeAccuracy, heading: c.heading, speed: c.speed, sim: false,
    });
  }

  function simulateFix(latlng) {
    onFix({ ts: Date.now(), lat: latlng.lat, lng: latlng.lng, acc: 5, alt: null, altAcc: null, heading: null, speed: null, sim: true });
  }

  // Every fix goes to the hunt while it runs; otherwise only the debug view uses it.
  function onFix(fix) {
    debug.samples?.push(fix);
    if (running()) handleFix(fix);
    else if (debug.on) debugFix(fix);
  }

  function onGeoError(err) {
    log('gps_error', { code: err.code, message: err.message });
    if (err.code === 1) {
      setGpsPill('off');
      showModal({
        id: 'gps_denied',
        title: '📍 Location is blocked',
        body: 'The hunt needs your location.\n\nIn Chrome tap the icon left of the address bar → Permissions → Location → Allow. Then reload — your progress is saved.',
        buttons: [{ label: 'Reload', primary: true, action: () => location.reload() }, { label: 'Close' }],
      });
    } else {
      setGpsPill('search');
    }
  }

  function handleFix(fix) {
    if (!running()) return;
    const first = !state.pos;
    state.pos = fix;
    state.lastFixAt = Date.now();
    drawUser(fix);
    const geo = evaluate(fix);
    Store.add('gps', {
      iso: new Date(fix.ts).toISOString(), ts: fix.ts,
      lat: round(fix.lat, 7), lng: round(fix.lng, 7), acc: round(fix.acc, 1),
      alt: round(fix.alt, 1), altAcc: round(fix.altAcc, 1), heading: round(fix.heading, 1), speed: round(fix.speed, 2),
      sim: fix.sim, ...geo,
    }).catch((e) => console.error('gps write failed', e));
    if (first) {
      log('gps_first_fix', { acc: round(fix.acc, 1) });
      if (state.follow) {
        markApp('first_fix');
        map.setView([fix.lat, fix.lng], Math.max(map.getZoom(), 17));
      }
    } else {
      followUser(fix);
    }
    updateScanButton();
    if ($('#sheet').classList.contains('open')) renderList();
    if (debug.on) renderDebug();
  }

  function evaluate(fix) {
    const inside = Geo.insidePolygon(fix, REGION);
    const edge = inside ? null : Geo.nearestOnPolygon(fix, REGION);
    const dists = ITEMS.map((p) => Geo.distance(fix, p));
    const reliable = fix.acc <= C.MAX_ACCURACY_M;
    if (reliable) {  // a fix this vague would make the signal jump around, so it keeps its last value
      checkBoundary(fix, inside, edge);
      updateTreasures(dists);
      checkOrigin(fix);
    }
    drawGuide(fix, edge);
    const n = dists.indexOf(Math.min(...dists));
    return {
      inside, outsideBy: edge ? round(edge.distance, 1) : 0, reliable,
      nearestItem: ITEMS[n]?.id ?? null, nearestItemDist: round(dists[n], 1),
      proximityItem: state.proximity?.poiId ?? null, proximity: state.proximity?.value ?? null,
    };
  }

  function checkBoundary(fix, inside, edge) {
    const clearlyOut = !inside && edge.distance > C.BOUNDARY_TOLERANCE_M;
    state.outsideStreak = clearlyOut ? state.outsideStreak + 1 : 0;

    if (!state.outside && state.outsideStreak >= 2) { // two fixes in a row, so one GPS jump doesn't trigger it
      state.outside = true;
      state.lastOutsideAlert = Date.now();
      alertUser('alarm');
      log('boundary_exit', { lat: round(fix.lat), lng: round(fix.lng), outsideBy: round(edge.distance, 1) });
      log('notification_shown', { channel: 'banner', id: 'boundary' });
    } else if (state.outside && inside) {
      state.outside = false;
      $('#boundary-banner').hidden = true;
      log('boundary_return', { lat: round(fix.lat), lng: round(fix.lng) });
      log('notification_dismissed', { channel: 'banner', id: 'boundary', how: 'returned_inside' });
      alertUser('ok');
      toast('✅ Back inside the hunt area', 'ok');
    }

    if (state.outside && edge) {
      const b = Geo.bearing(fix, edge);
      $('#boundary-arrow').style.transform = `rotate(${Math.round(b)}deg)`;
      $('#boundary-text').textContent = `Head ${Geo.compass(b)} for about ${Geo.formatDistance(edge.distance)} to get back.`;
      $('#boundary-banner').hidden = false;
      if (Date.now() - state.lastOutsideAlert > C.BOUNDARY_REMIND_SEC * 1000) {
        state.lastOutsideAlert = Date.now();
        alertUser('alarm');
        log('boundary_reminder', { outsideBy: round(edge.distance, 1) });
      }
    }
  }


  function checkOrigin(fix) {
    const s = state.session;
    const d = Geo.distance(fix, ORIGIN);
    if (!s.leftOrigin && d > ORIGIN.radius * 2 + 15) {
      s.leftOrigin = true;
      saveSession();
      log('origin_left', { distance: round(d, 1) });
    } else if (s.leftOrigin && d <= ORIGIN.radius) {
      s.leftOrigin = false;
      saveSession();
      log('origin_return', { distance: round(d, 1), found: foundCount() });
      alertUser('arrive');
      showModal({
        id: 'origin_return',
        title: `🏁 Back at ${ORIGIN.name}`,
        body: `You've found ${foundCount()} of ${ITEMS.length} items.\nFinish now to save your results, or keep hunting.`,
        buttons: [{ label: 'Finish & save results', primary: true, action: finishHunt }, { label: 'Keep hunting' }],
      });
    }
  }

  // ===================================================== TREASURE SIGNAL
  // state.proximity is the proximity variable. While the team is inside the
  // radius of a treasure they haven't found, it describes the nearest one:
  //   { poiId, distance (m), radius (m), value }
  //   value = 1 - distance / radius: 0 at the edge of the radius, 1 at the exact spot.
  // Outside every radius it is null. The treasure's position itself is never drawn.
  // UI can use it three ways: the CSS variable --proximity (0–1) on <html>,
  // the class body.has-signal, and the 'hunt:proximity' event on document.
  const SIGNAL_LEVELS = [
    { min: 0, label: 'Faint' },
    { min: 0.25, label: 'Warm' },
    { min: 0.5, label: 'Hot' },
    { min: 0.7, label: 'Very hot — look around!' },
  ];
  const levelOf = (v) => SIGNAL_LEVELS.reduce((lvl, l, i) => (v >= l.min ? i : lvl), 0);
  const LEAVE_SLACK_M = 5; // leaving needs a few extra metres, so GPS jitter at the edge doesn't flicker it

  function nearestSignal(dists) {
    let best = null;
    ITEMS.forEach((p, i) => {
      if (isFound(p.id)) return;
      const reach = p.radius + (state.proximity?.poiId === p.id ? LEAVE_SLACK_M : 0);
      if (dists[i] <= reach && (!best || dists[i] < best.d)) best = { p, d: dists[i] };
    });
    if (!best) return null;
    return {
      poiId: best.p.id, distance: round(best.d, 1), radius: best.p.radius,
      value: round(Math.max(0, 1 - best.d / best.p.radius), 3),
    };
  }

  function updateTreasures(dists) {
    setProximity(nearestSignal(dists));
    updateGhosts(dists);
  }

  // A hidden treasure is drawn only while the team is inside its radius: a
  // faint dashed pin plus its radius ring, fading in as they get closer
  // (CSS uses --proximity). Overlapping radii show both.
  const ghosts = {};             // poiId -> layer group, made on first use
  const ghostsShown = new Set();

  function makeGhost(p) {
    return L.layerGroup([
      L.circle([p.lat, p.lng], { radius: p.radius, className: 'reveal-ring', weight: 2, dashArray: '6 6', interactive: false }),
      L.marker([p.lat, p.lng], {
        interactive: false, keyboard: false,
        icon: L.divIcon({ className: 'pin-icon', html: `<div class="poi-pin ghost">${p.index}</div>`, iconSize: [34, 34], iconAnchor: [17, 17] }),
      }),
    ]);
  }

  function updateGhosts(dists) {
    if (C.REVEAL_POIS) return; // everything is on the map already
    ITEMS.forEach((p, i) => {
      const shown = ghostsShown.has(p.id);
      const show = !isFound(p.id) && dists[i] <= p.radius + (shown ? LEAVE_SLACK_M : 0);
      if (show === shown) return;
      if (show) {
        (ghosts[p.id] ||= makeGhost(p)).addTo(map);
        ghostsShown.add(p.id);
      } else {
        ghosts[p.id].remove();
        ghostsShown.delete(p.id);
      }
      log(show ? 'treasure_shown' : 'treasure_hidden', { poiId: p.id, distance: round(dists[i], 1), found: isFound(p.id) });
    });
  }

  function hideGhosts() {
    for (const id of ghostsShown) ghosts[id].remove();
    ghostsShown.clear();
  }

  function setProximity(next) {
    const prev = state.proximity;
    const level = next ? levelOf(next.value) : -1;
    state.proximity = next;
    if (prev?.poiId !== next?.poiId) {
      if (prev) log('proximity_exit', { poiId: prev.poiId, found: isFound(prev.poiId) });
      if (next) log('proximity_enter', { poiId: next.poiId, distance: next.distance, value: next.value, level }); // no pop-up: the ring and meter appearing are the cue
    } else if (next && level !== state.signalLevel) {
      log('proximity_level', { poiId: next.poiId, level, label: SIGNAL_LEVELS[level].label, distance: next.distance, value: next.value });
      if (level > state.signalLevel && C.VIBRATE && navigator.vibrate) navigator.vibrate(50 + 40 * level);
    }
    state.signalLevel = level;
    renderSignal();
    document.dispatchEvent(new CustomEvent('hunt:proximity', { detail: next }));
  }

  function renderSignal() {
    const s = state.proximity;
    document.documentElement.style.setProperty('--proximity', s ? s.value : 0);
    document.body.classList.toggle('has-signal', !!s);
    $('#signal').hidden = !s;
    if (!s) return;
    const p = itemById(s.poiId);
    const level = levelOf(s.value);
    $('#signal').dataset.level = level;
    $('#signal-name').textContent = p.name;
    $('#signal-level').textContent = SIGNAL_LEVELS[level].label;
    $('#signal-hint').textContent = p.hint || '';
    $('#signal-hint').hidden = !p.hint;
  }

  // ============================================== ALERTS: sound, vibration, UI
  let audioCtx = null;
  function unlockAudio() {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      audioCtx.resume();
    } catch (e) { /* no audio available */ }
  }

  const ALERTS = {
    soft: { vibrate: [120], tones: [[880, 0.12]] },
    ok: { vibrate: [80], tones: [[1046, 0.1]] },
    arrive: { vibrate: [200, 80, 200, 80, 400], tones: [[660, 0.12], [880, 0.12], [1175, 0.28]] },
    alarm: { vibrate: [400, 150, 400, 150, 400], tones: [[440, 0.25], [330, 0.4], [440, 0.25], [330, 0.4]] },
  };

  function alertUser(kind) {
    const a = ALERTS[kind];
    if (C.VIBRATE && navigator.vibrate) navigator.vibrate(a.vibrate);
    if (!C.SOUND || !audioCtx) return;
    let t = audioCtx.currentTime;
    for (const [freq, dur] of a.tones) {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.35, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(t);
      osc.stop(t + dur + 0.02);
      t += dur + 0.05;
    }
  }

  function toast(text, kind = 'info', ms = 5000) {
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.textContent = text;
    const box = $('#toasts');
    box.prepend(el);
    while (box.children.length > 3) box.lastElementChild.remove();
    log('notification_shown', { channel: 'toast', kind, text });
    const close = (how) => {
      if (!el.isConnected || el.classList.contains('out')) return;
      el.classList.add('out');
      setTimeout(() => el.remove(), 250);
      log('notification_dismissed', { channel: 'toast', text, how });
    };
    el.addEventListener('click', () => close('tap'));
    setTimeout(() => close('timeout'), ms);
  }

  // Modals are queued, so an arrival never wipes out a dialog the player hasn't answered.
  const modalQueue = [];
  let modalOpen = null;

  function showModal(opts) {
    modalQueue.push(opts);
    if (!modalOpen) nextModal();
  }

  function nextModal() {
    const root = $('#modal-root');
    const opts = modalQueue.shift();
    root.textContent = '';
    modalOpen = opts || null;
    if (!opts) { root.hidden = true; return; }

    const box = document.createElement('div');
    box.className = opts.compact ? 'modal compact' : 'modal';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    const h = document.createElement('h2');
    h.textContent = opts.title;
    box.append(h);
    if (opts.body) {
      const body = document.createElement('div');
      body.className = 'modal-body';
      if (typeof opts.body === 'string') body.textContent = opts.body;
      else body.append(opts.body);
      box.append(body);
    }
    const close = (how, button) => {
      log('notification_dismissed', { channel: 'modal', id: opts.id, how, button });
      opts.onClose?.();
      nextModal();
    };
    const actions = document.createElement('div');
    actions.className = 'actions';
    for (const b of opts.buttons || [{ label: 'OK', primary: true }]) {
      const btn = document.createElement('button');
      btn.textContent = b.label;
      btn.className = b.primary ? 'primary' : b.danger ? 'danger' : 'secondary';
      btn.onclick = () => { close('button', b.label); b.action?.(); };
      actions.append(btn);
    }
    box.append(actions);
    root.append(box);
    root.onclick = (e) => { if (e.target === root && opts.dismissable !== false) close('backdrop'); };
    root.hidden = false;
    log('notification_shown', { channel: 'modal', id: opts.id, title: opts.title });
    opts.onOpen?.(box);
  }

  function setGpsPill(kind, acc) {
    const el = $('#gps-pill');
    el.className = `pill gps-${kind}`;
    el.textContent = { off: 'GPS off', search: 'GPS…', sim: 'SIM GPS' }[kind] || `GPS ±${Math.round(acc)} m`;
  }

  function updateHud() {
    const text = `${foundCount()}/${ITEMS.length}`;
    $('#progress').textContent = text;
    $('#list-count').textContent = text;
  }

  // ------------------------------------------------------------- item list
  function openSheet() {
    renderList();
    $('#sheet').classList.add('open');
    $('#sheet-backdrop').hidden = false;
    log('list_open');
  }

  function closeSheet() {
    if (!$('#sheet').classList.contains('open')) return;
    $('#sheet').classList.remove('open');
    $('#sheet-backdrop').hidden = true;
    log('list_close');
  }

  function renderList() {
    const ol = $('#item-list');
    ol.textContent = '';
    for (const p of [...ITEMS, ORIGIN]) {
      const origin = p === ORIGIN;
      const rec = state.session?.items[p.id];
      const done = isFound(p.id);
      const li = document.createElement('li');
      li.className = origin ? 'origin' : done ? 'done' : '';
      let sub = origin ? 'Start & finish point' : done ? `Found ${clockTime(rec.foundAt)}${rec.method === 'manual' ? ' · code typed in' : ''}` : 'Not found yet';
      if (state.pos && C.REVEAL_POIS && !done) {
        sub += ` · ${Geo.formatDistance(Geo.distance(state.pos, p))} ${Geo.compass(Geo.bearing(state.pos, p))}`;
      }
      li.innerHTML = `<span class="num">${origin ? '🏁' : done ? '✓' : p.index}</span>
        <span class="info"><strong>${esc(p.name)}</strong><small>${esc(sub)}</small></span>
        ${p.hint ? '<span class="hint-tag" aria-label="Has a hint">💡</span>' : ''}<span class="chev" aria-hidden="true">›</span>`;
      li.onclick = () => openItemInfo(p);
      ol.append(li);
    }
  }

  // Small pop-up from the item list: the hint, plus "Show on map" for spots
  // that are already visible (start, found items, or everything with REVEAL_POIS).
  function openItemInfo(p) {
    const origin = p === ORIGIN;
    const rec = state.session?.items[p.id];
    log('item_info', { poiId: p.id, hasHint: !!p.hint, found: isFound(p.id) });
    const body = origin
      ? 'This is where the hunt starts and ends. Come back here when you are done and tap Finish.'
      : `${isFound(p.id) ? `✓ Found at ${clockTime(rec.foundAt)}` : 'Not found yet'}\n\n${p.hint ? `💡 ${p.hint}` : 'No hint for this one. Follow the treasure signal!'}`;
    const buttons = origin || isFound(p.id) || C.REVEAL_POIS
      ? [{ label: '📍 Show on map', primary: true, action: () => showOnMap(p) }, { label: 'Close' }]
      : [{ label: 'OK', primary: true }];
    showModal({ id: `item_info_${p.id}`, title: origin ? `🏁 ${p.name}` : p.name, body, buttons, compact: true });
  }

  function showOnMap(p) {
    log('list_select', { poiId: p.id });
    closeSheet();
    setFollow(false, 'list_select');
    markApp('list_select');
    map.flyTo([p.lat, p.lng], Math.max(map.getZoom(), 18), { duration: 0.8 });
  }

  // ============================================================ QR SCAN
  // Live camera inside the page (no app switch). Chrome on Android decodes with
  // its built-in BarcodeDetector; other browsers fall back to jsQR.
  const scan = { open: false, token: 0, stream: null, decoder: null, timer: null, torch: false, unknown: new Set() };

  // The treasure whose signal the team is picking up, if any.
  const scanTarget = () => (running() && state.proximity ? itemById(state.proximity.poiId) : null);

  function updateScanButton() {
    const p = scanTarget();
    const btn = $('#btn-scan');
    btn.classList.toggle('ready', !!p);
    btn.querySelector('span').textContent = p && C.REVEAL_POIS ? `Scan QR · ${p.name}` : 'Scan QR code';
  }

  function setScanStatus(text, kind = '') {
    const el = $('#scan-status');
    el.textContent = text;
    el.className = kind;
  }

  async function getDecoder() {
    if (scan.decoder) return scan.decoder;
    if ('BarcodeDetector' in window) {
      try {
        if ((await BarcodeDetector.getSupportedFormats()).includes('qr_code')) {
          const detector = new BarcodeDetector({ formats: ['qr_code'] });
          scan.decoder = { kind: 'native', read: async (video) => (await detector.detect(video))[0]?.rawValue || null };
          return scan.decoder;
        }
      } catch (e) { /* use jsQR */ }
    }
    await loadScript('js/vendor/jsQR.js');
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    scan.decoder = {
      kind: 'jsqr',
      read: async (video) => {
        const k = Math.min(1, 720 / Math.max(video.videoWidth, video.videoHeight)); // smaller frame = faster decode
        canvas.width = Math.round(video.videoWidth * k);
        canvas.height = Math.round(video.videoHeight * k);
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
        return window.jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' })?.data || null;
      },
    };
    return scan.decoder;
  }

  async function openScanner(from, target = scanTarget()) {
    if (!running() || scan.open) return;
    closeSheet();
    scan.open = true;
    const token = ++scan.token;
    scan.unknown.clear();
    log('qr_scan_open', { from, poiId: target?.id ?? null });
    $('#scan-title').textContent = target && C.REVEAL_POIS ? `Scan the QR code · ${target.name}` : 'Scan the QR code';
    $('#btn-torch').hidden = true;
    $('#btn-torch').classList.remove('on');
    setScanStatus('Starting camera…');
    $('#scanner').hidden = false;
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw Object.assign(new Error('this browser has no camera access'), { name: 'NotSupportedError' });
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
      });
      if (token !== scan.token) { stream.getTracks().forEach((t) => t.stop()); return; } // closed while Chrome was asking
      scan.stream = stream;
      const video = $('#scan-video');
      video.srcObject = stream;
      await video.play();
      const decoder = await getDecoder();
      if (token !== scan.token) return;
      const track = stream.getVideoTracks()[0];
      $('#btn-torch').hidden = !track.getCapabilities?.().torch;
      setScanStatus('Point the camera at the QR code');
      log('qr_camera_ready', { decoder: decoder.kind, width: video.videoWidth, height: video.videoHeight });
      scanLoop(token);
    } catch (e) {
      log('qr_camera_error', { name: e.name, message: e.message });
      if (token !== scan.token) return;
      setScanStatus(e.name === 'NotAllowedError'
        ? 'The camera is blocked. In Chrome tap the icon left of the address bar → Permissions → Camera → Allow. Or type the code in instead.'
        : `Camera problem (${e.message}). You can type the code in instead.`, 'warn');
    }
  }

  function scanLoop(token) {
    const video = $('#scan-video');
    const step = async () => {
      if (token !== scan.token) return;
      let text = null;
      if (video.readyState >= 2 && video.videoWidth) {
        try { text = await scan.decoder.read(video); } catch (e) { /* frame not ready yet */ }
      }
      if (token !== scan.token) return;
      if (text) onCameraCode(text);
      if (token === scan.token) scan.timer = setTimeout(step, 150);
    };
    step();
  }

  function onCameraCode(text) {
    if (itemForCode(text)) {
      closeScanner('scanned');
      submitCode(text, 'camera');
      return;
    }
    if (!scan.unknown.has(text)) { // the camera sees it many times a second; log it once
      scan.unknown.add(text);
      submitCode(text, 'camera');
      alertUser('soft');
    }
    setScanStatus('That QR code isn’t part of this hunt. Look for the hunt’s code.', 'warn');
  }

  function closeScanner(how) {
    if (!scan.open) return;
    scan.open = false;
    scan.token++;
    clearTimeout(scan.timer);
    scan.stream?.getTracks().forEach((t) => t.stop());
    scan.stream = null;
    scan.torch = false;
    $('#scan-video').srcObject = null;
    $('#scanner').hidden = true;
    log('qr_scan_close', { how });
  }

  async function toggleTorch() {
    const track = scan.stream?.getVideoTracks()[0];
    if (!track) return;
    try {
      await track.applyConstraints({ advanced: [{ torch: !scan.torch }] });
      scan.torch = !scan.torch;
      $('#btn-torch').classList.toggle('on', scan.torch);
      log('qr_torch', { on: scan.torch });
    } catch (e) {
      log('qr_torch_error', { message: e.message });
    }
  }

  // Fallback for a damaged code, glare or a blocked camera: the code text is
  // printed under each QR (tools/qr-codes.html).
  function openManualEntry(error) {
    closeScanner('manual_entry');
    log('qr_manual_open');
    const wrap = document.createElement('div');
    const p = document.createElement('p');
    p.className = error ? 'error' : '';
    p.textContent = error || 'Type the code printed under the QR code.';
    const input = document.createElement('input');
    input.className = 'code-input';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.setAttribute('autocapitalize', 'characters');
    input.maxLength = 200;
    wrap.append(p, input);
    showModal({
      id: 'manual_code',
      title: 'Type the code',
      body: wrap,
      buttons: [
        { label: 'Check code', primary: true, action: () => checkTypedCode(input.value) },
        { label: 'Cancel' },
      ],
      onOpen: (box) => {
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') box.querySelector('button.primary').click(); });
        setTimeout(() => input.focus(), 50);
      },
    });
  }

  function checkTypedCode(value) {
    const text = value.trim();
    if (!text) return;
    if (submitCode(text, 'manual') === 'unknown') openManualEntry(`“${text}” is not one of this hunt’s codes. Check it and try again.`);
  }

  function submitCode(text, method) {
    const p = itemForCode(text);
    if (!p) {
      log('qr_scan', { result: 'unknown', method, text: String(text).slice(0, 200) });
      return 'unknown';
    }
    if (isFound(p.id)) {
      log('qr_scan', { result: 'already_found', method, poiId: p.id });
      alertUser('ok');
      toast(`✓ ${p.name} was already found`, 'ok');
      return 'already_found';
    }
    log('qr_scan', { result: 'found', method, poiId: p.id });
    markFound(p, method);
    return 'found';
  }

  async function markFound(p, method) {
    const fix = state.pos;
    const rec = {
      foundAt: nowIso(), method,
      lat: round(fix?.lat, 7), lng: round(fix?.lng, 7), acc: round(fix?.acc, 1),
      distanceM: fix ? round(Geo.distance(fix, p), 1) : null,   // where GPS put the team when they scanned
      fixAgeSec: fix ? Math.round((Date.now() - state.lastFixAt) / 1000) : null,
    };
    state.session.items[p.id] = rec;
    log('item_found', { poiId: p.id, method, distanceM: rec.distanceM, acc: rec.acc });
    if (fix) updateTreasures(ITEMS.map((i) => Geo.distance(fix, i))); // its signal and ring go; a neighbour's may take over
    refreshPins();
    updateHud();
    updateScanButton();
    alertUser('arrive');
    toast(`✅ ${p.name} found! ${foundCount()}/${ITEMS.length}`, 'ok');
    if (foundCount() === ITEMS.length) {
      log('all_items_found');
      showModal({ id: 'all_found', title: '🎉 All items found!', body: `Head back to ${ORIGIN.name} and tap Finish to save your results.` });
    }
    await saveSession();
  }

  // ============================================================ RESULTS
  function walkedDistance(gps) {
    let total = 0;
    let last = null;
    for (const f of gps) {
      if (f.acc > C.MAX_ACCURACY_M) continue;
      if (!last) { last = f; continue; }
      const d = Geo.distance(last, f);
      if (d >= Math.max(3, Math.min(f.acc, last.acc))) { total += d; last = f; }
    }
    return Math.round(total);
  }

  function buildSummary(events, gps) {
    const s = state.session;
    const end = s.finishedAt || nowIso();
    return {
      huntName: C.HUNT_NAME, team: s.team, sessionId: s.id, appVersion: APP_VERSION, simulated: !!s.sim,
      positionsFrom: DRAFT_APPLIED ? 'debug view edits (this phone only)' : 'js/config.js',
      startedAt: s.startedAt, finishedAt: s.finishedAt, exportedAt: nowIso(),
      durationSec: Math.round((Date.parse(end) - Date.parse(s.startedAt)) / 1000),
      itemsFound: foundCount(), itemsTotal: ITEMS.length,
      distanceWalkedM: walkedDistance(gps), gpsFixes: gps.length, interactionEvents: events.length,
      items: ITEMS.map((p) => {
        const r = s.items[p.id] || {};
        return {
          id: p.id, index: p.index, name: p.name, lat: p.lat, lng: p.lng, radius: p.radius,
          found: !!r.foundAt, foundAt: r.foundAt || null, method: r.method || null,
          scanLat: r.lat ?? null, scanLng: r.lng ?? null, scanAcc: r.acc ?? null, scanDistanceM: r.distanceM ?? null,
        };
      }),
      origin: { id: ORIGIN.id, name: ORIGIN.name, lat: ORIGIN.lat, lng: ORIGIN.lng, radius: ORIGIN.radius },
      region: REGION,
      device: {
        userAgent: navigator.userAgent, language: navigator.language,
        screen: `${screen.width}x${screen.height}`, pixelRatio: devicePixelRatio,
        standalone: matchMedia('(display-mode: standalone)').matches,
      },
    };
  }

  // Plain JSON, laid out with one event / GPS fix per line so it also opens
  // comfortably in a text editor.
  function resultsJson(summary, events, gps) {
    const rows = (list) => (list.length ? `\n    ${list.map((r) => JSON.stringify(r)).join(',\n    ')}\n  ` : '');
    return `{\n  "format": "treasure-hunt-results",\n  "formatVersion": 1,\n`
      + `  "summary": ${JSON.stringify(summary, null, 2).replace(/\n/g, '\n  ')},\n`
      + `  "events": [${rows(events)}],\n  "gps": [${rows(gps)}]\n}\n`;
  }

  const resultsFileName = () => `hunt_${state.session.id}.json`;

  async function downloadResults() {
    const btn = $('#btn-download');
    btn.disabled = true;
    try {
      const [events, gps] = await Promise.all([Store.getAll('events'), Store.getAll('gps')]);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([resultsJson(buildSummary(events, gps), events, gps)], { type: 'application/json' }));
      a.download = resultsFileName();
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 60000);
      state.session.downloadedAt = nowIso();
      await saveSession();
      updateFinishUi();
    } catch (e) {
      console.error(e);
      $('#finish-msg').textContent = `Could not create the results file: ${e.message}. Tap the button to try again.`;
    } finally {
      btn.disabled = false;
    }
  }

  // ===================================================== SESSION LIFECYCLE
  function makeSessionId(team) {
    const slug = team.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'team';
    return `${fileStamp(new Date())}_${slug}_${Math.random().toString(36).slice(2, 6)}`;
  }

  async function startHunt() {
    const input = $('#team-input');
    const team = input.value.trim();
    if (!team) {
      input.classList.remove('invalid');
      void input.offsetWidth; // restart the shake animation
      input.classList.add('invalid');
      input.focus();
      return;
    }
    unlockAudio();
    $('#btn-start').disabled = true;
    await Store.clearAll();
    state.session = {
      id: makeSessionId(team), team, phase: 'running', startedAt: nowIso(), finishedAt: null,
      items: {}, leftOrigin: false, sim: SIM, appVersion: APP_VERSION,
    };
    await saveSession();
    flushPreStart();
    log('session_start', { sessionId: state.session.id, team, sim: SIM });
    beginTracking();
  }

  function resumeHunt(saved) {
    unlockAudio();
    state.session = saved;
    flushPreStart();
    log('session_resume', { found: foundCount() });
    beginTracking();
    toast('Hunt resumed — progress restored', 'ok');
  }

  function beginTracking() {
    $('#start-screen').hidden = true;
    document.body.classList.add('running');
    $('#team-label').textContent = `Team ${state.session.team}`;
    refreshPins();
    updateHud();
    updateScanButton();
    startGps();
    requestWakeLock();
    state.timers.forEach(clearInterval);
    state.timers = [setInterval(tick, 1000)];
    tick();
    if (SIM) toast('Simulation mode — tap the map to move', 'info', 7000);
  }

  function tick() {
    const s = state.session;
    if (!s) return;
    $('#timer').textContent = `⏱ ${duration((s.finishedAt ? Date.parse(s.finishedAt) : Date.now()) - Date.parse(s.startedAt))}`;
    if (!SIM && state.watchId !== null && state.lastFixAt && Date.now() - state.lastFixAt > 20000) setGpsPill('search');
  }

  function confirmFinish() {
    log('finish_prompt');
    showModal({
      id: 'confirm_finish',
      title: 'Finish the hunt?',
      body: `You found ${foundCount()} of ${ITEMS.length} items.\nTracking stops and your results are saved to this phone as one file.`,
      buttons: [{ label: 'Finish & save results', primary: true, action: finishHunt }, { label: 'Keep hunting' }],
    });
  }

  async function finishHunt() {
    if (!running()) return;
    setDebug(false);
    closeScanner('finish');
    closeSheet();
    setProximity(null);
    hideGhosts();
    log('session_finish', { found: foundCount(), total: ITEMS.length });
    stopGps();
    state.timers.forEach(clearInterval);
    state.timers = [];
    state.wakeLock?.release().catch(() => {});
    // From here on nothing more is logged: the file holds the hunt exactly as it ended.
    state.session.phase = 'done';
    state.session.finishedAt = nowIso();
    await saveSession();
    modalQueue.length = 0;
    if (modalOpen) nextModal();
    document.body.classList.remove('running');
    $('#boundary-banner').hidden = true;
    await showFinishScreen();
    downloadResults();
  }

  async function showFinishScreen() {
    const s = state.session;
    const gps = await Store.getAll('gps');
    const rows = [
      ['Team', s.team],
      ['Items found', `${foundCount()} / ${ITEMS.length}`],
      ['Time', duration(Date.parse(s.finishedAt || nowIso()) - Date.parse(s.startedAt))],
      ['Distance walked', Geo.formatDistance(walkedDistance(gps))],
    ];
    $('#finish-summary').innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('');
    updateFinishUi();
    $('#finish-screen').hidden = false;
  }

  function updateFinishUi() {
    const saved = !!state.session.downloadedAt;
    $('#btn-download').textContent = saved ? '⬇ Download again' : '⬇ Download results file';
    $('#finish-msg').textContent = saved
      ? `Your results were saved as\n${resultsFileName()}\nin this phone’s Downloads (Chrome ⋮ → Downloads). Send that file to the organiser.\nNot there? Tap Download again.`
      : 'Tap the button to save your results file on this phone.';
  }

  function discardAndReload(message) {
    showModal({
      id: 'confirm_discard',
      title: 'Delete this hunt’s data?',
      body: message,
      buttons: [
        { label: 'Delete and start over', danger: true, action: async () => { await Store.clearAll(); location.reload(); } },
        { label: 'Cancel' },
      ],
    });
  }

  // ========================================================== DEBUG VIEW
  // Organiser tool, shown when DEBUG_TOOLS is true. Works with or without a hunt.
  //  - every item's pin and radius, the live GPS reading, distance to the boundary;
  //  - Mark: GPS averaged over a few seconds. A mark made for an item (or the
  //    start) also moves it to that spot;
  //  - Edit: drag the boundary corners, item pins and the start; drag a "+" to
  //    add a corner, tap a corner to delete it. Undo, Simplify, Apply (use the
  //    edits on this phone after a reload) and Reset (back to js/config.js);
  //  - Edit → Drawing: bend your drawing to fit. It starts pinned at its four
  //    corners; tap it to add a warp point, drag a "+" to add one on its edge,
  //    then drag points to where those spots really are;
  //  - Export: GeoJSON of the marks, spots and boundary, plus the REGION /
  //    ORIGIN / POIS (and OVERLAY) block for js/config.js.
  // Marks and edits are kept on the phone (localStorage) until deleted or reset.
  const MARK_SECONDS = 8;
  const EDIT_MIN_ZOOM = 17; // corner handles only appear when they're big enough to grab
  const debug = {
    on: false, editing: false, target: 'spots', seeThrough: true,
    layer: null, samples: null, points: loadPoints(), draft: loadDraft(), undo: [],
  };
  const warpEditing = () => debug.on && debug.editing && debug.target === 'drawing' && !!C.OVERLAY;

  function loadStored(key) {
    try { return JSON.parse(localStorage.getItem(key)); } catch (e) { return null; }
  }
  function loadPoints() { return loadStored('hunt-debug-points') || []; }
  function loadDraft() { return loadStored(DRAFT_KEY); }
  const savePoints = () => localStorage.setItem('hunt-debug-points', JSON.stringify(debug.points));
  const saveDraft = () => (debug.draft ? localStorage.setItem(DRAFT_KEY, JSON.stringify(debug.draft)) : localStorage.removeItem(DRAFT_KEY));
  const targetName = (id) => (id === ORIGIN.id ? ORIGIN.name : itemById(id)?.name || 'Note');
  const ll7 = (ll) => [round(ll.lat, 7), round(ll.lng, 7)];

  function setDebug(on) {
    if (debug.on === on) return;
    if (on) {
      debug.on = true;
      log('debug_view', { on });
      if (!running()) { // scouting without a hunt
        $('#start-screen').hidden = true;
        startGps();
        requestWakeLock();
      }
    } else {
      log('debug_view', { on });
      debug.layer?.remove();
      debug.editing = false;
      if (!running()) { // done scouting: tidy up while still flagged, so none of it reaches a team's log
        stopGps();
        state.wakeLock?.release().catch(() => {});
        $('#toasts').textContent = '';
        if ($('#finish-screen').hidden) $('#start-screen').hidden = false;
      }
      debug.on = false;
      if (C.OVERLAY) syncDrawing(); // back to the drawing in use
    }
    document.body.classList.toggle('debug', on);
    $('#debug-panel').hidden = !on;
    $('#btn-debug').classList.toggle('active', on);
    if (on) {
      drawDebug();
      renderDebug();
    }
  }

  // ---------------------------------------------------------- edited spots
  // The boundary and spots being edited: the draft if there is one, otherwise
  // what the app is using now.
  function spots() {
    return debug.draft || {
      region: REGION.map((p) => [p[0], p[1]]),
      origin: { lat: ORIGIN.lat, lng: ORIGIN.lng },
      pois: Object.fromEntries(ITEMS.map((p) => [p.id, { lat: p.lat, lng: p.lng }])),
    };
  }
  const spotOf = (d, p) => d.pois[p.id] || { lat: p.lat, lng: p.lng };

  function editSpots(what, change) {
    debug.undo.push(JSON.stringify(debug.draft));
    if (debug.undo.length > 50) debug.undo.shift();
    const d = JSON.parse(JSON.stringify(spots()));
    change(d);
    d.updatedAt = nowIso();
    debug.draft = d;
    saveDraft();
    log('debug_edit', { what });
    drawDebug();
    renderDebug();
  }

  function undoEdit() {
    if (!debug.undo.length) return;
    debug.draft = JSON.parse(debug.undo.pop());
    saveDraft();
    log('debug_edit', { what: 'undo' });
    drawDebug();
    renderDebug();
  }

  function draftProblems(d) {
    const out = [];
    if (Geo.crossings(d.region).length) out.push('the boundary crosses itself');
    if (!Geo.insidePolygon(d.origin, d.region)) out.push('the start is outside the boundary');
    const outside = ITEMS.filter((p) => !Geo.insidePolygon(spotOf(d, p), d.region)).map((p) => p.name);
    if (outside.length) out.push(`${outside.join(', ')} outside the boundary`);
    if (debug.on && drawing?.folds?.()) out.push('the drawing folds over itself (drag the point back)');
    return out;
  }

  function draftStatus(d) {
    const dr = debug.draft;
    const where = !dr ? 'from js/config.js'
      : !dr.applied ? 'edited, not applied'
        : dr.updatedAt > dr.appliedAt ? 'applied on this phone, newer edits not applied' : 'applied on this phone';
    return warpEditing() ? `Drawing ${editWarp().length} points · ${where}` : `Boundary ${d.region.length} corners · ${where}`;
  }

  // ------------------------------------------------------- drawing warp
  // The edited warp (only if it belongs to the drawing in config.js).
  function draftWarp(d) {
    const o = d?.overlay;
    return o && C.OVERLAY && o.url === C.OVERLAY.url && Array.isArray(o.warp) ? o.warp : null;
  }
  const editWarp = () => draftWarp(debug.draft) || C.OVERLAY.warp || cornerWarp();
  const setDraftWarp = (x, warp) => { x.overlay = { url: C.OVERLAY.url, warp }; };

  // The drawing as the debug view shows it: the edited warp if there is one
  // (as warp points from its corners while you edit it), else the one in use.
  function syncDrawing() {
    const editing = warpEditing();
    const warp = (debug.on && draftWarp(debug.draft)) || C.OVERLAY.warp || (editing ? cornerWarp() : null);
    const base = C.OVERLAY.opacity ?? 1;
    showDrawing(warp, editing && debug.seeThrough ? Math.min(base, 0.55) : base);
  }

  // Warp handles: every warp point (drag to move that spot of the picture, tap
  // to delete), a "+" on each stretch of the drawing's edge (drag it to add a
  // point there), and the triangles the picture is bent along.
  function addWarpHandles(g) {
    const mesh = drawing?.mesh?.();
    if (!mesh) return; // the picture hasn't loaded yet; drawn again when it has
    const work = editWarp().map((p) => p.slice());
    const ll = (p) => [p[2], p[3]];
    const lines = L.polyline([], { className: 'warp-mesh', weight: 1.5, interactive: false }).addTo(g);
    const drawLines = (pts) => lines.setLatLngs(drawing.edges().map(([a, b]) => [ll(pts[a]), ll(pts[b])]));
    drawLines(work);

    const onSide = (a, b) => [0, 1].some((n) => a[n] === b[n] && (a[n] === 0 || a[n] === 1));
    const sides = drawing.edges().filter(([a, b]) => onSide(work[a], work[b]));
    const midUv = ([a, b]) => [round((work[a][0] + work[b][0]) / 2, 5), round((work[a][1] + work[b][1]) / 2, 5)];
    const midLl = (e) => drawing.latLngAt(...midUv(e)) || L.latLng((work[e[0]][2] + work[e[1]][2]) / 2, (work[e[0]][3] + work[e[1]][3]) / 2);
    const roomy = ([a, b]) => map.latLngToLayerPoint(ll(work[a])).distanceTo(map.latLngToLayerPoint(ll(work[b]))) > 60;
    const plus = sides.map((e) => {
      if (!roomy(e)) return null;
      const m = L.marker(midLl(e), { draggable: true, autoPan: true, keyboard: false, zIndexOffset: 400, icon: handleIcon('edit-mid warp-mid', '+') }).addTo(g);
      const uv = midUv(e);
      const added = () => [...work, [...uv, ...ll7(m.getLatLng())]];
      m.on('drag', () => { const t = added(); previewDrawing(t); drawLines(t); });
      m.on('dragend', () => editSpots('drawing: add point', (x) => setDraftWarp(x, added())));
      return { m, e };
    }).filter(Boolean);

    work.forEach((p, i) => {
      const corner = [0, 1].includes(p[0]) && [0, 1].includes(p[1]);
      const v = L.marker(ll(p), { draggable: true, autoPan: true, keyboard: false, zIndexOffset: 500, icon: handleIcon(`warp-pt${corner ? ' corner' : ''}`) }).addTo(g);
      v.on('drag', () => {
        const at = v.getLatLng();
        work[i] = [p[0], p[1], at.lat, at.lng];
        previewDrawing(work);
        drawLines(work);
        for (const x of plus) if (x.e.includes(i)) x.m.setLatLng([(work[x.e[0]][2] + work[x.e[1]][2]) / 2, (work[x.e[0]][3] + work[x.e[1]][3]) / 2]);
      });
      v.on('dragend', () => editSpots('drawing: move point', (x) => setDraftWarp(x, work.map((q, k) => (k === i ? [q[0], q[1], ...ll7(v.getLatLng())] : q)))));
      v.bindPopup(() => {
        const box = document.createElement('div');
        box.innerHTML = `<strong>${corner ? 'Corner' : 'Point'} of the drawing</strong><br>${Math.round(p[0] * 100)}% across, ${Math.round(p[1] * 100)}% down<br>`;
        const del = document.createElement('button');
        del.className = 'popup-btn';
        del.textContent = corner ? 'Corners can be moved, not deleted' : '🗑 Delete this point';
        del.disabled = corner;
        del.onclick = () => { map.closePopup(); editSpots('drawing: delete point', (x) => setDraftWarp(x, work.filter((_, k) => k !== i))); };
        box.append(del);
        return box;
      });
    });
  }

  // A tap on the drawing adds a warp point at that spot of the picture
  // (snapped onto the edge if close to it). Nothing moves until it's dragged.
  function addWarpPoint(latlng) {
    let uv = drawing?.uvAt?.(latlng);
    if (!uv) return toast('Tap on the drawing to add a point there.', 'info');
    const tap = map.latLngToLayerPoint(latlng);
    const near = (u, v) => { const at = drawing.latLngAt(u, v); return at && map.latLngToLayerPoint(at).distanceTo(tap) < 16; };
    let [u, v] = uv;
    if (near(0, v)) u = 0; else if (near(1, v)) u = 1;
    if (near(u, 0)) v = 0; else if (near(u, 1)) v = 1;
    uv = [round(u, 5), round(v, 5)];
    const at = drawing.latLngAt(...uv);
    const warp = editWarp();
    if (warp.some((p) => map.latLngToLayerPoint([p[2], p[3]]).distanceTo(map.latLngToLayerPoint(at)) < 20)) return toast('There’s already a point there. Drag it instead.', 'info');
    editSpots('drawing: add point', (x) => setDraftWarp(x, [...warp, [...uv, ...ll7(at)]]));
  }

  function setEditTarget(target) {
    if (debug.target === target) return;
    debug.target = target;
    log('debug_edit_target', { target });
    if (target === 'drawing') toast('Tap the drawing to add a point, then drag it to where that spot really is. Drag a “+” to bend an edge. Tap a point to delete it.', 'info', 8000);
    drawDebug();
    renderDebug();
  }

  function toggleSeeThrough() {
    debug.seeThrough = !debug.seeThrough;
    syncDrawing();
    renderDebug();
  }

  // ------------------------------------------------------------ map layer
  const handleIcon = (cls, text = '') => L.divIcon({ className: 'pin-icon', html: `<div class="${cls}"><span>${text}</span></div>`, iconSize: [30, 30], iconAnchor: [15, 15], popupAnchor: [0, -12] });

  function drawDebug() {
    if (!debug.on) return;
    const g = (debug.layer ||= L.layerGroup());
    g.clearLayers().addTo(map);
    if (C.OVERLAY) syncDrawing();
    const d = spots();
    const edit = debug.editing && !warpEditing(); // boundary and spots (not the drawing)
    const ringStyle = { className: 'debug-ring', weight: 2, dashArray: '4 5', interactive: false };

    if (edit || debug.draft) { // the boundary being edited (the orange dashed one is the one in use)
      const work = d.region.map((p) => [p[0], p[1]]);
      const poly = L.polygon(work, { className: 'debug-region', weight: 3, fill: false, interactive: false }).addTo(g);
      if (edit && map.getZoom() >= EDIT_MIN_ZOOM) addCornerHandles(g, poly, work);
    }

    const oRing = L.circle([d.origin.lat, d.origin.lng], { radius: ORIGIN.radius, ...ringStyle }).addTo(g);
    if (edit || debug.draft) { // the 🏁 pin shows the start in use; this one is the editable copy
      addSpotPin(g, d.origin, '🏁', oRing, edit, () => `<strong>${esc(ORIGIN.name)}</strong> (edited)<br>${d.origin.lat.toFixed(7)}, ${d.origin.lng.toFixed(7)}`,
        (ll) => editSpots('move start', (x) => { x.origin = { lat: ll[0], lng: ll[1] }; }));
    }
    for (const p of ITEMS) {
      const at = spotOf(d, p);
      const ring = L.circle([at.lat, at.lng], { radius: p.radius, ...ringStyle }).addTo(g);
      addSpotPin(g, at, p.index, ring, edit,
        () => `<strong>${esc(p.name)}</strong> · code ${esc(p.code)}<br>${at.lat.toFixed(7)}, ${at.lng.toFixed(7)}<br>radius ${p.radius} m${state.pos ? ` · ${Geo.formatDistance(Geo.distance(state.pos, at))} from you` : ''}`,
        (ll) => editSpots(`move ${p.id}`, (x) => { x.pois[p.id] = { lat: ll[0], lng: ll[1] }; }));
    }

    for (const pt of debug.points) {
      L.marker([pt.lat, pt.lng], {
        keyboard: false, zIndexOffset: 200,
        icon: L.divIcon({ className: 'pin-icon', html: `<div class="debug-dot"></div><span class="debug-label">${esc(pt.id)}</span>`, iconSize: [12, 12], iconAnchor: [6, 6], popupAnchor: [0, -6] }),
      }).bindPopup(() => `<strong>${esc(pt.id)}</strong> · ${esc(pt.for ? targetName(pt.for) : 'note')}<br>${pt.lat.toFixed(7)}, ${pt.lng.toFixed(7)}<br>±${Math.round(pt.acc)} m · ${pt.fixes} GPS fix${pt.fixes > 1 ? 'es' : ''} · ${clockTime(pt.at)}${pt.note ? `<br>${esc(pt.note)}` : ''}`).addTo(g);
    }
    if (warpEditing()) addWarpHandles(g);
    $('#debug-count').textContent = debug.points.length;
  }

  function addSpotPin(g, at, label, ring, draggable, popup, onDrop) {
    const m = L.marker([at.lat, at.lng], {
      draggable, autoPan: true, keyboard: false, zIndexOffset: 100,
      icon: L.divIcon({ className: 'pin-icon', html: `<div class="poi-pin debug-pin${draggable ? ' editable' : ''}">${label}</div>`, iconSize: [30, 30], iconAnchor: [15, 15], popupAnchor: [0, -14] }),
    }).bindPopup(popup).addTo(g);
    m.on('drag', () => ring.setLatLng(m.getLatLng()));
    m.on('dragend', () => onDrop(ll7(m.getLatLng())));
  }

  // Corner handles (drag to move, tap to delete) and a "+" on every edge long
  // enough to grab (drag it to add a corner there).
  function addCornerHandles(g, poly, work) {
    const n = work.length;
    const midOf = (i) => { const a = work[i], b = work[(i + 1) % n]; return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]; };
    const roomy = (i) => map.latLngToLayerPoint(work[i]).distanceTo(map.latLngToLayerPoint(work[(i + 1) % n])) > 50;
    const mids = work.map((_, i) => {
      if (!roomy(i)) return null;
      const m = L.marker(midOf(i), { draggable: true, autoPan: true, keyboard: false, zIndexOffset: 200, icon: handleIcon('edit-mid', '+') }).addTo(g);
      m.on('drag', () => {
        const t = work.slice();
        t.splice(i + 1, 0, [m.getLatLng().lat, m.getLatLng().lng]);
        poly.setLatLngs(t);
      });
      m.on('dragend', () => editSpots('add corner', (x) => { x.region.splice(i + 1, 0, ll7(m.getLatLng())); }));
      return m;
    });
    work.forEach((_, i) => {
      const v = L.marker(work[i], { draggable: true, autoPan: true, keyboard: false, zIndexOffset: 300, icon: handleIcon('edit-vertex') }).addTo(g);
      v.on('drag', () => {
        const ll = v.getLatLng();
        work[i] = [ll.lat, ll.lng];
        poly.setLatLngs(work);
        for (const k of [(i - 1 + n) % n, i]) mids[k]?.setLatLng(midOf(k));
      });
      v.on('dragend', () => editSpots('move corner', (x) => { x.region[i] = ll7(v.getLatLng()); }));
      v.bindPopup(() => {
        const box = document.createElement('div');
        box.innerHTML = `<strong>Corner ${i + 1} of ${n}</strong><br>`;
        const del = document.createElement('button');
        del.className = 'popup-btn';
        del.textContent = n > 3 ? '🗑 Delete this corner' : 'A boundary needs 3 corners';
        del.disabled = n <= 3;
        del.onclick = () => { map.closePopup(); editSpots('delete corner', (x) => { x.region.splice(i, 1); }); };
        box.append(del);
        return box;
      });
    });
  }

  function toggleEdit() {
    debug.editing = !debug.editing;
    log('debug_edit_mode', { on: debug.editing });
    if (debug.editing) {
      toast(warpEditing()
        ? 'Tap the drawing to add a point, then drag it to where that spot really is. Drag a “+” to bend an edge. Tap a point to delete it.'
        : 'Drag pins and boundary corners. Drag a “+” to add a corner; tap a corner to delete it.', 'info', 6000);
    }
    drawDebug();
    renderDebug();
  }

  function openSimplify() {
    const ring = spots().region;
    const body = document.createElement('p');
    body.textContent = `The boundary has ${ring.length} corners. Simplifying drops corners that barely change its shape (no part of the line moves more than the distance you pick). You can undo it.`;
    const options = [2, 3, 5, 8, 12].map((tol) => ({ tol, ring: Geo.simplifyRing(ring, tol) }))
      .filter((o) => o.ring.length < ring.length && !Geo.crossings(o.ring).length)
      .map((o) => ({ label: `Within ${o.tol} m → ${o.ring.length} corners`, action: () => editSpots(`simplify ${o.tol} m`, (x) => { x.region = o.ring; }) }));
    showModal({ id: 'debug_simplify', title: 'Simplify the boundary', body, compact: true, buttons: [...options, { label: 'Cancel', primary: true }] });
  }

  function applyDraft() {
    if (!debug.draft) return toast('Nothing edited yet', 'info');
    const d = spots();
    if (Geo.crossings(d.region).length) return toast('The boundary crosses itself. Fix that first (Undo, or move the corners).', 'warn', 7000);
    const problems = draftProblems(d);
    showModal({
      id: 'debug_apply', title: 'Use the edits on this phone?', compact: true,
      body: `The app reloads and then uses the edited boundary, spots${draftWarp(d) ? ' and drawing' : ''} instead of js/config.js, on this phone only. A running hunt carries on.`
        + `${problems.length ? `\n\n⚠ ${problems.join('; ')}.` : ''}\n\nTo make it permanent for every phone, put the config block (Points → Copy, or Export) into js/config.js.`,
      buttons: [
        { label: 'Apply and reload', primary: true, action: () => {
          debug.draft.applied = true;
          debug.draft.appliedAt = nowIso();
          saveDraft();
          log('debug_apply');
          location.reload();
        } },
        { label: 'Cancel' },
      ],
    });
  }

  function resetDraft() {
    if (!debug.draft) return toast('Already using js/config.js', 'info');
    const warped = !!draftWarp(debug.draft);
    showModal({
      id: 'debug_reset', title: 'Throw away the edits?', compact: true,
      body: `The boundary, spots${warped ? ' and drawing' : ''} go back to js/config.js${DRAFT_APPLIED ? ' and the app reloads' : ''}. Marked points are kept.`,
      buttons: [
        { label: warped ? 'Reset everything' : 'Reset', danger: true, action: () => {
          debug.undo.push(JSON.stringify(debug.draft));
          debug.draft = null;
          saveDraft();
          log('debug_edit', { what: 'reset' });
          if (DRAFT_APPLIED) location.reload();
          else { drawDebug(); renderDebug(); }
        } },
        ...(warped ? [{ label: 'Reset the drawing only', action: () => editSpots('drawing: reset', (x) => {
          if (DRAFT_APPLIED) setDraftWarp(x, (CONFIG_FILE.WARP && normWarp(CONFIG_FILE.WARP)) || cornerWarp()); // as in config.js (the applied one is in use now)
          else delete x.overlay;
        }) }] : []),
        { label: 'Cancel' },
      ],
    });
  }

  // ---------------------------------------------------------------- panel
  function debugFix(fix) {
    const first = !state.pos;
    state.pos = fix;
    state.lastFixAt = Date.now();
    drawUser(fix);
    if (first && state.follow) {
      markApp('first_fix');
      map.setView([fix.lat, fix.lng], Math.max(map.getZoom(), 17));
    } else {
      followUser(fix);
    }
    renderDebug();
  }

  function renderDebug() {
    const f = state.pos;
    const d = spots();
    $('#debug-gps').textContent = f
      ? `${f.lat.toFixed(6)}, ${f.lng.toFixed(6)} · ±${Math.round(f.acc)} m${f.sim ? ' (sim)' : ''}`
      : SIM ? 'Tap the map to set your position' : 'Waiting for GPS…';
    if (f) {
      const near = ITEMS.map((p) => ({ p, d: Geo.distance(f, spotOf(d, p)) })).sort((a, b) => a.d - b.d)[0];
      const edge = Math.round(Geo.nearestOnPolygon(f, d.region).distance);
      $('#debug-near').textContent = `Nearest: ${near.p.name}, ${Geo.formatDistance(near.d)}${near.d <= near.p.radius ? ' (inside its radius)' : ''}`
        + `${state.proximity ? ` · signal ${state.proximity.value.toFixed(2)}` : ''}`
        + ` · ${Geo.insidePolygon(f, d.region) ? `${edge} m inside the boundary` : `${edge} m OUTSIDE the boundary`}`;
    } else {
      $('#debug-near').textContent = '';
    }
    const problems = draftProblems(d);
    const warping = warpEditing();
    const hint = debug.editing && !warping && map.getZoom() < EDIT_MIN_ZOOM ? ' · zoom in to move corners' : '';
    $('#debug-draft').textContent = `${draftStatus(d)}${hint}${problems.length ? ` · ⚠ ${problems.join('; ')}` : ''}`;
    $('#debug-draft').classList.toggle('warn', problems.length > 0);
    $('#debug-edit-actions').hidden = !debug.editing;
    $('#debug-edit-target').hidden = !debug.editing || !C.OVERLAY;
    $('#btn-edit-spots').classList.toggle('on', !warping);
    $('#btn-edit-drawing').classList.toggle('on', warping);
    $('#btn-debug-simplify').hidden = warping;
    $('#btn-debug-seethrough').hidden = !warping;
    $('#btn-debug-seethrough').classList.toggle('on', debug.seeThrough);
    $('#btn-debug-edit').classList.toggle('on', debug.editing);
    $('#btn-debug-undo').disabled = !debug.undo.length;
  }

  // ----------------------------------------------------------------- marks
  function openMarkDialog() {
    if (!state.pos) return toast(SIM ? 'Tap the map first to set your position' : 'No GPS fix yet. Wait a moment.', 'warn');
    const d = spots();
    const near = ITEMS.map((p) => ({ p, d: Geo.distance(state.pos, spotOf(d, p)) })).sort((a, b) => a.d - b.d)[0].p;
    const wrap = document.createElement('div');
    const intro = document.createElement('p');
    intro.textContent = `${SIM ? 'Simulation: the point is taken where you last tapped.' : `Stand on the spot. GPS is averaged for ${MARK_SECONDS} seconds.`} A mark for an item or the start moves it here (you can undo that in Edit).`;
    const sel = document.createElement('select');
    sel.className = 'debug-field';
    for (const p of [...ITEMS, ORIGIN]) sel.add(new Option(`For ${p.name}`, p.id));
    sel.add(new Option('Just a note (moves nothing)', ''));
    sel.value = near.id;
    const note = document.createElement('input');
    note.className = 'debug-field';
    note.placeholder = 'Note (optional), e.g. "under the bench"';
    note.maxLength = 120;
    wrap.append(intro, sel, note);
    showModal({
      id: 'debug_mark', title: '📍 Mark this spot', body: wrap, compact: true,
      buttons: [{ label: 'Mark it', primary: true, action: () => markSpot(sel.value, note.value.trim()) }, { label: 'Cancel' }],
    });
  }

  async function markSpot(target, note) {
    const btn = $('#btn-debug-mark');
    btn.disabled = true;
    debug.samples = [];
    for (let s = SIM ? 0 : MARK_SECONDS; s > 0; s--) {
      btn.textContent = `Hold still… ${s}`;
      await sleep(1000);
    }
    const samples = debug.samples.length ? debug.samples : [state.pos]; // no new fix came in: use the last one
    debug.samples = null;
    btn.textContent = '📍 Mark';
    btn.disabled = false;
    // Average weighted by 1/accuracy², so the sharper fixes count more.
    let sw = 0, slat = 0, slng = 0;
    for (const f of samples) {
      const w = 1 / Math.max(1, f.acc) ** 2;
      sw += w; slat += f.lat * w; slng += f.lng * w;
    }
    const mean = { lat: slat / sw, lng: slng / sw };
    const n = debug.points.reduce((m, p) => Math.max(m, parseInt(p.id.slice(1), 10) || 0), 0) + 1;
    const point = {
      id: `P${n}`, for: target || null, note,
      lat: round(mean.lat, 7), lng: round(mean.lng, 7),
      acc: round(samples.reduce((s, f) => s + f.acc, 0) / samples.length, 1),      // average reported accuracy
      spreadM: round(Math.max(...samples.map((f) => Geo.distance(f, mean))), 1), // how far the fixes wandered
      fixes: samples.length, at: nowIso(), sim: !!samples[0].sim,
    };
    debug.points.push(point);
    savePoints();
    log('debug_mark', { id: point.id, for: point.for, lat: point.lat, lng: point.lng, acc: point.acc, fixes: point.fixes });
    const fixes = `±${Math.round(point.acc)} m, ${point.fixes} GPS fix${point.fixes > 1 ? 'es' : ''}`;
    if (point.for) {
      const d = spots();
      const was = point.for === ORIGIN.id ? d.origin : spotOf(d, itemById(point.for));
      const at = { lat: point.lat, lng: point.lng };
      editSpots(`mark ${point.for}`, (x) => { if (point.for === ORIGIN.id) x.origin = at; else x.pois[point.for] = at; });
      toast(`📍 ${point.id} saved: ${targetName(point.for)} moved here, ${Geo.formatDistance(Geo.distance(was, at))} from before (${fixes})`, 'ok', 6000);
    } else {
      drawDebug();
      toast(`📍 ${point.id} saved (${fixes})`, 'ok');
    }
  }

  function openPointsList() {
    const wrap = document.createElement('div');
    const render = () => {
      wrap.textContent = '';
      if (!debug.points.length) {
        wrap.textContent = 'No points yet. Walk to a spot and tap “Mark”.';
        return;
      }
      const ul = document.createElement('ul');
      ul.className = 'debug-list';
      for (const pt of [...debug.points].reverse()) {
        const li = document.createElement('li');
        li.innerHTML = `<span><b>${esc(pt.id)}</b> ${esc(pt.for ? targetName(pt.for) : 'Note')}${pt.note ? ` · ${esc(pt.note)}` : ''}`
          + `<small>±${Math.round(pt.acc)} m · ${pt.fixes} fix${pt.fixes > 1 ? 'es' : ''} · ${clockTime(pt.at)}</small></span>`;
        const show = document.createElement('button');
        show.textContent = '📍';
        show.setAttribute('aria-label', `Show ${pt.id} on the map`);
        show.onclick = () => {
          wrap.closest('.modal').querySelector('button.primary').click();
          setFollow(false, 'debug_point');
          markApp('debug_point');
          map.flyTo([pt.lat, pt.lng], 19, { duration: 0.8 });
        };
        const del = document.createElement('button');
        del.textContent = '🗑';
        del.setAttribute('aria-label', `Delete ${pt.id}`);
        del.onclick = () => {
          debug.points = debug.points.filter((x) => x !== pt);
          savePoints();
          drawDebug();
          log('debug_delete', { id: pt.id });
          render();
        };
        li.append(show, del);
        ul.append(li);
      }
      wrap.append(ul);
    };
    render();
    showModal({
      id: 'debug_points', title: 'Marked points', body: wrap, compact: true,
      buttons: [
        { label: 'Close', primary: true },
        { label: 'Copy config block', action: copyConfig },
        { label: 'Delete all points', danger: true, action: confirmClearPoints },
      ],
    });
  }

  function confirmClearPoints() {
    showModal({
      id: 'debug_clear', title: 'Delete all marked points?', body: 'Export them first if you still need them. Spots they moved stay where they are.', compact: true,
      buttons: [{ label: 'Delete all', danger: true, action: () => { debug.points = []; savePoints(); drawDebug(); log('debug_delete', { id: 'all' }); } }, { label: 'Cancel' }],
    });
  }

  // ---------------------------------------------------------------- export
  // REGION, ORIGIN and POIS as they'd look in js/config.js with the edits in.
  // Everything else about each item (name, code, hint…) is kept.
  function configLines() {
    const d = spots();
    const q = (s) => `'${String(s ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
    const file = Object.fromEntries(CONFIG_FILE.POIS.map((p) => [p.id, p]));
    const moved = (a, b) => {
      const m = b ? Geo.distance(a, b) : 0;
      return m >= 0.5 ? ` // moved ${m < 10 ? m.toFixed(1) : Math.round(m)} m` : '';
    };
    const lines = [`  // ${d.region.length} corners`, '  REGION: [', ...d.region.map(([lat, lng]) => `    [${lat.toFixed(7)}, ${lng.toFixed(7)}],`), '  ],', ''];
    lines.push(`  ORIGIN: { name: ${q(C.ORIGIN.name)}, lat: ${d.origin.lat.toFixed(7)}, lng: ${d.origin.lng.toFixed(7)}${C.ORIGIN.radius ? `, radius: ${C.ORIGIN.radius}` : ''} },${moved(d.origin, CONFIG_FILE.ORIGIN)}`, '', '  POIS: [');
    for (const p of C.POIS) {
      const a = spotOf(d, p);
      lines.push(`    { id: ${q(p.id)}, name: ${q(p.name)}, code: ${q(p.code || p.id)}, lat: ${a.lat.toFixed(7)}, lng: ${a.lng.toFixed(7)}${p.radius ? `, radius: ${p.radius}` : ''}, hint: ${q(p.hint)} },${moved(a, file[p.id])}`);
    }
    lines.push('  ],');
    const w = configWarp(d);
    if (w) {
      const O = C.OVERLAY;
      const at = (u, v) => { const p = w.find((x) => x[0] === u && x[1] === v); return `[${p[2].toFixed(7)}, ${p[3].toFixed(7)}]`; };
      const sorted = [...w].sort((a, b) => a[1] - b[1] || a[0] - b[0]);
      lines.push('', '  OVERLAY: {', `    url: ${q(O.url)},`, `    topLeft:    ${at(0, 0)},`, `    topRight:   ${at(1, 0)},`, `    bottomLeft: ${at(0, 1)},`,
        `    opacity: ${O.opacity ?? 1},`, `    streetMap: ${O.streetMap !== false},`,
        `    // ${w.length} warp points from the debug view: [across, down, lat, lng],`,
        '    // across/down = where in the picture, 0–1 (0, 0 = top-left corner).',
        '    warp: [', ...sorted.map((p) => `      [${round(p[0], 5)}, ${round(p[1], 5)}, ${p[2].toFixed(7)}, ${p[3].toFixed(7)}],`), '    ],', '  },');
    }
    return lines;
  }
  // The drawing's warp for the config block: edited, or already in config.js.
  const configWarp = (d) => (C.OVERLAY ? draftWarp(d) || C.OVERLAY.warp : null);

  async function copyConfig() {
    try {
      await navigator.clipboard.writeText(configLines().join('\n'));
      toast(`Config block copied: in js/config.js, replace REGION, ORIGIN, POIS${configWarp(spots()) ? ' and OVERLAY' : ''} with it`, 'ok', 6000);
    } catch (e) {
      toast('Could not copy here. Use Export instead; the file contains the same block.', 'warn');
    }
  }

  function exportDebug() {
    const d = spots();
    const point = (props, lat, lng) => ({ type: 'Feature', properties: props, geometry: { type: 'Point', coordinates: [lng, lat] } });
    const data = {
      type: 'FeatureCollection',
      features: [
        ...debug.points.map((pt) => point({
          id: pt.id, for: pt.for, forName: pt.for ? targetName(pt.for) : null, note: pt.note || null,
          accuracyM: pt.acc, spreadM: pt.spreadM, fixes: pt.fixes, time: pt.at, simulated: pt.sim, 'marker-color': '#7c3aed',
        }, pt.lat, pt.lng)),
        point({ id: ORIGIN.id, name: ORIGIN.name, 'marker-color': '#1d4ed8' }, d.origin.lat, d.origin.lng),
        ...ITEMS.map((p) => point({ id: p.id, name: p.name, 'marker-color': '#ea580c' }, spotOf(d, p).lat, spotOf(d, p).lng)),
        { type: 'Feature', properties: { name: 'Hunt boundary', corners: d.region.length, stroke: C.BOUNDARY_COLOR, 'fill-opacity': 0.05 }, geometry: { type: 'Polygon', coordinates: [[...d.region, d.region[0]].map(([lat, lng]) => [lng, lat])] } },
        ...(configWarp(d) || []).map((p) => point({ name: 'Drawing warp point', across: p[0], down: p[1], 'marker-color': '#0d9488', 'marker-size': 'small' }, p[2], p[3])),
      ],
      // Paste these lines over REGION, ORIGIN and POIS (and OVERLAY, if there) in js/config.js.
      config: configLines(),
    };
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' }));
    a.download = `hunt-debug_${fileStamp(new Date())}.json`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    log('debug_download', { points: debug.points.length, edited: !!debug.draft });
    toast(`⬇ Saved ${a.download}`, 'ok');
  }

  // ======================================================= SCREEN / APP STATE
  async function requestWakeLock() {
    if (!('wakeLock' in navigator) || document.visibilityState !== 'visible' || state.wakeLock) return;
    try {
      state.wakeLock = await navigator.wakeLock.request('screen');
      if (running()) log('wakelock_on'); // also used while scouting in the debug view, which isn't logged
      state.wakeLock.addEventListener('release', () => {
        state.wakeLock = null;
        if (running()) log('wakelock_off');
      });
    } catch (e) {
      log('wakelock_error', { message: e.message });
    }
  }

  function onVisibility() {
    const visible = document.visibilityState === 'visible';
    if (!visible) {
      state.hiddenAt = Date.now();
      closeScanner('app_hidden'); // release the camera
    }
    log('app_visibility', { state: document.visibilityState, hiddenForMs: visible && state.hiddenAt ? Date.now() - state.hiddenAt : undefined });
    if (visible && (running() || debug.on)) requestWakeLock();
  }

  function configProblems() {
    const out = [];
    if (!Geo.insidePolygon(ORIGIN, REGION)) out.push(`ORIGIN “${ORIGIN.name}” is outside REGION — check its lat/lng.`);
    const ids = new Set();
    const codes = new Map();
    for (const p of ITEMS) {
      if (!Geo.insidePolygon(p, REGION)) out.push(`${p.name} is outside REGION — check its lat/lng (latitude first).`);
      if (ids.has(p.id)) out.push(`Two items share the id “${p.id}”.`);
      ids.add(p.id);
      const key = normCode(p.code);
      if (!key) out.push(`${p.name}: its code “${p.code}” needs at least one letter or digit.`);
      else if (codes.has(key)) out.push(`${codes.get(key).name} and ${p.name} have the same QR code.`);
      else codes.set(key, p);
    }
    return out;
  }

  function showStart(saved) {
    const warnings = configProblems();
    if (!isSecureContext) warnings.push('This page is not served over HTTPS, so GPS and camera are blocked. Host it on GitHub Pages (see README).');
    if (SIM) warnings.push('Simulation mode: GPS is replaced by tapping the map.');
    if (DRAFT_APPLIED) warnings.push('This phone uses the boundary, spots and drawing edited in the debug view, not js/config.js. Debug view → Edit → Reset to go back.');
    $('#start-warnings').innerHTML = warnings.map((w) => `<p>⚠️ ${esc(w)}</p>`).join('');

    $('#start-new').hidden = !!saved;
    $('#start-resume').hidden = !saved;
    if (saved) {
      const found = ITEMS.filter((p) => saved.items[p.id]?.foundAt).length;
      $('#resume-text').textContent = `Team “${saved.team}” has a hunt in progress (${found}/${ITEMS.length} found, started ${clockTime(saved.startedAt)}).`;
      $('#btn-resume').onclick = () => resumeHunt(saved);
    }
    $('#start-screen').hidden = false;
  }

  function bindUi() {
    document.addEventListener('click', (e) => {
      const el = e.target.closest('[data-log]');
      if (el) log('ui_tap', { control: el.dataset.log });
    }, true);

    $('#btn-start').onclick = startHunt;
    $('#team-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') startHunt(); });
    $('#btn-discard').onclick = () => discardAndReload('The hunt in progress on this phone will be deleted, including its logs and GPS track.');

    $('#btn-zoom-in').onclick = () => { markApp('button_in'); map.zoomIn(); };
    $('#btn-zoom-out').onclick = () => { markApp('button_out'); map.zoomOut(); };
    $('#btn-locate').onclick = locateMe;
    $('#btn-area').onclick = () => { setFollow(false, 'fit_area'); markApp('fit_area'); map.fitBounds(regionBounds); };
    $('#btn-list').onclick = openSheet;
    $('#btn-sheet-close').onclick = closeSheet;
    $('#sheet-backdrop').onclick = closeSheet;
    $('#btn-finish').onclick = confirmFinish;
    $('#boundary-banner').onclick = () => {
      if (!state.pos) return;
      const edge = Geo.nearestOnPolygon(state.pos, REGION);
      setFollow(false, 'boundary_banner');
      markApp('boundary_banner');
      map.fitBounds(L.latLngBounds([[state.pos.lat, state.pos.lng], [edge.lat, edge.lng]]).pad(0.6), { maxZoom: 18 });
    };

    if (C.DEBUG_TOOLS) {
      $('#btn-debug').hidden = false;
      $('#btn-debug-start').hidden = false;
      $('#btn-debug').onclick = () => setDebug(!debug.on);
      $('#btn-debug-start').onclick = () => setDebug(true);
      $('#btn-debug-close').onclick = () => setDebug(false);
      $('#btn-debug-mark').onclick = openMarkDialog;
      $('#btn-debug-points').onclick = openPointsList;
      $('#btn-debug-download').onclick = exportDebug;
      $('#btn-debug-edit').onclick = toggleEdit;
      $('#btn-debug-undo').onclick = undoEdit;
      $('#btn-debug-simplify').onclick = openSimplify;
      $('#btn-debug-apply').onclick = applyDraft;
      $('#btn-debug-reset').onclick = resetDraft;
      $('#btn-edit-spots').onclick = () => setEditTarget('spots');
      $('#btn-edit-drawing').onclick = () => setEditTarget('drawing');
      $('#btn-debug-seethrough').onclick = toggleSeeThrough;
      map.on('click', (e) => { if (warpEditing()) addWarpPoint(e.latlng); });
      map.on('zoomend', () => {
        if (!debug.on || !debug.editing) return;
        drawDebug(); // corner handles appear / thin out with the zoom
        renderDebug();
      });
    }

    $('#btn-scan').onclick = () => openScanner('button');
    $('#btn-scan-close').onclick = () => closeScanner('cancel');
    $('#btn-torch').onclick = toggleTorch;
    $('#btn-scan-manual').onclick = () => openManualEntry();

    $('#btn-download').onclick = () => downloadResults();
    $('#btn-new').onclick = () => discardAndReload(state.session?.downloadedAt
      ? 'This removes the hunt from this phone. Make sure the results file has reached the organiser first.'
      : 'The results file has not been downloaded yet. If you continue, this hunt’s logs are gone for good.');

    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('online', () => log('network', { online: true }));
    window.addEventListener('offline', () => log('network', { online: false }));
    window.addEventListener('pagehide', () => log('page_hide'));
    screen.orientation?.addEventListener('change', () => log('orientation', { type: screen.orientation.type }));
    window.addEventListener('error', (e) => log('js_error', { message: e.message, source: e.filename, line: e.lineno }));
    window.addEventListener('unhandledrejection', (e) => log('js_error', { message: String(e.reason?.message || e.reason) }));
  }

  // ================================================================ BOOT
  async function boot() {
    document.documentElement.style.setProperty('--mask', C.MASK_COLOR);
    document.title = C.HUNT_NAME;
    $('#hunt-name').textContent = C.HUNT_NAME;
    $('#start-title').textContent = C.HUNT_NAME;
    $('#item-total').textContent = ITEMS.length;
    initMap();
    bindUi();
    updateHud();
    log('app_load', { appVersion: APP_VERSION, sim: SIM, secure: isSecureContext, overlay: C.OVERLAY?.url ?? null, userAgent: navigator.userAgent });

    const saved = await Store.get('meta', 'session').catch(() => null);
    if (!saved) {
      showStart(null);
    } else if (saved.phase === 'running') {
      showStart(saved);
    } else {
      state.session = saved;
      showFinishScreen();
    }

    if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
      navigator.serviceWorker.register('sw.js').catch((e) => console.warn('Service worker not registered', e));
    }
  }

  if (SIM) window.__hunt = { state, simulateFix: (lat, lng) => simulateFix(L.latLng(lat, lng)), log };
  boot();
})();
