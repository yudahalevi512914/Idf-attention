import PDFDocument from "pdfkit";
import { q, kvGet, kvSet, putFinal, listFinals, getFinal, pruneFinals, errorJson } from "./_db.js";
import { PDFDocument as PdfLib } from "pdf-lib";
import { attendancePdfFor } from "./attendance.js";

// One PIN per commander account. All four share the same data; only the tracked squad differs.
// Override in production with MANAGER_PINS="a,b,c,d" rather than relying on these defaults.
const PINS = (process.env.MANAGER_PINS || process.env.MANAGER_PIN || "5361,5362,5363,5364").split(",").map(s => s.trim()).filter(Boolean);
const acctOf = pin => { const i = PINS.indexOf(String(pin ?? "")); return i < 0 ? 0 : i + 1; };
const ACCTS = PINS.length;
const KEEP_DAYS = 7;

// Writes the shared state only if nobody else has saved since `curRev`; returns false when stale.
// Daily report file = the commander report, followed by that day's attendance report
// (activities finished so far) when there is one.
async function dailyPdf(data, date, acct) {
  const att = await attendancePdfFor(date).catch(e => { console.error("attendance pdf", e); return null; });
  const doc = buildDailyDoc(data, date, acct);
  doc.sub += att ? ` · דוח נוכחות מצורף${att.activities ? ` (${plur(att.activities, "פעילות אחת", "פעילויות")})` : ""}` : " · אין פעילויות נוכחות שהסתיימו";
  const main = await tablePdf(doc);
  if (!att) return main;
  const out = await PdfLib.load(main), add = await PdfLib.load(att.pdf);
  (await out.copyPages(add, add.getPageIndices())).forEach(p => out.addPage(p));
  return Buffer.from(await out.save());
}

