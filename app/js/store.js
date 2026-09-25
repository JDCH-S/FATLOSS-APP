/* Persistence. Primary backend: the claude.ai `db` capability (documents survive reloads, sessions and
 * republishes; other tabs and devices see changes live). Fallback: localStorage (only this browser).
 *
 * mode(): 'cloud' (db), 'browser' (no db in this view: localStorage), 'memory' (no db and no localStorage), or
 * 'device-only' (the db exists but could not be read at load: changes go to localStorage and the journal, never to
 * the cloud, and the next load that reads the cloud writes them there).
 *
 *   fl/setup         -> state.setup
 *   fl/program       -> state.program ({} while it is null)
 *   fl/plan          -> {plan}
 *   fl/products      -> {rows}
 *   fl/pricemeta     -> state.priceMeta
 *   logs/<YYYY>      -> {days: {iso: entry | null}}               (one document per calendar year)
 *   checkins/<YYYY>  -> {records: {weekStart: record | null}}     (one document per year of the week's Saturday)
 *
 * The fl/* documents are written whole with set(). Logs and check-ins are written per entry: an update() merge of only
 * the entries that changed, with null for a deleted one, so a tab holding an old copy never rewrites other entries.
 * Every document is subscribed to after load, and changes made by other tabs or devices are merged into the state
 * (onRemote). Each save also goes synchronously to localStorage: the whole state (the fallback copy) and a journal of
 * the changes the cloud has not confirmed yet, which the next load writes when the cloud still holds the value the
 * change was made on (page closed before the write, or the cloud was unreachable).
 *
 * In browser and device-only modes the localStorage copy is shared by every tab: a save writes only its own section
 * into the latest stored copy (log and check-in entries merged one by one, so a tab that is behind never drops or
 * reverts another tab's entries), and the window 'storage' event merges other tabs' saves into this tab's state
 * (onRemote), with the same rules as cloud snapshots.
 */
