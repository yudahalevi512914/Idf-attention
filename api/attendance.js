import { put, list } from "@vercel/blob";

const ADMIN_PIN = process.env.ADMIN_PIN || "1234";
const norm = n => String(n || "").trim().replace(/\s+/g, " ").replace(/[׳’`]/g, "'");
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Jerusalem" });
const okDate = d => /^\d{4}-\d{2}-\d{2}$/.test(d || "");
const path = (d, n) => `attendance/${d}/${encodeURIComponent(n)}`;

export default async function handler(req, res) {
  try {
    if (req.method === "POST") {
      const name = norm(req.body?.name);
      if (name.length < 2 || name.length > 60) return res.status(400).json({ error: "bad name" });
      await put(path(today(), name), "1", { access: "public", addRandomSuffix: false, allowOverwrite: true });
      return res.json({ ok: true });
    }
    const { date, name, pin } = req.query;
    if (!okDate(date)) return res.status(400).json({ error: "bad date" });
    if (name) {
      const p = path(date, norm(name));
      const { blobs } = await list({ prefix: p });
      return res.json({ present: blobs.some(b => b.pathname === p) });
    }
    if (pin !== ADMIN_PIN) return res.status(401).json({ error: "unauthorized" });
    const { blobs } = await list({ prefix: `attendance/${date}/`, limit: 1000 });
    return res.json({
      list: blobs.map(b => ({ name: decodeURIComponent(b.pathname.split("/").pop()), t: new Date(b.uploadedAt).getTime() })),
    });
  } catch (e) {
    return res.status(500).json({ error: "server" });
  }
}
