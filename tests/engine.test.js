'use strict';
// Unit tests for app/js/engine.js (SPEC §4). Run: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ENGINE_PATH = path.join(__dirname, '..', 'app', 'js', 'engine.js');
const E = require(ENGINE_PATH);

// ---------- fixtures ----------
const PS = '2026-09-26'; // program start, a Saturday
const KCAL_DAY = 7700 / 7; // 1100 kcal/day per kg/week
/** Saturday that starts program week k (1-based); W(0) is the week before the start. */
function W(k) { return E.addDays(PS, 7 * (k - 1)); }

function defaultSetup(over) {
  return Object.assign({
    isExample: true, weightKg: 85, heightCm: 180, age: 35, bodyFatPct: 20,
    goalType: 'bf', goalBodyFatPct: 12, goalWeightKg: null,
    steps: 8000, liftDays: [1, 3, 5], padelDays: [2, 6], liftMinutes: 60, padelMinutes: 90,
    mealsPerDay: 4, saturdayMode: 'offplan', programStart: PS,
    likedFoods: [], excludedFoods: [], customFoods: []
  }, over || {});
}
function makeState(setupOver, logs, checkins) {
  return { version: 1, setup: defaultSetup(setupOver), logs: logs || {}, checkins: checkins || {}, plan: null, products: [] };
}
/** Fill one diet week of logs. Each field is a number (all 7 days) or an array of 7 (null = not logged). */
function setWeek(logs, weekStart, fields) {
  E.weekDays(weekStart).forEach(function (d, i) {
    const e = logs[d] || {};
    Object.keys(fields).forEach(function (k) {
      const v = Array.isArray(fields[k]) ? fields[k][i] : fields[k];
      e[k] = v === undefined ? null : v;
    });
    logs[d] = e;
  });
  return logs;
}
function close(actual, expected, eps, msg) {
  const tol = eps === undefined ? 1e-6 : eps;
  assert.ok(typeof actual === 'number' && Math.abs(actual - expected) <= tol,
    (msg ? msg + ': ' : '') + 'expected ' + expected + ' ± ' + tol + ', got ' + actual);
}
function macroKcal(t) { return 4 * t.protein + 4 * t.carbs + 9 * t.fat; }
function save(state, record) { state.checkins[record.weekStart] = record; return record; }

// Worked example (SPEC §3 default setup)
const FORMULA_TDEE = 1805 * 1.2 + 8000 * 0.0005 * 85 + 2805 / 7; // 2906.714...
const PROTEIN = 2.7 * 68;                                          // 183.6
const WEEK1_KCAL = FORMULA_TDEE - 935;                              // 1971.714...
const WEEK1_CARBS = (WEEK1_KCAL - 4 * PROTEIN - 9 * 51) / 4;         // 194.578...

// =====================================================================================
// module pattern and purity
// =====================================================================================
test('module: exports in Node and registers window.FL.engine in a browser-like context', function () {
  assert.equal(typeof E.targetsForWeek, 'function');
  const src = fs.readFileSync(ENGINE_PATH, 'utf8');
  const win = {};
  vm.runInNewContext(src, { window: win });
  assert.equal(typeof win.FL.engine.computeCheckin, 'function');
  assert.equal(win.FL.engine.weekStartOf('2026-10-01'), PS);
});

test('module: no clock or randomness in the source', function () {
  const src = fs.readFileSync(ENGINE_PATH, 'utf8');
  assert.ok(!/Math\.random/.test(src), 'Math.random');
  assert.ok(!/Date\.now/.test(src), 'Date.now');
  assert.ok(!/new Date\(\s*\)/.test(src), 'argless new Date()');
});

