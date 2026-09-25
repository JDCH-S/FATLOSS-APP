#!/usr/bin/env python3
"""Fetch current supermarket prices for the grocery list exported by Cut Block Planner.

Reads the file from the Groceries tab ("Export grocery list"), runs one Apify actor per store
(Colruyt, Delhaize, Carrefour Belgium), matches the scraped products back to your product table
(EAN first, then the store's product code in the URL, then product name and pack size), and writes the JSON
that the app's "Import prices" button accepts:

    [{"store": "Colruyt", "ean": "...", "product": "...", "pack_size_g": 500,
      "price_eur": 3.49, "promo": false, "date": "2026-09-25"}]

Rows for product-table entries without an EAN also carry "match_product" (your table's name for the row), while
"product" is the store's current name. Pack sizes follow the food database: canned tuna and legumes in drained
grams (label net weight x the food's drained ratio), oil at 0.92 g/ml.

Usage
    export APIFY_TOKEN=apify_api_xxx            # Apify console > Settings > API & Integrations
    python3 fetch_prices.py grocery-list-2026-10-03.json -o prices-2026-10-03.json

Useful options
    --stores Colruyt,Delhaize      only these stores
    --dry-run                      print the actor inputs, call nothing
    --save-raw DIR                 keep each actor's raw dataset as DIR/<store>.json
    --from-dataset Colruyt=f.json  reuse a saved dataset instead of calling Apify (repeatable)
    --discover 1                   for foods without a product row at a store, add the best N search
                                   hits that show a pack size; the app lists them as unmatched so you can
                                   map them to a food

Actors are configured in STORE_CONFIG below. Override one without editing the file:
    APIFY_ACTOR_COLRUYT=username/actor-name
    APIFY_INPUT_COLRUYT='{"searchTerms": {queries}, "maxItems": {max_items}}'
(the {queries} and {max_items} placeholders are filled in as JSON). Same for DELHAIZE and CARREFOUR.

Only the Python standard library is used. Apify bills actor runs to your account.
"""

import argparse
import datetime as _dt
import difflib
import http.client
import json
import os
import re
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request

API = "https://api.apify.com/v2"
STORES = ("Colruyt", "Delhaize", "Carrefour")

# ---------------------------------------------------------------------------------------------
# Store configuration. "input" builds the actor input from the search queries (and product URLs
# when the actor accepts them). Field names follow each actor's published input schema.
# ---------------------------------------------------------------------------------------------


def _search_input(field, max_field="maxItems", extra=None):
    def build(queries, urls, max_items):
        body = {field: queries, max_field: max_items}
        body.update(extra or {})
        return body
    return build


STORE_CONFIG = {
    # Defaults are Harvest Edge's Belgian actors: the Colruyt one returns GTINs. Their field names below are the
    # author's convention; before each run the script reads the actor's real input schema and uses that instead.
    "Colruyt": {
        "actor": "harvestedge/colruyt-supermarket-be",
        "input": _search_input("keyterms", "maxResults"),
        "note": "colruyt.be; alternative: studio-amba/colruyt-scraper (searchQuery, one query per run)",
    },
    "Delhaize": {
        "actor": "harvestedge/delhaize-supermarket-scraper",
        "input": _search_input("keyterms", "maxResults"),
        "note": "delhaize.be; the platform exposes no EAN, so matching uses the product code in the URL or the name",
    },
    "Carrefour": {
        "actor": "harvestedge/carrefour-belgium",
        "input": _search_input("keyterms", "maxResults"),
        "note": "carrefour.be",
    },
}

# Candidate field names in actor outputs (first match wins). Nested paths use dots.
EAN_FIELDS = ("ean", "EAN", "ean13", "gtin", "gtin13", "GTIN", "barcode", "barCode", "gtins", "eans",
              "product.ean", "product.gtin", "productInfo.gtin")
NAME_FIELDS = ("name", "title", "productName", "product_name", "product", "description", "longName", "LongName")
BRAND_FIELDS = ("brand", "brandName", "Brand", "product.brand")
PRICE_FIELDS = ("price", "price_eur", "priceEur", "currentPrice", "salePrice", "finalPrice", "priceValue",
                "basicPrice", "price.value", "price.amount", "price.current", "prices.price", "price.basicPrice")
