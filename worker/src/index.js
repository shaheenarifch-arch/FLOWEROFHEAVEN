/**
 * foh-flowers: private server step between flowerofheaven.store and the Florist One API.
 *
 * The Florist One API key and password live only here, as Worker secrets:
 *   FLORISTONE_KEY, FLORISTONE_PASS
 * Docs: https://florist.one/api/documentation/
 *
 * Routes (all JSON):
 *   GET  /health
 *   GET  /availability?zip=02101           -> { zip, available, sameDay, dates[], message, orderUrl }
 *   GET  /products?category=bs&count=12&start=1&sort=pa
 *   GET  /product?code=F1-509
 *   POST /total   { code, zip }            -> price breakdown from Florist One
 *   GET  /payment-key                      -> Authorize.net Accept.js public key (safe to show)
 *   POST /order   { code, deliveryDate, cardMessage, instructions, recipient, customer, token }
 *
 * Card numbers never reach this Worker. The browser sends the card straight to
 * Authorize.net (Accept.js) and only passes us a one-time token.
 * Prices and totals are always looked up here, never taken from the browser.
 */

const API = "https://www.floristone.com/api/rest/flowershop";
const PRODUCT_CACHE_SECONDS = 3600;

// Florist One category codes: https://florist.one/api/documentation/Flower-Shop/Categories-and-Occasions
const CATEGORIES = new Set([
  "bs", "ao", "bd", "an", "lr", "gw", "nb", "ty", "sy",          // occasions
  "c", "o", "v", "r", "x", "p", "b",                               // product types
  "fbs", "fa", "fb", "fs", "fp", "fl", "fw", "fh", "fx", "fc", "fu", // funeral
  "u60", "60t80", "80t100", "a100",                                // price ranges
]);
const SORTS = new Set(["pa", "pd", "az", "za"]);
const STATES = new Set("AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY".split(" "));

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const allowed = (env.ALLOWED_ORIGINS || "https://flowerofheaven.store").split(",").map(s => s.trim());
    const cors = {
      "Access-Control-Allow-Origin": allowed.includes(origin) ? origin : allowed[0],
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Vary": "Origin",
    };
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    // Browsers on other sites may not call this Worker.
    if (origin && !allowed.includes(origin)) return json({ error: "origin not allowed" }, 403, cors);

    try {
      switch (url.pathname) {
        case "/health":
          return json({ ok: true, configured: !!(env.FLORISTONE_KEY && env.FLORISTONE_PASS) }, 200, cors);

        case "/availability": {
          const zip = cleanZip(url.searchParams.get("zip"));
          if (!zip) return json({ error: "Enter a 5-digit US ZIP code." }, 400, cors);
          const dates = await deliveryDates(env, zip);
          const today = new Date().toLocaleDateString("en-US", { timeZone: "America/New_York", month: "2-digit", day: "2-digit", year: "numeric" });
          const sameDay = dates.includes(today);
          return json({
            zip,
            available: dates.length > 0,
            sameDay,
            dates,
            orderUrl: "/flowers/",
            message: dates.length
              ? `Good news: local florists deliver to ${zip}. Earliest delivery: ${prettyDate(dates[0])}.${sameDay ? " Same-day delivery is available if you order before 1 PM local time." : ""}`
              : `We can't deliver to ${zip} yet. Coverage is growing, so please check back soon.`,
          }, 200, cors);
        }

        case "/products": {
          const category = (url.searchParams.get("category") || "bs").toLowerCase();
          if (!CATEGORIES.has(category)) return json({ error: "unknown category" }, 400, cors);
          const params = { category };
          const count = clampInt(url.searchParams.get("count"), 1, 48, 12);
          const start = clampInt(url.searchParams.get("start"), 1, 2000, 1);
          params.count = String(count);
          params.start = String(start);
          const sort = url.searchParams.get("sort");
          if (sort && SORTS.has(sort)) params.sorttype = sort;
          return await cached(ctx, `products?${new URLSearchParams(params)}`, cors, async () => {
            const data = await floristOne(env, "/getproducts", params);
            return { total: Number(data.TOTAL || 0) || null, products: (data.PRODUCTS || []).map(product) };
          });
        }

        case "/product": {
          const code = cleanCode(url.searchParams.get("code"));
          if (!code) return json({ error: "code required" }, 400, cors);
          return await cached(ctx, `product?code=${code}`, cors, async () => {
            const p = await lookupProduct(env, code);
            if (!p) throw new HttpError(404, "That bouquet is no longer available.");
            return { product: p };
          });
        }

        case "/total": {
          if (request.method !== "POST") return json({ error: "use POST" }, 405, cors);
          const body = await request.json().catch(() => ({}));
          const code = cleanCode(body.code), zip = cleanZip(body.zip);
          if (!code || !zip) return json({ error: "code and a 5-digit ZIP are required" }, 400, cors);
          const p = await lookupProduct(env, code);
          if (!p) return json({ error: "That bouquet is no longer available." }, 404, cors);
          return json(breakdown(await orderTotal(env, p, zip)), 200, cors);
        }

        case "/payment-key": {
          // Florist One says to fetch this every time rather than store it.
          const k = await floristOne(env, "/getauthorizenetkey", {});
          return json({ username: k.USERNAME, key: k.AUTHORIZENET_KEY, scriptUrl: k.AUTHORIZENET_URL }, 200, { ...cors, "Cache-Control": "no-store" });
        }

        case "/order": {
          if (request.method !== "POST") return json({ error: "use POST" }, 405, cors);
          const body = await request.json().catch(() => null);
          const v = validateOrder(body);
          if (v.error) return json({ error: v.error }, 400, cors);

          // Price and total come from Florist One, never from the browser.
          const p = await lookupProduct(env, v.code);
          if (!p) return json({ error: "That bouquet is no longer available. Please choose another." }, 409, cors);
          const dates = await deliveryDates(env, v.recipient.zipcode);
          if (!dates.includes(v.deliveryDateUS)) return json({ error: "That delivery date is no longer available. Please pick another date." }, 409, cors);
          const totals = await orderTotal(env, p, v.recipient.zipcode);

          const payload = {
            customer: { ...v.customer, IP: request.headers.get("CF-Connecting-IP") || "0.0.0.0" },
            products: [{
              CODE: p.code,
              PRICE: p.price,
              DELIVERYDATE: v.deliveryDateISO,
              CARDMESSAGE: v.cardMessage,
              SPECIALINSTRUCTIONS: v.instructions,
              RECIPIENT: v.recipient,
            }],
            ccinfo: { AUTHORIZENET_TOKEN: v.token },
            ordertotal: totals.ORDERTOTAL,
          };
          if (env.ALLOW_SUBSTITUTIONS) payload.allowsubstitutions = env.ALLOW_SUBSTITUTIONS === "0" ? 0 : 1;

          const res = await floristOne(env, "/placeorder", payload, "POST");
          if (!res.ORDERNO) throw new HttpError(502, "The order could not be placed. You have not been charged.");
          return json({ orderNo: String(res.ORDERNO), ...breakdown(res), product: { name: p.name, image: p.small }, deliveryDate: v.deliveryDateUS }, 200, cors);
        }

        default:
          return json({ error: "not found" }, 404, cors);
      }
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status, cors);
      // Fail closed and honest: the site falls back to the "expanding" message.
      return json({ error: "Flower delivery is temporarily unavailable. Please try again in a few minutes." }, 502, cors);
    }
  },
};

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function floristOne(env, path, params, method = "GET") {
  if (!env.FLORISTONE_KEY || !env.FLORISTONE_PASS) throw new Error("not configured");
  const headers = { Authorization: "Basic " + btoa(`${env.FLORISTONE_KEY}:${env.FLORISTONE_PASS}`), Accept: "application/json" };
  let target = `${API}${path}`, init = { method, headers };
  if (method === "GET") {
    const qs = new URLSearchParams(params).toString();
    if (qs) target += `?${qs}`;
  } else {
    headers["Content-Type"] = "application/json; charset=utf-8";
    init.body = JSON.stringify(params);
  }
  const res = await fetch(target, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.errors || data.ERRORS) {
    // Florist One returns validation messages for bad input or a declined card; pass those on.
    const msgs = data.errors || data.ERRORS;
    if (Array.isArray(msgs) && msgs.length && res.status < 500) throw new HttpError(400, msgs.map(String).join(" ").slice(0, 300));
    throw new Error(`Florist One ${res.status}`);
  }
  return data;
}

