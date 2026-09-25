'use strict';
// Unit tests for app/js/store.js (SPEC §7). Run: node --test tests/
// Each "tab" is a fresh copy of store.js with its own fake window: window.claude.use('db') returns a client of one
// shared in-memory store that follows db.d.ts (set replaces, update merges nested objects and needs an existing
// document, 256 KiB per document, onSnapshot with hasPendingWrites for the writer's own unconfirmed write), plus a
// fake localStorage and a fake clock for the store's timers.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const STORE_PATH = path.join(__dirname, '..', 'app', 'js', 'store.js');

// ---------- fakes ----------
const settle = function () { return new Promise(function (r) { setImmediate(r); }); };
function isObj(x) { return !!x && typeof x === 'object' && !Array.isArray(x); }
function deepFreeze(o) { if (o && typeof o === 'object') { Object.freeze(o); Object.values(o).forEach(deepFreeze); } return o; }
function deepMerge(a, b) {
  const out = Object.assign({}, a);
  Object.keys(b).forEach(function (k) { out[k] = isObj(out[k]) && isObj(b[k]) ? deepMerge(out[k], b[k]) : b[k]; });
  return out;
}
function parentOf(p) { return p.split('/').slice(0, -1).join('/'); }
function checkPath(p, even) {
  const s = String(p).split('/');
  if (s.some(function (x) { return !/^[A-Za-z0-9_\-.~:@+]+$/.test(x) || x === '.' || x === '..'; })) throw new TypeError('bad segment in ' + p);
  if ((s.length % 2 === 0) !== even) throw new TypeError('wrong segment count (' + s.length + ') for ' + p);
}

function makeClock() {
  let now = 0, seq = 0;
  const q = new Map();
  return {
    setTimeout: function (fn, ms) { const id = ++seq; q.set(id, { at: now + (ms || 0), fn: fn, id: id }); return id; },
    clearTimeout: function (id) { q.delete(id); },
    advance: async function (ms) {
      const end = now + ms;
      for (;;) {
        await settle();
        let next = null;
        for (const t of q.values()) if (t.at <= end && (!next || t.at < next.at || (t.at === next.at && t.id < next.id))) next = t;
        if (!next) break;
        q.delete(next.id); now = next.at; next.fn();
      }
      now = end;
      await settle();
    }
  };
}

function makeServer() {
  const docs = new Map();   // path -> JSON
  const clients = [];
  const log = [];           // every call: {op, path, body, tab}
  let faults = [];
  let gate = null;
  let inflight = 0, maxInflight = 0;
  const server = {
    docs: docs, log: log,
    maxInflight: function () { return maxInflight; },
    get: function (p) { return docs.has(p) ? JSON.parse(docs.get(p)) : undefined; },
    put: function (p, body) { docs.set(p, JSON.stringify(body)); },
    fail: function (op, re, code, times, message) { faults.push({ op: op, re: re, code: code, times: times == null ? Infinity : times, message: message || code }); },
    clearFaults: function () { faults = []; },
    hold: function () { let open; gate = new Promise(function (r) { open = r; }); return function () { gate = null; open(); }; },
    writes: function (tab) { return log.filter(function (c) { return /^(set|update|delete)$/.test(c.op) && (!tab || c.tab === tab); }); },
    client: client
  };
  function fault(op, p) {
    const f = faults.find(function (x) { return (x.op === op || x.op === '*') && x.re.test(p) && x.times > 0; });
    if (!f) return null;
    f.times--;
    return { code: f.code, message: f.message };
  }
  function snap(p, body, pending) {
    const data = body === undefined ? undefined : deepFreeze(JSON.parse(JSON.stringify(body)));
    return { id: p.split('/').pop(), exists: data !== undefined, data: function () { return data; }, metadata: { fromCache: false, hasPendingWrites: !!pending } };
  }
  function client(name, opts) {
    opts = opts || {};
    const subs = [];
    // overlay: this client's unconfirmed write {path, body}, shown only to this client with hasPendingWrites.
    function deliver(changedPath, overlay) {
      if (opts.deaf) return;
      subs.forEach(function (sub) {
        if (sub.dead) return;
        if (sub.doc) {
          if (sub.path !== changedPath) return;
          const pend = !!overlay && overlay.path === sub.path;
          sub.next(snap(sub.path, pend ? overlay.body : server.get(sub.path), pend));
        } else {
          if (parentOf(changedPath) !== sub.path) return;
          const paths = Array.from(docs.keys()).filter(function (p) { return parentOf(p) === sub.path; });
          if (overlay && parentOf(overlay.path) === sub.path && paths.indexOf(overlay.path) < 0) paths.push(overlay.path);
          const ds = paths.sort().map(function (p) {
            const pend = !!overlay && overlay.path === p;
            return snap(p, pend ? overlay.body : server.get(p), pend);
          }).filter(function (d) { return d.exists; });
          sub.next({ docs: ds, size: ds.length, empty: !ds.length, docChanges: function () { return []; },
            metadata: { fromCache: false, hasPendingWrites: ds.some(function (d) { return d.metadata.hasPendingWrites; }) } });
        }
      });
    }
    function broadcast(p, overlay) { clients.forEach(function (c) { c.deliver(p, c === self ? overlay : null); }); }
    async function write(op, p, body) {
      log.push({ op: op, path: p, body: body === undefined ? undefined : JSON.parse(JSON.stringify(body)), tab: name });
      const before = server.get(p);
      const after = op === 'set' ? body : op === 'update' && before !== undefined ? deepMerge(before, body) : undefined;
      if (after !== undefined) deliver(p, { path: p, body: after });
      inflight++; maxInflight = Math.max(maxInflight, inflight);
      try {
        await Promise.resolve();
        if (gate) await gate;
        const f = fault(op, p);
        if (f) { deliver(p, null); throw f; }
        if (op === 'update' && before === undefined) throw { code: 'invalid_argument', message: 'update() needs an existing document' };
        if (op === 'delete') docs.delete(p);
        else {
          const json = JSON.stringify(after);
          if (Buffer.byteLength(json) > 256 * 1024) { deliver(p, null); throw { code: 'invalid_argument', message: 'document over 256 KiB' }; }
          docs.set(p, json);
        }
      } finally { inflight--; }
      broadcast(p, null);
    }
    function docRef(p) {
      checkPath(p, true);
      return {
        id: p.split('/').pop(), path: p,
        get: async function () {
          log.push({ op: 'get', path: p, tab: name });
          await Promise.resolve();
          const f = fault('get', p); if (f) throw f;
          return snap(p, server.get(p), false);
        },
        set: function (data) { return write('set', p, data); },
        update: function (data) { return write('update', p, data); },
        delete: function () { return write('delete', p); },
        onSnapshot: function (next) {
          const sub = { doc: true, path: p, next: next };
          subs.push(sub);
          Promise.resolve().then(function () { if (!opts.deaf) next(snap(p, server.get(p), false)); });
          return function () { sub.dead = true; };
        }
      };
    }
    function colRef(p) {
      checkPath(p, false);
      return {
        path: p,
        doc: function (id) { return docRef(p + '/' + id); },
        get: async function () {
          log.push({ op: 'query', path: p, tab: name });
          await Promise.resolve();
          const f = fault('query', p); if (f) throw f;
          const ds = Array.from(docs.keys()).filter(function (k) { return parentOf(k) === p; }).sort().map(function (k) { return snap(k, server.get(k), false); });
          return { docs: ds, size: ds.length, empty: !ds.length, docChanges: function () { return []; }, metadata: { fromCache: false, hasPendingWrites: false } };
        },
        onSnapshot: function (next) {
          const sub = { doc: false, path: p, next: next };
          subs.push(sub);
          Promise.resolve().then(function () { deliver(p + '/x', null); });
          return function () { sub.dead = true; };
        }
      };
    }
    const self = { deliver: deliver, db: Object.freeze({ doc: docRef, collection: colRef }) };
    clients.push(self);
    return self.db;
  }
  return server;
}