REGULAR_PRICE_FIELDS = ("regularPrice", "oldPrice", "originalPrice", "listPrice", "price.regular", "wasPrice")
PROMO_FIELDS = ("promo", "isPromo", "promotion", "promotions", "isPromotion", "hasPromotion", "onPromotion",
                "isOnPromotion", "inPromotion", "onSale", "discount", "promoText")
PACK_FIELDS = ("pack_size_g", "packSize", "size", "content", "contents", "netContent", "quantity", "weight",
               "packaging", "unit", "volume", "contentSize")
URL_FIELDS = ("url", "productUrl", "link", "href", "product.url")


# ---------------------------------------------------------------------------------------------
# Parsing helpers
# ---------------------------------------------------------------------------------------------

def normalize(text):
    """Lowercase, strip accents and punctuation, collapse spaces (same rule as the app)."""
    text = unicodedata.normalize("NFD", str(text or ""))
    text = "".join(ch for ch in text if unicodedata.category(ch) != "Mn").lower()
    text = re.sub(r"[^a-z0-9%\s]", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def get_path(obj, path):
    cur = obj
    for part in path.split("."):
        if isinstance(cur, dict) and part in cur:
            cur = cur[part]
        else:
            return None
    return cur


def first(obj, fields):
    for f in fields:
        v = get_path(obj, f)
        if v not in (None, "", [], {}):
            return v
    return None


def parse_price(value):
    """Return a price in EUR from numbers, strings like '€ 3,49' or '3.49 EUR', or dicts."""
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value) if value >= 0 else None
    if isinstance(value, dict):
        return parse_price(first(value, ("value", "amount", "price", "current", "basicPrice")))
    if isinstance(value, list):
        return parse_price(value[0]) if value else None
    s = str(value).strip()
    # A unit price ("€ 12,49/kg") is not a pack price.
    if re.search(r"/\s*(?:kg|l|liter|litre|st|stuk|100\s*g|100\s*ml)\b", s, re.I):
        return None
    m = re.search(r"(\d+(?:[.,]\d{3})*(?:[.,]\d{1,2})?)", s)
    if not m:
        return None
    num = m.group(1)
    if re.search(r"[.,]\d{1,2}$", num):
        whole, dec = re.split(r"[.,](?=\d{1,2}$)", num)
        whole = re.sub(r"[.,]", "", whole)
        num = whole + "." + dec
    else:
        num = re.sub(r"[.,]", "", num)
    try:
        return float(num)
    except ValueError:
        return None


_UNIT_G = {"g": 1.0, "gr": 1.0, "gram": 1.0, "grams": 1.0, "kg": 1000.0, "kilo": 1000.0}
_UNIT_ML = {"ml": 1.0, "cl": 10.0, "dl": 100.0, "l": 1000.0, "lt": 1000.0, "liter": 1000.0, "litre": 1000.0}
_PIECE = r"(?:st|stuks?|stk|pcs?|pieces?|x)"


def parse_pack_size(text, unit_g=None, g_per_ml=None):
    """Grams in a pack from text like '500 g', '1,5 kg', '6 x 125 g', '1 L' (ml x g_per_ml, default 1),
    '10 st' (needs unit_g)."""
    if text is None:
        return None
    if isinstance(text, (int, float)) and not isinstance(text, bool):
        return float(text) if text > 0 else None
    if isinstance(text, dict):
        v = first(text, ("value", "amount", "size"))
        u = first(text, ("unit", "uom"))
        return parse_pack_size(f"{v} {u}" if u else v, unit_g, g_per_ml)

    def grams(unit):
        return _UNIT_G[unit] if unit in _UNIT_G else _UNIT_ML[unit] * (g_per_ml or 1.0)

    s = str(text).lower().replace(",", ".")
    m = re.search(r"(\d+(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?)\s*(kg|kilo|gr|grams?|g|ml|cl|dl|lt|liter|litre|l)\b", s)
    if m:
        return float(m.group(1)) * float(m.group(2)) * grams(m.group(3))
    m = re.search(r"(\d+(?:\.\d+)?)\s*(kg|kilo|gr|grams?|g|ml|cl|dl|lt|liter|litre|l)\b", s)
    if m:
        return float(m.group(1)) * grams(m.group(2))
    m = re.search(r"(\d+)\s*" + _PIECE + r"\b", s)
    if m and unit_g:
        return float(m.group(1)) * float(unit_g)
    return None


