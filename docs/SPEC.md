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
  program: null | { snapshot: null | { programStart, takenOn, reason, startWeightKg, week1: {kcal, protein, fat, carbs,
             limited, tdeeBasis, tdeeSource, tdeeText, deficit, rate, rateReason, weightUsed, weightSource, targetLossKg,
             bmrFloorApplied, phaseType, explanation} } },   // taken once week 1 is over or at the first check-in
  plan: null | { base: Plan, weekGenerated: '<weekStart>', history: { '<weekStart>': [{key, name, items:[{foodId, grams}]}] } },
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
       tdeeBasis, tdeeSource: 'formula'|'learned', tdeeText, deficit, rate, rateReason, weightUsed, weightSource,
       targetLossKg, bmrFloorApplied, explanation: [strings] }
  // tdeeText    'formula TDEE 2907 kcal (program weeks 1–2)' | 'learned TDEE 2850 kcal (<where it comes from>)'
  // weightSource where weightUsed comes from: 'Setup weight' | '7-day average of <range> (n weigh-ins)' | 'check-in average
  //              for <range>' | ... (null when there is no weight)
  // rateReason  weeklyRate(...).reason for a cut ('80.9 kg is at or below the 15 % body-fat weight (81.04 kg): 0.75 %/week'),
  //              else null
  // Basis lines: the explanation of EVERY week, whatever its source (initial, pre, checkin, carry, transition), contains
  //   cut:         'Weight <kg> kg: <weightSource>.'  '<rateReason>.'  'Target loss = <rate> % × <kg> kg = <x> kg/week.'
  //                '<dailyDeficit(rate, kg).formula>.'  ('Deficit = <rate> % × <kg> kg × 7700 kcal / 7 = <d> kcal/day (…)')
  //   break/final: '<phase label> has no deficit (<why>): the target is the TDEE, here <tdeeText>. <why this TDEE>'
  //   Each line appears once (check-in notes already hold them for new records). Records and snapshots saved before these
  //   fields existed get them rebuilt from their numbers (rate reason from the live rule when it gives the same rate, else
  //   '<rate> %/week, set by the check-in of <range>').
  // Rules:
  //  * weekStart < programStart: 'pre' → same numbers as week 1 (preview).
  //  * week 1 (weekStart === programStart): kcal = max(formulaTDEE − deficit(rate(setup.weightKg)), BMR),
  //    macros = initialMacros(kcal, calcProtein, weightKg). Computed live from setup until a program snapshot
  //    exists (see makeProgramSnapshot), then taken from snapshot.week1.
  //  * record = state.checkins[weekStart − 7] exists and has .next → that (source 'checkin').
  //  * else prev = targetsForWeek(weekStart − 7). If phase type differs from prev's phase type → transition:
  //    basis = weekNumber ≤ 2 ? formulaTDEE : latestLearned(state, weekStart); deficit per new phase using
  //    latestWeight(state, weekStart); kcal = max(basis − deficit, BMR); macros via applyCalorieChange.
  //    Otherwise carry prev unchanged (source 'carry').
  //  * targetLossKg = cut ? rate × weightUsed : 0.
// Program-week records only: a check-in record whose weekStart < programStart (saved by an old version, or left behind
// when the program start moved later) is baseline data and NEVER feeds latestLearned, latestWeight, goalReachedWeek,
// the stall chain (prevBelowTarget) or any target. The logs of the week before the start stay the baseline averages.
latestLearned(state, beforeWeekStart) -> learned TDEE from the latest program-week check-in before that week, else formula TDEE
latestWeight(state, beforeWeekStart)  -> newest of: a logged week with ≥ 4 weigh-ins (searched back to the week before the
                                        start), a saved program-week check-in average (logs win for the same week);
                                        else setup.weightKg
goalReachedWeek(state) -> programStart when the start weight is already at/below the goal; else the earliest
                          (record.weekStart + 7) among program-week check-ins with goalReached; else null
