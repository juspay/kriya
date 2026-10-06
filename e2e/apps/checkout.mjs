// Controlled test application: "checkout" family. Fake storefront, fake orders, TEST MODE only.
// Plain Node ESM, node:http only. The pages are written for people; nothing here is meant to
// help an automation (no test ids, no hint text).
import http from 'node:http';

export const family = 'checkout';
export const variants = ['A', 'B', 'C'];

const TEST_MODE_TEXT = 'TEST MODE - no real payment, test card numbers only.';

// ---------------------------------------------------------------------------------------------
// Seed data (fixed, no clocks, no randomness)
// ---------------------------------------------------------------------------------------------

const CATALOG = [
  {
    sku: 'ceramic-dripper',
    title: 'Ceramic Pour-Over Dripper',
    blurb: 'Hand-glazed, brews one to two cups',
    price: 2400,
    tone: '#a98f6d',
  },
  {
    sku: 'merino-socks',
    title: 'Merino Hiking Socks, 2 pack',
    blurb: 'Cushioned sole, charcoal grey',
    price: 1850,
    tone: '#6f8575',
  },
  {
    sku: 'notebook-set',
    title: 'Dot-Grid Notebook Set',
    blurb: 'Three A5 notebooks, lay-flat binding',
    price: 1400,
    tone: '#b99b6a',
  },
  {
    sku: 'desk-lamp',
    title: 'Brass Desk Lamp',
    blurb: 'Warm dimmable LED, weighted base',
    price: 6200,
    tone: '#98712f',
  },
  {
    sku: 'canvas-tote',
    title: 'Waxed Canvas Tote',
    blurb: 'Water-resistant, 18 litre',
    price: 3900,
    tone: '#58694f',
  },
  {
    sku: 'tea-sampler',
    title: 'Loose-Leaf Tea Sampler',
    blurb: 'Six 25 g tins',
    price: 2100,
    tone: '#92492d',
  },
  {
    sku: 'enamel-mug',
    title: 'Enamel Camp Mug',
    blurb: '350 ml, speckled white',
    price: 1600,
    tone: '#6d8aa6',
  },
  {
    sku: 'linen-apron',
    title: 'Linen Work Apron',
    blurb: 'Cross-back straps, sand',
    price: 3400,
    tone: '#a99466',
  },
];
const PRODUCT = new Map(CATALOG.map(p => [p.sku, p]));

const DEFAULT_CART = [
  { sku: 'ceramic-dripper', quantity: 1 },
  { sku: 'merino-socks', quantity: 2 },
  { sku: 'notebook-set', quantity: 1 },
];
const DEFAULT_SAVED = [{ sku: 'tea-sampler', quantity: 1 }];

const PROMOS = { WELCOME10: { percent: 10, label: '10% off' } };
const FREE_SHIPPING_AT = 8000;
const STANDARD_SHIPPING = 599;
const EXPRESS_SHIPPING = 1499;
const TAX_PERCENT = 8;

const STATES = [
  ['CA', 'California'],
  ['CO', 'Colorado'],
  ['IL', 'Illinois'],
  ['MA', 'Massachusetts'],
  ['NY', 'New York'],
  ['OR', 'Oregon'],
  ['TX', 'Texas'],
  ['WA', 'Washington'],
];
const STATE_CODES = new Set(STATES.map(([code]) => code));

const PROFILE = {
  contact: { email: 'test.shopper@example.test', phone: '555-010-0199' },
  shipping: {
    firstName: 'Test',
    lastName: 'Shopper',
    address1: '18 Alder Lane',
    address2: '',
    city: 'Portland',
    region: 'OR',
    postalCode: '97205',
  },
};

// Card numbers are assembled from parts so that no full test number sits in the source as one
// literal. The backend keeps only last4.
const VISA_TEST = '4242'.repeat(4);
const MASTERCARD_TEST = ['5555', '5555', '5555', '4444'].join('');
const DECLINED_TEST = ['4000', '0000', '0000', '0002'].join('');
const TEST_CARDS = new Map([
  [VISA_TEST, 'ok'],
  [MASTERCARD_TEST, 'ok'],
  [DECLINED_TEST, 'declined'],
]);
const SAVED_CARD_LAST4 = VISA_TEST.slice(-4);
// Fixed test clock for expiry validation, so behavior never depends on the real date.
const TEST_CLOCK = { year: 26, month: 10 };

const MSG = {
  A: {
    email: 'Enter an email address like name@example.com.',
    phone: 'Enter a phone number with at least 7 digits.',
    firstName: 'First name is required.',
    lastName: 'Last name is required.',
    address1: 'Street address is required.',
    city: 'City is required.',
    region: 'Select a state.',
    postalCode: 'ZIP code must be 5 digits.',
    method: 'Choose a delivery method.',
    cardName: 'Enter the name shown on the card.',
    cardNumber: 'Card number is not valid.',
    expiry: 'Enter a future expiry date as MM/YY.',
    cvc: 'Security code must be 3 digits.',
    declined: 'Your card was declined.',
    empty: 'Your cart is empty.',
  },
  B: {
    email: 'Please use a valid email address.',
    phone: 'We need a mobile number (7 to 15 digits) in case of delivery issues.',
    firstName: 'Please enter your first and last name.',
    lastName: 'Please enter your first and last name.',
    address1: 'Please enter a delivery address.',
    city: 'Please enter a city.',
    region: 'Please pick a state.',
    postalCode: 'Postal code should have 5 digits.',
    method: 'Pick a delivery speed.',
    cardName: 'Please enter the cardholder name.',
    cardNumber: "That card number can't be used here.",
    expiry: 'Choose a month and year that is still in the future.',
    cvc: 'Enter the 3-digit code from the back of the card.',
    declined: 'The card issuer declined this payment.',
    empty: 'Your bag is empty.',
  },
  C: {
    declined: 'Your saved card was declined.',
    empty: 'Your basket is empty.',
  },
};

const SERVER_ERROR = {
  error: 'server_error',
  message: 'Something went wrong on our end. Please try again.',
};

// ---------------------------------------------------------------------------------------------
// Isomorphic helpers: these functions are also sent to the browser as source text, so each one
// must stay self-contained (no references to module-level constants).
// ---------------------------------------------------------------------------------------------

function esc(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function money(cents) {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const dollars = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return sign + '$' + dollars + '.' + String(abs % 100).padStart(2, '0');
}

function plural(n, one, many) {
  return n + ' ' + (n === 1 ? one : many);
}

function shipFmt(cents) {
  return cents === 0 ? 'Free' : money(cents);
}

function thumb(tone, title) {
  return `<span class="thumb" style="background:${esc(tone)}" aria-hidden="true">${esc(title.charAt(0))}</span>`;
}

function syncCount(view) {
  const el = document.getElementById('cart-count');
  if (el) el.textContent = String(view.totals.itemCount);
}

async function api(method, path, body) {
  try {
    const res = await fetch(path, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
    });
    let data = null;
    try {
      data = await res.json();
    } catch (parseError) {
      data = null;
    }
    return { status: res.status, ok: res.ok, data };
  } catch (networkError) {
    return { status: 0, ok: false, data: null };
  }
}

// cloneNode keeps typed text and checked state but drops a select's live choice, so the choice is
// restored by hand. This comment lives outside the function on purpose: function bodies are served
// to the browser as source text, and no developer comment should reach the page.
function startRerender(ms, getRoots) {
  if (!ms) return;
  setInterval(() => {
    for (const root of getRoots()) {
      if (!root) continue;
      for (const node of Array.from(root.children)) {
        const chosen = Array.from(node.querySelectorAll('select')).map(s => s.selectedIndex);
        const fresh = node.cloneNode(true);
        fresh.querySelectorAll('select').forEach((s, i) => {
          s.selectedIndex = chosen[i];
        });
        node.replaceWith(fresh);
      }
    }
  }, ms);
}

function bindNewsletter() {
  document.addEventListener('submit', async event => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || !form.classList.contains('newsletter')) return;
    event.preventDefault();
    const message = form.querySelector('.nl-msg');
    const email = form.querySelector('input[name=email]').value;
    const r = await api('POST', '/api/newsletter', { email });
    if (message) {
      message.textContent = r.ok
        ? 'Thanks, you are on the list.'
        : r.status === 422
          ? 'Please enter a valid email address.'
          : 'Sorry, that did not go through. Please try again later.';
    }
  });
}

// --- Variant A fragments (rendered on the server and re-rendered in the browser)

function cartRegionA(view) {
  if (view.items.length === 0) {
    return '<div class="empty"><h2>Your cart is empty</h2><p>Anything you add from the shop will show up here.</p><a class="btn ghost" href="/p/shop">Continue shopping</a></div>';
  }
  const rows = view.items
    .map(
      i => `<tr>
<td class="prod">${thumb(i.tone, i.title)}<div><a href="/p/${esc(i.sku)}">${esc(i.title)}</a><div class="muted">${esc(i.blurb)}</div></div></td>
<td class="num">${money(i.unitPrice)}</td>
<td class="num"><label class="sr" for="qty-${esc(i.sku)}">Quantity for ${esc(i.title)}</label><input id="qty-${esc(i.sku)}" name="qty-${esc(i.sku)}" type="number" min="0" max="99" value="${i.quantity}"></td>
<td class="num">${money(i.lineTotal)}</td>
<td><button type="button" class="link" name="remove" value="${esc(i.sku)}">Remove<span class="sr"> ${esc(i.title)}</span></button></td>
</tr>`
    )
    .join('');
  const promoRow = view.promo
    ? `<div class="row"><dt>Promo ${esc(view.promo.code)}</dt><dd>${money(-view.totals.discount)}</dd></div>`
    : '';
  const removeCode = view.promo
    ? '<button type="button" class="link" name="unpromo">Remove code</button>'
    : '';
  return `<div class="layout">
<section aria-labelledby="items-h">
<h2 id="items-h">Items in your cart</h2>
<form id="cart-form" novalidate>
<table>
<thead><tr><th scope="col">Product</th><th scope="col" class="num">Price</th><th scope="col" class="num">Quantity</th><th scope="col" class="num">Total</th><th scope="col"><span class="sr">Actions</span></th></tr></thead>
<tbody>${rows}</tbody>
</table>
<div class="actions"><button type="submit" class="btn ghost">Update cart</button><button type="button" class="btn danger" name="clear">Clear cart</button><a href="/p/shop">Continue shopping</a></div>
</form>
<form id="promo-form" class="promo" novalidate><label for="promo-code">Promo code</label><input id="promo-code" name="code" autocomplete="off"><button type="submit" class="btn ghost">Apply</button>${removeCode}</form>
</section>
<aside aria-labelledby="sum-h" class="summary">
<h2 id="sum-h">Order summary</h2>
<dl><div class="row"><dt>Subtotal (${plural(view.totals.itemCount, 'item', 'items')})</dt><dd>${money(view.totals.subtotal)}</dd></div>${promoRow}</dl>
<p class="muted">Shipping and tax are calculated at checkout.</p>
<a class="btn primary wide" href="/checkout">Proceed to checkout</a>
</aside>
</div>`;
}

function summaryA(items, totals, promo) {
  const lines = items
    .map(
      i =>
        `<li><span>${esc(i.title)} <span class="muted">&times; ${i.quantity}</span></span><span>${money(i.lineTotal)}</span></li>`
    )
    .join('');
  const discount =
    totals.discount > 0
      ? `<div class="row"><dt>Discount${promo ? ' (' + esc(promo.code) + ')' : ''}</dt><dd>${money(-totals.discount)}</dd></div>`
      : '';
  return `<h2 id="sum-h">Order summary</h2>
<ul class="lines">${lines}</ul>
<dl>
<div class="row"><dt>Subtotal</dt><dd>${money(totals.subtotal)}</dd></div>${discount}
<div class="row"><dt>Shipping</dt><dd>${shipFmt(totals.shipping)}</dd></div>
<div class="row"><dt>Estimated tax</dt><dd>${money(totals.tax)}</dd></div>
<div class="row total"><dt>Total</dt><dd>${money(totals.total)}</dd></div>
</dl>`;
}

// --- Variant C fragments

