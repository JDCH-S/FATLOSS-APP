/* Groceries: weekly quantities from the fixed day plan, packs and costs per store, cheapest mix,
 * the grocery-list export for the price script, and the price import. Pure functions; "today" is passed in. */
(function (root) {
  'use strict';

  const STORES = ['Colruyt', 'Delhaize', 'Carrefour'];
  const STALE_DAYS = 7;
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

  function isNum(n) { return typeof n === 'number' && isFinite(n); }
  function isoToMs(iso) { const p = iso.split('-').map(Number); return Date.UTC(p[0], p[1] - 1, p[2]); }
  function label(iso) {
    const d = new Date(isoToMs(iso));
    return DAYS[d.getUTCDay()] + ' ' + d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()];
  }

  // How often a meal occurs in the diet week (Saturday dinner -> Friday dinner).
  // Breakfast and lunch fall 6 times (Sun-Fri) unless Saturday's are included in the plan; every meal after
  // lunch falls 7 times.
  function mealOccurrences(mealKey, saturdayMode) {
    if (mealKey === 'breakfast' || mealKey === 'lunch') return saturdayMode === 'included' ? 7 : 6;
    return 7;
  }

  function weeklyQuantities(plan, saturdayMode) {
    const byFood = {};
    ((plan && plan.meals) || []).forEach(function (m) {
      const times = mealOccurrences(m.key, saturdayMode);
      m.items.forEach(function (it) {
        if (!it || !isNum(it.grams) || it.grams <= 0) return;
        const q = byFood[it.foodId] || (byFood[it.foodId] = { foodId: it.foodId, grams: 0, perMeal: [] });
        q.grams += it.grams * times;
        q.perMeal.push({ mealKey: m.key, grams: it.grams, times: times });
      });
    });
    return Object.keys(byFood).sort().map(function (k) { return byFood[k]; });
  }

  function packsFor(needG, row) {
    if (!row || !isNum(row.packSizeG) || row.packSizeG <= 0 || !isNum(row.price) || row.price < 0 || !isNum(needG)) {
      return { packs: null, cost: null, leftoverG: null };
    }
    // Tiny epsilon so 1000.0000001 g of need against a 1000 g pack does not buy a second pack.
    const packs = needG <= 0 ? 0 : Math.ceil(needG / row.packSizeG - 1e-9);
    return { packs: packs, cost: Math.round(packs * row.price * 100) / 100, leftoverG: packs * row.packSizeG - needG };
  }

  function isStale(row, todayIso) {
    if (!row) return { stale: true, reason: 'no date', ageDays: null };
    const ageDays = row.date && ISO_RE.test(row.date) && todayIso ? Math.round((isoToMs(todayIso) - isoToMs(row.date)) / 86400000) : null;
    if (row.source === 'estimate') return { stale: true, reason: 'estimate', ageDays: ageDays };
    if (ageDays === null) return { stale: true, reason: 'no date', ageDays: null };
    if (ageDays > STALE_DAYS) return { stale: true, reason: 'older than 7 days', ageDays: ageDays };
    return { stale: false, reason: null, ageDays: ageDays };
  }

  // The row a store's line uses: the lowest-cost row among those with a current price (not stale), so a fresh
  // imported, mapped or hand-entered price beats a cheaper estimate or an old price. Only when no priced row is
  // current does the cheapest stale row count (its line keeps the stale flag). Rows without a usable price lose to
  // rows with one; on equal cost the earlier row wins.
  function bestRow(rows, needG, todayIso) {
    let best = null;
    rows.forEach(function (r) {
      const p = packsFor(needG, r);
      const c = { row: r, p: p, fresh: p.cost !== null && !isStale(r, todayIso).stale };
      if (!best) { best = c; return; }
      if (p.cost === null) return;
      if (best.p.cost === null || (c.fresh && !best.fresh) || (c.fresh === best.fresh && p.cost < best.p.cost)) best = c;
    });
    return best;
  }

  function storeBreakdown(quantities, products, todayIso) {
    const stores = {};
    STORES.forEach(function (st) { stores[st] = { items: [], total: 0, missing: [], staleCount: 0 }; });
    const cheapest = { items: [], total: 0, missing: [] };
    (quantities || []).forEach(function (q) {
      let bestStore = null;
      STORES.forEach(function (st) {
        const rows = (products || []).filter(function (r) { return r.store === st && r.foodId === q.foodId; });
        const s = stores[st];
        if (!rows.length) {
          s.missing.push(q.foodId);
          s.items.push({ foodId: q.foodId, needG: q.grams, row: null, packs: null, cost: null, leftoverG: null, stale: null });
          return;
        }
        const b = bestRow(rows, q.grams, todayIso);
        const stale = isStale(b.row, todayIso);
        const item = { foodId: q.foodId, needG: q.grams, row: b.row, packs: b.p.packs, cost: b.p.cost, leftoverG: b.p.leftoverG, stale: stale };
        s.items.push(item);
        if (item.cost !== null) s.total += item.cost;
        if (stale.stale) s.staleCount++;
        // Strict "<" keeps the earlier store in STORES order on ties.
        if (item.cost !== null && (!bestStore || item.cost < bestStore.item.cost)) bestStore = { store: st, item: item };
      });
      if (bestStore) {
        const it = bestStore.item;
        cheapest.items.push({ foodId: q.foodId, store: bestStore.store, row: it.row, packs: it.packs, cost: it.cost, leftoverG: it.leftoverG, stale: it.stale });
        cheapest.total += it.cost;
      } else {
        cheapest.missing.push(q.foodId);
      }
    });
    STORES.forEach(function (st) { stores[st].total = Math.round(stores[st].total * 100) / 100; });
    cheapest.total = Math.round(cheapest.total * 100) / 100;
    return { stores: stores, cheapest: cheapest };
  }

  function buildExport(quantities, products, foods, window, todayIso) {
    return {
      generated: todayIso,
      week: { start: window.start, end: window.end, label: label(window.start) + ' dinner → ' + label(window.end) + ' dinner' },
      items: (quantities || []).map(function (q) {
        const f = (foods || {})[q.foodId] || {};
        const stores = {};
        STORES.forEach(function (st) {
          stores[st] = (products || []).filter(function (r) { return r.store === st && r.foodId === q.foodId; }).map(function (r) {
            return { ean: r.ean || '', product: r.product || '', pack_size_g: isNum(r.packSizeG) ? r.packSizeG : null, url: r.url || '' };
          });
        });
        // drained_ratio / g_per_ml let the price script put a label's net weight or volume on the food's basis.
        return {
          food_id: q.foodId, food: f.name || q.foodId, food_nl: f.nameNl || '', weekly_g: Math.round(q.grams),
          unit_g: f.unit ? f.unit.grams : null, drained_ratio: isNum(f.drainedRatio) ? f.drainedRatio : null,
          g_per_ml: isNum(f.gPerMl) ? f.gPerMl : null, stores: stores
        };
      })
    };
  }

  function normalizeName(str) {
    return String(str == null ? '' : str)
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9%\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // Barcodes compare without spaces and leading zeros: the GTIN-14, EAN-13 and UPC-12 forms of one product differ
  // only in leading zeros.
  function eanKey(ean) { return String(ean == null ? '' : ean).replace(/\s+/g, '').replace(/^0+/, ''); }

  function canonicalStore(s) {
    const n = normalizeName(s);
    if (!n) return null;
    if (n.indexOf('colruyt') === 0 || n === 'collect go' || n === 'collect and go') return 'Colruyt';
    if (n.indexOf('delhaize') === 0) return 'Delhaize';
    if (n.indexOf('carrefour') === 0) return 'Carrefour';
    return null;
  }

  function toNumber(v) {
    if (isNum(v)) return v;
    if (typeof v === 'string' && v.trim() !== '') {
      const n = Number(v.trim().replace(',', '.'));
      return isFinite(n) ? n : NaN;
    }
    return NaN;
  }

  function parseImport(text) {
    const errors = [];
    let data;
    try { data = typeof text === 'string' ? JSON.parse(text) : text; } catch (e) {
      return { rows: [], errors: ['The file is not valid JSON: ' + e.message] };
    }
    if (!Array.isArray(data)) return { rows: [], errors: ['Expected a JSON array of price rows.'] };
    const rows = [];
    data.forEach(function (r, i) {
      const at = 'Row ' + (i + 1) + ': ';
      if (!r || typeof r !== 'object') { errors.push(at + 'not an object'); return; }
      if (r.store == null || String(r.store).trim() === '') { errors.push(at + 'missing store'); return; }
      const store = canonicalStore(r.store);
      if (!store) { errors.push(at + 'unknown store "' + r.store + '" (use Colruyt, Delhaize or Carrefour)'); return; }
      const price = toNumber(r.price_eur);
      if (Number.isNaN(price) || price < 0) { errors.push(at + 'price_eur is not a number'); return; }
      const pack = toNumber(r.pack_size_g);
      if (Number.isNaN(pack) || pack <= 0) { errors.push(at + 'pack_size_g must be a number above 0'); return; }
      let date = r.date == null || r.date === '' ? null : String(r.date).trim();
      if (date !== null && !ISO_RE.test(date)) { errors.push(at + 'date must look like 2026-09-25'); return; }
      const ean = r.ean == null ? '' : String(r.ean).replace(/\s+/g, '').trim();
      const product = r.product == null ? '' : String(r.product).trim();
      if (!ean && !product) { errors.push(at + 'needs an ean or a product name'); return; }
      const out = { store: store, ean: ean, product: product, pack_size_g: pack, price_eur: price, promo: r.promo === true || r.promo === 'true', date: date };
      // Optional: the product-table name the row should match, when "product" is the store's (newer) name.
      const matchProduct = r.match_product == null ? '' : String(r.match_product).trim();
      if (matchProduct) out.match_product = matchProduct;
      rows.push(out);
    });
    return { rows: rows, errors: errors };
  }

  function applyImport(products, rows, todayIso) {
    const out = (products || []).map(function (r) { return Object.assign({}, r); });
    const matched = [];
    const unmatched = [];
    const updatedIds = {};
    (rows || []).forEach(function (row) {
      const key = eanKey(row.ean);
      let hits = [];
      if (key) hits = out.filter(function (p) { return p.store === row.store && eanKey(p.ean) === key; });
      // Then the table's name (match_product), then the store's name; the row then takes the store's name.
      const names = [row.match_product, row.product].map(normalizeName).filter(Boolean);
      for (let i = 0; !hits.length && i < names.length; i++) {
        hits = out.filter(function (p) { return p.store === row.store && normalizeName(p.product) === names[i]; });
      }
      if (!hits.length) { unmatched.push(row); return; }
      hits.forEach(function (p) {
        if (row.product) p.product = row.product;
        if (row.ean && !p.ean) p.ean = row.ean;
        p.packSizeG = row.pack_size_g;
        p.price = row.price_eur;
        p.promo = !!row.promo;
        p.date = row.date || todayIso;
        p.source = 'import';
        updatedIds[p.id] = true;
        matched.push({ row: row, productId: p.id });
      });
    });
    return {
      products: out, matched: matched, unmatched: unmatched,
      summary: { matched: (rows || []).length - unmatched.length, updated: Object.keys(updatedIds).length, unmatched: unmatched.length }
    };
  }

  // Unmatched rows kept for mapping: one entry per store + barcode (store + normalised name without a barcode).
  // The newest row wins: an incoming row replaces an entry unless its date is older.
  function mergeUnmatched(existing, incoming) {
    const out = [];
    const at = {};
    (existing || []).concat(incoming || []).forEach(function (r) {
      if (!r || typeof r !== 'object') return;
      const e = eanKey(r.ean);
      const k = r.store + '|' + (e ? 'ean:' + e : 'name:' + normalizeName(r.product));
      if (!(k in at)) { at[k] = out.length; out.push(r); return; }
      const old = out[at[k]];
      if (!(old.date && r.date && r.date < old.date)) out[at[k]] = r;
    });
    return out;
  }

  function mapImportRow(products, row, foodId) {
    const list = (products || []).slice();
    const base = String(row.store).toLowerCase() + '-' + foodId + '-' + (row.ean || 'n');
    let id = base, n = 2;
    const taken = function (x) { return list.some(function (p) { return p.id === x; }); };
    while (taken(id)) id = base + '-' + n++;
    list.push({
      id: id, store: row.store, foodId: foodId, product: row.product || '', ean: row.ean || '', packSizeG: row.pack_size_g,
      price: row.price_eur, promo: !!row.promo, date: row.date || null, source: 'import', url: '', note: 'Added from a price import'
    });
    return list;
  }

  const api = {
    STORES: STORES, mealOccurrences: mealOccurrences, weeklyQuantities: weeklyQuantities, packsFor: packsFor, isStale: isStale,
    storeBreakdown: storeBreakdown, buildExport: buildExport, parseImport: parseImport, applyImport: applyImport,
    mergeUnmatched: mergeUnmatched, mapImportRow: mapImportRow, normalizeName: normalizeName, canonicalStore: canonicalStore
  };

  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.FL = root.FL || {}; root.FL.groceries = api; }
})(typeof window !== 'undefined' ? window : globalThis);