makeProgramSnapshot(state, todayIso) -> snapshot | null
   // null while setup.isExample is true, while Setup is incomplete, before the start, and until week 1 is fixed:
   // it is non-null only when todayIso ≥ programStart + 7 (week 1 is over) OR a check-in exists for a week ≥
   // programStart (the first check-in freezes week 1). Until then week 1 stays live from Setup.
   // snapshot = { programStart, takenOn: todayIso, reason: 'once week 1 was over' | 'when the first check-in was saved',
   //   startWeightKg, week1: { kcal, protein, fat, carbs, limited, tdeeBasis, tdeeSource, tdeeText, deficit, rate,
   //   rateReason, weightUsed, weightSource, targetLossKg, bmrFloorApplied, phaseType, explanation } }
   //   (reason, tdeeText, rateReason and weightSource are new; older snapshots without them still work.)
   // The UI stores it in state.program.snapshot as soon as it is non-null (and replaces it when programStart changes).
   // Week 1 then uses snapshot.week1 instead of live Setup values (explanation[0]: 'Week-1 targets fixed on <date>,
   // <reason>; Setup edits since then do not change them.'), and every week's protein is at least
   // snapshot.week1.protein (protein is never reduced; any raise comes out of carbs, then fat).

computeCheckin(state, weekStart) -> CheckinRecord   // pure; the UI saves it into state.checkins[weekStart]
   // weekStart < programStart → a baseline record (baseline: true) that changes nothing: observedTDEE null,
   // learnedAfter = learnedBefore, applied/belowTarget/stall/goalReached false, next = targetsForWeek(S + 7) (the week-1
   // preview), one note saying it is the baseline week (or a week before it). The UI should not offer to save it.
```

### Check-in algorithm (week = Sat `S` … Fri `S+6`, run on Friday morning after the weigh-in)

```
cur  = weekAverages(logs, S);  prev = weekAverages(logs, S − 7)
valid = cur.weighIns ≥ 4 && prev.weighIns ≥ 4 && cur.intakeDays ≥ 1      (else: no observed TDEE)
deltaKg   = cur.avgWeight − prev.avgWeight
observed  = cur.avgKcal − deltaKg × 7700 / 7
learnedBefore = latestLearned(state, S)            // formula TDEE if no earlier program-week check-in
thisT = targetsForWeek(state, S)
targetLossKg = thisT.targetLossKg;  actualLossKg = prev.avgWeight − cur.avgWeight
belowTarget  = thisT.phase.type === 'cut' && valid && actualLossKg < 0.7 × targetLossKg
prevBelowTarget = state.checkins[S − 7]?.belowTarget, or — when that check-in was never saved — the same test
                  worked out from the logs (record.prevBelowTargetSource: 'checkin' | 'logs' | null).
                  For week 1, S − 7 is the baseline week: false, source null (a saved record there is ignored).
stall = belowTarget && prevBelowTarget                                   // 2 consecutive weeks
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

`CheckinRecord = { weekStart, computedOn, baseline, valid, cur:{...weekAverages}, prev:{...}, deltaKg, observedTDEE,
learnedBefore, learnedAfter, formulaTDEE, tdeeUsedForNext:'formula'|'learned', targetLossKg, actualLossKg,
lossRatio, belowTarget, prevBelowTarget, prevBelowTargetSource, stall, diagnosis, diagnosisText, applied, goalReached,
capped, transition, next: {kcal, protein, fat, carbs, limited, phase, tdeeBasis, tdeeSource, tdeeText, deficit, rate,
rateReason, weightUsed, weightSource, targetLossKg, bmrFloorApplied}, notes:[...] }`

Notes (program weeks), in order: observed TDEE (or "Not enough data…"); for a cut week with a valid loss,
`Lost <a> kg vs target <t> kg (<r> %). Target loss = <rate> % × <kg> kg = <t> kg/week; weight: <weightSource>.`; the
stall lines; the learned-TDEE line; goal reached (`Goal weight reached (…): final maintenance from <date>.` the first time,
`At or below the goal weight (…): final maintenance continues (since <date>).` once it has started); the derivation of next week (`Next week: <tdeeText> − deficit <d> kcal =
<raw> kcal[, capped at …]` | `Phase change A → B: …` | `Targets unchanged (<why>). Next week keeps <macros>.`); then
ALWAYS the basis lines of next week's targets (see targetsForWeek: weight + source, rate reason with the 15 % body-fat
weight, target loss, deficit formula for a cut; TDEE used and why for a break/final), whether or not the phase changes,
the rate changes or the targets stay unchanged; then BMR floor, limited, macro change. `next.weightSource`,
`next.rateReason` and `next.tdeeText` carry the same texts so later weeks (source 'checkin' and 'carry') repeat them.

