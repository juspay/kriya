import { createServer } from 'node:http';

export const family = 'catalog';
export const variants = ['A', 'B', 'C'];

const SORTS = ['relevance', 'price_asc', 'price_desc', 'rating'];

const CATEGORY_DEFS = [
  { slug: 'audio', hue: 215, labels: { A: 'Audio', B: 'Headphones & Audio', C: 'Sound' } },
  { slug: 'kitchen', hue: 25, labels: { A: 'Kitchen', B: 'Kitchen & Dining', C: 'Cooking' } },
  { slug: 'fitness', hue: 150, labels: { A: 'Fitness', B: 'Fitness & Training', C: 'Training' } },
  { slug: 'office', hue: 265, labels: { A: 'Office', B: 'Office & Desk', C: 'Workspace' } },
  { slug: 'outdoor', hue: 95, labels: { A: 'Outdoor', B: 'Outdoors & Camping', C: 'Adventure' } },
];

const PRICE_STEPS = [25, 50, 100, 200];

const SORT_LABELS = {
  A: {
    relevance: 'Best match',
    price_asc: 'Price: low to high',
    price_desc: 'Price: high to low',
    rating: 'Avg. customer review',
  },
  B: {
    relevance: 'Most relevant',
    price_asc: 'Lowest price first',
    price_desc: 'Highest price first',
    rating: 'Best rated',
  },
  C: {
    relevance: 'Recommended',
    price_asc: 'Cheapest first',
    price_desc: 'Most expensive first',
    rating: 'Top reviewed',
  },
};

const RAW_PRODUCTS = [
  [
    'p01',
    'Northwave Aria Wireless Headphones',
    'audio',
    'Northwave',
    129.99,
    4.6,
    312,
    'Over-ear Bluetooth headphones with 40-hour battery life and soft memory-foam cushions.',
  ],
  [
    'p02',
    'Northwave Aria Mini Earbuds',
    'audio',
    'Northwave',
    59.99,
    4.3,
    198,
    'True wireless earbuds with a pocket charging case and three ear tip sizes.',
  ],
  [
    'p03',
    'Sonique Studio Monitor Headphones',
    'audio',
    'Sonique',
    89.0,
    4.7,
    421,
    'Open-back wired headphones tuned for mixing, monitoring and long listening sessions.',
  ],
  [
    'p04',
    'Sonique Pocket Bluetooth Speaker',
    'audio',
    'Sonique',
    39.95,
    4.4,
    876,
    'Water-resistant wireless speaker with twelve hours of playtime.',
  ],
  [
    'p05',
    'Lumio Desk Speaker Pair',
    'audio',
    'Lumio',
    74.5,
    4.1,
    143,
    'Compact powered speakers with USB-C and 3.5 mm inputs.',
  ],
  [
    'p06',
    'Sonique Turntable One',
    'audio',
    'Sonique',
    249.99,
    4.5,
    87,
    'Belt-drive record player with a built-in preamp and dust cover.',
  ],
  [
    'p07',
    'Kettlebrook Gooseneck Kettle',
    'kitchen',
    'Kettlebrook',
    54.0,
    4.8,
    654,
    'One litre electric kettle with precise temperature hold.',
  ],
  [
    'p08',
    'Kettlebrook Burr Coffee Grinder',
    'kitchen',
    'Kettlebrook',
    79.99,
    4.5,
    509,
    'Conical burr grinder with thirty grind settings.',
  ],
  [
    'p09',
    'Hearthly Cast Iron Skillet',
    'kitchen',
    'Hearthly',
    34.99,
    4.7,
    1203,
    'Pre-seasoned ten inch skillet for stovetop, oven and campfire.',
  ],
  [
    'p10',
    'Hearthly Stainless Steel Saucepan Set',
    'kitchen',
    'Hearthly',
    119.0,
    4.2,
    231,
    'Three saucepans with glass lids and riveted handles.',
  ],
  [
    'p11',
    'Lumio Smart Kitchen Scale',
    'kitchen',
    'Lumio',
    24.99,
    4.0,
    367,
    'Wireless digital scale that tracks portions in the companion app.',
  ],
  [
    'p12',
    'Hearthly Silicone Utensil Pack',
    'kitchen',
    'Hearthly',
    14.99,
    4.3,
    982,
    'Eight heat-resistant utensils in a bamboo holder.',
  ],
  [
    'p13',
    'Torque Adjustable Dumbbell Pair',
    'fitness',
    'Torque',
    199.0,
    4.6,
    274,
    'Dial-select dumbbells from five to fifty pounds each.',
  ],
  [
    'p14',
    'Torque Resistance Band Set',
    'fitness',
    'Torque',
    19.99,
    4.4,
    1544,
    'Five latex bands with door anchor and carry bag.',
  ],
  [
    'p15',
    'Pinecrest Cork Yoga Mat',
    'fitness',
    'Pinecrest',
    29.99,
    4.5,
    418,
    'Non-slip natural cork mat, six millimetres thick.',
  ],
  [
    'p16',
    'Pinecrest Insulated Water Bottle',
    'fitness',
    'Pinecrest',
    22.5,
    4.7,
    2310,
    'Stainless steel bottle that keeps drinks cold for a full day.',
  ],
  [
    'p17',
    'Aerodyne Wireless Fitness Tracker',
    'fitness',
    'Aerodyne',
    69.99,
    4.0,
    356,
    'Heart rate, sleep and step tracking with a seven-day battery.',
  ],
  [
    'p18',
    'Aerodyne Speed Jump Rope',
    'fitness',
    'Aerodyne',
    15.99,
    4.2,
    640,
    'Weighted handles and a tangle-free steel cable.',
  ],
  [
    'p19',
    'Deskly Standing Desk Converter',
    'office',
    'Deskly',
    159.0,
    4.3,
    189,
    'Sit-stand riser that lifts your keyboard and monitor in one motion.',
  ],
  [
    'p20',
    'Deskly Ergonomic Wireless Mouse',
    'office',
    'Deskly',
    34.5,
    4.4,
    733,
    'Vertical mouse with silent clicks and a rechargeable battery.',
  ],
  [
    'p21',
    'Lumio Wireless Mechanical Keyboard',
    'office',
    'Lumio',
    99.99,
    4.6,
    512,
    'Tenkeyless keyboard with hot-swappable switches and Bluetooth pairing.',
  ],
  [
    'p22',
    'Northwave Quiet Office Headset',
    'office',
    'Northwave',
    149.0,
    4.5,
    264,
    'Noise-cancelling wireless headset with a boom microphone for calls.',
  ],
  [
    'p23',
    'Deskly Dual Monitor Arm',
    'office',
    'Deskly',
    49.99,
    4.1,
    305,
    'Gas-spring arm that holds two screens up to twenty-seven inches.',
  ],
  [
    'p24',
    'Lumio LED Desk Lamp',
    'office',
    'Lumio',
    44.0,
    4.7,
    890,
    'Dimmable lamp with warm and cool light and a USB charging port.',
  ],
  [
    'p25',
    'Trailmark Two-Person Tent',
    'outdoor',
    'Trailmark',
    189.0,
    4.4,
    221,
    'Three-season tent that pitches in under five minutes.',
  ],
  [
    'p26',
    'Trailmark Carbon Trekking Poles',
    'outdoor',
    'Trailmark',
    49.95,
    4.5,
    342,
    'Collapsible poles with cork grips and tungsten tips.',
  ],
  [
    'p27',
    'Pinecrest Folding Camp Stove',
    'outdoor',
    'Pinecrest',
    64.99,
    4.3,
    198,
    'Compact single-burner stove that packs flat.',
  ],
  [
    'p28',
    'Pinecrest Steel Vacuum Thermos',
    'outdoor',
    'Pinecrest',
    27.99,
    4.6,
    1120,
    'Twenty-four ounce flask that keeps coffee hot for twelve hours.',
  ],
  [
    'p29',
    'Aerodyne Wireless Camping Lantern',
    'outdoor',
    'Aerodyne',
    21.99,
    4.2,
    478,
    'Rechargeable lantern with a red night mode.',
  ],
  [
    'p30',
    'Trailmark Daypack 22L',
    'outdoor',
    'Trailmark',
    79.0,
    4.6,
    610,
    'Ventilated daypack with a hydration sleeve and rain cover.',
  ],
];

const PRODUCTS = RAW_PRODUCTS.map(
  ([id, title, category, brand, price, rating, reviews, blurb], i) => ({
    id,
    title,
    category,
    brand,
    price,
    rating,
    reviews,
    blurb,
    featured: (i * 7) % RAW_PRODUCTS.length,
  })
);

const PRODUCT_BY_ID = new Map(PRODUCTS.map(p => [p.id, p]));
const BRAND_NAMES = [...new Set(PRODUCTS.map(p => p.brand))].sort();

const countBy = (key, value) => PRODUCTS.filter(p => p[key] === value).length;

const categoryList = variant =>
  CATEGORY_DEFS.map(c => ({
    slug: c.slug,
    label: c.labels[variant],
    count: countBy('category', c.slug),
  }));

const brandList = () =>
  BRAND_NAMES.map(name => ({
    slug: name.toLowerCase(),
    label: name,
    count: countBy('brand', name),
  }));

const POPULAR_SEARCHES = [
  'standing desk',
  'camping stove',
  'yoga mat',
  'coffee grinder',
  'bluetooth speaker',
];

/* ------------------------------------------------------------------ */
/* Pure helpers shared by the server and (serialized) the page scripts */
/* ------------------------------------------------------------------ */

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, ch => {
    const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    return map[ch];
  });
}

function renderInventory(inventory) {
  if (!inventory) {
    return '';
  }
  const basket = inventory.cart.length
    ? `<ul>${inventory.cart.map(item => `<li>${escapeHtml(item.title)} — Product ${escapeHtml(item.productId)} — Quantity ${escapeHtml(item.qty)}</li>`).join('')}</ul>`
    : '<p>No basket items.</p>';
  const saved = inventory.saved.length
    ? `<ul>${inventory.saved.map(item => `<li>${escapeHtml(item.title)} — Product ${escapeHtml(item.productId)}</li>`).join('')}</ul>`
    : '<p>No saved items.</p>';
  return `<section id="inventory-summary" aria-label="Basket and saved items" style="padding:8px 36px;background:#fff;border-bottom:1px solid #ddd">
    <h2>Basket items</h2>${basket}
    <h2>Saved items</h2>${saved}
    <p><a href="/info/basket">View basket items</a> · <a href="/info/saved">View saved items</a></p>
  </section>`;
}

function inventoryPatch(inventory) {
  if (!inventory) {
    return {};
  }
  return {
    inventory,
    cartCount: inventory.cart.reduce((sum, item) => sum + item.qty, 0),
    wishlist: inventory.saved.map(item => item.productId),
  };
}

function formatPrice(value) {
  return '$' + Number(value).toFixed(2);
}

function starText(rating) {
  const n = Math.round(rating);
  return '★'.repeat(n) + '☆'.repeat(5 - n);
}

function buildQuery(s) {
  const p = new URLSearchParams();
  if (s.q) p.set('q', s.q);
  s.category.forEach(v => p.append('category', v));
  s.brand.forEach(v => p.append('brand', v));
  if (s.maxPrice !== '' && s.maxPrice !== null && s.maxPrice !== undefined) {
    p.set('maxPrice', String(s.maxPrice));
  }
  if (s.sort && s.sort !== 'relevance') p.set('sort', s.sort);
  return p.toString();
}

