import { q, kvGet, errorJson } from "./_db.js";

const norm = n => String(n || "").trim().replace(/\s+/g, " ").replace(/[׳’`]/g, "'");
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Jerusalem" });
const KINDS = ["exit", "medical", "medstatus", "general"];

export default async function handler(req, res) {
  try {
    if (req.method === "POST") {
      const b = req.body || {};
      const name = norm(b.name), kind = b.kind, text = String(b.text || "").trim().slice(0, 3000);
      if (b.action !== "submit" || name.length < 2 || name.length > 60 || !KINDS.includes(kind) || !text) return res.status(400).json({ error: "bad request" });
      const okDate = d => /^\d{4}-\d{2}-\d{2}$/.test(d || "");
      const until = okDate(b.until) ? b.until : "", appt = okDate(b.appt) ? b.appt : "";
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, t = Date.now();
      // one statement: refuses the request once 500 requests are waiting for the commanders
      const r = await q(`insert into inbox (id, t, item) select $1, $2, $3::jsonb where (select count(*) from inbox) < 500 returning id`,
        [id, t, JSON.stringify({ id, t, name, kind, text, until, appt })]);
      if (!r.length) return res.status(429).json({ error: "inbox full" });
      return res.json({ ok: true });
    }
    const date = today();
    const pub = await kvGet("public");
    if (!pub) return res.json({ date, squad: [], items: [] });
    return res.json({ date, squad: Array.isArray(pub.squad) ? pub.squad : [], items: pub.schedule?.[date] || [] });
  } catch (e) {
    return res.status(500).json(errorJson(e));
  }
}