The ±200 kcal cap applies to week-to-week adjustments inside a phase. Phase transitions (cut → break, break → cut,
→ final) move the whole deficit at once, because the break must sit at maintenance.

```js
projectBlockEnd(state, todayIso) -> {weightKg, fromWeight, weeks, blockEnd, weightLabel, explanation}
   // base = trailing 7-day avg ending today (≥ 3 weigh-ins) else latestWeight; weeks = days to blockEnd / 7;
   // cut: apply weekly rate week by week (rate re-evaluated each week); break/final: unchanged.
   // weightLabel: 'Projected at block end' when the block has an end; 'Holding at' in final maintenance, which has
   // no block end (blockEnd null, weeks 0, weightKg = the current weight). Final explanation: the reason it started,
   // then 'Final maintenance has no block end: calories stay at maintenance with no end date, holding at <kg> kg (<source>).'
targetLine(state, fromIso, toIso) -> [{date, kg}]   // planned weight path from programStart:
   // start = avg of the week before programStart if ≥ 4 weigh-ins else setup.weightKg; cut weeks lose the weekly
   // rate, break weeks flat; stops at goal weight. One point per day (linear within a week).
programSummary(state, todayIso) -> { weekStart, phase, targets, blockEnd, projection, nextCheckinDate,
   checkinDue: {weekStart, date} | null, goalWeight, explanation: [strings] }
   // projectBlockEnd counts to the morning after the block's last Friday dinner (a whole cut = 8 weeks of loss).
   // In final maintenance: blockEnd null, and explanation[1] = 'Final maintenance: week <n>, since <blockStart> (dinner).
   // It has no block end: holding at <kg> kg.'
   // targetsForWeek / projectBlockEnd / programSummary all return explanation arrays with their numbers.
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
rescalePlan(plan, foods, newTargets, opts?) -> {plan, changes:[{mealKey, foodId, from, to}]}
   // opts.allowCarbStretch: false forbids the carb stretch of a large increase (see rule 7); it never enables it
swapCandidates(plan, foods, liked, excluded, mealKey, itemIndex) -> [foodId]  // same category, allowed, fits meal type
swapFood(plan, foods, liked, excluded, mealKey, itemIndex, newFoodId) -> Plan
planTotals(plan, foods) -> { day:{kcal,protein,carbs,fat,fibre}, meals:{[key]:{kcal,protein,carbs,fat,fibre}} }
checkPlan(plan, foods, targets) -> { ok, kcalDiffPct, proteinDiffG, fibre, vegCount, fruitCount, issues:[strings] }
roundGrams(food, grams) -> grams   // whole units if food.unit, else nearest 5 g (min one unit / 5 g)
replaceDisallowed(plan, foods, liked, excluded)
   -> { plan, replaced:[{mealKey, itemIndex, from, to}], dropped:[{mealKey, itemIndex, foodId}],
        impossible:[{mealKey, itemIndex, foodId}] }   // swaps out won't-eat / un-liked / deleted foods, meal by meal
limitDecimals(value, limit) -> 0..9   // decimals needed so a displayed value never looks like it is on the wrong side of a limit
```

