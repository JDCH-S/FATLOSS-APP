# Cut Block Planner

**Open the app:** https://claude.ai/artifact/SD82DKjNAqemdHhjnE8oQh (private to your account).

A fat-loss tracker built as a claude.ai Artifact: short hard cut blocks with mandatory maintenance breaks,
an adaptive weekly check-in that learns your real maintenance calories, one fixed daily meal plan, and a
Friday grocery list priced at Colruyt, Delhaize and Carrefour Belgium. Metric units, EUR, English UI.

```
app/                 the artifact (index.html + js/)
  js/foods.js        69 built-in foods, macros per 100 g
  js/products.js     seed product table (207 rows: every food at every store)
  js/engine.js       formulas, diet weeks, phases, check-in, targets
  js/mealplan.js     deterministic meal-plan solver, rescale, swap
  js/groceries.js    weekly quantities, packs, costs, cheapest mix, export, price import
  js/store.js        persistence (Claude account storage, browser fallback), backup
  js/ui.js           the five tabs
price_script/        fetch_prices.py (Apify → price-import JSON) + tests
tests/               node:test suites for the logic modules
docs/SPEC.md         module contract and algorithms
```

## First use

1. **Setup**: replace the example numbers (weight, height, age, body fat %, goal, steps, training days, session
   lengths), choose 3–5 meals per day and the Saturday mode, set the program start (a Saturday), and mark the foods
   you like and the ones you won't eat.
2. Check **Starting calculations** and the **Program timeline** on the same tab.
3. **Meal Plan** → *Generate plan*. Swap anything you don't want.
4. Log morning weights in the week before the start; that week becomes the baseline for the first check-in.
5. **Groceries** → *Export grocery list*, run the price script once, then *Import prices*. Until you do, every
   price is a flagged estimate.

## The weekly routine

1. **Every morning**: Daily Log → weight, calories, protein, steps (one row per day).
2. **Friday morning**, after the weigh-in: Weekly Check-in → *Save check-in*. It compares this week's
   Saturday–Friday average weight with last week's, updates your learned TDEE and sets the targets that apply
   from Saturday dinner.
3. **Friday, before shopping**: Groceries → *Export grocery list* → run the price script → *Import prices*.
   The list covers Saturday dinner → next Friday dinner and already uses the new targets.

## How the numbers are made

Every number in the app shows its formula and inputs (Setup → Starting calculations, and the check-in).

| Step | Rule |
|---|---|
| BMR | Mifflin-St Jeor (men): 10 × kg + 6.25 × cm − 5 × age + 5 |
| Starting TDEE | BMR × 1.2 + steps × 0.0005 × kg + weekly exercise kcal / 7; exercise = MET × kg × hours (lifting 5, padel 6) |
| Protein | 2.7 g/kg lean mass (lean mass = weight × (1 − BF%)); 2.2 g/kg bodyweight without BF%. Never reduced. |
| Fat | 22 % of calories, floor 0.6 g/kg bodyweight |
| Carbs | the remaining calories |
| Cut rate | 1.0 %/week of bodyweight above the 15 % body-fat weight, 0.75 %/week below it |
| Deficit | weekly loss (kg) × 7700 / 7 per day; calories never below BMR |
| Blocks | cut 8 weeks → maintenance break 2 weeks (not skippable) → repeat until the goal, then final maintenance |
| Observed TDEE | average logged intake − (change in 7-day average weight × 7700 / 7) |
| Learned TDEE | 0.7 × previous + 0.3 × observed; weeks 1–2 use the formula, week 3 onwards the learned value |
| Weekly change | new target = learned TDEE − phase deficit, capped at ±200 kcal inside a phase; carbs change first, then fat down to its floor. Phase changes move the whole deficit at once (a break sits at maintenance, the deficit comes back as carbs). |
| Stall | loss below 70 % of target for 2 weeks → steps down > 15 % vs Setup: "NEAT drop" (no cut); fewer than 6 of 7 days logged: "tracking gap" (no cut); otherwise "metabolic adaptation" (adjustment applied) |

