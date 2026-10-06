import http from 'node:http';

export const family = 'settings';
export const variants = ['A', 'B', 'C'];

const OPTIONAL_KEYS = ['promotional', 'updates', 'digest', 'sms'];
const ALL_KEYS = [...OPTIONAL_KEYS, 'security'];
const DEFAULT_INITIAL = { promotional: true, updates: true, digest: false, sms: true };
const FAULT_DEFAULTS = {
  rerenderEveryMs: 0,
  slowResponseMs: 0,
  failWrites: false,
  misleadingSuccess: false,
};
const MAX_BODY_BYTES = 65536;
const ACCOUNT_SCOPED = new Set([
  '/api/settings',
  '/api/settings/unsubscribe-all',
  '/api/account',
  '/api/profile',
  '/api/account/delete',
]);

const PAGE_TITLES = {
  '/shop': 'Shop',
  '/shop/sale': 'Sale',
  '/shop/spring': 'Spring offers',
  '/orders': 'Your orders',
  '/wishlist': 'Wishlist',
  '/help': 'Help centre',
  '/cart': 'Your cart',
  '/profile': 'Profile',
  '/payment-methods': 'Payment methods',
  '/privacy': 'Privacy and data',
  '/about': 'About Fernhill',
  '/terms': 'Terms of service',
  '/shipping': 'Delivery information',
  '/returns': 'Returns',
  '/careers': 'Careers',
  '/search': 'Search',
  '/signed-out': 'Signed out',
};

export function describe() {
  return {
    family,
    variants: [
      {
        id: 'A',
        summary:
          'Single-page app. Notifications page with role=switch buttons that save immediately (one PUT per toggle) and show a transient Saved toast; sidebar and header navigation are SPA transitions; Unsubscribe from everything and Delete account (confirm dialog) in a danger zone.',
      },
      {
        id: 'B',
        summary:
          'Multi-page site: every link and the delete step are full document navigations, with no client-side routing (the settings form itself is filled in by script on load). Plain checkboxes plus a Save changes button: nothing persists until Save, and Save with no changes still shows a Saved message (premature-success trap). Unsubscribe from everything only unchecks boxes locally; Delete account is a separate confirmation page.',
      },
      {
        id: 'C',
        summary:
          'Single-page app with a long account page: preferences sit in a collapsed Communication preferences accordion behind a Notifications tab, as visually hidden native checkboxes with styled labels that save on change. Scrolling is required to reach them.',
      },
    ],
    faults: [
      {
        name: 'rerenderEveryMs',
        summary:
          'Number of ms (0 = off). Periodically replaces the main content nodes with fresh equivalent nodes so held element references go stale; unsaved UI state is kept.',
      },
      {
        name: 'slowResponseMs',
        summary:
          'Number of ms (0 = off). Delays every /api response; writes are applied on arrival.',
      },
      {
        name: 'failWrites',
        summary:
          'Boolean. Every API write returns HTTP 500 and changes nothing; the UI shows a visible error and does not show the change as saved.',
      },
      {
        name: 'misleadingSuccess',
        summary:
          'Boolean. Preference writes return success but are silently discarded; the UI shows its normal saved confirmation although the persisted state did not change.',
      },
    ],
    initialOptions: [
      { name: 'promotional', summary: 'Boolean, default true. Promotional emails starting state.' },
      { name: 'updates', summary: 'Boolean, default true. Product updates starting state.' },
      { name: 'digest', summary: 'Boolean, default false. Weekly digest starting state.' },
      { name: 'sms', summary: 'Boolean, default true. Text message offers starting state.' },
    ],
  };
}

function normalizeInitial(initial) {
  if (initial === null || typeof initial !== 'object' || Array.isArray(initial)) {
    throw new TypeError('settings: initial must be an object');
  }
  const result = { ...DEFAULT_INITIAL };
  for (const [name, value] of Object.entries(initial)) {
    if (!OPTIONAL_KEYS.includes(name)) {
      throw new TypeError(`settings: unknown initial option "${name}"`);
    }
    if (typeof value !== 'boolean') {
      throw new TypeError(`settings: initial option "${name}" must be a boolean`);
    }
    result[name] = value;
  }
  return result;
}

function normalizeFaults(faults) {
  if (faults === null || typeof faults !== 'object' || Array.isArray(faults)) {
    throw new TypeError('settings: faults must be an object');
  }
  const result = { ...FAULT_DEFAULTS };
  for (const [name, value] of Object.entries(faults)) {
    if (!(name in FAULT_DEFAULTS)) {
      throw new TypeError(`settings: unknown fault "${name}"`);
    }
    if (typeof FAULT_DEFAULTS[name] === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        throw new TypeError(`settings: fault "${name}" must be a non-negative number`);
      }
    } else if (typeof value !== 'boolean') {
      throw new TypeError(`settings: fault "${name}" must be a boolean`);
    }
    result[name] = value;
  }
  return result;
}

function createStore(initialOptions) {
  let baseline = normalizeInitial(initialOptions);
  let writeSeq = 0;
  let requestSeq = 0;
  let requestLog = [];

  const fresh = base => ({
    settings: {
      promotional: base.promotional,
      updates: base.updates,
      digest: base.digest,
      security: true,
      sms: base.sms,
    },
    profile: { displayName: 'Jordan Ellis' },
    writes: [],
    saves: [],
    dangerActions: [],
    newsletter: [],
    accountDeleted: false,
    ignoredWrites: 0,
    failedWrites: 0,
    rejectedWrites: 0,
  });
  let data = fresh(baseline);

  const reply = (status, json) => ({ status, json });
  const bad = error => reply(400, { error });

  function recordWrite(key, to) {
    writeSeq += 1;
    data.writes.push({ seq: writeSeq, key, from: data.settings[key], to });
    data.settings[key] = to;
  }

  function putSettings(body, faults) {
    let changes;
    if (
      body &&
      typeof body === 'object' &&
      body.changes &&
      typeof body.changes === 'object' &&
      !Array.isArray(body.changes)
    ) {
      changes = body.changes;
    } else if (body && typeof body === 'object' && typeof body.key === 'string') {
      changes = { [body.key]: body.value };
    } else {
      return bad('invalid_body');
    }
    const entries = Object.entries(changes);
    for (const [key, value] of entries) {
      if (!ALL_KEYS.includes(key)) return bad('unknown_setting');
      if (typeof value !== 'boolean') return bad('invalid_value');
      if (key === 'security' && value !== true) {
        data.rejectedWrites += 1;
        return reply(403, { error: 'locked', key });
      }
    }
    const pending = entries.filter(([key, value]) => data.settings[key] !== value);
    if (faults.misleadingSuccess) {
      if (pending.length > 0) data.ignoredWrites += 1;
      return reply(200, { ok: true });
    }
    const changed = [];
    for (const [key, value] of pending) {
      recordWrite(key, value);
      changed.push(key);
    }
    data.saves.push({ keys: entries.map(([key]) => key), changed });
    return reply(200, { ok: true, changed, settings: { ...data.settings } });
  }

  function route(method, path, body, faults) {
    if (method !== 'GET' && faults.failWrites) {
      data.failedWrites += 1;
      return reply(500, { error: 'internal_error' });
    }
    if (data.accountDeleted && ACCOUNT_SCOPED.has(path)) {
      return reply(410, { error: 'account_deleted' });
    }
    switch (`${method} ${path}`) {
      case 'GET /api/settings':
        return reply(200, { settings: { ...data.settings }, locked: ['security'] });
      case 'PUT /api/settings':
        return putSettings(body, faults);
      case 'POST /api/settings/unsubscribe-all': {
        const changed = [];
        for (const key of OPTIONAL_KEYS) {
          if (data.settings[key]) {
            recordWrite(key, false);
            changed.push(key);
          }
        }
        data.dangerActions.push({ action: 'unsubscribe_all', changed });
        return reply(200, { ok: true, changed, settings: { ...data.settings } });
      }
      case 'GET /api/account':
        return reply(200, { profile: { ...data.profile } });
      case 'PUT /api/profile': {
        const name = body && typeof body.displayName === 'string' ? body.displayName.trim() : '';
        if (name.length === 0 || name.length > 60) return bad('invalid_name');
        data.profile.displayName = name;
        return reply(200, { ok: true, profile: { ...data.profile } });
      }
      case 'POST /api/account/delete':
        data.accountDeleted = true;
        data.dangerActions.push({ action: 'delete_account' });
        return reply(200, { ok: true });
      case 'POST /api/newsletter': {
        const email = body && typeof body.email === 'string' ? body.email.trim() : '';
        if (!email.includes('@')) return bad('invalid_email');
        data.newsletter.push({ email });
        return reply(200, { ok: true });
      }
      default:
        return reply(404, { error: 'not_found' });
    }
  }

  function summarizeBody(raw) {
    if (!raw) return null;
    try {
      return JSON.stringify(JSON.parse(raw)).slice(0, 200);
    } catch {
      return raw.slice(0, 200);
    }
  }

  return {
    route,
    state: () => JSON.parse(JSON.stringify(data)),
    requests: () => JSON.parse(JSON.stringify(requestLog)),
    log(method, path, searchParams, rawBody) {
      requestSeq += 1;
      requestLog.push({
        seq: requestSeq,
        method,
        path,
        query: Object.fromEntries(searchParams),
        bodySummary: summarizeBody(rawBody),
      });
    },
    reset(initial) {
      if (initial !== undefined) baseline = normalizeInitial(initial);
      data = fresh(baseline);
      writeSeq = 0;
      requestSeq = 0;
      requestLog = [];
    },
  };
}

