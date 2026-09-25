"""Tests for fetch_prices.py (standard library only): python3 -m unittest discover -s price_script"""

import http.client
import json
import os
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fetch_prices as fp  # noqa: E402

EXPORT = {
    "generated": "2026-10-02",
    "week": {"start": "2026-10-03", "end": "2026-10-09", "label": "Sat 3 Oct dinner → Fri 9 Oct dinner"},
    "items": [
        {"food_id": "skyr", "food": "Skyr natural 0%", "food_nl": "Skyr natuur", "weekly_g": 1800, "unit_g": None,
         "stores": {"Colruyt": [{"ean": "5400141044429", "product": "Boni Skyr natuur 500 g", "pack_size_g": 500, "url": ""}],
                    "Delhaize": [{"ean": "", "product": "Delhaize Skyr Nature", "pack_size_g": 450, "url": ""}],
                    "Carrefour": []}},
        {"food_id": "eggs", "food": "Eggs", "food_nl": "Eieren", "weekly_g": 770, "unit_g": 55,
         "stores": {"Colruyt": [{"ean": "", "product": "Boni vrije uitloop eieren (10 st)", "pack_size_g": 550, "url": ""}],
                    "Delhaize": [], "Carrefour": []}},
    ],
}

COLRUYT_RAW = [
    {"searchTerm": "Boni Skyr natuur", "name": "Skyr natuur", "brand": "Boni", "price": "€ 2,49", "gtin": "5400141044429",
     "content": "500 g", "url": "https://www.colruyt.be/nl/producten/15457"},
    {"searchTerm": "Boni Skyr natuur", "name": "Skyr aardbei", "brand": "Boni", "price": 2.69, "gtin": "5400141044436", "content": "500 g"},
    {"searchTerm": "Boni vrije uitloop eieren", "title": "BONI vrije uitloop eieren", "currentPrice": {"value": 3.19},
     "quantity": "10 st", "regularPrice": 3.49},
    {"searchTerm": "Boni vrije uitloop eieren", "title": "BONI scharreleieren", "currentPrice": {"value": 2.79}, "quantity": "12 st"},
]


class ParsingTests(unittest.TestCase):
    def test_parse_price(self):
        self.assertEqual(fp.parse_price("€ 3,49"), 3.49)
        self.assertEqual(fp.parse_price("3.49 EUR"), 3.49)
        self.assertEqual(fp.parse_price("1.299,00"), 1299.0)
        self.assertEqual(fp.parse_price({"amount": "1,05"}), 1.05)
        self.assertEqual(fp.parse_price([2.5]), 2.5)
        self.assertIsNone(fp.parse_price("€ 12,49/kg"))
        self.assertIsNone(fp.parse_price("gratis"))
        self.assertIsNone(fp.parse_price(True))
        self.assertIsNone(fp.parse_price(-1))

    def test_parse_pack_size(self):
        self.assertEqual(fp.parse_pack_size("500 g"), 500)
        self.assertEqual(fp.parse_pack_size("1,5 kg"), 1500)
        self.assertEqual(fp.parse_pack_size("6 x 125 g"), 750)
        self.assertEqual(fp.parse_pack_size("4×100g"), 400)
        self.assertEqual(fp.parse_pack_size("1 L"), 1000)
        self.assertEqual(fp.parse_pack_size("75 cl"), 750)
        self.assertEqual(fp.parse_pack_size("10 st", unit_g=55), 550)
        self.assertIsNone(fp.parse_pack_size("10 st"))
        self.assertEqual(fp.parse_pack_size({"value": 2, "unit": "kg"}), 2000)
        self.assertEqual(fp.parse_pack_size(250), 250)
        self.assertIsNone(fp.parse_pack_size("per stuk"))

    def test_parse_ean(self):
        self.assertEqual(fp.parse_ean("5400141 044429"), "5400141044429")
        self.assertEqual(fp.parse_ean(["", "05400141044429"]), "05400141044429")
        self.assertEqual(fp.parse_ean("123"), "")
        self.assertEqual(fp.parse_ean(None), "")

    def test_normalize_item_shapes(self):
        a = fp.normalize_item(COLRUYT_RAW[0])
        self.assertEqual(a, {"ean": "5400141044429", "product": "Boni Skyr natuur", "pack_size_g": 500.0, "price_eur": 2.49,
                             "promo": False, "url": "https://www.colruyt.be/nl/producten/15457"})
        b = fp.normalize_item(COLRUYT_RAW[2], unit_g=55)
        self.assertEqual(b["product"], "BONI vrije uitloop eieren")
        self.assertEqual(b["price_eur"], 3.19)
        self.assertEqual(b["pack_size_g"], 550)
        self.assertTrue(b["promo"], "regular price above current price means promo")
        c = fp.normalize_item({"productName": "Kipfilet 2 x 300 g", "price": {"value": "6,49"}, "promotions": []})
        self.assertEqual(c["pack_size_g"], 600)
        self.assertFalse(c["promo"])
        self.assertEqual(fp.normalize_item({"name": "x", "isPromo": "true", "price": 1})["promo"], True)

    def test_clean_query(self):
        self.assertEqual(fp.clean_query("Boni vrije uitloop eieren (10 st)"), "Boni vrije uitloop eieren")
        self.assertEqual(fp.clean_query("Boni Skyr natuur 500 g"), "Boni Skyr natuur")
        self.assertEqual(fp.clean_query("Kipfilet 2 x 300 g"), "Kipfilet")