A diet week runs from Saturday dinner to Friday dinner; for dates the app uses Saturday–Friday calendar weeks.
The week before the program start is a baseline: log weights then so the first check-in has a week to compare
with. Week-1 targets come from Setup and are frozen when the program starts, so later Setup edits act through the
next check-in instead of rewriting past weeks, and protein never drops below its week-1 value. Change the program
start to restart with new numbers. A skipped check-in doesn't hide a stall: last week's result is then worked out
from your logs.
Each week needs at least 4 weigh-ins (and this week at least one logged calorie day) for an adaptive update;
otherwise targets carry over.

Without a body-fat estimate, the 15 % threshold and a body-fat goal use a BMI-based estimate (Deurenberg), shown
as "estimated". Protein still uses 2.2 g/kg bodyweight.

## Meal plan

One fixed day, eaten every day, generated only from foods you like (foods you won't eat are excluded
everywhere). Each meal is one protein food + one carb food + vegetables or fruit, with a fat source when needed.
Grams are solved to hit the day within ±5 % kcal and ±10 g protein, with at least 2 different vegetables,
1 fruit and 25 g fibre, rounded to 5 g or whole units. The generator prefers filling, high-protein foods.
When targets change, the same meals are kept and only grams are rescaled (carbs first, then fat); maintenance
breaks simply get larger carb portions. *Swap* replaces one food with another liked food of the same category
and re-solves only that meal. Marking a planned food "won't eat" (or un-liking it, or deleting a custom food)
replaces it automatically the same way; changing meals per day regenerates the plan. "Changes vs last week"
compares with the plan you actually had last week, swaps included.

## Groceries and prices

Weekly quantity per food = grams per meal × how often that meal falls in the window: every meal after lunch
7 times; breakfast and lunch 6 times when Saturday breakfast and lunch are off-plan, 7 when included.
For each store the app picks the cheapest pack option with a current price (an estimate only when nothing current exists), rounds packs up and shows the leftover; the cheapest mix
takes the best store per item. Any price without a date, seeded as an estimate, or older than 7 days is flagged
**run price script**.

### About the seeded product table

The build environment could not reach the store websites, Open Food Facts or Apify, and its web-search budget
ran out part-way, so the seed table is a starting point, not verified shelf data:

- **Colruyt and Delhaize**: product names and product-page links come from store pages that showed up in web
  search results. EANs are filled in only where an Open Food Facts entry clearly matched (15 rows).
- **Carrefour**: typical own-brand shelf names, not checked against carrefour.be (quinoa comes from an Open Food Facts entry).
- **Prices**: estimates, or search-result prices with unknown dates. None has a price date, so every row is
  flagged until your first import.

Run the price script once to replace them with real products and prices. Unmatched rows from an import are
listed on the Groceries tab so you can map them to a food. Every row in the product table is also editable.

### Price script

```bash
export APIFY_TOKEN=apify_api_...          # Apify console → Settings → API & Integrations
python3 price_script/fetch_prices.py grocery-list-2026-10-03.json -o prices-2026-10-03.json
```

- Needs only Python 3.9+ (standard library).
- One Apify actor per store. Defaults are Harvest Edge's Belgian scrapers: `harvestedge/colruyt-supermarket-be`
  (returns GTINs), `harvestedge/delhaize-supermarket-scraper` and `harvestedge/carrefour-belgium`.
  `studio-amba/colruyt-scraper` is an alternative for Colruyt. Their input field names could not be confirmed
  from the build environment, so before the first run the script reads each actor's input schema from the
  Apify API and fills its search and max-results fields (one run per query when the actor takes a single search
  string). Check what it will send with `--dry-run`.
- Override an actor or its input without editing the file:
  `APIFY_ACTOR_DELHAIZE=user/actor` and `APIFY_INPUT_DELHAIZE='{"queries": {queries}, "maxItems": {max_items}}'`.
- Matching: EAN first (leading zeros are ignored, so a 14-digit GTIN matches the 13-digit EAN), then the store
  product code in the product URL (Delhaize exposes no EANs; its `/p/F…` and `/p/S…` codes both count), then
  product name plus pack size. For foods with no product row at a store, `--discover 1` (default) adds the best
  search hit that shows a pack size; the app lists it as unmatched so you can map it. A hit without a pack size
  cannot be imported, so it is skipped and reported.
