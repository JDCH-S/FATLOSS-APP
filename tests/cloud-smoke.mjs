// Two browser tabs against one fake claude.ai `db` (and `downloads`) capability: data loads from the cloud,
// entries written in one tab appear live in the other, a stale tab never overwrites newer entries, and a
// reload shows everything. Run: node tests/cloud-smoke.mjs
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch (e) { ({ chromium } = require('/opt/node22/lib/node_modules/playwright')); }
const here = dirname(fileURLToPath(import.meta.url));
const pageUrl = pathToFileURL(join(here, '..', 'app', 'index.html')).href;

// ---------- fake server ----------
const docs = new Map();           // path -> body
const subs = [];                  // {page, id, path, kind: 'doc' | 'col'}
const saved = [];                 // downloads
const clone = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));
const isObj = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
function deepMerge(a, b) {
  const out = Object.assign({}, a);
  Object.keys(b).forEach((k) => { out[k] = isObj(b[k]) && isObj(out[k]) ? deepMerge(out[k], b[k]) : b[k]; });
  return out;
}
const parent = (p) => p.split('/').slice(0, -1).join('/');
function listing(col) {
  return [...docs.keys()].filter((p) => parent(p) === col).sort().map((p) => ({ path: p, exists: true, data: clone(docs.get(p)) }));
}
function notify(path) {
  subs.forEach((s) => {
    const payload = s.kind === 'doc' ? (s.path === path ? { path, exists: docs.has(path), data: clone(docs.get(path)) } : null)
      : (parent(path) === s.path ? listing(s.path) : null);
    if (payload !== null) s.page.evaluate(([id, snap]) => window.__dbNotify(id, snap), [s.id, payload]).catch(() => {});
  });
}
async function dbCall(source, op, path, body) {
  const page = source.page;
  switch (op) {
    case 'get': return { path, exists: docs.has(path), data: clone(docs.get(path)) };
    case 'list': return listing(path);
    case 'set': docs.set(path, clone(body)); notify(path); return null;
    case 'update':
      if (!docs.has(path)) return { error: { code: 'invalid_argument', message: 'update: document does not exist' } };
      docs.set(path, deepMerge(docs.get(path), clone(body))); notify(path); return null;
    case 'delete': docs.delete(path); notify(path); return null;
    case 'sub': subs.push({ page, id: body.id, path, kind: body.kind });
      setTimeout(() => {
        const snap = body.kind === 'doc' ? { path, exists: docs.has(path), data: clone(docs.get(path)) } : listing(path);
        page.evaluate(([id, s]) => window.__dbNotify(id, s), [body.id, snap]).catch(() => {});
      }, 10);
      return null;
    case 'download': saved.push(body); return null;
    default: return { error: { code: 'invalid_argument', message: 'unknown op ' + op } };
  }
}

// ---------- browser side (runs before the app's scripts) ----------
function fakeClaude() {
  const listeners = {};
  let next = 1;
  window.__dbNotify = (id, snap) => { if (listeners[id]) listeners[id](snap); };
  const call = async (op, path, body) => {
    const r = await window.__db(op, path, body);
    if (r && r.error) throw r.error;
    return r;
  };
  const meta = { fromCache: false, hasPendingWrites: false };
  const docSnap = (r) => Object.freeze({ id: r.path.split('/').pop(), exists: r.exists, data: () => r.data, metadata: meta });
  const qSnap = (rs) => { const d = rs.map(docSnap); return { docs: d, size: d.length, empty: !d.length, docChanges: () => [], metadata: meta }; };
  function docRef(path) {
    return {
      id: path.split('/').pop(), path,
      get: async () => docSnap(await call('get', path)),
      set: (b) => call('set', path, b), update: (b) => call('update', path, b), delete: () => call('delete', path),
      onSnapshot: (nx) => { const id = next++; listeners[id] = (s) => nx(docSnap(s)); call('sub', path, { id, kind: 'doc' }); return () => { delete listeners[id]; }; },
      collection: (sub) => colRef(path + '/' + sub)
    };
  }
  function colRef(path) {
    const q = {
      path, doc: (id) => docRef(path + '/' + id),
      get: async () => qSnap(await call('list', path)),
      onSnapshot: (nx) => { const id = next++; listeners[id] = (s) => nx(qSnap(s)); call('sub', path, { id, kind: 'col' }); return () => { delete listeners[id]; }; },
      where: () => q, orderBy: () => q, limit: () => q
    };
    return q;
  }
  const db = Object.freeze({ doc: docRef, collection: colRef });
  const downloads = Object.freeze({ save: async (r) => { await call('download', '', { filename: r.filename, size: String(r.data).length }); return { status: 'saved' }; } });
  window.claude = { use: async (name) => (name === 'db' ? db : name === 'downloads' ? downloads : null) };
}

