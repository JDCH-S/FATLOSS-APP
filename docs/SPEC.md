# Fat-loss app — build spec

Single-user fat-loss tracker published as a claude.ai Artifact (HTML page + JS files). Metric units, EUR,
English UI. Clean and functional, no decoration. Five tabs: **Setup, Daily Log, Weekly Check-in, Meal Plan,
Groceries**. All data persists between sessions.

This document is the contract between modules. Function names, argument order and data shapes below are
binding. Anything not specified is the implementer's choice, but keep it deterministic (no `Math.random`, and
no `Date.now()`/`new Date()` inside logic modules: "today" is always passed in as an ISO date string).

## 1. Repository layout

```
app/index.html        page shell (no <!doctype>/<html>/<head>/<body> tags: the Artifact host adds them)
app/js/foods.js       built-in food DB (exists; do not change ids)
app/js/products.js    seed product table (research output)
app/js/engine.js      dates, calculations, phase logic, check-in, targets
app/js/mealplan.js    deterministic meal-plan solver, rescale, swap
app/js/groceries.js   weekly quantities, packs/costs, cheapest mix, export, price import
app/js/store.js       persistence (claude db capability, localStorage fallback), backup export/import
app/js/ui.js          rendering + event wiring for the five tabs, SVG chart
tests/*.test.js       node:test unit tests (`node --test tests/`), no npm dependencies
price_script/fetch_prices.py   Apify price fetcher (stdlib only) + test_fetch_prices.py (unittest)
```

### Module pattern (every file in app/js)

```js
(function (root) {
  'use strict';
  // ... pure code ...
  const api = { /* exports */ };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.FL = root.FL || {}; root.FL.<name> = api; }
})(typeof window !== 'undefined' ? window : globalThis);
```

Logic modules (engine, mealplan, groceries) are **pure** and **dependency-injected**: they do not require each
other; callers pass food maps, products, dates etc. as arguments. They must run unchanged in Node 22
(`require('../app/js/engine.js')`) and in the browser (`window.FL.engine`). Script load order in index.html:
foods, products, engine, mealplan, groceries, store, ui.

## 2. Conventions

* Dates are ISO strings `YYYY-MM-DD` (calendar dates, no time zone). Do date arithmetic via
  `Date.UTC(y, m-1, d)` and `getUTCDay()`; never local-time `Date` parsing.
* Weekdays are numbers 0–6 with 0 = Sunday … 6 = Saturday (JS `getUTCDay()` convention).
* **Diet week** = Saturday dinner → following Friday dinner. For every date-level purpose a week is the
  calendar block **Saturday … Friday** and is identified by its Saturday (`weekStart`). Saturday's calendar day
  belongs to the week that starts at its dinner.
* Energy: 7700 kcal per kg of body weight. Macro energy 4/4/9 kcal per g (protein/carbs/fat).
* Rounding for display only; keep full precision in logic (except meal-plan grams, which are rounded by design).

## 3. Persisted state (one object in memory)

```js
state = {
  version: 1,
  setup: {
    isExample: true,            // true until the user edits anything in Setup
    weightKg: 85, heightCm: 180, age: 35,
    bodyFatPct: 20,             // number or null (optional)
    goalType: 'bf',             // 'bf' | 'weight'
    goalBodyFatPct: 12,         // used when goalType === 'bf'
    goalWeightKg: null,         // used when goalType === 'weight'
    steps: 8000,                // typical daily steps
    liftDays: [1, 3, 5],        // weekday numbers
    padelDays: [2, 6],
    liftMinutes: 60, padelMinutes: 90,
    mealsPerDay: 4,             // 3..5
    saturdayMode: 'offplan',    // 'offplan' | 'included'
    programStart: '2026-09-26', // a Saturday; first diet week
    likedFoods: [...ids],       // default foods.DEFAULT_LIKED
    excludedFoods: [],          // excluded everywhere (wins over liked)
    customFoods: []             // same shape as foods.js entries, id prefix 'custom_', custom: true
  },
  logs: { 'YYYY-MM-DD': { weight: 84.2, kcal: 2100, protein: 180, steps: 9000 } }, // any field may be null
  checkins: { '<weekStart>': CheckinRecord },
  plan: null | { base: Plan, weekGenerated: '<weekStart>' },
  products: [ProductRow],       // starts as a copy of products.js seed
  priceMeta: { lastImport: null | 'YYYY-MM-DD', lastImportFile: null | string,
               lastImportSummary: null | {matched, updated, unmatched}, unmatched: [ImportRow] }
}
```