function parseQuery(search) {
  const p = new URLSearchParams(search);
  const many = key =>
    p
      .getAll(key)
      .flatMap(v => v.split(','))
      .map(v => v.trim().toLowerCase())
      .filter(Boolean);
  const mp = p.get('maxPrice');
  const price = mp !== null && mp.trim() !== '' && Number.isFinite(Number(mp)) ? Number(mp) : '';
  const sort = ['price_asc', 'price_desc', 'rating'].includes(p.get('sort'))
    ? p.get('sort')
    : 'relevance';
  return {
    q: (p.get('q') || '').replace(/\s+/g, ' ').trim(),
    category: many('category'),
    brand: many('brand'),
    maxPrice: price,
    sort,
  };
}

function renderHeaderA(cartCount, qValue) {
  return `<div class="promo">Free shipping on orders over $50 &middot; <a href="/info/deals">See this week&rsquo;s deals</a></div>
<header class="top">
  <a class="logo" href="/">Shopwell</a>
  <form class="search" id="search-form" role="search" action="/" method="get">
    <label class="sr" for="site-search">Search products</label>
    <input id="site-search" name="q" type="search" placeholder="Search products" autocomplete="off" value="${escapeHtml(qValue)}">
    <button type="submit" aria-label="Search"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7"></circle><path d="M20 20l-4-4"></path></svg></button>
  </form>
  <nav class="acct" aria-label="Account">
    <a href="/info/signin">Sign in</a>
    <a href="/info/help">Help</a>
    <a id="cart-link" href="/info/cart" aria-label="Cart, ${cartCount} items">Cart <span class="badge" id="cart-badge">${cartCount}</span></a>
  </nav>
</header>
<nav class="depts" aria-label="Shop sections">
  <a href="/info/deals">Deals</a><a href="/info/new">New arrivals</a><a href="/info/bestsellers">Best sellers</a><a href="/info/gift-cards">Gift cards</a><a href="/info/clearance">Clearance</a>
</nav>`;
}

function renderFooterA(draft, note, withNewsletter) {
  const noteHtml = note
    ? `<p class="${note.kind === 'error' ? 'nl-err' : 'nl-ok'}" role="${note.kind === 'error' ? 'alert' : 'status'}">${escapeHtml(note.text)}</p>`
    : '';
  const newsletter = withNewsletter
    ? `<form class="newsletter" id="nl-form" action="/info/newsletter" method="get">
      <h2>Get weekly offers</h2>
      <label for="nl-email">Email address</label>
      <div class="nl-row"><input id="nl-email" name="email" type="email" autocomplete="email" value="${escapeHtml(draft)}"><button type="submit">Subscribe</button></div>
      ${noteHtml}
    </form>`
    : '';
  return `<footer class="foot">
  ${newsletter}
  <div class="cols">
    <div><h2>Customer care</h2><a href="/info/shipping">Shipping info</a><a href="/info/returns">Returns</a><a href="/info/contact">Contact us</a></div>
    <div><h2>Company</h2><a href="/info/about">About Shopwell</a><a href="/info/careers">Careers</a><a href="/info/privacy">Privacy notice</a></div>
  </div>
  <p class="legal">&copy; Shopwell Demo Store. All prices in US dollars.</p>
</footer>`;
}

function renderHeaderC(cartCount, interactive) {
  const searchControl = interactive
    ? `<button type="button" class="icon-btn" id="open-search" aria-label="Search" aria-haspopup="dialog"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7"></circle><path d="M20 20l-4-4"></path></svg></button>`
    : `<a class="icon-btn" href="/?search=1" aria-label="Search"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7"></circle><path d="M20 20l-4-4"></path></svg></a>`;
  return `<header class="bar">
  <a class="mark" href="/">Mercato</a>
  <nav class="main-nav" aria-label="Primary"><a href="/info/shop">Shop</a><a href="/info/journal">Journal</a><a href="/info/stores">Stores</a><a href="/info/gift-cards">Gift cards</a></nav>
  <div class="tools">
    ${searchControl}
    <a class="plain" href="/info/signin">Account</a>
    <a class="plain" id="bag-link" href="/info/bag" aria-label="Bag, ${cartCount} items">Bag (<span id="bag-count">${cartCount}</span>)</a>
  </div>
</header>`;
}

function renderFooterC(draft, note, withNewsletter) {
  const noteHtml = note
    ? `<p class="${note.kind === 'error' ? 'nl-err' : 'nl-ok'}" role="${note.kind === 'error' ? 'alert' : 'status'}">${escapeHtml(note.text)}</p>`
    : '';
  const newsletter = withNewsletter
    ? `<form class="join" id="nl-form" action="/info/newsletter" method="get">
      <h2>Letters from the studio</h2>
      <label for="nl-email">Where should we send it?</label>
      <div class="nl-row"><input id="nl-email" name="email" type="email" autocomplete="email" placeholder="you@example.com" value="${escapeHtml(draft)}"><button type="submit">Sign me up</button></div>
      ${noteHtml}
    </form>`
    : '';
  return `<footer class="foot">
  ${newsletter}
  <nav aria-label="Footer"><a href="/info/stores">Find a store</a><a href="/info/returns">Returns &amp; exchanges</a><a href="/info/contact">Contact</a><a href="/info/privacy">Privacy</a></nav>
  <p class="legal">Mercato Demo Goods. Prices shown in US dollars.</p>
</footer>`;
}

const CLIENT_HELPERS = [
  escapeHtml,
  renderInventory,
  inventoryPatch,
  formatPrice,
  starText,
  buildQuery,
  parseQuery,
  renderHeaderA,
  renderFooterA,
  renderHeaderC,
  renderFooterC,
]
  .map(fn => fn.toString())
  .join('\n');

/* ------------------------------------------------------------------ */
/* Variant A client: live SPA with sidebar checkboxes                  */
/* ------------------------------------------------------------------ */