class MatchingTests(unittest.TestCase):
    def test_ean_beats_name(self):
        cands = [fp.normalize_item(r) for r in COLRUYT_RAW[:2]]
        c, score, how = fp.best_match({"ean": "5400141044429", "product": "something else"}, cands)
        self.assertEqual(how, "ean")
        self.assertEqual(c["price_eur"], 2.49)

    def test_other_ean_is_never_a_name_match(self):
        cands = [fp.normalize_item(COLRUYT_RAW[1])]
        c, _, _ = fp.best_match({"ean": "5400141044429", "product": "Boni Skyr aardbei"}, cands)
        self.assertIsNone(c)

    def test_name_match_with_pack_bonus_and_threshold(self):
        cands = [fp.normalize_item(r, unit_g=55) for r in COLRUYT_RAW[2:]]
        c, score, how = fp.best_match({"ean": "", "product": "Boni vrije uitloop eieren (10 st)", "pack_size_g": 550}, cands)
        self.assertEqual(how, "name")
        self.assertEqual(c["product"], "BONI vrije uitloop eieren")
        none, _, _ = fp.best_match({"ean": "", "product": "Volkoren pasta"}, cands)
        self.assertIsNone(none)

    def test_product_code_match(self):
        self.assertEqual(fp.store_code("https://www.delhaize.be/nl/shop/Zuivel/Verse-kaas-Mager/p/F2016122000141400000"), "F2016122000141400000")
        self.assertEqual(fp.store_code("https://www.colruyt.be/nl/producten/26267"), "26267")
        self.assertEqual(fp.store_code("https://www.carrefour.be/nl/opgeklopte-specialiteit-2-x-125-g/00654629.html"), "00654629")
        self.assertEqual(fp.store_code("https://example.org/x"), "")
        cands = [{"ean": "", "product": "Delhaize | Verse kaas | Mager", "price_eur": 1.49, "pack_size_g": 500,
                  "url": "https://www.delhaize.be/nl/shop/x/p/F2016122000141400000"},
                 {"ean": "", "product": "Delhaize Verse kaas mager 0%", "price_eur": 1.19, "pack_size_g": 500, "url": ""}]
        row = {"ean": "", "product": "Delhaize Verse kaas mager 0%", "url": "https://www.delhaize.be/nl/shop/Zuivel/p/F2016122000141400000"}
        c, score, how = fp.best_match(row, cands)
        self.assertEqual((how, c["price_eur"]), ("product code", 1.49))

    def test_build_queries(self):
        q, plan = fp.build_queries(EXPORT, "Colruyt")
        self.assertEqual(q, ["Boni Skyr natuur", "Boni vrije uitloop eieren"])
        q, plan = fp.build_queries(EXPORT, "Carrefour")
        self.assertEqual(q, ["Skyr natuur", "Eieren"], "no product rows: search the Dutch food name")
        self.assertTrue(all(p["row"] is None for p in plan))

    def test_price_row_rules(self):
        c = {"ean": "5400141044429", "product": "Boni Skyr natuur", "pack_size_g": 500, "price_eur": 2.49, "promo": False}
        with_ean = fp.price_row("Colruyt", c, {"ean": "5400141044429", "product": "old name", "pack_size_g": 450}, "2026-10-02")
        self.assertEqual((with_ean["ean"], with_ean["product"]), ("5400141044429", "Boni Skyr natuur"))
        no_ean = fp.price_row("Colruyt", c, {"ean": "", "product": "Boni Skyr natuur 500 g"}, "2026-10-02")
        self.assertEqual((no_ean["ean"], no_ean["product"], no_ean["match_product"]), ("5400141044429", "Boni Skyr natuur", "Boni Skyr natuur 500 g"))
        disc = fp.price_row("Carrefour", dict(c, pack_size_g=None), None, "2026-10-02")
        self.assertEqual(disc["product"], "Boni Skyr natuur")
        self.assertIsNone(disc["pack_size_g"])
        self.assertEqual(set(with_ean), {"store", "ean", "product", "pack_size_g", "price_eur", "promo", "date"})

    def test_match_store_end_to_end(self):
        rows, report = fp.match_store(EXPORT, "Colruyt", COLRUYT_RAW, "2026-10-02")
        self.assertEqual(len(rows), 2)
        skyr, eggs = rows
        self.assertEqual(skyr, {"store": "Colruyt", "ean": "5400141044429", "product": "Boni Skyr natuur", "pack_size_g": 500.0,
                                "price_eur": 2.49, "promo": False, "date": "2026-10-02"})
        self.assertEqual(eggs["product"], "BONI vrije uitloop eieren", "the store's name")
        self.assertEqual(eggs["match_product"], "Boni vrije uitloop eieren (10 st)", "the table's name, for the app's match")
        self.assertEqual(eggs["pack_size_g"], 550)
        self.assertTrue(eggs["promo"])
        self.assertTrue(any("Skyr" in line for line in report))

    def test_discovery_for_foods_without_rows(self):
        raw = [{"query": "Skyr natuur", "name": "Carrefour Skyr Nature", "price": 1.99, "ean": "3560071234567", "size": "450 g"},
               {"query": "Eieren", "name": "Carrefour Eieren", "price": 2.89, "size": "6 st"}]
        rows, _ = fp.match_store(EXPORT, "Carrefour", raw, "2026-10-02", discover=1)
        self.assertEqual([r["product"] for r in rows], ["Carrefour Skyr Nature", "Carrefour Eieren"])
        self.assertEqual(rows[1]["pack_size_g"], 330)
        none, _ = fp.match_store(EXPORT, "Carrefour", raw, "2026-10-02", discover=0)
        self.assertEqual(none, [])


