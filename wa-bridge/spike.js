// Step 1 of the WhatsApp agent: a link test. It answers one question before anything is built on it:
// can a spare WhatsApp number be linked with Baileys, receive a message, reply, and post to a group?
//
//   node spike.js                              link (scan the QR), list groups, log incoming messages
//   node spike.js send 919848012345 "hello"    send one message to a number (country code, no +), then stop
//   node spike.js send 1203...@g.us "hello"    send one message to a group (id from the list), then stop
//
// Use a spare SIM. Never the church's main number: WhatsApp can ban a number that uses an unofficial client.
// It replies only to a direct message that says "ping". It messages no one on its own.
import makeWASocket, { DisconnectReason, useMultiFileAuthState, Browsers, isJidGroup } from "@whiskeysockets/baileys";
import qrcode from "qrcode-terminal";
import P from "pino";

const [cmd, target, ...words] = process.argv.slice(2);
const sendOnce = cmd === "send" && target && words.length ? { to: target, text: words.join(" ") } : null;
if (cmd && !sendOnce) { console.log('Usage: node spike.js   |   node spike.js send <number or group id> "text"'); process.exit(1); }

const logger = P({ level: "silent" }); // Baileys' own log is noisy; this script prints what matters
const sent = new Map(); // messages this run sent, so WhatsApp can ask for one again
let tries = 0;

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState("./auth"); // the link is kept in ./auth; delete the folder to link again
  const sock = makeWASocket({
    auth: state, logger, browser: Browsers.macOS("Roster test"),
    markOnlineOnConnect: false, syncFullHistory: false,
    getMessage: async (key) => sent.get(key.id),
  });
  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
    if (qr) { console.log("\nOn the spare phone: WhatsApp > Settings > Linked devices > Link a device, then scan:\n"); qrcode.generate(qr, { small: true }); }
    if (connection === "open") {
      tries = 0;
      console.log("\nLINKED as", sock.user && sock.user.id);
      const groups = Object.values(await sock.groupFetchAllParticipating());
      console.log(groups.length ? "\nGroups this number is in:" : "\nThis number is in no groups yet.");
      for (const g of groups) console.log("  " + g.subject + "  |  " + g.id + "  |  " + g.participants.length + " people");
      if (sendOnce) {
        let jid = sendOnce.to;
        if (/^\d+$/.test(jid)) { // a phone number: ask WhatsApp for its address first
          const [hit] = (await sock.onWhatsApp(jid)) || [];
          if (!hit || !hit.exists) { console.log("\nNOT ON WHATSAPP:", jid); process.exit(2); }
          jid = hit.jid;
        }
        const m = await sock.sendMessage(jid, { text: sendOnce.text });
        if (m && m.key.id) sent.set(m.key.id, m.message);
        console.log("\nSENT to", jid, "id", m && m.key.id, "\nWaiting 15 s for delivery, then stopping.");
        setTimeout(() => process.exit(0), 15000);
      } else console.log('\nListening. From another phone, send this number "ping". Ctrl+C to stop.\n');
    }
    if (connection === "close") {
      const code = lastDisconnect && lastDisconnect.error && lastDisconnect.error.output && lastDisconnect.error.output.statusCode;
      if (code === DisconnectReason.loggedOut) { console.log("\nLOGGED OUT by WhatsApp (401). Delete the ./auth folder and run again to link."); process.exit(3); }
      if (code === DisconnectReason.restartRequired) return start(); // normal right after the QR is scanned
      if (++tries > 5) { console.log("\nGAVE UP after 5 tries. Last close code:", code, lastDisconnect && lastDisconnect.error && lastDisconnect.error.message); process.exit(4); }
      console.log("closed (code " + code + "), trying again in " + tries * 3 + " s");
      setTimeout(start, tries * 3000);
    }
  });

  sock.ev.on("messages.update", (ups) => { for (const u of ups) if (u.key.fromMe && u.update.status != null) console.log("DELIVERY", u.key.id, "status", u.update.status, "(2 sent, 3 delivered, 4 read)"); });

  sock.ev.on("messages.upsert", async ({ type, messages }) => {
    if (type !== "notify") return; // old messages arriving after the link are not new ones
    for (const m of messages) {
      const jid = m.key.remoteJid; if (!jid || m.key.fromMe) continue;
      const text = (m.message && (m.message.conversation || (m.message.extendedTextMessage && m.message.extendedTextMessage.text))) || "";
      // these are the fields Roster will use to work out who is writing
      console.log("IN", JSON.stringify({ group: isJidGroup(jid), remoteJid: jid, remoteJidAlt: m.key.remoteJidAlt, participant: m.key.participant, participantAlt: m.key.participantAlt, name: m.pushName, text: text.slice(0, 80) }));
      if (!isJidGroup(jid) && /^\s*ping\s*$/i.test(text)) {
        const r = await sock.sendMessage(jid, { text: "pong from the Roster test" }, { quoted: m });
        if (r && r.key.id) sent.set(r.key.id, r.message);
        console.log("REPLIED pong, id", r && r.key.id);
      }
    }
  });
}
start().catch((e) => { console.error("FAILED to start:", e && e.message); process.exit(1); });