function clientA(boot) {
  const $ = selector => document.querySelector(selector);
  let S = {
    q: '',
    qDraft: '',
    category: [],
    brand: [],
    maxPrice: '',
    sort: 'relevance',
    results: null,
    loading: false,
    loadError: false,
    cartCount: boot.cartCount,
    wishlist: boot.wishlist,
    inventory: boot.inventory ?? null,
    banner: null,
    nlDraft: '',
    nlNote: null,
  };
  const set = patch => {
    S = { ...S, ...patch };
  };
  let token = 0;
  let bannerTimer = null;
  let debounceTimer = null;

  const labelOf = (list, slug) => (list.find(item => item.slug === slug) || { label: slug }).label;
  const hasFilters = () => S.category.length > 0 || S.brand.length > 0 || S.maxPrice !== '';
  const urlFor = () => {
    const qs = buildQuery(S);
    return '/' + (qs ? '?' + qs : '');
  };

  const renderSidebar = () => `
    <h2>Filters</h2>
    <fieldset>
      <legend>Category</legend>
      <ul class="opts">${boot.categories
        .map(
          c =>
            `<li><label><input type="checkbox" name="category" value="${c.slug}"${
              S.category.includes(c.slug) ? ' checked' : ''
            }> <span>${escapeHtml(c.label)}</span> <span class="n">(${c.count})</span></label></li>`
        )
        .join('')}</ul>
    </fieldset>
    <fieldset>
      <legend>Brand</legend>
      <ul class="opts">${boot.brands
        .map(
          b =>
            `<li><label><input type="checkbox" name="brand" value="${b.slug}"${
              S.brand.includes(b.slug) ? ' checked' : ''
            }> <span>${escapeHtml(b.label)}</span> <span class="n">(${b.count})</span></label></li>`
        )
        .join('')}</ul>
    </fieldset>
    <div class="field">
      <label for="price">Price</label>
      <select id="price" name="maxPrice">
        <option value=""${S.maxPrice === '' ? ' selected' : ''}>Any price</option>
        ${boot.prices
          .map(
            v =>
              `<option value="${v}"${String(S.maxPrice) === String(v) ? ' selected' : ''}>Up to $${v}</option>`
          )
          .join('')}
      </select>
    </div>
    <div class="side-actions"><button type="button" class="link-btn clear-filters">Clear filters</button></div>
    <div class="member-box"><strong>Shopwell Plus</strong><p>Members save 10% on every order.</p><a class="cta" href="/info/plus">Join now</a></div>`;

  const renderPills = () => {
    const pills = [
      ...S.category.map(
        v =>
          `<li><button type="button" class="pill" name="category" value="${escapeHtml(v)}" aria-label="Remove filter: ${escapeHtml(
            labelOf(boot.categories, v)
          )}">${escapeHtml(labelOf(boot.categories, v))} <span aria-hidden="true">&times;</span></button></li>`
      ),
      ...S.brand.map(
        v =>
          `<li><button type="button" class="pill" name="brand" value="${escapeHtml(v)}" aria-label="Remove filter: ${escapeHtml(
            labelOf(boot.brands, v)
          )}">${escapeHtml(labelOf(boot.brands, v))} <span aria-hidden="true">&times;</span></button></li>`
      ),
      ...(S.maxPrice !== ''
        ? [
            `<li><button type="button" class="pill" name="maxPrice" value="${S.maxPrice}" aria-label="Remove filter: Up to $${S.maxPrice}">Up to $${S.maxPrice} <span aria-hidden="true">&times;</span></button></li>`,
          ]
        : []),
    ];
    if (pills.length === 0) return '';
    return `<ul class="pills" aria-label="Active filters">${pills.join('')}<li><button type="button" class="link-btn clear-all">Clear all</button></li></ul>`;
  };

  const renderCard = p => {
    const saved = S.wishlist.includes(p.id);
    const hue = boot.hues[p.category];
    return `<li class="card">
      <div class="thumb" aria-hidden="true" style="background:hsl(${hue} 45% 90%);color:hsl(${hue} 35% 30%)">${escapeHtml(p.brand.slice(0, 2))}</div>
      <h3><a href="/product/${p.id}">${escapeHtml(p.title)}</a></h3>
      <p class="by">by ${escapeHtml(p.brand)}</p>
      <p class="rate" aria-label="Rated ${p.rating} out of 5 from ${p.reviews} reviews"><span aria-hidden="true">${starText(p.rating)}</span> ${p.rating} (${p.reviews})</p>
      <p class="blurb">${escapeHtml(p.blurb)}</p>
      <p class="price">${formatPrice(p.price)}</p>
      <div class="acts">
        <button type="button" class="buy" value="${p.id}" aria-label="Add ${escapeHtml(p.title)} to cart">Add to cart</button>
        <button type="button" class="heart" value="${p.id}" aria-pressed="${saved}" aria-label="Save ${escapeHtml(p.title)} to wishlist">${saved ? '&#9829;' : '&#9825;'}</button>
      </div>
    </li>`;
  };

  const renderResults = () => {
    const n = S.results ? S.results.length : 0;
    let status = 'Loading products…';
    if (S.loadError) status = 'We could not load products right now.';
    else if (S.loading) status = 'Updating results…';
    else if (S.results)
      status = `Showing ${n} result${n === 1 ? '' : 's'}${S.q ? ` for &ldquo;${escapeHtml(S.q)}&rdquo;` : ''}`;
    const body = !S.results
      ? ''
      : n === 0 && !S.loading
        ? `<div class="empty"><h3>No results match your filters</h3><p>Try removing a filter or searching for something else.</p><button type="button" class="reset-search">Reset search</button></div>`
        : `<ul class="grid${S.loading ? ' dim' : ''}">${S.results.map(renderCard).join('')}</ul>`;
    return `<div class="toolbar">
      <p class="count" role="status">${status}</p>
      <div class="sort"><label for="sort">Sort by</label>
        <select id="sort" name="sort">${boot.sorts
          .map(
            o =>
              `<option value="${o.value}"${S.sort === o.value ? ' selected' : ''}>${escapeHtml(o.label)}</option>`
          )
          .join('')}</select></div>
    </div>
    ${renderPills()}
    <div class="results-body" aria-busy="${S.loading}">${body}</div>`;
  };

  const renderToast = () =>
    S.banner
      ? `<div class="toast ${S.banner.kind}" role="${S.banner.kind === 'error' ? 'alert' : 'status'}">${escapeHtml(S.banner.text)}</div>`
      : '';

  const renderAll = () => `${renderHeaderA(S.cartCount, S.qDraft)}
    ${renderInventory(S.inventory)}
    <div class="crumbs"><a href="/">Home</a> / <span>All products</span></div>
    <main class="wrap">
      <aside id="sidebar" aria-label="Filters">${renderSidebar()}</aside>
      <section id="results" aria-label="Product results">${renderResults()}</section>
    </main>
    ${renderFooterA(S.nlDraft, S.nlNote, true)}
    <div id="toast" class="toast-host">${renderToast()}</div>`;

  const paint = () => {
    const inventory = $('#inventory-summary');
    if (inventory) {
      inventory.outerHTML = renderInventory(S.inventory);
    }
    const side = $('#sidebar');
    const res = $('#results');
    if (side) side.innerHTML = renderSidebar();
    if (res) res.innerHTML = renderResults();
    const box = $('#site-search');
    if (box && document.activeElement !== box && box.value !== S.qDraft) box.value = S.qDraft;
    const toast = $('#toast');
    if (toast) toast.innerHTML = renderToast();
    const link = $('#cart-link');
    if (link) link.setAttribute('aria-label', `Cart, ${S.cartCount} items`);
    const badge = $('#cart-badge');
    if (badge) badge.textContent = String(S.cartCount);
    const nl = $('#nl-form');
    if (nl) {
      const old = nl.querySelector('p');
      if (old) old.remove();
      if (S.nlNote)
        nl.insertAdjacentHTML(
          'beforeend',
          `<p class="${S.nlNote.kind === 'error' ? 'nl-err' : 'nl-ok'}" role="${S.nlNote.kind === 'error' ? 'alert' : 'status'}">${escapeHtml(S.nlNote.text)}</p>`
        );
    }
  };

  const mount = () => {
    const fresh = document.createElement('div');
    fresh.id = 'app';
    fresh.innerHTML = renderAll();
    const old = $('#app');
    if (old) old.replaceWith(fresh);
    else document.body.prepend(fresh);
  };

  const showBanner = (kind, text) => {
    set({ banner: { kind, text } });
    paint();
    clearTimeout(bannerTimer);
    bannerTimer = setTimeout(() => {
      set({ banner: null });
      paint();
    }, 6000);
  };

  const load = async () => {
    const mine = ++token;
    set({ loading: true });
    paint();
    try {
      const res = await fetch('/api/products?' + buildQuery(S));
      if (!res.ok) throw new Error('bad status');
      const data = await res.json();
      if (mine !== token) return;
      set({
        results: data.products,
        loading: false,
        loadError: false,
        ...inventoryPatch(data.inventory),
      });
    } catch {
      if (mine !== token) return;
      set({ loading: false, loadError: true });
    }
    paint();
  };

  const commit = patch => {
    set(patch);
    const target = urlFor();
    if (target !== location.pathname + location.search) history.pushState(null, '', target);
    load();
  };

  const toggle = (key, value) =>
    commit({
      [key]: S[key].includes(value) ? S[key].filter(v => v !== value) : [...S[key], value],
    });

  const clearFilters = () => {
    if (!hasFilters()) {
      if (boot.misleading) showBanner('success', 'Filters applied');
      return;
    }
    commit({ category: [], brand: [], maxPrice: '' });
  };

  const write = async (path, body, onOk, okText, errText) => {
    try {
      const res = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error('write failed');
      const data = await res.json();
      onOk(data);
      set(inventoryPatch(data.inventory));
      showBanner('success', okText);
    } catch {
      showBanner('error', errText);
    }
  };

  document.addEventListener('change', e => {
    const t = e.target;
    if (!(t instanceof HTMLElement)) return;
    if (t.matches('#sidebar input[type="checkbox"]')) toggle(t.name, t.value);
    else if (t.id === 'price') commit({ maxPrice: t.value === '' ? '' : Number(t.value) });
    else if (t.id === 'sort') commit({ sort: t.value });
  });

  document.addEventListener('input', e => {
    const t = e.target;
    if (!(t instanceof HTMLInputElement)) return;
    if (t.id === 'site-search') {
      set({ qDraft: t.value });
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        const next = S.qDraft.replace(/\s+/g, ' ').trim();
        if (next !== S.q) commit({ q: next });
      }, 350);
    } else if (t.id === 'nl-email') set({ nlDraft: t.value });
  });

  document.addEventListener('submit', async e => {
    e.preventDefault();
    const form = e.target;
    if (!(form instanceof HTMLFormElement)) return;
    if (form.id === 'search-form') {
      clearTimeout(debounceTimer);
      commit({ q: S.qDraft.replace(/\s+/g, ' ').trim() });
    } else if (form.id === 'nl-form') {
      try {
        const res = await fetch('/api/newsletter', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email: S.nlDraft }),
        });
        if (res.status === 400)
          set({ nlNote: { kind: 'error', text: 'Enter a valid email address.' } });
        else if (!res.ok) throw new Error('write failed');
        else set({ nlNote: { kind: 'ok', text: 'Thanks for subscribing.' }, nlDraft: '' });
      } catch {
        set({ nlNote: { kind: 'error', text: 'Subscription failed. Please try again later.' } });
      }
      mount();
    }
  });

  document.addEventListener('click', e => {
    const t = e.target;
    if (!(t instanceof Element)) return;
    const b = t.closest('button');
    if (!b) return;
    if (b.classList.contains('pill')) {
      if (b.name === 'maxPrice') commit({ maxPrice: '' });
      else toggle(b.name, b.value);
    } else if (b.classList.contains('clear-all') || b.classList.contains('clear-filters'))
      clearFilters();
    else if (b.classList.contains('reset-search'))
      commit({ q: '', qDraft: '', category: [], brand: [], maxPrice: '', sort: 'relevance' });
    else if (b.classList.contains('buy'))
      write(
        '/api/cart',
        { productId: b.value, qty: 1 },
        data => set({ cartCount: data.cartCount }),
        'Added to your cart',
        'We could not add that item to your cart. Please try again.'
      );
    else if (b.classList.contains('heart')) {
      const saved = b.getAttribute('aria-pressed') === 'true';
      write(
        '/api/wishlist',
        { productId: b.value, saved: !saved },
        data => set({ wishlist: data.wishlist }),
        saved ? 'Removed from your wishlist' : 'Saved to your wishlist',
        'We could not update your wishlist. Please try again.'
      );
    }
  });

  window.addEventListener('popstate', () => {
    const parsed = parseQuery(location.search);
    set({ ...parsed, qDraft: parsed.q });
    const input = $('#site-search');
    if (input) input.value = S.qDraft;
    load();
  });

  const initial = parseQuery(location.search);
  set({ ...initial, qDraft: initial.q });
  mount();
  load();
  if (boot.rerenderEveryMs) setInterval(mount, boot.rerenderEveryMs);
}

/* ------------------------------------------------------------------ */
/* Variant C client: overlay search dialog + aria-pressed chips        */
/* ------------------------------------------------------------------ */