## 4. engine.js

All functions pure. `setup` is `state.setup`. Every calculation returns the number **and** the inputs/formula
text so the UI can show its working.

```js
// dates
parseISO(iso) -> ms (UTC midnight)          toISO(ms) -> iso
addDays(iso, n) -> iso                       dayOfWeek(iso) -> 0..6
daysBetween(aIso, bIso) -> integer (b - a)
weekStartOf(iso) -> iso of the Saturday on/before iso
weekDays(weekStart) -> [7 isos Sat..Fri]
nextSaturdayOnOrAfter(iso) -> iso
formatDate(iso) -> 'Sat 26 Sep'             formatRange(weekStart) -> 'Sat 26 Sep – Fri 2 Oct'

// calculations: each returns {value, formula, inputs:{...}} (value may be null when not computable)
calcBMR(setup)            // 10×kg + 6.25×cm − 5×age + 5
calcExercise(setup)       // MET × kg × hours; lifting MET 5, padel MET 6; returns {value: kcal/day avg,
                          //   liftWeek, padelWeek, liftSessions, padelSessions, ...}
calcFormulaTDEE(setup)    // BMR×1.2 + steps×0.0005×kg + weekly exercise kcal / 7
                          //   returns {value, parts:{base, steps, exercise}, formula, inputs}
calcLeanMass(setup)       // weight × (1 − BF%/100), null if no BF%
calcProtein(setup)        // 2.7 g/kg lean mass; fallback 2.2 g/kg bodyweight
calcFatFloor(weightKg)    // 0.6 g/kg
calcGoalWeight(setup)     // goalType 'weight' → goalWeightKg; 'bf' → LBM / (1 − goalBF/100).
                          //   Without BF% and goalType 'bf': LBM estimated from BMI with Deurenberg
                          //   (BF% = 1.2×BMI + 0.23×age − 16.2), flagged estimated:true
calcThresholdWeight(setup) // weight at which BF = 15% (LBM / 0.85), same LBM estimate rule
weeklyRate(setup, weightKg) -> {value: 0.01 | 0.0075, reason}
                          //   1.0 %/week while weightKg > thresholdWeight, else 0.75 %/week
dailyDeficit(rate, weightKg) -> {value: rate × weightKg × 7700 / 7, weeklyLossKg, formula}

// macros
initialMacros(kcal, proteinG, weightKg)
    // fat = max(0.22 × kcal / 9, 0.6 × kg); carbs = (kcal − 4P − 9F) / 4 (≥ 0)
applyCalorieChange(prev, newKcal, weightKg, proteinG)
    // protein = max(prev.protein, proteinG)  (protein is never reduced)
    // delta = newKcal − prev.kcal. Increase: all to carbs.
    // Decrease: from carbs first (down to 0), then fat down to the fat floor. If still short, kcal ends
    // higher than requested (report `limited: true`).
    // Returned kcal is ALWAYS recomputed as 4P + 4C + 9F.
    // -> {kcal, protein, fat, carbs, limited}

// phases (program = cycles of CUT 8 weeks + BREAK 2 weeks, until the goal is reached, then FINAL maintenance)
programWeekIndex(programStart, weekStart) -> integer (0 = first diet week; negative = before start)
phaseForWeek(programStart, weekStart, goalReachedWeek)
  -> { type: 'pre' | 'cut' | 'break' | 'final',
       label: 'Cut 2' | 'Maintenance break 1' | 'Final maintenance' | 'Not started',
       weekNumber,          // 1-based program week
       weekInBlock, blockLength,   // e.g. 3 of 8 (final: weekInBlock counts up, blockLength null)
       blockNumber,         // 1-based cycle number
       blockStart,          // Saturday of the block's first week
       blockEnd }           // Friday (dinner) that ends the block (null for final)
  // index n ≥ 0: n mod 10 < 8 → cut, else break. goalReachedWeek (a weekStart) and later → final.

// logs
weekAverages(logs, weekStart)
  -> { avgWeight, weighIns, avgKcal, intakeDays, avgProtein, proteinDays, avgSteps, stepDays, days:[...] }
     (averages over days that have that field; null when none)
trailingAverage(logs, endIso, n = 7) -> {avg, count}     // for the chart (rolling 7-day)

// targets
targetsForWeek(state, weekStart)
  -> { kcal, protein, fat, carbs, phase, source: 'initial'|'checkin'|'carry'|'transition'|'pre',
       tdeeBasis, tdeeSource: 'formula'|'learned', deficit, rate, weightUsed, targetLossKg, bmrFloorApplied,
       explanation: [strings] }
  // Rules:
  //  * weekStart < programStart: 'pre' → same numbers as week 1 (preview).
  //  * week 1 (weekStart === programStart): kcal = max(formulaTDEE − deficit(rate(setup.weightKg)), BMR),
  //    macros = initialMacros(kcal, calcProtein, weightKg). Computed live from setup.
  //  * record = state.checkins[weekStart − 7] exists and has .next → that (source 'checkin').
  //  * else prev = targetsForWeek(weekStart − 7). If phase type differs from prev's phase type → transition:
  //    basis = weekNumber ≤ 2 ? formulaTDEE : latestLearned(state, weekStart); deficit per new phase using
  //    latestWeight(state, weekStart); kcal = max(basis − deficit, BMR); macros via applyCalorieChange.
  //    Otherwise carry prev unchanged (source 'carry').
  //  * targetLossKg = cut ? rate × weightUsed : 0.
latestLearned(state, beforeWeekStart) -> learned TDEE from the latest check-in before that week, else formula TDEE
latestWeight(state, beforeWeekStart)  -> latest check-in avgWeight before that week, else setup.weightKg
goalReachedWeek(state) -> earliest (record.weekStart + 7) among check-ins with goalReached, else null

computeCheckin(state, weekStart) -> CheckinRecord   // pure; the UI saves it into state.checkins[weekStart]
```

