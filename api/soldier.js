import { put, list } from "@vercel/blob";

const token = process.env.BLOB_READ_WRITE_TOKEN || Object.entries(process.env).find(([k, v]) => /READ_WRITE_TOKEN$/.test(k) && v)?.[1];
const PUB = "soldier/public/", IN = "soldier/inbox/";
const norm = n => String(n || "").trim().replace(/\s+/g, " ").replace(/[׳’`]/g, "'");
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Jerusalem" });
const KINDS = ["exit", "medical", "medstatus"];

async function putAny(path, body) {
  const o = { token, addRandomSuffix: false, allowOverwrite: true, contentType: "application/json" };
  try { return await put(path, body, { ...o, access: "public" }); }
  catch (e) { if (!/private/i.test(String(e?.message))) throw e; return put(path, body, { ...o, access: "private" }); }
}

export default async function handler(req, res) {
  try {
    if (req.method === "POST") {
      const b = req.body || {};
      const name = norm(b.name), kind = b.kind, text = String(b.text || "").trim().slice(0, 600);
      if (b.action !== "submit" || name.length < 2 || name.length > 60 || !KINDS.includes(kind) || !text) return res.status(400).json({ error: "bad request" });
      const until = /^\d{4}-\d{2}-\d{2}$/.test(b.until || "") ? b.until : "";
      const pending = await list({ prefix: IN, limit: 500, token });
      if (pending.blobs.length >= 500) return res.status(429).json({ error: "inbox full" });
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      await putAny(`${IN}${id}.json`, JSON.stringify({ id, t: Date.now(), name, kind, text, until }));
      return res.json({ ok: true });
    }
    const date = today();
    const blobs = (await list({ prefix: PUB, limit: 1000, token })).blobs.sort((a, b) => (a.pathname < b.pathname ? 1 : -1));
    if (!blobs.length) return res.json({ date, squad: [], items: [] });
    const pub = await fetch(blobs[0].url).then(r => r.json());
    return res.json({ date, squad: Array.isArray(pub.squad) ? pub.squad : [], items: pub.schedule?.[date] || [] });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "server", detail: !token ? "no_blob_token" : String(e?.message || e).slice(0, 200) });
  }
}