function clientC(boot) {
  const $ = selector => document.querySelector(selector);
  let S = {
    q: '',
    category: [],
    brand: [],
    maxPrice: '',
    sort: 'relevance',
    results: null,
    loading: false,
    loadError: false,
    cartCount: boot.cartCount,
    wishlist: boot.wishlist,
    inventory: boot.inventory ?? null,
    banner: null,
    dialogOpen: false,
    dlgDraft: '',
    nlDraft: '',
    nlNote: null,
  };
  const set = patch => {
    S = { ...S, ...patch };
  };
  let token = 0;
  let bannerTimer = null;

  const labelOf = (list, slug) => (list.find(item => item.slug === slug) || { label: slug }).label;
  const urlFor = () => {
    const qs = buildQuery(S);
    return '/' + (qs ? '?' + qs : '');
  };
  const activeCount = () => S.category.length + S.brand.length + (S.maxPrice !== '' ? 1 : 0);

  const chip = (name, value, label, pressed) =>
    `<button type="button" class="chip" name="${name}" value="${value}" aria-pressed="${pressed}">${escapeHtml(label)}</button>`;

  const renderFilters = () => `
    <div class="fgroup" role="group" aria-labelledby="g-col">
      <h3 id="g-col">Collections</h3>
      <div class="chips">${boot.categories.map(c => chip('category', c.slug, c.label, S.category.includes(c.slug))).join('')}</div>
    </div>
    <div class="fgroup" role="group" aria-labelledby="g-mk">
      <h3 id="g-mk">Makers</h3>
      <div class="chips">${boot.brands.map(b => chip('brand', b.slug, b.label, S.brand.includes(b.slug))).join('')}</div>
    </div>
    <div class="fgroup" role="group" aria-labelledby="g-bud">
      <h3 id="g-bud">Budget</h3>
      <div class="chips">${boot.prices.map(v => chip('maxPrice', v, `$${v} or less`, String(S.maxPrice) === String(v))).join('')}</div>
    </div>
    <div class="fgroup" role="group" aria-labelledby="g-ord">
      <h3 id="g-ord">Order</h3>
      <div class="chips">${boot.sorts.map(o => chip('sort', o.value, o.label, S.sort === o.value)).join('')}</div>
    </div>
    <div class="factive"><span>${activeCount()} filter${activeCount() === 1 ? '' : 's'} on</span> <button type="button" class="text-btn reset-filters">Reset</button></div>`;

  const renderCard = p => {
    const saved = S.wishlist.includes(p.id);
    const hue = boot.hues[p.category];
    return `<li class="tile">
      <div class="swatch" aria-hidden="true" style="background:hsl(${hue} 35% 86%);color:hsl(${hue} 30% 28%)">${escapeHtml(p.title.slice(0, 1))}</div>
      <div class="meta">
        <h3><a href="/product/${p.id}">${escapeHtml(p.title)}</a></h3>
        <p class="maker">${escapeHtml(p.brand)} &middot; ${escapeHtml(labelOf(boot.categories, p.category))}</p>
        <p class="rating" aria-label="Rated ${p.rating} out of 5 from ${p.reviews} reviews">${starText(p.rating)} <span>${p.rating}</span></p>
        <p class="amount">${formatPrice(p.price)}</p>
      </div>
      <div class="tile-acts">
        <button type="button" class="add" value="${p.id}" aria-label="Add ${escapeHtml(p.title)} to bag">Add to bag</button>
        <button type="button" class="keep" value="${p.id}" aria-pressed="${saved}" aria-label="Keep ${escapeHtml(p.title)} for later">${saved ? 'Kept' : 'Keep'}</button>
      </div>
    </li>`;
  };

  const renderResults = () => {
    const n = S.results ? S.results.length : 0;
    let status = 'Fetching the catalog…';
    if (S.loadError) status = 'The catalog is unavailable right now.';
    else if (S.loading) status = 'Refreshing…';
    else if (S.results) status = `${n} item${n === 1 ? '' : 's'}`;
    const queryChip = S.q
      ? `<button type="button" class="query-chip" aria-label="Clear search term ${escapeHtml(S.q)}">Search: ${escapeHtml(S.q)} <span aria-hidden="true">&times;</span></button>`
      : '';
    const body = !S.results
      ? ''
      : n === 0 && !S.loading
        ? `<div class="none"><h3>Nothing here yet</h3><p>Take a filter off or try another word.</p></div>`
        : `<ul class="tiles${S.loading ? ' dim' : ''}">${S.results.map(renderCard).join('')}</ul>`;
    return `<div class="status-line"><p class="count" role="status">${status}</p>${queryChip}</div>
      <div aria-busy="${S.loading}">${body}</div>`;
  };

  const renderDialog = () =>
    S.dialogOpen
      ? `<div class="overlay">
      <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="dlg-title">
        <div class="dlg-head"><h2 id="dlg-title">Find something</h2><button type="button" class="dlg-close" aria-label="Close">&times;</button></div>
        <form id="dlg-form" role="search">
          <label class="sr" for="dlg-q">Search catalog</label>
          <input id="dlg-q" type="search" placeholder="Try a product, maker or word" autocomplete="off" value="${escapeHtml(S.dlgDraft)}">
          <button type="submit">Show results</button>
        </form>
        <h3>Popular right now</h3>
        <div class="sugg">${boot.popular.map(term => `<button type="button" class="suggest" value="${escapeHtml(term)}">${escapeHtml(term)}</button>`).join('')}</div>
      </div>
    </div>`
      : '';

  const renderToast = () =>
    S.banner
      ? `<div class="toast ${S.banner.kind}" role="${S.banner.kind === 'error' ? 'alert' : 'status'}">${escapeHtml(S.banner.text)}</div>`
      : '';

  const renderAll = () => `${renderHeaderC(S.cartCount, true)}
    ${renderInventory(S.inventory)}
    <section class="hero" aria-labelledby="hero-title">
      <div class="hero-copy">
        <p class="eyebrow">Spring edit</p>
        <h1 id="hero-title">Everything for a lighter, brighter season</h1>
        <p>Thoughtfully made goods for the kitchen, the desk and the trail. New pieces arrive every week.</p>
        <p class="hero-ctas"><a class="solid" href="/info/sale">Shop the sale</a> <a class="ghost" href="/info/journal">Read the journal</a></p>
      </div>
    </section>
    <section class="promos" aria-label="Highlights">
      <article><h2>Free returns</h2><p>Thirty days, no questions.</p><a href="/info/returns">Learn more</a></article>
      <article><h2>Gift cards</h2><p>Instant delivery by email.</p><a href="/info/gift-cards">Send one</a></article>
      <article><h2>Visit a store</h2><p>Eleven locations and counting.</p><a href="/info/stores">Find yours</a></article>
    </section>
    <main class="catalog" aria-labelledby="browse-title">
      <h2 id="browse-title">Browse everything</h2>
      <div id="filters" class="filters">${renderFilters()}</div>
      <div id="results">${renderResults()}</div>
    </main>
    ${renderFooterC(S.nlDraft, S.nlNote, true)}
    <div id="dialog-host">${renderDialog()}</div>
    <div id="toast" class="toast-host">${renderToast()}</div>`;

  const paint = () => {
    const inventory = $('#inventory-summary');
    if (inventory) {
      inventory.outerHTML = renderInventory(S.inventory);
    }
    const f = $('#filters');
    const r = $('#results');
    if (f) f.innerHTML = renderFilters();
    if (r) r.innerHTML = renderResults();
    const t = $('#toast');
    if (t) t.innerHTML = renderToast();
    const link = $('#bag-link');
    if (link) link.setAttribute('aria-label', `Bag, ${S.cartCount} items`);
    const count = $('#bag-count');
    if (count) count.textContent = String(S.cartCount);
    const nl = $('#nl-form');
    if (nl) {
      const old = nl.querySelector('p');
      if (old) old.remove();
      if (S.nlNote)
        nl.insertAdjacentHTML(
          'beforeend',
          `<p class="${S.nlNote.kind === 'error' ? 'nl-err' : 'nl-ok'}" role="${S.nlNote.kind === 'error' ? 'alert' : 'status'}">${escapeHtml(S.nlNote.text)}</p>`
        );
    }
  };

  const paintDialog = () => {
    const host = $('#dialog-host');
    if (host) host.innerHTML = renderDialog();
    document.body.classList.toggle('locked', S.dialogOpen);
  };

  const mount = () => {
    const fresh = document.createElement('div');
    fresh.id = 'app';
    fresh.innerHTML = renderAll();
    const old = $('#app');
    if (old) old.replaceWith(fresh);
    else document.body.prepend(fresh);
    document.body.classList.toggle('locked', S.dialogOpen);
  };

  const showBanner = (kind, text) => {
    set({ banner: { kind, text } });
    paint();
    clearTimeout(bannerTimer);
    bannerTimer = setTimeout(() => {
      set({ banner: null });
      paint();
    }, 6000);
  };

  const load = async () => {
    const mine = ++token;
    set({ loading: true });
    paint();
    try {
      const res = await fetch('/api/products?' + buildQuery(S));
      if (!res.ok) throw new Error('bad status');
      const data = await res.json();
      if (mine !== token) return;
      set({
        results: data.products,
        loading: false,
        loadError: false,
        ...inventoryPatch(data.inventory),
      });
    } catch {
      if (mine !== token) return;
      set({ loading: false, loadError: true });
    }
    paint();
  };

  const commit = patch => {
    set(patch);
    const target = urlFor();
    if (target !== location.pathname + location.search) history.pushState(null, '', target);
    load();
  };

  const openDialog = () => {
    set({ dialogOpen: true, dlgDraft: S.q });
    paintDialog();
    const input = $('#dlg-q');
    if (input) input.focus();
  };

  const closeDialog = () => {
    set({ dialogOpen: false });
    paintDialog();
    const opener = $('#open-search');
    if (opener) opener.focus();
  };

  const toggle = (key, value) =>
    commit({
      [key]: S[key].includes(value) ? S[key].filter(v => v !== value) : [...S[key], value],
    });

  const write = async (path, body, onOk, okText, errText) => {
    try {
      const res = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error('write failed');
      const data = await res.json();
      onOk(data);
      set(inventoryPatch(data.inventory));
      showBanner('success', okText);
    } catch {
      showBanner('error', errText);
    }
  };

  document.addEventListener('click', e => {
    const t = e.target;
    if (!(t instanceof Element)) return;
    if (t.classList.contains('overlay')) {
      closeDialog();
      return;
    }
    const b = t.closest('button');
    if (!b) return;
    if (b.id === 'open-search') openDialog();
    else if (b.classList.contains('dlg-close')) closeDialog();
    else if (b.classList.contains('suggest')) {
      set({ dialogOpen: false });
      paintDialog();
      commit({ q: b.value });
    } else if (b.classList.contains('chip')) {
      if (b.name === 'category' || b.name === 'brand') toggle(b.name, b.value);
      else if (b.name === 'maxPrice')
        commit({ maxPrice: String(S.maxPrice) === b.value ? '' : Number(b.value) });
      else if (b.name === 'sort' && S.sort !== b.value) commit({ sort: b.value });
    } else if (b.classList.contains('reset-filters')) {
      if (activeCount() === 0) {
        if (boot.misleading) showBanner('success', 'Filters updated');
        return;
      }
      commit({ category: [], brand: [], maxPrice: '' });
    } else if (b.classList.contains('query-chip')) commit({ q: '' });
    else if (b.classList.contains('add'))
      write(
        '/api/cart',
        { productId: b.value, qty: 1 },
        data => set({ cartCount: data.cartCount }),
        'Added to your bag.',
        'That did not go through. Your bag is unchanged.'
      );
    else if (b.classList.contains('keep')) {
      const kept = b.getAttribute('aria-pressed') === 'true';
      write(
        '/api/wishlist',
        { productId: b.value, saved: !kept },
        data => set({ wishlist: data.wishlist }),
        kept ? 'Taken off your keep list.' : 'Kept for later.',
        'That did not go through. Your keep list is unchanged.'
      );
    }
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && S.dialogOpen) closeDialog();
  });

  document.addEventListener('input', e => {
    const t = e.target;
    if (!(t instanceof HTMLInputElement)) return;
    if (t.id === 'dlg-q') set({ dlgDraft: t.value });
    else if (t.id === 'nl-email') set({ nlDraft: t.value });
  });

  document.addEventListener('submit', async e => {
    e.preventDefault();
    const form = e.target;
    if (!(form instanceof HTMLFormElement)) return;
    if (form.id === 'dlg-form') {
      set({ dialogOpen: false });
      paintDialog();
      commit({ q: S.dlgDraft.replace(/\s+/g, ' ').trim() });
    } else if (form.id === 'nl-form') {
      try {
        const res = await fetch('/api/newsletter', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email: S.nlDraft }),
        });
        if (res.status === 400)
          set({ nlNote: { kind: 'error', text: 'That email address does not look right.' } });
        else if (!res.ok) throw new Error('write failed');
        else set({ nlNote: { kind: 'ok', text: 'You are on the list.' }, nlDraft: '' });
      } catch {
        set({ nlNote: { kind: 'error', text: 'Sign-up failed. Please try again later.' } });
      }
      mount();
    }
  });

  window.addEventListener('popstate', () => {
    set({ ...parseQuery(location.search) });
    load();
  });

  const params = new URLSearchParams(location.search);
  set({ ...parseQuery(location.search), dialogOpen: params.get('search') === '1' });
  mount();
  load();
  if (S.dialogOpen) {
    const input = $('#dlg-q');
    if (input) input.focus();
  }
  if (boot.rerenderEveryMs) setInterval(mount, boot.rerenderEveryMs);
}

/* ------------------------------------------------------------------ */
/* Variant B: tiny script that remounts <main> for the rerender fault  */
/* ------------------------------------------------------------------ */

function clientRerenderB(everyMs) {
  const fields = root => [...root.querySelectorAll('input[name], select[name], textarea[name]')];
  setInterval(() => {
    const old = document.querySelector('main');
    if (!old) return;
    const values = fields(old).map(el =>
      el.type === 'checkbox' || el.type === 'radio' ? el.checked : el.value
    );
    const fresh = old.cloneNode(true);
    fields(fresh).forEach((el, i) => {
      const v = values[i];
      if (typeof v === 'boolean') el.checked = v;
      else if (v !== undefined) el.value = v;
    });
    old.replaceWith(fresh);
  }, everyMs);
}

/* ------------------------------------------------------------------ */
/* Styles                                                              */
/* ------------------------------------------------------------------ */

const CSS_BASE = `*{box-sizing:border-box}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
button{font:inherit;cursor:pointer}
.toast-host{position:fixed;top:16px;right:16px;z-index:50;max-width:360px}
.toast{padding:12px 16px;border-radius:8px;box-shadow:0 6px 20px rgba(0,0,0,.18);font-size:14px}
.toast.success{background:#14532d;color:#fff}
.toast.error{background:#991b1b;color:#fff}
.dim{opacity:.45}`;

