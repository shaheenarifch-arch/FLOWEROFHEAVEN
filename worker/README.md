# foh-flowers Worker

This Worker sits privately between flowerofheaven.store and the [Florist One API](https://florist.one/api/documentation/). The API key stays here and never appears on the public site. It runs on Cloudflare Workers' free plan at a free `workers.dev` address, so no new domain is needed.

## Deploy (one time, in the Cloudflare dashboard)
1. Go to **Workers & Pages → Create → Create Worker** and name it `foh-flowers`. Paste in `src/index.js`, then click **Deploy**. The site expects it at `https://foh-flowers.python-tester.workers.dev`. If your workers.dev subdomain is different, change `API` at the top of `/flowers/flowers.js` and `availabilityEndpoint` in `/index.html`.
2. Under **Settings → Variables and Secrets**, add:
   - `FLORISTONE_KEY`: the API key from Florist One's approval email (type: **Secret**)
   - `FLORISTONE_PASS`: the API password from the same email (type: **Secret**)
   - `ALLOWED_ORIGINS`: `https://flowerofheaven.store,https://www.flowerofheaven.store` (type: Text)
   - Optional `ALLOW_SUBSTITUTIONS`: `1` lets the florist swap in a similar flower if one is out of season, `0` does not (type: Text)
3. Open `https://foh-flowers.python-tester.workers.dev/health`. You should see `"configured": true`.

Help: [Cloudflare Workers secrets](https://developers.cloudflare.com/workers/configuration/secrets/) · [Florist One API docs](https://florist.one/api/documentation/)

## Routes
| Route | What it does |
|---|---|
| `GET /availability?zip=02101` | Delivery dates for a ZIP code (home-page ZIP checker and checkout) |
| `GET /products?category=bs&start=1&sort=pa` | Bouquets for an occasion, cached for 1 hour |
| `GET /product?code=F1-509` | One bouquet |
| `POST /total` `{code, zip}` | Price, delivery charge and tax, straight from Florist One |
| `GET /payment-key` | Authorize.net Accept.js public key (Florist One says to fetch it every time) |
| `POST /order` | Places the order with a one-time card token |

## How payment stays safe
- The checkout page sends the card number straight to Authorize.net using [Accept.js](https://developer.authorize.net/api/reference/features/acceptjs.html). Only a one-time token reaches this Worker. Card numbers are never sent to, logged by or stored in this Worker or the site.
- The Worker looks up the bouquet price and order total from Florist One itself. It never trusts a price sent by the browser.
- It checks the delivery date is still available before ordering.
- Florist One charges the customer, sends the order to a local florist and handles customer service ([Florist One customer service](https://www.floristone.com/customer-service/)).

## Test mode vs Live
While the API key is in Test mode, use the test cards from [Florist One's test-card page](https://florist.one/api/documentation/Flower-Shop/Using-a-Test--Credit-Card). Orders get an order number but nothing is delivered and no one is charged. When test orders work, email Florist One to request the Live review. No code change is needed when the key goes live: `/payment-key` switches to Authorize.net's live script by itself.

## Not included, on purpose
Florist One's order-information endpoint returns the customer's full name, address and phone for any order number, and order numbers are easy to guess. To protect customers' privacy, the Worker doesn't offer a public order-lookup route. Customers track orders with Florist One customer service, using the order number on their thank-you page.