class ApiAndCliTests(unittest.TestCase):
    def test_run_actor_polls_until_done(self):
        calls = []

        def fake(method, url, token, body=None, timeout=90):
            calls.append((method, url.split("?")[0], body))
            if method == "POST":
                return {"data": {"id": "run1", "defaultDatasetId": "ds1", "status": "READY"}}
            if "/actor-runs/" in url:
                status = "RUNNING" if len([c for c in calls if "/actor-runs/" in c[1]]) < 2 else "SUCCEEDED"
                return {"data": {"status": status}}
            return [{"name": "x"}]

        with mock.patch.object(fp, "_request", side_effect=fake):
            items = fp.run_actor("studio-amba/colruyt-scraper", {"searchTerms": ["a"]}, "tok", log=lambda *a: None)
        self.assertEqual(items, [{"name": "x"}])
        self.assertEqual(calls[0][1], "https://api.apify.com/v2/acts/studio-amba~colruyt-scraper/runs")
        self.assertEqual(calls[0][2], {"searchTerms": ["a"]})
        self.assertEqual(calls[-1][1], "https://api.apify.com/v2/datasets/ds1/items")

    def test_run_actor_failure(self):
        def fake(method, url, token, body=None, timeout=90):
            if method == "POST":
                return {"data": {"id": "run1", "defaultDatasetId": "ds1", "status": "RUNNING"}}
            return {"data": {"status": "FAILED"}}

        with mock.patch.object(fp, "_request", side_effect=fake):
            with self.assertRaises(fp.ApifyError):
                fp.run_actor("a/b", {}, "tok", log=lambda *a: None)

    def test_env_override_of_actor_and_input(self):
        env = {"APIFY_ACTOR_DELHAIZE": "me/my-delhaize", "APIFY_INPUT_DELHAIZE": '{"queries": {queries}, "limit": {max_items}}'}
        with mock.patch.dict(os.environ, env):
            actor, build = fp.actor_for("Delhaize")
        self.assertEqual(actor, "me/my-delhaize")
        self.assertEqual(build(["a b", "c"], [], 3), {"queries": ["a b", "c"], "limit": 3})

    def test_inputs_from_schema_array_field(self):
        schema = {"properties": {"searchTerms": {"type": "array"}, "maxItems": {"type": "integer"},
                                 "proxyConfiguration": {"type": "object", "prefill": {"useApifyProxy": True}},
                                 "language": {"type": "string", "default": "nl"}},
                  "required": ["searchTerms", "proxyConfiguration"]}
        runs = fp.inputs_from_schema(schema, ["skyr", "eieren"], 5)
        self.assertEqual(runs, [({"proxyConfiguration": {"useApifyProxy": True}, "maxItems": 5, "searchTerms": ["skyr", "eieren"]}, None)])

    def test_inputs_from_schema_single_string_means_one_run_per_query(self):
        schema = {"properties": {"search": {"type": "string"}, "limit": {"type": "integer"}}}
        runs = fp.inputs_from_schema(schema, ["skyr", "eieren"], 3)
        self.assertEqual(runs, [({"limit": 3, "search": "skyr"}, "skyr"), ({"limit": 3, "search": "eieren"}, "eieren")])
        textarea = {"properties": {"queries": {"type": "string", "editor": "textarea"}}}
        self.assertEqual(fp.inputs_from_schema(textarea, ["a", "b"], 3), [({"queries": "a\nb"}, None)])

    def test_inputs_from_schema_fuzzy_and_missing(self):
        fuzzy = {"properties": {"productSearchList": {"type": "array"}, "maxResults": {"type": "integer"}}}
        self.assertEqual(fp.inputs_from_schema(fuzzy, ["a"], 2), [({"maxResults": 2, "productSearchList": ["a"]}, None)])
        with self.assertRaises(fp.ApifyError) as ctx:
            fp.inputs_from_schema({"properties": {"startUrls": {"type": "array"}}}, ["a"], 2)
        self.assertIn("startUrls", str(ctx.exception))

    def test_fetch_input_schema_reads_default_build(self):
        schema = {"title": "x", "properties": {"searchTerms": {"type": "array"}}}

        def fake(method, url, token, body=None, timeout=90):
            self.assertTrue(url.endswith("/acts/studio-amba~colruyt-scraper/builds/default"))
            return {"data": {"inputSchema": json.dumps(schema)}}

        with mock.patch.object(fp, "_request", side_effect=fake):
            self.assertEqual(fp.fetch_input_schema("studio-amba/colruyt-scraper", "tok"), schema)

    def test_fetch_input_schema_falls_back_to_latest_build(self):
        schema = {"properties": {"queries": {"type": "array"}}}

        def fake(method, url, token, body=None, timeout=90):
            if url.endswith("/builds/default"):
                raise fp.ApifyError("HTTP 404")
            if "/actor-builds/" in url:
                return {"data": {"actorDefinition": {"input": schema}}}
            return {"data": {"taggedBuilds": {"latest": {"buildId": "b1"}}}}

        with mock.patch.object(fp, "_request", side_effect=fake):
            self.assertEqual(fp.fetch_input_schema("a/b", "tok"), schema)

    def test_resolve_inputs_precedence(self):
        build = fp.STORE_CONFIG["Colruyt"]["input"]
        with mock.patch.dict(os.environ, {}, clear=True):
            runs, how = fp.resolve_inputs("Colruyt", "a/b", build, ["x"], 4, None, log=lambda *a: None)
            self.assertEqual(how, "built-in default")
            self.assertEqual(runs, [({"keyterms": ["x"], "maxResults": 4}, None)])
            with mock.patch.object(fp, "fetch_input_schema", return_value={"properties": {"keywords": {"type": "array"}}}):
                runs, how = fp.resolve_inputs("Colruyt", "a/b", build, ["x"], 4, "tok", log=lambda *a: None)
            self.assertEqual((runs, how), ([({"keywords": ["x"]}, None)], "actor input schema"))

    def test_cli_offline_writes_import_file(self):
        with tempfile.TemporaryDirectory() as d:
            exp = os.path.join(d, "grocery.json")
            raw = os.path.join(d, "colruyt.json")
            out = os.path.join(d, "prices.json")
            with open(exp, "w", encoding="utf-8") as fh:
                json.dump(EXPORT, fh)
            with open(raw, "w", encoding="utf-8") as fh:
                json.dump(COLRUYT_RAW, fh)
            with mock.patch("builtins.print"):
                code = fp.main([exp, "-o", out, "--stores", "colruyt", "--from-dataset", f"Colruyt={raw}", "--today", "2026-10-02"])
            self.assertEqual(code, 0)
            with open(out, encoding="utf-8") as fh:
                rows = json.load(fh)
            self.assertEqual(len(rows), 2)
            self.assertTrue(all(r["date"] == "2026-10-02" and r["store"] == "Colruyt" for r in rows))

    def test_cli_requires_token(self):
        with tempfile.TemporaryDirectory() as d:
            exp = os.path.join(d, "grocery.json")
            with open(exp, "w", encoding="utf-8") as fh:
                json.dump(EXPORT, fh)
            with mock.patch.dict(os.environ, {}, clear=True), mock.patch("builtins.print"):
                with self.assertRaises(SystemExit):
                    fp.main([exp, "--stores", "Colruyt"])

    def test_cli_dry_run_needs_no_token(self):
        with tempfile.TemporaryDirectory() as d:
            exp = os.path.join(d, "grocery.json")
            with open(exp, "w", encoding="utf-8") as fh:
                json.dump(EXPORT, fh)
            with mock.patch.dict(os.environ, {}, clear=True), mock.patch("builtins.print") as p:
                self.assertEqual(fp.main([exp, "--dry-run"]), 0)
            printed = "\n".join(str(c.args[0]) for c in p.call_args_list if c.args)
            self.assertIn("Boni Skyr natuur", printed)



