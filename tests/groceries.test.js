'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('../app/js/groceries.js');
const foods = require('../app/js/foods.js');

const FOODS = foods.byId();

function plan(meals) {
  return { mealsPerDay: meals.length, targets: {}, warnings: [], meals: meals.map(function (m) {
    return { key: m[0], name: m[0], share: 0.25, items: m[1].map(function (i) { return { foodId: i[0], role: i[1], grams: i[2] }; }) };
  }) };
}

const PLAN4 = plan([
  ['breakfast', [['skyr', 'protein', 300], ['oats', 'carb', 60], ['apple', 'produce', 170]]],
  ['lunch', [['chicken_breast', 'protein', 150], ['potatoes', 'carb', 300], ['broccoli', 'produce', 200], ['olive_oil', 'fat', 10]]],
  ['snack_pm', [['quark', 'protein', 250], ['rice_cakes', 'carb', 16], ['banana', 'produce', 120]]],
  ['dinner', [['chicken_breast', 'protein', 200], ['potatoes', 'carb', 350], ['carrots', 'produce', 200], ['olive_oil', 'fat', 10]]]
]);

function row(id, store, foodId, pack, price, extra) {
  return Object.assign({ id: id, store: store, foodId: foodId, product: id, ean: '', packSizeG: pack, price: price, promo: false, date: '2026-09-25', source: 'import', url: '', note: '' }, extra || {});
}

test('meal occurrences follow the Saturday mode', function () {
  assert.equal(G.mealOccurrences('breakfast', 'offplan'), 6);
  assert.equal(G.mealOccurrences('lunch', 'offplan'), 6);
  assert.equal(G.mealOccurrences('breakfast', 'included'), 7);
  assert.equal(G.mealOccurrences('lunch', 'included'), 7);
  ['snack_pm', 'dinner', 'snack_eve'].forEach(function (k) {
    assert.equal(G.mealOccurrences(k, 'offplan'), 7);
    assert.equal(G.mealOccurrences(k, 'included'), 7);
  });
});

test('weekly quantities multiply grams by occurrences and merge foods across meals', function () {
  const q = G.weeklyQuantities(PLAN4, 'offplan');
  const by = {};
  q.forEach(function (x) { by[x.foodId] = x; });
  assert.equal(by.chicken_breast.grams, 150 * 6 + 200 * 7);
  assert.equal(by.potatoes.grams, 300 * 6 + 350 * 7);
  assert.equal(by.olive_oil.grams, 10 * 6 + 10 * 7);
  assert.equal(by.skyr.grams, 300 * 6);
  assert.equal(by.quark.grams, 250 * 7);
  assert.deepEqual(by.chicken_breast.perMeal, [{ mealKey: 'lunch', grams: 150, times: 6 }, { mealKey: 'dinner', grams: 200, times: 7 }]);
  const inc = G.weeklyQuantities(PLAN4, 'included');
  assert.equal(inc.find(function (x) { return x.foodId === 'chicken_breast'; }).grams, 150 * 7 + 200 * 7);
  assert.deepEqual(q.map(function (x) { return x.foodId; }), q.map(function (x) { return x.foodId; }).slice().sort());
});

test('3- and 5-meal layouts: every meal after lunch counts 7 times', function () {
  const p3 = plan([['breakfast', [['eggs', 'protein', 110]]], ['lunch', [['eggs', 'protein', 110]]], ['dinner', [['eggs', 'protein', 110]]]]);
  assert.equal(G.weeklyQuantities(p3, 'offplan')[0].grams, 110 * (6 + 6 + 7));
  const p5 = plan([['breakfast', [['skyr', 'protein', 100]]], ['lunch', [['skyr', 'protein', 100]]], ['snack_pm', [['skyr', 'protein', 100]]],
    ['dinner', [['skyr', 'protein', 100]]], ['snack_eve', [['skyr', 'protein', 100]]]]);
  assert.equal(G.weeklyQuantities(p5, 'offplan')[0].grams, 100 * (6 + 6 + 7 + 7 + 7));
  assert.equal(G.weeklyQuantities(p5, 'included')[0].grams, 100 * 35);
});