async function lookupProduct(env, code) {
  const data = await floristOne(env, "/getproducts", { code });
  const p = (data.PRODUCTS || [])[0];
  return p ? product(p) : null;
}

async function deliveryDates(env, zip) {
  const data = await floristOne(env, "/checkdeliverydate", { zipcode: zip });
  const arr = data.DATES || data.dates || [];
  return Array.isArray(arr) ? arr.map(String).filter(d => /^\d{2}\/\d{2}\/\d{4}$/.test(d)) : [];
}

async function orderTotal(env, p, zip) {
  return floristOne(env, "/gettotal", {
    products: JSON.stringify([{ CODE: p.code, PRICE: p.price, RECIPIENT: { ZIPCODE: zip } }]),
  });
}

function product(p) {
  return {
    code: String(p.CODE),
    name: String(p.NAME || ""),
    price: Number(p.PRICE),
    description: String(p.DESCRIPTION || "").trim(),
    dimension: String(p.DIMENSION || ""),
    small: String(p.SMALL || ""),
    large: String(p.LARGE || p.SMALL || ""),
  };
}

function breakdown(t) {
  return {
    subtotal: Number(t.SUBTOTAL || 0),
    delivery: Number(t.FLORISTONEDELIVERYCHARGE ?? t.FLORISTONESERVICECHARGE ?? t.DELIVERYCHARGETOTAL ?? 0),
    tax: Number(t.TAXTOTAL ?? t.FLORISTONETAX ?? 0),
    discount: Number(t.DISCOUNT || 0),
    total: Number(t.ORDERTOTAL || 0),
  };
}

