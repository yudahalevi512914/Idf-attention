import { put, list, del } from "@vercel/blob";
import PDFDocument from "pdfkit";

const token = process.env.BLOB_READ_WRITE_TOKEN || Object.entries(process.env).find(([k, v]) => /READ_WRITE_TOKEN$/.test(k) && v)?.[1];
const ADMIN_PIN = process.env.ADMIN_PIN || "1234";
const LIST = "attendance/list/", ACT = "attendance/activity/", ARC = "attendance/archive/", DEV = "attendance/dev/";
const okDev = d => /^[\w-]{16,64}$/.test(d || "");
const norm = n => String(n || "").trim().replace(/\s+/g, " ").replace(/[׳’`]/g, "'");
const dayOf = ms => new Date(ms).toLocaleDateString("en-CA", { timeZone: "Asia/Jerusalem" });
const b64 = s => Buffer.from(s).toString("base64url");
const unb64 = s => Buffer.from(s, "base64url").toString();
const clean = a => (Array.isArray(a) ? a.slice(0, 300).map(x => String(x).slice(0, 80)) : []);

async function listAll(prefix) {
  const out = []; let cursor;
  do {
    const r = await list({ prefix, limit: 1000, cursor, token });
    out.push(...r.blobs); cursor = r.hasMore ? r.cursor : undefined;
  } while (cursor);
  return out;
}
async function putAny(path, body) {
  const o = { token, addRandomSuffix: false, allowOverwrite: true };
  try { return await put(path, body, { ...o, access: "public" }); }
  catch (e) { if (!/private/i.test(String(e?.message))) throw e; return put(path, body, { ...o, access: "private" }); }
}
async function clearPrefix(prefix) {
  const all = await listAll(prefix);
  if (all.length) await del(all.map(b => b.url), { token });
}
async function getActivity() {
  const a = await listAll(ACT);
  return a.length ? unb64(a[0].pathname.slice(ACT.length)) : "";
}
// keeps only today and yesterday
async function purge() {
  const keep = dayOf(Date.now() - 24 * 3600e3);
  const old = (await listAll(ARC)).filter(b => b.pathname.slice(ARC.length).split("/")[0] < keep);
  if (old.length) await del(old.map(b => b.url), { token });
}


const FONT = "https://raw.githubusercontent.com/google/fonts/main/ofl/alef/Alef-Regular.ttf";
const BOLD = "https://raw.githubusercontent.com/google/fonts/main/ofl/alef/Alef-Bold.ttf";
let fonts;
async function getFonts() {
  if (fonts) return fonts;
  const get = async u => Buffer.from(await (await fetch(u)).arrayBuffer());
  fonts = await Promise.all([get(FONT), get(BOLD)]);
  return fonts;
}
async function buildPdf({ dateLabel, reports, timeOf }) {
  const [reg, bold] = await getFonts();
  const doc = new PDFDocument({ size: "A4", margin: 50, font: reg });
  doc.registerFont("B", bold);
  const chunks = []; doc.on("data", c => chunks.push(c));
  const done = new Promise(r => doc.on("end", () => r(Buffer.concat(chunks))));
  const W = doc.page.width - 100;
  // word-by-word RTL layout (keeps spaces intact; each word is shaped by fontkit)
  const right = (t, size, f = "B") => {
    doc.font(f === "B" ? "B" : reg).fontSize(size);
    const words = String(t).replace(/\u200F/g, "").split(/\s+/).filter(Boolean);
    const gap = size * 0.32, y = doc.y;
    let x = 50 + W;
    for (const w of words) { x -= doc.widthOfString(w); doc.text(w, x, y, { lineBreak: false }); x -= gap; }
    doc.x = 50; doc.y = y + size * 1.4;
  };
  const need = h => { if (doc.y + h > doc.page.height - 60) doc.addPage(); };

  right("יודה נוכחות – סיכום חוסרים", 22);
  doc.fillColor("#666"); right(`${dateLabel}\u200F  |  פעילויות:\u200F ${reports.length}`, 12, "R"); doc.fillColor("#000");
  doc.moveDown(0.6);

  if (!reports.length) right("לא נשמרו פעילויות ביום הזה.", 14, "R");
  reports.forEach(r => {
    need(70 + Math.min(r.missing.length, 3) * 18);
    doc.moveTo(50, doc.y).lineTo(50 + W, doc.y).strokeColor("#1e8a5a").lineWidth(1.5).stroke();
    doc.moveDown(0.5);
    doc.fillColor("#000"); right(`${r.activity}\u200F  –  ${timeOf(r.t)}`, 16);
    doc.fillColor("#555"); right(`הגיעו:\u200F ${r.present.length}  |  חסרים:\u200F ${r.missing.length}`, 12, "R"); doc.fillColor("#000");
    doc.moveDown(0.3);
    if (!r.missing.length) right("כולם הגיעו", 13, "R");
    r.missing.forEach(n => { need(20); right("•  " + n, 13, "R"); });
    doc.moveDown(0.8);
  });
  doc.end();
  return done;
}

export default async function handler(req, res) {
  try {
    if (req.method === "POST") {
      const b = req.body || {};
      if (b.action === "activity" || b.action === "reset" || b.action === "remove") {
        if (b.pin !== ADMIN_PIN) return res.status(401).json({ error: "unauthorized" });
        if (b.action === "remove") {
          const n = norm(b.name), key = b64(n);
          await del((await listAll(LIST + key)).filter(x => x.pathname === LIST + key).map(x => x.url), { token }).catch(() => {});
          const devs = (await listAll(DEV)).filter(x => x.pathname.endsWith("/" + key));
          if (devs.length) await del(devs.map(x => x.url), { token });
          return res.json({ ok: true });
        }
        if (b.action === "activity") {
          const a = norm(b.activity).slice(0, 60);
          await clearPrefix(ACT);
          if (a) await putAny(ACT + b64(a), "1");
          return res.json({ ok: true, activity: a });
        }
        const now = Date.now();
        const activity = (await getActivity()) || "ללא שם";
        await putAny(`${ARC}${dayOf(now)}/${now}`, JSON.stringify({ activity, t: now, present: clean(b.present), missing: clean(b.missing), extra: clean(b.extra) }));
        await clearPrefix(LIST);
        await clearPrefix(DEV);
        await clearPrefix(ACT);
        await purge();
        return res.json({ ok: true });
      }
      const name = norm(b.name);
      if (name.length < 2 || name.length > 60) return res.status(400).json({ error: "bad name" });
      if (!okDev(b.dev)) return res.status(400).json({ error: "bad device" });
      const prev = await list({ prefix: `${DEV}${b.dev}/`, token });
      if (prev.blobs.length) return res.status(409).json({ error: "already", name: unb64(prev.blobs[0].pathname.split("/").pop()) });
      await putAny(LIST + b64(name), "1");
      await putAny(`${DEV}${b.dev}/${b64(name)}`, "1");
      return res.json({ ok: true });
    }

    const { name, pin, report } = req.query;
    if (report !== undefined) {
      if (pin !== ADMIN_PIN) return res.status(401).json({ error: "unauthorized" });
      const now = Date.now(), date = dayOf(now);
      const blobs = await listAll(`${ARC}${date}/`);
      const reports = (await Promise.all(blobs.map(x => fetch(x.url).then(r => r.json()).catch(() => null)))).filter(Boolean).sort((a, c) => a.t - c.t);
      await purge();
      if (!reports.length) return res.json({ empty: true });
      const dateLabel = new Date(now).toLocaleDateString("he-IL", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Jerusalem" });
      const timeOf = t => new Date(t).toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Jerusalem" });
      const pdf = await buildPdf({ dateLabel, reports, timeOf });
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="attendance-${date}.pdf"`);
      return res.end(pdf);
    }
    if (name !== undefined) {
      const activity = await getActivity();
      let deviceName = "";
      if (okDev(req.query.dev)) {
        const d = await list({ prefix: `${DEV}${req.query.dev}/`, token });
        if (d.blobs.length) deviceName = unb64(d.blobs[0].pathname.split("/").pop());
      }
      if (!name) return res.json({ present: false, activity, deviceName });
      const p = LIST + b64(norm(name));
      const { blobs } = await list({ prefix: p, token });
      return res.json({ present: blobs.some(x => x.pathname === p), activity, deviceName });
    }
    if (pin !== ADMIN_PIN) return res.status(401).json({ error: "unauthorized" });
    const blobs = await listAll(LIST);
    return res.json({
      activity: await getActivity(),
      list: blobs.map(x => ({ name: unb64(x.pathname.slice(LIST.length)), t: new Date(x.uploadedAt).getTime() })),
    });
  } catch (e) {
    console.error(e);
    const m = String(e?.message || e);
    return res.status(500).json({ error: "server", detail: !token ? "no_blob_token" : m.slice(0, 200) });
  }
}