// =====================================================================================
// dates
// =====================================================================================
test('dates: parse/format round trip, addDays across month, year and leap day', function () {
  assert.equal(E.parseISO('2026-09-26'), Date.UTC(2026, 8, 26));
  assert.equal(E.toISO(Date.UTC(2026, 8, 26)), '2026-09-26');
  assert.equal(E.addDays('2026-09-30', 1), '2026-10-01');
  assert.equal(E.addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(E.addDays('2028-02-28', 1), '2028-02-29');
  assert.equal(E.addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(E.daysBetween('2026-09-26', '2026-10-03'), 7);
  assert.equal(E.daysBetween('2026-10-03', '2026-09-26'), -7);
  // Across the European DST change (25 Oct 2026) days stay whole.
  assert.equal(E.daysBetween('2026-10-24', '2026-10-26'), 2);
  assert.throws(function () { E.parseISO('26/09/2026'); });
});

test('dates: dayOfWeek, weekStartOf for every weekday, weekDays, nextSaturdayOnOrAfter', function () {
  assert.equal(E.dayOfWeek('2026-09-26'), 6);
  assert.equal(E.dayOfWeek('2026-09-27'), 0);
  assert.equal(E.dayOfWeek('2026-10-02'), 5);
  // Sat 26 Sep .. Fri 2 Oct all belong to the week of Sat 26 Sep.
  const days = ['2026-09-26', '2026-09-27', '2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02'];
  days.forEach(function (d, i) {
    assert.equal(E.dayOfWeek(d), (6 + i) % 7);
    assert.equal(E.weekStartOf(d), PS, d);
  });
  assert.equal(E.weekStartOf('2026-10-03'), '2026-10-03', 'Saturday maps to itself');
  assert.equal(E.weekStartOf('2026-09-25'), '2026-09-19', 'Friday maps to the previous Saturday');
  assert.equal(E.weekStartOf('2027-01-01'), '2026-12-26', 'across the year boundary');
  assert.deepEqual(E.weekDays(PS), days);
  assert.equal(E.nextSaturdayOnOrAfter('2026-09-26'), '2026-09-26');
  assert.equal(E.nextSaturdayOnOrAfter('2026-09-27'), '2026-10-03');
  assert.equal(E.nextSaturdayOnOrAfter('2026-10-02'), '2026-10-03');
});

test('dates: formatDate and formatRange', function () {
  assert.equal(E.formatDate('2026-09-26'), 'Sat 26 Sep');
  assert.equal(E.formatDate('2026-10-02'), 'Fri 2 Oct');
  assert.equal(E.formatRange(PS), 'Sat 26 Sep – Fri 2 Oct');
  assert.equal(E.formatRange('2026-12-26'), 'Sat 26 Dec – Fri 1 Jan');
});

// =====================================================================================
// calculations: worked example
// =====================================================================================
test('calc: BMR, exercise and formula TDEE (worked example)', function () {
  const s = defaultSetup();
  const bmr = E.calcBMR(s);
  assert.equal(bmr.value, 1805);
  assert.equal(bmr.formula, 'BMR = 10×85 kg + 6.25×180 cm − 5×35 y + 5 = 1805 kcal');
  assert.deepEqual(bmr.inputs, { weightKg: 85, heightCm: 180, age: 35 });

  const ex = E.calcExercise(s);
  assert.equal(ex.liftSessions, 3);
  assert.equal(ex.padelSessions, 2);
  close(ex.liftWeek, 1275);
  close(ex.padelWeek, 1530);
  close(ex.weekKcal, 2805);
  close(ex.value, 2805 / 7);
  assert.match(ex.formula, /Lifting 3 × MET 5 × 85 kg × 1 h = 1275 kcal\/week/);
  assert.match(ex.formula, /padel 2 × MET 6 × 85 kg × 1\.5 h = 1530 kcal\/week/);
  assert.match(ex.formula, /= 401 kcal\/day$/);

  const tdee = E.calcFormulaTDEE(s);
  close(tdee.parts.base, 2166);
  close(tdee.parts.steps, 340);
  close(tdee.parts.exercise, 400.7142857, 1e-6);
  close(tdee.value, 2906.7142857, 1e-6);
  assert.match(tdee.formula, /= 2166 \+ 340 \+ 401 = 2907 kcal$/);
});

test('calc: lean mass, protein, fat floor, goal and 15 % threshold (worked example)', function () {
  const s = defaultSetup();
  close(E.calcLeanMass(s).value, 68);
  const p = E.calcProtein(s);
  close(p.value, 183.6);
  assert.equal(p.basis, 'leanMass');
  assert.equal(p.formula, 'Protein = 2.7 g × 68 kg lean mass = 183.6 g');
  const ff = E.calcFatFloor(85);
  close(ff.value, 51);
  assert.equal(ff.formula, 'Fat floor = 0.6 g × 85 kg = 51 g');
  const g = E.calcGoalWeight(s);
  close(g.value, 68 / 0.88);
  close(g.value, 77.27, 0.005);
  assert.equal(g.estimated, false);
  assert.match(g.formula, /= 77\.27 kg$/);
  close(E.calcThresholdWeight(s).value, 80);
});

test('calc: weekly rate switches at the 15 % body-fat weight; daily deficit', function () {
  const s = defaultSetup();
  const r = E.weeklyRate(s, 85);
  assert.equal(r.value, 0.01);
  assert.match(r.reason, /above the 15 % body-fat weight \(80 kg\): 1\.0 %\/week/);
  assert.equal(E.weeklyRate(s, 80.01).value, 0.01);
  assert.equal(E.weeklyRate(s, 80).value, 0.0075, 'at the threshold the slower rate applies');
  assert.equal(E.weeklyRate(s, 78).value, 0.0075);

  const d = E.dailyDeficit(0.01, 85);
  close(d.value, 935);
  close(d.weeklyLossKg, 0.85);
  assert.equal(d.formula, 'Deficit = 1.0 % × 85 kg × 7700 kcal / 7 = 935 kcal/day (0.85 kg/week)');
  close(E.dailyDeficit(0.0075, 80).value, 660);
  close(E.dailyDeficit(E.weeklyRate(s, 85), 85).value, 935, 1e-9, 'accepts a weeklyRate() result');
});

test('calc: without body-fat % protein uses 2.2 g/kg and Deurenberg only feeds goal and threshold', function () {
  const s = defaultSetup({ bodyFatPct: null });
  assert.equal(E.calcLeanMass(s).value, null);
  const p = E.calcProtein(s);
  close(p.value, 187);
  assert.equal(p.basis, 'bodyweight');

  const bmi = 85 / (1.8 * 1.8);
  const bf = 1.2 * bmi + 0.23 * 35 - 16.2;
  const lbm = 85 * (1 - bf / 100);
  const g = E.calcGoalWeight(s);
  close(g.value, lbm / 0.88);
  assert.equal(g.estimated, true);
  assert.match(g.formula, /Deurenberg/);
  const thr = E.calcThresholdWeight(s);
  close(thr.value, lbm / 0.85);
  assert.equal(thr.estimated, true);
  assert.equal(E.weeklyRate(s, lbm / 0.85 + 0.1).value, 0.01);
  assert.equal(E.weeklyRate(s, lbm / 0.85 - 0.1).value, 0.0075);
  const t = E.targetsForWeek(makeState({ bodyFatPct: null }), PS);
  close(t.protein, 187);
  close(t.kcal, WEEK1_KCAL, 1e-9, 'rate still 1 %/week: 85 kg is above the estimated 15 % weight');
});

test('calc: goal type "weight" uses the goal weight directly; missing inputs give null values', function () {
  const g = E.calcGoalWeight(defaultSetup({ goalType: 'weight', goalWeightKg: 78 }));
  assert.equal(g.value, 78);
  assert.equal(g.estimated, false);
  assert.equal(E.calcBMR(defaultSetup({ age: null })).value, null);
  assert.equal(E.calcFormulaTDEE(defaultSetup({ heightCm: null })).value, null);
  const t = E.targetsForWeek(makeState({ weightKg: null }), PS);
  assert.equal(t.kcal, null);
});

// =====================================================================================
// macros
// =====================================================================================
test('macros: initialMacros applies the 22 % fat share or the fat floor, carbs take the rest', function () {
  const m = E.initialMacros(WEEK1_KCAL, PROTEIN, 85);
  close(m.fat, 51, 1e-9, 'floor wins over 22 % = 48.2 g');
  close(0.22 * WEEK1_KCAL / 9, 48.2, 0.01);
  close(m.carbs, WEEK1_CARBS);
  close(m.carbs, 194.58, 0.005);
  close(m.kcal, WEEK1_KCAL);
  const high = E.initialMacros(3000, 180, 85);
  close(high.fat, 0.22 * 3000 / 9, 1e-9, '22 % wins');
  close(high.carbs, (3000 - 720 - 9 * high.fat) / 4);
});

test('macros: applyCalorieChange increase goes to carbs only', function () {
  const prev = E.initialMacros(WEEK1_KCAL, PROTEIN, 85);
  const up = E.applyCalorieChange(prev, WEEK1_KCAL + 935, 85, PROTEIN);
  close(up.carbs, prev.carbs + 935 / 4);
  close(up.protein, prev.protein);
  close(up.fat, prev.fat);
  close(up.kcal, WEEK1_KCAL + 935);
  assert.equal(up.limited, false);
});

test('macros: applyCalorieChange decrease takes carbs first, then fat down to the floor, then reports limited', function () {
  const prev = { kcal: 4 * 180 + 4 * 50 + 9 * 80, protein: 180, carbs: 50, fat: 80 }; // 1640 kcal
  const small = E.applyCalorieChange(prev, 1540, 85, 180);
  close(small.carbs, 25);
  close(small.fat, 80);
  const intoFat = E.applyCalorieChange(prev, 1300, 85, 180);
  close(intoFat.carbs, 0);
  close(intoFat.fat, 80 - 140 / 9);
  close(intoFat.kcal, 1300);
  assert.equal(intoFat.limited, false);
  const limited = E.applyCalorieChange(prev, 1000, 85, 180);
  close(limited.carbs, 0);
  close(limited.fat, 51, 1e-9, 'fat stops at 0.6 g/kg');
  assert.equal(limited.limited, true);
  close(limited.kcal, 720 + 459, 1e-9, 'kcal ends higher than requested');
});

test('macros: applyCalorieChange never reduces protein and always recomputes kcal', function () {
  const prev = { kcal: 9999, protein: 180, carbs: 200, fat: 60 }; // stale kcal field
  const lower = E.applyCalorieChange(prev, 2000, 85, 150);
  assert.equal(lower.protein, 180);
  close(lower.kcal, 4 * lower.protein + 4 * lower.carbs + 9 * lower.fat);
  close(lower.kcal, 2000);
  const higher = E.applyCalorieChange(prev, 2000, 85, 200);
  assert.equal(higher.protein, 200);
  close(higher.kcal, 2000, 1e-9, 'the carbs absorb the extra protein');
  close(higher.fat, 60);
});

// =====================================================================================
// phases
// =====================================================================================
test('phases: program weeks 1..25 follow cut 8 / break 2 cycles; block ends on Fridays', function () {
  const expected = [];
  for (let wk = 1; wk <= 25; wk++) {
    const pos = (wk - 1) % 10, cycle = Math.floor((wk - 1) / 10) + 1;
    expected.push(pos < 8
      ? { type: 'cut', label: 'Cut ' + cycle, weekInBlock: pos + 1, blockLength: 8, blockNumber: cycle }
      : { type: 'break', label: 'Maintenance break ' + cycle, weekInBlock: pos - 7, blockLength: 2, blockNumber: cycle });
  }
  expected.forEach(function (e, i) {
    const ph = E.phaseForWeek(PS, W(i + 1), null);
    assert.equal(ph.type, e.type, 'week ' + (i + 1));
    assert.equal(ph.label, e.label, 'week ' + (i + 1));
    assert.equal(ph.weekNumber, i + 1);
    assert.equal(ph.weekInBlock, e.weekInBlock, 'week ' + (i + 1));
    assert.equal(ph.blockLength, e.blockLength);
    assert.equal(ph.blockNumber, e.blockNumber);
    assert.equal(E.dayOfWeek(ph.blockStart), 6);
    assert.equal(E.dayOfWeek(ph.blockEnd), 5);
  });
  const c1 = E.phaseForWeek(PS, W(3), null);
  assert.equal(c1.blockStart, '2026-09-26');
  assert.equal(c1.blockEnd, '2026-11-20');
  const b1 = E.phaseForWeek(PS, W(10), null);
  assert.equal(b1.blockStart, '2026-11-21');
  assert.equal(b1.blockEnd, '2026-12-04');
  const c2 = E.phaseForWeek(PS, W(11), null);
  assert.equal(c2.blockStart, '2026-12-05');
  assert.equal(c2.blockEnd, '2027-01-29');
  assert.equal(E.phaseForWeek(PS, W(20), null).blockEnd, '2027-02-12');
  assert.equal(E.phaseForWeek(PS, W(25), null).blockStart, '2027-02-13');
});

test('phases: programWeekIndex, pre-start and final maintenance', function () {
  assert.equal(E.programWeekIndex(PS, PS), 0);
  assert.equal(E.programWeekIndex(PS, W(0)), -1);
  assert.equal(E.programWeekIndex(PS, E.addDays(PS, 69)), 9);
  const pre = E.phaseForWeek(PS, W(0), null);
  assert.equal(pre.type, 'pre');
  assert.equal(pre.label, 'Not started');

  const grw = W(12);
  assert.equal(E.phaseForWeek(PS, W(11), grw).type, 'cut', 'the week before stays a cut');
  const f1 = E.phaseForWeek(PS, W(12), grw);
  assert.equal(f1.type, 'final');
  assert.equal(f1.label, 'Final maintenance');
  assert.equal(f1.weekInBlock, 1);
  assert.equal(f1.blockLength, null);
  assert.equal(f1.blockEnd, null);
  assert.equal(f1.blockStart, grw);
  const f4 = E.phaseForWeek(PS, W(15), grw);
  assert.equal(f4.type, 'final');
  assert.equal(f4.weekInBlock, 4, 'counts up');
  assert.equal(f4.weekNumber, 15);
});

// =====================================================================================
// logs
// =====================================================================================
test('logs: weekAverages averages each field over the days that have it', function () {
  const logs = {};
  logs['2026-09-26'] = { weight: 85.0, kcal: 2000, protein: 180, steps: 8000 };
  logs['2026-09-27'] = { weight: 84.6, kcal: null, protein: null, steps: 10000 };
  logs['2026-09-29'] = { weight: null, kcal: 2200, protein: 190, steps: null };
  logs['2026-09-30'] = { weight: null, kcal: null, protein: null, steps: null };
  logs['2026-10-02'] = { weight: 84.2 };
  logs['2026-10-03'] = { weight: 50 }; // next week: ignored
  const a = E.weekAverages(logs, PS);
  close(a.avgWeight, (85 + 84.6 + 84.2) / 3);
  assert.equal(a.weighIns, 3);
  close(a.avgKcal, 2100);
  assert.equal(a.intakeDays, 2);
  close(a.avgProtein, 185);
  assert.equal(a.proteinDays, 2);
  close(a.avgSteps, 9000);
  assert.equal(a.stepDays, 2);
  assert.equal(a.days.length, 7);
  assert.equal(a.days[0].date, PS);
  assert.deepEqual(a.days[2], { date: '2026-09-28', weight: null, kcal: null, protein: null, steps: null });

  const empty = E.weekAverages({}, PS);
  assert.equal(empty.avgWeight, null);
  assert.equal(empty.weighIns, 0);
  assert.equal(empty.avgSteps, null);
});

test('logs: trailingAverage covers the n days ending on the date', function () {
  const logs = { '2026-09-20': { weight: 90 }, '2026-09-21': { weight: 86 }, '2026-09-26': { weight: 84 }, '2026-09-27': { weight: 85 } };
  const t = E.trailingAverage(logs, '2026-09-27');
  assert.equal(t.count, 3);
  close(t.avg, 85);
  const t3 = E.trailingAverage(logs, '2026-09-27', 3);
  assert.equal(t3.count, 2);
  close(t3.avg, 84.5);
  assert.deepEqual(E.trailingAverage({}, '2026-09-27'), { avg: null, count: 0 });
});

// =====================================================================================
// targets without check-ins
// =====================================================================================
test('targets: week 1 is computed live from Setup (worked example); pre weeks preview it', function () {
  const state = makeState();
  const t = E.targetsForWeek(state, PS);
  assert.equal(t.source, 'initial');
  assert.equal(t.tdeeSource, 'formula');
  close(t.tdeeBasis, FORMULA_TDEE);
  close(t.deficit, 935);
  assert.equal(t.rate, 0.01);
  assert.equal(t.weightUsed, 85);
  close(t.targetLossKg, 0.85);
  close(t.kcal, WEEK1_KCAL);
  close(t.kcal, 1971.71, 0.005);
  close(t.protein, 183.6);
  close(t.fat, 51);
  close(t.carbs, 194.58, 0.005);
  assert.equal(t.bmrFloorApplied, false);
  assert.equal(t.phase.label, 'Cut 1');
  assert.ok(t.explanation.length > 0);

  const pre = E.targetsForWeek(state, W(0));
  assert.equal(pre.source, 'pre');
  assert.equal(pre.phase.type, 'pre');
  close(pre.kcal, t.kcal);
  close(pre.carbs, t.carbs);
  assert.equal(pre.targetLossKg, 0);
  // Any date in the week resolves to its Saturday.
  close(E.targetsForWeek(state, '2026-09-30').kcal, t.kcal);
});

test('targets: BMR floor when formula TDEE − deficit falls below BMR', function () {
  const state = makeState({ weightKg: 60, heightCm: 160, age: 60, bodyFatPct: 30, steps: 0, liftDays: [], padelDays: [] });
  const bmr = 600 + 1000 - 300 + 5; // 1305
  close(E.calcFormulaTDEE(state.setup).value, bmr * 1.2);
  const t = E.targetsForWeek(state, PS);
  assert.equal(t.bmrFloorApplied, true);
  close(t.kcal, bmr);
  close(t.protein, 2.7 * 42);
  close(t.fat, 36);
  close(t.carbs, (bmr - 4 * 2.7 * 42 - 9 * 36) / 4);
});

test('targets: without check-ins weeks 2–8 carry, week 9 becomes a break, week 11 cuts again', function () {
  const state = makeState();
  const w1 = E.targetsForWeek(state, W(1));
  for (let wk = 2; wk <= 8; wk++) {
    const t = E.targetsForWeek(state, W(wk));
    assert.equal(t.source, 'carry', 'week ' + wk);
    assert.equal(t.phase.weekInBlock, wk);
    close(t.kcal, w1.kcal);
    close(t.targetLossKg, 0.85);
  }
  const b = E.targetsForWeek(state, W(9));
  assert.equal(b.phase.type, 'break');
  assert.equal(b.source, 'transition');
  assert.equal(b.tdeeSource, 'learned');
  close(b.tdeeBasis, FORMULA_TDEE, 1e-9, 'no check-in yet: learned falls back to the formula value');
  close(b.kcal, FORMULA_TDEE, 1e-9, 'break sits at maintenance');
  assert.equal(b.deficit, 0);
  assert.equal(b.targetLossKg, 0);
  close(b.protein, w1.protein);
  close(b.fat, w1.fat);
  close(b.carbs, w1.carbs + 935 / 4, 1e-9, 'the whole difference goes to carbs');

  const b2 = E.targetsForWeek(state, W(10));
  assert.equal(b2.source, 'carry');
  close(b2.kcal, b.kcal);

  const c2 = E.targetsForWeek(state, W(11));
  assert.equal(c2.phase.label, 'Cut 2');
  assert.equal(c2.source, 'transition');
  close(c2.kcal, WEEK1_KCAL);
  close(c2.carbs, w1.carbs);
  close(c2.targetLossKg, 0.85);
});

test('targets: a transition uses the latest learned TDEE and latest check-in weight', function () {
  const state = makeState();
  // A saved check-in for week 7 whose next targets apply to week 8.
  state.checkins[W(7)] = {
    weekStart: W(7), learnedAfter: 2800, cur: { avgWeight: 81 }, tdeeUsedForNext: 'learned',
    next: { kcal: 1900, protein: 183.6, fat: 51, carbs: (1900 - 4 * 183.6 - 459) / 4, tdeeBasis: 2800,
      tdeeSource: 'learned', deficit: 891, rate: 0.01, weightUsed: 81, bmrFloorApplied: false },
    notes: ['saved']
  };
  const t8 = E.targetsForWeek(state, W(8));
  assert.equal(t8.source, 'checkin');
  close(t8.kcal, 1900);
  close(t8.targetLossKg, 0.81);
  assert.equal(E.latestLearned(state, W(9)), 2800);
  assert.equal(E.latestWeight(state, W(9)), 81);

  const t9 = E.targetsForWeek(state, W(9));
  assert.equal(t9.source, 'transition');
  close(t9.kcal, 2800);
  const t11 = E.targetsForWeek(state, W(11));
  close(t11.kcal, 2800 - 0.01 * 81 * KCAL_DAY);
  assert.equal(t11.weightUsed, 81);
});

test('targets: a phase change without recent check-ins uses the latest logged week, not a stale check-in weight (finding 33)', function () {
  const logs = {};
  setWeek(logs, W(0), { weight: 85, kcal: 2000, steps: 9000 });
  // −0.8 kg per cut week down to 78.6 kg in week 8 (below the 80 kg 15 % body-fat weight), flat through the break.
  for (let k = 1; k <= 10; k++) setWeek(logs, W(k), { weight: 85 - 0.8 * Math.min(k, 8), kcal: 2000, steps: 9000 });
  const state = makeState(null, logs);
  for (let k = 1; k <= 3; k++) save(state, E.computeCheckin(state, W(k))); // last check-in average: 82.6 kg
  close(E.latestWeight(state, W(11)), 78.6);
  const t = E.targetsForWeek(state, W(11));
  assert.equal(t.source, 'transition');
  assert.equal(t.phase.label, 'Cut 2');
  close(t.weightUsed, 78.6);
  assert.equal(t.rate, 0.0075, 'below the 15 % body-fat weight: 0.75 %/week');
  close(t.deficit, 0.0075 * 78.6 * KCAL_DAY);
  close(t.targetLossKg, 0.0075 * 78.6);
  assert.ok(t.explanation.indexOf('Weight 78.6 kg: 7-day average of Sat 28 Nov – Fri 4 Dec (7 weigh-ins).') >= 0, t.explanation.join('\n'));
  close(E.targetsForWeek(state, W(9)).weightUsed, 78.6, 1e-9, 'the break uses week 8 too');

  // A check-in with too few weigh-ins falls back to the latest logged week as well.
  setWeek(state.logs, W(10), { weight: [78.6, 78.6, null, null, null, null, null] });
  const r = E.computeCheckin(state, W(10));
  assert.equal(r.valid, false);
  assert.equal(r.transition, true);
  close(r.next.weightUsed, 78.6);
  assert.equal(r.next.rate, 0.0075);
  assert.ok(r.notes.some(function (n) { return /^Weight 78\.6 kg: 7-day average of Sat 21 Nov – Fri 27 Nov/.test(n); }), r.notes.join('\n'));
});

test('explanations: carried and phase-change weeks show their numbers and where they come from (finding 36)', function () {
  const state = makeState();
  const t3 = E.targetsForWeek(state, W(3));
  assert.equal(t3.explanation[0], 'No check-in saved for Sat 3 Oct – Fri 9 Oct: targets carried over unchanged from ' +
    'Sat 26 Sep – Fri 2 Oct (Cut 1): 1972 kcal, protein 183.6 g, carbs 194.6 g, fat 51 g.');
  assert.ok(t3.explanation.indexOf('Deficit = 1.0 % × 85 kg × 7700 kcal / 7 = 935 kcal/day (0.85 kg/week).') >= 0);

  assert.deepEqual(E.targetsForWeek(state, W(9)).explanation, [
    'Phase change Cut 1 → Maintenance break 1 (no check-in saved for Sat 14 Nov – Fri 20 Nov).',
    'Target = learned TDEE 2907 kcal (no check-in yet: formula value) − deficit 0 kcal = 2907 kcal: the whole deficit moves ' +
      'at once (no ±200 kcal cap).',
    'TDEE = BMR 1805 × 1.2 + 8000 steps × 0.0005 × 85 kg + exercise 2805 kcal/week / 7 = 2166 + 340 + 401 = 2907 kcal.',
    'Macros: protein 183.6 g (unchanged), carbs 194.6 → 428.3 g, fat 51 g (unchanged).'
  ]);

  // Learned TDEE from a check-in names that check-in; a cut names the weight it used.
  state.checkins[W(7)] = { weekStart: W(7), learnedAfter: 2800, cur: { avgWeight: 81 }, notes: [] };
  const c2 = E.targetsForWeek(state, W(11));
  assert.equal(c2.explanation[1], 'Target = learned TDEE 2800 kcal (from the check-in of Sat 7 Nov – Fri 13 Nov) − deficit 891 kcal ' +
    '= 1909 kcal: the whole deficit moves at once (no ±200 kcal cap).');
  assert.ok(c2.explanation.indexOf('Weight 81 kg: check-in average for Sat 7 Nov – Fri 13 Nov.') >= 0, c2.explanation.join('\n'));
  assert.ok(!c2.explanation.some(function (n) { return /^TDEE = BMR/.test(n); }), 'no formula line when the learned value is used');
});

// =====================================================================================
// program snapshot: week-1 targets fixed at the start, protein never reduced (finding 4)
// =====================================================================================
function withSnapshot(state, todayIso) {
  state.program = { snapshot: E.makeProgramSnapshot(state, todayIso) };
  return state;
}

test('snapshot: null before the start or with an incomplete Setup, else the week-1 targets and the start weight', function () {
  assert.equal(E.makeProgramSnapshot(makeState(), E.addDays(PS, -1)), null);
  assert.equal(E.makeProgramSnapshot(makeState({ age: null }), PS), null);
  const snap = E.makeProgramSnapshot(makeState(), W(3));
  assert.equal(snap.programStart, PS);
  assert.equal(snap.takenOn, W(3));
  assert.equal(snap.startWeightKg, 85);
  const w1 = E.targetsForWeek(makeState(), PS);
  ['kcal', 'protein', 'fat', 'carbs', 'tdeeBasis', 'deficit', 'rate', 'weightUsed', 'targetLossKg'].forEach(function (k) {
    close(snap.week1[k], w1[k], 1e-9, k);
  });
  assert.equal(snap.week1.tdeeSource, 'formula');
  assert.equal(snap.week1.bmrFloorApplied, false);
  assert.equal(snap.week1.limited, false);
  assert.equal(snap.week1.phaseType, 'cut');
  assert.deepEqual(snap.week1.explanation, w1.explanation);
  // Start weight: the pre-week average with ≥ 4 weigh-ins, as for the target line.
  const logs = {};
  setWeek(logs, W(0), { weight: [86, 86.2, 85.8, 86, null, null, null] });
  assert.equal(E.makeProgramSnapshot(makeState(null, logs), PS).startWeightKg, 86);
  // A new snapshot ignores the stored one (it is taken again when the program start changes).
  const old = withSnapshot(makeState(), PS);
  old.setup.programStart = W(3);
  old.setup.weightKg = 81;
  const again = E.makeProgramSnapshot(old, W(3));
  assert.equal(again.programStart, W(3));
  assert.equal(again.startWeightKg, 81);
});

test('snapshot: Setup edits after the start no longer rewrite week 1, carried weeks or the target line (finding 4)', function () {
  const state = withSnapshot(makeState(), PS);
  const before = [1, 2, 5].map(function (k) { return E.targetsForWeek(state, W(k)); });
  state.setup.weightKg = 81; // BF% still 20: live protein would be 2.7 × 64.8 = 175 g
  close(E.calcProtein(state.setup).value, 2.7 * 64.8);
  [1, 2, 5].forEach(function (k, i) {
    const t = E.targetsForWeek(state, W(k));
    assert.equal(t.source, k === 1 ? 'initial' : 'carry', 'week ' + k);
    close(t.protein, PROTEIN, 1e-9, 'week ' + k);
    close(t.kcal, before[i].kcal, 1e-9, 'week ' + k);
    close(t.carbs, before[i].carbs, 1e-9, 'week ' + k);
    close(t.fat, before[i].fat, 1e-9, 'week ' + k);
  });
  assert.match(E.targetsForWeek(state, W(1)).explanation[0], /saved when the program started/);
  assert.equal(E.targetLine(state, PS, PS)[0].kg, 85, 'the target line still starts at the start weight');
  // A snapshot of another program start is ignored: week 1 is live from Setup.
  state.setup.programStart = W(3);
  close(E.targetsForWeek(state, W(3)).protein, 2.7 * 64.8);
  // Without a snapshot the week-1 targets stay live from Setup.
  state.setup.programStart = PS;
  delete state.program;
  close(E.targetsForWeek(state, W(5)).protein, 2.7 * 64.8);
});

test('snapshot: the first check-in after a Setup edit keeps the program-start protein (finding 4)', function () {
  const state = withSnapshot(week1State(), PS);
  state.setup.weightKg = 84; // live protein 2.7 × 67.2 = 181.4 g
  const r = save(state, E.computeCheckin(state, W(1)));
  close(r.next.protein, PROTEIN);
  close(E.targetsForWeek(state, W(3)).protein, PROTEIN);
});

test('snapshot: protein is lifted to the program-start target in every week, calories unchanged (finding 4)', function () {
  const state = withSnapshot(makeState(), PS);
  const lowP = 175, kcal = 1950, fat = 51, carbs = (kcal - 4 * lowP - 9 * fat) / 4;
  state.checkins[W(4)] = { weekStart: W(4), learnedAfter: 2800, cur: { avgWeight: 82 }, notes: ['saved'],
    next: { kcal: kcal, protein: lowP, fat: fat, carbs: carbs, tdeeBasis: 2800, tdeeSource: 'learned', deficit: 850, rate: 0.01,
      weightUsed: 82, bmrFloorApplied: false } };
  const t5 = E.targetsForWeek(state, W(5));
  assert.equal(t5.source, 'checkin');
  close(t5.protein, PROTEIN);
  close(t5.kcal, kcal);
  close(t5.carbs, carbs - (PROTEIN - lowP), 1e-9, 'the extra protein comes out of carbs');
  close(t5.fat, fat);
  assert.ok(t5.explanation.some(function (n) { return /^Protein raised to the program-start target of 183\.6 g/.test(n); }));
  close(E.targetsForWeek(state, W(7)).protein, PROTEIN, 1e-9, 'carried weeks keep it');
  close(E.targetsForWeek(state, W(9)).protein, PROTEIN, 1e-9, 'and so does a phase change');
});

test('snapshot: a goal edit that moves week 1 into another phase recomputes week 1, keeping the protein floor', function () {
  const state = withSnapshot(makeState(), PS);
  Object.assign(state.setup, { goalType: 'weight', goalWeightKg: 86, bodyFatPct: 25 }); // live protein 172.1 g
  const t = E.targetsForWeek(state, W(1));
  assert.equal(t.phase.type, 'final');
  assert.equal(t.deficit, 0);
  close(t.kcal, FORMULA_TDEE);
  close(t.protein, PROTEIN);
  assert.match(t.explanation[0], /recomputed from Setup/);
  close(E.targetsForWeek(state, W(0)).protein, PROTEIN, 1e-9, 'the pre-start preview too');
});

// =====================================================================================
// check-in
// =====================================================================================
/** Pre-week at 85.0 kg, week 1 averaging 84.3 kg on 2000 kcal (weights vary day to day). */
function week1State(setupOver) {
  const logs = {};
  setWeek(logs, W(0), { weight: 85.0, kcal: 2500, steps: 9000 });
  setWeek(logs, W(1), { weight: [84.6, 84.5, 84.4, 84.3, 84.2, 84.1, 84.0], kcal: [2000, 1950, 2050, 2000, 1980, 2020, 2000],
    protein: 185, steps: 9000 });
  return makeState(setupOver, logs);
}

test('check-in: observed TDEE = avg intake − Δavg × 1100 and learned = 0.7 prev + 0.3 observed (week 1)', function () {
  const state = week1State();
  const r = E.computeCheckin(state, W(1));
  assert.equal(r.weekStart, W(1));
  assert.equal(r.valid, true);
  close(r.cur.avgWeight, 84.3);
  close(r.prev.avgWeight, 85);
  close(r.deltaKg, -0.7);
  close(r.observedTDEE, 2000 + 0.7 * 1100);
  close(r.observedTDEE, 2770);
  close(r.learnedBefore, FORMULA_TDEE);
  close(r.learnedAfter, 0.7 * FORMULA_TDEE + 0.3 * 2770);
  close(r.formulaTDEE, FORMULA_TDEE);
  assert.equal(r.applied, true);
  close(r.targetLossKg, 0.85);
  close(r.actualLossKg, 0.7);
  close(r.lossRatio, 0.7 / 0.85);
  assert.equal(r.belowTarget, false);
  assert.equal(r.stall, false);
  assert.equal(r.diagnosis, null);
  assert.equal(r.goalReached, false);
  assert.equal(r.transition, false);
  assert.equal(r.capped, false);
  // Next week is program week 2: formula TDEE, deficit from the new average weight.
  assert.equal(r.tdeeUsedForNext, 'formula');
  close(r.next.tdeeBasis, FORMULA_TDEE);
  close(r.next.deficit, 0.01 * 84.3 * KCAL_DAY);
  assert.equal(r.next.rate, 0.01);
  close(r.next.weightUsed, 84.3);
  close(r.next.targetLossKg, 0.843);
  close(r.next.kcal, FORMULA_TDEE - 927.3);
  close(r.next.protein, PROTEIN);
  close(r.next.fat, 51);
  close(r.next.carbs, WEEK1_CARBS + (FORMULA_TDEE - 927.3 - WEEK1_KCAL) / 4);
  assert.equal(r.next.phase.label, 'Cut 1');
  assert.equal(r.next.phase.weekInBlock, 2);
  assert.ok(r.notes.some(function (n) { return /Observed TDEE = 2000 kcal − \(−0\.7 kg × 7700 \/ 7\) = 2770 kcal/.test(n); }), r.notes.join('\n'));
  // Saved, it drives week 2.
  save(state, r);
  const t2 = E.targetsForWeek(state, W(2));
  assert.equal(t2.source, 'checkin');
  close(t2.kcal, r.next.kcal);
  close(t2.targetLossKg, 0.843);
});

test('check-in: weeks 1–2 use the formula TDEE, week 3 onward the learned TDEE', function () {
  const state = week1State();
  const r1 = save(state, E.computeCheckin(state, W(1)));
  setWeek(state.logs, W(2), { weight: 83.6, kcal: 2000, steps: 9000 });
  const r2 = E.computeCheckin(state, W(2));
  close(r2.learnedBefore, r1.learnedAfter);
  close(r2.observedTDEE, 2770);
  close(r2.learnedAfter, 0.7 * r1.learnedAfter + 0.3 * 2770);
  assert.equal(r2.tdeeUsedForNext, 'learned');
  close(r2.next.tdeeBasis, r2.learnedAfter);
  const raw = r2.learnedAfter - 0.01 * 83.6 * KCAL_DAY;
  assert.ok(Math.abs(raw - r1.next.kcal) < 200, 'inside the cap');
  close(r2.next.kcal, raw);
  assert.equal(E.latestLearned(state, W(3)), r1.learnedAfter, 'unsaved r2 does not count yet');
});

test('check-in: ±200 kcal cap inside a phase, both directions', function () {
  // Up, inside a cut: a big intake with the planned loss means a much higher learned TDEE.
  const base = week1State();
  const r1 = save(base, E.computeCheckin(base, W(1)));
  setWeek(base.logs, W(2), { weight: 83.6, kcal: 3500, steps: 9000 });
  const rh = E.computeCheckin(base, W(2));
  close(rh.observedTDEE, 3500 + 770);
  const rawHigh = (0.7 * r1.learnedAfter + 0.3 * 4270) - 0.01 * 83.6 * KCAL_DAY;
  assert.ok(rawHigh > r1.next.kcal + 200);
  assert.equal(rh.transition, false);
  assert.equal(rh.capped, true);
  close(rh.next.kcal, r1.next.kcal + 200);
  close(rh.next.carbs, r1.next.carbs + 50);

  // Down, inside a break (week 9 → 10): weight gain on 2000 kcal means a much lower learned TDEE.
  const logs = {};
  setWeek(logs, W(8), { weight: 81.5, kcal: 2000, steps: 9000 });
  setWeek(logs, W(9), { weight: 82.3, kcal: 2000, steps: 9000 });
  const state = makeState(null, logs);
  const thisT = E.targetsForWeek(state, W(9));
  close(thisT.kcal, FORMULA_TDEE);
  const rl = E.computeCheckin(state, W(9));
  close(rl.observedTDEE, 2000 - 0.8 * 1100);
  close(rl.learnedAfter, 0.7 * FORMULA_TDEE + 0.3 * 1120);
  assert.equal(rl.transition, false);
  assert.equal(rl.capped, true);
  close(rl.next.kcal, FORMULA_TDEE - 200);
  close(rl.next.carbs, thisT.carbs - 50);
  close(rl.next.protein, thisT.protein);
  close(rl.next.fat, thisT.fat);
});

test('check-in: cut → break is not capped; break = learned TDEE, whole difference in carbs', function () {
  const logs = {};
  setWeek(logs, W(7), { weight: 82.0, kcal: 2000, steps: 9000 });
  setWeek(logs, W(8), { weight: 81.5, kcal: 2000, steps: 9000 });
  const state = makeState(null, logs);
  const thisT = E.targetsForWeek(state, W(8));
  assert.equal(thisT.source, 'carry');
  const r = E.computeCheckin(state, W(8));
  close(r.observedTDEE, 2000 + 0.5 * 1100);
  close(r.learnedAfter, 0.7 * FORMULA_TDEE + 0.3 * 2550);
  assert.equal(r.belowTarget, true, '0.5 kg < 70 % of 0.85 kg');
  assert.equal(r.stall, false, 'first week below target');
  assert.equal(r.transition, true);
  assert.equal(r.capped, false);
  assert.equal(r.next.phase.label, 'Maintenance break 1');
  assert.equal(r.next.deficit, 0);
  assert.equal(r.next.targetLossKg, 0);
  close(r.next.kcal, r.learnedAfter, 1e-9, 'break sits at the learned TDEE');
  assert.ok(r.next.kcal - thisT.kcal > 200, 'bigger than the weekly cap');
  close(r.next.protein, thisT.protein);
  close(r.next.fat, thisT.fat);
  close(r.next.carbs, thisT.carbs + (r.learnedAfter - thisT.kcal) / 4);
  save(state, r);

  // Break week 1 -> week 2: no check-in saved for week 9, so week 10 carries.
  setWeek(state.logs, W(9), { weight: 81.8, kcal: 2800, steps: 9000 });
  setWeek(state.logs, W(10), { weight: 82.0, kcal: 2800, steps: 9000 });
  const t10 = E.targetsForWeek(state, W(10));
  assert.equal(t10.source, 'carry');
  close(t10.kcal, r.next.kcal);

  // Break -> cut: the whole deficit comes back at once.
  const rb = E.computeCheckin(state, W(10));
  close(rb.learnedBefore, r.learnedAfter);
  close(rb.observedTDEE, 2800 - 0.2 * 1100);
  close(rb.learnedAfter, 0.7 * r.learnedAfter + 0.3 * 2580);
  assert.equal(rb.belowTarget, false, 'no loss target in a break');
  assert.equal(rb.transition, true);
  assert.equal(rb.capped, false);
  assert.equal(rb.next.phase.label, 'Cut 2');
  const deficit = 0.01 * 82 * KCAL_DAY;
  close(rb.next.deficit, deficit);
  close(rb.next.kcal, rb.learnedAfter - deficit);
  assert.ok(t10.kcal - rb.next.kcal > 200);
  close(rb.next.protein, t10.protein);
  close(rb.next.fat, t10.fat, 1e-9, 'carbs cover the whole cut');
  close(rb.next.carbs, t10.carbs - (t10.kcal - rb.next.kcal) / 4);
});

test('check-in: BMR floor on the next targets', function () {
  const logs = {};
  setWeek(logs, W(2), { weight: 60.0, kcal: 1000, steps: 3000 });
  setWeek(logs, W(3), { weight: 59.4, kcal: 1000, steps: 3000 });
  const state = makeState({ weightKg: 60, heightCm: 160, age: 60, bodyFatPct: 30, steps: 3000, liftDays: [], padelDays: [] }, logs);
  const r = E.computeCheckin(state, W(3));
  // learned = 0.7 × formula + 0.3 × (1000 + 660) is far below BMR + deficit.
  assert.equal(r.next.bmrFloorApplied, true);
  close(r.next.kcal, 1305);
  assert.ok(r.notes.some(function (n) { return /BMR floor/.test(n); }));
});

test('check-in: invalid week (< 4 weigh-ins) carries the targets and keeps learned TDEE', function () {
  const logs = {};
  setWeek(logs, W(0), { weight: 85.0, kcal: 2500 });
  setWeek(logs, W(1), { weight: [84.5, null, 84.3, null, 84.1, null, null], kcal: 2000, steps: 9000 });
  const state = makeState(null, logs);
  const r = E.computeCheckin(state, W(1));
  assert.equal(r.cur.weighIns, 3);
  assert.equal(r.valid, false);
  assert.equal(r.observedTDEE, null);
  assert.equal(r.applied, false);
  assert.equal(r.belowTarget, false);
  close(r.learnedAfter, r.learnedBefore);
  const thisT = E.targetsForWeek(state, W(1));
  close(r.next.kcal, thisT.kcal);
  close(r.next.carbs, thisT.carbs);
  assert.equal(r.next.weightUsed, 85);
  assert.ok(r.notes.some(function (n) { return /Not enough data/.test(n); }));

  // Previous week short of weigh-ins, or no intake logged: also invalid.
  const logs2 = {};
  setWeek(logs2, W(0), { weight: [85, 85, 85, null, null, null, null] });
  setWeek(logs2, W(1), { weight: 84.3, kcal: 2000 });
  assert.equal(E.computeCheckin(makeState(null, logs2), W(1)).valid, false);
  const logs3 = {};
  setWeek(logs3, W(0), { weight: 85 });
  setWeek(logs3, W(1), { weight: 84.3 });
  assert.equal(E.computeCheckin(makeState(null, logs3), W(1)).valid, false);
});

test('check-in: an invalid week still makes the scheduled phase change', function () {
  const state = makeState();
  const r = E.computeCheckin(state, W(8));
  assert.equal(r.valid, false);
  assert.equal(r.transition, true);
  assert.equal(r.next.phase.type, 'break');
  close(r.next.kcal, FORMULA_TDEE, 1e-9, 'learned TDEE (formula fallback) without deficit');
});

/** Two weeks each losing 0.2 kg (far below 70 % of target), with configurable week-2 steps and intake days. */
function stallState(week2) {
  const logs = {};
  setWeek(logs, W(0), { weight: 85.0, kcal: 2000, steps: 9000 });
  setWeek(logs, W(1), { weight: 84.8, kcal: 2000, steps: 9000 });
  const state = makeState(null, logs);
  const r1 = E.computeCheckin(state, W(1));
  setWeek(state.logs, W(2), Object.assign({ weight: 84.6 }, week2));
  return { state: state, r1: r1 };
}

test('check-in: stall only after two consecutive weeks below 70 % of target', function () {
  const s = stallState({ kcal: 2000, steps: 9000 });
  assert.equal(s.r1.belowTarget, true);
  assert.equal(s.r1.stall, false, 'first week below target');
  assert.equal(s.r1.prevBelowTargetSource, null, 'the pre-week has no logged week before it to judge');
  // Week 1 not saved: its logs still show it below target, so the stall is found (review finding 3).
  const unsaved = E.computeCheckin(s.state, W(2));
  assert.equal(unsaved.belowTarget, true);
  assert.equal(unsaved.stall, true);
  assert.equal(unsaved.prevBelowTarget, true);
  assert.equal(unsaved.prevBelowTargetSource, 'logs');
  // Saved but not below target: no stall.
  save(s.state, Object.assign({}, s.r1, { belowTarget: false }));
  const notBelow = E.computeCheckin(s.state, W(2));
  assert.equal(notBelow.stall, false);
  assert.equal(notBelow.prevBelowTargetSource, 'checkin', 'a saved record wins over the logs');
  // Saved and below target: stall.
  save(s.state, s.r1);
  const r2 = E.computeCheckin(s.state, W(2));
  assert.equal(r2.stall, true);
  assert.equal(r2.prevBelowTargetSource, 'checkin');
  assert.equal(r2.diagnosis, 'adaptation');
  // Back on track the week after: no stall.
  const ok = stallState({ kcal: 2000, steps: 9000 });
  save(ok.state, ok.r1);
  setWeek(ok.state.logs, W(2), { weight: 84.0 });
  const r3 = E.computeCheckin(ok.state, W(2));
  assert.equal(r3.belowTarget, false);
  assert.equal(r3.stall, false);
});

test('check-in: diagnosis order neat → tracking → adaptation, and what each applies', function () {
  // NEAT wins even when tracking is also incomplete.
  const neat = stallState({ kcal: [2000, 2000, 2000, 2000, 2000, null, null], steps: 6000 });
  save(neat.state, neat.r1);
  const tNeat = E.targetsForWeek(neat.state, W(2));
  const rn = E.computeCheckin(neat.state, W(2));
  assert.equal(rn.stall, true);
  assert.equal(rn.diagnosis, 'neat');
  assert.equal(rn.diagnosisText, 'NEAT drop — restore steps before cutting food');
  assert.equal(rn.applied, false);
  close(rn.learnedAfter, rn.learnedBefore);
  assert.equal(typeof rn.observedTDEE, 'number', 'observed TDEE is still reported');
  close(rn.next.kcal, tNeat.kcal);
  close(rn.next.carbs, tNeat.carbs);
  close(rn.next.fat, tNeat.fat);
  close(rn.next.protein, tNeat.protein);

  // Steps fine (6800 is exactly 85 %), 5 days logged: tracking gap.
  const tr = stallState({ kcal: [2000, 2000, 2000, 2000, 2000, null, null], steps: 6800 });
  save(tr.state, tr.r1);
  const tTr = E.targetsForWeek(tr.state, W(2));
  const rt = E.computeCheckin(tr.state, W(2));
  assert.equal(rt.diagnosis, 'tracking');
  assert.equal(rt.diagnosisText, 'Tracking gap');
  assert.equal(rt.applied, false);
  close(rt.learnedAfter, rt.learnedBefore);
  close(rt.next.kcal, tTr.kcal);

  // Steps fine, 7 days logged: metabolic adaptation, the adjustment is applied.
  const ad = stallState({ kcal: 2000, steps: 9000 });
  save(ad.state, ad.r1);
  const ra = E.computeCheckin(ad.state, W(2));
  assert.equal(ra.diagnosis, 'adaptation');
  assert.equal(ra.diagnosisText, 'Metabolic adaptation');
  assert.equal(ra.applied, true);
  close(ra.observedTDEE, 2000 + 0.2 * 1100);
  close(ra.learnedAfter, 0.7 * ra.learnedBefore + 0.3 * ra.observedTDEE);
  assert.notEqual(ra.next.kcal, E.targetsForWeek(ad.state, W(2)).kcal);
});

test('check-in: a missed check-in no longer hides a two-week stall; the NEAT flag holds the food (finding 3)', function () {
  function program(skipWeek5) {
    const logs = {};
    [85, 84.2, 83.4, 82.6, 82.3, 82.1, 81.9].forEach(function (kg, i) {
      setWeek(logs, W(i), { weight: kg, kcal: 2000, steps: i >= 5 ? 5500 : 8000 });
    });
    const state = makeState(null, logs);
    for (let k = 1; k <= 5; k++) if (!(skipWeek5 && k === 5)) save(state, E.computeCheckin(state, W(k)));
    return state;
  }
  const state = program(true);
  const thisT = E.targetsForWeek(state, W(6));
  const r = E.computeCheckin(state, W(6));
  assert.equal(r.belowTarget, true);
  assert.equal(r.prevBelowTarget, true);
  assert.equal(r.prevBelowTargetSource, 'logs');
  assert.equal(r.stall, true);
  assert.equal(r.diagnosis, 'neat');
  assert.equal(r.applied, false);
  close(r.learnedAfter, r.learnedBefore, 1e-9, 'no food cut on a NEAT drop');
  close(r.next.kcal, thisT.kcal);
  assert.ok(r.notes.indexOf('No check-in saved for Sat 24 Oct – Fri 30 Oct; from its logs it lost 0.2 kg vs target 0.82 kg (24 %), ' +
    'below 70 % of target.') >= 0, r.notes.join('\n'));
  // Same outcome as when week 5 was saved.
  const full = E.computeCheckin(program(false), W(6));
  assert.equal(full.prevBelowTargetSource, 'checkin');
  assert.equal(full.diagnosis, 'neat');
  close(full.next.kcal, r.next.kcal);

  // Too few weigh-ins to judge week 5 from its logs: no stall is claimed.
  setWeek(state.logs, W(4), { weight: [82.3, 82.3, 82.3, null, null, null, null] });
  const sparse = E.computeCheckin(state, W(6));
  assert.equal(sparse.prevBelowTargetSource, null);
  assert.equal(sparse.prevBelowTarget, false);
  assert.equal(sparse.stall, false);
  assert.ok(sparse.notes.some(function (n) { return /logs are too sparse to judge its loss/.test(n); }));
});

test('check-in: a learned TDEE updated by this check-in is not called the formula value', function () {
  const state = week1State();
  setWeek(state.logs, W(2), { weight: 83.6, kcal: 2000, steps: 9000 });
  const r = E.computeCheckin(state, W(2)); // week 1 not saved, week 3 uses the learned value
  assert.equal(r.applied, true);
  assert.ok(r.notes.some(function (n) { return /^Next week: learned TDEE \d+ kcal \(updated by this check-in\)/.test(n); }), r.notes.join('\n'));
  const held = E.computeCheckin(makeState(), W(8)); // no logs: held at the formula value through the phase change
  assert.ok(held.notes.some(function (n) { return /learned TDEE 2907 kcal \(no check-in yet: formula value\)/.test(n); }), held.notes.join('\n'));
});

test('check-in: protein is never reduced even if Setup now gives less', function () {
  const state = week1State();
  save(state, E.computeCheckin(state, W(1)));
  setWeek(state.logs, W(2), { weight: 83.6, kcal: 2000, steps: 9000 });
  state.setup.bodyFatPct = 25; // calcProtein drops to 2.7 × 63.75
  const r = E.computeCheckin(state, W(2));
  close(r.next.protein, PROTEIN);
});

test('check-in: goal reached → final maintenance from the following week', function () {
  const state = week1State({ goalType: 'weight', goalWeightKg: 84.5 });
  const r = E.computeCheckin(state, W(1));
  assert.equal(r.goalReached, true);
  assert.equal(r.transition, true);
  assert.equal(r.next.phase.type, 'final');
  assert.equal(r.next.phase.blockStart, W(2));
  assert.equal(r.next.deficit, 0);
  close(r.next.kcal, FORMULA_TDEE, 1e-9, 'week 2: formula TDEE, no deficit');
  assert.equal(E.goalReachedWeek(state), null, 'not saved yet');
  save(state, r);
  assert.equal(E.goalReachedWeek(state), W(2));
  assert.equal(E.phaseForWeek(PS, W(1), E.goalReachedWeek(state)).type, 'cut');
  const t2 = E.targetsForWeek(state, W(2));
  assert.equal(t2.source, 'checkin');
  assert.equal(t2.phase.type, 'final');
  assert.equal(t2.targetLossKg, 0);
  const t5 = E.targetsForWeek(state, W(5));
  assert.equal(t5.source, 'carry');
  assert.equal(t5.phase.label, 'Final maintenance');
  assert.equal(t5.phase.weekInBlock, 4);
  close(t5.kcal, t2.kcal);
  // Re-computing the saved week ignores its own saved record.
  setWeek(state.logs, W(1), { weight: 84.7 });
  const again = E.computeCheckin(state, W(1));
  assert.equal(again.goalReached, false);
  assert.equal(again.next.phase.type, 'cut');
});

test('check-in: re-computing a saved week is idempotent', function () {
  const state = week1State();
  const r = E.computeCheckin(state, W(1));
  save(state, r);
  assert.deepEqual(E.computeCheckin(state, W(1)), r);
});

test('history lookups: latestLearned, latestWeight, goalReachedWeek', function () {
  const state = makeState();
  close(E.latestLearned(state, W(5)), FORMULA_TDEE);
  assert.equal(E.latestWeight(state, W(5)), 85);
  state.checkins[W(2)] = { weekStart: W(2), learnedAfter: 2700, cur: { avgWeight: 83 }, goalReached: false };
  state.checkins[W(3)] = { weekStart: W(3), learnedAfter: 2650, cur: { avgWeight: 82.5 }, goalReached: true };
  state.checkins[W(4)] = { weekStart: W(4), learnedAfter: 2600, cur: { avgWeight: 82 }, goalReached: true };
  assert.equal(E.latestLearned(state, W(3)), 2700, 'strictly before the week');
  assert.equal(E.latestLearned(state, W(9)), 2600);
  assert.equal(E.latestWeight(state, W(4)), 82.5);
  assert.equal(E.goalReachedWeek(state), W(4), 'earliest goal-reached check-in + 7 days');
});

test('history lookups: latestWeight takes the newest logged week (≥ 4 weigh-ins) or check-in average (finding 33)', function () {
  const logs = {};
  setWeek(logs, W(2), { weight: 83 });
  setWeek(logs, W(4), { weight: [82, 82, 82, null, null, null, null] }); // 3 weigh-ins: not enough
  const state = makeState(null, logs);
  close(E.latestWeight(state, W(6)), 83, 1e-9, 'week 2 logs');
  state.checkins[W(3)] = { weekStart: W(3), cur: { avgWeight: 82.5 } };
  close(E.latestWeight(state, W(6)), 82.5, 1e-9, 'a newer check-in beats older logs');
  setWeek(logs, W(3), { weight: 82.4 });
  close(E.latestWeight(state, W(6)), 82.4, 1e-9, 'for the same week the logs win');
  close(E.latestWeight(state, W(3)), 83, 1e-9, 'strictly before the week');
  assert.equal(E.latestWeight(makeState(), W(6)), 85, 'Setup weight when nothing is logged');
});

// =====================================================================================
// projections
// =====================================================================================
/** Planned cut weeks by hand: 1 %/week above 80 kg, 0.75 % at or below, the last one partial. */
function manualCut(kg, weeks) {
  const whole = Math.floor(weeks);
  for (let i = 0; i < whole; i++) kg *= 1 - (kg > 80 ? 0.01 : 0.0075);
  return kg * (1 - (kg > 80 ? 0.01 : 0.0075) * (weeks - whole));
}

test('projectBlockEnd: cut applies the weekly rate week by week from the Setup weight', function () {
  const state = makeState();
  const p = E.projectBlockEnd(state, PS);
  assert.equal(p.fromWeight, 85);
  close(p.weeks, 8);   // a whole 8-week block: counted to the Saturday morning after its last Friday dinner
  assert.equal(p.blockEnd, '2026-11-20');
  close(p.weightKg, manualCut(85, 8), 1e-9);
  assert.ok(p.explanation.length >= 2);
  // Before the start the first block is projected from the program start.
  const pre = E.projectBlockEnd(state, '2026-09-20');
  close(pre.weightKg, p.weightKg, 1e-9);
});

test('projectBlockEnd: trailing 7-day base needs 3 weigh-ins; breaks hold the weight; never below goal', function () {
  const logs = { '2026-10-06': { weight: 83.9 }, '2026-10-07': { weight: 84.1 }, '2026-10-08': { weight: 84.0 } };
  const state = makeState(null, logs);
  const p = E.projectBlockEnd(state, '2026-10-08');
  close(p.fromWeight, 84);
  close(p.weeks, E.daysBetween('2026-10-08', '2026-11-21') / 7);
  close(p.weightKg, manualCut(84, p.weeks), 1e-9);

  delete logs['2026-10-06'];
  const two = E.projectBlockEnd(state, '2026-10-08');
  assert.equal(two.fromWeight, 85, 'falls back to latestWeight (Setup)');

  const brk = E.projectBlockEnd(makeState(), '2026-11-25');
  assert.equal(brk.blockEnd, '2026-12-04');
  assert.equal(brk.weightKg, brk.fromWeight);

  const nearGoal = E.projectBlockEnd(makeState({ goalType: 'weight', goalWeightKg: 84 }), PS);
  assert.equal(nearGoal.weightKg, 84);
});

test('projectBlockEnd: final maintenance holds the weight', function () {
  const state = makeState();
  state.checkins[W(3)] = { weekStart: W(3), goalReached: true, cur: { avgWeight: 77 }, learnedAfter: 2700 };
  const p = E.projectBlockEnd(state, '2026-10-20');
  assert.equal(p.weightKg, 77);
  assert.equal(p.weeks, 0);
  assert.equal(p.blockEnd, null);
});

test('projectBlockEnd: the explanation gives the start source, rates, goal and the week-by-week path (finding 36)', function () {
  const state = makeState();
  const p = E.projectBlockEnd(state, W(3));
  assert.deepEqual(p.explanation, [
    'Start: 85 kg (Setup weight).',
    'Cut 1: 6 weeks to Fri 20 Nov (dinner). Each week loses 1.0 % of the weight while above the 15 % body-fat weight (80 kg), ' +
      '0.75 % at or below it, never going below the goal (77.27 kg).',
    'Week by week: 85 → 84.15 → 83.31 → 82.48 → 81.65 → 80.83 → 80.03 kg.'
  ]);
  assert.equal(p.explanation[2].split(' → ').pop(), p.weightKg.toFixed(2) + ' kg.', 'the path ends at the projected weight');

  const logs = { '2026-10-06': { weight: 83.9 }, '2026-10-07': { weight: 84.1 }, '2026-10-08': { weight: 84.0 } };
  const mid = E.projectBlockEnd(makeState(null, logs), '2026-10-08');
  assert.equal(mid.explanation[0], 'Start: 84 kg (7-day average of 3 weigh-ins, Fri 2 Oct – Thu 8 Oct).');
  assert.match(mid.explanation[1], /^Cut 1: 6\.3 weeks to Fri 20 Nov .*; the last 0\.29 of a week counts in part\.$/);

  const pre = E.projectBlockEnd(state, '2026-09-20');
  assert.equal(pre.explanation[0], 'Program starts Sat 26 Sep (dinner): Cut 1 is projected from the start.');
  const brk = E.projectBlockEnd(state, '2026-11-25');
  assert.equal(brk.explanation[1], 'Maintenance break 1: maintenance, weight held at 85 kg for 1.4 weeks until Fri 4 Dec (dinner).');
});

test('programSummary: explanation gives the program week, block and goal (finding 36)', function () {
  const sum = E.programSummary(makeState(), '2026-10-12');
  assert.deepEqual(sum.explanation, [
    'Program week 3, counted in diet weeks (Saturday dinner → Friday dinner) from Sat 26 Sep.',
    'Cut 1: week 3 of 8, Sat 26 Sep – Fri 20 Nov (dinner). Blocks repeat an 8-week cut and a 2-week maintenance break until ' +
      'the goal is reached.',
    'Goal weight = 68 kg lean mass / (1 − 12 %) = 77.27 kg.'
  ]);
  assert.equal(E.programSummary(makeState(), '2026-09-20').explanation[0], 'Program starts Sat 26 Sep (dinner), in 6 days.');
  const state = makeState();
  state.checkins[W(3)] = { weekStart: W(3), goalReached: true, cur: { avgWeight: 77 }, learnedAfter: 2700 };
  assert.ok(E.programSummary(state, '2026-10-20').explanation.indexOf('Goal weight reached at the check-in of Sat 10 Oct – Fri 16 Oct ' +
    '(77 kg ≤ goal 77.27 kg): final maintenance from Sat 17 Oct.') >= 0);
});

test('goal met at the start: final maintenance from week 1; targets, projection and target line agree (finding 31)', function () {
  const state = makeState({ bodyFatPct: 14, goalBodyFatPct: 15 }); // goal weight 73.1 / 0.85 = 86 kg ≥ 85 kg
  close(E.calcGoalWeight(state.setup).value, 86);
  assert.equal(E.goalReachedWeek(state), PS);
  const t1 = E.targetsForWeek(state, W(1));
  assert.equal(t1.phase.type, 'final');
  assert.equal(t1.deficit, 0);
  assert.equal(t1.targetLossKg, 0);
  close(t1.kcal, FORMULA_TDEE, 1e-9, 'maintenance, no cut deficit');
  assert.ok(t1.explanation.indexOf('Goal already reached at the start: 85 kg (Setup weight) ≤ goal 86 kg, so the program is in ' +
    'final maintenance from week 1.') >= 0, t1.explanation.join('\n'));
  [2, 9, 11].forEach(function (k) {
    const t = E.targetsForWeek(state, W(k));
    assert.equal(t.phase.type, 'final', 'week ' + k);
    close(t.kcal, t1.kcal, 1e-9, 'week ' + k);
  });
  close(E.targetsForWeek(state, W(0)).kcal, t1.kcal, 1e-9, 'the pre-start preview agrees');
  const p = E.projectBlockEnd(state, W(3));
  assert.equal(p.blockEnd, null);
  assert.equal(p.weightKg, 85);
  assert.equal(E.projectBlockEnd(state, '2026-09-20').blockEnd, null, 'before the start too');
  assert.ok(E.targetLine(state, PS, W(20)).every(function (pt) { return pt.kg === 85; }), 'flat target line');
  const sum = E.programSummary(state, W(3));
  assert.equal(sum.phase.label, 'Final maintenance');
  assert.ok(sum.explanation.some(function (n) { return /^Goal already reached at the start/.test(n); }));
  // A goal equal to the start weight counts; just below it is a cut.
  assert.equal(E.goalReachedWeek(makeState({ goalType: 'weight', goalWeightKg: 85 })), PS);
  const below = makeState({ goalType: 'weight', goalWeightKg: 84.9 });
  assert.equal(E.goalReachedWeek(below), null);
  assert.equal(E.targetsForWeek(below, PS).phase.type, 'cut');
});

test('goal met at the start: start weight is the snapshot one, else the pre-week average, else Setup (finding 31)', function () {
  // Pre-week average 86 kg (≥ 4 weigh-ins) is above an 85.5 kg goal: a cut, although Setup says 85 kg.
  const logs = {};
  setWeek(logs, W(0), { weight: 86 });
  const cut = makeState({ goalType: 'weight', goalWeightKg: 85.5 }, logs);
  assert.equal(E.goalReachedWeek(cut), null);
  assert.equal(E.targetLine(cut, PS, PS)[0].kg, 86);
  // Snapshot start weight 85 kg ≤ 86 kg goal: still final after the Setup weight is changed to 90 kg.
  const snap = withSnapshot(makeState({ goalType: 'weight', goalWeightKg: 86 }), PS);
  assert.equal(snap.program.snapshot.week1.phaseType, 'final');
  snap.setup.weightKg = 90;
  assert.equal(E.goalReachedWeek(snap), PS);
  const t4 = E.targetsForWeek(snap, W(4));
  assert.equal(t4.phase.type, 'final');
  close(t4.kcal, FORMULA_TDEE, 1e-9, 'week 1 from the snapshot, carried');
});

test('targetLine: one point per day from the program start, down in cuts, flat in breaks, stops at goal', function () {
  const state = makeState();
  const goal = 68 / 0.88;
  const line = E.targetLine(state, W(0), E.addDays(PS, 7 * 60));
  assert.equal(line[0].date, PS, 'starts at the program start');
  assert.equal(line[0].kg, 85);
  assert.equal(line.length, 7 * 60 + 1);
  for (let i = 1; i < line.length; i++) {
    assert.equal(E.daysBetween(line[i - 1].date, line[i].date), 1);
    const ph = E.phaseForWeek(PS, E.weekStartOf(line[i - 1].date), null);
    if (ph.type === 'cut') assert.ok(line[i].kg <= line[i - 1].kg + 1e-12, 'non-increasing in a cut at ' + line[i].date);
    else close(line[i].kg, line[i - 1].kg, 1e-12, 'flat in a break at ' + line[i].date);
    assert.ok(line[i].kg >= goal - 1e-9, 'never below goal');
  }
  close(line[line.length - 1].kg, goal, 1e-9, 'reaches the goal and stays there');
  // Week 1 loses 1 % linearly over the week.
  const byDate = {};
  line.forEach(function (p) { byDate[p.date] = p.kg; });
  close(byDate[W(2)], 85 * 0.99);
  close(byDate[E.addDays(PS, 3)], 85 - 0.85 * 3 / 7);
  close(byDate['2026-11-21'], byDate['2026-12-05'], 1e-12, 'break 1 flat');
});

test('targetLine: start weight is the pre-week average with ≥ 4 weigh-ins, else Setup; empty range', function () {
  const logs = {};
  setWeek(logs, W(0), { weight: [86, 86.2, 85.8, 86, null, null, null] });
  assert.equal(E.targetLine(makeState(null, logs), PS, PS)[0].kg, 86);
  logs[W(0)].weight = null;
  assert.equal(E.targetLine(makeState(null, logs), PS, PS)[0].kg, 85);
  assert.deepEqual(E.targetLine(makeState(), '2026-09-01', '2026-09-20'), []);
});

// =====================================================================================
// program summary
// =====================================================================================
test('programSummary: phase, targets, block end, projection and check-in scheduling', function () {
  const state = week1State();
  const fri = E.programSummary(state, '2026-10-02');
  assert.equal(fri.weekStart, PS);
  assert.equal(fri.phase.label, 'Cut 1');
  close(fri.targets.kcal, WEEK1_KCAL);
  assert.equal(fri.blockEnd, '2026-11-20');
  assert.equal(typeof fri.projection.weightKg, 'number');
  assert.equal(fri.nextCheckinDate, '2026-10-02');
  assert.deepEqual(fri.checkinDue, { weekStart: PS, date: '2026-10-02' });
  close(fri.goalWeight, 68 / 0.88);

  const sat = E.programSummary(state, '2026-10-03');
  assert.deepEqual(sat.checkinDue, { weekStart: PS, date: '2026-10-02' }, 'overdue');
  save(state, E.computeCheckin(state, W(1)));
  const satSaved = E.programSummary(state, '2026-10-03');
  assert.equal(satSaved.checkinDue, null);
  assert.equal(satSaved.nextCheckinDate, '2026-10-09');
  assert.equal(satSaved.targets.source, 'checkin');
  assert.equal(E.programSummary(state, '2026-10-02').nextCheckinDate, '2026-10-09', 'already saved today');

  const pre = E.programSummary(makeState(), '2026-09-20');
  assert.equal(pre.phase.type, 'pre');
  assert.equal(pre.checkinDue, null);
  assert.equal(pre.nextCheckinDate, '2026-10-02');
});