function makeLocalStorage(opts) {
  opts = opts || {};
  const m = new Map();
  return {
    getItem: function (k) { return m.has(k) ? m.get(k) : null; },
    setItem: function (k, v) { if (opts.throwSet) throw new Error('QuotaExceededError'); m.set(k, String(v)); }
  };
}

// One browser's localStorage seen from several tabs: each tab gets its own view, and a write from one view is
// delivered to the other tabs' windows as a 'storage' event (a later task, as in browsers). hold() queues the events
// (a tab that has not heard of another tab's writes yet) until the returned function is called.
function makeSharedStorage() {
  const m = new Map(), views = [];
  let queue = null;
  function deliver(ev, from) {
    views.forEach(function (v) { if (v !== from && v.win) v.win.dispatch('storage', ev); });
  }
  return {
    map: m,
    hold: function () { queue = []; return function () { const q = queue; queue = null; q.forEach(function (x) { deliver(x.ev, x.from); }); }; },
    view: function () {
      const v = {
        win: null,
        getItem: function (k) { return m.has(k) ? m.get(k) : null; },
        setItem: function (k, val) {
          const old = m.has(k) ? m.get(k) : null;
          m.set(k, String(val));
          const ev = { type: 'storage', key: k, oldValue: old, newValue: String(val) };
          if (queue) queue.push({ ev: ev, from: v }); else setImmediate(function () { deliver(ev, v); });
        }
      };
      views.push(v);
      return v;
    }
  };
}

function makeWindow(clock, db, ls) {
  const handlers = {};
  const doc = { visibilityState: 'visible', handlers: {}, addEventListener: function (t, f) { (doc.handlers[t] = doc.handlers[t] || []).push(f); } };
  return {
    claude: { use: async function (name) { return name === 'db' ? db : null; } },
    localStorage: ls,
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    addEventListener: function (t, f) { (handlers[t] = handlers[t] || []).push(f); },
    document: doc,
    fire: function (t) { (handlers[t] || []).forEach(function (f) { f({ type: t }); }); },
    dispatch: function (t, ev) { (handlers[t] || []).forEach(function (f) { f(ev); }); },
    hide: function () { doc.visibilityState = 'hidden'; (doc.handlers.visibilitychange || []).forEach(function (f) { f(); }); }
  };
}

// A fresh store.js bound to its own window, like one browser tab.
function openTab(env, name, opts) {
  opts = opts || {};
  const db = opts.noDb ? null : env.server.client(name, opts);
  const clock = opts.clock || env.clock;
  const win = makeWindow(clock, db, opts.ls || env.ls);
  if (win.localStorage && 'win' in win.localStorage) win.localStorage.win = win;
  delete require.cache[require.resolve(STORE_PATH)];
  global.window = win;
  let S;
  try { S = require(STORE_PATH); } finally { delete global.window; }
  const tab = { name: name, S: S, win: win, clock: clock, state: null, statuses: [], remotes: [] };
  S.onStatus(function (st, msg) { tab.statuses.push(msg ? st + ': ' + msg : st); });
  S.onRemote(function (section, value) { tab.remotes.push({ section: section, value: value }); });
  return tab;
}
async function load(env, tab) {
  const p = tab.S.load(defaults());
  await tab.clock.advance(20000);
  tab.res = await p;
  tab.state = tab.res.state;
  return tab.res;
}
function lastStatus(tab) { return tab.statuses[tab.statuses.length - 1]; }
function newEnv() { return { clock: makeClock(), server: makeServer(), ls: makeLocalStorage() }; }

