// FlightAware AeroAPI v4 client (flight number -> filed route).
// AeroAPI does not send CORS headers, so browsers need a proxy that forwards the
// x-apikey header. Configure proxy URL + key in Settings (stored in localStorage only).
(function (root) {
  const BASE = "https://aeroapi.flightaware.com/aeroapi";
  function viaProxy(proxy, url) {
    if (!proxy) return url;
    return proxy.includes("{url}") ? proxy.replace("{url}", encodeURIComponent(url)) : proxy + url;
  }
  async function call(path, cfg) {
    const url = viaProxy(cfg.proxy, BASE + path);
    let res;
    try {
      res = await fetch(url, { headers: { "x-apikey": cfg.key, Accept: "application/json" } });
    } catch (e) {
      const err = new Error(cfg.proxy ? "Couldn't reach the proxy (" + e.message + ")." :
        "Browser blocked the call to FlightAware (no CORS). Add a CORS proxy URL in Settings.");
      err.cors = !cfg.proxy; throw err;
    }
    if (res.status === 401) throw new Error("FlightAware rejected the API key (401).");
    if (res.status === 404) throw new Error("FlightAware has no flight by that ident (404).");
    if (!res.ok) throw new Error("FlightAware error " + res.status);
    return res.json();
  }
  function normIdent(s) {
    s = s.toUpperCase().replace(/\s+/g, "");
    if (/^AA\d+$/.test(s)) s = "AAL" + s.slice(2);
    if (/^\d+$/.test(s)) s = "AAL" + s; // bare number => American
    return s;
  }
  // Choose the flight Todd most likely cares about: next not-yet-departed, else in-air, else latest.
  function pickFlight(flights) {
    const now = Date.now();
    const t = (f) => Date.parse(f.scheduled_out || f.scheduled_off || 0);
    const live = flights.filter((f) => !f.cancelled && !f.actual_on);
    live.sort((a, b) => t(a) - t(b));
    const upcoming = live.find((f) => t(f) > now - 6 * 3600e3);
    return upcoming || live[0] || flights.slice().sort((a, b) => t(b) - t(a))[0];
  }
  async function lookup(identRaw, cfg) {
    if (!cfg.key) throw new Error("Add your FlightAware AeroAPI key in Settings first.");
    const ident = normIdent(identRaw);
    const data = await call(`/flights/${encodeURIComponent(ident)}`, cfg);
    const flights = data.flights || [];
    if (!flights.length) throw new Error("No recent or scheduled flights for " + ident + ".");
    const f = pickFlight(flights);
    const out = { ident, flight: f, filed: !!f.route, routeText: f.route || null, fixes: null, note: "" };
    try {
      const r = await call(`/flights/${encodeURIComponent(f.fa_flight_id)}/route`, cfg);
      if (r.fixes && r.fixes.length) out.fixes = r.fixes.filter((x) => x.latitude != null);
    } catch (e) { out.note = "Route detail unavailable: " + e.message; }
    if (!out.routeText && !(out.fixes && out.fixes.length)) {
      // not filed yet: fall back to the most recent flight of this number that had a filed route
      const prior = flights.filter((x) => x.route && x !== f).sort((a, b) => Date.parse(b.scheduled_out) - Date.parse(a.scheduled_out))[0];
      if (prior) { out.routeText = prior.route; out.note = `Not filed yet. Showing route filed for ${prior.scheduled_out?.slice(0, 10)} (recent history, not a guarantee).`; out.fromPrior = prior; }
      else out.note = "No filed route yet (usually filed 1–2 h before departure).";
    }
    return out;
  }
  root.AeroAPI = { lookup, normIdent, viaProxy };
})(this);
