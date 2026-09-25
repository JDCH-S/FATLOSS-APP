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
    { id: 'chicken_breast', name: 'Chicken breast fillet', nameNl: 'Kipfilet', category: 'protein', kcal: 108, protein: 23.5, carbs: 0, fat: 1.4, fibre: 0, slots: ['protein'], meals: ['main'], fill: 4, maxPerMeal: 300 },
    { id: 'turkey_breast', name: 'Turkey breast fillet', nameNl: 'Kalkoenfilet', category: 'protein', kcal: 104, protein: 24, carbs: 0, fat: 0.9, fibre: 0, slots: ['protein'], meals: ['main'], fill: 4, maxPerMeal: 300 },
    { id: 'beef_mince_lean', name: 'Lean minced beef (≤5% fat)', nameNl: 'Mager rundergehakt', category: 'protein', kcal: 125, protein: 21, carbs: 0, fat: 4.5, fibre: 0, slots: ['protein'], meals: ['main'], fill: 4, maxPerMeal: 300 },
    { id: 'beef_steak', name: 'Beef steak', nameNl: 'Rundssteak', category: 'protein', kcal: 121, protein: 22, carbs: 0, fat: 3.7, fibre: 0, slots: ['protein'], meals: ['main'], fill: 4, maxPerMeal: 300 },
    { id: 'pork_tenderloin', name: 'Pork tenderloin', nameNl: 'Varkenshaasje', category: 'protein', kcal: 109, protein: 21.5, carbs: 0, fat: 2.5, fibre: 0, slots: ['protein'], meals: ['main'], fill: 4, maxPerMeal: 300 },
    { id: 'cod', name: 'Cod fillet', nameNl: 'Kabeljauwfilet', category: 'protein', kcal: 77, protein: 18, carbs: 0, fat: 0.6, fibre: 0, slots: ['protein'], meals: ['main'], fill: 4, maxPerMeal: 350 },
    { id: 'salmon', name: 'Salmon fillet', nameNl: 'Zalmfilet', category: 'protein', kcal: 197, protein: 20, carbs: 0, fat: 13, fibre: 0, slots: ['protein'], meals: ['main'], fill: 3, maxPerMeal: 250 },
    { id: 'tuna_water', name: 'Tuna in water (drained)', nameNl: 'Tonijn in water', category: 'protein', kcal: 108, protein: 25, carbs: 0, fat: 1, fibre: 0, slots: ['protein'], meals: ['main'], fill: 3, maxPerMeal: 250 },
    { id: 'scampi', name: 'Scampi / prawns (peeled)', nameNl: 'Scampi gepeld', category: 'protein', kcal: 72, protein: 16.5, carbs: 0, fat: 0.7, fibre: 0, slots: ['protein'], meals: ['main'], fill: 3, maxPerMeal: 350 },
    { id: 'eggs', name: 'Eggs', nameNl: 'Eieren', category: 'protein', kcal: 139, protein: 12.6, carbs: 0.7, fat: 9.5, fibre: 0, slots: ['protein'], meals: ['breakfast', 'main'], fill: 4, maxPerMeal: 275, unit: { name: 'egg', grams: 55 } },
    { id: 'egg_whites', name: 'Liquid egg whites', nameNl: 'Vloeibaar eiwit', category: 'protein', kcal: 48, protein: 10.5, carbs: 0.7, fat: 0.2, fibre: 0, slots: ['protein'], meals: ['breakfast', 'main'], fill: 4, maxPerMeal: 400 },
    { id: 'whey', name: 'Whey protein powder', nameNl: 'Whey proteïne', category: 'protein', kcal: 380, protein: 78, carbs: 6, fat: 5, fibre: 0, slots: ['protein'], meals: ['breakfast'], fill: 1, maxPerMeal: 60, unit: { name: 'scoop', grams: 30 } },
    { id: 'ham_lean', name: 'Lean cooked ham', nameNl: 'Gekookte ham (mager)', category: 'protein', kcal: 110, protein: 20, carbs: 1, fat: 3, fibre: 0, slots: ['protein'], meals: ['breakfast', 'main'], fill: 3, maxPerMeal: 200 },
    { id: 'chicken_slices', name: 'Chicken breast slices', nameNl: 'Kipfilet (beleg)', category: 'protein', kcal: 104, protein: 21, carbs: 1.5, fat: 1.5, fibre: 0, slots: ['protein'], meals: ['breakfast', 'main'], fill: 3, maxPerMeal: 200 },
    { id: 'tofu', name: 'Tofu (firm)', nameNl: 'Tofu naturel', category: 'protein', kcal: 125, protein: 13, carbs: 1.5, fat: 7.5, fibre: 1, slots: ['protein'], meals: ['main'], fill: 3, maxPerMeal: 300 },

    // ---------- dairy ----------
    { id: 'skyr', name: 'Skyr natural 0%', nameNl: 'Skyr natuur', category: 'dairy', kcal: 62, protein: 11, carbs: 4, fat: 0.2, fibre: 0, slots: ['protein'], meals: ['breakfast'], fill: 5, maxPerMeal: 500 },
    { id: 'quark', name: 'Low-fat quark 0%', nameNl: 'Magere platte kaas', category: 'dairy', kcal: 52, protein: 8.3, carbs: 4, fat: 0.2, fibre: 0, slots: ['protein'], meals: ['breakfast'], fill: 5, maxPerMeal: 500 },
    { id: 'cottage', name: 'Cottage cheese (light)', nameNl: 'Cottage cheese light', category: 'dairy', kcal: 74, protein: 12.5, carbs: 2.7, fat: 1.5, fibre: 0, slots: ['protein'], meals: ['breakfast'], fill: 4, maxPerMeal: 400 },
    { id: 'greek_yogurt_0', name: 'Greek-style yogurt 0%', nameNl: 'Griekse yoghurt 0%', category: 'dairy', kcal: 57, protein: 10, carbs: 4, fat: 0.2, fibre: 0, slots: ['protein'], meals: ['breakfast'], fill: 5, maxPerMeal: 500 },
    { id: 'milk_skim', name: 'Skimmed milk', nameNl: 'Magere melk', category: 'dairy', kcal: 35, protein: 3.5, carbs: 4.8, fat: 0.1, fibre: 0, slots: ['protein'], meals: ['breakfast'], fill: 2, maxPerMeal: 500 },
    { id: 'milk_semi', name: 'Semi-skimmed milk', nameNl: 'Halfvolle melk', category: 'dairy', kcal: 46, protein: 3.4, carbs: 4.8, fat: 1.5, fibre: 0, slots: ['protein'], meals: ['breakfast'], fill: 2, maxPerMeal: 500 },
    { id: 'mozzarella_light', name: 'Light mozzarella', nameNl: 'Mozzarella light', category: 'dairy', kcal: 160, protein: 19, carbs: 1, fat: 9, fibre: 0, slots: ['protein', 'fat'], meals: ['main'], fill: 2, maxPerMeal: 125 },
    { id: 'gouda', name: 'Young Gouda cheese', nameNl: 'Jonge Goudse kaas', category: 'dairy', kcal: 356, protein: 24, carbs: 0, fat: 28.5, fibre: 0, slots: ['fat'], meals: ['breakfast', 'main'], fill: 2, maxPerMeal: 60 },

    // ---------- carb ----------
    { id: 'potatoes', name: 'Potatoes', nameNl: 'Aardappelen', category: 'carb', kcal: 80, protein: 2, carbs: 17, fat: 0.1, fibre: 1.8, slots: ['carb'], meals: ['main'], fill: 5, maxPerMeal: 700 },
    { id: 'sweet_potato', name: 'Sweet potato', nameNl: 'Zoete aardappel', category: 'carb', kcal: 86, protein: 1.6, carbs: 20, fat: 0.1, fibre: 3, slots: ['carb'], meals: ['main'], fill: 4, maxPerMeal: 600 },
    { id: 'oats', name: 'Rolled oats', nameNl: 'Havervlokken', category: 'carb', kcal: 372, protein: 13.5, carbs: 58.7, fat: 7, fibre: 10, slots: ['carb'], meals: ['breakfast'], fill: 5, maxPerMeal: 150 },
    { id: 'rice_basmati', name: 'Basmati rice (dry)', nameNl: 'Basmatirijst', category: 'carb', kcal: 355, protein: 8.5, carbs: 78, fat: 0.8, fibre: 1.2, slots: ['carb'], meals: ['main'], fill: 2, maxPerMeal: 150 },
    { id: 'rice_brown', name: 'Brown rice (dry)', nameNl: 'Volkorenrijst', category: 'carb', kcal: 355, protein: 8, carbs: 74, fat: 2.5, fibre: 3.5, slots: ['carb'], meals: ['main'], fill: 3, maxPerMeal: 150 },
    { id: 'pasta_wholewheat', name: 'Wholewheat pasta (dry)', nameNl: 'Volkoren pasta', category: 'carb', kcal: 348, protein: 13, carbs: 63, fat: 2.5, fibre: 8, slots: ['carb'], meals: ['main'], fill: 3, maxPerMeal: 150 },
    { id: 'pasta', name: 'Pasta (dry)', nameNl: 'Pasta', category: 'carb', kcal: 356, protein: 12.5, carbs: 71, fat: 1.5, fibre: 3, slots: ['carb'], meals: ['main'], fill: 2, maxPerMeal: 150 },
    { id: 'bread_wholemeal', name: 'Wholemeal bread', nameNl: 'Volkorenbrood', category: 'carb', kcal: 240, protein: 10, carbs: 40, fat: 3, fibre: 7, slots: ['carb'], meals: ['breakfast', 'main'], fill: 3, maxPerMeal: 210, unit: { name: 'slice', grams: 35 } },
    { id: 'rice_cakes', name: 'Rice cakes', nameNl: 'Rijstwafels', category: 'carb', kcal: 384, protein: 8, carbs: 81, fat: 2.8, fibre: 3, slots: ['carb'], meals: ['breakfast'], fill: 1, maxPerMeal: 64, unit: { name: 'cake', grams: 8 } },
    { id: 'couscous', name: 'Couscous (dry)', nameNl: 'Couscous', category: 'carb', kcal: 360, protein: 12.5, carbs: 72, fat: 1.5, fibre: 4, slots: ['carb'], meals: ['main'], fill: 2, maxPerMeal: 150 },
    { id: 'quinoa', name: 'Quinoa (dry)', nameNl: 'Quinoa', category: 'carb', kcal: 368, protein: 14, carbs: 64, fat: 6, fibre: 7, slots: ['carb'], meals: ['main'], fill: 3, maxPerMeal: 150 },
    { id: 'wraps_wholewheat', name: 'Wholewheat wraps', nameNl: 'Volkoren wraps', category: 'carb', kcal: 300, protein: 9, carbs: 48, fat: 7, fibre: 5, slots: ['carb'], meals: ['main'], fill: 2, maxPerMeal: 186, unit: { name: 'wrap', grams: 62 } },
    { id: 'chickpeas', name: 'Chickpeas (canned, drained)', nameNl: 'Kikkererwten', category: 'carb', kcal: 122, protein: 7, carbs: 15, fat: 2.5, fibre: 6, slots: ['carb'], meals: ['main'], fill: 4, maxPerMeal: 400 },
    { id: 'kidney_beans', name: 'Kidney beans (canned, drained)', nameNl: 'Rode kidneybonen', category: 'carb', kcal: 100, protein: 7.5, carbs: 13, fat: 0.5, fibre: 6.5, slots: ['carb'], meals: ['main'], fill: 4, maxPerMeal: 400 },
    { id: 'lentils_red', name: 'Red lentils (dry)', nameNl: 'Rode linzen', category: 'carb', kcal: 335, protein: 24, carbs: 50, fat: 1.5, fibre: 11, slots: ['carb'], meals: ['main'], fill: 4, maxPerMeal: 125 },

    // ---------- vegetable ----------
    { id: 'broccoli', name: 'Broccoli', nameNl: 'Broccoli', category: 'vegetable', kcal: 34, protein: 2.8, carbs: 4, fat: 0.4, fibre: 2.6, slots: ['produce'], meals: ['main'], fill: 5, maxPerMeal: 400 },
    { id: 'green_beans', name: 'Green beans', nameNl: 'Sperziebonen', category: 'vegetable', kcal: 31, protein: 1.8, carbs: 4.5, fat: 0.2, fibre: 3, slots: ['produce'], meals: ['main'], fill: 5, maxPerMeal: 400 },
    { id: 'spinach', name: 'Spinach', nameNl: 'Spinazie', category: 'vegetable', kcal: 23, protein: 2.9, carbs: 1.4, fat: 0.4, fibre: 2.2, slots: ['produce'], meals: ['main'], fill: 4, maxPerMeal: 400 },
    { id: 'carrots', name: 'Carrots', nameNl: 'Wortelen', category: 'vegetable', kcal: 38, protein: 0.8, carbs: 7, fat: 0.2, fibre: 2.8, slots: ['produce'], meals: ['main'], fill: 5, maxPerMeal: 400 },
    { id: 'bell_pepper', name: 'Red bell pepper', nameNl: 'Rode paprika', category: 'vegetable', kcal: 31, protein: 1, carbs: 5.5, fat: 0.3, fibre: 2, slots: ['produce'], meals: ['main'], fill: 4, maxPerMeal: 400 },
    { id: 'courgette', name: 'Courgette', nameNl: 'Courgette', category: 'vegetable', kcal: 18, protein: 1.3, carbs: 2.2, fat: 0.3, fibre: 1.1, slots: ['produce'], meals: ['main'], fill: 4, maxPerMeal: 400 },
    { id: 'cauliflower', name: 'Cauliflower', nameNl: 'Bloemkool', category: 'vegetable', kcal: 25, protein: 1.9, carbs: 3, fat: 0.3, fibre: 2.3, slots: ['produce'], meals: ['main'], fill: 5, maxPerMeal: 400 },
    { id: 'tomatoes', name: 'Tomatoes', nameNl: 'Tomaten', category: 'vegetable', kcal: 20, protein: 0.9, carbs: 3, fat: 0.2, fibre: 1.2, slots: ['produce'], meals: ['main'], fill: 4, maxPerMeal: 400 },
    { id: 'cucumber', name: 'Cucumber', nameNl: 'Komkommer', category: 'vegetable', kcal: 13, protein: 0.7, carbs: 1.8, fat: 0.1, fibre: 0.7, slots: ['produce'], meals: ['main'], fill: 3, maxPerMeal: 400 },
    { id: 'brussels_sprouts', name: 'Brussels sprouts', nameNl: 'Spruitjes', category: 'vegetable', kcal: 43, protein: 3.4, carbs: 5, fat: 0.3, fibre: 3.8, slots: ['produce'], meals: ['main'], fill: 5, maxPerMeal: 400 },
    { id: 'leek', name: 'Leek', nameNl: 'Prei', category: 'vegetable', kcal: 31, protein: 1.5, carbs: 5, fat: 0.3, fibre: 2.2, slots: ['produce'], meals: ['main'], fill: 4, maxPerMeal: 400 },
    { id: 'mushrooms', name: 'Mushrooms', nameNl: 'Champignons', category: 'vegetable', kcal: 22, protein: 3, carbs: 0.5, fat: 0.3, fibre: 1.5, slots: ['produce'], meals: ['main'], fill: 4, maxPerMeal: 400 },
    { id: 'witloof', name: 'Belgian endive', nameNl: 'Witloof', category: 'vegetable', kcal: 17, protein: 1, carbs: 2.5, fat: 0.1, fibre: 1.2, slots: ['produce'], meals: ['main'], fill: 4, maxPerMeal: 400 },
    { id: 'red_cabbage', name: 'Red cabbage', nameNl: 'Rode kool', category: 'vegetable', kcal: 29, protein: 1.3, carbs: 5, fat: 0.2, fibre: 2.5, slots: ['produce'], meals: ['main'], fill: 5, maxPerMeal: 400 },
    { id: 'wok_veg', name: 'Frozen stir-fry vegetables', nameNl: 'Wokgroenten (diepvries)', category: 'vegetable', kcal: 35, protein: 2, carbs: 5, fat: 0.3, fibre: 2.5, slots: ['produce'], meals: ['main'], fill: 4, maxPerMeal: 400 },
    { id: 'salad_mix', name: 'Mixed salad leaves', nameNl: 'Slamix', category: 'vegetable', kcal: 15, protein: 1.3, carbs: 1.5, fat: 0.2, fibre: 1.3, slots: ['produce'], meals: ['main'], fill: 3, maxPerMeal: 250 },

    // ---------- fruit ----------
    { id: 'banana', name: 'Banana', nameNl: 'Banaan', category: 'fruit', kcal: 93, protein: 1.1, carbs: 20, fat: 0.3, fibre: 2.3, slots: ['produce'], meals: ['breakfast', 'main'], fill: 3, maxPerMeal: 240, unit: { name: 'banana', grams: 120 } },
    { id: 'apple', name: 'Apple (Jonagold)', nameNl: 'Appel (Jonagold)', category: 'fruit', kcal: 54, protein: 0.3, carbs: 12, fat: 0.1, fibre: 2, slots: ['produce'], meals: ['breakfast', 'main'], fill: 4, maxPerMeal: 340, unit: { name: 'apple', grams: 170 } },
    { id: 'pear', name: 'Pear (Conference)', nameNl: 'Peer (Conference)', category: 'fruit', kcal: 55, protein: 0.4, carbs: 12, fat: 0.1, fibre: 3, slots: ['produce'], meals: ['breakfast', 'main'], fill: 4, maxPerMeal: 340, unit: { name: 'pear', grams: 170 } },
    { id: 'strawberries', name: 'Strawberries', nameNl: 'Aardbeien', category: 'fruit', kcal: 33, protein: 0.7, carbs: 6, fat: 0.3, fibre: 2, slots: ['produce'], meals: ['breakfast', 'main'], fill: 4, maxPerMeal: 400 },
    { id: 'blueberries', name: 'Blueberries', nameNl: 'Blauwe bessen', category: 'fruit', kcal: 57, protein: 0.7, carbs: 12, fat: 0.3, fibre: 2.4, slots: ['produce'], meals: ['breakfast', 'main'], fill: 3, maxPerMeal: 300 },
    { id: 'frozen_berries', name: 'Frozen mixed berries', nameNl: 'Bosvruchten (diepvries)', category: 'fruit', kcal: 45, protein: 1, carbs: 7.5, fat: 0.4, fibre: 4, slots: ['produce'], meals: ['breakfast', 'main'], fill: 4, maxPerMeal: 300 },
    { id: 'orange', name: 'Orange', nameNl: 'Sinaasappel', category: 'fruit', kcal: 47, protein: 0.9, carbs: 10, fat: 0.2, fibre: 2, slots: ['produce'], meals: ['breakfast', 'main'], fill: 4, maxPerMeal: 300, unit: { name: 'orange', grams: 150 } },
    { id: 'kiwi', name: 'Kiwi', nameNl: 'Kiwi', category: 'fruit', kcal: 61, protein: 1.1, carbs: 12, fat: 0.5, fibre: 3, slots: ['produce'], meals: ['breakfast', 'main'], fill: 3, maxPerMeal: 300, unit: { name: 'kiwi', grams: 75 } },
    { id: 'mandarin', name: 'Mandarin', nameNl: 'Mandarijn', category: 'fruit', kcal: 50, protein: 0.8, carbs: 11, fat: 0.3, fibre: 1.8, slots: ['produce'], meals: ['breakfast', 'main'], fill: 3, maxPerMeal: 280, unit: { name: 'mandarin', grams: 70 } },

    // ---------- fat ----------
    { id: 'olive_oil', name: 'Olive oil', nameNl: 'Olijfolie', category: 'fat', kcal: 900, protein: 0, carbs: 0, fat: 100, fibre: 0, slots: ['fat'], meals: ['main'], fill: 1, maxPerMeal: 25 },
    { id: 'peanut_butter', name: 'Peanut butter (100% peanuts)', nameNl: 'Pindakaas 100%', category: 'fat', kcal: 620, protein: 25, carbs: 12, fat: 50, fibre: 8, slots: ['fat'], meals: ['breakfast'], fill: 2, maxPerMeal: 40 },
    { id: 'almonds', name: 'Almonds', nameNl: 'Amandelen', category: 'fat', kcal: 610, protein: 22, carbs: 7, fat: 52, fibre: 12, slots: ['fat'], meals: ['breakfast', 'main'], fill: 2, maxPerMeal: 40 },
    { id: 'walnuts', name: 'Walnuts', nameNl: 'Walnoten', category: 'fat', kcal: 690, protein: 15, carbs: 7, fat: 67, fibre: 6, slots: ['fat'], meals: ['breakfast', 'main'], fill: 2, maxPerMeal: 40 },
    { id: 'avocado', name: 'Avocado', nameNl: 'Avocado', category: 'fat', kcal: 160, protein: 2, carbs: 2, fat: 15, fibre: 6.7, slots: ['fat'], meals: ['main'], fill: 3, maxPerMeal: 150 },
    { id: 'chia', name: 'Chia seeds', nameNl: 'Chiazaad', category: 'fat', kcal: 490, protein: 17, carbs: 8, fat: 31, fibre: 34, slots: ['fat'], meals: ['breakfast'], fill: 3, maxPerMeal: 30 }
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
