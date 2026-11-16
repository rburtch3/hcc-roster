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