test('packs round up and report leftover', function () {
  assert.deepEqual(G.packsFor(2300, { packSizeG: 1000, price: 9.99 }), { packs: 3, cost: 29.97, leftoverG: 700 });
  assert.deepEqual(G.packsFor(1000, { packSizeG: 1000, price: 2 }), { packs: 1, cost: 2, leftoverG: 0 });
  assert.deepEqual(G.packsFor(1, { packSizeG: 500, price: 1.5 }), { packs: 1, cost: 1.5, leftoverG: 499 });
  assert.deepEqual(G.packsFor(0, { packSizeG: 500, price: 1.5 }), { packs: 0, cost: 0, leftoverG: 0 });
  assert.deepEqual(G.packsFor(100, { packSizeG: 0, price: 1 }), { packs: null, cost: null, leftoverG: null });
  assert.deepEqual(G.packsFor(100, { packSizeG: 100 }), { packs: null, cost: null, leftoverG: null });
});

test('stale flags: estimate, no date, and older than 7 days (7 is still fresh)', function () {
  const today = '2026-09-25';
  assert.deepEqual(G.isStale({ source: 'estimate', date: null }, today), { stale: true, reason: 'estimate', ageDays: null });
  assert.equal(G.isStale({ source: 'estimate', date: '2026-09-25' }, today).reason, 'estimate');
  assert.equal(G.isStale({ source: 'import', date: null }, today).reason, 'no date');
  assert.deepEqual(G.isStale({ source: 'import', date: '2026-09-18' }, today), { stale: false, reason: null, ageDays: 7 });
  assert.deepEqual(G.isStale({ source: 'import', date: '2026-09-17' }, today), { stale: true, reason: 'older than 7 days', ageDays: 8 });
  assert.equal(G.isStale({ source: 'manual', date: '2026-09-25' }, today).stale, false);
});

test('store breakdown picks the cheapest row per store and the cheapest store per food', function () {
  const q = [{ foodId: 'chicken_breast', grams: 2300, perMeal: [] }, { foodId: 'oats', grams: 360, perMeal: [] }, { foodId: 'tofu', grams: 400, perMeal: [] }];
  const products = [
    row('c-chk-1kg', 'Colruyt', 'chicken_breast', 1000, 11.49),
    row('c-chk-500', 'Colruyt', 'chicken_breast', 500, 5.49),
    row('d-chk', 'Delhaize', 'chicken_breast', 600, 6.29),
    row('k-chk', 'Carrefour', 'chicken_breast', 1000, 12.99, { date: '2026-09-01' }),
    row('c-oats', 'Colruyt', 'oats', 500, 1.29),
    row('d-oats', 'Delhaize', 'oats', 500, 1.29),
    row('k-oats', 'Carrefour', 'oats', 1000, 2.19, { source: 'estimate', date: null })
  ];
  const br = G.storeBreakdown(q, products, '2026-09-25');
  const col = br.stores.Colruyt;
  const cChk = col.items.find(function (i) { return i.foodId === 'chicken_breast'; });
  // 3 × 1 kg = 34.47 vs 5 × 500 g = 27.45 → the 500 g pack wins.
  assert.equal(cChk.row.id, 'c-chk-500');
  assert.equal(cChk.packs, 5);
  assert.equal(cChk.cost, 27.45);
  assert.equal(cChk.leftoverG, 200);
  assert.deepEqual(col.missing, ['tofu']);
  assert.equal(col.total, Math.round((27.45 + 1.29) * 100) / 100);
  assert.equal(br.stores.Carrefour.staleCount, 2);
  // Delhaize chicken: 4 × 600 g × 6.29 = 25.16 is cheapest; oats tie Colruyt/Delhaize → Colruyt (STORES order).
  const ch = {};
  br.cheapest.items.forEach(function (i) { ch[i.foodId] = i; });
  assert.equal(ch.chicken_breast.store, 'Delhaize');
  assert.equal(ch.chicken_breast.cost, 25.16);
  assert.equal(ch.oats.store, 'Colruyt');
  assert.deepEqual(br.cheapest.missing, ['tofu']);
  assert.equal(br.cheapest.total, Math.round((25.16 + 1.29) * 100) / 100);
});

