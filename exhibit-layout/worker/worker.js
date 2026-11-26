// 展場配置模擬｜共用檔案庫 API（Cloudflare Worker + D1）
// 部署：Worker 名稱 exhibit-layout，繫結 D1 資料庫，變數名稱 DB。資料表第一次呼叫時自動建立。
// 設計：不需密碼；每次存檔都新增一個版本（不覆蓋舊資料），刪除只是移到「最近刪除」，可復原。

const ALLOWED_ORIGINS = ['https://aforesttw.github.io'];
const LOCAL_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
const MAX_BYTES = 300000;
let ready = false;

async function init(env) {
  if (ready) return;
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS plans (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, author TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      latest_vid INTEGER, item_count INTEGER NOT NULL DEFAULT 0, deleted_at INTEGER)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS plan_versions (
      vid INTEGER PRIMARY KEY AUTOINCREMENT, plan_id TEXT NOT NULL, name TEXT NOT NULL,
      author TEXT, data TEXT NOT NULL, item_count INTEGER NOT NULL, saved_at INTEGER NOT NULL)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_pv_plan ON plan_versions(plan_id, vid DESC)`),
  ]);
  ready = true;
}

function cors(origin) {
  const ok = origin && (ALLOWED_ORIGINS.includes(origin) || LOCAL_ORIGIN.test(origin));
  return {
    'Access-Control-Allow-Origin': ok ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}
const json = (data, status, origin) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...cors(origin) } });

const cleanText = (v, max) => String(v ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, max);
const ID_RE = /^[a-z0-9]{6,24}$/;

async function readBody(req) {
  const text = await req.text();
  if (text.length > MAX_BYTES) throw Object.assign(new Error('檔案太大'), { status: 413 });
  let b;
  try { b = JSON.parse(text); } catch { throw Object.assign(new Error('格式錯誤'), { status: 400 }); }
  const d = b && b.data;
  if (!d || !Array.isArray(d.items) || d.items.length > 400 || (d.custom && (!Array.isArray(d.custom) || d.custom.length > 60)))
    throw Object.assign(new Error('配置資料不正確'), { status: 400 });
  return {
    id: typeof b.id === 'string' && ID_RE.test(b.id) ? b.id : null,
    name: cleanText(b.name, 40) || '未命名',
    author: cleanText(b.author, 20) || null,
    data: JSON.stringify({ items: d.items, custom: d.custom || [] }),
    count: d.items.length,
    base: Number.isInteger(b.base_vid) ? b.base_vid : null,
    force: b.force === true,
  };
}

async function addVersion(env, id, b, now) {
  const r = await env.DB.prepare(
    'INSERT INTO plan_versions (plan_id, name, author, data, item_count, saved_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6) RETURNING vid'
  ).bind(id, b.name, b.author, b.data, b.count, now).first();
  await env.DB.prepare('UPDATE plans SET name=?2, author=?3, updated_at=?4, latest_vid=?5, item_count=?6 WHERE id=?1')
    .bind(id, b.name, b.author, now, r.vid, b.count).run();
  return r.vid;
}

async function handle(req, env, origin) {
  const url = new URL(req.url);
  const parts = url.pathname.split('/').filter(Boolean);
  const m = req.method;
  if (parts[0] === 'health') return json({ ok: true }, 200, origin);
  if (parts[0] !== 'plans') return json({ error: '找不到' }, 404, origin);
  const writing = m !== 'GET';
  if (writing && origin && !(ALLOWED_ORIGINS.includes(origin) || LOCAL_ORIGIN.test(origin)))
    return json({ error: '不允許的來源' }, 403, origin);
  await init(env);
  const now = Date.now();
  const [, id, sub, vidStr] = parts;

  // 列表：GET /plans 或 /plans?deleted=1
  if (!id && m === 'GET') {
    const del = url.searchParams.get('deleted') === '1';
    const rows = await env.DB.prepare(
      `SELECT p.id, p.name, p.author, p.updated_at, p.latest_vid, p.item_count, p.deleted_at,
        (SELECT COUNT(*) FROM plan_versions v WHERE v.plan_id = p.id) AS versions
       FROM plans p WHERE p.deleted_at IS ${del ? 'NOT NULL' : 'NULL'}
       ORDER BY ${del ? 'p.deleted_at' : 'p.updated_at'} DESC LIMIT 200`
    ).all();
    return json({ plans: rows.results || [] }, 200, origin);
  }
  // 新增：POST /plans
  if (!id && m === 'POST') {
    const b = await readBody(req);
    const pid = b.id || crypto.randomUUID().replace(/-/g, '').slice(0, 12);
    const exist = await env.DB.prepare('SELECT id, latest_vid FROM plans WHERE id=?1').bind(pid).first();
    if (exist) return json({ id: pid, vid: exist.latest_vid, repeated: true }, 200, origin); // 網路重送：不重複建立
    await env.DB.prepare('INSERT INTO plans (id, name, author, created_at, updated_at, item_count) VALUES (?1, ?2, ?3, ?4, ?4, ?5)')
      .bind(pid, b.name, b.author, now, b.count).run();
    const vid = await addVersion(env, pid, b, now);
    return json({ id: pid, vid }, 201, origin);
  }
  if (!id || !ID_RE.test(id)) return json({ error: '找不到' }, 404, origin);
  const plan = await env.DB.prepare('SELECT * FROM plans WHERE id=?1').bind(id).first();
  if (!plan) return json({ error: '找不到這個檔案' }, 404, origin);

  if (!sub && m === 'GET') {
    const v = await env.DB.prepare('SELECT vid, name, author, data, item_count, saved_at FROM plan_versions WHERE vid=?1').bind(plan.latest_vid).first();
    return json({ id, name: plan.name, deleted: !!plan.deleted_at, vid: v.vid, author: v.author, saved_at: v.saved_at, data: JSON.parse(v.data) }, 200, origin);
  }
  // 存新版本：PUT /plans/:id
  if (!sub && m === 'PUT') {
    if (plan.deleted_at) return json({ error: '這個檔案已被刪除' }, 410, origin);
    const b = await readBody(req);
    if (b.base !== null && b.base !== plan.latest_vid && !b.force) {
      const last = await env.DB.prepare('SELECT vid, name, author, data, saved_at FROM plan_versions WHERE vid=?1').bind(plan.latest_vid).first();
      if (last && last.data === b.data) return json({ id, vid: last.vid, repeated: true }, 200, origin);
      return json({ error: 'conflict', latest: { vid: last.vid, name: last.name, author: last.author, saved_at: last.saved_at } }, 409, origin);
    }
    const vid = await addVersion(env, id, b, now);
    return json({ id, vid }, 200, origin);
  }
  if (!sub && m === 'DELETE') {
    await env.DB.prepare('UPDATE plans SET deleted_at=?2 WHERE id=?1').bind(id, now).run();
    return json({ ok: true }, 200, origin);
  }
  if (sub === 'restore' && m === 'POST') {
    await env.DB.prepare('UPDATE plans SET deleted_at=NULL, updated_at=?2 WHERE id=?1').bind(id, now).run();
    return json({ ok: true }, 200, origin);
  }
  if (sub === 'versions' && m === 'GET' && !vidStr) {
    const rows = await env.DB.prepare('SELECT vid, name, author, item_count, saved_at FROM plan_versions WHERE plan_id=?1 ORDER BY vid DESC LIMIT 200').bind(id).all();
    return json({ versions: rows.results || [] }, 200, origin);
  }
  if (sub === 'versions' && m === 'GET' && vidStr) {
    const v = await env.DB.prepare('SELECT vid, name, author, data, item_count, saved_at FROM plan_versions WHERE plan_id=?1 AND vid=?2').bind(id, Number(vidStr)).first();
    if (!v) return json({ error: '找不到這個版本' }, 404, origin);
    return json({ id, name: v.name, vid: v.vid, author: v.author, saved_at: v.saved_at, data: JSON.parse(v.data) }, 200, origin);
  }
  return json({ error: '不支援的操作' }, 405, origin);
}

export default {
  async fetch(req, env) {
    const origin = req.headers.get('Origin') || '';
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin) });
    try { return await handle(req, env, origin); }
    catch (e) { return json({ error: e.message || '伺服器錯誤' }, e.status || 500, origin); }
  },
};
