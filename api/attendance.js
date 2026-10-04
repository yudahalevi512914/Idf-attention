import { put, list, del } from "@vercel/blob";

const token = process.env.BLOB_READ_WRITE_TOKEN || Object.entries(process.env).find(([k, v]) => /READ_WRITE_TOKEN$/.test(k) && v)?.[1];
const ADMIN_PIN = process.env.ADMIN_PIN || "1234";
const LIST = "attendance/list/", ACT = "attendance/activity/", ARC = "attendance/archive/";
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

export default async function handler(req, res) {
  try {
    if (req.method === "POST") {
      const b = req.body || {};
      if (b.action === "activity" || b.action === "reset") {
        if (b.pin !== ADMIN_PIN) return res.status(401).json({ error: "unauthorized" });
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
        await clearPrefix(ACT);
        await purge();
        return res.json({ ok: true });
      }
      const name = norm(b.name);
      if (name.length < 2 || name.length > 60) return res.status(400).json({ error: "bad name" });
      await putAny(LIST + b64(name), "1");
      return res.json({ ok: true });
    }

    const { name, pin, report } = req.query;
    if (report !== undefined) {
      if (pin !== ADMIN_PIN) return res.status(401).json({ error: "unauthorized" });
      const date = dayOf(Date.now());
      const blobs = await listAll(`${ARC}${date}/`);
      const reports = (await Promise.all(blobs.map(x => fetch(x.url).then(r => r.json()).catch(() => null)))).filter(Boolean).sort((a, c) => a.t - c.t);
      await purge();
      return res.json({ date, reports });
    }
    if (name !== undefined) {
      const activity = await getActivity();
      if (!name) return res.json({ present: false, activity });
      const p = LIST + b64(norm(name));
      const { blobs } = await list({ prefix: p, token });
      return res.json({ present: blobs.some(x => x.pathname === p), activity });
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
