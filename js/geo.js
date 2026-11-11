// Small geodesy helpers (nautical miles). Works in browser (window.Geo) and node (module.exports).
(function (root) {
  const R_NM = 3440.065;
  const rad = (d) => (d * Math.PI) / 180;
  function distNm(a, b) {
    const dLat = rad(b[0] - a[0]), dLon = rad(b[1] - a[1]);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLon / 2) ** 2;
    return 2 * R_NM * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  // local planar projection around a reference latitude (nm)
  function proj(p, lat0) { return [p[1] * 60 * Math.cos(rad(lat0)), p[0] * 60]; }
  function segDistNm(p, a, b) {
    const lat0 = p[0];
    const P = proj(p, lat0), A = proj(a, lat0), B = proj(b, lat0);
    let dx = B[0] - A[0], dy = B[1] - A[1];
    let t = dx || dy ? ((P[0] - A[0]) * dx + (P[1] - A[1]) * dy) / (dx * dx + dy * dy) : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(P[0] - (A[0] + t * dx), P[1] - (A[1] + t * dy));
  }
  function pointInPoly(p, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const yi = poly[i][0], xi = poly[i][1], yj = poly[j][0], xj = poly[j][1];
      if (yi > p[0] !== yj > p[0] && p[1] < ((xj - xi) * (p[0] - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  function distToPolyline(p, line) {
    if (line.length === 1) return distNm(p, line[0]);
    let m = Infinity;
    for (let i = 0; i < line.length - 1; i++) m = Math.min(m, segDistNm(p, line[i], line[i + 1]));
    return m;
  }
  // densify a route to samples every stepNm, each with cumulative distance
  function densify(pts, stepNm = 10) {
    const out = [];
    let cum = 0;
    for (let i = 0; i < pts.length; i++) {
      if (i === 0) { out.push({ p: pts[0], d: 0 }); continue; }
      const a = pts[i - 1], b = pts[i], L = distNm(a, b);
      const n = Math.max(1, Math.ceil(L / stepNm));
      for (let k = 1; k <= n; k++) {
        const t = k / n;
        out.push({ p: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], d: cum + L * t });
      }
      cum += L;
    }
    return out;
  }
  const api = { distNm, segDistNm, pointInPoly, distToPolyline, densify };
  if (typeof module !== "undefined") module.exports = api; else root.Geo = api;
})(this);