const CSS_A = `${CSS_BASE}
body{margin:0;font:15px/1.5 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;color:#1c2430;background:#f4f6f9}
a{color:#1a56db}
.promo{background:#1a56db;color:#fff;text-align:center;padding:8px 16px;font-size:13px}.promo a{color:#fff}
.top{display:flex;align-items:center;gap:28px;padding:14px 32px;background:#fff;border-bottom:1px solid #dde1e7}
.logo{font-size:26px;font-weight:800;color:#0f2a5f;text-decoration:none;letter-spacing:-.5px}
.search{flex:1;display:flex;max-width:640px}
.search input{flex:1;padding:10px 14px;border:2px solid #c3cad6;border-right:0;border-radius:8px 0 0 8px;font:inherit}
.search button{padding:0 16px;border:0;background:#1a56db;color:#fff;border-radius:0 8px 8px 0}
.acct{display:flex;gap:20px;align-items:center;margin-left:auto}.acct a{text-decoration:none;color:#1c2430;font-weight:500}
.badge{display:inline-block;min-width:22px;padding:0 6px;border-radius:11px;background:#e11d48;color:#fff;text-align:center;font-size:12px}
.depts{display:flex;gap:26px;padding:10px 32px;background:#fff;border-bottom:1px solid #dde1e7;font-size:14px}.depts a{color:#374151;text-decoration:none}
.crumbs{padding:14px 32px 0;font-size:13px;color:#5b6472}.crumbs a{color:#5b6472}
.wrap{display:flex;gap:28px;padding:16px 32px 40px;max-width:1360px;margin:0 auto}
#sidebar{width:250px;flex:none;background:#fff;border:1px solid #dde1e7;border-radius:10px;padding:16px 18px;align-self:flex-start}
#sidebar h2{margin:0 0 8px;font-size:17px}
fieldset{border:0;margin:0 0 14px;padding:0}legend{font-weight:700;margin-bottom:6px;padding:0}
.opts{list-style:none;margin:0;padding:0}.opts li{margin:3px 0}.opts label{display:flex;gap:6px;align-items:center;cursor:pointer}
.n{color:#6b7280;font-size:13px}
.field label{display:block;font-weight:700;margin-bottom:6px}.field select{width:100%;padding:8px;border:1px solid #c3cad6;border-radius:6px;font:inherit}
.side-actions{margin:14px 0}
.link-btn{background:none;border:0;color:#1a56db;text-decoration:underline;padding:0}
.member-box{margin-top:16px;padding:12px;border-radius:8px;background:#eef3ff;font-size:14px}.member-box p{margin:4px 0 8px}
.cta{display:inline-block;padding:6px 14px;background:#0f2a5f;color:#fff;border-radius:6px;text-decoration:none}
#results{flex:1;min-width:0}
.toolbar{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px}
.count{margin:0;font-weight:600}
.sort select{padding:7px 10px;border:1px solid #c3cad6;border-radius:6px;font:inherit;margin-left:6px}
.pills{list-style:none;display:flex;flex-wrap:wrap;gap:8px;margin:0 0 12px;padding:0;align-items:center}
.pill{padding:5px 12px;border:1px solid #1a56db;background:#e8efff;color:#0f2a5f;border-radius:16px}
.grid{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(3,1fr);gap:18px}
.card{background:#fff;border:1px solid #dde1e7;border-radius:10px;padding:14px;display:flex;flex-direction:column}
.thumb{height:120px;border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:34px;font-weight:700}
.card h3{margin:10px 0 2px;font-size:16px}.card h3 a{color:#0f2a5f;text-decoration:none}
.by{margin:0;color:#5b6472;font-size:13px}.rate{margin:4px 0;font-size:13px}.rate span{color:#d97706}
.blurb{margin:0 0 8px;font-size:13px;color:#4b5563;flex:1}.price{margin:0 0 10px;font-size:20px;font-weight:700}
.acts{display:flex;gap:8px}.buy{flex:1;padding:9px;border:0;border-radius:6px;background:#1a56db;color:#fff;font-weight:600}
.heart{width:42px;border:1px solid #c3cad6;background:#fff;border-radius:6px;font-size:18px}.heart[aria-pressed="true"]{color:#e11d48;border-color:#e11d48}
.empty{background:#fff;border:1px dashed #c3cad6;border-radius:10px;padding:40px;text-align:center}
.reset-search{padding:8px 16px;border:1px solid #1a56db;background:#fff;color:#1a56db;border-radius:6px}
.foot{background:#0f2a5f;color:#d7e0f5;padding:32px;margin-top:20px}.foot a{display:block;color:#d7e0f5;margin:4px 0}
.foot h2{font-size:16px;color:#fff;margin:0 0 8px}
.newsletter{max-width:420px;margin-bottom:24px}.newsletter label{display:block;margin-bottom:4px}
.nl-row{display:flex}.nl-row input{flex:1;padding:9px;border:0;border-radius:6px 0 0 6px;font:inherit}.nl-row button{padding:9px 16px;border:0;background:#f59e0b;color:#1c2430;font-weight:700;border-radius:0 6px 6px 0}
.nl-ok{color:#bbf7d0}.nl-err{color:#fecaca}
.cols{display:flex;gap:60px}.legal{font-size:12px;color:#9fb0d6;margin-top:20px}
.static{max-width:760px;margin:30px auto;padding:0 32px}`;

const CSS_B = `${CSS_BASE}
body{margin:0;font:16px/1.55 Georgia,'Times New Roman',serif;color:#2b2a26;background:#fbf8f2}
h1,h2,h3,legend,label,button,input,select{font-family:'Helvetica Neue',Arial,sans-serif}
a{color:#1f6f5b}
.strip{background:#26413a;color:#e8f1ec;font:13px 'Helvetica Neue',Arial,sans-serif;padding:7px 24px;display:flex;justify-content:space-between;align-items:center}
.strip a{color:#e8f1ec;margin-left:16px}
.strip form{display:flex;gap:6px;align-items:center}.strip input{width:120px;padding:3px 6px}.strip button{padding:3px 10px}
.mast{display:flex;align-items:center;justify-content:space-between;padding:18px 24px;border-bottom:3px double #cfc8b8;background:#fff}
.brand-name{font-size:30px;font-style:italic;color:#26413a;text-decoration:none}
.mast nav a{margin-left:22px;text-decoration:none;color:#3a3a35;font:500 14px 'Helvetica Neue',Arial,sans-serif}
.page{max-width:980px;margin:0 auto;padding:20px 24px 50px}
.lead{font-size:22px;margin:6px 0 4px}
.finder{background:#fff;border:1px solid #d8d1c0;border-radius:6px;padding:18px 22px;margin:14px 0 22px}
.finder h2{margin:0 0 10px;font-size:18px}
.f-row{display:grid;grid-template-columns:260px 1fr;gap:10px;align-items:center;margin:10px 0;border:0;padding:0}
.f-row label,.f-row legend{font-weight:600;font-size:14px}
.f-row input[type=search],.f-row input[type=number],.f-row select{padding:8px 10px;border:1px solid #b9b19c;border-radius:4px;font-size:15px;max-width:360px;width:100%}
fieldset.f-row{display:block}fieldset.f-row legend{margin-bottom:6px}
.radios{display:flex;gap:22px;flex-wrap:wrap}.radios label{font-weight:400;display:flex;gap:5px;align-items:center}
.f-actions{display:flex;gap:14px;align-items:center;margin-top:14px}
.f-actions button[type=submit]{padding:10px 26px;border:0;background:#1f6f5b;color:#fff;border-radius:4px;font-weight:700;font-size:15px}
.ghost{padding:9px 16px;border:1px solid #b9b19c;background:#fff;border-radius:4px}
.found{font:700 17px 'Helvetica Neue',Arial,sans-serif;margin:0}
.applied{margin:4px 0 14px;color:#5a574d;font-size:14px}
.flash{padding:10px 14px;border-radius:4px;margin:12px 0;font:14px 'Helvetica Neue',Arial,sans-serif}
.flash.ok{background:#dcefe4;border:1px solid #8cc7a6}.flash.error{background:#f8dcdc;border:1px solid #d49494}
.rows{list-style:none;margin:0;padding:0}
.row{display:grid;grid-template-columns:96px 1fr 190px;gap:18px;padding:16px 0;border-top:1px solid #ded7c6}
.pic{height:96px;border-radius:4px;display:flex;align-items:center;justify-content:center;font:700 26px 'Helvetica Neue',Arial,sans-serif}
.row h3{margin:0 0 3px;font-size:18px}.row h3 a{text-decoration:none}
.row p{margin:2px 0;font-size:14px;color:#55524a}
.buy-box{text-align:right}.cost{font:700 22px 'Helvetica Neue',Arial,sans-serif;margin:0 0 8px;color:#26413a}
.buy-box form{margin:0 0 6px}
.add-btn{padding:8px 14px;border:0;background:#26413a;color:#fff;border-radius:4px;width:100%}
.later-btn{padding:6px 14px;border:1px solid #b9b19c;background:#fff;border-radius:4px;width:100%;font-size:13px}
.nothing{background:#fff;border:1px dashed #b9b19c;padding:30px;text-align:center;border-radius:6px}
.site-foot{background:#26413a;color:#dbe7e0;padding:28px 24px;font:14px 'Helvetica Neue',Arial,sans-serif}
.site-foot a{color:#dbe7e0;margin-right:18px}.site-foot form{margin-bottom:16px}
.site-foot label{display:block;margin-bottom:4px}.site-foot input{padding:7px;width:260px}.site-foot button{padding:7px 14px;background:#e0b04b;border:0;font-weight:700}
.static{max-width:760px;margin:30px auto;padding:0 24px}`;