const safeJson = value => JSON.stringify(value).replace(/</g, '\\x3c');

/* ----------------------------- browser-side helpers ----------------------------- */
/* These functions are serialized with toString() and run inside the page, not in Node. */

function esc(value) {
  return String(value).replace(
    /[&<>"']/g,
    ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]
  );
}

async function api(method, url, body) {
  try {
    const res = await fetch(url, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let payload = null;
    try {
      payload = await res.json();
    } catch {
      payload = null;
    }
    return { ok: res.ok, status: res.status, data: payload };
  } catch {
    return { ok: false, status: 0, data: null };
  }
}

function initNewsletter() {
  const form = document.getElementById('newsletter-form');
  if (!form) return;
  const message = document.getElementById('newsletter-msg');
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const email = document.getElementById('newsletter-email').value.trim();
    if (!email.includes('@')) {
      message.textContent = 'Please enter a valid email address.';
      return;
    }
    const result = await api('POST', '/api/newsletter', { email });
    message.textContent = result.ok
      ? 'Thanks for subscribing.'
      : 'Something went wrong. Please try again.';
  });
}

function newsletterForm({ label, button, placeholder }) {
  return `<form id="newsletter-form" class="newsletter" novalidate>
  <label for="newsletter-email">${label}</label>
  <div class="newsletter-row">
    <input id="newsletter-email" type="email" name="email" placeholder="${placeholder}" autocomplete="off">
    <button type="submit">${button}</button>
  </div>
  <p id="newsletter-msg" class="newsletter-msg" role="status"></p>
</form>`;
}

function scriptTag(entry, cfg, extraFns = []) {
  const helpers = [esc, api, initNewsletter, ...extraFns].map(fn => fn.toString()).join('\n');
  return `<script>\n${helpers}\n(${entry.toString()})(${safeJson(cfg)});\ninitNewsletter();\n</script>`;
}

/* --------------------------------- variant A ---------------------------------- */

const A_CSS = `
*{box-sizing:border-box}
body{margin:0;font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:#1d2b2f;background:#f2f5f5}
a{color:#0a6a64}
[hidden]{display:none!important}
button{font:inherit}
.site-header{display:flex;align-items:center;gap:36px;height:64px;padding:0 40px;background:#fff;border-bottom:1px solid #d9e2e2}
.brand{font-size:22px;font-weight:700;letter-spacing:-.02em;color:#0a4f4b;text-decoration:none}
.site-header nav{display:flex;gap:24px;flex:1}
.site-header nav a{color:#31464a;text-decoration:none;font-weight:500}
.header-right{display:flex;align-items:center;gap:16px}
.header-right a{color:#31464a;text-decoration:none}
.avatar{width:34px;height:34px;border-radius:50%;background:#0a6a64;color:#fff;display:grid;place-items:center;font-size:13px;font-weight:600}
.promo{background:#e1f0ee;color:#0a4f4b;text-align:center;padding:9px 16px;font-size:14px}
#alerts:empty{display:none}
#alerts{max-width:1120px;margin:16px auto 0;padding:0 24px}
.banner{display:flex;align-items:center;justify-content:space-between;gap:16px;background:#fdecea;border:1px solid #f1b5ae;color:#8a1f13;border-radius:10px;padding:10px 14px}
.banner button{background:none;border:0;color:#8a1f13;text-decoration:underline;cursor:pointer}
.layout{display:grid;grid-template-columns:240px 1fr;gap:32px;max-width:1120px;margin:24px auto 40px;padding:0 24px;align-items:start}
.layout.wide{grid-template-columns:1fr}
.sidebar{background:#fff;border:1px solid #d9e2e2;border-radius:12px;padding:16px 12px}
.side-title{font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:#6a7d80;margin:0 8px 8px}
.sidebar ul{list-style:none;margin:0;padding:0}
.side-link{display:block;padding:8px 10px;border-radius:8px;color:#31464a;text-decoration:none}
.side-link:hover{background:#eef4f4}
.side-link[aria-current="page"]{background:#dff0ee;color:#0a4f4b;font-weight:600}
.panel{background:#fff;border:1px solid #d9e2e2;border-radius:12px;padding:28px 32px}
.panel h1{margin:0 0 4px;font-size:26px}
.lede,.muted{color:#5b6e71;margin:0 0 20px}
.prefs{list-style:none;margin:0 0 28px;padding:0;border-top:1px solid #e4ebeb}
.pref{display:flex;align-items:center;justify-content:space-between;gap:24px;padding:16px 0;border-bottom:1px solid #e4ebeb}
.pref-text{display:flex;flex-direction:column}
.pref-name{font-weight:600}
.pref-desc{color:#5b6e71;font-size:14px}
.switch{position:relative;width:46px;height:26px;border-radius:13px;border:0;background:#b7c4c6;cursor:pointer;padding:0;flex:none;transition:background .15s}
.switch .knob{position:absolute;top:3px;left:3px;width:20px;height:20px;border-radius:50%;background:#fff;transition:transform .15s;box-shadow:0 1px 2px rgba(0,0,0,.3)}
.switch[aria-checked="true"]{background:#0a8a80}
.switch[aria-checked="true"] .knob{transform:translateX(20px)}
.switch:disabled{opacity:.55;cursor:not-allowed}
.switch:focus-visible{outline:3px solid #8fd1ca;outline-offset:2px}
.danger-zone{border:1px solid #efc3be;background:#fff8f7;border-radius:10px;padding:16px 20px}
.danger-zone h2{margin:0 0 8px;font-size:16px;color:#8a1f13}
.dz-row{display:flex;align-items:center;justify-content:space-between;gap:24px;padding:10px 0}
.dz-row+.dz-row{border-top:1px solid #f1d9d5}
.dz-row p{margin:0;color:#6b4a46;font-size:14px}
.btn{border:1px solid #b9c7c9;background:#fff;border-radius:8px;padding:8px 14px;cursor:pointer;color:#1d2b2f}
.btn.outline-danger{border-color:#d9776c;color:#a32a1c}
.btn.danger{background:#c43a2b;border-color:#c43a2b;color:#fff}
#toast{position:fixed;right:24px;bottom:24px;background:#16302e;color:#fff;border-radius:10px;padding:10px 18px;box-shadow:0 6px 20px rgba(0,0,0,.25)}
#toast:empty{display:none}
.scrim{position:fixed;inset:0;background:rgba(15,30,30,.45);display:grid;place-items:center}
.dialog{background:#fff;border-radius:14px;padding:24px 28px;width:420px;box-shadow:0 20px 50px rgba(0,0,0,.3)}
.dialog h2{margin:0 0 8px}
.dialog-actions{display:flex;justify-content:flex-end;gap:10px;margin-top:20px}
.site-footer{background:#16302e;color:#cfe0de;padding:32px 40px 20px}
.footer-grid{display:grid;grid-template-columns:repeat(3,1fr) 1.6fr;gap:32px;max-width:1120px;margin:0 auto}
.site-footer h2{font-size:14px;color:#fff;margin:0 0 8px}
.site-footer ul{list-style:none;margin:0;padding:0}
.site-footer a{color:#cfe0de;text-decoration:none;line-height:1.9}
.site-footer p{margin:0 0 8px}
.copy{max-width:1120px;margin:20px auto 0!important;font-size:13px;color:#8fb0ac}
.newsletter label{display:block;font-size:13px;margin-bottom:4px}
.newsletter-row{display:flex;gap:8px}
.newsletter input{flex:1;padding:8px 10px;border-radius:8px;border:1px solid #4d716d;background:#0f2422;color:#fff}
.newsletter button{background:#3fb8ac;border:0;border-radius:8px;padding:8px 14px;color:#06201d;font-weight:600;cursor:pointer}
.newsletter-msg{font-size:13px;min-height:18px}
`;