function validateOrder(b) {
  if (!b || typeof b !== "object") return { error: "Missing order details." };
  const code = cleanCode(b.code);
  if (!code) return { error: "Please choose a bouquet." };

  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(b.deliveryDate || ""));
  if (!m) return { error: "Please choose a delivery date." };
  const deliveryDateISO = m[0], deliveryDateUS = `${m[2]}/${m[3]}/${m[1]}`;

  const cardMessage = text(b.cardMessage, 200);
  if (!cardMessage) return { error: "Please write a card message (up to 200 characters)." };
  const instructions = text(b.instructions, 100);

  const r = b.recipient || {}, c = b.customer || {};
  const recipient = {
    NAME: text(r.name, 100), INSTITUTION: text(r.institution, 100),
    ADDRESS1: text(r.address1, 100), ADDRESS2: text(r.address2, 100),
    CITY: text(r.city, 100), STATE: String(r.state || "").toUpperCase(), COUNTRY: "US",
    PHONE: digits(r.phone), ZIPCODE: cleanZip(r.zipcode),
  };
  const customer = {
    NAME: text(c.name, 100), EMAIL: text(c.email, 100),
    ADDRESS1: text(c.address1, 100), ADDRESS2: text(c.address2, 100),
    CITY: text(c.city, 100), STATE: String(c.state || "").toUpperCase(), COUNTRY: "US",
    PHONE: digits(c.phone), ZIPCODE: cleanZip(c.zipcode),
  };
  for (const [who, o] of [["recipient", recipient], ["your", customer]]) {
    if (!o.NAME || !o.ADDRESS1 || !o.CITY) return { error: `Please fill in the ${who} name, street address and city.` };
    if (!STATES.has(o.STATE)) return { error: `Please choose the ${who} state.` };
    if (!o.ZIPCODE) return { error: `Please enter a 5-digit ZIP code for the ${who} address.` };
    if (o.PHONE.length !== 10) return { error: `Please enter a 10-digit phone number for the ${who} details.` };
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(customer.EMAIL)) return { error: "Please enter a valid email address for your receipt." };

  const token = String(b.token || "");
  if (!/^[\w+/=:-]{20,4096}$/.test(token)) return { error: "Card details could not be confirmed. Please re-enter your card." };

  return { code, deliveryDateISO, deliveryDateUS, cardMessage, instructions, recipient, customer, token };
}

async function cached(ctx, key, cors, build) {
  const cacheKey = new Request(`https://cache.foh/${key}`);
  const cache = caches.default;
  const hit = await cache.match(cacheKey);
  if (hit) return withHeaders(hit, cors);
  const res = json(await build(), 200, { ...cors, "Cache-Control": `public, max-age=${PRODUCT_CACHE_SECONDS}` });
  ctx.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}

function cleanZip(z) { const s = String(z || "").trim().slice(0, 5); return /^\d{5}$/.test(s) ? s : ""; }
function cleanCode(c) { const s = String(c || "").trim(); return /^[A-Za-z0-9-]{2,20}$/.test(s) ? s.toUpperCase() : ""; }
function text(v, max) { return String(v ?? "").replace(/[\u0000-\u001f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, max); }
function digits(v) { return String(v || "").replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "").slice(0, 10); }
function clampInt(v, min, max, dflt) { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt; }
function prettyDate(us) {
  const [mm, dd, yyyy] = us.split("/").map(Number);
  return new Date(Date.UTC(yyyy, mm - 1, dd)).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });
}

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...headers } });
}

function withHeaders(res, headers) {
  const r = new Response(res.body, res);
  for (const [k, v] of Object.entries(headers)) r.headers.set(k, v);
  return r;
}
