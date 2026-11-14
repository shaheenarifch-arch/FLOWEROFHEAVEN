/* Flower of Heaven: fresh flower delivery through Florist One.
   All calls go to our private server step (the foh-flowers Worker, see /worker/README.md).
   Card numbers are sent straight to Authorize.net by Accept.js and never to our server. */
(function () {
  "use strict";
  var API = "https://foh-flowers.python-tester.workers.dev";
  var ACCEPT_JS = ["https://js.authorize.net/v1/Accept.js", "https://jstest.authorize.net/v1/Accept.js"];
  var OCCASIONS = [
    ["bs", "Best Sellers"], ["ao", "Every Day"], ["bd", "Birthday"], ["an", "Anniversary"],
    ["lr", "Love & Romance"], ["gw", "Get Well"], ["nb", "New Baby"], ["ty", "Thank You"], ["sy", "Sympathy"]
  ];
  var STATES = "AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY".split(" ");
  var PAGE = 12;

  function $(id) { return document.getElementById(id); }
  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    for (var k in attrs || {}) {
      if (k === "text") n.textContent = attrs[k];
      else if (k === "class") n.className = attrs[k];
      else n.setAttribute(k, attrs[k]);
    }
    (kids || []).forEach(function (c) { if (c) n.appendChild(typeof c === "string" ? document.createTextNode(c) : c); });
    return n;
  }
  function money(n) { return "$" + Number(n || 0).toFixed(2); }
  function qs(name) { return new URLSearchParams(location.search).get(name) || ""; }
  function validZip(z) { return /^\d{5}$/.test(z); }
  function call(path, body) {
    var opt = { headers: { Accept: "application/json" } };
    if (body) { opt.method = "POST"; opt.headers["Content-Type"] = "application/json"; opt.body = JSON.stringify(body); }
    return fetch(API + path, opt).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) {
        if (!r.ok) throw new Error(d.error || "Something went wrong. Please try again.");
        return d;
      });
    }, function () { throw new Error("We couldn't reach our flower service. Please check your connection and try again."); });
  }
  function usToISO(us) { var p = us.split("/"); return p[2] + "-" + p[0] + "-" + p[1]; }
  function prettyUS(us) {
    var p = us.split("/").map(Number);
    return new Date(Date.UTC(p[2], p[0] - 1, p[1])).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
  }
  function imgUrl(u) { return /^https:\/\//.test(u) ? u : (/^http:\/\//.test(u) ? u.replace(/^http:/, "https:") : ""); }

  /* ---------- Catalog page (/flowers/) ---------- */
  function initCatalog() {
    var grid = $("fl-grid"); if (!grid) return;
    var tabs = $("fl-tabs"), more = $("fl-more"), status = $("fl-status"), sort = $("fl-sort");
    var zipIn = $("fl-zip"), zipOut = $("fl-zip-status");
    var state = { cat: "bs", start: 1, zip: "" };
    var q = qs("occasion"); if (OCCASIONS.some(function (o) { return o[0] === q; })) state.cat = q;
    if (validZip(qs("zip"))) { state.zip = qs("zip"); zipIn.value = state.zip; checkZip(); }

    OCCASIONS.forEach(function (o) {
      var b = el("button", { type: "button", class: "fl-tab", "data-cat": o[0], "aria-pressed": String(o[0] === state.cat), text: o[1] });
      b.addEventListener("click", function () {
        state.cat = o[0];
        tabs.querySelectorAll("button").forEach(function (x) { x.setAttribute("aria-pressed", String(x === b)); });
        var u = new URL(location.href); u.searchParams.set("occasion", o[0]); history.replaceState(null, "", u);
        load(true);
      });
      tabs.appendChild(b);
    });
    sort.addEventListener("change", function () { load(true); });
    more.addEventListener("click", function () { load(false); });

    $("fl-zip-form").addEventListener("submit", function (e) { e.preventDefault(); checkZip(); });
    zipIn.addEventListener("input", function () { zipIn.value = zipIn.value.replace(/\D/g, "").slice(0, 5); });

    function checkZip() {
      var z = zipIn.value.trim();
      zipOut.className = "nd-status";
      if (!validZip(z)) { zipOut.classList.add("err"); zipOut.textContent = "Please enter a 5-digit US ZIP code."; return; }
      zipOut.textContent = "Checking " + z + "…";
      call("/availability?zip=" + z).then(function (r) {
        state.zip = r.available ? z : "";
        if (!r.available) zipOut.classList.add("err");
        zipOut.textContent = r.message;
        grid.querySelectorAll("a[data-code]").forEach(setLink);
      }).catch(function (err) { zipOut.classList.add("err"); zipOut.textContent = err.message; });
    }
    function setLink(a) {
      a.href = "/flowers/checkout/?code=" + encodeURIComponent(a.getAttribute("data-code")) + (state.zip ? "&zip=" + state.zip : "");
    }
    function load(reset) {
      if (reset) { state.start = 1; grid.textContent = ""; }
      status.textContent = "Loading bouquets…"; more.hidden = true;
      var path = "/products?category=" + state.cat + "&count=" + PAGE + "&start=" + state.start + (sort.value ? "&sort=" + sort.value : "");
      call(path).then(function (d) {
        status.textContent = "";
        if (!d.products.length && reset) status.textContent = "No bouquets in this occasion right now. Please try another.";
        d.products.forEach(function (p) { grid.appendChild(card(p)); });
        state.start += d.products.length;
        more.hidden = d.products.length < PAGE || (d.total && state.start > d.total);
      }).catch(function (err) {
        status.textContent = err.message + " You can also call Florist One on 888-610-8262.";
      });
    }
    function card(p) {
      var link = el("a", { class: "btn btn-rose", "data-code": p.code, text: "Choose this bouquet" });
      setLink(link);
      var photo = el("a", { class: "ph", "data-code": p.code, "aria-hidden": "true", tabindex: "-1" }, [
        el("img", { src: imgUrl(p.large || p.small), alt: p.name, loading: "lazy", width: "400", height: "400" })
      ]);
      setLink(photo);
      return el("article", { class: "card" }, [
        photo,
        el("div", { class: "bd" }, [
          el("h3", { text: p.name }),
          p.dimension ? el("p", { class: "muted fl-dim", text: "Size: " + p.dimension }) : null,
          el("p", { class: "price", text: money(p.price) }, [el("small", { text: "Plus delivery charge and tax, shown before you pay" })]),
          link
        ])
      ]);
    }
    load(true);
  }

  /* ---------- Checkout page (/flowers/checkout/) ---------- */
  function initCheckout() {
    var form = $("co-form"); if (!form) return;
    var code = qs("code"), product = null, payKey = null;
    var msg = $("co-msg"), btn = $("co-submit"), dateSel = $("co-date"), rZip = $("r-zip");
    ["r-state", "c-state"].forEach(function (id) {
      var s = $(id); s.appendChild(el("option", { value: "", text: "Choose…" }));
      STATES.forEach(function (st) { s.appendChild(el("option", { value: st, text: st })); });
    });
    counter("co-card", "co-card-count", 200);
    counter("co-instr", "co-instr-count", 100);
    ["r-zip", "c-zip", "c-phone", "r-phone", "cc-num", "cc-cvv"].forEach(function (id) {
      $(id).addEventListener("input", function () { var max = +$(id).getAttribute("maxlength") || 20; $(id).value = $(id).value.replace(/[^\d]/g, "").slice(0, max); });
    });

    if (!code) { showProductError("Please choose a bouquet first."); return; }
    call("/product?code=" + encodeURIComponent(code)).then(function (d) {
      product = d.product;
      $("co-img").src = imgUrl(product.large || product.small); $("co-img").alt = product.name;
      $("co-name").textContent = product.name;
      $("co-desc").textContent = product.description;
      $("co-dim").textContent = product.dimension ? "Size: " + product.dimension : "";
      $("co-price").textContent = money(product.price);
      document.title = "Send " + product.name + " | Flower of Heaven";
      if (validZip(qs("zip"))) { rZip.value = qs("zip"); loadDates(); }
    }).catch(function (err) { showProductError(err.message); });

    rZip.addEventListener("change", loadDates);
    rZip.addEventListener("input", function () { if (rZip.value.length === 5) loadDates(); });

    function showProductError(t) {
      $("co-summary").textContent = "";
      $("co-summary").appendChild(el("p", { class: "nd-status err", text: t + " " }, [el("a", { href: "/flowers/", text: "Browse bouquets" })]));
      btn.disabled = true;
    }
    var lastZip = "";
    function loadDates() {
      var z = rZip.value.trim(); if (!validZip(z) || z === lastZip) return; lastZip = z;
      dateSel.textContent = ""; dateSel.appendChild(el("option", { value: "", text: "Checking dates…" }));
      $("co-date-help").textContent = "";
      call("/availability?zip=" + z).then(function (r) {
        dateSel.textContent = "";
        if (!r.available) {
          dateSel.appendChild(el("option", { value: "", text: "No delivery dates for this ZIP" }));
          $("co-date-help").textContent = r.message; setTotals(null); return;
        }
        dateSel.appendChild(el("option", { value: "", text: "Choose a delivery date…" }));
        r.dates.forEach(function (d) { dateSel.appendChild(el("option", { value: usToISO(d), text: prettyUS(d) })); });
        $("co-date-help").textContent = r.sameDay ? "Same-day delivery is available if you order before 1 PM in the recipient's time zone." : "";
        if (product) return call("/total", { code: product.code, zip: z }).then(setTotals);
      }).catch(function (err) { $("co-date-help").textContent = err.message; });
    }
    function setTotals(t) {
      $("t-sub").textContent = t ? money(t.subtotal) : "–";
      $("t-del").textContent = t ? money(t.delivery) : "–";
      $("t-tax").textContent = t ? money(t.tax) : "–";
      $("t-total").textContent = t ? money(t.total) : "–";
      btn.textContent = t ? "Place order · " + money(t.total) : "Place order";
    }

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      msg.className = "nd-status"; msg.textContent = "";
      if (!form.reportValidity()) return;
      var exp = $("cc-exp").value.replace(/\s/g, "").split("/");
      if (exp.length !== 2 || !/^\d{2}$/.test(exp[0]) || !/^\d{2}(\d{2})?$/.test(exp[1])) return fail("Enter the card expiry as MM/YY.");
      if (!dateSel.value) return fail("Please choose a delivery date.");
      btn.disabled = true; msg.textContent = "Securing your card with Authorize.net…";
      var v = function (id) { return $(id).value.trim(); };
      getToken({
        cardNumber: v("cc-num"), month: exp[0], year: exp[1].length === 2 ? "20" + exp[1] : exp[1],
        cardCode: v("cc-cvv"), zip: v("c-zip"), fullName: v("cc-name")
      }).then(function (token) {
        // Card fields are cleared as soon as the token exists.
        ["cc-num", "cc-cvv", "cc-exp"].forEach(function (id) { $(id).value = ""; });
        msg.textContent = "Placing your order with our florist partner…";
        return call("/order", {
          code: product.code, deliveryDate: dateSel.value,
          cardMessage: v("co-card"), instructions: v("co-instr"), token: token,
          recipient: { name: v("r-name"), institution: v("r-inst"), address1: v("r-addr1"), address2: v("r-addr2"), city: v("r-city"), state: v("r-state"), zipcode: v("r-zip"), phone: v("r-phone") },
          customer: { name: v("c-name"), email: v("c-email"), address1: v("c-addr1"), address2: v("c-addr2"), city: v("c-city"), state: v("c-state"), zipcode: v("c-zip"), phone: v("c-phone") }
        });
      }).then(function (order) {
        try { sessionStorage.setItem("foh_order", JSON.stringify(order)); } catch (x) {}
        location.href = "/flowers/thank-you/?order=" + encodeURIComponent(order.orderNo);
      }).catch(function (err) { fail(err.message); btn.disabled = false; });
    });
    function fail(t) { msg.className = "nd-status err"; msg.textContent = t; msg.scrollIntoView({ block: "center", behavior: "smooth" }); }

    function getToken(card) {
      var keyP = payKey ? Promise.resolve(payKey) : call("/payment-key").then(function (k) { payKey = k; return k; });
      return keyP.then(function (k) {
        if (ACCEPT_JS.indexOf(k.scriptUrl) < 0) throw new Error("Secure payment is unavailable right now. You have not been charged.");
        return loadScript(k.scriptUrl).then(function () {
          return new Promise(function (resolve, reject) {
            window.Accept.dispatchData({ authData: { clientKey: k.key, apiLoginID: k.username }, cardData: card }, function (res) {
              if (res && res.messages && res.messages.resultCode === "Ok") resolve(res.opaqueData.dataValue);
              else reject(new Error(((res && res.messages && res.messages.message) || []).map(function (m) { return m.text; }).join(" ") || "Your card could not be verified. Please check the details."));
            });
          });
        });
      });
    }
    function loadScript(src) {
      if (window.Accept) return Promise.resolve();
      return new Promise(function (resolve, reject) {
        var s = document.createElement("script"); s.src = src; s.charset = "utf-8";
        s.onload = resolve; s.onerror = function () { reject(new Error("Secure payment could not load. Please try again.")); };
        document.head.appendChild(s);
      });
    }
  }
  function counter(inputId, outId, max) {
    var i = $(inputId), o = $(outId);
    function u() { o.textContent = i.value.length + " / " + max; }
    i.addEventListener("input", u); u();
  }

  /* ---------- Thank-you page (/flowers/thank-you/) ---------- */
  function initThanks() {
    var box = $("ty-box"); if (!box) return;
    var o = null; try { o = JSON.parse(sessionStorage.getItem("foh_order") || "null"); } catch (x) {}
    var no = (o && o.orderNo) || qs("order").replace(/\D/g, "");
    $("ty-no").textContent = no || "shown in your confirmation email";
    if (o && o.orderNo === no) {
      $("ty-product").textContent = o.product.name;
      $("ty-date").textContent = prettyUS(o.deliveryDate);
      $("ty-total").textContent = money(o.total) + " (bouquet " + money(o.subtotal) + ", delivery " + money(o.delivery) + ", tax " + money(o.tax) + ")";
      if (o.product.image) { $("ty-img").src = imgUrl(o.product.image); $("ty-img").alt = o.product.name; $("ty-img").hidden = false; }
    } else {
      $("ty-details").hidden = true;
    }
  }

  function init() { initCatalog(); initCheckout(); initThanks(); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
