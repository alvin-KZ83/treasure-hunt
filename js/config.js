/* =====================================================================
 *  HUNT CONFIGURATION — the only file you need to edit.
 *
 *  Coordinates are [latitude, longitude] in decimal degrees.
 *  Tip: in Google Maps, right-click a spot → the first menu line is
 *  "lat, lng" (click it to copy).
 * ===================================================================== */
window.HUNT_CONFIG = {
  HUNT_NAME: 'Treasure Hunt',

  // ---- Hunt area -------------------------------------------------------
  // Any polygon shape, with as many corners as you like. Either:
  //  a) a list of [lat, lng] corners in order around the edge, like below, or
  //  b) draw around the area at https://geojson.io (polygon or line tool) and
  //     paste the whole JSON from its right-hand panel here instead:
  //       REGION: { "type": "FeatureCollection", ... },
  //     (geojson.io writes points as [lng, lat]; the app converts that for you.)
  // Nothing outside is drawn, the map can't be panned or zoomed out past
  // it, and players get an alarm if they walk out of it.
  // (Your geojson.io drawing, converted to [lat, lng] and simplified from 160 to
  // 107 corners: no part of the line moved more than 5 m.)
  REGION: [
    [36.0997043, 140.1028705],
    [36.0995830, 140.1027417],
    [36.0992037, 140.1029348],
    [36.0988721, 140.1029643],
    [36.0987941, 140.1034847],
    [36.0988786, 140.1036000],
    [36.0991192, 140.1035839],
    [36.0995851, 140.1037019],
    [36.0999752, 140.1041204],
    [36.0998062, 140.1043189],
    [36.0997282, 140.1048124],
    [36.1000052, 140.1050516],
    [36.1002310, 140.1050913],
    [36.1003567, 140.1048392],
    [36.1006644, 140.1043725],
    [36.1008638, 140.1043671],
    [36.1012276, 140.1045830],
    [36.1015483, 140.1044251],
    [36.1015009, 140.1039326],
    [36.1018607, 140.1038736],
    [36.1019083, 140.1042438],
    [36.1026408, 140.1042598],
    [36.1031870, 140.1041043],
    [36.1033243, 140.1037470],
    [36.1034282, 140.1037375],
    [36.1034404, 140.1038510],
    [36.1036182, 140.1038274],
    [36.1036097, 140.1037162],
    [36.1037166, 140.1036977],
    [36.1036923, 140.1033196],
    [36.1042684, 140.1031831],
    [36.1045361, 140.1032264],
    [36.1053689, 140.1029515],
    [36.1055791, 140.1029613],
    [36.1065056, 140.1026331],
    [36.1067508, 140.1033234],
    [36.1073821, 140.1036990],
    [36.1079039, 140.1033671],
    [36.1082923, 140.1040631],
    [36.1088071, 140.1038545],
    [36.1084976, 140.1033045],
    [36.1087060, 140.1031679],
    [36.1086202, 140.1029403],
    [36.1092852, 140.1025155],
    [36.1094629, 140.1029138],
    [36.1098828, 140.1025041],
    [36.1099839, 140.1027886],
    [36.1104345, 140.1025035],
    [36.1102107, 140.1019692],
    [36.1102107, 140.1016620],
    [36.1105325, 140.1013168],
    [36.1104722, 140.1011445],
    [36.1101371, 140.1009337],
    [36.1098368, 140.1003723],
    [36.1096192, 140.0999778],
    [36.1093097, 140.1001409],
    [36.1092786, 140.1008676],
    [36.1090506, 140.1010045],
    [36.1088878, 140.1006253],
    [36.1085403, 140.1008492],
    [36.1088521, 140.1015631],
    [36.1085541, 140.1017578],
    [36.1081887, 140.1009517],
    [36.1074707, 140.1013892],
    [36.1070334, 140.1015652],
    [36.1068914, 140.1018132],
    [36.1065861, 140.1013748],
    [36.1062424, 140.1013748],
    [36.1057943, 140.1011637],
    [36.1042672, 140.1016103],
    [36.1044558, 140.1023152],
    [36.1041356, 140.1024571],
    [36.1035857, 140.1025486],
    [36.1035593, 140.1023006],
    [36.1031422, 140.1023656],
    [36.1031885, 140.1028551],
    [36.1030433, 140.1028857],
    [36.1029290, 140.1017691],
    [36.1025845, 140.1017976],
    [36.1026495, 140.1023394],
    [36.1021857, 140.1024520],
    [36.1021467, 140.1028705],
    [36.1015665, 140.1027155],
    [36.1009652, 140.1029816],
    [36.1011009, 140.1026644],
    [36.1013712, 140.1024808],
    [36.1013633, 140.1021458],
    [36.1010614, 140.1019261],
    [36.1008053, 140.1020443],
    [36.1005690, 140.1018834],
    [36.1002483, 140.1020417],
    [36.1000034, 140.1023582],
  ],

  // ---- Start / finish spot --------------------------------------------
  ORIGIN: { name: 'Start / Finish', lat: 36.1000424, lng: 140.1027283, radius: 20 },

  // ---- The items -------------------------------------------------------
  // id:     unique, letters/numbers only
  // code:   the text inside this item's QR code. Print all the codes with
  //         tools/qr-codes.html. Change them if you like; keep them unique.
  // radius (optional): this item's own signal radius; default PROXIMITY_RADIUS_M
  // hint (optional): shown in the item list and in the signal meter
   POIS: [
    { id: 'item01', name: 'Item 1', code: 'K7Q2XM', lat: 36.0994962, lng: 140.1034099, hint: '' }, // moved 19 m
    { id: 'item02', name: 'Item 2', code: 'P4HN8D', lat: 36.1004189, lng: 140.1030271, hint: '' }, // moved 8.5 m
    { id: 'item03', name: 'Item 3', code: 'T9WB3F', lat: 36.1008223, lng: 140.1037774, hint: '' },
    { id: 'item04', name: 'Item 4', code: 'R2JC6L', lat: 36.1011869, lng: 140.1033844, hint: '' }, // moved 34 m
    { id: 'item05', name: 'Item 5', code: 'M8VE4Z', lat: 36.1018389, lng: 140.1032408, hint: '' }, // moved 5.1 m
    { id: 'item06', name: 'Item 6', code: 'H3XT7N', lat: 36.1029291, lng: 140.1032982, hint: '' }, // moved 42 m
    { id: 'item07', name: 'Item 7', code: 'W6LP2K', lat: 36.1060497, lng: 140.1025432, hint: '' }, // moved 48 m
    { id: 'item08', name: 'Item 8', code: 'D5RZ9Q', lat: 36.1061537, lng: 140.1022804, hint: '' }, // moved 31 m
    { id: 'item09', name: 'Item 9', code: 'B7NF3H', lat: 36.1072653, lng: 140.1027632, hint: '' }, // moved 38 m
    { id: 'item10', name: 'Item 10', code: 'Y4KM8T', lat: 36.1078829, lng: 140.1024467, hint: '' }, // moved 9.0 m
    { id: 'item11', name: 'Item 11', code: 'F2GW6R', lat: 36.1079154, lng: 140.1016983, hint: '' }, // moved 9.2 m
    { id: 'item12', name: 'Item 12', code: 'N9CJ5V', lat: 36.1091723, lng: 140.1017520, hint: '' }, // moved 22 m
    { id: 'item13', name: 'Item 13', code: 'L3PD7X', lat: 36.1095710, lng: 140.1012558, hint: '' }, // moved 3.6 m
    { id: 'item14', name: 'Item 14', code: 'Z8TH4B', lat: 36.1098960, lng: 140.1015508, hint: '' }, // moved 16 m
  ],

  // ---- Treasure proximity ----------------------------------------------
  // Treasures are hidden on the map. Once the team is inside this distance
  // of one they haven't found yet, its ring appears and the "treasure
  // signal" turns on. It gets stronger as they close in: proximity = 0 at
  // the edge of the radius, 1 at the exact spot. Found treasures then
  // appear on the map as ✓.
  PROXIMITY_RADIUS_M: 15,

  // ---- Alert tuning (metres / seconds) ---------------------------------
  BOUNDARY_TOLERANCE_M: 10,  // how far outside the area before the alarm (absorbs GPS jitter)
  BOUNDARY_REMIND_SEC: 30,   // repeat vibration/sound this often while still outside
  MAX_ACCURACY_M: 40,        // GPS fixes worse than this are logged but don't trigger alerts
  SOUND: true,
  VIBRATE: true,

  // ---- Gameplay ----------------------------------------------------------
  REVEAL_POIS: false,        // true = show every treasure's marker and distance (handy for testing)

  // ---- Debug / scouting ----------------------------------------------------
  // Shows a 🛠 button (map controls + start screen) that toggles a debug view:
  // every item's pin and radius, your live GPS reading, and "Mark spot" to
  // record GPS points while you walk, then download them. Set false for the event.
  DEBUG_TOOLS: true,

  // ---- Map ---------------------------------------------------------------
  TILE_URL: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  TILE_ATTRIBUTION: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  MAX_ZOOM: 19,
  OUTSIDE_SHADE: 0,           // darkening outside REGION: 0 = shown normally, 0.4 = dimmed, 1 = blacked out
  MASK_COLOR: '#1e293b',      // colour of that shading (and behind the map while tiles load)
  BOUNDARY_COLOR: '#f97316',  // dashed outline of REGION

  // ---- Your own map drawing (optional) ---------------------------------
  // A PNG or JPG laid over the street map, pinned by three of its corners
  // (so it can also be rotated). Put the file in the images/ folder and use
  // tools/align-drawing.html to make a template or line the drawing up;
  // it writes this block for you. null = no drawing.
  OVERLAY: null,
  // OVERLAY: {
  //   url: 'images/test.png',
  //   topLeft:    [36.1107498, 140.0997162],
  //   topRight:   [36.1111908, 140.1055027],
  //   bottomLeft: [36.0974796, 140.0996589],
  //   opacity: 1,
  //   streetMap: true,
  // },

  // Testing without walking: set true, or add ?sim=1 to the URL.
  // Then tapping the map moves your "GPS position" there.
  SIMULATE_GPS: false,
};
