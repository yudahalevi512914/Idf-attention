import { put, list, del } from "@vercel/blob";
import PDFDocument from "pdfkit";

const token = process.env.BLOB_READ_WRITE_TOKEN || Object.entries(process.env).find(([k, v]) => /READ_WRITE_TOKEN$/.test(k) && v)?.[1];
// One PIN per commander account. All four share the same data; only the tracked squad differs.
// Override in production with MANAGER_PINS="a,b,c,d" rather than relying on these defaults.
const PINS = (process.env.MANAGER_PINS || process.env.MANAGER_PIN || "5361,5362,5363,5364").split(",").map(s => s.trim()).filter(Boolean);
const acctOf = pin => { const i = PINS.indexOf(String(pin ?? "")); return i < 0 ? 0 : i + 1; };
const ACCTS = PINS.length;
const P = "manager/data/";
const FINAL = "manager/final/";
const KEEP_DAYS = 7;

async function putAny(path, body, contentType = "application/json") {
  const o = { token, addRandomSuffix: false, allowOverwrite: true, contentType };
  try { return await put(path, body, { ...o, access: "public" }); }
  catch (e) { if (!/private/i.test(String(e?.message))) throw e; return put(path, body, { ...o, access: "private" }); }
}

async function listAll(prefix) {
  const out = []; let cursor;
  do {
    const r = await list({ prefix, limit: 1000, cursor, token });
    out.push(...r.blobs); cursor = r.hasMore ? r.cursor : undefined;
  } while (cursor);
  return out;
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
const s = (v, n) => String(v ?? "").slice(0, n);

// doc = { title, sub, tables: [{ heading, cols: [{h, w}], rows: [[cell,...]] }] }
export async function tablePdf(input) {
  const [reg, bold] = await getFonts();
  const tables = (Array.isArray(input?.tables) ? input.tables : []).slice(0, 20).map(t => ({
    heading: s(t.heading, 100),
    cols: (Array.isArray(t.cols) ? t.cols : []).slice(0, 8).map(c => ({ h: s(c.h, 40), w: Math.max(1, +c.w || 1) })),
    rows: (Array.isArray(t.rows) ? t.rows : []).slice(0, 1000).map(r => (Array.isArray(r) ? r : []).slice(0, 8).map(c => s(c, 600))),
  }));
  const doc = new PDFDocument({ size: "A4", margin: 36, font: reg, bufferPages: true });
  doc.registerFont("B", bold);
  const chunks = []; doc.on("data", c => chunks.push(c));
  const done = new Promise(r => doc.on("end", () => r(Buffer.concat(chunks))));
  const PW = doc.page.width, PH = doc.page.height, M = 36, R = PW - M, W = PW - 2 * M;
  const NAVY = "#16263a", GREEN = "#1e8a5a", ZEBRA = "#f5f1e8", LINE = "#d9d2c0";
  const cw = (t, size, f) => doc.font(f).fontSize(size).widthOfString(t);
  const BR = { "(": ")", ")": "(", "[": "]", "]": "[" };
  // split a word into Hebrew/neutral runs, left-to-right runs (numbers, latin) and brackets
  const segs = w => {
    const out = []; let last = 0;
    w.replace(/[A-Za-z0-9]+(?:[.:\/%-][A-Za-z0-9]+)*|[()\[\]]/g, (m, i) => {
      if (i > last) out.push({ t: w.slice(last, i), k: "h" });
      out.push({ t: m, k: /^[()\[\]]$/.test(m) ? "b" : "l" }); last = i + m.length; return m;
    });
    if (last < w.length) out.push({ t: w.slice(last), k: "h" });
    return out;
  };
  const segW = (g, size, f) => g.k === "h" ? cw(g.t, size, f) : g.k === "b" ? cw(BR[g.t], size, f) : [...g.t].reduce((a, c) => a + cw(c, size, f), 0);
  const wid = (w, size, f) => segs(w).reduce((a, g) => a + segW(g, size, f), 0);
  const gap = size => size * 0.32;
  const wordsW = (ws, size, f) => ws.reduce((a, w) => a + wid(w, size, f), 0) + gap(size) * Math.max(0, ws.length - 1);
  const drawWord = (w, xr, y, size, f) => {
    let x = xr;
    for (const g of segs(w)) {
      x -= segW(g, size, f); doc.font(f).fontSize(size);
      if (g.k === "h") doc.text(g.t, x, y, { lineBreak: false });
      else if (g.k === "b") doc.text(BR[g.t], x, y, { lineBreak: false });
      else { let cx = x; for (const c of g.t) { doc.text(c, cx, y, { lineBreak: false }); cx += cw(c, size, f); } }
    }
    return xr - x;
  };
  const draw = (ws, xr, y, size, f) => { let x = xr; for (const w of ws) { x -= drawWord(w, x, y, size, f); x -= gap(size); } };
  const lines = (t, size, f, maxW) => {
    const out = []; let cur = [];
    const push = () => { if (cur.length) out.push(cur); cur = []; };
    for (let w of String(t).split(/\s+/).filter(Boolean)) {
      while (wid(w, size, f) > maxW && w.length > 1) { // very long word: hard split
        let k = w.length - 1; while (k > 1 && wid(w.slice(0, k), size, f) > maxW) k--;
        push(); out.push([w.slice(0, k)]); w = w.slice(k);
      }
      if (cur.length && wordsW([...cur, w], size, f) > maxW) push();
      cur.push(w);
    }
    push(); return out.length ? out : [[]];
  };
  const text = (t, xr, y, size, f = reg, maxW = W) => lines(t, size, f, maxW).forEach((ws, i) => draw(ws, xr, y + i * size * 1.25, size, f));

  doc.fillColor(NAVY); text(s(input?.title, 120) || "סיכום", R, M, 20, "B");
  doc.fillColor("#666"); text(s(input?.sub, 200), R, M + 28, 11);
  doc.moveTo(M, M + 48).lineTo(R, M + 48).strokeColor(GREEN).lineWidth(1.5).stroke();
  let y = M + 60;
  const FS = 10, LH = 13;
  for (const t of tables) {
    if (y > PH - 120) { doc.addPage(); y = M; }
    doc.fillColor(NAVY); text(`${t.heading} (${t.rows.length})`, R, y, 14, "B"); y += 24;
    if (!t.rows.length || !t.cols.length) { doc.fillColor("#666"); text("אין פריטים.", R, y, 11); y += 26; continue; }
    const tw = t.cols.reduce((a, c) => a + c.w, 0); let xr = R;
    const cols = t.cols.map(c => { const w = (c.w / tw) * W; const o = { ...c, xr, w }; xr -= w; return o; });
    const header = () => {
      doc.rect(M, y, W, 20).fill(NAVY); doc.fillColor("#fff");
      cols.forEach(c => text(c.h, c.xr - 6, y + 5, 10, "B", c.w - 10)); y += 20;
    };
    header();
    t.rows.forEach((row, i) => {
      const cells = cols.map((c, k) => lines(row[k] ?? "", FS, reg, c.w - 12));
      const h = Math.max(...cells.map(l => l.length)) * LH + 8;
      if (y + h > PH - M - 22) { doc.addPage(); y = M; header(); }
      if (i % 2) doc.rect(M, y, W, h).fill(ZEBRA);
      doc.fillColor("#111");
      cols.forEach((c, k) => cells[k].forEach((ws, li) => draw(ws, c.xr - 6, y + 4 + li * LH, FS, reg)));
      doc.moveTo(M, y + h).lineTo(R, y + h).strokeColor(LINE).lineWidth(0.4).stroke();
      y += h;
    });
    y += 22;
  }
  const n = doc.bufferedPageRange().count;
  for (let i = 0; i < n; i++) { doc.switchToPage(i); doc.fillColor("#888"); text(`עמוד ${i + 1} מתוך ${n}`, M + 80, PH - 28, 9); }
  doc.end();
  return done;
}

// ---------- daily commander report ----------
const WAIT = "ממתין לתשובה מרמ״מ";
const CLOSED_ST = ["נסגר", "בוצעה", "סגור", "טופל", "הושלם"];
const isOpenSt = st => !CLOSED_ST.includes(String(st ?? "").trim());
const dayOfMs = t => new Date(t).toLocaleDateString("en-CA", { timeZone: "Asia/Jerusalem" });
const todayIL = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Jerusalem" });
const shiftDay = (d, n) => new Date(new Date(d + "T12:00:00Z").getTime() + n * 864e5).toLocaleDateString("en-CA");
const dayLabel = d => new Date(d + "T09:00:00Z").toLocaleDateString("he-IL", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Jerusalem" });
const hhmm = t => new Date(t).toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Jerusalem" });
const dmy = d => (d ? new Date(d + "T12:00:00Z").toLocaleDateString("he-IL", { day: "numeric", month: "numeric", year: "numeric" }) : "");
const plur = (n, one, many) => (n === 1 ? one : `${n} ${many}`);
const oneLine = t => String(t ?? "").replace(/\s*\n\s*/g, " | ");
// Each account tracks its own squad; `squad` is the pre-accounts shape and is still honoured.
const squadOf = (S, acct) => {
  const m = S?.squads;
  if (m && typeof m === "object") return Array.isArray(m[acct]) ? m[acct] : [];
  return Array.isArray(S?.squad) && acct === 1 ? S.squad : [];
};
const allSquads = S => [...new Set(Array.from({ length: ACCTS }, (_, i) => squadOf(S, i + 1)).flat())];

// Builds the PDF document description for one day: the day's safety / discipline /
// readiness events, the requests opened that day, and anything still waiting on the RMM.
export function buildDailyDoc(data, date, acct = 1) {
  const S = data || {};
  const squad = squadOf(S, acct);
  const inSquad = new Set(squad);
  const soldiers = S.soldiers || {};

  const events = (Array.isArray(S.events) ? S.events : [])
    .filter(e => dayOfMs(e.t) === date && inSquad.has(e.n)).sort((a, b) => a.t - b.t);

  const todayLogs = [], waiting = [];
  squad.forEach(n => ((soldiers[n] || {}).log || []).forEach(l => {
    const row = { n, l };
    if (dayOfMs(l.t) === date) todayLogs.push(row);
    else if (String(l.st || "").trim() === WAIT) waiting.push(row);
  }));
  const byTime = (a, b) => a.l.t - b.l.t;
  todayLogs.sort(byTime); waiting.sort(byTime);

  const logCols = [{ h: "חייל", w: 2.4 }, { h: "סוג", w: 2 }, { h: "שעה", w: 1.2 }, { h: "סטטוס", w: 2.2 }, { h: "פירוט", w: 6 }];
  const logRow = ({ n, l }) => [n, l.type || "", hhmm(l.t), l.st || "", oneLine(l.text)];
  const waitCols = [{ h: "חייל", w: 2.4 }, { h: "סוג", w: 2 }, { h: "נפתח", w: 1.6 }, { h: "פירוט", w: 6 }];

  const tables = [
    {
      heading: "אירועי בטיחות, משמעת ופערי כוננות",
      cols: [{ h: "חייל", w: 2.4 }, { h: "סוג", w: 2 }, { h: "שעה", w: 1.2 }, { h: "פירוט", w: 6 }],
      rows: events.map(e => [e.n || "", e.kind || "", hhmm(e.t), oneLine(e.text)]),
    },
    { heading: "פניות ובקשות שנפתחו היום", cols: logCols, rows: todayLogs.map(logRow) },
    {
      heading: "ממתינות להחלטת רמ״מ מימים קודמים",
      cols: waitCols,
      rows: waiting.map(({ n, l }) => [n, l.type || "", dmy(dayOfMs(l.t)), oneLine(l.text)]),
    },
  ];

  const open = squad.reduce((a, n) => a + ((soldiers[n] || {}).log || []).filter(l => isOpenSt(l.st)).length, 0);
  return {
    title: "דוח יומי – לוח מפקד",
    sub: `${dayLabel(date)} · ${plur(events.length, "אירוע אחד", "אירועים")} · ${plur(todayLogs.length, "פנייה חדשה אחת", "פניות חדשות")} · ${plur(waiting.length, "אחת ממתינה לרמ״מ", "ממתינות לרמ״מ")} · ${open} פתוחות בסך הכל`,
    tables,
  };
}

async function readState() {
  const blobs = (await listAll(P)).sort((a, b) => (a.pathname < b.pathname ? 1 : -1));
  if (!blobs.length) return { data: null, blobs };
  const data = await fetch(blobs[0].url).then(r => r.json()).catch(() => null);
  return { data, blobs };
}

// Every day that has ended gets one stored PDF (kept KEEP_DAYS days); its events are
// then dropped from the live state so the commander board only ever shows today.
async function finalizeManagerDays() {
  const { data, blobs } = await readState();
  if (!data) return { days: [] };
  const today = todayIL();
  const eventDays = [...new Set((Array.isArray(data.events) ? data.events : []).map(e => dayOfMs(e.t)))];
  const days = [...new Set([shiftDay(today, -1), ...eventDays])].filter(d => d < today).sort();

  for (const d of days) {
    for (let a = 1; a <= ACCTS; a++) {
      if (!squadOf(data, a).length) continue;
      const pdf = await tablePdf(buildDailyDoc(data, d, a));
      await putAny(`${FINAL}${d}-a${a}.pdf`, pdf, "application/pdf");
    }
  }

  const kept = (Array.isArray(data.events) ? data.events : []).filter(e => dayOfMs(e.t) >= today);
  if (kept.length !== (data.events || []).length) {
    data.events = kept;
    data.rev = (Number(data.rev) || 0) + 1;
    await putAny(`${P}${Date.now()}.json`, JSON.stringify(data));
    if (blobs.length) await del(blobs.map(b => b.url), { token });
  }

  const keepFrom = shiftDay(today, -(KEEP_DAYS - 1));
  const old = (await listAll(FINAL)).filter(b => b.pathname.slice(FINAL.length, FINAL.length + 10) < keepFrom);
  if (old.length) await del(old.map(b => b.url), { token });
  return { days };
}

export default async function handler(req, res) {
  try {
    if (req.query.cron !== undefined) {
      const sec = process.env.CRON_SECRET;
      if (sec && req.headers.authorization !== `Bearer ${sec}`) return res.status(401).json({ error: "unauthorized" });
      const r = await finalizeManagerDays();
      return res.json({ ok: true, ...r });
    }
    const pin = req.method === "POST" ? req.body?.pin : req.query.pin;
    const acct = acctOf(pin);
    if (!acct) return res.status(401).json({ error: "unauthorized" });
    if (req.method === "POST" && req.body?.action === "pdf") {
      const pdf = await tablePdf(req.body.doc);
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", 'attachment; filename="summary.pdf"');
      return res.end(pdf);
    }
    // on-demand daily report, built from the stored state so it never lags the client
    if (req.method === "POST" && req.body?.action === "daily") {
      const date = /^\d{4}-\d{2}-\d{2}$/.test(req.body.date || "") ? req.body.date : todayIL();
      const { data } = await readState();
      const pdf = await tablePdf(buildDailyDoc(data, date, acct));
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="daily-${date}.pdf"`);
      return res.end(pdf);
    }
    if (req.method === "GET" && (req.query.finals !== undefined || req.query.final !== undefined)) {
      await finalizeManagerDays();
      const all = (await listAll(FINAL))
        .map(b => ({ date: b.pathname.slice(FINAL.length, FINAL.length + 10), name: b.pathname.slice(FINAL.length), url: b.url }))
        .filter(x => x.name === `${x.date}-a${acct}.pdf`)
        .sort((a, c) => (a.date < c.date ? 1 : -1));
      if (req.query.finals !== undefined) return res.json({ finals: all.map(x => ({ date: x.date, label: dayLabel(x.date) })) });
      const f = all.find(x => x.date === req.query.final);
      if (!f) return res.status(404).json({ error: "not found" });
      const buf = Buffer.from(await (await fetch(f.url)).arrayBuffer());
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="daily-${f.date}.pdf"`);
      return res.end(buf);
    }
    const IN = "soldier/inbox/", PUB = "soldier/public/";
    if (req.method === "GET" && req.query.inbox !== undefined) {
      const bl = (await list({ prefix: IN, limit: 500, token })).blobs;
      const items = (await Promise.all(bl.map(x => fetch(x.url).then(r => r.json()).catch(() => null)))).filter(Boolean).sort((p, q) => p.t - q.t);
      return res.json({ items });
    }
    if (req.method === "POST" && req.body?.action === "ack") {
      const ids = new Set((Array.isArray(req.body.ids) ? req.body.ids : []).map(String));
      const bl = (await list({ prefix: IN, limit: 500, token })).blobs.filter(x => ids.has(x.pathname.slice(IN.length).replace(/\.json$/, "")));
      if (bl.length) await del(bl.map(x => x.url), { token });
      return res.json({ ok: true, deleted: bl.length });
    }
    if (req.method === "POST" && req.body?.action === "publish") {
      const body = JSON.stringify({ squad: (req.body.squad || []).slice(0, 60).map(s => String(s).slice(0, 60)), schedule: req.body.schedule || {} });
      if (body.length > 100000) return res.status(413).json({ error: "too big" });
      const old = (await list({ prefix: PUB, limit: 1000, token })).blobs;
      await putAny(`${PUB}${Date.now()}.json`, body);
      if (old.length) await del(old.map(x => x.url), { token });
      return res.json({ ok: true });
    }
    const blobs = (await list({ prefix: P, limit: 1000, token })).blobs.sort((a, b) => (a.pathname < b.pathname ? 1 : -1));
    if (req.method === "POST") {
      const incoming = req.body.data ?? null;
      // Four commanders share one document, so a write built on a stale copy would silently
      // erase everyone else's day. Reject it and hand back the current state instead.
      const cur = blobs.length ? await fetch(blobs[0].url).then(r => r.json()).catch(() => null) : null;
      const curRev = Number(cur?.rev) || 0;
      if (req.body.rev !== undefined && Number(req.body.rev) !== curRev) {
        return res.status(409).json({ error: "stale", rev: curRev, data: cur, acct });
      }
      const next = incoming && typeof incoming === "object" ? { ...incoming, rev: curRev + 1 } : incoming;
      const body = JSON.stringify(next);
      if (body.length > 400000) return res.status(413).json({ error: "too big" });
      await putAny(`${P}${Date.now()}.json`, body);
      if (blobs.length) await del(blobs.map(b => b.url), { token });
      return res.json({ ok: true, rev: curRev + 1 });
    }
    if (!blobs.length) return res.json({ data: null, acct, accts: ACCTS });
    const data = await fetch(blobs[0].url).then(r => r.json());
    return res.json({ data, acct, accts: ACCTS });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "server", detail: !token ? "no_blob_token" : String(e?.message || e).slice(0, 200) });
  }
}
