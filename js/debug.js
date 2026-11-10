/* Organiser scouting and editing tools. Created by app.js before boot. */
window.createHuntDebug = function (dependencies) {
  "use strict";
  // Map initialization and drawing replacement remain owned by app.js.
  const {
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
    getMap,
    getDrawing,
  } = dependencies;

  // ---- Debug view state and persistence ----------------------------------
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
    on: false,
    editing: false,
    target: "spots",
    seeThrough: true,
    layer: null,
    samples: null,
    points: loadPoints(),
    draft: loadDraft(),
    undo: [],
  };
  const warpEditing = () =>
    debug.on && debug.editing && debug.target === "drawing" && !!C.OVERLAY;

  function loadStored(key) {
    try {
      return JSON.parse(localStorage.getItem(key));
    } catch (e) {
      return null;
    }
  }
  function loadPoints() {
    return loadStored("hunt-debug-points") || [];
  }
  function loadDraft() {
    return loadStored(DRAFT_KEY);
  }
  const savePoints = () =>
    localStorage.setItem("hunt-debug-points", JSON.stringify(debug.points));
  const saveDraft = () =>
    debug.draft
      ? localStorage.setItem(DRAFT_KEY, JSON.stringify(debug.draft))
      : localStorage.removeItem(DRAFT_KEY);
  const targetName = (id) =>
    id === ORIGIN.id ? ORIGIN.name : itemById(id)?.name || "Note";
  const ll7 = (ll) => [round(ll.lat, 7), round(ll.lng, 7)];

  function setDebug(on) {
    if (debug.on === on) return;
    if (on) {
      debug.on = true;
      log("debug_view", { on });
      if (!running()) {
        // scouting without a hunt
        $("#start-screen").hidden = true;
        startGps();
        requestWakeLock();
      }
    } else {
      log("debug_view", { on });
      debug.layer?.remove();
      debug.editing = false;
      if (!running()) {
        // done scouting: tidy up while still flagged, so none of it reaches a team's log
        stopGps();
        state.wakeLock?.release().catch(() => {});
        $("#toasts").textContent = "";
        if ($("#finish-screen").hidden) $("#start-screen").hidden = false;
      }
      debug.on = false;
      if (C.OVERLAY) syncDrawing(); // back to the drawing in use
    }
    document.body.classList.toggle("debug", on);
    $("#debug-panel").hidden = !on;
    $("#btn-debug").classList.toggle("active", on);
    if (on) {
      drawDebug();
      renderDebug();
    }
  }

  // ---- Debug spot drafts and undo ----------------------------------------
  // The boundary and spots being edited: the draft if there is one, otherwise
  // what the app is using now.
  function spots() {
    return (
      debug.draft || {
        region: REGION.map((p) => [p[0], p[1]]),
        origin: { lat: ORIGIN.lat, lng: ORIGIN.lng },
        pois: Object.fromEntries(
          ITEMS.map((p) => [p.id, { lat: p.lat, lng: p.lng }]),
        ),
      }
    );
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
    log("debug_edit", { what });
    drawDebug();
    renderDebug();
  }

  function undoEdit() {
    if (!debug.undo.length) return;
    debug.draft = JSON.parse(debug.undo.pop());
    saveDraft();
    log("debug_edit", { what: "undo" });
    drawDebug();
    renderDebug();
  }

  function draftProblems(d) {
    const out = [];
    if (Geo.crossings(d.region).length) out.push("the boundary crosses itself");
    if (!Geo.insidePolygon(d.origin, d.region))
      out.push("the start is outside the boundary");
    const outside = ITEMS.filter(
      (p) => !Geo.insidePolygon(spotOf(d, p), d.region),
    ).map((p) => p.name);
    if (outside.length) out.push(`${outside.join(", ")} outside the boundary`);
    if (debug.on && getDrawing()?.folds?.())
      out.push("the drawing folds over itself (drag the point back)");
    return out;
  }

  function draftStatus(d) {
    const dr = debug.draft;
    const where = !dr
      ? "from js/config.js"
      : !dr.applied
        ? "edited, not applied"
        : dr.updatedAt > dr.appliedAt
          ? "applied on this phone, newer edits not applied"
          : "applied on this phone";
    return warpEditing()
      ? `Drawing ${editWarp().length} points · ${where}`
      : `Boundary ${d.region.length} corners · ${where}`;
  }

  // ---- Debug drawing warp editor -----------------------------------------
  // The edited warp (only if it belongs to the drawing in config.js).
  function draftWarp(d) {
    const o = d?.overlay;
    return o && C.OVERLAY && o.url === C.OVERLAY.url && Array.isArray(o.warp)
      ? o.warp
      : null;
  }
  const editWarp = () =>
    draftWarp(debug.draft) || C.OVERLAY.warp || cornerWarp();
  const setDraftWarp = (x, warp) => {
    x.overlay = { url: C.OVERLAY.url, warp };
  };

  // The drawing as the debug view shows it: the edited warp if there is one
  // (as warp points from its corners while you edit it), else the one in use.
  function syncDrawing() {
    const editing = warpEditing();
    const warp =
      (debug.on && draftWarp(debug.draft)) ||
      C.OVERLAY.warp ||
      (editing ? cornerWarp() : null);
    const base = C.OVERLAY.opacity ?? 1;
    showDrawing(
      warp,
      editing && debug.seeThrough ? Math.min(base, 0.55) : base,
    );
  }

  // Warp handles: every warp point (drag to move that spot of the picture, tap
  // to delete), a "+" on each stretch of the drawing's edge (drag it to add a
  // point there), and the triangles the picture is bent along.
  function addWarpHandles(g) {
    const mesh = getDrawing()?.mesh?.();
    if (!mesh) return; // the picture hasn't loaded yet; drawn again when it has
    const work = editWarp().map((p) => p.slice());
    const ll = (p) => [p[2], p[3]];
    const lines = L.polyline([], {
      className: "warp-mesh",
      weight: 1.5,
      interactive: false,
    }).addTo(g);
    const drawLines = (pts) =>
      lines.setLatLngs(
        getDrawing().edges().map(([a, b]) => [ll(pts[a]), ll(pts[b])]),
      );
    drawLines(work);

    const onSide = (a, b) =>
      [0, 1].some((n) => a[n] === b[n] && (a[n] === 0 || a[n] === 1));
    const sides = getDrawing().edges().filter(([a, b]) => onSide(work[a], work[b]));
    const midUv = ([a, b]) => [
      round((work[a][0] + work[b][0]) / 2, 5),
      round((work[a][1] + work[b][1]) / 2, 5),
    ];
    const midLl = (e) =>
      getDrawing().latLngAt(...midUv(e)) ||
      L.latLng(
        (work[e[0]][2] + work[e[1]][2]) / 2,
        (work[e[0]][3] + work[e[1]][3]) / 2,
      );
    const roomy = ([a, b]) =>
      getMap()
        .latLngToLayerPoint(ll(work[a]))
        .distanceTo(getMap().latLngToLayerPoint(ll(work[b]))) > 60;
    const plus = sides
      .map((e) => {
        if (!roomy(e)) return null;
        const m = L.marker(midLl(e), {
          draggable: true,
          autoPan: true,
          keyboard: false,
          zIndexOffset: 400,
          icon: handleIcon("edit-mid warp-mid", "+"),
        }).addTo(g);
        const uv = midUv(e);
        const added = () => [...work, [...uv, ...ll7(m.getLatLng())]];
        m.on("drag", () => {
          const t = added();
          previewDrawing(t);
          drawLines(t);
        });
        m.on("dragend", () =>
          editSpots("drawing: add point", (x) => setDraftWarp(x, added())),
        );
        return { m, e };
      })
      .filter(Boolean);

    work.forEach((p, i) => {
      const corner = [0, 1].includes(p[0]) && [0, 1].includes(p[1]);
      const v = L.marker(ll(p), {
        draggable: true,
        autoPan: true,
        keyboard: false,
        zIndexOffset: 500,
        icon: handleIcon(`warp-pt${corner ? " corner" : ""}`),
      }).addTo(g);
      v.on("drag", () => {
        const at = v.getLatLng();
        work[i] = [p[0], p[1], at.lat, at.lng];
        previewDrawing(work);
        drawLines(work);
        for (const x of plus)
          if (x.e.includes(i))
            x.m.setLatLng([
              (work[x.e[0]][2] + work[x.e[1]][2]) / 2,
              (work[x.e[0]][3] + work[x.e[1]][3]) / 2,
            ]);
      });
      v.on("dragend", () =>
        editSpots("drawing: move point", (x) =>
          setDraftWarp(
            x,
            work.map((q, k) =>
              k === i ? [q[0], q[1], ...ll7(v.getLatLng())] : q,
            ),
          ),
        ),
      );
      v.bindPopup(() => {
        const box = document.createElement("div");
        box.innerHTML = `<strong>${corner ? "Corner" : "Point"} of the drawing</strong><br>${Math.round(p[0] * 100)}% across, ${Math.round(p[1] * 100)}% down<br>`;
        const del = document.createElement("button");
        del.className = "popup-btn";
        del.textContent = corner
          ? "Corners can be moved, not deleted"
          : "🗑 Delete this point";
        del.disabled = corner;
        del.onclick = () => {
          getMap().closePopup();
          editSpots("drawing: delete point", (x) =>
            setDraftWarp(
              x,
              work.filter((_, k) => k !== i),
            ),
          );
        };
        box.append(del);
        return box;
      });
    });
  }

  // A tap on the drawing adds a warp point at that spot of the picture
  // (snapped onto the edge if close to it). Nothing moves until it's dragged.
  function addWarpPoint(latlng) {
    let uv = getDrawing()?.uvAt?.(latlng);
    if (!uv) return toast("Tap on the drawing to add a point there.", "info");
    const tap = getMap().latLngToLayerPoint(latlng);
    const near = (u, v) => {
      const at = getDrawing().latLngAt(u, v);
      return at && getMap().latLngToLayerPoint(at).distanceTo(tap) < 16;
    };
    let [u, v] = uv;
    if (near(0, v)) u = 0;
    else if (near(1, v)) u = 1;
    if (near(u, 0)) v = 0;
    else if (near(u, 1)) v = 1;
    uv = [round(u, 5), round(v, 5)];
    const at = getDrawing().latLngAt(...uv);
    const warp = editWarp();
    if (
      warp.some(
        (p) =>
          getMap()
            .latLngToLayerPoint([p[2], p[3]])
            .distanceTo(getMap().latLngToLayerPoint(at)) < 20,
      )
    )
      return toast("There’s already a point there. Drag it instead.", "info");
    editSpots("drawing: add point", (x) =>
      setDraftWarp(x, [...warp, [...uv, ...ll7(at)]]),
    );
  }

  function setEditTarget(target) {
    if (debug.target === target) return;
    debug.target = target;
    log("debug_edit_target", { target });
    if (target === "drawing")
      toast(
        "Tap the drawing to add a point, then drag it to where that spot really is. Drag a “+” to bend an edge. Tap a point to delete it.",
        "info",
        8000,
      );
    drawDebug();
    renderDebug();
  }

  function toggleSeeThrough() {
    debug.seeThrough = !debug.seeThrough;
    syncDrawing();
    renderDebug();
  }

  // ---- Debug map layers and handles --------------------------------------
  const handleIcon = (cls, text = "") =>
    L.divIcon({
      className: "pin-icon",
      html: `<div class="${cls}"><span>${text}</span></div>`,
      iconSize: [30, 30],
      iconAnchor: [15, 15],
      popupAnchor: [0, -12],
    });

  function drawDebug() {
    if (!debug.on) return;
    const g = (debug.layer ||= L.layerGroup());
    g.clearLayers().addTo(getMap());
    if (C.OVERLAY) syncDrawing();
    const d = spots();
    const edit = debug.editing && !warpEditing(); // boundary and spots (not the drawing)
    const ringStyle = {
      className: "debug-ring",
      weight: 2,
      dashArray: "4 5",
      interactive: false,
    };

    if (edit || debug.draft) {
      // the boundary being edited (the orange dashed one is the one in use)
      const work = d.region.map((p) => [p[0], p[1]]);
      const poly = L.polygon(work, {
        className: "debug-region",
        weight: 3,
        fill: false,
        interactive: false,
      }).addTo(g);
      if (edit && getMap().getZoom() >= EDIT_MIN_ZOOM)
        addCornerHandles(g, poly, work);
    }

    const oRing = L.circle([d.origin.lat, d.origin.lng], {
      radius: ORIGIN.radius,
      ...ringStyle,
    }).addTo(g);
    if (edit || debug.draft) {
      // the 🏁 pin shows the start in use; this one is the editable copy
      addSpotPin(
        g,
        d.origin,
        "🏁",
        oRing,
        edit,
        () =>
          `<strong>${esc(ORIGIN.name)}</strong> (edited)<br>${d.origin.lat.toFixed(7)}, ${d.origin.lng.toFixed(7)}`,
        (ll) =>
          editSpots("move start", (x) => {
            x.origin = { lat: ll[0], lng: ll[1] };
          }),
      );
    }
    for (const p of ITEMS) {
      const at = spotOf(d, p);
      const ring = L.circle([at.lat, at.lng], {
        radius: p.radius,
        ...ringStyle,
      }).addTo(g);
      addSpotPin(
        g,
        at,
        p.index,
        ring,
        edit,
        () =>
          `<strong>${esc(p.name)}</strong> · code ${esc(p.code)}<br>${at.lat.toFixed(7)}, ${at.lng.toFixed(7)}<br>radius ${p.radius} m${state.pos ? ` · ${Geo.formatDistance(Geo.distance(state.pos, at))} from you` : ""}`,
        (ll) =>
          editSpots(`move ${p.id}`, (x) => {
            x.pois[p.id] = { lat: ll[0], lng: ll[1] };
          }),
      );
    }

    for (const pt of debug.points) {
      L.marker([pt.lat, pt.lng], {
        keyboard: false,
        zIndexOffset: 200,
        icon: L.divIcon({
          className: "pin-icon",
          html: `<div class="debug-dot"></div><span class="debug-label">${esc(pt.id)}</span>`,
          iconSize: [12, 12],
          iconAnchor: [6, 6],
          popupAnchor: [0, -6],
        }),
      })
        .bindPopup(
          () =>
            `<strong>${esc(pt.id)}</strong> · ${esc(pt.for ? targetName(pt.for) : "note")}<br>${pt.lat.toFixed(7)}, ${pt.lng.toFixed(7)}<br>±${Math.round(pt.acc)} m · ${pt.fixes} GPS fix${pt.fixes > 1 ? "es" : ""} · ${clockTime(pt.at)}${pt.note ? `<br>${esc(pt.note)}` : ""}`,
        )
        .addTo(g);
    }
    if (warpEditing()) addWarpHandles(g);
    $("#debug-count").textContent = debug.points.length;
  }

  function addSpotPin(g, at, label, ring, draggable, popup, onDrop) {
    const m = L.marker([at.lat, at.lng], {
      draggable,
      autoPan: true,
      keyboard: false,
      zIndexOffset: 100,
      icon: L.divIcon({
        className: "pin-icon",
        html: `<div class="poi-pin debug-pin${draggable ? " editable" : ""}">${label}</div>`,
        iconSize: [30, 30],
        iconAnchor: [15, 15],
        popupAnchor: [0, -14],
      }),
    })
      .bindPopup(popup)
      .addTo(g);
    m.on("drag", () => ring.setLatLng(m.getLatLng()));
    m.on("dragend", () => onDrop(ll7(m.getLatLng())));
  }

  // Corner handles (drag to move, tap to delete) and a "+" on every edge long
  // enough to grab (drag it to add a corner there).
  function addCornerHandles(g, poly, work) {
    const n = work.length;
    const midOf = (i) => {
      const a = work[i],
        b = work[(i + 1) % n];
      return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    };
    const roomy = (i) =>
      getMap()
        .latLngToLayerPoint(work[i])
        .distanceTo(getMap().latLngToLayerPoint(work[(i + 1) % n])) > 50;
    const mids = work.map((_, i) => {
      if (!roomy(i)) return null;
      const m = L.marker(midOf(i), {
        draggable: true,
        autoPan: true,
        keyboard: false,
        zIndexOffset: 200,
        icon: handleIcon("edit-mid", "+"),
      }).addTo(g);
      m.on("drag", () => {
        const t = work.slice();
        t.splice(i + 1, 0, [m.getLatLng().lat, m.getLatLng().lng]);
        poly.setLatLngs(t);
      });
      m.on("dragend", () =>
        editSpots("add corner", (x) => {
          x.region.splice(i + 1, 0, ll7(m.getLatLng()));
        }),
      );
      return m;
    });
    work.forEach((_, i) => {
      const v = L.marker(work[i], {
        draggable: true,
        autoPan: true,
        keyboard: false,
        zIndexOffset: 300,
        icon: handleIcon("edit-vertex"),
      }).addTo(g);
      v.on("drag", () => {
        const ll = v.getLatLng();
        work[i] = [ll.lat, ll.lng];
        poly.setLatLngs(work);
        for (const k of [(i - 1 + n) % n, i]) mids[k]?.setLatLng(midOf(k));
      });
      v.on("dragend", () =>
        editSpots("move corner", (x) => {
          x.region[i] = ll7(v.getLatLng());
        }),
      );
      v.bindPopup(() => {
        const box = document.createElement("div");
        box.innerHTML = `<strong>Corner ${i + 1} of ${n}</strong><br>`;
        const del = document.createElement("button");
        del.className = "popup-btn";
        del.textContent =
          n > 3 ? "🗑 Delete this corner" : "A boundary needs 3 corners";
        del.disabled = n <= 3;
        del.onclick = () => {
          getMap().closePopup();
          editSpots("delete corner", (x) => {
            x.region.splice(i, 1);
          });
        };
        box.append(del);
        return box;
      });
    });
  }

  // ---- Debug edit controls and draft application -------------------------
  function toggleEdit() {
    debug.editing = !debug.editing;
    log("debug_edit_mode", { on: debug.editing });
    if (debug.editing) {
      toast(
        warpEditing()
          ? "Tap the drawing to add a point, then drag it to where that spot really is. Drag a “+” to bend an edge. Tap a point to delete it."
          : "Drag pins and boundary corners. Drag a “+” to add a corner; tap a corner to delete it.",
        "info",
        6000,
      );
    }
    drawDebug();
    renderDebug();
  }

  function openSimplify() {
    const ring = spots().region;
    const body = document.createElement("p");
    body.textContent = `The boundary has ${ring.length} corners. Simplifying drops corners that barely change its shape (no part of the line moves more than the distance you pick). You can undo it.`;
    const options = [2, 3, 5, 8, 12]
      .map((tol) => ({ tol, ring: Geo.simplifyRing(ring, tol) }))
      .filter(
        (o) => o.ring.length < ring.length && !Geo.crossings(o.ring).length,
      )
      .map((o) => ({
        label: `Within ${o.tol} m → ${o.ring.length} corners`,
        action: () =>
          editSpots(`simplify ${o.tol} m`, (x) => {
            x.region = o.ring;
          }),
      }));
    showModal({
      id: "debug_simplify",
      title: "Simplify the boundary",
      body,
      compact: true,
      buttons: [...options, { label: "Cancel", primary: true }],
    });
  }

  function applyDraft() {
    if (!debug.draft) return toast("Nothing edited yet", "info");
    const d = spots();
    if (Geo.crossings(d.region).length)
      return toast(
        "The boundary crosses itself. Fix that first (Undo, or move the corners).",
        "warn",
        7000,
      );
    const problems = draftProblems(d);
    showModal({
      id: "debug_apply",
      title: "Use the edits on this phone?",
      compact: true,
      body:
        `The app reloads and then uses the edited boundary, spots${draftWarp(d) ? " and drawing" : ""} instead of js/config.js, on this phone only. A running hunt carries on.` +
        `${problems.length ? `\n\n⚠ ${problems.join("; ")}.` : ""}\n\nTo make it permanent for every phone, put the config block (Points → Copy, or Export) into js/config.js.`,
      buttons: [
        {
          label: "Apply and reload",
          primary: true,
          action: () => {
            debug.draft.applied = true;
            debug.draft.appliedAt = nowIso();
            saveDraft();
            log("debug_apply");
            location.reload();
          },
        },
        { label: "Cancel" },
      ],
    });
  }

  function resetDraft() {
    if (!debug.draft) return toast("Already using js/config.js", "info");
    const warped = !!draftWarp(debug.draft);
    showModal({
      id: "debug_reset",
      title: "Throw away the edits?",
      compact: true,
      body: `The boundary, spots${warped ? " and drawing" : ""} go back to js/config.js${DRAFT_APPLIED ? " and the app reloads" : ""}. Marked points are kept.`,
      buttons: [
        {
          label: warped ? "Reset everything" : "Reset",
          danger: true,
          action: () => {
            debug.undo.push(JSON.stringify(debug.draft));
            debug.draft = null;
            saveDraft();
            log("debug_edit", { what: "reset" });
            if (DRAFT_APPLIED) location.reload();
            else {
              drawDebug();
              renderDebug();
            }
          },
        },
        ...(warped
          ? [
              {
                label: "Reset the drawing only",
                action: () =>
                  editSpots("drawing: reset", (x) => {
                    if (DRAFT_APPLIED)
                      setDraftWarp(
                        x,
                        (CONFIG_FILE.WARP && normWarp(CONFIG_FILE.WARP)) ||
                          cornerWarp(),
                      );
                    // as in config.js (the applied one is in use now)
                    else delete x.overlay;
                  }),
              },
            ]
          : []),
        { label: "Cancel" },
      ],
    });
  }

  // ---- Debug GPS and panel rendering -------------------------------------
  function debugFix(fix) {
    const first = !state.pos;
    state.pos = fix;
    state.lastFixAt = Date.now();
    drawUser(fix);
    if (first && state.follow) {
      markApp("first_fix");
      getMap().setView([fix.lat, fix.lng], Math.max(getMap().getZoom(), 17));
    } else {
      followUser(fix);
    }
    renderDebug();
  }

  function renderDebug() {
    const f = state.pos;
    const d = spots();
    $("#debug-gps").textContent = f
      ? `${f.lat.toFixed(6)}, ${f.lng.toFixed(6)} · ±${Math.round(f.acc)} m${f.sim ? " (sim)" : ""}`
      : SIM
        ? "Tap the map to set your position"
        : "Waiting for GPS…";
    if (f) {
      const near = ITEMS.map((p) => ({
        p,
        d: Geo.distance(f, spotOf(d, p)),
      })).sort((a, b) => a.d - b.d)[0];
      const edge = Math.round(Geo.nearestOnPolygon(f, d.region).distance);
      $("#debug-near").textContent =
        `Nearest: ${near.p.name}, ${Geo.formatDistance(near.d)}${near.d <= near.p.radius ? " (inside its radius)" : ""}` +
        `${state.proximity ? ` · signal ${state.proximity.value.toFixed(2)}` : ""}` +
        ` · ${Geo.insidePolygon(f, d.region) ? `${edge} m inside the boundary` : `${edge} m OUTSIDE the boundary`}`;
    } else {
      $("#debug-near").textContent = "";
    }
    const problems = draftProblems(d);
    const warping = warpEditing();
    const hint =
      debug.editing && !warping && getMap().getZoom() < EDIT_MIN_ZOOM
        ? " · zoom in to move corners"
        : "";
    $("#debug-draft").textContent =
      `${draftStatus(d)}${hint}${problems.length ? ` · ⚠ ${problems.join("; ")}` : ""}`;
    $("#debug-draft").classList.toggle("warn", problems.length > 0);
    $("#debug-edit-actions").hidden = !debug.editing;
    $("#debug-edit-target").hidden = !debug.editing || !C.OVERLAY;
    $("#btn-edit-spots").classList.toggle("on", !warping);
    $("#btn-edit-drawing").classList.toggle("on", warping);
    $("#btn-debug-simplify").hidden = warping;
    $("#btn-debug-seethrough").hidden = !warping;
    $("#btn-debug-seethrough").classList.toggle("on", debug.seeThrough);
    $("#btn-debug-edit").classList.toggle("on", debug.editing);
    $("#btn-debug-undo").disabled = !debug.undo.length;
  }

  // ---- Debug GPS marks and point management ------------------------------
  function openMarkDialog() {
    if (!state.pos)
      return toast(
        SIM
          ? "Tap the map first to set your position"
          : "No GPS fix yet. Wait a moment.",
        "warn",
      );
    const d = spots();
    const near = ITEMS.map((p) => ({
      p,
      d: Geo.distance(state.pos, spotOf(d, p)),
    })).sort((a, b) => a.d - b.d)[0].p;
    const wrap = document.createElement("div");
    const intro = document.createElement("p");
    intro.textContent = `${SIM ? "Simulation: the point is taken where you last tapped." : `Stand on the spot. GPS is averaged for ${MARK_SECONDS} seconds.`} A mark for an item or the start moves it here (you can undo that in Edit).`;
    const sel = document.createElement("select");
    sel.className = "debug-field";
    for (const p of [...ITEMS, ORIGIN])
      sel.add(new Option(`For ${p.name}`, p.id));
    sel.add(new Option("Just a note (moves nothing)", ""));
    sel.value = near.id;
    const note = document.createElement("input");
    note.className = "debug-field";
    note.placeholder = 'Note (optional), e.g. "under the bench"';
    note.maxLength = 120;
    wrap.append(intro, sel, note);
    showModal({
      id: "debug_mark",
      title: "📍 Mark this spot",
      body: wrap,
      compact: true,
      buttons: [
        {
          label: "Mark it",
          primary: true,
          action: () => markSpot(sel.value, note.value.trim()),
        },
        { label: "Cancel" },
      ],
    });
  }

  async function markSpot(target, note) {
    const btn = $("#btn-debug-mark");
    btn.disabled = true;
    debug.samples = [];
    for (let s = SIM ? 0 : MARK_SECONDS; s > 0; s--) {
      btn.textContent = `Hold still… ${s}`;
      await sleep(1000);
    }
    const samples = debug.samples.length ? debug.samples : [state.pos]; // no new fix came in: use the last one
    debug.samples = null;
    btn.textContent = "📍 Mark";
    btn.disabled = false;
    // Average weighted by 1/accuracy², so the sharper fixes count more.
    let sw = 0,
      slat = 0,
      slng = 0;
    for (const f of samples) {
      const w = 1 / Math.max(1, f.acc) ** 2;
      sw += w;
      slat += f.lat * w;
      slng += f.lng * w;
    }
    const mean = { lat: slat / sw, lng: slng / sw };
    const n =
      debug.points.reduce(
        (m, p) => Math.max(m, parseInt(p.id.slice(1), 10) || 0),
        0,
      ) + 1;
    const point = {
      id: `P${n}`,
      for: target || null,
      note,
      lat: round(mean.lat, 7),
      lng: round(mean.lng, 7),
      acc: round(samples.reduce((s, f) => s + f.acc, 0) / samples.length, 1), // average reported accuracy
      spreadM: round(Math.max(...samples.map((f) => Geo.distance(f, mean))), 1), // how far the fixes wandered
      fixes: samples.length,
      at: nowIso(),
      sim: !!samples[0].sim,
    };
    debug.points.push(point);
    savePoints();
    log("debug_mark", {
      id: point.id,
      for: point.for,
      lat: point.lat,
      lng: point.lng,
      acc: point.acc,
      fixes: point.fixes,
    });
    const fixes = `±${Math.round(point.acc)} m, ${point.fixes} GPS fix${point.fixes > 1 ? "es" : ""}`;
    if (point.for) {
      const d = spots();
      const was =
        point.for === ORIGIN.id ? d.origin : spotOf(d, itemById(point.for));
      const at = { lat: point.lat, lng: point.lng };
      editSpots(`mark ${point.for}`, (x) => {
        if (point.for === ORIGIN.id) x.origin = at;
        else x.pois[point.for] = at;
      });
      toast(
        `📍 ${point.id} saved: ${targetName(point.for)} moved here, ${Geo.formatDistance(Geo.distance(was, at))} from before (${fixes})`,
        "ok",
        6000,
      );
    } else {
      drawDebug();
      toast(`📍 ${point.id} saved (${fixes})`, "ok");
    }
  }

  function openPointsList() {
    const wrap = document.createElement("div");
    const render = () => {
      wrap.textContent = "";
      if (!debug.points.length) {
        wrap.textContent = "No points yet. Walk to a spot and tap “Mark”.";
        return;
      }
      const ul = document.createElement("ul");
      ul.className = "debug-list";
      for (const pt of [...debug.points].reverse()) {
        const li = document.createElement("li");
        li.innerHTML =
          `<span><b>${esc(pt.id)}</b> ${esc(pt.for ? targetName(pt.for) : "Note")}${pt.note ? ` · ${esc(pt.note)}` : ""}` +
          `<small>±${Math.round(pt.acc)} m · ${pt.fixes} fix${pt.fixes > 1 ? "es" : ""} · ${clockTime(pt.at)}</small></span>`;
        const show = document.createElement("button");
        show.textContent = "📍";
        show.setAttribute("aria-label", `Show ${pt.id} on the map`);
        show.onclick = () => {
          wrap.closest(".modal").querySelector("button.primary").click();
          setFollow(false, "debug_point");
          markApp("debug_point");
          getMap().flyTo([pt.lat, pt.lng], 19, { duration: 0.8 });
        };
        const del = document.createElement("button");
        del.textContent = "🗑";
        del.setAttribute("aria-label", `Delete ${pt.id}`);
        del.onclick = () => {
          debug.points = debug.points.filter((x) => x !== pt);
          savePoints();
          drawDebug();
          log("debug_delete", { id: pt.id });
          render();
        };
        li.append(show, del);
        ul.append(li);
      }
      wrap.append(ul);
    };
    render();
    showModal({
      id: "debug_points",
      title: "Marked points",
      body: wrap,
      compact: true,
      buttons: [
        { label: "Close", primary: true },
        { label: "Copy config block", action: copyConfig },
        {
          label: "Delete all points",
          danger: true,
          action: confirmClearPoints,
        },
      ],
    });
  }

  function confirmClearPoints() {
    showModal({
      id: "debug_clear",
      title: "Delete all marked points?",
      body: "Export them first if you still need them. Spots they moved stay where they are.",
      compact: true,
      buttons: [
        {
          label: "Delete all",
          danger: true,
          action: () => {
            debug.points = [];
            savePoints();
            drawDebug();
            log("debug_delete", { id: "all" });
          },
        },
        { label: "Cancel" },
      ],
    });
  }

  // ---- Debug configuration and GeoJSON export ----------------------------
  // REGION, ORIGIN and POIS as they'd look in js/config.js with the edits in.
  // Everything else about each item (name, code, hint…) is kept.
  function configLines() {
    const d = spots();
    const q = (s) =>
      `'${String(s ?? "")
        .replace(/\\/g, "\\\\")
        .replace(/'/g, "\\'")
        .replace(/\n/g, "\\n")}'`;
    const file = Object.fromEntries(CONFIG_FILE.POIS.map((p) => [p.id, p]));
    const moved = (a, b) => {
      const m = b ? Geo.distance(a, b) : 0;
      return m >= 0.5
        ? ` // moved ${m < 10 ? m.toFixed(1) : Math.round(m)} m`
        : "";
    };
    const lines = [
      `  // ${d.region.length} corners`,
      "  REGION: [",
      ...d.region.map(
        ([lat, lng]) => `    [${lat.toFixed(7)}, ${lng.toFixed(7)}],`,
      ),
      "  ],",
      "",
    ];
    lines.push(
      `  ORIGIN: { name: ${q(C.ORIGIN.name)}, lat: ${d.origin.lat.toFixed(7)}, lng: ${d.origin.lng.toFixed(7)}${C.ORIGIN.radius ? `, radius: ${C.ORIGIN.radius}` : ""} },${moved(d.origin, CONFIG_FILE.ORIGIN)}`,
      "",
      "  POIS: [",
    );
    for (const p of C.POIS) {
      const a = spotOf(d, p);
      lines.push(
        `    { id: ${q(p.id)}, name: ${q(p.name)}, code: ${q(p.code || p.id)}, lat: ${a.lat.toFixed(7)}, lng: ${a.lng.toFixed(7)}${p.radius ? `, radius: ${p.radius}` : ""}, hint: ${q(p.hint)} },${moved(a, file[p.id])}`,
      );
    }
    lines.push("  ],");
    const w = configWarp(d);
    if (w) {
      const O = C.OVERLAY;
      const at = (u, v) => {
        const p = w.find((x) => x[0] === u && x[1] === v);
        return `[${p[2].toFixed(7)}, ${p[3].toFixed(7)}]`;
      };
      const sorted = [...w].sort((a, b) => a[1] - b[1] || a[0] - b[0]);
      lines.push(
        "",
        "  OVERLAY: {",
        `    url: ${q(O.url)},`,
        `    topLeft:    ${at(0, 0)},`,
        `    topRight:   ${at(1, 0)},`,
        `    bottomLeft: ${at(0, 1)},`,
        `    opacity: ${O.opacity ?? 1},`,
        `    streetMap: ${O.streetMap !== false},`,
        `    // ${w.length} warp points from the debug view: [across, down, lat, lng],`,
        "    // across/down = where in the picture, 0–1 (0, 0 = top-left corner).",
        "    warp: [",
        ...sorted.map(
          (p) =>
            `      [${round(p[0], 5)}, ${round(p[1], 5)}, ${p[2].toFixed(7)}, ${p[3].toFixed(7)}],`,
        ),
        "    ],",
        "  },",
      );
    }
    return lines;
  }
  // The drawing's warp for the config block: edited, or already in config.js.
  const configWarp = (d) => (C.OVERLAY ? draftWarp(d) || C.OVERLAY.warp : null);

  async function copyConfig() {
    try {
      await navigator.clipboard.writeText(configLines().join("\n"));
      toast(
        `Config block copied: in js/config.js, replace REGION, ORIGIN, POIS${configWarp(spots()) ? " and OVERLAY" : ""} with it`,
        "ok",
        6000,
      );
    } catch (e) {
      toast(
        "Could not copy here. Use Export instead; the file contains the same block.",
        "warn",
      );
    }
  }

  function exportDebug() {
    const d = spots();
    const point = (props, lat, lng) => ({
      type: "Feature",
      properties: props,
      geometry: { type: "Point", coordinates: [lng, lat] },
    });
    const data = {
      type: "FeatureCollection",
      features: [
        ...debug.points.map((pt) =>
          point(
            {
              id: pt.id,
              for: pt.for,
              forName: pt.for ? targetName(pt.for) : null,
              note: pt.note || null,
              accuracyM: pt.acc,
              spreadM: pt.spreadM,
              fixes: pt.fixes,
              time: pt.at,
              simulated: pt.sim,
              "marker-color": "#7c3aed",
            },
            pt.lat,
            pt.lng,
          ),
        ),
        point(
          { id: ORIGIN.id, name: ORIGIN.name, "marker-color": "#1d4ed8" },
          d.origin.lat,
          d.origin.lng,
        ),
        ...ITEMS.map((p) =>
          point(
            { id: p.id, name: p.name, "marker-color": "#ea580c" },
            spotOf(d, p).lat,
            spotOf(d, p).lng,
          ),
        ),
        {
          type: "Feature",
          properties: {
            name: "Hunt boundary",
            corners: d.region.length,
            stroke: C.BOUNDARY_COLOR,
            "fill-opacity": 0.05,
          },
          geometry: {
            type: "Polygon",
            coordinates: [
              [...d.region, d.region[0]].map(([lat, lng]) => [lng, lat]),
            ],
          },
        },
        ...(configWarp(d) || []).map((p) =>
          point(
            {
              name: "Drawing warp point",
              across: p[0],
              down: p[1],
              "marker-color": "#0d9488",
              "marker-size": "small",
            },
            p[2],
            p[3],
          ),
        ),
      ],
      // Paste these lines over REGION, ORIGIN and POIS (and OVERLAY, if there) in js/config.js.
      config: configLines(),
    };
    const a = document.createElement("a");
    a.href = URL.createObjectURL(
      new Blob([JSON.stringify(data, null, 1)], { type: "application/json" }),
    );
    a.download = `hunt-debug_${fileStamp(new Date())}.json`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    log("debug_download", {
      points: debug.points.length,
      edited: !!debug.draft,
    });
    toast(`⬇ Saved ${a.download}`, "ok");
  }

  return {
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
  };
};