test('rows without a price never beat priced rows', function () {
  const q = [{ foodId: 'oats', grams: 500, perMeal: [] }];
  const br = G.storeBreakdown(q, [row('a', 'Colruyt', 'oats', 500, null), row('b', 'Colruyt', 'oats', 500, 1.99)], '2026-09-25');
  assert.equal(br.stores.Colruyt.items[0].row.id, 'b');
});

test('export has the documented shape', function () {
  const q = G.weeklyQuantities(PLAN4, 'offplan');
  const products = [row('c-eggs', 'Colruyt', 'eggs', 550, 3.19, { ean: '5400141000001', product: 'Boni eieren 10 st', url: 'https://example.org/eggs' })];
  const q2 = q.concat([{ foodId: 'eggs', grams: 770, perMeal: [] }]);
  const ex = G.buildExport(q2, products, FOODS, { start: '2026-10-03', end: '2026-10-09' }, '2026-10-02');
  assert.equal(ex.generated, '2026-10-02');
  assert.deepEqual(ex.week, { start: '2026-10-03', end: '2026-10-09', label: 'Sat 3 Oct dinner → Fri 9 Oct dinner' });
  const eggs = ex.items.find(function (i) { return i.food_id === 'eggs'; });
  assert.deepEqual(eggs, {
    food_id: 'eggs', food: 'Eggs', food_nl: 'Eieren', weekly_g: 770, unit_g: 55,
    stores: { Colruyt: [{ ean: '5400141000001', product: 'Boni eieren 10 st', pack_size_g: 550, url: 'https://example.org/eggs' }], Delhaize: [], Carrefour: [] }
  });
  const chk = ex.items.find(function (i) { return i.food_id === 'chicken_breast'; });
  assert.equal(chk.weekly_g, 2300);
  assert.equal(chk.unit_g, null);
});

test('parseImport validates rows and canonicalises store names', function () {
  const text = JSON.stringify([
    { store: 'colruyt', ean: ' 5400141 044429 ', product: 'Boni skyr', pack_size_g: 500, price_eur: 2.49, promo: false, date: '2026-09-25' },
    { store: 'Carrefour Belgium', ean: '', product: 'Kipfilet', pack_size_g: '600', price_eur: '6,49', date: null },
    { store: 'DELHAIZE', product: 'Havermout', pack_size_g: 500, price_eur: 1.19, promo: true, date: '2026-09-24' },
    { ean: '1', product: 'x', pack_size_g: 1, price_eur: 1 },
    { store: 'Aldi', product: 'x', pack_size_g: 1, price_eur: 1 },
    { store: 'Colruyt', product: 'x', pack_size_g: 1, price_eur: 'abc' },
    { store: 'Colruyt', product: 'x', pack_size_g: 0, price_eur: 1 },
    { store: 'Colruyt', product: 'x', pack_size_g: 1, price_eur: 1, date: '25/09/2026' },
    'nope'
  ]);
  const r = G.parseImport(text);
  assert.equal(r.rows.length, 3);
  assert.deepEqual(r.rows[0], { store: 'Colruyt', ean: '5400141044429', product: 'Boni skyr', pack_size_g: 500, price_eur: 2.49, promo: false, date: '2026-09-25' });
  assert.equal(r.rows[1].store, 'Carrefour');
  assert.equal(r.rows[1].price_eur, 6.49);
  assert.equal(r.rows[1].pack_size_g, 600);
  assert.equal(r.rows[2].store, 'Delhaize');
  assert.equal(r.rows[2].promo, true);
  assert.equal(r.errors.length, 6);
  assert.match(r.errors[0], /Row 4: missing store/);
  assert.match(r.errors[1], /Row 5: unknown store/);
  assert.match(r.errors[2], /Row 6: price_eur/);
  assert.match(r.errors[3], /Row 7: pack_size_g/);
  assert.match(r.errors[4], /Row 8: date/);
  assert.match(r.errors[5], /Row 9: not an object/);
  assert.deepEqual(G.parseImport('{bad').rows, []);
  assert.equal(G.parseImport('{"a":1}').errors[0], 'Expected a JSON array of price rows.');
});

