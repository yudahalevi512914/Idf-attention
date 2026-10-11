// Shared Neon (Postgres) access for every API route.
// Files starting with "_" inside /api are not exposed as routes by Vercel.
import { neon } from "@neondatabase/serverless";

const URL_ = process.env.DATABASE_URL || process.env.POSTGRES_URL ||
  Object.entries(process.env).find(([k, v]) => /(DATABASE_URL|POSTGRES_URL)$/.test(k) && v)?.[1];

// runner: { q(text, params) -> rows, tx([[text, params], ...]) -> rows[] }
let runner = URL_ ? fromNeon(neon(URL_)) : null;
function fromNeon(sql) {
  return {
    q: (text, params = []) => sql.query(text, params),
    tx: list => sql.transaction(list.map(([text, params = []]) => sql.query(text, params))),
  };
}
// tests swap in a local Postgres
export function setRunner(r) { runner = r; ready = null; }
export const hasDb = () => !!runner;

const SCHEMA = [
  // small JSON values: manager state, current activity name, soldier public page
  `create table if not exists kv (k text primary key, v jsonb not null, updated timestamptz not null default now())`,
  `create table if not exists att_list (name text primary key, t bigint not null)`,
  `create table if not exists att_dev (dev text primary key, name text not null)`,
  `create table if not exists att_archive (t bigint primary key, day text not null, rec jsonb not null)`,
  `create index if not exists att_archive_day on att_archive (day)`,
  `create table if not exists inbox (id text primary key, t bigint not null, item jsonb not null)`,
  // stored daily PDFs: kind 'att' (attendance) or 'mgr' (commander report, per account)
  `create table if not exists finals (k text primary key, kind text not null, day text not null, acct int not null default 0, pdf text not null)`,
];
let ready = null;
function init() {
  if (!runner) return Promise.reject(Object.assign(new Error("no_db"), { code: "no_db" }));
  return (ready ||= runner.tx(SCHEMA.map(s => [s])).catch(e => { ready = null; throw e; }));
}

export async function q(text, params) { await init(); return runner.q(text, params); }
export async function tx(list) { await init(); return runner.tx(list); }

// --- helpers ---
export async function kvGet(k) { return (await q(`select v from kv where k = $1`, [k]))[0]?.v ?? null; }
export const kvSet = (k, v) => q(`insert into kv (k, v) values ($1, $2::jsonb) on conflict (k) do update set v = excluded.v, updated = now()`, [k, JSON.stringify(v)]);
export const kvDel = k => q(`delete from kv where k = $1`, [k]);

export async function putFinal({ kind, day, acct = 0 }, pdf) {
  const k = `${kind}/${day}/${acct}`;
  await q(`insert into finals (k, kind, day, acct, pdf) values ($1, $2, $3, $4, $5) on conflict (k) do update set pdf = excluded.pdf`,
    [k, kind, day, acct, Buffer.from(pdf).toString("base64")]);
}
export const listFinals = (kind, acct = 0) => q(`select day from finals where kind = $1 and acct = $2 order by day desc`, [kind, acct]);
export async function getFinal(kind, day, acct = 0) {
  const r = (await q(`select pdf from finals where kind = $1 and day = $2 and acct = $3`, [kind, day, acct]))[0];
  return r ? Buffer.from(r.pdf, "base64") : null;
}
export const pruneFinals = (kind, keepFrom) => q(`delete from finals where kind = $1 and day < $2`, [kind, keepFrom]);

export function errorJson(e) {
  console.error(e);
  return { error: "server", detail: !runner || e?.code === "no_db" ? "no_db" : String(e?.message || e).slice(0, 200) };
}
