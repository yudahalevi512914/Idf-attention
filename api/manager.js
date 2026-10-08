import { put, list, del } from "@vercel/blob";
import PDFDocument from "pdfkit";

const token = process.env.BLOB_READ_WRITE_TOKEN || Object.entries(process.env).find(([k, v]) => /READ_WRITE_TOKEN$/.test(k) && v)?.[1];
const PIN = process.env.MANAGER_PIN || process.env.ADMIN_PIN || "1234";
const P = "manager/data/";

async function putAny(path, body) {
  const o = { token, addRandomSuffix: false, allowOverwrite: true, contentType: "application/json" };
  try { return await put(path, body, { ...o, access: "public" }); }
  catch (e) { if (!/private/i.test(String(e?.message))) throw e; return put(path, body, { ...o, access: "private" }); }
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
async function tablePdf(input) {
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

export default async function handler(req, res) {
  try {
    const pin = req.method === "POST" ? req.body?.pin : req.query.pin;
    if (pin !== PIN) return res.status(401).json({ error: "unauthorized" });
    if (req.method === "POST" && req.body?.action === "pdf") {
      const pdf = await tablePdf(req.body.doc);
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", 'attachment; filename="summary.pdf"');
      return res.end(pdf);
    }
    const blobs = (await list({ prefix: P, limit: 1000, token })).blobs.sort((a, b) => (a.pathname < b.pathname ? 1 : -1));
    if (req.method === "POST") {
      const body = JSON.stringify(req.body.data ?? null);
      if (body.length > 400000) return res.status(413).json({ error: "too big" });
      await putAny(`${P}${Date.now()}.json`, body);
      if (blobs.length) await del(blobs.map(b => b.url), { token });
      return res.json({ ok: true });
    }
    if (!blobs.length) return res.json({ data: null });
    const data = await fetch(blobs[0].url).then(r => r.json());
    return res.json({ data });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "server", detail: !token ? "no_blob_token" : String(e?.message || e).slice(0, 200) });
  }
}