test('applyImport matches by EAN, falls back to normalised name, and never mutates inputs', function () {
  const products = [
    row('c-skyr', 'Colruyt', 'skyr', 450, 2.19, { ean: '5400141044429', product: 'Boni Skyr natuur', source: 'estimate', date: null }),
    row('c-skyr-b', 'Colruyt', 'skyr', 450, 2.19, { ean: '5400141044429', product: 'Boni Skyr natuur (duplicate)', source: 'estimate', date: null }),
    row('d-quark', 'Delhaize', 'quark', 500, 1.59, { ean: '', product: 'Délhaize  Platte kaas mager 0%' }),
    row('k-oats', 'Carrefour', 'oats', 500, 1.29, { ean: '3560070000000' })
  ];
  const before = JSON.parse(JSON.stringify(products));
  const rows = [
    { store: 'Colruyt', ean: '5400141044429', product: 'BONI Skyr natuur 500g', pack_size_g: 500, price_eur: 2.49, promo: true, date: '2026-09-24' },
    { store: 'Delhaize', ean: '', product: 'delhaize platte kaas MAGER 0 %', pack_size_g: 500, price_eur: 1.49, promo: false, date: null },
    { store: 'Delhaize', ean: '999', product: 'Unknown product', pack_size_g: 100, price_eur: 1, promo: false, date: '2026-09-25' },
    { store: 'Colruyt', ean: '3560070000000', product: 'Carrefour oats at the wrong store', pack_size_g: 500, price_eur: 1, promo: false, date: '2026-09-25' }
  ];
  const res = G.applyImport(products, rows, '2026-09-25');
  assert.deepEqual(products, before, 'input products untouched');
  const by = {};
  res.products.forEach(function (p) { by[p.id] = p; });
  assert.equal(by['c-skyr'].price, 2.49);
  assert.equal(by['c-skyr'].packSizeG, 500);
  assert.equal(by['c-skyr'].promo, true);
  assert.equal(by['c-skyr'].date, '2026-09-24');
  assert.equal(by['c-skyr'].source, 'import');
  assert.equal(by['c-skyr'].product, 'BONI Skyr natuur 500g');
  assert.equal(by['c-skyr-b'].price, 2.49, 'every row with the same store+EAN is updated');
  // "delhaize platte kaas MAGER 0 %" vs "Délhaize  Platte kaas mager 0%": accents, case and spacing differ.
  assert.equal(G.normalizeName('Délhaize  Platte kaas mager 0%'), 'delhaize platte kaas mager 0%');
  assert.equal(by['d-quark'].price, 1.59, 'the "0 %" spacing makes this a different name');
  assert.equal(res.unmatched.length, 3);
  assert.equal(res.summary.matched, 1);
  assert.equal(res.summary.updated, 2);
  assert.equal(res.summary.unmatched, 3);
  assert.deepEqual(res.unmatched[2], rows[3], 'unmatched rows returned untouched');
});

test('name fallback matches when the normalised names are equal', function () {
  const products = [row('d-quark', 'Delhaize', 'quark', 500, 1.59, { ean: '', product: 'Délhaize  Platte-kaas mager 0%' })];
  const res = G.applyImport(products, [{ store: 'Delhaize', ean: '', product: 'delhaize platte kaas MAGER 0%', pack_size_g: 500, price_eur: 1.49, promo: false, date: null }], '2026-09-25');
  assert.equal(res.products[0].price, 1.49);
  assert.equal(res.products[0].date, '2026-09-25', 'a missing date becomes the import day');
  assert.equal(res.summary.matched, 1);
});

test('mapImportRow adds a new import row with a unique id', function () {
  const products = [row('colruyt-tofu-123', 'Colruyt', 'tofu', 200, 2)];
  const r = { store: 'Colruyt', ean: '123', product: 'Tofu naturel', pack_size_g: 400, price_eur: 2.99, promo: false, date: '2026-09-25' };
  const out = G.mapImportRow(products, r, 'tofu');
  assert.equal(products.length, 1);
  assert.equal(out.length, 2);
  assert.equal(out[1].id, 'colruyt-tofu-123-2');
  assert.equal(out[1].packSizeG, 400);
  assert.equal(out[1].price, 2.99);
  assert.equal(out[1].source, 'import');
  const out2 = G.mapImportRow(out, Object.assign({}, r, { ean: '' }), 'tofu');
  assert.equal(out2[2].id, 'colruyt-tofu-n');
});
