import { put, list, del } from "@vercel/blob";

const token = process.env.BLOB_READ_WRITE_TOKEN || Object.entries(process.env).find(([k, v]) => /READ_WRITE_TOKEN$/.test(k) && v)?.[1];
const ADMIN_PIN = process.env.ADMIN_PIN || "1234";
const norm = n => String(n || "").trim().replace(/\s+/g, " ").replace(/[׳’`]/g, "'");
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Jerusalem" });
const okDate = d => /^\d{4}-\d{2}-\d{2}$/.test(d || "");
const path = (d, n) => `attendance/${d}/${Buffer.from(n).toString("base64url")}`;

export default async function handler(req, res) {
  try {
    if (req.method === "POST" && req.body?.action === "reset") {
      if (req.body.pin !== ADMIN_PIN) return res.status(401).json({ error: "unauthorized" });
      if (!okDate(req.body.date)) return res.status(400).json({ error: "bad date" });
      let cursor, n = 0;
      do {
        const r = await list({ prefix: `attendance/${req.body.date}/`, limit: 1000, cursor, token });
        if (r.blobs.length) { await del(r.blobs.map(b => b.url), { token }); n += r.blobs.length; }
        cursor = r.hasMore ? r.cursor : undefined;
      } while (cursor);
      return res.json({ ok: true, deleted: n });
    }
    if (req.method === "POST") {
      const name = norm(req.body?.name);
      if (name.length < 2 || name.length > 60) return res.status(400).json({ error: "bad name" });
      const opts = { addRandomSuffix: false, allowOverwrite: true };
      try { await put(path(today(), name), "1", { ...opts, token, access: "public" }); }
      catch (e) {
        if (!/private/i.test(String(e?.message))) throw e;
        await put(path(today(), name), "1", { ...opts, token, access: "private" });
      }
      return res.json({ ok: true });
    }
    const { date, name, pin } = req.query;
    if (!okDate(date)) return res.status(400).json({ error: "bad date" });
    if (name) {
      const p = path(date, norm(name));
      const { blobs } = await list({ prefix: p, token });
      return res.json({ present: blobs.some(b => b.pathname === p) });
    }
    if (pin !== ADMIN_PIN) return res.status(401).json({ error: "unauthorized" });
    const { blobs } = await list({ prefix: `attendance/${date}/`, limit: 1000, token });
    return res.json({
      list: blobs.map(b => ({ name: Buffer.from(b.pathname.split("/").pop(), "base64url").toString(), t: new Date(b.uploadedAt).getTime() })),
    });
  } catch (e) {
    console.error(e);
    const m = String(e?.message || e);
    return res.status(500).json({ error: "server", detail: !token ? "no_blob_token" : m.slice(0, 200) });
  }
}
