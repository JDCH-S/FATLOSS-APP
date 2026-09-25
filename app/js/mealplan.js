/* Meal-plan solver (SPEC §5): builds one fixed day of meals from the liked foods, rescales it when the weekly
 * targets change and swaps single foods. Pure and deterministic; energy always comes from food.kcal (per 100 g).
 *
 * generatePlan pipeline
 *   1. pick foods per meal: one protein-role, one carb-role, one produce item and (optionally) one fat-role food,
 *      ranked by filling-ness with variety across meals;
 *   2. fix produce grams (vegetables ~200 g per main meal, ~150 g fruit per breakfast/snack);
 *   3. per meal, solve protein/carb/fat grams against the meal's share of P/C/F/kcal (box-constrained least
 *      squares, 3 unknowns, active sets enumerated), then round to 5 g / whole units;
 *   4. grow vegetable portions until fibre ≥ 25 g (re-solving the meal each time);
 *   5. day-level greedy correction: ±1 step moves scored by a weighted error, until no move improves;
 *   6. if the day still breaks a rule, try alternative foods (deterministic local search) and keep the best.
 * rescalePlan keeps foods and meals: protein items follow a protein-target change, then the energy change goes to
 * carb items (shares proportional to their carb grams) and, once those hit their bounds, to fat items.
 * swapFood replaces one item and re-solves only that meal towards its previous totals.
 * Warnings are always checkPlan's issues, so they describe the plan as it is.
 */