### Check-in algorithm (week = Sat `S` … Fri `S+6`, run on Friday morning after the weigh-in)

```
cur  = weekAverages(logs, S);  prev = weekAverages(logs, S − 7)
valid = cur.weighIns ≥ 4 && prev.weighIns ≥ 4 && cur.intakeDays ≥ 1      (else: no observed TDEE)
deltaKg   = cur.avgWeight − prev.avgWeight
observed  = cur.avgKcal − deltaKg × 7700 / 7
learnedBefore = latestLearned(state, S)            // formula TDEE if no earlier check-in
thisT = targetsForWeek(state, S)
targetLossKg = thisT.targetLossKg;  actualLossKg = prev.avgWeight − cur.avgWeight
belowTarget  = thisT.phase.type === 'cut' && valid && actualLossKg < 0.7 × targetLossKg
stall = belowTarget && state.checkins[S − 7]?.belowTarget === true      // 2 consecutive weeks
diagnosis (only when stall), first match wins:
   cur.avgSteps < setup.steps × 0.85          → 'neat'      "NEAT drop — restore steps before cutting food"
   cur.intakeDays < 6                         → 'tracking'  "Tracking gap"
   otherwise                                  → 'adaptation' "Metabolic adaptation" (adjustment applied)
applied = valid && diagnosis ∉ {neat, tracking}
learnedAfter = applied ? 0.7 × learnedBefore + 0.3 × observed : learnedBefore
goalReached = valid && cur.avgWeight ≤ goalWeight
nextPhase = phaseForWeek(programStart, S + 7, goalReached ? S + 7 : goalReachedWeek(state))
nextWeekNumber = programWeekIndex(programStart, S + 7) + 1
basis = nextWeekNumber ≤ 2 ? formulaTDEE : learnedAfter
weightNow = valid ? cur.avgWeight : latestWeight(state, S)
deficitNext = nextPhase.type === 'cut' ? dailyDeficit(weeklyRate(setup, weightNow), weightNow) : 0
raw = basis − deficitNext
transition = nextPhase.type !== thisT.phase.type
if !applied && !transition: kcal = thisT.kcal                 (targets unchanged)
elif transition:            kcal = raw                        (full step: deficit removed / re-applied)
else:                       kcal = clamp(raw, thisT.kcal − 200, thisT.kcal + 200)
kcal = max(kcal, BMR)  (bmrFloorApplied flag)
next = applyCalorieChange(thisT, kcal, weightNow, calcProtein(setup).value) + {phase: nextPhase, ...}
```

