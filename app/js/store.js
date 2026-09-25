/* Persistence. Primary backend: the claude.ai `db` capability (documents survive reloads, sessions and
 * republishes). Fallback: localStorage (only this browser). Every section of the state maps to one or more
 * documents; a save writes only the documents whose content changed, one write in flight per document.
 *
 *   fl/setup      -> state.setup
 *   fl/plan       -> {plan}
 *   fl/products   -> {rows}
 *   fl/pricemeta  -> state.priceMeta
 *   fl/checkins   -> {records}
 *   logs/<YYYY>   -> {days: {iso: entry}}   (one document per calendar year)
 */
(function (root) {
  'use strict';

  const LS_KEY = 'fatloss-app-v1';
  const DEBOUNCE_MS = 600;

  let db = null;
  let backend = 'memory';
  const statusFns = [];
  const timers = {};
  const lastWritten = {};    // doc path -> JSON string last confirmed (or loaded)
  const chains = {};         // doc path -> promise chain (one write at a time per document)
  let pendingWrites = 0;
  let lastError = null;

  function emit(status, detail) {
    statusFns.forEach(function (fn) { try { fn(status, detail); } catch (e) { /* ignore listener errors */ } });
  }
  function onStatus(fn) { statusFns.push(fn); }

  function lsRead() {
    try {
      const raw = root.localStorage && root.localStorage.getItem(LS_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }
  function lsWrite(state) {
    try { if (root.localStorage) root.localStorage.setItem(LS_KEY, JSON.stringify(state)); return true; } catch (e) { return false; }
  }

  function clone(x) { return x === undefined ? undefined : JSON.parse(JSON.stringify(x)); }

  // Fill missing sections/fields from defaults so older or partial data always loads.
  function merge(defaults, loaded) {
    const s = clone(defaults);
    if (!loaded || typeof loaded !== 'object') return s;
    if (loaded.setup && typeof loaded.setup === 'object') s.setup = Object.assign(s.setup, loaded.setup);
    if (loaded.logs && typeof loaded.logs === 'object') s.logs = loaded.logs;
    if (loaded.checkins && typeof loaded.checkins === 'object') s.checkins = loaded.checkins;
    if (loaded.plan !== undefined) s.plan = loaded.plan;
    if (Array.isArray(loaded.products)) s.products = loaded.products;
    if (loaded.priceMeta && typeof loaded.priceMeta === 'object') s.priceMeta = Object.assign(s.priceMeta, loaded.priceMeta);
    s.version = 1;
    return s;
  }

  function docsFor(section, state) {
    switch (section) {
      case 'setup': return { 'fl/setup': state.setup };
      case 'plan': return { 'fl/plan': { plan: state.plan || null } };
      case 'products': return { 'fl/products': { rows: state.products || [] } };
      case 'priceMeta': return { 'fl/pricemeta': state.priceMeta || {} };
      case 'checkins': return { 'fl/checkins': { records: state.checkins || {} } };
      case 'logs': {
        const years = {};
        Object.keys(state.logs || {}).forEach(function (iso) {
          const y = iso.slice(0, 4);
          (years[y] = years[y] || {})[iso] = state.logs[iso];
        });
        // Years that were written before but are now empty must be cleared too.
        Object.keys(lastWritten).forEach(function (p) {
          if (p.indexOf('logs/') === 0 && !years[p.slice(5)]) years[p.slice(5)] = {};
        });
        const out = {};
        Object.keys(years).forEach(function (y) { out['logs/' + y] = { days: years[y] }; });
        return out;
      }
      default: return {};
    }
  }
  const SECTIONS = ['setup', 'plan', 'products', 'priceMeta', 'checkins', 'logs'];

  async function load(defaults) {
    let dbNs = null;
    try {
      if (root.claude && typeof root.claude.use === 'function') dbNs = await root.claude.use('db');
    } catch (e) { dbNs = null; }

    const local = lsRead();
    if (dbNs) {
      db = dbNs;
      try {
        const loaded = {};
        const get = async function (path) {
          const snap = await db.doc(path).get();
          if (snap.exists) { const d = snap.data(); lastWritten[path] = JSON.stringify(d); return d; }
          return null;
        };
        const setup = await get('fl/setup');
        const plan = await get('fl/plan');
        const products = await get('fl/products');
        const priceMeta = await get('fl/pricemeta');
        const checkins = await get('fl/checkins');
        const logsSnap = await db.collection('logs').get();
        const logs = {};
        logsSnap.docs.forEach(function (d) {
          if (!d.exists) return;
          const body = d.data() || {};
          lastWritten['logs/' + d.id] = JSON.stringify(body);
          Object.assign(logs, body.days || {});
        });
        if (setup) loaded.setup = clone(setup);
        if (plan) loaded.plan = clone(plan.plan);
        if (products) loaded.products = clone(products.rows);
        if (priceMeta) loaded.priceMeta = clone(priceMeta);
        if (checkins) loaded.checkins = clone(checkins.records);
        loaded.logs = clone(logs);

        backend = 'cloud';
        const isEmpty = !setup && !Object.keys(logs).length;
        if (isEmpty && local) {
          // First cloud run after using the browser fallback: move that data into the cloud store.
          const state = merge(defaults, local);
          SECTIONS.forEach(function (s) { save(s, state, true); });
          return { state: state, backend: backend, migrated: true };
        }
        return { state: merge(defaults, loaded), backend: backend };
      } catch (e) {
        db = null;
        lastError = e;
      }
    }
    backend = local !== null || lsWrite(merge(defaults, null)) ? 'browser' : 'memory';
    return { state: merge(defaults, local), backend: backend, error: lastError ? (lastError.message || String(lastError)) : null };
  }

  function writeDoc(path, body) {
    const json = JSON.stringify(body);
    if (lastWritten[path] === json) return Promise.resolve();
    pendingWrites++;
    emit('saving');
    const prev = chains[path] || Promise.resolve();
    const next = prev.then(async function () {
      if (lastWritten[path] === json) return;
      try {
        await db.doc(path).set(JSON.parse(json));
      } catch (e) {
        if (e && e.code === 'unavailable') {
          await new Promise(function (r) { setTimeout(r, 400 + Math.floor(Math.random() * 600)); });
          await db.doc(path).set(JSON.parse(json));
        } else { throw e; }
      }
      lastWritten[path] = json;
    }).then(function () {
      pendingWrites--;
      if (pendingWrites === 0) emit('saved');
    }, function (e) {
      pendingWrites--;
      lastError = e;
      const code = e && e.code;
      const msg = code === 'invalid_argument' ? 'This view cannot save (read-only access).'
        : code === 'quota_exceeded' ? 'Storage is full. Export a backup and delete old data.'
          : 'Could not save: ' + ((e && e.message) || code || 'unknown error');
      emit('error', msg);
    });
    chains[path] = next;
    return next;
  }

  function flushSection(section, state) {
    lsWrite(state);
    if (backend !== 'cloud' || !db) { emit('saved'); return Promise.resolve(); }
    const docs = docsFor(section, state);
    return Promise.all(Object.keys(docs).map(function (p) { return writeDoc(p, docs[p]); }));
  }

  // Debounced per section; `now` skips the debounce.
  function save(section, state, now) {
    if (timers[section]) clearTimeout(timers[section]);
    if (now) { timers[section] = null; return flushSection(section, state); }
    emit('saving');
    timers[section] = setTimeout(function () { timers[section] = null; flushSection(section, state); }, DEBOUNCE_MS);
    return Promise.resolve();
  }

  function saveAll(state) {
    return Promise.all(SECTIONS.map(function (s) { return save(s, state, true); }));
  }

  function exportAll(state, todayIso) {
    return JSON.stringify({ app: 'fatloss', version: 1, exported: todayIso || null, state: state }, null, 2);
  }

  function importAll(text, defaults) {
    let parsed;
    try { parsed = JSON.parse(text); } catch (e) { throw new Error('The file is not valid JSON.'); }
    const body = parsed && parsed.app === 'fatloss' && parsed.state ? parsed.state : parsed;
    if (!body || typeof body !== 'object' || !body.setup) throw new Error('This file is not a fat-loss app backup (no setup section).');
    return merge(defaults, body);
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
        setTimeout(function () { root.URL.revokeObjectURL(url); }, 2000);
        return 'fallback';
      } catch (e) { return 'unavailable'; }
    }
    return 'unavailable';
  }

  const api = {
    load: load, save: save, saveAll: saveAll, onStatus: onStatus,
    exportAll: exportAll, importAll: importAll, download: download, merge: merge,
    backend: function () { return backend; }
  };

  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.FL = root.FL || {}; root.FL.store = api; }
})(typeof window !== 'undefined' ? window : globalThis);