(function (root) {
  'use strict';

  // ---------- constants ----------
  const KCAL_TOL_PCT = 5;          // published tolerances (checkPlan)
  const PROTEIN_TOL_G = 10;
  const FIBRE_MIN_G = 25;
  const VEG_MIN = 2;
  const FRUIT_MIN = 1;
  const KCAL_AIM_PCT = 3.5;        // the solver aims inside the tolerances so rescaling keeps some headroom
  const PROTEIN_AIM_G = 7;
  const FIBRE_AIM_G = 26;
  const VEG_START_G = 200;
  const FRUIT_START_G = 150;
  const PRODUCE_GROW_G = 25;
  const MIN_PORTION_KCAL = 50;     // protein and carb items are generated at no less than ~50 kcal
  const MAX_CORRECTION_STEPS = 600;
  const MAX_SEARCH_ROUNDS = 4;
  const MAX_SEARCH_EVALS = 150;    // bounds the food-choice search (each evaluation is a full day solve)

  // Internal nutrient vectors: [kcal, protein, carbs, fat, fibre] per gram.
  const K = 0, P = 1, C = 2, FA = 3, FI = 4;
  // Least-squares row weights for [protein g, carbs g, fat g, kcal]: protein and energy matter most.
  const LS_WEIGHTS = [12, 4, 6, 2];

  function layoutEntry(key, name, share, type) { return Object.freeze({ key: key, name: name, share: share, type: type }); }
  const MEAL_LAYOUTS = Object.freeze({
    3: Object.freeze([
      layoutEntry('breakfast', 'Breakfast', 0.30, 'breakfast'),
      layoutEntry('lunch', 'Lunch', 0.35, 'main'),
      layoutEntry('dinner', 'Dinner', 0.35, 'main')
    ]),
    4: Object.freeze([
      layoutEntry('breakfast', 'Breakfast', 0.25, 'breakfast'),
      layoutEntry('lunch', 'Lunch', 0.30, 'main'),
      layoutEntry('snack_pm', 'Afternoon snack', 0.15, 'breakfast'),
      layoutEntry('dinner', 'Dinner', 0.30, 'main')
    ]),
    5: Object.freeze([
      layoutEntry('breakfast', 'Breakfast', 0.22, 'breakfast'),
      layoutEntry('lunch', 'Lunch', 0.28, 'main'),
      layoutEntry('snack_pm', 'Afternoon snack', 0.12, 'breakfast'),
      layoutEntry('dinner', 'Dinner', 0.28, 'main'),
      layoutEntry('snack_eve', 'Evening snack', 0.10, 'breakfast')
    ])
  });
  const MEAL_TYPE = { breakfast: 'breakfast', snack_pm: 'breakfast', snack_eve: 'breakfast', lunch: 'main', dinner: 'main' };

  // ---------- foods ----------
  function num(x) { return typeof x === 'number' && isFinite(x) ? x : 0; }

  function defaultSlots(f) {
    const kcal = num(f.kcal);
    switch (f.category) {
      case 'protein': return ['protein'];
      case 'dairy':
        if (kcal > 0 && num(f.protein) * 4 / kcal >= 0.4) return ['protein'];
        if (kcal > 0 && num(f.fat) * 9 / kcal >= 0.6) return ['fat'];
        return [];
      case 'carb': return ['carb'];
      case 'vegetable': case 'fruit': return ['produce'];
      case 'fat': return ['fat'];
      default: return [];
    }
  }

  // Fat- and carb-role foods are capped at the grams giving ~900 kcal, everything else at 350 g;
  // unit foods are capped at whole units.
  function defaultMaxPerMeal(f) {
    const dense = f.slots.indexOf('protein') < 0 && (f.slots.indexOf('fat') >= 0 || f.slots.indexOf('carb') >= 0);
    const g = dense && num(f.kcal) > 0 ? 900 / f.kcal * 100 : 350;
    if (f.unit) return Math.max(1, Math.floor(g / f.unit.grams)) * f.unit.grams;
    return Math.max(5, Math.round(g / 5) * 5);
  }

  // Returns a copy of the food with every field the solver needs (custom foods may lack slots, meals, fill…).
  function normalizeFood(food) {
    const f = Object.assign({}, food);
    ['protein', 'carbs', 'fat', 'fibre'].forEach(function (k) { f[k] = num(f[k]); });
    f.unit = f.unit && num(f.unit.grams) > 0 ? f.unit : null;
    if (!Array.isArray(f.slots)) f.slots = defaultSlots(f);
    if (!Array.isArray(f.meals) || !f.meals.length) f.meals = ['breakfast', 'main'];
    if (!(num(f.fill) > 0)) f.fill = 3;
    if (!(num(f.maxPerMeal) > 0)) f.maxPerMeal = defaultMaxPerMeal(f);
    return f;
  }

  function normalizeMap(foods) {
    const out = {};
    Object.keys(foods || {}).forEach(function (id) {
      if (!foods[id]) return;
      out[id] = normalizeFood(foods[id]);
      if (!out[id].id) out[id].id = id;
    });
    return out;
  }

  function allowedIds(F, liked, excluded) {
    const ex = {};
    (excluded || []).forEach(function (id) { ex[id] = true; });
    const seen = {};
    return (liked || []).filter(function (id) {
      if (!F[id] || ex[id] || seen[id]) return false;
      seen[id] = true;
      return true;
    });
  }

  function vec(food) {
    return [num(food.kcal) / 100, food.protein / 100, food.carbs / 100, food.fat / 100, food.fibre / 100];
  }
  function stepOf(food) { return food.unit ? food.unit.grams : 5; }
  // Smallest sensible generated portion of a protein or carb food: ~50 kcal rounded up to a whole step.
  function minPortion(food) {
    const s = stepOf(food);
    const g = num(food.kcal) > 0 ? MIN_PORTION_KCAL / food.kcal * 100 : s;
    return Math.min(maxGrams(food), Math.max(1, Math.ceil(g / s - 1e-9)) * s);
  }
  function maxGrams(food) {
    const s = stepOf(food);
    return Math.max(1, Math.floor(food.maxPerMeal / s + 1e-9)) * s;
  }

  function roundGrams(food, grams) {
    const g = num(grams);
    if (food && food.unit && num(food.unit.grams) > 0) return Math.max(1, Math.round(g / food.unit.grams)) * food.unit.grams;
    return Math.max(5, Math.round(g / 5) * 5);
  }

  // ---------- ranking and food choice ----------
  function per100kcal(food, x) { return num(food.kcal) > 0 ? x * 100 / food.kcal : 0; }

  // Higher is better, compared lexicographically (SPEC §5 rule 4).
  function rankKey(food, role) {
    if (role === 'protein') return [per100kcal(food, food.protein) + food.fill];
    return [food.fill, per100kcal(food, food.fibre)];
  }

  function rankFoods(list, role) {
    return list.map(function (f) { return { f: f, k: rankKey(f, role) }; }).sort(function (a, b) {
      for (let i = 0; i < a.k.length; i++) if (a.k[i] !== b.k[i]) return b.k[i] - a.k[i];
      return a.f.id < b.f.id ? -1 : a.f.id > b.f.id ? 1 : 0;
    }).map(function (x) { return x.f; });
  }

  function fits(food, role, type) { return food.slots.indexOf(role) >= 0 && food.meals.indexOf(type) >= 0; }

  // Ranked candidate lists per meal type and role. Produce is split: breakfast/snacks prefer fruit, main meals
  // vegetables; the other kind is only a fallback when none of the preferred kind fits.
  function candidateLists(allowed) {
    const out = {};
    ['breakfast', 'main'].forEach(function (type) {
      const lists = {};
      ['protein', 'carb', 'fat', 'produce'].forEach(function (role) {
        lists[role] = rankFoods(allowed.filter(function (f) { return fits(f, role, type); }), role);
      });
      const preferred = type === 'main' ? 'vegetable' : 'fruit';
      const pref = lists.produce.filter(function (f) { return f.category === preferred; });
      lists.produce = pref.length ? pref : lists.produce;
      out[type] = lists;
    });
    return out;
  }

  // Initial choice: per meal and role the best-ranked food, preferring foods not yet used in the day.
  function selectFoods(layout, lists) {
    const used = {};
    return layout.map(function (L) {
      const inMeal = {};
      function pick(list) {
        let best = null, bestUse = Infinity;
        list.forEach(function (f) {
          if (inMeal[f.id]) return;
          const u = used[f.id] || 0;
          if (u < bestUse) { best = f; bestUse = u; }
        });
        if (best) { inMeal[best.id] = true; used[best.id] = bestUse + 1; }
        return best;
      }
      const l = lists[L.type];
      const protein = pick(l.protein);
      const carb = pick(l.carb);
      const produce = pick(l.produce);
      const fat = pick(l.fat);
      return { protein: protein, carb: carb, produce: produce, fat: fat };
    });
  }

  // ---------- working representation ----------
  // item: {food, role, grams, lo, hi, v}; meal: {key, name, share, type, items}
  function mkItem(food, role, grams, lo) {
    return { food: food, role: role, grams: grams, lo: lo, hi: maxGrams(food), v: vec(food) };
  }

  function mealVec(meal) {
    const t = [0, 0, 0, 0, 0];
    meal.items.forEach(function (it) { for (let k = 0; k < 5; k++) t[k] += it.v[k] * it.grams; });
    return t;
  }
  function dayVec(meals) {
    const t = [0, 0, 0, 0, 0];
    meals.forEach(function (m) { const mv = mealVec(m); for (let k = 0; k < 5; k++) t[k] += mv[k]; });
    return t;
  }

  function toOutputMeal(m) {
    return {
      key: m.key, name: m.name, share: m.share,
      items: m.items.filter(function (it) { return it.grams > 0; })
        .map(function (it) { return { foodId: it.food.id, role: it.role, grams: it.grams }; })
    };
  }

  // Rebuilds working meals from a Plan (for rescale and swap). Unknown foods are kept as inert items. Protein and
  // carb items keep the generator's minimum portion as their floor (or their current grams if already below it).
  function toWorkMeals(plan, F) {
    return plan.meals.map(function (m) {
      return {
        key: m.key, name: m.name, share: m.share, type: MEAL_TYPE[m.key] || 'main',
        items: m.items.map(function (it) {
          const food = F[it.foodId];
          if (!food) return { food: { id: it.foodId }, role: it.role, grams: it.grams, lo: it.grams, hi: it.grams, v: [0, 0, 0, 0, 0], inert: true };
          const floor = it.role === 'protein' || it.role === 'carb' ? Math.min(it.grams, minPortion(food)) : stepOf(food);
          const w = mkItem(food, it.role, it.grams, floor);
          w.hi = Math.max(w.hi, it.grams);   // never force an existing portion down just because of the cap
          return w;
        })
      };
    });
  }

  function clonePlan(plan) { return JSON.parse(JSON.stringify(plan)); }

  function pickTargets(t) {
    t = t || {};
    return { kcal: num(t.kcal), protein: num(t.protein), fat: num(t.fat), carbs: num(t.carbs) };
  }

  // ---------- least squares ----------
  function solveLinear(M, b) {
    const n = b.length, A = M.map(function (row, i) { return row.concat([b[i]]); });
    for (let c = 0; c < n; c++) {
      let piv = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
      if (Math.abs(A[piv][c]) < 1e-12) return null;
      const tmp = A[c]; A[c] = A[piv]; A[piv] = tmp;
      for (let r = 0; r < n; r++) {
        if (r === c) continue;
        const f = A[r][c] / A[c][c];
        for (let k = c; k <= n; k++) A[r][k] -= f * A[c][k];
      }
    }
    return A.map(function (row, i) { return row[n] / A[i][i]; });
  }

  // Minimises Σ_r (w_r · (Σ_j cols[j][r]·x_j − t_r))² with lo_j ≤ x_j ≤ hi_j for up to 3 unknowns: every
  // combination of active bounds (3^n) is tried and the free unknowns come from the normal equations.
  function boxLeastSquares(cols, t, w, lo, hi) {
    const n = cols.length, R = t.length;
    let best = null, bestObj = Infinity;
    for (let code = 0; code < Math.pow(3, n); code++) {
      const x = new Array(n), free = [];
      let c = code;
      for (let j = 0; j < n; j++) {
        const s = c % 3; c = (c - s) / 3;
        if (s === 0) free.push(j); else x[j] = s === 1 ? lo[j] : hi[j];
      }
      const rt = t.slice();
      for (let j = 0; j < n; j++) if (free.indexOf(j) < 0) for (let r = 0; r < R; r++) rt[r] -= cols[j][r] * x[j];
      if (free.length) {
        const M = free.map(function (a) {
          return free.map(function (b) { let s = 0; for (let r = 0; r < R; r++) s += w[r] * w[r] * cols[a][r] * cols[b][r]; return s; });
        });
        const rhs = free.map(function (a) { let s = 0; for (let r = 0; r < R; r++) s += w[r] * w[r] * cols[a][r] * rt[r]; return s; });
        const sol = solveLinear(M, rhs);
        if (!sol) continue;
        let ok = true;
        free.forEach(function (j, i) { x[j] = sol[i]; if (x[j] < lo[j] - 1e-9 || x[j] > hi[j] + 1e-9) ok = false; });
        if (!ok) continue;
      }
      let obj = 0;
      for (let r = 0; r < R; r++) {
        let s = -t[r];
        for (let j = 0; j < n; j++) s += cols[j][r] * x[j];
        obj += w[r] * w[r] * s * s;
      }
      if (obj < bestObj - 1e-12) { bestObj = obj; best = x; }
    }
    return best;
  }

  // Rounds a solved portion; items whose lower bound is 0 (optional fat) drop out below half a step.
  function roundItem(it, g) {
    if (it.lo === 0 && g < stepOf(it.food) / 2) return 0;
    return Math.min(it.hi, Math.max(it.lo, roundGrams(it.food, g)));
  }

  // Solves the protein/carb/fat grams of one meal against `aim` ([kcal, P, C, F]) with produce fixed.
  function solveMeal(meal, aim) {
    const vars = meal.items.filter(function (it) { return it.role !== 'produce' && !it.inert; });
    if (!vars.length) return;
    const fixed = [0, 0, 0, 0, 0];
    meal.items.forEach(function (it) {
      if (vars.indexOf(it) < 0) for (let k = 0; k < 5; k++) fixed[k] += it.v[k] * it.grams;
    });
    const t = [aim[P] - fixed[P], aim[C] - fixed[C], aim[FA] - fixed[FA], aim[K] - fixed[K]];
    const cols = vars.map(function (it) { return [it.v[P] * 100, it.v[C] * 100, it.v[FA] * 100, it.v[K] * 100]; });
    const x = boxLeastSquares(cols, t, LS_WEIGHTS,
      vars.map(function (it) { return it.lo / 100; }), vars.map(function (it) { return it.hi / 100; }));
    vars.forEach(function (it, j) { it.grams = roundItem(it, x[j] * 100); });
  }

  function shareAim(T, share) { return [T.kcal * share, T.protein * share, T.carbs * share, T.fat * share]; }

  // ---------- scoring and greedy correction ----------
  function sq(x) { return x * x; }
  // Fat below this is reported as a warning (fat above target is not: it only happens when carbs are capped).
  function fatFloor(T) { return T.fat > 0 ? T.fat - Math.max(10, 0.2 * T.fat) : 0; }

  // Penalties shared by generation and swaps, in kcal-equivalents squared, in priority order:
  //   ×100  kcal / protein outside the aim band (published limits, with headroom),
  //   ×1    fibre below `fibreAim` and fat below the warning floor (so an unreachable fibre goal never costs the
  //         kcal/protein limits, and fibre is not bought by dropping all fat),
  //   soft  distance of kcal, protein, carbs and fat from `aim` (fat below aim costs more than above it).
  function penalty(day, T, aim, fibreAim) {
    const kE = day[K] - aim[K], pE = day[P] - aim[P], fE = day[FA] - aim[FA];
    const limits = sq(Math.max(0, Math.abs(day[K] - T.kcal) - T.kcal * KCAL_AIM_PCT / 100)) +
      sq(4 * Math.max(0, Math.abs(day[P] - T.protein) - PROTEIN_AIM_G));
    const rules = sq(40 * Math.max(0, fibreAim - day[FI])) + sq(20 * Math.max(0, fatFloor(T) - day[FA]));
    const soft = sq(kE) + 1.5 * sq(4 * pE) + 0.15 * sq(4 * (day[C] - aim[C])) + (fE < 0 ? 0.6 : 0.15) * sq(9 * fE);
    return 100 * limits + rules + soft;
  }

  // Day score for generation: the penalty against the day targets, plus a small term keeping each meal's energy
  // and protein near its share so corrections don't pile up in one meal.
  function dayScorer(T, meals) {
    const aim = [T.kcal, T.protein, T.carbs, T.fat];
    const shares = meals.map(function (m) { return m.share; });
    return function (tot, mealT) {
      let spread = 0;
      for (let i = 0; i < mealT.length; i++) {
        spread += sq(mealT[i][K] - shares[i] * T.kcal) + sq(4 * (mealT[i][P] - shares[i] * T.protein));
      }
      return penalty(tot, T, aim, FIBRE_AIM_G) + 0.05 * spread;
    };
  }

  // Deterministic best-improvement descent over ±1 step moves of the movable items. `scorer(dayTotals,
  // mealTotals)` is minimised; stops when no single move (or, failing that, no pair of opposite moves) improves.
  function correct(meals, movable, scorer) {
    const tot = dayVec(meals);
    const mealT = meals.map(mealVec);
    const moves = [];
    movable.forEach(function (ref) {
      const it = meals[ref.m].items[ref.i];
      [1, -1].forEach(function (d) { moves.push({ it: it, m: ref.m, d: d }); });
    });
    function target(mv) {
      const g = mv.it.grams + mv.d * stepOf(mv.it.food);
      if (g < mv.it.lo - 1e-9 || g > mv.it.hi + 1e-9) return null;
      return Math.abs(g) < 1e-9 ? 0 : g;
    }
    function apply(mv, g, sign) {
      const dg = (g - mv.it.grams) * sign;
      for (let k = 0; k < 5; k++) { tot[k] += mv.it.v[k] * dg; mealT[mv.m][k] += mv.it.v[k] * dg; }
    }
    let cur = scorer(tot, mealT);
    for (let iter = 0; iter < MAX_CORRECTION_STEPS; iter++) {
      let best = null, bestS = cur - 1e-9;
      moves.forEach(function (mv) {
        const g = target(mv);
        if (g === null) return;
        apply(mv, g, 1);
        const s = scorer(tot, mealT);
        apply(mv, g, -1);
        if (s < bestS) { bestS = s; best = [[mv, g]]; }
      });
      if (!best) best = bestPair(moves, target, apply, scorer, tot, mealT, cur);
      if (!best) break;
      best.forEach(function (x) { apply(x[0], x[1], 1); x[0].it.grams = x[1]; });
      cur = scorer(tot, mealT);
    }
  }

  // Pairs of moves on two different items (one up, one down): lets the descent trade e.g. carbs for protein
  // when every single step makes the score worse.
  function bestPair(moves, target, apply, scorer, tot, mealT, cur) {
    let best = null, bestS = cur - 1e-9;
    for (let a = 0; a < moves.length; a++) {
      const ga = target(moves[a]);
      if (ga === null || moves[a].d < 0) continue;
      apply(moves[a], ga, 1);
      const saved = moves[a].it.grams;
      moves[a].it.grams = ga;
      for (let b = 0; b < moves.length; b++) {
        if (moves[b].d > 0 || moves[b].it === moves[a].it) continue;
        const gb = target(moves[b]);
        if (gb === null) continue;
        apply(moves[b], gb, 1);
        const s = scorer(tot, mealT);
        apply(moves[b], gb, -1);
        if (s < bestS) { bestS = s; best = [[moves[a], ga], [moves[b], gb]]; }
      }
      moves[a].it.grams = saved;
      apply(moves[a], ga, -1);
    }
    return best;
  }

  // ---------- generation ----------
  function buildDay(layout, sel, T) {
    const meals = layout.map(function (L, i) {
      const s = sel[i], items = [];
      if (s.protein) items.push(mkItem(s.protein, 'protein', 0, minPortion(s.protein)));
      if (s.carb) items.push(mkItem(s.carb, 'carb', 0, minPortion(s.carb)));
      if (s.produce) {
        const start = s.produce.category === 'vegetable' ? VEG_START_G : FRUIT_START_G;
        const it = mkItem(s.produce, 'produce', 0, 0);
        it.grams = it.lo = Math.min(it.hi, roundGrams(s.produce, start));
        items.push(it);
      }
      if (s.fat) items.push(mkItem(s.fat, 'fat', 0, 0));
      return { key: L.key, name: L.name, share: L.share, type: L.type, items: items };
    });
    meals.forEach(function (m) { solveMeal(m, shareAim(T, m.share)); });
    growFibre(meals, function (m) { solveMeal(m, shareAim(T, m.share)); });
    const movable = [];
    meals.forEach(function (m, mi) { m.items.forEach(function (it, ii) { movable.push({ m: mi, i: ii }); }); });
    correct(meals, movable, dayScorer(T, meals));
    return meals;
  }

  // Grows produce (vegetables first, smallest portion first) until the day reaches the fibre aim; the meal is
  // re-solved after every step so the extra produce replaces carb-food energy.
  function growFibre(meals, resolve) {
    for (let guard = 0; guard < 200 && dayVec(meals)[FI] < FIBRE_AIM_G; guard++) {
      let pick = null;
      ['vegetable', 'fruit'].forEach(function (cat) {
        if (pick) return;
        meals.forEach(function (m) {
          m.items.forEach(function (it) {
            if (it.role !== 'produce' || it.inert || it.food.category !== cat || it.grams >= it.hi) return;
            if (!pick || it.grams < pick.it.grams || (it.grams === pick.it.grams && it.v[FI] > pick.it.v[FI])) pick = { it: it, m: m };
          });
        });
      });
      if (!pick) {   // any other produce (e.g. a custom food) as a last resort
        meals.forEach(function (m) {
          m.items.forEach(function (it) {
            if (!pick && it.role === 'produce' && !it.inert && it.grams < it.hi && it.v[FI] > 0) pick = { it: it, m: m };
          });
        });
      }
      if (!pick) return;
      const it = pick.it;
      it.grams = it.lo = Math.min(it.hi, it.food.unit ? it.grams + it.food.unit.grams : it.grams + PRODUCE_GROW_G);
      resolve(pick.m);
    }
  }

  // Sum of how far the day is outside the rules that produce warnings (0 = all met); used to compare
  // alternative food choices.
  function violation(meals, T) {
    const tot = dayVec(meals);
    const kPct = T.kcal > 0 ? Math.abs(tot[K] - T.kcal) / T.kcal * 100 : 0;
    return Math.max(0, kPct - KCAL_TOL_PCT) * 10 + Math.max(0, Math.abs(tot[P] - T.protein) - PROTEIN_TOL_G) * 2 +
      Math.max(0, FIBRE_MIN_G - tot[FI]) * 2 + Math.max(0, fatFloor(T) - tot[FA]);
  }

  function evaluate(layout, sel, T) {
    const meals = buildDay(layout, sel, T);
    const scorer = dayScorer(T, meals);
    return { sel: sel, meals: meals, bad: violation(meals, T), score: scorer(dayVec(meals), meals.map(mealVec)) };
  }

  function better(a, b) { return a.bad < b.bad - 1e-9 || (Math.abs(a.bad - b.bad) <= 1e-9 && a.score < b.score - 1e-6); }

  function distinctVeg(sel) {
    const ids = {};
    sel.forEach(function (s) { if (s.produce && s.produce.category === 'vegetable') ids[s.produce.id] = true; });
    return Object.keys(ids).length;
  }

  // Local search over food choices, used only when the ranked choice cannot meet the hard rules (e.g. very high
  // kcal with few meals needs denser carbs). Each round tries every single-food replacement and keeps the best.
  function improveSelection(layout, lists, first, T) {
    let cur = first, evals = 0;
    for (let round = 0; round < MAX_SEARCH_ROUNDS && cur.bad > 0 && evals < MAX_SEARCH_EVALS; round++) {
      let best = cur;
      layout.forEach(function (L, mi) {
        ['carb', 'protein', 'fat', 'produce'].forEach(function (role) {
          const s = cur.sel[mi];
          lists[L.type][role].forEach(function (f) {
            if (s[role] && f.id === s[role].id) return;
            if (['protein', 'carb', 'produce', 'fat'].some(function (r) { return r !== role && s[r] && s[r].id === f.id; })) return;
            const sel = cur.sel.map(function (x, i) { return i === mi ? Object.assign({}, x, { [role]: f }) : x; });
            if (role === 'produce' && distinctVeg(sel) < Math.min(VEG_MIN, distinctVeg(cur.sel))) return;
            if (evals++ >= MAX_SEARCH_EVALS) return;
            const cand = evaluate(layout, sel, T);
            if (better(cand, best)) best = cand;
          });
        });
      });
      if (best === cur) break;
      cur = best;
    }
    return cur;
  }

  function generatePlan(opts) {
    opts = opts || {};
    const F = normalizeMap(opts.foods);
    const T = pickTargets(opts.targets);
    const n = MEAL_LAYOUTS[opts.mealsPerDay] ? Number(opts.mealsPerDay) : 4;
    const layout = MEAL_LAYOUTS[n];
    const allowed = allowedIds(F, opts.liked, opts.excluded).map(function (id) { return F[id]; });
    const lists = candidateLists(allowed);
    let res = evaluate(layout, selectFoods(layout, lists), T);
    if (res.bad > 0) res = improveSelection(layout, lists, res, T);
    const plan = { mealsPerDay: n, targets: T, meals: res.meals.map(toOutputMeal), warnings: [] };
    plan.warnings = checkPlan(plan, F, T).issues;
    return plan;
  }

  // ---------- totals and checks ----------
  function nutrientsOf(food, grams) {
    const k = num(grams) / 100;
    return { kcal: num(food.kcal) * k, protein: num(food.protein) * k, carbs: num(food.carbs) * k, fat: num(food.fat) * k, fibre: num(food.fibre) * k };
  }
  function zero() { return { kcal: 0, protein: 0, carbs: 0, fat: 0, fibre: 0 }; }
  function addTo(acc, x) { Object.keys(acc).forEach(function (k) { acc[k] += x[k]; }); }

  function planTotals(plan, foods) {
    const day = zero(), meals = {};
    (plan && plan.meals || []).forEach(function (m) {
      const t = zero();
      m.items.forEach(function (it) { if (foods[it.foodId]) addTo(t, nutrientsOf(foods[it.foodId], it.grams)); });
      meals[m.key] = t;
      addTo(day, t);
    });
    return { day: day, meals: meals };
  }

  function fmt(x) { return String(Math.round(x)); }
  function signed(x) { const r = Math.round(x * 10) / 10; return (r > 0 ? '+' : r < 0 ? '−' : '') + String(Math.abs(r)); }

  function checkPlan(plan, foods, targets) {
    const T = pickTargets(targets || plan.targets);
    const F = normalizeMap(foods);
    const d = planTotals(plan, F).day;
    const kcalDiffPct = T.kcal > 0 ? (d.kcal - T.kcal) / T.kcal * 100 : 0;
    const proteinDiffG = d.protein - T.protein;
    const veg = {}, fruit = {}, issues = [];
    plan.meals.forEach(function (m) {
      const count = { protein: 0, carb: 0, produce: 0 };
      m.items.forEach(function (it) {
        const f = F[it.foodId];
        if (!f) { issues.push(m.name + ': unknown food "' + it.foodId + '".'); return; }
        if (count[it.role] !== undefined) count[it.role]++;
        if (it.role === 'produce' && f.category === 'vegetable') veg[f.id] = true;
        if (it.role === 'produce' && f.category === 'fruit') fruit[f.id] = true;
        if (it.grams > maxGrams(f) + 1e-9) issues.push(m.name + ': ' + f.name + ' ' + fmt(it.grams) + ' g is above the ' + fmt(f.maxPerMeal) + ' g per-meal maximum.');
      });
      if (count.protein !== 1) issues.push(m.name + ': ' + (count.protein ? 'more than one protein food.' : 'no protein food (like a protein food that suits this meal).'));
      if (count.carb !== 1) issues.push(m.name + ': ' + (count.carb ? 'more than one carb food.' : 'no carb food (like a carb food that suits this meal).'));
      if (!count.produce) issues.push(m.name + ': no vegetable or fruit (like one that suits this meal).');
    });
    const vegCount = Object.keys(veg).length, fruitCount = Object.keys(fruit).length;
    if (Math.abs(kcalDiffPct) > KCAL_TOL_PCT + 1e-9) {
      issues.push('Calories ' + fmt(d.kcal) + ' kcal vs target ' + fmt(T.kcal) + ' (' + signed(kcalDiffPct) + ' %, limit ±5 %).');
    }
    if (Math.abs(proteinDiffG) > PROTEIN_TOL_G + 1e-9) {
      issues.push('Protein ' + fmt(d.protein) + ' g vs target ' + fmt(T.protein) + ' g (' + signed(proteinDiffG) + ' g, limit ±10 g).');
    }
    if (d.fibre < FIBRE_MIN_G - 1e-9) issues.push('Fibre ' + fmt(d.fibre) + ' g is below 25 g: like more vegetables, fruit or wholegrain carbs.');
    if (vegCount < VEG_MIN) issues.push((vegCount ? 'Only 1 different vegetable' : 'No vegetables') + ' in the day (need 2): like more vegetables.');
    if (fruitCount < FRUIT_MIN) issues.push('No fruit in the day (need 1): like a fruit.');
    if (d.fat < fatFloor(T) - 1e-9) {
      issues.push('Fat ' + fmt(d.fat) + ' g is well below the ' + fmt(T.fat) + ' g target: like a fat source (oil, nuts, avocado).');
    }
    return { ok: issues.length === 0, kcalDiffPct: kcalDiffPct, proteinDiffG: proteinDiffG, fibre: d.fibre, vegCount: vegCount, fruitCount: fruitCount, issues: issues };
  }

  // ---------- rescale ----------
  function sameTargets(a, b) { return a.kcal === b.kcal && a.protein === b.protein && a.fat === b.fat && a.carbs === b.carbs; }

  // Spreads `delta` (kcal or grams of nutrient `key`) over items, each item taking a share proportional to
  // `weight(it)`, within [lo, hi] (water-filling: clamped items drop out and the rest is shared again). Changed
  // items are rounded. Returns the part of `delta` that could not be placed.
  function spread(items, delta, key, weight) {
    let left = delta;
    let active = items.filter(function (it) { return it.v[key] > 0; });
    const want = new Map(items.map(function (it) { return [it, it.grams]; }));
    while (active.length && Math.abs(left) > 1e-9) {
      let wsum = 0;
      active.forEach(function (it) { wsum += weight(it); });
      const even = wsum <= 0;
      const next = [];
      let placed = 0;
      active.forEach(function (it) {
        const share = even ? 1 / active.length : weight(it) / wsum;
        const g = want.get(it) + left * share / it.v[key];
        const clamped = Math.min(it.hi, Math.max(it.lo, g));
        placed += (clamped - want.get(it)) * it.v[key];
        want.set(it, clamped);
        if (clamped === g) next.push(it);
      });
      left -= placed;
      if (next.length === active.length) break;
      active = next;
    }
    items.forEach(function (it) {
      const g = want.get(it);
      if (Math.abs(g - it.grams) > 1e-9) it.grams = Math.min(it.hi, Math.max(it.lo, roundGrams(it.food, g)));
    });
    return left;
  }

  // Greedy clean-up after rounding: single steps on `items` (never against the direction `dir` of the change,
  // never past `origin`) while |value − aim| shrinks.
  function polish(items, dir, key, aim, currentValue, origin) {
    let val = currentValue;
    for (let guard = 0; guard < 200; guard++) {
      let best = null, bestErr = Math.abs(val - aim) - 1e-9;
      items.forEach(function (it) {
        [1, -1].forEach(function (d) {
          const g = it.grams + d * stepOf(it.food);
          if (g < it.lo - 1e-9 || g > it.hi + 1e-9) return;
          if (dir > 0 && g < origin.get(it) - 1e-9) return;
          if (dir < 0 && g > origin.get(it) + 1e-9) return;
          const e = Math.abs(val + (g - it.grams) * it.v[key] - aim);
          if (e < bestErr) { bestErr = e; best = { it: it, g: g }; }
        });
      });
      if (!best) return;
      val += (best.g - best.it.grams) * best.it.v[key];
      best.it.grams = best.g;
    }
  }

  function byRole(meals, role) {
    const out = [];
    meals.forEach(function (m) { m.items.forEach(function (it) { if (it.role === role && !it.inert) out.push(it); }); });
    return out;
  }

  function rescalePlan(plan, foods, newTargets) {
    const F = normalizeMap(foods);
    const T1 = pickTargets(newTargets);
    const out = clonePlan(plan);
    out.targets = T1;
    if (sameTargets(pickTargets(plan.targets), T1)) return { plan: out, changes: [] };
    const meals = toWorkMeals(plan, F);
    const origin = new Map();
    meals.forEach(function (m) { m.items.forEach(function (it) { origin.set(it, it.grams); }); });

    // 1. protein items move only when the protein target moved, towards the new target
    if (pickTargets(plan.targets).protein !== T1.protein) {
      const items = byRole(meals, 'protein');
      const dP = T1.protein - dayVec(meals)[P];
      spread(items, dP, P, function (it) { return it.grams * it.v[P]; });
      polish(items, Math.sign(dP), P, T1.protein, dayVec(meals)[P], origin);
    }
    // 2. energy: carb items first (in proportion to their carb grams), then fat items
    const dK = T1.kcal - dayVec(meals)[K];
    const carbs = byRole(meals, 'carb'), fats = byRole(meals, 'fat');
    const left = spread(carbs, dK, K, function (it) { return it.grams * it.v[C]; });
    let used = carbs;
    if (Math.abs(left) > 1e-6 && Math.sign(left) === Math.sign(dK)) {
      spread(fats, left, K, function (it) { return it.grams * it.v[FA]; });
      used = carbs.concat(fats);
    }
    polish(used, Math.sign(dK), K, T1.kcal, dayVec(meals)[K], origin);

    const changes = [];
    out.meals.forEach(function (m, mi) {
      m.items.forEach(function (it, ii) {
        const g = meals[mi].items[ii].grams;
        if (g !== it.grams) { changes.push({ mealKey: m.key, foodId: it.foodId, from: it.grams, to: g }); it.grams = g; }
      });
    });
    out.warnings = checkPlan(out, F, T1).issues;
    return { plan: out, changes: changes };
  }

  // ---------- swap ----------
  function vegIds(plan, F, skip) {
    const ids = {};
    plan.meals.forEach(function (m) {
      m.items.forEach(function (it) {
        if (it === skip) return;
        const f = F[it.foodId];
        if (f && it.role === 'produce' && f.category === 'vegetable') ids[f.id] = true;
      });
    });
    return ids;
  }

  function swapCandidates(plan, foods, liked, excluded, mealKey, itemIndex) {
    const F = normalizeMap(foods);
    const meal = (plan.meals || []).filter(function (m) { return m.key === mealKey; })[0];
    const item = meal && meal.items[itemIndex];
    const cur = item && F[item.foodId];
    if (!cur) return [];
    const type = MEAL_TYPE[mealKey] || 'main';
    const inMeal = {};
    meal.items.forEach(function (it) { inMeal[it.foodId] = true; });
    let list = allowedIds(F, liked, excluded).map(function (id) { return F[id]; }).filter(function (f) {
      return !inMeal[f.id] && f.category === cur.category && fits(f, item.role, type);
    });
    if (cur.category === 'vegetable' && item.role === 'produce') {
      // a vegetable already used elsewhere is only offered when the day keeps 2 different vegetables
      const before = Object.keys(vegIds(plan, F)).length;
      const others = vegIds(plan, F, item);
      list = list.filter(function (f) {
        const after = Object.keys(others).length + (others[f.id] ? 0 : 1);
        return after >= VEG_MIN || after >= before;
      });
    }
    return rankFoods(list, item.role).map(function (f) { return f.id; });
  }

  function swapFood(plan, foods, liked, excluded, mealKey, itemIndex, newFoodId) {
    if (swapCandidates(plan, foods, liked, excluded, mealKey, itemIndex).indexOf(newFoodId) < 0) {
      throw new Error('swapFood: ' + newFoodId + ' is not a valid replacement for item ' + itemIndex + ' of ' + mealKey);
    }
    const F = normalizeMap(foods);
    const T = pickTargets(plan.targets);
    const meals = toWorkMeals(plan, F);
    const mi = plan.meals.map(function (m) { return m.key; }).indexOf(mealKey);
    const meal = meals[mi];
    const before = mealVec(meal);
    const beforeFibre = dayVec(meals)[FI];

    // new item: start from the portion that supplies the same amount of the role's key nutrient
    const old = meal.items[itemIndex], food = F[newFoodId];
    const key = { protein: P, carb: C, fat: FA }[old.role];
    const next = mkItem(food, old.role, 0, old.role === 'protein' || old.role === 'carb' ? minPortion(food) : stepOf(food));
    const startG = key === undefined || !(next.v[key] > 0) ? old.grams : old.grams * old.v[key] / next.v[key];
    next.grams = Math.min(next.hi, Math.max(next.lo, roundGrams(food, startG)));
    meal.items[itemIndex] = next;
    // produce portions may grow (fibre) but never shrink to make room for energy
    meal.items.forEach(function (it) { if (it.role === 'produce' && !it.inert) it.lo = it.grams; });

    // re-solve this meal only, towards its previous totals; the day must keep its hard rules
    solveMeal(meal, [before[K], before[P], before[C], before[FA]]);
    // The soft aim is the day as it was before the swap, so the meal is pulled back to its previous totals.
    const fibreAim = Math.min(FIBRE_AIM_G, Math.max(beforeFibre, FIBRE_MIN_G));
    const rest = dayVec(meals.filter(function (m, i) { return i !== mi; }));
    const aim = [rest[K] + before[K], rest[P] + before[P], rest[C] + before[C], rest[FA] + before[FA]];
    const scorer = function (tot) {
      const day = [0, 0, 0, 0, 0];
      for (let k = 0; k < 5; k++) day[k] = rest[k] + tot[k];
      return penalty(day, T, aim, fibreAim);
    };
    const movable = meal.items.map(function (it, ii) { return { m: 0, i: ii }; }).filter(function (r) { return !meal.items[r.i].inert; });
    correct([meal], movable, scorer);

    const out = clonePlan(plan);
    out.meals[mi].items = meal.items.map(function (it, ii) {
      return { foodId: it.food.id, role: plan.meals[mi].items[ii].role, grams: it.grams };
    });
    out.warnings = checkPlan(out, F, T).issues;
    return out;
  }

  const api = {
    MEAL_LAYOUTS: MEAL_LAYOUTS,
    normalizeFood: normalizeFood,
    roundGrams: roundGrams,
    generatePlan: generatePlan,
    rescalePlan: rescalePlan,
    swapCandidates: swapCandidates,
    swapFood: swapFood,
    planTotals: planTotals,
    checkPlan: checkPlan
  };

  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.FL = root.FL || {}; root.FL.mealplan = api; }
})(typeof window !== 'undefined' ? window : globalThis);
