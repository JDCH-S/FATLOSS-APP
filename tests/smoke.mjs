// Browser smoke test: loads app/index.html in headless Chromium, drives every tab and fails on any page error.
// Run: npm run smoke   (uses the globally installed Playwright; screenshots go to $SMOKE_OUT or ./smoke-out)
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch (e) { ({ chromium } = require('/opt/node22/lib/node_modules/playwright')); }

const here = dirname(fileURLToPath(import.meta.url));
const pageUrl = pathToFileURL(join(here, '..', 'app', 'index.html')).href;
const out = process.env.SMOKE_OUT || join(here, '..', 'smoke-out');
mkdirSync(out, { recursive: true });

const errors = [];
const checks = [];
function check(name, ok, detail) { checks.push({ name, ok: !!ok, detail }); if (!ok) console.log('FAIL', name, detail || ''); }

function iso(d) { return d.toISOString().slice(0, 10); }

const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
const context = await browser.newContext({ viewport: { width: 1200, height: 900 }, acceptDownloads: true });
const page = await context.newPage();
page.on('pageerror', (e) => { errors.push('pageerror: ' + e.message); console.log('PAGE ERROR', e.message); });
// Font requests can fail in sandboxes without internet; that is not an app error.
page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) { errors.push('console: ' + m.text()); console.log('CONSOLE ERROR', m.text()); } });

await page.goto(pageUrl);
await page.waitForFunction(() => document.getElementById('status-strip')?.textContent.length > 10, null, { timeout: 15000 });
check('header renders', true);

async function tab(name) {
  await page.click(`#tab-${name}`);
  await page.waitForTimeout(80);
  const broken = await page.locator('text=Something went wrong').count();
  check(`tab ${name} renders without error`, broken === 0);
  await page.screenshot({ path: join(out, `${name}.png`), fullPage: true });
}

// ---- Setup
await tab('setup');
check('starting calculations table', await page.locator('text=BMR (Mifflin-St Jeor, men)').count() > 0);
const bmrBefore = await page.locator('td:has-text("BMR (Mifflin-St Jeor, men)") + td').textContent();
await page.fill('#s-weight', '90');
await page.press('#s-weight', 'Tab');
await page.waitForTimeout(120);
const bmrAfter = await page.locator('td:has-text("BMR (Mifflin-St Jeor, men)") + td').textContent();
check('BMR updates when weight changes', bmrBefore !== bmrAfter, `${bmrBefore} -> ${bmrAfter}`);
check('focus moved to next field after Tab', await page.evaluate(() => document.activeElement && document.activeElement.id) === 's-height');
await page.fill('#s-weight', '85');
await page.press('#s-weight', 'Tab');
await page.click('#day-liftDays-4'); // toggle Thursday
await page.waitForTimeout(80);
check('weekday toggle works', (await page.getAttribute('#day-liftDays-4', 'aria-pressed')) === 'true');
await page.click('#day-liftDays-4');
await page.fill('#s-weight', '5');
await page.press('#s-weight', 'Tab');
await page.waitForTimeout(80);
check('invalid weight shows an error', await page.locator('text=Weight must be between').count() > 0);
// custom food
await page.click('summary:has-text("Add a custom food")');
await page.fill('#cf-name', 'Test protein pudding');
await page.selectOption('#cf-category', 'dairy');
await page.fill('#cf-kcal', '70');
await page.fill('#cf-protein', '10');
await page.fill('#cf-carbs', '5');
await page.fill('#cf-fat', '1');
await page.fill('#cf-fibre', '0');
await page.click('#cf-add');
await page.waitForTimeout(100);
check('custom food added', await page.locator('text=Test protein pudding').count() > 0);

// ---- Program start: the week before the start is a baseline; then start two weeks ago so a check-in can be saved
await page.click('#tab-checkin');
await page.waitForTimeout(80);
const todayUtc = new Date(Date.UTC(new Date().getFullYear(), new Date().getMonth(), new Date().getDate()));
const startPre = new Date(todayUtc); startPre.setUTCDate(startPre.getUTCDate() + ((6 - startPre.getUTCDay() + 7) % 7 || 7));
if (await page.locator('text=The program starts').count()) check('pre-start check-in tab shows the baseline note', await page.locator('text=baseline').count() > 0);
await page.click('#tab-setup');
const start = new Date(todayUtc); start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 1) % 7) - 7);
await page.fill('#s-start', iso(start));
await page.press('#s-start', 'Enter');
await page.waitForTimeout(120);
check('program start typed with the keyboard is applied', (await page.inputValue('#s-start')) === iso(start), await page.inputValue('#s-start'));
check('header shows Cut 1 after the start moved', await page.locator('#status-strip >> text=Cut 1').count() > 0);

// ---- Meal plan
await tab('plan');
await page.click('#plan-generate');
await page.waitForTimeout(200);
const meals = await page.locator('.meal-head').count();
check('plan generated with 4 meals', meals === 4, `meals=${meals}`);
const badChips = await page.locator('.chip.bad').count();
check('plan passes all checks (no red chips)', badChips === 0, `red chips=${badChips}`);
await page.screenshot({ path: join(out, 'plan.png'), fullPage: true });
const swapSel = page.locator('select[data-swap]').first();
if (await swapSel.count()) {
  const opts = await swapSel.locator('option').allTextContents();
  if (opts.length > 1) {
    await swapSel.selectOption({ index: 1 });
    await page.waitForTimeout(150);
    check('swap works', await page.locator('text=Swapped in').count() > 0);
  }
}

