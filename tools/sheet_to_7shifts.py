"""Turn the HCC Roster Sheet's service tabs into public/sheet-shifts.json for the 7shifts sync.

Input folder holds the Sheet's values as JSON (header row included):
  sunam.json, sunpm.json, wedpm.json  [Team, Role, "Sun 22-Nov", ...] wide grids
  cleanup.json                        ["Sat 21-Nov-2026", "Suresh & Jayanth"] rows
Only names are copied. Rows before FROM are left out.
Usage: python3 -I tools/sheet_to_7shifts.py <folder> public/sheet-shifts.json 2026-11-16
"""
import json, re, sys, os
from datetime import date, datetime

TEAMS = {"Song Service", "Media", "Welcome", "Ushers", "Accounting", "Altar Workers", "Kids", "Facilities", "Cleanup"}
SERVICES = {  # from the Sheet's Services tab: call = Prayer, time = Start
    "Sun AM": {"call": "10:00 AM", "time": "11:00 AM", "name": "Sunday Morning"},
    "Sun PM": {"call": "6:00 PM", "time": "7:00 PM", "name": "Sunday Evening"},
    "Wed PM": {"call": "7:00 PM", "time": "8:00 PM", "name": "Wednesday Evening"},
    "Sat Cleanup": {"call": "9:00 PM", "time": "9:00 PM", "name": "Saturday Cleanup"},
}

def role_name(r):
    r = r.strip()
    return r if re.fullmatch(r"Guitar \d", r) else re.sub(r"\s+\d+$", "", r)

def day(label, today):
    d = datetime.strptime(label.split(" ", 1)[1] + f"-{today.year}", "%d-%b-%Y").date()
    return d.replace(year=d.year + 1) if (today - d).days > 180 else d

def grid(rows, svc, today):
    head, out, team = rows[0], [], None
    for r in rows[1:]:
        if len(r) < 2 or not r[1].strip(): continue
        if r[0].strip() in TEAMS: team = r[0].strip()
        for i, cell in enumerate(r[2:], start=2):
            if cell.strip(): out.append([day(head[i], today).isoformat(), svc, team, role_name(r[1]), cell.strip()])
    return out

def main(folder, out, frm):
    frm = date.fromisoformat(frm)
    load = lambda f: json.load(open(os.path.join(folder, f)))
    rows = grid(load("sunam.json"), "Sun AM", frm) + grid(load("sunpm.json"), "Sun PM", frm) + grid(load("wedpm.json"), "Wed PM", frm)
    for d, names in load("cleanup.json"):
        iso = datetime.strptime(d.split(" ", 1)[1], "%d-%b-%Y").date().isoformat()
        for n in re.split(r"\s*(?:&|,| and )\s*", names):
            if n.strip(): rows.append([iso, "Sat Cleanup", "Cleanup", "Cleanup", n.strip()])
    rows = sorted((r for r in rows if r[0] >= frm.isoformat()), key=lambda r: (r[0], list(SERVICES).index(r[1])))
    json.dump({"source": f"Google Sheet, read {frm.isoformat()}", "services": SERVICES, "schedule": rows}, open(out, "w"), indent=1, ensure_ascii=False)
    print(f"{len(rows)} shifts, {rows[0][0]} to {rows[-1][0]}")

if __name__ == "__main__":
    main(*sys.argv[1:4])
