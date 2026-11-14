# foh-flowers Worker

This Worker sits privately between flowerofheaven.store and the [Florist One API](https://www.floristone.com/api/). The API key stays here and never appears on the public site. It runs on Cloudflare Workers' free plan with a free `workers.dev` address.

## Deploy (one time, in the Cloudflare dashboard)
1. Go to **Workers & Pages → Create → Create Worker** and name it `foh-flowers`. Paste in `src/index.js`, then click **Deploy**.
2. Under **Settings → Variables and Secrets**, add:
   - `FLORISTONE_KEY`: the API key from Florist One's email (type: **Secret**)
   - `FLORISTONE_PASS`: the API password (type: **Secret**)
   - `ALLOWED_ORIGINS`: `https://flowerofheaven.store,https://www.flowerofheaven.store` (type: Text)
3. Open `https://foh-flowers.<your-subdomain>.workers.dev/health`. You should see `"configured": true`.

Help: [Cloudflare Workers secrets](https://developers.cloudflare.com/workers/configuration/secrets/) · [Florist One API FAQ](https://floristone.com/api/flowers-api-faq)

## Routes
| Route | What it does |
|---|---|
| `GET /availability?zip=02101` | Delivery dates for a ZIP code (used by the home-page ZIP checker) |
| `GET /products?category=…` | Bouquets, cached for 1 hour |
| `POST /total` | Order total including service charges |
| `POST /order` | Turned off (returns 501) until Florist One's payment flow is confirmed |
| `GET /order-status?orderno=…` | Order status and proof of delivery |

Only flowerofheaven.store may call it from a browser. If Florist One can't be reached, it returns an error and the site falls back to the "We're expanding quickly" message.