// ---------- test ----------
const checks = [];
const errors = [];
function check(name, ok, detail) { checks.push({ name, ok: !!ok }); if (!ok) console.log('FAIL', name, detail === undefined ? '' : detail); }
const iso = (d) => d.toISOString().slice(0, 10);
const today = new Date(Date.UTC(new Date().getFullYear(), new Date().getMonth(), new Date().getDate()));
const dayIso = (n) => { const d = new Date(today); d.setUTCDate(d.getUTCDate() - n); return iso(d); };

const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
const context = await browser.newContext({ viewport: { width: 1100, height: 900 } });
await context.exposeBinding('__db', (source, op, path, body) => dbCall(source, op, path, body));
await context.addInitScript(fakeClaude);

async function openTab() {
  const p = await context.newPage();
  p.on('pageerror', (e) => { errors.push(e.message); console.log('PAGE ERROR', e.message); });
  p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) { errors.push(m.text()); console.log('CONSOLE ERROR', m.text()); } });
  await p.goto(pageUrl);
  await p.waitForFunction(() => /Saved to your Claude account|Saving/.test(document.getElementById('save-state').textContent), null, { timeout: 15000 });
  return p;
}
async function logDay(p, date, kg) {
  await p.click('#tab-log');
  await p.fill('#log-date', date);
  await p.press('#log-date', 'Enter');
  await p.fill('#log-weight', String(kg));
  await p.fill('#log-kcal', '2111');
  await p.press('#log-kcal', 'Enter');
  await p.waitForTimeout(80);
}
const cloudDays = () => Object.entries((docs.get('logs/' + dayIso(0).slice(0, 4)) || {}).days || {}).filter(([, v]) => v !== null).map(([k]) => k).sort();

const A = await openTab();
check('tab A says it saves to the Claude account', /Claude account/.test(await A.locator('#save-state').textContent()));
await A.click('#tab-plan');
await A.click('#plan-generate');
await logDay(A, dayIso(0), 84.4);
await A.evaluate(() => new Promise((r) => setTimeout(r, 900)));
check('A: today\'s entry is in the cloud', cloudDays().includes(dayIso(0)), cloudDays());
check('A: plan document written', !!(docs.get('fl/plan') || {}).plan);

const B = await openTab();
await B.click('#tab-log');
await B.waitForTimeout(150);
check('B loads A\'s entry from the cloud', await B.locator('td.n:has-text("84.4")').count() > 0);
await logDay(B, dayIso(1), 84.9);
await B.waitForTimeout(1000);
check('B: yesterday is in the cloud', cloudDays().includes(dayIso(1)), cloudDays());
await A.click('#tab-log');
await A.waitForTimeout(200);
check('A shows B\'s entry live (no reload)', await A.locator('td.n:has-text("84.9")').count() > 0);

// A writes another day; nothing B wrote may be lost
await logDay(A, dayIso(2), 85.3);
await A.waitForTimeout(1000);
check('no entry lost after both tabs wrote', [dayIso(0), dayIso(1), dayIso(2)].every((d) => cloudDays().includes(d)), cloudDays());

// Deleting in B removes it everywhere
await B.click('#tab-log');
await B.waitForTimeout(100);
await B.click(`#log-del-${dayIso(2)}`);
await B.click('#confirm-yes');
await B.waitForTimeout(1000);
check('delete reaches the cloud', !cloudDays().includes(dayIso(2)), cloudDays());

await A.reload();
await A.waitForFunction(() => /Claude account/.test(document.getElementById('save-state').textContent), null, { timeout: 15000 });
await A.click('#tab-log');
await A.waitForTimeout(150);
check('after reload A has both remaining entries', (await A.locator('td.n:has-text("84.4")').count()) > 0 && (await A.locator('td.n:has-text("84.9")').count()) > 0);
check('after reload the deleted entry stays deleted', (await A.locator('td.n:has-text("85.3")').count()) === 0);

// Downloads go through the capability
await A.click('#tab-groceries');
await A.click('#groc-export');
await A.waitForTimeout(300);
check('export uses the downloads capability', saved.some((s) => /^grocery-list-.*\.json$/.test(s.filename)), JSON.stringify(saved));
check('no fallback textarea when downloads work', (await A.locator('#export-text').count()) === 0);

await browser.close();
const failed = checks.filter((c) => !c.ok);
console.log(`${checks.length - failed.length}/${checks.length} cloud checks passed, ${errors.length} page errors.`);
process.exit(failed.length || errors.length ? 1 : 0);