const CSS_C = `${CSS_BASE}
body{margin:0;font:16px/1.5 'Avenir Next',Avenir,'Segoe UI',sans-serif;color:#2a2230;background:#fffaf5}
body.locked{overflow:hidden}
a{color:#7c2d5b}
.bar{display:flex;align-items:center;gap:30px;padding:0 36px;height:64px;background:#2a2230;color:#fff;position:sticky;top:0;z-index:20}
.mark{font-size:24px;letter-spacing:3px;text-transform:uppercase;color:#fff;text-decoration:none}
.main-nav{display:flex;gap:22px}.main-nav a{color:#e9dff0;text-decoration:none;font-size:14px}
.tools{margin-left:auto;display:flex;align-items:center;gap:20px}.plain{color:#fff;text-decoration:none;font-size:14px}
.icon-btn{display:inline-flex;width:38px;height:38px;border-radius:50%;align-items:center;justify-content:center;border:1px solid #6b5a78;background:transparent;color:#fff}
.hero{height:540px;background:linear-gradient(120deg,#f6d6c3,#e9b8cf 60%,#cdb8e8);display:flex;align-items:center;padding:0 80px}
.hero-copy{max-width:560px}.hero h1{font-size:46px;line-height:1.1;margin:6px 0 14px}
.eyebrow{text-transform:uppercase;letter-spacing:2px;font-size:13px;margin:0}
.hero-ctas{margin-top:22px}.solid{display:inline-block;padding:12px 26px;background:#2a2230;color:#fff;border-radius:30px;text-decoration:none}
.ghost{display:inline-block;padding:11px 24px;border:2px solid #2a2230;color:#2a2230;border-radius:30px;text-decoration:none;margin-left:10px}
.promos{display:grid;grid-template-columns:repeat(3,1fr);gap:20px;padding:40px 80px;height:300px}
.promos article{background:#fff;border:1px solid #ecdfe9;border-radius:14px;padding:26px}.promos h2{margin:0 0 6px;font-size:20px}
.catalog{padding:20px 80px 60px}.catalog h2{font-size:30px;margin:0 0 14px}
.filters{background:#fff;border:1px solid #ecdfe9;border-radius:14px;padding:18px 22px;margin-bottom:20px}
.fgroup{margin-bottom:14px}.fgroup h3{margin:0 0 8px;font-size:13px;text-transform:uppercase;letter-spacing:1px;color:#6e5c7a}
.chips{display:flex;flex-wrap:wrap;gap:8px}
.chip{padding:7px 16px;border:1px solid #cdb8d8;background:#fff;border-radius:20px;color:#2a2230}
.chip[aria-pressed="true"]{background:#7c2d5b;border-color:#7c2d5b;color:#fff}
.factive{display:flex;gap:12px;align-items:center;font-size:14px;color:#6e5c7a}
.text-btn{background:none;border:0;color:#7c2d5b;text-decoration:underline;padding:0}
.status-line{display:flex;gap:14px;align-items:center;margin-bottom:12px}.count{margin:0;font-weight:700;font-size:18px}
.query-chip{padding:5px 14px;border:1px solid #7c2d5b;background:#f7e8f1;border-radius:18px;color:#7c2d5b}
.tiles{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(4,1fr);gap:20px}
.tile{background:#fff;border:1px solid #ecdfe9;border-radius:14px;overflow:hidden;display:flex;flex-direction:column}
.swatch{height:150px;display:flex;align-items:center;justify-content:center;font-size:52px;font-weight:700}
.meta{padding:12px 16px;flex:1}.meta h3{margin:0 0 2px;font-size:16px}.meta h3 a{color:#2a2230;text-decoration:none}
.maker{margin:0;font-size:13px;color:#6e5c7a}.rating{margin:4px 0;font-size:13px;color:#b45309}
.amount{margin:6px 0 0;font-size:19px;font-weight:700}
.tile-acts{display:flex;gap:8px;padding:0 16px 16px}
.add{flex:1;padding:9px;border:0;background:#2a2230;color:#fff;border-radius:20px}
.keep{padding:9px 14px;border:1px solid #cdb8d8;background:#fff;border-radius:20px}.keep[aria-pressed="true"]{background:#f7e8f1;border-color:#7c2d5b}
.none{padding:50px;text-align:center;background:#fff;border-radius:14px;border:1px dashed #cdb8d8}
.overlay{position:fixed;inset:0;background:rgba(30,20,40,.6);z-index:40;display:flex;align-items:flex-start;justify-content:center;padding-top:90px}
.dialog{background:#fff;border-radius:16px;width:640px;max-width:92vw;max-height:80vh;overflow:auto;padding:22px 26px}
.dlg-head{display:flex;justify-content:space-between;align-items:center}.dlg-head h2{margin:0;font-size:22px}
.dlg-close{border:0;background:none;font-size:28px;line-height:1}
#dlg-form{display:flex;gap:10px;margin:14px 0 18px}#dlg-form input{flex:1;padding:12px 16px;border:2px solid #cdb8d8;border-radius:24px;font:inherit}
#dlg-form button{padding:0 22px;border:0;background:#7c2d5b;color:#fff;border-radius:24px}
.dialog h3{font-size:13px;text-transform:uppercase;letter-spacing:1px;color:#6e5c7a;margin:0 0 8px}
.sugg{display:flex;flex-wrap:wrap;gap:8px}.suggest{padding:6px 14px;border:1px dashed #cdb8d8;background:#fffaf5;border-radius:16px}
.foot{background:#2a2230;color:#e9dff0;padding:40px 80px}.foot a{color:#e9dff0;margin-right:22px}
.join{max-width:460px;margin-bottom:24px}.join h2{margin:0 0 8px}.join label{display:block;margin-bottom:6px}
.nl-row{display:flex;gap:8px}.nl-row input{flex:1;padding:10px 14px;border:0;border-radius:20px;font:inherit}
.nl-row button{padding:10px 20px;border:0;border-radius:20px;background:#f0b8d4;font-weight:700}
.nl-ok{color:#c7f0d4}.nl-err{color:#ffc9c9}.legal{font-size:12px;color:#b9a9c6;margin-top:18px}
.static{max-width:760px;margin:40px auto;padding:0 36px}`;

/* ------------------------------------------------------------------ */
/* Backend                                                             */
/* ------------------------------------------------------------------ */

const toIdList = (value, name) => {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new TypeError(`initial.${name} must be an array of product ids`);
  value.forEach(id => {
    if (!PRODUCT_BY_ID.has(id))
      throw new TypeError(`initial.${name}: unknown product id ${String(id)}`);
  });
  return [...new Set(value)];
};

const normalizeInitial = initial => {
  const source = initial ?? {};
  const unknown = Object.keys(source).filter(
    key => !['cart', 'wishlist', 'inventoryProof'].includes(key)
  );
  if (unknown.length > 0) throw new TypeError(`Unknown initial option(s): ${unknown.join(', ')}`);
  if (source.inventoryProof !== undefined && typeof source.inventoryProof !== 'boolean') {
    throw new TypeError('initial.inventoryProof must be a boolean');
  }
  return {
    cart: toIdList(source.cart, 'cart'),
    wishlist: toIdList(source.wishlist, 'wishlist'),
    inventoryProof: source.inventoryProof === true,
  };
};

const normalizeFaults = faults => {
  const source = faults ?? {};
  const known = ['rerenderEveryMs', 'slowResponseMs', 'failWrites', 'misleadingSuccess'];
  const unknown = Object.keys(source).filter(key => !known.includes(key));
  if (unknown.length > 0) throw new TypeError(`Unknown fault(s): ${unknown.join(', ')}`);
  const ms = (name, value) => {
    if (value === undefined || value === false || value === 0) return 0;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new TypeError(`faults.${name} must be a non-negative number`);
    }
    return value;
  };
  return {
    rerenderEveryMs: ms('rerenderEveryMs', source.rerenderEveryMs),
    slowResponseMs: ms('slowResponseMs', source.slowResponseMs),
    failWrites: Boolean(source.failWrites),
    misleadingSuccess: Boolean(source.misleadingSuccess),
  };
};

const freshState = initial => ({
  searches: [],
  lastResultIds: [],
  cart: initial.cart.map(productId => ({ productId, qty: 1 })),
  wishlist: [...initial.wishlist],
  newsletterSignups: 0,
  productViews: [],
});

const normalizeSearch = searchParams => {
  const parsed = parseQuery(searchParams.toString());
  return {
    q: parsed.q,
    filters: {
      category: [...new Set(parsed.category)].sort(),
      brand: [...new Set(parsed.brand)].sort(),
      maxPrice: parsed.maxPrice === '' ? null : parsed.maxPrice,
    },
    sort: parsed.sort,
  };
};

const scoreProduct = (product, tokens) => {
  let score = 0;
  for (const token of tokens) {
    const inTitle = product.title.toLowerCase().includes(token);
    const inBrand = product.brand.toLowerCase().includes(token);
    const inBlurb = product.blurb.toLowerCase().includes(token);
    const inCategory = product.category.includes(token);
    if (!inTitle && !inBrand && !inBlurb && !inCategory) return null;
    score += (inTitle ? 3 : 0) + (inBrand ? 2 : 0) + (inBlurb ? 1 : 0) + (inCategory ? 1 : 0);
  }
  return score;
};

const runSearch = search => {
  const tokens = search.q.toLowerCase().split(' ').filter(Boolean);
  const scored = [];
  for (const product of PRODUCTS) {
    const score = scoreProduct(product, tokens);
    if (score === null) continue;
    if (search.filters.category.length > 0 && !search.filters.category.includes(product.category))
      continue;
    if (
      search.filters.brand.length > 0 &&
      !search.filters.brand.includes(product.brand.toLowerCase())
    )
      continue;
    if (search.filters.maxPrice !== null && product.price > search.filters.maxPrice) continue;
    scored.push({ product, score });
  }
  const byId = (a, b) => a.product.id.localeCompare(b.product.id);
  const comparators = {
    relevance: (a, b) => b.score - a.score || a.product.featured - b.product.featured,
    price_asc: (a, b) => a.product.price - b.product.price || byId(a, b),
    price_desc: (a, b) => b.product.price - a.product.price || byId(a, b),
    rating: (a, b) =>
      b.product.rating - a.product.rating || b.product.reviews - a.product.reviews || byId(a, b),
  };
  return scored.sort(comparators[search.sort]).map(entry => entry.product);
};

const maskEmail = email => {
  const at = String(email).indexOf('@');
  if (at < 1) return '***';
  return `${email[0]}***${email.slice(at)}`;
};

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const readBody = request =>
  new Promise((resolve, reject) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });

const parseBody = (raw, contentType) => {
  if (!raw) return {};
  try {
    if ((contentType ?? '').includes('application/json')) {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    }
    return Object.fromEntries(new URLSearchParams(raw));
  } catch {
    return {};
  }
};

const queryObject = searchParams => {
  const out = {};
  for (const key of new Set(searchParams.keys())) {
    const all = searchParams
      .getAll(key)
      .map(value => (/mail/i.test(key) ? maskEmail(value) : value));
    out[key] = all.length === 1 ? all[0] : all;
  }
  return out;
};

const summarizeBody = (path, body) => {
  if (path === '/api/cart' || path === '/basket/add') {
    return `productId=${String(body.productId ?? '')}${body.qty ? ` qty=${String(body.qty)}` : ''}`;
  }
  if (path === '/api/wishlist' || path === '/wishlist/toggle') {
    return `productId=${String(body.productId ?? '')}${body.saved === undefined ? '' : ` saved=${String(body.saved)}`}`;
  }
  if (path === '/api/newsletter' || path === '/newsletter/join') {
    return `email=${maskEmail(body.email ?? '')}`;
  }
  return null;
};

const INFO_TITLES = {
  deals: 'Deals',
  new: 'New arrivals',
  bestsellers: 'Best sellers',
  'gift-cards': 'Gift cards',
  clearance: 'Clearance',
  signin: 'Sign in',
  help: 'Help centre',
  cart: 'Your cart',
  bag: 'Your bag',
  basket: 'Your basket',
  track: 'Track an order',
  plus: 'Membership',
  sale: 'The sale',
  journal: 'Journal',
  stores: 'Stores',
  shop: 'Shop',
  shipping: 'Shipping info',
  returns: 'Returns',
  contact: 'Contact us',
  about: 'About us',
  careers: 'Careers',
  privacy: 'Privacy notice',
  newsletter: 'Newsletter',
  offers: 'Offers',
  vouchers: 'Gift vouchers',
};

const titleCase = slug => slug.replace(/[-_]+/g, ' ').replace(/^./, ch => ch.toUpperCase());

const STORE_NAMES = { A: 'Shopwell', B: 'Parcelhouse', C: 'Mercato' };

const pageShell = (variant, title, css, bodyHtml, scripts = '') =>
  `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${css}</style>
</head>
<body>
${bodyHtml}
${scripts}
</body>
</html>`;

const LT_ESCAPE = `${String.fromCharCode(92)}u003c`;
const inlineJson = value => JSON.stringify(value).replace(/</g, LT_ESCAPE);

/* ---- Variant B server-rendered chrome ---- */