def _write(path, data):
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(data, fh)


class ReviewFindingTests(unittest.TestCase):
    def test_canned_and_oil_pack_sizes_use_the_food_basis(self):
        # Finding 7: the food macros for canned tuna and legumes are per drained gram, oil is 0.92 g/ml.
        self.assertEqual(fp.normalize_item({"name": "Carrefour Kikkererwten 400 g", "price": 0.99}, drained_ratio=0.6)["pack_size_g"], 240)
        self.assertEqual(fp.normalize_item({"name": "Tonijn | Eigen nat | 3 x 150 gr", "price": 5.49}, drained_ratio=0.7)["pack_size_g"], 315)
        self.assertEqual(fp.normalize_item({"name": "Olijfolie extra vierge", "size": "1 l", "price": 8.99}, g_per_ml=0.92)["pack_size_g"], 920)
        self.assertEqual(fp.normalize_item({"name": "Olijfolie 500 g", "price": 4.99}, g_per_ml=0.92)["pack_size_g"], 500, "mass needs no density")
        self.assertEqual(fp.parse_pack_size("1 L"), 1000, "other liquids stay 1 ml = 1 g")
        export = {"items": [{"food_id": "chickpeas", "food": "Chickpeas", "food_nl": "Kikkererwten", "unit_g": None, "drained_ratio": 0.6,
                             "g_per_ml": None, "weekly_g": 1400,
                             "stores": {"Carrefour": [{"ean": "", "product": "Kikkererwten", "pack_size_g": 240, "url": ""}]}}]}
        raw = [{"searchTerm": "Kikkererwten", "name": "Carrefour Kikkererwten", "size": "400 g", "price": 0.89}]
        rows, _ = fp.match_store(export, "Carrefour", raw, "2026-10-02")
        self.assertEqual(rows[0]["pack_size_g"], 240)

    def test_ean_less_rows_send_the_store_name_and_match_product(self):
        # Finding 8: the app matches on match_product, then shows the store's own name for the price it stores.
        export = {"items": [{"food_id": "peanut_butter", "food": "Peanut butter", "food_nl": "Pindakaas 100%", "unit_g": None, "weekly_g": 200,
                             "stores": {"Carrefour": [{"ean": "", "product": "Calvé Pindakaas 100% pinda's", "pack_size_g": 350, "url": ""}]}}]}
        raw = [{"searchTerm": "Calvé Pindakaas 100% pinda's", "name": "Pindakaas 100% pinda's crunchy", "brand": "Carrefour Classic",
                "price": "€ 2,19", "ean": "3560071012345", "size": "350 g"}]
        rows, _ = fp.match_store(export, "Carrefour", raw, "2026-09-25")
        self.assertEqual(rows, [{"store": "Carrefour", "ean": "3560071012345", "product": "Carrefour Classic Pindakaas 100% pinda's crunchy",
                                 "match_product": "Calvé Pindakaas 100% pinda's", "pack_size_g": 350.0, "price_eur": 2.19, "promo": False,
                                 "date": "2026-09-25"}])

    def test_discovery_skips_hits_without_a_pack_size(self):
        # Finding 9: the import format needs a number, so a hit without a pack size is reported, never written as null.
        export = {"items": [{"food_id": "custom_pudding", "food": "Protein pudding", "food_nl": "Protein pudding", "unit_g": None, "weekly_g": 1400,
                             "stores": {"Colruyt": [], "Delhaize": [], "Carrefour": []}}]}
        raw = [{"searchTerm": "Protein pudding", "name": "EHRMANN High Protein pudding chocolade", "price": 1.49},
               {"searchTerm": "Protein pudding", "name": "Alpro Protein pudding", "price": "1,99"}]
        rows, report = fp.match_store(export, "Colruyt", raw, "2026-09-25", discover=1)
        self.assertEqual(rows, [])
        self.assertTrue(any("no pack size" in line and "Alpro Protein pudding" in line for line in report), report)
        sized = raw + [{"searchTerm": "Protein pudding", "name": "Ehrmann pudding vanille", "price": 1.39, "size": "200 g"}]
        rows, _ = fp.match_store(export, "Colruyt", sized, "2026-09-25", discover=1)
        self.assertEqual([(r["product"], r["pack_size_g"]) for r in rows], [("Ehrmann pudding vanille", 200.0)])

    def test_delhaize_s_codes_are_product_codes(self):
        # Finding 10: 22 of the seeded Delhaize URLs use /p/S... codes.
        url = "https://www.delhaize.be/nl/shop/Rijst/Rijst-Basmati/p/S2018100200120350000"
        self.assertEqual(fp.store_code(url), "S2018100200120350000")
        row = {"ean": "", "product": "Delhaize | Rijst | Basmati | 1 kg", "pack_size_g": 1000, "url": url}
        cands = [{"ean": "", "product": "Delhaize Rijst | Basmati | Kookbuiltjes | 1 kg", "price_eur": 4.49, "pack_size_g": 1000,
                  "url": "https://www.delhaize.be/nl/shop/Rijst/p/S2018100200120360000"},
                 {"ean": "", "product": "Basmati rijst", "price_eur": 3.29, "pack_size_g": 1000, "url": url}]
        c, _, how = fp.best_match(row, cands)
        self.assertEqual((how, c["price_eur"]), ("product code", 3.29))

    def test_gtin14_matches_ean13(self):
        # Finding 37: a zero-padded GTIN-14 is the same product as the table's EAN-13.
        cand = fp.normalize_item({"name": "BONI Skyr natuur 500g", "price": 1.29, "gtin": "05400141571738", "content": "500 g"})
        c, _, how = fp.best_match({"ean": "5400141571738", "product": "BONI Skyr natuur 500g", "pack_size_g": 500}, [cand])
        self.assertEqual((how, c["price_eur"]), ("ean", 1.29))
        c, _, how = fp.best_match({"ean": "0012345678905", "product": "x"}, [dict(cand, ean="012345678905")])
        self.assertEqual(how, "ean")
        other, _, _ = fp.best_match({"ean": "5400141571739", "product": "BONI Skyr natuur 500g"}, [cand])
        self.assertIsNone(other, "a different barcode still blocks the name match")


