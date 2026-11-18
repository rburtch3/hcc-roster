# Roster WhatsApp bridge

A small Node program that links a WhatsApp number with [Baileys](https://baileys.wiki) so Roster can send serve
times and reminders. It runs on a computer that stays on. It cannot run inside the Cloudflare Worker.

Baileys is an unofficial WhatsApp client. WhatsApp's terms do not allow it and can ban the number. Use a spare
SIM, never the church's main number. The plan is to move 1:1 messages to the official WhatsApp Cloud API later;
the bridge is kept behind a small interface so that swap does not touch Roster.

## Step 1: link test (`spike.js`)

Needs Node 20 or newer and a spare phone with WhatsApp on the spare SIM.

    cd wa-bridge
    npm install
    node spike.js

1. Scan the QR from the spare phone: WhatsApp > Settings > Linked devices > Link a device.
2. It prints `LINKED as ...` and the groups that number is in.
3. From your own phone, send the spare number `ping`. It prints an `IN {...}` line and replies `pong`.
4. Add the spare number to a test group, run `node spike.js` again to see the group's id, then:

       node spike.js send <group id> "Roster test post"

5. To a person: `node spike.js send 919848012345 "Roster test"` (country code, no +).

The link is saved in `wa-bridge/auth/` (not committed). Delete that folder to link again.

What to report back: did it link, the `IN {...}` line from the ping, and whether the group post arrived.
