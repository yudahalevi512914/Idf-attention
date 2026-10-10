import { put, list, del } from "@vercel/blob";
import PDFDocument from "pdfkit";

const token = process.env.BLOB_READ_WRITE_TOKEN || Object.entries(process.env).find(([k, v]) => /READ_WRITE_TOKEN$/.test(k) && v)?.[1];
// Same commander PINs as the manager board, so one code opens both.
const PINS = (process.env.MANAGER_PINS || process.env.ADMIN_PIN || "5361,5362,5363,5364").split(",").map(s => s.trim()).filter(Boolean);
const okPin = p => PINS.includes(String(p ?? ""));
const LIST = "attendance/list/", ACT = "attendance/activity/", ARC = "attendance/archive/", DEV = "attendance/dev/", FINAL = "attendance/final/";
const okDev = d => /^[\w-]{16,64}$/.test(d || "");
const norm = n => String(n || "").trim().replace(/\s+/g, " ").replace(/[׳’`]/g, "'");
const dayOf = ms => new Date(ms).toLocaleDateString("en-CA", { timeZone: "Asia/Jerusalem" });
const b64 = s => Buffer.from(s).toString("base64url");
const unb64 = s => Buffer.from(s, "base64url").toString();
const nk0 = n => String(n).replace(/[׳’`]/g, "'");
const cleanReasons = o => Object.fromEntries(Object.entries(o && typeof o === "object" ? o : {}).slice(0, 300).map(([k, v]) => [String(k).slice(0, 80), String(v ?? "").trim().slice(0, 120)]).filter(([, v]) => v));
const clean = a => (Array.isArray(a) ? a.slice(0, 300).map(x => String(x).slice(0, 80)) : []);

async function listAll(prefix) {
  const out = []; let cursor;
  do {
    const r = await list({ prefix, limit: 1000, cursor, token });
    out.push(...r.blobs); cursor = r.hasMore ? r.cursor : undefined;
  } while (cursor);
  return out;
}
async function putAny(path, body, contentType) {
  const o = { token, addRandomSuffix: false, allowOverwrite: true, ...(contentType ? { contentType } : {}) };
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
const labelOf = ms => new Date(ms).toLocaleDateString("he-IL", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Jerusalem" });
const timeOf = t => new Date(t).toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Jerusalem" });
const readReports = async blobs => (await Promise.all(blobs.map(x => fetch(x.url).then(r => r.json()).catch(() => null)))).filter(Boolean).sort((a, c) => a.t - c.t);

// Pushes one finished activity as a new column into the Google Sheet (via the Apps Script web app).
async function pushSheet(rec) {
  const url = process.env.SHEET_URL;
  if (!url) return "off";
  const date = dayOf(rec.t), noon = Date.parse(`${date}T12:00:00Z`), dow = new Date(noon).getUTCDay();
  const d0 = noon - dow * 864e5, fm = ms => { const i = new Date(ms).toISOString(); return `${i.slice(8, 10)}.${i.slice(5, 7)}`; };
  const reasons = new Map(Object.entries(rec.reasons || {}).map(([n, t]) => [nk0(n), t]));
  const rows = [...rec.present.map(n => ({ name: n, value: true })), ...rec.missing.map(n => ({ name: n, value: reasons.get(nk0(n)) || false }))];
  try {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, signal: AbortSignal.timeout(20000),
      body: JSON.stringify({ secret: process.env.SHEET_SECRET || "", sheetName: `שבוע ${fm(d0)}-${fm(d0 + 6 * 864e5)}`, dateLabel: fm(noon), header: `${rec.activity}\n${timeOf(rec.t)}`, rows }) });
    const j = await r.json().catch(() => null);
    return j?.ok ? "ok" : "failed";
  } catch (e) { console.error("sheet", e); return "failed"; }
}

