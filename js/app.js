/* Treasure Hunt navigator — main application.
 * Plain browser JavaScript, no build step. Needs Leaflet, HUNT_CONFIG (config.js), Geo and Store. */
(function () {
  "use strict";

  // ---- Configuration and applied debug overrides -------------------------
  // Apply saved overrides before deriving REGION, ITEMS, ORIGIN, or map bounds.
  const C = window.HUNT_CONFIG;
  const fatal = (text) => {
    const p = document.createElement("p");
    p.className = "fatal";
    p.textContent = text;
    document.body.prepend(p);
  };
  if (!C || !window.L) {
    fatal(
      !C
        ? "js/config.js could not be read — it probably has a typo (a missing comma or bracket). Open Chrome DevTools → Console to see the line."
        : "Could not load the map library. Check your internet connection and reload.",
    );
    return;
  }
  // Edits from the debug view, once "applied", replace the boundary, spots
  // and drawing warp from config.js on this phone only, and only while
  // DEBUG_TOOLS is on.
  const DRAFT_KEY = "hunt-debug-draft";
  const CONFIG_FILE = JSON.parse(
    JSON.stringify({
      ORIGIN: C.ORIGIN,
      POIS: C.POIS,
      WARP: C.OVERLAY?.warp ?? null,
    }),
  ); // as written in config.js
  let DRAFT_APPLIED = false;
  if (C.DEBUG_TOOLS) {
    try {
      const d = JSON.parse(localStorage.getItem(DRAFT_KEY));
      if (d?.applied) {
        C.REGION = d.region;
        C.ORIGIN = { ...C.ORIGIN, ...d.origin };
        C.POIS = C.POIS.map((p) =>
          d.pois[p.id] ? { ...p, ...d.pois[p.id] } : p,
        );
        if (d.overlay && C.OVERLAY && d.overlay.url === C.OVERLAY.url)
          C.OVERLAY = { ...C.OVERLAY, warp: d.overlay.warp };
        DRAFT_APPLIED = true;
      }
    } catch (e) {
      /* unreadable draft: ignore it */
    }
  }
  if (C.OVERLAY?.warp) C.OVERLAY.warp = normWarp(C.OVERLAY.warp);

  let REGION;
  try {
    REGION = Geo.parseRegion(C.REGION);
  } catch (e) {
    fatal(`Problem in js/config.js: ${e.message}`);
    return;
  }
  const APP_VERSION = "2.0.0";
  const SIM =
    !!C.SIMULATE_GPS || new URLSearchParams(location.search).has("sim");

  // ---- Shared utilities --------------------------------------------------
  const $ = (sel) => document.querySelector(sel);
  const round = (v, d = 6) =>
    v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d;
  const nowIso = () => new Date().toISOString();
  const pad = (n) => String(n).padStart(2, "0");
  const esc = (s) =>
    String(s ?? "").replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
  const fileStamp = (d) =>
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const clockTime = (iso) =>
    new Date(iso).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function duration(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
  }

  const loadScript = (src) =>
    new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error(`could not load ${src}`));
      document.head.append(s);
    });

  // ---- Hunt targets and puzzle defaults ----------------------------------
  const ITEMS = C.POIS.map((p, i) => ({
    ...p,
    index: i + 1,
    radius: p.radius || C.PROXIMITY_RADIUS_M,
    code: String(p.code || p.id),
  }));
  const ORIGIN = {
    id: "origin",
    ...C.ORIGIN,
    radius: C.ORIGIN.radius || C.PROXIMITY_RADIUS_M,
  };
  const itemById = (id) => ITEMS.find((p) => p.id === id);

  // Codes match ignoring case, spaces and punctuation, so a typed "k7q2-xm" counts.
  const normCode = (s) =>
    String(s ?? "")
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "");
  const BY_CODE = new Map();
  for (const p of ITEMS)
    if (normCode(p.code) && !BY_CODE.has(normCode(p.code)))
      BY_CODE.set(normCode(p.code), p);
  const itemForCode = (text) => BY_CODE.get(normCode(text)) || null;

  // Puzzles from questions.json, one per item in item order (see loadQuestions).
  const QUIZ_TRIES = C.QUIZ_TRIES || 3;
  // Ring radius by the level solved; a plain number counts for both levels.
  const quizRadius = (level) => {
    const r = C.QUIZ_REVEAL_RADIUS_M;
    return (
      (r && typeof r === "object" ? r[level] : r) ||
      (level === "hard" ? 10 : 20)
    );
  };
  const quizProblems = [];
  // Answers match ignoring case, full/half width, spaces and punctuation, and katakana = hiragana.
  const normAnswer = (s) =>
    String(s ?? "")
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60))
      .replace(/[^\p{L}\p{N}]/gu, "");

  // ---- Shared runtime state and session accessors ------------------------
  const state = {
    session: null, // persisted in IndexedDB under meta/session
    pos: null, // latest GPS fix
    lastFixAt: 0,
    proximity: null, // THE PROXIMITY VARIABLE, see TREASURE SIGNAL below
    signalLevel: -1,
    outside: false,
    outsideStreak: 0,
    lastOutsideAlert: 0,
    follow: true,
    watchId: null,
    wakeLock: null,
    hiddenAt: 0,
    timers: [],
    preStart: [], // events logged before Start / Resume, flushed into the session
  };

  const running = () => state.session?.phase === "running";
  const isFound = (id) => !!state.session?.items[id]?.foundAt;
  const foundCount = () => ITEMS.filter((p) => isFound(p.id)).length;
  const quizOf = (id) => state.session?.quiz?.[id] || { tries: 0 }; // { tries, solvedAt }
  const isSolved = (id) => !!quizOf(id).solvedAt;
  const saveSession = () => Store.put("meta", state.session, "session");

  // ---- Session event logging ---------------------------------------------
  // Every record carries the map viewport at that moment, so the log alone
  // reconstructs what the player was looking at.
  function viewSnapshot() {
    if (!mapReady) return null;
    const c = map.getCenter();
    const b = map.getBounds();
    return {
      zoom: round(map.getZoom(), 2),
      lat: round(c.lat),
      lng: round(c.lng),
      bounds: [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()].map((v) =>
        round(v),
      ),
    };
  }

  // Uses map and debug state; events before a session starts may be buffered.
  function log(type, data) {
    const ts = Date.now();
    const rec = {
      ts,
      iso: new Date(ts).toISOString(),
      type,
      ...data,
      view: viewSnapshot(),
    };
    const s = state.session;
    if (!s) {
      // Scouting in the debug view before a hunt isn't part of any team's log.
      const scouting =
        debug.on ||
        type.startsWith("debug_") ||
        String(data?.control).startsWith("debug");
      if (state.preStart.length < 5000 && !scouting) state.preStart.push(rec);
    } else if (s.phase === "running") {
      Store.add("events", rec).catch((e) =>
        console.error("log write failed", e),
      );
    }
    if (SIM) console.debug("[log]", type, data || "");
  }

  function flushPreStart() {
    // Adds are queued in order, so the buffered events keep their position in the log.
    for (const rec of state.preStart.splice(0))
      Store.add("events", { ...rec, buffered: true });
  }

  // ---- Map setup and viewport state --------------------------------------
  let map, maskRenderer, userMarker, accCircle, guideLine;
  let mapReady = false;
  const regionBounds = L.latLngBounds(REGION);
  // Everything worth seeing: the hunt area plus the drawing (if any).
  const viewBounds = L.latLngBounds(REGION);
  for (const p of C.OVERLAY ? C.OVERLAY.warp || cornerWarp() || [] : [])
    viewBounds.extend([p[2], p[3]]);
  const padMetres = (b, m) => {
    const dLat = m / 111320,
      dLng = m / (111320 * Math.cos((b.getCenter().lat * Math.PI) / 180));
    return L.latLngBounds(
      [b.getSouth() - dLat, b.getWest() - dLng],
      [b.getNorth() + dLat, b.getEast() + dLng],
    );
  };
  const pins = {};

  // Programmatic moves are tagged so the log can tell them apart from the player's gestures.
  let appAction = null; // { source, at }
  let currentMove = null; // { source }
  let zoomInfo = null; // { from, trigger }
  const gesture = {
    pointers: new Set(),
    maxPointers: 0,
    lastUp: 0,
    lastWheel: 0,
    lastTap: 0,
    lastDoubleTap: 0,
  };
  const appSource = () =>
    appAction && Date.now() - appAction.at < 1500 ? appAction.source : null;
  const markApp = (source) => {
    appAction = { source, at: Date.now() };
  };

  function initMap() {
    map = L.map("map", {
      zoomControl: false,
      maxBounds: viewBounds, // panning stops 300 m past the area / drawing
      maxBoundsViscosity: 1,
      maxZoom: C.MAX_ZOOM,
      zoomSnap: 0.25,
      bounceAtZoomLimits: false,
    });
    map.fitBounds(regionBounds);
    updateMinZoom();

    map.createPane("drawing").style.zIndex = 350; // your drawing: over the street map, under rings and markers
    map.createPane("mask").style.zIndex = 450; // boundary line, outside shading, GPS circle: above tiles/overlays, below markers
    map.createPane("me").style.zIndex = 640; // the player's dot sits above everything

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
    maskRenderer = L.svg({ pane: "mask", padding: 1 });
    const shade = Math.min(1, Math.max(0, C.OUTSIDE_SHADE ?? 0));
    if (shade > 0) {
      const world = [
        [-85, -180],
        [-85, 180],
        [85, 180],
        [85, -180],
      ];
      L.polygon([world, REGION], {
        renderer: maskRenderer,
        stroke: false,
        fillColor: C.MASK_COLOR,
        fillOpacity: shade,
        interactive: false,
      }).addTo(map);
    }
    L.polygon(REGION, {
      renderer: maskRenderer,
      color: C.BOUNDARY_COLOR,
      weight: 3,
      dashArray: "10 8",
      fill: false,
      interactive: false,
    }).addTo(map);

    addPins();
    bindMapLogging();
    mapReady = true;
  }

  function updateMinZoom() {
    map.setMinZoom(map.getBoundsZoom(viewBounds, true));
  }

  // ---- Map drawing overlays ----------------------------------------------
  // Warp points are [across, down, lat, lng]: across/down 0–1 in the picture
  // (0, 0 = top-left corner). These are its corners as config.js places them;
  // the bottom-right one follows from the other three.
  function cornerWarp() {
    const O = C.OVERLAY;
    const [tl, tr, bl] = [O.topLeft, O.topRight, O.bottomLeft].map((c) =>
      c ? L.latLng(c) : null,
    );
    if (!tl || !tr || !bl) return null;
    return [
      [0, 0, tl.lat, tl.lng],
      [1, 0, tr.lat, tr.lng],
      [0, 1, bl.lat, bl.lng],
      [1, 1, tr.lat + bl.lat - tl.lat, tr.lng + bl.lng - tl.lng],
    ];
  }

  // OVERLAY.warp, tidied up: inside the picture, and all four corners present
  // (missing ones come from topLeft/topRight/bottomLeft). null if unusable.
  function normWarp(list) {
    const clamp = (x) => Math.min(1, Math.max(0, x));
    const out = (Array.isArray(list) ? list : [])
      .filter(
        (p) =>
          Array.isArray(p) &&
          p.length >= 4 &&
          p.slice(0, 4).every(Number.isFinite),
      )
      .map(([u, v, lat, lng]) => [clamp(u), clamp(v), lat, lng]);
    for (const c of cornerWarp() || [])
      if (!out.some((p) => p[0] === c[0] && p[1] === c[1])) out.push(c);
    return [
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
    ].every(([u, v]) => out.some((p) => p[0] === u && p[1] === v))
      ? out
      : null;
  }

  // The drawing pinned by its corners, or bent by warp points.
  let drawing = null;
  let drawingKey = ""; // the warp last fully painted ('' = only a quick preview)
  let drawingFailed = false;
  function showDrawing(warp, opacity) {
    const O = C.OVERLAY;
    const Type = warp ? L.WarpedImageOverlay : L.CornerImageOverlay;
    const key = JSON.stringify(warp);
    if (!(drawing instanceof Type)) {
      drawing?.remove();
      const opts = { pane: "drawing", opacity: O.opacity ?? 1 };
      drawing = warp
        ? new L.WarpedImageOverlay(O.url, warp, opts)
        : new L.CornerImageOverlay(
            O.url,
            [O.topLeft, O.topRight, O.bottomLeft],
            opts,
          );
      drawing.on("error", () => {
        if (drawingFailed) return;
        drawingFailed = true;
        log("overlay_error", { url: O.url });
        $("#start-warnings").insertAdjacentHTML(
          "beforeend",
          `<p>⚠️ The drawing “${esc(O.url)}” could not be loaded. Check OVERLAY.url in js/config.js and that the file was uploaded.</p>`,
        );
      });
      drawing.on("load", () => warpEditing() && drawDebug()); // the warp handles need the picture's size
      drawing.addTo(map);
    } else if (warp && key !== drawingKey) {
      drawing.setWarp(warp);
    }
    drawingKey = key;
    drawing.setOpacity(opacity ?? O.opacity ?? 1);
  }

  function previewDrawing(warp) {
    // quick repaint while a warp point is dragged
    drawing.setWarp(
      warp.map((p) => p.slice()),
      true,
    );
    drawingKey = "";
  }

  // ---- Map pins and solved-puzzle rings ----------------------------------
  function pinIcon(p) {
    const origin = p === ORIGIN;
    const done = !origin && isFound(p.id);
    const label = origin ? "🏁" : done ? "✓" : p.index;
    return L.divIcon({
      className: "pin-icon",
      html: `<div class="poi-pin${origin ? " origin" : ""}${done ? " done" : ""}">${label}</div>`,
      iconSize: [34, 34],
      iconAnchor: [17, 17],
      popupAnchor: [0, -16],
    });
  }

  function popupHtml(p) {
    const status =
      p === ORIGIN
        ? "Start &amp; finish point"
        : isFound(p.id)
          ? "✓ Found"
          : "Not found yet";
    const dist = state.pos
      ? ` · ${Geo.formatDistance(Geo.distance(state.pos, p))} away`
      : "";
    return `<strong>${esc(p.name)}</strong><br><small>${status}${dist}</small>${p.hint ? `<br>${esc(p.hint).replace(/\n/g, "<br>")}` : ""}`;
  }

  function addPin(p) {
    if (p !== ORIGIN && C.REVEAL_POIS) {
      L.circle([p.lat, p.lng], {
        radius: p.radius,
        color: "#ea580c",
        weight: 1,
        fillOpacity: 0.08,
        interactive: false,
      }).addTo(map);
    }
    const m = L.marker([p.lat, p.lng], {
      icon: pinIcon(p),
      title: p.name,
      keyboard: false,
    });
    m.bindPopup(() => popupHtml(p));
    m.on("click", () => log("poi_tap", { poiId: p.id }));
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
    refreshQuizRings();
  }

  // A solved puzzle shows a ring around its item (like the debug view's)
  // until the item is found.
  const quizRings = {}; // poiId -> layer group, made on first use
  function refreshQuizRings() {
    for (const p of ITEMS) {
      const show = isSolved(p.id) && !isFound(p.id);
      if (show && !quizRings[p.id]?._map) {
        (quizRings[p.id] ||= L.layerGroup([
          L.circle([p.lat, p.lng], {
            radius: quizRadius(quizOf(p.id).solvedLevel),
            className: "quiz-ring",
            weight: 2,
            dashArray: "4 5",
            interactive: false,
          }),
          L.marker([p.lat, p.lng], {
            keyboard: false,
            title: p.name,
            icon: L.divIcon({
              className: "pin-icon",
              html: `<div class="poi-pin quiz-pin">${p.index}</div>`,
              iconSize: [30, 30],
              iconAnchor: [15, 15],
            }),
          }).on("click", () => {
            log("poi_tap", { poiId: p.id, ring: "quiz" });
            openItemInfo(p);
          }),
        ])).addTo(map);
      } else if (!show && quizRings[p.id]?._map) {
        quizRings[p.id].remove();
      }
    }
  }

  // ---- Map gesture and viewport logging ----------------------------------
  function bindMapLogging() {
    const el = map.getContainer();
    el.addEventListener(
      "pointerdown",
      (e) => {
        if (!gesture.pointers.size) gesture.maxPointers = 0;
        gesture.pointers.add(e.pointerId);
        gesture.maxPointers = Math.max(
          gesture.maxPointers,
          gesture.pointers.size,
        );
      },
      true,
    );
    const up = (e) => {
      gesture.pointers.delete(e.pointerId);
      gesture.lastUp = Date.now();
    };
    window.addEventListener("pointerup", up, true);
    window.addEventListener("pointercancel", up, true);
    el.addEventListener(
      "wheel",
      () => {
        gesture.lastWheel = Date.now();
      },
      { capture: true, passive: true },
    );
    el.addEventListener(
      "click",
      () => {
        const t = Date.now();
        if (t - gesture.lastTap < 400) gesture.lastDoubleTap = t;
        gesture.lastTap = t;
      },
      true,
    );
    el.addEventListener(
      "dblclick",
      () => {
        gesture.lastDoubleTap = Date.now();
      },
      true,
    );

    const gestureTrigger = () => {
      const t = Date.now();
      if (
        gesture.maxPointers >= 2 &&
        (gesture.pointers.size >= 2 || t - gesture.lastUp < 800)
      )
        return "pinch";
      if (t - gesture.lastWheel < 500) return "wheel";
      if (t - gesture.lastDoubleTap < 800) return "double_tap";
      return "other";
    };

    map.on("movestart", () => {
      currentMove = { source: appSource() || "user" };
    });
    map.on("moveend", () => {
      if (!currentMove) return; // Leaflet fires a bare moveend for zero-length pans
      log("view_change", { source: currentMove.source });
      currentMove = null;
      appAction = null;
    });
    map.on("zoomstart", () => {
      zoomInfo = {
        from: map.getZoom(),
        trigger: appSource() || gestureTrigger(),
      };
    });
    map.on("zoomend", () => {
      const to = map.getZoom();
      if (zoomInfo && to !== zoomInfo.from)
        log("zoom", {
          from: round(zoomInfo.from, 2),
          to: round(to, 2),
          trigger: zoomInfo.trigger,
        });
      zoomInfo = null;
    });
    map.on("dragstart", () => {
      log("pan_start");
      setFollow(false, "drag");
    });
    map.on("dragend", (e) =>
      log("pan_end", { distancePx: Math.round(e.distance || 0) }),
    );
    map.on("click", (e) => {
      log("map_tap", { lat: round(e.latlng.lat), lng: round(e.latlng.lng) });
      if (SIM && (running() || debug.on) && !warpEditing())
        simulateFix(e.latlng); // taps add warp points there instead
    });
    map.on("contextmenu", (e) =>
      log("map_long_press", {
        lat: round(e.latlng.lat),
        lng: round(e.latlng.lng),
      }),
    );
    map.on("popupclose", () => log("popup_close"));
    map.on("autopanstart", () => markApp("popup_autopan"));
    map.on("resize", () => {
      updateMinZoom();
      const s = map.getSize();
      log("map_resize", { width: s.x, height: s.y });
    });
  }

  // ---- Map following and player position ---------------------------------
  function setFollow(on, reason) {
    if (state.follow === on) return;
    state.follow = on;
    $("#btn-locate").classList.toggle("active", on);
    log(on ? "follow_on" : "follow_off", { reason });
  }

  function followUser(fix) {
    if (!state.follow || zoomInfo || gesture.pointers.size) return;
    const pt = map.latLngToContainerPoint([fix.lat, fix.lng]);
    if (pt.distanceTo(map.getSize().divideBy(2)) < 30) return; // ignore GPS jitter
    markApp("follow");
    map.panTo([fix.lat, fix.lng], { animate: true, duration: 0.6 });
  }

  function locateMe() {
    if (!state.pos) return toast("Waiting for a GPS fix…", "info");
    setFollow(true, "locate_button");
    markApp("locate_button");
    map.setView([state.pos.lat, state.pos.lng], Math.max(map.getZoom(), 17));
  }

  function drawUser(fix) {
    const at = [fix.lat, fix.lng];
    if (!userMarker) {
      userMarker = L.marker(at, {
        pane: "me",
        interactive: false,
        keyboard: false,
        icon: L.divIcon({
          className: "me-icon",
          html: '<div class="me-dot"></div>',
          iconSize: [22, 22],
          iconAnchor: [11, 11],
        }),
      }).addTo(map);
      accCircle = L.circle(at, {
        renderer: maskRenderer,
        radius: fix.acc,
        color: "#2563eb",
        weight: 1,
        opacity: 0.5,
        fillColor: "#3b82f6",
        fillOpacity: 0.12,
        interactive: false,
      }).addTo(map);
    } else {
      userMarker.setLatLng(at);
      accCircle.setLatLng(at).setRadius(fix.acc);
    }
    setGpsPill(
      fix.sim
        ? "sim"
        : fix.acc <= 15
          ? "good"
          : fix.acc <= C.MAX_ACCURACY_M
            ? "fair"
            : "poor",
      fix.acc,
    );
  }

  function drawGuide(fix, edge) {
    if (state.outside && edge) {
      const pts = [
        [fix.lat, fix.lng],
        [edge.lat, edge.lng],
      ];
      if (guideLine) guideLine.setLatLngs(pts);
      else
        guideLine = L.polyline(pts, {
          renderer: maskRenderer,
          color: "#ef4444",
          weight: 4,
          dashArray: "2 9",
          lineCap: "round",
          interactive: false,
        }).addTo(map);
    } else if (guideLine) {
      guideLine.remove();
      guideLine = null;
    }
  }

  // ---- GPS tracking and geofencing ---------------------------------------
  function startGps() {
    if (SIM) {
      setGpsPill("sim");
      if (!state.pos && running())
        simulateFix(L.latLng(ORIGIN.lat, ORIGIN.lng));
      return;
    }
    if (state.watchId !== null) return; // already on (the debug view may have started it)
    if (!("geolocation" in navigator)) {
      setGpsPill("off");
      showModal({
        id: "no_gps",
        title: "No GPS",
        body: "This browser does not support location. Please open the hunt in Google Chrome.",
      });
      return;
    }
    setGpsPill("search");
    state.watchId = navigator.geolocation.watchPosition(
      onPosition,
      onGeoError,
      {
        enableHighAccuracy: true,
        maximumAge: 0,
        timeout: 30000,
      },
    );
    log("gps_watch_start");
  }

  function stopGps() {
    if (state.watchId === null) return;
    navigator.geolocation.clearWatch(state.watchId);
    state.watchId = null;
    log("gps_watch_stop");
  }

  function onPosition(p) {
    const c = p.coords;
    onFix({
      ts: p.timestamp || Date.now(),
      lat: c.latitude,
      lng: c.longitude,
      acc: c.accuracy,
      alt: c.altitude,
      altAcc: c.altitudeAccuracy,
      heading: c.heading,
      speed: c.speed,
      sim: false,
    });
  }

  function simulateFix(latlng) {
    onFix({
      ts: Date.now(),
      lat: latlng.lat,
      lng: latlng.lng,
      acc: 5,
      alt: null,
      altAcc: null,
      heading: null,
      speed: null,
      sim: true,
    });
  }

  // Every fix goes to the hunt while it runs; otherwise only the debug view uses it.
  function onFix(fix) {
    debug.samples?.push(fix);
    if (running()) handleFix(fix);
    else if (debug.on) debugFix(fix);
  }

  function onGeoError(err) {
    log("gps_error", { code: err.code, message: err.message });
    if (err.code === 1) {
      setGpsPill("off");
      showModal({
        id: "gps_denied",
        title: "📍 Location is blocked",
        body: "The hunt needs your location.\n\nIn Chrome tap the icon left of the address bar → Permissions → Location → Allow. Then reload — your progress is saved.",
        buttons: [
          { label: "Reload", primary: true, action: () => location.reload() },
          { label: "Close" },
        ],
      });
    } else {
      setGpsPill("search");
    }
  }

  function handleFix(fix) {
    if (!running()) return;
    const first = !state.pos;
    state.pos = fix;
    state.lastFixAt = Date.now();
    drawUser(fix);
    const geo = evaluate(fix);
    Store.add("gps", {
      iso: new Date(fix.ts).toISOString(),
      ts: fix.ts,
      lat: round(fix.lat, 7),
      lng: round(fix.lng, 7),
      acc: round(fix.acc, 1),
      alt: round(fix.alt, 1),
      altAcc: round(fix.altAcc, 1),
      heading: round(fix.heading, 1),
      speed: round(fix.speed, 2),
      sim: fix.sim,
      ...geo,
    }).catch((e) => console.error("gps write failed", e));
    if (first) {
      log("gps_first_fix", { acc: round(fix.acc, 1) });
      if (state.follow) {
        markApp("first_fix");
        map.setView([fix.lat, fix.lng], Math.max(map.getZoom(), 17));
      }
    } else {
      followUser(fix);
    }
    updateScanButton();
    if ($("#sheet").classList.contains("open")) renderList();
    if (debug.on) renderDebug();
  }

  function evaluate(fix) {
    const inside = Geo.insidePolygon(fix, REGION);
    const edge = inside ? null : Geo.nearestOnPolygon(fix, REGION);
    const dists = ITEMS.map((p) => Geo.distance(fix, p));
    // Reliable fixes update boundary, treasure, and origin state in that order.
    const reliable = fix.acc <= C.MAX_ACCURACY_M;
    if (reliable) {
      // a fix this vague would make the signal jump around, so it keeps its last value
      checkBoundary(fix, inside, edge);
      updateTreasures(dists);
      checkOrigin(fix);
    }
    drawGuide(fix, edge);
    const n = dists.indexOf(Math.min(...dists));
    return {
      inside,
      outsideBy: edge ? round(edge.distance, 1) : 0,
      reliable,
      nearestItem: ITEMS[n]?.id ?? null,
      nearestItemDist: round(dists[n], 1),
      proximityItem: state.proximity?.poiId ?? null,
      proximity: state.proximity?.value ?? null,
    };
  }

  function checkBoundary(fix, inside, edge) {
    const clearlyOut = !inside && edge.distance > C.BOUNDARY_TOLERANCE_M;
    state.outsideStreak = clearlyOut ? state.outsideStreak + 1 : 0;

    if (!state.outside && state.outsideStreak >= 2) {
      // two fixes in a row, so one GPS jump doesn't trigger it
      state.outside = true;
      state.lastOutsideAlert = Date.now();
      alertUser("alarm");
      log("boundary_exit", {
        lat: round(fix.lat),
        lng: round(fix.lng),
        outsideBy: round(edge.distance, 1),
      });
      log("notification_shown", { channel: "banner", id: "boundary" });
    } else if (state.outside && inside) {
      state.outside = false;
      $("#boundary-banner").hidden = true;
      log("boundary_return", { lat: round(fix.lat), lng: round(fix.lng) });
      log("notification_dismissed", {
        channel: "banner",
        id: "boundary",
        how: "returned_inside",
      });
      alertUser("ok");
      toast("✅ Back inside the hunt area", "ok");
    }

    if (state.outside && edge) {
      const b = Geo.bearing(fix, edge);
      $("#boundary-arrow").style.transform = `rotate(${Math.round(b)}deg)`;
      $("#boundary-text").textContent =
        `Head ${Geo.compass(b)} for about ${Geo.formatDistance(edge.distance)} to get back.`;
      $("#boundary-banner").hidden = false;
      if (Date.now() - state.lastOutsideAlert > C.BOUNDARY_REMIND_SEC * 1000) {
        state.lastOutsideAlert = Date.now();
        alertUser("alarm");
        log("boundary_reminder", { outsideBy: round(edge.distance, 1) });
      }
    }
  }

  function checkOrigin(fix) {
    const s = state.session;
    const d = Geo.distance(fix, ORIGIN);
    if (!s.leftOrigin && d > ORIGIN.radius * 2 + 15) {
      s.leftOrigin = true;
      saveSession();
      log("origin_left", { distance: round(d, 1) });
    } else if (s.leftOrigin && d <= ORIGIN.radius) {
      s.leftOrigin = false;
      saveSession();
      log("origin_return", { distance: round(d, 1), found: foundCount() });
      alertUser("arrive");
      showModal({
        id: "origin_return",
        title: `🏁 Back at ${ORIGIN.name}`,
        body: `You've found ${foundCount()} of ${ITEMS.length} items.\nFinish now to save your results, or keep hunting.`,
        buttons: [
          { label: "Finish & save results", primary: true, action: finishHunt },
          { label: "Keep hunting" },
        ],
      });
    }
  }

  // ---- Treasure proximity signal -----------------------------------------
  // state.proximity is the proximity variable. While the team is inside the
  // radius of a treasure they haven't found, it describes the nearest one:
  //   { poiId, distance (m), radius (m), value }
  //   value = 1 - distance / radius: 0 at the edge of the radius, 1 at the exact spot.
  // Outside every radius it is null. The treasure's position itself is never drawn.
  // UI can use it three ways: the CSS variable --proximity (0–1) on <html>,
  // the class body.has-signal, and the 'hunt:proximity' event on document.
  const SIGNAL_LEVELS = [
    { min: 0, label: "Faint" },
    { min: 0.25, label: "Warm" },
    { min: 0.5, label: "Hot" },
    { min: 0.7, label: "Very hot — look around!" },
  ];
  const levelOf = (v) =>
    SIGNAL_LEVELS.reduce((lvl, l, i) => (v >= l.min ? i : lvl), 0);
  const LEAVE_SLACK_M = 5; // leaving needs a few extra metres, so GPS jitter at the edge doesn't flicker it

  function nearestSignal(dists) {
    let best = null;
    ITEMS.forEach((p, i) => {
      if (isFound(p.id)) return;
      const reach =
        p.radius + (state.proximity?.poiId === p.id ? LEAVE_SLACK_M : 0);
      if (dists[i] <= reach && (!best || dists[i] < best.d))
        best = { p, d: dists[i] };
    });
    if (!best) return null;
    return {
      poiId: best.p.id,
      distance: round(best.d, 1),
      radius: best.p.radius,
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
  const ghosts = {}; // poiId -> layer group, made on first use
  const ghostsShown = new Set();

  function makeGhost(p) {
    return L.layerGroup([
      L.circle([p.lat, p.lng], {
        radius: p.radius,
        className: "reveal-ring",
        weight: 2,
        dashArray: "6 6",
        interactive: false,
      }),
      L.marker([p.lat, p.lng], {
        interactive: false,
        keyboard: false,
        icon: L.divIcon({
          className: "pin-icon",
          html: `<div class="poi-pin ghost">${p.index}</div>`,
          iconSize: [34, 34],
          iconAnchor: [17, 17],
        }),
      }),
    ]);
  }

  function updateGhosts(dists) {
    if (C.REVEAL_POIS) return; // everything is on the map already
    ITEMS.forEach((p, i) => {
      const shown = ghostsShown.has(p.id);
      const show =
        !isFound(p.id) && dists[i] <= p.radius + (shown ? LEAVE_SLACK_M : 0);
      if (show === shown) return;
      if (show) {
        (ghosts[p.id] ||= makeGhost(p)).addTo(map);
        ghostsShown.add(p.id);
      } else {
        ghosts[p.id].remove();
        ghostsShown.delete(p.id);
      }
      log(show ? "treasure_shown" : "treasure_hidden", {
        poiId: p.id,
        distance: round(dists[i], 1),
        found: isFound(p.id),
      });
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
      if (prev)
        log("proximity_exit", {
          poiId: prev.poiId,
          found: isFound(prev.poiId),
        });
      if (next)
        log("proximity_enter", {
          poiId: next.poiId,
          distance: next.distance,
          value: next.value,
          level,
        }); // no pop-up: the ring and meter appearing are the cue
    } else if (next && level !== state.signalLevel) {
      log("proximity_level", {
        poiId: next.poiId,
        level,
        label: SIGNAL_LEVELS[level].label,
        distance: next.distance,
        value: next.value,
      });
      if (level > state.signalLevel && C.VIBRATE && navigator.vibrate)
        navigator.vibrate(50 + 40 * level);
    }
    state.signalLevel = level;
    renderSignal();
    document.dispatchEvent(new CustomEvent("hunt:proximity", { detail: next }));
  }

  function renderSignal() {
    const s = state.proximity;
    document.documentElement.style.setProperty("--proximity", s ? s.value : 0);
    document.body.classList.toggle("has-signal", !!s);
    $("#signal").hidden = !s;
    if (!s) return;
    const p = itemById(s.poiId);
    const level = levelOf(s.value);
    $("#signal").dataset.level = level;
    $("#signal-name").textContent = p.name;
    $("#signal-level").textContent = SIGNAL_LEVELS[level].label;
    $("#signal-hint").textContent = p.hint || "";
    $("#signal-hint").hidden = !p.hint;
  }

  // ---- Audio and vibration alerts ----------------------------------------
  let audioCtx = null;
  function unlockAudio() {
    try {
      audioCtx =
        audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      audioCtx.resume();
    } catch (e) {
      /* no audio available */
    }
  }

  const ALERTS = {
    soft: { vibrate: [120], tones: [[880, 0.12]] },
    ok: { vibrate: [80], tones: [[1046, 0.1]] },
    arrive: {
      vibrate: [200, 80, 200, 80, 400],
      tones: [
        [660, 0.12],
        [880, 0.12],
        [1175, 0.28],
      ],
    },
    alarm: {
      vibrate: [400, 150, 400, 150, 400],
      tones: [
        [440, 0.25],
        [330, 0.4],
        [440, 0.25],
        [330, 0.4],
      ],
    },
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

  // ---- Toast notifications -----------------------------------------------
  function toast(text, kind = "info", ms = 5000) {
    const el = document.createElement("div");
    el.className = `toast ${kind}`;
    el.textContent = text;
    const box = $("#toasts");
    box.prepend(el);
    while (box.children.length > 3) box.lastElementChild.remove();
    log("notification_shown", { channel: "toast", kind, text });
    const close = (how) => {
      if (!el.isConnected || el.classList.contains("out")) return;
      el.classList.add("out");
      setTimeout(() => el.remove(), 250);
      log("notification_dismissed", { channel: "toast", text, how });
    };
    el.addEventListener("click", () => close("tap"));
    setTimeout(() => close("timeout"), ms);
  }

  // ---- Queued modal dialogs ----------------------------------------------
  // Modals are queued, so an arrival never wipes out a dialog the player hasn't answered.
  const modalQueue = [];
  let modalOpen = null;

  function showModal(opts) {
    modalQueue.push(opts);
    if (!modalOpen) nextModal();
  }

  function nextModal() {
    const root = $("#modal-root");
    const opts = modalQueue.shift();
    root.textContent = "";
    modalOpen = opts || null;
    if (!opts) {
      root.hidden = true;
      return;
    }

    const box = document.createElement("div");
    box.className = opts.compact ? "modal compact" : "modal";
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-modal", "true");
    const h = document.createElement("h2");
    h.textContent = opts.title;
    box.append(h);
    if (opts.body) {
      const body = document.createElement("div");
      body.className = "modal-body";
      if (typeof opts.body === "string") body.textContent = opts.body;
      else body.append(opts.body);
      box.append(body);
    }
    const close = (how, button) => {
      log("notification_dismissed", {
        channel: "modal",
        id: opts.id,
        how,
        button,
      });
      opts.onClose?.();
      nextModal();
    };
    const actions = document.createElement("div");
    actions.className = "actions";
    for (const b of opts.buttons || [{ label: "OK", primary: true }]) {
      const btn = document.createElement("button");
      btn.textContent = b.label;
      btn.className = b.primary ? "primary" : b.danger ? "danger" : "secondary";
      btn.onclick = () => {
        close("button", b.label);
        b.action?.();
      };
      actions.append(btn);
    }
    box.append(actions);
    root.append(box);
    root.onclick = (e) => {
      if (e.target === root && opts.dismissable !== false) close("backdrop");
    };
    root.hidden = false;
    log("notification_shown", {
      channel: "modal",
      id: opts.id,
      title: opts.title,
    });
    opts.onOpen?.(box, close);
  }

  // ---- GPS status and progress display -----------------------------------
  function setGpsPill(kind, acc) {
    const el = $("#gps-pill");
    el.className = `pill gps-${kind}`;
    el.textContent =
      { off: "GPS off", search: "GPS…", sim: "SIM GPS" }[kind] ||
      `GPS ±${Math.round(acc)} m`;
  }

  function updateHud() {
    const text = `${foundCount()}/${ITEMS.length}`;
    $("#progress").textContent = text;
    $("#list-count").textContent = text;
  }

  // ---- Item list and detail dialogs --------------------------------------
  function openSheet() {
    renderList();
    $("#sheet").classList.add("open");
    $("#sheet-backdrop").hidden = false;
    log("list_open");
  }

  function closeSheet() {
    if (!$("#sheet").classList.contains("open")) return;
    $("#sheet").classList.remove("open");
    $("#sheet-backdrop").hidden = true;
    log("list_close");
  }

  function renderList() {
    const ol = $("#item-list");
    ol.textContent = "";
    for (const p of [...ITEMS, ORIGIN]) {
      const origin = p === ORIGIN;
      const rec = state.session?.items[p.id];
      const done = isFound(p.id);
      const li = document.createElement("li");
      li.className = origin ? "origin" : done ? "done" : "";
      let sub = origin
        ? "Start & finish point"
        : done
          ? `Found ${clockTime(rec.foundAt)}${rec.method === "manual" ? " · code typed in" : ""}`
          : "Not found yet";
      if (!origin && !done && p.quiz && state.session) {
        const st = quizState(p);
        sub +=
          st === "solved"
            ? " · 🧩 solved"
            : st === "locked"
              ? " · 🧩 no tries left"
              : ` · 🧩 ${triesLeft(p)}/${QUIZ_TRIES} tries`;
      }
      if (state.pos && C.REVEAL_POIS && !done) {
        sub += ` · ${Geo.formatDistance(Geo.distance(state.pos, p))} ${Geo.compass(Geo.bearing(state.pos, p))}`;
      }
      li.innerHTML = `<span class="num">${origin ? "🏁" : done ? "✓" : p.index}</span>
        <span class="info"><strong>${esc(p.name)}</strong><small>${esc(sub)}</small></span>
        ${p.hint ? '<span class="hint-tag" aria-label="Has a hint">💡</span>' : ""}<span class="chev" aria-hidden="true">›</span>`;
      li.onclick = () => openItemInfo(p);
      ol.append(li);
    }
  }

  // Small pop-up from the item list: the hint, the item's puzzle while it
  // isn't found, plus "Show on map" for spots that are already visible.
  function openItemInfo(p) {
    const origin = p === ORIGIN;
    const rec = state.session?.items[p.id];
    const withQuiz = !origin && !!p.quiz && running() && !isFound(p.id);

    log("item_info", {
      poiId: p.id,
      hasHint: !!p.hint,
      found: isFound(p.id),
      quiz: withQuiz ? quizState(p) : undefined,
    });

    const text = origin
      ? "This is where the hunt starts and ends. Come back here when you are done and tap Finish."
      : `${isFound(p.id) ? `✓ Found at ${clockTime(rec.foundAt)}` : "Not found yet"}\n\n${p.hint ? `💡 ${p.hint}` : withQuiz ? "" : "No hint for this one. Follow the treasure signal!"}`.trim();

    let body = text;

    if (withQuiz) {
      body = document.createElement("div");
      body.className = "item-view";

      const status = document.createElement("p");
      status.textContent = isFound(p.id)
        ? `✓ Found at ${clockTime(rec.foundAt)}`
        : "Not found yet";

      body.append(status);

      // Tabs are created here but added AFTER the puzzle.
      let tabs = null;

      if (p.hint) {
        const hint = document.createElement("p");
        hint.className = "item-hint";
        hint.textContent = `💡 ${p.hint}`;

        tabs = document.createElement("div");
        tabs.className = "view-tabs";

        const show = (view, how) => {
          body.dataset.show = view;

          for (const b of tabs.children) {
            b.classList.toggle("on", b.dataset.view === view);
          }

          if (how) {
            localStorage.setItem(ITEM_VIEW_KEY, view);
            log("item_view", { poiId: p.id, show: view });
          }
        };

        for (const [view, label] of [
          ["puzzle", "🧩 Puzzle"],
          ["hint", "💡 Hint"],
          ["both", "Both"],
        ]) {
          const b = document.createElement("button");
          b.type = "button";
          b.dataset.view = view;
          b.textContent = label;
          b.onclick = () => show(view, "tap");
          tabs.append(b);
        }

        body.append(hint);

        show(
          ["puzzle", "hint", "both"].includes(
            localStorage.getItem(ITEM_VIEW_KEY),
          )
            ? localStorage.getItem(ITEM_VIEW_KEY)
            : "both",
        );
      }

      // Puzzle content
      body.append(quizBox(p));

      // Tabs BELOW the puzzle and hint
      if (tabs) {
        body.append(tabs);
      }
    }

    const buttons =
      origin || isFound(p.id) || isSolved(p.id) || C.REVEAL_POIS
        ? [
            {
              label: "📍 Show on map",
              primary: true,
              action: () => showOnMap(p),
            },
            { label: "Close" },
          ]
        : [{ label: withQuiz ? "Close" : "OK", primary: !withQuiz }];

    showModal({
      id: `item_info_${p.id}`,
      title: origin ? `🏁 ${ORIGIN.name}` : p.name,
      body,
      buttons,
      compact: !withQuiz,
      onOpen: withQuiz
        ? (box, close) => {
            quizClose = close;
          }
        : undefined,
      onClose: withQuiz
        ? () => {
            quizClose = null;
          }
        : undefined,
    });
  }

  // ---- Puzzle state, rendering, and loading ------------------------------
  let quizClose = null; // closes the open item pop-up, once its puzzle is solved
  const ITEM_VIEW_KEY = "hunt-item-view"; // what the item pop-up shows: puzzle, hint or both (kept on the phone)
  const quizState = (p) =>
    isSolved(p.id)
      ? "solved"
      : quizOf(p.id).tries >= QUIZ_TRIES
        ? "locked"
        : "open";
  const triesLeft = (p) => QUIZ_TRIES - quizOf(p.id).tries;

  // Each item's puzzle comes in up to two levels; the team picks one per item
  // (kept in the session). The tries are shared, so switching gives no extra ones.
  const QUIZ_LEVELS = [
    ["easy", "Easy"],
    ["hard", "Hard"],
  ];
  const quizLevel = (p) => {
    const want = quizOf(p.id).level;
    return p.quiz.levels[want]
      ? want
      : QUIZ_LEVELS.map(([l]) => l).find((l) => p.quiz.levels[l]);
  };

  function setQuizLevel(p, level) {
    if (quizLevel(p) === level) return;
    ((state.session.quiz ||= {})[p.id] ||= { tries: 0 }).level = level;
    log("quiz_level", { poiId: p.id, level });
    saveSession();
  }

  // The level switch, puzzle picture, answer box and tries left; redrawn after each answer.
  function quizBox(p, feedback) {
    const box = document.createElement("div");
    box.className = "quiz";
    const level = quizLevel(p);
    const L1 = p.quiz.levels[level];
    const st = quizState(p);
    if (
      st === "open" &&
      QUIZ_LEVELS.filter(([l]) => p.quiz.levels[l]).length > 1
    ) {
      const tabs = document.createElement("div");
      tabs.className = "view-tabs";
      for (const [l, label] of QUIZ_LEVELS) {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = `${label} · ${quizRadius(l)} m`;
        b.classList.toggle("on", l === level);
        b.onclick = () => {
          setQuizLevel(p, l);
          box.replaceWith(quizBox(p));
        };
        tabs.append(b);
      }
      box.append(tabs);
    }
    const img = document.createElement("img");
    img.className = `quiz-img ${level}`;
    img.alt = `${level === "easy" ? "Easy" : "Hard"} puzzle for ${p.name}`;
    img.src = L1.image;
    img.onerror = () => {
      log("quiz_image_error", { poiId: p.id, level, image: L1.image });
      const err = document.createElement("p");
      err.className = "error";
      err.textContent =
        "The puzzle picture could not be loaded. Check the internet connection, then close this and open it again.";
      img.replaceWith(err);
    };
    box.append(img);
    if (L1.question) {
      const q = document.createElement("p");
      q.className = "quiz-question";
      q.textContent = L1.question;
      box.append(q);
    }
    const msg = document.createElement("p");
    msg.className = `quiz-msg${feedback ? " error" : ""}`;
    box.append(msg);
    if (st !== "open") {
      msg.textContent =
        st === "solved"
          ? `✓ Solved! ${p.name} is within ${quizRadius(quizOf(p.id).solvedLevel)} m of the centre of its ring on the map.`
          : `✗ No tries left for this puzzle. Follow the treasure signal instead.`;
      return box;
    }
    if (!L1.answers.length) {
      msg.textContent =
        "This puzzle can’t be answered yet. Try the other level.";
      return box;
    }
    const left = triesLeft(p);
    msg.textContent = `${feedback ? `${feedback} ` : ""}${left} ${left === 1 ? "try" : "tries"} left.`;
    const form = document.createElement("form");
    form.className = "quiz-form";
    const input = document.createElement("input");
    input.className = "quiz-input";
    input.placeholder = "Your answer";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.setAttribute("autocapitalize", "off");
    input.maxLength = 100;
    const btn = document.createElement("button");
    btn.type = "submit";
    btn.className = "primary";
    btn.textContent = "Answer";
    form.append(input, btn);
    form.onsubmit = (e) => {
      e.preventDefault();
      const correct = answerQuiz(p, input.value);
      if (correct === null) {
        input.focus();
        return;
      }
      if (correct) {
        quizClose?.("solved");
        showOnMap(p);
        return;
      }
      const next = quizBox(p, "✗ Not quite.");
      box.replaceWith(next);
      next.querySelector("input")?.focus();
    };
    box.append(form);
    return box;
  }

  // Checks against the level on screen. Returns true / false, or null if there
  // was nothing to check (empty, no tries left, or no answer set for that level).
  function answerQuiz(p, text) {
    if (quizState(p) !== "open" || !normAnswer(text)) return null;
    const q = ((state.session.quiz ||= {})[p.id] ||= { tries: 0 });
    q.tries++;
    const correct = p.quiz.answers.some(
      (a) => normAnswer(a) === normAnswer(text),
    );
    if (correct) q.solvedAt = nowIso();
    log("quiz_answer", {
      poiId: p.id,
      quizId: p.quiz.id,
      attempt: q.tries,
      correct,
      text: String(text).slice(0, 100),
    });
    if (correct) {
      log("quiz_solved", { poiId: p.id, quizId: p.quiz.id, tries: q.tries });
      refreshQuizRings();
      alertUser("ok");
      toast(`🧩 Solved! ${p.name} is somewhere inside the ring`, "ok");
    } else {
      if (C.VIBRATE && navigator.vibrate) navigator.vibrate(60);
      if (q.tries >= QUIZ_TRIES)
        log("quiz_locked", { poiId: p.id, quizId: p.quiz.id });
    }
    if ($("#sheet").classList.contains("open")) renderList();
    saveSession();
    return correct;
  }

  // questions.json: one puzzle per item, in item order. The top-level "image"
  // and "answer" are the hard puzzle, "easy": { "image", "answer" } the easy one.
  // Problems end up on the start screen.
  async function loadQuestions() {
    let list;
    try {
      const res = await fetch("questions.json");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      list = await res.json();
      if (!Array.isArray(list))
        throw new Error("it should be a list: [ { … }, { … } ]");
    } catch (e) {
      quizProblems.push(
        `questions.json could not be read (${e.message}), so there are no puzzles.`,
      );
      return;
    }
    const level = (q) =>
      q?.image
        ? {
            image: String(q.image),
            question: q.question ? String(q.question) : "",
            answers: []
              .concat(q.answer ?? [])
              .map(String)
              .filter((a) => normAnswer(a)),
          }
        : null;
    const unanswered = [];
    list.forEach((q, i) => {
      const p = ITEMS[i];
      if (!p) return;
      const levels = { hard: level(q), easy: level(q?.easy) };
      for (const [l] of QUIZ_LEVELS) {
        if (!levels[l]) delete levels[l];
        else if (!levels[l].answers.length)
          unanswered.push(`${p.index} (${l})`);
      }
      if (!Object.keys(levels).length)
        quizProblems.push(
          `questions.json, entry ${i + 1} (for ${p.name}): needs an "image".`,
        );
      else p.quiz = { id: q.id ?? null, levels };
    });
    if (unanswered.length)
      quizProblems.push(
        `questions.json: no "answer" yet for items ${unanswered.join(", ")}. Those puzzles show but can’t be answered.`,
      );
    if (list.length > ITEMS.length)
      quizProblems.push(
        `questions.json has ${list.length} puzzles but there are only ${ITEMS.length} items; the extra ones are ignored.`,
      );
  }

  // Fetch every puzzle picture once, so the service worker has them when the signal drops.
  function preloadQuizImages() {
    for (const p of ITEMS)
      for (const l of Object.values(p.quiz?.levels || {}))
        new Image().src = l.image;
  }

  function showOnMap(p) {
    log("list_select", { poiId: p.id });
    closeSheet();
    setFollow(false, "list_select");
    markApp("list_select");
    map.flyTo([p.lat, p.lng], Math.max(map.getZoom(), 18), { duration: 0.8 });
  }

  // ---- QR scanning controller --------------------------------------------
  const {
    updateScanButton,
    openScanner,
    closeScanner,
    toggleTorch,
    openManualEntry,
  } = window.createHuntScanner({
    $,
    C,
    running,
    state,
    itemById,
    closeSheet,
    log,
    loadScript,
    itemForCode,
    submitCode,
    alertUser,
    showModal,
  });

  function submitCode(text, method) {
    const p = itemForCode(text);
    if (!p) {
      log("qr_scan", {
        result: "unknown",
        method,
        text: String(text).slice(0, 200),
      });
      return "unknown";
    }
    if (isFound(p.id)) {
      log("qr_scan", { result: "already_found", method, poiId: p.id });
      alertUser("ok");
      toast(`✓ ${p.name} was already found`, "ok");
      return "already_found";
    }
    log("qr_scan", { result: "found", method, poiId: p.id });
    markFound(p, method);
    return "found";
  }

  async function markFound(p, method) {
    const fix = state.pos;
    const rec = {
      foundAt: nowIso(),
      method,
      lat: round(fix?.lat, 7),
      lng: round(fix?.lng, 7),
      acc: round(fix?.acc, 1),
      distanceM: fix ? round(Geo.distance(fix, p), 1) : null, // where GPS put the team when they scanned
      fixAgeSec: fix ? Math.round((Date.now() - state.lastFixAt) / 1000) : null,
    };
    state.session.items[p.id] = rec;
    log("item_found", {
      poiId: p.id,
      method,
      distanceM: rec.distanceM,
      acc: rec.acc,
    });
    if (fix) updateTreasures(ITEMS.map((i) => Geo.distance(fix, i))); // its signal and ring go; a neighbour's may take over
    refreshPins();
    updateHud();
    updateScanButton();
    alertUser("arrive");
    toast(`✅ ${p.name} found! ${foundCount()}/${ITEMS.length}`, "ok");
    showReward(p);
    updateRewardBadge();
    if (foundCount() === ITEMS.length) {
      log("all_items_found");
      showModal({
        id: "all_found",
        title: "🎉 All items found!",
        body: `Head back to ${ORIGIN.name} and tap Finish to save your results.`,
      });
    }
    await saveSession();
  }

  // ---- Reward picture and secret question --------------------------------
  // One layer per item (REWARD_LAYERS, {n} = item number), stacked in item
  // order. After each find the picture is shown full-screen with the layers
  // of every found item; the new one fades in. Tap to close.
  const rewardUrl = (p) => C.REWARD_LAYERS.replace("{n}", p.index);
  const rewardImages = new Map(); // poiId -> Promise<Image | null>
  const reward = { queue: [], open: null, anim: 0 };

  function rewardImage(p) {
    if (!rewardImages.has(p.id)) {
      rewardImages.set(
        p.id,
        new Promise((resolve) => {
          const img = new Image();
          img.onload = () => resolve(img);
          img.onerror = () => {
            log("reward_image_error", { poiId: p.id, url: rewardUrl(p) });
            resolve(null);
          };
          img.src = rewardUrl(p);
        }),
      );
    }
    return rewardImages.get(p.id);
  }

  // Load every layer up front, so the picture shows at once (and offline).
  function preloadReward() {
    if (C.REWARD_LAYERS) ITEMS.forEach(rewardImage);
  }

  // p = the item just found (its layer fades in); no p = just look at the picture (the badge).
  function showReward(p) {
    if (!C.REWARD_LAYERS) return;
    reward.queue.push({ p: p || null });
    if (!reward.open) nextReward();
  }

  // The badge in the map controls: a thumbnail of the picture so far. Tap = full screen.
  async function updateRewardBadge() {
    const btn = $("#btn-reward");
    if (!btn) return; // Reward button may not exist in this HTML version.
    btn.hidden = !C.REWARD_LAYERS;
    if (!C.REWARD_LAYERS) return;
    $("#reward-count").textContent = `${foundCount()}/${ITEMS.length}`;
    btn.classList.toggle("glow", !!state.session?.secret?.correct);
    const imgs = (
      await Promise.all(
        ITEMS.map((i) => (isFound(i.id) ? rewardImage(i) : null)),
      )
    ).filter(Boolean);
    const first = imgs[0] || (await rewardImage(ITEMS[0]));
    if (!first) return;
    const canvas = $("#reward-thumb");
    canvas.height = 96; // drawn at 2× for sharp screens
    canvas.width = Math.round((96 * first.naturalWidth) / first.naturalHeight);
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const img of imgs)
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  }

  function openRewardBadge() {
    if (!foundCount()) {
      toast(
        "🖼 Find an item to get the first piece of the picture",
        "info",
        3500,
      );
      return;
    }
    showReward(null);
  }

  // After the last find the picture turns over to the secret question
  // (SECRET): one free-text try. Right → it turns back glowing; wrong → it
  // turns back without.
  const secretPending = () =>
    !!C.SECRET &&
    !!state.session &&
    foundCount() === ITEMS.length &&
    !state.session.secret;
  const secretKeywords = () =>
    (C.SECRET?.keywords || [])
      .map((k) => [].concat(k).map(String))
      .filter((k) => k.some(normAnswer));
  const secretNeed = () => C.SECRET?.need || 3;
  const secretMatches = (text) => {
    const t = normAnswer(text);
    return secretKeywords()
      .filter((k) => k.some((w) => normAnswer(w) && t.includes(normAnswer(w))))
      .map((k) => k[0]);
  };

  async function nextReward() {
    const job = reward.queue.shift();
    reward.open = job || null;
    if (!job) return;
    const { p } = job; // null when just looking at the picture
    const layers = await Promise.all(
      ITEMS.filter((i) => isFound(i.id)).map(async (i) => ({
        p: i,
        img: await rewardImage(i),
      })),
    );
    const drawn = layers.filter((l) => l.img);
    if (!drawn.length) {
      nextReward();
      return;
    } // no pictures at all: skip quietly (the errors are logged)

    const canvas = $("#reward-canvas");
    const ctx = canvas.getContext("2d");
    canvas.width = drawn[0].img.naturalWidth;
    canvas.height = drawn[0].img.naturalHeight;
    const draw = (fresh) => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      for (const l of drawn) {
        ctx.globalAlpha = l.p === p ? fresh : 1;
        ctx.drawImage(l.img, 0, 0, canvas.width, canvas.height);
      }
      ctx.globalAlpha = 1;
    };
    draw(0);
    const final = secretPending() && reward.queue.length === 0;
    let phase = final ? "picture" : "done"; // picture → question → answered → done
    $("#reward-title").textContent = p
      ? `✨ ${p.name} found!`
      : "🖼 Your picture";
    $("#reward-sub").textContent =
      `${foundCount()} / ${ITEMS.length} pieces · tap to ${final ? "turn it over" : p ? "continue" : "close"}`;
    const el = $("#reward");
    const card = el.querySelector(".reward-card");
    card.classList.remove("flipped");
    el.classList.remove("show", "asking", "glow", "secret-lost");
    el.hidden = false;
    void el.offsetWidth; // restart the CSS animations
    el.classList.add("show");
    const secret = state.session?.secret;
    if (secret && !final)
      el.classList.add(secret.correct ? "glow" : "secret-lost"); // the finished picture keeps its look
    log("reward_shown", {
      poiId: p?.id ?? null,
      layers: drawn.map((l) => l.p.index),
      secretNext: final,
      from: p ? "found" : "badge",
    });

    // The new layer fades in after the picture has popped up.
    const start = performance.now() + 500;
    const DURATION = 1400;
    cancelAnimationFrame(reward.anim);
    const step = (now) => {
      const t = Math.min(1, Math.max(0, (now - start) / DURATION));
      draw(1 - (1 - t) ** 3);
      if (t < 1) reward.anim = requestAnimationFrame(step);
    };
    reward.anim = requestAnimationFrame(step);

    const FLIP_MS = 800;
    let readyAt = Date.now() + 800; // don't let the tap that confirmed the scan close it
    const shownAt = Date.now();
    const input = $("#secret-input");

    const askSecret = () => {
      phase = "question";
      cancelAnimationFrame(reward.anim);
      draw(1);
      $("#secret-question").textContent = C.SECRET.question || "";
      input.value = "";
      $("#reward-title").textContent = "🔮 One last question…";
      $("#reward-sub").textContent = "";
      el.classList.add("asking");
      card.classList.add("flipped");
      log("secret_shown");
      setTimeout(() => input.focus(), FLIP_MS);
    };

    $("#secret-form").onsubmit = (e) => {
      e.preventDefault();
      if (phase !== "question") return;
      const text = input.value.trim();
      if (!normAnswer(text)) {
        input.focus();
        return;
      }
      phase = "answered";
      input.blur();
      const matched = secretMatches(text);
      const correct = matched.length >= secretNeed();
      state.session.secret = {
        answer: text.slice(0, 500),
        correct,
        matched,
        at: nowIso(),
      };
      log("secret_answer", { correct, matched, text: text.slice(0, 500) });
      saveSession();
      updateRewardBadge();
      el.classList.remove("asking");
      card.classList.remove("flipped");
      $("#reward-title").textContent = "";
      setTimeout(() => {
        phase = "done";
        readyAt = Date.now() + 800;
        el.classList.add(correct ? "glow" : "secret-lost");
        $("#reward-title").textContent = correct
          ? "🌟 The secret treasure is yours!"
          : "The secret stays hidden…";
        $("#reward-sub").textContent = "tap to continue";
        if (correct) alertUser("arrive");
        else if (C.VIBRATE && navigator.vibrate) navigator.vibrate(60);
      }, FLIP_MS);
    };

    el.onclick = () => {
      if (Date.now() < readyAt) return;
      if (phase === "picture") {
        askSecret();
        return;
      }
      if (phase !== "done") return; // the question is up: only its button acts
      cancelAnimationFrame(reward.anim);
      draw(1);
      el.hidden = true;
      el.classList.remove("show", "asking", "glow", "secret-lost");
      log("reward_closed", {
        poiId: p?.id ?? null,
        shownMs: Date.now() - shownAt,
      });
      nextReward();
    };
  }

  // ---- Results summary and download --------------------------------------
  function walkedDistance(gps) {
    let total = 0;
    let last = null;
    for (const f of gps) {
      if (f.acc > C.MAX_ACCURACY_M) continue;
      if (!last) {
        last = f;
        continue;
      }
      const d = Geo.distance(last, f);
      if (d >= Math.max(3, Math.min(f.acc, last.acc))) {
        total += d;
        last = f;
      }
    }
    return Math.round(total);
  }

  function buildSummary(events, gps) {
    const s = state.session;
    const end = s.finishedAt || nowIso();
    return {
      huntName: C.HUNT_NAME,
      team: s.team,
      sessionId: s.id,
      appVersion: APP_VERSION,
      simulated: !!s.sim,
      positionsFrom: DRAFT_APPLIED
        ? "debug view edits (this phone only)"
        : "js/config.js",
      startedAt: s.startedAt,
      finishedAt: s.finishedAt,
      exportedAt: nowIso(),
      durationSec: Math.round(
        (Date.parse(end) - Date.parse(s.startedAt)) / 1000,
      ),
      itemsFound: foundCount(),
      itemsTotal: ITEMS.length,
      distanceWalkedM: walkedDistance(gps),
      gpsFixes: gps.length,
      interactionEvents: events.length,
      items: ITEMS.map((p) => {
        const r = s.items[p.id] || {};
        return {
          id: p.id,
          index: p.index,
          name: p.name,
          lat: p.lat,
          lng: p.lng,
          radius: p.radius,
          found: !!r.foundAt,
          foundAt: r.foundAt || null,
          method: r.method || null,
          scanLat: r.lat ?? null,
          scanLng: r.lng ?? null,
          scanAcc: r.acc ?? null,
          scanDistanceM: r.distanceM ?? null,
          quizId: p.quiz?.id ?? null,
          quizTries: quizOf(p.id).tries,
          quizSolvedAt: quizOf(p.id).solvedAt || null,
          quizSolvedLevel: quizOf(p.id).solvedLevel || null,
        };
      }),
      origin: {
        id: ORIGIN.id,
        name: ORIGIN.name,
        lat: ORIGIN.lat,
        lng: ORIGIN.lng,
        radius: ORIGIN.radius,
      },
      region: REGION,
      secret: C.SECRET
        ? {
            question: C.SECRET.question,
            ...(s.secret || { answer: null, correct: false }),
          }
        : null,
      device: {
        userAgent: navigator.userAgent,
        language: navigator.language,
        screen: `${screen.width}x${screen.height}`,
        pixelRatio: devicePixelRatio,
        standalone: matchMedia("(display-mode: standalone)").matches,
      },
    };
  }

  // Plain JSON, laid out with one event / GPS fix per line so it also opens
  // comfortably in a text editor.
  function resultsJson(summary, events, gps) {
    const rows = (list) =>
      list.length
        ? `\n    ${list.map((r) => JSON.stringify(r)).join(",\n    ")}\n  `
        : "";
    return (
      `{\n  "format": "treasure-hunt-results",\n  "formatVersion": 1,\n` +
      `  "summary": ${JSON.stringify(summary, null, 2).replace(/\n/g, "\n  ")},\n` +
      `  "events": [${rows(events)}],\n  "gps": [${rows(gps)}]\n}\n`
    );
  }

  const resultsFileName = () => `hunt_${state.session.id}.json`;

  async function downloadResults() {
    const btn = $("#btn-download");
    btn.disabled = true;
    try {
      const [events, gps] = await Promise.all([
        Store.getAll("events"),
        Store.getAll("gps"),
      ]);
      const a = document.createElement("a");
      a.href = URL.createObjectURL(
        new Blob([resultsJson(buildSummary(events, gps), events, gps)], {
          type: "application/json",
        }),
      );
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
      $("#finish-msg").textContent =
        `Could not create the results file: ${e.message}. Tap the button to try again.`;
    } finally {
      btn.disabled = false;
    }
  }

  // ---- Session lifecycle -------------------------------------------------
  function makeSessionId(team) {
    const slug =
      team
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 24) || "team";
    return `${fileStamp(new Date())}_${slug}_${Math.random().toString(36).slice(2, 6)}`;
  }

  async function startHunt() {
    const input = $("#team-input");
    const team = input.value.trim();
    if (!team) {
      input.classList.remove("invalid");
      void input.offsetWidth; // restart the shake animation
      input.classList.add("invalid");
      input.focus();
      return;
    }
    unlockAudio();
    $("#btn-start").disabled = true;
    await Store.clearAll();
    state.session = {
      id: makeSessionId(team),
      team,
      phase: "running",
      startedAt: nowIso(),
      finishedAt: null,
      items: {},
      quiz: {},
      leftOrigin: false,
      sim: SIM,
      appVersion: APP_VERSION,
    };
    await saveSession();
    flushPreStart();
    log("session_start", { sessionId: state.session.id, team, sim: SIM });
    beginTracking();
  }

  function resumeHunt(saved) {
    unlockAudio();
    state.session = saved;
    flushPreStart();
    log("session_resume", { found: foundCount() });
    beginTracking();
    toast("Hunt resumed — progress restored", "ok");
  }

  function beginTracking() {
    $("#start-screen").hidden = true;
    document.body.classList.add("running");
    $("#team-label").textContent = `Team ${state.session.team}`;
    refreshPins();
    updateHud();
    updateScanButton();
    preloadQuizImages();
    preloadReward();
    updateRewardBadge();
    if (secretPending()) {
      // the app was closed before the secret question was answered: ask again
      const last = ITEMS.filter((i) => isFound(i.id))
        .sort(
          (x, y) =>
            Date.parse(state.session.items[x.id].foundAt) -
            Date.parse(state.session.items[y.id].foundAt),
        )
        .pop();
      showReward(last);
    }
    startGps();
    requestWakeLock();
    state.timers.forEach(clearInterval);
    state.timers = [setInterval(tick, 1000)];
    tick();
    if (SIM) toast("Simulation mode — tap the map to move", "info", 7000);
  }

  function tick() {
    const s = state.session;
    if (!s) return;
    $("#timer").textContent = duration(
      (s.finishedAt ? Date.parse(s.finishedAt) : Date.now()) -
        Date.parse(s.startedAt),
    );
    if (
      !SIM &&
      state.watchId !== null &&
      state.lastFixAt &&
      Date.now() - state.lastFixAt > 20000
    )
      setGpsPill("search");
  }

  function confirmFinish() {
    log("finish_prompt");
    showModal({
      id: "confirm_finish",
      title: "Finish the hunt?",
      body: `You found ${foundCount()} of ${ITEMS.length} items.\nTracking stops and your results are saved to this phone as one file.`,
      buttons: [
        { label: "Finish & save results", primary: true, action: finishHunt },
        { label: "Keep hunting" },
      ],
    });
  }

  async function finishHunt() {
    if (!running()) return;
    setDebug(false);
    closeScanner("finish");
    closeSheet();
    setProximity(null);
    hideGhosts();
    log("session_finish", { found: foundCount(), total: ITEMS.length });
    stopGps();
    state.timers.forEach(clearInterval);
    state.timers = [];
    state.wakeLock?.release().catch(() => {});
    // From here on nothing more is logged: the file holds the hunt exactly as it ended.
    state.session.phase = "done";
    state.session.finishedAt = nowIso();
    await saveSession();
    modalQueue.length = 0;
    if (modalOpen) nextModal();
    document.body.classList.remove("running");
    $("#boundary-banner").hidden = true;
    await showFinishScreen();
    downloadResults();
  }

  async function showFinishScreen() {
    const s = state.session;
    const gps = await Store.getAll("gps");
    const rows = [
      ["Team", s.team],
      ["Items found", `${foundCount()} / ${ITEMS.length}`],
      [
        "Time",
        duration(
          Date.parse(s.finishedAt || nowIso()) - Date.parse(s.startedAt),
        ),
      ],
      ["Distance walked", Geo.formatDistance(walkedDistance(gps))],
      ...(C.SECRET
        ? [
            [
              "Secret treasure",
              s.secret ? (s.secret.correct ? "🌟 Found" : "✗ Missed") : "—",
            ],
          ]
        : []),
    ];
    $("#finish-summary").innerHTML = rows
      .map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`)
      .join("");
    updateFinishUi();
    $("#finish-screen").hidden = false;
  }

  function updateFinishUi() {
    const saved = !!state.session.downloadedAt;
    $("#btn-download").textContent = saved
      ? "⬇ Download again"
      : "⬇ Download results file";
    $("#finish-msg").textContent = saved
      ? `Your results were saved as\n${resultsFileName()}\nin this phone’s Downloads (Chrome ⋮ → Downloads). Send that file to the organiser.\nNot there? Tap Download again.`
      : "Tap the button to save your results file on this phone.";
  }

  function discardAndReload(message) {
    showModal({
      id: "confirm_discard",
      title: "Delete this hunt’s data?",
      body: message,
      buttons: [
        {
          label: "Delete and start over",
          danger: true,
          action: async () => {
            await Store.clearAll();
            location.reload();
          },
        },
        { label: "Cancel" },
      ],
    });
  }

  // ---- Debug controller --------------------------------------------------
  const {
    debug,
    warpEditing,
    setDebug,
    drawDebug,
    debugFix,
    renderDebug,
    openMarkDialog,
    openPointsList,
    exportDebug,
    toggleEdit,
    undoEdit,
    openSimplify,
    applyDraft,
    resetDraft,
    setEditTarget,
    toggleSeeThrough,
    addWarpPoint,
  } = window.createHuntDebug({
    $,
    C,
    SIM,
    REGION,
    ORIGIN,
    ITEMS,
    CONFIG_FILE,
    DRAFT_KEY,
    DRAFT_APPLIED,
    state,
    running,
    log,
    startGps,
    stopGps,
    requestWakeLock,
    showDrawing,
    cornerWarp,
    normWarp,
    previewDrawing,
    setFollow,
    markApp,
    drawUser,
    followUser,
    round,
    nowIso,
    esc,
    toast,
    showModal,
    itemById,
    fileStamp,
    clockTime,
    sleep,
    getMap: () => map,
    getDrawing: () => drawing,
  });

  // ---- Screen wake lock and visibility -----------------------------------
  async function requestWakeLock() {
    if (
      !("wakeLock" in navigator) ||
      document.visibilityState !== "visible" ||
      state.wakeLock
    )
      return;
    try {
      state.wakeLock = await navigator.wakeLock.request("screen");
      if (running()) log("wakelock_on"); // also used while scouting in the debug view, which isn't logged
      state.wakeLock.addEventListener("release", () => {
        state.wakeLock = null;
        if (running()) log("wakelock_off");
      });
    } catch (e) {
      log("wakelock_error", { message: e.message });
    }
  }

  function onVisibility() {
    const visible = document.visibilityState === "visible";
    if (!visible) {
      state.hiddenAt = Date.now();
      closeScanner("app_hidden"); // release the camera
    }
    log("app_visibility", {
      state: document.visibilityState,
      hiddenForMs:
        visible && state.hiddenAt ? Date.now() - state.hiddenAt : undefined,
    });
    if (visible && (running() || debug.on)) requestWakeLock();
  }

  // ---- Configuration validation and start screen -------------------------
  function configProblems() {
    const out = [];
    if (!Geo.insidePolygon(ORIGIN, REGION))
      out.push(
        `ORIGIN “${ORIGIN.name}” is outside REGION — check its lat/lng.`,
      );
    const ids = new Set();
    const codes = new Map();
    for (const p of ITEMS) {
      if (!Geo.insidePolygon(p, REGION))
        out.push(
          `${p.name} is outside REGION — check its lat/lng (latitude first).`,
        );
      if (ids.has(p.id)) out.push(`Two items share the id “${p.id}”.`);
      ids.add(p.id);
      const key = normCode(p.code);
      if (!key)
        out.push(
          `${p.name}: its code “${p.code}” needs at least one letter or digit.`,
        );
      else if (codes.has(key))
        out.push(`${codes.get(key).name} and ${p.name} have the same QR code.`);
      else codes.set(key, p);
    }
    if (C.SECRET && secretKeywords().length < secretNeed())
      out.push(
        `SECRET: the answer needs ${secretNeed()} keywords, but only ${secretKeywords().length} are listed, so nobody can get it right. Add them to SECRET.keywords in js/config.js.`,
      );
    return out.concat(quizProblems);
  }

  function showStart(saved) {
    const warnings = configProblems();
    if (!isSecureContext)
      warnings.push(
        "This page is not served over HTTPS, so GPS and camera are blocked. Host it on GitHub Pages (see README).",
      );
    if (SIM)
      warnings.push("Simulation mode: GPS is replaced by tapping the map.");
    if (DRAFT_APPLIED)
      warnings.push(
        "This phone uses the boundary, spots and drawing edited in the debug view, not js/config.js. Debug view → Edit → Reset to go back.",
      );
    $("#start-warnings").innerHTML = warnings
      .map((w) => `<p>⚠️ ${esc(w)}</p>`)
      .join("");

    $("#start-new").hidden = !!saved;
    $("#start-resume").hidden = !saved;
    if (saved) {
      const found = ITEMS.filter((p) => saved.items[p.id]?.foundAt).length;
      $("#resume-text").textContent =
        `Team “${saved.team}” has a hunt in progress (${found}/${ITEMS.length} found, started ${clockTime(saved.startedAt)}).`;
      $("#btn-resume").onclick = () => resumeHunt(saved);
    }
    $("#start-screen").hidden = false;
  }

  // ---- UI and browser event bindings -------------------------------------
  function bindUi() {
    // Guard optional controls: independently merged HTML may omit some buttons.
    document.addEventListener(
      "click",
      (e) => {
        const el = e.target.closest("[data-log]");
        if (el) log("ui_tap", { control: el.dataset.log });
      },
      true,
    );

    if ($("#btn-start")) $("#btn-start").onclick = startHunt;
    $("#team-input")?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") startHunt();
    });
    if ($("#btn-discard"))
      $("#btn-discard").onclick = () =>
        discardAndReload(
          "The hunt in progress on this phone will be deleted, including its logs and GPS track.",
        );

    if ($("#btn-zoom-in"))
      $("#btn-zoom-in").onclick = () => {
        markApp("button_in");
        map.zoomIn();
      };
    if ($("#btn-zoom-out"))
      $("#btn-zoom-out").onclick = () => {
        markApp("button_out");
        map.zoomOut();
      };
    if ($("#btn-locate")) $("#btn-locate").onclick = locateMe;
    if ($("#btn-area"))
      $("#btn-area").onclick = () => {
        setFollow(false, "fit_area");
        markApp("fit_area");
        map.fitBounds(regionBounds);
      };
    if ($("#btn-list")) $("#btn-list").onclick = openSheet;
    if ($("#btn-reward")) $("#btn-reward").onclick = openRewardBadge;
    if ($("#btn-sheet-close")) $("#btn-sheet-close").onclick = closeSheet;
    if ($("#sheet-backdrop")) $("#sheet-backdrop").onclick = closeSheet;
    if ($("#btn-finish")) $("#btn-finish").onclick = confirmFinish;
    if ($("#boundary-banner"))
      $("#boundary-banner").onclick = () => {
        if (!state.pos) return;
        const edge = Geo.nearestOnPolygon(state.pos, REGION);
        setFollow(false, "boundary_banner");
        markApp("boundary_banner");
        map.fitBounds(
          L.latLngBounds([
            [state.pos.lat, state.pos.lng],
            [edge.lat, edge.lng],
          ]).pad(0.6),
          { maxZoom: 18 },
        );
      };

    if (C.DEBUG_TOOLS) {
      if ($("#btn-debug")) $("#btn-debug").hidden = false;
      if ($("#btn-debug-start")) $("#btn-debug-start").hidden = false;
      if ($("#btn-debug")) $("#btn-debug").onclick = () => setDebug(!debug.on);
      if ($("#btn-debug-start"))
        $("#btn-debug-start").onclick = () => setDebug(true);
      if ($("#btn-debug-close"))
        $("#btn-debug-close").onclick = () => setDebug(false);
      if ($("#btn-debug-mark")) $("#btn-debug-mark").onclick = openMarkDialog;
      if ($("#btn-debug-points"))
        $("#btn-debug-points").onclick = openPointsList;
      if ($("#btn-debug-download"))
        $("#btn-debug-download").onclick = exportDebug;
      if ($("#btn-debug-edit")) $("#btn-debug-edit").onclick = toggleEdit;
      if ($("#btn-debug-undo")) $("#btn-debug-undo").onclick = undoEdit;
      if ($("#btn-debug-simplify"))
        $("#btn-debug-simplify").onclick = openSimplify;
      if ($("#btn-debug-apply")) $("#btn-debug-apply").onclick = applyDraft;
      if ($("#btn-debug-reset")) $("#btn-debug-reset").onclick = resetDraft;
      if ($("#btn-edit-spots"))
        $("#btn-edit-spots").onclick = () => setEditTarget("spots");
      if ($("#btn-edit-drawing"))
        $("#btn-edit-drawing").onclick = () => setEditTarget("drawing");
      if ($("#btn-debug-seethrough"))
        $("#btn-debug-seethrough").onclick = toggleSeeThrough;
      map.on("click", (e) => {
        if (warpEditing()) addWarpPoint(e.latlng);
      });
      map.on("zoomend", () => {
        if (!debug.on || !debug.editing) return;
        drawDebug(); // corner handles appear / thin out with the zoom
        renderDebug();
      });
    }

    if ($("#btn-scan")) $("#btn-scan").onclick = () => openScanner("button");
    if ($("#btn-scan-close"))
      $("#btn-scan-close").onclick = () => closeScanner("cancel");
    if ($("#btn-torch")) $("#btn-torch").onclick = toggleTorch;
    if ($("#btn-scan-manual"))
      $("#btn-scan-manual").onclick = () => openManualEntry();

    if ($("#btn-download"))
      $("#btn-download").onclick = () => downloadResults();
    if ($("#btn-new"))
      $("#btn-new").onclick = () =>
        discardAndReload(
          state.session?.downloadedAt
            ? "This removes the hunt from this phone. Make sure the results file has reached the organiser first."
            : "The results file has not been downloaded yet. If you continue, this hunt’s logs are gone for good.",
        );

    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("online", () => log("network", { online: true }));
    window.addEventListener("offline", () => log("network", { online: false }));
    window.addEventListener("pagehide", () => log("page_hide"));
    screen.orientation?.addEventListener("change", () =>
      log("orientation", { type: screen.orientation.type }),
    );
    window.addEventListener("error", (e) =>
      log("js_error", {
        message: e.message,
        source: e.filename,
        line: e.lineno,
      }),
    );
    window.addEventListener("unhandledrejection", (e) =>
      log("js_error", { message: String(e.reason?.message || e.reason) }),
    );
  }

  // ---- Application startup -----------------------------------------------
  async function boot() {
    document.documentElement.style.setProperty("--mask", C.MASK_COLOR);
    if (C.QUIZ_RING_COLOR)
      document.documentElement.style.setProperty(
        "--quiz-ring",
        C.QUIZ_RING_COLOR,
      );
    document.title = C.HUNT_NAME;
    $("#hunt-name").textContent = C.HUNT_NAME;
    $("#start-title").textContent = C.HUNT_NAME;
    $("#item-total").textContent = ITEMS.length;
    // Initialize the map before binding controls or logging viewport snapshots.
    initMap();
    bindUi();
    updateHud();
    log("app_load", {
      appVersion: APP_VERSION,
      sim: SIM,
      secure: isSecureContext,
      overlay: C.OVERLAY?.url ?? null,
      userAgent: navigator.userAgent,
    });
    // Load puzzle metadata before validating config or restoring a saved hunt.
    await loadQuestions();

    const saved = await Store.get("meta", "session").catch(() => null);
    if (!saved) {
      showStart(null);
    } else if (saved.phase === "running") {
      showStart(saved);
    } else {
      state.session = saved;
      showFinishScreen();
    }

    if (
      "serviceWorker" in navigator &&
      (location.protocol === "https:" || location.hostname === "localhost")
    ) {
      navigator.serviceWorker
        .register("sw.js")
        .catch((e) => console.warn("Service worker not registered", e));
    }
  }

  if (SIM)
    window.__hunt = {
      state,
      simulateFix: (lat, lng) => simulateFix(L.latLng(lat, lng)),
      log,
    };
  boot().catch((error) => {
    console.error("[Treasure Hunt] Startup failed:", error);
    fatal(
      `Treasure Hunt could not start: ${error?.message || error}. Check Chrome DevTools → Console.`,
    );
  });
})();