function basketBodyC(view) {
  const n = view.totals.itemCount;
  const head = `<h1>Your basket <span class="count">${plural(n, 'item', 'items')}</span></h1>`;
  const qtyOptions = qty => {
    const max = Math.max(10, qty);
    let out = '';
    for (let q = 1; q <= max; q += 1)
      out += `<option value="${q}"${q === qty ? ' selected' : ''}>${q}</option>`;
    return out;
  };
  const lines = view.items
    .map(
      i => `<li class="card">
${thumb(i.tone, i.title)}
<div class="grow"><h3><a href="/p/${esc(i.sku)}">${esc(i.title)}</a></h3><p class="muted">${esc(i.blurb)}</p><p>${money(i.unitPrice)} each</p>
<div class="row"><label>Qty <select name="qty-${esc(i.sku)}" aria-label="Quantity for ${esc(i.title)}">${qtyOptions(i.quantity)}</select></label>
<button type="button" class="chip" name="save" value="${esc(i.sku)}">Save for later<span class="sr"> ${esc(i.title)}</span></button>
<button type="button" class="chip warn" name="remove" value="${esc(i.sku)}">Remove<span class="sr"> ${esc(i.title)}</span></button></div></div>
<p class="line-total">${money(i.lineTotal)}</p>
</li>`
    )
    .join('');
  const itemsBlock =
    view.items.length > 0
      ? `<section aria-labelledby="lines-h"><h2 id="lines-h" class="sr">Items in your basket</h2><ul class="cards">${lines}</ul></section>`
      : '<section><p class="lead">Your basket is empty.</p><a class="btn ghost" href="/p/new-arrivals">Keep shopping</a></section>';
  const saved =
    view.saved.length > 0
      ? `<section aria-labelledby="saved-h"><h2 id="saved-h">Saved for later (${view.saved.length})</h2><ul class="cards compact">${view.saved
          .map(
            i => `<li class="card">${thumb(i.tone, i.title)}<div class="grow"><h3>${esc(i.title)}</h3><p>${money(i.unitPrice)}</p></div>
<div class="row"><button type="button" class="chip" name="restore" value="${esc(i.sku)}">Move to basket<span class="sr"> ${esc(i.title)}</span></button>
<button type="button" class="chip warn" name="drop" value="${esc(i.sku)}">Delete<span class="sr"> ${esc(i.title)}</span></button></div></li>`
          )
          .join('')}</ul></section>`
      : '';
  const recs = view.recommended
    .map(
      p => `<li class="rec">${thumb(p.tone, p.title)}<h3>${esc(p.title)}</h3><p>${money(p.unitPrice)}</p>
<button type="button" class="chip" name="add" value="${esc(p.sku)}">Add to basket<span class="sr"> ${esc(p.title)}</span></button></li>`
    )
    .join('');
  const recBlock =
    view.recommended.length > 0
      ? `<section aria-labelledby="recs-h"><h2 id="recs-h">Customers also picked</h2><ul class="grid4">${recs}</ul></section>`
      : '';
  const discount =
    view.totals.discount > 0
      ? `<div class="row"><dt>Promo ${esc(view.promo ? view.promo.code : '')}</dt><dd>${money(-view.totals.discount)}</dd></div>`
      : '';
  const removeCode = view.promo
    ? '<button type="button" class="chip" name="unpromo">Remove code</button>'
    : '';
  const checkout =
    view.items.length > 0
      ? `<section class="panel" aria-labelledby="ship-h"><h2 id="ship-h">Delivery and payment</h2>
<dl class="facts"><dt>Deliver to</dt><dd>${esc(view.account.name)}, ${esc(view.account.address)}</dd>
<dt>Delivery</dt><dd>Standard, 3 to 5 business days</dd>
<dt>Pay with</dt><dd>${esc(view.account.card)}</dd></dl>
<a href="/p/wallet">Change address or card</a></section>
<form id="promo-form" class="promo" novalidate><label for="promo-code">Promo code</label><input id="promo-code" name="code" autocomplete="off"><button type="submit" class="chip">Apply</button>${removeCode}</form>
<section class="panel summary" aria-labelledby="tot-h"><h2 id="tot-h">Basket total</h2>
<dl><div class="row"><dt>Items</dt><dd>${money(view.totals.subtotal)}</dd></div>${discount}
<div class="row"><dt>Delivery</dt><dd>${shipFmt(view.totals.shipping)}</dd></div>
<div class="row"><dt>Estimated tax</dt><dd>${money(view.totals.tax)}</dd></div>
<div class="row total"><dt>Total</dt><dd>${money(view.totals.total)}</dd></div></dl>
<button type="button" class="buy" name="buy">Buy now</button>
<a class="again" href="/p/new-arrivals">Continue shopping</a></section>`
      : '';
  return head + itemsBlock + saved + recBlock + checkout;
}

function confirmTextC(view) {
  return `You are about to pay ${money(view.totals.total)} with ${view.account.card} for ${plural(view.totals.itemCount, 'item', 'items')}, delivered to ${view.account.address}.`;
}

function receiptC(r) {
  const lines = r.items
    .map(
      i =>
        `<li><span>${esc(i.title)} <span class="muted">&times; ${i.quantity}</span></span><span>${money(i.lineTotal)}</span></li>`
    )
    .join('');
  return `<section class="receipt" aria-labelledby="rc-h">
<h1 id="rc-h">Order placed</h1>
<p class="lead">Thank you, ${esc(r.shipping.name.split(' ')[0])}. Your order <strong>${esc(r.id)}</strong> is being packed.</p>
<p class="notice">Test order. No payment was taken.</p>
<ul class="lines">${lines}</ul>
<dl><div class="row"><dt>Items</dt><dd>${money(r.totals.subtotal)}</dd></div>
<div class="row"><dt>Delivery</dt><dd>${shipFmt(r.totals.shipping)}</dd></div>
<div class="row"><dt>Tax</dt><dd>${money(r.totals.tax)}</dd></div>
<div class="row total"><dt>Total paid</dt><dd>${money(r.totals.total)}</dd></div></dl>
<p>Delivering to ${esc(r.shipping.name)}, ${esc(r.shipping.address1)}, ${esc(r.shipping.city)}, ${esc(r.shipping.region)} ${esc(r.shipping.postalCode)}.</p>
<p>Card ending in ${esc(r.cardLast4)}.</p>
<p><a href="/p/new-arrivals">Back to the market</a></p>
</section>`;
}

const ISO_SRC = [
  esc,
  money,
  plural,
  shipFmt,
  thumb,
  syncCount,
  api,
  startRerender,
  bindNewsletter,
  cartRegionA,
  summaryA,
  basketBodyC,
  confirmTextC,
  receiptC,
]
  .map(fn => fn.toString())
  .join('\n');

// ---------------------------------------------------------------------------------------------
// Browser code, one function per variant (serialized into the page)
// ---------------------------------------------------------------------------------------------

function clientA(cfg) {
  const $ = selector => document.querySelector(selector);
  const region = () => document.getElementById('cart-region');
  startRerender(cfg.rerenderEveryMs, () => [document.getElementById('page')]);
  bindNewsletter();

  const notice = text => {
    const el = $('#notice');
    if (el) el.textContent = text;
  };
  const problem = text => {
    const el = $('#problem');
    if (el) el.textContent = text;
  };

  async function refresh() {
    const r = await api('GET', '/api/cart');
    if (r.ok && region()) {
      region().innerHTML = cartRegionA(r.data);
      syncCount(r.data);
    }
  }

  async function mutate(method, path, payload, okText) {
    notice('');
    problem('');
    const r = await api(method, path, payload);
    if (r.ok && r.data && r.data.cart) {
      region().innerHTML = cartRegionA(r.data.cart);
      syncCount(r.data.cart);
      notice(okText);
      return;
    }
    const errors = r.data && r.data.errors ? Object.values(r.data.errors) : [];
    problem(
      errors.length > 0 ? String(errors[0]) : "We couldn't update your cart. Please try again."
    );
    await refresh();
  }

  function fieldErrors(errors) {
    for (const old of document.querySelectorAll('#checkout-form .err')) old.remove();
    for (const input of document.querySelectorAll('#checkout-form [aria-invalid]')) {
      input.removeAttribute('aria-invalid');
      input.removeAttribute('aria-describedby');
    }
    let first = null;
    for (const [name, text] of Object.entries(errors || {})) {
      const input = document.getElementById('checkout-form').elements[name];
      if (!input) continue;
      const holder = input.closest('.field');
      const note = document.createElement('p');
      note.className = 'err';
      note.id = 'err-' + input.id;
      note.setAttribute('role', 'alert');
      note.textContent = String(text);
      holder.appendChild(note);
      input.setAttribute('aria-invalid', 'true');
      input.setAttribute('aria-describedby', note.id);
      if (!first) first = input;
    }
    if (first) first.focus();
  }

  async function placeOrder(form) {
    const val = name => String(form.elements[name].value);
    const alertBox = $('#form-alert');
    alertBox.textContent = '';
    fieldErrors({});
    const submit = form.querySelector('button[type=submit]');
    submit.disabled = true;
    const method = form.querySelector('input[name="shipping.method"]:checked');
    const r = await api('POST', '/api/orders', {
      contact: { email: val('contact.email'), phone: val('contact.phone') },
      shipping: {
        firstName: val('shipping.firstName'),
        lastName: val('shipping.lastName'),
        address1: val('shipping.address1'),
        address2: val('shipping.address2'),
        city: val('shipping.city'),
        region: val('shipping.region'),
        postalCode: val('shipping.postalCode'),
        method: method ? method.value : '',
      },
      payment: {
        cardName: val('payment.cardName'),
        cardNumber: val('payment.cardNumber'),
        expiry: val('payment.expiry'),
        cvc: val('payment.cvc'),
      },
      marketingOptIn: form.elements.marketingOptIn.checked,
      note: val('note'),
    });
    if (r.status === 201 && r.data && r.data.id) {
      window.location.assign('/order/' + r.data.id);
      return;
    }
    const liveForm = document.getElementById('checkout-form');
    const liveAlert = $('#form-alert');
    if (r.status === 422 && r.data && r.data.errors) {
      liveAlert.textContent = 'There is a problem with your order. Check the highlighted fields.';
      fieldErrors(r.data.errors);
    } else if (r.status === 402 || r.status === 409) {
      liveAlert.textContent = r.data && r.data.message ? r.data.message : 'Payment failed.';
    } else {
      liveAlert.textContent =
        "We couldn't place your order right now. Nothing was charged. Please try again in a moment.";
    }
    const liveSubmit = liveForm.querySelector('button[type=submit]');
    if (liveSubmit) liveSubmit.disabled = false;
  }

  document.addEventListener('submit', async event => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    if (form.id === 'cart-form') {
      event.preventDefault();
      const items = Array.from(form.querySelectorAll('input[type=number]')).map(input => ({
        sku: input.name.slice(4),
        quantity: Number(input.value),
      }));
      await mutate('PUT', '/api/cart', { items }, 'Your cart has been updated.');
    } else if (form.id === 'promo-form') {
      event.preventDefault();
      const code = form.elements.code.value;
      await mutate('POST', '/api/cart/promo', { code }, 'Promo code applied.');
    } else if (form.id === 'checkout-form') {
      event.preventDefault();
      await placeOrder(form);
    }
  });

  document.addEventListener('click', async event => {
    const button = event.target.closest('button');
    if (!button) return;
    if (button.name === 'remove') {
      await mutate(
        'DELETE',
        '/api/cart/items/' + encodeURIComponent(button.value),
        undefined,
        'Item removed from your cart.'
      );
    } else if (button.name === 'clear') {
      await mutate('POST', '/api/cart/clear', {}, 'Your cart is now empty.');
    } else if (button.name === 'unpromo') {
      await mutate('DELETE', '/api/cart/promo', undefined, 'Promo code removed.');
    } else if (button.name === 'wallet') {
      const note = $('#wallet-note');
      if (note) note.textContent = 'Wallet payments are not available in test mode.';
    }
  });

  document.addEventListener('change', async event => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || input.name !== 'shipping.method') return;
    const r = await api('GET', '/api/quote?method=' + encodeURIComponent(input.value));
    const box = $('#checkout-summary');
    if (r.ok && box) box.innerHTML = summaryA(r.data.items, r.data.totals, r.data.promo);
  });
}

