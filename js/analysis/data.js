/* ============================================================
   TREASURE HUNT ANALYTICS — DATA PROCESSING
   ============================================================ */

// 1. LOAD & VALIDATE JSON FILES

export async function loadSessions(files) {
  const sessions = [];

  for (const file of files) {
    let data;
    try {
      data = JSON.parse(await file.text());
    } catch {
      throw new Error(`${file.name}: Invalid JSON file.`);
    }

    if (
      data.format !== "treasure-hunt-results" ||
      !data.summary ||
      !Array.isArray(data.events)
    ) {
      throw new Error(`${file.name}: Not a Treasure Hunt results file.`);
    }

    sessions.push(analyzeSession(data));
  }

  return sessions;
}

// 2. HELPERS

const countBy = (items, getKey) => {
  const counts = {};
  for (const item of items) {
    const key = getKey(item) || "other";
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
};

const isManualZoom = (event) =>
  event.type === "zoom" &&
  !["first_fix", "follow", "list_select", "initial", "app"].includes(
    event.trigger,
  );

// Some actions generate more than one event. This is an activity indicator,
// not a literal click count.
const isUserAction = (event) =>
  event.type === "ui_tap" ||
  event.type === "pan_start" ||
  isManualZoom(event) ||
  event.type === "item_view" ||
  event.type === "quiz_level" ||
  event.type === "quiz_answer" ||
  event.type === "list_open" ||
  event.type === "list_select" ||
  event.type === "map_tap";

// 3. INTERACTION METRICS

function analyzeInteractions(events, durationSec) {
  const zooms = events.filter((e) => e.type === "zoom");
  const manualZooms = zooms.filter(isManualZoom);
  const pans = events.filter((e) => e.type === "pan_start");
  const taps = events.filter((e) => e.type === "ui_tap");
  const userEvents = events.filter(isUserAction);

  const activityRate =
    durationSec > 0 ? userEvents.length / (durationSec / 60) : 0;

  return {
    totalLoggedEvents: events.length,
    userActivityEvents: userEvents.length,
    activityRate: Number(activityRate.toFixed(2)),
    zoomIn: manualZooms.filter((e) => e.to > e.from).length,
    zoomOut: manualZooms.filter((e) => e.to < e.from).length,
    manualZooms: manualZooms.length,
    automaticZooms: zooms.length - manualZooms.length,
    pans: pans.length,
    locateTaps: taps.filter((e) => e.control === "locate").length,
    controlUsage: countBy(taps, (e) => e.control),
    eventTypes: countBy(events, (e) => e.type),
    viewSources: countBy(
      events.filter((e) => e.type === "view_change"),
      (e) => e.source,
    ),
  };
}

// 4. FEATURE USAGE

function analyzeFeatures(events) {
  const count = (type) => events.filter((e) => e.type === type).length;
  return {
    listOpens: count("list_open"),
    itemViews: count("item_info"),
    // These are explicit tab selections, not every time a hint was visible.
    hintViews: events.filter(
      (e) => e.type === "item_view" && ["hint", "both"].includes(e.show),
    ).length,
    puzzleAnswers: count("quiz_answer"),
    correctAnswers: events.filter(
      (e) => e.type === "quiz_answer" && e.correct === true,
    ).length,
    scanAttempts: events.filter(
      (e) => e.type === "ui_tap" && e.control === "scan",
    ).length,
    proximityAlerts: count("proximity_enter"),
    boundaryExits: count("boundary_exit"),
  };
}

// 5. ACTIVITY TIMELINE

function analyzeTimeline(events, startTs, durationSec) {
  const bucketSeconds = 300; // 5-minute intervals
  const buckets = [];
  if (!Number.isFinite(startTs) || durationSec <= 0) return buckets;

  const actions = events.filter(isUserAction);
  for (let start = 0; start < durationSec; start += bucketSeconds) {
    const end = Math.min(start + bucketSeconds, durationSec);
    const count = actions.filter((e) => {
      const elapsed = (e.ts - startTs) / 1000;
      return elapsed >= start && elapsed < end;
    }).length;

    buckets.push({
      minute: Math.floor(start / 60),
      label: `${Math.floor(start / 60)}–${Math.ceil(end / 60)} min`,
      interactions: count,
    });
  }
  return buckets;
}

// 6. BEHAVIOR PATTERNS

function analyzePatterns(events) {
  const patterns = [];
  const ordered = [...events].sort((a, b) => a.ts - b.ts);

  // Count episodes, not overlapping pairs. An episode requires at least
  // 2 manual zooms, with <= 30 seconds between consecutive zooms.
  const zooms = ordered.filter(isManualZoom);
  let zoomEpisodes = 0;
  let runLength = 0;

  for (let i = 0; i < zooms.length; i++) {
    if (i > 0 && zooms[i].ts - zooms[i - 1].ts <= 30000) {
      runLength += 1;
    } else {
      if (runLength >= 2) zoomEpisodes++;
      runLength = 1;
    }
  }
  if (runLength >= 2) zoomEpisodes++;

  if (zoomEpisodes > 0) {
    patterns.push({
      title: "Repeated Zooming Episodes",
      count: zoomEpisodes,
      description:
        "Groups of at least two manual zoom actions, with no more than " +
        "30 seconds between consecutive zooms. One group counts as one episode.",
    });
  }

  // Locate Me shortly after manual map exploration.
  const locates = ordered.filter(
    (e) => e.type === "ui_tap" && e.control === "locate",
  );
  const explorations = ordered.filter(
    (e) => e.type === "pan_start" || isManualZoom(e),
  );
  const reorientations = locates.filter((locate) =>
    explorations.some((e) => locate.ts >= e.ts && locate.ts - e.ts <= 60000),
  ).length;

  if (reorientations > 0) {
    patterns.push({
      title: "Possible Reorientation",
      count: reorientations,
      description:
        "Locate Me was used within 60 seconds of manual map exploration.",
    });
  }

  // Did any manual action follow a boundary alert within 30 seconds?
  const alerts = ordered.filter((e) => e.type === "boundary_exit");
  const responses = alerts.filter((alert) =>
    ordered.some(
      (e) => isUserAction(e) && e.ts > alert.ts && e.ts <= alert.ts + 30000,
    ),
  ).length;

  if (responses > 0) {
    patterns.push({
      title: "Interaction After Boundary Alert",
      count: responses,
      description:
        "At least one manual interaction occurred within 30 seconds " +
        "of a boundary alert.",
    });
  }

  return patterns;
}

// 7. PROCESS ONE SESSION

export function analyzeSession(data) {
  const summary = data.summary;
  const events = [...data.events].sort((a, b) => a.ts - b.ts);
  const startTs = Date.parse(summary.startedAt);
  const durationSec = Number(summary.durationSec) || 0;

  return {
    id: summary.sessionId,
    team: summary.team || "Unknown",
    startedAt: summary.startedAt,
    durationSec,
    itemsFound: summary.itemsFound || 0,
    itemsTotal: summary.itemsTotal || 0,
    interactions: analyzeInteractions(events, durationSec),
    features: analyzeFeatures(events),
    timeline: analyzeTimeline(events, startTs, durationSec),
    patterns: analyzePatterns(events),
    events,
  };
}