function clientA(cfg) {
  const ROWS = [
    {
      key: 'promotional',
      name: 'Promotional emails',
      desc: 'Deals, discounts and seasonal sales sent to your inbox.',
    },
    {
      key: 'updates',
      name: 'Product updates',
      desc: 'News about new features, improvements and restocks.',
    },
    {
      key: 'digest',
      name: 'Weekly digest',
      desc: 'A Monday summary of your orders, wishlist and recommendations.',
    },
    {
      key: 'security',
      name: 'Security alerts',
      desc: 'Sign-in and password notices. Always on to keep your account safe.',
    },
    {
      key: 'sms',
      name: 'Text message offers',
      desc: 'Time-limited offers by SMS to the mobile number on your account.',
    },
  ];
  const NAV = [
    { href: '/profile', label: 'Profile' },
    { href: '/', label: 'Notifications' },
    { href: '/payment-methods', label: 'Payment methods' },
    { href: '/privacy', label: 'Privacy and data' },
  ];
  const SETTINGS_PATHS = [
    '/',
    '/settings/notifications',
    '/profile',
    '/payment-methods',
    '/privacy',
  ];
  const OPTIONAL = ['promotional', 'updates', 'digest', 'sms'];
  const model = { path: location.pathname, settings: null, confirmed: null, deleted: false };
  const app = document.getElementById('app');
  const alerts = document.getElementById('alerts');
  const toast = document.getElementById('toast');
  const overlay = document.getElementById('overlay');
  let toastTimer = 0;
  let queue = Promise.resolve();

  const isPrefs = path => path === '/' || path === '/settings/notifications';
  const inSettings = path => SETTINGS_PATHS.includes(path);
  const titleOf = path => (isPrefs(path) ? 'Notifications' : cfg.titles[path] || 'Page not found');

  function setAlert(text) {
    alerts.innerHTML = text
      ? `<div class="banner" role="alert"><span>${esc(text)}</span><button type="button" id="dismiss-alert">Dismiss</button></div>`
      : '';
  }

  function flash(text) {
    toast.textContent = text;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toast.textContent = '';
    }, 2500);
  }

  function isCurrent(href) {
    return href === '/' ? isPrefs(model.path) : model.path === href;
  }

  function sidebar() {
    return `<aside class="sidebar" aria-label="Account settings"><h2 class="side-title">Account settings</h2><ul>${NAV.map(
      n =>
        `<li><a class="spa side-link" href="${n.href}"${isCurrent(n.href) ? ' aria-current="page"' : ''}>${n.label}</a></li>`
    ).join('')}</ul></aside>`;
  }

  function prefRow(row) {
    const on = !!model.settings[row.key];
    const locked = row.key === 'security';
    return `<li class="pref"><div class="pref-text"><span class="pref-name" id="n-${row.key}">${row.name}</span><span class="pref-desc" id="d-${row.key}">${row.desc}</span></div><button type="button" role="switch" class="switch" id="switch-${row.key}" aria-checked="${on}" aria-labelledby="n-${row.key}" aria-describedby="d-${row.key}"${locked ? ' disabled' : ''}><span class="knob"></span></button></li>`;
  }

  function prefsView() {
    if (!model.settings) {
      return `<section class="panel"><h1>Notifications</h1><p class="muted">Loading your preferences...</p></section>`;
    }
    return `<section class="panel" aria-labelledby="h-notif">
<h1 id="h-notif">Notifications</h1>
<p class="lede">Choose which messages Fernhill can send you.</p>
<ul class="prefs">${ROWS.map(prefRow).join('')}</ul>
<section class="danger-zone" aria-labelledby="h-danger">
<h2 id="h-danger">Danger zone</h2>
<div class="dz-row"><div><strong>Unsubscribe from everything</strong><p>Turn off every optional email and text message in one go.</p></div><button type="button" class="btn outline-danger" id="unsub-all">Unsubscribe from everything</button></div>
<div class="dz-row"><div><strong>Delete account</strong><p>Permanently delete your account, orders and saved addresses.</p></div><button type="button" class="btn danger" id="delete-account">Delete account</button></div>
</section>
</section>`;
  }

  function mainView() {
    if (model.deleted) {
      return `<section class="panel"><h1>Your account has been deleted</h1><p class="muted">We're sorry to see you go. A confirmation has been sent to your email.</p><a class="spa" href="/shop">Back to the shop</a></section>`;
    }
    if (isPrefs(model.path)) return prefsView();
    const title = cfg.titles[model.path];
    if (!title) {
      return `<section class="panel"><h1>Page not found</h1><p class="muted">We couldn't find the page you were looking for.</p></section>`;
    }
    return `<section class="panel"><h1>${esc(title)}</h1><p class="muted">Nothing to review here right now.</p></section>`;
  }

  function render() {
    const withSide = inSettings(model.path) && !model.deleted;
    document.title = `${model.deleted ? 'Account deleted' : titleOf(model.path)} - Fernhill`;
    app.className = withSide ? 'layout' : 'layout wide';
    app.innerHTML = (withSide ? sidebar() : '') + `<main class="main">${mainView()}</main>`;
  }

  function syncSwitches() {
    if (!model.settings) return;
    for (const row of ROWS) {
      const el = document.getElementById(`switch-${row.key}`);
      if (el) el.setAttribute('aria-checked', String(!!model.settings[row.key]));
    }
  }

  async function loadSettings() {
    const result = await api('GET', '/api/settings');
    if (!isPrefs(model.path)) return;
    if (result.status === 410) {
      model.deleted = true;
      render();
    } else if (result.ok) {
      model.settings = { ...result.data.settings };
      model.confirmed = { ...result.data.settings };
      render();
    } else {
      setAlert('We could not load your preferences. Please refresh and try again.');
    }
  }

  async function enter() {
    setAlert('');
    if (isPrefs(model.path) && !model.deleted) {
      model.settings = null;
      render();
      await loadSettings();
    } else {
      render();
    }
  }

  function go(path) {
    history.pushState({}, '', path);
    model.path = location.pathname;
    window.scrollTo(0, 0);
    enter();
  }

  async function persist(key, next) {
    const result = await api('PUT', '/api/settings', { key, value: next });
    if (result.ok) {
      if (model.confirmed) model.confirmed[key] = next;
      setAlert('');
      flash('Saved');
    } else {
      if (model.settings && model.confirmed) {
        model.settings[key] = model.confirmed[key];
        syncSwitches();
      }
      setAlert("We couldn't save your change. Please try again.");
    }
  }

  function onToggle(key) {
    if (!model.settings) return;
    const next = !model.settings[key];
    model.settings[key] = next;
    syncSwitches();
    queue = queue.then(() => persist(key, next));
  }

  async function unsubscribeAll() {
    const result = await api('POST', '/api/settings/unsubscribe-all');
    if (result.ok) {
      for (const key of OPTIONAL) {
        if (model.settings) model.settings[key] = false;
        if (model.confirmed) model.confirmed[key] = false;
      }
      syncSwitches();
      flash('Unsubscribed from all optional notifications');
    } else {
      setAlert('We could not update your notifications. Please try again.');
    }
  }

  async function deleteAccount() {
    overlay.innerHTML = '';
    const result = await api('POST', '/api/account/delete');
    if (result.ok || result.status === 410) {
      model.deleted = true;
      render();
    } else {
      setAlert('We could not delete your account right now. Please try again later.');
    }
  }

  function openDeleteDialog() {
    overlay.innerHTML = `<div class="scrim"><div class="dialog" role="alertdialog" aria-modal="true" aria-labelledby="dlg-title" aria-describedby="dlg-text"><h2 id="dlg-title">Delete your account?</h2><p id="dlg-text">This permanently removes your profile, orders and saved addresses. This can't be undone.</p><div class="dialog-actions"><button type="button" class="btn" id="dlg-cancel">Keep my account</button><button type="button" class="btn danger" id="dlg-confirm">Yes, delete my account</button></div></div></div>`;
    document.getElementById('dlg-cancel').focus();
  }

  document.addEventListener('click', event => {
    const el = event.target instanceof Element ? event.target : null;
    if (!el) return;
    const sw = el.closest('button.switch');
    if (sw) {
      if (!sw.disabled) onToggle(sw.id.replace('switch-', ''));
      return;
    }
    const link = el.closest('a.spa');
    if (link && !event.metaKey && !event.ctrlKey && !event.shiftKey) {
      event.preventDefault();
      go(link.getAttribute('href'));
      return;
    }
    const button = el.closest('button');
    if (!button) return;
    if (button.id === 'unsub-all') unsubscribeAll();
    else if (button.id === 'delete-account') openDeleteDialog();
    else if (button.id === 'dlg-cancel') overlay.innerHTML = '';
    else if (button.id === 'dlg-confirm') deleteAccount();
    else if (button.id === 'dismiss-alert') setAlert('');
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') overlay.innerHTML = '';
  });
  window.addEventListener('popstate', () => {
    model.path = location.pathname;
    enter();
  });

  enter();
  if (cfg.rerenderEveryMs > 0) setInterval(render, cfg.rerenderEveryMs);
}