function clientB(cfg) {
  const view = document.getElementById('view');
  const draft = {
    contact: { email: '', phone: '' },
    shipping: {
      fullName: '',
      address1: '',
      address2: '',
      city: '',
      region: '',
      postalCode: '',
      method: 'standard',
    },
    payment: { cardName: '', cardNumber: '', expMonth: '', expYear: '', cvc: '' },
    marketing: true,
  };
  const st = {
    cart: null,
    quote: null,
    shippingOk: false,
    paymentOk: false,
    errors: {},
    flash: '',
    alert: '',
    receipt: null,
    profileApplied: false,
    busy: false,
  };
  const STEP_PATHS = ['/checkout/shipping', '/checkout/payment', '/checkout/review'];
  const MONTHS = [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
  ];
  const e = esc;

  startRerender(cfg.rerenderEveryMs, () => [view]);
  bindNewsletter();

  const getPath = name => {
    const parts = name.split('.');
    return draft[parts[0]] ? draft[parts[0]][parts[1]] : undefined;
  };
  const setPath = (name, value) => {
    const parts = name.split('.');
    if (draft[parts[0]] && parts[1] in draft[parts[0]]) draft[parts[0]][parts[1]] = value;
  };
  const setCount = n => {
    const el = document.getElementById('cart-count');
    if (el) el.textContent = String(n);
  };

  function field(id, label, name, options) {
    const o = options || {};
    const err = st.errors[name];
    const aria = err ? ` aria-invalid="true" aria-describedby="${id}-err"` : '';
    return `<div class="fld"><label for="${id}">${e(label)}</label><input id="${id}" name="${name}" type="${o.type || 'text'}" value="${e(getPath(name) || '')}"${o.autocomplete ? ` autocomplete="${o.autocomplete}"` : ''}${o.inputmode ? ` inputmode="${o.inputmode}"` : ''}${o.placeholder ? ` placeholder="${e(o.placeholder)}"` : ''}${aria}>${err ? `<p class="err" id="${id}-err" role="alert">${e(err)}</p>` : ''}</div>`;
  }

  function selectField(id, label, name, choices, placeholder) {
    const err = st.errors[name];
    const aria = err ? ` aria-invalid="true" aria-describedby="${id}-err"` : '';
    const current = getPath(name) || '';
    const opts = [`<option value="">${e(placeholder)}</option>`]
      .concat(
        choices.map(
          c =>
            `<option value="${e(c[0])}"${c[0] === current ? ' selected' : ''}>${e(c[1])}</option>`
        )
      )
      .join('');
    return `<div class="fld"><label for="${id}">${e(label)}</label><select id="${id}" name="${name}"${aria}>${opts}</select>${err ? `<p class="err" id="${id}-err" role="alert">${e(err)}</p>` : ''}</div>`;
  }

  function stepper(active) {
    const names = ['Shipping', 'Payment', 'Review'];
    return `<ol class="steps" aria-label="Checkout progress">${names
      .map(
        (n, i) =>
          `<li${i === active ? ' aria-current="step"' : ''} class="${i < active ? 'done' : ''}"><span class="n">${i + 1}</span> ${n}</li>`
      )
      .join('')}</ol>`;
  }

  function summaryPanel(q) {
    if (!q) return '';
    const t = q.totals;
    const lines = q.items
      .map(
        i =>
          `<li><span>${e(i.title)} <span class="muted">&times; ${i.quantity}</span></span><span>${money(i.lineTotal)}</span></li>`
      )
      .join('');
    return `<aside class="card side" aria-labelledby="os-h"><h2 id="os-h">Your order</h2><ul class="lines">${lines}</ul><dl>
<div class="row"><dt>Subtotal</dt><dd>${money(t.subtotal)}</dd></div>${t.discount > 0 ? `<div class="row"><dt>Promo</dt><dd>${money(-t.discount)}</dd></div>` : ''}
<div class="row"><dt>Delivery</dt><dd>${shipFmt(t.shipping)}</dd></div>
<div class="row"><dt>Tax</dt><dd>${money(t.tax)}</dd></div>
<div class="row total"><dt>Total</dt><dd>${money(t.total)}</dd></div></dl></aside>`;
  }

  const banner = `<div class="test-banner" role="note">${e(cfg.testMode)}</div>`;
  const alertBox = () =>
    `<div id="form-alert" role="alert" class="alertbox">${st.alert ? e(st.alert) : ''}</div>`;

  function bagView() {
    const c = st.cart;
    if (!c || c.items.length === 0) {
      return `<h1>Your bag</h1>${st.flash ? `<p class="toast" role="status">${e(st.flash)}</p>` : ''}${st.alert ? `<p class="alertbox" role="alert">${e(st.alert)}</p>` : ''}<div class="card"><p>Your bag is empty.</p><a class="btn ghost" href="/p/new-in">Browse new arrivals</a></div>`;
    }
    const lines = c.items
      .map(
        i => `<li class="line">${thumb(i.tone, i.title)}
<div class="info"><a href="/p/${e(i.sku)}">${e(i.title)}</a><p class="muted">${e(i.blurb)}</p><button type="button" class="textbtn" name="remove" value="${e(i.sku)}">Remove<span class="sr"> ${e(i.title)}</span></button></div>
<div class="stepper" role="group" aria-label="Quantity for ${e(i.title)}"><button type="button" name="dec" value="${e(i.sku)}" aria-label="Decrease quantity of ${e(i.title)}">&minus;</button><input name="qty-${e(i.sku)}" inputmode="numeric" aria-label="Quantity of ${e(i.title)}" value="${i.quantity}"><button type="button" name="inc" value="${e(i.sku)}" aria-label="Increase quantity of ${e(i.title)}">+</button></div>
<p class="price">${money(i.lineTotal)}</p></li>`
      )
      .join('');
    const t = c.totals;
    return `<h1>Your bag</h1>${st.flash ? `<p class="toast" role="status">${e(st.flash)}</p>` : ''}${st.alert ? `<p class="alertbox" role="alert">${e(st.alert)}</p>` : ''}
<div class="cols"><section aria-label="Bag contents"><ul class="bag">${lines}</ul>
<form id="promo-form" class="promo" novalidate><label for="promo">Have a promo code?</label><div class="inline"><input id="promo" name="code" autocomplete="off"><button type="submit" class="btn ghost">Apply code</button>${c.promo ? '<button type="button" class="textbtn" name="unpromo">Remove code</button>' : ''}</div></form>
</section>
<aside class="card side" aria-labelledby="bt-h"><h2 id="bt-h">Bag total</h2><dl>
<div class="row"><dt>Subtotal</dt><dd>${money(t.subtotal)}</dd></div>${t.discount > 0 ? `<div class="row"><dt>Promo ${e(c.promo.code)}</dt><dd>${money(-t.discount)}</dd></div>` : ''}
<div class="row total"><dt>Before delivery and tax</dt><dd>${money(t.subtotal - t.discount)}</dd></div></dl>
<a class="btn primary wide" href="/checkout/shipping">Checkout securely</a>
<button type="button" class="textbtn center" name="empty">Empty bag</button></aside></div>`;
  }

  function shippingView() {
    const opts = st.quote ? st.quote.shippingOptions : { standard: 599, express: 1499 };
    return `${stepper(0)}${banner}<h1>Where should we send it?</h1><div class="cols"><form id="step-form" novalidate>
<fieldset class="card"><legend>Contact</legend>
${field('f-email', 'Email', 'contact.email', { type: 'email', autocomplete: 'email' })}
${field('f-phone', 'Mobile phone', 'contact.phone', { type: 'tel', autocomplete: 'tel' })}</fieldset>
<fieldset class="card"><legend>Delivery address</legend>
${field('f-name', 'Full name', 'shipping.fullName', { autocomplete: 'name' })}
${field('f-addr1', 'Address', 'shipping.address1', { autocomplete: 'address-line1' })}
${field('f-addr2', 'Apartment or unit', 'shipping.address2', { autocomplete: 'address-line2' })}
${field('f-city', 'Town or city', 'shipping.city', { autocomplete: 'address-level2' })}
${selectField('f-state', 'State', 'shipping.region', cfg.states, 'Choose state')}
${field('f-zip', 'Postal code', 'shipping.postalCode', { autocomplete: 'postal-code', inputmode: 'numeric' })}
<div class="fld"><label for="f-speed">Delivery speed</label><select id="f-speed" name="shipping.method"><option value="standard"${draft.shipping.method === 'standard' ? ' selected' : ''}>Standard, 3 to 5 days (${shipFmt(opts.standard)})</option><option value="express"${draft.shipping.method === 'express' ? ' selected' : ''}>Express, 1 to 2 days (${shipFmt(opts.express)})</option></select></div></fieldset>
<div class="nav"><a href="/bag">Back to bag</a><button type="submit" class="btn primary">Continue to payment</button></div></form>${summaryPanel(st.quote)}</div>`;
  }

  function paymentView() {
    const yearNow = 2026;
    const months = MONTHS.map((m, i) => [
      String(i + 1).padStart(2, '0'),
      String(i + 1).padStart(2, '0') + ' - ' + m,
    ]);
    const years = [];
    for (let y = yearNow; y <= yearNow + 8; y += 1) years.push([String(y), String(y)]);
    const expErr = st.errors['payment.expiry'];
    return `${stepper(1)}${banner}<h1>Payment details</h1><div class="cols"><form id="step-form" novalidate>
<fieldset class="card"><legend>Card</legend>
${field('p-holder', 'Cardholder name', 'payment.cardName', { autocomplete: 'cc-name' })}
${field('p-number', 'Card number', 'payment.cardNumber', { autocomplete: 'cc-number', inputmode: 'numeric', placeholder: '0000 0000 0000 0000' })}
<fieldset class="expiry"><legend>Expiry date</legend>${selectField('p-month', 'Month', 'payment.expMonth', months, 'MM')}${selectField('p-year', 'Year', 'payment.expYear', years, 'YYYY')}${expErr ? `<p class="err" role="alert">${e(expErr)}</p>` : ''}</fieldset>
${field('p-cvc', 'Security code (CVC)', 'payment.cvc', { autocomplete: 'cc-csc', inputmode: 'numeric' })}
<label class="check"><input type="checkbox" name="billingSame" checked> Billing address is the same as the delivery address</label></fieldset>
<div class="nav"><a href="/checkout/shipping">Back to shipping</a><button type="submit" class="btn primary">Review order</button></div></form>${summaryPanel(st.quote)}</div>`;
  }

  function reviewView() {
    const s = draft.shipping;
    const last4 = draft.payment.cardNumber.replace(/\D/g, '').slice(-4);
    const speed = s.method === 'express' ? 'Express, 1 to 2 days' : 'Standard, 3 to 5 days';
    return `${stepper(2)}${banner}<h1>Review your order</h1><div class="cols"><div>
<section class="card" aria-labelledby="rv1"><h2 id="rv1">Contact</h2><p>${e(draft.contact.email)}<br>${e(draft.contact.phone)}</p><a href="/checkout/shipping">Change contact</a></section>
<section class="card" aria-labelledby="rv2"><h2 id="rv2">Delivery</h2><p>${e(s.fullName)}<br>${e(s.address1)}${s.address2 ? ', ' + e(s.address2) : ''}<br>${e(s.city)}, ${e(s.region)} ${e(s.postalCode)}</p><p>${speed}</p><a href="/checkout/shipping">Change address</a></section>
<section class="card" aria-labelledby="rv3"><h2 id="rv3">Payment</h2><p>Card ending in ${e(last4)}</p><a href="/checkout/payment">Change card</a></section>
<form id="step-form" novalidate><label class="check"><input type="checkbox" name="marketing"${draft.marketing ? ' checked' : ''}> Send me news and offers from Harbor &amp; Hearth</label>
${alertBox()}
<div class="nav"><a href="/checkout/payment">Back to payment</a><button type="submit" class="btn primary">Place your order</button></div></form></div>${summaryPanel(st.quote)}</div>`;
  }

  function completeView(r) {
    if (!r) {
      return `<h1>Order not found</h1><p>We could not find that order.</p><a class="btn ghost" href="/p/new-in">Back to the shop</a>`;
    }
    const lines = r.items
      .map(
        i =>
          `<li><span>${e(i.title)} <span class="muted">&times; ${i.quantity}</span></span><span>${money(i.lineTotal)}</span></li>`
      )
      .join('');
    return `<div class="card done"><h1>Order confirmed</h1><p class="lead">Thanks, ${e(r.shipping.name.split(' ')[0])}. Your order number is <strong>${e(r.id)}</strong>.</p>
<p class="notice">This was a test order. No payment was taken.</p>
<ul class="lines">${lines}</ul><dl>
<div class="row"><dt>Subtotal</dt><dd>${money(r.totals.subtotal)}</dd></div>
<div class="row"><dt>Delivery</dt><dd>${shipFmt(r.totals.shipping)}</dd></div>
<div class="row"><dt>Tax</dt><dd>${money(r.totals.tax)}</dd></div>
<div class="row total"><dt>Total charged</dt><dd>${money(r.totals.total)}</dd></div></dl>
<p>Shipping to ${e(r.shipping.name)}, ${e(r.shipping.address1)}, ${e(r.shipping.city)}, ${e(r.shipping.region)} ${e(r.shipping.postalCode)}. Paid with card ending in ${e(r.cardLast4)}.</p>
<a class="btn ghost" href="/p/new-in">Back to the shop</a></div>`;
  }

  async function loadCart() {
    const r = await api('GET', '/api/cart');
    if (r.ok) {
      st.cart = r.data;
      setCount(r.data.totals.itemCount);
      if (r.data.profile && !st.profileApplied) {
        st.profileApplied = true;
        const p = r.data.profile;
        draft.contact.email = p.contact.email;
        draft.contact.phone = p.contact.phone;
        draft.shipping.fullName = p.shipping.firstName + ' ' + p.shipping.lastName;
        draft.shipping.address1 = p.shipping.address1;
        draft.shipping.address2 = p.shipping.address2;
        draft.shipping.city = p.shipping.city;
        draft.shipping.region = p.shipping.region;
        draft.shipping.postalCode = p.shipping.postalCode;
      }
    }
    return r.ok;
  }

  async function loadQuote() {
    const r = await api('GET', '/api/quote?method=' + encodeURIComponent(draft.shipping.method));
    if (r.ok) st.quote = r.data;
    return r.ok;
  }

  const titleFor = path =>
    path === '/bag'
      ? 'Your bag - Harbor & Hearth'
      : path === '/checkout/shipping'
        ? 'Shipping - Checkout - Harbor & Hearth'
        : path === '/checkout/payment'
          ? 'Payment - Checkout - Harbor & Hearth'
          : path === '/checkout/review'
            ? 'Review - Checkout - Harbor & Hearth'
            : 'Order confirmed - Harbor & Hearth';

  async function paint() {
    let path = location.pathname.replace(/\/+$/, '') || '/bag';
    if (path === '/checkout/payment' && !st.shippingOk) {
      history.replaceState(null, '', '/checkout/shipping');
      path = '/checkout/shipping';
    } else if (path === '/checkout/review' && !(st.shippingOk && st.paymentOk)) {
      const back = st.shippingOk ? '/checkout/payment' : '/checkout/shipping';
      history.replaceState(null, '', back);
      path = back;
    }
    document.title = titleFor(path);
    view.innerHTML = '<p role="status" class="loading">Loading</p>';
    const done = path.startsWith('/checkout/complete/');
    if (done) {
      const id = decodeURIComponent(path.slice('/checkout/complete/'.length));
      let receipt = st.receipt && st.receipt.id === id ? st.receipt : null;
      if (!receipt) {
        const r = await api('GET', '/api/receipts/' + encodeURIComponent(id));
        receipt = r.ok ? r.data.receipt : null;
      }
      view.innerHTML = completeView(receipt);
      return;
    }
    const ok = await loadCart();
    if (!ok) {
      view.innerHTML =
        '<h1>Something went wrong</h1><p role="alert">We could not load your bag. Please refresh the page.</p>';
      return;
    }
    if (path === '/bag') {
      view.innerHTML = bagView();
      return;
    }
    if (st.cart.items.length === 0) {
      view.innerHTML = `<h1>Your bag is empty</h1><p>Add something to your bag to check out.</p><a class="btn ghost" href="/p/new-in">Browse new arrivals</a>`;
      return;
    }
    await loadQuote();
    view.innerHTML =
      path === '/checkout/shipping'
        ? shippingView()
        : path === '/checkout/payment'
          ? paymentView()
          : reviewView();
  }

  async function go(path) {
    st.errors = {};
    st.alert = '';
    st.flash = '';
    history.pushState(null, '', path);
    window.scrollTo(0, 0);
    await paint();
  }

  const nameParts = full => {
    const parts = full.trim().split(/\s+/).filter(Boolean);
    return { firstName: parts[0] || '', lastName: parts.slice(1).join(' ') };
  };

  function requestBody(step) {
    const pay = draft.payment;
    return {
      step,
      contact: { email: draft.contact.email, phone: draft.contact.phone },
      shipping: Object.assign(nameParts(draft.shipping.fullName), {
        address1: draft.shipping.address1,
        address2: draft.shipping.address2,
        city: draft.shipping.city,
        region: draft.shipping.region,
        postalCode: draft.shipping.postalCode,
        method: draft.shipping.method,
      }),
      payment: {
        cardName: pay.cardName,
        cardNumber: pay.cardNumber,
        expiry: pay.expMonth && pay.expYear ? pay.expMonth + '/' + pay.expYear.slice(-2) : '',
        cvc: pay.cvc,
      },
      marketingOptIn: draft.marketing,
      note: '',
    };
  }

  function mapErrors(errors) {
    const out = {};
    for (const [key, text] of Object.entries(errors || {})) {
      if (key === 'shipping.firstName' || key === 'shipping.lastName') {
        out['shipping.fullName'] = text;
      } else if (key === 'payment.expiry') {
        out['payment.expiry'] = text;
      } else {
        out[key] = text;
      }
    }
    return out;
  }

  async function stepSubmit(step, next) {
    st.errors = {};
    st.alert = '';
    const r = await api('POST', '/api/checkout/validate', requestBody(step));
    if (r.ok) {
      if (step === 'shipping') st.shippingOk = true;
      if (step === 'payment') st.paymentOk = true;
      await go(next);
      return;
    }
    if (r.status === 422 && r.data && r.data.errors) {
      st.errors = mapErrors(r.data.errors);
    } else {
      st.alert = 'We could not check those details. Please try again.';
    }
    await paint();
    const bad = view.querySelector('[aria-invalid="true"]');
    if (bad) bad.focus();
  }

  async function placeOrder() {
    if (st.busy) return;
    st.busy = true;
    st.alert = '';
    const button = view.querySelector('button[type=submit]');
    if (button) button.disabled = true;
    const r = await api('POST', '/api/orders', requestBody('order'));
    st.busy = false;
    if (r.status === 201 && r.data && r.data.receipt) {
      st.receipt = r.data.receipt;
      draft.payment.cardNumber = '';
      draft.payment.cvc = '';
      st.shippingOk = false;
      st.paymentOk = false;
      setCount(0);
      await go('/checkout/complete/' + encodeURIComponent(r.data.id));
      return;
    }
    if (r.status === 402 || r.status === 409) {
      st.alert = r.data && r.data.message ? r.data.message : 'Payment failed.';
    } else if (r.status === 422 && r.data && r.data.errors) {
      st.alert =
        'Some details need another look. Go back and check your shipping and card details.';
    } else {
      st.alert = "We couldn't place your order right now. Nothing was charged. Please try again.";
    }
    await paint();
  }

  let bagQueue = Promise.resolve();
  const enqueue = job => {
    bagQueue = bagQueue.then(job, job);
    return bagQueue;
  };

  async function bagWrite(method, path, payload, okText) {
    st.alert = '';
    st.flash = '';
    const r = await api(method, path, payload);
    if (r.ok && r.data && r.data.cart) {
      st.cart = r.data.cart;
      st.flash = okText;
      setCount(r.data.cart.totals.itemCount);
    } else if (r.status === 422 && r.data && r.data.errors) {
      st.alert = String(Object.values(r.data.errors)[0]);
      await loadCart();
    } else {
      st.alert = "We couldn't update your bag. Please try again.";
      await loadCart();
    }
    if (location.pathname.replace(/\/+$/, '') === '/bag') view.innerHTML = bagView();
  }

  document.addEventListener('input', event => {
    const el = event.target;
    if (!el.name) return;
    if (el.name === 'marketing') draft.marketing = el.checked;
    else if (el.type !== 'checkbox' && el.name.indexOf('.') > 0) setPath(el.name, el.value);
  });

  document.addEventListener('change', async event => {
    const el = event.target;
    if (!el.name) return;
    if (el.name === 'marketing') draft.marketing = el.checked;
    else if (el.type !== 'checkbox' && el.name.indexOf('.') > 0) setPath(el.name, el.value);
    if (el.name === 'shipping.method') {
      if (await loadQuote()) {
        const side = view.querySelector('aside');
        if (side) side.outerHTML = summaryPanel(st.quote);
      }
    } else if (el.name.startsWith('qty-') && st.cart) {
      const sku = el.name.slice(4);
      const quantity = Number(el.value);
      await enqueue(() =>
        bagWrite('PUT', '/api/cart/items/' + encodeURIComponent(sku), { quantity }, 'Bag updated.')
      );
    }
  });

  document.addEventListener('submit', async event => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    if (form.id === 'promo-form') {
      event.preventDefault();
      const code = form.elements.code.value;
      await enqueue(() => bagWrite('POST', '/api/cart/promo', { code }, 'Promo code added.'));
    } else if (form.id === 'step-form') {
      event.preventDefault();
      const path = location.pathname.replace(/\/+$/, '');
      if (path === '/checkout/shipping') await stepSubmit('shipping', '/checkout/payment');
      else if (path === '/checkout/payment') await stepSubmit('payment', '/checkout/review');
      else if (path === '/checkout/review') await placeOrder();
    }
  });

  document.addEventListener('click', async event => {
    const button = event.target.closest('button');
    if (button && st.cart) {
      const name = button.name;
      const sku = button.value;
      if (name === 'inc' || name === 'dec' || name === 'remove') {
        await enqueue(async () => {
          const item = st.cart.items.find(i => i.sku === sku);
          if (!item) return;
          const path = '/api/cart/items/' + encodeURIComponent(sku);
          if (name === 'remove') await bagWrite('DELETE', path, undefined, 'Item removed.');
          else {
            const quantity =
              name === 'inc' ? Math.min(99, item.quantity + 1) : Math.max(1, item.quantity - 1);
            await bagWrite('PUT', path, { quantity }, 'Bag updated.');
          }
        });
      } else if (name === 'empty') {
        await enqueue(() => bagWrite('POST', '/api/cart/clear', {}, 'Your bag is empty.'));
      } else if (name === 'unpromo') {
        await enqueue(() =>
          bagWrite('DELETE', '/api/cart/promo', undefined, 'Promo code removed.')
        );
      }
      return;
    }
    const link = event.target.closest('a[href]');
    if (!link || event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey) return;
    const target = new URL(link.href, location.href);
    const spa =
      target.origin === location.origin &&
      (target.pathname === '/bag' || STEP_PATHS.includes(target.pathname));
    if (spa) {
      event.preventDefault();
      await go(target.pathname);
    }
  });

  window.addEventListener('popstate', () => {
    paint();
  });
  paint();
}

