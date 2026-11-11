# RouteWx

Phone-first web app (add to iPhone Home Screen) that combines a MyRadar-style animated radar map
with WSI-style route weather: paste a route, see SIGMETs / G-AIRMETs / PIREPs along it and
METAR/TAF at both ends.

**Live:** https://f16rat.github.io/route-wx/

## Using it
- **Route box:** `KDFW KPHX`, or a full route like `KDFW AKUNA9 ABI J4 INK DCT ELP DCT SSO SUNSS8 KPHX`
  (dotted ICAO style `KDFW.AKUNA9.ABI..INK..ELP..TUS.SUNSS8.KPHX` also works).
  Airports, VORs/NDBs, fixes, lat/lon (`3530N10530W`), airways, and FAA SIDs/STARs are expanded
  from the FAA NASR 28-day data. Anything it can't find is listed and skipped (line connects the rest).
- **Briefing sheet** (tap the bottom bar): DEP/ARR METAR+TAF with flight category; SIGMETs,
  convective SIGMETs, international SIGMETs and G-AIRMETs touching a ±25 nm corridor (where along the route);
  PIREPs within 50 nm (MOD+ first); IFR/LIFR airports near the route. Corridor/radius are in Settings.
- **Map:** tap a METAR dot or route airport for METAR/TAF; tap a polygon or PIREP for its text.
  ☰ toggles layers and G-AIRMET time (now/+3/+6 h). ⏸/▶ plays the radar loop.
- **Recent:** every route you run is saved on the phone (localStorage).
- Share/bookmark a route: `https://f16rat.github.io/route-wx/#r=KDFW%20KPHX`.

## Where the data comes from
| Layer | Source | Freshness |
|---|---|---|
| Radar | NEXRAD composite via Iowa Environmental Mesonet tiles (default), or RainViewer (global, max zoom 7) | live, 5-min frames, 50-min loop |
| METAR/TAF/PIREP/SIGMET/G-AIRMET | aviationweather.gov | snapshot every ~10 min (see below) |
| Airports/navaids/fixes/airways/SIDs/STARs | FAA NASR 28-day subscription (+ OurAirports for non-US airports) | refreshed weekly by a GitHub Action |

**Why a snapshot:** aviationweather.gov doesn't send CORS headers, so a web page on another site
can't read it directly. A GitHub Action (`.github/workflows/pages.yml`) runs `tools/fetch_wx.py`
every 10 minutes and publishes the JSON next to the app. GitHub sometimes delays scheduled runs;
the app shows the data age at top-left (turns yellow if > 45 min).

## Flight-number lookup (FlightAware AeroAPI) — needs setup
The code path is built (`js/aeroapi.js`): `GET /flights/{ident}` → picks the next/active flight →
`GET /flights/{fa_flight_id}/route` for the filed fixes (falls back to the `route` string, or to the
most recent day's filed route if today's isn't filed yet — dispatch usually files 1–2 h before departure).

Two things are required, entered in ⚙ Settings (stored only on the phone):
1. An **AeroAPI key** (FlightAware account, billed per query).
2. A **CORS proxy URL**, because AeroAPI blocks browser calls. Format `https://your-proxy/?url={url}`.
   Use a proxy you control (the key passes through it). Example Cloudflare Worker:
   ```js
   export default { async fetch(req) {
     const u = new URL(req.url).searchParams.get("url");
     if (req.method === "OPTIONS") return new Response(null, { headers: { "Access-Control-Allow-Origin": "https://f16rat.github.io", "Access-Control-Allow-Headers": "x-apikey", "Access-Control-Allow-Methods": "GET" } });
     if (!u || !u.startsWith("https://aeroapi.flightaware.com/aeroapi/")) return new Response("bad url", { status: 400 });
     const r = await fetch(u, { headers: { "x-apikey": req.headers.get("x-apikey") || "" } });
     return new Response(r.body, { status: r.status, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "https://f16rat.github.io" } });
   } };
   ```
Until then, the Lookup button shows a FlightAware link so you can copy the route and paste it.

## Limits
- Not a dispatch/briefing product; situational awareness only.
- Procedures: draws the SID/STAR "common" path plus the named transition; runway-specific legs are simplified.
  Non-FAA procedures/airways (e.g., Canadian/Mexican) aren't expanded — the line connects known points.
- G-AIRMET freezing-level lines are drawn but not listed as route hazards.

## Dev
`python3 tools/build_nav.py` (nav data) · `python3 tools/fetch_wx.py` (weather snapshot) · serve the folder with any static server.
