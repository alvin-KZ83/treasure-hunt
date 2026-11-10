/* QR camera and manual-entry controller. Created by app.js before boot. */
window.createHuntScanner = function (dependencies) {
  "use strict";
  const {
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
  } = dependencies;

  // ---- QR scanning and item discovery ------------------------------------
  // Live camera inside the page (no app switch). Chrome on Android decodes with
  // its built-in BarcodeDetector; other browsers fall back to jsQR.
  const scan = {
    open: false,
    token: 0, // invalidates pending camera setup and decode work when closed
    stream: null,
    decoder: null,
    timer: null,
    torch: false,
    unknown: new Set(),
  };

  // The treasure whose signal the team is picking up, if any.
  const scanTarget = () =>
    running() && state.proximity ? itemById(state.proximity.poiId) : null;

  function updateScanButton() {
    const p = scanTarget();
    const btn = $("#btn-scan");
    btn.classList.toggle("ready", !!p);
    btn.querySelector("span").textContent =
      p && C.REVEAL_POIS ? `Scan QR · ${p.name}` : "Scan QR code";
  }

  function setScanStatus(text, kind = "") {
    const el = $("#scan-status");
    el.textContent = text;
    el.className = kind;
  }

  async function getDecoder() {
    if (scan.decoder) return scan.decoder;
    if ("BarcodeDetector" in window) {
      try {
        if ((await BarcodeDetector.getSupportedFormats()).includes("qr_code")) {
          const detector = new BarcodeDetector({ formats: ["qr_code"] });
          scan.decoder = {
            kind: "native",
            read: async (video) =>
              (await detector.detect(video))[0]?.rawValue || null,
          };
          return scan.decoder;
        }
      } catch (e) {
        /* use jsQR */
      }
    }
    await loadScript("js/vendor/jsQR.js");
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    scan.decoder = {
      kind: "jsqr",
      read: async (video) => {
        const k = Math.min(
          1,
          720 / Math.max(video.videoWidth, video.videoHeight),
        ); // smaller frame = faster decode
        canvas.width = Math.round(video.videoWidth * k);
        canvas.height = Math.round(video.videoHeight * k);
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
        return (
          window.jsQR(img.data, img.width, img.height, {
            inversionAttempts: "dontInvert",
          })?.data || null
        );
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
    log("qr_scan_open", { from, poiId: target?.id ?? null });
    $("#scan-title").textContent =
      target && C.REVEAL_POIS
        ? `Scan the QR code · ${target.name}`
        : "Scan the QR code";
    $("#btn-torch").hidden = true;
    $("#btn-torch").classList.remove("on");
    setScanStatus("Starting camera…");
    $("#scanner").hidden = false;
    try {
      if (!navigator.mediaDevices?.getUserMedia)
        throw Object.assign(new Error("this browser has no camera access"), {
          name: "NotSupportedError",
        });
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
      });
      if (token !== scan.token) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      } // closed while Chrome was asking
      scan.stream = stream;
      const video = $("#scan-video");
      video.srcObject = stream;
      await video.play();
      const decoder = await getDecoder();
      if (token !== scan.token) return;
      const track = stream.getVideoTracks()[0];
      $("#btn-torch").hidden = !track.getCapabilities?.().torch;
      setScanStatus("Point the camera at the QR code");
      log("qr_camera_ready", {
        decoder: decoder.kind,
        width: video.videoWidth,
        height: video.videoHeight,
      });
      scanLoop(token);
    } catch (e) {
      log("qr_camera_error", { name: e.name, message: e.message });
      if (token !== scan.token) return;
      setScanStatus(
        e.name === "NotAllowedError"
          ? "The camera is blocked. In Chrome tap the icon left of the address bar → Permissions → Camera → Allow. Or type the code in instead."
          : `Camera problem (${e.message}). You can type the code in instead.`,
        "warn",
      );
    }
  }

  function scanLoop(token) {
    const video = $("#scan-video");
    const step = async () => {
      if (token !== scan.token) return;
      let text = null;
      if (video.readyState >= 2 && video.videoWidth) {
        try {
          text = await scan.decoder.read(video);
        } catch (e) {
          /* frame not ready yet */
        }
      }
      if (token !== scan.token) return;
      if (text) onCameraCode(text);
      if (token === scan.token) scan.timer = setTimeout(step, 150);
    };
    step();
  }

  function onCameraCode(text) {
    if (itemForCode(text)) {
      closeScanner("scanned");
      submitCode(text, "camera");
      return;
    }
    if (!scan.unknown.has(text)) {
      // the camera sees it many times a second; log it once
      scan.unknown.add(text);
      submitCode(text, "camera");
      alertUser("soft");
    }
    setScanStatus(
      "That QR code isn’t part of this hunt. Look for the hunt’s code.",
      "warn",
    );
  }

  function closeScanner(how) {
    if (!scan.open) return;
    scan.open = false;
    scan.token++;
    clearTimeout(scan.timer);
    scan.stream?.getTracks().forEach((t) => t.stop());
    scan.stream = null;
    scan.torch = false;
    $("#scan-video").srcObject = null;
    $("#scanner").hidden = true;
    log("qr_scan_close", { how });
  }

  async function toggleTorch() {
    const track = scan.stream?.getVideoTracks()[0];
    if (!track) return;
    try {
      await track.applyConstraints({ advanced: [{ torch: !scan.torch }] });
      scan.torch = !scan.torch;
      $("#btn-torch").classList.toggle("on", scan.torch);
      log("qr_torch", { on: scan.torch });
    } catch (e) {
      log("qr_torch_error", { message: e.message });
    }
  }

  // Fallback for a damaged code, glare or a blocked camera: the code text is
  // printed under each QR (tools/qr-codes.html).
  function openManualEntry(error) {
    closeScanner("manual_entry");
    log("qr_manual_open");
    const wrap = document.createElement("div");
    const p = document.createElement("p");
    p.className = error ? "error" : "";
    p.textContent = error || "Type the code printed under the QR code.";
    const input = document.createElement("input");
    input.className = "code-input";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.setAttribute("autocapitalize", "characters");
    input.maxLength = 200;
    wrap.append(p, input);
    showModal({
      id: "manual_code",
      title: "Type the code",
      body: wrap,
      buttons: [
        {
          label: "Check code",
          primary: true,
          action: () => checkTypedCode(input.value),
        },
        { label: "Cancel" },
      ],
      onOpen: (box) => {
        input.addEventListener("keydown", (e) => {
          if (e.key === "Enter") box.querySelector("button.primary").click();
        });
        setTimeout(() => input.focus(), 50);
      },
    });
  }

  function checkTypedCode(value) {
    const text = value.trim();
    if (!text) return;
    if (submitCode(text, "manual") === "unknown")
      openManualEntry(
        `“${text}” is not one of this hunt’s codes. Check it and try again.`,
      );
  }

  return {
    updateScanButton,
    openScanner,
    closeScanner,
    toggleTorch,
    openManualEntry,
  };
};
