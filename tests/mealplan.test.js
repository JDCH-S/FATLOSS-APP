'use strict';
// Tests for app/js/mealplan.js (SPEC §5). Run: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const M = require('../app/js/mealplan.js');
const foods = require('../app/js/foods.js');

const F = foods.byId();
const LIKED = foods.DEFAULT_LIKED;
const TYPE = { breakfast: 'breakfast', snack_pm: 'breakfast', snack_eve: 'breakfast', lunch: 'main', dinner: 'main' };

// ---------- helpers (independent of the module's own totals) ----------
function targetsFor(kcal, protein) {
  const fat = Math.max(0.22 * kcal / 9, 51);
  return { kcal: kcal, protein: protein, fat: fat, carbs: (kcal - 4 * protein - 9 * fat) / 4 };
}

function totals(plan, map) {
  const day = { kcal: 0, protein: 0, carbs: 0, fat: 0, fibre: 0 };
  const meals = {};
  plan.meals.forEach(function (m) {
    const t = { kcal: 0, protein: 0, carbs: 0, fat: 0, fibre: 0 };
    m.items.forEach(function (it) {
      const f = map[it.foodId];
      Object.keys(t).forEach(function (k) { t[k] += (f[k] || 0) * it.grams / 100; });
    });
    meals[m.key] = t;
    Object.keys(day).forEach(function (k) { day[k] += t[k]; });
  });
  return { day: day, meals: meals };
}

function distinct(plan, map, category) {
  const ids = new Set();
  plan.meals.forEach(function (m) {
    m.items.forEach(function (it) { if (it.role === 'produce' && map[it.foodId].category === category) ids.add(it.foodId); });
  });
  return ids.size;
}

function isRounded(food, g) {
  if (food.unit) {
    const n = g / food.unit.grams;
    return n >= 1 && Math.abs(n - Math.round(n)) < 1e-9;
  }
  return g >= 5 && g % 5 === 0;
}

function allowedSet(liked, excluded) {
  return new Set(liked.filter(function (id) { return (excluded || []).indexOf(id) < 0; }));
}

// Structural rules that hold for every generated plan: layout, roles, rounding, caps, allowed foods.
function assertStructure(plan, map, allowed, label) {
  const layout = M.MEAL_LAYOUTS[plan.mealsPerDay];
  assert.deepEqual(plan.meals.map(function (m) { return m.key; }), layout.map(function (l) { return l.key; }), label);
  plan.meals.forEach(function (m, i) {
    assert.equal(m.name, layout[i].name, label);
    assert.equal(m.share, layout[i].share, label);
    const type = TYPE[m.key];
    m.items.forEach(function (it) {
      const f = M.normalizeFood(map[it.foodId]);
      const where = label + ' ' + m.key + ' ' + it.foodId + ' ' + it.grams;
      assert.ok(allowed.has(it.foodId), 'not allowed: ' + where);
      assert.ok(f.slots.indexOf(it.role) >= 0, 'role not in slots: ' + where);
      assert.ok(f.meals.indexOf(type) >= 0, 'meal type mismatch: ' + where);
      assert.ok(isRounded(f, it.grams), 'not rounded: ' + where);
      assert.ok(it.grams <= f.maxPerMeal + 1e-9, 'above maxPerMeal: ' + where);
    });
    const ids = m.items.map(function (it) { return it.foodId; });
    assert.equal(new Set(ids).size, ids.length, 'duplicate food in meal: ' + label + ' ' + m.key);
    assert.ok(m.items.filter(function (it) { return it.role === 'fat'; }).length <= 1, label + ' ' + m.key);
  });
}

// Full SPEC rule 1-3 acceptance: structure plus day totals, fibre, variety and no warnings.
function assertPlanMeetsRules(plan, map, targets, allowed, label) {
  assertStructure(plan, map, allowed, label);
  plan.meals.forEach(function (m) {
    const count = function (role) { return m.items.filter(function (it) { return it.role === role; }).length; };
    assert.equal(count('protein'), 1, label + ' ' + m.key + ' protein');
    assert.equal(count('carb'), 1, label + ' ' + m.key + ' carb');
    assert.ok(count('produce') >= 1, label + ' ' + m.key + ' produce');
  });
  const d = totals(plan, map).day;
  const kPct = (d.kcal - targets.kcal) / targets.kcal * 100;
  assert.ok(Math.abs(kPct) <= 5, label + ' kcal ' + d.kcal.toFixed(0) + ' (' + kPct.toFixed(1) + ' %)');
  assert.ok(Math.abs(d.protein - targets.protein) <= 10, label + ' protein ' + d.protein.toFixed(1));
  assert.ok(d.fibre >= 25, label + ' fibre ' + d.fibre.toFixed(1));
  assert.ok(distinct(plan, map, 'vegetable') >= 2, label + ' vegetables');
  assert.ok(distinct(plan, map, 'fruit') >= 1, label + ' fruit');
  assert.deepEqual(plan.warnings, [], label + ' warnings');
}

function gen(opts) {
  return M.generatePlan(Object.assign({ foods: F, liked: LIKED, excluded: [], mealsPerDay: 4 }, opts));
}

function clone(x) { return JSON.parse(JSON.stringify(x)); }

