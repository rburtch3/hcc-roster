"""Turn the HCC Roster Google Sheet's tabs into public/roster-data.json, the app's starting data.

Input: a JSON file with the Sheet's rows (header row left off):
  people   People!A:H     [name, phone, email, ...]   only the name is used
  roles    Roles!A:H      [service, team, role, count, leader, people, ...]
  services Services!A:E   [service, day, prayer time, service time]
  schedule rows           [date "Sun 15-Nov-2026", service, team, role, person]
Phone numbers and emails are never copied: the data file is readable by anyone with the link.
Usage: python3 -I tools/import_sheet.py sheet.json public/roster-data.json
"""
import json, sys, re
from datetime import datetime
from collections import Counter, OrderedDict

NAMES = {"Sun AM": "Sunday Morning", "Sun PM": "Sunday Evening", "Wed PM": "Wednesday Evening",
         "Sat Cleanup": "Saturday Cleanup", "Mon PM": "Monday Evening", "Tue PM": "Tuesday Evening",
         "Fri PM": "Friday Evening", "Sat PM": "Saturday Evening"}

def iso(d):
    return datetime.strptime(d.split(" ", 1)[1], "%d-%b-%Y").strftime("%Y-%m-%d")

def main(src, out):
    raw = json.load(open(src))
    svcs = OrderedDict()
    for r in raw["services"]:
        if not r or not r[0]: continue
        prayer = r[2] if len(r) > 2 else ""
        start = r[3] if len(r) > 3 else ""
        svcs[r[0]] = {"call": prayer or start, "time": start or prayer, "name": NAMES.get(r[0], r[0])}
    roles, pool, lead = OrderedDict(), OrderedDict(), {}
    for r in raw["roles"]:
        if len(r) < 3 or not r[0]: continue
        sv, team, role = r[0], r[1], r[2]
        n = int(r[3]) if len(r) > 3 and str(r[3]).isdigit() else 1
        roles.setdefault(team, OrderedDict()).setdefault(sv, []).extend([role] * n)
        pool.setdefault(team, [])
        for p in (r[5] if len(r) > 5 else "").split(","):
            p = p.strip()
            if p and p not in pool[team]: pool[team].append(p)
        if len(r) > 4 and r[4]: lead.setdefault(team, Counter())[r[4]] += 1
    rows = []
    for r in raw["schedule"]:
        if len(r) < 4 or not r[0]: continue
        rows.append([iso(r[0]), r[1], r[2], r[3], (r[4].strip() if len(r) > 4 else "")])
        team = r[2]
        roles.setdefault(team, OrderedDict()).setdefault(r[1], [])
        pool.setdefault(team, [])
        if len(r) > 4 and r[4].strip() and r[4].strip() not in pool[team]: pool[team].append(r[4].strip())
    people = [r[0].strip() for r in raw["people"] if r and r[0].strip()]
    data = {
        "source": raw.get("source", "Google Sheet"),
        "services": svcs, "roles": roles, "pool": pool,
        "leaders": {t: c.most_common(1)[0][0] for t, c in lead.items()},
        "people": people, "schedule": sorted(rows, key=lambda x: (x[0], list(svcs).index(x[1]) if x[1] in svcs else 99)),
    }
    json.dump(data, open(out, "w"), indent=1, ensure_ascii=False)
    print(f"{len(people)} people, {len(svcs)} services, {len(roles)} teams, {len(rows)} schedule rows, "
          f"{rows[0][0]} to {rows[-1][0]}")

if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