def parse_ean(value):
    if value is None:
        return ""
    if isinstance(value, list):
        for v in value:
            e = parse_ean(v)
            if e:
                return e
        return ""
    digits = re.sub(r"\D", "", str(value))
    return digits if 8 <= len(digits) <= 14 else ""


def ean_key(ean):
    """A barcode for comparing: the GTIN-14, EAN-13 and UPC-12 forms of one product differ only in leading zeros."""
    return ean.lstrip("0")


def truthy_promo(item):
    v = first(item, PROMO_FIELDS)
    if isinstance(v, bool):
        promo = v
    elif isinstance(v, (int, float)):
        promo = v > 0
    elif isinstance(v, (list, dict)):
        promo = len(v) > 0
    elif isinstance(v, str):
        promo = v.strip().lower() not in ("", "false", "0", "no", "none", "null")
    else:
        promo = False
    reg = parse_price(first(item, REGULAR_PRICE_FIELDS))
    price = parse_price(first(item, PRICE_FIELDS))
    if reg and price and reg > price + 0.001:
        promo = True
    return promo


def normalize_item(raw, unit_g=None, drained_ratio=None, g_per_ml=None):
    """Map one scraped dataset item to {ean, product, pack_size_g, price_eur, promo, url}. pack_size_g is on the
    food database's basis: a canned food's label (net) weight times its drained ratio, a liquid's ml times g_per_ml."""
    name = first(raw, NAME_FIELDS)
    if isinstance(name, dict):
        name = first(name, ("nl", "fr", "en", "value"))
    brand = first(raw, BRAND_FIELDS)
    if isinstance(brand, dict):
        brand = first(brand, ("name", "value"))
    product = str(name or "").strip()
    if brand and normalize(brand) and normalize(brand) not in normalize(product):
        product = f"{str(brand).strip()} {product}".strip()
    pack = None
    for f in PACK_FIELDS:
        pack = parse_pack_size(get_path(raw, f), unit_g, g_per_ml)
        if pack:
            break
    if not pack:
        pack = parse_pack_size(product, unit_g, g_per_ml)
    if pack and drained_ratio:
        pack *= drained_ratio
    return {
        "ean": parse_ean(first(raw, EAN_FIELDS)),
        "product": product,
        "pack_size_g": round(pack, 1) if pack else None,
        "price_eur": parse_price(first(raw, PRICE_FIELDS)),
        "promo": truthy_promo(raw),
        "url": str(first(raw, URL_FIELDS) or ""),
    }


# ---------------------------------------------------------------------------------------------
# Matching
# ---------------------------------------------------------------------------------------------

def name_score(a, b):
    na, nb = normalize(a), normalize(b)
    if not na or not nb:
        return 0.0
    ta, tb = set(na.split()), set(nb.split())
    jacc = len(ta & tb) / len(ta | tb)
    seq = difflib.SequenceMatcher(None, na, nb).ratio()
    return 0.5 * jacc + 0.5 * seq


_CODE_PATTERNS = (
    r"delhaize\.be/.*/p/([A-Z]\d+)",      # Delhaize: .../p/F2016122000141400000 or .../p/S2018100200120350000
    r"colruyt\.be/.*/producten/(\d+)",     # Colruyt: /nl/producten/26267
    r"carrefour\.be/.*/(\d{6,10})\.html",  # Carrefour: .../00654629.html
)


def store_code(url):
    """The store's own product id from a product URL, or ''."""
    for pat in _CODE_PATTERNS:
        m = re.search(pat, str(url or ""), re.I)
        if m:
            return m.group(1).upper()
    return ""


def best_match(row, candidates, min_score=0.55):
    """Pick the scraped product for one product-table row: exact EAN, then the store's product code from the
    URL, else the best name (+ pack size) match."""
    ean = ean_key(parse_ean(row.get("ean")))
    usable = [c for c in candidates if c.get("price_eur") is not None]
    if ean:
        for c in usable:
            if ean_key(c["ean"]) == ean:
                return c, 1.0, "ean"
    code = store_code(row.get("url"))
    if code:
        for c in usable:
            if store_code(c.get("url")) == code:
                return c, 1.0, "product code"
    best, best_s = None, 0.0
    for c in usable:
        if ean and c["ean"] and ean_key(c["ean"]) != ean:
            continue  # a different barcode is a different product
        s = name_score(row.get("product", ""), c["product"])
        want = row.get("pack_size_g")
        if want and c.get("pack_size_g"):
            ratio = min(want, c["pack_size_g"]) / max(want, c["pack_size_g"])
            s += 0.15 if ratio > 0.95 else (-0.15 if ratio < 0.6 else 0.0)
        if s > best_s:
            best, best_s = c, s
    if best is not None and best_s >= min_score:
        return best, best_s, "name"
    return None, best_s, None


