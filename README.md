# HCC Roster

The HCC volunteer roster app. `public/index.html` is the whole app; `src/worker.js` saves one shared copy of the roster in Cloudflare KV at `/api/state`.

## 7shifts sync

`/7shifts.html` copies a week into 7shifts as unpublished (draft) shifts through the 7shifts API; nothing is published or sent. The shifts come from `public/sheet-shifts.json`, made from the Roster Sheet with `tools/sheet_to_7shifts.py`. The Worker needs the Cloudflare secret `SEVENSHIFTS_TOKEN`; company and location ids are in `wrangler.jsonc`.
