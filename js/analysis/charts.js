/* ============================================================
   TREASURE HUNT ANALYTICS — DASHBOARD
   ============================================================ */

import { loadSessions } from "./data.js";

// 1. ELEMENTS & STATE

const $ = (selector) => document.querySelector(selector);
const upload = $("#json-upload");
const status = $("#upload-status");
const dashboard = $("#dashboard-content");

let sessions = [];
let selectedSession = 0;
const charts = {};

const formatDuration = (seconds) => {
  const minutes = Math.floor(seconds / 60);
  const remaining = Math.floor(seconds % 60);
  return `${minutes}m ${String(remaining).padStart(2, "0")}s`;
};

const setStatus = (message, error = false) => {
  status.textContent = message;
  status.style.color = error ? "#dc2626" : "#64748b";
};

// 2. FILE UPLOAD

upload.addEventListener("change", async () => {
  const files = [...upload.files];
  if (!files.length) return;

  dashboard.hidden = true;
  setStatus("Reading files...");

  try {
    if (typeof Chart === "undefined") {
      throw new Error(
        "Chart.js could not be loaded. Check your internet connection.",
      );
    }

    sessions = await loadSessions(files);
    selectedSession = 0;
    createSessionSelector();
    renderDashboard();
    dashboard.hidden = false;
    setStatus(`${sessions.length} session(s) loaded successfully.`);
  } catch (error) {
    sessions = [];
    setStatus(error.message, true);
    console.error("Analytics error:", error);
  }
});

// 3. SESSION SELECTOR

function createSessionSelector() {
  let container = $("#session-selector");
  if (!container) {
    container = document.createElement("div");
    container.id = "session-selector";
    container.className = "upload-section";
    dashboard.prepend(container);
  }
  container.replaceChildren();

  if (sessions.length <= 1) {
    container.hidden = true;
    return;
  }
  container.hidden = false;

  const label = document.createElement("label");
  label.htmlFor = "session-select";
  label.textContent = "Select participant / session";

  const select = document.createElement("select");
  select.id = "session-select";
  sessions.forEach((session, index) => {
    const option = document.createElement("option");
    option.value = index;
    option.textContent = `${session.team} — ${session.id}`;
    select.append(option);
  });
  select.addEventListener("change", () => {
    selectedSession = Number(select.value);
    renderDashboard();
  });
  container.append(label, select);
}

// 4. SUMMARY CARDS

function renderSummary(session) {
  const container = $("#summary-cards");
  container.replaceChildren();
  const interaction = session.interactions;
  const features = session.features;

  const metrics = [
    ["Duration", formatDuration(session.durationSec)],
    [
      "Manual map actions",
      interaction.manualZooms + interaction.pans + interaction.locateTaps,
    ],
    ["Activity events", interaction.userActivityEvents],
    ["Activity events / min", interaction.activityRate],
    ["Zoom actions", interaction.manualZooms],
    ["Manual pans", interaction.pans],
    ["Locate Me taps", interaction.locateTaps],
    ["Items found", `${session.itemsFound}/${session.itemsTotal}`],
    ["Item views", features.itemViews],
    ["Puzzle answers", features.puzzleAnswers],
    ["Boundary exits", features.boundaryExits],
    ["Proximity entries", features.proximityAlerts],
  ];

  for (const [label, value] of metrics) {
    const card = document.createElement("article");
    card.className = "metric-card";
    const number = document.createElement("div");
    number.className = "metric-value";
    number.textContent = value;
    const text = document.createElement("div");
    text.className = "metric-label";
    text.textContent = label;
    card.append(number, text);
    container.append(card);
  }
}

// 5. CHART HELPERS

function drawChart(id, config) {
  if (charts[id]) charts[id].destroy();
  charts[id] = new Chart(document.getElementById(id), config);
}

const commonOptions = {
  responsive: true,
  maintainAspectRatio: false,
  plugins: { legend: { display: false } },
  scales: { y: { beginAtZero: true, ticks: { precision: 0 } } },
};

// 6. INTERACTION TYPES CHART

function renderInteractionChart(session) {
  const data = session.interactions;
  drawChart("interaction-chart", {
    type: "bar",
    data: {
      labels: ["Zoom In", "Zoom Out", "Manual Pan", "Locate Me"],
      datasets: [
        {
          label: "Actions",
          data: [data.zoomIn, data.zoomOut, data.pans, data.locateTaps],
          backgroundColor: ["#0d9488", "#14b8a6", "#64748b", "#2563eb"],
          borderRadius: 6,
        },
      ],
    },
    options: commonOptions,
  });
}

// 7. FEATURE USAGE CHART

function renderFeatureChart(session) {
  const data = session.features;
  drawChart("feature-chart", {
    type: "bar",
    data: {
      labels: [
        "Open List",
        "View Item",
        "Select Hint/Both",
        "Quiz Answer",
        "QR Scan Tap",
      ],
      datasets: [
        {
          label: "Events",
          data: [
            data.listOpens,
            data.itemViews,
            data.hintViews,
            data.puzzleAnswers,
            data.scanAttempts,
          ],
          backgroundColor: "#0d9488",
          borderRadius: 6,
        },
      ],
    },
    options: {
      ...commonOptions,
      indexAxis: "y",
      scales: {
        x: { beginAtZero: true, ticks: { precision: 0 } },
        y: { ticks: { autoSkip: false } },
      },
    },
  });
}

// 8. INTERACTION TIMELINE

function renderTimelineChart(session) {
  const timeline = session.timeline;
  drawChart("timeline-chart", {
    type: "line",
    data: {
      labels: timeline.map((item) => item.label),
      datasets: [
        {
          label: "Activity events",
          data: timeline.map((item) => item.interactions),
          borderColor: "#0d9488",
          backgroundColor: "rgba(13,148,136,0.12)",
          fill: true,
          tension: 0.25,
          pointRadius: timeline.length > 25 ? 2 : 4,
          pointBackgroundColor: "#0d9488",
        },
      ],
    },
    options: {
      ...commonOptions,
      scales: {
        x: {
          ticks: {
            maxTicksLimit: 9,
            maxRotation: 0,
            autoSkip: true,
          },
          grid: { display: false },
        },
        y: { beginAtZero: true, ticks: { precision: 0 } },
      },
      plugins: {
        legend: { display: false },
        tooltip: { enabled: true },
      },
    },
  });
}

// 9. BEHAVIOR PATTERNS

function renderPatterns(session) {
  const container = $("#behavior-patterns");
  container.replaceChildren();

  if (!session.patterns.length) {
    const card = document.createElement("article");
    card.className = "pattern-card";
    const title = document.createElement("h3");
    title.textContent = "No predefined patterns detected";
    const description = document.createElement("p");
    description.textContent =
      "This session did not match the current detection rules. " +
      "This does not mean there were no meaningful behaviors.";
    card.append(title, description);
    container.append(card);
    return;
  }

  for (const pattern of session.patterns) {
    const card = document.createElement("article");
    card.className = "pattern-card";
    const title = document.createElement("h3");
    title.textContent = pattern.title;
    const count = document.createElement("div");
    count.className = "metric-value";
    count.textContent = pattern.count;
    const description = document.createElement("p");
    description.textContent = pattern.description;
    card.append(title, count, description);
    container.append(card);
  }
}

// 10. RENDER THE COMPLETE DASHBOARD

function renderDashboard() {
  const session = sessions[selectedSession];
  if (!session) return;
  renderSummary(session);
  renderInteractionChart(session);
  renderFeatureChart(session);
  renderTimelineChart(session);
  renderPatterns(session);
}