def build_queries(export, store):
    """Search terms for one store: current product names, or the Dutch food name when there is no row."""
    queries, plan = [], []
    for item in export.get("items", []):
        rows = (item.get("stores") or {}).get(store) or []
        if rows:
            for row in rows:
                q = clean_query(row.get("product") or item.get("food_nl") or item.get("food"))
                plan.append({"item": item, "row": row, "query": q})
                if q and q not in queries:
                    queries.append(q)
        else:
            q = clean_query(item.get("food_nl") or item.get("food"))
            plan.append({"item": item, "row": None, "query": q})
            if q and q not in queries:
                queries.append(q)
    return queries, plan


def clean_query(text):
    """Drop pack sizes and bracketed notes from a product name so the store search is broad enough."""
    s = re.sub(r"\([^)]*\)", " ", str(text or ""))
    s = re.sub(r"\b\d+(?:[.,]\d+)?\s*(?:x\s*\d+(?:[.,]\d+)?\s*)?(?:kg|g|gr|ml|cl|l|st|stuks?)\b", " ", s, flags=re.I)
    return re.sub(r"\s+", " ", s).strip()


def match_store(export, store, raw_items, today, discover=0):
    """Return (price rows, report lines) for one store."""
    queries, plan = build_queries(export, store)
    by_query = {}
    everything = []
    for raw in raw_items:
        q = first(raw, ("searchTerm", "query", "keyword", "searchQuery", "search"))
        norm = normalize_item(raw)
        if not norm["product"]:
            continue
        everything.append((q, raw, norm))
        if q:
            by_query.setdefault(clean_query(q), []).append((raw, norm))

    out, report, seen = [], [], set()
    for p in plan:
        item = p["item"]
        pool = by_query.get(p["query"]) or [(r, n) for _, r, n in everything]
        cands = [normalize_item(r, item.get("unit_g"), item.get("drained_ratio"), item.get("g_per_ml")) for r, _ in pool]
        food = item.get("food") or item["food_id"]
        if p["row"] is None:
            if discover:
                ranked = sorted((c for c in cands if c["price_eur"] is not None),
                                key=lambda c: -name_score(p["query"], c["product"]))
                # The import format needs a pack size, so a hit without one could never be mapped in the app.
                if ranked and not ranked[0]["pack_size_g"]:
                    report.append(f"  ? {food}: skipped '{ranked[0]['product']}' (the store listing shows no pack size)")
                for c in [c for c in ranked if c["pack_size_g"]][:discover]:
                    key = (c["ean"], c["product"])
                    if key in seen:
                        continue
                    seen.add(key)
                    out.append(price_row(store, c, None, today))
                    report.append(f"  + {food}: no product row, suggesting '{c['product']}' (map it in the app)")
            continue
        c, score, how = best_match(p["row"], cands)
        if c is None:
            report.append(f"  ! {food}: no match for '{p['row'].get('product')}' (best score {score:.2f})")
            continue
        key = (c["ean"] or p["row"].get("ean"), c["product"])
        if key in seen:
            continue
        seen.add(key)
        line = price_row(store, c, p["row"], today)
        if line["pack_size_g"] is None:
            report.append(f"  ! {food}: '{c['product']}' has no pack size in the store listing or your product table")
            continue
        out.append(line)
        report.append(f"  = {food}: {c['product']} €{c['price_eur']:.2f} ({how}{f' {score:.2f}' if how == 'name' else ''})")
    return out, report


def price_row(store, c, row, today):
    """One import row; "product" is always the name the store shows, so the app's table names the product the
    price belongs to. The app matches store + EAN, then store + match_product, then store + product, so:
    - product-table row with an EAN: send that EAN;
    - row without an EAN: send the row's own name as match_product, plus the scraped EAN, which the app stores on
      the row for next time;
    - no row (discovery): the app lists it as unmatched for mapping."""
    row_ean = parse_ean((row or {}).get("ean"))
    out = {"store": store, "ean": row_ean or c.get("ean", ""), "product": c["product"]}
    if row is not None and not row_ean and row.get("product"):
        out["match_product"] = row["product"]
    out.update({
        "pack_size_g": c.get("pack_size_g") or (row or {}).get("pack_size_g"),
        "price_eur": round(float(c["price_eur"]), 2),
        "promo": bool(c.get("promo")),
        "date": today,
    })
    return out