// Every day that has ended gets one final PDF (kept 7 days); its raw data is then deleted.
async function finalizeDays() {
  const today = dayOf(Date.now());
  const byDay = {};
  for (const b of await listAll(ARC)) { const d = b.pathname.slice(ARC.length).split("/")[0]; if (d < today) (byDay[d] ||= []).push(b); }
  for (const [day, blobs] of Object.entries(byDay)) {
    const reports = await readReports(blobs);
    if (!reports.length) { await del(blobs.map(x => x.url), { token }); continue; }
    const pdf = await buildPdf({ dateLabel: labelOf(`${day}T09:00:00Z`), reports, timeOf });
    await putAny(`${FINAL}${day}.pdf`, pdf, "application/pdf");
    await del(blobs.map(x => x.url), { token });
  }
  const keepFrom = dayOf(Date.now() - 6 * 24 * 3600e3);
  const old = (await listAll(FINAL)).filter(b => b.pathname.slice(FINAL.length, FINAL.length + 10) < keepFrom);
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

export async function buildPdf({ dateLabel, reports, timeOf }) {
  const [reg, bold] = await getFonts();
  const doc = new PDFDocument({ size: "A4", layout: "landscape", margin: 24, font: reg, bufferPages: true });
  doc.registerFont("B", bold);
  const chunks = []; doc.on("data", c => chunks.push(c));
  const done = new Promise(r => doc.on("end", () => r(Buffer.concat(chunks))));
  const PW = doc.page.width, PH = doc.page.height, M = 24, R = PW - M, W = PW - 2 * M;
  const AMBER = "#e39a12", NAVY = "#16263a", RED = "#d9541e", GREEN = "#1e8a5a", ZEBRA = "#f5f1e8", LINE = "#d9d2c0";

  // --- RTL text helpers (word by word, so spaces and numbers stay correct) ---
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
  const gapOf = size => size * 0.32;
  const wordsW = (ws, size, f) => ws.reduce((x, w) => x + wid(w, size, f), 0) + gapOf(size) * Math.max(0, ws.length - 1);
  const fit = (t, size, f, maxW) => {
    let ws = String(t).split(/\s+/).filter(Boolean);
    if (wordsW(ws, size, f) > maxW) { let s = ws.join(" "); while (s.length > 1 && wordsW((s + ".").split(/\s+/), size, f) > maxW) s = s.slice(0, -1); ws = (s + ".").split(/\s+/); }
    return ws;
  };
  const draw = (ws, xr, y, size, f) => { let x = xr; for (const w of ws) { x -= drawWord(w, x, y, size, f); x -= gapOf(size); } };
  const rtl = (t, xr, y, size, f = reg, maxW = 1e9) => draw(fit(t, size, f, maxW), xr, y, size, f);
  const center = (t, xl, w, y, size, f = reg) => { doc.font(f).fontSize(size).text(String(t), xl, y, { width: w, align: "center", lineBreak: false }); };
  // Largest readable rendering of a reason that still fits inside one matrix cell.
  // Falls back to a trimmed first word, and to null when even that is unreadable.
  const cellFit = (t, maxW) => {
    const ws = String(t).split(/\s+/).filter(Boolean);
    if (!ws.length) return null;
    for (const size of [8, 7.5, 7, 6.5, 6]) if (wordsW(ws, size, "B") <= maxW) return { ws, size };
    const size = 6; let s = ws[0];
    while (s.length > 1 && wid(s + ".", size, "B") > maxW) s = s.slice(0, -1);
    return s.length >= 3 && wid(s + ".", size, "B") <= maxW ? { ws: [s + "."], size } : null;
  };
  const cellText = (f, xl, cw, y) => draw(f.ws, xl + (cw + wordsW(f.ws, f.size, "B")) / 2, y + (rowH - f.size) / 2, f.size, "B");
  // wrap into at most maxLines lines, each no wider than maxW
  const wrap = (t, size, f, maxW, maxLines) => {
    const ws = String(t).split(/\s+/).filter(Boolean), lines = [[]];
    for (const w of ws) { const cur = lines[lines.length - 1]; if (cur.length && wordsW([...cur, w], size, f) > maxW && lines.length < maxLines) lines.push([w]); else cur.push(w); }
    return lines.map(l => fit(l.join(" "), size, f, maxW));
  };
  // vertical header text, reads bottom-to-top, sits on the bottom edge yb, centered in a cell of width cw at xl
  const vtext = (t, xl, cw, yb, maxW) => {
    const size = cw >= 32 ? 10 : 8, lh = size * 1.2, maxLines = Math.max(1, Math.min(3, Math.floor((cw - 3) / lh)));
    const lines = wrap(t, size, bold, maxW, maxLines), block = lines.length * lh;
    doc.save(); doc.translate(xl + cw / 2, yb); doc.rotate(-90);
    lines.forEach((ws, i) => draw(ws, wordsW(ws, size, bold), -block / 2 + i * lh, size, bold));
    doc.restore();
  };

  // --- data: every name x every activity ---
  const nk = n => String(n).replace(/[׳’`]/g, "'");
  const extras = new Set(reports.flatMap(r => r.extra.map(nk)));
  const disp = new Map();
  reports.forEach(r => r.present.forEach(n => { const k = nk(n); if (!extras.has(k)) disp.set(k, n); }));
  reports.forEach(r => r.missing.forEach(n => disp.set(nk(n), n)));
  const miss = reports.map(r => new Set(r.missing.map(nk)));
  const rows = [...disp].map(([k, n]) => { const abs = miss.map(s => s.has(k)); return { n, abs, total: abs.filter(Boolean).length }; })
    .sort((a, b) => b.total - a.total || a.n.localeCompare(b.n, "he"));
  // explanations: number every explained absence (row by row) and keep a list for the last pages
  const rs = reports.map(r => new Map(Object.entries(r.reasons || {}).filter(([, t]) => String(t).trim()).map(([n, t]) => [nk(n), String(t).trim()])));
  const notes = [];
  // notes stay in matrix row order, so the detail table below reads in the same order as the grid
  rows.forEach(row => { row.note = reports.map(() => null); reports.forEach((r, j) => { if (row.abs[j]) { const t = rs[j].get(nk(row.n)); if (t) { row.note[j] = t; notes.push({ name: row.n, activity: r.activity, t: r.t, reason: t }); } } }); });
  const N = reports.length, colTot = reports.map((_, j) => rows.filter(r => r.abs[j]).length);
  const grand = rows.reduce((s, r) => s + r.total, 0);

  // --- layout ---
  const nameW = 120, totW = 44, avail = W - nameW - totW;
  const cellW = Math.max(21, Math.min(56, Math.floor(avail / Math.max(N, 1))));
  const perPage = Math.floor(avail / cellW);
  const colChunks = []; for (let i = 0; i < N; i += perPage) colChunks.push([i, Math.min(N, i + perPage)]);
  const rowH = 14, nameH = 88, timeH = 14, hdrH = nameH + timeH, titleH = 32, footH = 16;
  const rowsPer = Math.floor((PH - 2 * M - titleH - hdrH - footH) / rowH);
  const rowChunks = []; for (let i = 0; i < Math.max(rows.length, 1); i += rowsPer) rowChunks.push([i, Math.min(rows.length, i + rowsPer)]);

  let page = 0, endY = M; // endY: bottom of the last matrix block, so the explanations can follow it
  (colChunks.length ? colChunks : [[0, 0]]).forEach(([c0, c1]) => rowChunks.forEach(([r0, r1], ri) => {
    if (page) doc.addPage(); page++;
    doc.fillColor(NAVY); rtl("יודה נוכחות – סיכום חוסרים", R, M, 14, "B");
    doc.fillColor("#666"); rtl(`${dateLabel}  |  פעילויות: ${N}  |  חיילים: ${rows.length}  |  סה״כ חיסורים: ${grand}`, R, M + 18, 9.5);
    if (colChunks.length > 1) rtl(`מציג פעילויות ${c0 + 1} עד ${c1}`, R - 330, M + 18, 9.5);
    const lg = (xr, color, label) => { doc.rect(xr - 9, M + 3, 9, 9).fill(color); doc.fillColor("#555"); rtl(label, xr - 13, M + 2.5, 8.5); };
    lg(R - 190, RED, "חסר"); if (notes.length) lg(R - 245, AMBER, "חסר עם הסבר (הנוסח המלא בטבלה שמתחת)");
    let y = M + titleH;
    const tx = R - nameW - totW, cols = c1 - c0, left = tx - cols * cellW;
    doc.rect(left, y, nameW + totW + cols * cellW, hdrH).fill(NAVY);
    doc.fillColor("#fff"); rtl("שם", R - 8, y + hdrH - 20, 11, "B"); center("סה״כ", R - nameW - totW, totW, y + hdrH - 20, 10, "B");
    for (let j = c0; j < c1; j++) {
      const xl = tx - (j - c0 + 1) * cellW;
      doc.fillColor("#fff"); vtext(reports[j].activity, xl, cellW, y + nameH - 3, nameH - 8);
      doc.fillColor("#c9d3de"); center(timeOf(reports[j].t), xl, cellW, y + nameH + 3, 6.5);
    }
    y += hdrH; const top = y;
    for (let i = r0; i < r1; i++, y += rowH) {
      const row = rows[i];
      if ((i - r0) % 2) doc.rect(left, y, R - left, rowH).fill(ZEBRA);
      doc.fillColor("#111"); rtl(row.n, R - 8, y + 2.5, 10, reg, nameW - 14);
      doc.fillColor(row.total ? RED : "#999"); center(row.total || "–", R - nameW - totW, totW, y + 2.5, 10, row.total ? "B" : reg);
      for (let j = c0; j < c1; j++) if (row.abs[j]) {
        const xl = tx - (j - c0 + 1) * cellW, cx = xl + cellW / 2;
        const nt = row.note[j];
        if (nt) {
          doc.rect(xl + 1, y + 1, cellW - 2, rowH - 2).fill(AMBER); doc.fillColor("#fff");
          const f = cellFit(nt, cellW - 5);
          if (f) cellText(f, xl, cellW, y); else center("•••", xl, cellW, y + 3, 7, "B");
          continue;
        }
        doc.rect(xl + 1, y + 1, cellW - 2, rowH - 2).fill(RED);
        doc.moveTo(cx - 3, y + 4.5).lineTo(cx + 3, y + rowH - 4.5).moveTo(cx + 3, y + 4.5).lineTo(cx - 3, y + rowH - 4.5).strokeColor("#fff").lineWidth(1.1).stroke();
      }
    }
    doc.strokeColor(LINE).lineWidth(0.4);
    for (let j = 0; j <= cols; j++) doc.moveTo(tx - j * cellW, top).lineTo(tx - j * cellW, y).stroke();
    doc.moveTo(R - nameW, top).lineTo(R - nameW, y).stroke(); doc.moveTo(R, top).lineTo(R, y).stroke();
    for (let k = 0; k <= r1 - r0; k++) doc.moveTo(left, top + k * rowH).lineTo(R, top + k * rowH).stroke();
    if (ri === rowChunks.length - 1) {
      doc.rect(left, y + 2, R - left, footH).fill(NAVY);
      doc.fillColor("#fff"); rtl("חסרים בפעילות", R - 8, y + 5, 10, "B"); center(grand, R - nameW - totW, totW, y + 5, 10, "B");
      for (let j = c0; j < c1; j++) center(colTot[j], tx - (j - c0 + 1) * cellW, cellW, y + 5, 9.5, "B");
      endY = y + 2 + footH;
    } else endY = y;
  }));
  if (notes.length) {
    const E = [{ h: "חייל", w: 150 }, { h: "פעילות", w: 210 }, { h: "ההסבר המלא", w: W - 150 - 210 }];
    let y;
    const head = () => {
      doc.fillColor(NAVY); rtl("פירוט ההסברים", R, y, 14, "B"); y += 26;
      doc.rect(M, y, W, 18).fill(NAVY); let xr = R; doc.fillColor("#fff");
      E.forEach(c => { rtl(c.h, xr - 6, y + 4, 10, "B"); xr -= c.w; }); y += 18;
    };
    // continue underneath the matrix when at least a header and one row still fit on the page
    if (PH - M - 12 - (endY + 28) >= 26 + 18 + 20) y = endY + 28;
    else { doc.addPage(); y = M; }
    head();
    notes.forEach((nt, i) => {
      const ls = [nt.name, `${nt.activity} ${timeOf(nt.t)}`, nt.reason].map((t, k) => wrap(t, 10, reg, E[k].w - 12, 8));
      const h = Math.max(...ls.map(l => l.length)) * 13 + 6;
      if (y + h > PH - M - 12) { doc.addPage(); y = M; head(); }
      if (i % 2) doc.rect(M, y, W, h).fill(ZEBRA);
      doc.fillColor("#111"); let xr = R;
      E.forEach((c, k) => { ls[k].forEach((ws, li) => draw(ws, xr - 6, y + 3 + li * 13, 10, reg)); xr -= c.w; });
      doc.moveTo(M, y + h).lineTo(R, y + h).strokeColor(LINE).lineWidth(0.4).stroke(); y += h;
    });
  }
  const totalPages = doc.bufferedPageRange().count;
  for (let i = 0; i < totalPages; i++) { doc.switchToPage(i); doc.fillColor("#666"); rtl(`עמוד ${i + 1} מתוך ${totalPages}`, M + 90, M + 3, 9); }
  doc.end();
  return done;
}

export default async function handler(req, res) {
  try {
    if (req.method === "POST") {
      const b = req.body || {};
      if (b.action === "activity" || b.action === "reset" || b.action === "remove") {
        if (!okPin(b.pin)) return res.status(401).json({ error: "unauthorized" });
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
        const rec = { activity, t: now, present: clean(b.present), missing: clean(b.missing), extra: clean(b.extra), reasons: cleanReasons(b.reasons) };
        await putAny(`${ARC}${dayOf(now)}/${now}`, JSON.stringify(rec));
        await clearPrefix(LIST);
        await clearPrefix(DEV);
        await clearPrefix(ACT);
        const sheet = await pushSheet(rec);
        return res.json({ ok: true, sheet });
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
    if (req.query.cron !== undefined) {
      const sec = process.env.CRON_SECRET;
      if (sec && req.headers.authorization !== `Bearer ${sec}`) return res.status(401).json({ error: "unauthorized" });
      await finalizeDays();
      return res.json({ ok: true });
    }
    if (req.query.finals !== undefined || req.query.final !== undefined) {
      if (!okPin(pin)) return res.status(401).json({ error: "unauthorized" });
      await finalizeDays();
      const all = (await listAll(FINAL)).map(b => ({ date: b.pathname.slice(FINAL.length, FINAL.length + 10), url: b.url })).sort((a, c) => (a.date < c.date ? 1 : -1));
      if (req.query.finals !== undefined) return res.json({ finals: all.map(x => ({ date: x.date, label: labelOf(`${x.date}T09:00:00Z`) })) });
      const f = all.find(x => x.date === req.query.final);
      if (!f) return res.status(404).json({ error: "not found" });
      const buf = Buffer.from(await (await fetch(f.url)).arrayBuffer());
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="attendance-${f.date}.pdf"`);
      return res.end(buf);
    }
    if (report !== undefined) {
      if (!okPin(pin)) return res.status(401).json({ error: "unauthorized" });
      const now = Date.now(), date = dayOf(now);
      const reports = await readReports(await listAll(`${ARC}${date}/`));
      if (!reports.length) return res.json({ empty: true });
      const pdf = await buildPdf({ dateLabel: labelOf(now), reports, timeOf });
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
    if (!okPin(pin)) return res.status(401).json({ error: "unauthorized" });
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