`CheckinRecord = { weekStart, computedOn, valid, cur:{...weekAverages}, prev:{...}, deltaKg, observedTDEE,
learnedBefore, learnedAfter, formulaTDEE, tdeeUsedForNext:'formula'|'learned', targetLossKg, actualLossKg,
lossRatio, belowTarget, stall, diagnosis, diagnosisText, applied, goalReached, capped, transition,
next: {kcal, protein, fat, carbs, phase, tdeeBasis, deficit, rate, weightUsed, targetLossKg}, notes:[...] }`

The ±200 kcal cap applies to week-to-week adjustments inside a phase. Phase transitions (cut → break, break → cut,
→ final) move the whole deficit at once, because the break must sit at maintenance.

```js
projectBlockEnd(state, todayIso) -> {weightKg, fromWeight, weeks, explanation}
   // base = trailing 7-day avg ending today (≥ 3 weigh-ins) else latestWeight; weeks = days to blockEnd / 7;
   // cut: apply weekly rate week by week (rate re-evaluated each week); break/final: unchanged.
targetLine(state, fromIso, toIso) -> [{date, kg}]   // planned weight path from programStart:
   // start = avg of the week before programStart if ≥ 4 weigh-ins else setup.weightKg; cut weeks lose the weekly
   // rate, break weeks flat; stops at goal weight. One point per day (linear within a week).
programSummary(state, todayIso) -> { weekStart, phase, targets, blockEnd, projection, nextCheckinDate,
   checkinDue: {weekStart, date} | null, goalWeight }
```

## 5. mealplan.js

Food objects come from `foods.byId([...FOODS, ...customFoods])`. Allowed foods = liked − excluded.

```js
MEAL_LAYOUTS = {
  3: [breakfast 0.30, lunch 0.35, dinner 0.35],
  4: [breakfast 0.25, lunch 0.30, afternoon snack 0.15, dinner 0.30],
  5: [breakfast 0.22, lunch 0.28, afternoon snack 0.12, dinner 0.28, evening snack 0.10] }
  // each entry {key:'breakfast'|'lunch'|'snack_pm'|'dinner'|'snack_eve', name, share, type:'breakfast'|'main'}
  // breakfast and snacks use type 'breakfast' foods, lunch/dinner type 'main'.

Plan = { mealsPerDay, targets:{kcal,protein,fat,carbs}, meals:[ { key, name, share,
          items:[ {foodId, role:'protein'|'carb'|'produce'|'fat', grams} ] } ],
         warnings:[strings] }

generatePlan({foods, liked, excluded, targets, mealsPerDay}) -> Plan
rescalePlan(plan, foods, newTargets) -> {plan, changes:[{mealKey, foodId, from, to}]}
swapCandidates(plan, foods, liked, excluded, mealKey, itemIndex) -> [foodId]  // same category, allowed, fits meal type
swapFood(plan, foods, liked, excluded, mealKey, itemIndex, newFoodId) -> Plan
planTotals(plan, foods) -> { day:{kcal,protein,carbs,fat,fibre}, meals:{[key]:{kcal,protein,carbs,fat,fibre}} }
checkPlan(plan, foods, targets) -> { ok, kcalDiffPct, proteinDiffG, fibre, vegCount, fruitCount, issues:[strings] }
roundGrams(food, grams) -> grams   // whole units if food.unit, else nearest 5 g (min one unit / 5 g)
```