# ---------------------------------------------------------------------------------------------
# Apify API
# ---------------------------------------------------------------------------------------------

RETRY_WAIT_S = 5


class ApifyError(Exception):
    def __init__(self, message, transient=False):
        super().__init__(message)
        self.transient = transient  # network trouble, a body that is not JSON, HTTP 429 or 5xx: worth one retry


def _request(method, url, token, body=None, timeout=90):
    """Call the Apify API and return the parsed JSON. Every failure is an ApifyError, so a store that fails never
    ends the whole run. A GET is retried once after a transient failure; a POST is not, because it may already
    have started (and billed) an actor run."""
    for attempt in (1, 2):
        try:
            return _request_once(method, url, token, body, timeout)
        except ApifyError as e:
            if not e.transient or method != "GET" or attempt == 2:
                raise
            time.sleep(RETRY_WAIT_S)


def _request_once(method, url, token, body, timeout):
    data = None if body is None else json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", f"Bearer {token}")
    req.add_header("Accept", "application/json")
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:300]
        hints = {401: "the API token is invalid", 402: "your Apify account has no credit for this actor",
                 403: "this token may not run the actor (rent/subscribe to it in the Apify Store first)",
                 404: "actor not found: check the actor ID", 429: "rate limited: wait and retry",
                 400: "the actor rejected the input (" + detail + "); set APIFY_INPUT_<STORE> to match its input schema"}
        raise ApifyError(f"HTTP {e.code} for {url.split('?')[0]}: {hints.get(e.code, detail)}",
                         transient=e.code == 429 or e.code >= 500) from None
    except urllib.error.URLError as e:
        raise ApifyError(f"Network error calling Apify: {e.reason}", transient=True) from None
    except (OSError, http.client.HTTPException) as e:
        # Timeouts and dropped connections while waiting for or reading the response are not wrapped in URLError.
        raise ApifyError(f"Network error calling Apify: {type(e).__name__}: {e}", transient=True) from None
    try:
        return json.loads(raw.decode("utf-8") or "null")
    except ValueError:
        raise ApifyError(f"Apify sent a response that is not JSON for {url.split('?')[0]}", transient=True) from None


def run_actor(actor_id, actor_input, token, timeout_s=900, log=print):
    """Start an actor run, wait for it to finish, and return its dataset items."""
    act = urllib.parse.quote(actor_id.replace("/", "~"), safe="~")
    run = _request("POST", f"{API}/acts/{act}/runs", token, actor_input)
    run = (run or {}).get("data") or {}
    run_id, dataset = run.get("id"), run.get("defaultDatasetId")
    if not run_id:
        raise ApifyError(f"Apify did not start {actor_id}")
    log(f"  run {run_id} started")
    deadline = time.time() + timeout_s
    status = run.get("status")
    while status in (None, "READY", "RUNNING"):
        if time.time() > deadline:
            raise ApifyError(f"{actor_id} still running after {timeout_s}s (run {run_id}). When it finishes, export dataset "
                             f"{dataset} as JSON from the Apify console (Storage > Datasets) and rerun with --from-dataset STORE=FILE")
        info = _request("GET", f"{API}/actor-runs/{run_id}?waitForFinish=60", token, timeout=90)
        status = ((info or {}).get("data") or {}).get("status")
    if status != "SUCCEEDED":
        raise ApifyError(f"{actor_id} finished with status {status} (run {run_id})")
    items = _request("GET", f"{API}/datasets/{dataset}/items?clean=true&format=json", token, timeout=120)
    return items if isinstance(items, list) else []


def actor_for(store):
    env = store.upper()
    actor = os.environ.get(f"APIFY_ACTOR_{env}") or STORE_CONFIG[store]["actor"]
    template = os.environ.get(f"APIFY_INPUT_{env}")
    if template:
        def build(queries, urls, max_items, _t=template):
            filled = _t.replace("{queries}", json.dumps(queries)).replace("{urls}", json.dumps(urls))
            return json.loads(filled.replace("{max_items}", json.dumps(max_items)))
        return actor, build
    return actor, STORE_CONFIG[store]["input"]