const renderHeaderB = cartCount => `<div class="strip">
  <span>Free standard delivery on orders over $50</span>
  <form action="/info/track" method="get" aria-label="Order lookup">
    <label for="track-no">Track an order</label>
    <input id="track-no" name="order" type="text" inputmode="numeric">
    <button type="submit">Track</button>
  </form>
</div>
<header class="mast">
  <a class="brand-name" href="/">Parcelhouse</a>
  <nav aria-label="Main">
    <a href="/info/offers">Today&rsquo;s offers</a><a href="/info/new">New in</a><a href="/info/vouchers">Gift vouchers</a><a href="/info/help">Help</a><a href="/info/signin">Sign in</a><a href="/info/basket">Basket (${cartCount})</a>
  </nav>
</header>`;

const renderFooterB = back =>
  `<footer class="site-foot">
  <form action="/newsletter/join" method="post">
    <input type="hidden" name="back" value="${escapeHtml(back)}">
    <label for="join-mail">Join our mailing list</label>
    <input id="join-mail" name="email" type="email" autocomplete="email">
    <button type="submit">Join</button>
  </form>
  <p><a href="/info/shipping">Delivery</a><a href="/info/returns">Returns</a><a href="/info/about">About Parcelhouse</a><a href="/info/privacy">Privacy</a></p>
  <p>Parcelhouse Demo Goods. Prices in US dollars.</p>
</footer>`;

const renderFormB = search => {
  const categories = categoryList('B');
  const selectedCategory = search.filters.category[0] ?? '';
  const selectedBrand = search.filters.brand[0] ?? '';
  const cap = search.filters.maxPrice === null ? '' : String(search.filters.maxPrice);
  const sortOptions = SORTS.map(
    value =>
      `<label><input type="radio" name="sort" value="${value}"${search.sort === value ? ' checked' : ''}> ${escapeHtml(SORT_LABELS.B[value])}</label>`
  ).join('');
  return `<form class="finder" method="get" action="/search" role="search" aria-labelledby="finder-title">
  <h2 id="finder-title">Find products</h2>
  <div class="f-row"><label for="q">What are you looking for?</label><input id="q" name="q" type="search" value="${escapeHtml(search.q)}" autocomplete="off"></div>
  <div class="f-row"><label for="dept">Department</label><select id="dept" name="category"><option value="">All departments</option>${categories
    .map(
      c =>
        `<option value="${c.slug}"${selectedCategory === c.slug ? ' selected' : ''}>${escapeHtml(c.label)}</option>`
    )
    .join('')}</select></div>
  <div class="f-row"><label for="make">Manufacturer</label><select id="make" name="brand"><option value="">Any manufacturer</option>${brandList()
    .map(
      b =>
        `<option value="${b.slug}"${selectedBrand === b.slug ? ' selected' : ''}>${escapeHtml(b.label)}</option>`
    )
    .join('')}</select></div>
  <div class="f-row"><label for="cap">Highest price you will pay (USD)</label><input id="cap" name="maxPrice" type="number" min="0" step="any" inputmode="decimal" value="${escapeHtml(cap)}"></div>
  <fieldset class="f-row"><legend>Order results by</legend><div class="radios">${sortOptions}</div></fieldset>
  <div class="f-actions"><button type="submit">Search</button><button type="reset" class="ghost">Reset form</button><a href="/">Start over</a></div>
</form>`;
};

const renderRowB = (product, state, back) => {
  const def = CATEGORY_DEFS.find(c => c.slug === product.category);
  const saved = state.wishlist.includes(product.id);
  return `<li class="row">
  <div class="pic" aria-hidden="true" style="background:hsl(${def.hue} 30% 88%);color:hsl(${def.hue} 30% 28%)">${escapeHtml(product.brand.slice(0, 2))}</div>
  <div>
    <h3><a href="/product/${product.id}">${escapeHtml(product.title)}</a></h3>
    <p>Manufacturer: ${escapeHtml(product.brand)} &middot; Department: ${escapeHtml(def.labels.B)}</p>
    <p>${escapeHtml(product.blurb)}</p>
    <p>Customer rating ${product.rating} of 5 (${product.reviews} reviews)</p>
  </div>
  <div class="buy-box">
    <p class="cost">${formatPrice(product.price)}</p>
    <form method="post" action="/basket/add"><input type="hidden" name="productId" value="${product.id}"><input type="hidden" name="back" value="${escapeHtml(back)}"><button type="submit" class="add-btn" aria-label="Add ${escapeHtml(product.title)} to basket">Add to basket</button></form>
    <form method="post" action="/wishlist/toggle"><input type="hidden" name="productId" value="${product.id}"><input type="hidden" name="back" value="${escapeHtml(back)}"><button type="submit" class="later-btn" aria-label="${saved ? `Remove ${escapeHtml(product.title)} from saved items` : `Save ${escapeHtml(product.title)} for later`}">${saved ? 'Saved for later' : 'Save for later'}</button></form>
  </div>
</li>`;
};

const describeActiveB = search => {
  const parts = [];
  if (search.q) parts.push(`Search: “${search.q}”`);
  if (search.filters.category.length > 0) {
    parts.push(
      `Department: ${search.filters.category.map(s => CATEGORY_DEFS.find(c => c.slug === s)?.labels.B ?? s).join(', ')}`
    );
  }
  if (search.filters.brand.length > 0) {
    parts.push(
      `Manufacturer: ${search.filters.brand.map(s => BRAND_NAMES.find(n => n.toLowerCase() === s) ?? s).join(', ')}`
    );
  }
  if (search.filters.maxPrice !== null) parts.push(`Up to $${search.filters.maxPrice}`);
  parts.push(`Ordered by ${SORT_LABELS.B[search.sort].toLowerCase()}`);
  return parts.join(' · ');
};

const renderPageB = ({ search, results, state, flash, back, rerenderEveryMs, inventory }) => {
  const flashHtml = flash
    ? `<div class="flash ${flash.kind}" role="${flash.kind === 'error' ? 'alert' : 'status'}">${escapeHtml(flash.text)}</div>`
    : '';
  const cartCount = state.cart.reduce((sum, item) => sum + item.qty, 0);
  let body;
  if (results === null) {
    const featured = [...PRODUCTS].sort((a, b) => a.featured - b.featured).slice(0, 6);
    body = `<h2 class="lead">Featured this week</h2><ul class="rows">${featured.map(p => renderRowB(p, state, back)).join('')}</ul>`;
  } else if (results.length === 0) {
    body = `<p class="found" role="status">0 products found</p><p class="applied">${escapeHtml(describeActiveB(search))}</p><div class="nothing"><h2>We could not find anything matching that search.</h2><p>Check the spelling or loosen one of the options above.</p></div>`;
  } else {
    body = `<p class="found" role="status">${results.length} product${results.length === 1 ? '' : 's'} found</p><p class="applied">${escapeHtml(describeActiveB(search))}</p><ul class="rows">${results.map(p => renderRowB(p, state, back)).join('')}</ul>`;
  }
  const scripts = [
    back !== '/' && back !== undefined
      ? `<script>history.replaceState(null, '', ${inlineJson(back)});</script>`
      : '',
    rerenderEveryMs ? `<script>(${clientRerenderB.toString()})(${rerenderEveryMs});</script>` : '',
  ].join('\n');
  return pageShell(
    'B',
    results === null ? 'Parcelhouse - Home' : 'Parcelhouse - Search results',
    CSS_B,
    `${renderHeaderB(cartCount)}
${renderInventory(inventory)}
<main class="page">
${flashHtml}
${results === null ? '<h1 class="lead">Everyday essentials for home, desk and trail</h1>' : '<h1 class="sr">Search results</h1>'}
${renderFormB(search)}
${body}
</main>
${renderFooterB(back ?? '/')}`,
    scripts
  );
};

/* ---- static pages shared by every variant ---- */

const renderStaticPage = (variant, title, innerHtml, cartCount) => {
  if (variant === 'A') {
    return pageShell(
      variant,
      `${STORE_NAMES.A} - ${title}`,
      CSS_A,
      `${renderHeaderA(cartCount, '')}<main class="static">${innerHtml}</main>${renderFooterA('', null, false)}`
    );
  }
  if (variant === 'C') {
    return pageShell(
      variant,
      `${STORE_NAMES.C} - ${title}`,
      CSS_C,
      `${renderHeaderC(cartCount, false)}<main class="static">${innerHtml}</main>${renderFooterC('', null, false)}`
    );
  }
  return pageShell(
    variant,
    `${STORE_NAMES.B} - ${title}`,
    CSS_B,
    `${renderHeaderB(cartCount)}<main class="static">${innerHtml}</main>${renderFooterB('/')}`
  );
};

const renderProductDetail = product => {
  const def = CATEGORY_DEFS.find(c => c.slug === product.category);
  return `<h1>${escapeHtml(product.title)}</h1>
<p>${escapeHtml(product.brand)} &middot; ${escapeHtml(def.labels.A)}</p>
<p><strong>${formatPrice(product.price)}</strong> &middot; Rated ${product.rating} of 5 from ${product.reviews} reviews</p>
<p>${escapeHtml(product.blurb)}</p>
<p><a href="/">Back to all products</a></p>`;
};

export function describe() {
  return {
    family,
    variants: [
      {
        id: 'A',
        summary:
          'Shopwell: header search box plus sidebar checkboxes (Category, Brand), a price select and a sort select; results update live as a SPA and the URL query follows every change.',
      },
      {
        id: 'B',
        summary:
          'Parcelhouse: server-rendered search form with an explicit Search button, department and manufacturer selects, a maximum-price number field and a sort radio group; every search is a full page navigation.',
      },
      {
        id: 'C',
        summary:
          'Mercato: a header search icon opens an overlay dialog holding the input; filters are aria-pressed chips below a tall hero so the page must be scrolled; SPA with pushState URL updates.',
      },
    ],
    faults: [
      {
        name: 'rerenderEveryMs',
        summary:
          'Every N ms the main content nodes are replaced by fresh equivalent nodes (uncommitted field values kept, focus lost) so held element references go stale.',
      },
      {
        name: 'slowResponseMs',
        summary:
          'Every API response (and the variant B search/write responses) is delayed by N ms; the SPA variants show an updating state with stale results meanwhile.',
      },
      {
        name: 'failWrites',
        summary:
          'Cart, wishlist and newsletter writes return HTTP 500; the UI shows a visible error and does not show the change as saved. Searches (reads) are unaffected.',
      },
      {
        name: 'misleadingSuccess',
        summary:
          'Cart, wishlist and newsletter writes answer success and the UI shows a success banner, but nothing is persisted; in variants A and C, clearing filters with none active also shows a success banner without any request.',
      },
    ],
    initialOptions: [
      {
        name: 'cart',
        summary: 'Array of product ids (p01..p30) already in the cart, quantity 1 each.',
      },
      {
        name: 'wishlist',
        summary: 'Array of product ids (p01..p30) already saved to the wishlist.',
      },
      {
        name: 'inventoryProof',
        summary:
          'Optional boolean, false by default. Shows current basket product ids, titles and quantities and saved product ids and titles near the top of listing pages, with read-only basket and saved-items pages.',
      },
    ],
  };
}

