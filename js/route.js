// Route string parser. Resolves airports, navaids, fixes, lat/lon, airways (J/Q/V/T…),
// SIDs and STARs (FAA NASR) into an ordered list of points.
(function (root) {
  const Geo = typeof module !== "undefined" ? require("./geo.js") : root.Geo;

  function cleanTokens(str) {
    return str.toUpperCase()
      .replace(/[\r\n\t,]+/g, " ")
      .split(/\s+/)
      .filter(Boolean)
      .flatMap((t) => {
        t = t.replace(/^-+|-+$/g, "");
        if (/^(DCT|DIRECT|IFR|VFR|\.\.)$/.test(t)) return [];
        if (/^[NMK]\d{3,4}([FAMS]\d{3,4})?$/.test(t)) return []; // speed/level e.g. N0450F350
        t = t.replace(/\/.*$/, "");                               // KDFW/0130, ELP/N0450F360
        if (!t) return [];
        return t.split(".").filter(Boolean); // KDFW.AKUNA9.ABI..INK..TUS.SUNSS8.KPHX
      });
  }

  function parseLatLon(t) {
    let m = t.match(/^(\d{2})(\d{2})?([NS])(\d{3})(\d{2})?([EW])$/);
    if (m) {
      let lat = +m[1] + (m[2] ? +m[2] / 60 : 0), lon = +m[4] + (m[5] ? +m[5] / 60 : 0);
      if (m[3] === "S") lat = -lat; if (m[6] === "W") lon = -lon;
      return [lat, lon];
    }
    m = t.match(/^(\d{2})(\d{2})?(\d{2})(\d{2})?$/); // ARINC-ish 4/8 digit not supported reliably
    return null;
  }

  class RouteParser {
    constructor(nav) {
      this.points = nav.points; this.airways = nav.airways;
      this.sid = (nav.procs && nav.procs.sid) || {}; this.star = (nav.procs && nav.procs.star) || {};
    }
    candidates(id, preferAirport) {
      let c = this.points[id] || [];
      if (!preferAirport) {
        const nonAp = c.filter((x) => x[2] !== "A");
        if (nonAp.length) return nonAp;
      }
      if (preferAirport) {
        const ap = c.filter((x) => x[2] === "A");
        if (ap.length) return ap;
        if (/^[A-Z0-9]{3}$/.test(id) && this.points["K" + id]) return this.points["K" + id].filter((x) => x[2] === "A");
      }
      return c;
    }
    pick(id, near, preferAirport) {
      const c = this.candidates(id, preferAirport);
      if (!c.length) return null;
      if (!near || c.length === 1) return c[0];
      let best = c[0], bd = Infinity;
      for (const x of c) { const d = Geo.distNm(near, x); if (d < bd) { bd = d; best = x; } }
      return best;
    }
    isAirway(t) { return /^[A-Z]{1,2}\d{1,4}$/.test(t) && !!this.airways[t]; }
    isSid(t) { return /^[A-Z]{3,6}\d$/.test(t) && !!this.sid[t]; }
    isStar(t) { return /^[A-Z]{3,6}\d$/.test(t) && !!this.star[t]; }

    airwaySlice(awy, fromId, toId, near) {
      const seqs = this.airways[awy] || [];
      let best = null;
      for (const seq of seqs) {
        const i = seq.findIndex((p) => p[0] === fromId), j = seq.findIndex((p) => p[0] === toId);
        if (i < 0 || j < 0) continue;
        const d = near ? Geo.distNm(near, [seq[i][1], seq[i][2]]) : 0;
        if (!best || d < best.d) best = { seq, i, j, d };
      }
      if (!best) return null;
      const { seq, i, j } = best;
      const s = i <= j ? seq.slice(i, j + 1) : seq.slice(j, i + 1).reverse();
      return s.map((p) => ({ id: p[0], lat: p[1], lon: p[2], via: awy }));
    }

    parse(str) {
      const toks = cleanTokens(str);
      const out = [], unresolved = [], notes = [];
      if (!toks.length) return { points: out, unresolved, notes, tokens: toks };
      // anchor: destination airport if resolvable
      const last = toks[toks.length - 1];
      const destP = this.pick(last, null, true);
      let prev = null;
      const push = (id, p, kind, via) => {
        const q = { id, lat: p[0], lon: p[1], kind, via };
        const lp = out[out.length - 1];
        if (lp && lp.id === id && Geo.distNm([lp.lat, lp.lon], [q.lat, q.lon]) < 15) return;
        out.push(q); prev = [q.lat, q.lon];
      };
      for (let k = 0; k < toks.length; k++) {
        let t = toks[k];
        const next = toks[k + 1];
        const isEnd = k === 0 || k === toks.length - 1;
        if (isEnd) {
          const p = this.pick(t, prev || destP, true);
          if (p) { push(t, p, "A"); continue; }
        }
        const ll = parseLatLon(t);
        if (ll) { push(t, ll, "LL"); continue; }
        if (this.isSid(t) && out.length <= 1) {
          this.expandSid(t, next && !this.isAirway(next) ? next : null, push, notes, () => prev);
          continue;
        }
        if (this.isStar(t) && k >= toks.length - 3) {
          const prevId = out.length ? out[out.length - 1].id : null;
          this.expandStar(t, prevId, push, notes, () => prev);
          continue;
        }
        if (this.isAirway(t)) {
          const fromId = out.length ? out[out.length - 1].id : null;
          if (fromId && next) {
            const seg = this.airwaySlice(t, fromId, next, prev);
            if (seg && seg.length) {
              seg.slice(1, -1).forEach((p) => push(p.id, [p.lat, p.lon], "AWY", t));
              continue;
            }
          }
          unresolved.push(t); notes.push(`${t}: couldn't find ${fromId || "?"}→${next || "?"} on this airway; connected the points directly.`);
          continue;
        }
        const p = this.pick(t, prev || destP, false);
        if (p) { push(t, p, p[2]); continue; }
        if (/^[A-Z]{3,6}\d[A-Z]?$/.test(t)) notes.push(`${t}: procedure not in FAA data (skipped).`);
        unresolved.push(t);
      }
      return { points: out, unresolved, notes, tokens: toks };
    }
    expandSid(name, trans, push, notes, getPrev) {
      const d = this.sid[name];
      (d.b || []).forEach((p) => push(p[0], [p[1], p[2]], "SID", name));
      if (trans && d.t[trans]) d.t[trans].forEach((p) => push(p[0], [p[1], p[2]], "SID", name));
      else if (trans) notes.push(`${name}: no "${trans}" transition found; drew the common route only.`);
    }
    expandStar(name, trans, push, notes, getPrev) {
      const d = this.star[name];
      if (trans && d.t[trans]) d.t[trans].forEach((p) => push(p[0], [p[1], p[2]], "STAR", name));
      (d.b || []).forEach((p) => push(p[0], [p[1], p[2]], "STAR", name));
    }
  }
  const api = { RouteParser, cleanTokens, parseLatLon };
  if (typeof module !== "undefined") module.exports = api; else root.RouteLib = api;
})(this);