# Input fields recognised in an actor's input schema, most specific first.
SEARCH_KEYS = ("keyterms", "keyTerms", "searchTerms", "searchQueries", "queries", "keywords", "searchKeywords", "search",
               "searchQuery", "query", "keyword", "searchTerm", "terms", "searchStrings")
MAX_KEYS = ("maxItems", "maxResults", "maxProducts", "maxItemsPerQuery", "maxResultsPerQuery", "maxProductsPerQuery",
            "resultsPerQuery", "maxResultsPerSearch", "limit", "resultsLimit")


def fetch_input_schema(actor_id, token):
    """The actor's input schema from its default build, or None when Apify does not expose it."""
    act = urllib.parse.quote(actor_id.replace("/", "~"), safe="~")
    build = None
    try:
        build = (_request("GET", f"{API}/acts/{act}/builds/default", token) or {}).get("data")
    except ApifyError:
        try:
            actor = (_request("GET", f"{API}/acts/{act}", token) or {}).get("data") or {}
            build_id = (((actor.get("taggedBuilds") or {}).get("latest")) or {}).get("buildId")
            if build_id:
                build = (_request("GET", f"{API}/actor-builds/{build_id}", token) or {}).get("data")
        except ApifyError:
            return None
    if not build:
        return None
    schema = (build.get("actorDefinition") or {}).get("input") or build.get("inputSchema")
    if isinstance(schema, str):
        try:
            schema = json.loads(schema)
        except ValueError:
            return None
    return schema if isinstance(schema, dict) and isinstance(schema.get("properties"), dict) else None


def _pick(props, names, types):
    for n in names:
        if n in props and (props[n].get("type") in types or "type" not in props[n]):
            return n
    lowered = {k.lower(): k for k in props}
    for n in names:
        if n.lower() in lowered and props[lowered[n.lower()]].get("type") in types:
            return lowered[n.lower()]
    return None


def inputs_from_schema(schema, queries, max_items):
    """Build actor inputs from its schema. Returns [(input, query_or_None)]: one run when the search field
    takes a list, one run per query when it takes a single string."""
    props = schema.get("properties") or {}
    key = _pick(props, SEARCH_KEYS, ("array", "string"))
    if not key:
        fuzzy = [k for k, v in props.items() if re.search(r"search|quer|keyword", k, re.I) and v.get("type") in ("array", "string")]
        key = fuzzy[0] if fuzzy else None
    if not key:
        raise ApifyError("no search field in the actor's input schema (fields: " + ", ".join(sorted(props)) + ")")
    max_key = _pick(props, MAX_KEYS, ("integer", "number"))
    base = {}
    for req in schema.get("required") or []:
        if req in (key, max_key) or req not in props:
            continue
        spec = props[req]
        for src in ("prefill", "default", "example"):
            if spec.get(src) is not None:
                base[req] = spec[src]
                break
    if max_key:
        base[max_key] = max_items
    if props[key].get("type") == "array":
        body = dict(base)
        body[key] = list(queries)
        return [(body, None)]
    if props[key].get("editor") == "textarea":
        body = dict(base)
        body[key] = "\n".join(queries)
        return [(body, None)]
    return [(dict(base, **{key: q}), q) for q in queries]


def resolve_inputs(store, actor, build, queries, max_items, token, log=print):
    """Actor inputs for one store: env template > the actor's own input schema > STORE_CONFIG default."""
    if os.environ.get(f"APIFY_INPUT_{store.upper()}"):
        return [(build(queries, [], max_items), None)], "APIFY_INPUT_" + store.upper()
    if token:
        schema = fetch_input_schema(actor, token)
        if schema:
            return inputs_from_schema(schema, queries, max_items), "actor input schema"
        log("  input schema not available; using the built-in field names")
    return [(build(queries, [], max_items), None)], "built-in default"


# ---------------------------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------------------------

def load_export(path):
    with open(path, encoding="utf-8") as fh:
        data = json.load(fh)
    if not isinstance(data, dict) or not isinstance(data.get("items"), list):
        raise SystemExit(f"{path} is not a grocery-list export (expected an object with 'items').")
    return data