Additions made after review: normalizeFood fills custom-food defaults by category (meals, and gram/kcal caps per
meal); lunch/dinner prefer a cooking fat (oil, avocado) and breakfast/snacks nuts, seeds or nut butter, and the fat
source may repeat; generated carb portions have a meal-type floor (150 kcal main, 80 kcal breakfast/snack, at most
60 % of the meal's carb budget); rescalePlan also holds protein within the aim by nudging protein items and restores
fibre by growing produce; checkPlan warns when fat is more than 20 % above target, and a calorie shortfall whose carb
portions are all at their maximum says so (`…limit ±5 %): every carb portion is already as large as one meal allows;
more meals per day (or regenerating the plan) would make room.`).

Repair (generation, rescale and swap, when the day ends outside a published kcal/protein/fibre limit): first moves of
one item, or two at once, to any portion on its grid (greedy rounds, best move first); if those rounds do not meet
the limits, every portion goes back and one meal at a time is re-solved as a whole (its protein, carb and fat
items, and produce within its bounds: bounded least squares towards the exact targets and towards a 5 × 5 grid of targets across the limit box, whole-unit items fixed one unit
below and above, then rounding and every portion within one step), and the valid result closest to the aim is kept.
Neither stage breaks a rule that already held (the fat floor included), and a meal whose extreme portions cannot
reach the limits is skipped. What this guarantees: whenever a warning about kcal, protein or fibre remains, no one-
or two-item move and none of those single-meal re-solves meets the limits. It is not exhaustive: a fix that needs
portions in two meals to move together, or that lies between the re-solve's targets, can be missed. Deterministic;
generation stays under 100 ms with the default foods.

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
   goes to carb items first (proportionally to their current carb grams, within `maxPerMeal`), then fat items.
   Returns per-item changes. Maintenance breaks = the same meals with larger carb portions. An increase the carb
   items cannot hold at their maximum: fat items grow while the day's fat stays within +20 % of its target (no fat
   warning from this step); only for a large increase (`newTargets.kcal − plan.targets.kcal ≥ 300`, i.e. a phase
   change such as a maintenance break, and `opts.allowCarbStretch !== false`) and when the day is still short by
   more than 3.5 %, carb items may then stretch to 1.25 × their maximum (reported by the per-meal maximum warning);
   fat goes past +20 % (reported) only as far as the kcal limit needs (to −4.5 %). Routine check-ins (weekly
   changes ≤ 200 kcal) therefore never take a portion past `maxPerMeal`; if nothing else can hold the energy, the
   calorie warning is reported instead.
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
  // several rows for the same food+store: use the lowest-cost one among the rows with a price that is not stale
  // (isStale), so a fresh imported, mapped or manual price beats a cheaper estimate or old price. Only when no priced
  // row is current, the lowest-cost row overall (its item keeps stale.stale = true). Rows without a usable price never
  // beat priced rows; on equal cost the earlier row wins.
buildExport(quantities, products, foods, window:{start, end}, todayIso)
  -> { generated, week:{start, end, label}, items:[{ food_id, food, food_nl, weekly_g, unit_g, drained_ratio, g_per_ml,
        stores:{ Colruyt:[{ean, product, pack_size_g, url}], Delhaize:[...], Carrefour:[...] } }] }
parseImport(text) -> {rows:[ImportRow], errors:[strings]}
   // ImportRow = {store, ean, product, pack_size_g, price_eur, promo, date, match_product?}; validates types, store names
   // (case-insensitive → canonical), trims EAN.
applyImport(products, rows, todayIso)
   -> {products, matched:[{row, productId}], unmatched:[row], summary:{matched, updated, unmatched}}
   // match store + EAN (leading zeros ignored, so GTIN-14 = EAN-13), then store + match_product, then store +
   // normalized product name (lowercase, collapse spaces, strip accents). Matched rows take the store's product
   // name, packSizeG, price, promo, date (row.date || todayIso), source 'import'. Never mutate the input array.
