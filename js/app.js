/* RouteWx – live radar + route weather for iPhone (PWA). */
(function () {
  "use strict";
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const LS = "routewx.";
  const settings = Object.assign({ radar: "iem", corridor: 25, pirepNm: 50, faKey: "", proxy: "", ga: { "TURB-HI": 1, "TURB-LO": 1, ICE: 1, LLWS: 1 }, gaHour: 0,
    layers: { radar: 1, conv: 1, sigmet: 1, gairmet: 1, pirep: 1, metar: 1 } }, JSON.parse(localStorage.getItem(LS + "settings") || "{}"));
  const save = () => localStorage.setItem(LS + "settings", JSON.stringify(settings));
  function toast(msg, ms = 3500) { const t = $("#toast"); t.textContent = msg; t.classList.remove("hidden"); clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.add("hidden"), ms); }
  const fmtTime = (d) => new Date(d).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const zulu = (d) => { d = new Date(d); return String(d.getUTCHours()).padStart(2, "0") + String(d.getUTCMinutes()).padStart(2, "0") + "Z"; };

  // ---------- Map ----------
  const map = L.map("map", { preferCanvas: true, zoomControl: false, worldCopyJump: true, attributionControl: true }).setView([37, -97], 4);
  const ESRI = "https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/";
  L.tileLayer(ESRI + "World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}", { maxZoom: 12, maxNativeZoom: 16, attribution: "Basemap © Esri, HERE, Garmin, OSM" }).addTo(map);
  map.createPane("radar"); map.getPane("radar").style.zIndex = 350;
  map.createPane("labels"); map.getPane("labels").style.zIndex = 380; map.getPane("labels").style.pointerEvents = "none";
  L.tileLayer(ESRI + "World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}", { maxZoom: 12, maxNativeZoom: 16, pane: "labels", opacity: 0.8 }).addTo(map);
  map.createPane("areas"); map.getPane("areas").style.zIndex = 400;
  map.createPane("route"); map.getPane("route").style.zIndex = 450;
  const canvasPts = L.canvas({ padding: 0.3 });

  // ---------- Radar loop ----------
  const radar = { frames: [], idx: 0, playing: true, timer: null, group: L.layerGroup().addTo(map) };
  async function buildRadar() {
    clearInterval(radar.timer); radar.group.clearLayers(); radar.frames = [];
    if (!settings.layers.radar) { $("#radarTime").textContent = "Radar off"; return; }
    const common = { pane: "radar", opacity: 0, maxZoom: 12, tileSize: 256, updateWhenIdle: true, keepBuffer: 1 };
    if (settings.radar === "rv") {
      try {
        const j = await (await fetch("https://api.rainviewer.com/public/weather-maps.json", { cache: "no-store" })).json();
        for (const f of j.radar.past) radar.frames.push({ t: f.time * 1000, layer: L.tileLayer(`${j.host}${f.path}/256/{z}/{x}/{y}/2/1_1.png`, Object.assign({ maxNativeZoom: 7, attribution: "Radar © RainViewer" }, common)) });
      } catch (e) { toast("RainViewer radar unavailable"); }
    } else {
      // IEM NEXRAD base reflectivity composite: current + 5-min steps back to 50 min
      const now = Date.now(), base = Math.floor(now / 300000) * 300000;
      for (let m = 50; m >= 0; m -= 5) {
        const name = m ? `nexrad-n0q-900913-m${String(m).padStart(2, "0")}m` : "nexrad-n0q-900913";
        radar.frames.push({ t: base - m * 60000, layer: L.tileLayer(`https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/${name}/{z}/{x}/{y}.png?_=${base}`, Object.assign({ maxNativeZoom: 10, attribution: "NEXRAD via IEM" }, common)) });
      }
    }
    radar.frames.forEach((f) => radar.group.addLayer(f.layer));
    radar.idx = radar.frames.length - 1; showFrame();
    if (radar.playing) startLoop();
  }
  function showFrame() {
    radar.frames.forEach((f, i) => f.layer.setOpacity(i === radar.idx ? 0.7 : 0));
    const f = radar.frames[radar.idx];
    if (f) $("#radarTime").textContent = `Radar ${fmtTime(f.t)} (${zulu(f.t)})${radar.idx === radar.frames.length - 1 ? " • latest" : ""}`;
  }
  function startLoop() {
    clearInterval(radar.timer);
    radar.timer = setInterval(() => {
      radar.idx = (radar.idx + 1) % radar.frames.length;
      showFrame();
      if (radar.idx === radar.frames.length - 1) { clearInterval(radar.timer); setTimeout(() => radar.playing && startLoop(), 1200); }
    }, 450);
  }
  $("#playBtn").onclick = () => {
    radar.playing = !radar.playing; $("#playBtn").textContent = radar.playing ? "⏸" : "▶";
    if (radar.playing) startLoop(); else { clearInterval(radar.timer); radar.idx = radar.frames.length - 1; showFrame(); }
  };

  // ---------- Weather data (snapshot published next to the app every ~10 min) ----------
  const wx = { metar: [], metarIdx: {}, taf: {}, pirep: [], sigmet: [], isigmet: [], gairmet: [], status: null };
  const layers = { conv: L.layerGroup(), sigmet: L.layerGroup(), gairmet: L.layerGroup(), pirep: L.layerGroup(), metar: L.layerGroup() };
  async function getJSON(u) { const r = await fetch(u, { cache: "no-cache" }); if (!r.ok) throw new Error(u + " " + r.status); return r.json(); }
  async function loadWx() {
    const names = ["metar", "taf", "pirep", "sigmet", "isigmet", "gairmet", "status"];
    const res = await Promise.allSettled(names.map((n) => getJSON(`data/${n}.json`)));
    res.forEach((r, i) => { if (r.status === "fulfilled") wx[names[i]] = r.value; });
    wx.metarIdx = Object.fromEntries((wx.metar || []).map((m) => [m[0], m]));
    drawWx(); updateAge();
    if (current.points) analyze(current, false);
  }
  function updateAge() {
    const u = wx.status && wx.status.updated;
    if (!u) { $("#dataAge").textContent = "Wx data: unavailable"; return; }
    const mins = Math.round((Date.now() - Date.parse(u)) / 60000);
    $("#dataAge").textContent = `Wx data ${fmtTime(u)} (${mins} min ago)`;
    $("#dataAge").style.color = mins > 45 ? "#ffcf66" : "";
  }
  setInterval(updateAge, 60000);
  setInterval(loadWx, 5 * 60000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) { loadWx(); buildRadar(); } });

  const CAT_COL = { VFR: "#3ddc84", MVFR: "#3fa9ff", IFR: "#ff4d4d", LIFR: "#d65cff" };
  const GA_COL = { "TURB-HI": "#ffb02e", "TURB-LO": "#ff8a3d", ICE: "#5ad1ff", IFR: "#c27bff", MT_OBSC: "#c9a36b", LLWS: "#ff5fa2", SFC_WND: "#ffe15a", FZLVL: "#8cf", M_FZLVL: "#8cf" };
  function popupStation(id) {
    const m = wx.metarIdx[id], t = wx.taf[id];
    return `<b>${esc(id)}</b> ${m && m[3] ? `<span class="cat ${m[3]}">${m[3]}</span>` : ""}
      <div class="raw">${esc(m ? m[4] : "No current METAR")}</div>${t ? `<div class="raw">${esc(t[0]).replace(/ (FM\d{6}|BECMG|TEMPO|PROB\d\d)/g, "\n  $1")}</div>` : ""}`;
  }
  function polyPopup(title, alt, raw, extra) {
    return `<b>${esc(title)}</b>${alt ? `<div class="m">${esc(alt)}</div>` : ""}${extra ? `<div class="m">${esc(extra)}</div>` : ""}${raw ? `<div class="raw">${esc(raw)}</div>` : ""}`;
  }
  function drawWx() {
    Object.values(layers).forEach((g) => g.clearLayers());
    for (const s of (wx.sigmet || []).concat(wx.isigmet || [])) {
      if (!s.coords || s.coords.length < 3) continue;
      const conv = s.hazard === "CONVECTIVE";
      const until = s.to ? "Valid until " + zulu(+s.to * 1000) : "";
      L.polygon(s.coords, { pane: "areas", color: conv ? "#ff3b3b" : "#ff9f1a", weight: 2, fillOpacity: conv ? 0.18 : 0.1, dashArray: s.type === "ISIGMET" ? "6 4" : null })
        .bindPopup(polyPopup(`${s.type === "ISIGMET" ? "Intl SIGMET" : conv ? "Convective SIGMET" : s.type} ${s.series || ""} ${conv ? "TS" : s.hazard || ""}`, "", s.raw, until))
        .addTo(conv ? layers.conv : layers.sigmet);
    }
    for (const g of wx.gairmet || []) {
      if (+g.fh !== +settings.gaHour || !settings.ga[g.hazard] || !g.coords || g.coords.length < 2) continue;
      const col = GA_COL[g.hazard] || "#aaa";
      const alt = [g.base, g.top].some(Boolean) ? `${g.base || "SFC"}–${g.top || ""} (hundreds ft)` : g.level ? `Level ${g.level}` : "";
      const opts = { pane: "areas", color: col, weight: 1.5, fillOpacity: 0.07, dashArray: "4 4" };
      const shape = g.geom === "AREA" ? L.polygon(g.coords, opts) : L.polyline(g.coords, opts);
      shape.bindPopup(polyPopup(`G-AIRMET ${g.hazard}${g.sev ? " " + g.sev : ""}`, alt, g.due, "Valid " + fmtTime(g.valid) + " (" + zulu(g.valid) + ")")).addTo(layers.gairmet);
    }
    const zz = map.getZoom();
    for (const r of wx.pirep || []) {
      const s = (r.tb || "") + (r.ic || "");
      const sev = /SEV|EXTRM/.test(s) ? 3 : /MOD/.test(s) ? 2 : /NEG|SMTH|NONE/.test(s) ? 0 : s ? 1 : 0;
      if (zz < 6 && sev < 2) continue; // declutter when zoomed out: only MOD+
      const col = r.ic && !r.tb ? (sev >= 2 ? "#3ab8ff" : "#8fd6ff") : sev === 3 ? "#ff3b3b" : sev === 2 ? "#ffb02e" : sev === 1 ? "#e8e36b" : "#9aa6b2";
      L.circleMarker([r.lat, r.lon], { renderer: canvasPts, radius: sev >= 2 ? 4.5 : sev ? 3.5 : 2.5, color: "#000", weight: 1, fillColor: col, fillOpacity: 0.95 })
        .bindPopup(`<b>${esc(r.type || "PIREP")} ${esc(r.ac)}</b> ${r.alt ? "• " + Math.round(r.alt / 100) * 100 + " ft" : ""}<div class="m">${esc(r.tb ? "Turb " + r.tb : "")} ${esc(r.ic ? "Ice " + r.ic : "")} • ${r.t ? fmtTime(r.t) : ""}</div><div class="raw">${esc(r.raw)}</div>`)
        .addTo(layers.pirep);
    }
    const z = map.getZoom();
    for (const m of wx.metar || []) {
      const col = CAT_COL[m[3]]; if (!col) continue;
      if (z < 6 && m[3] === "VFR") continue; // declutter: only non-VFR when zoomed out
      L.circleMarker([m[1], m[2]], { renderer: canvasPts, radius: z < 6 ? 3 : 4.5, color: "#000", weight: 0.5, fillColor: col, fillOpacity: 0.9 })
        .on("click", (e) => L.popup().setLatLng(e.latlng).setContent(popupStation(m[0])).openOn(map)).addTo(layers.metar);
    }
    applyLayerVis();
  }
  let lastZ = map.getZoom();
  map.on("zoomend", () => { const z = map.getZoom(); if ((z < 6) !== (lastZ < 6)) drawWx(); lastZ = z; });
  function applyLayerVis() {
    for (const [k, g] of Object.entries(layers)) { if (settings.layers[k]) g.addTo(map); else g.remove(); }
  }

  // ---------- Nav data + route ----------
  let parser = null, navMeta = null;
  async function loadNav() {
    if (parser) return parser;
    toast("Loading FAA nav data…", 6000);
    const [points, airways, procs, meta] = await Promise.all(["points", "airways", "procs", "meta"].map((n) => getJSON(`nav/${n}.json`)));
    navMeta = meta; parser = new RouteLib.RouteParser({ points, airways, procs });
    $("#navInfo").textContent = `Nav data: FAA NASR cycle ${meta.nasr_cycle} (${meta.counts.points.toLocaleString()} points, ${meta.counts.airways} airways, ${meta.counts.sids} SIDs, ${meta.counts.stars} STARs).`;
    $("#toast").classList.add("hidden");
    return parser;
  }
  const routeLayer = L.layerGroup().addTo(map);
  let current = {};
  function drawRoute(pts) {
    routeLayer.clearLayers();
    if (!pts.length) return;
    const ll = pts.map((p) => [p.lat, p.lon]);
    L.polyline(ll, { pane: "route", color: "#000", weight: 7, opacity: 0.6 }).addTo(routeLayer);
    L.polyline(ll, { pane: "route", color: "#ff2fd0", weight: 3.5 }).addTo(routeLayer);
    pts.forEach((p, i) => {
      const end = i === 0 || i === pts.length - 1;
      L.circleMarker([p.lat, p.lon], { pane: "route", radius: end ? 6 : 3, color: "#fff", weight: 1.5, fillColor: end ? "#ff2fd0" : "#fff", fillOpacity: 1 })
        .bindTooltip(p.id, { permanent: end || pts.length < 18, direction: "right", className: "wpt", offset: [6, 0], opacity: 1 })
        .on("click", () => { if (p.kind === "A") L.popup().setLatLng([p.lat, p.lon]).setContent(popupStation(icaoOf(p.id))).openOn(map); })
        .addTo(routeLayer);
    });
    map.fitBounds(L.latLngBounds(ll).pad(0.15), { paddingTopLeft: [10, 120], paddingBottomRight: [10, 80] });
  }
  const icaoOf = (id) => (wx.metarIdx[id] || wx.taf[id] ? id : id.length === 3 && (wx.metarIdx["K" + id] || wx.taf["K" + id]) ? "K" + id : id);

  async function runRoute(text, opts = {}) {
    text = text.trim(); if (!text) return;
    await loadNav();
    const r = parser.parse(text);
    if (r.points.length < 1) { toast("Couldn't find any of those points."); return; }
    current = { text, label: opts.label || "", points: r.points, unresolved: r.unresolved, notes: (opts.notes || []).concat(r.notes), extraHtml: opts.extraHtml || "" };
    drawRoute(r.points); analyze(current, true);
    addRecent(text, opts.label); location.hash = "r=" + encodeURIComponent(text);
  }
  function runPoints(points, meta) {
    current = Object.assign({ points, unresolved: [], notes: [] }, meta);
    drawRoute(points); analyze(current, true);
  }

  function analyze(cur, open) {
    const b = Hazards.brief(cur.points, wx, { corridorNm: +settings.corridor, pirepNm: +settings.pirepNm, fh: +settings.gaHour });
    const ids = cur.points.map((p) => p.id);
    const title = `${ids[0]} → ${ids[ids.length - 1]} • ${Math.round(b.totalNm)} nm • ${b.areas.length} advisories • ${b.pireps.filter((p) => p.score >= 2).length} MOD+ PIREPs`;
    $("#sheetTitle").textContent = title;
    let h = "";
    if (cur.extraHtml) h += cur.extraHtml;
    h += `<div class="small">Route: ${esc(ids.join(" "))}</div>`;
    if (cur.unresolved && cur.unresolved.length) h += `<div class="warn">Not found / skipped: ${esc(cur.unresolved.join(", "))} (line connects the points it could find)</div>`;
    (cur.notes || []).forEach((n) => (h += `<div class="warn">${esc(n)}</div>`));
    const stn = (lbl, s) => s ? `<div class="item"><div class="h">${lbl} ${esc(s.id)} ${s.cat ? `<span class="cat ${s.cat}">${s.cat}</span>` : ""}</div><div class="raw">${esc(s.metar || "No METAR")}</div>${s.taf ? `<div class="raw">${esc(s.taf).replace(/ (FM\d{6}|BECMG|TEMPO|PROB\d\d)/g, "\n  $1")}</div>` : ""}</div>` : "";
    h += `<div class="sec">Departure / Destination</div>` + stn("DEP", b.dep) + stn("ARR", b.dest);
    h += `<div class="sec">Advisories within ${settings.corridor} nm of route${+settings.gaHour ? ` (G-AIRMET +${settings.gaHour} h)` : ""}</div>`;
    if (!b.areas.length) h += `<div class="small">None found.</div>`;
    b.areas.forEach((a) => {
      h += `<div class="item sev${a.sev}"><div class="h">${esc(a.title)}</div><div class="m">${a.alt ? esc(a.alt) + " • " : ""}nm ${Math.round(a.from)}–${Math.round(a.to)} along route${a.to && a.kind !== "G-AIRMET" && +a.to ? "" : ""}</div>${a.raw ? `<details><summary class="m">Text</summary><div class="raw">${esc(a.raw)}</div></details>` : ""}</div>`;
    });
    h += `<div class="sec">PIREPs within ${settings.pirepNm} nm (${b.pireps.length})</div>`;
    if (!b.pireps.length) h += `<div class="small">None reported.</div>`;
    b.pireps.slice(0, 40).forEach((p) => {
      h += `<div class="item sev${p.score >= 3 ? 3 : p.score >= 2 ? 2 : p.score ? 1 : 0}"><div class="h">${esc(p.ac || "")} ${p.alt ? Math.round(p.alt / 100) * 100 + " ft" : ""} ${p.tb ? "• Turb " + esc(p.tb) : ""} ${p.ic ? "• Ice " + esc(p.ic) : ""}</div><div class="m">nm ${Math.round(p.along)} along, ${Math.round(p.off)} nm off • ${p.t ? fmtTime(p.t) : ""}</div><div class="raw">${esc(p.raw)}</div></div>`;
    });
    if (b.enroute.length) {
      h += `<div class="sec">IFR/LIFR airports near route</div><div class="small">${b.enroute.map((e) => `<span class="cat ${e.cat}">${e.cat}</span> ${esc(e.id)}`).join(" &nbsp; ")}</div>`;
    }
    h += `<p class="small">Data: aviationweather.gov snapshot ${wx.status ? fmtTime(wx.status.updated) : "?"}. For situational awareness only — not a substitute for your release/dispatch.</p>`;
    $("#sheetBody").innerHTML = h;
    if (open) $("#sheet").classList.remove("collapsed");
  }
  $("#sheetHandle").onclick = () => $("#sheet").classList.toggle("collapsed");

  // ---------- Recent ----------
  const getRecent = () => JSON.parse(localStorage.getItem(LS + "recent") || "[]");
  function addRecent(route, label) {
    const r = getRecent().filter((x) => x.route !== route);
    r.unshift({ route, label: label || "", ts: Date.now() });
    localStorage.setItem(LS + "recent", JSON.stringify(r.slice(0, 20)));
  }
  function showRecent() {
    const r = getRecent();
    $("#recentList").innerHTML = r.length ? r.map((x, i) => `<div class="item recent" data-i="${i}"><div><div class="h">${esc(x.label || x.route.split(/\s+/)[0] + " → " + x.route.split(/\s+/).pop())}</div><div class="r">${esc(x.route)}</div><div class="m">${new Date(x.ts).toLocaleString()}</div></div><button data-del="${i}">✕</button></div>`).join("") : `<div class="small">No saved routes yet.</div>`;
    $("#recentPanel").classList.remove("hidden");
  }
  $("#recentList").onclick = (e) => {
    const del = e.target.closest("[data-del]");
    const r = getRecent();
    if (del) { r.splice(+del.dataset.del, 1); localStorage.setItem(LS + "recent", JSON.stringify(r)); showRecent(); return; }
    const it = e.target.closest("[data-i]"); if (!it) return;
    const x = r[+it.dataset.i]; $("#routeIn").value = x.route; $("#recentPanel").classList.add("hidden"); runRoute(x.route, { label: x.label });
  };
  $("#recentBtn").onclick = showRecent;
  $("#clearRecent").onclick = () => { localStorage.removeItem(LS + "recent"); toast("Recent routes cleared"); };

  // ---------- Forms ----------
  $("#routeForm").onsubmit = (e) => { e.preventDefault(); $("#routeIn").blur(); runRoute($("#routeIn").value).catch((err) => toast(err.message)); };
  $("#fltForm").onsubmit = async (e) => {
    e.preventDefault(); $("#fltIn").blur();
    const raw = $("#fltIn").value.trim(); if (!raw) return;
    const ident = AeroAPI.normIdent(raw);
    const faLink = `<a href="https://www.flightaware.com/live/flight/${encodeURIComponent(ident)}" target="_blank" rel="noopener">Open ${esc(ident)} on FlightAware</a>`;
    if (!settings.faKey || !settings.proxy) {
      $("#sheetTitle").textContent = `${ident}: flight lookup needs setup`;
      $("#sheetBody").innerHTML = `<div class="item"><div class="h">Flight-number lookup isn't set up yet</div><div class="m">It needs a FlightAware AeroAPI key and a small CORS proxy (FlightAware blocks direct calls from web pages). Add both in Settings ⚙.</div><p>For now: ${faLink}, copy the filed route, and paste it in the route box.</p></div>`;
      $("#sheet").classList.remove("collapsed"); return;
    }
    toast("Looking up " + ident + "…", 8000);
    try {
      const r = await AeroAPI.lookup(ident, { key: settings.faKey, proxy: settings.proxy });
      const f = r.flight, o = f.origin?.code_icao || f.origin?.code, d = f.destination?.code_icao || f.destination?.code;
      const when = f.scheduled_out ? new Date(f.scheduled_out).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
      const extra = `<div class="item"><div class="h">${esc(ident)} ${esc(o)}→${esc(d)} • ${esc(when)} • ${esc(f.status || "")}</div><div class="m">${r.filed ? "Filed route" : "Route"}: <span class="raw">${esc(r.routeText || (r.fixes || []).map((x) => x.name).join(" ") || "—")}</span></div>${r.note ? `<div class="warn">${esc(r.note)}</div>` : ""}<div class="m">${faLink}</div></div>`;
      toast("Got " + ident);
      const label = `${ident} ${o}→${d}`;
      if (r.fixes && r.fixes.length && !r.fromPrior) {
        await loadNav();
        const pts = r.fixes.map((x) => ({ id: x.name, lat: x.latitude, lon: x.longitude, kind: x.type === "Origin" || x.type === "Destination" ? "A" : "F" }));
        const ap = (c) => { const p = parser.pick(c, null, true); return p ? { id: c, lat: p[0], lon: p[1], kind: "A" } : null; };
        if (o && pts[0].id !== o && ap(o)) pts.unshift(ap(o));
        if (d && pts[pts.length - 1].id !== d && ap(d)) pts.push(ap(d));
        const text = `${o} ${pts.slice(1, -1).map((p) => p.id).join(" ")} ${d}`.replace(/\s+/g, " ");
        addRecent(text, label);
        runPoints(pts, { text, label, extraHtml: extra });
      } else if (r.routeText) {
        await runRoute(`${o} ${r.routeText} ${d}`, { label, extraHtml: extra });
      } else {
        await runRoute(`${o} ${d}`, { label, extraHtml: extra, notes: [r.note || "No route available; showing direct line."] });
      }
    } catch (err) {
      $("#sheetTitle").textContent = `${ident}: lookup failed`;
      $("#sheetBody").innerHTML = `<div class="item"><div class="warn">${esc(err.message)}</div><p>${faLink} and paste the route instead.</p></div>`;
      $("#sheet").classList.remove("collapsed");
    }
  };

  // ---------- Panels ----------
  document.querySelectorAll(".panel .close").forEach((b) => (b.onclick = () => b.closest(".panel").classList.add("hidden")));
  $("#layersBtn").onclick = () => { $("#settingsPanel").classList.add("hidden"); $("#layersPanel").classList.toggle("hidden"); };
  $("#setBtn").onclick = () => { $("#layersPanel").classList.add("hidden"); $("#settingsPanel").classList.toggle("hidden"); loadNav().catch(() => {}); };
  document.querySelectorAll("[data-layer]").forEach((cb) => {
    cb.checked = !!settings.layers[cb.dataset.layer];
    cb.onchange = () => { settings.layers[cb.dataset.layer] = cb.checked ? 1 : 0; save(); if (cb.dataset.layer === "radar") buildRadar(); else applyLayerVis(); };
  });
  document.querySelectorAll("[data-ga]").forEach((cb) => {
    cb.checked = !!settings.ga[cb.dataset.ga];
    cb.onchange = () => { settings.ga[cb.dataset.ga] = cb.checked ? 1 : 0; save(); drawWx(); };
  });
  const bind = (sel, key, after) => { const el = $(sel); el.value = settings[key]; el.onchange = () => { settings[key] = el.value.trim(); save(); after && after(); }; };
  bind("#gaHour", "gaHour", () => { drawWx(); if (current.points) analyze(current, false); });
  bind("#radarSrc", "radar", buildRadar);
  bind("#corridor", "corridor", () => current.points && analyze(current, false));
  bind("#pirepNm", "pirepNm", () => current.points && analyze(current, false));
  bind("#faKey", "faKey"); bind("#proxy", "proxy");

  $("#locBtn").onclick = () => {
    if (!navigator.geolocation) return toast("Location not available");
    navigator.geolocation.getCurrentPosition((p) => { map.setView([p.coords.latitude, p.coords.longitude], 8); L.circleMarker([p.coords.latitude, p.coords.longitude], { radius: 6, color: "#fff", fillColor: "#3fa9ff", fillOpacity: 1 }).addTo(map); }, () => toast("Couldn't get location"));
  };

  // ---------- Boot ----------
  buildRadar(); loadWx();
  const m = location.hash.match(/r=([^&]+)/);
  if (m) { const t = decodeURIComponent(m[1]); $("#routeIn").value = t; runRoute(t).catch((e) => toast(e.message)); }
  if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js");
  window.__routewx = { runRoute, wx, get current() { return current; } }; // for testing
})();
