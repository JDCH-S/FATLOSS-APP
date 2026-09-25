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
  ['MEAL_LAYOUTS', 'generatePlan', 'rescalePlan', 'swapCandidates', 'swapFood', 'replaceDisallowed', 'planTotals', 'checkPlan',
    'roundGrams', 'normalizeFood', 'limitDecimals'].forEach(function (k) { assert.ok(k in M, k); });
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
  assert.equal(p.fill, 3);
  assert.equal(p.unit, null);
  // meal types by category, as in the built-in database: lunch/dinner for protein, carb, vegetable foods and cooking
  // fats; breakfast and snacks too for dairy, fruit, nuts and seeds. An explicit `meals` (the form's "suitable for")
  // wins. (Every custom food used to default to breakfast + main, so custom potatoes became a snack: finding 13.)
  assert.deepEqual(p.meals, ['main']);
  assert.deepEqual(make({ category: 'carb' }).meals, ['main']);
  assert.deepEqual(make({ category: 'vegetable' }).meals, ['main']);
  assert.deepEqual(make({ category: 'fruit' }).meals, ['breakfast', 'main']);
  assert.deepEqual(make({ category: 'dairy', kcal: 80, protein: 8, fat: 1 }).meals, ['breakfast', 'main']);
  assert.deepEqual(make({ category: 'fat', kcal: 900, protein: 0, carbs: 0, fat: 100 }).meals, ['main']);                 // oil
  assert.deepEqual(make({ category: 'fat', kcal: 620, protein: 25, carbs: 12, fat: 50 }).meals, ['breakfast', 'main']);   // nut butter
  assert.deepEqual(make({ category: 'carb', meals: ['breakfast'] }).meals, ['breakfast']);
  assert.deepEqual(make({ category: 'carb', meals: [] }).meals, ['main']);
  // per-meal caps modelled on the built-in foods of the same role (5 g steps or whole units); they used to be the
  // grams giving 900 kcal for carb and fat foods (1,200 g of potatoes, 100 g of oil: finding 13)
  assert.equal(make({ category: 'protein', kcal: 108 }).maxPerMeal, 300);          // lean meat: 300 g
  assert.equal(make({ category: 'protein', kcal: 380 }).maxPerMeal, 120);          // protein powder: ~450 kcal
  assert.equal(make({ category: 'carb', kcal: 75 }).maxPerMeal, 500);              // potatoes: 500 g
  assert.equal(make({ category: 'carb', kcal: 360 }).maxPerMeal, 155);             // dry grain: ~550 kcal
  assert.equal(make({ category: 'fat', kcal: 900, fat: 100 }).maxPerMeal, 25);     // oil: ~225 kcal
  assert.equal(make({ category: 'fat', kcal: 620 }).maxPerMeal, 35);               // nuts
  assert.equal(make({ category: 'fat', kcal: 160 }).maxPerMeal, 140);              // avocado
  assert.equal(make({ category: 'vegetable', kcal: 25 }).maxPerMeal, 400);
  assert.equal(make({ category: 'fruit', kcal: 50 }).maxPerMeal, 300);
  assert.equal(make({ category: 'carb', kcal: 250, unit: { name: 'slice', grams: 40 } }).maxPerMeal, 200);
  assert.equal(make({ category: 'protein', unit: { name: 'pack', grams: 100 } }).maxPerMeal, 200);
  assert.equal(make({ category: 'carb', maxPerMeal: 90 }).maxPerMeal, 90);

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
        const label = n + ' meals / ' + kcal + ' kcal / ' + protein + ' g';
        assert.equal(plan.mealsPerDay, n);
        assert.deepEqual(plan.targets, T);
        // 3 meals near the top of the range: every carb portion is at its maximum, so fat ends well above its target;
        // that is reported (finding 14) and is the only warning
        const fatHigh = plan.warnings.filter(function (w) { return /^Fat .* above the .* target/.test(w); });
        if (fatHigh.length) {
          assert.ok(n === 3 && kcal >= 3000, label);
          itemsByRole(plan, 'carb').forEach(function (x) { assert.equal(x.it.grams, F[x.it.foodId].maxPerMeal, label + ' ' + x.it.foodId); });
        }
        const rest = plan.warnings.filter(function (w) { return fatHigh.indexOf(w) < 0; });
        assertPlanMeetsRules(Object.assign({}, plan, { warnings: rest }), F, T, allowed, label);
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

  // (with cod and turkey liked too, seitan would rank third among the main-meal proteins and not be needed)
  const liked = LIKED.filter(function (id) { return id !== 'cod' && id !== 'turkey_breast'; }).concat(['custom_seitan']);
  const plan = gen({ foods: map, liked: liked, targets: T });
  assertPlanMeetsRules(plan, map, T, allowedSet(liked), 'custom + defaults');
  assert.ok(plan.meals.some(function (m) { return m.items.some(function (it) { return it.foodId === 'custom_seitan'; }); }));

  // the custom food as the only protein: without `meals` a protein food suits lunch and dinner only, so breakfast and
  // the snack report a missing protein food; marked as suitable for breakfast too, it fills every meal
  const only = ['custom_seitan', 'potatoes', 'oats', 'broccoli', 'carrots', 'apple', 'olive_oil', 'almonds'];
  const mainOnly = gen({ foods: map, liked: only, targets: T });
  mainOnly.meals.forEach(function (m) {
    const p = m.items.filter(function (it) { return it.role === 'protein'; });
    assert.deepEqual(p.map(function (it) { return it.foodId; }), TYPE[m.key] === 'main' ? ['custom_seitan'] : [], m.key);
  });
  assert.ok(mainOnly.warnings.some(function (w) { return /^Breakfast: no protein food/.test(w); }));
  const allDay = foods.byId(foods.FOODS.concat([Object.assign({}, seitan, { meals: ['breakfast', 'main'] })]));
  const plan2 = gen({ foods: allDay, liked: only, targets: T });
  assertPlanMeetsRules(plan2, allDay, T, allowedSet(only), 'custom only protein');
  plan2.meals.forEach(function (m) {
    assert.equal(m.items.filter(function (it) { return it.role === 'protein'; })[0].foodId, 'custom_seitan');
  });
  assert.equal(seitan.slots, undefined, 'caller food not mutated');
});