class NetworkFailureTests(unittest.TestCase):
    """Finding 11: timeouts, dropped connections and non-JSON bodies are ApifyErrors, so one store's failure never
    loses the other stores' rows."""

    @staticmethod
    def _resp(body):
        r = mock.MagicMock()
        r.__enter__.return_value.read.return_value = body
        return r

    def test_get_is_retried_once_after_a_timeout(self):
        with mock.patch.object(fp.urllib.request, "urlopen", side_effect=[TimeoutError("timed out"), self._resp(b'{"data": 1}')]) as op, \
                mock.patch.object(fp.time, "sleep") as sleep:
            self.assertEqual(fp._request("GET", "https://api.apify.com/v2/actor-runs/r1", "tok"), {"data": 1})
        self.assertEqual(op.call_count, 2)
        sleep.assert_called_once()

    def test_failures_become_apify_errors(self):
        cases = [http.client.RemoteDisconnected("Remote end closed connection without response"), ConnectionResetError(104, "reset"),
                 self._resp(b"<html>Bad gateway</html>"), self._resp(b"\xff\xfe")]
        for failure in cases:
            with mock.patch.object(fp.urllib.request, "urlopen", side_effect=[failure, failure]) as op, mock.patch.object(fp.time, "sleep"):
                with self.assertRaises(fp.ApifyError):
                    fp._request("GET", "https://api.apify.com/v2/datasets/d1/items", "tok")
            self.assertEqual(op.call_count, 2)

    def test_post_is_never_retried(self):
        # A retried POST could start (and bill) a second actor run.
        with mock.patch.object(fp.urllib.request, "urlopen", side_effect=TimeoutError("timed out")) as op, mock.patch.object(fp.time, "sleep"):
            with self.assertRaises(fp.ApifyError):
                fp._request("POST", "https://api.apify.com/v2/acts/a~b/runs", "tok", {"x": 1})
        self.assertEqual(op.call_count, 1)

    def test_a_failing_store_keeps_the_other_stores_rows(self):
        with tempfile.TemporaryDirectory() as d:
            exp, raw, out = (os.path.join(d, n) for n in ("grocery.json", "colruyt.json", "prices.json"))
            _write(exp, EXPORT)
            _write(raw, COLRUYT_RAW)
            dropped = http.client.RemoteDisconnected("Remote end closed connection without response")
            with mock.patch.dict(os.environ, {"APIFY_TOKEN": "tok"}, clear=True), mock.patch("builtins.print"), \
                    mock.patch.object(fp.urllib.request, "urlopen", side_effect=dropped), mock.patch.object(fp.time, "sleep"):
                code = fp.main([exp, "-o", out, "--stores", "Colruyt,Delhaize", "--from-dataset", f"Colruyt={raw}", "--today", "2026-10-02"])
            self.assertEqual(code, 1)
            with open(out, encoding="utf-8") as fh:
                self.assertEqual({r["store"] for r in json.load(fh)}, {"Colruyt"})

    def test_run_timeout_names_the_dataset(self):
        def fake(method, url, token, body=None, timeout=90):
            if method == "POST":
                return {"data": {"id": "run1", "defaultDatasetId": "ds9", "status": "RUNNING"}}
            return {"data": {"status": "RUNNING"}}

        with mock.patch.object(fp, "_request", side_effect=fake):
            with self.assertRaises(fp.ApifyError) as ctx:
                fp.run_actor("a/b", {}, "tok", timeout_s=0, log=lambda *a: None)
        self.assertIn("ds9", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