Rules (acceptance criteria, tested):
1. Only allowed foods. Each meal = exactly 1 protein-role food + 1 carb-role food + ≥ 1 produce item
   (+ 1 fat-role food when needed to reach the fat target). Role eligibility from `food.slots`; meal type from
   `food.meals`.
2. Day totals: kcal within ±5 % of target, protein within ±10 g. Fibre ≥ 25 g. ≥ 2 different vegetables and
   ≥ 1 fruit per day. Fat and carbs as close as possible.
3. All grams rounded (5 g or whole units). Respect `maxPerMeal`.
4. Deterministic: same inputs → identical output. Food choice ranks by filling-ness: protein role by protein per
   100 kcal + fill; carb role by fill then fibre per 100 kcal; produce by fill; prefer variety across meals
   (don't repeat a protein/carb food if another allowed one fits the meal type).
5. Produce: breakfast/snack meals get fruit, lunch/dinner get vegetables (two different vegetables across the
   day). Vegetable portions start ~200 g per main meal and grow (≤ maxPerMeal) until fibre ≥ 25 g.
6. Grams per meal solved from the meal's share of P/C/F (small non-negative least squares on protein, carb and fat
   foods after produce is fixed), then rounded, then a deterministic day-level correction pass nudges portions in
   5 g / 1-unit steps until rule 2 holds (or no step improves: then add a warning that says what is off).
7. `rescalePlan`: same foods and meals; protein items only change if the protein target changed. Calorie change
   goes to carb items first (proportionally to their current carb grams), then fat items. Returns per-item
   changes. Maintenance breaks = the same meals with larger carb portions.
8. `swapFood`: replaces one item with another allowed food of the same category (vegetable ↔ vegetable, etc.),
   re-solves only that meal's grams to that meal's previous totals; other meals are byte-identical. Keep ≥ 2
   different vegetables per day (candidates exclude a vegetable already used elsewhere when that would break it).
9. When constraints cannot be met (e.g. no liked fruit), still return a plan and list what is missing in
   `warnings`.

## 6. groceries.js

```js
STORES = ['Colruyt', 'Delhaize', 'Carrefour']
ProductRow = { id, store, foodId, product, ean, packSizeG, price, promo, date: iso|null,
               source: 'estimate'|'seed'|'import'|'manual', url: string|'' , note: string|'' }
mealOccurrences(mealKey, saturdayMode) -> 7 | 6
   // 'breakfast','lunch' → 6 when 'offplan', 7 when 'included'; every meal after lunch → 7
weeklyQuantities(plan, saturdayMode) -> [{foodId, grams, perMeal:[{mealKey, grams, times}]}] (sorted by foodId)
packsFor(needG, row) -> {packs: ceil(need / packSizeG), cost: packs × price, leftoverG}
isStale(row, todayIso) -> {stale: bool, reason: 'estimate'|'no date'|'older than 7 days'|null, ageDays}
storeBreakdown(quantities, products, todayIso)
  -> { stores: { [store]: { items:[{foodId, needG, row|null, packs, cost, leftoverG, stale}],
                             total, missing:[foodId], staleCount } },
       cheapest: { items:[{foodId, store, row, packs, cost, leftoverG, stale}], total, missing:[foodId] } }
  // several rows for the same food+store: use the one with the lowest cost for the need.
buildExport(quantities, products, foods, window:{start, end}, todayIso)
  -> { generated, week:{start, end, label}, items:[{ food_id, food, food_nl, weekly_g, unit_g,
        stores:{ Colruyt:[{ean, product, pack_size_g, url}], Delhaize:[...], Carrefour:[...] } }] }
parseImport(text) -> {rows:[ImportRow], errors:[strings]}
   // ImportRow = {store, ean, product, pack_size_g, price_eur, promo, date}; validates types, store names
   // (case-insensitive → canonical), trims EAN.
applyImport(products, rows, todayIso)
   -> {products, matched:[{row, productId}], unmatched:[row], summary:{matched, updated, unmatched}}
   // match store + EAN (EAN non-empty); fallback store + normalized product name (lowercase, collapse spaces,
   // strip accents). Matched rows update product name, packSizeG, price, promo, date (row.date || todayIso),
   // source 'import'. Never mutate the input array.
mapImportRow(products, row, foodId) -> products   // adds a new ProductRow for an unmatched row
```