test('custom foods get realistic portions and suitable meals (finding 13)', function () {
  // stored exactly as the Setup form stores them: no slots, meals, fill or maxPerMeal
  const potatoes = { id: 'custom_baby_potatoes', name: 'Baby potatoes', nameNl: '', category: 'carb', kcal: 75, protein: 2, carbs: 16, fat: 0.1, fibre: 1.5, unit: null, custom: true };
  const oil = { id: 'custom_rapeseed_oil', name: 'Rapeseed oil', nameNl: '', category: 'fat', kcal: 900, protein: 0, carbs: 0, fat: 100, fibre: 0, unit: null, custom: true };
  const map = foods.byId(foods.FOODS.concat([potatoes, oil]));
  const liked = LIKED.filter(function (id) { return ['potatoes', 'olive_oil', 'rice_basmati'].indexOf(id) < 0; }).concat([potatoes.id, oil.id]);
  let used = 0;
  // before: dinner with 1,005–1,125 g of baby potatoes, 30–35 g of oil in one meal, potatoes as an afternoon snack
  [[2800, 170, 3], [2400, 170, 3], [2900, 170, 3], [2800, 170, 4], [3300, 170, 4], [2100, 170, 3]].forEach(function (c) {
    const label = c.join('/');
    const plan = gen({ foods: map, liked: liked, targets: targetsFor(c[0], c[1]), mealsPerDay: c[2] });
    assertStructure(plan, map, allowedSet(liked), label);
    plan.meals.forEach(function (m) {
      m.items.forEach(function (it) {
        if (it.foodId === potatoes.id) { used++; assert.equal(TYPE[m.key], 'main', label); assert.ok(it.grams <= 500, label + ' ' + it.grams); }
        if (it.foodId === oil.id) { used++; assert.equal(TYPE[m.key], 'main', label); assert.ok(it.grams <= 25, label + ' ' + it.grams); }
      });
    });
    const d = totals(plan, map).day;
    assert.ok(Math.abs(d.kcal - c[0]) <= 0.05 * c[0] && Math.abs(d.protein - c[1]) <= 10, label);
  });
  assert.ok(used >= 10, 'the custom foods are used');
});

