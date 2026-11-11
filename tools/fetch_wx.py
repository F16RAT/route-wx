#!/usr/bin/env python3
"""Snapshot aviation weather from aviationweather.gov into data/*.json.
aviationweather.gov does not send CORS headers, so a browser app on another
origin cannot read it directly. GitHub Actions runs this every ~10 minutes and
publishes the files alongside the app (same origin, no proxy needed)."""
import csv, gzip, io, json, os, sys, time, urllib.request, xml.etree.ElementTree as ET, datetime

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data")
os.makedirs(OUT, exist_ok=True)
UA = {"User-Agent": "route-wx/1.0 (github.com/F16RAT/route-wx)"}
API = "https://aviationweather.gov/api/data"
CACHE = "https://aviationweather.gov/data/cache"
BBOX = (5.0, -180.0, 75.0, -40.0)  # N. America + Caribbean + approaches

def get(url, tries=3):
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=60) as r:
                data = r.read()
            if url.endswith(".gz"): data = gzip.decompress(data)
            return data
        except Exception as e:
            print("retry", url, e, file=sys.stderr); time.sleep(3 * (i + 1))
    raise RuntimeError("failed " + url)

def inb(lat, lon):
    return BBOX[0] <= lat <= BBOX[2] and BBOX[1] <= lon <= BBOX[3]

def f(x):
    try: return float(x)
    except (TypeError, ValueError): return None

def dump(name, obj):
    p = os.path.join(OUT, name)
    with open(p, "w") as fh: json.dump(obj, fh, separators=(",", ":"))
    print(name, os.path.getsize(p))

status = {}
def step(name, fn):
    try: fn(); status[name] = "ok"
    except Exception as e:
        status[name] = "error: %s" % e; print("ERROR", name, e, file=sys.stderr)

def metars():
    rows = csv.reader(io.StringIO(get(CACHE + "/metars.cache.csv.gz").decode("utf-8", "ignore")))
    hdr = None; out = []
    for r in rows:
        if hdr is None:
            if r and r[0] == "raw_text": hdr = r
            continue
        d = dict(zip(hdr, r))
        lat, lon = f(d.get("latitude")), f(d.get("longitude"))
        if lat is None or lon is None or not inb(lat, lon): continue
        out.append([d["station_id"], round(lat, 3), round(lon, 3), d.get("flight_category") or "", d["raw_text"], d.get("observation_time", "")])
    dump("metar.json", out)

def tafs():
    root = ET.fromstring(get(CACHE + "/tafs.cache.xml.gz"))
    out = {}
    for t in root.iter("TAF"):
        lat, lon = f(t.findtext("latitude")), f(t.findtext("longitude"))
        if lat is None or lon is None or not inb(lat, lon): continue
        out[t.findtext("station_id")] = [t.findtext("raw_text"), t.findtext("issue_time")]
    dump("taf.json", out)

def pireps():
    rows = csv.reader(io.StringIO(get(CACHE + "/aircraftreports.cache.csv.gz").decode("utf-8", "ignore")))
    hdr = None; out = []
    for r in rows:
        if hdr is None:
            if r and r[0] == "receipt_time": hdr = r
            continue
        # duplicated column names (sky_cover, turbulence_*, icing_*) -> keep first occurrence via index
        idx = {}
        for i, h in enumerate(hdr): idx.setdefault(h, i)
        g = lambda k: r[idx[k]] if k in idx and idx[k] < len(r) else ""
        lat, lon = f(g("latitude")), f(g("longitude"))
        if lat is None or lon is None or not inb(lat, lon): continue
        out.append({"t": g("observation_time"), "lat": round(lat, 3), "lon": round(lon, 3),
                    "alt": f(g("altitude_ft_msl")), "ac": g("aircraft_ref"),
                    "tb": g("turbulence_intensity"), "ic": g("icing_intensity"),
                    "type": g("report_type"), "raw": g("raw_text")})
    dump("pirep.json", out)

def airsigmet():
    d = json.loads(get(API + "/airsigmet?format=json"))
    out = []
    for s in d:
        out.append({"type": s.get("airSigmetType"), "hazard": s.get("hazard"), "series": s.get("seriesId"),
                    "from": s.get("validTimeFrom"), "to": s.get("validTimeTo"),
                    "lo": s.get("altitudeLow1"), "hi": s.get("altitudeHi1") or s.get("altitudeHi2"),
                    "sev": s.get("severity"), "raw": s.get("rawAirSigmet"),
                    "coords": flat(s.get("coords"))})
    dump("sigmet.json", out)

def flat(cs):
    out = []
    for c in cs or []:
        if isinstance(c, dict): out.append([float(c["lat"]), float(c["lon"])])
        elif isinstance(c, list): out.extend(flat(c))
    return out

def isigmet():
    d = json.loads(get(API + "/isigmet?format=json"))
    out = []
    for s in d:
        cs = flat(s.get("coords"))
        if len(cs) < 3 or not any(inb(a, b) for a, b in cs): continue
        out.append({"type": "ISIGMET", "hazard": s.get("hazard"), "series": s.get("seriesId"), "fir": s.get("firName"),
                    "from": s.get("validTimeFrom"), "to": s.get("validTimeTo"), "lo": s.get("base"), "hi": s.get("top"),
                    "raw": s.get("rawSigmet"), "coords": cs})
    dump("isigmet.json", out)

def gairmet():
    d = []
    for fh in (0, 3, 6):
        d += json.loads(get(API + "/gairmet?format=json&fore=%d" % fh))
    out = []
    for g in d:
        out.append({"hazard": g.get("hazard"), "fh": g.get("forecastHour"), "valid": g.get("validTime"),
                    "geom": g.get("geometryType"), "top": g.get("top"), "base": g.get("base"), "level": g.get("level"),
                    "fzltop": g.get("fzltop"), "fzlbase": g.get("fzlbase"), "sev": g.get("severity"), "due": g.get("due_to"),
                    "coords": flat(g.get("coords"))})
    dump("gairmet.json", out)

for n, fn in [("metar", metars), ("taf", tafs), ("pirep", pireps), ("sigmet", airsigmet), ("isigmet", isigmet), ("gairmet", gairmet)]:
    step(n, fn)
dump("status.json", {"updated": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "sources": status})
if all(v != "ok" for v in status.values()): sys.exit(1)
