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
  const doc = new PDFDocument({ size: "A4", layout: "landscape", margin: 30, font: reg, autoFirstPage: true });
  doc.registerFont("B", bold);
  const chunks = []; doc.on("data", c => chunks.push(c));
  const done = new Promise(r => doc.on("end", () => r(Buffer.concat(chunks))));
  const PW = doc.page.width, PH = doc.page.height, M = 30, R = PW - M, W = PW - 2 * M;
  const NAVY = "#16263a", RED = "#d9541e", GREEN = "#1e8a5a", ZEBRA = "#f5f1e8", LINE = "#d9d2c0";

  // --- text helpers (RTL, word by word) ---
  const wid = (s, size, f) => doc.font(f).fontSize(size).widthOfString(s);
  const rtl = (t, xr, y, size, f = reg, maxW = 1e9) => {
    let words = String(t).split(/\s+/).filter(Boolean);
    const gap = size * 0.32, total = ws => ws.reduce((s, w) => s + wid(w, size, f), 0) + gap * (ws.length - 1);
    if (total(words) > maxW) { let s = words.join(" "); while (s.length > 1 && total((s + ".").split(/\s+/)) > maxW) s = s.slice(0, -1); words = (s + ".").split(/\s+/); }
    doc.font(f).fontSize(size);
    let x = xr; for (const w of words) { x -= wid(w, size, f); doc.text(w, x, y, { lineBreak: false }); x -= gap; }
  };
  const center = (t, xl, w, y, size, f = reg) => { doc.font(f).fontSize(size).text(String(t), xl, y, { width: w, align: "center", lineBreak: false }); };

  // --- data: all names x all activities ---
  const nk = n => String(n).replace(/[׳’`]/g, "'");
  const extras = new Set(reports.flatMap(r => r.extra.map(nk)));
  const disp = new Map();
  reports.forEach(r => r.present.forEach(n => { const k = nk(n); if (!extras.has(k)) disp.set(k, n); }));
  reports.forEach(r => r.missing.forEach(n => disp.set(nk(n), n)));
  const miss = reports.map(r => new Set(r.missing.map(nk)));
  const rows = [...disp].map(([k, n]) => { const abs = miss.map(s => s.has(k)); return { n, abs, total: abs.filter(Boolean).length }; })
    .sort((a, b) => b.total - a.total || a.n.localeCompare(b.n, "he"));
  const N = reports.length, colTot = reports.map((_, j) => rows.filter(r => r.abs[j]).length);
  const grand = rows.reduce((s, r) => s + r.total, 0);

  // --- layout ---
  const nameW = 130, totW = 44, avail = W - nameW - totW;
  const cellW = Math.max(22, Math.min(40, Math.floor(avail / Math.max(N, 1))));
  const perPage = Math.floor(avail / cellW);
  const colChunks = []; for (let i = 0; i < N; i += perPage) colChunks.push([i, Math.min(N, i + perPage)]);
  const rowH = 15, hdrH = 36, titleH = 34, footH = 16;
  const rowsPer = Math.floor((PH - 2 * M - titleH - hdrH - footH) / rowH);
  const rowChunks = []; for (let i = 0; i < Math.max(rows.length, 1); i += rowsPer) rowChunks.push([i, Math.min(rows.length, i + rowsPer)]);
  const totalPages = 1 + colChunks.length * rowChunks.length;

  // --- page 1: summary + legend ---
  doc.fillColor(NAVY); rtl("יודה נוכחות – סיכום חוסרים", R, M, 24, "B");
  doc.fillColor("#666"); rtl(`${dateLabel}  |  פעילויות: ${N}  |  חיילים: ${rows.length}  |  סה״כ חיסורים: ${grand}`, R, M + 34, 12);
  doc.fillColor(NAVY); rtl("מקרא פעילויות", R, M + 64, 15, "B");
  doc.moveTo(M, M + 84).lineTo(R, M + 84).strokeColor(GREEN).lineWidth(1.5).stroke();
  const lc = N > 36 ? 3 : N > 16 ? 2 : 1, per = Math.ceil(N / lc), lw = W / lc, ly = M + 94, lh = 15.5;
  reports.forEach((r, i) => {
    const c = Math.floor(i / per), y = ly + (i % per) * lh, xr = R - c * lw;
    doc.fillColor(RED); rtl(`${i + 1}.`, xr, y, 11, "B");
    doc.fillColor("#222"); rtl(r.activity, xr - 26, y, 11, reg, lw - 90);
    doc.fillColor("#777"); rtl(timeOf(r.t), xr - lw + 60, y, 10);
  });
  doc.fillColor("#777"); rtl(`עמוד 1 מתוך ${totalPages}`, R, PH - M - 12, 9);

  // --- table pages ---
  let page = 1;
  colChunks.forEach(([c0, c1]) => rowChunks.forEach(([r0, r1], ri) => {
    doc.addPage(); page++;
    doc.fillColor(NAVY); rtl("יודה נוכחות – סיכום חוסרים", R, M, 14, "B");
    doc.fillColor("#666"); rtl(`${dateLabel}  |  פעילויות ${c0 + 1} עד ${c1}  |  ממוין לפי מספר חיסורים`, R, M + 18, 9.5);
    rtl(`עמוד ${page} מתוך ${totalPages}`, M + 90, M + 3, 9);
    let y = M + titleH;
    // header
    const tx = R - nameW - totW;
    doc.rect(tx - (c1 - c0) * cellW, y, nameW + totW + (c1 - c0) * cellW, hdrH).fill(NAVY);
    doc.fillColor("#fff"); rtl("שם", R - 8, y + 11, 11, "B"); center("סה״כ", R - nameW - totW, totW, y + 11, 10, "B");
    for (let j = c0; j < c1; j++) {
      const xl = tx - (j - c0 + 1) * cellW;
      doc.fillColor("#fff"); center(j + 1, xl, cellW, y + 5, 11, "B");
      doc.fillColor("#c9d3de"); center(timeOf(reports[j].t), xl, cellW, y + 21, 6.5);
    }
    y += hdrH;
    // body
    for (let i = r0; i < r1; i++, y += rowH) {
      const row = rows[i];
      if ((i - r0) % 2) doc.rect(tx - (c1 - c0) * cellW, y, (c1 - c0) * cellW + totW + nameW, rowH).fill(ZEBRA);
      doc.fillColor("#111"); rtl(row.n, R - 8, y + 3, 10.5, reg, nameW - 14);
      doc.fillColor(row.total ? RED : "#999"); center(row.total || "–", R - nameW - totW, totW, y + 3, 10.5, row.total ? "B" : reg);
      for (let j = c0; j < c1; j++) if (row.abs[j]) {
        const xl = tx - (j - c0 + 1) * cellW;
        doc.rect(xl + 1, y + 1, cellW - 2, rowH - 2).fill(RED);
        doc.moveTo(xl + cellW / 2 - 3, y + 4.5).lineTo(xl + cellW / 2 + 3, y + rowH - 4.5).moveTo(xl + cellW / 2 + 3, y + 4.5).lineTo(xl + cellW / 2 - 3, y + rowH - 4.5).strokeColor("#fff").lineWidth(1.1).stroke();
      }
    }
    // grid
    const top = M + titleH + hdrH, left = tx - (c1 - c0) * cellW;
    doc.strokeColor(LINE).lineWidth(0.4);
    for (let j = 0; j <= c1 - c0; j++) doc.moveTo(tx - j * cellW, top).lineTo(tx - j * cellW, y).stroke();
    doc.moveTo(R - nameW, top).lineTo(R - nameW, y).stroke(); doc.moveTo(R, top).lineTo(R, y).stroke();
    for (let k = 0; k <= r1 - r0; k++) doc.moveTo(left, top + k * rowH).lineTo(R, top + k * rowH).stroke();
    // totals row on the last row page
    if (ri === rowChunks.length - 1) {
      doc.rect(left, y + 2, R - left, footH).fill(NAVY);
      doc.fillColor("#fff"); rtl("חסרים בפעילות", R - 8, y + 5, 10, "B"); center(grand, R - nameW - totW, totW, y + 5, 10, "B");
      for (let j = c0; j < c1; j++) center(colTot[j], tx - (j - c0 + 1) * cellW, cellW, y + 5, 9.5, "B");
    }
  }));
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
