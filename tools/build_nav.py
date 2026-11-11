#!/usr/bin/env python3
"""Build compact navigation datasets (airports, navaids, fixes, airways, SIDs, STARs)
from the FAA NASR 28-day subscription CSVs + OurAirports (non-US airports).
Output: nav/points.json, nav/airways.json, nav/procs.json, nav/meta.json
Usage: python3 tools/build_nav.py [workdir]
"""
import csv, io, json, math, os, re, sys, urllib.request, zipfile, datetime

UA = {"User-Agent": "route-wx/1.0 (github.com/F16RAT/route-wx)"}
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "nav")
WORK = sys.argv[1] if len(sys.argv) > 1 else "/tmp/nasr_build"
os.makedirs(WORK, exist_ok=True); os.makedirs(OUT, exist_ok=True)

def get(url):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.read()

def current_cycle():
    html = get("https://www.faa.gov/air_traffic/flight_info/aeronav/aero_data/NASR_Subscription/").decode("utf-8", "ignore")
    dates = sorted(set(re.findall(r"NASR_Subscription/(\d{4}-\d{2}-\d{2})", html)))
    today = datetime.date.today().isoformat()
    past = [d for d in dates if d <= today]
    return past[-1] if past else dates[0]

MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"]
def nasr_csv(cycle, group):
    y, m, d = cycle.split("-")
    name = f"{d}_{MON[int(m)-1]}_{y}_{group}_CSV.zip"
    path = os.path.join(WORK, name)
    if not os.path.exists(path):
        with open(path, "wb") as f:
            f.write(get(f"https://nfdc.faa.gov/webContent/28DaySub/extra/{name}"))
    return zipfile.ZipFile(path)

def rows(z, fname):
    with z.open(fname) as f:
        yield from csv.DictReader(io.TextIOWrapper(f, encoding="latin-1"))

def r4(x): return round(float(x), 4)

points = {}  # id -> list of [lat, lon, type]
def add(pid, lat, lon, typ):
    pid = pid.strip().upper()
    if not pid: return
    lst = points.setdefault(pid, [])
    for p in lst:
        if abs(p[0]-lat) < 0.01 and abs(p[1]-lon) < 0.01: return
    lst.append([lat, lon, typ])

cycle = current_cycle()
print("NASR cycle", cycle)

# Airports (NASR)
z = nasr_csv(cycle, "APT")
for r in rows(z, "APT_BASE.csv"):
    if r["SITE_TYPE_CODE"] not in ("A",): continue
    try: lat, lon = r4(r["LAT_DECIMAL"]), r4(r["LONG_DECIMAL"])
    except ValueError: continue
    if r["ICAO_ID"]: add(r["ICAO_ID"], lat, lon, "A")
    add(r["ARPT_ID"], lat, lon, "A")

# Non-US airports (OurAirports), large/medium with an ICAO-style ident
oa = get("https://davidmegginson.github.io/ourairports-data/airports.csv").decode("utf-8")
for r in csv.DictReader(io.StringIO(oa)):
    if r["iso_country"] == "US": continue
    if r["type"] not in ("large_airport", "medium_airport"): continue
    code = r["icao_code"] or r["gps_code"] or r["ident"]
    if not re.fullmatch(r"[A-Z]{4}", code or ""): continue
    add(code, r4(r["latitude_deg"]), r4(r["longitude_deg"]), "A")

# Navaids
z = nasr_csv(cycle, "NAV")
for r in rows(z, "NAV_BASE.csv"):
    if r["NAV_TYPE"] in ("VOT", "FAN MARKER", "MARINE NDB"): continue
    try: add(r["NAV_ID"], r4(r["LAT_DECIMAL"]), r4(r["LONG_DECIMAL"]), "V" if "VOR" in r["NAV_TYPE"] or "TACAN" in r["NAV_TYPE"] else "N")
    except ValueError: pass

# Fixes
z = nasr_csv(cycle, "FIX")
for r in rows(z, "FIX_BASE.csv"):
    try: add(r["FIX_ID"], r4(r["LAT_DECIMAL"]), r4(r["LONG_DECIMAL"]), "F")
    except ValueError: pass

def dist(a, b):
    la = math.radians((a[0]+b[0])/2)
    return math.hypot(a[0]-b[0], (a[1]-b[1])*math.cos(la))

def resolve(pid, near):
    c = points.get(pid.strip().upper())
    if not c: return None
    if near is None or len(c) == 1:
        # prefer navaid/fix inside CONUS-ish bbox
        return c[0]
    return min(c, key=lambda p: dist(p, near))

def seq_points(ids, anchor=None):
    out, prev = [], anchor
    # if no anchor, find the first id with a unique candidate to anchor on
    if prev is None:
        for i in ids:
            c = points.get(i)
            if c and len(c) == 1: prev = c[0]; break
    for i in ids:
        p = resolve(i, prev)
        if p: out.append([i, p[0], p[1]]); prev = p
    return out

# Airways
z = nasr_csv(cycle, "AWY")
aw = {}
for r in rows(z, "AWY_SEG_ALT.csv"):
    key = (r["AWY_ID"].strip(), r["AWY_LOCATION"].strip())
    aw.setdefault(key, []).append((int(r["POINT_SEQ"]), r["FROM_POINT"].strip()))
airways = {}
for (aid, loc), lst in aw.items():
    lst.sort()
    ids = [p for _, p in lst]
    airways.setdefault(aid, []).append(seq_points(ids))

# Procedures
def procs(group, fname, is_sid):
    z = nasr_csv(cycle, group)
    routes = {}  # (name, portion, routename/trans) -> [(seq, point)]
    for r in rows(z, fname):
        code = r["DP_COMPUTER_CODE"] if is_sid else r["STAR_COMPUTER_CODE"]
        if "." not in code: continue
        a, b = code.split(".", 1)
        name = a if is_sid else b
        portion = r["ROUTE_PORTION_TYPE"]
        tcode = r["TRANSITION_COMPUTER_CODE"]
        if portion == "TRANSITION" and tcode and "." in tcode:
            t1, t2 = tcode.split(".", 1)
            tkey = t2 if is_sid else t1
        else:
            tkey = None
        k = (name, portion, tkey or r["ROUTE_NAME"])
        routes.setdefault(k, []).append((int(r["POINT_SEQ"]), r["POINT"].strip()))
    out = {}
    for (name, portion, key), lst in routes.items():
        lst.sort(); ids = [p for _, p in lst if p]
        d = out.setdefault(name, {"b": None, "t": {}})
        pts = seq_points(ids)
        if portion == "BODY":
            if d["b"] is None or (len(pts) and len(pts) < len(d["b"])): d["b"] = pts
        else:
            d["t"][key] = pts
    for d in out.values():
        if d["b"] is None: d["b"] = []
    return out

sids = procs("DP", "DP_RTE.csv", True)
stars = procs("STAR", "STAR_RTE.csv", False)

def dump(name, obj):
    with open(os.path.join(OUT, name), "w") as f:
        json.dump(obj, f, separators=(",", ":"))
    print(name, os.path.getsize(os.path.join(OUT, name)))

dump("points.json", points)
dump("airways.json", airways)
dump("procs.json", {"sid": sids, "star": stars})
dump("meta.json", {"nasr_cycle": cycle, "built": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                   "counts": {"points": len(points), "airways": len(airways), "sids": len(sids), "stars": len(stars)}})
