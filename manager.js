import { put, list, del } from "@vercel/blob";

const token = process.env.BLOB_READ_WRITE_TOKEN || Object.entries(process.env).find(([k, v]) => /READ_WRITE_TOKEN$/.test(k) && v)?.[1];
const PIN = process.env.MANAGER_PIN || process.env.ADMIN_PIN || "1234";
const P = "manager/data/";

async function putAny(path, body) {
  const o = { token, addRandomSuffix: false, allowOverwrite: true, contentType: "application/json" };
  try { return await put(path, body, { ...o, access: "public" }); }
  catch (e) { if (!/private/i.test(String(e?.message))) throw e; return put(path, body, { ...o, access: "private" }); }
}

export default async function handler(req, res) {
  try {
    const pin = req.method === "POST" ? req.body?.pin : req.query.pin;
    if (pin !== PIN) return res.status(401).json({ error: "unauthorized" });
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