function defaults() {
  return {
    version: 1,
    setup: {
      isExample: true, weightKg: 85, heightCm: 180, age: 35, bodyFatPct: 20,
      goalType: 'bf', goalBodyFatPct: 12, goalWeightKg: null,
      steps: 8000, liftDays: [1, 3, 5], padelDays: [2, 6], liftMinutes: 60, padelMinutes: 90,
      mealsPerDay: 4, saturdayMode: 'offplan', programStart: '2026-09-26',
      likedFoods: ['chicken_breast'], excludedFoods: [], customFoods: []
    },
    logs: {}, checkins: {}, plan: null, program: null,
    products: [{ id: 'colruyt-oats', store: 'Colruyt', foodId: 'oats', product: 'Oats', ean: '', packSizeG: 500, price: 1.5, promo: false, date: null }],
    priceMeta: { lastImport: null, lastImportFile: null, lastImportSummary: null, unmatched: [] }
  };
}
function cloudSetup(over) { return Object.assign({}, defaults().setup, { isExample: false, weightKg: 92 }, over || {}); }
function entry(kg) { return { weight: kg, kcal: 2100, protein: 180, steps: 9000 }; }
function days(server, year) { return (server.get('logs/' + (year || '2026')) || {}).days || {}; }
function liveKeys(obj) { return Object.keys(obj || {}).filter(function (k) { return obj[k] !== null; }).sort(); }
// A check-in record of about 2.7 KB, like engine.computeCheckin produces.
function checkinRecord(week, n) {
  return { weekStart: week, computedOn: week, valid: true, cur: { avgWeight: 90 - n / 10, days: Array(7).fill({ w: 90, kcal: 2100, steps: 9000 }) },
    prev: { avgWeight: 90 }, next: { kcal: 2300 - n, protein: 180, fat: 60, carbs: 250 }, notes: ['x'.repeat(2000)] };
}
function addDays(iso, n) { return new Date(Date.parse(iso + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10); }

// ---------- finding 1: stale tabs and devices ----------
test('a tab left open that saves one day keeps the days another device saved (logs and check-ins)', async function () {
  const env = newEnv();
  env.server.put('fl/setup', cloudSetup());
  env.server.put('logs/2026', { days: { '2026-09-19': entry(90) } });
  // The laptop never receives snapshots, so only the per-entry writes can protect the phone's days.
  const laptop = openTab(env, 'laptop', { deaf: true, ls: makeLocalStorage() });
  const phone = openTab(env, 'phone', { ls: makeLocalStorage() });
  await load(env, laptop); await load(env, phone);
  for (let d = 20; d <= 24; d++) {
    phone.state.logs['2026-09-' + d] = entry(90 - d / 10);
    phone.S.save('logs', phone.state);
    await env.clock.advance(700);
  }
  phone.state.checkins['2026-09-12'] = { weekStart: '2026-09-12', next: { kcal: 2400 } };
  phone.S.save('checkins', phone.state);
  await env.clock.advance(700);

  laptop.state.logs['2026-09-25'] = entry(87.4);
  laptop.S.save('logs', laptop.state);
  laptop.state.checkins['2026-09-19'] = { weekStart: '2026-09-19', next: { kcal: 2300 } };
  laptop.S.save('checkins', laptop.state);
  await env.clock.advance(700);

  assert.deepEqual(liveKeys(days(env.server)), ['2026-09-19', '2026-09-20', '2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25']);
  assert.deepEqual(liveKeys(env.server.get('checkins/2026').records), ['2026-09-12', '2026-09-19']);
  assert.equal(env.server.get('fl/checkins'), undefined);
  assert.ok(env.server.writes('laptop').filter(function (w) { return /^(logs|checkins)\//.test(w.path); }).every(function (w) { return w.op === 'update'; }));
  assert.deepEqual(env.server.writes('laptop').find(function (w) { return w.path === 'logs/2026'; }).body, { days: { '2026-09-25': entry(87.4) } });
});

test('other tabs\' changes reach an open tab through onRemote; its own echoes and unsaved edits are kept', async function () {
  const env = newEnv();
  const older = cloudSetup();
  delete older.customFoods;   // saved before that field existed: the defaults fill it in
  env.server.put('fl/setup', older);
  const a = openTab(env, 'a', { ls: makeLocalStorage() });
  const b = openTab(env, 'b', { ls: makeLocalStorage() });
  await load(env, a); await load(env, b);
  assert.deepEqual(a.remotes, [], 'the first snapshots after load change nothing');

  a.state.logs['2026-09-20'] = entry(91);
  a.S.save('logs', a.state);
  await env.clock.advance(700);
  assert.deepEqual(a.remotes, [], 'a tab is not told about its own write');
  assert.deepEqual(Object.keys(b.state.logs), ['2026-09-20'], 'the store merges the change into the other tab\'s state');
  assert.equal(b.remotes.length, 1);
  assert.equal(b.remotes[0].section, 'logs');
  assert.equal(b.remotes[0].value, b.state.logs);

  // b has unsaved edits (still in the debounce) when a's 22nd arrives: b keeps its own and gains a's.
  b.state.logs['2026-09-20'] = entry(90.9);
  b.state.logs['2026-09-21'] = entry(90.5);
  b.S.save('logs', b.state);
  a.state.logs['2026-09-22'] = entry(90.2);
  a.S.save('logs', a.state);
  await a.S.flush();
  await settle();
  assert.equal(days(env.server)['2026-09-20'].weight, 91);
  assert.deepEqual(Object.keys(b.state.logs).sort(), ['2026-09-20', '2026-09-21', '2026-09-22']);
  assert.equal(b.state.logs['2026-09-20'].weight, 90.9);
  await env.clock.advance(700);
  assert.deepEqual(Object.keys(a.state.logs).sort(), ['2026-09-20', '2026-09-21', '2026-09-22']);
  assert.equal(a.state.logs['2026-09-20'].weight, 90.9);
  assert.deepEqual(liveKeys(days(env.server)), ['2026-09-20', '2026-09-21', '2026-09-22']);
  assert.equal(days(env.server)['2026-09-20'].weight, 90.9);

  b.state.setup = Object.assign({}, b.state.setup, { weightKg: 90 });
  b.S.save('setup', b.state);
  await env.clock.advance(700);
  const last = a.remotes[a.remotes.length - 1];
  assert.equal(last.section, 'setup');
  assert.equal(last.value.weightKg, 90);
  assert.equal(a.state.setup.weightKg, 90);
  assert.equal(env.server.writes().filter(function (w) { return w.path === 'fl/setup'; }).length, 1, 'no tab writes a remote change back');

  // a's unsaved Setup edit is not replaced by b's that lands first; a's whole document is written after it.
  a.state.setup.steps = 12000;
  a.S.save('setup', a.state);
  b.state.setup = Object.assign({}, b.state.setup, { age: 40 });
  b.S.save('setup', b.state);
  await b.S.flush();
  await settle();
  assert.equal(a.state.setup.steps, 12000);
  await env.clock.advance(700);
  assert.equal(env.server.get('fl/setup').steps, 12000);
  assert.equal(b.state.setup.steps, 12000);
});

test('a deleted entry is written as null and is absent after a reload and in other tabs', async function () {
  const env = newEnv();
  env.server.put('fl/setup', cloudSetup());
  env.server.put('logs/2026', { days: { '2026-09-19': entry(90), '2026-09-20': entry(89.8) } });
  const a = openTab(env, 'a', { ls: makeLocalStorage() });
  const b = openTab(env, 'b', { ls: makeLocalStorage() });
  await load(env, a); await load(env, b);
  delete a.state.logs['2026-09-19'];
  a.S.save('logs', a.state);
  await env.clock.advance(700);
  assert.equal(days(env.server)['2026-09-19'], null);
  assert.deepEqual(Object.keys(b.state.logs), ['2026-09-20']);
  const c = openTab(env, 'c', { ls: makeLocalStorage() });
  await load(env, c);
  assert.deepEqual(Object.keys(c.state.logs), ['2026-09-20']);
});

test('re-saving an entry replaces it: members it no longer has do not survive the merge, and nothing is rewritten', async function () {
  const env = newEnv();
  env.server.put('fl/setup', cloudSetup());
  env.server.put('checkins/2026', { records: { '2026-09-19': { weekStart: '2026-09-19', cur: { avg: 90, extra: 1 }, notes: ['old'] } } });
  const a = openTab(env, 'a', { ls: makeLocalStorage() });
  await load(env, a);
  a.state.checkins['2026-09-19'] = { weekStart: '2026-09-19', cur: { avg: 89 } };
  a.S.save('checkins', a.state);
  await env.clock.advance(700);
  const rec = env.server.get('checkins/2026').records['2026-09-19'];
  assert.equal(rec.cur.avg, 89);
  assert.equal(rec.cur.extra, null);
  assert.equal(rec.notes, null);
  const before = env.server.writes().length;
  a.S.save('checkins', a.state);
  await env.clock.advance(5000);
  assert.equal(env.server.writes().length, before);
  assert.equal(lastStatus(a), 'saved');
});

test('one write in flight per document; changes made meanwhile follow in one more write', async function () {
  const env = newEnv();
  env.server.put('fl/setup', cloudSetup());
  env.server.put('logs/2026', { days: {} });
  const a = openTab(env, 'a');
  await load(env, a);
  const release = env.server.hold();
  a.state.logs['2026-09-20'] = entry(91);
  a.S.save('logs', a.state);
  await env.clock.advance(700);
  a.state.logs['2026-09-21'] = entry(90.8);
  a.S.save('logs', a.state);
  a.state.logs['2026-09-22'] = entry(90.6);
  a.S.save('logs', a.state);
  await env.clock.advance(700);
  assert.equal(env.server.writes().length, 1);
  release();
  await env.clock.advance(700);
  assert.equal(env.server.maxInflight(), 1);
  assert.equal(env.server.writes().length, 2);
  assert.deepEqual(liveKeys(days(env.server)), ['2026-09-20', '2026-09-21', '2026-09-22']);
});

// ---------- findings 20 and 38: check-in document size ----------
test('two years of check-ins are stored per year and no document reaches the 256 KiB limit', async function () {
  const env = newEnv();
  env.server.put('fl/setup', cloudSetup());
  const a = openTab(env, 'a');
  await load(env, a);
  let week = '2026-09-26';
  for (let n = 0; n < 110; n++, week = addDays(week, 7)) {
    a.state.checkins[week] = checkinRecord(week, n);
    a.S.save('checkins', a.state);
    await env.clock.advance(700);
    assert.equal(lastStatus(a), 'saved', 'check-in ' + n);
  }
  const paths = Array.from(env.server.docs.keys()).filter(function (p) { return /^checkins\//.test(p); }).sort();
  assert.deepEqual(paths, ['checkins/2026', 'checkins/2027', 'checkins/2028']);
  paths.forEach(function (p) { assert.ok(Buffer.byteLength(env.server.docs.get(p)) < 256 * 1024, p); });
  const b = openTab(env, 'b', { ls: makeLocalStorage() });
  await load(env, b);
  assert.equal(Object.keys(b.state.checkins).length, 110);
});

test('the old single fl/checkins document is migrated to per-year documents and deleted', async function () {
  const env = newEnv();
  env.server.put('fl/setup', cloudSetup());
  env.server.put('fl/checkins', { records: { '2026-09-19': { v: 'legacy 19' }, '2026-09-26': { v: 'legacy 26' }, '2027-01-02': { v: 'legacy 2027' }, '2026-10-03': { v: 'deleted later' } } });
  env.server.put('checkins/2026', { records: { '2026-09-26': { v: 'newer 26' }, '2026-10-03': null } });
  const a = openTab(env, 'a');
  await load(env, a);
  assert.deepEqual(a.state.checkins, { '2026-09-19': { v: 'legacy 19' }, '2026-09-26': { v: 'newer 26' }, '2027-01-02': { v: 'legacy 2027' } });
  await env.clock.advance(700);
  assert.equal(env.server.get('fl/checkins'), undefined);
  assert.deepEqual(env.server.get('checkins/2026').records, { '2026-09-19': { v: 'legacy 19' }, '2026-09-26': { v: 'newer 26' }, '2026-10-03': null });
  assert.deepEqual(env.server.get('checkins/2027').records, { '2027-01-02': { v: 'legacy 2027' } });
});

test('a rejected write names its real cause: the size limit, or read-only access', async function () {
  const env = newEnv();
  env.server.put('fl/setup', cloudSetup());
  const a = openTab(env, 'a');
  await load(env, a);
  a.state.products = Array.from({ length: 1200 }, function (_, i) { return { id: 'p' + i, product: 'x'.repeat(250) }; });
  a.S.save('products', a.state);
  await env.clock.advance(700);
  assert.match(lastStatus(a), /^error: .*256 KiB/);
  assert.doesNotMatch(lastStatus(a), /read-only/);

  const b = openTab(env, 'b', { ls: makeLocalStorage() });
  await load(env, b);
  env.server.fail('set', /^fl\/setup$/, 'invalid_argument');
  b.state.setup.steps = 9000;
  b.S.save('setup', b.state);
  await env.clock.advance(700);
  assert.match(lastStatus(b), /^error: .*read-only/);
});

// ---------- finding 21: read errors at load ----------
test('a transient read error at load is retried and the cloud data is used', async function () {
  const env = newEnv();
  env.server.put('fl/setup', cloudSetup());
  env.server.put('logs/2026', { days: { '2026-09-24': entry(91) } });
  env.server.fail('query', /^fl$/, 'unavailable', 1);
  const a = openTab(env, 'a');
  const res = await load(env, a);
  assert.equal(res.backend, 'cloud');
  assert.equal(res.readOnly, false);
  assert.equal(res.error, null);
  assert.equal(res.state.setup.weightKg, 92);
  assert.deepEqual(Object.keys(res.state.logs), ['2026-09-24']);
});

test('reads that keep failing give a device-only session: never writes the cloud, keeps changes in this browser, says so', async function () {
  const env = newEnv();
  env.server.put('fl/setup', cloudSetup());
  env.server.fail('query', /^logs$/, 'unavailable');
  const a = openTab(env, 'a');
  const res = await load(env, a);
  assert.equal(res.readOnly, true);
  assert.equal(res.mode, 'device-only');
  assert.equal(res.backend, 'cloud');
  assert.equal(a.S.mode(), 'device-only');
  assert.match(res.error, /^Could not load your saved data \(unavailable\)\. Changes are saved on this device only and sync after a successful reload\.$/);
  a.state.logs['2026-09-25'] = entry(90);
  a.S.save('logs', a.state);
  a.S.save('setup', a.state);
  await env.clock.advance(5000);
  assert.equal(await a.S.flush(), false, 'not stored in the account');
  assert.equal(lastStatus(a), 'error: Saved on this device only: your account could not be reached. It syncs after a successful reload.');
  assert.ok(a.statuses.every(function (st) { return /^error: Saved on this device only/.test(st); }), a.statuses.join(' | '));
  assert.deepEqual(env.server.writes(), []);
  assert.equal(env.server.get('fl/setup').weightKg, 92);
  assert.deepEqual(Object.keys(JSON.parse(env.ls.getItem('fatloss-app-v1')).logs), ['2026-09-25']);
  assert.deepEqual(JSON.parse(env.ls.getItem('fatloss-app-v1-pending')).logs['2026-09-25'], { v: entry(90), b: null });
});

test('device-only changes reach the cloud on the next load that reads it; the cloud\'s newer values win', async function () {
  const env = newEnv();
  env.server.put('fl/setup', cloudSetup());
  env.server.put('logs/2026', { days: { '2026-09-23': entry(91.4), '2026-09-24': entry(91.2) } });
  const first = openTab(env, 'first');
  await load(env, first);   // a healthy visit leaves this browser's copy in step with the cloud

  env.server.fail('*', /.*/, 'unavailable');
  const ro = openTab(env, 'ro');
  const res = await load(env, ro);
  assert.equal(res.mode, 'device-only');
  assert.deepEqual(Object.keys(res.state.logs).sort(), ['2026-09-23', '2026-09-24'], 'the browser copy is shown');
  ro.state.logs['2026-09-25'] = entry(91.1);                       // new day
  ro.state.logs['2026-09-24'] = entry(91);                         // edited here, and on another device meanwhile
  ro.S.save('logs', ro.state);
  ro.state.checkins['2026-09-19'] = { weekStart: '2026-09-19', next: { kcal: 2300 } };
  ro.S.save('checkins', ro.state);
  ro.state.setup = Object.assign({}, ro.state.setup, { steps: 10500 });
  ro.S.save('setup', ro.state);
  await env.clock.advance(5000);
  assert.deepEqual(env.server.writes(), []);
  env.server.clearFaults();
  env.server.put('logs/2026', { days: Object.assign(days(env.server), { '2026-09-24': entry(90.9) }) });

  const next = openTab(env, 'next');
  const res2 = await load(env, next);
  assert.equal(res2.mode, 'cloud');
  assert.deepEqual(Object.keys(res2.state.logs).sort(), ['2026-09-23', '2026-09-24', '2026-09-25']);
  assert.equal(res2.state.logs['2026-09-25'].weight, 91.1);
  assert.equal(res2.state.logs['2026-09-24'].weight, 90.9, 'the other device\'s newer value wins');
  assert.deepEqual(Object.keys(res2.state.checkins), ['2026-09-19']);
  assert.equal(res2.state.setup.steps, 10500);
  await env.clock.advance(700);
  assert.equal(days(env.server)['2026-09-25'].weight, 91.1);
  assert.equal(days(env.server)['2026-09-24'].weight, 90.9);
  assert.deepEqual(liveKeys(env.server.get('checkins/2026').records), ['2026-09-19']);
  assert.equal(env.server.get('fl/setup').steps, 10500);
  assert.equal(lastStatus(next), 'saved');
});

test('device-only mode reports when localStorage rejects the change too', async function () {
  const env = newEnv();
  env.server.put('fl/setup', cloudSetup());
  env.server.fail('query', /^fl$/, 'unavailable');
  const ls = makeLocalStorage();
  const a = openTab(env, 'a', { ls: ls });
  assert.equal((await load(env, a)).mode, 'device-only');
  ls.setItem = function () { throw new Error('QuotaExceededError'); };
  a.state.logs['2026-09-25'] = entry(90);
  a.S.save('logs', a.state);
  assert.equal(lastStatus(a), 'error: Not saved: your account could not be reached, and this browser\'s storage is full or blocked.');
});

test('mode() names the backend: cloud, browser, memory', async function () {
  const env = newEnv();
  env.server.put('fl/setup', cloudSetup());
  const c = openTab(env, 'c');
  assert.equal(c.S.mode(), 'memory', 'before load');
  assert.equal((await load(env, c)).mode, 'cloud');
  assert.equal(c.S.mode(), 'cloud');
  const b = openTab(env, 'b', { noDb: true, ls: makeLocalStorage() });
  assert.equal((await load(env, b)).mode, 'browser');
  assert.equal(b.S.mode(), 'browser');
  const m = openTab(env, 'm', { noDb: true, ls: makeLocalStorage({ throwSet: true }) });
  assert.equal((await load(env, m)).mode, 'memory');
  assert.equal(m.S.backend(), 'memory');
});

test('edits made while the db was unavailable reach the cloud on the next load, unless the cloud changed them since', async function () {
  const env = newEnv();
  env.server.put('fl/setup', cloudSetup());
  env.server.put('logs/2026', { days: { '2026-09-19': entry(90), '2026-09-20': entry(89.9), '2026-09-21': entry(89.8) } });
  const first = openTab(env, 'first');
  await load(env, first);   // leaves this browser's copy in step with the cloud

  const offline = openTab(env, 'offline', { noDb: true });
  const res = await load(env, offline);
  assert.equal(res.backend, 'browser');
  offline.state.logs['2026-09-25'] = entry(89.5);          // new day
  delete offline.state.logs['2026-09-19'];                  // deleted day
  offline.state.logs['2026-09-21'] = entry(88);            // edited here, and on another device meanwhile
  offline.S.save('logs', offline.state);
  offline.state.setup.steps = 11000;
  offline.S.save('setup', offline.state);
  env.server.put('logs/2026', { days: Object.assign(days(env.server), { '2026-09-21': entry(89.7) }) });

  const next = openTab(env, 'next');
  const res2 = await load(env, next);
  assert.equal(res2.backend, 'cloud');
  assert.deepEqual(Object.keys(res2.state.logs).sort(), ['2026-09-20', '2026-09-21', '2026-09-25']);
  assert.equal(res2.state.logs['2026-09-21'].weight, 89.7, 'the other device\'s newer value wins');
  assert.equal(res2.state.setup.steps, 11000);
  await env.clock.advance(700);
  assert.deepEqual(liveKeys(days(env.server)), ['2026-09-20', '2026-09-21', '2026-09-25']);
  assert.equal(days(env.server)['2026-09-21'].weight, 89.7);
  assert.equal(env.server.get('fl/setup').steps, 11000);
});

test('example data edited on a device without a copy never replaces the cloud setup', async function () {
  const env = newEnv();
  env.server.put('fl/setup', cloudSetup());
  const offline = openTab(env, 'offline', { noDb: true });
  await load(env, offline);
  assert.equal(offline.state.setup.weightKg, 85);
  offline.state.setup.mealsPerDay = 5;
  offline.S.save('setup', offline.state);
  offline.state.logs['2026-09-25'] = entry(89.5);
  offline.S.save('logs', offline.state);
  const next = openTab(env, 'next');
  const res = await load(env, next);
  await env.clock.advance(700);
  assert.equal(res.state.setup.weightKg, 92);
  assert.equal(env.server.get('fl/setup').mealsPerDay, 4);
  assert.deepEqual(liveKeys(days(env.server)), ['2026-09-25']);
});

// ---------- finding 22: failed writes ----------
test('a failed write keeps the error status through other saves and is retried until it succeeds', async function () {
  const env = newEnv();
  env.server.put('fl/setup', cloudSetup());
  env.server.put('logs/2026', { days: {} });
  const a = openTab(env, 'a');
  await load(env, a);
  env.server.fail('update', /^logs\//, 'resource_exhausted', Infinity, 'per-viewer call rate exceeded');
  a.state.logs['2026-09-25'] = entry(89.6);
  a.S.save('logs', a.state);
  await env.clock.advance(700);
  assert.match(lastStatus(a), /^error: .*per-viewer call rate exceeded/);
  a.state.setup.steps = 9000;
  a.S.save('setup', a.state);
  await env.clock.advance(700);
  assert.equal(env.server.get('fl/setup').steps, 9000);
  assert.match(lastStatus(a), /^error: /, 'another document\'s success does not hide the failure');
  assert.equal(a.statuses.indexOf('saved', a.statuses.length - 3), -1);
  env.server.clearFaults();
  await env.clock.advance(60000);
  assert.deepEqual(liveKeys(days(env.server)), ['2026-09-25']);
  assert.equal(lastStatus(a), 'saved');
});

test('a write that retrying cannot fix is not retried on a timer, but again on the next save', async function () {
  const env = newEnv();
  env.server.put('fl/setup', cloudSetup());
  env.server.put('logs/2026', { days: {} });
  const a = openTab(env, 'a');
  await load(env, a);
  env.server.fail('update', /^logs\//, 'quota_exceeded', 1);
  a.state.logs['2026-09-25'] = entry(89.6);
  a.S.save('logs', a.state);
  await env.clock.advance(700);
  assert.equal(lastStatus(a), 'error: Storage is full. Export a backup and delete old data.');
  const attempts = env.server.writes().length;
  await env.clock.advance(120000);
  assert.equal(env.server.writes().length, attempts);
  a.state.setup.steps = 9000;
  a.S.save('setup', a.state);
  await env.clock.advance(700);
  assert.deepEqual(liveKeys(days(env.server)), ['2026-09-25']);
  assert.equal(lastStatus(a), 'saved');
});

// ---------- findings 23 and 30: leaving the page ----------
test('pagehide and a hidden page write pending saves at once', async function () {
  const env = newEnv();
  env.server.put('fl/setup', cloudSetup());
  const a = openTab(env, 'a');
  await load(env, a);
  a.state.logs['2026-09-25'] = entry(84.3);
  a.S.save('logs', a.state);
  a.win.fire('pagehide');
  await settle();
  assert.deepEqual(liveKeys(days(env.server)), ['2026-09-25']);
  a.state.setup.weightKg = 90;
  a.S.save('setup', a.state);
  a.win.hide();
  await settle();
  assert.equal(env.server.get('fl/setup').weightKg, 90);
});

test('flush() resolves once the writes are stored, and \'saved\' comes only after them', async function () {
  const env = newEnv();
  env.server.put('fl/setup', cloudSetup());
  const a = openTab(env, 'a');
  await load(env, a);
  const release = env.server.hold();
  a.state.logs['2026-09-25'] = entry(84.3);
  a.S.save('logs', a.state);
  let done = null;
  a.S.flush().then(function (ok) { done = ok; });
  await env.clock.advance(5000);
  assert.equal(done, null);
  assert.equal(lastStatus(a), 'saving');
  release();
  await settle();
  assert.equal(done, true);
  assert.equal(lastStatus(a), 'saved');
  assert.deepEqual(liveKeys(days(env.server)), ['2026-09-25']);
});

test('in browser mode a save is in localStorage before save() returns', async function () {
  const env = newEnv();
  const a = openTab(env, 'a', { noDb: true });
  await load(env, a);
  a.state.logs['2026-09-25'] = entry(84.3);
  a.S.save('logs', a.state);
  assert.deepEqual(Object.keys(JSON.parse(env.ls.getItem('fatloss-app-v1')).logs), ['2026-09-25']);
  assert.equal(lastStatus(a), 'saved');
});

test('a change the page could not send before it closed is written by the next load', async function () {
  const env = newEnv();
  env.server.put('fl/setup', cloudSetup());
  env.server.put('logs/2026', { days: { '2026-09-24': entry(84.6) } });
  const a = openTab(env, 'a', { clock: makeClock() });
  await load(env, a);
  a.state.logs['2026-09-25'] = entry(84.3);
  a.S.save('logs', a.state);
  a.state.setup.age = 36;
  a.S.save('setup', a.state);
  // The page is gone before the debounce ends (its clock never moves again); this browser opens the app again.
  const b = openTab(env, 'b');
  const res = await load(env, b);
  assert.deepEqual(Object.keys(res.state.logs).sort(), ['2026-09-24', '2026-09-25']);
  await env.clock.advance(700);
  assert.deepEqual(liveKeys(days(env.server)), ['2026-09-24', '2026-09-25']);
  assert.equal(env.server.get('fl/setup').age, 36);
  assert.equal(env.server.writes('a').length, 0);
  const c = openTab(env, 'c');
  await load(env, c);
  await env.clock.advance(700);
  assert.equal(env.server.writes('c').length, 0, 'the journal is empty once the writes are confirmed');
});

// ---------- verification pass: two tabs sharing the browser copy (no db) ----------
test('browser mode: another tab\'s saves reach an open tab through the storage event (onRemote per section)', async function () {
  const env = newEnv();
  const shared = makeSharedStorage();
  const a = openTab(env, 'a', { noDb: true, ls: shared.view() });
  const b = openTab(env, 'b', { noDb: true, ls: shared.view() });
  await load(env, a); await load(env, b);
  assert.equal(a.res.mode, 'browser');

  b.state.logs['2026-09-24'] = entry(85.1);
  b.S.save('logs', b.state);
  await settle();
  assert.deepEqual(Object.keys(a.state.logs), ['2026-09-24']);
  assert.deepEqual(a.remotes.map(function (r) { return r.section; }), ['logs']);
  assert.equal(a.remotes[0].value, a.state.logs);
  assert.deepEqual(b.remotes, [], 'a tab is not told about its own write');

  b.state.setup = Object.assign({}, b.state.setup, { steps: 11000 });
  b.S.save('setup', b.state);
  b.state.checkins['2026-09-19'] = { weekStart: '2026-09-19', next: { kcal: 2300 } };
  b.S.save('checkins', b.state);
  await settle();
  assert.equal(a.state.setup.steps, 11000);
  assert.deepEqual(Object.keys(a.state.checkins), ['2026-09-19']);
  assert.deepEqual(a.remotes.map(function (r) { return r.section; }), ['logs', 'setup', 'checkins']);

  // A deletion travels the same way; an event that changes nothing for this tab is not reported.
  delete b.state.logs['2026-09-24'];
  b.S.save('logs', b.state);
  await settle();
  assert.deepEqual(a.state.logs, {});
  const n = a.remotes.length;
  b.S.save('plan', b.state);
  await settle();
  assert.equal(a.remotes.length, n);

  // a's own days survive b's saves, and a reload in either tab shows both tabs' work.
  a.state.logs['2026-09-25'] = entry(84.7);
  a.S.save('logs', a.state);
  await settle();
  assert.deepEqual(Object.keys(b.state.logs), ['2026-09-25']);
  const c = openTab(env, 'c', { noDb: true, ls: shared.view() });
  await load(env, c);
  assert.deepEqual(Object.keys(c.state.logs), ['2026-09-25']);
  assert.equal(c.state.setup.steps, 11000);
  assert.deepEqual(Object.keys(c.state.checkins), ['2026-09-19']);
});

test('browser mode: a tab that has not heard of another tab\'s saves never drops or reverts them when it saves', async function () {
  const env = newEnv();
  const shared = makeSharedStorage();
  const a = openTab(env, 'a', { noDb: true, ls: shared.view() });
  const b = openTab(env, 'b', { noDb: true, ls: shared.view() });
  await load(env, a); await load(env, b);
  a.state.logs['2026-09-20'] = entry(86);
  a.state.logs['2026-09-21'] = entry(85.9);
  a.S.save('logs', a.state);
  await settle();
  assert.deepEqual(Object.keys(b.state.logs).sort(), ['2026-09-20', '2026-09-21']);

  const release = shared.hold();   // a hears nothing of b's saves until release()
  b.state.logs['2026-09-24'] = entry(85.1);                  // new in b
  b.state.logs['2026-09-20'] = entry(85.8);                  // edited in b
  delete b.state.logs['2026-09-21'];                         // deleted in b
  b.S.save('logs', b.state);
  b.state.checkins['2026-09-12'] = { weekStart: '2026-09-12', next: { kcal: 2400 } };
  b.S.save('checkins', b.state);
  b.state.setup = Object.assign({}, b.state.setup, { age: 36 });
  b.S.save('setup', b.state);
  await settle();
  assert.deepEqual(Object.keys(a.state.logs).sort(), ['2026-09-20', '2026-09-21'], 'a is behind');

  a.state.logs['2026-09-25'] = entry(84.7);
  a.S.save('logs', a.state);
  a.state.checkins['2026-09-19'] = { weekStart: '2026-09-19', next: { kcal: 2300 } };
  a.S.save('checkins', a.state);
  a.state.setup.steps = 9500;
  a.S.save('setup', a.state);
  const stored = JSON.parse(shared.map.get('fatloss-app-v1'));
  assert.deepEqual(Object.keys(stored.logs).sort(), ['2026-09-20', '2026-09-24', '2026-09-25']);
  assert.equal(stored.logs['2026-09-20'].weight, 85.8, 'b\'s edit is not reverted');
  assert.deepEqual(Object.keys(stored.checkins).sort(), ['2026-09-12', '2026-09-19']);
  // Setup is one section: a's whole Setup is the newest save, as with a cloud document.
  assert.equal(stored.setup.steps, 9500);
  // a's state now holds what it merged, and the page is told.
  assert.deepEqual(Object.keys(a.state.logs).sort(), ['2026-09-20', '2026-09-24', '2026-09-25']);
  assert.equal(a.state.logs['2026-09-20'].weight, 85.8);
  assert.deepEqual(Object.keys(a.state.checkins).sort(), ['2026-09-12', '2026-09-19']);
  await settle();
  assert.deepEqual(a.remotes.map(function (r) { return r.section; }).sort(), ['checkins', 'logs']);

  // The late events change nothing more in a; b gets a's saves.
  release();
  await settle();
  assert.deepEqual(Object.keys(a.state.logs).sort(), ['2026-09-20', '2026-09-24', '2026-09-25']);
  assert.equal(a.state.setup.steps, 9500);
  assert.equal(a.remotes.length, 2);
  assert.equal(lastStatus(a), 'saved');
  assert.deepEqual(Object.keys(b.state.logs).sort(), ['2026-09-20', '2026-09-24', '2026-09-25']);
  assert.deepEqual(Object.keys(b.state.checkins).sort(), ['2026-09-12', '2026-09-19']);
  assert.equal(b.state.setup.steps, 9500);

  // A tab saving a section other than logs keeps the other tab's logs in the stored copy.
  const release2 = shared.hold();
  b.state.logs['2026-09-26'] = entry(84.5);
  b.S.save('logs', b.state);
  a.state.plan = { base: 'x' };
  a.S.save('plan', a.state);
  release2();
  await settle();
  assert.deepEqual(Object.keys(JSON.parse(shared.map.get('fatloss-app-v1')).logs).sort(), ['2026-09-20', '2026-09-24', '2026-09-25', '2026-09-26']);
  assert.deepEqual(b.state.plan, { base: 'x' });
  assert.ok(a.state.logs['2026-09-26']);
});

test('device-only tabs share the browser copy the same way, and the journal keeps both tabs\' changes', async function () {
  const env = newEnv();
  env.server.put('fl/setup', cloudSetup());
  env.server.fail('*', /.*/, 'unavailable');
  const shared = makeSharedStorage();
  const a = openTab(env, 'a', { ls: shared.view() });
  const b = openTab(env, 'b', { ls: shared.view() });
  await load(env, a); await load(env, b);
  assert.equal(a.S.mode(), 'device-only');
  const release = shared.hold();
  b.state.logs['2026-09-24'] = entry(85.1);
  b.S.save('logs', b.state);
  a.state.logs['2026-09-25'] = entry(84.7);
  a.S.save('logs', a.state);
  release();
  await settle();
  assert.deepEqual(Object.keys(a.state.logs).sort(), ['2026-09-24', '2026-09-25']);
  assert.deepEqual(Object.keys(b.state.logs).sort(), ['2026-09-24', '2026-09-25']);
  assert.deepEqual(Object.keys(JSON.parse(shared.map.get('fatloss-app-v1-pending')).logs).sort(), ['2026-09-24', '2026-09-25']);
  env.server.clearFaults();
  const next = openTab(env, 'next', { ls: shared.view() });
  await load(env, next);
  await env.clock.advance(700);
  assert.deepEqual(liveKeys(days(env.server)), ['2026-09-24', '2026-09-25']);
});

// ---------- finding 40: save status ----------
test('a save that changes nothing ends in \'saved\'', async function () {
  const env = newEnv();
  env.server.put('fl/setup', cloudSetup());
  const a = openTab(env, 'a');
  await load(env, a);
  a.S.save('setup', a.state);
  a.S.save('logs', a.state);
  await env.clock.advance(3000);
  assert.equal(lastStatus(a), 'saved');
});

test('browser and memory modes report \'error\' when localStorage rejects the write', async function () {
  const env = newEnv();
  const ls = makeLocalStorage();
  ls.setItem('fatloss-app-v1', JSON.stringify(defaults()));
  const a = openTab(env, 'a', { noDb: true, ls: ls });
  assert.equal((await load(env, a)).backend, 'browser');
  ls.setItem = function () { throw new Error('QuotaExceededError'); };
  a.state.setup.weightKg = 88;
  a.S.save('setup', a.state);
  assert.match(lastStatus(a), /^error: Could not save in this browser/);

  const m = openTab(env, 'm', { noDb: true, ls: makeLocalStorage({ throwSet: true }) });
  assert.equal((await load(env, m)).backend, 'memory');
  m.S.save('setup', m.state);
  assert.match(lastStatus(m), /^error: /);
});

// ---------- finding 24 (store side): backup validation ----------
function backup(over, setupOver) {
  const st = defaults();
  st.setup = Object.assign(st.setup, setupOver || {});
  return JSON.stringify({ app: 'fatloss', version: 1, state: Object.assign(st, over || {}) });
}

test('importAll refuses a program start that is not a date and moves a weekday start to the next Saturday', function () {
  const S = openTab(newEnv(), 'x').S;
  ['2026-9-26', '26/09/2026', null, '', '2026-02-30'].forEach(function (bad) {
    assert.throws(function () { S.importAll(backup(null, { programStart: bad }), defaults()); }, /program|programStart/, String(bad));
  });
  assert.throws(function () { S.importAll(backup(null, { programStart: '2026-9-26' }), defaults()); }, /cannot be restored: setup "programStart" is "2026-9-26", but must be a date \(YYYY-MM-DD\)/);
  assert.equal(S.importAll(backup(null, { programStart: '2026-09-28' }), defaults()).setup.programStart, '2026-10-03');
  assert.equal(S.importAll(backup(null, { programStart: '2026-10-03' }), defaults()).setup.programStart, '2026-10-03');
});

test('importAll refuses non-numbers in setup and logs, and bad log or check-in dates', function () {
  const S = openTab(newEnv(), 'x').S;
  assert.throws(function () { S.importAll(backup(null, { weightKg: '85' }), defaults()); }, /setup "weightKg" is "85", but must be a number/);
  assert.throws(function () { S.importAll(backup(null, { weightKg: null }), defaults()); }, /weightKg/);
  assert.throws(function () { S.importAll(backup(null, { liftDays: ['Mon'] }), defaults()); }, /liftDays/);
  assert.throws(function () { S.importAll(backup(null, { goalType: 'fat' }), defaults()); }, /goalType.*"bf", "weight"/);
  const inf = backup().replace('"steps":8000', '"steps":1e999');
  assert.throws(function () { S.importAll(inf, defaults()); }, /steps/);
  assert.throws(function () { S.importAll(backup({ logs: { '2026-9-25': entry(90) } }), defaults()); }, /daily log key "2026-9-25"/);
  assert.throws(function () { S.importAll(backup({ logs: { '2026-09-25': { weight: 'heavy' } } }), defaults()); }, /2026-09-25/);
  assert.throws(function () { S.importAll(backup({ checkins: { week1: {} } }), defaults()); }, /check-in key "week1"/);
  assert.throws(function () { S.importAll(backup({ products: {} }), defaults()); }, /products/);
  assert.equal(S.importAll(backup(null, { bodyFatPct: null }), defaults()).setup.bodyFatPct, null);
});

test('importAll drops unknown junk and deleted entries and keeps state.program', function () {
  const S = openTab(newEnv(), 'x').S;
  const program = { snapshot: { programStart: '2026-09-26', week1: { kcal: 2400 } } };
  const st = S.importAll(backup({ junk: 1, program: program, logs: { '2026-09-25': entry(90), '2026-09-24': null } }, { foo: 'bar' }), defaults());
  assert.equal(st.junk, undefined);
  assert.equal(st.setup.foo, undefined);
  assert.deepEqual(st.program, program);
  assert.deepEqual(Object.keys(st.logs), ['2026-09-25']);
  const round = S.importAll(S.exportAll(st, '2026-09-25'), defaults());
  assert.deepEqual(round, st);
});

test('merge carries state.program and repairs a stored program start that is not a date', function () {
  const S = openTab(newEnv(), 'x').S;
  const program = { snapshot: { programStart: '2026-09-26' } };
  assert.deepEqual(S.merge(defaults(), { setup: {}, program: program }).program, program);
  assert.equal(S.merge(defaults(), { setup: {} }).program, null);
  assert.equal(S.merge(defaults(), { setup: { programStart: '2026-9-26' } }).setup.programStart, '2026-09-26');
  assert.equal(S.merge(defaults(), { setup: { programStart: '2026-10-01' } }).setup.programStart, '2026-10-03');
});

test('state.program is stored in fl/program and loads back', async function () {
  const env = newEnv();
  env.server.put('fl/setup', cloudSetup());
  const a = openTab(env, 'a');
  await load(env, a);
  assert.equal(a.state.program, null);
  a.state.program = { snapshot: { programStart: '2026-09-26', week1: { kcal: 2400 } } };
  a.S.save('program', a.state);
  await env.clock.advance(700);
  assert.deepEqual(env.server.get('fl/program'), a.state.program);
  const b = openTab(env, 'b', { ls: makeLocalStorage() });
  await load(env, b);
  assert.deepEqual(b.state.program, a.state.program);
});
