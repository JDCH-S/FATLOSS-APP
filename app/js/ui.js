/* UI: renders the five tabs and wires events. The state object lives in memory; every change goes through
 * commit(section), which saves via FL.store and re-renders. Logic lives in engine / mealplan / groceries. */
(function (root) {
  'use strict';

  const doc = root.document;
  const FL = root.FL;
  const E = FL.engine, M = FL.mealplan, G = FL.groceries, S = FL.store, F = FL.foods;
  const SEED = (FL.products && FL.products.PRODUCTS) || [];
  const STORES = G.STORES;
  const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];
  const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const CAT_ORDER = ['protein', 'dairy', 'carb', 'vegetable', 'fruit', 'fat'];
  const CAT_LABEL = { protein: 'Protein', dairy: 'Dairy', carb: 'Carbs', vegetable: 'Vegetables', fruit: 'Fruit', fat: 'Fats' };
  const ROLE_LABEL = { protein: 'Protein', carb: 'Carb', produce: 'Veg / fruit', fat: 'Fat' };
  const RANGES = {
    weightKg: [30, 300, 'Weight', 'kg'], heightCm: [120, 230, 'Height', 'cm'], age: [14, 100, 'Age', 'years'],
    bodyFatPct: [3, 60, 'Body fat', '%'], goalBodyFatPct: [3, 40, 'Goal body fat', '%'], goalWeightKg: [30, 300, 'Goal weight', 'kg'],
    steps: [0, 60000, 'Daily steps', 'steps'], liftMinutes: [0, 300, 'Lifting session', 'min'], padelMinutes: [0, 300, 'Padel session', 'min']
  };

  let state = null;
  let backend = 'memory';
  let tab = 'setup';
  let renderTimer = null;
  const ui = {
    setupErr: null, setupNote: null, foodFilter: '', custom: {}, customErr: null,
    logDraft: null, logMsg: null, weeksShown: 2,
    checkinWeek: null, checkinMsg: null,
    planWeek: 'this', planMsg: null,
    grocWeek: 'coming', grocView: 'cheapest', exportText: null, importMsg: null, importErrors: [], mapSel: {},
    prodStore: 'all', newProd: {}, prodMsg: null,
    backupMsg: null, pendingBackup: null,
    confirm: null,
    open: {}          // open state of <details> elements by id, so a re-render never collapses them
  };

  // ---------- helpers ----------
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }
  function isNum(n) { return typeof n === 'number' && isFinite(n); }
  function fmt(n, d) {
    if (!isNum(n)) return '–';
    return n.toLocaleString('en-GB', { minimumFractionDigits: d || 0, maximumFractionDigits: d || 0 });
  }
  function signed(n, d) {
    if (!isNum(n)) return '–';
    const r = Number(n.toFixed(d || 0));
    return (r > 0 ? '+' : r < 0 ? '−' : '±') + fmt(Math.abs(r), d);
  }
  function eur(n) { return isNum(n) ? '€' + n.toFixed(2) : '–'; }
  function pad(n) { return String(n).padStart(2, '0'); }
  function todayIso() { const d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function val(x) { return x && typeof x === 'object' && 'value' in x ? x.value : x; }
  function clone(x) { return JSON.parse(JSON.stringify(x)); }
  function parseNum(v) {
    if (v === '' || v == null) return null;
    const n = Number(String(v).replace(',', '.'));
    return isFinite(n) ? n : NaN;
  }
  function macros(T) { return { kcal: T.kcal, protein: T.protein, fat: T.fat, carbs: T.carbs }; }
  function dateLong(iso) { return iso ? E.formatDate(iso) + ' ' + iso.slice(0, 4) : '–'; }
  function formulaText(x) { return x && x.formula ? x.formula : ''; }

  function defaultState() {
    const today = todayIso();
    return {
      version: 1,
      setup: {
        isExample: true, weightKg: 85, heightCm: 180, age: 35, bodyFatPct: 20,
        goalType: 'bf', goalBodyFatPct: 12, goalWeightKg: 78,
        steps: 8000, liftDays: [1, 3, 5], padelDays: [2, 6], liftMinutes: 60, padelMinutes: 90,
        mealsPerDay: 4, saturdayMode: 'offplan', programStart: E.nextSaturdayOnOrAfter(today),
        likedFoods: F.DEFAULT_LIKED.slice(), excludedFoods: [], customFoods: []
      },
      logs: {},
      checkins: {},
      plan: null,
      products: clone(SEED),
      priceMeta: { lastImport: null, lastImportFile: null, lastImportSummary: null, unmatched: [] }
    };
  }

  function ctx() {
    const today = todayIso();
    const list = F.FOODS.concat(state.setup.customFoods || []).map(M.normalizeFood);
    const foods = F.byId(list);
    const excluded = (state.setup.excludedFoods || []).filter(function (id) { return foods[id]; });
    const liked = (state.setup.likedFoods || []).filter(function (id) { return foods[id] && excluded.indexOf(id) < 0; });
    return { today: today, list: list, foods: foods, liked: liked, excluded: excluded, weekNow: E.weekStartOf(today) };
  }

  // What the plan looked like in a diet week (latest version), so "changes vs last week" can show real swaps.
  function compactPlan(plan) {
    return plan.meals.map(function (m) { return { key: m.key, name: m.name, items: m.items.map(function (it) { return { foodId: it.foodId, grams: it.grams }; }) }; });
  }
  function recordPlanWeek(c) {
    if (!state.plan || !state.plan.base) return false;
    const p = planForWeek(c, c.weekNow);
    const snap = compactPlan(p.plan);
    const hist = state.plan.history || {};
    if (JSON.stringify(hist[c.weekNow]) === JSON.stringify(snap)) return false;
    hist[c.weekNow] = snap;
    Object.keys(hist).sort().reverse().slice(10).forEach(function (k) { delete hist[k]; });
    state.plan.history = hist;
    return true;
  }

  function planForWeek(c, week) {
    if (!state.plan || !state.plan.base) return null;
    const T = E.targetsForWeek(state, week);
    const res = M.rescalePlan(state.plan.base, c.foods, macros(T));
    return { plan: res.plan, targets: T };
  }

  function amountText(food, grams) {
    if (food && food.unit && food.unit.grams) {
      const n = Math.round(grams / food.unit.grams * 10) / 10;
      const name = food.unit.name + (n === 1 ? '' : 's');
      return fmt(n, n % 1 ? 1 : 0) + ' ' + esc(name) + ' <span class="muted">(' + fmt(grams) + ' g)</span>';
    }
    return fmt(grams) + ' g';
  }

  // ---------- commit / render ----------
  function commit(section) {
    if (section === 'setup') state.setup.isExample = false;
    S.save(section, state);
    scheduleRender();
  }
  function scheduleRender() {
    if (renderTimer) return;
    renderTimer = setTimeout(function () { renderTimer = null; render(); }, 0);
  }

  // Patches the live DOM to match freshly rendered HTML instead of replacing it, so elements keep their identity:
  // focus, the caret, a half-typed date, an open <select> and the button under the pointer survive a re-render.
  function morph(from, to) {
    if (from.nodeType !== 1) { if (from.nodeValue !== to.nodeValue) from.nodeValue = to.nodeValue; return; }
    const focused = from === doc.activeElement;
    const wantSelect = from.nodeName === 'SELECT' ? selectedValue(to) : null;
    for (let i = from.attributes.length - 1; i >= 0; i--) {
      const name = from.attributes[i].name;
      if (!to.hasAttribute(name)) from.removeAttribute(name);
    }
    for (let i = 0; i < to.attributes.length; i++) {
      const at = to.attributes[i];
      if (from.getAttribute(at.name) !== at.value) from.setAttribute(at.name, at.value);
    }
    if (from.nodeName === 'INPUT') {
      if (from.type === 'checkbox' || from.type === 'radio') from.checked = to.hasAttribute('checked');
      else if (from.type !== 'file' && !focused && from.value !== (to.getAttribute('value') || '')) from.value = to.getAttribute('value') || '';
      return;
    }
    if (from.nodeName === 'TEXTAREA') { if (!focused && from.value !== to.value) from.value = to.value; return; }
    morphChildren(from, to);
    if (wantSelect !== null && !focused && from.value !== wantSelect) from.value = wantSelect;
  }
  function selectedValue(sel) {
    const opts = sel.querySelectorAll('option');
    for (let i = 0; i < opts.length; i++) if (opts[i].hasAttribute('selected')) return opts[i].getAttribute('value') || '';
    return opts.length ? opts[0].getAttribute('value') || '' : '';
  }
  // Children are matched by id when they have one, otherwise by position and tag.
  function morphChildren(from, to) {
    const keyed = {};
    for (let n = from.firstChild; n; n = n.nextSibling) if (n.nodeType === 1 && n.id) keyed[n.id] = n;
    let cur = from.firstChild;
    let nk = to.firstChild;
    while (nk) {
      const next = nk.nextSibling;
      let match = null;
      if (nk.nodeType === 1 && nk.id) match = keyed[nk.id] || null;
      else if (cur && cur.nodeName === nk.nodeName && !(cur.nodeType === 1 && cur.id)) match = cur;
      if (match) {
        if (match !== cur) from.insertBefore(match, cur);
        morph(match, nk);
        cur = match.nextSibling;
      } else {
        from.insertBefore(nk, cur);
      }
      nk = next;
    }
    while (cur) { const n = cur.nextSibling; from.removeChild(cur); cur = n; }
  }
  function patch(el, html) {
    const tmp = doc.createElement(el.nodeName);
    tmp.innerHTML = html;
    morphChildren(el, tmp);
  }

  function render() {
    if (!state) return;
    const view = doc.getElementById('view');
    const ae = doc.activeElement;
    const fid = ae && ae.id;
    let html = '';
    try {
      const c = ctx();
      if (ui.logDraft && ui.logDraft.followToday && ui.logDraft.date !== c.today) resetDraft(c.today);
      renderHeader(c);
      html = tab === 'setup' ? renderSetup(c)
        : tab === 'log' ? renderLog(c)
          : tab === 'checkin' ? renderCheckin(c)
            : tab === 'plan' ? renderPlan(c)
              : renderGroceries(c);
    } catch (err) {
      html = '<div class="banner bad" role="alert">Something went wrong while drawing this tab: ' + esc(err && err.message) +
        '. Your data is safe. Check the Setup values (for example the program start date), restore a backup, or reload.</div>' +
        (tab === 'setup' ? safeRender(renderBackup) : '');
      if (root.console) root.console.error(err);
    }
    doc.querySelectorAll('.tab').forEach(function (b) { b.setAttribute('aria-selected', String(b.dataset.tab === tab)); });
    view.setAttribute('aria-labelledby', 'tab-' + tab);
    patch(view, html);
    // Focus normally survives the patch; if its element was replaced, put it back by id.
    if (fid && doc.activeElement !== ae) { const el = doc.getElementById(fid); if (el) { try { el.focus({ preventScroll: true }); } catch (e) { el.focus(); } } }
  }
  function safeRender(fn) { try { return fn(); } catch (e) { return ''; } }

  function setSaveState(status, msg) {
    const el = doc.getElementById('save-state');
    if (!el) return;
    el.classList.toggle('error', status === 'error');
    if (status === 'saving') el.textContent = 'Saving…';
    else if (status === 'error') el.textContent = msg || 'Could not save';
    else el.textContent = backend === 'cloud' ? 'Saved to your Claude account'
      : backend === 'browser' ? 'Saved in this browser only' : 'Not saved: storage unavailable';
  }

  // ---------- header ----------
  function renderHeader(c) {
    const strip = doc.getElementById('status-strip');
    const sum = E.programSummary(state, c.today) || {};
    const ph = sum.phase || {};
    const T = sum.targets || {};
    const parts = [];
    if (ph.type === 'pre') {
      const first = E.phaseForWeek(state.setup.programStart, state.setup.programStart, null);
      parts.push('<span class="chip">Not started</span>');
      parts.push('<span><b>' + esc(first.label) + '</b> starts ' + esc(E.formatDate(state.setup.programStart)) + ' (dinner)</span>');
      parts.push('<span>Week 1 of ' + first.blockLength + ', ends <b>' + esc(E.formatDate(first.blockEnd)) + '</b>, dinner</span>');
    } else {
      const cls = ph.type === 'cut' ? 'accent' : 'good';
      parts.push('<span class="chip ' + cls + '">' + esc(ph.label || '') + '</span>');
      parts.push('<span>Week <b>' + ph.weekInBlock + '</b>' + (ph.blockLength ? ' of ' + ph.blockLength : '') + '</span>');
      if (ph.blockEnd) parts.push('<span>Block ends <b>' + esc(E.formatDate(ph.blockEnd)) + '</b>, dinner</span>');
    }
    if (sum.projection && isNum(sum.projection.weightKg)) {
      parts.push('<span>Projected at block end <b>' + fmt(sum.projection.weightKg, 1) + ' kg</b></span>');
    }
    parts.push('<span>' + (ph.type === 'pre' ? 'Week-1 targets' : 'Today') + ' <b>' + fmt(T.kcal) + ' kcal</b> · P ' + fmt(T.protein) +
      ' · C ' + fmt(T.carbs) + ' · F ' + fmt(T.fat) + ' g</span>');
    const how = (T.explanation || []).concat((sum.projection && sum.projection.explanation) || []);
    if (how.length) {
      parts.push('<details class="how" id="hdr-how"' + (ui.open['hdr-how'] ? ' open' : '') + '><summary>How are these worked out?</summary><ul class="note">' +
        how.map(function (l) { return '<li>' + esc(l) + '</li>'; }).join('') + '</ul></details>');
    }
    patch(strip, parts.join(''));
  }

  // ---------- small builders ----------
  function block(title, body, aside) {
    return '<section class="block"><div class="block-head"><h2>' + esc(title) + '</h2>' + (aside || '') + '</div>' + body + '</section>';
  }
  function numInput(id, label, value, bind, step) {
    return '<label class="field" for="' + id + '">' + esc(label) +
      '<input type="number" id="' + id + '" data-bind="' + bind + '" inputmode="decimal" step="' + (step || 'any') + '" value="' +
      (isNum(value) ? value : '') + '"></label>';
  }
  function seg(field, current, options, prefix) {
    return '<div class="seg" role="group">' + options.map(function (o) {
      return '<button type="button" id="' + (prefix || 'seg') + '-' + field + '-' + o[0] + '" data-action="set" data-field="' + field +
        '" data-value="' + o[0] + '" aria-pressed="' + String(String(current) === String(o[0])) + '">' + esc(o[1]) + '</button>';
    }).join('') + '</div>';
  }
  function dayPicker(field, days) {
    return '<div class="days" role="group">' + WEEK_ORDER.map(function (d) {
      return '<button type="button" id="day-' + field + '-' + d + '" data-action="toggle-day" data-field="' + field + '" data-day="' + d +
        '" aria-pressed="' + String(days.indexOf(d) >= 0) + '">' + DAY_SHORT[d] + '</button>';
    }).join('') + '</div>';
  }
  function confirmBar(kind, key, text, yes) {
    if (!ui.confirm || ui.confirm.kind !== kind || String(ui.confirm.key || '') !== String(key || '')) return '';
    return '<div class="banner warn row" role="alert"><span>' + esc(text) + '</span>' +
      '<button type="button" class="btn danger" id="confirm-yes" data-action="confirm-yes">' + esc(yes) + '</button>' +
      '<button type="button" class="btn" id="confirm-no" data-action="confirm-no">Cancel</button></div>';
  }
  function msg(m) {
    if (!m) return '';
    return '<div class="banner ' + (m.kind || 'info') + '" role="status">' + esc(m.text) + '</div>';
  }

  // =====================================================================================
  // SETUP
  // =====================================================================================
  function renderSetup(c) {
    const s = state.setup;
    const h = [];
    if (s.isExample) {
      h.push('<div class="banner info">These are example inputs, not yours yet. Replace them with your own numbers; every target in the app updates when you leave a field.</div>');
    }
    if (ui.setupErr) h.push('<div class="banner bad" role="alert">' + esc(ui.setupErr) + '</div>');
    if (ui.setupNote) h.push('<div class="banner info" role="status">' + esc(ui.setupNote) + '</div>');

    h.push(block('Body', '<div class="panel stack"><div class="grid">' +
      numInput('s-weight', 'Weight (kg)', s.weightKg, 'weightKg', 0.1) +
      numInput('s-height', 'Height (cm)', s.heightCm, 'heightCm', 1) +
      numInput('s-age', 'Age (years)', s.age, 'age', 1) +
      numInput('s-bf', 'Estimated body fat % (optional)', s.bodyFatPct, 'bodyFatPct', 0.5) +
      '</div><div class="row"><span class="label">Goal</span>' +
      seg('goalType', s.goalType, [['bf', 'Body fat %'], ['weight', 'Weight']]) +
      '<div style="width:170px">' + (s.goalType === 'bf'
        ? numInput('s-goalbf', 'Goal body fat %', s.goalBodyFatPct, 'goalBodyFatPct', 0.5)
        : numInput('s-goalkg', 'Goal weight (kg)', s.goalWeightKg, 'goalWeightKg', 0.1)) + '</div></div></div>'));

    h.push(block('Training and activity', '<div class="panel stack">' +
      '<div class="grid">' + numInput('s-steps', 'Typical daily steps', s.steps, 'steps', 100) +
      numInput('s-liftmin', 'Lifting session (min)', s.liftMinutes, 'liftMinutes', 5) +
      numInput('s-padelmin', 'Padel session (min)', s.padelMinutes, 'padelMinutes', 5) + '</div>' +
      '<div class="stack"><span class="label">Lifting days</span>' + dayPicker('liftDays', s.liftDays || []) + '</div>' +
      '<div class="stack"><span class="label">Padel days</span>' + dayPicker('padelDays', s.padelDays || []) + '</div></div>'));

    const satText = s.saturdayMode === 'offplan'
      ? 'Off-plan: Saturday breakfast and lunch are not on the grocery list. Log them yourself; they count against Saturday’s targets.'
      : 'Included: Saturday breakfast and lunch come from the meal plan and are on the grocery list.';
    h.push(block('Plan settings', '<div class="panel stack">' +
      '<div class="row"><span class="label" style="min-width:120px">Meals per day</span>' +
      seg('mealsPerDay', s.mealsPerDay, [[3, '3'], [4, '4'], [5, '5']]) + '</div>' +
      '<div class="row"><span class="label" style="min-width:120px">Saturday breakfast &amp; lunch</span>' +
      seg('saturdayMode', s.saturdayMode, [['offplan', 'Off-plan'], ['included', 'Included']]) + '</div>' +
      '<p class="note">' + esc(satText) + '</p>' +
      '<div class="row"><label class="field" for="s-start" style="max-width:220px">Program start (a Saturday; first diet week starts at dinner)' +
      '<input type="date" id="s-start" value="' + esc(s.programStart) + '"></label></div></div>'));

    h.push(renderCalculations(c));
    h.push(renderTimeline(c));
    h.push(renderFoodPicker(c));
    h.push(renderBackup(c));
    return h.join('');
  }

  function renderCalculations(c) {
    const s = state.setup;
    const bmr = E.calcBMR(s);
    const ex = E.calcExercise(s);
    const tdee = E.calcFormulaTDEE(s);
    const lbm = E.calcLeanMass(s);
    const prot = E.calcProtein(s);
    const ff = E.calcFatFloor(s.weightKg);
    const goal = E.calcGoalWeight(s);
    const thr = E.calcThresholdWeight(s);
    const rate = E.weeklyRate(s, s.weightKg);
    const def = E.dailyDeficit(val(rate), s.weightKg);
    const w1 = E.targetsForWeek(state, s.programStart);
    const fat22 = 0.22 * w1.kcal / 9;
    const rows = [
      ['BMR (Mifflin-St Jeor, men)', fmt(val(bmr)) + ' kcal', formulaText(bmr)],
      ['Exercise (average per day)', fmt(val(ex), 0) + ' kcal', formulaText(ex)],
      ['Starting TDEE (formula)', fmt(val(tdee)) + ' kcal', formulaText(tdee)],
      ['Lean mass', isNum(val(lbm)) ? fmt(val(lbm), 1) + ' kg' : 'no BF% given', formulaText(lbm)],
      ['Protein', fmt(val(prot)) + ' g', formulaText(prot)],
      ['Fat floor', fmt(val(ff)) + ' g', formulaText(ff)],
      ['Goal weight', fmt(val(goal), 1) + ' kg' + (goal && goal.estimated ? ' (estimated)' : ''), formulaText(goal)],
      ['15 % body-fat weight', isNum(val(thr)) ? fmt(val(thr), 1) + ' kg' : '–', formulaText(thr)],
      ['Weekly loss rate (cut)', fmt(val(rate) * 100, 2) + ' % / week', (rate && rate.reason) || ''],
      ['Daily deficit (cut)', fmt(val(def)) + ' kcal', formulaText(def)],
      ['Week-1 calorie target', fmt(w1.kcal) + ' kcal', (w1.explanation || []).join(' · ')],
      ['Week-1 fat', fmt(w1.fat) + ' g', 'Fat = max(22 % × ' + fmt(w1.kcal) + ' kcal / 9, 0.6 g × ' + fmt(s.weightKg, 1) + ' kg) = max(' +
        fmt(fat22, 1) + ', ' + fmt(val(ff), 1) + ') = ' + fmt(w1.fat, 1) + ' g'],
      ['Week-1 carbs', fmt(w1.carbs) + ' g', 'Carbs = (' + fmt(w1.kcal) + ' − 4 × ' + fmt(w1.protein, 1) + ' − 9 × ' + fmt(w1.fat, 1) + ') / 4 = ' + fmt(w1.carbs, 1) + ' g'],
      ['Calorie floor', fmt(val(bmr)) + ' kcal', 'Targets never go below BMR' + (w1.bmrFloorApplied ? ' (applied to week 1)' : '') + '. Protein is never reduced.']
    ];
    const body = '<div class="tscroll"><table><thead><tr><th>Number</th><th class="n">Value</th><th>Formula and inputs</th></tr></thead><tbody>' +
      rows.map(function (r) {
        return '<tr><td>' + esc(r[0]) + '</td><td class="n"><b>' + esc(r[1]) + '</b></td><td class="formula">' + esc(r[2]) + '</td></tr>';
      }).join('') + '</tbody></table></div>' +
      '<p class="note">Weeks 1–2 use this formula TDEE. From week 3 the weekly check-in uses your learned TDEE instead (see Weekly Check-in).</p>';
    return block('Starting calculations', body);
  }

  function renderTimeline(c) {
    const s = state.setup;
    const start = s.programStart;
    const grw = E.goalReachedWeek(state);
    const goal = val(E.calcGoalWeight(s));
    const horizon = E.addDays(start, 7 * 156);
    const line = E.targetLine(state, start, horizon) || [];
    const kgAt = {};
    line.forEach(function (p) { kgAt[p.date] = p.kg; });
    let goalDate = null;
    if (isNum(goal)) for (let i = 0; i < line.length; i++) { if (line[i].kg <= goal + 0.005) { goalDate = line[i].date; break; } }

    const blocks = [];
    for (let i = 0; i < 156 && blocks.length < 14; i++) {
      const w = E.addDays(start, 7 * i);
      const ph = E.phaseForWeek(start, w, grw);
      const last = blocks[blocks.length - 1];
      if (last && last.label === ph.label) continue;
      if (ph.type === 'final') { blocks.push({ label: ph.label, type: 'final', start: w }); break; }
      const b = { label: ph.label, type: ph.type, start: ph.blockStart, end: ph.blockEnd, length: ph.blockLength };
      blocks.push(b);
      if (goalDate && ph.blockEnd && goalDate <= ph.blockEnd) {
        // The check-in that sees the goal switches the next diet week to final maintenance, so this block stops there.
        const fw = E.nextSaturdayOnOrAfter(E.addDays(goalDate, 1));
        if (fw <= ph.blockEnd) { b.end = E.addDays(fw, -1); b.length = Math.round(E.daysBetween(b.start, fw) / 7); b.goalEnd = true; }
        blocks.push({ label: 'Final maintenance', type: 'final', start: fw, projected: true });
        break;
      }
    }
    const thisWeek = c.weekNow;
    const rows = blocks.map(function (b) {
      const now = b.start <= thisWeek && (!b.end || thisWeek <= b.end);
      const from = kgAt[b.start];
      // Weight after the block: the morning after its last Friday dinner.
      const to = b.goalEnd && isNum(goal) ? goal : b.end ? kgAt[E.addDays(b.end, 1)] : null;
      const dates = b.type === 'final'
        ? 'from ' + E.formatDate(b.start) + (b.projected ? ' (projected)' : '')
        : E.formatDate(b.start) + ' – ' + E.formatDate(b.end) + ' · ' + b.length + ' wk' + (b.goalEnd ? ' (goal reached, projected)' : '');
      const kg = b.type === 'final' ? (isNum(goal) ? 'goal ' + fmt(goal, 1) + ' kg' : '')
        : isNum(from) && isNum(to) ? fmt(from, 1) + ' → ' + fmt(to, 1) + ' kg' : '';
      return '<div class="t' + (now ? ' now' : '') + '"><span><b>' + esc(b.label) + '</b>' + (now ? ' <span class="chip accent">now</span>' : '') +
        '</span><span class="muted">' + esc(dates) + '</span><span class="num">' + esc(kg) + '</span></div>';
    }).join('');
    const note = '<p class="note">Cut blocks are 8 weeks, maintenance breaks 2 weeks and not skippable. Weights are the planned path ' +
      '(1.0 %/week above the 15 % body-fat weight, 0.75 %/week below it); the real path comes from your check-ins.</p>';
    return block('Program timeline', '<div class="panel timeline">' + rows + '</div>' + note);
  }

  function renderFoodPicker(c) {
    const s = state.setup;
    const q = ui.foodFilter.trim().toLowerCase();
    const liked = s.likedFoods || [];
    const excluded = s.excludedFoods || [];
    const groups = CAT_ORDER.map(function (cat) {
      const items = c.list.filter(function (f) {
        return f.category === cat && (!q || (f.name + ' ' + (f.nameNl || '')).toLowerCase().indexOf(q) >= 0);
      });
      if (!items.length) return '';
      return '<tr class="sub"><td colspan="7">' + CAT_LABEL[cat] + '</td></tr>' + items.map(function (f) {
        const pref = excluded.indexOf(f.id) >= 0 ? 'exclude' : liked.indexOf(f.id) >= 0 ? 'like' : 'neutral';
        const tri = '<div class="seg tri" role="group" aria-label="Preference for ' + esc(f.name) + '">' +
          [['like', 'Like'], ['neutral', '–'], ['exclude', 'Won’t eat']].map(function (o) {
            return '<button type="button" id="pref-' + esc(f.id) + '-' + o[0] + '" data-action="food-pref" data-food="' + esc(f.id) +
              '" data-v="' + o[0] + '" aria-pressed="' + String(pref === o[0]) + '">' + o[1] + '</button>';
          }).join('') + '</div>';
        const del = f.custom ? ' <button type="button" class="btn ghost" id="delcustom-' + esc(f.id) + '" data-action="delete-custom" data-food="' +
          esc(f.id) + '">Delete</button>' : '';
        return '<tr><td>' + esc(f.name) + (f.custom ? ' <span class="chip">custom</span>' : '') + '<span class="sub">' + esc(f.nameNl || '') +
          (f.unit ? ' · 1 ' + esc(f.unit.name) + ' = ' + fmt(f.unit.grams) + ' g' : '') + '</span>' +
          '<span class="sub show-sm">' + fmt(f.kcal) + ' kcal · P ' + fmt(f.protein, 1) + ' · C ' + fmt(f.carbs, 1) + ' · F ' + fmt(f.fat, 1) + ' · fibre ' + fmt(f.fibre, 1) + '</span>' + del +
          confirmBar('deleteCustom', f.id, 'Delete this custom food? It is removed from your liked foods and the plan.', 'Delete') +
          '</td><td class="n hide-sm">' + fmt(f.kcal) + '</td><td class="n hide-sm">' + fmt(f.protein, 1) + '</td><td class="n hide-sm">' + fmt(f.carbs, 1) +
          '</td><td class="n hide-sm">' + fmt(f.fat, 1) + '</td><td class="n hide-sm">' + fmt(f.fibre, 1) + '</td><td>' + tri + '</td></tr>';
      }).join('');
    }).join('');
    const likedCount = c.liked.length;
    const table = '<div class="tscroll"><table><thead><tr><th>Food (per 100 g)</th><th class="n hide-sm">kcal</th><th class="n hide-sm">Protein</th>' +
      '<th class="n hide-sm">Carbs</th><th class="n hide-sm">Fat</th><th class="n hide-sm">Fibre</th><th>Preference</th></tr></thead><tbody>' +
      (groups || '<tr><td colspan="7" class="muted">No food matches “' + esc(ui.foodFilter) + '”.</td></tr>') + '</tbody></table></div>';

    const cf = ui.custom;
    const customForm = '<details class="panel" id="cf-details"' + (ui.open['cf-details'] || ui.customErr ? ' open' : '') + '><summary><b>Add a custom food</b> <span class="muted small">(macros per 100 g)</span></summary>' +
      '<div class="stack" style="margin-top:10px">' + (ui.customErr ? '<div class="banner bad" role="alert">' + esc(ui.customErr) + '</div>' : '') +
      '<div class="grid">' +
      customField('cf-name', 'Name', 'name', 'text') +
      '<label class="field" for="cf-category">Category<select id="cf-category" data-custom="category">' + CAT_ORDER.map(function (k) {
        return '<option value="' + k + '"' + ((cf.category || 'protein') === k ? ' selected' : '') + '>' + CAT_LABEL[k] + '</option>';
      }).join('') + '</select></label>' +
      customField('cf-kcal', 'kcal', 'kcal') + customField('cf-protein', 'Protein (g)', 'protein') + customField('cf-carbs', 'Carbs (g)', 'carbs') +
      customField('cf-fat', 'Fat (g)', 'fat') + customField('cf-fibre', 'Fibre (g)', 'fibre') +
      customField('cf-unitg', 'Unit weight (g, optional)', 'unitGrams') + customField('cf-unitname', 'Unit name (optional)', 'unitName', 'text') +
      '</div><div class="row"><button type="button" class="btn primary" id="cf-add" data-action="add-custom">Add food</button>' +
      '<span class="muted small">New custom foods are marked as liked.</span></div></div></details>';

    const aside = '<span class="muted small">' + likedCount + ' liked · ' + (s.excludedFoods || []).length + ' excluded</span>';
    return block('Foods', '<p class="note">Pick the foods you like. The meal plan uses liked foods only; foods you won’t eat are excluded everywhere (plan, swaps, groceries).</p>' +
      '<div class="row"><input type="search" id="food-filter" placeholder="Filter foods" aria-label="Filter foods" value="' + esc(ui.foodFilter) + '" style="max-width:280px"></div>' +
      table + customForm, aside);
  }
  function customField(id, label, key, type) {
    const v = ui.custom[key] == null ? '' : ui.custom[key];
    return '<label class="field" for="' + id + '">' + esc(label) + '<input type="' + (type || 'number') + '" id="' + id + '" data-custom="' + key +
      '" value="' + esc(v) + '"' + (type ? '' : ' inputmode="decimal" step="any" min="0"') + '></label>';
  }

  function renderBackup() {
    const body = '<div class="panel stack"><p class="note">Download everything (setup, logs, check-ins, plan, product table) as one JSON file, or restore from one.</p>' +
      msg(ui.backupMsg) +
      confirmBar('importBackup', '', 'Replace all current data with the backup' + (ui.pendingBackup && ui.pendingBackup.name ? ' “' + ui.pendingBackup.name + '”' : '') + '?', 'Replace') +
      '<div class="row"><button type="button" class="btn" id="backup-export" data-action="backup-export">Export all data</button>' +
      '<button type="button" class="btn" id="backup-import" data-action="pick-file" data-target="file-backup">Import backup…</button></div>' +
      exportBox() + '</div>';
    return block('Backup', body);
  }

  function exportBox() {
    if (!ui.exportText) return '';
    return '<div class="stack"><p class="note">Downloads are not available in this view. Copy the JSON below and save it as <b>' + esc(ui.exportText.name) + '</b>.</p>' +
      '<textarea id="export-text" readonly>' + esc(ui.exportText.text) + '</textarea>' +
      '<div class="row"><button type="button" class="btn" id="copy-export" data-action="copy-export">Copy</button>' +
      '<button type="button" class="btn ghost" id="close-export" data-action="close-export">Close</button></div></div>';
  }

  // =====================================================================================
  // DAILY LOG
  // =====================================================================================
  function renderLog(c) {
    const date = (ui.logDraft && ui.logDraft.date) || c.today;
    if (!ui.logDraft || ui.logDraft.date !== date) resetDraft(date);
    const d = ui.logDraft;
    const T = E.targetsForWeek(state, E.weekStartOf(date));
    const h = [];

    const form = '<form id="log-form" class="panel stack" autocomplete="off" novalidate>' +
      '<div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(130px,1fr))">' +
      '<label class="field" for="log-date">Date<input type="date" id="log-date" value="' + esc(date) + '"></label>' +
      draftField('log-weight', 'Morning weight (kg)', 'weight') + draftField('log-kcal', 'Calories eaten', 'kcal') +
      draftField('log-protein', 'Protein eaten (g)', 'protein') + draftField('log-steps', 'Steps', 'steps') +
      '</div><div class="row"><button type="submit" class="btn primary" id="log-save">Save day</button>' +
      '<span class="muted small">Enter saves. Leave a field empty if you did not measure it.</span></div>' + msg(ui.logMsg) + '</form>';
    h.push(block('Log a day', form));

    const ph = T.phase || {};
    let tcard = '<div class="kv">' +
      kv('Targets for ' + E.formatDate(date), fmt(T.kcal) + ' kcal') + kv('Protein', fmt(T.protein) + ' g') +
      kv('Carbs', fmt(T.carbs) + ' g') + kv('Fat', fmt(T.fat) + ' g') + kv('Phase', esc(ph.label || '')) + '</div>';
    if (E.dayOfWeek(date) === 6 && state.setup.saturdayMode === 'offplan') tcard += saturdayBudget(c, date, T);
    if ((T.explanation || []).length) {
      tcard += '<details id="log-how"' + (ui.open['log-how'] ? ' open' : '') + '><summary class="small">Where these targets come from</summary><ul class="note">' +
        T.explanation.map(function (l) { return '<li>' + esc(l) + '</li>'; }).join('') + '</ul></details>';
    }
    h.push('<div class="panel stack">' + tcard + '</div>');

    // weeks table
    const weeks = [];
    for (let i = 0; i < ui.weeksShown; i++) weeks.push(E.addDays(c.weekNow, -7 * i));
    const rows = weeks.map(function (ws) { return weekRows(c, ws); }).join('');
    const table = '<div class="tscroll"><table><thead><tr><th>Day</th><th class="n">Weight</th><th class="n hide-sm">7-day avg</th><th class="n">kcal</th>' +
      '<th class="n">Protein</th><th class="n">Steps</th><th class="hide-sm"></th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
      '<div class="row"><button type="button" class="btn" id="log-more" data-action="log-more">Show an older week</button>' +
      (ui.weeksShown > 2 ? '<button type="button" class="btn ghost" id="log-less" data-action="log-less">Show fewer</button>' : '') + '</div>';
    h.push(block('Diet weeks', '<p class="note">Weeks run Saturday to Friday (diet week: Saturday dinner → Friday dinner). kcal is green within ±5 % of target, red above; protein green within 10 g of target.</p>' + table));
    return h.join('');
  }
  function kv(k, v) { return '<div><span class="label">' + esc(k) + '</span><span class="v">' + v + '</span></div>'; }
  function draftField(id, label, key) {
    const v = ui.logDraft[key];
    return '<label class="field" for="' + id + '">' + esc(label) + '<input type="number" id="' + id + '" data-draft="' + key + '" inputmode="decimal" step="any" min="0" value="' +
      esc(v == null ? '' : v) + '"></label>';
  }
  // The quick-entry form follows today unless the user picked another day; after saving a past day it returns to today.
  function resetDraft(date) {
    const e = (state.logs || {})[date] || {};
    ui.logDraft = { date: date, weight: e.weight, kcal: e.kcal, protein: e.protein, steps: e.steps, followToday: date === todayIso() };
  }
  function showDraftValues() {
    ['weight', 'kcal', 'protein', 'steps'].forEach(function (k) {
      const el = doc.getElementById('log-' + k);
      if (el) el.value = ui.logDraft[k] == null ? '' : ui.logDraft[k];
    });
  }
  function applyLogDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '') || (ui.logDraft && ui.logDraft.date === value)) return;
    resetDraft(value);
    showDraftValues();
    ui.logMsg = null;
    scheduleRender();
  }

  function saturdayBudget(c, date, T) {
    const p = planForWeek(c, E.weekStartOf(date));
    if (!p) return '<p class="note">Saturday breakfast and lunch are off-plan. Generate a meal plan to see how much of today’s target is left for them.</p>';
    const tot = M.planTotals(p.plan, c.foods);
    let kcal = 0, prot = 0;
    p.plan.meals.forEach(function (m) {
      if (m.key !== 'breakfast' && m.key !== 'lunch') { kcal += tot.meals[m.key].kcal; prot += tot.meals[m.key].protein; }
    });
    return '<div class="banner info">Saturday: breakfast and lunch are off-plan. Planned meals after lunch: <b>' + fmt(kcal) + ' kcal</b>, ' + fmt(prot) +
      ' g protein. Budget for your off-plan breakfast + lunch: <b>' + fmt(T.kcal - kcal) + ' kcal</b> and at least <b>' + fmt(Math.max(0, T.protein - prot)) + ' g protein</b>.</div>';
  }

  function weekRows(c, ws) {
    const T = E.targetsForWeek(state, ws);
    const avg = E.weekAverages(state.logs || {}, ws);
    const ph = T.phase || {};
    const head = '<tr class="sub"><td colspan="7">' + esc(E.formatRange(ws)) + ' · ' + esc(ph.label || '') +
      (ph.weekInBlock ? ' week ' + ph.weekInBlock + (ph.blockLength ? ' of ' + ph.blockLength : '') : '') +
      ' · target ' + fmt(T.kcal) + ' kcal / ' + fmt(T.protein) + ' g protein</td></tr>';
    const days = E.weekDays(ws).map(function (d) {
      const e = (state.logs || {})[d];
      const future = d > c.today;
      const tr = E.trailingAverage(state.logs || {}, d, 7);
      const kcalCls = e && isNum(e.kcal) ? (e.kcal > T.kcal * 1.05 ? 'over' : e.kcal >= T.kcal * 0.95 ? 'ok' : '') : '';
      const protCls = e && isNum(e.protein) ? (e.protein >= T.protein - 10 ? 'ok' : 'under') : '';
      const actions = e ? '<button type="button" class="btn ghost" id="log-edit-' + d + '" data-action="log-edit" data-date="' + d + '">Edit</button>' +
        '<button type="button" class="btn ghost danger" id="log-del-' + d + '" data-action="log-delete" data-date="' + d + '">Delete</button>'
        : (!future ? '<button type="button" class="btn ghost" id="log-add-' + d + '" data-action="log-edit" data-date="' + d + '">Add</button>' : '');
      const smActions = actions.replace(/id="log-(edit|del|add)-/g, 'id="log-$1-sm-');
      const row = '<tr' + (future ? ' class="muted"' : '') + '><td>' + esc(E.formatDate(d)) + (d === c.today ? ' <span class="chip accent">today</span>' : '') +
        (smActions ? '<span class="sub show-sm">' + smActions + '</span>' : '') +
        '</td><td class="n">' + (e && isNum(e.weight) ? fmt(e.weight, 1) : '') + '</td><td class="n muted hide-sm">' +
        (e && isNum(e.weight) && tr && tr.count >= 3 ? fmt(tr.avg, 1) : '') + '</td><td class="n ' + kcalCls + '">' + (e && isNum(e.kcal) ? fmt(e.kcal) : '') +
        '</td><td class="n ' + protCls + '">' + (e && isNum(e.protein) ? fmt(e.protein) : '') + '</td><td class="n">' + (e && isNum(e.steps) ? fmt(e.steps) : '') +
        '</td><td class="n hide-sm">' + actions + '</td></tr>';
      const conf = ui.confirm && ui.confirm.kind === 'deleteLog' && ui.confirm.key === d
        ? '<tr><td colspan="7">' + confirmBar('deleteLog', d, 'Delete the entry for ' + E.formatDate(d) + '?', 'Delete') + '</td></tr>' : '';
      return row + conf;
    }).join('');
    const foot = '<tr class="total"><td>Average</td><td class="n">' + (isNum(avg.avgWeight) ? fmt(avg.avgWeight, 2) : '–') +
      ' <span class="muted xs">(' + avg.weighIns + '/7)</span></td><td class="hide-sm"></td><td class="n">' + (isNum(avg.avgKcal) ? fmt(avg.avgKcal) : '–') +
      ' <span class="muted xs">(' + avg.intakeDays + '/7)</span></td><td class="n">' + (isNum(avg.avgProtein) ? fmt(avg.avgProtein) : '–') +
      '</td><td class="n">' + (isNum(avg.avgSteps) ? fmt(avg.avgSteps) : '–') + '</td><td class="hide-sm"></td></tr>';
    return head + days + foot;
  }

  function saveLog() {
    const read = function (id) { const el = doc.getElementById(id); return el ? parseNum(el.value) : null; };
    const dateEl = doc.getElementById('log-date');
    const date = dateEl && dateEl.value;
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) { ui.logMsg = { kind: 'bad', text: 'Pick a date first.' }; return scheduleRender(); }
    const entry = { weight: read('log-weight'), kcal: read('log-kcal'), protein: read('log-protein'), steps: read('log-steps') };
    const bad = Object.keys(entry).filter(function (k) { return Number.isNaN(entry[k]) || (isNum(entry[k]) && entry[k] < 0); });
    if (bad.length) { ui.logMsg = { kind: 'bad', text: 'Check ' + bad.join(', ') + ': use numbers only.' }; return scheduleRender(); }
    if (isNum(entry.weight) && (entry.weight < 30 || entry.weight > 300)) { ui.logMsg = { kind: 'bad', text: 'Weight must be between 30 and 300 kg.' }; return scheduleRender(); }
    if (isNum(entry.kcal) && entry.kcal > 10000) { ui.logMsg = { kind: 'bad', text: 'Calories look too high (over 10,000). Check the number.' }; return scheduleRender(); }
    state.logs = state.logs || {};
    const empty = ['weight', 'kcal', 'protein', 'steps'].every(function (k) { return entry[k] == null; });
    if (empty) {
      if (state.logs[date]) { delete state.logs[date]; ui.logMsg = { kind: 'good', text: 'Cleared ' + E.formatDate(date) + '.' }; }
      else { ui.logMsg = { kind: 'warn', text: 'Nothing to save: all fields are empty.' }; return scheduleRender(); }
    } else {
      state.logs[date] = entry;
      ui.logMsg = { kind: 'good', text: 'Saved ' + E.formatDate(date) + '.' };
    }
    const today = todayIso();
    if (date !== today) ui.logMsg.text += ' The form is back on today.';
    resetDraft(today);
    showDraftValues();
    const dEl = doc.getElementById('log-date');
    if (dEl && doc.activeElement !== dEl) dEl.value = today;
    commit('logs');
  }

  // =====================================================================================
  // WEEKLY CHECK-IN
  // =====================================================================================
  // The week the check-in tab opens on: the engine's due week, else this week on a Friday, else last week.
  function dueWeek(c) {
    const sum = E.programSummary(state, c.today);
    if (sum.checkinDue) return sum.checkinDue.weekStart;
    return E.dayOfWeek(c.today) === 5 ? c.weekNow : E.addDays(c.weekNow, -7);
  }

  function renderCheckin(c) {
    const due = dueWeek(c);
    const week = ui.checkinWeek || due;
    const saved = (state.checkins || {})[week] || null;
    const rec = E.computeCheckin(state, week);
    const h = [];

    // due banner
    const ps = state.setup.programStart;
    const saved_ = state.checkins || {};
    const isFri = E.dayOfWeek(c.today) === 5;
    const lastWeek = E.addDays(c.weekNow, -7);
    const sum = E.programSummary(state, c.today);
    let banner;
    if (c.today < ps) {
      banner = '<div class="banner">The program starts ' + esc(E.formatDate(ps)) + ' at dinner; the first check-in is ' + esc(E.formatDate(E.addDays(ps, 6))) +
        '. Weights you log before then give the first check-in its baseline week. Week-1 targets come from Setup.</div>';
    } else if (isFri && !saved_[c.weekNow]) {
      banner = '<div class="banner warn"><b>Check-in due today.</b> Log this morning’s weight first, then save the check-in before the grocery trip. New targets apply from Saturday dinner.' +
        (lastWeek >= ps && !saved_[lastWeek] ? ' Last week’s check-in (' + esc(E.formatRange(lastWeek)) + ') was not saved: save that one first so this week builds on it.' : '') + '</div>';
    } else if (sum.checkinDue) {
      banner = '<div class="banner warn">The check-in for ' + esc(E.formatRange(sum.checkinDue.weekStart)) + ' was not saved. Save it now; its targets apply to the diet week after it.</div>';
    } else {
      banner = '<div class="banner">Next check-in: <b>' + esc(E.formatDate(sum.nextCheckinDate)) + '</b>, morning, after the weigh-in.</div>';
    }
    h.push(banner);
    const baseline = week < ps;

    // week picker
    const options = [];
    const first = E.addDays(state.setup.programStart, -7);
    const newest = E.dayOfWeek(c.today) === 5 ? c.weekNow : E.addDays(c.weekNow, -7);
    for (let w = newest; w >= first && options.length < 60; w = E.addDays(w, -7)) options.push(w);
    if (options.indexOf(week) < 0) options.unshift(week);
    const picker = '<label class="field" for="ci-week" style="max-width:340px">Week (Saturday – Friday)<select id="ci-week">' + options.map(function (w) {
      return '<option value="' + w + '"' + (w === week ? ' selected' : '') + '>' + esc(E.formatRange(w)) + (w < ps ? ' · baseline' : '') + ((state.checkins || {})[w] ? ' · saved' : '') + '</option>';
    }).join('') + '</select></label>';

    const cur = rec.cur || {}, prev = rec.prev || {};
    const avgTable = '<div class="tscroll"><table><thead><tr><th></th><th class="n">Previous week<span class="sub">' + esc(E.formatRange(E.addDays(week, -7))) +
      '</span></th><th class="n">This week<span class="sub">' + esc(E.formatRange(week)) + '</span></th><th class="n">Change</th></tr></thead><tbody>' +
      avgRow('7-day average weight', prev.avgWeight, cur.avgWeight, 2, ' kg') +
      countRow('Weigh-ins', prev.weighIns, cur.weighIns) +
      avgRow('Average intake', prev.avgKcal, cur.avgKcal, 0, ' kcal') +
      countRow('Days with calories logged', prev.intakeDays, cur.intakeDays) +
      avgRow('Average protein', prev.avgProtein, cur.avgProtein, 0, ' g') +
      avgRow('Average steps', prev.avgSteps, cur.avgSteps, 0, '') +
      '</tbody></table></div>';

    const lines = [];
    if (!rec.valid) {
      lines.push('<div class="banner warn">Not enough data for an adaptive update: each week needs at least 4 weigh-ins and this week at least 1 day of logged calories. ' +
        'Targets carry over unchanged (a scheduled phase change still happens).</div>');
    }
    const tdeeRows = [];
    if (rec.valid) {
      tdeeRows.push(['Observed TDEE', fmt(rec.observedTDEE) + ' kcal', 'avg intake − Δ avg weight × 7700 / 7 = ' + fmt(cur.avgKcal) + ' − (' + signed(rec.deltaKg, 2) +
        ' kg × 1100) = ' + fmt(rec.observedTDEE) + ' kcal']);
    }
    tdeeRows.push(['Learned TDEE', fmt(rec.learnedAfter) + ' kcal', rec.applied
      ? '0.7 × ' + fmt(rec.learnedBefore) + ' (previous) + 0.3 × ' + fmt(rec.observedTDEE) + ' (observed) = ' + fmt(rec.learnedAfter) + ' kcal'
      : 'Held at ' + fmt(rec.learnedBefore) + ' kcal (no update this week)']);
    tdeeRows.push(['Formula TDEE', fmt(rec.formulaTDEE) + ' kcal', 'From Setup; used for program weeks 1–2']);
    tdeeRows.push(['Used for next week', rec.tdeeUsedForNext === 'formula' ? 'formula' : 'learned', rec.tdeeUsedForNext === 'formula'
      ? 'Next week is program week ' + (E.programWeekIndex(state.setup.programStart, E.addDays(week, 7)) + 1) + ': the formula estimate is used for weeks 1–2'
      : 'From program week 3 the learned value drives the targets']);
    if (rec.targetLossKg > 0) {
      tdeeRows.push(['Weight loss vs target', rec.valid ? fmt(rec.actualLossKg, 2) + ' of ' + fmt(rec.targetLossKg, 2) + ' kg' : '–',
        rec.valid ? fmt(rec.lossRatio * 100, 0) + ' % of target' + (rec.belowTarget ? ' — below 70 %' : '') : '']);
    }
    const tdeeTable = '<div class="tscroll"><table><tbody>' + tdeeRows.map(function (r) {
      return '<tr><td>' + esc(r[0]) + '</td><td class="n"><b>' + esc(r[1]) + '</b></td><td class="formula">' + esc(r[2]) + '</td></tr>';
    }).join('') + '</tbody></table></div>';

    let diag = '';
    if (rec.stall) {
      const cls = rec.diagnosis === 'adaptation' ? 'warn' : 'bad';
      diag = '<div class="banner ' + cls + '"><b>Stall: loss below 70 % of target for 2 weeks' +
        (rec.prevBelowTargetSource === 'logs' ? ' (last week worked out from your logs; its check-in was not saved)' : '') + '.</b> <span class="chip ' + cls + '">' + esc(rec.diagnosisText) + '</span> ' +
        (rec.diagnosis === 'neat' ? 'Average steps ' + fmt(cur.avgSteps) + ' vs ' + fmt(state.setup.steps) + ' in Setup. Targets are not cut this week.'
          : rec.diagnosis === 'tracking' ? 'Only ' + cur.intakeDays + ' of 7 days logged. Targets are not changed until tracking is complete.'
            : 'The adjustment below is applied.') + '</div>';
    } else if (rec.belowTarget) {
      diag = '<div class="banner">Loss was below 70 % of target this week. A stall is flagged only after 2 weeks in a row.</div>';
    }
    if (rec.goalReached) diag += '<div class="banner good"><b>Goal weight reached.</b> Final maintenance starts next diet week.</div>';

    const nowT = E.targetsForWeek(state, week);
    const nx = rec.next || {};
    const nextWeek = E.addDays(week, 7);
    const newT = '<div class="tscroll"><table><thead><tr><th></th><th class="n">Current<span class="sub">' + esc(E.formatRange(week)) + '</span></th><th class="n">New<span class="sub">from ' +
      esc(E.formatDate(nextWeek)) + ' dinner</span></th><th class="n">Change</th></tr></thead><tbody>' +
      changeRow('Calories', nowT.kcal, nx.kcal, ' kcal') + changeRow('Protein', nowT.protein, nx.protein, ' g') +
      changeRow('Carbs', nowT.carbs, nx.carbs, ' g') + changeRow('Fat', nowT.fat, nx.fat, ' g') +
      '<tr><td>Phase</td><td class="n">' + esc((nowT.phase || {}).label || '') + '</td><td class="n">' + esc((nx.phase || {}).label || '') + '</td><td></td></tr>' +
      '</tbody></table></div>';
    // The engine's notes explain the observed/learned TDEE, cap, transition and macro split; add what they leave out.
    const notes = (rec.notes || []).slice();
    const said = notes.join(' ').toLowerCase();
    if (nx.deficit && said.indexOf('deficit ' + fmt(nx.deficit).toLowerCase()) < 0) {
      notes.unshift('Deficit ' + fmt(nx.deficit) + ' kcal/day = ' + fmt((nx.rate || 0) * 100, 2) + ' % × ' + fmt(nx.weightUsed, 1) + ' kg × 7700 / 7.');
    }
    if (rec.capped && said.indexOf('cap') < 0) notes.push('The change was capped at ±200 kcal for this week.');
    if (nx.bmrFloorApplied && said.indexOf('bmr') < 0) notes.push('Raised to the calorie floor (BMR).');

    const savedLine = saved ? '<span class="chip good">Saved' + (saved.computedOn ? ' ' + esc(E.formatDate(saved.computedOn)) : '') + '</span>' : '<span class="chip warn">Not saved</span>';
    const changedSinceSave = saved && JSON.stringify(stripMeta(saved)) !== JSON.stringify(stripMeta(rec));
    const saveBtn = '<div class="row"><button type="button" class="btn primary" id="ci-save" data-action="checkin-save">' + (saved ? 'Save again with current logs' : 'Save check-in') + '</button>' +
      savedLine + (changedSinceSave ? '<span class="muted small">Your logs changed since this check-in was saved.</span>' : '') + '</div>' + msg(ui.checkinMsg);

    if (baseline) {
      h.push(block('Check-in', '<div class="row">' + picker + '</div>' + avgTable +
        '<p class="note">This is the week before the program starts. Its averages are the baseline that week 1’s check-in compares against; ' +
        'week-1 targets come from Setup, so nothing here changes your targets.</p>'));
      h.push(block('Weight trend', weightChart(c)));
      h.push(block('History', historyTable()));
      return h.join('');
    }
    h.push(block('Check-in', '<div class="row">' + picker + '</div>' + avgTable + lines.join('') + tdeeTable + diag +
      '<h3>New targets</h3>' + newT + (notes.length ? '<ul class="note">' + notes.map(function (n) { return '<li>' + esc(n) + '</li>'; }).join('') + '</ul>' : '') + saveBtn));
    h.push(block('Weight trend', weightChart(c)));
    h.push(block('History', historyTable()));
    return h.join('');
  }
  function stripMeta(r) { const x = clone(r); delete x.computedOn; return x; }
  function avgRow(label, a, b, d, unit) {
    const diff = isNum(a) && isNum(b) ? b - a : null;
    return '<tr><td>' + esc(label) + '</td><td class="n">' + (isNum(a) ? fmt(a, d) + unit : '–') + '</td><td class="n">' + (isNum(b) ? fmt(b, d) + unit : '–') +
      '</td><td class="n">' + (isNum(diff) ? signed(diff, d) + unit : '') + '</td></tr>';
  }
  function countRow(label, a, b) {
    return '<tr><td>' + esc(label) + '</td><td class="n">' + (a == null ? '–' : a + ' / 7') + '</td><td class="n">' + (b == null ? '–' : b + ' / 7') + '</td><td></td></tr>';
  }
  function changeRow(label, a, b, unit) {
    return '<tr><td>' + esc(label) + '</td><td class="n">' + fmt(a) + unit + '</td><td class="n"><b>' + fmt(b) + unit + '</b></td><td class="n">' +
      (isNum(a) && isNum(b) ? signed(b - a, 0) + unit : '') + '</td></tr>';
  }

  function historyTable() {
    const recs = Object.keys(state.checkins || {}).sort().reverse().map(function (k) { return state.checkins[k]; });
    if (!recs.length) return '<p class="note">No check-ins saved yet.</p>';
    return '<div class="tscroll"><table><thead><tr><th>Week</th><th class="n">Avg weight</th><th class="n">Δ</th><th class="n">Avg kcal</th>' +
      '<th class="n">Observed TDEE</th><th class="n">Learned TDEE</th><th class="n">Next kcal</th><th>Result</th></tr></thead><tbody>' +
      recs.map(function (r) {
        const cur = r.cur || {};
        const res = !r.valid ? '<span class="chip">not enough data</span>'
          : r.stall ? '<span class="chip ' + (r.applied ? 'warn' : 'bad') + '">' + esc(r.diagnosisText) + '</span>'
            : r.goalReached ? '<span class="chip good">goal reached</span>'
              : r.belowTarget ? '<span class="chip warn">below 70 % of target (' + fmt(r.lossRatio * 100) + ' %)</span>'
                : r.targetLossKg > 0 ? '<span class="chip good">on track (' + fmt(r.lossRatio * 100) + ' %)</span>' : '<span class="chip good">maintenance</span>';
        return '<tr><td>' + esc(E.formatRange(r.weekStart)) + '</td><td class="n">' + fmt(cur.avgWeight, 2) + '</td><td class="n">' + signed(r.deltaKg, 2) +
          '</td><td class="n">' + fmt(cur.avgKcal) + '</td><td class="n">' + fmt(r.observedTDEE) + '</td><td class="n">' + fmt(r.learnedAfter) +
          '</td><td class="n">' + fmt(r.next && r.next.kcal) + '</td><td>' + res + '</td></tr>';
      }).join('') + '</tbody></table></div>';
  }

  function weightChart(c) {
    const logs = state.logs || {};
    const start = state.setup.programStart;
    const dates = Object.keys(logs).filter(function (d) { return logs[d] && isNum(logs[d].weight); }).sort();
    let from = E.addDays(start, -7);
    if (dates.length && dates[0] < from) from = dates[0];
    let to = dates.length ? (dates[dates.length - 1] > c.today ? dates[dates.length - 1] : c.today) : E.addDays(start, 56);
    to = E.addDays(to, 7);
    if (to < E.addDays(from, 28)) to = E.addDays(from, 28);
    const span = E.daysBetween(from, to);

    const pts = dates.filter(function (d) { return d >= from && d <= to; }).map(function (d) { return { d: d, v: logs[d].weight }; });
    const avg = [];
    if (dates.length) {
      for (let d = dates[0]; d <= dates[dates.length - 1]; d = E.addDays(d, 1)) {
        const t = E.trailingAverage(logs, d, 7);
        if (t && t.count >= 3) avg.push({ d: d, v: t.avg });
      }
    }
    const target = (E.targetLine(state, from, to) || []).map(function (p) { return { d: p.date, v: p.kg }; });
    const goal = val(E.calcGoalWeight(state.setup));

    const vals = pts.map(function (p) { return p.v; }).concat(avg.map(function (p) { return p.v; }), target.map(function (p) { return p.v; }));
    if (!vals.length) vals.push(state.setup.weightKg);
    let lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
    const showGoal = isNum(goal) && goal >= lo - 2 && goal <= hi + 2;
    if (showGoal) { lo = Math.min(lo, goal); hi = Math.max(hi, goal); }
    lo -= 0.4; hi += 0.4;
    const range = hi - lo;
    const step = [0.5, 1, 2, 5, 10].filter(function (s) { return range / s <= 7; })[0] || 10;
    lo = Math.floor(lo / step) * step; hi = Math.ceil(hi / step) * step;

    const W = 720, H = 280, L = 46, R = 14, T = 12, B = 30;
    const x = function (d) { return L + (E.daysBetween(from, d) / span) * (W - L - R); };
    const y = function (v) { return T + (hi - v) / (hi - lo) * (H - T - B); };
    const parts = [];
    for (let v = lo; v <= hi + 1e-9; v += step) {
      parts.push('<line class="c-grid" x1="' + L + '" x2="' + (W - R) + '" y1="' + y(v).toFixed(1) + '" y2="' + y(v).toFixed(1) + '"/>');
      parts.push('<text x="' + (L - 6) + '" y="' + (y(v) + 4).toFixed(1) + '" text-anchor="end">' + fmt(v, step < 1 ? 1 : 0) + '</text>');
    }
    const sats = [];
    for (let d = E.nextSaturdayOnOrAfter(from); d <= to; d = E.addDays(d, 7)) sats.push(d);
    const every = Math.max(1, Math.ceil(sats.length / 7));
    sats.forEach(function (d, i) {
      if (i % every) return;
      parts.push('<line class="c-grid" x1="' + x(d).toFixed(1) + '" x2="' + x(d).toFixed(1) + '" y1="' + T + '" y2="' + (H - B) + '"/>');
      parts.push('<text x="' + x(d).toFixed(1) + '" y="' + (H - B + 16) + '" text-anchor="middle">' + esc(E.formatDate(d).slice(4)) + '</text>');
    });
    if (showGoal) {
      parts.push('<line class="c-goal" x1="' + L + '" x2="' + (W - R) + '" y1="' + y(goal).toFixed(1) + '" y2="' + y(goal).toFixed(1) + '"/>');
    }
    const path = function (arr) {
      return arr.map(function (p, i) { return (i ? 'L' : 'M') + x(p.d).toFixed(1) + ' ' + y(p.v).toFixed(1); }).join(' ');
    };
    if (target.length) parts.push('<path class="c-target" d="' + path(target) + '"/>');
    if (avg.length) parts.push('<path class="c-avg" d="' + path(avg) + '"/>');
    pts.forEach(function (p) { parts.push('<circle class="c-dot" cx="' + x(p.d).toFixed(1) + '" cy="' + y(p.v).toFixed(1) + '" r="2.6"><title>' + esc(E.formatDate(p.d)) + ': ' + fmt(p.v, 1) + ' kg</title></circle>'); });
    if (c.today >= from && c.today <= to) {
      parts.push('<line class="c-today" x1="' + x(c.today).toFixed(1) + '" x2="' + x(c.today).toFixed(1) + '" y1="' + T + '" y2="' + (H - B) + '"/>');
    }
    const svg = '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Daily weight, 7-day average and target line">' + parts.join('') + '</svg>';
    const legend = '<div class="legend"><span><i class="lg-dot"></i>Daily weight</span><span><i style="border-color:var(--chart-avg)"></i>7-day average</span>' +
      '<span><i style="border-color:var(--chart-target);border-top-style:dashed"></i>Target line</span>' +
      (isNum(goal) ? '<span><i style="border-color:var(--chart-goal)"></i>Goal ' + fmt(goal, 1) + ' kg' + (showGoal ? '' : ' (below the chart)') + '</span>' : '') + '</div>';
    const empty = pts.length ? '' : '<p class="note">No weights logged yet. Log morning weights on the Daily Log tab; the target line shows the planned path.</p>';
    return '<div class="panel stack">' + svg + legend + empty + '</div>';
  }

  // =====================================================================================
  // MEAL PLAN
  // =====================================================================================
  function renderPlan(c) {
    const week = ui.planWeek === 'next' ? E.addDays(c.weekNow, 7) : c.weekNow;
    const T = E.targetsForWeek(state, week);
    const h = [];
    const weekSeg = '<div class="seg" role="group">' +
      '<button type="button" id="plan-week-this" data-action="plan-week" data-value="this" aria-pressed="' + String(ui.planWeek !== 'next') + '">This week · ' + esc(E.formatRange(c.weekNow)) + '</button>' +
      '<button type="button" id="plan-week-next" data-action="plan-week" data-value="next" aria-pressed="' + String(ui.planWeek === 'next') + '">Next week · from ' + esc(E.formatDate(E.addDays(c.weekNow, 7))) + ' dinner</button></div>';
    h.push('<div class="row">' + weekSeg + '</div>');
    if (ui.planWeek === 'next' && T.source !== 'checkin' && !(state.checkins || {})[c.weekNow] && E.programWeekIndex(state.setup.programStart, week) > 0) {
      h.push('<div class="banner">Provisional: next week’s targets are set by Friday’s check-in. Amounts will update when you save it.</div>');
    }

    if (!state.plan || !state.plan.base) {
      h.push(block('Meal plan', '<div class="panel stack"><p class="note">One fixed day, eaten every day, built only from your liked foods. Each meal is one protein food, one carb food and vegetables or fruit, ' +
        'with a fat source when needed. Grams are solved to hit ' + fmt(T.kcal) + ' kcal (±5 %) and ' + fmt(T.protein) + ' g protein (±10 g), with at least 2 vegetables, 1 fruit and 25 g fibre.</p>' +
        '<div class="row"><button type="button" class="btn primary" id="plan-generate" data-action="plan-generate">Generate plan</button><span class="muted small">' + c.liked.length + ' liked foods · ' +
        state.setup.mealsPerDay + ' meals per day</span></div>' + msg(ui.planMsg) + '</div>'));
      return h.join('');
    }

    const p = planForWeek(c, week);
    const plan = p.plan;
    const tot = M.planTotals(plan, c.foods);
    const chk = M.checkPlan(plan, c.foods, macros(T));
    const warnings = [];
    if (plan.mealsPerDay !== state.setup.mealsPerDay) warnings.push('Your plan has ' + plan.mealsPerDay + ' meals but Setup says ' + state.setup.mealsPerDay + '. Regenerate to apply it.');
    const bad = [];
    plan.meals.forEach(function (m) { m.items.forEach(function (it) { if (c.liked.indexOf(it.foodId) < 0) bad.push(c.foods[it.foodId] ? c.foods[it.foodId].name : it.foodId); }); });
    if (bad.length) warnings.push('The plan contains foods that are no longer liked or are excluded: ' + unique(bad).join(', ') + '. Swap them or regenerate.');
    (plan.warnings || []).forEach(function (w) { warnings.push(w); });

    // summary
    const d = tot.day;
    const summ = '<div class="tscroll"><table><thead><tr><th></th><th class="n">Target</th><th class="n">Plan</th><th class="n">Difference</th><th>Check</th></tr></thead><tbody>' +
      sumRow('Calories', T.kcal, d.kcal, ' kcal', Math.abs(chk.kcalDiffPct) <= 5, fmt(chk.kcalDiffPct, 1) + ' % (limit ±5 %)') +
      sumRow('Protein', T.protein, d.protein, ' g', Math.abs(chk.proteinDiffG) <= 10, signed(chk.proteinDiffG, 0) + ' g (limit ±10 g)') +
      sumRow('Carbs', T.carbs, d.carbs, ' g', null, '') +
      sumRow('Fat', T.fat, d.fat, ' g', null, '') +
      sumRow('Fibre', 25, d.fibre, ' g', d.fibre >= 25, 'at least 25 g') +
      '<tr><td>Vegetables / fruit</td><td class="n">≥ 2 / ≥ 1</td><td class="n">' + chk.vegCount + ' / ' + chk.fruitCount + '</td><td></td><td>' +
      okChip(chk.vegCount >= 2 && chk.fruitCount >= 1, 'different vegetables / fruit') + '</td></tr></tbody></table></div>';

    const actions = '<div class="row"><button type="button" class="btn" id="plan-regenerate" data-action="plan-regenerate">Regenerate plan</button>' +
      '<span class="muted small">Generated for ' + esc(E.formatRange(state.plan.weekGenerated || week)) + '. Weekly target changes only rescale grams (carbs first, then fat).</span></div>' +
      confirmBar('regen', '', 'Replace the current meals, including your swaps, with a newly generated plan?', 'Regenerate');

    h.push(block('Day totals · ' + E.formatRange(week), (warnings.length ? '<div class="banner warn"><ul class="note" style="margin:0;padding-left:18px">' +
      warnings.map(function (w) { return '<li>' + esc(w) + '</li>'; }).join('') + '</ul></div>' : '') + summ + actions + msg(ui.planMsg)));

    // meals
    const meals = plan.meals.map(function (m) {
      const mt = tot.meals[m.key];
      const rows = m.items.map(function (it, idx) {
        const f = c.foods[it.foodId] || { name: it.foodId, kcal: 0, protein: 0, carbs: 0, fat: 0, fibre: 0 };
        const k = it.grams / 100;
        const cands = M.swapCandidates(plan, c.foods, c.liked, c.excluded, m.key, idx);
        const swap = cands.length ? '<select id="swap-' + m.key + '-' + idx + '" data-swap="1" data-meal="' + m.key + '" data-idx="' + idx + '" aria-label="Swap ' + esc(f.name) + '">' +
          '<option value="">Swap…</option>' + cands.map(function (id) { return '<option value="' + esc(id) + '">' + esc(c.foods[id].name) + '</option>'; }).join('') + '</select>'
          : '<span class="muted xs">no alternative liked</span>';
        return '<tr><td><span class="role">' + esc(ROLE_LABEL[it.role] || it.role) + '</span></td><td>' + esc(f.name) + '<span class="sub">' + esc(f.nameNl || '') + '</span></td><td class="n">' + amountText(f, it.grams) +
          '</td><td class="n">' + fmt(f.kcal * k) + '</td><td class="n">' + fmt(f.protein * k, 1) + '</td><td class="n">' + fmt(f.carbs * k, 1) + '</td><td class="n">' + fmt(f.fat * k, 1) +
          '</td><td class="n">' + fmt(f.fibre * k, 1) + '</td><td>' + swap + '</td></tr>';
      }).join('');
      const occ = G.mealOccurrences(m.key, state.setup.saturdayMode);
      return '<div class="tscroll"><div class="meal-head"><h3>' + esc(m.name) + '</h3><span class="muted small">' + fmt(m.share * 100) + ' % of the day · ' + occ + '× in the grocery week</span></div>' +
        '<table><thead><tr><th>Role</th><th>Food</th><th class="n">Amount</th><th class="n">kcal</th><th class="n">P</th><th class="n">C</th><th class="n">F</th><th class="n">Fibre</th><th>Swap</th></tr></thead><tbody>' +
        rows + '</tbody><tfoot><tr><td></td><td>Meal total</td><td></td><td class="n">' + fmt(mt.kcal) + '</td><td class="n">' + fmt(mt.protein, 1) + '</td><td class="n">' + fmt(mt.carbs, 1) +
        '</td><td class="n">' + fmt(mt.fat, 1) + '</td><td class="n">' + fmt(mt.fibre, 1) + '</td><td></td></tr></tfoot></table></div>';
    }).join('');
    const dayTotal = '<div class="tscroll"><table><tbody><tr class="total"><td>Day total</td><td class="n">' + fmt(d.kcal) + ' kcal</td><td class="n">P ' + fmt(d.protein, 1) + ' g</td><td class="n">C ' +
      fmt(d.carbs, 1) + ' g</td><td class="n">F ' + fmt(d.fat, 1) + ' g</td><td class="n">Fibre ' + fmt(d.fibre, 1) + ' g</td></tr></tbody></table></div>';
    h.push(block('Meals', '<div class="meals">' + meals + dayTotal + '</div>'));

    // changes vs last week: against the plan recorded for that week when there is one
    const prevWeek = E.addDays(week, -7);
    const prevT = E.targetsForWeek(state, prevWeek);
    const recorded = (state.plan.history || {})[prevWeek];
    const prevPlan = recorded ? { meals: recorded } : M.rescalePlan(state.plan.base, c.foods, macros(prevT)).plan;
    h.push(block('Changes vs last week', planDiff(c, prevPlan, plan, prevT, T, !recorded)));
    return h.join('');
  }
  function unique(a) { return a.filter(function (x, i) { return a.indexOf(x) === i; }); }
  function okChip(ok, text) { return '<span class="chip ' + (ok ? 'good' : 'bad') + '">' + (ok ? '✓ ' : '✗ ') + esc(text) + '</span>'; }
  function sumRow(label, target, actual, unit, ok, text) {
    return '<tr><td>' + esc(label) + '</td><td class="n">' + fmt(target) + unit + '</td><td class="n">' + fmt(actual) + unit + '</td><td class="n">' + signed(actual - target, 0) + unit +
      '</td><td>' + (ok == null ? '' : okChip(ok, text)) + '</td></tr>';
  }
  function planDiff(c, a, b, ta, tb, estimated) {
    const name = function (id) { return (c.foods[id] || {}).name || id; };
    const lines = [];
    b.meals.forEach(function (m) {
      const pm = a.meals.filter(function (x) { return x.key === m.key; })[0];
      if (!pm) { lines.push(m.name + ': new meal'); return; }
      m.items.forEach(function (it, ii) {
        const old = pm.items[ii];
        if (!old) { lines.push(m.name + ': ' + name(it.foodId) + ' ' + fmt(it.grams) + ' g (new)'); return; }
        if (old.foodId !== it.foodId) { lines.push(m.name + ': ' + name(old.foodId) + ' ' + fmt(old.grams) + ' g → ' + name(it.foodId) + ' ' + fmt(it.grams) + ' g'); return; }
        if (old.grams !== it.grams) lines.push(m.name + ': ' + name(it.foodId) + ' ' + fmt(old.grams) + ' g → ' + fmt(it.grams) + ' g (' + signed(it.grams - old.grams, 0) + ' g)');
      });
      pm.items.slice(m.items.length).forEach(function (old) { lines.push(m.name + ': ' + name(old.foodId) + ' removed'); });
    });
    a.meals.forEach(function (pm) {
      if (!b.meals.some(function (m) { return m.key === pm.key; })) lines.push((pm.name || pm.key) + ': meal removed');
    });
    const head = '<p class="note">Targets ' + fmt(ta.kcal) + ' → ' + fmt(tb.kcal) + ' kcal (' + signed(tb.kcal - ta.kcal, 0) + '), carbs ' + fmt(ta.carbs) + ' → ' + fmt(tb.carbs) +
      ' g, fat ' + fmt(ta.fat) + ' → ' + fmt(tb.fat) + ' g, protein ' + fmt(ta.protein) + ' → ' + fmt(tb.protein) + ' g.' +
      (estimated ? ' Last week’s plan was not recorded, so it is estimated from the current meals at last week’s targets.' : '') + '</p>';
    if (!lines.length) return head + '<p class="note">No changes: same foods, same amounts.</p>';
    return head + '<ul class="note">' + lines.map(function (l) { return '<li>' + esc(l) + '</li>'; }).join('') + '</ul>';
  }

  // =====================================================================================
  // GROCERIES
  // =====================================================================================
  function groceryWeek(c) {
    const coming = E.dayOfWeek(c.today) === 6 ? c.today : E.nextSaturdayOnOrAfter(E.addDays(c.today, 1));
    return ui.grocWeek === 'previous' ? E.addDays(coming, -7) : coming;
  }

  function renderGroceries(c) {
    const h = [];
    const week = groceryWeek(c);
    const coming = E.dayOfWeek(c.today) === 6 ? c.today : E.nextSaturdayOnOrAfter(E.addDays(c.today, 1));
    const end = E.addDays(week, 6);
    const weekSeg = '<div class="seg" role="group">' +
      '<button type="button" id="groc-week-coming" data-action="groc-week" data-value="coming" aria-pressed="' + String(ui.grocWeek !== 'previous') + '">Coming diet week · ' + esc(E.formatDate(coming)) + '</button>' +
      '<button type="button" id="groc-week-previous" data-action="groc-week" data-value="previous" aria-pressed="' + String(ui.grocWeek === 'previous') + '">Current diet week · ' + esc(E.formatDate(E.addDays(coming, -7))) + '</button></div>';
    h.push('<div class="row">' + weekSeg + '</div>');

    const imp = state.priceMeta || {};
    const priceLine = '<span class="muted small">Prices last imported: <b>' + (imp.lastImport ? esc(dateLong(imp.lastImport)) + (imp.lastImportFile ? ' (' + esc(imp.lastImportFile) + ')' : '') : 'never') + '</b></span>';
    const tools = '<div class="row"><button type="button" class="btn" id="groc-export" data-action="groc-export">Export grocery list</button>' +
      '<button type="button" class="btn" id="groc-import" data-action="pick-file" data-target="file-prices">Import prices…</button>' +
      priceLine + '</div>' + exportBox() + msg(ui.importMsg) + importErrors() + unmatchedPanel(c);

    if (!state.plan || !state.plan.base) {
      h.push(block('Groceries', '<div class="panel stack"><p class="note">Generate a meal plan first; the grocery list is built from it.</p>' + tools + '</div>'));
      h.push(renderProductTable(c));
      return h.join('');
    }
    const p = planForWeek(c, week);
    const T = p.targets;
    const qty = G.weeklyQuantities(p.plan, state.setup.saturdayMode);
    const br = G.storeBreakdown(qty, state.products || [], c.today);
    const provisional = week > c.weekNow && T.source !== 'checkin' && !(state.checkins || {})[E.addDays(week, -7)] &&
      E.programWeekIndex(state.setup.programStart, week) > 0;

    const intro = '<p class="note"><b>' + esc(E.formatDate(week)) + ' dinner → ' + esc(E.formatDate(end)) + ' dinner.</b> Targets ' + fmt(T.kcal) + ' kcal / ' + fmt(T.protein) + ' g protein (' +
      esc((T.phase || {}).label || '') + '). Quantities = the fixed day’s grams per meal × times that meal occurs in the window: meals after lunch ×7, breakfast and lunch ×' +
      (state.setup.saturdayMode === 'offplan' ? '6 (Saturday off-plan)' : '7 (Saturday included)') + '.</p>' +
      (provisional ? '<div class="banner">Provisional: the check-in for ' + esc(E.formatRange(E.addDays(week, -7))) + ' has not been saved yet. Save it on Friday morning and this list updates.</div>' : '');

    // store totals
    const totals = '<div class="tscroll"><table><thead><tr><th>Store</th><th class="n">Total</th><th class="n">Items priced</th><th class="n">Missing</th><th class="n">Needs price script</th></tr></thead><tbody>' +
      STORES.map(function (st) {
        const s = br.stores[st];
        const priced = s.items.filter(function (i) { return i.row && isNum(i.cost); }).length;
        return '<tr><td>' + st + '</td><td class="n"><b>' + eur(s.total) + '</b></td><td class="n">' + priced + ' / ' + qty.length + '</td><td class="n">' + (s.missing.length || '') +
          '</td><td class="n">' + (s.staleCount ? '<span class="chip warn">' + s.staleCount + '</span>' : '') + '</td></tr>';
      }).join('') +
      '<tr class="total"><td>Cheapest mix</td><td class="n">' + eur(br.cheapest.total) + '</td><td class="n">' + (qty.length - br.cheapest.missing.length) + ' / ' + qty.length + '</td><td class="n">' +
      (br.cheapest.missing.length || '') + '</td><td class="n">' + (br.cheapest.items.filter(function (i) { return i.stale && i.stale.stale; }).length || '') + '</td></tr></tbody></table></div>';
    const missingTxt = br.cheapest.missing.length ? '<p class="note">No product at any store for: ' + esc(br.cheapest.missing.map(function (id) { return (c.foods[id] || {}).name || id; }).join(', ')) +
      '. Add a row in the product table below.</p>' : '';

    const viewSeg = '<div class="seg" role="group">' + [['cheapest', 'Cheapest mix']].concat(STORES.map(function (s) { return [s, s]; })).map(function (o) {
      return '<button type="button" id="groc-view-' + o[0] + '" data-action="groc-view" data-value="' + o[0] + '" aria-pressed="' + String(ui.grocView === o[0]) + '">' + o[1] + '</button>';
    }).join('') + '</div>';

    const qById = {};
    qty.forEach(function (q) { qById[q.foodId] = q; });
    const items = ui.grocView === 'cheapest' ? br.cheapest.items.map(function (i) { return Object.assign({ needG: qById[i.foodId] ? qById[i.foodId].grams : 0 }, i); })
      .concat(br.cheapest.missing.map(function (id) { return { foodId: id, needG: qById[id].grams, row: null, store: null }; }))
      : br.stores[ui.grocView].items;
    items.sort(function (a, b) { return catRank(c, a.foodId) - catRank(c, b.foodId) || String(a.foodId).localeCompare(String(b.foodId)); });
    const showStore = ui.grocView === 'cheapest';
    const total = ui.grocView === 'cheapest' ? br.cheapest.total : br.stores[ui.grocView].total;
    const rows = items.map(function (i) {
      const f = c.foods[i.foodId] || { name: i.foodId };
      const q = qById[i.foodId];
      const need = '<b>' + fmt(i.needG) + ' g</b>' + (f.unit ? '<span class="sub">≈ ' + fmt(i.needG / f.unit.grams, 1) + ' ' + esc(f.unit.name) + 's</span>' : '') +
        (q ? '<span class="sub">' + q.perMeal.map(function (pm) { return fmt(pm.grams) + ' g × ' + pm.times; }).join(' + ') + '</span>' : '');
      if (!i.row) {
        return '<tr><td>' + esc(f.name) + '</td>' + (showStore ? '<td></td>' : '') + '<td class="n">' + need + '</td><td colspan="8" class="muted">No product row for this store</td></tr>';
      }
      const r = i.row;
      const st = i.stale || G.isStale(r, c.today);
      const flag = st && st.stale ? '<span class="chip warn" title="' + esc(st.reason) + '">run price script</span>' + (st.reason === 'estimate' ? '<span class="sub">estimate</span>' : '') : '<span class="chip good">current</span>';
      return '<tr><td>' + esc(f.name) + '</td>' + (showStore ? '<td>' + esc(i.store) + '</td>' : '') + '<td class="n">' + need + '</td><td>' + esc(r.product) + (r.promo ? ' <span class="chip accent">promo</span>' : '') +
        (r.url ? '<span class="sub"><a href="' + esc(r.url) + '" target="_blank" rel="noopener">product page</a></span>' : '') + '</td><td class="mono">' + esc(r.ean || '–') +
        '</td><td class="n">' + fmt(r.packSizeG) + ' g</td><td class="n">' + eur(r.price) + '</td><td class="n">' + (r.date ? esc(r.date) : '–') + '</td><td class="n">' + (i.packs == null ? '–' : i.packs) +
        '</td><td class="n"><b>' + eur(i.cost) + '</b></td><td class="n">' + (isNum(i.leftoverG) ? fmt(i.leftoverG) + ' g' : '–') + '</td><td>' + flag + '</td></tr>';
    }).join('');
    const table = '<div class="tscroll"><table><thead><tr><th>Food</th>' + (showStore ? '<th>Store</th>' : '') + '<th class="n">Need this week</th><th>Product</th><th>EAN</th><th class="n">Pack</th><th class="n">Price</th>' +
      '<th class="n">Price date</th><th class="n">Packs</th><th class="n">Cost</th><th class="n">Leftover</th><th>Price status</th></tr></thead><tbody>' + rows +
      '</tbody><tfoot><tr><td colspan="' + (showStore ? 9 : 8) + '">Total' + (ui.grocView === 'cheapest' ? ' (best store per item)' : ' at ' + esc(ui.grocView)) + '</td><td class="n">' + eur(total) +
      '</td><td colspan="2"></td></tr></tfoot></table></div>';

    h.push(block('Groceries', intro + tools + totals + missingTxt));
    h.push(block('Shopping list', '<div class="row">' + viewSeg + '</div>' + table +
      '<p class="note">Prices marked “run price script” are older than 7 days, have no date, or are seeded estimates. Export the list, run <span class="mono">fetch_prices.py</span>, then import its output.</p>'));
    h.push(renderProductTable(c));
    return h.join('');
  }
  function catRank(c, id) { const f = c.foods[id]; return f ? CAT_ORDER.indexOf(f.category) : 99; }

  function importErrors() {
    if (!ui.importErrors || !ui.importErrors.length) return '';
    return '<div class="banner bad"><b>Rows skipped:</b><ul class="note" style="margin:4px 0 0;padding-left:18px">' + ui.importErrors.slice(0, 20).map(function (e) { return '<li>' + esc(e) + '</li>'; }).join('') +
      (ui.importErrors.length > 20 ? '<li>… and ' + (ui.importErrors.length - 20) + ' more</li>' : '') + '</ul></div>';
  }

  function unmatchedPanel(c) {
    const un = (state.priceMeta && state.priceMeta.unmatched) || [];
    if (!un.length) return '';
    const opts = c.list.slice().sort(function (a, b) { return a.name.localeCompare(b.name); })
      .map(function (f) { return '<option value="' + esc(f.id) + '">' + esc(f.name) + '</option>'; }).join('');
    const rows = un.map(function (r, i) {
      const sel = ui.mapSel[i] || '';
      return '<tr><td>' + esc(r.store) + '</td><td>' + esc(r.product) + '</td><td class="mono">' + esc(r.ean || '–') + '</td><td class="n">' + fmt(r.pack_size_g) + ' g</td><td class="n">' + eur(r.price_eur) +
        '</td><td><select id="map-' + i + '" data-map="' + i + '" aria-label="Food for ' + esc(r.product) + '"><option value="">Choose food…</option>' +
        opts.replace('value="' + esc(sel) + '"', 'value="' + esc(sel) + '" selected') + '</select></td><td><button type="button" class="btn" id="map-add-' + i + '" data-action="map-unmatched" data-idx="' + i +
        '">Add to product table</button></td></tr>';
    }).join('');
    return '<div class="stack"><h3>Unmatched import rows (' + un.length + ')</h3><p class="note">These rows matched no product by store + EAN or store + name. Map each one to a food to add it to the product table.</p>' +
      '<div class="tscroll"><table><thead><tr><th>Store</th><th>Product</th><th>EAN</th><th class="n">Pack</th><th class="n">Price</th><th>Food</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
      '<div class="row"><button type="button" class="btn ghost" id="unmatched-clear" data-action="unmatched-clear">Dismiss all unmatched rows</button></div></div>';
  }

  function renderProductTable(c) {
    const rows = (state.products || []).filter(function (r) { return ui.prodStore === 'all' || r.store === ui.prodStore; })
      .slice().sort(function (a, b) { return catRank(c, a.foodId) - catRank(c, b.foodId) || String(a.foodId).localeCompare(String(b.foodId)) || a.store.localeCompare(b.store); });
    const foodOpts = function (sel) {
      return c.list.slice().sort(function (a, b) { return a.name.localeCompare(b.name); }).map(function (f) {
        return '<option value="' + esc(f.id) + '"' + (f.id === sel ? ' selected' : '') + '>' + esc(f.name) + '</option>';
      }).join('');
    };
    const storeSeg = '<div class="seg" role="group">' + [['all', 'All stores']].concat(STORES.map(function (s) { return [s, s]; })).map(function (o) {
      return '<button type="button" id="prod-store-' + o[0] + '" data-action="prod-store" data-value="' + o[0] + '" aria-pressed="' + String(ui.prodStore === o[0]) + '">' + o[1] + '</button>';
    }).join('') + '</div>';
    const body = rows.map(function (r) {
      const id = esc(r.id);
      const st = G.isStale(r, c.today);
      return '<tr><td>' + esc(r.store) + '</td><td><select id="p-' + id + '-foodId" data-prod="' + id + '" data-key="foodId" aria-label="Food">' + foodOpts(r.foodId) + '</select></td>' +
        '<td><input type="text" id="p-' + id + '-product" data-prod="' + id + '" data-key="product" value="' + esc(r.product) + '" aria-label="Product name" style="min-width:220px"></td>' +
        '<td><input type="text" id="p-' + id + '-ean" data-prod="' + id + '" data-key="ean" value="' + esc(r.ean || '') + '" aria-label="EAN" style="min-width:130px" class="mono"></td>' +
        '<td><input type="number" id="p-' + id + '-packSizeG" data-prod="' + id + '" data-key="packSizeG" value="' + (isNum(r.packSizeG) ? r.packSizeG : '') + '" aria-label="Pack size in grams" style="width:90px" min="1" step="any"></td>' +
        '<td><input type="number" id="p-' + id + '-price" data-prod="' + id + '" data-key="price" value="' + (isNum(r.price) ? r.price : '') + '" aria-label="Price in euro" style="width:90px" min="0" step="0.01"></td>' +
        '<td><input type="checkbox" id="p-' + id + '-promo" data-prod="' + id + '" data-key="promo"' + (r.promo ? ' checked' : '') + ' aria-label="Promo"></td>' +
        '<td><input type="date" id="p-' + id + '-date" data-prod="' + id + '" data-key="date" value="' + esc(r.date || '') + '" aria-label="Price date"></td>' +
        '<td>' + esc(r.source || '') + (st.stale ? '<span class="sub">' + esc(st.reason) + '</span>' : '') + '</td>' +
        '<td><button type="button" class="btn ghost danger" id="p-' + id + '-del" data-action="prod-delete" data-id="' + id + '">Delete</button>' +
        (ui.confirm && ui.confirm.kind === 'deleteProduct' && ui.confirm.key === r.id ? confirmBar('deleteProduct', r.id, 'Delete this row?', 'Delete') : '') + '</td></tr>';
    }).join('');
    const np = ui.newProd;
    const addForm = '<details class="panel"><summary><b>Add a product row</b></summary><div class="stack" style="margin-top:10px">' +
      '<div class="grid">' +
      '<label class="field" for="np-store">Store<select id="np-store" data-newprod="store">' + STORES.map(function (s) { return '<option' + ((np.store || STORES[0]) === s ? ' selected' : '') + '>' + s + '</option>'; }).join('') + '</select></label>' +
      '<label class="field" for="np-food">Food<select id="np-food" data-newprod="foodId"><option value="">Choose…</option>' + foodOpts(np.foodId) + '</select></label>' +
      '<label class="field" for="np-product">Product name<input type="text" id="np-product" data-newprod="product" value="' + esc(np.product || '') + '"></label>' +
      '<label class="field" for="np-ean">EAN<input type="text" id="np-ean" data-newprod="ean" value="' + esc(np.ean || '') + '"></label>' +
      '<label class="field" for="np-pack">Pack size (g)<input type="number" id="np-pack" data-newprod="packSizeG" min="1" step="any" value="' + esc(np.packSizeG || '') + '"></label>' +
      '<label class="field" for="np-price">Price (€)<input type="number" id="np-price" data-newprod="price" min="0" step="0.01" value="' + esc(np.price || '') + '"></label>' +
      '</div><div class="row"><button type="button" class="btn primary" id="np-add" data-action="prod-add">Add row</button><span class="muted small">The price date is set to today.</span></div></div></details>';
    const body2 = '<details class="panel" id="prod-details"' + (ui.prodOpen ? ' open' : '') + '><summary><b>Edit product table</b> <span class="muted small">(' + (state.products || []).length + ' rows · Colruyt, Delhaize, Carrefour)</span></summary>' +
      '<div class="stack" style="margin-top:12px"><p class="note">Every row is editable. Changing a price sets its date to today. Pack sizes are in grams (eggs: count × 55 g, liquids: 1 ml = 1 g, oil 0.92 g/ml).</p>' +
      msg(ui.prodMsg) + '<div class="row">' + storeSeg + '<button type="button" class="btn ghost danger" id="prod-reset" data-action="prod-reset">Reset table to built-in products</button></div>' +
      confirmBar('resetProducts', '', 'Replace the whole product table with the built-in rows? Imported and edited prices are lost.', 'Reset') + addForm +
      '<div class="tscroll"><table><thead><tr><th>Store</th><th>Food</th><th>Product</th><th>EAN</th><th>Pack g</th><th>Price €</th><th>Promo</th><th>Price date</th><th>Source</th><th></th></tr></thead><tbody>' +
      (body || '<tr><td colspan="10" class="muted">No rows.</td></tr>') + '</tbody></table></div></div></details>';
    return block('Product table', body2);
  }

  // =====================================================================================
  // ACTIONS
  // =====================================================================================
  const ACTIONS = {
    'set': function (el) {
      const f = el.dataset.field;
      let v = el.dataset.value;
      if (f === 'mealsPerDay') v = Number(v);
      state.setup[f] = v;
      commit('setup');
    },
    'toggle-day': function (el) {
      const f = el.dataset.field, d = Number(el.dataset.day);
      const arr = (state.setup[f] || []).slice();
      const i = arr.indexOf(d);
      if (i >= 0) arr.splice(i, 1); else arr.push(d);
      arr.sort();
      state.setup[f] = arr;
      commit('setup');
    },
    'food-pref': function (el) {
      const id = el.dataset.food, v = el.dataset.v;
      const s = state.setup;
      s.likedFoods = (s.likedFoods || []).filter(function (x) { return x !== id; });
      s.excludedFoods = (s.excludedFoods || []).filter(function (x) { return x !== id; });
      if (v === 'like') s.likedFoods.push(id);
      if (v === 'exclude') s.excludedFoods.push(id);
      commit('setup');
    },
    'add-custom': addCustomFood,
    'delete-custom': function (el) { ui.confirm = { kind: 'deleteCustom', key: el.dataset.food }; scheduleRender(); },
    'log-edit': function (el) {
      resetDraft(el.dataset.date); ui.logMsg = null; scheduleRender();
      setTimeout(function () { const w = doc.getElementById('log-weight'); if (w) { w.focus(); try { w.scrollIntoView({ block: 'center' }); } catch (e) { /* old browsers */ } } }, 20);
    },
    'log-delete': function (el) { ui.confirm = { kind: 'deleteLog', key: el.dataset.date }; scheduleRender(); },
    'log-more': function () { ui.weeksShown += 1; scheduleRender(); },
    'log-less': function () { ui.weeksShown = 2; scheduleRender(); },
    'checkin-save': function () {
      const c = ctx();
      const week = ui.checkinWeek || dueWeek(c);
      const rec = E.computeCheckin(state, week);
      rec.computedOn = c.today;
      state.checkins = state.checkins || {};
      state.checkins[week] = rec;
      const later = Object.keys(state.checkins).filter(function (k) { return k > week; });
      ui.checkinMsg = { kind: 'good', text: 'Check-in saved. New targets apply from ' + E.formatDate(E.addDays(week, 7)) + ' dinner; the meal plan and grocery list use them now.' +
        (later.length ? ' Later check-ins were computed from the old values: open and save them again in order.' : '') };
      commit('checkins');
    },
    'plan-week': function (el) { ui.planWeek = el.dataset.value; scheduleRender(); },
    'plan-generate': generatePlan,
    'plan-regenerate': function () { ui.confirm = { kind: 'regen' }; scheduleRender(); },
    'groc-week': function (el) { ui.grocWeek = el.dataset.value; scheduleRender(); },
    'groc-view': function (el) { ui.grocView = el.dataset.value; scheduleRender(); },
    'groc-export': exportGroceries,
    'pick-file': function (el) { const f = doc.getElementById(el.dataset.target); if (f) { f.value = ''; f.click(); } },
    'map-unmatched': function (el) {
      const i = Number(el.dataset.idx);
      const foodId = ui.mapSel[i];
      if (!foodId) { ui.importMsg = { kind: 'bad', text: 'Choose a food for that row first.' }; return scheduleRender(); }
      const un = state.priceMeta.unmatched;
      state.products = G.mapImportRow(state.products, un[i], foodId);
      un.splice(i, 1);
      ui.mapSel = {};
      ui.importMsg = { kind: 'good', text: 'Added to the product table.' };
      S.save('products', state);
      commit('priceMeta');
    },
    'unmatched-clear': function () { state.priceMeta.unmatched = []; ui.mapSel = {}; commit('priceMeta'); },
    'prod-store': function (el) { ui.prodStore = el.dataset.value; ui.prodOpen = true; scheduleRender(); },
    'prod-add': function () {
      const np = ui.newProd;
      const store = np.store || STORES[0];
      const pack = parseNum(np.packSizeG), price = parseNum(np.price);
      if (!np.foodId || !np.product || !isNum(pack) || pack <= 0 || !isNum(price) || price < 0) {
        ui.prodMsg = { kind: 'bad', text: 'Fill in food, product name, a pack size above 0 g and a price.' }; ui.prodOpen = true; return scheduleRender();
      }
      const c = ctx();
      let n = 1, id;
      do { id = store.toLowerCase() + '-' + np.foodId + '-m' + n++; } while ((state.products || []).some(function (r) { return r.id === id; }));
      state.products = (state.products || []).concat([{ id: id, store: store, foodId: np.foodId, product: String(np.product).trim(), ean: String(np.ean || '').trim(),
        packSizeG: pack, price: price, promo: false, date: c.today, source: 'manual', url: '', note: '' }]);
      ui.newProd = { store: store };
      ui.prodMsg = { kind: 'good', text: 'Row added.' }; ui.prodOpen = true;
      commit('products');
    },
    'prod-delete': function (el) { ui.confirm = { kind: 'deleteProduct', key: el.dataset.id }; ui.prodOpen = true; scheduleRender(); },
    'prod-reset': function () { ui.confirm = { kind: 'resetProducts' }; ui.prodOpen = true; scheduleRender(); },
    'backup-export': function () {
      const c = ctx();
      offerFile('fatloss-backup-' + c.today + '.json', S.exportAll(state, c.today), 'backup');
    },
    'copy-export': function () {
      const ta = doc.getElementById('export-text');
      const text = ui.exportText ? ui.exportText.text : '';
      const fallback = function () { if (ta) { ta.focus(); ta.select(); } };
      try {
        const p = root.navigator && root.navigator.clipboard && root.navigator.clipboard.writeText(text);
        if (p && p.then) p.then(function () { flash('copy-export', 'Copied'); }, fallback); else fallback();
      } catch (e) { fallback(); }
    },
    'close-export': function () { ui.exportText = null; scheduleRender(); },
    'confirm-no': function () { ui.confirm = null; scheduleRender(); },
    'confirm-yes': function () {
      const cf = ui.confirm; ui.confirm = null;
      if (!cf) return;
      if (cf.kind === 'deleteLog') { delete state.logs[cf.key]; ui.logMsg = { kind: 'good', text: 'Deleted ' + E.formatDate(cf.key) + '.' }; resetDraft((ui.logDraft && ui.logDraft.date) || todayIso()); commit('logs'); }
      else if (cf.kind === 'regen') { generatePlan(); }
      else if (cf.kind === 'resetProducts') { state.products = clone(SEED); ui.prodMsg = { kind: 'good', text: 'Product table reset to the built-in rows.' }; commit('products'); }
      else if (cf.kind === 'deleteProduct') { state.products = state.products.filter(function (r) { return r.id !== cf.key; }); commit('products'); }
      else if (cf.kind === 'deleteCustom') {
        const s = state.setup;
        s.customFoods = (s.customFoods || []).filter(function (f) { return f.id !== cf.key; });
        s.likedFoods = (s.likedFoods || []).filter(function (x) { return x !== cf.key; });
        s.excludedFoods = (s.excludedFoods || []).filter(function (x) { return x !== cf.key; });
        commit('setup');
      } else if (cf.kind === 'importBackup' && ui.pendingBackup) {
        state = ui.pendingBackup.state; ui.pendingBackup = null;
        ui.backupMsg = { kind: 'good', text: 'Backup restored.' };
        S.saveAll(state);
        scheduleRender();
      }
    }
  };

  function flash(id, text) {
    const b = doc.getElementById(id);
    if (!b) return;
    const old = b.textContent; b.textContent = text;
    setTimeout(function () { b.textContent = old; }, 1400);
  }

  function addCustomFood() {
    const cf = ui.custom;
    const name = String(cf.name || '').trim();
    const nums = {};
    ['kcal', 'protein', 'carbs', 'fat', 'fibre'].forEach(function (k) { nums[k] = parseNum(cf[k]); });
    const unitG = parseNum(cf.unitGrams);
    let err = null;
    if (!name) err = 'Give the food a name.';
    else if (!isNum(nums.kcal) || nums.kcal <= 0) err = 'Enter kcal per 100 g (above 0).';
    else if (['protein', 'carbs', 'fat'].some(function (k) { return !isNum(nums[k]) || nums[k] < 0; })) err = 'Enter protein, carbs and fat per 100 g (0 or more).';
    else if (nums.protein + nums.carbs + nums.fat > 100) err = 'Protein + carbs + fat cannot exceed 100 g per 100 g.';
    else if (isNum(unitG) && unitG <= 0) err = 'Unit weight must be above 0 g, or leave it empty.';
    if (err) { ui.customErr = err; return scheduleRender(); }
    const s = state.setup;
    const slug = name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 24) || 'food';
    let id = 'custom_' + slug, n = 2;
    const exists = function (x) { return F.FOODS.some(function (f) { return f.id === x; }) || (s.customFoods || []).some(function (f) { return f.id === x; }); };
    while (exists(id)) id = 'custom_' + slug + '_' + n++;
    const food = {
      id: id, name: name, nameNl: '', category: cf.category || 'protein', kcal: nums.kcal, protein: nums.protein, carbs: nums.carbs, fat: nums.fat,
      fibre: isNum(nums.fibre) ? nums.fibre : 0, unit: isNum(unitG) ? { name: String(cf.unitName || 'unit').trim() || 'unit', grams: unitG } : null,
      custom: true, source: 'Custom (entered in Setup)'
    };
    s.customFoods = (s.customFoods || []).concat([food]);
    s.likedFoods = (s.likedFoods || []).concat([id]);
    ui.custom = {}; ui.customErr = null;
    ui.setupNote = 'Added “' + name + '” and marked it as liked.';
    commit('setup');
  }

  function generatePlan() {
    const c = ctx();
    const week = ui.planWeek === 'next' ? E.addDays(c.weekNow, 7) : c.weekNow;
    const T = E.targetsForWeek(state, week);
    if (!c.liked.length) { ui.planMsg = { kind: 'bad', text: 'Mark some foods as liked in Setup first.' }; return scheduleRender(); }
    const plan = M.generatePlan({ foods: c.foods, liked: c.liked, excluded: c.excluded, targets: macros(T), mealsPerDay: state.setup.mealsPerDay });
    state.plan = { base: plan, weekGenerated: week, history: (state.plan && state.plan.history) || {} };
    recordPlanWeek(c);
    ui.planMsg = { kind: 'good', text: 'Plan generated.' };
    commit('plan');
  }

  function doSwap(el) {
    const newId = el.value;
    if (!newId) return;
    const c = ctx();
    const week = ui.planWeek === 'next' ? E.addDays(c.weekNow, 7) : c.weekNow;
    const p = planForWeek(c, week);
    const next = M.swapFood(p.plan, c.foods, c.liked, c.excluded, el.dataset.meal, Number(el.dataset.idx), newId);
    state.plan = { base: next, weekGenerated: week, history: state.plan.history || {} };
    recordPlanWeek(c);
    ui.planMsg = { kind: 'good', text: 'Swapped in ' + c.foods[newId].name + '. Only that meal was re-solved.' };
    commit('plan');
  }

  async function offerFile(name, text, where) {
    const res = await S.download(name, text);
    if (res === 'saved' || res === 'fallback') {
      const m = { kind: 'good', text: 'Downloaded ' + name + '.' };
      if (where === 'backup') ui.backupMsg = m; else ui.importMsg = m;
      ui.exportText = null;
    } else if (res === 'declined') {
      const m = { kind: 'warn', text: 'Download cancelled.' };
      if (where === 'backup') ui.backupMsg = m; else ui.importMsg = m;
    } else {
      ui.exportText = { name: name, text: text };
    }
    scheduleRender();
  }

  function exportGroceries() {
    const c = ctx();
    if (!state.plan || !state.plan.base) { ui.importMsg = { kind: 'bad', text: 'Generate a meal plan first.' }; return scheduleRender(); }
    const week = groceryWeek(c);
    const p = planForWeek(c, week);
    const qty = G.weeklyQuantities(p.plan, state.setup.saturdayMode);
    const data = G.buildExport(qty, state.products || [], c.foods, { start: week, end: E.addDays(week, 6) }, c.today);
    offerFile('grocery-list-' + week + '.json', JSON.stringify(data, null, 2), 'groceries');
  }

  function readFile(input) {
    return new Promise(function (resolve, reject) {
      const file = input.files && input.files[0];
      if (!file) return reject(new Error('No file chosen.'));
      const r = new root.FileReader();
      r.onload = function () { resolve({ name: file.name, text: String(r.result || '') }); };
      r.onerror = function () { reject(new Error('Could not read the file.')); };
      r.readAsText(file);
    });
  }

  function importPricesFile(input) {
    readFile(input).then(function (f) {
      const c = ctx();
      const parsed = G.parseImport(f.text);
      ui.importErrors = parsed.errors || [];
      if (!parsed.rows.length) {
        ui.importMsg = { kind: 'bad', text: 'No usable rows in ' + f.name + '. Expected a JSON array like [{"store": "Colruyt", "ean": "…", "product": "…", "pack_size_g": 500, "price_eur": 3.49, "promo": false, "date": "2026-09-25"}].' };
        return scheduleRender();
      }
      const res = G.applyImport(state.products || [], parsed.rows, c.today);
      state.products = res.products;
      state.priceMeta = Object.assign({}, state.priceMeta, {
        lastImport: c.today, lastImportFile: f.name, lastImportSummary: res.summary,
        unmatched: ((state.priceMeta && state.priceMeta.unmatched) || []).concat(res.unmatched)
      });
      ui.importMsg = { kind: res.unmatched.length ? 'warn' : 'good', text: 'Imported ' + f.name + ': ' + res.summary.matched + ' rows matched, ' + res.summary.updated + ' products updated, ' +
        res.summary.unmatched + ' unmatched' + (res.unmatched.length ? ' (map them below)' : '') + '.' };
      S.save('products', state);
      commit('priceMeta');
    }, function (e) { ui.importMsg = { kind: 'bad', text: e.message }; scheduleRender(); });
  }

  function importBackupFile(input) {
    readFile(input).then(function (f) {
      try {
        const st = S.importAll(f.text, defaultState());
        ui.pendingBackup = { name: f.name, state: st };
        ui.confirm = { kind: 'importBackup' };
        ui.backupMsg = null;
      } catch (e) { ui.backupMsg = { kind: 'bad', text: e.message }; }
      scheduleRender();
    }, function (e) { ui.backupMsg = { kind: 'bad', text: e.message }; scheduleRender(); });
  }

  function bindSetup(el) {
    const key = el.dataset.bind;
    const v = parseNum(el.value);
    const r = RANGES[key];
    ui.setupErr = null; ui.setupNote = null;
    if (v === null) {
      if (key === 'bodyFatPct') { state.setup.bodyFatPct = null; return commit('setup'); }
      ui.setupErr = r[2] + ' is required.'; return scheduleRender();
    }
    if (Number.isNaN(v) || v < r[0] || v > r[1]) {
      ui.setupErr = r[2] + ' must be between ' + r[0] + ' and ' + r[1] + (r[3] ? ' ' + r[3] : '') + '. The previous value is kept.';
      return scheduleRender();
    }
    state.setup[key] = v;
    commit('setup');
  }

  function setProgramStart(v) {
    ui.setupErr = null; ui.setupNote = null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v || '')) { ui.setupErr = 'Pick a valid start date.'; return scheduleRender(); }
    const sat = E.nextSaturdayOnOrAfter(v);
    if (sat !== v) ui.setupNote = 'Diet weeks start on Saturday, so the program start moved to ' + E.formatDate(sat) + '.';
    state.setup.programStart = sat;
    commit('setup');
  }

  function editProduct(el) {
    const row = (state.products || []).find(function (r) { return r.id === el.dataset.prod; });
    if (!row) return;
    const key = el.dataset.key;
    const today = todayIso();
    ui.prodOpen = true; ui.prodMsg = null;
    if (key === 'packSizeG' || key === 'price') {
      const v = parseNum(el.value);
      if (!isNum(v) || v < 0 || (key === 'packSizeG' && v === 0)) { ui.prodMsg = { kind: 'bad', text: (key === 'price' ? 'Price' : 'Pack size') + ' must be a positive number.' }; return scheduleRender(); }
      row[key] = v;
      if (key === 'price') { row.date = today; row.source = 'manual'; }
    } else if (key === 'promo') {
      row.promo = !!el.checked;
    } else if (key === 'date') {
      row.date = el.value || null;
      if (row.source === 'estimate' && row.date) row.source = 'manual';
    } else {
      row[key] = String(el.value).trim();
    }
    commit('products');
  }

  // ---------- events ----------
  function onClick(e) {
    const t = e.target.closest('[data-action], .tab');
    if (!t) return;
    if (t.classList.contains('tab')) { setTab(t.dataset.tab); return; }
    const fn = ACTIONS[t.dataset.action];
    if (fn) { e.preventDefault(); fn(t); }
  }
  function onChange(e) {
    const t = e.target;
    if (t.dataset.bind) return bindSetup(t);
    // Typing a date fires change per segment; apply it when the field is left (or on Enter) instead.
    if (t.id === 's-start') { if (doc.activeElement !== t) setProgramStart(t.value); return; }
    if (t.id === 'log-date') { if (doc.activeElement !== t) applyLogDate(t.value); return; }
    if (t.id === 'ci-week') { ui.checkinWeek = t.value; ui.checkinMsg = null; return scheduleRender(); }
    if (t.dataset.swap) return doSwap(t);
    if (t.dataset.prod) return editProduct(t);
    if (t.id === 'file-prices') return importPricesFile(t);
    if (t.id === 'file-backup') return importBackupFile(t);
    if (t.dataset.map !== undefined) { ui.mapSel[t.dataset.map] = t.value; return; }
    if (t.dataset.custom) { ui.custom[t.dataset.custom] = t.value; return; }
    if (t.dataset.newprod) { ui.newProd[t.dataset.newprod] = t.value; return; }
  }
  function onInput(e) {
    const t = e.target;
    if (t.id === 'food-filter') { ui.foodFilter = t.value; scheduleRender(); return; }
    if (t.dataset.draft && ui.logDraft) { ui.logDraft[t.dataset.draft] = t.value; return; }
    if (t.dataset.custom) { ui.custom[t.dataset.custom] = t.value; return; }
    if (t.dataset.newprod) { ui.newProd[t.dataset.newprod] = t.value; }
  }
  function onFocusOut(e) {
    const t = e.target;
    if (t.id === 's-start' && t.value !== state.setup.programStart) setProgramStart(t.value);
    if (t.id === 'log-date') applyLogDate(t.value);
  }
  function onKeydown(e) {
    const t = e.target;
    if (e.key !== 'Enter' || (t.id !== 's-start' && t.id !== 'log-date')) return;
    e.preventDefault();
    if (t.id === 's-start') { if (t.value !== state.setup.programStart) setProgramStart(t.value); } else applyLogDate(t.value);
  }
  function onSubmit(e) {
    if (e.target.id === 'log-form') { e.preventDefault(); saveLog(); }
  }
  function onToggle(e) {
    if (e.target.id === 'prod-details') ui.prodOpen = e.target.open;
    else if (e.target.id) ui.open[e.target.id] = e.target.open;
  }

  function setTab(name) {
    if (['setup', 'log', 'checkin', 'plan', 'groceries'].indexOf(name) < 0) name = 'setup';
    tab = name;
    ui.confirm = null;
    if (name === 'log') { resetDraft(todayIso()); ui.logMsg = null; }
    if ((name === 'plan' || name === 'groceries') && state && recordPlanWeek(ctx())) S.save('plan', state);
    try { root.history.replaceState(null, '', '#' + name); } catch (e) { /* sandboxed */ }
    render();
    try { root.scrollTo(0, 0); } catch (e) { /* ignore */ }
  }

  async function boot() {
    doc.addEventListener('click', onClick);
    doc.addEventListener('change', onChange);
    doc.addEventListener('input', onInput);
    doc.addEventListener('submit', onSubmit);
    doc.addEventListener('focusout', onFocusOut);
    doc.addEventListener('keydown', onKeydown);
    doc.addEventListener('toggle', onToggle, true);
    const hash = (root.location.hash || '').replace('#', '');
    if (hash) tab = hash;
    S.onStatus(setSaveState);
    const res = await S.load(defaultState());
    state = res.state;
    backend = res.backend;
    // Keep the program start on a Saturday even if older data says otherwise.
    if (state.setup.programStart && E.dayOfWeek(state.setup.programStart) !== 6) state.setup.programStart = E.nextSaturdayOnOrAfter(state.setup.programStart);
    if (!state.products || !state.products.length) state.products = clone(SEED);
    setSaveState('saved');
    setTab(tab);
  }

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', boot); else boot();
})(window);
