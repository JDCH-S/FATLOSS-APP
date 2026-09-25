/* Engine: dates, starting calculations, program phases, weekly check-in and targets (SPEC §4).
 *
 * Pure and deterministic: no clock and no randomness. "Today" is always an ISO date argument, and every date is a
 * calendar date handled through Date.UTC. Calculations return {value, formula, inputs} so the UI can show its
 * working: formula strings use rounded display values, while every value keeps full precision.
 */
(function (root) {
  'use strict';

  // ---------- constants ----------
  const DAY_MS = 86400000;
  const KCAL_PER_KG = 7700;                 // energy in one kg of body weight
  const KCAL_P = 4, KCAL_C = 4, KCAL_F = 9; // kcal per gram of protein / carbs / fat
  const MET_LIFT = 5, MET_PADEL = 6;
  const ACTIVITY_FACTOR = 1.2;              // BMR multiplier before steps and exercise are added
  const KCAL_PER_STEP_KG = 0.0005;          // kcal per step per kg of body weight
  const PROTEIN_PER_LBM = 2.7, PROTEIN_PER_KG = 2.2;
  const FAT_SHARE = 0.22, FAT_FLOOR_PER_KG = 0.6;
  const THRESHOLD_BF = 15;                  // body-fat % where the weekly rate slows down
  const RATE_FAST = 0.01, RATE_SLOW = 0.0075;
  const CUT_WEEKS = 8, BREAK_WEEKS = 2, CYCLE_WEEKS = CUT_WEEKS + BREAK_WEEKS;
  const FORMULA_WEEKS = 2;                  // program weeks 1..2 use the formula TDEE
  const WEEKLY_CAP = 200;                   // max kcal change per week inside a phase
  const MIN_WEIGH_INS = 4;
  const LEARN_PREV = 0.7, LEARN_OBSERVED = 0.3;
  const STALL_RATIO = 0.7;                  // loss below 70 % of target counts as "below target"
  const NEAT_RATIO = 0.85;                  // steps below 85 % of the Setup value = NEAT drop
  const MIN_TRACKED_DAYS = 6;
  const TRAILING_MIN_WEIGH_INS = 3;         // projection base needs 3 weigh-ins in the last 7 days

  const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const DIAGNOSIS_TEXT = {
    neat: 'NEAT drop — restore steps before cutting food',
    tracking: 'Tracking gap',
    adaptation: 'Metabolic adaptation'
  };

  // ---------- small helpers ----------
  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  function allNum() { for (let i = 0; i < arguments.length; i++) if (!isNum(arguments[i])) return false; return true; }
  function numOrNull(x) { return isNum(x) ? x : null; }
  function mean(xs) { return xs.reduce(function (a, b) { return a + b; }, 0) / xs.length; }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function macroKcal(p, c, f) { return KCAL_P * p + KCAL_C * c + KCAL_F * f; }

  // Display number: rounded to `dp` decimals, trailing zeros dropped, typographic minus sign.
  function fmt(x, dp) {
    if (!isNum(x)) return '–';
    let s = x.toFixed(dp || 0);
    if (s.indexOf('.') >= 0) s = s.replace(/\.?0+$/, '');
    if (s === '-0') s = '0';
    return s.replace('-', '−');
  }
  // Weekly rate as a percentage with at least one decimal: 0.01 → "1.0", 0.0075 → "0.75".
  function ratePct(rate) { return (rate * 100).toFixed(2).replace(/0$/, ''); }

  // ======================================================================================
  // dates
  // ======================================================================================
  function parseISO(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso));
    if (!m) throw new Error('Invalid ISO date: ' + iso);
    return Date.UTC(+m[1], +m[2] - 1, +m[3]);
  }
  function toISO(ms) {
    const d = new Date(ms);
    return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
  }
  function addDays(iso, n) { return toISO(parseISO(iso) + n * DAY_MS); }
  function dayOfWeek(iso) { return new Date(parseISO(iso)).getUTCDay(); }
  function daysBetween(aIso, bIso) { return Math.round((parseISO(bIso) - parseISO(aIso)) / DAY_MS); }
  // Saturday = 6 maps to itself, Sunday back 1 day, ..., Friday back 6 days.
  function weekStartOf(iso) { return addDays(iso, -((dayOfWeek(iso) + 1) % 7)); }
  function weekDays(weekStart) {
    const out = [];
    for (let i = 0; i < 7; i++) out.push(addDays(weekStart, i));
    return out;
  }
  function nextSaturdayOnOrAfter(iso) { return addDays(iso, (6 - dayOfWeek(iso) + 7) % 7); }
  function formatDate(iso) {
    const d = new Date(parseISO(iso));
    return WEEKDAY_NAMES[d.getUTCDay()] + ' ' + d.getUTCDate() + ' ' + MONTH_NAMES[d.getUTCMonth()];
  }
  function formatRange(weekStart) { return formatDate(weekStart) + ' – ' + formatDate(addDays(weekStart, 6)); }

  // ======================================================================================
  // calculations: each returns {value, formula, inputs}
  // ======================================================================================
  function calcBMR(setup) {
    const kg = setup.weightKg, cm = setup.heightCm, age = setup.age;
    const inputs = { weightKg: kg, heightCm: cm, age: age };
    if (!allNum(kg, cm, age)) return { value: null, formula: 'BMR needs weight, height and age', inputs: inputs };
    const value = 10 * kg + 6.25 * cm - 5 * age + 5;
    return {
      value: value,
      formula: 'BMR = 10×' + fmt(kg, 1) + ' kg + 6.25×' + fmt(cm, 1) + ' cm − 5×' + fmt(age, 1) + ' y + 5 = ' +
        fmt(value) + ' kcal',
      inputs: inputs
    };
  }

  // Distinct valid weekday numbers in a day list.
  function sessionCount(days) {
    if (!Array.isArray(days)) return 0;
    return days.filter(function (d, i) { return Number.isInteger(d) && d >= 0 && d <= 6 && days.indexOf(d) === i; }).length;
  }

  function calcExercise(setup) {
    const kg = setup.weightKg;
    const liftSessions = sessionCount(setup.liftDays), padelSessions = sessionCount(setup.padelDays);
    const liftHours = (isNum(setup.liftMinutes) ? setup.liftMinutes : 0) / 60;
    const padelHours = (isNum(setup.padelMinutes) ? setup.padelMinutes : 0) / 60;
    const inputs = { weightKg: kg, liftSessions: liftSessions, liftHours: liftHours, liftMET: MET_LIFT,
      padelSessions: padelSessions, padelHours: padelHours, padelMET: MET_PADEL };
    if (!isNum(kg)) {
      return { value: null, liftWeek: null, padelWeek: null, weekKcal: null, liftSessions: liftSessions,
        padelSessions: padelSessions, formula: 'Exercise needs body weight', inputs: inputs };
    }
    const liftWeek = liftSessions * MET_LIFT * kg * liftHours;
    const padelWeek = padelSessions * MET_PADEL * kg * padelHours;
    const weekKcal = liftWeek + padelWeek;
    const value = weekKcal / 7;
    return {
      value: value, liftWeek: liftWeek, padelWeek: padelWeek, weekKcal: weekKcal,
      liftSessions: liftSessions, padelSessions: padelSessions,
      formula: 'Lifting ' + liftSessions + ' × MET ' + MET_LIFT + ' × ' + fmt(kg, 1) + ' kg × ' + fmt(liftHours, 2) + ' h = ' +
        fmt(liftWeek) + ' kcal/week; padel ' + padelSessions + ' × MET ' + MET_PADEL + ' × ' + fmt(kg, 1) + ' kg × ' +
        fmt(padelHours, 2) + ' h = ' + fmt(padelWeek) + ' kcal/week; (' + fmt(liftWeek) + ' + ' + fmt(padelWeek) +
        ') / 7 = ' + fmt(value) + ' kcal/day',
      inputs: inputs
    };
  }

  function calcFormulaTDEE(setup) {
    const bmr = calcBMR(setup), ex = calcExercise(setup);
    const kg = setup.weightKg, steps = isNum(setup.steps) ? setup.steps : 0;
    const inputs = { bmr: bmr.value, steps: steps, weightKg: kg, exercisePerDay: ex.value, exerciseWeek: ex.weekKcal };
    if (!allNum(bmr.value, ex.value)) return { value: null, parts: null, formula: 'TDEE needs weight, height and age', inputs: inputs };
    const parts = { base: bmr.value * ACTIVITY_FACTOR, steps: steps * KCAL_PER_STEP_KG * kg, exercise: ex.value };
    const value = parts.base + parts.steps + parts.exercise;
    return {
      value: value, parts: parts,
      formula: 'TDEE = BMR ' + fmt(bmr.value) + ' × ' + ACTIVITY_FACTOR + ' + ' + fmt(steps) + ' steps × ' + KCAL_PER_STEP_KG +
        ' × ' + fmt(kg, 1) + ' kg + exercise ' + fmt(ex.weekKcal) + ' kcal/week / 7 = ' + fmt(parts.base) + ' + ' +
        fmt(parts.steps) + ' + ' + fmt(parts.exercise) + ' = ' + fmt(value) + ' kcal',
      inputs: inputs
    };
  }

  function hasBodyFat(setup) { return isNum(setup.bodyFatPct) && setup.bodyFatPct > 0 && setup.bodyFatPct < 100; }

  function calcLeanMass(setup) {
    const kg = setup.weightKg, bf = setup.bodyFatPct;
    const inputs = { weightKg: kg, bodyFatPct: bf };
    if (!hasBodyFat(setup) || !isNum(kg)) return { value: null, formula: 'No body-fat % given', inputs: inputs };
    const value = kg * (1 - bf / 100);
    return {
      value: value,
      formula: 'Lean mass = ' + fmt(kg, 1) + ' kg × (1 − ' + fmt(bf, 1) + ' %) = ' + fmt(value, 1) + ' kg',
      inputs: inputs
    };
  }

  // Lean mass for the goal and 15 % threshold: measured when BF% is given, else Deurenberg estimate from BMI
  // (BF% = 1.2×BMI + 0.23×age − 16.2, adult men).
  function leanMassBasis(setup) {
    const lbm = calcLeanMass(setup);
    if (isNum(lbm.value)) return { lbm: lbm.value, estimated: false, formula: lbm.formula };
    const kg = setup.weightKg, cm = setup.heightCm, age = setup.age;
    if (!allNum(kg, cm, age)) return { lbm: null, estimated: true, formula: 'Lean mass estimate needs weight, height and age' };
    const m = cm / 100;
    const bmi = kg / (m * m);
    const bf = 1.2 * bmi + 0.23 * age - 16.2;
    const value = kg * (1 - bf / 100);
    return {
      lbm: value, estimated: true, bmi: bmi, bodyFatPct: bf,
      formula: 'Lean mass estimated (no body-fat % given): BMI = ' + fmt(kg, 1) + ' / ' + fmt(m, 2) + '² = ' + fmt(bmi, 1) +
        '; body fat (Deurenberg) = 1.2×' + fmt(bmi, 1) + ' + 0.23×' + fmt(age, 1) + ' − 16.2 = ' + fmt(bf, 1) +
        ' %; lean mass = ' + fmt(kg, 1) + ' kg × (1 − ' + fmt(bf, 1) + ' %) = ' + fmt(value, 1) + ' kg'
    };
  }

  function calcProtein(setup) {
    const lbm = calcLeanMass(setup), kg = setup.weightKg;
    if (isNum(lbm.value)) {
      const value = PROTEIN_PER_LBM * lbm.value;
      return { value: value, basis: 'leanMass', formula: 'Protein = ' + PROTEIN_PER_LBM + ' g × ' + fmt(lbm.value, 1) +
        ' kg lean mass = ' + fmt(value, 1) + ' g', inputs: { leanMassKg: lbm.value, gPerKg: PROTEIN_PER_LBM } };
    }
    if (!isNum(kg)) return { value: null, basis: null, formula: 'Protein needs body weight', inputs: { weightKg: kg } };
    const value = PROTEIN_PER_KG * kg;
    return { value: value, basis: 'bodyweight', formula: 'Protein = ' + PROTEIN_PER_KG + ' g × ' + fmt(kg, 1) +
      ' kg body weight = ' + fmt(value, 1) + ' g (no body-fat % given)', inputs: { weightKg: kg, gPerKg: PROTEIN_PER_KG } };
  }

  function calcFatFloor(weightKg) {
    if (!isNum(weightKg)) return { value: null, formula: 'Fat floor needs body weight', inputs: { weightKg: weightKg } };
    const value = FAT_FLOOR_PER_KG * weightKg;
    return { value: value, formula: 'Fat floor = ' + FAT_FLOOR_PER_KG + ' g × ' + fmt(weightKg, 1) + ' kg = ' + fmt(value, 1) + ' g',
      inputs: { weightKg: weightKg, gPerKg: FAT_FLOOR_PER_KG } };
  }

  function calcGoalWeight(setup) {
    if (setup.goalType === 'weight') {
      const g = numOrNull(setup.goalWeightKg);
      return { value: g, estimated: false, formula: g === null ? 'No goal weight given' : 'Goal weight set directly: ' + fmt(g, 2) + ' kg',
        inputs: { goalType: 'weight', goalWeightKg: g } };
    }
    const goalBF = setup.goalBodyFatPct;
    const basis = leanMassBasis(setup);
    const inputs = { goalType: 'bf', goalBodyFatPct: goalBF, leanMassKg: basis.lbm, leanMassEstimated: basis.estimated };
    if (!isNum(goalBF) || goalBF <= 0 || goalBF >= 100 || !isNum(basis.lbm)) {
      return { value: null, estimated: basis.estimated, formula: 'Goal weight needs a goal body-fat % and lean mass', inputs: inputs };
    }
    const value = basis.lbm / (1 - goalBF / 100);
    return {
      value: value, estimated: basis.estimated,
      formula: (basis.estimated ? basis.formula + '. ' : '') + 'Goal weight = ' + fmt(basis.lbm, 1) + ' kg lean mass / (1 − ' +
        fmt(goalBF, 1) + ' %) = ' + fmt(value, 2) + ' kg',
      inputs: inputs
    };
  }

  function calcThresholdWeight(setup) {
    const basis = leanMassBasis(setup);
    const inputs = { leanMassKg: basis.lbm, leanMassEstimated: basis.estimated, thresholdBodyFatPct: THRESHOLD_BF };
    if (!isNum(basis.lbm)) return { value: null, estimated: basis.estimated, formula: basis.formula, inputs: inputs };
    const value = basis.lbm / (1 - THRESHOLD_BF / 100);
    return {
      value: value, estimated: basis.estimated,
      formula: (basis.estimated ? basis.formula + '. ' : '') + '15 % body-fat weight = ' + fmt(basis.lbm, 1) +
        ' kg lean mass / 0.85 = ' + fmt(value, 2) + ' kg',
      inputs: inputs
    };
  }

  function weeklyRate(setup, weightKg) {
    const thr = calcThresholdWeight(setup).value;
    const inputs = { weightKg: weightKg, thresholdWeightKg: thr };
    let value, reason;
    if (!isNum(weightKg)) {
      value = null; reason = 'Weekly rate needs body weight';
    } else if (!isNum(thr)) {
      value = RATE_FAST; reason = '15 % body-fat weight unknown: ' + ratePct(RATE_FAST) + ' %/week';
    } else if (weightKg > thr) {
      value = RATE_FAST;
      reason = fmt(weightKg, 2) + ' kg is above the 15 % body-fat weight (' + fmt(thr, 2) + ' kg): ' + ratePct(RATE_FAST) + ' %/week';
    } else {
      value = RATE_SLOW;
      reason = fmt(weightKg, 2) + ' kg is at or below the 15 % body-fat weight (' + fmt(thr, 2) + ' kg): ' + ratePct(RATE_SLOW) + ' %/week';
    }
    return { value: value, reason: reason, formula: reason, thresholdWeight: thr, inputs: inputs };
  }

  // `rate` is a number or a weeklyRate() result.
  function dailyDeficit(rate, weightKg) {
    const r = rate && typeof rate === 'object' ? rate.value : rate;
    const inputs = { rate: r, weightKg: weightKg };
    if (!allNum(r, weightKg)) return { value: null, weeklyLossKg: null, formula: 'Deficit needs a rate and body weight', inputs: inputs };
    const weeklyLossKg = r * weightKg;
    const value = weeklyLossKg * KCAL_PER_KG / 7;
    return {
      value: value, weeklyLossKg: weeklyLossKg,
      formula: 'Deficit = ' + ratePct(r) + ' % × ' + fmt(weightKg, 2) + ' kg × ' + KCAL_PER_KG + ' kcal / 7 = ' + fmt(value) +
        ' kcal/day (' + fmt(weeklyLossKg, 2) + ' kg/week)',
      inputs: inputs
    };
  }

  // ======================================================================================
  // macros
  // ======================================================================================
  function initialMacros(kcal, proteinG, weightKg) {
    if (!allNum(kcal, proteinG, weightKg)) return { kcal: null, protein: null, fat: null, carbs: null, limited: false };
    const fat = Math.max(FAT_SHARE * kcal / KCAL_F, FAT_FLOOR_PER_KG * weightKg);
    const rawCarbs = (kcal - KCAL_P * proteinG - KCAL_F * fat) / KCAL_C;
    const carbs = Math.max(0, rawCarbs);
    // kcal is recomputed from the macros; it only differs from the request when protein + fat alone exceed it.
    return { kcal: macroKcal(proteinG, carbs, fat), protein: proteinG, fat: fat, carbs: carbs, limited: rawCarbs < 0 };
  }

  function applyCalorieChange(prev, newKcal, weightKg, proteinG) {
    if (!prev || !allNum(prev.protein, prev.carbs, prev.fat) || !isNum(newKcal)) {
      return { kcal: null, protein: null, fat: null, carbs: null, limited: false };
    }
    const protein = isNum(proteinG) ? Math.max(prev.protein, proteinG) : prev.protein; // protein is never reduced
    let carbs = prev.carbs, fat = prev.fat, limited = false;
    // Measured against the macros after any protein increase, so the result lands on newKcal whenever possible.
    const delta = newKcal - macroKcal(protein, carbs, fat);
    if (delta >= 0) {
      carbs += delta / KCAL_C;
    } else {
      let short = -delta;
      const fromCarbs = Math.min(short, carbs * KCAL_C);
      carbs -= fromCarbs / KCAL_C; short -= fromCarbs;
      const floor = isNum(weightKg) ? FAT_FLOOR_PER_KG * weightKg : fat;
      const fromFat = Math.min(short, Math.max(0, (fat - floor) * KCAL_F));
      fat -= fromFat / KCAL_F; short -= fromFat;
      limited = short > 1e-9;
    }
    carbs = Math.max(0, carbs);
    return { kcal: macroKcal(protein, carbs, fat), protein: protein, fat: fat, carbs: carbs, limited: limited };
  }

  // ======================================================================================
  // phases: cycles of CUT 8 weeks + BREAK 2 weeks until the goal is reached, then FINAL maintenance
  // ======================================================================================
  function programWeekIndex(programStart, weekStart) { return Math.floor(daysBetween(programStart, weekStart) / 7); }

  function phaseForWeek(programStart, weekStart, goalReachedWeek) {
    const n = programWeekIndex(programStart, weekStart);
    if (n < 0) {
      return { type: 'pre', label: 'Not started', weekNumber: null, weekInBlock: null, blockLength: null,
        blockNumber: null, blockStart: null, blockEnd: null };
    }
    if (goalReachedWeek && daysBetween(goalReachedWeek, weekStart) >= 0) {
      const start = daysBetween(programStart, goalReachedWeek) >= 0 ? goalReachedWeek : programStart;
      return { type: 'final', label: 'Final maintenance', weekNumber: n + 1,
        weekInBlock: Math.floor(daysBetween(start, weekStart) / 7) + 1, blockLength: null,
        blockNumber: null, blockStart: start, blockEnd: null };
    }
    const cycle = Math.floor(n / CYCLE_WEEKS), pos = n % CYCLE_WEEKS;
    const cycleStart = addDays(programStart, cycle * CYCLE_WEEKS * 7);
    if (pos < CUT_WEEKS) {
      return { type: 'cut', label: 'Cut ' + (cycle + 1), weekNumber: n + 1, weekInBlock: pos + 1, blockLength: CUT_WEEKS,
        blockNumber: cycle + 1, blockStart: cycleStart, blockEnd: addDays(cycleStart, CUT_WEEKS * 7 - 1) };
    }
    const breakStart = addDays(cycleStart, CUT_WEEKS * 7);
    return { type: 'break', label: 'Maintenance break ' + (cycle + 1), weekNumber: n + 1, weekInBlock: pos - CUT_WEEKS + 1,
      blockLength: BREAK_WEEKS, blockNumber: cycle + 1, blockStart: breakStart, blockEnd: addDays(breakStart, BREAK_WEEKS * 7 - 1) };
  }

  // ======================================================================================
  // logs
  // ======================================================================================
  const LOG_FIELDS = [
    ['weight', 'avgWeight', 'weighIns'],
    ['kcal', 'avgKcal', 'intakeDays'],
    ['protein', 'avgProtein', 'proteinDays'],
    ['steps', 'avgSteps', 'stepDays']
  ];

  function weekAverages(logs, weekStart) {
    const days = weekDays(weekStart).map(function (date) {
      const e = (logs && logs[date]) || {};
      return { date: date, weight: numOrNull(e.weight), kcal: numOrNull(e.kcal), protein: numOrNull(e.protein), steps: numOrNull(e.steps) };
    });
    const out = {};
    LOG_FIELDS.forEach(function (f) {
      const vals = days.map(function (d) { return d[f[0]]; }).filter(isNum);
      out[f[1]] = vals.length ? mean(vals) : null;
      out[f[2]] = vals.length;
    });
    out.days = days;
    return out;
  }

  function trailingAverage(logs, endIso, n) {
    const len = n || 7;
    const vals = [];
    for (let i = len - 1; i >= 0; i--) {
      const e = logs && logs[addDays(endIso, -i)];
      if (e && isNum(e.weight)) vals.push(e.weight);
    }
    return { avg: vals.length ? mean(vals) : null, count: vals.length };
  }

  // ======================================================================================
  // check-in history lookups
  // ======================================================================================
  // The weekStart of the latest saved check-in before `beforeWeekStart` that passes `accept`, or null.
  function latestCheckinWeek(state, beforeWeekStart, accept) {
    const checkins = state.checkins || {};
    let best = null;
    Object.keys(checkins).forEach(function (k) {
      const r = checkins[k];
      if (r && k < beforeWeekStart && accept(r) && (best === null || k > best)) best = k;
    });
    return best;
  }

  // Learned TDEE before a week and where it comes from: {value, week (of the check-in, null = formula value), text}.
  function learnedBasis(state, beforeWeekStart) {
    const k = latestCheckinWeek(state, beforeWeekStart, function (x) { return isNum(x.learnedAfter); });
    return k === null ? { value: calcFormulaTDEE(state.setup).value, week: null, text: 'no check-in yet: formula value' }
      : { value: state.checkins[k].learnedAfter, week: k, text: 'from the check-in of ' + formatRange(k) };
  }
  function latestLearned(state, beforeWeekStart) { return learnedBasis(state, beforeWeekStart).value; }

  // Latest body weight before a week: the newest week with ≥ 4 logged weigh-ins or a saved check-in average (the logs win
  // for the same week), searched back to the week before the program start; else the Setup weight. {kg, text}
  function weightBasis(state, beforeWeekStart) {
    const logs = state.logs || {};
    const k = latestCheckinWeek(state, beforeWeekStart, function (x) { return !!x.cur && isNum(x.cur.avgWeight); });
    const stop = k === null ? addDays(state.setup.programStart, -7) : k;
    for (let w = weekStartOf(addDays(beforeWeekStart, -1)); w >= stop; w = addDays(w, -7)) {
      const a = weekAverages(logs, w);
      if (a.weighIns >= MIN_WEIGH_INS) return { kg: a.avgWeight, text: '7-day average of ' + formatRange(w) + ' (' + a.weighIns + ' weigh-ins)' };
    }
    if (k !== null) return { kg: state.checkins[k].cur.avgWeight, text: 'check-in average for ' + formatRange(k) };
    return { kg: numOrNull(state.setup.weightKg), text: 'Setup weight' };
  }
  function latestWeight(state, beforeWeekStart) { return weightBasis(state, beforeWeekStart).kg; }

  // state.program.snapshot when it belongs to the current program start and holds week-1 targets, else null.
  function programSnapshot(state) {
    const snap = state.program && state.program.snapshot;
    return snap && snap.programStart === state.setup.programStart && snap.week1 &&
      allNum(snap.week1.kcal, snap.week1.protein, snap.week1.carbs, snap.week1.fat) ? snap : null;
  }

  // Weight the program starts from: fixed by the snapshot once the program has started, else the average of the week
  // before the start (≥ 4 weigh-ins), else the Setup weight. {kg, text}
  function startWeight(state) {
    const snap = programSnapshot(state);
    if (snap && isNum(snap.startWeightKg)) return { kg: snap.startWeightKg, text: 'start weight saved when the program started' };
    const pre = addDays(state.setup.programStart, -7);
    const a = weekAverages(state.logs || {}, pre);
    if (a.weighIns >= MIN_WEIGH_INS) return { kg: a.avgWeight, text: '7-day average of ' + formatRange(pre) + ' (' + a.weighIns + ' weigh-ins)' };
    return { kg: numOrNull(state.setup.weightKg), text: 'Setup weight' };
  }

  // A start weight already at or below the goal weight puts the whole program in final maintenance.
  function goalAtStart(state) {
    const start = startWeight(state), goal = calcGoalWeight(state.setup).value;
    const met = allNum(start.kg, goal) && start.kg <= goal;
    return { met: met, text: met ? 'Goal already reached at the start: ' + fmt(start.kg, 2) + ' kg (' + start.text + ') ≤ goal ' +
      fmt(goal, 2) + ' kg, so the program is in final maintenance from week 1.' : null };
  }

  function goalReachedWeek(state) {
    if (goalAtStart(state).met) return state.setup.programStart;
    const checkins = state.checkins || {};
    let best = null;
    Object.keys(checkins).forEach(function (k) {
      if (checkins[k] && checkins[k].goalReached) {
        const w = addDays(k, 7);
        if (best === null || w < best) best = w;
      }
    });
    return best;
  }

  // Why final maintenance started: the goal was met at the start, or at a saved check-in.
  function finalReason(state, grw) {
    const atStart = goalAtStart(state);
    if (atStart.met) return atStart.text;
    const r = (state.checkins || {})[addDays(grw, -7)];
    return 'Goal weight reached at the check-in of ' + formatRange(addDays(grw, -7)) + (r && r.cur && isNum(r.cur.avgWeight)
      ? ' (' + fmt(r.cur.avgWeight, 2) + ' kg ≤ goal ' + fmt(calcGoalWeight(state.setup).value, 2) + ' kg)' : '') +
      ': final maintenance from ' + formatDate(grw) + '.';
  }

  function hasNext(record) { return !!(record && record.next && isNum(record.next.kcal)); }

  // ======================================================================================
  // targets
  // ======================================================================================
  function macroText(m, weightKg) {
    return 'Fat = max(22 % × ' + fmt(m.kcal) + ' kcal / 9, 0.6 g × ' + fmt(weightKg, 1) + ' kg) = max(' +
      fmt(FAT_SHARE * m.kcal / KCAL_F, 1) + ', ' + fmt(FAT_FLOOR_PER_KG * weightKg, 1) + ') = ' + fmt(m.fat, 1) +
      ' g; carbs = (' + fmt(m.kcal) + ' − 4×' + fmt(m.protein, 1) + ' − 9×' + fmt(m.fat, 1) + ') / 4 = ' + fmt(m.carbs, 1) + ' g.';
  }

  // "formula TDEE 2907 kcal (program weeks 1–2)" or "learned TDEE 2850 kcal (<where it comes from>)".
  function tdeeText(useFormula, basis, learnedText) {
    if (useFormula) return 'formula TDEE ' + fmt(basis) + ' kcal (program weeks 1–' + FORMULA_WEEKS + ')';
    return 'learned TDEE ' + fmt(basis) + ' kcal (' + learnedText + ')';
  }

  function macroSummary(t) {
    return fmt(t.kcal) + ' kcal, protein ' + fmt(t.protein, 1) + ' g, carbs ' + fmt(t.carbs, 1) + ' g, fat ' + fmt(t.fat, 1) + ' g';
  }

  function changeText(prev, next) {
    function part(name, a, b) {
      return Math.abs(b - a) < 1e-9 ? name + ' ' + fmt(b, 1) + ' g (unchanged)' : name + ' ' + fmt(a, 1) + ' → ' + fmt(b, 1) + ' g';
    }
    return 'Macros: ' + part('protein', prev.protein, next.protein) + ', ' + part('carbs', prev.carbs, next.carbs) + ', ' +
      part('fat', prev.fat, next.fat) + '.';
  }

  function emptyTargets(weekStart, phase, source, text) {
    return { weekStart: weekStart, kcal: null, protein: null, fat: null, carbs: null, limited: false, phase: phase, source: source,
      tdeeBasis: null, tdeeSource: 'formula', deficit: null, rate: null, weightUsed: null, targetLossKg: 0,
      bmrFloorApplied: false, explanation: [text] };
  }

  // Week 1, computed live from Setup.
  function firstWeekTargets(state, grw) {
    const setup = state.setup, ps = setup.programStart, kg = setup.weightKg;
    const phase = phaseForWeek(ps, ps, grw);
    const tdee = calcFormulaTDEE(setup), bmr = calcBMR(setup), protein = calcProtein(setup);
    if (!allNum(tdee.value, bmr.value, protein.value)) {
      return emptyTargets(ps, phase, 'initial', 'Complete the Setup (weight, height, age) to compute targets.');
    }
    const cut = phase.type === 'cut';
    const rate = cut ? weeklyRate(setup, kg) : null;
    const def = cut ? dailyDeficit(rate, kg) : null;
    const deficit = cut ? def.value : 0;
    const raw = tdee.value - deficit;
    const bmrFloorApplied = raw < bmr.value;
    const m = initialMacros(Math.max(raw, bmr.value), protein.value, kg);
    const explanation = ['Week 1 (' + phase.label + '): formula TDEE ' + fmt(tdee.value) + ' kcal − deficit ' + fmt(deficit) +
      ' kcal = ' + fmt(raw) + ' kcal.', tdee.formula + '.'];
    if (phase.type === 'final') explanation.push(finalReason(state, grw));
    if (cut) explanation.push(rate.reason + '.', def.formula + '.');
    if (bmrFloorApplied) explanation.push('Raised to the BMR floor: ' + fmt(bmr.value) + ' kcal.');
    explanation.push(protein.formula + '.', macroText(m, kg));
    return {
      weekStart: ps, kcal: m.kcal, protein: m.protein, fat: m.fat, carbs: m.carbs, limited: m.limited, phase: phase,
      source: 'initial', tdeeBasis: tdee.value, tdeeSource: 'formula', deficit: deficit, rate: cut ? rate.value : 0,
      weightUsed: kg, targetLossKg: cut ? rate.value * kg : 0, bmrFloorApplied: bmrFloorApplied, explanation: explanation
    };
  }

  // Week 1: the targets fixed by the program snapshot, so Setup edits after the start never rewrite them; live from
  // Setup when there is no snapshot, or when a goal change has since moved week 1 into another phase.
  function weekOneTargets(state, grw) {
    const snap = programSnapshot(state);
    if (!snap) return firstWeekTargets(state, grw);
    const ps = state.setup.programStart;
    const phase = phaseForWeek(ps, ps, grw);
    const w = snap.week1;
    if (w.phaseType !== phase.type) {
      const t = firstWeekTargets(state, grw);
      t.explanation.unshift('The week-1 targets saved at the program start were for another phase; week 1 is now ' + phase.label +
        ', so they are recomputed from Setup.');
      return t;
    }
    return {
      weekStart: ps, kcal: w.kcal, protein: w.protein, fat: w.fat, carbs: w.carbs, limited: !!w.limited, phase: phase,
      source: 'initial', tdeeBasis: numOrNull(w.tdeeBasis), tdeeSource: w.tdeeSource || 'formula', deficit: numOrNull(w.deficit),
      rate: numOrNull(w.rate), weightUsed: numOrNull(w.weightUsed), targetLossKg: isNum(w.targetLossKg) ? w.targetLossKg : 0,
      bmrFloorApplied: !!w.bmrFloorApplied,
      explanation: ['Week-1 targets saved when the program started; Setup edits after the start do not change them.']
        .concat(w.explanation || [])
    };
  }

  // Protein is never reduced below the week-1 target fixed at the program start: the extra protein comes out of carbs,
  // then fat, so calories stay the same.
  function withProteinFloor(state, T) {
    const snap = programSnapshot(state);
    const floor = snap ? snap.week1.protein : null;
    if (!isNum(floor) || !allNum(T.kcal, T.protein, T.carbs, T.fat) || T.protein >= floor) return T;
    const m = applyCalorieChange(T, T.kcal, T.weightUsed, floor);
    return Object.assign({}, T, {
      kcal: m.kcal, protein: m.protein, fat: m.fat, carbs: m.carbs, limited: T.limited || m.limited,
      explanation: T.explanation.concat('Protein raised to the program-start target of ' + fmt(floor, 1) +
        ' g (protein is never reduced). ' + changeText(T, m))
    });
  }

  // Targets saved by the check-in of the week before `weekStart`. The phase is always the live one.
  function checkinTargets(state, weekStart, record, grw) {
    const n = record.next;
    const phase = phaseForWeek(state.setup.programStart, weekStart, grw);
    const cut = phase.type === 'cut';
    return {
      weekStart: weekStart, kcal: n.kcal, protein: n.protein, fat: n.fat, carbs: n.carbs, limited: !!n.limited, phase: phase,
      source: 'checkin', tdeeBasis: numOrNull(n.tdeeBasis), tdeeSource: n.tdeeSource || record.tdeeUsedForNext || 'learned',
      deficit: numOrNull(n.deficit), rate: numOrNull(n.rate), weightUsed: numOrNull(n.weightUsed),
      targetLossKg: cut && allNum(n.rate, n.weightUsed) ? n.rate * n.weightUsed : 0,
      bmrFloorApplied: !!n.bmrFloorApplied,
      explanation: ['Set by the check-in of ' + formatRange(addDays(weekStart, -7)) + '.'].concat(record.notes || [])
    };
  }

  // A week without a check-in behind it: carry the previous week, or move the whole deficit on a phase change.
  function followingWeekTargets(state, prevT, base, weekStart, grw) {
    const setup = state.setup;
    const phase = phaseForWeek(setup.programStart, weekStart, grw);
    const missing = 'No check-in saved for ' + formatRange(addDays(weekStart, -7));
    if (phase.type === prevT.phase.type) {
      return Object.assign({}, prevT, {
        weekStart: weekStart, phase: phase, source: 'carry',
        explanation: [missing + ': targets carried over unchanged from ' + formatRange(base.weekStart) + ' (' + base.phase.label +
          '): ' + macroSummary(prevT) + '.'].concat(base.explanation)
      });
    }
    const useFormula = phase.weekNumber <= FORMULA_WEEKS;
    const formula = calcFormulaTDEE(setup);
    const learned = learnedBasis(state, weekStart);
    const basis = useFormula ? formula.value : learned.value;
    const bmr = calcBMR(setup).value;
    const weight = weightBasis(state, weekStart);
    const weightUsed = weight.kg;
    if (!allNum(basis, bmr, weightUsed, prevT.kcal)) {
      return emptyTargets(weekStart, phase, 'transition', 'Complete the Setup (weight, height, age) to compute targets.');
    }
    const cut = phase.type === 'cut';
    const rate = cut ? weeklyRate(setup, weightUsed) : null;
    const def = cut ? dailyDeficit(rate, weightUsed) : null;
    const deficit = cut ? def.value : 0;
    const raw = basis - deficit;
    const bmrFloorApplied = raw < bmr;
    const m = applyCalorieChange(prevT, Math.max(raw, bmr), weightUsed, calcProtein(setup).value);
    const explanation = [
      'Phase change ' + prevT.phase.label + ' → ' + phase.label + ' (' + missing.charAt(0).toLowerCase() + missing.slice(1) + ').',
      'Target = ' + tdeeText(useFormula, basis, learned.text) + ' − deficit ' + fmt(deficit) + ' kcal = ' + fmt(raw) +
        ' kcal: the whole deficit moves at once (no ±' + WEEKLY_CAP + ' kcal cap).'
    ];
    if (useFormula || learned.week === null) explanation.push(formula.formula + '.');
    if (phase.type === 'final') explanation.push(finalReason(state, grw));
    if (cut) explanation.push('Weight ' + fmt(weightUsed, 2) + ' kg: ' + weight.text + '.', rate.reason + '.', def.formula + '.');
    if (bmrFloorApplied) explanation.push('Raised to the BMR floor: ' + fmt(bmr) + ' kcal.');
    if (m.limited) explanation.push('Carbs are at 0 g and fat at its floor: calories cannot go lower.');
    explanation.push(changeText(prevT, m));
    return {
      weekStart: weekStart, kcal: m.kcal, protein: m.protein, fat: m.fat, carbs: m.carbs, limited: m.limited, phase: phase,
      source: 'transition', tdeeBasis: basis, tdeeSource: useFormula ? 'formula' : 'learned', deficit: deficit,
      rate: cut ? rate.value : 0, weightUsed: weightUsed, targetLossKg: cut ? rate.value * weightUsed : 0,
      bmrFloorApplied: bmrFloorApplied, explanation: explanation
    };
  }

  function targetsForWeek(state, weekStart) {
    const setup = state.setup, ps = setup.programStart;
    const checkins = state.checkins || {};
    const S = weekStartOf(weekStart);
    const grw = goalReachedWeek(state);

    if (programWeekIndex(ps, S) < 0) {
      const w1 = withProteinFloor(state, weekOneTargets(state, grw));
      return Object.assign({}, w1, {
        weekStart: S, phase: phaseForWeek(ps, S, grw), source: 'pre', targetLossKg: 0,
        explanation: ['Program starts ' + formatDate(ps) + ' (dinner): preview of the week-1 targets.'].concat(w1.explanation)
      });
    }

    // Walk back to the anchor week: week 1, or a week whose previous week has a saved check-in.
    let w = S;
    while (programWeekIndex(ps, w) > 0 && !hasNext(checkins[addDays(w, -7)])) w = addDays(w, -7);
    let T = withProteinFloor(state, programWeekIndex(ps, w) === 0 ? Object.assign(weekOneTargets(state, grw), { weekStart: w })
      : checkinTargets(state, w, checkins[addDays(w, -7)], grw));
    // Then walk forward week by week; `base` is the last week whose numbers were actually derived.
    let base = T;
    while (w < S) {
      w = addDays(w, 7);
      T = followingWeekTargets(state, T, base, w, grw);
      if (T.source !== 'carry') base = T;
    }
    return T;
  }

  // What the UI stores in state.program.snapshot once the program has started: the week-1 targets and the start weight,
  // so Setup edits after the start cannot rewrite past weeks or lower protein. Null before the start or while the
  // Setup is incomplete.
  function makeProgramSnapshot(state, todayIso) {
    const ps = state.setup.programStart;
    if (daysBetween(ps, todayIso) < 0) return null;
    const live = Object.assign({}, state, { program: null });
    const t = firstWeekTargets(live, goalReachedWeek(live));
    if (!allNum(t.kcal, t.protein, t.carbs, t.fat)) return null;
    return {
      programStart: ps, takenOn: todayIso, startWeightKg: startWeight(live).kg,
      week1: {
        kcal: t.kcal, protein: t.protein, fat: t.fat, carbs: t.carbs, limited: t.limited, tdeeBasis: t.tdeeBasis,
        tdeeSource: t.tdeeSource, deficit: t.deficit, rate: t.rate, weightUsed: t.weightUsed, targetLossKg: t.targetLossKg,
        bmrFloorApplied: t.bmrFloorApplied, phaseType: t.phase.type, explanation: t.explanation.slice()
      }
    };
  }

  // ======================================================================================
  // weekly check-in
  // ======================================================================================
  function diagnose(cur, setup) {
    // Without logged steps a NEAT drop cannot be judged, so that check is skipped.
    if (isNum(cur.avgSteps) && isNum(setup.steps) && cur.avgSteps < setup.steps * NEAT_RATIO) return 'neat';
    if (cur.intakeDays < MIN_TRACKED_DAYS) return 'tracking';
    return 'adaptation';
  }

  // Both weeks need ≥ 4 weigh-ins and this week ≥ 1 day of logged calories.
  function validWeeks(cur, prev) { return cur.weighIns >= MIN_WEIGH_INS && prev.weighIns >= MIN_WEIGH_INS && cur.intakeDays >= 1; }

  // Below-target status of a week whose check-in was never saved, worked out from its logs with the check-in rules.
  // {belowTarget, source: 'logs', or null when it was no cut week or its logs are too sparse to judge, text (null: nothing to say)}
  function loggedWeekStatus(state, weekStart) {
    const T = targetsForWeek(state, weekStart);
    if (T.phase.type !== 'cut' || !(T.targetLossKg > 0)) return { belowTarget: false, source: null, text: null };
    const logs = state.logs || {};
    const cur = weekAverages(logs, weekStart), prev = weekAverages(logs, addDays(weekStart, -7));
    const head = 'No check-in saved for ' + formatRange(weekStart);
    if (!validWeeks(cur, prev)) return { belowTarget: false, source: null, text: head + ', and its logs are too sparse to judge its loss.' };
    const loss = prev.avgWeight - cur.avgWeight;
    const below = loss < STALL_RATIO * T.targetLossKg;
    return { belowTarget: below, source: 'logs', text: head + '; from its logs it lost ' + fmt(loss, 2) + ' kg vs target ' +
      fmt(T.targetLossKg, 2) + ' kg (' + fmt(loss / T.targetLossKg * 100) + ' %)' + (below ? ', below ' + fmt(STALL_RATIO * 100) +
      ' % of target.' : '.') };
  }

  function computeCheckin(state, weekStart) {
    const setup = state.setup, ps = setup.programStart;
    const S = weekStartOf(weekStart);
    const logs = state.logs || {};
    const all = state.checkins || {};
    // Only earlier check-ins feed this one, so saving the same week again gives the same result.
    const earlier = {};
    Object.keys(all).forEach(function (k) { if (k < S) earlier[k] = all[k]; });
    const st = Object.assign({}, state, { checkins: earlier });
    const notes = [];

    const cur = weekAverages(logs, S);
    const prev = weekAverages(logs, addDays(S, -7));
    const valid = validWeeks(cur, prev);
    const bothAvg = isNum(cur.avgWeight) && isNum(prev.avgWeight);
    const deltaKg = bothAvg ? cur.avgWeight - prev.avgWeight : null;
    const actualLossKg = bothAvg ? prev.avgWeight - cur.avgWeight : null;
    const observedTDEE = valid ? cur.avgKcal - deltaKg * KCAL_PER_KG / 7 : null;
    const formulaTDEE = calcFormulaTDEE(setup).value;
    const learnedPrev = learnedBasis(st, S);
    const learnedBefore = learnedPrev.value;

    if (valid) {
      notes.push('Observed TDEE = ' + fmt(cur.avgKcal) + ' kcal − (' + fmt(deltaKg, 2) + ' kg × ' + KCAL_PER_KG + ' / 7) = ' +
        fmt(observedTDEE) + ' kcal.');
    } else {
      notes.push('Not enough data for an adaptive update (needs ≥ ' + MIN_WEIGH_INS + ' weigh-ins in both weeks and ≥ 1 day of ' +
        'logged calories). Weigh-ins: previous week ' + prev.weighIns + ', this week ' + cur.weighIns + '; days with calories: ' +
        cur.intakeDays + '.');
    }

    const thisT = targetsForWeek(st, S);
    const isCut = thisT.phase.type === 'cut';
    const targetLossKg = thisT.targetLossKg;
    const lossRatio = valid && isCut && targetLossKg > 0 ? actualLossKg / targetLossKg : null;
    const belowTarget = isCut && valid && actualLossKg < STALL_RATIO * targetLossKg;
    // Last week's status comes from its saved check-in, else from its logs, so one missed check-in cannot hide a stall.
    const prevRecord = all[addDays(S, -7)];
    const prevStatus = prevRecord ? { belowTarget: prevRecord.belowTarget === true, source: 'checkin' }
      : loggedWeekStatus(st, addDays(S, -7));
    const stall = belowTarget && prevStatus.belowTarget;
    const diagnosis = stall ? diagnose(cur, setup) : null;
    const applied = valid && diagnosis !== 'neat' && diagnosis !== 'tracking';
    const learnedAfter = applied && isNum(learnedBefore) ? LEARN_PREV * learnedBefore + LEARN_OBSERVED * observedTDEE : learnedBefore;

    if (lossRatio !== null) {
      notes.push('Lost ' + fmt(actualLossKg, 2) + ' kg vs target ' + fmt(targetLossKg, 2) + ' kg (' + fmt(lossRatio * 100) + ' %).');
    }
    if (belowTarget && prevStatus.text) notes.push(prevStatus.text);
    if (stall) notes.push('Stall: below ' + fmt(STALL_RATIO * 100) + ' % of target two weeks in a row. ' + DIAGNOSIS_TEXT[diagnosis] + '.');
    else if (belowTarget) notes.push('Below ' + fmt(STALL_RATIO * 100) + ' % of target this week; a stall needs two weeks in a row.');
    notes.push(applied && isNum(learnedBefore)
      ? 'Learned TDEE = 0.7 × ' + fmt(learnedBefore) + ' + 0.3 × ' + fmt(observedTDEE) + ' = ' + fmt(learnedAfter) + ' kcal.'
      : 'Learned TDEE held at ' + fmt(learnedBefore) + ' kcal.');

    const goalWeight = calcGoalWeight(setup).value;
    const goalReached = valid && isNum(goalWeight) && cur.avgWeight <= goalWeight;
    const nextWeek = addDays(S, 7);
    const grwBefore = goalReachedWeek(st);
    const grw = goalReached && (grwBefore === null || nextWeek < grwBefore) ? nextWeek : grwBefore;
    const nextPhase = phaseForWeek(ps, nextWeek, grw);
    if (goalReached) {
      notes.push('Goal weight reached (' + fmt(cur.avgWeight, 2) + ' kg ≤ ' + fmt(goalWeight, 2) + ' kg): final maintenance from ' +
        formatDate(nextWeek) + '.');
    }

    const nextWeekNumber = programWeekIndex(ps, nextWeek) + 1;
    const tdeeUsedForNext = nextWeekNumber <= FORMULA_WEEKS ? 'formula' : 'learned';
    const basis = tdeeUsedForNext === 'formula' ? formulaTDEE : learnedAfter;
    const weightSrc = valid ? { kg: cur.avgWeight, text: '7-day average of ' + formatRange(S) + ' (' + cur.weighIns + ' weigh-ins)' }
      : weightBasis(st, S);
    const weightNow = weightSrc.kg;
    const nextCut = nextPhase.type === 'cut';
    const transition = nextPhase.type !== thisT.phase.type;
    const unchanged = !applied && !transition;
    const bmr = calcBMR(setup).value;

    const record = {
      weekStart: S, computedOn: null, // the caller stamps the date it saves the record
      valid: valid, cur: cur, prev: prev, deltaKg: deltaKg, observedTDEE: observedTDEE,
      learnedBefore: learnedBefore, learnedAfter: learnedAfter, formulaTDEE: formulaTDEE, tdeeUsedForNext: tdeeUsedForNext,
      targetLossKg: targetLossKg, actualLossKg: actualLossKg, lossRatio: lossRatio, belowTarget: belowTarget,
      prevBelowTarget: prevStatus.belowTarget, prevBelowTargetSource: prevStatus.source, stall: stall,
      diagnosis: diagnosis, diagnosisText: diagnosis ? DIAGNOSIS_TEXT[diagnosis] : null, applied: applied,
      goalReached: goalReached, capped: false, transition: transition, next: null, notes: notes
    };

    if (!allNum(thisT.kcal, bmr, basis, weightNow)) {
      notes.push('Complete the Setup (weight, height, age) to compute targets.');
      record.next = { kcal: null, protein: null, fat: null, carbs: null, limited: false, phase: nextPhase, tdeeBasis: null,
        tdeeSource: tdeeUsedForNext, deficit: null, rate: null, weightUsed: null, targetLossKg: 0, bmrFloorApplied: false };
      return record;
    }

    const rate = nextCut ? weeklyRate(setup, weightNow) : null;
    const deficitNext = nextCut ? dailyDeficit(rate, weightNow).value : 0;
    const raw = basis - deficitNext;
    let kcal;
    const derivation = tdeeText(tdeeUsedForNext === 'formula', basis, applied ? 'updated by this check-in' : learnedPrev.text) +
      ' − deficit ' + fmt(deficitNext) + ' kcal = ' + fmt(raw) + ' kcal';
    if (unchanged) {
      kcal = thisT.kcal;
      notes.push(diagnosis === 'neat' ? 'Targets unchanged: restore the steps before cutting food.'
        : diagnosis === 'tracking' ? 'Targets unchanged until tracking is complete (fewer than ' + MIN_TRACKED_DAYS + ' days logged).'
          : 'Targets unchanged (not enough data).');
    } else if (transition) {
      kcal = raw;
      notes.push('Phase change ' + thisT.phase.label + ' → ' + nextPhase.label + ': ' + derivation +
        ' (the whole deficit moves at once, no ±' + WEEKLY_CAP + ' kcal cap).');
      if (nextCut) notes.push('Weight ' + fmt(weightNow, 2) + ' kg: ' + weightSrc.text + '. ' + rate.reason + '.');
    } else {
      kcal = Math.min(Math.max(raw, thisT.kcal - WEEKLY_CAP), thisT.kcal + WEEKLY_CAP);
      record.capped = kcal !== raw;
      notes.push('Next week: ' + derivation + (record.capped ? ', capped at ' + fmt(kcal) + ' kcal (±' + WEEKLY_CAP +
        ' kcal per week inside a phase)' : '') + '.');
    }
    const bmrFloorApplied = kcal < bmr;
    if (bmrFloorApplied) notes.push('Raised to the BMR floor: ' + fmt(bmr) + ' kcal.');
    kcal = Math.max(kcal, bmr);

    const weightUsed = unchanged ? thisT.weightUsed : weightNow;
    const m = applyCalorieChange(thisT, kcal, weightUsed, calcProtein(setup).value);
    if (m.limited) notes.push('Carbs are at 0 g and fat at its floor: calories cannot go lower.');
    if (!unchanged) notes.push(changeText(thisT, m));
    const nextRate = unchanged ? thisT.rate : (nextCut ? rate.value : 0);
    record.next = {
      kcal: m.kcal, protein: m.protein, fat: m.fat, carbs: m.carbs, limited: m.limited, phase: nextPhase,
      tdeeBasis: unchanged ? thisT.tdeeBasis : basis,
      tdeeSource: unchanged ? thisT.tdeeSource : tdeeUsedForNext,
      deficit: unchanged ? thisT.deficit : deficitNext,
      rate: nextRate, weightUsed: weightUsed,
      targetLossKg: nextCut && allNum(nextRate, weightUsed) ? nextRate * weightUsed : 0,
      bmrFloorApplied: bmrFloorApplied
    };
    return record;
  }

  // ======================================================================================
  // projections
  // ======================================================================================
  // One planned cut week (or a fraction of one): lose the weekly rate for the current weight, never below the goal.
  function cutStep(setup, kg, goal, fraction) {
    if (isNum(goal) && kg <= goal) return kg;
    const next = kg * (1 - weeklyRate(setup, kg).value * fraction);
    return isNum(goal) ? Math.max(goal, next) : next;
  }

  function projectBlockEnd(state, todayIso) {
    const setup = state.setup, ps = setup.programStart;
    const ws = weekStartOf(todayIso);
    const grw = goalReachedWeek(state);
    const phase = phaseForWeek(ps, ws, grw);
    const pre = phase.type === 'pre';
    // Before the start, project the first block, counting from the program start.
    const block = pre ? phaseForWeek(ps, ps, grw) : phase;
    const trail = trailingAverage(state.logs || {}, todayIso, 7);
    const from = trail.count >= TRAILING_MIN_WEIGH_INS ? { kg: trail.avg,
      text: '7-day average of ' + trail.count + ' weigh-ins, ' + formatDate(addDays(todayIso, -6)) + ' – ' + formatDate(todayIso) }
      : weightBasis(state, addDays(ws, 7));
    const fromWeight = from.kg;
    if (!isNum(fromWeight)) return { weightKg: null, fromWeight: null, weeks: 0, blockEnd: block.blockEnd, explanation: ['No weight known yet.'] };

    const explanation = [];
    if (pre) explanation.push('Program starts ' + formatDate(ps) + ' (dinner): ' + block.label + ' is projected from the start.');
    explanation.push('Start: ' + fmt(fromWeight, 2) + ' kg (' + from.text + ').');
    if (!block.blockEnd) {
      explanation.push(finalReason(state, grw), 'Final maintenance: weight held at ' + fmt(fromWeight, 2) + ' kg.');
      return { weightKg: fromWeight, fromWeight: fromWeight, weeks: 0, blockEnd: null, explanation: explanation };
    }
    // The block ends at Friday dinner, so its full effect shows on the next morning's weigh-in (Saturday):
    // a whole 8-week cut counts as 8 weeks of loss.
    const weeks = Math.max(0, daysBetween(pre ? ps : todayIso, addDays(block.blockEnd, 1)) / 7);
    let kg = fromWeight;
    if (block.type === 'cut') {
      const goal = calcGoalWeight(setup).value, thr = calcThresholdWeight(setup).value;
      const whole = Math.floor(weeks), part = weeks - whole;
      const path = [kg];
      for (let i = 0; i < whole; i++) path.push(kg = cutStep(setup, kg, goal, 1));
      if (part > 0) path.push(kg = cutStep(setup, kg, goal, part));
      explanation.push(block.label + ': ' + fmt(weeks, 1) + ' weeks to ' + formatDate(block.blockEnd) + ' (dinner). Each week loses ' +
        (isNum(thr) ? ratePct(RATE_FAST) + ' % of the weight while above the 15 % body-fat weight (' + fmt(thr, 2) + ' kg), ' +
          ratePct(RATE_SLOW) + ' % at or below it' : ratePct(RATE_FAST) + ' % of the weight (15 % body-fat weight unknown)') +
        (isNum(goal) ? ', never going below the goal (' + fmt(goal, 2) + ' kg)' : '') +
        (part > 0 ? '; the last ' + fmt(part, 2) + ' of a week counts in part' : '') + '.');
      explanation.push('Week by week: ' + path.map(function (x) { return fmt(x, 2); }).join(' → ') + ' kg.');
      if (isNum(goal) && fromWeight <= goal) {
        explanation.push('Already at or below the goal: final maintenance starts once a saved check-in confirms it.');
      }
    } else {
      explanation.push(block.label + ': maintenance, weight held at ' + fmt(kg, 2) + ' kg for ' + fmt(weeks, 1) + ' weeks until ' +
        formatDate(block.blockEnd) + ' (dinner).');
    }
    return { weightKg: kg, fromWeight: fromWeight, weeks: weeks, blockEnd: block.blockEnd, explanation: explanation };
  }

  function targetLine(state, fromIso, toIso) {
    const setup = state.setup, ps = setup.programStart;
    const start = startWeight(state).kg;
    const first = fromIso > ps ? fromIso : ps; // the planned path starts at the program start
    if (!isNum(start) || first > toIso) return [];
    const goal = calcGoalWeight(setup).value;
    const grw = goalReachedWeek(state);
    // Weight on the Saturday that starts each program week.
    const weekKg = [start];
    const lastIndex = programWeekIndex(ps, toIso);
    for (let k = 0; k <= lastIndex; k++) {
      const type = phaseForWeek(ps, addDays(ps, 7 * k), grw).type;
      weekKg.push(type === 'cut' ? cutStep(setup, weekKg[k], goal, 1) : weekKg[k]);
    }
    const out = [];
    for (let d = first; d <= toIso; d = addDays(d, 1)) {
      const off = daysBetween(ps, d), k = Math.floor(off / 7);
      out.push({ date: d, kg: weekKg[k] + (weekKg[k + 1] - weekKg[k]) * (off % 7) / 7 });
    }
    return out;
  }

  function programSummary(state, todayIso) {
    const setup = state.setup, ps = setup.programStart;
    const checkins = state.checkins || {};
    const weekStart = weekStartOf(todayIso);
    const grw = goalReachedWeek(state);
    const phase = phaseForWeek(ps, weekStart, grw);
    const goal = calcGoalWeight(setup);

    const explanation = [phase.type === 'pre' ? 'Program starts ' + formatDate(ps) + ' (dinner), in ' + daysBetween(todayIso, ps) + ' days.'
      : 'Program week ' + phase.weekNumber + ', counted in diet weeks (Saturday dinner → Friday dinner) from ' + formatDate(ps) + '.'];
    if (phase.blockEnd) {
      explanation.push(phase.label + ': week ' + phase.weekInBlock + ' of ' + phase.blockLength + ', ' + formatDate(phase.blockStart) +
        ' – ' + formatDate(phase.blockEnd) + ' (dinner). Blocks repeat an ' + CUT_WEEKS + '-week cut and a ' + BREAK_WEEKS +
        '-week maintenance break until the goal is reached.');
    }
    if (grw && daysBetween(grw, phase.type === 'pre' ? ps : weekStart) >= 0) explanation.push(finalReason(state, grw));
    explanation.push(goal.formula + '.');

    // Check-ins run on the Friday of each program week; the first one is the Friday of week 1.
    let nextCheckinDate = addDays(weekStart, 6);
    if (nextCheckinDate < addDays(ps, 6)) nextCheckinDate = addDays(ps, 6);
    if (checkins[weekStartOf(nextCheckinDate)]) nextCheckinDate = addDays(nextCheckinDate, 7);

    // Due: today's check-in on a Friday, else last week's when it was never saved.
    const lastWeek = addDays(weekStart, -7);
    let checkinDue = null;
    if (dayOfWeek(todayIso) === 5 && weekStart >= ps && !checkins[weekStart]) checkinDue = { weekStart: weekStart, date: todayIso };
    else if (lastWeek >= ps && !checkins[lastWeek]) checkinDue = { weekStart: lastWeek, date: addDays(lastWeek, 6) };

    return {
      weekStart: weekStart, phase: phase, targets: targetsForWeek(state, weekStart), blockEnd: phase.blockEnd,
      projection: projectBlockEnd(state, todayIso), nextCheckinDate: nextCheckinDate, checkinDue: checkinDue,
      goalWeight: goal.value, explanation: explanation
    };
  }

  const api = {
    // dates
    parseISO: parseISO, toISO: toISO, addDays: addDays, dayOfWeek: dayOfWeek, daysBetween: daysBetween,
    weekStartOf: weekStartOf, weekDays: weekDays, nextSaturdayOnOrAfter: nextSaturdayOnOrAfter,
    formatDate: formatDate, formatRange: formatRange,
    // calculations
    calcBMR: calcBMR, calcExercise: calcExercise, calcFormulaTDEE: calcFormulaTDEE, calcLeanMass: calcLeanMass,
    calcProtein: calcProtein, calcFatFloor: calcFatFloor, calcGoalWeight: calcGoalWeight,
    calcThresholdWeight: calcThresholdWeight, weeklyRate: weeklyRate, dailyDeficit: dailyDeficit,
    // macros
    initialMacros: initialMacros, applyCalorieChange: applyCalorieChange,
    // phases
    programWeekIndex: programWeekIndex, phaseForWeek: phaseForWeek,
    // logs
    weekAverages: weekAverages, trailingAverage: trailingAverage,
    // targets and check-in
    targetsForWeek: targetsForWeek, makeProgramSnapshot: makeProgramSnapshot, latestLearned: latestLearned,
    latestWeight: latestWeight, goalReachedWeek: goalReachedWeek, computeCheckin: computeCheckin,
    // projections
    projectBlockEnd: projectBlockEnd, targetLine: targetLine, programSummary: programSummary
  };

  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.FL = root.FL || {}; root.FL.engine = api; }
})(typeof window !== 'undefined' ? window : globalThis);