function clientC(cfg) {
  const $ = selector => document.querySelector(selector);
  let view = cfg.view;
  const hasBasket = () => document.getElementById('basket');
  startRerender(cfg.rerenderEveryMs, () => [document.getElementById('main'), $('#confirm')]);
  bindNewsletter();

  function paint(next) {
    view = next;
    const box = hasBasket();
    if (box) box.innerHTML = basketBodyC(next);
    syncCount(next);
  }

  const problem = text => {
    const el = $('#problem');
    if (el) el.textContent = text;
  };

  async function write(method, path, payload) {
    problem('');
    const r = await api(method, path, payload);
    if (r.ok && r.data && r.data.cart) {
      paint(r.data.cart);
      return;
    }
    const errors = r.data && r.data.errors ? Object.values(r.data.errors) : [];
    problem(
      errors.length > 0 ? String(errors[0]) : "We couldn't update your basket. Please try again."
    );
    const fresh = await api('GET', '/api/cart');
    if (fresh.ok) paint(fresh.data);
  }

  async function placeOrder() {
    const err = $('#confirm-error');
    if (err) err.textContent = '';
    const yes = $('#confirm button[name=confirm]');
    if (yes) yes.disabled = true;
    const r = await api('POST', '/api/orders', { source: 'buy-now' });
    const dialog = $('#confirm');
    if (r.status === 201 && r.data && r.data.receipt) {
      dialog.close();
      dialog.remove();
      history.pushState(null, '', '/thanks/' + encodeURIComponent(r.data.id));
      document.title = 'Order placed - Marlow Market';
      document.getElementById('main').innerHTML = receiptC(r.data.receipt);
      const count = document.getElementById('cart-count');
      if (count) count.textContent = '0';
      window.scrollTo(0, 0);
      return;
    }
    const box = $('#confirm-error');
    if (box) {
      box.textContent =
        (r.status === 402 || r.status === 409) && r.data && r.data.message
          ? r.data.message
          : "We couldn't place your order. Nothing was charged. Please try again.";
    }
    const again = $('#confirm button[name=confirm]');
    if (again) again.disabled = false;
  }

  document.addEventListener('click', async event => {
    const button = event.target.closest('button');
    if (!button) return;
    const sku = button.value;
    if (button.name === 'save') await write('POST', '/api/cart/saved', { sku });
    else if (button.name === 'remove')
      await write('DELETE', '/api/cart/items/' + encodeURIComponent(sku));
    else if (button.name === 'restore') await write('POST', '/api/cart/restore', { sku });
    else if (button.name === 'drop')
      await write('DELETE', '/api/cart/saved/' + encodeURIComponent(sku));
    else if (button.name === 'add') await write('POST', '/api/cart/items', { sku, quantity: 1 });
    else if (button.name === 'unpromo') await write('DELETE', '/api/cart/promo');
    else if (button.name === 'buy') {
      const text = $('#confirm-text');
      if (text) text.textContent = confirmTextC(view);
      const err = $('#confirm-error');
      if (err) err.textContent = '';
      $('#confirm').showModal();
    } else if (button.name === 'cancel') $('#confirm').close();
    else if (button.name === 'confirm') await placeOrder();
  });

  document.addEventListener('change', async event => {
    const select = event.target;
    if (!(select instanceof HTMLSelectElement) || !select.name.startsWith('qty-')) return;
    await write('PUT', '/api/cart/items/' + encodeURIComponent(select.name.slice(4)), {
      quantity: Number(select.value),
    });
  });

  document.addEventListener('submit', async event => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || form.id !== 'promo-form') return;
    event.preventDefault();
    await write('POST', '/api/cart/promo', { code: form.elements.code.value });
  });

  window.addEventListener('popstate', () => {
    window.location.reload();
  });
}

// ---------------------------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------------------------

const CSS_BASE = `
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;min-height:100vh;display:flex;flex-direction:column}
main{flex:1;width:100%}
a{color:inherit}
button,input,select,textarea{font:inherit;color:inherit}
button{cursor:pointer}
button:disabled{opacity:.6;cursor:default}
.sr{position:absolute!important;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.thumb{display:inline-flex;align-items:center;justify-content:center;width:64px;height:64px;border-radius:8px;color:#fff;font:700 22px system-ui,sans-serif;flex:none}
.muted{color:#6b7280;font-size:.875rem}
ul{padding:0;list-style:none}
dl{margin:0}
.row{display:flex;justify-content:space-between;gap:12px}
.row dt,.row dd{margin:0}
.test-banner{background:#fff4c2;border:2px solid #d9a400;color:#5c4400;font:700 15px/1.3 system-ui,sans-serif;padding:10px 14px;border-radius:6px;margin:12px 0}
`;

const CSS_A = `
body.a{background:#faf6ee;color:#2b2a26;font:16px/1.55 Georgia,'Times New Roman',serif}
.a input,.a select,.a textarea,.a button{font-family:system-ui,sans-serif;font-size:15px}
.a .promo-strip{background:#2f4f3a;color:#f4efe2;text-align:center;font:600 13px/1 system-ui,sans-serif;padding:10px}
.a header.site{background:#fffdf8;border-bottom:1px solid #e3dbc8}
.a .bar{max-width:1120px;margin:0 auto;padding:14px 24px;display:flex;align-items:center;gap:28px}
.a .logo{font-size:24px;font-weight:700;text-decoration:none;color:#2f4f3a;letter-spacing:.02em}
.a nav{display:flex;gap:20px;flex:1}
.a nav a{text-decoration:none;font:14px system-ui,sans-serif}
.a form[role=search]{display:flex;gap:6px}
.a form[role=search] input{padding:7px 10px;border:1px solid #cfc6b0;border-radius:4px;width:180px}
.a form[role=search] button{padding:7px 12px;border:1px solid #2f4f3a;background:#fff;border-radius:4px}
.a .cart-link{font:600 14px system-ui,sans-serif;text-decoration:none}
.a main{max-width:1120px;margin:0 auto;padding:28px 24px 56px}
.a h1{font-size:32px;margin:0 0 12px}
.a h2{font-size:20px;margin:0 0 12px}
.a .layout{display:grid;grid-template-columns:1fr 340px;gap:32px;align-items:start}
.a table{width:100%;border-collapse:collapse;background:#fffdf8;border:1px solid #e3dbc8}
.a th{font:600 12px system-ui,sans-serif;text-transform:uppercase;letter-spacing:.06em;text-align:left;padding:10px 12px;border-bottom:1px solid #e3dbc8}
.a td{padding:12px;border-bottom:1px solid #eee6d3;vertical-align:middle}
.a .num{text-align:right}
.a .prod{display:flex;gap:14px;align-items:center}
.a .prod a{font-weight:700;text-decoration:none}
.a td input[type=number]{width:70px;padding:6px;text-align:right;border:1px solid #cfc6b0;border-radius:4px}
.a .actions{display:flex;gap:12px;align-items:center;margin:14px 0}
.a .actions a{margin-left:auto;font:14px system-ui,sans-serif}
.a .btn{display:inline-block;padding:10px 18px;border-radius:4px;border:1px solid #2f4f3a;font:600 15px system-ui,sans-serif;text-decoration:none;background:#fff;text-align:center}
.a .btn.primary{background:#2f4f3a;color:#fff}
.a .btn.danger{border-color:#a63a2b;color:#a63a2b}
.a .btn.wide{display:block;width:100%;padding:13px}
.a .link{background:none;border:0;padding:0;text-decoration:underline;font:14px system-ui,sans-serif;color:#2f4f3a}
.a .summary,.a .panel{background:#fffdf8;border:1px solid #e3dbc8;padding:20px;border-radius:6px}
.a .summary .row{padding:4px 0}
.a .promo{display:flex;gap:10px;align-items:center;margin-top:18px;font:14px system-ui,sans-serif}
.a .promo input{padding:7px 10px;border:1px solid #cfc6b0;border-radius:4px}
.a #notice{color:#1f5d36;font:600 14px system-ui,sans-serif;min-height:0;margin:6px 0}
.a #problem,.a #form-alert{color:#a63a2b;font:600 14px system-ui,sans-serif;margin:6px 0}
.a #form-alert:not(:empty){background:#fdecea;border:1px solid #e9b7b0;padding:10px 12px;border-radius:4px}
.a .empty{background:#fffdf8;border:1px solid #e3dbc8;padding:32px;text-align:center}
.a fieldset{border:1px solid #e3dbc8;background:#fffdf8;border-radius:6px;margin:0 0 18px;padding:14px 18px 18px}
.a legend{font:700 17px Georgia,serif;padding:0 8px}
.a .field{display:flex;flex-direction:column;gap:4px;margin:10px 0}
.a .field label,.a .group>legend{font:600 14px system-ui,sans-serif}
.a .field input,.a .field select,.a .field textarea{padding:9px 10px;border:1px solid #cfc6b0;border-radius:4px;background:#fff}
.a .two{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.a .err{color:#a63a2b;font:13px system-ui,sans-serif;margin:2px 0 0}
.a .opt{display:flex;gap:10px;align-items:center;padding:10px 12px;border:1px solid #e3dbc8;border-radius:4px;margin:8px 0;font:15px system-ui,sans-serif;background:#fff}
.a .opt .price{margin-left:auto;font-weight:700}
.a .check{display:flex;gap:8px;align-items:center;font:14px system-ui,sans-serif;margin:8px 0}
.a .wallet{display:flex;gap:12px;align-items:center;margin:0 0 20px;padding:14px;border:1px dashed #cfc6b0;border-radius:6px;font:14px system-ui,sans-serif}
.a .lines li{display:flex;justify-content:space-between;gap:10px;padding:6px 0;border-bottom:1px solid #eee6d3;font-size:15px}
.a .total{font-weight:700;font-size:18px;border-top:1px solid #e3dbc8;margin-top:6px;padding-top:8px}
.a .submit-row{display:flex;gap:16px;align-items:center;margin-top:8px}
.a .receipt-box{background:#fffdf8;border:1px solid #e3dbc8;padding:28px;border-radius:6px;max-width:720px}
.a .notice{background:#e9f3ec;border:1px solid #b9d6c1;padding:8px 12px;border-radius:4px;font:14px system-ui,sans-serif}
.a footer.site-footer{background:#2b2a26;color:#e9e3d2;padding:32px 24px;margin-top:auto;font:14px system-ui,sans-serif}
.a .cols{max-width:1120px;margin:0 auto 18px;display:grid;grid-template-columns:1fr 1fr 1.4fr;gap:32px}
.a footer h2{font-size:14px;text-transform:uppercase;letter-spacing:.08em;margin:0 0 10px}
.a footer ul{margin:0}
.a footer li{margin:4px 0}
.a footer .newsletter{display:flex;flex-direction:column;gap:6px}
.a footer .newsletter input{padding:8px;border-radius:4px;border:0}
.a footer .newsletter button{padding:8px;border-radius:4px;border:1px solid #e9e3d2;background:transparent;color:#fff}
.a footer .fine{max-width:1120px;margin:0 auto;opacity:.7}
`;