// ---- Daily log: 14 days of data ending today
await tab('log');
const today = new Date();
for (let i = 13; i >= 0; i--) {
  const d = new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate() - i));
  await page.fill('#log-date', iso(d));
  await page.dispatchEvent('#log-date', 'change');
  await page.waitForTimeout(30);
  await page.fill('#log-weight', String((86 - (13 - i) * 0.1).toFixed(1)));
  await page.fill('#log-kcal', String(2013 + (i % 3) * 47));
  await page.fill('#log-protein', '181.5');
  await page.fill('#log-steps', String(8537 + i));
  await page.press('#log-steps', 'Enter');
  await page.waitForTimeout(40);
}
check('log rows saved (non-round numbers)', await page.locator('text=Saved').count() > 0);
await page.waitForTimeout(900); // saves are debounced
check('14 days stored', await page.evaluate(() => { try { return Object.keys(JSON.parse(localStorage.getItem('fatloss-app-v1')).logs).length; } catch (e) { return -1; } }) >= 14);
await page.screenshot({ path: join(out, 'log-filled.png'), fullPage: true });

// ---- Check-in
await tab('checkin');
await page.click('#ci-save');
await page.waitForTimeout(150);
check('check-in saved', await page.locator('text=Check-in saved').count() > 0);
check('chart drawn', await page.locator('svg.chart circle').count() > 5);
await page.screenshot({ path: join(out, 'checkin-saved.png'), fullPage: true });

// ---- Groceries
await tab('groceries');
check('store totals table', await page.locator('td:has-text("Cheapest mix")').count() > 0);
const dl = page.waitForEvent('download', { timeout: 5000 }).catch(() => null);
await page.click('#groc-export');
const download = await dl;
let exported = null;
if (download) {
  const p = join(out, 'grocery-export.json');
  await download.saveAs(p);
  exported = JSON.parse(require('node:fs').readFileSync(p, 'utf8'));
} else if (await page.locator('#export-text').count()) {
  exported = JSON.parse(await page.locator('#export-text').inputValue());
}
check('grocery export produced', exported && Array.isArray(exported.items) && exported.items.length > 5, exported && exported.items && exported.items.length);
// import prices: one EAN match + one unmatched row
const first = exported && exported.items.find((i) => i.stores.Colruyt.length);
const importRows = [
  { store: 'Colruyt', ean: first.stores.Colruyt[0].ean, product: first.stores.Colruyt[0].product, pack_size_g: first.stores.Colruyt[0].pack_size_g, price_eur: 1.11, promo: false, date: iso(today) },
  { store: 'Delhaize', ean: '0000000000000', product: 'Something new', pack_size_g: 250, price_eur: 2.22, promo: true, date: iso(today) }
];
const importPath = join(out, 'prices.json');
writeFileSync(importPath, JSON.stringify(importRows));
await page.setInputFiles('#file-prices', importPath);
await page.waitForTimeout(250);
if (!(await page.locator('text=Imported prices.json').count())) console.log('banners after import:', await page.locator('.banner').allTextContents());
check('price import summary shown', await page.locator('text=Imported prices.json').count() > 0);
check('unmatched rows listed', await page.locator('text=Unmatched import rows').count() > 0);
await page.selectOption('#map-0', { index: 1 });
await page.click('#map-add-0');
await page.waitForTimeout(120);
check('unmatched row mapped', await page.locator('text=Added to the product table').count() > 0);
await page.screenshot({ path: join(out, 'groceries.png'), fullPage: true });

// ---- Backup round trip
await tab('setup');
const dl2 = page.waitForEvent('download', { timeout: 5000 }).catch(() => null);
await page.click('#backup-export');
const bk = await dl2;
check('backup export downloads', !!bk);

// ---- Persistence across reload (browser fallback)
await page.reload();
await page.waitForFunction(() => document.getElementById('status-strip')?.textContent.length > 10);
await page.click('#tab-log');
await page.waitForTimeout(100);
check('logs persist across reload', await page.locator('td.n:has-text("85.")').count() > 0);

// ---- Phone width: no horizontal page scroll on any tab
await page.setViewportSize({ width: 400, height: 860 });
for (const t of ['setup', 'log', 'checkin', 'plan', 'groceries']) {
  await page.click(`#tab-${t}`);
  await page.waitForTimeout(80);
  const sw = await page.evaluate(() => document.documentElement.scrollWidth);
  check(`no horizontal scroll at 400px (${t})`, sw <= 401, `scrollWidth=${sw}`);
  await page.screenshot({ path: join(out, `phone-${t}.png`), fullPage: false });
}

// ---- Dark theme renders
await page.emulateMedia({ colorScheme: 'dark' });
await page.click('#tab-checkin');
await page.waitForTimeout(80);
await page.screenshot({ path: join(out, 'dark-checkin.png'), fullPage: false });
const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
check('dark theme background applied', bg === 'rgb(15, 18, 21)', bg);

await browser.close();
errors.forEach((e) => console.log('ERROR', e));
const failed = checks.filter((c) => !c.ok);
console.log(`${checks.length - failed.length}/${checks.length} checks passed, ${errors.length} page errors. Screenshots: ${out}`);
process.exit(failed.length || errors.length ? 1 : 0);