(function (root) {
  'use strict';

  const LS_KEY = 'fatloss-app-v1';
  const LS_PENDING = 'fatloss-app-v1-pending';
  const DEBOUNCE_MS = 600;
  const READ_TRIES = 4;
  const MAX_DOC_BYTES = 256 * 1024;
  const DOCS = { setup: 'fl/setup', program: 'fl/program', plan: 'fl/plan', products: 'fl/products', priceMeta: 'fl/pricemeta' };
  const FIELD = { logs: 'days', checkins: 'records' };   // entry sections: a collection of that name, one document per year
  const LEGACY_CHECKINS = 'fl/checkins';                // all check-ins in one document {records}, before the split by year
  const SECTIONS = ['setup', 'program', 'plan', 'products', 'priceMeta', 'checkins', 'logs'];
  const LABEL = { setup: 'the Setup', program: 'the program', plan: 'the meal plan', products: 'the product table',
    priceMeta: 'the price import details', checkins: 'the check-ins', logs: 'the daily log' };
  // Codes where repeating the same call cannot succeed (db.d.ts); every other code counts as transient.
  const FINAL = { invalid_argument: 1, transform_error: 1, quota_exceeded: 1, revoked: 1, not_granted: 1, capability_disabled: 1, capability_removed: 1 };
  // The runtime cannot run db in this view: same as claude.use('db') resolving null.
  const NO_DB = { not_granted: 1, capability_disabled: 1, capability_removed: 1 };
  const LS_FAILED = 'Could not save in this browser (storage is full or blocked).';
  const DEVICE_ONLY = 'Saved on this device only: your account could not be reached. It syncs after a successful reload.';
  const DEVICE_ONLY_FAILED = 'Not saved: your account could not be reached, and this browser\'s storage is full or blocked.';

  let db = null;
  let backend = 'memory';
  let mode = 'memory';       // 'cloud' | 'browser' | 'memory' | 'device-only' (see the top of this file)
  let lsOk = true;
  let defs = null;           // defaults given to load(), to merge remote sections with
  let cur = null;            // the state last loaded or saved; remote changes are merged into it
  const statusFns = [];
  const remoteFns = [];
  const timers = {};         // section -> debounce timer
  const docBase = {};        // fl/* section -> canonical JSON of the body the cloud holds
  const entryBase = { logs: {}, checkins: {} };   // entry section -> key -> canonical JSON the cloud holds
  const W = {};              // doc path -> {busy, failed, tries, timer}: one write in flight per document
  // Browser and device-only modes: canonical JSON of what this tab last read from or wrote to the localStorage copy.
  const seen = { doc: {}, logs: {}, checkins: {} };

  function emit(status, detail) {
    statusFns.forEach(function (fn) { try { fn(status, detail); } catch (e) { /* ignore listener errors */ } });
  }
  function onStatus(fn) { statusFns.push(fn); }
  function onRemote(fn) { remoteFns.push(fn); }

  function later(fn, ms) { return root.setTimeout(fn, ms); }
  function backoff(n) { return Math.min(30000, 500 * Math.pow(2, n)) * (0.75 + Math.random() / 2); }
  function retryable(e) { return !(e && FINAL[e.code]); }
  function describe(e) { return (e && (e.message || e.code)) || String(e); }
  function isObj(x) { return !!x && typeof x === 'object' && !Array.isArray(x); }
  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  function clone(x) { return x === undefined ? undefined : JSON.parse(JSON.stringify(x)); }

  // JSON with sorted keys and without null members (undefined for null itself): the store may reorder keys, and an
  // update() leaves null where a member was removed, so two copies are compared in this form.
  function canon(x) {
    if (x == null) return undefined;
    return JSON.stringify(x, function (k, v) {
      if (!isObj(v)) return v;
      const o = {};
      Object.keys(v).sort().forEach(function (key) { if (v[key] !== null) o[key] = v[key]; });
      return o;
    });
  }
  function hash(str) {
    if (str === undefined) return null;
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return (h >>> 0).toString(36) + '.' + str.length;
  }

  function isoDate(v) {
    if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
    return new Date(Date.UTC(+v.slice(0, 4), +v.slice(5, 7) - 1, +v.slice(8, 10))).toISOString().slice(0, 10) === v;
  }
  function saturdayOnOrAfter(iso) {
    const t = Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));
    return new Date(t + ((13 - new Date(t).getUTCDay()) % 7) * 86400000).toISOString().slice(0, 10);
  }

  function lsGet(key) {
    try {
      const raw = root.localStorage && root.localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }
  function lsSet(key, value) {
    try { if (!root.localStorage) return false; root.localStorage.setItem(key, JSON.stringify(value)); return true; } catch (e) { return false; }
  }

  // Fill missing sections/fields from defaults so older or partial data always loads.
  function merge(defaults, loaded) {
    const s = clone(defaults);
    if (s.program === undefined) s.program = null;
    if (isObj(loaded)) {
      if (isObj(loaded.setup)) s.setup = Object.assign(s.setup, loaded.setup);
      if (isObj(loaded.program) || loaded.program === null) s.program = loaded.program;
      if (isObj(loaded.logs)) s.logs = loaded.logs;
      if (isObj(loaded.checkins)) s.checkins = loaded.checkins;
      if (loaded.plan !== undefined) s.plan = loaded.plan;
      if (Array.isArray(loaded.products)) s.products = loaded.products;
      if (isObj(loaded.priceMeta)) s.priceMeta = Object.assign(s.priceMeta, loaded.priceMeta);
    }
    // A program start that is not a date stops every view from rendering; one off a Saturday moves to the next one.
    const ps = s.setup.programStart;
    s.setup.programStart = isoDate(ps) ? saturdayOnOrAfter(ps) : defaults.setup.programStart;
    s.version = 1;
    return s;
  }

  function bodyOf(section, state) {
    switch (section) {
      case 'setup': return state.setup || {};
      case 'program': return state.program || {};
      case 'plan': return { plan: state.plan === undefined ? null : state.plan };
      case 'products': return { rows: state.products || [] };
      default: return state.priceMeta || {};
    }
  }
  // A document body as the partial state merge() takes.
  function asState(section, body) {
    const s = {};
    s[section] = section === 'plan' ? body.plan : section === 'products' ? body.rows
      : section === 'program' && !Object.keys(body).length ? null : body;
    return s;
  }
  function entryPath(section, key) { return section + '/' + key.slice(0, 4); }
  function sectionOf(path) {
    const s = Object.keys(DOCS).find(function (k) { return DOCS[k] === path; });
    return s || path.split('/')[0];
  }
  function baseOf(section) { return DOCS[section] ? docBase : entryBase[section]; }

  // What differs from the cloud in a section (or in one of its documents): [{key, prev, next, value}], with prev/next
  // as canonical JSON (undefined = absent) and value what to write (null = delete the entry). The key of an fl/*
  // section is the section name.
  function changedItems(section, path) {
    if (DOCS[section]) {
      const value = bodyOf(section, cur), next = canon(value);
      return next === docBase[section] ? [] : [{ key: section, prev: docBase[section], next: next, value: value }];
    }
    const vals = cur[section] || {}, base = entryBase[section], out = [];
    Object.keys(Object.assign({}, base, vals)).forEach(function (k) {
      if (path && entryPath(section, k) !== path) return;
      const next = canon(vals[k]);
      if (next !== base[k]) out.push({ key: k, prev: base[k], next: next, value: next === undefined ? null : vals[k] });
    });
    return out;
  }

  // ---------- journal: changes the cloud has not confirmed, as {section: {key: {v, b}}} with v the new value (null =
  // deleted) and b the hash of the cloud value it replaces ----------
  function journal() { const j = lsGet(LS_PENDING); return isObj(j) ? j : {}; }
  function slotOf(j, section) { return isObj(j[section]) ? j[section] : (j[section] = {}); }

  function record(section) {
    const j = journal(), slot = slotOf(j, section);
    changedItems(section).forEach(function (it) {
      slot[it.key] = { v: it.value, b: isObj(slot[it.key]) ? slot[it.key].b : hash(it.prev) };
    });
    lsSet(LS_PENDING, j);
  }

  function confirm(section, items) {
    const base = baseOf(section), j = journal(), slot = slotOf(j, section);
    items.forEach(function (it) {
      // A snapshot that arrived during the write has already moved the base, and it knows better.
      if (base[it.key] === it.prev) { if (it.next === undefined) delete base[it.key]; else base[it.key] = it.next; }
      const e = slot[it.key];
      if (!isObj(e)) return;
      if (canon(e.v) === it.next) delete slot[it.key];
      else if (e.b === hash(it.prev)) e.b = hash(it.next);
    });
    lsSet(LS_PENDING, j);
  }

  // Journal changes are applied when the cloud still holds the value they were made on; otherwise the cloud's newer
  // value wins and the change is dropped. Returns the sections that now have something to write.
  function replay() {
    const j = journal(), out = [];
    SECTIONS.forEach(function (s) {
      const slot = slotOf(j, s), base = baseOf(s);
      Object.keys(slot).forEach(function (k) {
        const e = slot[k];
        if (!isObj(e) || (DOCS[s] && k !== s) || e.b !== hash(base[k]) || canon(e.v) === base[k]) { delete slot[k]; return; }
        if (DOCS[s]) cur[s] = merge(defs, asState(s, clone(e.v)))[s];
        else if (e.v == null) delete cur[s][k];
        else cur[s][k] = clone(e.v);
        if (out.indexOf(s) < 0) out.push(s);
      });
    });
    lsSet(LS_PENDING, j);
    return out;
  }

  // ---------- load ----------
  // Resolves {state, backend: 'cloud'|'browser'|'memory', mode, error, readOnly, migrated}. When the cloud store
  // exists but cannot be read, the session is device-only (backend 'cloud', readOnly true): it shows the browser copy
  // (or the defaults) and records changes in localStorage and the journal, never in the cloud.
  async function load(defaults) {
    defs = defaults;
    let ns = null;
    try {
      if (root.claude && typeof root.claude.use === 'function') ns = await root.claude.use('db');
    } catch (e) { ns = null; }
    const local = lsGet(LS_KEY);
    let error = null;
    if (ns) {
      db = ns;
      try {
        const snaps = await Promise.all(['fl', 'logs', 'checkins'].map(function (c) {
          return read(function () { return db.collection(c).get(); });
        }));
        return openCloud(snaps, local);
      } catch (e) { error = e; }
      db = null;
      if (!NO_DB[error && error.code]) {
        backend = 'cloud';
        mode = 'device-only';
        cur = merge(defaults, local);
        openLocal();
        return { state: cur, backend: backend, mode: mode, readOnly: true, migrated: false,
          error: 'Could not load your saved data (' + describe(error) + '). Changes are saved on this device only and sync after a successful reload.' };
      }
    }
    cur = merge(defaults, local);
    lsOk = local !== null || lsSet(LS_KEY, cur);
    backend = mode = lsOk ? 'browser' : 'memory';
    openLocal();
    return { state: cur, backend: backend, mode: mode, error: error ? describe(error) : null, readOnly: false, migrated: false };
  }

  // Browser and device-only modes. The journal records what this session changes relative to what it loaded (the
  // browser copy mirrors the cloud as the last session that read it saw it), so a later load that reads the cloud
  // writes those changes where the cloud still holds the loaded value.
  function openLocal() {
    Object.keys(DOCS).forEach(function (s) { docBase[s] = canon(bodyOf(s, cur)); });
    Object.keys(FIELD).forEach(function (s) {
      Object.keys(cur[s] || {}).forEach(function (k) { const c = canon(cur[s][k]); if (c !== undefined) entryBase[s][k] = c; });
    });
    SECTIONS.forEach(remember);
    if (typeof root.addEventListener !== 'function') return;
    root.addEventListener('storage', function (e) { if (e && e.key === LS_KEY) pull(); });
    // Storage events can be missed while a page sits in the back/forward cache.
    root.addEventListener('pageshow', function () { pull(); });
    const d = root.document;
    if (d && typeof d.addEventListener === 'function') {
      d.addEventListener('visibilitychange', function () { if (d.visibilityState === 'visible') pull(); });
    }
  }

  async function read(fn) {
    for (let n = 0; ; n++) {
      try { return await fn(); } catch (e) {
        if (!retryable(e) || n + 1 >= READ_TRIES) throw e;
        await new Promise(function (r) { later(r, backoff(n)); });
      }
    }
  }

  function openCloud(snaps, local) {
    const fl = {}, loaded = { logs: {}, checkins: {} }, stored = {};
    snaps[0].docs.forEach(function (d) { if (d.exists) fl[d.id] = d.data(); });
    Object.keys(DOCS).forEach(function (s) {
      const body = fl[DOCS[s].slice(3)];
      if (body) { docBase[s] = canon(body); Object.assign(loaded, asState(s, clone(body))); }
    });
    Object.keys(FIELD).forEach(function (s, i) {
      snaps[i + 1].docs.forEach(function (d) {
        const vals = (d.exists && d.data()[FIELD[s]]) || {};
        Object.keys(vals).forEach(function (k) {
          stored[s + k] = true;
          if (vals[k] == null) return;
          entryBase[s][k] = canon(vals[k]);
          loaded[s][k] = clone(vals[k]);
        });
      });
    });
    // Records only in the old single document move to the per-year documents (a key there, even null, is newer).
    const legacy = fl.checkins && isObj(fl.checkins.records) ? fl.checkins.records : null;
    if (legacy) Object.keys(legacy).forEach(function (k) { if (!stored['checkins' + k] && legacy[k]) loaded.checkins[k] = clone(legacy[k]); });

    backend = mode = 'cloud';
    // First cloud run after using the browser fallback: move that data into the cloud store.
    const migrated = !fl.setup && !Object.keys(loaded.logs).length && local !== null;
    cur = merge(defs, migrated ? local : loaded);
    const toWrite = migrated ? SECTIONS.slice() : replay();
    if (legacy && toWrite.indexOf('checkins') < 0) toWrite.push('checkins');
    lsSet(LS_KEY, cur);
    subscribe();
    flushOnExit();
    const writes = toWrite.map(function (s) { record(s); return flushSection(s); });
    if (legacy) {
      Promise.all(writes).then(function () {
        if (!changedItems('checkins').length) return db.doc(LEGACY_CHECKINS).delete();
      }).catch(function () { /* the next load migrates again */ });
    }
    return { state: cur, backend: backend, mode: mode, error: null, readOnly: false, migrated: migrated };
  }

  // ---------- other tabs and devices ----------
  function subscribe() {
    Object.keys(DOCS).forEach(function (s) { listen(db.doc(DOCS[s]), function (snap) { applyDoc(s, snap); }, 0); });
    Object.keys(FIELD).forEach(function (s) {
      listen(db.collection(s), function (q) { q.docs.forEach(function (d) { applyEntries(s, d); }); }, 0);
    });
  }
  // A terminated subscription is replaced after a pause, unless its error is final.
  function listen(ref, next, n) {
    try {
      ref.onSnapshot(next, function (e) { if (retryable(e)) later(function () { listen(ref, next, n + 1); }, backoff(n)); });
    } catch (e) { /* no live updates in this view */ }
  }
  // Echoes of this page's unconfirmed writes and not-yet-definitive views are skipped; a definitive one follows.
  function fresh(snap) { const m = snap.metadata || {}; return !m.hasPendingWrites && !m.fromCache; }

  function notify(section) {
    remoteFns.forEach(function (fn) { try { fn(section, cur[section]); } catch (e) { /* ignore listener errors */ } });
  }
  function changed(section) {
    lsSet(LS_KEY, cur);
    notify(section);
  }

  function applyDoc(section, snap) {
    if (!snap.exists || !fresh(snap)) return;
    docBase[section] = canon(snap.data());
    const w = W[DOCS[section]];
    // This page's own unsaved or unconfirmed change is written next and wins.
    if (timers[section] || (w && (w.busy || w.failed))) return;
    const value = merge(defs, asState(section, clone(snap.data())))[section];
    if (canon(value) === canon(cur[section])) return;
    cur[section] = value;
    changed(section);
  }

  function applyEntries(section, d) {
    if (!d.exists || !fresh(d)) return;
    const year = d.id, remote = d.data()[FIELD[section]] || {}, base = entryBase[section];
    const vals = cur[section] || {}, next = Object.assign({}, vals);
    let n = 0;
    Object.keys(Object.assign({}, base, remote)).forEach(function (k) {
      if (k.slice(0, 4) !== year) return;
      const r = canon(remote[k]), mine = canon(vals[k]), pending = mine !== base[k];
      if (r === undefined) delete base[k]; else base[k] = r;
      // An entry changed here and not yet confirmed keeps this page's value; it is written next.
      if (pending || mine === r) return;
      if (r === undefined) delete next[k]; else next[k] = clone(remote[k]);
      n++;
    });
    if (n) { cur[section] = next; changed(section); }
  }

  // ---------- other tabs sharing the localStorage copy (browser and device-only modes) ----------
  // Records what the stored copy now holds for a section, as this tab wrote or read it.
  function remember(section) {
    if (DOCS[section]) { seen.doc[section] = canon(bodyOf(section, cur)); return; }
    const vals = cur[section] || {}, sn = seen[section] = {};
    Object.keys(vals).forEach(function (k) { const c = canon(vals[k]); if (c !== undefined) sn[k] = c; });
  }

  // Another tab saved: take what it changed. Setup, program, plan, products and priceMeta are taken whole, as their
  // snapshots are in cloud mode (saves here are synchronous, so this tab has nothing waiting to be written); log and
  // check-in entries one by one, except an entry this tab changed and has not saved.
  function pull() {
    const stored = lsGet(LS_KEY);
    if (!isObj(stored) || !defs) return;
    const latest = merge(defs, stored), touched = [];
    Object.keys(DOCS).forEach(function (s) {
      const r = canon(bodyOf(s, latest));
      if (r === seen.doc[s]) return;
      seen.doc[s] = r;
      if (r === canon(bodyOf(s, cur))) return;
      cur[s] = latest[s];
      touched.push(s);
    });
    Object.keys(FIELD).forEach(function (s) {
      const remote = latest[s] || {}, sn = seen[s], mine = cur[s] || {}, next = Object.assign({}, mine);
      let n = 0;
      Object.keys(Object.assign({}, sn, remote)).forEach(function (k) {
        const r = canon(remote[k]), m = canon(mine[k]), pending = m !== sn[k];
        if (r === undefined) delete sn[k]; else sn[k] = r;
        if (pending || m === r) return;
        if (r === undefined) delete next[k]; else next[k] = clone(remote[k]);
        n++;
      });
      if (n) { cur[s] = next; touched.push(s); }
    });
    touched.forEach(notify);
  }

  // Before a log or check-in save: entries this tab has not changed since it last synced take the stored copy's
  // value (another tab may have added, edited or deleted them); entries it changed keep its own. Updates the
  // section in place and says whether anything came from the stored copy.
  function mergeStoredEntries(section, stored) {
    const mine = cur[section] || (cur[section] = {}), sn = seen[section];
    let n = 0;
    Object.keys(Object.assign({}, sn, stored)).forEach(function (k) {
      const m = canon(mine[k]);
      if (m !== sn[k]) return;
      const r = canon(stored[k]);
      if (r === m) return;
      if (r === undefined) delete mine[k]; else mine[k] = clone(stored[k]);
      n++;
    });
    return n > 0;
  }

  // Writes one section into the latest stored copy (other sections keep what other tabs stored), records it in the
  // journal, and returns whether localStorage took the write.
  function saveLocal(section) {
    const stored = lsGet(LS_KEY);
    const latest = isObj(stored) && defs ? merge(defs, stored) : null;
    const pulled = !!latest && !!FIELD[section] && mergeStoredEntries(section, latest[section] || {});
    record(section);
    let ok;
    if (latest) { latest[section] = cur[section]; ok = lsSet(LS_KEY, latest); } else ok = lsSet(LS_KEY, cur);
    if (ok) remember(section);
    if (pulled) Promise.resolve().then(function () { notify(section); });
    return ok;
  }

  // ---------- writes ----------
  // update() merges nested objects, so an entry is sent with null for every member it no longer has.
  function replacement(old, val) {
    if (!isObj(old) || !isObj(val)) return val;
    const out = {};
    Object.keys(old).forEach(function (k) { out[k] = null; });
    Object.keys(val).forEach(function (k) { out[k] = replacement(old[k], val[k]); });
    return out;
  }

  function send(path, section, items) {
    const ref = db.doc(path);
    if (DOCS[section]) return ref.set(clone(items[0].value));
    const field = FIELD[section], patch = {}, created = {};
    items.forEach(function (it) {
      patch[it.key] = it.value === null ? null : replacement(it.prev === undefined ? undefined : JSON.parse(it.prev), clone(it.value));
      if (it.value !== null) created[it.key] = clone(it.value);
    });
    return ref.update({ [field]: patch }).catch(function (e) {
      if (!e || e.code !== 'invalid_argument') throw e;
      // update() needs an existing document: create this year's one, unless it exists and the error is real.
      return ref.get().then(function (snap) { if (snap.exists) throw e; return ref.set({ [field]: created }); });
    });
  }

  function failure(e, path, section) {
    const code = e && e.code;
    if (code === 'invalid_argument' || code === 'transform_error') {
      return docBytes(path, section) > MAX_DOC_BYTES
        ? 'Could not save ' + LABEL[section] + ': it is over the 256 KiB storage limit for one document. Export a backup.'
        : 'Could not save: this view has read-only access to the data.';
    }
    if (code === 'quota_exceeded') return 'Storage is full. Export a backup and delete old data.';
    if (code === 'revoked') return 'Saving stopped: this page lost access to your data. Reload the page.';
    return 'Could not save (' + describe(e) + ').' + (retryable(e) ? ' Retrying…' : '');
  }
  function docBytes(path, section) {
    let body = bodyOf(section, cur);
    if (FIELD[section]) {
      const vals = {};
      Object.keys(cur[section] || {}).forEach(function (k) { if (entryPath(section, k) === path) vals[k] = cur[section][k]; });
      body = { [FIELD[section]]: vals };
    }
    return new TextEncoder().encode(JSON.stringify(body)).length;
  }

  // Writes what differs from the cloud in one document, then again for changes made meanwhile. A failed write keeps
  // the document marked failed; transient failures retry with backoff, and any later save retries every failed one.
  function pump(path) {
    const w = W[path] = W[path] || { busy: null, failed: null, tries: 0, timer: null };
    if (w.busy) return w.busy;
    const section = sectionOf(path), items = changedItems(section, path);
    if (!items.length) { w.failed = null; report(); return Promise.resolve(); }
    w.busy = Promise.resolve().then(function () { return send(path, section, items); }).then(function () {
      confirm(section, items);
      w.failed = null; w.tries = 0;
      if (w.timer) { root.clearTimeout(w.timer); w.timer = null; }
    }, function (e) {
      w.failed = failure(e, path, section);
      if (retryable(e) && !w.timer) w.timer = later(function () { w.timer = null; pump(path); }, backoff(w.tries++));
    }).then(function () {
      w.busy = null;
      return w.failed ? null : pump(path);
    }).then(report);
    return w.busy;
  }

  function failed() {
    const p = Object.keys(W).find(function (k) { return W[k].failed; });
    return p ? W[p].failed : null;
  }
  // 'saved' only once nothing is waiting or in flight; a failed document keeps 'error' until it is written.
  function report() {
    if (SECTIONS.some(function (s) { return timers[s]; }) || Object.keys(W).some(function (p) { return W[p].busy; })) return;
    const f = failed();
    if (f) emit('error', f); else emit('saved');
  }

  function flushSection(section) {
    if (timers[section]) root.clearTimeout(timers[section]);
    timers[section] = null;
    const paths = DOCS[section] ? [DOCS[section]] : changedItems(section).map(function (it) { return entryPath(section, it.key); })
      .filter(function (p, i, all) { return all.indexOf(p) === i; });
    return Promise.all(paths.map(pump)).then(report);
  }

  // Debounced per section. The localStorage copy and the journal are written at once, so a closed page loses nothing.
  // Device-only mode stops there and reports 'error' (the change is not in the account yet).
  function save(section, state) {
    if (!DOCS[section] && !FIELD[section]) return;
    cur = state;
    if (mode !== 'cloud') {
      lsOk = saveLocal(section);
      if (mode === 'device-only') emit('error', lsOk ? DEVICE_ONLY : DEVICE_ONLY_FAILED);
      else if (lsOk) emit('saved'); else emit('error', LS_FAILED);
      return;
    }
    record(section);
    lsOk = lsSet(LS_KEY, state);
    if (!failed()) emit('saving');
    if (timers[section]) root.clearTimeout(timers[section]);
    timers[section] = later(function () { flushSection(section); }, DEBOUNCE_MS);
    Object.keys(W).forEach(function (p) { if (W[p].failed) pump(p); });
  }

  // Writes everything pending now; resolves true once all of it is stored (in device-only mode: false, as it is
  // only on this device).
  async function flush() {
    if (mode === 'device-only') return false;
    if (mode !== 'cloud') return lsOk;
    SECTIONS.forEach(function (s) { if (timers[s]) flushSection(s); });
    Object.keys(W).forEach(function (p) { if (W[p].failed) pump(p); });
    for (;;) {
      const busy = Object.keys(W).map(function (p) { return W[p].busy; }).filter(Boolean);
      if (!busy.length) break;
      await Promise.all(busy);
    }
    return !failed();
  }

  function flushOnExit() {
    if (typeof root.addEventListener === 'function') root.addEventListener('pagehide', function () { flush(); });
    const d = root.document;
    if (d && typeof d.addEventListener === 'function') {
      d.addEventListener('visibilitychange', function () { if (d.visibilityState === 'hidden') flush(); });
    }
  }

  function saveAll(state) {
    SECTIONS.forEach(function (s) { save(s, state); });
    return flush();
  }

  // ---------- backup ----------
  function exportAll(state, todayIso) {
    return JSON.stringify({ app: 'fatloss', version: 1, exported: todayIso || null, state: state }, null, 2);
  }

  const SETUP_RULES = {
    weightKg: 'number', heightCm: 'number', age: 'number', bodyFatPct: 'number?', goalBodyFatPct: 'number?', goalWeightKg: 'number?',
    steps: 'number', liftMinutes: 'number', padelMinutes: 'number', mealsPerDay: 'number', isExample: 'boolean',
    liftDays: 'weekdays', padelDays: 'weekdays', likedFoods: 'ids', excludedFoods: 'ids', customFoods: 'objects',
    goalType: ['bf', 'weight'], saturdayMode: ['offplan', 'included'], programStart: 'date'
  };
  const RULE_TEXT = { number: 'a number', 'number?': 'a number or empty', boolean: 'true or false', weekdays: 'a list of weekday numbers 0–6',
    ids: 'a list of food ids', objects: 'a list of foods', date: 'a date (YYYY-MM-DD)' };
  const LOG_NUMBERS = ['weight', 'kcal', 'protein', 'steps'];

  function fits(v, rule) {
    if (Array.isArray(rule)) return rule.indexOf(v) >= 0;
    switch (rule) {
      case 'number': return isNum(v);
      case 'number?': return v === null || isNum(v);
      case 'boolean': return typeof v === 'boolean';
      case 'weekdays': return Array.isArray(v) && v.every(function (d) { return Number.isInteger(d) && d >= 0 && d <= 6; });
      case 'ids': return Array.isArray(v) && v.every(function (x) { return typeof x === 'string'; });
      case 'objects': return Array.isArray(v) && v.every(isObj);
      default: return isoDate(v);
    }
  }

  // Everything the app reads must have the right type, or the restore is refused with the reason. Unknown sections
  // and setup fields are dropped, and so are deleted (null) log and check-in entries.
  function checkBackup(body, defaults) {
    const bad = function (msg) { throw new Error('This backup cannot be restored: ' + msg); };
    const out = { setup: {} };
    Object.keys(body.setup).forEach(function (k) {
      if (!(k in defaults.setup)) return;
      const v = body.setup[k], rule = SETUP_RULES[k];
      if (rule && !fits(v, rule)) {
        bad('setup "' + k + '" is ' + JSON.stringify(v) + ', but must be ' +
          (Array.isArray(rule) ? 'one of ' + rule.map(function (x) { return '"' + x + '"'; }).join(', ') : RULE_TEXT[rule]) + '.');
      }
      out.setup[k] = v;
    });
    Object.keys(FIELD).forEach(function (s) {
      if (body[s] === undefined) return;
      if (!isObj(body[s])) bad('"' + s + '" must be an object keyed by date.');
      out[s] = {};
      Object.keys(body[s]).forEach(function (k) {
        const e = body[s][k];
        if (!isoDate(k)) bad('the ' + (s === 'logs' ? 'daily log' : 'check-in') + ' key ' + JSON.stringify(k) + ' is not a date (YYYY-MM-DD).');
        if (e === null) return;
        if (!isObj(e)) bad('the ' + (s === 'logs' ? 'daily log' : 'check-in') + ' entry for ' + k + ' is not an object.');
        if (s === 'logs' && LOG_NUMBERS.some(function (f) { return e[f] != null && !isNum(e[f]); })) bad('the daily log entry for ' + k + ' has a value that is not a number.');
        out[s][k] = e;
      });
    });
    if (body.products !== undefined) {
      if (!fits(body.products, 'objects')) bad('"products" must be a list of product rows.');
      out.products = body.products;
    }
    ['plan', 'program'].forEach(function (s) {
      if (body[s] === undefined) return;
      if (body[s] !== null && !isObj(body[s])) bad('"' + s + '" must be an object or null.');
      out[s] = body[s];
    });
    if (body.priceMeta !== undefined) {
      if (!isObj(body.priceMeta)) bad('"priceMeta" must be an object.');
      out.priceMeta = body.priceMeta;
    }
    return out;
  }

  function importAll(text, defaults) {
    let parsed;
    try { parsed = JSON.parse(text); } catch (e) { throw new Error('The file is not valid JSON.'); }
    const body = parsed && parsed.app === 'fatloss' && parsed.state ? parsed.state : parsed;
    if (!isObj(body) || !isObj(body.setup)) throw new Error('This file is not a fat-loss app backup (no setup section).');
    return merge(defaults, checkBackup(body, defaults));
  }

  // Offer a file to the viewer. Returns 'saved' | 'fallback' (Blob link used) | 'unavailable'.
  async function download(filename, text) {
    let dl = null;
    try { if (root.claude && typeof root.claude.use === 'function') dl = await root.claude.use('downloads'); } catch (e) { dl = null; }
    if (dl) {
      try { await dl.save({ filename: filename, data: text }); return 'saved'; } catch (e) {
        if (e && e.code === 'declined') return 'declined';
        if (e && e.code === 'rate_limited') return 'rate_limited';
        return 'unavailable';
      }
    }
    // Outside claude.ai the page can download directly.
    const inFrame = (function () { try { return root.self !== root.top; } catch (e) { return true; } })();
    if (!inFrame && root.document && root.Blob && root.URL) {
      try {
        const url = root.URL.createObjectURL(new root.Blob([text], { type: 'application/json' }));
        const a = root.document.createElement('a');
        a.href = url; a.download = filename;
        root.document.body.appendChild(a); a.click(); a.remove();
        later(function () { root.URL.revokeObjectURL(url); }, 2000);
        return 'fallback';
      } catch (e) { return 'unavailable'; }
    }
    return 'unavailable';
  }

  const api = {
    load: load, save: save, saveAll: saveAll, flush: flush, onStatus: onStatus, onRemote: onRemote,
    exportAll: exportAll, importAll: importAll, download: download, merge: merge,
    backend: function () { return backend; },
    mode: function () { return mode; }
  };

  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.FL = root.FL || {}; root.FL.store = api; }
})(typeof window !== 'undefined' ? window : globalThis);