const CSS_B = `
body.b{background:#f1f4f8;color:#1a2433;font:16px/1.5 system-ui,-apple-system,'Segoe UI',sans-serif}
.b header.top{background:#12263f;color:#fff}
.b .bar{max-width:1180px;margin:0 auto;padding:16px 28px;display:flex;align-items:center;gap:32px}
.b .logo{font-weight:800;font-size:22px;text-decoration:none;letter-spacing:-.01em}
.b nav{display:flex;gap:22px;flex:1}
.b nav a{text-decoration:none;opacity:.9;font-size:15px}
.b form[role=search] input{padding:8px 14px;border-radius:999px;border:0;width:190px}
.b .bag-link{text-decoration:none;font-weight:700;background:#1f8a70;padding:8px 16px;border-radius:999px}
.b .ribbon{background:#d8e6f5;text-align:center;font-size:13px;padding:8px}
.b main{max-width:1180px;margin:0 auto;padding:28px 28px 64px}
.b h1{font-size:28px;margin:8px 0 18px;letter-spacing:-.02em}
.b .cols{display:grid;grid-template-columns:1fr 340px;gap:28px;align-items:start}
.b .card{background:#fff;border-radius:14px;padding:20px;box-shadow:0 1px 2px rgba(18,38,63,.08);border:0;margin:0 0 18px}
.b fieldset.card legend{font-weight:700;padding:0 6px}
.b .bag{margin:0}
.b .line{display:grid;grid-template-columns:64px 1fr auto 90px;gap:16px;align-items:center;background:#fff;border-radius:14px;padding:16px;margin-bottom:12px;box-shadow:0 1px 2px rgba(18,38,63,.08)}
.b .line a{font-weight:700;text-decoration:none}
.b .price{text-align:right;font-weight:700;margin:0}
.b .stepper{display:flex;align-items:center;border:1px solid #c7d1de;border-radius:999px;overflow:hidden}
.b .stepper button{width:34px;height:34px;border:0;background:#eef2f7;font-size:18px}
.b .stepper input{width:44px;text-align:center;border:0;padding:6px 0}
.b .textbtn{background:none;border:0;padding:0;color:#2563a6;text-decoration:underline;font-size:14px}
.b .textbtn.center{display:block;margin:14px auto 0}
.b .btn{display:inline-block;border:0;border-radius:999px;padding:11px 22px;font-weight:700;text-decoration:none;background:#e3e9f1;color:#12263f;text-align:center}
.b .btn.primary{background:#1f8a70;color:#fff}
.b .btn.wide{display:block;width:100%}
.b .promo{background:#fff;border-radius:14px;padding:16px 20px;box-shadow:0 1px 2px rgba(18,38,63,.08)}
.b .promo label{display:block;font-weight:600;margin-bottom:8px}
.b .inline{display:flex;gap:10px;align-items:center}
.b .inline input{flex:1;padding:9px 12px;border:1px solid #c7d1de;border-radius:10px}
.b .side h2{font-size:18px;margin:0 0 10px}
.b .side .row{padding:3px 0}
.b .total{font-weight:800;border-top:1px solid #dde4ee;margin-top:6px;padding-top:8px}
.b .toast{background:#dff3ec;color:#14634f;border-radius:10px;padding:10px 14px;font-weight:600}
.b .alertbox{background:#fde8e6;color:#9b2c20;border-radius:10px;padding:10px 14px;font-weight:600;margin:10px 0}
.b .alertbox:empty{display:none}
.b .steps{display:flex;gap:10px;list-style:none;padding:0;margin:0 0 12px}
.b .steps li{display:flex;gap:8px;align-items:center;color:#6b7a90;font-weight:600}
.b .steps li+li::before{content:'';width:28px;height:2px;background:#c7d1de;margin-right:8px}
.b .steps .n{display:inline-flex;width:24px;height:24px;border-radius:50%;background:#c7d1de;color:#fff;align-items:center;justify-content:center;font-size:13px}
.b .steps [aria-current=step]{color:#12263f}
.b .steps [aria-current=step] .n{background:#12263f}
.b .steps .done .n{background:#1f8a70}
.b .fld{display:flex;flex-direction:column;gap:4px;margin:12px 0}
.b .fld label{font-weight:600;font-size:14px}
.b .fld input,.b .fld select{padding:10px 12px;border:1px solid #c7d1de;border-radius:10px;background:#fff}
.b .expiry{border:0;padding:0;margin:12px 0;display:grid;grid-template-columns:1fr 1fr;gap:12px}
.b .expiry legend{font-weight:600;font-size:14px;padding:0 0 4px}
.b .err{color:#9b2c20;font-size:13px;margin:2px 0 0}
.b .nav{display:flex;justify-content:space-between;align-items:center;margin-top:8px}
.b .check{display:flex;gap:8px;align-items:center;margin:10px 0;font-size:14px}
.b .lines li{display:flex;justify-content:space-between;gap:10px;padding:5px 0;font-size:14px}
.b .notice{background:#eef4fb;border-radius:10px;padding:8px 12px;font-size:14px}
.b .loading{color:#6b7a90}
.b footer.foot{background:#12263f;color:#cdd8e6;padding:28px;margin-top:auto;font-size:14px}
.b .foot-in{max-width:1180px;margin:0 auto;display:flex;gap:48px;justify-content:space-between;flex-wrap:wrap}
.b .foot a{display:block;margin:4px 0;text-decoration:none}
.b .foot h2{font-size:13px;text-transform:uppercase;letter-spacing:.08em;margin:0 0 8px;color:#fff}
.b .newsletter{display:flex;flex-direction:column;gap:6px;min-width:240px}
.b .newsletter input{padding:8px 10px;border-radius:8px;border:0}
.b .newsletter button{padding:8px 10px;border-radius:8px;border:0;background:#1f8a70;color:#fff;font-weight:700}
`;

const CSS_C = `
body.c{background:#fff7f1;color:#231815;font:17px/1.55 'Trebuchet MS',system-ui,sans-serif}
.c .strip{background:#231815;color:#ffe9d9;text-align:center;font-size:13px;padding:9px}
.c header.mast{background:#fff;border-bottom:3px solid #ff6a4d}
.c .bar{max-width:880px;margin:0 auto;padding:16px 24px;display:flex;align-items:center;gap:22px}
.c .logo{font-size:26px;font-weight:800;text-decoration:none;color:#ff6a4d}
.c nav{display:flex;gap:18px;flex:1;flex-wrap:wrap}
.c nav a{text-decoration:none;font-size:15px}
.c .basket-link{font-weight:800;text-decoration:none;border:2px solid #231815;padding:6px 14px;border-radius:10px}
.c main{max-width:880px;margin:0 auto;padding:26px 24px 64px}
.c h1{font-size:34px;margin:0 0 6px}
.c h1 .count{font-size:16px;font-weight:400;color:#6a5a52;margin-left:8px}
.c h2{font-size:23px;margin:34px 0 12px}
.c h3{font-size:17px;margin:0}
.c h3 a{text-decoration:none}
.c .cards{margin:0;display:flex;flex-direction:column;gap:14px}
.c .card{display:flex;gap:18px;align-items:flex-start;background:#fff;border:2px solid #f0dccd;border-radius:14px;padding:18px 20px}
.c .card.compact{align-items:center}
.c .card .grow{flex:1}
.c .card p{margin:4px 0}
.c .line-total{font-weight:800;font-size:19px}
.c .row{align-items:center;flex-wrap:wrap;justify-content:flex-start;gap:12px;margin-top:8px}
.c select{padding:8px 10px;border:2px solid #d9bfae;border-radius:8px;background:#fff}
.c .chip{border:2px solid #231815;background:#fff;border-radius:999px;padding:7px 15px;font-weight:700;font-size:14px}
.c .chip.warn{border-color:#b3261e;color:#b3261e}
.c .grid4{margin:0;display:grid;grid-template-columns:1fr 1fr;gap:16px}
.c .rec{background:#fff;border:2px solid #f0dccd;border-radius:14px;padding:18px;display:flex;flex-direction:column;gap:8px;align-items:flex-start;min-height:210px}
.c .rec .thumb{width:90px;height:90px;font-size:32px}
.c .rec p{margin:0}
.c .panel{background:#fff;border:2px solid #f0dccd;border-radius:14px;padding:20px 22px;margin-top:22px}
.c .panel h2{margin:0 0 10px;font-size:21px}
.c .facts{display:grid;grid-template-columns:130px 1fr;gap:6px 12px;margin-bottom:10px}
.c .facts dd{margin:0}
.c .facts dt{color:#6a5a52}
.c .promo{display:flex;gap:10px;align-items:center;margin-top:22px;flex-wrap:wrap}
.c .promo input{padding:9px 12px;border:2px solid #d9bfae;border-radius:8px}
.c .summary .row,.c .receipt .row{justify-content:space-between;margin:4px 0}
.c .total{font-weight:800;font-size:22px;border-top:2px solid #f0dccd;padding-top:8px;margin-top:8px}
.c .buy{display:block;width:100%;margin:18px 0 10px;padding:18px;border:0;border-radius:14px;background:#ff6a4d;color:#fff;font-size:21px;font-weight:800}
.c .again{display:block;text-align:center}
.c .lead{font-size:20px}
.c .btn{display:inline-block;padding:10px 20px;border-radius:999px;border:2px solid #231815;text-decoration:none;font-weight:700}
#problem{color:#b3261e;font-weight:700}
.c .notice{background:#e9f6ee;border-radius:10px;padding:8px 14px}
.c .lines li{display:flex;justify-content:space-between;gap:10px;padding:6px 0;border-bottom:1px solid #f0dccd}
.c dialog{border:0;border-radius:18px;padding:28px 30px;max-width:520px;width:calc(100% - 40px);box-shadow:0 20px 60px rgba(35,24,21,.35)}
.c dialog::backdrop{background:rgba(35,24,21,.55)}
.c dialog h2{margin:0 0 8px}
.c dialog .btns{display:flex;gap:12px;justify-content:flex-end;margin-top:18px}
.c dialog .btns button{padding:12px 20px;border-radius:12px;border:2px solid #231815;background:#fff;font-weight:800}
.c dialog .btns button[name=confirm]{background:#ff6a4d;border-color:#ff6a4d;color:#fff}
.c #confirm-error{color:#b3261e;font-weight:700;margin-top:10px}
.c footer.foot{background:#231815;color:#ffe9d9;padding:30px 24px;margin-top:auto;font-size:14px}
.c .foot-in{max-width:880px;margin:0 auto;display:grid;grid-template-columns:1fr 1fr 1.3fr;gap:28px}
.c .foot a{display:block;margin:4px 0;text-decoration:none}
.c .foot h2{font-size:15px;margin:0 0 8px}
.c .newsletter{display:flex;flex-direction:column;gap:6px}
.c .newsletter input{padding:8px;border-radius:8px;border:0}
.c .newsletter button{padding:8px;border-radius:8px;border:2px solid #ff6a4d;background:transparent;color:#fff;font-weight:700}
.c .newsletter label{font-size:14px}
`;

// ---------------------------------------------------------------------------------------------
// Page chrome per variant
// ---------------------------------------------------------------------------------------------