function pageA(faults) {
  const cfg = { rerenderEveryMs: faults.rerenderEveryMs, titles: PAGE_TITLES };
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Notifications - Fernhill</title>
<style>${A_CSS}</style>
</head>
<body>
<header class="site-header">
  <a class="spa brand" href="/shop">Fernhill</a>
  <nav aria-label="Main">
    <a class="spa" href="/shop">Shop</a>
    <a class="spa" href="/orders">Orders</a>
    <a class="spa" href="/wishlist">Wishlist</a>
    <a class="spa" href="/help">Help centre</a>
  </nav>
  <div class="header-right"><a class="spa" href="/cart">Cart (0)</a><span class="avatar" aria-hidden="true">JE</span></div>
</header>
<div class="promo">Free standard delivery on orders over $50 this week. <a class="spa" href="/shop/sale">Shop the sale</a></div>
<div id="alerts"></div>
<div id="app" class="layout"></div>
<footer class="site-footer">
  <div class="footer-grid">
    <div><h2>Shop</h2><ul><li><a href="/shop">All products</a></li><li><a href="/shop/sale">Sale</a></li><li><a href="/wishlist">Wishlist</a></li></ul></div>
    <div><h2>Support</h2><ul><li><a href="/help">Help centre</a></li><li><a href="/shipping">Delivery information</a></li><li><a href="/returns">Returns</a></li></ul></div>
    <div><h2>Company</h2><ul><li><a href="/about">About Fernhill</a></li><li><a href="/careers">Careers</a></li><li><a href="/terms">Terms of service</a></li></ul></div>
    <div><h2>Stay in the loop</h2><p>Get 10% off your first order when you join our newsletter.</p>${newsletterForm({ label: 'Email for the newsletter', button: 'Subscribe', placeholder: 'you@example.com' })}</div>
  </div>
  <p class="copy">&copy; 2025 Fernhill Goods Ltd.</p>
</footer>
<div id="toast" role="status" aria-live="polite"></div>
<div id="overlay"></div>
${scriptTag(clientA, cfg)}
</body>
</html>`;
}

/* --------------------------------- variant B ---------------------------------- */

const B_CSS = `
*{box-sizing:border-box}
body{margin:0;font:16px/1.55 Georgia,"Times New Roman",serif;color:#232842;background:#eef0f7}
a{color:#3342a8}
h1,h2,legend,label,button,input,nav,.btn,.msg,.notice,.topbar{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
[hidden]{display:none!important}
.topbar{display:flex;align-items:center;gap:28px;padding:0 48px;height:58px;background:#232842;color:#fff}
.logo{font-weight:700;font-size:20px;color:#fff;text-decoration:none;letter-spacing:.01em}
.topbar nav{display:flex;gap:6px;flex:1}
.topbar nav a{color:#c9cffa;text-decoration:none;padding:6px 12px;border-radius:6px;font-size:15px}
.topbar nav a[aria-current="page"]{background:#3a4170;color:#fff}
.topbar .cartlink{color:#c9cffa;text-decoration:none;font-size:15px}
.notice{background:#fff3cf;color:#6b5311;text-align:center;padding:8px 16px;font-size:14px}
.container{max-width:760px;margin:0 auto;padding:24px 20px 56px}
.crumbs{font-size:14px;color:#6a7094;margin-bottom:8px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
.crumbs a{color:#6a7094}
h1{font-size:30px;margin:0 0 20px;color:#171b36}
.card{background:#fff;border:1px solid #d6daeb;border-radius:10px;padding:24px 28px;margin-bottom:20px}
.card h2{margin:0 0 14px;font-size:19px}
.field{display:flex;flex-direction:column;gap:4px;margin-bottom:14px;max-width:380px}
.field label{font-size:14px;font-weight:600}
.field input{padding:9px 11px;border:1px solid #b8bedb;border-radius:6px;font:inherit;font-family:inherit}
.field input[readonly]{background:#f3f4fa;color:#5a6086}
fieldset{border:1px solid #dde0f0;border-radius:8px;margin:0 0 16px;padding:10px 18px 6px}
legend{font-size:13px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:#5a6086;padding:0 6px}
.check{display:grid;grid-template-columns:22px 1fr;column-gap:12px;padding:8px 0}
.check input{width:18px;height:18px;margin:3px 0 0;accent-color:#3342a8}
.check label{font-weight:600;font-size:15px}
.check .hint{grid-column:2;margin:0;font-size:14px;color:#656b8f;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
.form-actions{display:flex;align-items:center;gap:20px;margin-top:8px}
.btn{display:inline-block;border-radius:6px;padding:9px 18px;font-size:15px;cursor:pointer;text-decoration:none;border:1px solid transparent}
.btn.primary{background:#3342a8;color:#fff}
.btn.primary[disabled]{opacity:.7;cursor:wait}
.btn.secondary{background:#fff;color:#3342a8;border-color:#3342a8}
.btn.link{background:none;color:#3342a8;text-decoration:underline;padding:9px 0}
.btn.danger{background:#fff;color:#b3261e;border-color:#b3261e}
.btn.danger.solid{background:#b3261e;color:#fff}
.msg{margin:14px 0 0;padding:9px 14px;border-radius:6px;font-size:15px}
.msg.ok{background:#e6f5ea;color:#17622d;border:1px solid #b5dfc0}
.msg.err{background:#fdecea;color:#8a1f13;border:1px solid #f1b5ae}
.inline-status{margin:8px 0 0;font-size:14px;color:#17622d;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
.card.danger-card{border-color:#e7b9b5;background:#fffafa}
.site-footer{background:#171b36;color:#b8bedb;padding:28px 48px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;font-size:14px}
.footer-inner{max-width:760px;margin:0 auto;display:flex;justify-content:space-between;gap:32px;flex-wrap:wrap}
.site-footer a{color:#b8bedb;margin-right:16px}
.newsletter label{display:block;margin-bottom:4px;color:#fff}
.newsletter-row{display:flex;gap:8px}
.newsletter input{padding:8px 10px;border-radius:6px;border:1px solid #4a5290;background:#232842;color:#fff;width:230px}
.newsletter button{background:#c9cffa;border:0;border-radius:6px;padding:8px 14px;color:#171b36;font-weight:600;cursor:pointer}
.newsletter-msg{margin:6px 0 0;min-height:18px}
.copy{width:100%;margin:0;font-size:13px;color:#7c83ad}
`;

function clientB(cfg) {
  const EMAIL_ROWS = [
    {
      key: 'digest',
      label: 'Send me the weekly digest',
      hint: 'One email every Monday with your orders and picks for the week.',
    },
    {
      key: 'updates',
      label: 'Send me product updates',
      hint: 'Announcements about new features and improvements.',
    },
    {
      key: 'promotional',
      label: 'Send me promotional emails',
      hint: 'Sales, discount codes and special offers.',
    },
    {
      key: 'security',
      label: 'Security alerts',
      hint: "Required for your account and can't be turned off.",
    },
  ];
  const SMS_ROWS = [
    {
      key: 'sms',
      label: 'Send me text message offers',
      hint: 'Occasional offers by SMS to your mobile number.',
    },
  ];
  const OPTIONAL = ['promotional', 'updates', 'digest', 'sms'];
  const model = {
    values: { ...cfg.settings },
    baseline: { ...cfg.settings },
    name: cfg.profile.displayName,
    saving: false,
    status: null,
    nameStatus: '',
  };
  const app = document.getElementById('app');

  function statusHtml() {
    if (!model.status) return '';
    return model.status.kind === 'ok'
      ? `<p class="msg ok" role="status">${esc(model.status.text)}</p>`
      : `<p class="msg err" role="alert">${esc(model.status.text)}</p>`;
  }

  function checkRow(row) {
    const locked = row.key === 'security';
    const checked = locked ? true : model.values[row.key];
    return `<div class="check"><input type="checkbox" id="opt-${row.key}" name="${row.key}"${checked ? ' checked' : ''}${locked ? ' disabled' : ''} aria-describedby="hint-${row.key}"><label for="opt-${row.key}">${row.label}</label><p class="hint" id="hint-${row.key}">${row.hint}</p></div>`;
  }

  function render() {
    app.innerHTML = `
<section class="card" aria-labelledby="h-details">
<h2 id="h-details">Your details</h2>
<form id="name-form" novalidate>
<div class="field"><label for="display-name">Display name</label><input id="display-name" type="text" value="${esc(model.name)}" autocomplete="off"></div>
<div class="field"><label for="account-email">Email address</label><input id="account-email" type="email" value="jordan.ellis@example.com" readonly></div>
<button type="submit" class="btn secondary">Update name</button>
<p class="inline-status" id="name-status" role="status">${esc(model.nameStatus)}</p>
</form>
</section>
<section class="card" aria-labelledby="h-prefs">
<h2 id="h-prefs">Email and text preferences</h2>
<form id="prefs-form" novalidate>
<fieldset><legend>Emails</legend>${EMAIL_ROWS.map(checkRow).join('')}</fieldset>
<fieldset><legend>Text messages</legend>${SMS_ROWS.map(checkRow).join('')}</fieldset>
<div class="form-actions">
<button type="submit" class="btn primary" id="save-prefs"${model.saving ? ' disabled' : ''}>${model.saving ? 'Saving...' : 'Save changes'}</button>
<button type="button" class="btn link" id="unsub-all">Unsubscribe from everything</button>
</div>
<div id="prefs-status">${statusHtml()}</div>
</form>
</section>
<section class="card danger-card" aria-labelledby="h-close">
<h2 id="h-close">Close your account</h2>
<p>Deleting your account removes your orders, saved addresses and wishlist for good.</p>
<a class="btn danger" href="/account/delete">Delete account</a>
</section>`;
  }

  function setStatus(kind, text) {
    model.status = kind ? { kind, text } : null;
    const el = document.getElementById('prefs-status');
    if (el) el.innerHTML = statusHtml();
  }

  function syncSave() {
    const button = document.getElementById('save-prefs');
    if (!button) return;
    button.disabled = model.saving;
    button.textContent = model.saving ? 'Saving...' : 'Save changes';
  }

  async function savePrefs() {
    if (model.saving) return;
    const changes = {};
    for (const key of OPTIONAL) {
      if (model.values[key] !== model.baseline[key]) changes[key] = model.values[key];
    }
    model.saving = true;
    setStatus(null);
    syncSave();
    const result = await api('PUT', '/api/settings', { changes });
    model.saving = false;
    if (result.ok) {
      Object.assign(model.baseline, changes);
      setStatus('ok', 'Saved. Your notification preferences have been updated.');
    } else {
      setStatus('error', 'Your changes could not be saved. Please try again.');
    }
    syncSave();
  }

  async function saveName() {
    const result = await api('PUT', '/api/profile', { displayName: model.name });
    model.nameStatus = result.ok ? 'Name updated.' : 'Could not update your name.';
    const el = document.getElementById('name-status');
    if (el) el.textContent = model.nameStatus;
  }

  app.addEventListener('change', event => {
    const el = event.target;
    if (!(el instanceof HTMLInputElement) || !el.id.startsWith('opt-')) return;
    const key = el.id.replace('opt-', '');
    if (key === 'security') return;
    model.values[key] = el.checked;
    setStatus(null);
  });
  app.addEventListener('input', event => {
    const el = event.target;
    if (el instanceof HTMLInputElement && el.id === 'display-name') {
      model.name = el.value;
      model.nameStatus = '';
    }
  });
  app.addEventListener('submit', event => {
    event.preventDefault();
    if (event.target.id === 'prefs-form') savePrefs();
    else if (event.target.id === 'name-form') saveName();
  });
  app.addEventListener('click', event => {
    const el = event.target instanceof Element ? event.target.closest('button') : null;
    if (!el || el.id !== 'unsub-all') return;
    for (const key of OPTIONAL) {
      model.values[key] = false;
      const box = document.getElementById(`opt-${key}`);
      if (box) box.checked = false;
    }
    setStatus(null);
  });

  render();
  if (cfg.rerenderEveryMs > 0) setInterval(render, cfg.rerenderEveryMs);
}

function clientBDelete() {
  const form = document.getElementById('delete-form');
  const alerts = document.getElementById('delete-alert');
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const result = await api('POST', '/api/account/delete');
    if (result.ok || result.status === 410) {
      location.assign('/goodbye');
    } else {
      alerts.innerHTML =
        '<p class="msg err" role="alert">We could not delete your account right now. Please try again later.</p>';
    }
  });
}

function chromeB(title, current, main, scripts) {
  const link = (href, label) =>
    `<a href="${href}"${current === href ? ' aria-current="page"' : ''}>${label}</a>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} - Fernhill</title>
<style>${B_CSS}</style>
</head>
<body>
<header class="topbar">
  <a class="logo" href="/shop">Fernhill</a>
  <nav aria-label="Main">${link('/shop', 'Shop')}${link('/orders', 'Orders')}${link('/', 'Account')}${link('/help', 'Help')}</nav>
  <a class="cartlink" href="/cart">Basket (0)</a>
</header>
<div class="notice">Spring sale: 20% off selected homeware. <a href="/shop/spring">See the offers</a></div>
<main class="container">
${main}
</main>
<footer class="site-footer">
  <div class="footer-inner">
    <div><a href="/about">About</a><a href="/careers">Careers</a><a href="/shipping">Delivery</a><a href="/returns">Returns</a><a href="/terms">Terms</a></div>
    ${newsletterForm({ label: 'Join our newsletter', button: 'Sign up', placeholder: 'Your email address' })}
    <p class="copy">&copy; 2025 Fernhill Goods Ltd.</p>
  </div>
</footer>
${scripts}
</body>
</html>`;
}

function pageB(path, faults, state) {
  if (path === '/') {
    if (state.accountDeleted) {
      return {
        status: 200,
        html: chromeB(
          'Account deleted',
          '/',
          '<h1>This account has been deleted</h1><p>There is nothing to manage here any more.</p>',
          scriptTag(() => {}, {})
        ),
      };
    }
    const cfg = {
      settings: state.settings,
      profile: state.profile,
      rerenderEveryMs: faults.rerenderEveryMs,
    };
    const main = `<nav class="crumbs" aria-label="Breadcrumb"><a href="/shop">Home</a> / <a href="/">Account</a> / Settings</nav>
<h1>Account settings</h1>
<div id="app"></div>`;
    return { status: 200, html: chromeB('Account settings', '/', main, scriptTag(clientB, cfg)) };
  }
  if (path === '/account/delete') {
    const main = `<nav class="crumbs" aria-label="Breadcrumb"><a href="/shop">Home</a> / <a href="/">Account</a> / Close account</nav>
<h1>Delete your account?</h1>
<section class="card danger-card">
<p>This permanently deletes your orders, saved addresses and wishlist. You will not be able to get them back.</p>
<form id="delete-form">
<div class="form-actions"><button type="submit" class="btn danger solid" id="confirm-delete">Yes, delete my account</button><a class="btn secondary" href="/">No, keep my account</a></div>
<div id="delete-alert"></div>
</form>
</section>`;
    return {
      status: 200,
      html: chromeB('Delete account', '/', main, scriptTag(clientBDelete, {})),
    };
  }
  if (path === '/goodbye') {
    return {
      status: 200,
      html: chromeB(
        'Account deleted',
        '',
        '<h1>Your account has been deleted</h1><p>We are sorry to see you go. A confirmation has been sent to your email.</p><p><a href="/shop">Back to the shop</a></p>',
        scriptTag(() => {}, {})
      ),
    };
  }
  const title = PAGE_TITLES[path];
  if (title) {
    return {
      status: 200,
      html: chromeB(
        title,
        path,
        `<h1>${title}</h1><section class="card"><p>Nothing to review here right now.</p></section>`,
        scriptTag(() => {}, {})
      ),
    };
  }
  return {
    status: 404,
    html: chromeB(
      'Page not found',
      '',
      '<h1>Page not found</h1><p>We could not find the page you were looking for.</p>',
      scriptTag(() => {}, {})
    ),
  };
}

/* --------------------------------- variant C ---------------------------------- */

const C_CSS = `
*{box-sizing:border-box}
body{margin:0;font:15px/1.55 "Helvetica Neue",Helvetica,Arial,sans-serif;color:#2b2420;background:#f7f2ec}
a{color:#a8421b}
[hidden]{display:none!important}
button,input,select{font:inherit}
.header{display:flex;align-items:center;gap:24px;padding:12px 40px;background:#2b2420;color:#f7f2ec}
.header .brand{font-size:21px;font-weight:700;color:#f7f2ec;text-decoration:none}
.search{display:flex;gap:6px;flex:1;max-width:360px}
.search input{flex:1;padding:7px 10px;border-radius:6px;border:1px solid #6b5d52;background:#3a312b;color:#fff}
.search button{border:0;border-radius:6px;background:#e0a074;color:#2b2420;padding:7px 12px;cursor:pointer;font-weight:600}
.header nav{display:flex;gap:18px;margin-left:auto;align-items:center}
.header nav a{color:#e9ddd1;text-decoration:none}
.header nav button{background:none;border:1px solid #6b5d52;color:#e9ddd1;border-radius:6px;padding:5px 12px;cursor:pointer}
.strip{background:#f0d9c4;color:#5b2c10;padding:8px 40px;font-size:14px}
.wrap{max-width:940px;margin:0 auto;padding:28px 24px 48px}
.card{background:#fff;border:1px solid #e6d9cc;border-radius:12px;padding:22px 26px;margin-bottom:22px}
.card h2{margin:0 0 12px;font-size:18px}
.hello{font-size:26px;margin:0 0 4px}
.stats{display:flex;gap:36px;margin-top:16px}
.stats div{display:flex;flex-direction:column}
.stats strong{font-size:22px}
.stats span{color:#7b6c5f;font-size:13px}
table{width:100%;border-collapse:collapse}
th,td{text-align:left;padding:11px 8px;border-bottom:1px solid #eee3d8;font-size:14px}
th{color:#7b6c5f;font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.05em}
.addr-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.addr{border:1px solid #e6d9cc;border-radius:10px;padding:14px 16px;line-height:1.5}
.addr a{font-size:14px}
.accordion{border:1px solid #e6d9cc;border-radius:12px;background:#fff;overflow:hidden}
.acc-item+.acc-item{border-top:1px solid #e6d9cc}
.acc-h{margin:0}
.acc-btn{width:100%;display:flex;align-items:center;justify-content:space-between;padding:18px 26px;background:#fff;border:0;font-size:17px;font-weight:600;cursor:pointer;text-align:left;color:#2b2420}
.acc-btn:hover{background:#fbf6f0}
.chev{width:10px;height:10px;border-right:2px solid #7b6c5f;border-bottom:2px solid #7b6c5f;transform:rotate(45deg);transition:transform .15s}
.acc-btn[aria-expanded="true"] .chev{transform:rotate(-135deg)}
.acc-panel{padding:6px 26px 26px}
.tabs{display:flex;gap:4px;border-bottom:2px solid #eee3d8;margin:6px 0 18px}
.tab{background:none;border:0;padding:10px 16px;cursor:pointer;color:#7b6c5f;border-bottom:3px solid transparent;margin-bottom:-2px;font-weight:600}
.tab[aria-selected="true"]{color:#a8421b;border-bottom-color:#a8421b}
.tabpanel h3{margin:0 0 4px;font-size:16px}
.sub{margin:0 0 12px;color:#7b6c5f}
dl{display:grid;grid-template-columns:160px 1fr;gap:8px 16px;margin:0}
dt{color:#7b6c5f}
dd{margin:0}
.status{min-height:22px;margin:0 0 6px;font-size:14px;color:#3b6b2a}
.status.err{color:#a1281c;font-weight:600}
.status:empty{display:none}
.toggle-row{position:relative;padding:14px 0;border-bottom:1px solid #eee3d8}
.toggle-row:first-of-type{border-top:1px solid #eee3d8}
.vh{position:absolute;width:1px;height:1px;margin:-1px;padding:0;border:0;overflow:hidden;clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap}
.toggle{display:flex;align-items:center;justify-content:space-between;gap:16px;font-weight:600;cursor:pointer;max-width:560px}
.toggle::after{content:"";flex:none;width:44px;height:24px;border-radius:12px;background-color:#bfae9c;background-image:radial-gradient(circle at 12px 12px,#fff 9px,transparent 10px);background-size:24px 24px;background-repeat:no-repeat;background-position:0 0;transition:background-position .15s,background-color .15s}
.vh:checked+.toggle::after{background-color:#b4491f;background-position:20px 0}
.vh:disabled+.toggle{opacity:.6;cursor:not-allowed}
.vh:focus-visible+.toggle::after{outline:3px solid #f0b99f;outline-offset:2px}
.toggle-desc{margin:2px 0 0;color:#7b6c5f;font-size:14px;max-width:520px}
.field{display:flex;flex-direction:column;gap:4px;margin-bottom:12px;max-width:360px}
.field label{font-weight:600;font-size:14px}
.field input{padding:8px 10px;border:1px solid #cdbba9;border-radius:6px}
.field input[readonly]{background:#f6f0e9;color:#7b6c5f}
.btn{border:1px solid #cdbba9;background:#fff;border-radius:8px;padding:8px 16px;cursor:pointer;color:#2b2420}
.btn.primary{background:#a8421b;border-color:#a8421b;color:#fff}
.btn.danger{background:#b3261e;border-color:#b3261e;color:#fff}
.btn.warn{border-color:#d9776c;color:#a32a1c}
.priv-row{display:flex;align-items:center;justify-content:space-between;gap:24px;padding:12px 0;border-top:1px solid #eee3d8}
.priv-row:first-of-type{border-top:0}
.priv-row p{margin:0;color:#7b6c5f;font-size:14px}
.loading{color:#7b6c5f;padding:40px 0}
.scrim{position:fixed;inset:0;background:rgba(30,20,12,.5);display:grid;place-items:center}
.dialog{background:#fff;border-radius:14px;padding:24px 28px;width:440px;box-shadow:0 20px 50px rgba(0,0,0,.3)}
.dialog h2{margin:0 0 8px}
.dialog-actions{display:flex;justify-content:flex-end;gap:10px;margin-top:20px}
.site-footer{background:#2b2420;color:#cdbba9;padding:26px 40px;font-size:14px}
.footer-inner{max-width:940px;margin:0 auto;display:flex;justify-content:space-between;gap:32px;flex-wrap:wrap;align-items:flex-start}
.site-footer a{color:#e9ddd1;margin-right:14px}
.newsletter label{display:block;margin-bottom:4px;color:#fff}
.newsletter-row{display:flex;gap:8px}
.newsletter input{padding:7px 10px;border-radius:6px;border:1px solid #6b5d52;background:#3a312b;color:#fff;width:220px}
.newsletter button{background:#e0a074;border:0;border-radius:6px;padding:7px 14px;color:#2b2420;font-weight:600;cursor:pointer}
.newsletter-msg{margin:6px 0 0;min-height:18px}
.copy{width:100%;margin:0;font-size:13px;color:#8d7d6f}
`;

function clientC(cfg) {
  const ROWS = [
    {
      key: 'security',
      name: 'Security alerts',
      desc: 'Important notices about sign-ins and password changes. Required, so this one stays on.',
    },
    {
      key: 'promotional',
      name: 'Promotions and offers by email',
      desc: 'Discount codes, seasonal sales and member-only offers.',
    },
    {
      key: 'sms',
      name: 'Text message (SMS) offers',
      desc: 'Short flash-sale messages to your registered mobile number.',
    },
    {
      key: 'updates',
      name: 'Product news and updates',
      desc: 'New arrivals, feature launches and restock announcements.',
    },
    {
      key: 'digest',
      name: 'Weekly digest email',
      desc: 'Everything worth knowing, once a week.',
    },
  ];
  const OPTIONAL = ['promotional', 'updates', 'digest', 'sms'];
  const TABS = [
    { id: 'general', label: 'General' },
    { id: 'notifications', label: 'Notifications' },
    { id: 'devices', label: 'Linked devices' },
  ];
  const ORDERS = [
    ['FH-10482', '14 Mar 2025', 'Delivered', '84.00'],
    ['FH-10377', '02 Mar 2025', 'Delivered', '36.50'],
    ['FH-10291', '19 Feb 2025', 'Delivered', '212.00'],
    ['FH-10188', '27 Jan 2025', 'Returned', '58.25'],
    ['FH-10120', '11 Jan 2025', 'Delivered', '19.99'],
    ['FH-10043', '23 Dec 2024', 'Delivered', '147.80'],
    ['FH-09976', '30 Nov 2024', 'Delivered', '64.00'],
    ['FH-09871', '08 Nov 2024', 'Delivered', '27.40'],
  ];
  const model = {
    path: location.pathname,
    query: location.search,
    settings: null,
    confirmed: null,
    name: '',
    nameStatus: '',
    deleted: false,
    open: { profile: true, comms: false, privacy: false },
    tab: 'general',
    status: null,
    privacyStatus: null,
  };
  const app = document.getElementById('app');
  const overlay = document.getElementById('overlay');
  let queue = Promise.resolve();

  const isAccount = path => path === '/';

  function statusHtml() {
    if (!model.status)
      return '<p class="status" role="status" id="status-ok"></p><p class="status err" role="alert" id="status-err"></p>';
    const ok = model.status.kind !== 'error';
    return `<p class="status" role="status" id="status-ok">${ok ? esc(model.status.text) : ''}</p><p class="status err" role="alert" id="status-err">${ok ? '' : esc(model.status.text)}</p>`;
  }

  function setStatus(kind, text) {
    model.status = kind ? { kind, text } : null;
    const ok = document.getElementById('status-ok');
    const err = document.getElementById('status-err');
    if (ok) ok.textContent = kind && kind !== 'error' ? text : '';
    if (err) err.textContent = kind === 'error' ? text : '';
  }

  function privacyStatusHtml() {
    const current = model.privacyStatus;
    const failed = current !== null && current.kind === 'error';
    return `<p class="status" role="status" id="privacy-ok">${current && !failed ? esc(current.text) : ''}</p><p class="status err" role="alert" id="privacy-err">${failed ? esc(current.text) : ''}</p>`;
  }

  function setPrivacyStatus(kind, text) {
    model.privacyStatus = kind ? { kind, text } : null;
    const ok = document.getElementById('privacy-ok');
    const err = document.getElementById('privacy-err');
    if (ok) ok.textContent = kind === 'ok' ? text : '';
    if (err) err.textContent = kind === 'error' ? text : '';
  }

  function toggleRow(row) {
    const locked = row.key === 'security';
    const checked = locked ? true : !!model.settings[row.key];
    return `<div class="toggle-row"><input type="checkbox" class="vh" id="pref-${row.key}"${checked ? ' checked' : ''}${locked ? ' disabled' : ''} aria-describedby="pd-${row.key}"><label class="toggle" for="pref-${row.key}">${row.name}</label><p class="toggle-desc" id="pd-${row.key}">${row.desc}</p></div>`;
  }

  function tabPanel(id) {
    const hidden = model.tab === id ? '' : ' hidden';
    const attrs = `role="tabpanel" class="tabpanel" id="tabpanel-${id}" aria-labelledby="tab-${id}"${hidden}`;
    if (id === 'general') {
      return `<div ${attrs}><h3>General</h3><p class="sub">How your account is set up on Fernhill.</p><dl><dt>Primary email</dt><dd>jordan.ellis@example.com</dd><dt>Language</dt><dd>English (UK)</dd><dt>Time zone</dt><dd>London (GMT)</dd><dt>Currency</dt><dd>Pound sterling</dd></dl></div>`;
    }
    if (id === 'notifications') {
      return `<div ${attrs}><h3>Notification settings</h3><p class="sub">Changes are saved automatically.</p><div id="status-box">${statusHtml()}</div><div class="toggle-list">${ROWS.map(toggleRow).join('')}</div></div>`;
    }
    return `<div ${attrs}><h3>Linked devices</h3><p class="sub">Devices that are signed in to your account.</p><p>No other devices are linked.</p></div>`;
  }

  function accordionItem(id, title, body) {
    const open = model.open[id];
    return `<div class="acc-item"><h2 class="acc-h"><button type="button" class="acc-btn" id="acc-${id}" aria-expanded="${open}" aria-controls="acc-panel-${id}">${title}<span class="chev" aria-hidden="true"></span></button></h2><div class="acc-panel" id="acc-panel-${id}" role="region" aria-labelledby="acc-${id}"${open ? '' : ' hidden'}>${body}</div></div>`;
  }

  function accountView() {
    if (!model.settings) return '<p class="loading">Loading your account...</p>';
    const profile = `<form id="name-form" novalidate><div class="field"><label for="display-name">Display name</label><input id="display-name" type="text" value="${esc(model.name)}" autocomplete="off"></div><div class="field"><label for="account-email">Email address</label><input id="account-email" type="email" value="jordan.ellis@example.com" readonly></div><button type="submit" class="btn">Update details</button><p class="sub" id="name-status" role="status">${esc(model.nameStatus)}</p></form>`;
    const comms = `<div class="tabs" role="tablist" aria-label="Communication settings">${TABS.map(
      t =>
        `<button type="button" role="tab" class="tab" id="tab-${t.id}" aria-selected="${model.tab === t.id}" aria-controls="tabpanel-${t.id}">${t.label}</button>`
    ).join('')}</div>${TABS.map(t => tabPanel(t.id)).join('')}`;
    const privacy = `${privacyStatusHtml()}<div class="priv-row"><div><strong>Unsubscribe from everything</strong><p>Stop all optional emails and text messages.</p></div><button type="button" class="btn warn" id="unsub-all">Unsubscribe from everything</button></div><div class="priv-row"><div><strong>Delete account</strong><p>Permanently remove your account and order history.</p></div><button type="button" class="btn danger" id="delete-account">Delete account</button></div>`;
    return `<section class="card"><h1 class="hello">Welcome back, ${esc(model.name)}</h1><p class="sub">Member since March 2021</p><div class="stats"><div><strong>18</strong><span>Orders placed</span></div><div><strong>1,240</strong><span>Reward points</span></div><div><strong>3</strong><span>Wishlist items</span></div></div></section>
<section class="card"><h2>Recent orders</h2><table><thead><tr><th scope="col">Order</th><th scope="col">Date</th><th scope="col">Status</th><th scope="col">Total</th><th scope="col"><span class="vh">Details</span></th></tr></thead><tbody>${ORDERS.map(
      o =>
        `<tr><td>${o[0]}</td><td>${o[1]}</td><td>${o[2]}</td><td>&pound;${o[3]}</td><td><a class="spa" href="/orders">View</a></td></tr>`
    ).join('')}</tbody></table></section>
<section class="card"><h2>Saved addresses</h2><div class="addr-grid"><div class="addr"><strong>Home</strong><br>14 Alder Row<br>Bristol BS1 4QA<br><a class="spa" href="/profile">Edit address</a></div><div class="addr"><strong>Work</strong><br>2 Mill Lane<br>Bristol BS2 0JA<br><a class="spa" href="/profile">Edit address</a></div></div></section>
<div class="accordion">${accordionItem('profile', 'Profile details', profile)}${accordionItem('comms', 'Communication preferences', comms)}${accordionItem('privacy', 'Privacy and data', privacy)}</div>`;
  }

  function otherView() {
    if (model.path === '/search') {
      const q = new URLSearchParams(model.query).get('q') || '';
      return `<section class="card"><h1 class="hello">Search</h1><p class="sub">No results for &ldquo;${esc(q)}&rdquo;.</p><a class="spa" href="/">Back to my account</a></section>`;
    }
    const title = cfg.titles[model.path];
    if (!title) {
      return `<section class="card"><h1 class="hello">Page not found</h1><p class="sub">We couldn't find the page you were looking for.</p><a class="spa" href="/">Back to my account</a></section>`;
    }
    return `<section class="card"><h1 class="hello">${esc(title)}</h1><p class="sub">Nothing to review here right now.</p><a class="spa" href="/">Back to my account</a></section>`;
  }

  function render() {
    let html;
    if (model.deleted) {
      html = `<section class="card"><h1 class="hello">Your account has been deleted</h1><p class="sub">We're sorry to see you go. A confirmation has been sent to your email.</p><a class="spa" href="/shop">Back to the shop</a></section>`;
    } else {
      html = isAccount(model.path) ? accountView() : otherView();
    }
    document.title = `${model.deleted ? 'Account deleted' : isAccount(model.path) ? 'My account' : cfg.titles[model.path] || 'Not found'} - Fernhill`;
    app.innerHTML = html;
  }

  function syncAccordion() {
    for (const id of ['profile', 'comms', 'privacy']) {
      const btn = document.getElementById(`acc-${id}`);
      const panel = document.getElementById(`acc-panel-${id}`);
      if (btn) btn.setAttribute('aria-expanded', String(model.open[id]));
      if (panel) panel.hidden = !model.open[id];
    }
  }

  function syncTabs() {
    for (const tab of TABS) {
      const btn = document.getElementById(`tab-${tab.id}`);
      const panel = document.getElementById(`tabpanel-${tab.id}`);
      if (btn) btn.setAttribute('aria-selected', String(model.tab === tab.id));
      if (panel) panel.hidden = model.tab !== tab.id;
    }
  }

  function syncChecks() {
    if (!model.settings) return;
    for (const key of OPTIONAL) {
      const el = document.getElementById(`pref-${key}`);
      if (el) el.checked = !!model.settings[key];
    }
  }

  async function load() {
    const [settings, account] = await Promise.all([
      api('GET', '/api/settings'),
      api('GET', '/api/account'),
    ]);
    if (!isAccount(model.path)) return;
    if (settings.status === 410 || account.status === 410) {
      model.deleted = true;
    } else if (settings.ok && account.ok) {
      model.settings = { ...settings.data.settings };
      model.confirmed = { ...settings.data.settings };
      model.name = account.data.profile.displayName;
    } else {
      app.innerHTML =
        '<p class="loading">We could not load your account. Please refresh and try again.</p>';
      return;
    }
    render();
  }

  async function enter() {
    overlay.innerHTML = '';
    if (isAccount(model.path) && !model.deleted) {
      model.settings = null;
      model.status = null;
      model.privacyStatus = null;
      render();
      await load();
    } else {
      render();
    }
  }

  function go(url) {
    history.pushState({}, '', url);
    model.path = location.pathname;
    model.query = location.search;
    window.scrollTo(0, 0);
    enter();
  }

  async function persist(key, next) {
    const result = await api('PUT', '/api/settings', { key, value: next });
    if (result.ok) {
      if (model.confirmed) model.confirmed[key] = next;
      setStatus('ok', 'All changes saved');
    } else {
      if (model.settings && model.confirmed) {
        model.settings[key] = model.confirmed[key];
        syncChecks();
      }
      setStatus('error', "We couldn't save that change, so the setting was left as it was.");
    }
  }

  function onChange(input) {
    const key = input.id.replace('pref-', '');
    if (!model.settings || !OPTIONAL.includes(key)) return;
    const next = input.checked;
    model.settings[key] = next;
    setStatus('pending', 'Saving...');
    queue = queue.then(() => persist(key, next));
  }

  function openDialog(kind) {
    const del = kind === 'delete';
    overlay.innerHTML = `<div class="scrim"><div class="dialog" role="alertdialog" aria-modal="true" aria-labelledby="dlg-title" aria-describedby="dlg-text"><h2 id="dlg-title">${del ? 'Delete your account?' : 'Unsubscribe from everything?'}</h2><p id="dlg-text">${del ? 'Your account, orders and saved addresses will be removed for good.' : 'You will stop receiving every optional email and text message.'}</p><div class="dialog-actions"><button type="button" class="btn" id="dlg-cancel">Cancel</button><button type="button" class="btn ${del ? 'danger' : 'warn'}" id="${del ? 'dlg-delete' : 'dlg-unsub'}">${del ? 'Delete my account' : 'Yes, unsubscribe'}</button></div></div></div>`;
    document.getElementById('dlg-cancel').focus();
  }

  async function unsubscribeAll() {
    overlay.innerHTML = '';
    setPrivacyStatus(null);
    const result = await api('POST', '/api/settings/unsubscribe-all');
    if (result.ok) {
      for (const key of OPTIONAL) {
        if (model.settings) model.settings[key] = false;
        if (model.confirmed) model.confirmed[key] = false;
      }
      syncChecks();
      setPrivacyStatus('ok', 'You are now unsubscribed from all optional notifications.');
    } else {
      setPrivacyStatus('error', "We couldn't update your notifications. Please try again.");
    }
  }

  async function deleteAccount() {
    overlay.innerHTML = '';
    setPrivacyStatus(null);
    const result = await api('POST', '/api/account/delete');
    if (result.ok || result.status === 410) {
      model.deleted = true;
      render();
    } else {
      setPrivacyStatus(
        'error',
        "We couldn't delete your account right now. Please try again later."
      );
    }
  }

  async function saveName() {
    const result = await api('PUT', '/api/profile', { displayName: model.name });
    model.nameStatus = result.ok ? 'Details updated.' : 'We could not update your details.';
    const el = document.getElementById('name-status');
    if (el) el.textContent = model.nameStatus;
  }

  document.addEventListener('click', event => {
    const el = event.target instanceof Element ? event.target : null;
    if (!el) return;
    const link = el.closest('a.spa');
    if (link && !event.metaKey && !event.ctrlKey && !event.shiftKey) {
      event.preventDefault();
      go(link.getAttribute('href'));
      return;
    }
    const button = el.closest('button');
    if (!button) return;
    if (button.id.startsWith('acc-') && button.classList.contains('acc-btn')) {
      const id = button.id.replace('acc-', '');
      model.open[id] = !model.open[id];
      syncAccordion();
    } else if (button.classList.contains('tab')) {
      model.tab = button.id.replace('tab-', '');
      syncTabs();
    } else if (button.id === 'unsub-all') openDialog('unsub');
    else if (button.id === 'delete-account') openDialog('delete');
    else if (button.id === 'dlg-cancel') overlay.innerHTML = '';
    else if (button.id === 'dlg-unsub') unsubscribeAll();
    else if (button.id === 'dlg-delete') deleteAccount();
    else if (button.id === 'sign-out') go('/signed-out');
  });
  document.addEventListener('change', event => {
    const el = event.target;
    if (el instanceof HTMLInputElement && el.id.startsWith('pref-')) onChange(el);
  });
  document.addEventListener('input', event => {
    const el = event.target;
    if (el instanceof HTMLInputElement && el.id === 'display-name') {
      model.name = el.value;
      model.nameStatus = '';
    }
  });
  document.addEventListener('submit', event => {
    event.preventDefault();
    const form = event.target;
    if (form.id === 'name-form') saveName();
    else if (form.id === 'site-search') {
      const q = document.getElementById('site-search-input').value.trim();
      go(`/search?q=${encodeURIComponent(q)}`);
    }
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') overlay.innerHTML = '';
  });
  window.addEventListener('popstate', () => {
    model.path = location.pathname;
    model.query = location.search;
    enter();
  });

  enter();
  if (cfg.rerenderEveryMs > 0) setInterval(render, cfg.rerenderEveryMs);
}

function pageC(faults) {
  const cfg = { rerenderEveryMs: faults.rerenderEveryMs, titles: PAGE_TITLES };
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>My account - Fernhill</title>
<style>${C_CSS}</style>
</head>
<body>
<header class="header">
  <a class="spa brand" href="/shop">Fernhill</a>
  <form class="search" id="site-search" role="search"><input id="site-search-input" type="search" placeholder="Search Fernhill" aria-label="Search the shop"><button type="submit">Search</button></form>
  <nav aria-label="Main"><a class="spa" href="/orders">Orders</a><a class="spa" href="/wishlist">Wishlist</a><a class="spa" href="/help">Help</a><button type="button" id="sign-out">Sign out</button></nav>
</header>
<div class="strip">Members get early access to the spring collection. <a class="spa" href="/shop/spring">Browse early access</a></div>
<div class="wrap" id="app"></div>
<footer class="site-footer">
  <div class="footer-inner">
    <div><a href="/about">About us</a><a href="/careers">Careers</a><a href="/shipping">Delivery</a><a href="/returns">Returns</a><a href="/terms">Terms</a></div>
    ${newsletterForm({ label: 'Be first to hear about new arrivals', button: 'Join', placeholder: 'name@example.com' })}
    <p class="copy">&copy; 2025 Fernhill Goods Ltd.</p>
  </div>
</footer>
<div id="overlay"></div>
${scriptTag(clientC, cfg)}
</body>
</html>`;
}

/* ----------------------------------- server ----------------------------------- */

const PAGES = {
  A: (path, faults) => ({
    status: path === '/' || path === '/settings/notifications' || PAGE_TITLES[path] ? 200 : 404,
    html: pageA(faults),
  }),
  B: (path, faults, state) => pageB(path, faults, state),
  C: (path, faults) => ({
    status: path === '/' || PAGE_TITLES[path] ? 200 : 404,
    html: pageC(faults),
  }),
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export async function startApp({ port = 0, variant = 'A', initial = {}, faults = {} } = {}) {
  if (!variants.includes(variant)) {
    throw new RangeError(`settings: unknown variant "${variant}" (expected one of ${variants})`);
  }
  const activeFaults = normalizeFaults(faults);
  const store = createStore(initial);
  const sockets = new Set();
  const timers = new Set();

  const send = (res, status, contentType, payload) => {
    res.writeHead(status, {
      'content-type': contentType,
      'cache-control': 'no-store',
    });
    res.end(payload);
  };
  const sendJson = (res, status, json) =>
    send(res, status, 'application/json; charset=utf-8', JSON.stringify(json));
  const sendLater = (res, status, json) => {
    if (activeFaults.slowResponseMs <= 0) {
      sendJson(res, status, json);
      return;
    }
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (!res.destroyed) sendJson(res, status, json);
    }, activeFaults.slowResponseMs);
    timers.add(timer);
  };

  async function handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname;
    const method = req.method ?? 'GET';

    if (path === '/__test/state' && method === 'GET') {
      sendJson(res, 200, store.state());
      return;
    }
    if (path === '/__test/reset' && method === 'POST') {
      const raw = await readBody(req);
      let initialOverride;
      try {
        const parsed = raw ? JSON.parse(raw) : undefined;
        initialOverride =
          parsed && typeof parsed === 'object' ? (parsed.initial ?? parsed) : undefined;
        if (initialOverride && Object.keys(initialOverride).length === 0)
          initialOverride = undefined;
        store.reset(initialOverride);
      } catch (error) {
        sendJson(res, 400, { error: String(error?.message ?? error) });
        return;
      }
      sendJson(res, 200, { ok: true });
      return;
    }
    if (path === '/favicon.ico') {
      res.writeHead(204);
      res.end();
      return;
    }

    const rawBody = await readBody(req);
    store.log(method, path, url.searchParams, rawBody);

    if (path.startsWith('/api/')) {
      let parsedBody;
      if (rawBody) {
        try {
          parsedBody = JSON.parse(rawBody);
        } catch {
          sendLater(res, 400, { error: 'invalid_json' });
          return;
        }
      }
      const outcome = store.route(method, path, parsedBody, activeFaults);
      sendLater(res, outcome.status, outcome.json);
      return;
    }
    if (method !== 'GET' && method !== 'HEAD') {
      send(res, 405, 'text/plain; charset=utf-8', 'Method not allowed');
      return;
    }
    const page = PAGES[variant](path, activeFaults, store.state());
    send(res, page.status, 'text/html; charset=utf-8', page.html);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Internal error');
    });
  });
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const boundPort = server.address().port;
  const origin = `http://127.0.0.1:${boundPort}`;
  let closePromise = null;

  return {
    url: `${origin}/`,
    origin,
    family,
    variant,
    state: () => store.state(),
    requests: () => store.requests(),
    reset: initialOverride => store.reset(initialOverride),
    close() {
      if (!closePromise) {
        closePromise = new Promise(resolve => {
          for (const timer of timers) clearTimeout(timer);
          timers.clear();
          server.close(() => resolve());
          server.closeAllConnections();
          for (const socket of sockets) socket.destroy();
        });
      }
      return closePromise;
    },
  };
}