export async function startApp({ port = 0, variant = 'A', initial = {}, faults = {} } = {}) {
  if (!variants.includes(variant)) throw new TypeError(`Unknown variant: ${String(variant)}`);
  const fault = normalizeFaults(faults);
  const baseline = normalizeInitial(initial);
  let state = freshState(baseline);
  let inventoryProof = baseline.inventoryProof;
  let log = [];
  let seq = 0;

  const cartCount = () => state.cart.reduce((sum, item) => sum + item.qty, 0);
  const snapshot = () => JSON.parse(JSON.stringify(state));
  const inventoryPayload = () =>
    inventoryProof
      ? {
          inventory: {
            cart: state.cart.map(item => ({
              productId: item.productId,
              title: PRODUCT_BY_ID.get(item.productId).title,
              qty: item.qty,
            })),
            saved: state.wishlist.map(productId => ({
              productId,
              title: PRODUCT_BY_ID.get(productId).title,
            })),
          },
        }
      : {};
  const timers = new Set();
  const pause = () =>
    fault.slowResponseMs > 0
      ? new Promise(resolve => {
          const timer = setTimeout(() => {
            timers.delete(timer);
            resolve();
          }, fault.slowResponseMs);
          timers.add(timer);
        })
      : null;

  const runAndRecord = (search, record) => {
    const results = runSearch(search);
    if (record) {
      state.searches.push({
        q: search.q,
        filters: {
          category: [...search.filters.category],
          brand: [...search.filters.brand],
          maxPrice: search.filters.maxPrice,
        },
        sort: search.sort,
        count: results.length,
      });
      state.lastResultIds = results.map(p => p.id);
    }
    return results;
  };

  const writeCart = body => {
    const id = String(body.productId ?? '');
    if (!PRODUCT_BY_ID.has(id)) return { status: 404, error: 'unknown_product' };
    if (fault.failWrites) return { status: 500, error: 'internal_error' };
    if (!fault.misleadingSuccess) {
      const existing = state.cart.find(item => item.productId === id);
      if (existing) existing.qty += 1;
      else state.cart.push({ productId: id, qty: 1 });
    }
    return { status: 200 };
  };

  const writeWishlist = (id, saved) => {
    if (!PRODUCT_BY_ID.has(id)) return { status: 404, error: 'unknown_product' };
    if (fault.failWrites) return { status: 500, error: 'internal_error' };
    if (!fault.misleadingSuccess) {
      const without = state.wishlist.filter(item => item !== id);
      state.wishlist = saved ? [...without, id] : without;
    }
    return { status: 200 };
  };

  const writeNewsletter = email => {
    if (fault.failWrites) return { status: 500, error: 'internal_error' };
    if (!EMAIL_PATTERN.test(String(email ?? ''))) return { status: 400, error: 'invalid_email' };
    if (!fault.misleadingSuccess) state.newsletterSignups += 1;
    return { status: 200 };
  };

  const sendJson = (res, status, payload) => {
    const text = JSON.stringify(payload);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    });
    res.end(text);
  };

  const sendHtml = (res, status, html) => {
    res.writeHead(status, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    });
    res.end(html);
  };

  const bootFor = () => ({
    categories: categoryList(variant),
    brands: brandList(),
    prices: PRICE_STEPS,
    sorts: SORTS.map(value => ({ value, label: SORT_LABELS[variant][value] })),
    hues: Object.fromEntries(CATEGORY_DEFS.map(c => [c.slug, c.hue])),
    popular: POPULAR_SEARCHES,
    cartCount: cartCount(),
    wishlist: [...state.wishlist],
    ...inventoryPayload(),
    rerenderEveryMs: fault.rerenderEveryMs,
    misleading: fault.misleadingSuccess,
  });

  const renderShell = () => {
    const boot = bootFor();
    const client = variant === 'A' ? clientA : clientC;
    const script = `<script>\n${CLIENT_HELPERS}\n(${client.toString()})(${inlineJson(boot)});\n</script>`;
    return pageShell(
      variant,
      variant === 'A' ? 'Shopwell - All products' : 'Mercato - The spring edit',
      variant === 'A' ? CSS_A : CSS_C,
      '<div id="app"></div>',
      script
    );
  };

  const resolveBack = back => {
    const text = typeof back === 'string' && /^\/(?![/\\])/.test(back) ? back : '/';
    const parsed = new URL(text, 'http://127.0.0.1');
    if (parsed.origin === 'http://127.0.0.1' && parsed.pathname === '/search')
      return { search: normalizeSearch(parsed.searchParams), back: text };
    return { search: normalizeSearch(new URLSearchParams()), back: '/' };
  };

  const renderBFromBack = (backText, flash) => {
    const { search, back } = resolveBack(backText);
    const results = back === '/' ? null : runAndRecord(search, false);
    return renderPageB({
      search,
      results,
      state,
      flash,
      back,
      rerenderEveryMs: fault.rerenderEveryMs,
      ...inventoryPayload(),
    });
  };

  const handle = async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname;
    const method = req.method ?? 'GET';

    if (path === '/__test/state' && method === 'GET') {
      sendJson(res, 200, snapshot());
      return;
    }
    if (path === '/__test/reset' && method === 'POST') {
      const body = parseBody(await readBody(req), req.headers['content-type']);
      try {
        reset(body.initial);
        sendJson(res, 200, { ok: true });
      } catch (error) {
        sendJson(res, 400, { ok: false, error: String(error?.message ?? error) });
      }
      return;
    }
    if (path === '/favicon.ico') {
      res.writeHead(204);
      res.end();
      return;
    }

    const raw = method === 'POST' ? await readBody(req) : '';
    const body = parseBody(raw, req.headers['content-type']);
    seq += 1;
    log.push({
      seq,
      method,
      path,
      query: queryObject(url.searchParams),
      bodySummary: method === 'POST' ? summarizeBody(path, body) : null,
    });

    if (method === 'GET' && path === '/') {
      if (variant === 'B') {
        sendHtml(res, 200, renderBFromBack('/', null));
      } else {
        sendHtml(res, 200, renderShell());
      }
      return;
    }

    if (method === 'GET' && path === '/api/products') {
      await pause();
      const search = normalizeSearch(url.searchParams);
      const results = runAndRecord(search, true);
      sendJson(res, 200, {
        query: { q: search.q, ...search.filters, sort: search.sort },
        count: results.length,
        products: results,
        ...inventoryPayload(),
      });
      return;
    }

    if (method === 'POST' && path === '/api/cart') {
      await pause();
      const outcome = writeCart(body);
      if (outcome.status !== 200) sendJson(res, outcome.status, { error: outcome.error });
      else sendJson(res, 200, { ok: true, cartCount: cartCount(), ...inventoryPayload() });
      return;
    }

    if (method === 'POST' && path === '/api/wishlist') {
      await pause();
      const saved = body.saved === true || body.saved === 'true';
      const outcome = writeWishlist(String(body.productId ?? ''), saved);
      if (outcome.status !== 200) sendJson(res, outcome.status, { error: outcome.error });
      else sendJson(res, 200, { ok: true, wishlist: [...state.wishlist], ...inventoryPayload() });
      return;
    }

    if (method === 'POST' && path === '/api/newsletter') {
      await pause();
      const outcome = writeNewsletter(body.email);
      if (outcome.status !== 200) sendJson(res, outcome.status, { error: outcome.error });
      else sendJson(res, 200, { ok: true });
      return;
    }

    if (variant === 'B' && method === 'GET' && path === '/search') {
      await pause();
      const search = normalizeSearch(url.searchParams);
      const results = runAndRecord(search, true);
      sendHtml(
        res,
        200,
        renderPageB({
          search,
          results,
          state,
          flash: null,
          back: `${path}${url.search}`,
          rerenderEveryMs: fault.rerenderEveryMs,
          ...inventoryPayload(),
        })
      );
      return;
    }

    if (variant === 'B' && method === 'POST' && path === '/basket/add') {
      await pause();
      const outcome = writeCart(body);
      const flash =
        outcome.status === 200
          ? { kind: 'ok', text: 'Item added to your basket.' }
          : { kind: 'error', text: 'Sorry, your basket could not be updated. Nothing was added.' };
      sendHtml(res, outcome.status, renderBFromBack(body.back, flash));
      return;
    }

    if (variant === 'B' && method === 'POST' && path === '/wishlist/toggle') {
      await pause();
      const id = String(body.productId ?? '');
      const outcome = writeWishlist(id, !state.wishlist.includes(id));
      const flash =
        outcome.status === 200
          ? { kind: 'ok', text: 'Your saved items were updated.' }
          : { kind: 'error', text: 'Sorry, your saved items could not be updated.' };
      sendHtml(res, outcome.status, renderBFromBack(body.back, flash));
      return;
    }

    if (variant === 'B' && method === 'POST' && path === '/newsletter/join') {
      await pause();
      const outcome = writeNewsletter(body.email);
      let flash = { kind: 'ok', text: 'Thanks, you are on the mailing list.' };
      if (outcome.status === 400)
        flash = { kind: 'error', text: 'Please enter a valid email address.' };
      else if (outcome.status !== 200)
        flash = { kind: 'error', text: 'Sorry, we could not sign you up right now.' };
      sendHtml(res, outcome.status, renderBFromBack(body.back, flash));
      return;
    }

    if (method === 'GET' && path.startsWith('/product/')) {
      const product = PRODUCT_BY_ID.get(decodeURIComponent(path.slice('/product/'.length)));
      if (!product) {
        sendHtml(
          res,
          404,
          renderStaticPage(
            variant,
            'Not found',
            '<h1>Page not found</h1><p><a href="/">Back to the store</a></p>',
            cartCount()
          )
        );
        return;
      }
      state.productViews.push(product.id);
      sendHtml(
        res,
        200,
        renderStaticPage(variant, product.title, renderProductDetail(product), cartCount())
      );
      return;
    }

    if (method === 'GET' && path.startsWith('/info/')) {
      const slug = decodeURIComponent(path.slice('/info/'.length)).toLowerCase();
      const inventoryPage =
        inventoryProof && ['cart', 'basket', 'bag', 'saved', 'wishlist'].includes(slug);
      const title =
        inventoryPage && ['saved', 'wishlist'].includes(slug)
          ? 'Your saved items'
          : (INFO_TITLES[slug] ?? titleCase(slug || 'page'));
      sendHtml(
        res,
        200,
        renderStaticPage(
          variant,
          title,
          `<h1>${escapeHtml(title)}</h1>${inventoryPage ? renderInventory(inventoryPayload().inventory) : '<p>There is nothing to show here at the moment.</p>'}<p><a href="/">Back to the store</a></p>`,
          cartCount()
        )
      );
      return;
    }

    sendHtml(
      res,
      404,
      renderStaticPage(
        variant,
        'Not found',
        '<h1>Page not found</h1><p><a href="/">Back to the store</a></p>',
        cartCount()
      )
    );
  };

  const server = createServer((req, res) => {
    handle(req, res).catch(error => {
      if (!res.headersSent)
        sendJson(res, 500, { error: 'internal_error', detail: String(error?.message ?? error) });
      else res.end();
    });
  });

  const reset = nextInitial => {
    const next = nextInitial === undefined ? baseline : normalizeInitial(nextInitial);
    state = freshState(next);
    inventoryProof = next.inventoryProof;
    log = [];
    seq = 0;
  };

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });

  const address = server.address();
  const boundPort = typeof address === 'object' && address ? address.port : port;
  const origin = `http://127.0.0.1:${boundPort}`;
  let closing = null;

  return {
    url: `${origin}/`,
    origin,
    family,
    variant,
    state: snapshot,
    requests: () => log.map(entry => ({ ...entry, query: { ...entry.query } })),
    reset,
    close: () => {
      if (!closing) {
        timers.forEach(clearTimeout);
        timers.clear();
        closing = new Promise(resolve => {
          server.close(() => resolve());
          server.closeAllConnections();
        });
      }
      return closing;
    },
  };
}
