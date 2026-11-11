https://geojson.io/

# Treasure Hunt Navigator

A GPS treasure-hunt app that runs in **Chrome on Android**. Players don't install anything: they open a link.

- Map with pinch/double-tap/button zoom, pan, "follow me" and "show whole area".
- The hunt area can be any polygon shape and is outlined with an orange dashed line. The map (and your drawing) still shows around it; panning stops about 300 m past the area or the drawing, whichever reaches further. `OUTSIDE_SHADE` can dim or black out the outside.
- **Pop-up alerts** (with vibration and sound):
  - a red banner with a direction arrow when a team walks **out of the area**, and again when they're back inside
  - "Back at the start, finish now?" on returning to the origin
- **Hidden treasures**: items are not shown on the map. Nothing pops up when a team gets near one. Instead, once they're inside its radius, the item's ring and a faint pin fade in, and a **treasure signal** grows stronger as they close in (see [The treasure signal](#the-treasure-signal)). Found items then appear on the map as ✓.
- **Your own map drawing**: a PNG or JPG laid over the street map, lined up exactly (see [Your own map drawing](#your-own-map-drawing)).
- **Item list**: tapping an item opens a small pop-up with its hint.
- **Debug / scouting view** (🛠, for organisers): shows every item's pin and radius and your live GPS reading. Walk the area, mark spots, and download them to fine-tune item positions (see [Debug / scouting view](#debug--scouting-view)).
- **QR codes**: each item has a printed QR code. The team scans it with the in-app scanner to mark the item found. If a code can't be scanned, they can type the text printed under it.
- **Start / Finish**: Start begins live GPS tracking. Finish stops it and **downloads one JSON file** with the summary, every interaction and the whole GPS track.
- Everything is saved on the phone as it happens. A reload or crash doesn't lose the hunt: it resumes.

```
index.html               the app
css/style.css
js/config.js             ← YOUR HUNT SETTINGS
questions.json           the item puzzles, one per item in item order
puzzle/                  pictures for the easy puzzles (Easy 01 = Item 1)
reward/                  the reward picture's layers: 1.png = Item 1's, …
js/app.js                map, GPS, alerts, QR scanning, logging, results file
js/geo.js                distance / inside-area maths
js/store.js              on-phone storage (IndexedDB)
js/overlay.js            places your drawing on the map by its corners
js/vendor/jsQR.js        QR decoder for phones without Chrome's built-in one
images/                  your map drawing (create this folder when you add one)
sw.js, manifest.webmanifest, icons/   offline cache + "Add to Home screen"
tools/qr-codes.html      printable QR codes for your items           ┐ organiser tools: keep private,
tools/align-drawing.html template + lining up your map drawing      │ don't upload the tools folder
tools/hunt-template.png  ready-made template for the current boundary┘
```

---

## 1. Set up your hunt: `js/config.js`

| Setting                              | What to put                                                                                                                                                                                                                                                                       |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `REGION`                             | The hunt area: any polygon, with as many corners as you need (see below).                                                                                                                                                                                                         |
| `ORIGIN`                             | Start/finish spot `{ name, lat, lng, radius }`                                                                                                                                                                                                                                    |
| `POIS`                               | Your 14 items: `{ id, name, code, lat, lng, hint }`. `id` is letters/numbers only. `code` is the text inside the item's QR code. `radius` overrides `PROXIMITY_RADIUS_M` for one item (optional). `hint` shows when the item is tapped in the item list, and in the signal meter. |
| `PROXIMITY_RADIUS_M`                 | Distance at which an item's ring appears and its treasure signal turns on (default 25 m). Phone GPS is usually off by 5–15 m, so 25–40 m works well.                                                                                                                              |
| `QUIZ_TRIES`, `QUIZ_REVEAL_RADIUS_M` | Puzzles (see [Item puzzles](#item-puzzles)): wrong answers allowed per puzzle (default 3), and the radius of the ring a solved puzzle shows, by level: `{ easy: 20, hard: 10 }` (a single number counts for both).                                                                |
| `BOUNDARY_COLOR`, `QUIZ_RING_COLOR`  | Colours of the dashed hunt boundary and of a solved puzzle's ring and its number, e.g. `'#f97316'`.                                                                                                                                                                               |
| `REVEAL_POIS`                        | `false` (default) keeps items hidden. `true` shows every item's marker, radius and distance, which is handy for checking your setup.                                                                                                                                              |
| `OVERLAY`                            | Your own map drawing, or `null` for none (see [Your own map drawing](#your-own-map-drawing)). Its optional `warp` list (`[across, down, lat, lng]` points) is written by the debug view.                                                                                          |
| `OUTSIDE_SHADE`                      | How much to darken the map outside `REGION`: `0` (default) shows it normally, `0.4` dims it, `1` blacks it out.                                                                                                                                                                   |
| `DEBUG_TOOLS`                        | `true` shows the 🛠 debug / scouting button. **Set it to `false` before the event**, so players can't see where the items are.                                                                                                                                                    |

### Drawing the boundary polygon

The easiest way is **<https://geojson.io>**:

1. Zoom the map to your area.
2. Pick the **polygon** drawing tool (the line tool works too), then click each corner around the edge. Add extra corners wherever the boundary should bend or follow a path. Click the first point again to close the shape.
3. Copy all the JSON from the right-hand panel and paste it in as the value of `REGION`. Keep the comma at the end:
   ```js
   REGION: { "type": "FeatureCollection", "features": [ ... ] },
   ```
   geojson.io writes points as `[longitude, latitude]`. The app converts that for you, so paste it as is.

Or type the corners yourself as `[lat, lng]` pairs, in order around the edge, as in the demo.

### Item and start coordinates

In Google Maps, right-click a spot. The first line of the menu is `lat, lng`; click it to copy. Latitude comes first. If you swap them, the start screen warns that the item is outside `REGION`.

### The treasure signal

Items are never drawn on the map. The app keeps one **proximity variable** for the item the team is closest to:

- it's off (`null`) until the team is inside an unfound item's radius;
- inside, `value = 1 − distance / radius`: **0** at the edge of the radius, **1** at the exact spot. If two radii overlap, the nearer item wins;
- it turns off again a few metres past the edge (so GPS jitter doesn't flicker it), when the item's QR code is scanned, and at Finish;
- GPS fixes with accuracy worse than `MAX_ACCURACY_M` leave it unchanged.

What the team sees, all driven by that value (none of it points towards the item):

| Value      | Signal meter              | Screen edge          | Player's dot         |
| ---------- | ------------------------- | -------------------- | -------------------- |
| 0 – 0.25   | 📡 bar, "Faint"           | yellow glow          | yellow, slow pulse   |
| 0.25 – 0.5 | "Warm"                    | orange               | orange               |
| 0.5 – 0.7  | "Hot"                     | red-orange, stronger | faster, bigger rings |
| 0.7 – 1    | "Very hot — look around!" | deep red, fast       | red, fast            |

Entering a radius doesn't trigger a pop-up or sound; the ring and meter simply appear. The phone gives a short buzz when the level steps up. With a 25 m radius and typical phone GPS, the value standing right at the spot usually reads 0.6–0.9, not exactly 1.

**On the map**, nothing about an item is drawn until the team is inside its radius. From then on its radius ring and a dashed pin are shown. They start faint and grow more solid and redder as `value` rises, and disappear again once the team walks a few metres back out. If two radii overlap, both appear. Once the QR code is scanned, the ring goes and a green ✓ stays.

**To add your own visual cues**, use the same variable:

- CSS: `--proximity` (0–1) is set on `<html>`, and `body` has the class `has-signal` while it's on. For example, `.my-thing { opacity: var(--proximity); }`. The existing cues are in `css/style.css` under "treasure signal".
- JavaScript: `document.addEventListener('hunt:proximity', (e) => { e.detail })` fires on every GPS fix. `e.detail` is `null` or `{ poiId, distance, radius, value }`.
- In `js/app.js` it is `state.proximity` (section TREASURE SIGNAL).

### Item puzzles

`questions.json` holds one puzzle per item, in item order: the first entry is Item 1's, the second Item 2's, and so on. An item with no entry has no puzzle. Each puzzle has a hard level (the top-level `image` / `answer`) and optionally an easy one (`easy`):

```json
[
  {
    "id": 1562,
    "image": "https://…/puzzle.png",
    "answer": "おはらい",
    "easy": {
      "image": "puzzle/Easy 01/1_question (Slide 3).png",
      "answer": "6"
    }
  },
  {
    "image": "images/quiz/02.png",
    "question": "What is it?",
    "answer": ["ラクダ", "camel"]
  }
]
```

`image` is the puzzle picture; `answer` is the answer, or a list of accepted answers. A level with an empty `answer` shows its picture but can't be answered yet (the start screen lists those). Optional: `question` (text under the picture) and `id` (copied into the log). Answers match ignoring upper/lower case, full/half width, spaces and punctuation, and hiragana and katakana count as the same (`オハライ` = `おはらい`).

During the hunt, tapping an item in the item list shows its hint and puzzle with an answer box. A switch at the top (🧩 Puzzle · 💡 Hint · Both) picks what to show; the phone remembers the choice. Items with both levels also get an **Easy · Hard** switch above the picture (Easy to begin with), remembered per item. Both levels share the same tries, so switching doesn't give extra ones. Each puzzle allows `QUIZ_TRIES` wrong answers. A right answer shows a dashed ring in `QUIZ_RING_COLOR` around the item on the map: a 20 m radius for an easy puzzle, 10 m for a hard one (`QUIZ_REVEAL_RADIUS_M`; the switch shows each level's size), which stays until the item is found. After the last wrong try the puzzle locks; the item can still be found with the treasure signal.

Pictures on another website only load while the phone is online and that site allows it. For the event, it's safer to save them into `images/quiz/` and point `image` at them; the app then keeps them for offline use.

### Reward picture

Every found item adds a piece to a bigger picture. Right after a find, the picture fills the screen with every found item's layer on, and the new piece fades in; the team taps to continue. Put one PNG per item in `reward/`, named by item number (`1.png` for Item 1, `2.png` for Item 2…). They are stacked in item order, so make them all the same size, transparent everywhere except their own piece. `REWARD_LAYERS` in `config.js` sets the file names (`'reward/{n}.png'`), or `null` turns the picture off. The layers are loaded when the hunt starts, so they show even with no signal.

**The secret 14th treasure.** After the last item is found, tapping the finished picture turns it over to one last question (`SECRET.question` in `config.js`). The team types a free answer and gets **one try**: it counts if it contains at least `SECRET.need` (3) different words from `SECRET.keywords`. A keyword can be a list of ways to write it, like `['こころ', '心']`; case, width, spaces and hiragana/katakana don't matter. A right answer turns the card back to the picture, now glowing; a wrong one turns it back with no glow. If the app is closed before they answer, the question comes back when the hunt is resumed. The answer is in the results file (`summary.secret`) and on the finish screen. `SECRET: null` turns it off. The start screen warns while there are fewer keywords than `need`.

### Your own map drawing

You can lay your own design (PNG or JPG) over the street map. It sits under the item rings, the pins and the player's dot. It shows in full, including any part beyond the boundary (unless `OUTSIDE_SHADE` is set). Use **`tools/align-drawing.html`**: open it on your computer by double-clicking it. It needs internet for the street map.

**For an exact match, start from the template:**

1. In step **A**, choose the detail level and click **Download template**. You get `hunt-template.png`: the street map of your area with the boundary drawn on, and known corner positions. A "High" one for the current boundary is already in `tools/hunt-template.png`.
   The template is cut around `REGION`, so **make it once the boundary is final**. If the boundary changes after you've set up `OVERLAY`, your drawing stays where it is, because its corners are saved in `config.js`; only a fresh template would change.
2. Draw your design on top of it in any drawing app (Procreate, Photoshop, Krita, Canva…). Resizing the whole picture is fine. **Don't crop it or add space around it**, because its edges are what pin it to the map.
3. Export as PNG (or JPG for a painted picture with no transparent parts). Keep it under about 4000 px on its longest side so phones handle it easily.
4. In step **B**, load your drawing. Because it has the template's shape, it snaps to the exact position. Check it against the streets.
5. In step **C**, set the file name and opacity, click **Copy**, and in `js/config.js` replace `OVERLAY: null,` with what you copied.
6. Create an `images` folder next to `index.html`, put the drawing in it, and upload that folder with the app.

**Drawing not made on the template?** Load it in step B and drag it into place: **✥** moves it, **⤡** resizes and rotates it, and **Free corners** fixes a drawing that's slightly out of shape. Turn down "See-through" to compare it with the streets. Line up landmarks at both ends of the area for the best fit.

Options in the `OVERLAY` block: `opacity` (1 = solid, lower lets the streets show through) and `streetMap: false` to show only your drawing with no street map underneath. To adjust a drawing later, open the tool again; it loads the current one from `config.js`.

**Drawing doesn't quite match the streets in places?** Bend it in the debug view (**✏️ Edit → 🖼 Drawing**, see below). That adds a `warp` list to the `OVERLAY` block. Do the overall placement in the tool first: the tool leaves `warp` out, so re-copying from it removes the bending.

### Debug / scouting view

For organisers, while `DEBUG_TOOLS: true`. Open it with **🛠** in the map controls, or "🛠 Debug / scouting view" on the start screen. Tap 🛠 or ✕ to close it again. It works with or without a hunt running.

- **On the map**: every item's pin (purple, dashed) and radius ring, the start's radius, and your marked points.
- **The panel** shows:
  - your GPS position and accuracy;
  - the nearest item and its distance (and the signal value during a hunt);
  - how far inside or outside the boundary you are;
  - the boundary's corner count and whether you're using `config.js` or your edits.
- **📍 Mark**:
  - Choose which item the spot is for (the nearest one is preselected), the start, or "just a note", and add a note if you like.
  - Stand still: GPS is averaged over 8 seconds, which is usually much steadier than a single reading.
  - The point appears as P1, P2…, and **the item (or start) moves to it**. That's an edit, so it can be undone.
- **✏️ Edit**: moves things by hand. Opens a second row of buttons.
  - Drag item pins and the 🏁 start pin.
  - Boundary corners (white squares) show when you zoom in. **Drag** a corner to move it, **drag a "+"** on an edge to add a corner there, and **tap** a corner to delete it.
  - **↶ Undo**: steps back through the last 50 edits.
  - **〰 Simplify**: removes boundary corners that barely change the shape. You choose how far the line may move (e.g. "Within 8 m → 91 corners").
  - **▶ Apply**: the app reloads and this phone then uses your edits instead of `config.js`, so you can test them for real. The start screen says so. Other phones are not affected.
  - **⟲ Reset**: throws the edits away and goes back to `config.js`.
  - The panel warns if the boundary crosses itself or a spot ends up outside it.
  - **📍 Boundary & spots / 🖼 Drawing** (only if you have an `OVERLAY`): picks what you're editing.
- **🖼 Drawing** bends your drawing to fit the real map. It starts pinned at its 4 corners (squares).
  - **Tap the drawing** to add a point at that spot of the picture. Nothing moves yet. Then **drag the point** to where that spot really is, e.g. from a drawn crossroads to the real one. The picture stretches around it.
  - **Drag a "+"** on the drawing's edge to add a point there and bend that edge. Drag a corner to move a corner.
  - **Tap a point** to delete it. Corners can only be moved.
  - The teal lines show the triangles the picture is bent along. Moving a point only changes the triangles touching it, so add a few points around an area to keep it still.
  - **◐ See-through** makes the drawing half transparent while you work (on by default). Undo, Apply and Reset work as above; Reset can also reset just the drawing.
  - The panel warns if a point is dragged so far that the drawing folds over itself.
- **☰ Points**: list with show-on-map and delete for each point, **Copy config block**, and **Delete all points**.
- **⬇ Export**: saves `hunt-debug_<date-time>.json`. It's GeoJSON, so you can open it at geojson.io to see your marks (purple), the item spots (orange), the start (blue) and the boundary.

**Making edits permanent:** "Copy config block", and the `config` lines in the exported file, contain `REGION`, `ORIGIN` and `POIS` with your edits in, plus `OVERLAY` with its `warp` points if you've bent the drawing. Moved spots are tagged `// moved N m`. In `js/config.js`, replace those blocks with it. That updates every phone, after which you can **Reset** on yours.

Edits are easier on a computer with a mouse. Open the app there (with `?sim=1` if you like), tap 🛠, and edit. Each device keeps its own edits, so use Copy / Export to move them across.

Marks and edits stay on the device, even after a reload or a hunt, until you delete or reset them. Scouting before a hunt is not written to any team's results file. With `DEBUG_TOOLS: false`, the debug view is gone and applied edits are ignored, so every phone uses `config.js`.

## 2. Print the QR codes

Open **`tools/qr-codes.html`** on your computer by double-clicking it. It needs no internet. It shows a QR code for every item in `config.js`, with the code text printed underneath. Print the page, cut out the codes and put each one at its item's spot. Outdoors, laminate them or use plastic sleeves.

- The demo config already has a random 6-character code per item. Keep them or change them; each must be unique. Codes match regardless of upper/lower case, spaces and dashes.
- If you change a code later, reprint that item's QR.
- Optionally type your app's address into the page, and it prints an extra "Open the hunt app" QR for teams to scan at the start.

## 3. Put it online (HTTPS is required)

Chrome only allows GPS and the camera on `https://` pages. GitHub Pages is free:

1. Create a GitHub account and a **new public repository**, e.g. `hunt`.
2. **Add file → Upload files**: drag in `index.html`, `manifest.webmanifest`, `sw.js` and the `css`, `js`, `icons` and (if you have a drawing) `images` folders. **Don't upload `tools/`**: those pages show every code and item position. Commit.
3. Open **Settings → Pages → Source: Deploy from a branch → `main` / `(root)` → Save**.
4. After a minute the app is live at `https://<username>.github.io/hunt/`. Share that link, or its QR code (step 2).

To change the hunt later, edit `js/config.js` on GitHub (pencil icon) and commit. Phones pick up the change on their next load.

## 4. Test before the event

- **At your desk, no walking needed:** open `https://<username>.github.io/hunt/?sim=1`. GPS is replaced by tapping the map: tap near an item's spot to pick up its signal (closer = stronger), and tap just outside the dashed line to trigger the boundary alarm. Items stay hidden here too. To see where they are while testing, temporarily set `REVEAL_POIS: true`. To "scan", hold a printed code (or `tools/qr-codes.html` on another screen) up to the webcam, or tap **Type the code**. Sim results files are marked `"simulated": true`.
- **On a phone:** walk to one item, scan its printed code, walk back and tap Finish. Then check the file in Downloads.

## On the day

- Before you share the link: set `DEBUG_TOOLS: false` in `js/config.js`.

- Charge phones fully. GPS with the screen on uses roughly 10–20 % battery per hour.
- Each team: open the link in **Chrome**, then ⋮ → **Add to Home screen**. It then opens full-screen like an app.
- Tap **Start hunt** and allow **Location**. Chrome asks for the **Camera** the first time they scan.
- **Keep the app open on screen.** The app keeps the screen awake, but browsers pause GPS when the phone is locked or another app is in front. Those gaps show up in the log as `app_visibility` events.
- At **Finish**, the phone downloads `hunt_<date>-<time>_<team>_<id>.json` to its Downloads folder. To collect it, have the team share it from the **Files** app (Downloads → share → email / WhatsApp / Drive), or copy it off the phone yourself. The Finish screen has **Download again** in case it went missing. The hunt stays on the phone until someone taps **Start a new hunt**.

## The results file

One JSON file per team:

```
{
  "format": "treasure-hunt-results", "formatVersion": 1,
  "summary": {
    team, sessionId, startedAt, finishedAt, durationSec, completedAt, huntTimeSec, itemsFound, itemsTotal,
    distanceWalkedM, gpsFixes, interactionEvents, simulated, device,
    items: [ { id, name, lat, lng, found, foundAt, method: "camera" | "manual",
               scanLat, scanLng, scanAcc, scanDistanceM, quizId, quizTries, quizSolvedAt, quizSolvedLevel }, … ],
    origin, region
  },
  "events": [ one interaction per line … ],
  "gps":    [ one GPS fix per line: iso, lat, lng, acc, alt, speed, heading,
              inside, outsideBy, nearestItem, nearestItemDist,
              proximityItem, proximity (the signal value at that moment) … ]
}
```

**Times:** the hunt clock stops the moment the last item is found. `completedAt` is that moment (null if not every item was found) and `huntTimeSec` is the team's time: start → last find, or start → Finish if they didn't find them all. This is the time shown on screen and on the finish screen. `durationSec` is the whole session, start → Finish. When the last item is found, a pop-up offers to end the hunt and save the results straight away.

`scanDistanceM` is how far GPS placed the team from the item when they scanned it. A large value means the code was scanned somewhere else, for example from a photo another team shared.

To analyse it in Python: `pd.DataFrame(json.load(open(path))["events"])`, and the same for `"gps"`.

### Interaction log events

Every event has `ts` (ms), `iso` (UTC time), `type`, and `view` = the map viewport at that moment (`zoom`, centre `lat`/`lng`, `bounds` [S, W, N, E]).

| Group                                   | Events                                                                                                                                                                                                                                                                                                                                                             |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Map                                     | `view_change` (`source`: `user`, `follow`, `button_in`, `fit_area`, `list_select`…), `zoom` (`from`, `to`, `trigger`: `pinch` / `double_tap` / `wheel` / `button_in` / `button_out` / `follow` / …), `pan_start`, `pan_end` (`distancePx`), `map_tap`, `map_long_press`, `poi_tap`, `popup_close`, `follow_on` / `follow_off` (`reason`), `map_resize`             |
| Buttons & screens                       | `ui_tap` (`control`), `list_open`, `list_close`, `item_info` (hint pop-up opened: `poiId`, `hasHint`, `found`), `list_select` ("Show on map" in that pop-up)                                                                                                                                                                                                       |
| Notifications                           | `notification_shown` / `notification_dismissed` (`channel`: toast / modal / banner, `id`, `how`: tap / timeout / button / backdrop, `button`)                                                                                                                                                                                                                      |
| Geofence                                | `boundary_exit`, `boundary_reminder`, `boundary_return`, `origin_left`, `origin_return`, `all_items_found` (`huntTimeSec`)                                                                                                                                                                                                                                                       |
| Treasure signal                         | `proximity_enter` (`poiId`, `distance`, `value`, `level`), `proximity_level` (`level` 0–3, `label`, `value`), `proximity_exit` (`found`), `treasure_shown` / `treasure_hidden` (ring + pin appeared / went: `poiId`, `distance`)                                                                                                                                   |
| Puzzles                                 | `quiz_answer` (`level`, `attempt`, `correct`, `text`), `quiz_solved` (`tries`), `quiz_locked`, `quiz_image_error`, `quiz_level` (`level`: easy / hard), `item_view` (`show`: puzzle / hint / both)                                                                                                                                                                 |
| Reward picture                          | `reward_shown` (`layers`: item numbers on), `reward_closed` (`shownMs`), `reward_image_error`, `secret_shown`, `secret_answer` (`correct`, `matched`, `text`)                                                                                                                                                                                                      |
| QR codes                                | `qr_scan_open`, `qr_camera_ready` (`decoder`), `qr_camera_error`, `qr_scan` (`result`: found / already_found / unknown, `method`: camera / manual), `item_found` (`distanceM`, `acc`), `qr_manual_open`, `qr_torch`, `qr_scan_close` (`how`)                                                                                                                       |
| GPS                                     | `gps_watch_start`, `gps_first_fix`, `gps_error`, `gps_watch_stop`                                                                                                                                                                                                                                                                                                  |
| Session & app                           | `app_load`, `session_start`, `session_resume`, `finish_prompt`, `session_finish`, `app_visibility`, `wakelock_on` / `_off`, `network`, `orientation`, `page_hide`, `overlay_error` (drawing file missing), `js_error`                                                                                                                                              |
| Debug view (only if used during a hunt) | `debug_view` (`on`), `debug_mark` (`id`, `for`, `lat`, `lng`, `acc`, `fixes`), `debug_edit_mode` (`on`), `debug_edit_target` (`target`: spots / drawing), `debug_edit` (`what`: move corner / add corner / delete corner / move item01 / simplify 8 m / drawing: add point / drawing: move point / undo / reset…), `debug_apply`, `debug_delete`, `debug_download` |

The summary's `positionsFrom` says whether that phone used `js/config.js` or debug-view edits.

Events from before **Start** (e.g. exploring the map) are kept and marked `"buffered": true`. Logging stops at Finish.

## Notes and limits

- **The codes (and puzzle answers in `questions.json`) are visible** to anyone who opens the page source. That's fine for a friendly hunt. If cheating matters, compare `scanDistanceM` in the results file.
- **Map tiles** come from OpenStreetMap's free server, which is fine for a hunt with a few teams. For a large public event, use a provider with an API key (MapTiler, Stadia, Thunderforest) and set `TILE_URL` and `TILE_ATTRIBUTION`.
- **Background tracking** isn't possible for web apps on Android, so the screen must stay on (see above).
- iPhone Safari mostly works (it uses the jsQR decoder), but the app is built and tested for Chrome on Android.