def main(argv=None):
    ap = argparse.ArgumentParser(description="Fetch Colruyt / Delhaize / Carrefour prices via Apify for a Cut Block Planner grocery list.")
    ap.add_argument("export", help="grocery-list JSON exported from the Groceries tab")
    ap.add_argument("-o", "--output", help="price-import JSON to write (default: prices-<week>.json)")
    ap.add_argument("--stores", default=",".join(STORES), help="comma-separated stores (default: all three)")
    ap.add_argument("--max-items", type=int, default=5, help="search results per query (default 5)")
    ap.add_argument("--timeout", type=int, default=900, help="seconds to wait per actor run (default 900)")
    ap.add_argument("--discover", type=int, default=1, help="suggestions per food without a product row (default 1, 0 = off)")
    ap.add_argument("--dry-run", action="store_true", help="print actor inputs and exit (reads input schemas when APIFY_TOKEN is set)")
    ap.add_argument("--max-runs", type=int, default=40, help="cap on runs per store for actors that take one query per run")
    ap.add_argument("--save-raw", metavar="DIR", help="save raw dataset items per store")
    ap.add_argument("--from-dataset", action="append", default=[], metavar="STORE=FILE", help="use a saved dataset instead of calling Apify")
    ap.add_argument("--today", help=argparse.SUPPRESS)
    args = ap.parse_args(argv)

    export = load_export(args.export)
    today = args.today or _dt.date.today().isoformat()
    stores = [s.strip() for s in args.stores.split(",") if s.strip()]
    canon = {s.lower(): s for s in STORES}
    bad = [s for s in stores if s.lower() not in canon]
    if bad:
        raise SystemExit(f"Unknown store(s): {', '.join(bad)}. Use {', '.join(STORES)}.")
    stores = [canon[s.lower()] for s in stores]
    offline = {}
    for spec in args.from_dataset:
        store, _, path = spec.partition("=")
        if store.lower() not in canon or not path:
            raise SystemExit(f"--from-dataset expects STORE=FILE, got {spec!r}")
        with open(path, encoding="utf-8") as fh:
            offline[canon[store.lower()]] = json.load(fh)

    token = os.environ.get("APIFY_TOKEN") or os.environ.get("APIFY_API_TOKEN")
    needs_api = [s for s in stores if s not in offline]
    if needs_api and not token and not args.dry_run:
        raise SystemExit("Set APIFY_TOKEN (Apify console > Settings > API & Integrations), or use --from-dataset.")

    week = (export.get("week") or {}).get("start") or today
    out_path = args.output or f"prices-{week}.json"
    print(f"Grocery list for {(export.get('week') or {}).get('label', week)}: {len(export['items'])} foods")

    all_rows, failures = [], []
    for store in stores:
        actor, build = actor_for(store)
        queries, _ = build_queries(export, store)
        print(f"\n{store}: {len(queries)} search queries -> {actor}")
        try:
            raw = offline.get(store)
            if raw is None:
                runs, how = resolve_inputs(store, actor, build, queries, args.max_items, token)
                if len(runs) > args.max_runs:
                    raise ApifyError(f"{actor} takes one query per run: {len(runs)} runs needed, over --max-runs {args.max_runs}")
                print(f"  input from {how}: {len(runs)} run(s)")
                if args.dry_run:
                    for body, _q in runs[:3]:
                        print(json.dumps(body, indent=2, ensure_ascii=False))
                    if len(runs) > 3:
                        print(f"  ... and {len(runs) - 3} more runs")
                    continue
                raw = []
                for body, q in runs:
                    items = run_actor(actor, body, token, args.timeout)
                    if q:
                        for it in items:
                            if isinstance(it, dict):
                                it.setdefault("searchTerm", q)
                    raw.extend(items)
            elif args.dry_run:
                print(f"  using saved dataset ({len(raw)} items)")
                continue
            if args.save_raw:
                os.makedirs(args.save_raw, exist_ok=True)
                with open(os.path.join(args.save_raw, f"{store}.json"), "w", encoding="utf-8") as fh:
                    json.dump(raw, fh, ensure_ascii=False, indent=1)
            rows, report = match_store(export, store, raw, today, args.discover)
            print(f"  {len(raw)} products scraped, {len(rows)} price rows")
            print("\n".join(report))
            all_rows.extend(rows)
        except ApifyError as e:
            failures.append(f"{store}: {e}")
            print(f"  ERROR {e}")

    if args.dry_run:
        return 0
    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump(all_rows, fh, ensure_ascii=False, indent=2)
    print(f"\nWrote {len(all_rows)} rows to {out_path}. Import it on the Groceries tab (Import prices).")
    if failures:
        print("Some stores failed:\n  " + "\n  ".join(failures), file=sys.stderr)
        return 2 if not all_rows else 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