test('generatePlan reaches the published limits when the same foods allow it (finding 16)', function () {
  // the descent aims inside the limits (3.5 %, 7 g) one step at a time and stopped at protein −10.8 g, although
  // 5 g more oats met every rule; the repair moves one or two items to any portion, scored against 5 % and 10 g
  const liked = ['eggs', 'skyr', 'kidney_beans', 'rice_basmati', 'oats', 'bell_pepper', 'carrots', 'courgette', 'strawberries', 'orange', 'chia'];
  const T = { kcal: 1800, protein: 180, fat: 51, carbs: 155.25 };
  assertPlanMeetsRules(gen({ liked: liked, targets: T, mealsPerDay: 3 }), F, T, allowedSet(liked), 'finding 16');
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

test('checkPlan reports fat more than 20 % above its target (finding 14)', function () {
  const fat = totals(BASE, F).day.fat;
  const fatIssues = function (targetFat) {
    return M.checkPlan(BASE, F, Object.assign({}, T0, { fat: targetFat })).issues.filter(function (w) { return /^Fat /.test(w); });
  };
  assert.deepEqual(fatIssues(fat), []);
  assert.deepEqual(fatIssues(fat / 1.2), [], 'exactly +20 % is within the limit');
  assert.deepEqual(fatIssues(fat / 1.25), ['Fat 57 g is 25 % above the 45 g target (limit +20 %): leaner foods, or more room for carbs ' +
    '(more meals per day), would bring it down.']);
  assert.match(fatIssues(fat / 1.203)[0], / is 20\.3 % above /);
});

test('checkPlan warnings never round onto the limit they report (finding 39)', function () {
  const d = totals(BASE, F).day;
  const issue = function (re, targets) {
    return M.checkPlan(BASE, F, Object.assign({}, T0, targets)).issues.filter(function (w) { return re.test(w); });
  };
  // before: 'Protein 165 g vs target 155 g (+10 g, limit ±10 g).' and 'Fibre 25 g is below 25 g'
  const pr = issue(/^Protein /, { protein: d.protein - 10.04 });
  assert.equal(pr.length, 1);
  assert.match(pr[0], /^Protein 183\.71 g vs target 173\.67 g \(\+10\.04 g, limit ±10 g\)\.$/);
  assert.match(issue(/^Protein /, { protein: d.protein + 10.4 })[0], /^Protein 183\.7 g vs target 194\.1 g \(−10\.4 g, limit ±10 g\)\.$/);
  assert.match(issue(/^Protein /, { protein: d.protein + 25 })[0], /^Protein 184 g vs target 209 g \(−25 g, limit ±10 g\)\.$/);
  assert.match(issue(/^Calories /, { kcal: d.kcal / 1.0504 })[0], /\(\+5\.04 %, limit ±5 %\)\.$/);
  assert.match(issue(/^Calories /, { kcal: d.kcal / 0.9 })[0], /^Calories 2407 kcal vs target 2675 \(−10 %, limit ±5 %\)\.$/);
  const lowFibre = { mealsPerDay: 3, targets: T0, warnings: [], meals: [
    { key: 'breakfast', name: 'Breakfast', share: 0.5, items: [{ foodId: 'oats', role: 'carb', grams: 100 }] },
    { key: 'lunch', name: 'Lunch', share: 0.5, items: [{ foodId: 'broccoli', role: 'produce', grams: 480 }] }
  ] };
  assert.ok(M.checkPlan(lowFibre, F, T0).issues.indexOf('Fibre 24.9 g is below 25 g: like more vegetables, fruit or wholegrain carbs.') >= 0);
  // the helper the UI uses for its own summary rows
  assert.equal(M.limitDecimals(10.035, 10), 2);
  assert.equal(M.limitDecimals(24.74, 25), 1);
  assert.equal(M.limitDecimals(-10.4, -10), 1);
  assert.equal(M.limitDecimals(12, 10), 0);
  assert.equal(M.limitDecimals(-13.2, -10), 0);
  assert.equal(M.limitDecimals(10, 10), 0);
  assert.equal(M.limitDecimals(10.0000001, 10), 7);
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
    // with 3 meals the carb items cannot hold the break within their maximum: they stretch (≤ 1.25 ×, reported)
    // rather than the energy going into oil and nuts (finding 14)
    const stretched = chkUp.issues.filter(function (w) { return /per-meal maximum/.test(w); });
    assert.deepEqual(chkUp.issues.filter(function (w) { return stretched.indexOf(w) < 0; }), [], c + ' break');
    assert.ok(c[0] === 3 || !stretched.length, c + ' break: ' + stretched.join(' | '));
    up.plan.meals.forEach(function (m) {
      m.items.forEach(function (it) {
        const max = F[it.foodId].maxPerMeal;
        assert.ok(it.grams <= (it.role === 'carb' ? 1.25 * max : max), c + ' ' + it.foodId + ' ' + it.grams);
      });
    });
    assert.ok(totals(up.plan, F).day.fat <= 1.2 * brk.fat, c + ' fat ' + totals(up.plan, F).day.fat.toFixed(1));
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

function overMax(plan) {
  const out = [];
  plan.meals.forEach(function (m) {
    m.items.forEach(function (it) { if (it.grams > F[it.foodId].maxPerMeal + 1e-9) out.push(m.key + ' ' + it.foodId + ' ' + it.grams); });
  });
  return out;
}

test('rescalePlan: an increase the carbs cannot hold goes to fat up to +20 %; only a large one (≥ 300 kcal) then stretches carbs', function () {
  const T = targetsFor(3000, 185);
  const base = gen({ targets: T, mealsPerDay: 3 });
  const stretchCap = function (id) { const f = F[id], s = f.unit ? f.unit.grams : 5; return Math.floor(1.25 * f.maxPerMeal / s + 1e-9) * s; };
  itemsByRole(base, 'carb').forEach(function (x) { assert.equal(x.it.grams, F[x.it.foodId].maxPerMeal, 'base carb ' + x.it.foodId + ' at max'); });
  const up = function (dk, opts) { const T1 = Object.assign({}, T, { kcal: T.kcal + dk, carbs: T.carbs + dk / 4 }); return { T1: T1, r: M.rescalePlan(base, F, T1, opts) }; };
  const fatItems = itemsByRole(base, 'fat');
  // routine +200: fat items take it while the day's fat stays within +20 %; no portion passes its maximum (before
  // the fix oats, potatoes and bread went to 1.25 × their maximum on any increase)
  const a = up(200);
  assert.deepEqual(overMax(a.r.plan), []);
  assert.ok(fatItems.some(function (x) { return gramsAt(a.r.plan, x) > x.it.grams; }), 'fat items grew');
  assert.ok(totals(a.r.plan, F).day.fat <= 1.2 * a.T1.fat + 1e-9, 'fat ' + totals(a.r.plan, F).day.fat);
  assert.deepEqual(a.r.plan.warnings, []);
  // +299 is still routine: fat goes past +20 % only as far as the kcal limit needs, and that is reported
  const b = up(299);
  assert.deepEqual(overMax(b.r.plan), []);
  const cb = M.checkPlan(b.r.plan, F, b.T1);
  assert.ok(Math.abs(cb.kcalDiffPct) <= 5, cb.issues.join(' | '));
  assert.equal(b.r.plan.warnings.length, 1, b.r.plan.warnings.join(' | '));
  assert.match(b.r.plan.warnings[0], /^Fat \d+ g is \d+ % above the \d+ g target \(limit \+20 %\)/);
  // +300 (a phase change): fat first fills to +20 %, then the carb items stretch (≤ 1.25 ×, reported) instead of
  // fat going past +20 %
  const c = up(300);
  itemsByRole(base, 'carb').forEach(function (x) {
    const g = gramsAt(c.r.plan, x);
    assert.ok(g >= x.it.grams && g <= stretchCap(x.it.foodId), x.it.foodId + ' ' + g);
  });
  assert.ok(overMax(c.r.plan).length > 0);
  assert.ok(totals(c.r.plan, F).day.fat <= 1.2 * c.T1.fat + 1e-9, 'fat ' + totals(c.r.plan, F).day.fat);
  const cc = M.checkPlan(c.r.plan, F, c.T1);
  assert.ok(Math.abs(cc.kcalDiffPct) <= 5 && Math.abs(cc.proteinDiffG) <= 10, cc.issues.join(' | '));
  c.r.plan.warnings.forEach(function (w) { assert.match(w, /is above the \d+ g per-meal maximum \(more meals per day would spread it\)\.$/); });
  // …unless the caller forbids it (e.g. targets that drifted up over several check-ins)
  assert.deepEqual(overMax(up(300, { allowCarbStretch: false }).r.plan), []);
  assert.deepEqual(overMax(up(600, { allowCarbStretch: false }).r.plan), []);
  // +600: every carb item reaches its stretched maximum, then fat items take what keeps kcal within the limit
  const d = up(600);
  itemsByRole(base, 'carb').forEach(function (x) { assert.equal(gramsAt(d.r.plan, x), stretchCap(x.it.foodId), x.it.foodId); });
  assert.ok(fatItems.every(function (x) { return gramsAt(d.r.plan, x) >= x.it.grams; }));
  assert.ok(fatItems.some(function (x) { return gramsAt(d.r.plan, x) > x.it.grams; }), 'fat items took the rest');
  assert.ok(Math.abs(M.checkPlan(d.r.plan, F, d.T1).kcalDiffPct) <= 5);
});

test('rescalePlan: routine check-ins (±100 / ±200 kcal) never take a portion past its per-meal maximum (carb stretch finding)', function () {
  // the reported case: 3 meals at 2500 kcal / 140 g protein (oats, potatoes and bread already at their maximum),
  // then an ordinary +200 kcal check-in; before: oats 165 g and potatoes 765 g with two warnings
  const T = { kcal: 2500, protein: 140, fat: 61.111111111111114, carbs: 347.5 };
  const base = gen({ targets: T, mealsPerDay: 3 });
  assert.deepEqual(base.warnings, []);
  const T1 = Object.assign({}, T, { kcal: 2700, carbs: 397.5 });
  const r = M.rescalePlan(base, F, T1);
  assert.deepEqual(overMax(r.plan), []);
  assert.deepEqual(r.plan.warnings, []);
  assert.ok(r.changes.every(function (ch) { return F[ch.foodId].category === 'fat'; }), JSON.stringify(r.changes));
  // property: default foods, 3–5 meals, a spread of targets
  [3, 4, 5].forEach(function (n) {
    [1900, 2400, 2900].forEach(function (kcal) {
      [140, 190].forEach(function (protein) {
        const Tb = targetsFor(kcal, protein);
        const b = gen({ targets: Tb, mealsPerDay: n });
        if (overMax(b).length) return;
        [-200, -100, 100, 200].forEach(function (dk) {
          const p = M.rescalePlan(b, F, Object.assign({}, Tb, { kcal: kcal + dk, carbs: Tb.carbs + dk / 4 })).plan;
          assert.deepEqual(overMax(p), [], n + ' meals ' + kcal + '/' + protein + ' ' + dk);
        });
      });
    });
  });
});

test('checkPlan: calories short with every carb portion at its maximum says so (carb stretch finding)', function () {
  const T = targetsFor(3000, 185);
  const base = gen({ targets: T, mealsPerDay: 3 });
  const issues = M.checkPlan(base, F, Object.assign({}, T, { kcal: 3600 })).issues.filter(function (w) { return /^Calories /.test(w); });
  assert.equal(issues.length, 1);
  assert.match(issues[0], /\(−\d+(\.\d)? %, limit ±5 %\): every carb portion is already as large as one meal allows; more meals per day \(or regenerating the plan\) would make room\.$/);
  // not when a carb portion still has room, nor when calories are over
  assert.match(M.checkPlan(BASE, F, Object.assign({}, T0, { kcal: T0.kcal * 1.2 })).issues.filter(function (w) { return /^Calories /.test(w); })[0], /limit ±5 %\)\.$/);
  assert.match(M.checkPlan(base, F, Object.assign({}, T, { kcal: 2500 })).issues.filter(function (w) { return /^Calories /.test(w); })[0], /limit ±5 %\)\.$/);
});

test('rescalePlan: a 3-meal maintenance break goes to carbs, not oil and nuts, and stays on target (finding 14)', function () {
  // the example user (85 kg, 3 meals): cut targets of week 1 → break targets of week 9
  const cut = { kcal: 1971.7142857142858, protein: 183.6, fat: 51, carbs: 194.57857142857142 };
  const brk = { kcal: 2906.714285714286, protein: 183.6, fat: 51, carbs: 428.3285714285714 };
  const base = gen({ targets: cut, mealsPerDay: 3 });
  const r = M.rescalePlan(base, F, brk);
  const b = totals(base, F).day, d = totals(r.plan, F).day;
  // before: fat 83 g (+63 %, peanut butter, oil and almonds grown, no warning), carbs 325 g of 428 g
  assert.ok(Math.abs(d.kcal - brk.kcal) <= 0.05 * brk.kcal, 'kcal ' + d.kcal.toFixed(0));
  assert.ok(d.fat <= 1.2 * brk.fat, 'fat ' + d.fat.toFixed(1));
  assert.ok((d.carbs - b.carbs) * 4 >= 0.75 * (d.kcal - b.kcal), 'most of the added energy is carbs');
  itemsByRole(base, 'fat').forEach(function (x) { assert.ok(gramsAt(r.plan, x) <= x.it.grams + 5, x.it.foodId); });
  assert.ok(r.plan.warnings.length > 0);
  r.plan.warnings.forEach(function (w) { assert.match(w, /per-meal maximum/); });
});

test('rescalePlan: a routine −200 kcal check-in keeps protein within ±10 g when the same foods allow it (finding 15)', function () {
  const liked = ['ham_lean', 'mozzarella_light', 'milk_semi', 'lentils_red', 'quinoa', 'rice_cakes', 'bread_wholemeal', 'witloof', 'carrots',
    'strawberries', 'chia', 'almonds'];
  const T = targetsFor(2000, 205);
  const base = gen({ liked: liked, targets: T, mealsPerDay: 3 });
  assert.deepEqual(base.warnings, []);
  const T1 = Object.assign({}, T, { kcal: T.kcal - 200, carbs: T.carbs - 50 });
  const r = M.rescalePlan(base, F, T1);
  sameShape(r.plan, base);
  // before: 'Protein 189 g vs target 205 g (−15.6 g)': the protein foods are at their maximum, so the day keeps
  // more of the protein-rich lentils instead and sits higher in the kcal band
  const c = M.checkPlan(r.plan, F, T1);
  assert.ok(c.ok, c.issues.join(' | '));
});

test('rescalePlan keeps fibre ≥ 25 g by growing produce when a cut removes fibrous carbs (finding 17)', function () {
  const liked = ['ham_lean', 'milk_skim', 'pasta', 'rice_cakes', 'carrots', 'tomatoes', 'courgette', 'kiwi', 'apple', 'walnuts'];
  const T = { kcal: 1900, protein: 160, fat: 46, carbs: 212 };
  const base = gen({ liked: liked, targets: T });
  assert.deepEqual(base.warnings, []);
  const T1 = { kcal: 1700, protein: 160, fat: 46, carbs: 162 };
  const r = M.rescalePlan(base, F, T1);
  const c = M.checkPlan(r.plan, F, T1);
  assert.ok(c.ok, c.issues.join(' | '));            // before: 'Fibre 24 g is below 25 g' (23.9 g)
  const produce = itemsByRole(base, 'produce');
  assert.ok(produce.every(function (x) { return gramsAt(r.plan, x) >= x.it.grams; }));
  assert.ok(produce.some(function (x) { return gramsAt(r.plan, x) > x.it.grams; }), 'produce grew');
  assert.deepEqual(r.changes, expectedChanges(base, r.plan));
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
        // a fattier food (egg whites → whole eggs) can take the day's fat past +20 %: that is reported
        const fatHigh = p.warnings.filter(function (w) { return /^Fat .* above the .* target/.test(w); });
        if (fatHigh.length) assert.ok(F[id].fat > F[it.foodId].fat, label);
        assertPlanMeetsRules(Object.assign({}, p, { warnings: p.warnings.filter(function (w) { return fatHigh.indexOf(w) < 0; }) }), F, T0,
          allowedSet(LIKED), label);
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

test('swapFood re-solves the meal to a valid day when the same foods allow it (finding 16)', function () {
  const liked = ['eggs', 'cod', 'chicken_slices', 'whey', 'potatoes', 'kidney_beans', 'rice_cakes', 'green_beans', 'red_cabbage', 'courgette',
    'tomatoes', 'blueberries', 'frozen_berries'];
  const T = { kcal: 2400, protein: 180, fat: 58.67, carbs: 288 };
  const plan = gen({ liked: liked, targets: T });
  assert.deepEqual(plan.warnings, []);
  const idx = plan.meals[0].items.findIndex(function (it) { return it.foodId === 'chicken_slices'; });
  const p = M.swapFood(plan, F, liked, [], 'breakfast', idx, 'eggs');
  // before: eggs 220 g + rice cakes 48 g left protein at −13 g; one more egg for four fewer rice cakes is valid
  // (whole eggs in three meals do take fat well above its target, which is reported)
  assert.deepEqual(p.warnings.map(function (w) { return w.slice(0, 11); }), ['Fat 81 g is']);
  assertPlanMeetsRules(Object.assign({}, p, { warnings: [] }), F, T, allowedSet(liked), 'chicken slices → eggs');
  p.meals.forEach(function (m, j) { if (j > 0) assert.deepStrictEqual(m, plan.meals[j]); });
});

test('swapFood: when no one- or two-item move reaches the limits, the meal is re-solved as a whole (finding 16)', function () {
  // each case needed three portions of the swapped meal to move together; before, the repair (one or two items)
  // gave up and the day kept a protein warning
  const cases = [
    { liked: ['chicken_slices', 'milk_semi', 'quinoa', 'potatoes', 'oats', 'bread_wholemeal', 'witloof', 'spinach', 'bell_pepper', 'kiwi', 'banana'],
      T: { kcal: 2400, protein: 225, fat: 58.666666666666664, carbs: 243 }, meals: 5, meal: 'dinner', from: 'quinoa', to: 'bread_wholemeal',
      // before: chicken slices 200 g, bread 35 g, bell pepper 395 g at protein −10.7 g (the fat floor warning is
      // the base plan's: no fat food is liked)
      warnings: [/^Fat \d+ g is well below/] },
    { liked: ['turkey_breast', 'tofu', 'chicken_slices', 'milk_skim', 'greek_yogurt_0', 'kidney_beans', 'rice_brown', 'bread_wholemeal', 'broccoli',
      'bell_pepper', 'mushrooms', 'mandarin', 'frozen_berries', 'almonds', 'gouda'],
      T: { kcal: 2000, protein: 210, fat: 51, carbs: 175.25 }, meals: 4, meal: 'snack_pm', from: 'greek_yogurt_0', to: 'milk_skim',
      warnings: [] },   // before: milk 500 g, bread 35 g, mandarin 210 g at protein −10.2 g
    { liked: ['beef_steak', 'eggs', 'tofu', 'greek_yogurt_0', 'kidney_beans', 'lentils_red', 'bread_wholemeal', 'oats', 'green_beans', 'witloof',
      'broccoli', 'pear', 'banana', 'chia', 'olive_oil'],
      T: { kcal: 1900, protein: 165, fat: 51, carbs: 195.25 }, meals: 5, meal: 'lunch', from: 'beef_steak', to: 'eggs',
      // before: 3 eggs, kidney beans 165 g, green beans 400 g at protein −13 g; valid: 5 eggs, beans ~50 g and fewer
      // green beans (whole eggs take fat well above target, which is reported)
      warnings: [/^Fat \d+ g is \d+ % above/] }
  ];
  cases.forEach(function (c) {
    const plan = gen({ liked: c.liked, targets: c.T, mealsPerDay: c.meals });
    const mi = plan.meals.findIndex(function (m) { return m.key === c.meal; });
    const idx = plan.meals[mi].items.findIndex(function (it) { return it.foodId === c.from; });
    const t = process.hrtime.bigint();
    const p = M.swapFood(plan, F, c.liked, [], c.meal, idx, c.to);
    const ms = Number(process.hrtime.bigint() - t) / 1e6;
    const label = c.from + ' → ' + c.to;
    assert.ok(ms < 100, label + ' took ' + ms.toFixed(1) + ' ms');
    assert.equal(p.warnings.length, c.warnings.length, label + ': ' + p.warnings.join(' | '));
    c.warnings.forEach(function (re, i) { assert.match(p.warnings[i], re, label); });
    assertStructure(p, F, allowedSet(c.liked), label);
    const d = totals(p, F).day;
    assert.ok(Math.abs(d.kcal - c.T.kcal) <= 0.05 * c.T.kcal && Math.abs(d.protein - c.T.protein) <= 10 && d.fibre >= 25, label);
    p.meals.forEach(function (m, j) { if (j !== mi) assert.deepStrictEqual(m, plan.meals[j]); });
    // produce never goes below its portion before the swap
    plan.meals[mi].items.forEach(function (it, k) {
      if (it.role === 'produce') assert.ok(p.meals[mi].items[k].grams >= it.grams, label + ' ' + it.foodId);
    });
    assert.deepStrictEqual(M.swapFood(plan, F, c.liked, [], c.meal, idx, c.to), p, label + ' deterministic');
  });
});

// ---------- replaceDisallowed ----------
function mealOf(plan, key) { return plan.meals.filter(function (m) { return m.key === key; })[0]; }
function indexOf(plan, key, foodId) { return mealOf(plan, key).items.findIndex(function (it) { return it.foodId === foodId; }); }

test('replaceDisallowed: an excluded food is swapped in its meal only, preferring a food not yet in the day (finding 0)', function () {
  const before = clone(BASE);
  const lunchIdx = indexOf(BASE, 'lunch', 'cod');
  assert.ok(lunchIdx >= 0);
  const r = M.replaceDisallowed(BASE, F, LIKED, ['cod']);
  assert.deepStrictEqual(BASE, before, 'input not mutated');
  assert.deepStrictEqual(M.replaceDisallowed(BASE, F, LIKED, ['cod']), r, 'deterministic');
  // turkey ranks first but is already dinner's protein: chicken breast is the best food not yet in the day
  assert.deepEqual(r.replaced, [{ mealKey: 'lunch', itemIndex: lunchIdx, from: 'cod', to: 'chicken_breast' }]);
  assert.deepEqual(r.dropped, []);
  assert.deepEqual(r.impossible, []);
  assert.equal(r.plan.meals[1].items[lunchIdx].role, 'protein');
  r.plan.meals.forEach(function (m, j) { if (m.key !== 'lunch') assert.deepStrictEqual(m, BASE.meals[j]); });
  assertPlanMeetsRules(r.plan, F, T0, allowedSet(LIKED, ['cod']), 'cod excluded');
  // same for a food that is simply no longer liked, and nothing to do when every food is allowed
  const unliked = LIKED.filter(function (id) { return id !== 'potatoes'; });
  const r2 = M.replaceDisallowed(BASE, F, unliked, []);
  assert.equal(r2.replaced.length, 1);
  assert.equal(F[r2.replaced[0].to].category, 'carb');
  assertPlanMeetsRules(r2.plan, F, T0, allowedSet(unliked), 'potatoes un-liked');
  const none = M.replaceDisallowed(BASE, F, LIKED, []);
  assert.deepStrictEqual(none.plan, BASE);
  assert.deepEqual([none.replaced, none.dropped, none.impossible], [[], [], []]);
});

test('replaceDisallowed: vegetables are replaced so the day keeps 2 different ones', function () {
  const r = M.replaceDisallowed(BASE, F, LIKED, ['broccoli', 'green_beans']);
  assert.equal(r.replaced.length, 2);
  assert.deepEqual(r.impossible, []);
  assertPlanMeetsRules(r.plan, F, T0, allowedSet(LIKED, ['broccoli', 'green_beans']), 'vegetables excluded');
});

test('replaceDisallowed: a deleted custom food (unknown id) is replaced by a food of the same role (finding 19)', function () {
  const seitan = { id: 'custom_seitan', name: 'Seitan', category: 'protein', kcal: 120, protein: 25, carbs: 4, fat: 1.5, fibre: 0.5, unit: null, custom: true };
  const liked = LIKED.filter(function (id) { return id !== 'cod' && id !== 'turkey_breast'; });
  const plan = gen({ foods: foods.byId(foods.FOODS.concat([seitan])), liked: liked.concat([seitan.id]), targets: T0 });
  const key = plan.meals.filter(function (m) { return m.items.some(function (it) { return it.foodId === seitan.id; }); })[0].key;
  const idx = indexOf(plan, key, seitan.id);
  // after the delete the food is gone from the map; swap candidates are offered by role
  const cands = M.swapCandidates(plan, F, liked, [], key, idx);
  assert.ok(cands.length > 0 && cands.every(function (id) { return M.normalizeFood(F[id]).slots.indexOf('protein') >= 0; }));
  const r = M.replaceDisallowed(plan, F, liked, []);
  assert.deepEqual(r.replaced.map(function (x) { return [x.mealKey, x.itemIndex, x.from]; }), [[key, idx, seitan.id]]);
  assert.ok(cands.indexOf(r.replaced[0].to) >= 0);
  assertPlanMeetsRules(r.plan, F, T0, allowedSet(liked), 'custom food deleted');
});

test('replaceDisallowed: an item without a candidate is dropped when its meal keeps its roles, else reported', function () {
  // no main-meal fat left: the olive oil items go and their meals are re-solved (energy moves to the carbs)
  const noOil = LIKED.filter(function (id) { return id !== 'olive_oil' && id !== 'almonds'; });
  const oil = ['lunch', 'dinner'].map(function (k) { return { mealKey: k, itemIndex: indexOf(BASE, k, 'olive_oil'), foodId: 'olive_oil' }; });
  const r = M.replaceDisallowed(BASE, F, noOil, []);
  assert.deepEqual(r.replaced, []);
  assert.deepEqual(r.dropped, oil);
  assert.deepEqual(r.impossible, []);
  ['lunch', 'dinner'].forEach(function (k) {
    const m = mealOf(r.plan, k), b = mealOf(BASE, k);
    assert.equal(m.items.length, b.items.length - 1);
    assert.ok(m.items.every(function (it) { return it.role !== 'fat'; }));
    m.items.filter(function (it) { return it.role === 'produce'; }).forEach(function (it) {
      assert.equal(it.grams, b.items.filter(function (x) { return x.foodId === it.foodId; })[0].grams, 'vegetables do not chase the lost fat');
    });
  });
  const d = totals(r.plan, F).day;
  assert.ok(Math.abs(d.kcal - T0.kcal) <= 0.05 * T0.kcal && Math.abs(d.protein - T0.protein) <= 10);
  assert.ok(r.plan.warnings.every(function (w) { return /^Fat /.test(w); }), r.plan.warnings.join(' | '));
  // the only protein food excluded: nothing can replace it and a meal cannot lose its protein → impossible
  const liked = ['egg_whites', 'bread_wholemeal', 'broccoli', 'carrots', 'apple', 'almonds'];
  const plan = gen({ liked: liked, targets: targetsFor(2200, 160), mealsPerDay: 3 });
  const r2 = M.replaceDisallowed(plan, F, liked, ['egg_whites']);
  assert.deepEqual(r2.replaced, []);
  assert.deepEqual(r2.dropped, []);
  assert.deepEqual(r2.impossible, plan.meals.map(function (m) { return { mealKey: m.key, itemIndex: indexOf(plan, m.key, 'egg_whites'), foodId: 'egg_whites' }; }));
  assert.deepStrictEqual(r2.plan.meals, plan.meals);
});