async function writeState(next, curRev) {
  const r = await q(`insert into kv (k, v) values ('manager', $1::jsonb)
    on conflict (k) do update set v = excluded.v, updated = now()
    where coalesce((kv.v->>'rev')::int, 0) = $2 returning k`, [JSON.stringify(next), curRev]);
  return r.length > 0;
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
    heading: s(t.heading, 100), grouped: !!t.grouped,
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
    doc.fillColor(NAVY); text(t.grouped ? t.heading : `${t.heading} (${t.rows.length})`, R, y, 14, "B"); y += 24;
    if (!t.rows.length || !t.cols.length) { doc.fillColor("#666"); text("אין פריטים.", R, y, 11); y += 26; continue; }
    const tw = t.cols.reduce((a, c) => a + c.w, 0); let xr = R;
    const cols = t.cols.map(c => { const w = (c.w / tw) * W; const o = { ...c, xr, w }; xr -= w; return o; });
    const header = () => {
      doc.rect(M, y, W, 20).fill(NAVY); doc.fillColor("#fff");
      cols.forEach(c => text(c.h, c.xr - 6, y + 5, 10, "B", c.w - 10)); y += 20;
    };
    header();
    // grouped tables: a group starts where the first cell is filled; zebra and a rule per group
    let band = -1;
    t.rows.forEach((row, i) => {
      const start = t.grouped && String(row[0] ?? "") !== "";
      if (!t.grouped || start) band++;
      const cells = cols.map((c, k) => lines(row[k] ?? "", FS, reg, c.w - 12));
      const h = Math.max(...cells.map(l => l.length)) * LH + 8;
      if (y + h > PH - M - 22) { doc.addPage(); y = M; header(); }
      if (band % 2) doc.rect(M, y, W, h).fill(ZEBRA);
      if (start && i) doc.moveTo(M, y).lineTo(R, y).strokeColor(NAVY).lineWidth(0.8).stroke();
      doc.fillColor("#111");
      cols.forEach((c, k) => cells[k].forEach((ws, li) => draw(ws, c.xr - 6, y + 4 + li * LH, FS, t.grouped && k === 0 ? "B" : reg)));
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
    .filter(e => dayOfMs(e.t) === date && (e.n ? inSquad.has(e.n) : e.a === acct)).sort((a, b) => a.t - b.t);
  const evOf = kind => events.filter(e => e.kind === kind).map(e => `${e.n || "כללי"} · ${hhmm(e.t)}: ${oneLine(e.text)}`);

  // every request that is not closed, whatever its status or the day it was opened
  const open = [];
  squad.forEach(n => ((soldiers[n] || {}).log || []).forEach(l => {
    if (isOpenSt(l.st) && dayOfMs(l.t) <= date) open.push({ n, l });
  }));
  open.sort((a, b) => a.l.t - b.l.t);
  const opened = l => (dayOfMs(l.t) === date ? `היום ${hhmm(l.t)}` : dmy(dayOfMs(l.t)));
  const GROUP = { "רפואי": "med", "ת״ש": "tash", "שלישות": "shal" };
  const req = (g, withType) => open.filter(x => (GROUP[x.l.type] || "special") === g)
    .map(({ n, l }) => `${n}${withType && l.type ? ` · ${l.type}` : ""} · ${opened(l)} · ${l.st || ""}: ${oneLine(l.text)}`);

  // typed in by the commander right before issuing (kept per account and day)
  const manual = S.daily?.[acct]?.[date] || {};
  const textLines = t => String(t ?? "").split(/\n/).map(x => x.trim()).filter(Boolean);
  const manpower = [...textLines(manual.kh), ...evOf("פער בכח אדם").map(x => `פער: ${x}`)];

  const sections = [
    ["מצב כח אדם", manpower, "לא הוזן"],
    ["שלישות", req("shal")],
    ["כוננות", evOf("פער כוננות")],
    ["ת״ש", req("tash")],
    ["רפואה", req("med")],
    ["משמעת", evOf("משמעת")],
    ["בקשות מיוחדות", req("special", true)],
    ["אירועי בטיחות", evOf("בטיחות")],
    ["התייחסות אישית", textLines(manual.personal), "—"],
  ];
  const rows = sections.flatMap(([h, items, none = "אין"]) => (items.length ? items : [none]).map((x, i) => [i ? "" : h, x]));

  return {
    title: "דוח יומי – לוח מפקד",
    sub: `${dayLabel(date)} · ${plur(open.length, "בקשה פתוחה אחת", "בקשות פתוחות")} · ${plur(events.length, "אירוע אחד", "אירועים")}`,
    tables: [{ heading: "סיכום יומי", grouped: true, cols: [{ h: "נושא", w: 2.2 }, { h: "פירוט", w: 8 }], rows }],
  };
}

const readState = async () => ({ data: await kvGet("manager") });

// Every day that has ended gets one stored PDF (kept KEEP_DAYS days); its events are
// then dropped from the live state so the commander board only ever shows today.
async function finalizeManagerDays() {
  const { data } = await readState();
  if (!data) return { days: [] };
  const today = todayIL();
  const eventDays = [...new Set((Array.isArray(data.events) ? data.events : []).map(e => dayOfMs(e.t)))];
  const yesterday = shiftDay(today, -1);
  const stored = new Set((await q(`select day || '-' || acct as k from finals where kind = 'mgr' and day >= $1`, [yesterday])).map(r => r.k));
  // yesterday's report is rebuilt until it exists; older days only while they still hold events
  const days = [...new Set([yesterday, ...eventDays])].filter(d => d < today).sort();

  for (const d of days) {
    for (let a = 1; a <= ACCTS; a++) {
      if (!squadOf(data, a).length) continue;
      if (d === yesterday && !eventDays.includes(d) && stored.has(`${d}-${a}`)) continue;
      await putFinal({ kind: "mgr", day: d, acct: a }, await dailyPdf(data, d, a));
    }
  }

  const kept = (Array.isArray(data.events) ? data.events : []).filter(e => dayOfMs(e.t) >= today);
  if (kept.length !== (data.events || []).length) {
    const rev = Number(data.rev) || 0;
    await writeState({ ...data, events: kept, rev: rev + 1 }, rev); // skipped if a commander saved meanwhile; next run retries
  }
  await pruneFinals("mgr", shiftDay(today, -(KEEP_DAYS - 1)));
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
      const pdf = await dailyPdf(data, date, acct);
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="daily-${date}.pdf"`);
      return res.end(pdf);
    }
    if (req.method === "GET" && (req.query.finals !== undefined || req.query.final !== undefined)) {
      await finalizeManagerDays();
      if (req.query.finals !== undefined) return res.json({ finals: (await listFinals("mgr", acct)).map(x => ({ date: x.day, label: dayLabel(x.day) })) });
      const buf = await getFinal("mgr", String(req.query.final), acct);
      if (!buf) return res.status(404).json({ error: "not found" });
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="daily-${req.query.final}.pdf"`);
      return res.end(buf);
    }
    if (req.method === "GET" && req.query.inbox !== undefined) {
      const items = (await q(`select item from inbox order by t limit 500`)).map(r => r.item);
      return res.json({ items });
    }
    if (req.method === "POST" && req.body?.action === "ack") {
      const ids = (Array.isArray(req.body.ids) ? req.body.ids : []).map(String).slice(0, 500);
      const r = ids.length ? await q(`delete from inbox where id = any($1::text[]) returning id`, [ids]) : [];
      return res.json({ ok: true, deleted: r.length });
    }
    if (req.method === "POST" && req.body?.action === "publish") {
      const g = req.body.guard;
      const guard = g && /^\d{4}-\d{2}-\d{2}$/.test(g.d || "") && Array.isArray(g.slots)
        ? { d: g.d, slots: g.slots.slice(0, 100).map(x => ({ n: String(x?.n ?? "").slice(0, 60), a: Math.round(+x?.a || 0), b: Math.round(+x?.b || 0) })) }
        : null;
      const pub = { squad: (req.body.squad || []).slice(0, 60).map(s => String(s).slice(0, 60)), schedule: req.body.schedule || {}, guard };
      if (JSON.stringify(pub).length > 100000) return res.status(413).json({ error: "too big" });
      await kvSet("public", pub);
      return res.json({ ok: true });
    }
    if (req.method === "POST") {
      const incoming = req.body.data ?? null;
      // Four commanders share one document, so a write built on a stale copy would silently
      // erase everyone else's day. Reject it and hand back the current state instead.
      const cur = await kvGet("manager");
      const curRev = Number(cur?.rev) || 0;
      const stale = () => res.status(409).json({ error: "stale", rev: curRev, data: cur, acct });
      if (req.body.rev !== undefined && Number(req.body.rev) !== curRev) return stale();
      if (!incoming || typeof incoming !== "object") return res.status(400).json({ error: "bad data" });
      const next = { ...incoming, rev: curRev + 1 };
      if (JSON.stringify(next).length > 400000) return res.status(413).json({ error: "too big" });
      if (!(await writeState(next, curRev))) { const now = await kvGet("manager"); return res.status(409).json({ error: "stale", rev: Number(now?.rev) || 0, data: now, acct }); }
      return res.json({ ok: true, rev: curRev + 1 });
    }
    return res.json({ data: await kvGet("manager"), acct, accts: ACCTS });
  } catch (e) {
    return res.status(500).json(errorJson(e));
  }
}
