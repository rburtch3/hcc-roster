# HCC Roster

The HCC volunteer roster app. `public/index.html` is the whole app; `src/worker.js` saves one shared copy of the roster in Cloudflare KV at `/api/state`.

## 7shifts sync

`/7shifts.html` copies a week into 7shifts as unpublished (draft) shifts through the 7shifts API; nothing is published or sent. The shifts come from `public/sheet-shifts.json`, made from the Roster Sheet with `tools/sheet_to_7shifts.py`. The Worker needs the Cloudflare secret `SEVENSHIFTS_TOKEN`; company and location ids are in `wrangler.jsonc`.

## Sign in with HCC Hub

HCC Hub (`https://hub.hyderabadchristiancenter.com`, Firebase project `HUB_PROJECT_ID`) signs people
in with Google or SMS. Its Roster tile POSTs the Firebase ID token (form field `idToken`) to
`/auth/hub`. `src/hub.js` checks it against Google's keys (audience and issuer are the Hub's
project) and reads the Hub's claim `hub = { rota: 'admin' | 'leader' | 'member', rotaTeams }`. Roster
then sets its own signed cookie `roster_session` for 14 days (`SESSION_SECRET` if set, else a key
kept in the Durable Object).

- **Who they are in Roster**: a saved link (Hub uid to Roster name, `hubLinks`), else the one person
  whose saved phone (last 10 digits) or email matches what Firebase verified. No match, or a shared
  number: they pick their name once (`POST /api/me`); a name already linked can't be picked.
- **Roles come from the Hub**: `admin` opens Admin without the leader PIN; `leader` leads their
  `rotaTeams` (matched to Roster's team names, any case) in the team leader view; `member` is a
  volunteer. A linked person's availability and emergency contact can only be changed by them or
  an admin, like a volunteer PIN.
- **Teams and positions stay in Roster** (who is on which team, which positions they fill).
- `GET /api/me`, `POST /auth/signout`. The leader PIN and name list still work during the switch.

## People from HCC Hub

`POST /hub/people` (Bearer Google ID token from the Hub's functions account
`575810669504-compute@developer.gserviceaccount.com`, audience `hcc-roster-people`; `src/hubpeople.js`).
Body `{ hubId, name, whatsapp, phone, email, role, teams, status: active | removed | deleted }`. The person
is found by Hub ID (`hubPeople` in the store), else phone (last 10 digits), else email, else exact name;
names are never changed. Their phone and email go to Roster's contacts, which Hub sign-in matches on.
Someone new and active is added to the people list with no team; removed or deleted people are marked,
not deleted. Answers `{ ok, action: linked | created | updated | deactivated | unchanged, name }`.
`GET /hub/teams`: `{ teams }` A to Z, for the Hub's team-leader boxes. Leaders are set in HCC Hub.

## Install on a phone

Roster is an installable web app: `public/manifest.webmanifest`, icons (`icon-192.png`, `icon-512.png`,
`icon-maskable-512.png`, `apple-touch-icon.png`) and `public/sw.js` (network first, so a deploy never strands
a phone on an old copy; the last good copy opens offline; `/api`, `/auth`, `/hub` are never cached). The
sign-in screen and More show "Get the Roster app" (Android's install prompt, or the Home Screen steps on
iPhone). An installed app keeps its own cookies apart from the phone's browser, where HCC Hub signs people
in, so in the app "Sign in with HCC Hub" opens `/auth/hub?n=<random>` in the browser: that browser keeps `n`
in a cookie (`roster_nonce`, SameSite=None, 15 minutes) through the Hub round trip, the POST back saves the
new session under `n` for 10 minutes and shows "You're signed in, go back to the app", and the app collects
it once from `GET /api/handoff?n=`.