- Pack sizes follow the food database: canned tuna, chickpeas and kidney beans in **drained** grams (the label's
  net weight × the food's drained ratio: 0.7 for tuna, 0.6 for legumes), olive oil at 0.92 g/ml. The grocery-list
  export carries these factors (`drained_ratio`, `g_per_ml`). The ratio is not applied when the listing already
  gives the drained weight ("uitgelekt", "égoutté", "drained", or a drained-weight field; a size written next to
  those words is used), or when the listed size is within 10 % of your product row's own pack size, which the table
  keeps in drained grams (Colruyt's "BONI tonijn in eigen nat MSC 95g" stays 95 g). Write drained grams for canned
  foods in hand-made import files too.
- Network trouble (timeouts, dropped connections, a response that is not JSON, HTTP 429/5xx) is retried once
  while polling and downloading; starting a run is never retried, so nothing is billed twice. A store that still
  fails is reported and the other stores' rows are still written (exit code 1, or 2 when no rows were written).
  If a run outlasts `--timeout`, the message names its dataset: when the run finishes, export that dataset as
  JSON from the Apify console and rerun with `--from-dataset`.
- `--save-raw DIR` keeps the raw datasets and `--from-dataset Colruyt=file.json` reprocesses them without new runs.
- Some actors are paid, and the runs are billed to your Apify account.

Output format (what *Import prices* accepts):

```json
[{"store": "Colruyt", "ean": "5400141044429", "product": "BONI Skyr natuur 500g", "pack_size_g": 500,
  "price_eur": 1.29, "promo": false, "date": "2026-10-02"},
 {"store": "Delhaize", "ean": "", "product": "Skyr natuur 450 g", "match_product": "Delhaize | Skyr | Natuur",
  "pack_size_g": 450, "price_eur": 1.99, "promo": false, "date": "2026-10-02"}]
```

`product` is always the name the store shows now. `match_product` is optional: the script adds it for product-table
rows without an EAN, holding your table's name for that row. The app matches store + EAN, then store +
`match_product`, then store + `product`, and a matched row takes the store's name, so the table always names the
product the price belongs to. Rows that match nothing are listed once per store + EAN (or store + name without an
EAN); importing the same suggestions again refreshes their price instead of adding copies.

## Data and backups

Inside claude.ai your data is stored in the artifact's database under your account, readable and writable only
by you (the artifact's owner). It survives reloads, sessions and new versions of the app. Several open tabs or
devices stay in sync: daily entries and check-ins are saved one by one, so an old tab never overwrites newer
entries, and changes made elsewhere appear without reloading. If the saved data can't be read when the app opens,
it says so and keeps your changes on this device only (in this browser's local storage, never written over your
account's data); the next time the app opens and can read your account, it adds them there, except for any day,
check-in or setting that was changed elsewhere in the meantime (the newer value wins). Opened outside claude.ai,
the app falls back to this browser's local storage; several tabs of it stay in sync too, and a tab left open
never drops days or check-ins another tab saved. Setup → Backup exports or restores everything as one JSON file.

## Known limits

- Setup is saved as one record: if two tabs or devices change Setup within about a second of each other, the
  later save wins. Daily entries and check-ins are saved one by one and never overwrite each other.
- With 3 meals a day and a very high maintenance-break target, carb portions can go past the normal per-meal
  size (up to 1.25×) or calories can fall short; the Meal Plan tab says so. More meals per day fixes it.
- A food you won't eat stays in the plan only when nothing you like can replace it; it is then flagged and left
  off the grocery list until you like an alternative or regenerate the plan.

## Development

```bash
npm test      # node --test tests/*.test.js && python3 -m unittest discover -s price_script
npm run smoke # headless Chromium: every tab end to end, plus two tabs against a fake cloud store
```

The logic modules are pure and deterministic (no clock or randomness inside them), so they run unchanged in
Node and the browser.