// A typical plan used by the rescale and swap tests.
const T0 = targetsFor(2400, 185);
const BASE = gen({ targets: T0 });

// ---------- module shape ----------
test('module works in the browser branch (window.FL.mealplan) and uses no clock or randomness', function () {
  const src = fs.readFileSync(path.join(__dirname, '..', 'app', 'js', 'mealplan.js'), 'utf8');
  const sandbox = { window: {} };
  vm.runInNewContext(src, sandbox);
  assert.equal(typeof sandbox.window.FL.mealplan.generatePlan, 'function');
  assert.ok(!/Math\.random|Date\.now|new Date\s*\(/.test(src));
  ['MEAL_LAYOUTS', 'generatePlan', 'rescalePlan', 'swapCandidates', 'swapFood', 'planTotals', 'checkPlan', 'roundGrams', 'normalizeFood']
    .forEach(function (k) { assert.ok(k in M, k); });
});

test('MEAL_LAYOUTS match the spec', function () {
  const view = function (n) { return M.MEAL_LAYOUTS[n].map(function (m) { return [m.key, m.name, m.share, m.type]; }); };
  assert.deepEqual(view(3), [['breakfast', 'Breakfast', 0.30, 'breakfast'], ['lunch', 'Lunch', 0.35, 'main'], ['dinner', 'Dinner', 0.35, 'main']]);
  assert.deepEqual(view(4), [['breakfast', 'Breakfast', 0.25, 'breakfast'], ['lunch', 'Lunch', 0.30, 'main'],
    ['snack_pm', 'Afternoon snack', 0.15, 'breakfast'], ['dinner', 'Dinner', 0.30, 'main']]);
  assert.deepEqual(view(5), [['breakfast', 'Breakfast', 0.22, 'breakfast'], ['lunch', 'Lunch', 0.28, 'main'],
    ['snack_pm', 'Afternoon snack', 0.12, 'breakfast'], ['dinner', 'Dinner', 0.28, 'main'], ['snack_eve', 'Evening snack', 0.10, 'breakfast']]);
  [3, 4, 5].forEach(function (n) {
    const sum = M.MEAL_LAYOUTS[n].reduce(function (s, m) { return s + m.share; }, 0);
    assert.ok(Math.abs(sum - 1) < 1e-9);
  });
});

// ---------- roundGrams / normalizeFood ----------
test('roundGrams: nearest 5 g, whole units for unit foods, never below one step', function () {
  assert.equal(M.roundGrams(F.chicken_breast, 152.4), 150);
  assert.equal(M.roundGrams(F.chicken_breast, 152.5), 155);
  assert.equal(M.roundGrams(F.chicken_breast, 2), 5);
  assert.equal(M.roundGrams(F.chicken_breast, 0), 5);
  assert.equal(M.roundGrams(F.eggs, 80), 55);        // 1.45 eggs → 1
  assert.equal(M.roundGrams(F.eggs, 90), 110);       // 1.64 eggs → 2
  assert.equal(M.roundGrams(F.eggs, 0), 55);
  assert.equal(M.roundGrams(F.bread_wholemeal, 100), 105);
  assert.equal(M.roundGrams({ unit: null }, 12), 10);
});

test('normalizeFood fills defaults for custom foods and keeps existing fields', function () {
  const base = { name: 'x', custom: true, kcal: 200, protein: 10, carbs: 10, fat: 10, fibre: 1 };
  const make = function (extra) { return M.normalizeFood(Object.assign({ id: 'custom_x' }, base, extra)); };

  assert.deepEqual(make({ category: 'protein' }).slots, ['protein']);
  assert.deepEqual(make({ category: 'carb' }).slots, ['carb']);
  assert.deepEqual(make({ category: 'vegetable' }).slots, ['produce']);
  assert.deepEqual(make({ category: 'fruit' }).slots, ['produce']);
  assert.deepEqual(make({ category: 'fat' }).slots, ['fat']);
  // dairy: protein ≥ 40 % of energy → protein; else fat ≥ 60 % → fat; else no role
  assert.deepEqual(make({ category: 'dairy', kcal: 80, protein: 8, fat: 1 }).slots, ['protein']);
  assert.deepEqual(make({ category: 'dairy', kcal: 400, protein: 20, fat: 30 }).slots, ['fat']);
  assert.deepEqual(make({ category: 'dairy', kcal: 60, protein: 3.4, fat: 1.5, carbs: 5 }).slots, []);

  const p = make({ category: 'protein' });
  assert.deepEqual(p.meals, ['breakfast', 'main']);
  assert.equal(p.fill, 3);
  assert.equal(p.unit, null);
  assert.equal(p.maxPerMeal, 350);
  // fat/carb foods: grams giving ~900 kcal (rounded to 5 g, or whole units)
  assert.equal(make({ category: 'carb', kcal: 360 }).maxPerMeal, 250);
  assert.equal(make({ category: 'fat', kcal: 600 }).maxPerMeal, 150);
  assert.equal(make({ category: 'carb', kcal: 250, unit: { name: 'slice', grams: 40 } }).maxPerMeal, 360);
  assert.equal(make({ category: 'protein', unit: { name: 'pack', grams: 100 } }).maxPerMeal, 300);

  // built-in foods pass through unchanged, and the input is never mutated
  const eggs = clone(F.eggs);
  assert.deepEqual(M.normalizeFood(F.eggs), F.eggs);
  assert.deepEqual(F.eggs, eggs);
  const custom = { id: 'custom_y', category: 'fat', kcal: 700, protein: 1, carbs: 1, fat: 77 };
  const copy = clone(custom);
  M.normalizeFood(custom);
  assert.deepEqual(custom, copy);
  assert.deepEqual(M.normalizeFood(M.normalizeFood(custom)), M.normalizeFood(custom));
});

// ---------- generatePlan ----------
test('property grid: every combo meets the rules with the default liked foods', function () {
  const allowed = allowedSet(LIKED);
  let combos = 0;
  [3, 4, 5].forEach(function (n) {
    for (let kcal = 1800; kcal <= 3400; kcal += 100) {
      [150, 185, 220].forEach(function (protein) {
        const T = targetsFor(kcal, protein);
        if (T.carbs < 80) return;
        const plan = gen({ targets: T, mealsPerDay: n });
        assert.equal(plan.mealsPerDay, n);
        assert.deepEqual(plan.targets, T);
        assertPlanMeetsRules(plan, F, T, allowed, n + ' meals / ' + kcal + ' kcal / ' + protein + ' g');
        combos++;
      });
    }
  });
  assert.ok(combos > 120, 'grid too small: ' + combos);
});

test('fat and carbs land close to target in the typical range (rule 2)', function () {
  [4, 5].forEach(function (n) {
    for (let kcal = 2000; kcal <= 3000; kcal += 100) {
      [150, 185].forEach(function (protein) {
        const T = targetsFor(kcal, protein);
        const d = totals(gen({ targets: T, mealsPerDay: n }), F).day;
        const label = n + '/' + kcal + '/' + protein;
        assert.ok(Math.abs(d.fat - T.fat) <= 6, label + ' fat ' + d.fat.toFixed(1) + ' vs ' + T.fat.toFixed(1));
        assert.ok(Math.abs(d.carbs - T.carbs) <= 0.1 * T.carbs, label + ' carbs ' + d.carbs.toFixed(0) + ' vs ' + T.carbs.toFixed(0));
      });
    }
  });
});

test('deterministic: same input → identical plan (also with a reordered liked list)', function () {
  const T = targetsFor(2600, 185);
  [3, 4, 5].forEach(function (n) {
    const a = gen({ targets: T, mealsPerDay: n });
    const b = gen({ targets: T, mealsPerDay: n });
    assert.deepStrictEqual(a, b);
    assert.deepStrictEqual(gen({ targets: T, mealsPerDay: n, liked: LIKED.slice().reverse() }), a);
  });
});

test('food choice follows the ranking with variety across meals (rule 4) and produce placement (rule 5)', function () {
  const plan = BASE;
  const nf = function (id) { return M.normalizeFood(F[id]); };
  const proteinScore = function (id) { const f = nf(id); return f.protein * 100 / f.kcal + f.fill; };
  const carbKey = function (id) { const f = nf(id); return [f.fill, f.fibre * 100 / f.kcal]; };
  const ranked = function (role, type, key) {
    return LIKED.filter(function (id) { const f = nf(id); return f.slots.indexOf(role) >= 0 && f.meals.indexOf(type) >= 0; })
      .sort(function (a, b) {
        const ka = [].concat(key(a)), kb = [].concat(key(b));
        for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return kb[i] - ka[i];
        return a < b ? -1 : 1;
      });
  };
  const item = function (key, role) {
    return plan.meals.filter(function (m) { return m.key === key; })[0].items.filter(function (it) { return it.role === role; })[0].foodId;
  };
  const mainProteins = ranked('protein', 'main', proteinScore);
  const bfCarbs = ranked('carb', 'breakfast', carbKey);
  const mainCarbs = ranked('carb', 'main', carbKey);
  assert.equal(item('breakfast', 'protein'), ranked('protein', 'breakfast', proteinScore)[0]);
  assert.equal(item('lunch', 'protein'), mainProteins[0]);
  assert.equal(item('dinner', 'protein'), mainProteins[1]);          // not repeated
  assert.equal(item('breakfast', 'carb'), bfCarbs[0]);
  assert.equal(item('snack_pm', 'carb'), bfCarbs[1]);                // oats already used at breakfast
  assert.equal(item('lunch', 'carb'), mainCarbs[0]);
  assert.notEqual(item('dinner', 'carb'), item('lunch', 'carb'));
  plan.meals.forEach(function (m) {
    m.items.filter(function (it) { return it.role === 'produce'; }).forEach(function (it) {
      assert.equal(F[it.foodId].category, TYPE[m.key] === 'main' ? 'vegetable' : 'fruit', m.key + ' ' + it.foodId);
      if (F[it.foodId].category === 'vegetable') assert.ok(it.grams >= 200, 'vegetables start at ~200 g');
    });
  });
});

test('vegetable portions grow from ~200 g until fibre ≥ 25 g (rule 5)', function () {
  const liked = ['chicken_breast', 'cod', 'skyr', 'quark', 'rice_basmati', 'pasta', 'rice_cakes', 'green_beans', 'courgette', 'mandarin', 'olive_oil'];
  const T = targetsFor(2400, 185);
  const plan = gen({ liked: liked, targets: T });
  assertPlanMeetsRules(plan, F, T, allowedSet(liked), 'low-fibre foods');
  const veg = [];
  plan.meals.forEach(function (m) { m.items.forEach(function (it) { if (F[it.foodId].category === 'vegetable') veg.push(it.grams); }); });
  assert.equal(veg.length, 2);
  assert.ok(veg.every(function (g) { return g > 200 && g <= 400; }), 'grown vegetables: ' + veg);
});

test('minimal liked set (1 protein, 1 carb, 2 veg, 1 fruit, 1 fat) meets the rules', function () {
  const liked = ['egg_whites', 'bread_wholemeal', 'broccoli', 'carrots', 'apple', 'almonds'];
  [3, 4, 5].forEach(function (n) {
    [[2000, 150], [2200, 160], [2500, 170]].forEach(function (c) {
      const T = targetsFor(c[0], c[1]);
      assertPlanMeetsRules(gen({ liked: liked, targets: T, mealsPerDay: n }), F, T, allowedSet(liked), 'minimal ' + n + '/' + c);
    });
  });
});

test('no fat food liked: kcal and protein still met; any warning is about fat only', function () {
  const lean = ['chicken_breast', 'cod', 'skyr', 'quark', 'potatoes', 'oats', 'rice_basmati', 'broccoli', 'green_beans', 'apple', 'banana'];
  const noFat = LIKED.filter(function (id) { return ['olive_oil', 'peanut_butter', 'almonds'].indexOf(id) < 0; });
  [[lean, true], [noFat, false]].forEach(function (c) {
    const liked = c[0];
    [3, 4, 5].forEach(function (n) {
      const T = targetsFor(2400, 185);
      const plan = gen({ liked: liked, targets: T, mealsPerDay: n });
      assertStructure(plan, F, allowedSet(liked), 'no fat ' + n);
      const d = totals(plan, F).day;
      assert.ok(Math.abs(d.kcal - T.kcal) / T.kcal <= 0.05, 'kcal ' + d.kcal);
      assert.ok(Math.abs(d.protein - T.protein) <= 10, 'protein ' + d.protein);
      assert.ok(plan.meals.every(function (m) { return m.items.every(function (it) { return it.role !== 'fat'; }); }));
      plan.warnings.forEach(function (w) { assert.match(w, /^Fat /); });
      if (c[1]) assert.equal(plan.warnings.length, 1, 'lean foods only: the fat target is missed and reported');
    });
  });
});

test('no fruit liked: a plan is still returned, with warnings about the missing fruit', function () {
  const liked = LIKED.filter(function (id) { return F[id].category !== 'fruit'; });
  const T = targetsFor(2400, 185);
  const plan = gen({ liked: liked, targets: T });
  assertStructure(plan, F, allowedSet(liked), 'no fruit');
  assert.ok(plan.warnings.some(function (w) { return /No fruit/.test(w); }), plan.warnings.join(' | '));
  assert.ok(plan.warnings.some(function (w) { return /^Breakfast: no vegetable or fruit/.test(w); }));
  const d = totals(plan, F).day;
  assert.ok(Math.abs(d.kcal - T.kcal) / T.kcal <= 0.05);
  assert.ok(Math.abs(d.protein - T.protein) <= 10);
  assert.ok(d.fibre >= 25);
  assert.equal(M.checkPlan(plan, F, T).ok, false);
});

test('excluded foods never appear, even when liked', function () {
  const excluded = ['cod', 'turkey_breast', 'oats', 'green_beans', 'frozen_berries', 'almonds'];
  const allowed = allowedSet(LIKED, excluded);
  [3, 4, 5].forEach(function (n) {
    [1900, 2500, 3000].forEach(function (kcal) {
      const T = targetsFor(kcal, 185);
      const plan = gen({ excluded: excluded, targets: T, mealsPerDay: n });
      assertPlanMeetsRules(plan, F, T, allowed, 'excluded ' + n + '/' + kcal);
    });
  });
});

test('custom foods without slots/meals/fill/maxPerMeal are normalized and used', function () {
  const seitan = { id: 'custom_seitan', name: 'Seitan', nameNl: '', category: 'protein', kcal: 120, protein: 25, carbs: 4, fat: 1.5, fibre: 0.5, unit: null, custom: true };
  const map = foods.byId(foods.FOODS.concat([seitan]));
  const T = targetsFor(2400, 185);

  const liked = LIKED.concat(['custom_seitan']);
  const plan = gen({ foods: map, liked: liked, targets: T });
  assertPlanMeetsRules(plan, map, T, allowedSet(liked), 'custom + defaults');
  assert.ok(plan.meals.some(function (m) { return m.items.some(function (it) { return it.foodId === 'custom_seitan'; }); }));

  // the custom food as the only protein: it fills every meal's protein role (default meals: breakfast + main)
  const only = ['custom_seitan', 'potatoes', 'oats', 'broccoli', 'carrots', 'apple', 'olive_oil', 'almonds'];
  const plan2 = gen({ foods: map, liked: only, targets: T });
  assertPlanMeetsRules(plan2, map, T, allowedSet(only), 'custom only protein');
  plan2.meals.forEach(function (m) {
    assert.equal(m.items.filter(function (it) { return it.role === 'protein'; })[0].foodId, 'custom_seitan');
  });
  assert.equal(seitan.slots, undefined, 'caller food not mutated');
});

test('unmeetable input: empty liked list still returns a well-formed plan with warnings', function () {
  const plan = gen({ liked: [], targets: T0 });
  assert.equal(plan.meals.length, 4);
  assert.ok(plan.meals.every(function (m) { return m.items.length === 0; }));
  assert.ok(plan.warnings.length > 0);
});

test('generatePlan runs well under 100 ms', function () {
  gen({ targets: T0 });
  const cases = [[3, 3300, 150], [4, 2400, 185], [5, 1800, 220], [3, 3400, 185], [5, 3000, 150]];
  cases.forEach(function (c) {
    const t = process.hrtime.bigint();
    gen({ targets: targetsFor(c[1], c[2]), mealsPerDay: c[0] });
    const ms = Number(process.hrtime.bigint() - t) / 1e6;
    assert.ok(ms < 100, c.join('/') + ' took ' + ms.toFixed(1) + ' ms');
  });
});

// ---------- planTotals / checkPlan ----------
test('planTotals sums food.kcal (label energy) per meal and per day', function () {
  const plan = { mealsPerDay: 3, targets: T0, warnings: [], meals: [
    { key: 'lunch', name: 'Lunch', share: 0.5, items: [{ foodId: 'chicken_breast', role: 'protein', grams: 200 }, { foodId: 'potatoes', role: 'carb', grams: 300 }] },
    { key: 'dinner', name: 'Dinner', share: 0.5, items: [{ foodId: 'chia', role: 'fat', grams: 10 }] }
  ] };
  const t = M.planTotals(plan, F);
  const c = F.chicken_breast, p = F.potatoes, ch = F.chia;
  const near = function (a, b) { return Math.abs(a - b) < 1e-9; };
  assert.ok(near(t.meals.lunch.kcal, c.kcal * 2 + p.kcal * 3));
  assert.ok(near(t.meals.lunch.protein, c.protein * 2 + p.protein * 3));
  assert.ok(near(t.meals.dinner.kcal, ch.kcal * 0.1));          // label energy, not 4P + 4C + 9F
  assert.ok(!near(ch.kcal * 0.1, (4 * ch.protein + 4 * ch.carbs + 9 * ch.fat) * 0.1));
  assert.ok(near(t.day.fibre, p.fibre * 3 + ch.fibre * 0.1));
  assert.ok(near(t.day.carbs, p.carbs * 3 + ch.carbs * 0.1));
});

test('checkPlan reports every broken rule', function () {
  const good = M.checkPlan(BASE, F, T0);
  assert.equal(good.ok, true);
  assert.deepEqual(good.issues, []);
  const d = totals(BASE, F).day;
  assert.ok(Math.abs(good.kcalDiffPct - (d.kcal - T0.kcal) / T0.kcal * 100) < 1e-9);
  assert.ok(Math.abs(good.proteinDiffG - (d.protein - T0.protein)) < 1e-9);
  assert.equal(good.vegCount, 2);
  assert.equal(good.fruitCount, 2);

  const bad = { mealsPerDay: 3, targets: T0, warnings: [], meals: [
    { key: 'breakfast', name: 'Breakfast', share: 0.3, items: [{ foodId: 'skyr', role: 'protein', grams: 200 }] },
    { key: 'lunch', name: 'Lunch', share: 0.35, items: [{ foodId: 'cod', role: 'protein', grams: 200 }, { foodId: 'rice_basmati', role: 'carb', grams: 200 },
      { foodId: 'broccoli', role: 'produce', grams: 100 }] },
    { key: 'dinner', name: 'Dinner', share: 0.35, items: [{ foodId: 'cod', role: 'protein', grams: 100 }, { foodId: 'potatoes', role: 'carb', grams: 100 },
      { foodId: 'broccoli', role: 'produce', grams: 100 }] }
  ] };
  const r = M.checkPlan(bad, F, T0);
  assert.equal(r.ok, false);
  assert.equal(r.vegCount, 1);
  assert.equal(r.fruitCount, 0);
  const has = function (re) { assert.ok(r.issues.some(function (s) { return re.test(s); }), re + ' in ' + r.issues.join(' | ')); };
  has(/^Breakfast: no carb food/);
  has(/^Breakfast: no vegetable or fruit/);
  has(/^Lunch: Basmati rice \(dry\) 200 g is above the 150 g per-meal maximum/);
  has(/^Calories /);
  has(/^Protein /);
  has(/^Fibre /);
  has(/^Only 1 different vegetable/);
  has(/^No fruit/);
  has(/^Fat /);
});

// ---------- rescalePlan ----------
function itemsByRole(plan, role) {
  const out = [];
  plan.meals.forEach(function (m, mi) { m.items.forEach(function (it, ii) { if (it.role === role) out.push({ mi: mi, ii: ii, it: it }); }); });
  return out;
}
function gramsAt(plan, x) { return plan.meals[x.mi].items[x.ii].grams; }
function sameShape(a, b) {
  const shape = function (p) { return p.meals.map(function (m) { return [m.key, m.name, m.share, m.items.map(function (it) { return [it.foodId, it.role]; })]; }); };
  assert.deepEqual(shape(a), shape(b));
}
function expectedChanges(before, after) {
  const out = [];
  before.meals.forEach(function (m, mi) {
    m.items.forEach(function (it, ii) {
      const g = after.meals[mi].items[ii].grams;
      if (g !== it.grams) out.push({ mealKey: m.key, foodId: it.foodId, from: it.grams, to: g });
    });
  });
  return out;
}

test('rescalePlan with unchanged targets returns the same plan and no changes', function () {
  const r = M.rescalePlan(BASE, F, Object.assign({}, T0));
  assert.deepStrictEqual(r.plan, BASE);
  assert.notEqual(r.plan, BASE);
  assert.deepEqual(r.changes, []);
});

test('rescalePlan +300 kcal (maintenance-style): only carb items grow, proportionally to their carb grams', function () {
  const before = clone(BASE);
  const T1 = Object.assign({}, T0, { kcal: T0.kcal + 300, carbs: T0.carbs + 75 });
  const r = M.rescalePlan(BASE, F, T1);
  assert.deepStrictEqual(BASE, before, 'input not mutated');
  sameShape(r.plan, BASE);
  assert.deepEqual(r.plan.targets, T1);
  ['protein', 'produce', 'fat'].forEach(function (role) {
    itemsByRole(BASE, role).forEach(function (x) { assert.equal(gramsAt(r.plan, x), x.it.grams, role + ' ' + x.it.foodId + ' unchanged'); });
  });
  const carbs = itemsByRole(BASE, 'carb');
  assert.ok(carbs.every(function (x) { return gramsAt(r.plan, x) >= x.it.grams; }));
  assert.ok(carbs.filter(function (x) { return gramsAt(r.plan, x) > x.it.grams; }).length >= 2);
  // each gram-portioned carb item takes roughly its carb-gram share of the extra energy (whole-unit foods are coarse)
  const dK = T1.kcal - totals(BASE, F).day.kcal;
  const carbG = carbs.reduce(function (s, x) { return s + x.it.grams * F[x.it.foodId].carbs / 100; }, 0);
  carbs.filter(function (x) { return !F[x.it.foodId].unit; }).forEach(function (x) {
    const f = F[x.it.foodId];
    const added = (gramsAt(r.plan, x) - x.it.grams) * f.kcal / 100;
    const share = dK * (x.it.grams * f.carbs / 100) / carbG;
    assert.ok(Math.abs(added - share) <= 30, x.it.foodId + ' added ' + added.toFixed(0) + ' kcal, share ' + share.toFixed(0));
  });
  assert.deepEqual(r.changes, expectedChanges(BASE, r.plan));
  assert.ok(r.changes.length > 0 && r.changes.every(function (c) { return F[c.foodId].category === 'carb'; }));
  const c = M.checkPlan(r.plan, F, T1);
  assert.ok(c.ok, c.issues.join(' | '));
  assert.deepEqual(r.plan.warnings, []);
});

test('rescalePlan −200 kcal lowers carb items first and stays within tolerance', function () {
  const T1 = Object.assign({}, T0, { kcal: T0.kcal - 200, carbs: T0.carbs - 50 });
  const r = M.rescalePlan(BASE, F, T1);
  sameShape(r.plan, BASE);
  ['protein', 'produce', 'fat'].forEach(function (role) {
    itemsByRole(BASE, role).forEach(function (x) { assert.equal(gramsAt(r.plan, x), x.it.grams); });
  });
  const carbs = itemsByRole(BASE, 'carb');
  assert.ok(carbs.every(function (x) { return gramsAt(r.plan, x) <= x.it.grams; }));
  assert.ok(carbs.some(function (x) { return gramsAt(r.plan, x) < x.it.grams; }));
  assert.deepEqual(r.changes, expectedChanges(BASE, r.plan));
  const c = M.checkPlan(r.plan, F, T1);
  assert.ok(c.ok, c.issues.join(' | '));
});

test('rescalePlan across typical plans keeps tolerance for +300 / −200 kcal', function () {
  [[3, 2200, 160], [4, 2000, 150], [4, 2600, 185], [5, 2400, 185], [5, 2800, 220]].forEach(function (c) {
    const T = targetsFor(c[1], c[2]);
    const base = gen({ targets: T, mealsPerDay: c[0] });
    [300, -200].forEach(function (dk) {
      const T1 = Object.assign({}, T, { kcal: T.kcal + dk, carbs: T.carbs + dk / 4 });
      const r = M.rescalePlan(base, F, T1);
      const chk = M.checkPlan(r.plan, F, T1);
      assert.ok(chk.ok, c + ' ' + dk + ': ' + chk.issues.join(' | '));
      // protein items only move against the protein the carb change drags in (more carbs → trim protein items)
      itemsByRole(base, 'protein').forEach(function (x) {
        assert.ok(dk > 0 ? gramsAt(r.plan, x) <= x.it.grams : gramsAt(r.plan, x) >= x.it.grams, c + ' ' + dk + ' ' + x.it.foodId);
      });
      itemsByRole(base, 'fat').forEach(function (x) { assert.equal(gramsAt(r.plan, x), x.it.grams); });
    });
  });
});

test('rescalePlan: maintenance break adds the whole deficit as carbs and returns, protein held within ±10 g', function () {
  [[3, 1970, 184], [4, 1970, 184], [5, 1970, 184], [4, 2300, 200], [5, 2600, 170]].forEach(function (c) {
    const cut = targetsFor(c[1], c[2]);
    const base = gen({ targets: cut, mealsPerDay: c[0] });
    const deficit = 935;
    const brk = Object.assign({}, cut, { kcal: cut.kcal + deficit, carbs: cut.carbs + deficit / 4 });
    const up = M.rescalePlan(base, F, brk);
    sameShape(up.plan, base);
    const chkUp = M.checkPlan(up.plan, F, brk);
    assert.ok(chkUp.ok, c + ' break: ' + chkUp.issues.join(' | '));
    assert.ok(itemsByRole(base, 'carb').every(function (x) { return gramsAt(up.plan, x) >= x.it.grams; }), 'carb portions scaled up');
    assert.ok(itemsByRole(base, 'carb').some(function (x) { return gramsAt(up.plan, x) > x.it.grams; }));
    const down = M.rescalePlan(up.plan, F, cut);
    const chkDown = M.checkPlan(down.plan, F, cut);
    assert.ok(chkDown.ok, c + ' back to cut: ' + chkDown.issues.join(' | '));
  });
});

test('rescalePlan changes protein items only when the protein target changes', function () {
  const T1 = Object.assign({}, T0, { protein: T0.protein + 15, carbs: T0.carbs - 15 });
  const r = M.rescalePlan(BASE, F, T1);
  sameShape(r.plan, BASE);
  const prot = itemsByRole(BASE, 'protein');
  assert.ok(prot.every(function (x) { return gramsAt(r.plan, x) >= x.it.grams; }));
  assert.ok(prot.some(function (x) { return gramsAt(r.plan, x) > x.it.grams; }));
  itemsByRole(BASE, 'produce').forEach(function (x) { assert.equal(gramsAt(r.plan, x), x.it.grams); });
  const c = M.checkPlan(r.plan, F, T1);
  assert.ok(c.ok, c.issues.join(' | '));
});

test('rescalePlan: once carbs reach their minimum, fat items take the rest of a decrease', function () {
  const T1 = Object.assign({}, T0, { kcal: 1200, carbs: 0 });
  const r = M.rescalePlan(BASE, F, T1);
  sameShape(r.plan, BASE);
  // cutting carbs removes their protein too; protein items may only grow to make up for it
  itemsByRole(BASE, 'protein').forEach(function (x) { assert.ok(gramsAt(r.plan, x) >= x.it.grams, x.it.foodId); });
  const fats = itemsByRole(BASE, 'fat');
  assert.ok(fats.some(function (x) { return gramsAt(r.plan, x) < x.it.grams; }), 'fat items decreased');
  assert.ok(fats.every(function (x) { return gramsAt(r.plan, x) >= 5; }), 'no item removed');
  // carbs were cut to (about) 50 kcal portions before fat moved
  itemsByRole(BASE, 'carb').forEach(function (x) {
    const f = F[x.it.foodId];
    assert.ok(gramsAt(r.plan, x) * f.kcal / 100 <= Math.max(60, (f.unit ? f.unit.grams : 5) * f.kcal / 100 + 1e-9), x.it.foodId);
  });
  assert.ok(r.plan.warnings.some(function (w) { return /^(Calories|Protein) /.test(w); }), 'unreachable target is reported');
});

test('rescalePlan: an increase moves fat items only after every carb item is at its maximum', function () {
  const T = targetsFor(3000, 185);
  const base = gen({ targets: T, mealsPerDay: 3 });
  const T1 = Object.assign({}, T, { kcal: T.kcal + 600, carbs: T.carbs + 150 });
  const r = M.rescalePlan(base, F, T1);
  const fatMoved = itemsByRole(base, 'fat').some(function (x) { return gramsAt(r.plan, x) !== x.it.grams; });
  assert.ok(fatMoved, 'this case needs more than the carb items can hold');
  itemsByRole(base, 'carb').forEach(function (x) {
    assert.equal(gramsAt(r.plan, x), F[x.it.foodId].maxPerMeal, x.it.foodId + ' at max');
  });
  itemsByRole(base, 'fat').forEach(function (x) { assert.ok(gramsAt(r.plan, x) >= x.it.grams); });
});

// ---------- swapCandidates / swapFood ----------
test('swapCandidates: same category, allowed, fits the meal type and role, never excluded', function () {
  const excluded = ['chicken_breast', 'rice_basmati'];
  const liked = LIKED.concat(['salmon', 'tofu', 'mozzarella_light', 'gouda', 'cucumber', 'orange']);
  const plan = gen({ liked: liked, excluded: excluded, targets: T0 });
  const allowed = allowedSet(liked, excluded);
  let offered = 0;
  plan.meals.forEach(function (m) {
    m.items.forEach(function (it, ii) {
      const cur = M.normalizeFood(F[it.foodId]);
      const cands = M.swapCandidates(plan, F, liked, excluded, m.key, ii);
      cands.forEach(function (id) {
        const f = M.normalizeFood(F[id]);
        assert.ok(allowed.has(id), id);
        assert.ok(excluded.indexOf(id) < 0, id);
        assert.equal(f.category, cur.category, m.key + ' ' + it.foodId + ' → ' + id);
        assert.ok(f.slots.indexOf(it.role) >= 0);
        assert.ok(f.meals.indexOf(TYPE[m.key]) >= 0);
        assert.ok(m.items.every(function (o) { return o.foodId !== id; }), 'not already in the meal');
      });
      offered += cands.length;
    });
  });
  assert.ok(offered > 20);
  // dairy is not offered for a protein-category food and vice versa
  const bf = plan.meals[0];
  const pIdx = bf.items.findIndex(function (it) { return it.role === 'protein'; });
  const cands = M.swapCandidates(plan, F, liked, excluded, 'breakfast', pIdx);
  const cat = F[bf.items[pIdx].foodId].category;
  assert.ok(cands.every(function (id) { return F[id].category === cat; }));
  assert.deepEqual(M.swapCandidates(plan, F, liked, excluded, 'nope', 0), []);
  assert.deepEqual(M.swapCandidates(plan, F, liked, excluded, 'lunch', 99), []);
});

test('swapCandidates keeps 2 different vegetables per day', function () {
  const lunchVeg = itemsByRole(BASE, 'produce').filter(function (x) { return BASE.meals[x.mi].key === 'lunch'; })[0];
  const dinnerVeg = itemsByRole(BASE, 'produce').filter(function (x) { return BASE.meals[x.mi].key === 'dinner'; })[0];
  const cands = M.swapCandidates(BASE, F, LIKED, [], 'lunch', lunchVeg.ii);
  assert.ok(cands.length > 0);
  assert.ok(cands.indexOf(dinnerVeg.it.foodId) < 0, 'the dinner vegetable is not offered at lunch');
  assert.ok(cands.every(function (id) { return F[id].category === 'vegetable'; }));
});

test('swapFood: only the swapped meal changes and the day stays within tolerance', function () {
  const before = clone(BASE);
  let swaps = 0;
  BASE.meals.forEach(function (m, mi) {
    m.items.forEach(function (it, ii) {
      M.swapCandidates(BASE, F, LIKED, [], m.key, ii).forEach(function (id) {
        const label = m.key + ' ' + it.foodId + ' → ' + id;
        const p = M.swapFood(BASE, F, LIKED, [], m.key, ii, id);
        swaps++;
        p.meals.forEach(function (m2, j) { if (j !== mi) assert.deepStrictEqual(m2, BASE.meals[j], label); });
        assert.equal(p.meals[mi].items[ii].foodId, id);
        assert.equal(p.meals[mi].items[ii].role, it.role);
        assert.equal(F[id].category, F[it.foodId].category);
        assert.equal(p.meals[mi].items.length, m.items.length);
        assert.deepEqual(p.targets, BASE.targets);
        assertPlanMeetsRules(p, F, T0, allowedSet(LIKED), label);
        // re-solved towards the meal's previous totals
        const a = totals(BASE, F).meals[m.key], b = totals(p, F).meals[m.key];
        assert.ok(Math.abs(b.kcal - a.kcal) <= 0.12 * a.kcal, label + ' meal kcal ' + a.kcal.toFixed(0) + ' → ' + b.kcal.toFixed(0));
      });
    });
  });
  assert.ok(swaps >= 20);
  assert.deepStrictEqual(BASE, before, 'input not mutated');
});

test('swapFood works on plans from other liked sets and meal counts', function () {
  const liked = foods.FOODS.map(function (f) { return f.id; });
  [[3, 2200, 160], [5, 2600, 185]].forEach(function (c) {
    const T = targetsFor(c[1], c[2]);
    const plan = gen({ liked: liked, targets: T, mealsPerDay: c[0] });
    let ok = 0, total = 0;
    plan.meals.forEach(function (m, mi) {
      m.items.forEach(function (it, ii) {
        M.swapCandidates(plan, F, liked, [], m.key, ii).forEach(function (id) {
          const p = M.swapFood(plan, F, liked, [], m.key, ii, id);
          p.meals.forEach(function (m2, j) { if (j !== mi) assert.deepStrictEqual(m2, plan.meals[j]); });
          assertStructure(p, F, allowedSet(liked), c + ' ' + it.foodId + ' → ' + id);
          assert.ok(distinct(p, F, 'vegetable') >= 2);
          total++;
          if (M.checkPlan(p, F, T).ok) ok++;
        });
      });
    });
    // a few swaps to a much less protein-dense food (e.g. cod → whole eggs) cannot hold the protein target
    assert.ok(ok / total >= 0.95, c + ': ' + ok + '/' + total + ' swaps within tolerance');
  });
});

test('swapFood rejects foods that are not candidates', function () {
  const lunch = BASE.meals.filter(function (m) { return m.key === 'lunch'; })[0];
  const pIdx = lunch.items.findIndex(function (it) { return it.role === 'protein'; });
  assert.throws(function () { M.swapFood(BASE, F, LIKED, [], 'lunch', pIdx, 'potatoes'); }, /not a valid replacement/);   // other category
  assert.throws(function () { M.swapFood(BASE, F, LIKED, ['chicken_breast'], 'lunch', pIdx, 'chicken_breast'); });    // excluded
  assert.throws(function () { M.swapFood(BASE, F, LIKED, [], 'lunch', pIdx, 'salmon'); });                           // not liked
});
