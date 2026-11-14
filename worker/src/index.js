/**
 * foh-flowers: private server step between flowerofheaven.store and the Florist One API.
 *
 * The Florist One API key and password live only here, as Worker secrets:
 *   FLORISTONE_KEY, FLORISTONE_PASS
 * Docs: https://www.floristone.com/api/  (help: https://floristone.com/api/flowers-api-faq)
 *
 * Routes (all JSON):
 *   GET  /health
 *   GET  /availability?zip=02101        -> { zip, available, sameDay, dates[], message }
 *   GET  /products?category=bd&count=12&start=1
 *   POST /total        { products: [...] }   -> order total incl. service charges
 *   POST /order        -> 501 until the payment flow is confirmed in Florist One's docs
 *   GET  /order-status?orderno=123456   -> status / proof of delivery
 *
 * Pipeline: Customer -> ZIP -> Availability -> Bouquet -> Checkout -> Order Routing
 *           -> Local Florist Partner -> Delivery -> Proof of Delivery
 */

const API = "https://www.floristone.com/api/rest/flowershop";
const PRODUCT_CACHE_SECONDS = 3600;

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
          const zip = (url.searchParams.get("zip") || "").trim();
          if (!/^\d{5}$/.test(zip)) return json({ error: "Enter a 5-digit US ZIP code." }, 400, cors);
          const data = await floristOne(env, "/checkdeliverydate", { zipcode: zip });
          const dates = extractDates(data);
          const today = new Date().toLocaleDateString("en-US", { timeZone: "America/New_York", month: "2-digit", day: "2-digit", year: "numeric" });
          return json({
            zip,
            available: dates.length > 0,
            sameDay: dates.some(d => sameDate(d, today)),
            dates,
            message: dates.length
              ? `Good news: local florists deliver to ${zip}. Earliest delivery: ${dates[0]}.`
              : `We don't deliver to ${zip} yet. Coverage is growing, so please check back soon.`,
          }, 200, cors);
        }

        case "/products": {
          const params = {};
          for (const k of ["category", "code", "count", "start"]) {
            const v = url.searchParams.get(k);
            if (v) params[k] = v.replace(/[^\w,-]/g, "").slice(0, 40);
          }
          const cacheKey = new Request(`https://cache.foh/products?${new URLSearchParams(params)}`);
          const cache = caches.default;
          const hit = await cache.match(cacheKey);
          if (hit) return withHeaders(hit, cors);
          const res = json(await floristOne(env, "/getproducts", params), 200, { ...cors, "Cache-Control": `public, max-age=${PRODUCT_CACHE_SECONDS}` });
          ctx.waitUntil(cache.put(cacheKey, res.clone()));
          return res;
        }

        case "/total": {
          if (request.method !== "POST") return json({ error: "use POST" }, 405, cors);
          const body = await request.json().catch(() => ({}));
          if (!Array.isArray(body.products) || !body.products.length || body.products.length > 10)
            return json({ error: "products must be a list of 1 to 10 items" }, 400, cors);
          return json(await floristOne(env, "/gettotal", { products: JSON.stringify(body.products) }), 200, cors);
        }

        case "/order":
          // Deliberately off until Florist One's payment flow is confirmed from their docs.
          // Card numbers must never pass through or be stored by this Worker.
          return json({ error: "Online ordering is coming soon." }, 501, cors);

        case "/order-status": {
          const orderno = (url.searchParams.get("orderno") || "").replace(/\D/g, "").slice(0, 20);
          if (!orderno) return json({ error: "orderno required" }, 400, cors);
          return json(await floristOne(env, "/getorderinfo", { orderno }), 200, cors);
        }

        default:
          return json({ error: "not found" }, 404, cors);
      }
    } catch (e) {
      // Fail closed and honest: the site falls back to the "expanding" message.
      return json({ error: "Delivery check is temporarily unavailable." }, 502, cors);
    }
  },
};

async function floristOne(env, path, params) {
  if (!env.FLORISTONE_KEY || !env.FLORISTONE_PASS) throw new Error("not configured");
  const res = await fetch(`${API}${path}?${new URLSearchParams(params)}`, {
    headers: { Authorization: "Basic " + btoa(`${env.FLORISTONE_KEY}:${env.FLORISTONE_PASS}`), Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`Florist One ${res.status}`);
  return res.json();
}

// Florist One's exact response shape is confirmed once we have API access; accept the likely forms.
function extractDates(data) {
  const arr = data?.DATES || data?.dates || data?.Dates || (Array.isArray(data) ? data : []);
  return Array.isArray(arr) ? arr.map(String).filter(Boolean) : [];
}

function sameDate(a, b) {
  const n = s => { const d = new Date(s); return isNaN(d) ? s : d.toISOString().slice(0, 10); };
  return n(a) === n(b);
}

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...headers } });
}

function withHeaders(res, headers) {
  const r = new Response(res.body, res);
  for (const [k, v] of Object.entries(headers)) r.headers.set(k, v);
  return r;
}
