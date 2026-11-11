// Route hazard briefing: which SIGMETs / G-AIRMETs touch the route corridor,
// PIREPs near the route, and METAR/TAF at departure & destination.
(function (root) {
  const Geo = typeof module !== "undefined" ? require("./geo.js") : root.Geo;

  const GA_NAMES = {
    "TURB-HI": "Turbulence (high)", "TURB-LO": "Turbulence (low)", LLWS: "Low-level wind shear",
    SFC_WND: "Strong surface winds", ICE: "Icing", FZLVL: "Freezing level", M_FZLVL: "Multiple freezing levels",
    IFR: "IFR (ceiling/vis)", MT_OBSC: "Mountain obscuration",
  };
  function fl(v) {
    if (v == null || v === "") return null;
    if (v === "SFC" || v === "FZL") return v;
    const n = +v; if (isNaN(n)) return String(v);
    return n >= 180 ? "FL" + String(n).padStart(3, "0") : (n * 100).toLocaleString() + " ft";
  }
  function ft(v) { // feet (SIGMET altitudes)
    if (v == null || v === "" || v === "None") return null;
    const n = +v; if (isNaN(n)) return null;
    return n === 0 ? "SFC" : n >= 18000 ? "FL" + String(Math.round(n / 100)).padStart(3, "0") : n.toLocaleString() + " ft";
  }
  function altRange(lo, hi) { lo = lo || "SFC"; return hi ? `${lo}–${hi}` : lo === "SFC" ? "" : `${lo}+`; }

  function areaHit(samples, poly, corridorNm) {
    if (!poly || poly.length < 3) return null;
    const closed = poly.concat([poly[0]]);
    let first = null, last = null;
    for (const s of samples) {
      const hit = Geo.pointInPoly(s.p, poly) || Geo.distToPolyline(s.p, closed) <= corridorNm;
      if (hit) { if (first == null) first = s.d; last = s.d; }
    }
    return first == null ? null : { from: first, to: last };
  }

  function describeSigmet(s) {
    const conv = s.hazard === "CONVECTIVE";
    const kind = s.type === "ISIGMET" ? "Intl SIGMET" : conv ? "Convective SIGMET" : s.type === "AIRMET" ? "AIRMET" : "SIGMET";
    return { kind, sev: conv ? 3 : 2, hazard: (s.hazard || "").replace(/_/g, " "),
      title: `${kind} ${s.series || ""} – ${conv ? "Thunderstorms" : (s.hazard || "")}`.trim(),
      alt: altRange(ft(s.lo), ft(s.hi)), raw: s.raw || "", to: s.to };
  }
  function describeGairmet(g) {
    const name = GA_NAMES[g.hazard] || g.hazard;
    let alt = "";
    if (g.hazard === "ICE" || g.hazard.startsWith("TURB") || g.hazard === "M_FZLVL") alt = altRange(fl(g.base), fl(g.top));
    if (g.hazard === "ICE" && g.base === "FZL" && g.fzlbase) alt = `FZL (${fl(g.fzlbase)}–${fl(g.fzltop)})–${fl(g.top)}`;
    return { kind: "G-AIRMET", sev: g.hazard.startsWith("TURB") || g.hazard === "ICE" || g.hazard === "LLWS" ? 2 : 1,
      hazard: g.hazard, title: `G-AIRMET ${name}${g.sev ? " " + g.sev : ""}`, alt, raw: g.due || "", valid: g.valid };
  }

  function brief(routePts, wx, opt = {}) {
    const corridor = opt.corridorNm ?? 25, pirepNm = opt.pirepNm ?? 50, fh = opt.fh ?? 0;
    const pts = routePts.map((p) => [p.lat, p.lon]);
    const samples = Geo.densify(pts, 5);
    const total = samples.length ? samples[samples.length - 1].d : 0;
    const areas = [];
    for (const s of (wx.sigmet || []).concat(wx.isigmet || [])) {
      const h = areaHit(samples, s.coords, corridor);
      if (h) areas.push(Object.assign(describeSigmet(s), h));
    }
    for (const g of wx.gairmet || []) {
      if (+g.fh !== +fh || g.geom !== "AREA") continue;
      const h = areaHit(samples, g.coords, corridor);
      if (h) areas.push(Object.assign(describeGairmet(g), h));
    }
    areas.sort((a, b) => b.sev - a.sev || a.from - b.from);

    const pireps = [];
    for (const r of wx.pirep || []) {
      const p = [r.lat, r.lon];
      // quick bbox reject
      let best = Infinity, along = 0;
      for (const s of samples) {
        if (Math.abs(s.p[0] - p[0]) > 2 || Math.abs(s.p[1] - p[1]) > 3) continue;
        const d = Geo.distNm(s.p, p); if (d < best) { best = d; along = s.d; }
      }
      if (best <= pirepNm) pireps.push(Object.assign({ off: best, along }, r));
    }
    const score = (r) => (/SEV|EXTRM/.test(r.tb + r.ic) ? 3 : /MOD/.test(r.tb + r.ic) ? 2 : r.tb || r.ic ? 1 : 0);
    pireps.forEach((r) => (r.score = score(r)));
    pireps.sort((a, b) => b.score - a.score || a.along - b.along);

    const station = (id) => {
      if (!id) return null;
      const m = (wx.metarIdx || {})[id], t = (wx.taf || {})[id];
      return { id, cat: m ? m[3] : "", metar: m ? m[4] : null, taf: t ? t[0] : null };
    };
    const first = routePts[0], last = routePts[routePts.length - 1];
    const enroute = [];
    if (wx.metar && samples.length > 2) {
      for (const m of wx.metar) {
        if (m[3] !== "IFR" && m[3] !== "LIFR") continue;
        let best = Infinity, along = 0;
        for (const s of samples) {
          if (Math.abs(s.p[0] - m[1]) > 1 || Math.abs(s.p[1] - m[2]) > 1.5) continue;
          const d = Geo.distNm(s.p, [m[1], m[2]]); if (d < best) { best = d; along = s.d; }
        }
        if (best <= 20 && along > 30 && along < total - 30) enroute.push({ id: m[0], cat: m[3], along, raw: m[4] });
      }
      enroute.sort((a, b) => a.along - b.along);
    }
    return { totalNm: total, areas, pireps, enroute,
      dep: first && first.kind === "A" ? station(icao(first.id, wx)) : null,
      dest: last && last.kind === "A" && routePts.length > 1 ? station(icao(last.id, wx)) : null };
  }
  function icao(id, wx) {
    const idx = wx.metarIdx || {}, taf = wx.taf || {};
    if (idx[id] || taf[id]) return id;
    if (id.length === 3 && (idx["K" + id] || taf["K" + id])) return "K" + id;
    return id;
  }
  const api = { brief, areaHit };
  if (typeof module !== "undefined") module.exports = api; else root.Hazards = api;
})(this);