## 7. store.js (persistence)

* Uses `await window.claude?.use?.('db')` when available (the page declares the `db` capability with rules
  making all data owner-only). Documents:
  `fl/setup`, `fl/program` (reserved), `fl/plan`, `fl/products` `{rows}`, `fl/pricemeta`, `fl/checkins`
  `{records}`, `logs/<YYYY>` `{days: {iso: entry}}` (one document per calendar year).
* Fallback when db is null: `localStorage['fatloss-app-v1']` (whole state JSON), every access in try/catch.
* `load() -> Promise<{state, backend: 'cloud'|'browser'|'memory'}>`; `save(section, state)` debounced (~600 ms)
  per document, one write in flight per document; `onStatus(fn)` reports 'saving'|'saved'|'error'.
* Backup: `exportAll(state) -> JSON string` `{app:'fatloss', version:1, exported, state}`;
  `importAll(text) -> state` (validates, fills missing sections with defaults).
* Downloads: `download(filename, text)` uses `await window.claude?.use?.('downloads')` → `save({filename, data})`;
  without it, falls back to a Blob + `<a download>` (works when the page is opened outside claude.ai), and if that is
  impossible the UI shows the JSON in a textarea with a Copy button.

## 8. UI (index.html + ui.js)

* Header on every tab: current phase label, "week X of Y", block end date ("ends Fri 20 Nov, dinner"),
  projected weight at block end, today's targets (kcal / P / C / F), save status.
* **Setup**: all inputs from §3 (weekday pickers as 7 toggle buttons Sat…Fri or Mon…Sun), Saturday toggle, food
  picker grouped by category with per-100 g macros, three states per food (Like / — / Won't eat), custom food
  form, program start date (Saturday). Below: "Starting calculations" panel showing every number with its
  formula and inputs (BMR, exercise, formula TDEE, LBM, protein, fat floor, fat 22 %, carbs, goal weight, 15 %
  threshold weight, weekly rate, deficit, starting target, BMR floor). Phase timeline (blocks with dates).
  Backup export/import buttons.
* **Daily Log**: quick-entry row (date defaults to today; weight, kcal, protein, steps; Enter saves), table of
  the current and previous diet weeks with targets vs eaten, edit/delete per row. On Saturdays with
  saturdayMode 'offplan': show the budget left for the off-plan breakfast + lunch = day target − planned kcal
  and protein of the meals after lunch.
* **Weekly Check-in**: due banner (Friday), this vs previous week table (7-day averages, days logged, steps),
  observed / learned / formula TDEE with formulas, target vs actual loss, stall diagnosis flags, proposed new
  targets vs current, "Save check-in" (overwrites the same week), history table, SVG chart: daily weights
  (dots), rolling 7-day average (line), target line (dashed), goal weight (thin line).
* **Meal Plan**: week selector (this week / next week from Saturday dinner), Generate button (confirm inline
  when a plan exists), meals table with grams (and units, e.g. "2 eggs (110 g)"), macros per meal and per day
  vs targets, check results (kcal %, protein g, fibre, veg/fruit counts), Swap per item (select of candidates),
  "changes vs last week" list.
* **Groceries**: window "Sat 3 Oct dinner → Fri 9 Oct dinner", weekly quantities, per-store tables (product,
  EAN, pack, price, price date, packs, cost, leftover, stale flag "run price script"), totals per store, cheapest
  mix, "Export grocery list", "Import prices" (file input), last import date, unmatched rows with a food select
  to map them, editable product table (add/edit/delete rows, reset to seed).
* No `alert/confirm/prompt` (they are blocked in the artifact viewer): inline confirmations.
* Theme tokens on `:root`, dark palette under `@media (prefers-color-scheme: dark)` guarded by
  `:root:not([data-theme="light"])` and repeated under `:root[data-theme="dark"]`; body background from a token;
  works at 400 px wide (tables in `overflow-x:auto` wrappers); visible focus states.