mapImportRow(products, row, foodId) -> products   // adds a new ProductRow for an unmatched row
mergeUnmatched(existing, incoming) -> list         // de-duplicated by store + barcode (or store + name), newest wins
// Canned tuna, chickpeas and kidney beans are counted in drained grams everywhere (foods.drainedRatio); oil in grams
// (foods.gPerMl 0.92). The price script multiplies a scraped label (net) size by drained_ratio, except when the
// listing states a drained weight (uitgelekt / égoutté / drained, or a drained-weight field; a size written next to
// those words is used) or when the label size is within ±10 % of the matched product row's own pack_size_g, which
// the table already holds in drained grams (Colruyt 'BONI tonijn in eigen nat MSC 95g' stays 95 g).
```

## 7. store.js (persistence)

* Uses `await window.claude?.use?.('db')` when available (the page declares the `db` capability with rules
  making all data owner-only). Documents:
  `fl/setup`, `fl/program`, `fl/plan`, `fl/products` `{rows}`, `fl/pricemeta`, `checkins/<YYYY>` `{records}` and
  `logs/<YYYY>` `{days: {iso: entry}}` (one document per calendar year; a legacy `fl/checkins` is migrated on load).
* Logs and check-ins are written per entry with `update()` (a deleted entry is written as null), so a stale tab
  can never overwrite newer entries; the other documents use `set()`. After load the store subscribes once to every
  document/collection and `onRemote(fn(section, value))` fires when another tab or device changed something (the
  value is already merged into the state object).
* Failed writes retry with backoff and keep the 'error' status until they succeed; `flush()` writes everything
  pending and runs on `pagehide` / when the page is hidden.
* Every save also goes at once to `localStorage['fatloss-app-v1']` (the state JSON) and to a journal
  (`fatloss-app-v1-pending`: `{section: {key: {v, b}}}`, the new value and a hash of the cloud value it replaces).
  The next load that reads the cloud writes each journal change whose base the cloud still holds; otherwise the
  cloud's newer value wins and the change is dropped.
* Modes (`mode()`, also `load().mode`):
  - `'cloud'`: db read at load. The localStorage copy is the whole state.
  - `'browser'`: no db in this view (null, or not_granted / capability_disabled / capability_removed);
    localStorage only. `'memory'`: no db and localStorage rejects writes (nothing persists; saves report 'error').
  - `'device-only'`: the db exists but its reads kept failing at load. `load` returns `backend: 'cloud'`,
    `readOnly: true` and `error: 'Could not load your saved data (<reason>). Changes are saved on this device only
    and sync after a successful reload.'`; the state shown is the localStorage copy (or the defaults). Saves go to
    localStorage and the journal only, never to the cloud, so example or stale data can never replace cloud data,
    and each save reports `'error'` with `'Saved on this device only: your account could not be reached. It syncs
    after a successful reload.'` (or `'Not saved: your account could not be reached, and this browser's storage is
    full or blocked.'`). `flush()` resolves false. The journal's base check makes the next healthy load add new
    entries and keep any value the cloud changed meanwhile.
* Several tabs in `'browser'` / `'device-only'` mode share the localStorage copy. A save writes only its own section
  into the latest stored copy; for logs and check-ins, entries this tab has not changed since it last read the copy
  take the stored value (another tab's additions, edits and deletions survive; its own changes win). The window
  `'storage'` event (and `pageshow` / becoming visible) merges other tabs' saves into the state: setup, program,
  plan, products and priceMeta whole, log and check-in entries one by one; `onRemote(section, value)` fires per
  changed section, as in cloud mode, and also (asynchronously) after a save that pulled in another tab's entries.
  Saves here are synchronous: 'saved' (browser) is reported before `save()` returns. Every localStorage access is
  in try/catch.
* `load(defaults) -> Promise<{state, backend: 'cloud'|'browser'|'memory', mode, error, readOnly, migrated}>`;
  `save(section, state)` debounced (~600 ms) per document, one write in flight per document; sections 'setup',
  'program', 'plan', 'products', 'priceMeta', 'checkins', 'logs'; `onStatus(fn(status, message))` reports
  'saving' | 'saved' (only after the writes completed) | 'error'. `backend()` and `mode()` return the current values.
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
* Rendering patches the live DOM in place (a small morph) so focus, half-typed dates and the clicked button survive a
  re-render; date fields apply on blur or Enter.
* The week before the program start is a baseline on the Check-in tab (week-1 targets come from Setup).
* Marking a planned food "won't eat", un-liking it or deleting a custom food replaces it in the plan
  (replaceDisallowed); changing meals per day regenerates the plan.
* Theme tokens on `:root`, dark palette under `@media (prefers-color-scheme: dark)` guarded by
  `:root:not([data-theme="light"])` and repeated under `:root[data-theme="dark"]`; body background from a token;
  works at 400 px wide (tables in `overflow-x:auto` wrappers); visible focus states.