function docHtml({ title, css, bodyClass, body, script }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${CSS_BASE}${css}</style>
</head>
<body class="${bodyClass}">
${body}
${script}
</body>
</html>`;
}

function scriptTag(client, cfg) {
  const json = JSON.stringify(cfg).replace(/</g, '\\u003c');
  return `<script>${ISO_SRC}\n(${client.toString()})(${json});</script>`;
}

const CART_PATH = { A: '/cart', B: '/bag', C: '/basket' };

function chromeA(ctx, title, main, script) {
  const n = ctx.cartCount;
  const body = `<div class="promo-strip">Free standard shipping on orders over $80 &middot; 30-day returns</div>
<header class="site"><div class="bar">
<a class="logo" href="/">Pinewood Supply</a>
<nav aria-label="Primary"><a href="/p/shop">Shop</a><a href="/p/gifts">Gifts</a><a href="/p/journal">Journal</a><a href="/p/help">Help</a></nav>
<form role="search" action="/search" method="get"><label class="sr" for="site-q">Search the shop</label><input id="site-q" name="q" type="search" placeholder="Search"><button type="submit">Search</button></form>
<a class="cart-link" href="/cart">Cart (<span id="cart-count">${n}</span>)</a>
</div></header>
${main}
<footer class="site-footer"><div class="cols">
<div><h2>Customer care</h2><ul><li><a href="/p/shipping-returns">Shipping &amp; returns</a></li><li><a href="/p/order-status">Order status</a></li><li><a href="/p/contact-us">Contact us</a></li></ul></div>
<div><h2>Company</h2><ul><li><a href="/p/our-story">Our story</a></li><li><a href="/p/careers">Careers</a></li><li><a href="/p/stockists">Stockists</a></li></ul></div>
<form class="newsletter" novalidate><h2>Monthly letter</h2><label for="nl-email">Your email</label><input id="nl-email" name="email" type="email" autocomplete="off"><button type="submit">Subscribe</button><p class="nl-msg" role="status"></p></form>
</div><p class="fine">&copy; Pinewood Supply Co. All rights reserved.</p></footer>`;
  return docHtml({ title, css: CSS_A, bodyClass: 'a', body, script });
}

function chromeB(ctx, title, main, script) {
  const body = `<header class="top"><div class="bar">
<a class="logo" href="/">Harbor &amp; Hearth</a>
<nav aria-label="Main"><a href="/p/new-in">New in</a><a href="/p/kitchen">Kitchen</a><a href="/p/outdoors">Outdoors</a><a href="/p/stories">Stories</a></nav>
<form role="search" action="/search" method="get"><input name="q" type="search" aria-label="Find products" placeholder="Find products"></form>
<a class="bag-link" href="/bag">Bag <span id="cart-count">${ctx.cartCount}</span></a>
</div></header>
<div class="ribbon">Enamel mugs are back in stock in three colours</div>
${main}
<footer class="foot"><div class="foot-in">
<div><h2>Help</h2><a href="/p/delivery">Delivery</a><a href="/p/returns-policy">Returns policy</a><a href="/p/faq">FAQ</a></div>
<div><h2>About</h2><a href="/p/about-us">About us</a><a href="/p/sustainability">Sustainability</a><a href="/p/newsroom">Newsroom</a></div>
<form class="newsletter" novalidate><h2>Stories by email</h2><label for="nl-mail">Email for updates</label><input id="nl-mail" name="email" type="email" autocomplete="off"><button type="submit">Sign me up</button><p class="nl-msg" role="status"></p></form>
</div></footer>`;
  return docHtml({ title, css: CSS_B, bodyClass: 'b', body, script });
}

function chromeC(ctx, title, main, script, extra = '') {
  const body = `<div class="strip">Free standard delivery over $80 this week</div>
<header class="mast"><div class="bar">
<a class="logo" href="/">Marlow Market</a>
<nav aria-label="Sections"><a href="/p/deals">Deals</a><a href="/p/new-arrivals">New arrivals</a><a href="/p/home-living">Home</a><a href="/p/outdoors">Outdoors</a></nav>
<a class="basket-link" href="/basket">Basket <span id="cart-count">${ctx.cartCount}</span></a>
</div></header>
${main}
<footer class="foot"><div class="foot-in">
<div><h2>Need a hand?</h2><a href="/p/delivery-info">Delivery info</a><a href="/p/returns">Returns</a><a href="/p/contact">Contact</a></div>
<div><h2>Marlow</h2><a href="/p/our-makers">Our makers</a><a href="/p/gift-cards">Gift cards</a><a href="/p/jobs">Jobs</a></div>
<form class="newsletter" novalidate><h2>Market Mail</h2><label for="nl-addr">Email</label><input id="nl-addr" name="email" type="email" autocomplete="off"><button type="submit">Join</button><p class="nl-msg" role="status"></p></form>
</div></footer>
${extra}`;
  return docHtml({ title, css: CSS_C, bodyClass: 'c', body, script });
}

function chrome(variant, ctx, title, main, script, extra) {
  if (variant === 'A') return chromeA(ctx, title, main, script);
  if (variant === 'B') return chromeB(ctx, title, main, script);
  return chromeC(ctx, title, main, script, extra);
}

// ---------------------------------------------------------------------------------------------
// Server-rendered pages
// ---------------------------------------------------------------------------------------------

function optionsHtml(current, placeholder) {
  return [`<option value="">${esc(placeholder)}</option>`]
    .concat(
      STATES.map(
        ([code, name]) =>
          `<option value="${code}"${code === current ? ' selected' : ''}>${esc(name)}</option>`
      )
    )
    .join('');
}

function cartPageA(ctx, view, cfg) {
  const main = `<main id="page"><h1>Shopping cart</h1>
<div id="notice" role="status"></div><div id="problem" role="alert"></div>
<div id="cart-region">${cartRegionA(view)}</div></main>`;
  return chrome('A', ctx, 'Shopping cart - Pinewood Supply', main, scriptTag(clientA, cfg));
}

function checkoutPageA(ctx, view, cfg, prefill) {
  if (view.items.length === 0) {
    const main = `<main id="page"><h1>Checkout</h1><div class="empty"><h2>Your cart is empty</h2><p>There is nothing to check out yet.</p><a class="btn ghost" href="/cart">Return to cart</a></div></main>`;
    return chrome('A', ctx, 'Checkout - Pinewood Supply', main, scriptTag(clientA, cfg));
  }
  const p = prefill ? PROFILE : null;
  const v = value => esc(value || '');
  const input = (id, label, name, value, extra = '') =>
    `<div class="field"><label for="${id}">${esc(label)}</label><input id="${id}" name="${name}" value="${v(value)}" ${extra}></div>`;
  const opts = view.shippingOptions;
  const main = `<main id="page">
<h1>Checkout</h1>
<div class="test-banner" role="note">${TEST_MODE_TEXT}</div>
<div class="wallet"><button type="button" class="btn ghost" name="wallet">Pay with wallet</button><span id="wallet-note" role="status"></span></div>
<div class="layout">
<form id="checkout-form" novalidate aria-label="Checkout details">
<fieldset><legend>Contact information</legend>
${input('c-email', 'Email address', 'contact.email', p && p.contact.email, 'type="email" autocomplete="email"')}
${input('c-phone', 'Phone number (optional)', 'contact.phone', p && p.contact.phone, 'type="tel" autocomplete="tel"')}
</fieldset>
<fieldset><legend>Shipping address</legend>
<div class="two">${input('s-first', 'First name', 'shipping.firstName', p && p.shipping.firstName, 'autocomplete="given-name"')}${input('s-last', 'Last name', 'shipping.lastName', p && p.shipping.lastName, 'autocomplete="family-name"')}</div>
${input('s-addr', 'Street address', 'shipping.address1', p && p.shipping.address1, 'autocomplete="address-line1"')}
${input('s-addr2', 'Apartment, suite, etc. (optional)', 'shipping.address2', p && p.shipping.address2, 'autocomplete="address-line2"')}
${input('s-city', 'City', 'shipping.city', p && p.shipping.city, 'autocomplete="address-level2"')}
<div class="two"><div class="field"><label for="s-state">State</label><select id="s-state" name="shipping.region" autocomplete="address-level1">${optionsHtml(p ? p.shipping.region : '', 'Select a state')}</select></div>
${input('s-zip', 'ZIP code', 'shipping.postalCode', p && p.shipping.postalCode, 'inputmode="numeric" autocomplete="postal-code"')}</div>
<div class="field"><label for="s-country">Country/region</label><select id="s-country" name="shipping.country"><option value="US">United States</option></select></div>
</fieldset>
<fieldset class="group"><legend>Delivery method</legend>
<label class="opt"><input type="radio" name="shipping.method" value="standard" checked><span>Standard shipping<br><span class="muted">3 to 5 business days</span></span><span class="price">${shipFmt(opts.standard)}</span></label>
<label class="opt"><input type="radio" name="shipping.method" value="express"><span>Express shipping<br><span class="muted">1 to 2 business days</span></span><span class="price">${shipFmt(opts.express)}</span></label>
</fieldset>
<fieldset><legend>Payment</legend>
<div class="test-banner" role="note">${TEST_MODE_TEXT}</div>
${input('p-name', 'Name on card', 'payment.cardName', '', 'autocomplete="cc-name"')}
${input('p-number', 'Card number', 'payment.cardNumber', '', 'inputmode="numeric" autocomplete="cc-number" placeholder="1234 1234 1234 1234"')}
<div class="two">${input('p-exp', 'Expiry date (MM/YY)', 'payment.expiry', '', 'autocomplete="cc-exp" placeholder="MM / YY"')}${input('p-cvc', 'Security code', 'payment.cvc', '', 'inputmode="numeric" autocomplete="cc-csc"')}</div>
<label class="check"><input type="checkbox" name="billingSame" checked> Billing address is the same as shipping</label>
<label class="check"><input type="checkbox" name="marketingOptIn"> Email me news and offers</label>
<div class="field"><label for="o-note">Delivery notes (optional)</label><textarea id="o-note" name="note" rows="2"></textarea></div>
</fieldset>
<div id="form-alert" role="alert"></div>
<div class="submit-row"><button type="submit" class="btn primary">Place order</button><a href="/cart">Return to cart</a></div>
</form>
<aside id="checkout-summary" class="summary" aria-labelledby="sum-h">${summaryA(view.items, view.totals, view.promo)}</aside>
</div></main>`;
  return chrome('A', ctx, 'Checkout - Pinewood Supply', main, scriptTag(clientA, cfg));
}

function orderPageA(ctx, r, cfg) {
  const lines = r.items
    .map(
      i =>
        `<li><span>${esc(i.title)} <span class="muted">&times; ${i.quantity}</span></span><span>${money(i.lineTotal)}</span></li>`
    )
    .join('');
  const main = `<main id="page"><div class="receipt-box">
<h1>Thank you for your order</h1>
<p>Order <strong>${esc(r.id)}</strong> is confirmed. A receipt was sent to ${esc(r.contact.email)}.</p>
<p class="notice">This was a test order. No real payment was taken.</p>
<h2>Items</h2><ul class="lines">${lines}</ul>
<dl><div class="row"><dt>Subtotal</dt><dd>${money(r.totals.subtotal)}</dd></div>
<div class="row"><dt>Shipping</dt><dd>${shipFmt(r.totals.shipping)}</dd></div>
<div class="row"><dt>Tax</dt><dd>${money(r.totals.tax)}</dd></div>
<div class="row total"><dt>Total</dt><dd>${money(r.totals.total)}</dd></div></dl>
<h2>Shipping to</h2><p>${esc(r.shipping.name)}<br>${esc(r.shipping.address1)}${r.shipping.address2 ? '<br>' + esc(r.shipping.address2) : ''}<br>${esc(r.shipping.city)}, ${esc(r.shipping.region)} ${esc(r.shipping.postalCode)}</p>
<p>Paid with card ending in ${esc(r.cardLast4)}.</p>
<p class="actions"><button type="button" class="btn ghost">Print receipt</button><a href="/p/shop">Continue shopping</a></p>
</div></main>`;
  return chrome('A', ctx, 'Order confirmed - Pinewood Supply', main, scriptTag(clientA, cfg));
}

function shellB(ctx, cfg) {
  const main = `<main id="view" tabindex="-1"><p class="loading" role="status">Loading</p></main>`;
  return chrome('B', ctx, 'Harbor & Hearth', main, scriptTag(clientB, cfg));
}

function dialogC() {
  return `<dialog id="confirm" aria-labelledby="confirm-h" aria-describedby="confirm-text">
<h2 id="confirm-h">Place this order?</h2>
<p class="test-banner" role="note">${TEST_MODE_TEXT}</p>
<p id="confirm-text"></p>
<div id="confirm-error" role="alert"></div>
<div class="btns"><button type="button" name="cancel">No, go back</button><button type="button" name="confirm">Yes, place test order</button></div>
</dialog>`;
}

function basketPageC(ctx, view, cfg) {
  const main = `<main id="main"><div id="problem" role="alert"></div><div id="basket">${basketBodyC(view)}</div></main>`;
  const body = main.replace(
    '<div id="basket">',
    `<div class="test-banner" role="note">${TEST_MODE_TEXT}</div><div id="basket">`
  );
  return chrome(
    'C',
    ctx,
    'Your basket - Marlow Market',
    body,
    scriptTag(clientC, { ...cfg, view }),
    dialogC()
  );
}

function thanksPageC(ctx, receipt, cfg) {
  const main = `<main id="main">${receiptC(receipt)}</main>`;
  return chrome(
    'C',
    ctx,
    'Order placed - Marlow Market',
    main,
    scriptTag(clientC, { ...cfg, view: null })
  );
}

function infoBody(variant, slug, query) {
  const cart = CART_PATH[variant];
  const cartWord = variant === 'A' ? 'cart' : variant === 'B' ? 'bag' : 'basket';
  if (slug === 'search') {
    const q = query.get('q') || '';
    return `<h1>Search results</h1><p>No products matched &ldquo;${esc(q)}&rdquo;.</p><p><a href="${cart}">Back to your ${cartWord}</a></p>`;
  }
  const product = PRODUCT.get(slug);
  if (product) {
    return `<h1>${esc(product.title)}</h1><p>${esc(product.blurb)}.</p><p><strong>${money(product.price)}</strong></p><p><a href="${cart}">Back to your ${cartWord}</a></p>`;
  }
  const title = slug
    .split('-')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
  return `<h1>${esc(title)}</h1><p>We keep this section short. If you need help with an order, write to the support desk and a person will reply within one business day.</p><p><a href="${cart}">Back to your ${cartWord}</a></p>`;
}

function infoPage(variant, ctx, slug, query) {
  const inner = infoBody(variant, slug, query);
  const wrap =
    variant === 'A'
      ? `<main id="page">${inner}</main>`
      : variant === 'B'
        ? `<main id="view">${inner}</main>`
        : `<main id="main">${inner}</main>`;
  const script = `<script>${ISO_SRC}\nbindNewsletter();</script>`;
  return chrome(variant, ctx, pageTitle(variant, slug), wrap, script);
}

function pageTitle(variant, slug) {
  const brand = { A: 'Pinewood Supply', B: 'Harbor & Hearth', C: 'Marlow Market' }[variant];
  const name = slug
    .split('-')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
  return `${PRODUCT.has(slug) ? PRODUCT.get(slug).title : name} - ${brand}`;
}

// ---------------------------------------------------------------------------------------------
// Backend
// ---------------------------------------------------------------------------------------------

const obj = value => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});
const str = value => (typeof value === 'string' ? value.trim() : '');
const clone = value => JSON.parse(JSON.stringify(value));
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeFaults(faults) {
  const f = obj(faults);
  const ms = value => (Number.isFinite(value) && value > 0 ? Math.floor(value) : 0);
  return {
    rerenderEveryMs: ms(f.rerenderEveryMs),
    slowResponseMs: ms(f.slowResponseMs),
    failWrites: f.failWrites === true,
    misleadingSuccess: f.misleadingSuccess === true,
  };
}

function normalizeInitial(initial) {
  const opts = obj(initial);
  const lines = (list, label, fallback) => {
    if (list === undefined) return fallback.map(line => ({ ...line }));
    if (!Array.isArray(list)) throw new TypeError(`initial.${label} must be an array`);
    const merged = new Map();
    for (const entry of list) {
      const sku = obj(entry).sku;
      const quantity = obj(entry).quantity === undefined ? 1 : obj(entry).quantity;
      if (!PRODUCT.has(sku)) throw new Error(`initial.${label}: unknown sku ${String(sku)}`);
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) {
        throw new Error(`initial.${label}: quantity for ${sku} must be an integer from 1 to 99`);
      }
      merged.set(sku, (merged.get(sku) || 0) + quantity);
    }
    return [...merged].map(([sku, quantity]) => ({ sku, quantity }));
  };
  let promo = null;
  if (opts.promo !== undefined && opts.promo !== null && opts.promo !== false) {
    promo = String(opts.promo).toUpperCase();
    if (!PROMOS[promo]) throw new Error(`initial.promo: unknown code ${promo}`);
  }
  return {
    cart: lines(opts.cart, 'cart', DEFAULT_CART),
    saved: lines(opts.saved, 'saved', DEFAULT_SAVED),
    promo,
    prefill: opts.prefill === true,
  };
}

function lineItems(list) {
  return list.map(({ sku, quantity }) => {
    const p = PRODUCT.get(sku);
    return {
      sku,
      title: p.title,
      blurb: p.blurb,
      tone: p.tone,
      unitPrice: p.price,
      quantity,
      lineTotal: p.price * quantity,
    };
  });
}

function shippingOptionsFor(net, empty) {
  if (empty) return { standard: 0, express: 0 };
  return { standard: net >= FREE_SHIPPING_AT ? 0 : STANDARD_SHIPPING, express: EXPRESS_SHIPPING };
}

function pricing(items, promoCode, method) {
  const subtotal = items.reduce((sum, i) => sum + PRODUCT.get(i.sku).price * i.quantity, 0);
  const percent = promoCode ? PROMOS[promoCode].percent : 0;
  const discount = Math.round((subtotal * percent) / 100);
  const net = subtotal - discount;
  const options = shippingOptionsFor(net, items.length === 0);
  const shipping = method === 'express' ? options.express : options.standard;
  const tax = Math.round((net * TAX_PERCENT) / 100);
  return {
    itemCount: items.reduce((n, i) => n + i.quantity, 0),
    subtotal,
    discount,
    shipping,
    tax,
    total: net + shipping + tax,
  };
}

function json(status, data, headers = {}) {
  return {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
    body: JSON.stringify(data),
  };
}

function html(status, body, headers = {}) {
  return {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      ...headers,
    },
    body,
  };
}

const PAN_RUN = /\d(?:[ -]?\d){12,18}/g;

function luhnOk(digits) {
  let sum = 0;
  for (let i = 0; i < digits.length; i += 1) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

// A card number can end up in any text field (street address, delivery notes, a search box) when a
// client fills the wrong control, so every string that leaves the backend as state or log is
// scrubbed, not only the payment object.
const KNOWN_PANS = [...TEST_CARDS.keys()].map(digits => ({
  pattern: new RegExp(digits.split('').join('[ -]?'), 'g'),
  tag: `[card ending ${digits.slice(-4)}]`,
}));

function maskCards(text) {
  const known = KNOWN_PANS.reduce((out, { pattern, tag }) => out.replace(pattern, tag), text);
  return known.replace(PAN_RUN, run => {
    const digits = run.replace(/\D/g, '');
    return luhnOk(digits) ? `[card ending ${digits.slice(-4)}]` : run;
  });
}

function scrub(value) {
  if (typeof value === 'string') return maskCards(value);
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, scrub(inner)]));
  }
  return value;
}

function summarizeBody(body) {
  if (body === undefined || body === null) return null;
  const copy = clone(body);
  const payment = obj(copy).payment;
  if (payment && typeof payment === 'object') {
    const digits = String(payment.cardNumber === undefined ? '' : payment.cardNumber).replace(
      /\D/g,
      ''
    );
    delete payment.cardNumber;
    payment.cardLast4 = digits.slice(-4);
    if ('cvc' in payment) payment.cvc = '[masked]';
    if ('expiry' in payment) payment.expiry = '[masked]';
  }
  return scrub(copy);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > 262144) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function createBackend(variant, faults, initialRef) {
  const msg = { ...MSG.A, ...MSG[variant] };
  const sessions = new Map();
  const orders = [];
  const receipts = new Map();
  const newsletter = [];
  const attemptLog = [];
  const requestLog = [];
  const delays = new Set();
  let seq = 0;
  let sidSeq = 0;
  let epoch = 0;
  let nextOrderNo = 1001;
  let attempts = 0;
  let disposed = false;

  const sleep = ms =>
    new Promise(resolve => {
      const entry = { timer: null, resolve };
      entry.timer = setTimeout(() => {
        delays.delete(entry);
        resolve();
      }, ms);
      delays.add(entry);
    });

  function newSession() {
    sidSeq += 1;
    const initial = initialRef.current;
    const session = {
      id: `s${sidSeq}`,
      key: `e${epoch}-s${sidSeq}`,
      cart: { items: clone(initial.cart), saved: clone(initial.saved), promo: initial.promo },
    };
    sessions.set(session.key, session);
    return session;
  }

  function viewOf(cart, method = 'standard') {
    const net =
      cart.items.reduce((sum, i) => sum + PRODUCT.get(i.sku).price * i.quantity, 0) -
      pricing(cart.items, cart.promo, method).discount;
    const owned = new Set([...cart.items, ...cart.saved].map(i => i.sku));
    const recommended = CATALOG.filter(p => !owned.has(p.sku))
      .slice(0, 4)
      .map(p => ({
        sku: p.sku,
        title: p.title,
        blurb: p.blurb,
        tone: p.tone,
        unitPrice: p.price,
      }));
    const promo = cart.promo
      ? { code: cart.promo, percent: PROMOS[cart.promo].percent, label: PROMOS[cart.promo].label }
      : null;
    return {
      items: lineItems(cart.items),
      saved: lineItems(cart.saved),
      promo,
      totals: pricing(cart.items, cart.promo, method),
      shippingOptions: shippingOptionsFor(net, cart.items.length === 0),
      recommended: variant === 'C' ? recommended : [],
      account: {
        name: `${PROFILE.shipping.firstName} ${PROFILE.shipping.lastName}`,
        address: `${PROFILE.shipping.address1}, ${PROFILE.shipping.city}, ${PROFILE.shipping.region} ${PROFILE.shipping.postalCode}`,
        card: `Test Visa ending ${SAVED_CARD_LAST4}`,
      },
    };
  }

  function receiptOf(order) {
    return {
      id: order.id,
      items: order.items,
      totals: order.totals,
      shipping: {
        name: order.shipping.name,
        address1: order.shipping.address1,
        address2: order.shipping.address2,
        city: order.shipping.city,
        region: order.shipping.region,
        postalCode: order.shipping.postalCode,
        method: order.shipping.method,
      },
      contact: { email: order.contact.email },
      cardLast4: order.cardLast4,
    };
  }

  // Applies a cart change to a copy; the copy is only committed when persistence is not faked away.
  function mutateCart(ctx, change) {
    const next = clone(ctx.session.cart);
    const failure = change(next);
    if (failure) return failure;
    if (!faults.misleadingSuccess) ctx.session.cart = next;
    return json(200, { ok: true, cart: viewOf(next) });
  }

  const invalid = (field, message) => json(422, { errors: { [field]: message } });
  const validQty = value => Number.isInteger(value) && value >= 0 && value <= 99;

  function validateShipping(body, errors) {
    const contact = obj(body.contact);
    const ship = obj(body.shipping);
    if (!EMAIL_RE.test(str(contact.email))) errors['contact.email'] = msg.email;
    const phone = str(contact.phone);
    const digits = phone.replace(/\D/g, '');
    const phoneOk = digits.length >= 7 && digits.length <= 15;
    if (variant === 'B' ? !phoneOk : phone !== '' && !phoneOk) errors['contact.phone'] = msg.phone;
    if (!str(ship.firstName)) errors['shipping.firstName'] = msg.firstName;
    if (!str(ship.lastName)) errors['shipping.lastName'] = msg.lastName;
    if (!str(ship.address1)) errors['shipping.address1'] = msg.address1;
    if (!str(ship.city)) errors['shipping.city'] = msg.city;
    if (!STATE_CODES.has(str(ship.region))) errors['shipping.region'] = msg.region;
    if (!/^\d{5}$/.test(str(ship.postalCode))) errors['shipping.postalCode'] = msg.postalCode;
    if (!['standard', 'express'].includes(str(ship.method))) errors['shipping.method'] = msg.method;
  }

  function validatePayment(body, errors) {
    const pay = obj(body.payment);
    if (!str(pay.cardName)) errors['payment.cardName'] = msg.cardName;
    const number = String(typeof pay.cardNumber === 'string' ? pay.cardNumber : '').replace(
      /[\s-]/g,
      ''
    );
    if (!TEST_CARDS.has(number)) errors['payment.cardNumber'] = msg.cardNumber;
    const match = /^(0[1-9]|1[0-2])\s*\/\s*(\d{2})$/.exec(str(pay.expiry));
    const expired =
      !match ||
      Number(match[2]) < TEST_CLOCK.year ||
      (Number(match[2]) === TEST_CLOCK.year && Number(match[1]) < TEST_CLOCK.month);
    if (expired) errors['payment.expiry'] = msg.expiry;
    if (!/^\d{3}$/.test(str(pay.cvc))) errors['payment.cvc'] = msg.cvc;
  }

  function placeOrder(ctx) {
    attempts += 1;
    const entry = { seq: ctx.seq, outcome: 'pending' };
    attemptLog.push(entry);
    const finish = (outcome, response) => {
      entry.outcome = outcome;
      return response;
    };
    if (faults.failWrites) return finish('failed', json(500, SERVER_ERROR));
    const cart = ctx.session.cart;
    if (cart.items.length === 0) {
      return finish('empty-cart', json(409, { error: 'empty_cart', message: msg.empty }));
    }
    const body = obj(ctx.body);
    let contact;
    let shipping;
    let cardLast4;
    let marketingOptIn = false;
    let note = '';
    const source = body.source === 'buy-now' ? 'buy-now' : 'checkout';
    if (source === 'buy-now') {
      contact = { ...PROFILE.contact };
      shipping = { ...PROFILE.shipping, method: 'standard' };
      cardLast4 = SAVED_CARD_LAST4;
    } else {
      const errors = {};
      validateShipping(body, errors);
      validatePayment(body, errors);
      if (Object.keys(errors).length > 0) return finish('invalid', json(422, { errors }));
      const number = String(obj(body.payment).cardNumber).replace(/[\s-]/g, '');
      if (TEST_CARDS.get(number) === 'declined') {
        return finish('declined', json(402, { error: 'card_declined', message: msg.declined }));
      }
      const c = obj(body.contact);
      const s = obj(body.shipping);
      contact = { email: str(c.email), phone: str(c.phone) };
      shipping = {
        firstName: str(s.firstName),
        lastName: str(s.lastName),
        address1: str(s.address1),
        address2: str(s.address2),
        city: str(s.city),
        region: str(s.region),
        postalCode: str(s.postalCode),
        method: str(s.method),
      };
      cardLast4 = number.slice(-4);
      marketingOptIn = body.marketingOptIn === true;
      note = str(body.note).slice(0, 500);
    }
    const order = {
      id: `ORD-${nextOrderNo}`,
      items: lineItems(cart.items).map(({ sku, title, unitPrice, quantity, lineTotal }) => ({
        sku,
        title,
        unitPrice,
        quantity,
        lineTotal,
      })),
      totals: { ...pricing(cart.items, cart.promo, shipping.method), currency: 'USD' },
      shipping: {
        name: `${shipping.firstName} ${shipping.lastName}`,
        address1: shipping.address1,
        address2: shipping.address2,
        city: shipping.city,
        region: shipping.region,
        postalCode: shipping.postalCode,
        country: 'US',
        method: shipping.method,
      },
      contact,
      cardLast4,
      createdSeq: ctx.seq,
      promo: cart.promo,
      marketingOptIn,
      note,
      source,
    };
    const receipt = receiptOf(order);
    receipts.set(order.id, receipt);
    if (faults.misleadingSuccess) {
      return finish('ignored', json(201, { id: order.id, receipt }));
    }
    nextOrderNo += 1;
    orders.push(order);
    ctx.session.cart.items = [];
    return finish('created', json(201, { id: order.id, receipt }));
  }

  function routeApi(ctx) {
    const { method, path, body, session } = ctx;
    const isRead = method === 'GET' || path === '/api/checkout/validate';
    if (path === '/api/orders' && method === 'POST') return placeOrder(ctx);
    if (!isRead && faults.failWrites) return json(500, SERVER_ERROR);
    const cart = session.cart;
    if (method === 'GET' && path === '/api/cart') {
      return json(200, {
        ...viewOf(cart),
        profile: initialRef.current.prefill ? PROFILE : null,
      });
    }
    if (method === 'GET' && path === '/api/quote') {
      const m = ctx.query.get('method') === 'express' ? 'express' : 'standard';
      const view = viewOf(cart, m);
      return json(200, {
        items: view.items,
        totals: view.totals,
        promo: view.promo,
        shippingOptions: view.shippingOptions,
      });
    }
    const receiptMatch = /^\/api\/receipts\/([^/]+)$/.exec(path);
    if (method === 'GET' && receiptMatch) {
      const receipt = receipts.get(decodeURIComponent(receiptMatch[1]));
      return receipt ? json(200, { receipt }) : json(404, { error: 'not_found' });
    }
    if (method === 'POST' && path === '/api/checkout/validate') {
      const errors = {};
      const step = obj(body).step;
      if (step === 'shipping') validateShipping(obj(body), errors);
      else if (step === 'payment') validatePayment(obj(body), errors);
      return Object.keys(errors).length > 0 ? json(422, { errors }) : json(200, { ok: true });
    }
    if (method === 'PUT' && path === '/api/cart') {
      const entries = obj(body).items;
      if (!Array.isArray(entries)) return invalid('items', 'Items are required.');
      return mutateCart(ctx, next => {
        for (const entry of entries) {
          const sku = obj(entry).sku;
          const quantity = obj(entry).quantity;
          if (!validQty(quantity)) {
            return invalid('quantity', 'Quantities must be whole numbers from 0 to 99.');
          }
          const index = next.items.findIndex(i => i.sku === sku);
          if (index < 0) return invalid('sku', 'That item is not in your cart.');
          if (quantity === 0) next.items.splice(index, 1);
          else next.items[index].quantity = quantity;
        }
        return null;
      });
    }
    if (method === 'POST' && path === '/api/cart/items') {
      const sku = obj(body).sku;
      const quantity = obj(body).quantity === undefined ? 1 : obj(body).quantity;
      if (!PRODUCT.has(sku)) return invalid('sku', 'Unknown product.');
      if (!validQty(quantity) || quantity < 1) return invalid('quantity', 'Invalid quantity.');
      return mutateCart(ctx, next => {
        const found = next.items.find(i => i.sku === sku);
        if (found) found.quantity = Math.min(99, found.quantity + quantity);
        else next.items.push({ sku, quantity });
        return null;
      });
    }
    const itemMatch = /^\/api\/cart\/items\/([^/]+)$/.exec(path);
    if (itemMatch && (method === 'PUT' || method === 'DELETE')) {
      const sku = decodeURIComponent(itemMatch[1]);
      const quantity = method === 'DELETE' ? 0 : obj(body).quantity;
      if (!validQty(quantity)) {
        return invalid('quantity', 'Quantities must be whole numbers from 0 to 99.');
      }
      return mutateCart(ctx, next => {
        const index = next.items.findIndex(i => i.sku === sku);
        if (index < 0) return json(404, { error: 'not_in_cart' });
        if (quantity === 0) next.items.splice(index, 1);
        else next.items[index].quantity = quantity;
        return null;
      });
    }
    if (method === 'POST' && path === '/api/cart/saved') {
      const sku = obj(body).sku;
      return mutateCart(ctx, next => {
        const index = next.items.findIndex(i => i.sku === sku);
        if (index < 0) return json(404, { error: 'not_in_cart' });
        const [moved] = next.items.splice(index, 1);
        const already = next.saved.find(i => i.sku === sku);
        if (already) already.quantity += moved.quantity;
        else next.saved.push(moved);
        return null;
      });
    }
    if (method === 'POST' && path === '/api/cart/restore') {
      const sku = obj(body).sku;
      return mutateCart(ctx, next => {
        const index = next.saved.findIndex(i => i.sku === sku);
        if (index < 0) return json(404, { error: 'not_saved' });
        const [moved] = next.saved.splice(index, 1);
        const already = next.items.find(i => i.sku === sku);
        if (already) already.quantity += moved.quantity;
        else next.items.push(moved);
        return null;
      });
    }
    const savedMatch = /^\/api\/cart\/saved\/([^/]+)$/.exec(path);
    if (method === 'DELETE' && savedMatch) {
      const sku = decodeURIComponent(savedMatch[1]);
      return mutateCart(ctx, next => {
        const index = next.saved.findIndex(i => i.sku === sku);
        if (index < 0) return json(404, { error: 'not_saved' });
        next.saved.splice(index, 1);
        return null;
      });
    }
    if (method === 'POST' && path === '/api/cart/clear') {
      return mutateCart(ctx, next => {
        next.items = [];
        return null;
      });
    }
    if (method === 'POST' && path === '/api/cart/promo') {
      const code = str(obj(body).code).toUpperCase();
      if (!PROMOS[code]) return invalid('code', 'That promo code is not valid.');
      return mutateCart(ctx, next => {
        next.promo = code;
        return null;
      });
    }
    if (method === 'DELETE' && path === '/api/cart/promo') {
      return mutateCart(ctx, next => {
        next.promo = null;
        return null;
      });
    }
    if (method === 'POST' && path === '/api/newsletter') {
      const email = str(obj(body).email);
      if (!EMAIL_RE.test(email)) return invalid('email', 'Enter a valid email address.');
      if (!faults.misleadingSuccess && !newsletter.includes(email)) newsletter.push(email);
      return json(200, { ok: true });
    }
    return json(404, { error: 'not_found' });
  }

  function routePage(ctx) {
    const { path, session, query } = ctx;
    const cfg = {
      rerenderEveryMs: faults.rerenderEveryMs,
      testMode: TEST_MODE_TEXT,
      states: STATES,
    };
    const view = viewOf(session.cart);
    const page = { cartCount: view.totals.itemCount };
    if (path === '/') {
      return { status: 302, headers: { location: CART_PATH[variant] }, body: '' };
    }
    if (path === '/search') return html(200, infoPage(variant, page, 'search', query));
    const info = /^\/p\/([a-z0-9-]+)$/.exec(path);
    if (info) return html(200, infoPage(variant, page, info[1], query));
    if (variant === 'A') {
      if (path === '/cart') return html(200, cartPageA(page, view, cfg));
      if (path === '/checkout') {
        return html(200, checkoutPageA(page, view, cfg, initialRef.current.prefill));
      }
      const order = /^\/order\/([^/]+)$/.exec(path);
      if (order) {
        const receipt = receipts.get(decodeURIComponent(order[1]));
        if (receipt) return html(200, orderPageA(page, receipt, cfg));
      }
    } else if (variant === 'B') {
      const spa = new Set(['/bag', '/checkout/shipping', '/checkout/payment', '/checkout/review']);
      if (spa.has(path) || /^\/checkout\/complete\/[^/]+$/.test(path)) {
        return html(200, shellB(page, cfg));
      }
    } else {
      if (path === '/basket') return html(200, basketPageC(page, view, cfg));
      const thanks = /^\/thanks\/([^/]+)$/.exec(path);
      if (thanks) {
        const receipt = receipts.get(decodeURIComponent(thanks[1]));
        if (receipt) return html(200, thanksPageC(page, receipt, cfg));
      }
    }
    const brand = { A: 'Pinewood Supply', B: 'Harbor & Hearth', C: 'Marlow Market' }[variant];
    const main = `<main><h1>Page not found</h1><p>We could not find what you were looking for.</p><p><a href="${CART_PATH[variant]}">Back to the shop</a></p></main>`;
    return html(
      404,
      chrome(
        variant,
        page,
        `Not found - ${brand}`,
        main,
        `<script>${ISO_SRC}\nbindNewsletter();</script>`
      )
    );
  }

  function state() {
    return scrub(
      clone({
        orders,
        attempts,
        attemptLog,
        carts: [...sessions.values()].map(s => ({
          sid: s.id,
          items: s.cart.items,
          saved: s.cart.saved,
          promo: s.cart.promo,
          totals: pricing(s.cart.items, s.cart.promo, 'standard'),
        })),
        newsletter,
      })
    );
  }

  function reset(nextInitial) {
    if (nextInitial !== undefined) initialRef.current = normalizeInitial(nextInitial);
    sessions.clear();
    orders.length = 0;
    receipts.clear();
    newsletter.length = 0;
    attemptLog.length = 0;
    requestLog.length = 0;
    seq = 0;
    sidSeq = 0;
    epoch += 1;
    nextOrderNo = 1001;
    attempts = 0;
  }

  function dispose() {
    disposed = true;
    for (const entry of delays) {
      clearTimeout(entry.timer);
      entry.resolve();
    }
    delays.clear();
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    const method = req.method || 'GET';
    const path = url.pathname;
    if (path === '/favicon.ico') {
      res.writeHead(204);
      res.end();
      return;
    }
    const raw = await readBody(req);
    let body;
    let badJson = false;
    if (raw.length > 0) {
      try {
        body = JSON.parse(raw);
      } catch (parseError) {
        badJson = true;
      }
    }
    const isTest = path.startsWith('/__test/');
    if (isTest) {
      let result;
      if (method === 'GET' && path === '/__test/state') result = json(200, state());
      else if (method === 'GET' && path === '/__test/requests')
        result = json(200, clone(requestLog));
      else if (method === 'POST' && path === '/__test/reset') {
        reset(body && Object.keys(obj(body)).length > 0 ? body : undefined);
        result = json(200, { ok: true });
      } else result = json(404, { error: 'not_found' });
      res.writeHead(result.status, result.headers);
      res.end(result.body);
      return;
    }
    seq += 1;
    const thisSeq = seq;
    requestLog.push({
      seq: thisSeq,
      method,
      path: maskCards(path),
      query: scrub(Object.fromEntries(url.searchParams)),
      bodySummary: summarizeBody(body),
    });
    const headers = {};
    const cookie = /(?:^|;\s*)sid=([^;]+)/.exec(req.headers.cookie || '');
    let session = cookie ? sessions.get(cookie[1]) : undefined;
    if (!session) {
      session = newSession();
      headers['set-cookie'] = `sid=${session.key}; Path=/; HttpOnly; SameSite=Lax`;
    }
    const ctx = { method, path, query: url.searchParams, body, session, seq: thisSeq };
    const isApi = path.startsWith('/api/');
    let result;
    try {
      if (badJson) result = json(400, { error: 'invalid_json' });
      else if (isApi) result = routeApi(ctx);
      else if (method === 'GET' || method === 'HEAD') result = routePage(ctx);
      else result = json(405, { error: 'method_not_allowed' });
    } catch (error) {
      result = json(500, SERVER_ERROR);
    }
    if (isApi && faults.slowResponseMs > 0) await sleep(faults.slowResponseMs);
    if (disposed || res.destroyed || res.writableEnded) return;
    res.writeHead(result.status, { ...result.headers, ...headers });
    res.end(method === 'HEAD' ? undefined : result.body);
  }

  return {
    handle,
    state,
    requests: () => clone(requestLog),
    reset,
    dispose,
  };
}

// ---------------------------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------------------------

export function describe() {
  return {
    family,
    variants: [
      {
        id: 'A',
        summary:
          'Pinewood Supply: server-rendered cart page (quantity inputs, Update cart, Clear cart, promo code) then one single-page checkout form with a Place order button. Full-page navigations.',
      },
      {
        id: 'B',
        summary:
          'Harbor & Hearth: single-page app. Bag with quantity steppers, then a three-step checkout (shipping, payment, review) with history.pushState transitions and a Place your order button.',
      },
      {
        id: 'C',
        summary:
          'Marlow Market: long basket page; Buy now sits far below the fold and opens an in-page confirm dialog (Yes, place test order). Save for later, Remove and Add to basket are wrong-choice controls. Uses the saved address and test card.',
      },
    ],
    faults: [
      {
        name: 'rerenderEveryMs',
        summary:
          'Every N ms the main content nodes (and the dialog contents in C) are replaced with fresh equivalent clones, so held element references go stale.',
      },
      {
        name: 'slowResponseMs',
        summary:
          'Every /api response is delayed by N ms after the backend already processed it (backend state changes before the UI hears back).',
      },
      {
        name: 'failWrites',
        summary:
          'Every API write (cart changes, newsletter, POST /api/orders) returns HTTP 500 and changes nothing; the UI shows a visible error and not a success state.',
      },
      {
        name: 'misleadingSuccess',
        summary:
          'API writes answer with success but do not persist: no order is stored and the cart is not cleared, while the UI shows the confirmation or a success notice.',
      },
    ],
    initialOptions: [
      {
        name: 'cart',
        summary:
          'Array of { sku, quantity } for the starting cart. Default: ceramic-dripper x1, merino-socks x2, notebook-set x1. SKUs: ' +
          CATALOG.map(p => p.sku).join(', ') +
          '.',
      },
      {
        name: 'saved',
        summary:
          'Array of { sku, quantity } saved for later (shown in variant C). Default: tea-sampler x1.',
      },
      {
        name: 'promo',
        summary: 'Promo code already applied to the cart, for example WELCOME10 (10% off).',
      },
      {
        name: 'prefill',
        summary:
          'Boolean. When true, the contact and shipping fields of the checkout forms (variants A and B) start filled with a returning customer profile.',
      },
    ],
  };
}

export async function startApp({ port = 0, variant = 'A', initial = {}, faults = {} } = {}) {
  if (!variants.includes(variant)) {
    throw new Error(`Unknown variant ${String(variant)}; expected one of ${variants.join(', ')}`);
  }
  const initialRef = { current: normalizeInitial(initial) };
  const backend = createBackend(variant, normalizeFaults(faults), initialRef);
  const server = http.createServer((req, res) => {
    backend.handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('Internal error');
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const address = server.address();
  const origin = `http://127.0.0.1:${address.port}`;
  let closing = null;
  return {
    url: `${origin}/`,
    origin,
    family,
    variant,
    state: () => backend.state(),
    requests: () => backend.requests(),
    reset: next => backend.reset(next),
    close() {
      if (closing) return closing;
      backend.dispose();
      closing = new Promise(resolve => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      return closing;
    },
  };
}
