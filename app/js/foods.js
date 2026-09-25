/* Built-in food database. Values per 100 g as sold (raw for meat/fish/veg, dry for grains/pasta/rice/lentils,
 * drained for canned). kcal is the label energy (EU labels count fibre at 2 kcal/g), so kcal can differ slightly
 * from 4P+4C+9F. Every calculation that needs energy uses the kcal field.
 *
 * Fields
 *   id        stable key used everywhere (plan, products, exports)
 *   name/nameNl  English UI name / Dutch shelf name (Belgian stores)
 *   category  protein | carb | fat | vegetable | fruit | dairy
 *   slots     meal-plan roles this food can fill: protein | carb | produce | fat
 *   meals     'breakfast' (breakfast + snacks) and/or 'main' (lunch + dinner)
 *   unit      {name, grams} when the food is portioned in whole units (grams = edible weight of one unit)
 *   fill      1-5 satiety/volume score used to bias the generator toward filling foods
 *   maxPerMeal  sensible upper bound in grams for one meal
 *   source    where the macros come from
 */
(function (root) {
  'use strict';

  const REF = 'Reference values (NEVO 2023 / Belgian label typical)';

  const FOODS = [
    // ---------- protein ----------
    { id: 'chicken_breast', name: 'Chicken breast fillet', nameNl: 'Kipfilet', category: 'protein', kcal: 108, protein: 23.5, carbs: 0, fat: 1.4, fibre: 0, slots: ['protein'], meals: ['main'], fill: 4, maxPerMeal: 300, source: 'NEVO 2025 kipfilet rauw: 109 kcal, 23.3 P, 0 C, 1.8 F' },
    { id: 'turkey_breast', name: 'Turkey breast fillet', nameNl: 'Kalkoenfilet', category: 'protein', kcal: 104, protein: 24, carbs: 0, fat: 0.9, fibre: 0, slots: ['protein'], meals: ['main'], fill: 4, maxPerMeal: 300, source: 'Dutch nutrition-table snippet (kalkoenfilet rauw): 110 kcal, 25 P, 1.2 F' },
    { id: 'beef_mince_lean', name: 'Lean minced beef (≤5% fat)', nameNl: 'Mager rundergehakt', category: 'protein', kcal: 125, protein: 21, carbs: 0, fat: 4.5, fibre: 0, slots: ['protein'], meals: ['main'], fill: 4, maxPerMeal: 300, source: 'USDA SR Legacy ground beef 95% lean/5% fat raw (21.4 P, 5.0 F, EU kcal ~131); from reference knowledge, FDC not reachable' },
    { id: 'beef_steak', name: 'Beef steak', nameNl: 'Rundssteak', category: 'protein', kcal: 108, protein: 22.9, carbs: 0, fat: 1.8, fibre: 0, slots: ['protein'], meals: ['main'], fill: 4, maxPerMeal: 300, source: 'Voedingscentrum (NEVO) biefstuk rauw: 108 kcal, 22.9 P, 0 C, 1.8 F' },
    { id: 'pork_tenderloin', name: 'Pork tenderloin', nameNl: 'Varkenshaasje', category: 'protein', kcal: 109, protein: 21.5, carbs: 0, fat: 2.5, fibre: 0, slots: ['protein'], meals: ['main'], fill: 4, maxPerMeal: 300, source: 'Voedingscentrum varkenshaas rauw: 105 kcal, 22.4 P, 0 C, 1.7 F' },
    { id: 'cod', name: 'Cod fillet', nameNl: 'Kabeljauwfilet', category: 'protein', kcal: 77, protein: 18, carbs: 0, fat: 0.6, fibre: 0, slots: ['protein'], meals: ['main'], fill: 4, maxPerMeal: 350, source: 'Voedingscentrum / Dutch-table snippet kabeljauw rauw: ~82 kcal, 18 P, 0.7 F' },
    { id: 'salmon', name: 'Salmon fillet', nameNl: 'Zalmfilet', category: 'protein', kcal: 197, protein: 20, carbs: 0, fat: 13, fibre: 0, slots: ['protein'], meals: ['main'], fill: 3, maxPerMeal: 250, source: 'voedingswaardetabel.nl (NEVO-based) zalm onbereid: 200 kcal, 20.0 P, 13.5 F' },
    { id: 'tuna_water', name: 'Tuna in water (drained)', nameNl: 'Tonijn in water', category: 'protein', kcal: 108, protein: 25, carbs: 0, fat: 1, fibre: 0, slots: ['protein'], meals: ['main'], fill: 3, maxPerMeal: 250, source: 'Search snippet for canned tuna in water, drained: 116 kcal, 25.5 P, 0.8 F (USDA-type value); another brand 99 kcal, 24 P, 0.5 F' },
    { id: 'scampi', name: 'Scampi / prawns (peeled)', nameNl: 'Scampi gepeld', category: 'protein', kcal: 72, protein: 16.5, carbs: 0, fat: 0.7, fibre: 0, slots: ['protein'], meals: ['main'], fill: 3, maxPerMeal: 350, source: 'Voedingscentrum garnalen: 70 kcal, 15.4 P, 0 C, 0.9 F' },
    { id: 'eggs', name: 'Eggs', nameNl: 'Eieren', category: 'protein', kcal: 139, protein: 12.6, carbs: 0.7, fat: 9.5, fibre: 0, slots: ['protein'], meals: ['breakfast', 'main'], fill: 4, maxPerMeal: 275, unit: { name: 'egg', grams: 55 }, source: 'USDA SR Legacy whole egg raw (12.56 P, 0.72 C, 9.51 F -> EU ~139 kcal); from reference knowledge' },
    { id: 'egg_whites', name: 'Liquid egg whites', nameNl: 'Vloeibaar eiwit', category: 'protein', kcal: 48, protein: 10.5, carbs: 0.7, fat: 0.2, fibre: 0, slots: ['protein'], meals: ['breakfast', 'main'], fill: 4, maxPerMeal: 400, source: 'Search snippet for pasteurised liquid egg white: 48 kcal, 11 P, 0 C, 0 F; USDA raw egg white 52 kcal, 10.9 P, 0.7 C, 0.2 F (knowledge)' },
    { id: 'whey', name: 'Whey protein powder', nameNl: 'Whey proteïne', category: 'protein', kcal: 380, protein: 78, carbs: 6, fat: 5, fibre: 0, slots: ['protein'], meals: ['breakfast'], fill: 1, maxPerMeal: 60, unit: { name: 'scoop', grams: 30 }, source: 'Search snippet whey concentrate labels: HPV WPC 373 kcal, 74.1 P, 6.5 C, 5.5 F; Pulsin WPC 1722 kJ, 82 P, 4 C, 7.5 F' },
    { id: 'ham_lean', name: 'Lean cooked ham', nameNl: 'Gekookte ham (mager)', category: 'protein', kcal: 110, protein: 20, carbs: 1, fat: 3, fibre: 0, slots: ['protein'], meals: ['breakfast', 'main'], fill: 3, maxPerMeal: 200, source: 'fatsecret.be (via search) Boni gekookte ham ontvet: 113 kcal/100 g' },
    { id: 'chicken_slices', name: 'Chicken breast slices', nameNl: 'Kipfilet (beleg)', category: 'protein', kcal: 104, protein: 21, carbs: 1.5, fat: 1.5, fibre: 0, slots: ['protein'], meals: ['breakfast', 'main'], fill: 3, maxPerMeal: 200, source: 'No complete reference retrieved; typical Belgian/Dutch chicken-fillet cold cut' },
    { id: 'tofu', name: 'Tofu (firm)', nameNl: 'Tofu naturel', category: 'protein', kcal: 125, protein: 13, carbs: 1.5, fat: 7.5, fibre: 1, slots: ['protein'], meals: ['main'], fill: 3, maxPerMeal: 300, source: 'Ekoplaza listing (snippet attributes it to Alpro tofu naturel): 113 kcal, 12.5 P, 1.0 C, 6.5 F, 0.4 fibre' },

    // ---------- dairy ----------
    { id: 'skyr', name: 'Skyr natural 0%', nameNl: 'Skyr natuur', category: 'dairy', kcal: 62, protein: 11, carbs: 4, fat: 0.2, fibre: 0, slots: ['protein'], meals: ['breakfast'], fill: 5, maxPerMeal: 500, source: 'Boni Skyr natuur via fatsecret.be / Solucious snippet: 62 kcal, 11 P, 4 C, 0.5 F' },
    { id: 'quark', name: 'Low-fat quark 0%', nameNl: 'Magere platte kaas', category: 'dairy', kcal: 52, protein: 8.3, carbs: 4, fat: 0.2, fibre: 0, slots: ['protein'], meals: ['breakfast'], fill: 5, maxPerMeal: 500, source: 'fatsecret.be: Boni verse kaas 0% 49 kcal; Carrefour platte kaas 0% 54 kcal' },
    { id: 'cottage', name: 'Cottage cheese (light)', nameNl: 'Cottage cheese light', category: 'dairy', kcal: 74, protein: 12.5, carbs: 2.7, fat: 1.5, fibre: 0, slots: ['protein'], meals: ['breakfast'], fill: 4, maxPerMeal: 400, source: 'Search snippet: Milbona cottage cheese light 77 kcal, 11 P, 2.4 F' },
    { id: 'greek_yogurt_0', name: 'Greek-style yogurt 0%', nameNl: 'Griekse yoghurt 0%', category: 'dairy', kcal: 57, protein: 10, carbs: 4, fat: 0.2, fibre: 0, slots: ['protein'], meals: ['breakfast'], fill: 5, maxPerMeal: 500, source: 'fatsecret.be Boni Griekse yoghurt 0%: 58 kcal; Dutch table mager Griekse yoghurt: 56 kcal, 10.2 P, 3.5 C, 0.4 F' },
    { id: 'milk_skim', name: 'Skimmed milk', nameNl: 'Magere melk', category: 'dairy', kcal: 35, protein: 3.5, carbs: 4.8, fat: 0.1, fibre: 0, slots: ['protein'], meals: ['breakfast'], fill: 2, maxPerMeal: 500, source: 'Voedingscentrum magere melk (per 250 g: 88 kcal, 9.3 P, 12.2 C, 0.2 F -> 35 kcal, 3.7 P, 4.9 C, 0.1 F per 100)' },
    { id: 'milk_semi', name: 'Semi-skimmed milk', nameNl: 'Halfvolle melk', category: 'dairy', kcal: 46, protein: 3.4, carbs: 4.8, fat: 1.5, fibre: 0, slots: ['protein'], meals: ['breakfast'], fill: 2, maxPerMeal: 500, source: 'Dutch table / Voedingscentrum halfvolle melk: 46 kcal, 3.4 P, 4.8 C, 1.5 F; fatsecret.be Boni Bio melk halfvol 46 kcal' },
    { id: 'mozzarella_light', name: 'Light mozzarella', nameNl: 'Mozzarella light', category: 'dairy', kcal: 160, protein: 19, carbs: 1, fat: 9, fibre: 0, slots: ['protein', 'fat'], meals: ['main'], fill: 2, maxPerMeal: 125, source: 'fatsecret.nl snippet Galbani Mozzarella Light: 167 kcal, 20 P, 9 F' },
    { id: 'gouda', name: 'Young Gouda cheese', nameNl: 'Jonge Goudse kaas', category: 'dairy', kcal: 356, protein: 24, carbs: 0, fat: 28.5, fibre: 0, slots: ['fat'], meals: ['breakfast', 'main'], fill: 2, maxPerMeal: 60, source: 'Voedingscentrum kaas 48+ jong belegen per 30 g slice: 111 kcal, 6.8 P, 0 C, 9 F (-> 370 kcal, 22.7 P, 30 F per 100 g)' },

    // ---------- carb ----------
    { id: 'potatoes', name: 'Potatoes', nameNl: 'Aardappelen', category: 'carb', kcal: 88, protein: 2, carbs: 19, fat: 0.1, fibre: 1.8, slots: ['carb'], meals: ['main'], fill: 5, maxPerMeal: 700, source: 'Voedingscentrum (NEVO) aardappelen rauw: 88 kcal, 2 P, 19 C, 0 F, 1.8 fibre' },
    { id: 'sweet_potato', name: 'Sweet potato', nameNl: 'Zoete aardappel', category: 'carb', kcal: 82, protein: 1.6, carbs: 17.1, fat: 0.1, fibre: 3, slots: ['carb'], meals: ['main'], fill: 4, maxPerMeal: 600, source: 'USDA SR Legacy sweet potato raw (86 kcal US, 1.57 P, 20.1 total C incl. 3.0 fibre, 0.05 F), converted to EU basis; from reference knowledge' },
    { id: 'oats', name: 'Rolled oats', nameNl: 'Havervlokken', category: 'carb', kcal: 372, protein: 13.5, carbs: 58.7, fat: 7, fibre: 10, slots: ['carb'], meals: ['breakfast'], fill: 5, maxPerMeal: 150, source: 'fatsecret.be Boni havermout 364 kcal; Dutch-table havermout ~366 kcal, 12.8 P, 59.2 C, 6.2 F' },
    { id: 'rice_basmati', name: 'Basmati rice (dry)', nameNl: 'Basmatirijst', category: 'carb', kcal: 355, protein: 8.5, carbs: 78, fat: 0.8, fibre: 1.2, slots: ['carb'], meals: ['main'], fill: 2, maxPerMeal: 150, source: 'Dutch-table / label snippets basmati raw: 352 kcal, 7 P, 78 C, 1 F; 365 kcal, 8.6 P, 75.8 C, 1.0 F, 1.2 fibre' },
    { id: 'rice_brown', name: 'Brown rice (dry)', nameNl: 'Volkorenrijst', category: 'carb', kcal: 355, protein: 8, carbs: 74, fat: 2.5, fibre: 3.5, slots: ['carb'], meals: ['main'], fill: 3, maxPerMeal: 150, source: 'voedingswaardetabel.nl zilvervliesrijst raw: 361 kcal, 7.5 P, 75 C, 2.2 F' },
    { id: 'pasta_wholewheat', name: 'Wholewheat pasta (dry)', nameNl: 'Volkoren pasta', category: 'carb', kcal: 348, protein: 13, carbs: 63, fat: 2.5, fibre: 8, slots: ['carb'], meals: ['main'], fill: 3, maxPerMeal: 150, source: 'fatsecret.be Delhaize volkorenpasta: 349 kcal, 12.2 P, 63.1 C, 8.9 fibre' },
    { id: 'pasta', name: 'Pasta (dry)', nameNl: 'Pasta', category: 'carb', kcal: 356, protein: 12.5, carbs: 71, fat: 1.5, fibre: 3, slots: ['carb'], meals: ['main'], fill: 2, maxPerMeal: 150, source: 'Voedingscentrum spaghetti (dry): 356 kcal, 12.3 P, 72 C, 3 fibre' },
    { id: 'bread_wholemeal', name: 'Wholemeal bread', nameNl: 'Volkorenbrood', category: 'carb', kcal: 240, protein: 10, carbs: 40, fat: 3, fibre: 7, slots: ['carb'], meals: ['breakfast', 'main'], fill: 3, maxPerMeal: 210, unit: { name: 'slice', grams: 35 }, source: 'Voedingscentrum volkorenbrood (NEVO) portion values scaled: ~236 kcal, 11.2 P, 39 C, 2.4 F, 6.8 fibre per 100 g' },
    { id: 'rice_cakes', name: 'Rice cakes', nameNl: 'Rijstwafels', category: 'carb', kcal: 384, protein: 8, carbs: 81, fat: 2.8, fibre: 3, slots: ['carb'], meals: ['breakfast'], fill: 1, maxPerMeal: 64, unit: { name: 'cake', grams: 8 }, source: 'Dutch-table snippets rijstwafel naturel: 390 kcal, 6.6 P, 81.8 C, 3 F (matches); another gives 374 kcal, 8.0 P, 74.5 C, 3.5 F' },
    { id: 'couscous', name: 'Couscous (dry)', nameNl: 'Couscous', category: 'carb', kcal: 360, protein: 12.5, carbs: 72, fat: 1.5, fibre: 4, slots: ['carb'], meals: ['main'], fill: 2, maxPerMeal: 150, source: 'fatsecret.be: Boni couscous 365 kcal, Delhaize couscous 365 kcal, Carrefour Bio 348 kcal; generic dry couscous 350 kcal, 12 P, 70 C, 1.5 F, 3.5 fibre' },
    { id: 'quinoa', name: 'Quinoa (dry)', nameNl: 'Quinoa', category: 'carb', kcal: 370, protein: 13, carbs: 60, fat: 6.6, fibre: 7, slots: ['carb'], meals: ['main'], fill: 3, maxPerMeal: 150, source: 'Carrefour Bio quinoa label values via fitia.app / les-calories search snippet: 370 kcal, 13 P, 60 C, 6.6 F; NEVO (voedingswaardetabel.nl quinoa…' },
    { id: 'wraps_wholewheat', name: 'Wholewheat wraps', nameNl: 'Volkoren wraps', category: 'carb', kcal: 300, protein: 9, carbs: 48, fat: 7, fibre: 5, slots: ['carb'], meals: ['main'], fill: 2, maxPerMeal: 186, unit: { name: 'wrap', grams: 62 }, source: 'fatsecret.be: Delhaize wraps 297 kcal/100 g, Carrefour wraps 326 kcal/100 g' },
    { id: 'chickpeas', name: 'Chickpeas (canned, drained)', nameNl: 'Kikkererwten', category: 'carb', kcal: 121, protein: 6.4, carbs: 15, fat: 2.2, fibre: 7.7, slots: ['carb'], meals: ['main'], fill: 4, maxPerMeal: 400, source: 'Bonduelle kikkererwten label: 121 kcal, 6.4 P, 15 C, 2.2 F, 7.7 fibre' },
    { id: 'kidney_beans', name: 'Kidney beans (canned, drained)', nameNl: 'Rode kidneybonen', category: 'carb', kcal: 100, protein: 7.5, carbs: 13, fat: 0.5, fibre: 6.5, slots: ['carb'], meals: ['main'], fill: 4, maxPerMeal: 400, source: 'fatsecret.be Boni rode kidneybonen 100 kcal; AH Terra kidneybonen label 101 kcal, 8 P, 12 C, 0.8 F, 7 fibre (snippet)' },
    { id: 'lentils_red', name: 'Red lentils (dry)', nameNl: 'Rode linzen', category: 'carb', kcal: 346, protein: 23.9, carbs: 52.3, fat: 2.2, fibre: 10.8, slots: ['carb'], meals: ['main'], fill: 4, maxPerMeal: 125, source: 'USDA SR Legacy lentils, pink/red, raw (358 kcal US, 23.9 P, 63.1 total C incl. 10.8 fibre, 2.17 F), converted to EU basis; from reference knowledge' },

    // ---------- vegetable ----------
    { id: 'broccoli', name: 'Broccoli', nameNl: 'Broccoli', category: 'vegetable', kcal: 27, protein: 2.9, carbs: 0.7, fat: 0.7, fibre: 3.1, slots: ['produce'], meals: ['main'], fill: 5, maxPerMeal: 400, source: 'NEVO broccoli rauw (fatsecret ’Nevo broccoli rauw’ snippet 27 kcal, 2.9 P, 0.7 C, 0.7 F) + Voedingscentrum per 50 g (14 kcal, 1.4 P, 0.4 C, 0.4 F,…' },
    { id: 'green_beans', name: 'Green beans', nameNl: 'Sperziebonen', category: 'vegetable', kcal: 24, protein: 2.4, carbs: 1.8, fat: 0.2, fibre: 3.6, slots: ['produce'], meals: ['main'], fill: 5, maxPerMeal: 400, source: 'Voedingscentrum (NEVO) sperziebonen rauw per 50 g: 12 kcal, 1.2 P, 0.9 C, 0.1 F, 1.8 fibre (scaled x2)' },
    { id: 'spinach', name: 'Spinach', nameNl: 'Spinazie', category: 'vegetable', kcal: 26, protein: 3.2, carbs: 0.9, fat: 0.6, fibre: 2, slots: ['produce'], meals: ['main'], fill: 4, maxPerMeal: 400, source: 'Dutch table (NEVO-based) spinazie vers: 26 kcal, 3.2 P, 0.9 C, 0.6 F, 2.0 fibre' },
    { id: 'carrots', name: 'Carrots', nameNl: 'Wortelen', category: 'vegetable', kcal: 33, protein: 1, carbs: 5.2, fat: 0.3, fibre: 2.9, slots: ['produce'], meals: ['main'], fill: 5, maxPerMeal: 400, source: 'Voedingscentrum (NEVO) wortels rauw per 70 g: 22 kcal, 0.6 P, 3.7 C, 0.2 F, 2 fibre (-> 31, 0.9, 5.3, 0.3, 2.9) and voedingswaardetabel.nl 33 kcal,…' },
    { id: 'bell_pepper', name: 'Red bell pepper', nameNl: 'Rode paprika', category: 'vegetable', kcal: 25, protein: 0.8, carbs: 4.3, fat: 0.1, fibre: 1.8, slots: ['produce'], meals: ['main'], fill: 4, maxPerMeal: 400, source: 'Voedingscentrum (NEVO) paprika rode rauw per 135 g piece: 34 kcal, 1.1 P, 5.8 C, 0.1 F, 2.4 fibre (scaled to 100 g)' },
    { id: 'courgette', name: 'Courgette', nameNl: 'Courgette', category: 'vegetable', kcal: 18, protein: 1.3, carbs: 2.2, fat: 0.3, fibre: 1.1, slots: ['produce'], meals: ['main'], fill: 4, maxPerMeal: 400, source: 'Voedingscentrum courgette rauw per 50 g: 9 kcal, 0.6 P, 1.2 C, 0.1 F, 0.5 fibre (-> 18, 1.2, 2.4, 0.2, 1.0)' },
    { id: 'cauliflower', name: 'Cauliflower', nameNl: 'Bloemkool', category: 'vegetable', kcal: 25, protein: 1.9, carbs: 3, fat: 0.3, fibre: 2.3, slots: ['produce'], meals: ['main'], fill: 5, maxPerMeal: 400, source: 'Voedingscentrum bloemkool rauw per 70 g: 18 kcal, 1.3 P, 2.1 C, 0.1 F, 1.5 fibre (-> 26, 1.9, 3.0, 0.1, 2.1)' },
    { id: 'tomatoes', name: 'Tomatoes', nameNl: 'Tomaten', category: 'vegetable', kcal: 20, protein: 0.9, carbs: 3, fat: 0.2, fibre: 1.2, slots: ['produce'], meals: ['main'], fill: 4, maxPerMeal: 400, source: 'NEVO (older edition) tomaat: 19–20 kcal, 0.9 P, 3 C, 0.2 F' },
    { id: 'cucumber', name: 'Cucumber', nameNl: 'Komkommer', category: 'vegetable', kcal: 13, protein: 0.7, carbs: 1.8, fat: 0.1, fibre: 0.7, slots: ['produce'], meals: ['main'], fill: 3, maxPerMeal: 400, source: 'Voedingscentrum komkommer met schil per 115 g: 15 kcal, 0.8 P, 1.5 C, 0.5 F, 0.7 fibre (-> 13, 0.7, 1.3, 0.4, 0.6); voedingswaardetabel.nl 14 kcal,…' },
    { id: 'brussels_sprouts', name: 'Brussels sprouts', nameNl: 'Spruitjes', category: 'vegetable', kcal: 43, protein: 3.4, carbs: 5, fat: 0.3, fibre: 3.8, slots: ['produce'], meals: ['main'], fill: 5, maxPerMeal: 400, source: 'Dutch-table snippet spruitjes rauw: 46 kcal, 2.3 P, 5.6 C, 0.7 F; USDA raw 43 kcal, 3.4 P, 5.2 available C, 0.3 F, 3.8 fibre (knowledge)' },
    { id: 'leek', name: 'Leek', nameNl: 'Prei', category: 'vegetable', kcal: 28, protein: 1.6, carbs: 3.6, fat: 0.1, fibre: 3.2, slots: ['produce'], meals: ['main'], fill: 4, maxPerMeal: 400, source: 'Voedingscentrum (NEVO) prei rauw per 25 g: 7 kcal, 0.4 P, 0.9 C, 0 F, 0.8 fibre (scaled x4); other Dutch table 26 kcal, 1.8 P, 4 C' },
    { id: 'mushrooms', name: 'Mushrooms', nameNl: 'Champignons', category: 'vegetable', kcal: 18, protein: 2.7, carbs: 0.3, fat: 0.3, fibre: 2, slots: ['produce'], meals: ['main'], fill: 4, maxPerMeal: 400, source: 'NEVO champignons rauw (16 kcal, 2.7 P, 0.3 C) with Belgian NICE fat 0.3–0.5 g → 18 kcal' },
    { id: 'witloof', name: 'Belgian endive', nameNl: 'Witloof', category: 'vegetable', kcal: 17, protein: 1, carbs: 2.5, fat: 0.1, fibre: 1.2, slots: ['produce'], meals: ['main'], fill: 4, maxPerMeal: 400, source: 'Voedingscentrum witlof per 80 g struik: 15 kcal, 1 P, 1.9 C, 0.2 F, 1 fibre (-> 19, 1.25, 2.4, 0.25, 1.25)' },
    { id: 'red_cabbage', name: 'Red cabbage', nameNl: 'Rode kool', category: 'vegetable', kcal: 28, protein: 2, carbs: 3.2, fat: 0.1, fibre: 3.6, slots: ['produce'], meals: ['main'], fill: 5, maxPerMeal: 400, source: 'Voedingscentrum (NEVO) rodekool per 25 g: 7 kcal, 0.5 P, 0.8 C, 0 F, 0.9 fibre (scaled x4)' },
    { id: 'wok_veg', name: 'Frozen stir-fry vegetables', nameNl: 'Wokgroenten (diepvries)', category: 'vegetable', kcal: 35, protein: 2, carbs: 5, fat: 0.3, fibre: 2.5, slots: ['produce'], meals: ['main'], fill: 4, maxPerMeal: 400, source: 'fatsecret.be: Boni wokgroenten mix 37 kcal/100 g; Delhaize wokgroenten 29-30 kcal; Carrefour pikante wokgroenten 41 kcal' },
    { id: 'salad_mix', name: 'Mixed salad leaves', nameNl: 'Slamix', category: 'vegetable', kcal: 15, protein: 1.3, carbs: 1.5, fat: 0.2, fibre: 1.3, slots: ['produce'], meals: ['main'], fill: 3, maxPerMeal: 250, source: 'USDA SR Legacy green leaf lettuce raw (15 kcal, 1.36 P, 1.57 available C, 0.15 F, 1.3 fibre); from reference knowledge' },

    // ---------- fruit ----------
    { id: 'banana', name: 'Banana', nameNl: 'Banaan', category: 'fruit', kcal: 93, protein: 1.1, carbs: 20, fat: 0.3, fibre: 2.3, slots: ['produce'], meals: ['breakfast', 'main'], fill: 3, maxPerMeal: 240, unit: { name: 'banana', grams: 120 }, source: 'USDA SR Legacy banana raw (1.09 P, 20.2 available C, 0.33 F, 2.6 fibre -> EU ~93 kcal); from reference knowledge' },
    { id: 'apple', name: 'Apple (Jonagold)', nameNl: 'Appel (Jonagold)', category: 'fruit', kcal: 54, protein: 0.3, carbs: 12, fat: 0.1, fibre: 2, slots: ['produce'], meals: ['breakfast', 'main'], fill: 4, maxPerMeal: 340, unit: { name: 'apple', grams: 170 }, source: 'USDA SR Legacy apple with skin (0.26 P, 11.4 available C, 0.17 F, 2.4 fibre -> EU ~54 kcal); from reference knowledge' },
    { id: 'pear', name: 'Pear (Conference)', nameNl: 'Peer (Conference)', category: 'fruit', kcal: 55, protein: 0.4, carbs: 12, fat: 0.1, fibre: 3, slots: ['produce'], meals: ['breakfast', 'main'], fill: 4, maxPerMeal: 340, unit: { name: 'pear', grams: 170 }, source: 'USDA SR Legacy pear raw (0.36 P, 12.1 available C, 0.14 F, 3.1 fibre -> EU ~57 kcal); from reference knowledge' },
    { id: 'strawberries', name: 'Strawberries', nameNl: 'Aardbeien', category: 'fruit', kcal: 33, protein: 0.7, carbs: 6, fat: 0.3, fibre: 2, slots: ['produce'], meals: ['breakfast', 'main'], fill: 4, maxPerMeal: 400, source: 'USDA SR Legacy strawberries raw (0.67 P, 5.7 available C, 0.3 F, 2.0 fibre -> EU ~32 kcal); from reference knowledge' },
    { id: 'blueberries', name: 'Blueberries', nameNl: 'Blauwe bessen', category: 'fruit', kcal: 57, protein: 0.7, carbs: 12, fat: 0.3, fibre: 2.4, slots: ['produce'], meals: ['breakfast', 'main'], fill: 3, maxPerMeal: 300, source: 'USDA SR Legacy blueberries raw (0.74 P, 12.1 available C, 0.33 F, 2.4 fibre -> EU ~59 kcal); from reference knowledge' },
    { id: 'frozen_berries', name: 'Frozen mixed berries', nameNl: 'Bosvruchten (diepvries)', category: 'fruit', kcal: 45, protein: 1, carbs: 7.5, fat: 0.4, fibre: 4, slots: ['produce'], meals: ['breakfast', 'main'], fill: 4, maxPerMeal: 300, source: 'No direct reference; USDA component berries (raspberry, blackberry, redcurrant, blueberry) average ~50 EU kcal, 1.2 P, 7.4 C, 0.4 F, 4.6 fibre…' },
    { id: 'orange', name: 'Orange', nameNl: 'Sinaasappel', category: 'fruit', kcal: 47, protein: 0.9, carbs: 10, fat: 0.2, fibre: 2, slots: ['produce'], meals: ['breakfast', 'main'], fill: 4, maxPerMeal: 300, unit: { name: 'orange', grams: 150 }, source: 'USDA SR Legacy orange raw (0.94 P, 9.35 available C, 0.12 F, 2.4 fibre -> EU ~47 kcal); from reference knowledge' },
    { id: 'kiwi', name: 'Kiwi', nameNl: 'Kiwi', category: 'fruit', kcal: 61, protein: 1.1, carbs: 12, fat: 0.5, fibre: 3, slots: ['produce'], meals: ['breakfast', 'main'], fill: 3, maxPerMeal: 300, unit: { name: 'kiwi', grams: 75 }, source: 'USDA SR Legacy green kiwifruit raw (1.14 P, 11.7 available C, 0.52 F, 3.0 fibre -> EU ~64 kcal); from reference knowledge' },
    { id: 'mandarin', name: 'Mandarin', nameNl: 'Mandarijn', category: 'fruit', kcal: 56, protein: 0.8, carbs: 11.5, fat: 0.3, fibre: 1.8, slots: ['produce'], meals: ['breakfast', 'main'], fill: 3, maxPerMeal: 280, unit: { name: 'mandarin', grams: 70 }, source: 'USDA SR Legacy tangerine/mandarin raw (53 kcal US, 0.81 P, 13.34 total C incl. 1.8 fibre, 0.31 F) converted to EU basis; from reference knowledge' },

    // ---------- fat ----------
    { id: 'olive_oil', name: 'Olive oil', nameNl: 'Olijfolie', category: 'fat', kcal: 900, protein: 0, carbs: 0, fat: 100, fibre: 0, slots: ['fat'], meals: ['main'], fill: 1, maxPerMeal: 25, source: 'EU labelling: 100 g fat = 900 kcal per 100 g (labels per 100 ml show ~824 kcal, 91.6 g fat)' },
    { id: 'peanut_butter', name: 'Peanut butter (100% peanuts)', nameNl: 'Pindakaas 100%', category: 'fat', kcal: 620, protein: 25, carbs: 12, fat: 50, fibre: 8, slots: ['fat'], meals: ['breakfast'], fill: 2, maxPerMeal: 40, source: 'USDA SR Legacy peanuts dry-roasted (24.4 P, 13.5 available C, 49.7 F, 8.0 fibre -> EU ~615 kcal) as proxy for 100% peanut butter; from reference…' },
    { id: 'almonds', name: 'Almonds', nameNl: 'Amandelen', category: 'fat', kcal: 631, protein: 21.7, carbs: 7.1, fat: 55.8, fibre: 7.2, slots: ['fat'], meals: ['breakfast', 'main'], fill: 2, maxPerMeal: 40, source: 'NEVO via Dutch-table snippet (631 kcal, 21.7 P, 7.1 C, 55.8 F) + Voedingscentrum amandelen ongezouten per 25 g (158 kcal, 5.4 P, 1.8 C, 14 F, 1.8…' },
    { id: 'walnuts', name: 'Walnuts', nameNl: 'Walnoten', category: 'fat', kcal: 690, protein: 15, carbs: 7, fat: 67, fibre: 6, slots: ['fat'], meals: ['breakfast', 'main'], fill: 2, maxPerMeal: 40, source: 'Voedingscentrum walnoten ongezouten: 699 kcal, 14.6 P, 65.9 F; USDA available carbs 7.0, fibre 6.7 (knowledge)' },
    { id: 'avocado', name: 'Avocado', nameNl: 'Avocado', category: 'fat', kcal: 160, protein: 2, carbs: 2, fat: 15, fibre: 6.7, slots: ['fat'], meals: ['main'], fill: 3, maxPerMeal: 150, source: 'USDA SR Legacy avocado raw (2.0 P, 1.8 available C, 14.7 F, 6.7 fibre -> EU ~161 kcal); from reference knowledge' },
    { id: 'chia', name: 'Chia seeds', nameNl: 'Chiazaad', category: 'fat', kcal: 443, protein: 16.5, carbs: 7.7, fat: 30.7, fibre: 34.4, slots: ['fat'], meals: ['breakfast'], fill: 3, maxPerMeal: 30, source: 'USDA SR Legacy chia seeds on EU basis, confirmed by Dutch snippet: 443 kcal, 16.5 P, 7.7 C, 34.4 fibre; fat 30.7 (USDA)' }
  ];

  FOODS.forEach(function (f) {
    if (!f.source) f.source = REF;
    if (!f.unit) f.unit = null;
  });

  const CATEGORIES = ['protein', 'carb', 'fat', 'vegetable', 'fruit', 'dairy'];

  // Foods pre-selected as "liked" in the example setup: the high-volume, high-protein bias from the brief.
  const DEFAULT_LIKED = [
    'chicken_breast', 'turkey_breast', 'beef_mince_lean', 'cod', 'eggs', 'egg_whites',
    'skyr', 'quark', 'potatoes', 'oats', 'rice_basmati', 'bread_wholemeal',
    'broccoli', 'green_beans', 'carrots', 'bell_pepper', 'brussels_sprouts',
    'apple', 'banana', 'frozen_berries', 'olive_oil', 'peanut_butter', 'almonds'
  ];

  function byId(list) {
    const map = {};
    (list || FOODS).forEach(function (f) { map[f.id] = f; });
    return map;
  }

  const api = { FOODS: FOODS, CATEGORIES: CATEGORIES, DEFAULT_LIKED: DEFAULT_LIKED, byId: byId };

  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.FL = root.FL || {}; root.FL.foods = api; }
})(typeof window !== 'undefined' ? window : globalThis);
