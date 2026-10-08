import crypto from 'node:crypto';
import { getEventListeners } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  DEFAULT_JEV_CONCURRENCY,
  REDACTED,
  UNREDACTABLE,
  createJevGate,
  createRecordingHttp,
  getProcessGate,
} from './jev.mjs';
import {
  VIEWPORT,
  findChromium,
  launchBrowser,
  loadPlaywright,
  newScenarioContext,
} from './browser.mjs';
import { classifyEvaluateError, createPlaywrightTransport } from './host.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHECK_TIMEOUT_MS = 60000;

// ---------------------------------------------------------------------------------------------
// check runner (assertion messages never print values: secrets are only ever tested with ok())
// ---------------------------------------------------------------------------------------------

let passed = 0;
let total = 0;
const failed = [];

const ok = (condition, label) => {
  if (!condition) {
    throw new Error(label);
  }
};
const show = value => {
  const text = JSON.stringify(value);
  return text === undefined ? String(value) : text.slice(0, 160);
};
const eq = (actual, expected, label) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label}: expected ${show(expected)} got ${show(actual)}`);
  }
};
const rejects = async (promise, name, label) => {
  let caught;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  ok(caught !== undefined, `${label}: did not reject`);
  eq(caught.name, name, `${label}: error name`);
  return caught;
};

async function check(name, fn) {
  total += 1;
  let timer;
  try {
    await Promise.race([
      fn(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('check timed out')), CHECK_TIMEOUT_MS);
      }),
    ]);
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    failed.push(name);
    console.log(`FAIL ${name}: ${String(error?.message ?? error).split('\n')[0]}`);
  } finally {
    clearTimeout(timer);
  }
}

const section = title => console.log(`\n== ${title}`);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Node warnings (timer overflow, listener leaks) are a log sink the modules must never write to.
const processWarnings = [];
process.on('warning', warning => {
  processWarnings.push(`${warning.name}: ${String(warning.message).split('\n')[0]}`);
});

const leavesOf = (value, into = []) => {
  if (typeof value === 'string') {
    into.push(value);
  } else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      into.push(key);
      leavesOf(item, into);
    }
  }
  return into;
};

// ---------------------------------------------------------------------------------------------
// run-time generated fake secrets (nothing here is a literal credential)
// ---------------------------------------------------------------------------------------------

const hex = bytes => crypto.randomBytes(bytes).toString('hex');
const digits = count => Array.from(crypto.randomBytes(count), byte => byte % 10).join('');
const FAKE_KEY = `jt_${hex(18)}`;
const FAKE_PASSWORD = `Pw ${hex(6)}"q\\z+${hex(2)}`;
const FAKE_DIGITS = `4${digits(15)}`;
const FAKE_CARD_SPACED = FAKE_DIGITS.replace(/(.{4})(?=.)/g, '$1 ');
const FAKE_CARD_DASHED = FAKE_DIGITS.replace(/(.{4})(?=.)/g, '$1-');
const HOST_SECRET = hex(10);

// ---------------------------------------------------------------------------------------------
// local stand-in for the Jev endpoint
// ---------------------------------------------------------------------------------------------

const defaultPlan = ({ index }) => ({
  status: 200,
  headers: { 'x-typesafe-request-id': `rq_${index}` },
  json: { model: 'jev-1.13.0', answers: { operation: { choice: 'CLICK', confidence: 0.9 } } },
});

async function startJevServer() {
  const state = { hits: [], inFlight: 0, peak: 0, handler: undefined };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const index = state.hits.length;
      const bodyText = Buffer.concat(chunks).toString('utf8');
      state.hits.push({ index, method: req.method, url: req.url, headers: req.headers, bodyText });
      state.inFlight += 1;
      state.peak = Math.max(state.peak, state.inFlight);
      let released = false;
      res.on('close', () => {
        if (!released) {
          released = true;
          state.inFlight -= 1;
        }
      });
      const plan = (state.handler ?? defaultPlan)({ index, req, bodyText });
      const reply = () => {
        if (plan.destroy === true) {
          req.socket.destroy();
          return;
        }
        res.writeHead(plan.status ?? 200, {
          'content-type': plan.text === undefined ? 'application/json' : 'text/plain',
          ...(plan.headers ?? {}),
        });
        res.end(plan.text === undefined ? JSON.stringify(plan.json ?? {}) : plan.text);
      };
      if (plan.delayMs === undefined) {
        reply();
      } else {
        setTimeout(reply, plan.delayMs);
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    state,
    port,
    url: `http://127.0.0.1:${port}/v1/systemone`,
    reset: () => {
      state.hits.length = 0;
      state.peak = 0;
      state.handler = undefined;
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

const bodyFor = (tag, extra = {}) => ({
  model: 'jev-latest',
  state: { page: { url: `http://127.0.0.1/${tag}` }, ...extra },
  questions: { operation: { criteria: { CLICK: 'choose the control', DONE: 'finish' } } },
});

const initFor = (body, overrides = {}) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  credential: () => FAKE_KEY,
  body: JSON.stringify(body),
  timeoutMs: 5000,
  ...overrides,
});

const countingCredential = () => {
  const counter = { calls: 0 };
  counter.read = () => {
    counter.calls += 1;
    return FAKE_KEY;
  };
  return counter;
};

const manualTask = () => {
  const task = { started: false };
  task.promise = new Promise(resolve => {
    task.finish = resolve;
  });
  task.run = () => {
    task.started = true;
    return task.promise;
  };
  return task;
};

// ---------------------------------------------------------------------------------------------
// local pages and a stub bridge bundle (UMD shape of dist/index.umd.js, no dist needed)
// ---------------------------------------------------------------------------------------------

const STUB_UMD = String.raw`(function (global, factory) {
  typeof exports === 'object' && typeof module !== 'undefined' ? factory(exports) :
  typeof define === 'function' && define.amd ? define(['exports'], factory) :
  (global = typeof globalThis !== 'undefined' ? globalThis : global || self, factory(global.WebAutomata = {}));
})(this, (function (exports) {
  'use strict';
  var PROTOCOL = 'kriya.task.v1';
  function randomHex(length) {
    var out = '';
    while (out.length < length) { out += Math.floor(Math.random() * 16).toString(16); }
    return out;
  }
  function installTaskBridge(options) {
    var g = globalThis;
    var name = (options && options.globalName) || '__kriyaTaskBridge';
    var installs = g.__stubInstalls || (g.__stubInstalls = []);
    var isTop = g.top === g;
    installs.push({ isTop: isTop, url: String(g.location.href) });
    if (!isTop || Object.prototype.hasOwnProperty.call(g, name)) { return { installed: false }; }
    var documentId = 'doc_' + randomHex(12);
    var ready = false;
    var order = (g.__stubOrder = []);
    var executions = (g.__stubExecutions = { started: 0, cancelled: 0 });
    var live = new Map();
    var finished = new Set();
    var tombstones = new Set();
    var failedCancelled = { status: 'failed', code: 'EXECUTION_CANCELLED', effect: 'none' };
    var uncertainCancelled = { status: 'uncertain', code: 'EXECUTION_CANCELLED', effect: 'uncertain' };
    var markReady = function () { ready = true; };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', markReady, { once: true });
    } else {
      markReady();
    }
    function respond(envelope, ok, payload) {
      var base = { protocol: PROTOCOL, callId: envelope.callId, documentId: documentId, method: envelope.method, ok: ok };
      if (ok) { base.value = payload; } else { base.error = payload; }
      return base;
    }
    function wait(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }
    function execute(envelope) {
      var stub = (envelope.payload && envelope.payload.__stub) || {};
      if (tombstones.has(envelope.callId)) { return Promise.resolve(respond(envelope, true, failedCancelled)); }
      return new Promise(function (resolve) {
        var entry = { phase: 'not_started', timer: null };
        function finish(outcome) {
          if (entry.timer) { clearTimeout(entry.timer); }
          live.delete(envelope.callId);
          finished.add(envelope.callId);
          resolve(respond(envelope, true, outcome));
        }
        entry.abort = function () {
          executions.cancelled += 1;
          finish(entry.phase === 'after_commit' ? uncertainCancelled : failedCancelled);
        };
        live.set(envelope.callId, entry);
        executions.started += 1;
        entry.phase = 'before_commit';
        if (stub.click) { entry.phase = 'after_commit'; document.querySelector(stub.click).click(); }
        if (stub.hold) {
          entry.timer = setTimeout(function () { finish({ status: 'applied', effect: 'applied' }); }, stub.hold);
        } else {
          finish({ status: 'applied', effect: 'applied' });
        }
      });
    }
    function cancel(envelope) {
      var target = envelope.payload && envelope.payload.targetCallId;
      var entry = live.get(target);
      if (entry) {
        var phase = entry.phase;
        entry.abort();
        return respond(envelope, true, { found: true, phase: phase });
      }
      if (finished.has(target)) { return respond(envelope, true, { found: true, phase: 'finished' }); }
      tombstones.add(target);
      return respond(envelope, true, { found: false, phase: 'unknown' });
    }
    async function invoke(envelope) {
      order.push({ method: envelope.method, callId: envelope.callId });
      var stub = (envelope.payload && envelope.payload.__stub) || {};
      if (stub.throw) { throw new Error(String(stub.throw)); }
      if (stub.malformed) { return null; }
      if (stub.hold && envelope.method !== 'execute') { await wait(stub.hold); }
      if (envelope.method === 'hello') {
        return respond(envelope, true, {
          documentId: documentId,
          url: g.__stubLie ? 'https://evil.example/' : g.location.href,
          origin: g.__stubLie ? 'https://evil.example' : g.location.origin,
          ready: ready,
          isTop: true,
          capabilities: { hostKind: 'in_page', protocol: PROTOCOL }
        });
      }
      if (envelope.method === 'observe') {
        return respond(envelope, true, { documentId: documentId, url: g.location.href, title: document.title, elements: document.querySelectorAll('*').length });
      }
      if (envelope.method === 'execute') { return execute(envelope); }
      if (envelope.method === 'cancel') { return cancel(envelope); }
      return respond(envelope, true, null);
    }
    var endpoint = { protocol: PROTOCOL, documentId: documentId, get ready() { return ready; }, invoke: invoke };
    Object.defineProperty(g, name, { value: Object.freeze(endpoint), writable: false, configurable: false, enumerable: false });
    return { installed: true, documentId: documentId, endpoint: endpoint, dispose: function () {} };
  }
  exports.installTaskBridge = installTaskBridge;
  Object.defineProperty(exports, '__esModule', { value: true });
}));`;

const BAD_UMD = String.raw`(function (global) { global.WebAutomata = {}; })(globalThis);`;

const pageHtml = (title, body) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;

const START_BODY = `<h1 id="h">Start page</h1>
<a id="go" href="/second?via=link">Go second</a>
<form id="f" method="POST" action="/post"><input name="q" value="hello"><button id="submit" type="submit">Send</button></form>
<button id="spa" onclick="history.pushState({}, '', '/spa'); document.title = 'SPA';">SPA</button>
<button id="slowgo" onclick="location.href = '/slow'">Slow</button>
<iframe id="frame" src="/frame"></iframe>`;

async function startPageServer() {
  const hits = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      const body = Buffer.concat(chunks).toString('utf8');
      hits.push({ method: req.method, path: url.pathname, query: url.search, body });
      const send = (text, headers = {}) => {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...headers });
        res.end(text);
      };
      if (url.pathname === '/second') {
        send(
          pageHtml(
            'Second',
            `<h1 id="h">Second</h1><p id="info">via=${url.searchParams.get('via')}</p>`
          )
        );
      } else if (url.pathname === '/post') {
        const q = new URLSearchParams(body).get('q');
        send(
          pageHtml('Posted', `<h1 id="h">Posted</h1><p id="info">method=${req.method} q=${q}</p>`)
        );
      } else if (url.pathname === '/slow') {
        setTimeout(() => send(pageHtml('Slow', '<h1 id="h">Slow</h1>')), 1200);
      } else if (url.pathname === '/frame') {
        send(pageHtml('Frame', '<p id="inner">inside frame</p>'));
      } else if (url.pathname === '/cookie') {
        const value = url.searchParams.get('v');
        send(
          pageHtml(
            'Cookie',
            `<p>cookie ${value}</p><script>localStorage.setItem('scn', '${value}')</script>`
          ),
          { 'set-cookie': `scn=${value}; Path=/` }
        );
      } else if (url.pathname === '/diag') {
        send(pageHtml('Diag', '<script>console.log("diag-line")</script>'));
      } else if (url.pathname === '/noisy') {
        send(
          pageHtml(
            'Noisy',
            `<script>
              console.log('long ' + 'x'.repeat(2000));
              for (let i = 0; i < 300; i += 1) { console.log('noise ' + i); }
              for (let i = 0; i < 260; i += 1) {
                setTimeout(() => { throw new Error('err ' + i + ' ' + 'y'.repeat(900)); }, 0);
              }
              setTimeout(() => { globalThis.__noiseDone = true; }, 50);
            </script>`
          )
        );
      } else if (url.pathname === '/slowload') {
        send(pageHtml('Slow load', '<h1 id="h">Slow load</h1><script src="/slow.js"></script>'));
      } else if (url.pathname === '/slow.js') {
        setTimeout(() => {
          res.writeHead(200, { 'content-type': 'text/javascript' });
          res.end('globalThis.__slowScript = true;');
        }, 900);
      } else {
        send(pageHtml('Start', START_BODY));
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    hits,
    port,
    origin: `http://127.0.0.1:${port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

let envelopeCounter = 0;
const envelope = (method, payload = {}, extra = {}) => ({
  protocol: 'kriya.task.v1',
  callId: `req_${(envelopeCounter += 1).toString(16).padStart(12, '0')}`,
  method,
  payload,
  ...extra,
});
const callOf = (timeoutMs = 5000, signal) => ({
  timeoutMs,
  ...(signal === undefined ? {} : { signal }),
});
const documentIdOf = page => page.evaluate(() => globalThis.__kriyaTaskBridge.documentId);
const executionsOf = page => page.evaluate(() => globalThis.__stubExecutions);
const redactHostSecret = text => text.split(HOST_SECRET).join(REDACTED);

async function consoleCalls(fn) {
  const names = ['log', 'info', 'warn', 'error', 'debug'];
  const originals = Object.fromEntries(names.map(name => [name, console[name]]));
  const writers = ['stdout', 'stderr'];
  const originalWrites = Object.fromEntries(writers.map(name => [name, process[name].write]));
  let count = 0;
  for (const name of names) {
    console[name] = () => {
      count += 1;
    };
  }
  for (const name of writers) {
    process[name].write = (...args) => {
      count += 1;
      const done = args.find(arg => typeof arg === 'function');
      done?.();
      return true;
    };
  }
  try {
    await fn();
  } finally {
    for (const name of names) {
      console[name] = originals[name];
    }
    for (const name of writers) {
      process[name].write = originalWrites[name];
    }
  }
  return count;
}

const fakePage = (overrides = {}) => ({
  isClosed: () => false,
  url: () => 'http://127.0.0.1:9/',
  evaluate: () => Promise.reject(new Error('unset')),
  waitForFunction: () => Promise.reject(new Error('unset')),
  ...overrides,
});

// ---------------------------------------------------------------------------------------------
// section 1: jev.mjs against the local stand-in
// ---------------------------------------------------------------------------------------------

async function runJevChecks() {
  section('jev.mjs');
  const jev = await startJevServer();
  const memory = () => [];

  const burst = async (http, count, tagPrefix = 'b') => {
    const results = await Promise.all(
      Array.from({ length: count }, (_, index) =>
        http(jev.url, initFor(bodyFor(`${tagPrefix}${index}`)))
      )
    );
    return results;
  };

  await check('jev: process gate defaults to 3 and is one object per process', async () => {
    const gate = getProcessGate();
    eq(DEFAULT_JEV_CONCURRENCY, 3, 'default constant');
    eq(gate.maxInFlight, 3, 'process gate limit');
    ok(getProcessGate() === gate, 'same object on second call');
    ok(
      globalThis[Symbol.for('kriya.e2e.jev.process-gate')] === gate,
      'shared through the symbol key'
    );
  });

  await check('jev: createJevGate rejects a non-positive or non-integer limit', async () => {
    for (const bad of [0, -1, 1.5, '3', Number.NaN]) {
      let threw = false;
      try {
        createJevGate({ maxInFlight: bad });
      } catch (error) {
        threw = error instanceof TypeError;
      }
      ok(threw, `limit ${String(bad)} must throw TypeError`);
    }
  });

  await check(
    'jev: createRecordingHttp rejects an invalid gate and an invalid recorder',
    async () => {
      for (const options of [{ gate: 'x' }, { gate: {} }, { recorder: 5 }]) {
        let threw = false;
        try {
          createRecordingHttp(options);
        } catch (error) {
          threw = error instanceof TypeError;
        }
        ok(threw, `options ${show(options)} must throw TypeError`);
      }
    }
  );

  const gate3 = createJevGate({ maxInFlight: 3 });
  await check('jev: ten concurrent calls never exceed 3 in flight (server side)', async () => {
    jev.reset();
    jev.state.handler = ({ index }) => ({ ...defaultPlan({ index }), delayMs: 150 });
    const http = createRecordingHttp({ gate: gate3, recorder: memory() });
    const results = await burst(http, 10);
    eq(results.length, 10, 'responses');
    ok(
      results.every(result => result.status === 200 && result.ok === true),
      'all 200'
    );
    ok(jev.state.peak <= 3, `server saw ${jev.state.peak} in flight`);
    eq(jev.state.hits.length, 10, 'server hits');
  });

  await check(
    'jev: the limit is reached, not only respected (server and gate peak are 3)',
    async () => {
      eq(jev.state.peak, 3, 'server peak');
      eq(gate3.peak, 3, 'gate peak');
      eq(gate3.inFlight, 0, 'gate in flight after run');
      eq(gate3.queued, 0, 'gate queue after run');
      eq(gate3.started, 10, 'gate started');
    }
  );

  await check('jev: limit 1 serializes calls and keeps first-in first-out order', async () => {
    jev.reset();
    jev.state.handler = ({ index }) => ({ ...defaultPlan({ index }), delayMs: 25 });
    const http = createRecordingHttp({
      gate: createJevGate({ maxInFlight: 1 }),
      recorder: memory(),
    });
    await burst(http, 5, 'fifo');
    eq(jev.state.peak, 1, 'server peak');
    eq(
      jev.state.hits.map(hit => JSON.parse(hit.bodyText).state.page.url.split('/').pop()),
      ['fifo0', 'fifo1', 'fifo2', 'fifo3', 'fifo4'],
      'arrival order'
    );
  });

  await check('jev: two recording http instances share one gate', async () => {
    jev.reset();
    jev.state.handler = ({ index }) => ({ ...defaultPlan({ index }), delayMs: 60 });
    const shared = createJevGate({ maxInFlight: 2 });
    const first = createRecordingHttp({ gate: shared, recorder: memory() });
    const second = createRecordingHttp({ gate: shared, recorder: memory() });
    await Promise.all([burst(first, 4, 's1-'), burst(second, 4, 's2-')]);
    eq(jev.state.hits.length, 8, 'server hits');
    eq(jev.state.peak, 2, 'server peak across both instances');
    eq(shared.peak, 2, 'gate peak');
  });

  await check('jev: without a gate option the process gate (limit 3) is used', async () => {
    jev.reset();
    jev.state.handler = ({ index }) => ({ ...defaultPlan({ index }), delayMs: 60 });
    const processGate = getProcessGate();
    const before = processGate.started;
    const http = createRecordingHttp({ recorder: memory() });
    await burst(http, 8, 'pg');
    eq(jev.state.peak, 3, 'server peak');
    eq(processGate.started - before, 8, 'process gate admitted every call');
  });

  await check('jev: a numeric gate option sets the process-wide limit', async () => {
    jev.reset();
    jev.state.handler = ({ index }) => ({ ...defaultPlan({ index }), delayMs: 60 });
    try {
      const http = createRecordingHttp({ gate: 2, recorder: memory() });
      eq(getProcessGate().maxInFlight, 2, 'limit applied to the process gate');
      await burst(http, 6, 'n2');
      eq(jev.state.peak, 2, 'server peak');
    } finally {
      getProcessGate(DEFAULT_JEV_CONCURRENCY);
    }
    eq(getProcessGate().maxInFlight, 3, 'limit restored');
  });

  await check('jev: raising the limit admits queued work immediately', async () => {
    const gate = createJevGate({ maxInFlight: 1 });
    const tasks = [manualTask(), manualTask(), manualTask()];
    const runs = tasks.map(task => gate.run(task.run));
    await sleep(10);
    eq([gate.inFlight, gate.queued], [1, 2], 'one running, two waiting');
    gate.setMaxInFlight(3);
    await sleep(10);
    eq([gate.inFlight, gate.queued], [3, 0], 'all admitted after raising the limit');
    tasks.forEach(task => task.finish('done'));
    await Promise.all(runs);
    eq(gate.inFlight, 0, 'released');
  });

  await check('jev: a task that throws still releases its slot', async () => {
    const gate = createJevGate({ maxInFlight: 1 });
    await rejects(
      gate.run(() => Promise.reject(Object.assign(new Error('x'), { name: 'Boom' }))),
      'Boom',
      'task'
    );
    await gate.run(() => 'next');
    eq([gate.inFlight, gate.queued], [0, 0], 'gate idle');
  });

  await check('jev: abort while queued rejects without a request and leaks no slot', async () => {
    jev.reset();
    jev.state.handler = ({ index }) => ({ ...defaultPlan({ index }), delayMs: 300 });
    const gate = createJevGate({ maxInFlight: 1 });
    const recordedQueue = memory();
    const http = createRecordingHttp({ gate, recorder: recordedQueue });
    const holder = http(jev.url, initFor(bodyFor('holder')));
    await sleep(40);
    const controller = new AbortController();
    const queued = http(jev.url, initFor(bodyFor('queued'), { signal: controller.signal }));
    await sleep(20);
    eq(gate.queued, 1, 'second call is waiting');
    controller.abort();
    const error = await rejects(queued, 'AbortError', 'queued call');
    ok(error.cause === undefined, 'no cause attached');
    await holder;
    eq(jev.state.hits.length, 1, 'only the holder reached the server');
    jev.state.handler = undefined;
    const third = await http(jev.url, initFor(bodyFor('after')));
    eq(third.status, 200, 'later call works');
    eq([gate.inFlight, gate.queued], [0, 0], 'gate idle');
    eq(gate.started, 2, 'the aborted waiter never took a slot (only holder and later call ran)');
    eq(
      recordedQueue.map(entry => entry.request.state.page.url.split('/').pop()),
      ['holder', 'after'],
      'the aborted request was never dispatched, so it left no entry'
    );
  });

  await check(
    'jev: abort in flight rejects AbortError with a fixed message and frees the slot',
    async () => {
      jev.reset();
      jev.state.handler = ({ index }) => ({ ...defaultPlan({ index }), delayMs: 600 });
      const gate = createJevGate({ maxInFlight: 1 });
      const recorded = memory();
      const http = createRecordingHttp({ gate, recorder: recorded });
      const controller = new AbortController();
      const started = performance.now();
      const pending = http(jev.url, initFor(bodyFor('inflight'), { signal: controller.signal }));
      await sleep(80);
      controller.abort();
      const error = await rejects(pending, 'AbortError', 'in-flight call');
      ok(performance.now() - started < 450, 'rejected promptly, not after the server delay');
      eq(error.message, 'Jev request aborted', 'fixed message');
      ok(error.cause === undefined, 'no cause attached');
      ok(
        !error.message.includes(jev.url) && !error.message.includes(FAKE_KEY),
        'message carries no url or key'
      );
      eq(recorded.length, 1, 'the dispatched attempt is recorded');
      eq([recorded[0].error, recorded[0].status], ['aborted', null], 'recorded as aborted');
      ok(
        recorded[0].latency >= 60 && recorded[0].latency < 450,
        `aborted attempt latency (${recorded[0].latency})`
      );
      eq(gate.inFlight, 0, 'slot freed');
    }
  );

  await check('jev: an already aborted signal sends nothing', async () => {
    jev.reset();
    const controller = new AbortController();
    controller.abort();
    const recorded = memory();
    const http = createRecordingHttp({
      gate: createJevGate({ maxInFlight: 2 }),
      recorder: recorded,
    });
    await rejects(
      http(jev.url, initFor(bodyFor('pre'), { signal: controller.signal })),
      'AbortError',
      'call'
    );
    eq(jev.state.hits.length, 0, 'server hits');
    eq(recorded.length, 0, 'nothing recorded for a request that was never sent');
  });

  await check('jev: the per-attempt timeout rejects TimeoutError and is recorded', async () => {
    jev.reset();
    jev.state.handler = ({ index }) => ({ ...defaultPlan({ index }), delayMs: 700 });
    const recorded = memory();
    const http = createRecordingHttp({
      gate: createJevGate({ maxInFlight: 2 }),
      recorder: recorded,
    });
    const error = await rejects(
      http(jev.url, initFor(bodyFor('slow'), { timeoutMs: 120 })),
      'TimeoutError',
      'call'
    );
    eq(error.message, 'Jev request timed out', 'fixed message');
    eq([recorded[0].error, recorded[0].status], ['timeout', null], 'recorded as timeout');
    ok(
      recorded[0].latency >= 100 && recorded[0].latency < 600,
      `timed-out attempt latency (${recorded[0].latency})`
    );
  });

  await check(
    'jev: the default send path sends Authorization from credential() once per attempt',
    async () => {
      jev.reset();
      const credential = countingCredential();
      const http = createRecordingHttp({
        gate: createJevGate({ maxInFlight: 2 }),
        recorder: memory(),
      });
      for (let i = 0; i < 3; i += 1) {
        await http(jev.url, initFor(bodyFor(`auth${i}`), { credential: credential.read }));
      }
      eq(credential.calls, 3, 'credential calls');
      ok(
        jev.state.hits.every(hit => hit.headers.authorization === `Bearer ${FAKE_KEY}`),
        'server received the bearer key'
      );
    }
  );

  await check('jev: the recording layer never calls credential() (injected send)', async () => {
    jev.reset();
    const credential = countingCredential();
    const sends = [];
    const send = async ({ url, init }) => {
      sends.push({ url, hasCredential: typeof init.credential === 'function' });
      return new Response(JSON.stringify({ model: 'jev-1.13.0' }), {
        status: 200,
        headers: { 'x-typesafe-request-id': 'rq_inj' },
      });
    };
    const recorded = memory();
    const http = createRecordingHttp({
      gate: createJevGate({ maxInFlight: 1 }),
      recorder: recorded,
      send,
    });
    const response = await http(jev.url, initFor(bodyFor('inj'), { credential: credential.read }));
    eq(credential.calls, 0, 'credential calls by the recording layer');
    eq(sends.length, 1, 'injected send used');
    eq(response.header('x-typesafe-request-id'), 'rq_inj', 'request id passed through');
    eq(jev.state.hits.length, 0, 'the default fetch path was not used');
    eq(recorded[0].requestId, 'rq_inj', 'request id recorded');
  });

  await check(
    'jev: an adapter-supplied Authorization header is replaced and never recorded',
    async () => {
      jev.reset();
      const recorded = memory();
      const http = createRecordingHttp({
        gate: createJevGate({ maxInFlight: 2 }),
        recorder: recorded,
        redactValues: [FAKE_KEY],
      });
      await http(
        jev.url,
        initFor(bodyFor('hdr'), {
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer wrong-adapter-value',
            'X-Api-Key': FAKE_KEY,
            'x-trace': 'abc',
          },
        })
      );
      const hit = jev.state.hits[0];
      eq(
        hit.headers.authorization,
        `Bearer ${FAKE_KEY}`,
        'only the credential-based Authorization is sent'
      );
      const headers = recorded[0].requestHeaders;
      eq(headers.Authorization, REDACTED, 'Authorization recorded as redacted');
      eq(headers['X-Api-Key'], REDACTED, 'api key header recorded as redacted');
      eq(headers['x-trace'], 'abc', 'harmless header kept');
      ok(!JSON.stringify(recorded).includes(FAKE_KEY), 'key absent from the recorded entry');
      ok(!JSON.stringify(recorded).includes('wrong-adapter-value'), 'adapter value absent');
    }
  );

  await check(
    'jev: an entry has request, response, model, requestId, latency, status and attempt',
    async () => {
      jev.reset();
      jev.state.handler = ({ index }) => ({ ...defaultPlan({ index }), delayMs: 150 });
      const recorded = memory();
      const http = createRecordingHttp({
        gate: createJevGate({ maxInFlight: 2 }),
        recorder: recorded,
      });
      await http(jev.url, initFor(bodyFor('shape')));
      const [entry] = recorded;
      for (const field of [
        'request',
        'response',
        'model',
        'requestId',
        'latency',
        'status',
        'attempt',
      ]) {
        ok(field in entry, `field ${field} present`);
      }
      ok(/^jev-/.test(entry.model), 'model is the resolved jev id');
      eq(entry.requestId, 'rq_0', 'x-typesafe-request-id');
      eq([entry.status, entry.attempt], [200, 1], 'status and attempt');
      ok(
        Number.isFinite(entry.latency) && entry.latency >= 120 && entry.latency < 3000,
        `latency in ms covers the 150 ms server delay (${entry.latency})`
      );
      eq(entry.request.model, 'jev-latest', 'request is the parsed body');
      eq(entry.response.model, 'jev-1.13.0', 'response is the parsed body');
      ok(typeof entry.at === 'string' && !Number.isNaN(Date.parse(entry.at)), 'timestamp');
    }
  );

  await check('jev: the recorded request is plain JSON without credential or signal', async () => {
    jev.reset();
    const recorded = memory();
    const http = createRecordingHttp({
      gate: createJevGate({ maxInFlight: 2 }),
      recorder: recorded,
    });
    await http(jev.url, initFor(bodyFor('plain'), { signal: new AbortController().signal }));
    const text = JSON.stringify(recorded[0]);
    ok(!text.includes('credential') && !text.includes('signal'), 'no credential or signal field');
    eq(JSON.parse(text), recorded[0], 'entry survives a JSON round trip');
  });

  await check('jev: header() is case-insensitive and null when absent', async () => {
    jev.reset();
    const http = createRecordingHttp({
      gate: createJevGate({ maxInFlight: 2 }),
      recorder: memory(),
    });
    const response = await http(jev.url, initFor(bodyFor('hdrs')));
    eq(response.header('X-TypeSafe-Request-Id'), 'rq_0', 'upper case lookup');
    eq(response.header('x-typesafe-request-id'), 'rq_0', 'lower case lookup');
    eq(response.header('x-absent'), null, 'absent header');
    eq((await response.json()).model, 'jev-1.13.0', 'json()');
    eq((await response.json()).model, 'jev-1.13.0', 'json() twice');
  });

  await check(
    'jev: a 429 is returned, not retried here, and the adapter retry is attempt 2',
    async () => {
      jev.reset();
      jev.state.handler = ({ index }) =>
        index === 0
          ? {
              status: 429,
              headers: { 'retry-after': '0', 'x-typesafe-request-id': 'rq_429' },
              json: { error: 'slow down' },
            }
          : defaultPlan({ index });
      const recorded = memory();
      const http = createRecordingHttp({
        gate: createJevGate({ maxInFlight: 2 }),
        recorder: recorded,
      });
      const body = bodyFor('retry429');
      const first = await http(jev.url, initFor(body));
      eq([first.ok, first.status], [false, 429], 'the 429 is handed back');
      eq(jev.state.hits.length, 1, 'no retry inside the module');
      const second = await http(jev.url, initFor(body));
      eq(second.status, 200, 'adapter retry succeeds');
      const third = await http(jev.url, initFor(body));
      eq(third.status, 200, 'a later identical request');
      eq(
        recorded.map(entry => entry.attempt),
        [1, 2, 1],
        'attempt numbering'
      );
      eq(recorded[0].retryAfter, '0', 'retry-after recorded');
      eq(recorded[0].requestId, 'rq_429', 'request id of the failed attempt');
    }
  );

  await check('jev: a 503 is returned without a module retry', async () => {
    jev.reset();
    jev.state.handler = ({ index }) => ({ status: 503, json: { error: 'down', index } });
    const recorded = memory();
    const http = createRecordingHttp({
      gate: createJevGate({ maxInFlight: 2 }),
      recorder: recorded,
    });
    const response = await http(jev.url, initFor(bodyFor('r503')));
    eq([response.ok, response.status], [false, 503], 'the 503 is handed back');
    eq(jev.state.hits.length, 1, 'exactly one request');
    eq(recorded[0].model, null, 'no model in an error body');
  });

  await check(
    'jev: a non-JSON body rejects json() with a fixed message and records response null',
    async () => {
      jev.reset();
      jev.state.handler = () => ({ status: 200, text: `<html>upstream echoed ${FAKE_KEY}</html>` });
      const recorded = memory();
      const http = createRecordingHttp({
        gate: createJevGate({ maxInFlight: 2 }),
        recorder: recorded,
      });
      const response = await http(jev.url, initFor(bodyFor('text')));
      const error = await rejects(response.json(), 'InvalidResponse', 'json()');
      ok(
        !error.message.includes(FAKE_KEY) && !error.message.includes('upstream'),
        'no body text in the error'
      );
      eq(recorded[0].response, null, 'response recorded as null');
      ok(!JSON.stringify(recorded).includes(FAKE_KEY), 'key absent from the entry');
    }
  );

  await check(
    'jev: a network failure rejects NetworkError with a fixed message and is recorded',
    async () => {
      jev.reset();
      jev.state.handler = () => ({ destroy: true });
      const recorded = memory();
      const http = createRecordingHttp({
        gate: createJevGate({ maxInFlight: 2 }),
        recorder: recorded,
      });
      const body = bodyFor('net');
      const error = await rejects(http(jev.url, initFor(body)), 'NetworkError', 'call');
      eq(error.message, 'Jev request failed', 'fixed message');
      ok(error.cause === undefined, 'no cause attached');
      eq([recorded[0].error, recorded[0].status], ['network', null], 'recorded as network');
      jev.state.handler = undefined;
      await http(jev.url, initFor(body));
      eq(recorded[1].attempt, 2, 'a retry after a network failure is attempt 2');
    }
  );

  await check('jev: redirects are refused and the key never reaches the target', async () => {
    const target = await startJevServer();
    try {
      jev.reset();
      jev.state.handler = () => ({ status: 302, headers: { location: target.url }, text: '' });
      const http = createRecordingHttp({
        gate: createJevGate({ maxInFlight: 2 }),
        recorder: memory(),
      });
      await rejects(http(jev.url, initFor(bodyFor('redir'))), 'NetworkError', 'call');
      eq(target.state.hits.length, 0, 'redirect target was never contacted');
    } finally {
      await target.close();
    }
  });

  await check(
    'jev: the recorded file holds no key and no sensitive value in any variant',
    async () => {
      jev.reset();
      jev.state.handler = ({ bodyText, index }) => ({
        ...defaultPlan({ index }),
        json: {
          model: 'jev-1.13.0',
          echo: JSON.parse(bodyText).state.note,
          echoCard: JSON.parse(bodyText).state.card,
        },
      });
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kriya-io-'));
      const file = path.join(dir, 'jev-calls.json');
      const recorder = {
        write: (_name, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2)),
      };
      const http = createRecordingHttp({
        gate: createJevGate({ maxInFlight: 2 }),
        recorder,
        redactValues: [FAKE_KEY, FAKE_PASSWORD, FAKE_CARD_SPACED],
      });
      try {
        await http(
          jev.url,
          initFor(
            bodyFor('secrets', {
              note: JSON.stringify({ typed: FAKE_PASSWORD }),
              link: `http://127.0.0.1/?p=${encodeURIComponent(FAKE_PASSWORD)}&f=${encodeURIComponent(FAKE_PASSWORD).replace(/%20/g, '+')}`,
              card: FAKE_CARD_SPACED,
              cardDashed: FAKE_CARD_DASHED,
              cardDigits: FAKE_DIGITS,
              plain: FAKE_PASSWORD,
              inline: `prefix ${FAKE_CARD_SPACED} suffix`,
            })
          )
        );
        const text = fs.readFileSync(file, 'utf8');
        const variants = [
          FAKE_KEY,
          FAKE_PASSWORD,
          JSON.stringify(FAKE_PASSWORD).slice(1, -1),
          encodeURIComponent(FAKE_PASSWORD),
          encodeURIComponent(FAKE_PASSWORD).replace(/%20/g, '+'),
          FAKE_CARD_SPACED,
          FAKE_CARD_DASHED,
          FAKE_DIGITS,
        ];
        for (const [index, variant] of variants.entries()) {
          ok(!text.includes(variant), `variant ${index} absent from the file`);
        }
        ok(text.includes(REDACTED), 'redaction marker present');
        const parsed = JSON.parse(text);
        const stored = leavesOf(parsed);
        for (const [index, variant] of variants.entries()) {
          ok(
            !stored.some(leaf => leaf.includes(variant)),
            `variant ${index} absent from every stored string and key (a JSON-in-JSON string is not visible in the serialized text)`
          );
        }
        eq(parsed.length, 1, 'one entry in the file');
        eq(parsed[0].request.state.page.url, 'http://127.0.0.1/secrets', 'non-sensitive data kept');
        eq(
          parsed[0].request.state.inline,
          `prefix ${REDACTED} suffix`,
          'inline occurrence replaced in place'
        );
        eq(parsed[0].status, 200, 'metadata kept');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  );

  await check(
    'jev: a key echoed by the server is redacted even when redactValues omits it',
    async () => {
      jev.reset();
      jev.state.handler = ({ req, index }) => ({
        ...defaultPlan({ index }),
        json: { model: 'jev-1.13.0', seen: req.headers.authorization },
      });
      const recorded = memory();
      const http = createRecordingHttp({
        gate: createJevGate({ maxInFlight: 2 }),
        recorder: recorded,
        redactValues: [],
      });
      const response = await http(jev.url, initFor(bodyFor('echo')));
      ok(
        (await response.json()).seen.includes(FAKE_KEY),
        'control: the caller still sees the real response'
      );
      ok(!JSON.stringify(recorded).includes(FAKE_KEY), 'key absent from the entry');
      ok(JSON.stringify(recorded).includes(REDACTED), 'replaced by the marker');
    }
  );

  await check(
    'jev: redactValues accepts an object, a Set and a function evaluated late',
    async () => {
      const lateValue = `late_${hex(8)}`;
      const objectValue = `obj_${hex(8)}`;
      const setValue = `set_${hex(8)}`;
      const pool = [];
      const recorded = memory();
      jev.reset();
      const http = createRecordingHttp({
        gate: createJevGate({ maxInFlight: 2 }),
        recorder: recorded,
        redactValues: () => [{ nested: { value: objectValue } }, new Set([setValue]), pool],
      });
      pool.push(lateValue);
      await http(
        jev.url,
        initFor(
          bodyFor('values', { a: objectValue, b: setValue, c: lateValue, d: 'keep-me-visible' })
        )
      );
      const text = JSON.stringify(recorded);
      ok(
        !text.includes(objectValue) && !text.includes(setValue) && !text.includes(lateValue),
        'every source form redacted'
      );
      ok(text.includes('keep-me-visible'), 'unrelated text kept');
    }
  );

  await check(
    'jev: values shorter than 4 characters are redacted only by exact equality',
    async () => {
      jev.reset();
      const recorded = memory();
      const http = createRecordingHttp({
        gate: createJevGate({ maxInFlight: 2 }),
        recorder: recorded,
        redactValues: ['ab'],
      });
      await http(
        jev.url,
        initFor(bodyFor('short', { exact: 'ab', word: 'about', padded: ' ab ' }))
      );
      eq(recorded[0].request.state.exact, REDACTED, 'exact leaf redacted');
      eq(recorded[0].request.state.padded, REDACTED, 'trimmed-equal leaf redacted');
      eq(recorded[0].request.state.word, 'about', 'substring left alone');
    }
  );

  await check('jev: object keys are redacted too', async () => {
    jev.reset();
    const keyed = `key_${hex(8)}`;
    const recorded = memory();
    const http = createRecordingHttp({
      gate: createJevGate({ maxInFlight: 2 }),
      recorder: recorded,
      redactValues: [keyed],
    });
    await http(jev.url, initFor(bodyFor('keys', { [keyed]: 'value' })));
    ok(!JSON.stringify(recorded).includes(keyed), 'secret absent as a key');
    eq(recorded[0].request.state[REDACTED], 'value', 'value kept under the marker key');
  });

  await check('jev: __proto__ in a body is recorded as data, not as a prototype', async () => {
    jev.reset();
    const recorded = memory();
    const http = createRecordingHttp({
      gate: createJevGate({ maxInFlight: 2 }),
      recorder: recorded,
    });
    const init = initFor({});
    init.body = '{"__proto__":{"polluted":"yes"},"plain":1}';
    await http(jev.url, init);
    const request = recorded[0].request;
    ok(Object.prototype.hasOwnProperty.call(request, '__proto__'), 'own data property');
    eq(Object.getPrototypeOf(request) === Object.prototype, true, 'prototype untouched');
    eq({}.polluted, undefined, 'Object.prototype not polluted');
  });

  await check(
    'jev: recorder forms (function, record, push, write) all receive entries',
    async () => {
      jev.reset();
      const viaFunction = [];
      const viaRecord = [];
      const viaPush = [];
      const writes = [];
      const forms = [
        entry => viaFunction.push(entry),
        { record: entry => viaRecord.push(entry) },
        viaPush,
        { write: (name, data) => writes.push({ name, size: data.length }) },
      ];
      for (const recorder of forms) {
        const http = createRecordingHttp({ gate: createJevGate({ maxInFlight: 2 }), recorder });
        await http(jev.url, initFor(bodyFor('forms')));
        await http(jev.url, initFor(bodyFor('forms2')));
      }
      eq(
        [viaFunction.length, viaRecord.length, viaPush.length],
        [2, 2, 2],
        'function, record, push'
      );
      eq(
        writes,
        [
          { name: 'jev-calls.json', size: 1 },
          { name: 'jev-calls.json', size: 2 },
        ],
        'write form rewrites the whole list'
      );
    }
  );

  await check('jev: a failing recorder does not break the call and is counted', async () => {
    jev.reset();
    const http = createRecordingHttp({
      gate: createJevGate({ maxInFlight: 2 }),
      recorder: () => {
        throw new Error('disk full');
      },
    });
    const response = await http(jev.url, initFor(bodyFor('badrec')));
    eq(response.status, 200, 'call still succeeds');
    const asyncFailing = createRecordingHttp({
      gate: createJevGate({ maxInFlight: 2 }),
      recorder: () => Promise.reject(new Error('async disk full')),
    });
    await asyncFailing(jev.url, initFor(bodyFor('badrec2')));
    await sleep(20);
    eq(http.stats().recordErrors, 1, 'sync failure counted');
    eq(asyncFailing.stats().recordErrors, 1, 'async failure counted');
  });

  await check('jev: stats and recorded() reflect sent and failed attempts', async () => {
    jev.reset();
    const http = createRecordingHttp({
      gate: createJevGate({ maxInFlight: 2 }),
      recorder: memory(),
    });
    await http(jev.url, initFor(bodyFor('st1')));
    jev.state.handler = () => ({ destroy: true });
    await rejects(http(jev.url, initFor(bodyFor('st2'))), 'NetworkError', 'failing call');
    eq(http.stats(), { sent: 1, failed: 1, recordErrors: 0 }, 'stats');
    eq(http.recorded().length, 2, 'recorded entries');
    http.recorded().pop();
    eq(http.recorded().length, 2, 'recorded() returns a copy');
  });

  await check(
    'jev: an adapter Authorization header in any letter case is dropped, never sent beside the key',
    async () => {
      jev.reset();
      const http = createRecordingHttp({
        gate: createJevGate({ maxInFlight: 2 }),
        recorder: memory(),
      });
      await http(
        jev.url,
        initFor(bodyFor('authcase'), {
          headers: {
            'Content-Type': 'application/json',
            authorization: 'Bearer wrong-lower',
            AUTHORIZATION: 'Bearer wrong-upper',
          },
        })
      );
      eq(
        jev.state.hits[0].headers.authorization,
        `Bearer ${FAKE_KEY}`,
        'exactly one credential-based header on the wire'
      );
    }
  );

  await check(
    'jev: an empty or non-string credential sends no Authorization header; a throwing one cannot leak',
    async () => {
      jev.reset();
      const recorded = memory();
      const http = createRecordingHttp({
        gate: createJevGate({ maxInFlight: 2 }),
        recorder: recorded,
        redactValues: [FAKE_KEY],
      });
      const credentials = [() => '', () => undefined, () => 42];
      for (const [index, credential] of credentials.entries()) {
        await http(jev.url, initFor(bodyFor(`cred${index}`), { credential }));
      }
      eq(jev.state.hits.length, 3, 'three requests sent');
      ok(
        jev.state.hits.every(hit => hit.headers.authorization === undefined),
        'none carried an Authorization header'
      );
      const error = await rejects(
        http(
          jev.url,
          initFor(bodyFor('credthrow'), {
            credential: () => {
              throw new Error(`credential lookup failed for ${FAKE_KEY}`);
            },
          })
        ),
        'NetworkError',
        'throwing credential'
      );
      eq(error.message, 'Jev request failed', 'fixed message');
      ok(error.cause === undefined, 'no cause attached');
      eq(jev.state.hits.length, 3, 'nothing was sent for the failing credential');
      ok(!JSON.stringify(recorded).includes(FAKE_KEY), 'key absent from the entries');
    }
  );

  await check(
    'jev: latency measures the exchange, not the time spent waiting in the gate',
    async () => {
      jev.reset();
      jev.state.handler = ({ bodyText }) => ({
        ...defaultPlan({ index: 0 }),
        delayMs: bodyText.includes('holdlat') ? 400 : 100,
      });
      const recorded = memory();
      const http = createRecordingHttp({
        gate: createJevGate({ maxInFlight: 1 }),
        recorder: recorded,
      });
      await Promise.all([
        http(jev.url, initFor(bodyFor('holdlat'))),
        http(jev.url, initFor(bodyFor('quicklat'))),
      ]);
      const byTag = Object.fromEntries(
        recorded.map(entry => [entry.request.state.page.url.split('/').pop(), entry.latency])
      );
      ok(byTag.holdlat >= 350 && byTag.holdlat < 3000, `first call latency (${byTag.holdlat})`);
      ok(
        byTag.quicklat >= 80 && byTag.quicklat < 380,
        `queued call latency excludes the 400 ms wait (${byTag.quicklat})`
      );
    }
  );

  await check(
    'jev: attempt numbering follows the retryable statuses (408, 429, 5xx) and nothing else',
    async () => {
      const table = [
        [408, true],
        [429, true],
        [500, true],
        [502, true],
        [503, true],
        [504, true],
        [529, true],
        [200, false],
        [400, false],
        [401, false],
        [403, false],
        [404, false],
        [422, false],
      ];
      for (const [status, retryable] of table) {
        const recorded = memory();
        const http = createRecordingHttp({
          gate: createJevGate({ maxInFlight: 1 }),
          recorder: recorded,
          send: async () => new Response(JSON.stringify({ model: 'jev-1.13.0' }), { status }),
        });
        const init = initFor(bodyFor(`table${status}`));
        await http(jev.url, init);
        await http(jev.url, init);
        eq(
          recorded.map(entry => entry.attempt),
          retryable ? [1, 2] : [1, 1],
          `status ${status}`
        );
      }
    }
  );

  await check(
    'jev: an aborted attempt restarts numbering, a timed-out attempt continues it',
    async () => {
      jev.reset();
      jev.state.handler = ({ index }) => ({ ...defaultPlan({ index }), delayMs: 400 });
      const recorded = memory();
      const http = createRecordingHttp({
        gate: createJevGate({ maxInFlight: 2 }),
        recorder: recorded,
      });
      const aborted = bodyFor('abortretry');
      const controller = new AbortController();
      const first = http(jev.url, initFor(aborted, { signal: controller.signal }));
      await sleep(60);
      controller.abort();
      await rejects(first, 'AbortError', 'aborted call');
      jev.state.handler = undefined;
      await http(jev.url, initFor(aborted));
      const slow = bodyFor('timeoutretry');
      jev.state.handler = ({ index }) => ({ ...defaultPlan({ index }), delayMs: 500 });
      await rejects(
        http(jev.url, initFor(slow, { timeoutMs: 100 })),
        'TimeoutError',
        'timed out call'
      );
      jev.state.handler = undefined;
      await http(jev.url, initFor(slow));
      eq(
        recorded.map(entry => [entry.error ?? null, entry.attempt]),
        [
          ['aborted', 1],
          [null, 1],
          ['timeout', 1],
          [null, 2],
        ],
        'error kind and attempt per entry'
      );
    }
  );

  await check('jev: a task that throws synchronously still releases its slot', async () => {
    const gate = createJevGate({ maxInFlight: 1 });
    await rejects(
      gate.run(() => {
        throw Object.assign(new Error('x'), { name: 'SyncBoom' });
      }),
      'SyncBoom',
      'task'
    );
    eq([gate.inFlight, gate.queued], [0, 0], 'slot released at once');
    eq(await gate.run(() => 'next'), 'next', 'the next task runs');
  });

  await check(
    'jev: secrets inside arrays are redacted in the request and in the response',
    async () => {
      jev.reset();
      jev.state.handler = ({ bodyText, index }) => ({
        ...defaultPlan({ index }),
        json: { model: 'jev-1.13.0', echo: JSON.parse(bodyText).state.list },
      });
      const recorded = memory();
      const http = createRecordingHttp({
        gate: createJevGate({ maxInFlight: 2 }),
        recorder: recorded,
        redactValues: [FAKE_PASSWORD, FAKE_KEY],
      });
      await http(
        jev.url,
        initFor(
          bodyFor('arrays', {
            list: ['keep', FAKE_PASSWORD, { deep: [FAKE_PASSWORD, `x ${FAKE_KEY} y`] }],
          })
        )
      );
      const [entry] = recorded;
      eq(
        entry.request.state.list,
        ['keep', REDACTED, { deep: [REDACTED, `x ${REDACTED} y`] }],
        'request'
      );
      eq(
        entry.response.echo,
        ['keep', REDACTED, { deep: [REDACTED, `x ${REDACTED} y`] }],
        'response'
      );
      const stored = leavesOf(recorded);
      ok(
        !stored.some(leaf => leaf.includes(FAKE_PASSWORD) || leaf.includes(FAKE_KEY)),
        'no secret in any stored string'
      );
    }
  );

  await check(
    'jev: a secret that survives as a JSON number withholds request and response instead of leaking',
    async () => {
      jev.reset();
      const secret = `1${digits(9)}`;
      const recorded = memory();
      const http = createRecordingHttp({
        gate: createJevGate({ maxInFlight: 2 }),
        recorder: recorded,
        redactValues: [secret],
      });
      await http(jev.url, initFor(bodyFor('numbers', { pin: Number(secret), other: 7 })));
      jev.state.handler = ({ index }) => ({
        ...defaultPlan({ index }),
        json: { model: 'jev-1.13.0', echoed: Number(secret) },
      });
      await http(jev.url, initFor(bodyFor('numbers-response')));
      jev.state.handler = undefined;
      await http(jev.url, initFor(bodyFor('numbers-control', { pin: 1234567, other: 7 })));
      eq(
        recorded.slice(0, 2).map(entry => [entry.request, entry.response]),
        [
          [UNREDACTABLE, UNREDACTABLE],
          [UNREDACTABLE, UNREDACTABLE],
        ],
        'withheld in both directions'
      );
      eq(
        recorded.slice(0, 2).map(entry => [entry.status, entry.model, entry.url]),
        [
          [200, 'jev-1.13.0', jev.url],
          [200, 'jev-1.13.0', jev.url],
        ],
        'metadata kept'
      );
      eq(recorded[2].request.state.pin, 1234567, 'control: an unrelated number is recorded as is');
      ok(!JSON.stringify(recorded).includes(secret), 'secret absent from every entry');
    }
  );

  await check(
    'jev: very deep JSON is cut off at a fixed depth instead of overflowing or leaking',
    async () => {
      jev.reset();
      const secret = `deep_${hex(8)}`;
      let nested = secret;
      for (let level = 0; level < 200; level += 1) {
        nested = { n: nested };
      }
      const recorded = memory();
      const http = createRecordingHttp({
        gate: createJevGate({ maxInFlight: 2 }),
        recorder: recorded,
        redactValues: [secret],
      });
      const init = initFor({});
      init.body = JSON.stringify({
        model: 'jev-latest',
        state: { deep: nested, near: { a: { b: secret } } },
      });
      const response = await http(jev.url, init);
      eq(response.status, 200, 'call answered');
      const text = JSON.stringify(recorded);
      ok(!text.includes(secret), 'secret absent at both depths');
      ok(text.includes('[TRUNCATED]'), 'the deep branch was cut off');
      eq(recorded[0].request.state.near.a.b, REDACTED, 'shallow secret redacted in place');
    }
  );

  await check(
    'jev: a redactValues source that throws fails closed without leaking or rejecting',
    async () => {
      jev.reset();
      const recorded = memory();
      const http = createRecordingHttp({
        gate: createJevGate({ maxInFlight: 2 }),
        recorder: recorded,
        redactValues: () => {
          throw new Error(`redaction source broke on ${FAKE_KEY}`);
        },
      });
      const response = await http(
        jev.url,
        initFor(bodyFor('brokenredact', { note: FAKE_PASSWORD }), {
          headers: { 'Content-Type': 'application/json', 'x-trace': FAKE_PASSWORD },
        })
      );
      eq(response.status, 200, 'the caller still gets its response');
      const [entry] = recorded;
      eq([entry.request, entry.response], [UNREDACTABLE, UNREDACTABLE], 'bodies withheld');
      eq([entry.url, entry.requestHeaders], [UNREDACTABLE, {}], 'url and headers withheld');
      eq([entry.status, entry.attempt, entry.model], [200, 1, null], 'own metadata kept');
      const text = JSON.stringify(recorded);
      ok(!text.includes(FAKE_KEY) && !text.includes(FAKE_PASSWORD), 'no secret in the entry');
      eq(http.stats().recordErrors, 1, 'counted');
    }
  );

  await check(
    'jev: hostile timeout values never fire early, throw, or print a warning',
    async () => {
      jev.reset();
      const before = processWarnings.length;
      const http = createRecordingHttp({
        gate: createJevGate({ maxInFlight: 2 }),
        recorder: memory(),
      });
      const hostile = [3e9, 1e10, Number.MAX_SAFE_INTEGER, Infinity, Number.NaN, -5, 0, '100'];
      for (const timeoutMs of hostile) {
        jev.state.handler = ({ index }) => ({ ...defaultPlan({ index }), delayMs: 80 });
        const response = await http(
          jev.url,
          initFor(bodyFor(`hostile-${String(timeoutMs)}`), { timeoutMs })
        );
        eq(response.status, 200, `timeoutMs ${String(timeoutMs)}`);
      }
      const hugeDefault = createRecordingHttp({
        gate: createJevGate({ maxInFlight: 2 }),
        recorder: memory(),
        defaultTimeoutMs: 1e10,
      });
      const init = initFor(bodyFor('huge-default'));
      delete init.timeoutMs;
      eq((await hugeDefault(jev.url, init)).status, 200, 'oversized defaultTimeoutMs');
      const brokenDefault = createRecordingHttp({
        gate: createJevGate({ maxInFlight: 2 }),
        recorder: memory(),
        defaultTimeoutMs: Number.NaN,
      });
      const init2 = initFor(bodyFor('nan-default'));
      delete init2.timeoutMs;
      eq((await brokenDefault(jev.url, init2)).status, 200, 'NaN defaultTimeoutMs');
      await sleep(30);
      eq(processWarnings.slice(before), [], 'no process warning');
    }
  );

  await check(
    'jev: a secret echoed in the url, a response header and a request header is redacted',
    async () => {
      jev.reset();
      const secret = `echo_${hex(10)}`;
      jev.state.handler = () => ({
        status: 429,
        headers: { 'x-typesafe-request-id': `rq_${secret}`, 'retry-after': secret },
        json: { model: 'jev-1.13.0', note: secret },
      });
      const recorded = memory();
      const http = createRecordingHttp({
        gate: createJevGate({ maxInFlight: 2 }),
        recorder: recorded,
        redactValues: [secret],
      });
      await http(
        `${jev.url}?token=${secret}`,
        initFor(bodyFor('echo-sinks'), {
          headers: { 'Content-Type': 'application/json', 'x-trace': secret },
        })
      );
      const [entry] = recorded;
      eq(
        [entry.url, entry.requestId, entry.retryAfter, entry.requestHeaders['x-trace']],
        [`${jev.url}?token=${REDACTED}`, `rq_${REDACTED}`, REDACTED, REDACTED],
        'each sink redacted in place'
      );
      ok(!leavesOf(recorded).some(leaf => leaf.includes(secret)), 'secret absent everywhere');
    }
  );

  await check(
    'jev: abort listeners do not accumulate on a signal shared by many calls',
    async () => {
      jev.reset();
      const controller = new AbortController();
      const gate = createJevGate({ maxInFlight: 2 });
      const http = createRecordingHttp({ gate, recorder: memory() });
      for (let index = 0; index < 25; index += 1) {
        await http(jev.url, initFor(bodyFor(`shared${index}`), { signal: controller.signal }));
        await gate.run(() => 'x', controller.signal);
      }
      eq(getEventListeners(controller.signal, 'abort').length, 0, 'abort listeners left behind');
    }
  );

  await check(
    'jev: a signal that aborted by timeout (the adapter joins its per-attempt timer into it) is a TimeoutError',
    async () => {
      jev.reset();
      jev.state.handler = ({ index }) => ({ ...defaultPlan({ index }), delayMs: 600 });
      const recorded = memory();
      const http = createRecordingHttp({
        gate: createJevGate({ maxInFlight: 1 }),
        recorder: recorded,
      });
      const body = bodyFor('joined-timeout');
      const caller = new AbortController();
      const joined = AbortSignal.any([caller.signal, AbortSignal.timeout(100)]);
      const error = await rejects(
        http(jev.url, initFor(body, { signal: joined })),
        'TimeoutError',
        'timer fired while in flight'
      );
      eq(error.message, 'Jev request timed out', 'fixed message');
      const callerSide = new AbortController();
      const joinedAbort = AbortSignal.any([callerSide.signal, AbortSignal.timeout(5000)]);
      const pending = http(jev.url, initFor(bodyFor('joined-abort'), { signal: joinedAbort }));
      await sleep(60);
      callerSide.abort();
      await rejects(pending, 'AbortError', 'caller abort through a joined signal');
      jev.state.handler = ({ index }) => ({ ...defaultPlan({ index }), delayMs: 400 });
      const holder = http(jev.url, initFor(bodyFor('joined-holder')));
      await sleep(40);
      await rejects(
        http(jev.url, initFor(bodyFor('joined-queued'), { signal: AbortSignal.timeout(80) })),
        'TimeoutError',
        'timer fired while waiting in the gate'
      );
      await holder;
      eq(jev.state.hits.length, 3, 'the queued call never reached the server');
      jev.state.handler = undefined;
      await http(jev.url, initFor(body));
      eq(
        recorded.map(entry => [entry.error ?? null, entry.attempt]),
        [
          ['timeout', 1],
          ['aborted', 1],
          [null, 1],
          [null, 2],
        ],
        'a timer abort is a retryable attempt, a caller abort is not'
      );
    }
  );

  await check('jev: a task that is not a function rejects and releases its slot', async () => {
    const gate = createJevGate({ maxInFlight: 1 });
    for (const task of ['nope', undefined, null, 5]) {
      await rejects(gate.run(task), 'TypeError', `task ${show(task)}`);
      eq([gate.inFlight, gate.queued], [0, 0], `slot after ${show(task)}`);
    }
    eq(await gate.run(() => 'ok'), 'ok', 'gate still works');
  });

  await check('jev: every copy of the module in the process shares one gate', async () => {
    const copy = await import(`${pathToFileURL(path.join(HERE, 'jev.mjs')).href}?second-copy`);
    ok(copy.createJevGate !== createJevGate, 'control: this really is a second module instance');
    ok(copy.getProcessGate() === getProcessGate(), 'same gate object');
    try {
      copy.getProcessGate(2);
      eq(getProcessGate().maxInFlight, 2, 'a limit set through the copy is seen by the original');
    } finally {
      getProcessGate(DEFAULT_JEV_CONCURRENCY);
    }
    eq(copy.getProcessGate().maxInFlight, 3, 'and back');
  });

  await check('jev: nothing is logged or printed, whatever the outcome of a call', async () => {
    jev.reset();
    const quiet = () =>
      createRecordingHttp({ gate: createJevGate({ maxInFlight: 2 }), recorder: memory() });
    const printed = await consoleCalls(async () => {
      const http = quiet();
      await http(jev.url, initFor(bodyFor('quiet-ok')));
      jev.state.handler = () => ({ status: 429, json: { error: FAKE_KEY } });
      await http(jev.url, initFor(bodyFor('quiet-429')));
      jev.state.handler = () => ({ destroy: true });
      await rejects(http(jev.url, initFor(bodyFor('quiet-net'))), 'NetworkError', 'network');
      jev.state.handler = ({ index }) => ({ ...defaultPlan({ index }), delayMs: 400 });
      await rejects(
        http(jev.url, initFor(bodyFor('quiet-timeout'), { timeoutMs: 60 })),
        'TimeoutError',
        'timeout'
      );
      const controller = new AbortController();
      const pending = http(jev.url, initFor(bodyFor('quiet-abort'), { signal: controller.signal }));
      await sleep(40);
      controller.abort();
      await rejects(pending, 'AbortError', 'abort');
      const failing = createRecordingHttp({
        gate: createJevGate({ maxInFlight: 2 }),
        recorder: () => {
          throw new Error(`recorder broke ${FAKE_KEY}`);
        },
        redactValues: () => {
          throw new Error(`source broke ${FAKE_KEY}`);
        },
      });
      jev.state.handler = undefined;
      await failing(jev.url, initFor(bodyFor('quiet-broken')));
    });
    eq(printed, 0, 'console, stdout and stderr writes during the calls');
  });

  await jev.close();
}

// ---------------------------------------------------------------------------------------------
// section 2: browser.mjs and host.mjs in a real headless Chromium
// ---------------------------------------------------------------------------------------------

let browser;
let pages;

async function withScenario(fn, { startPath = '/', umd = STUB_UMD, waitReady = true } = {}) {
  const scenario = await newScenarioContext(browser, { umd });
  try {
    await scenario.page.goto(`${pages.origin}${startPath}`);
    if (waitReady) {
      await scenario.page.waitForFunction(
        () => globalThis.__kriyaTaskBridge?.ready === true,
        undefined,
        { timeout: 10000, polling: 25 }
      );
    }
    return await fn(scenario);
  } finally {
    await scenario.close();
  }
}

async function runBrowserChecks() {
  section('browser.mjs');
  const env = { chromePath: findChromium() };

  await check(
    'browser: findChromium prefers the preferred path, then the first chromium-N, else undefined',
    async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kriya-chromium-'));
      try {
        const exe = 'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
        const preferred = path.join(root, 'preferred-binary');
        fs.writeFileSync(preferred, '');
        eq(findChromium({ preferred, root }), preferred, 'preferred');
        eq(findChromium({ preferred: path.join(root, 'missing'), root }), undefined, 'empty root');
        for (const dir of ['chromium-1300', 'chromium-1100', 'chromium_headless_shell-1000']) {
          const folder = path.join(root, dir, 'chrome-mac-arm64', path.dirname(exe));
          fs.mkdirSync(folder, { recursive: true });
          fs.writeFileSync(path.join(root, dir, 'chrome-mac-arm64', exe), '');
        }
        eq(
          findChromium({ preferred: path.join(root, 'missing'), root }),
          path.join(root, 'chromium-1100', 'chrome-mac-arm64', exe),
          'first sorted chromium-N, headless shell ignored'
        );
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
  );

  await check('browser: a Chromium executable is available for the selftest', async () => {
    ok(
      typeof env.chromePath === 'string' && fs.existsSync(env.chromePath),
      'findChromium found a binary'
    );
  });

  await check(
    'browser: launchBrowser passes headless and the given executable to Playwright',
    async () => {
      const launches = [];
      const fake = {
        chromium: { launch: async options => (launches.push(options), { fake: true }) },
      };
      await launchBrowser({ playwright: fake, chromePath: env.chromePath });
      await launchBrowser({ playwright: fake, chromePath: env.chromePath, headless: false });
      eq(launches[0], { headless: true, executablePath: env.chromePath }, 'defaults');
      eq(launches[1].headless, false, 'headless override');
    }
  );

  await check(
    'browser: launchBrowser falls back to the discovered Chromium when chromePath is stale',
    async () => {
      const launches = [];
      const fake = {
        chromium: { launch: async options => (launches.push(options), { fake: true }) },
      };
      await launchBrowser({ playwright: fake, chromePath: '/nonexistent/chrome' });
      eq(launches[0].executablePath, env.chromePath, 'fallback path');
    }
  );

  await check('browser: launchBrowser starts a real connected headless Chromium', async () => {
    const real = loadPlaywright({});
    ok(typeof real.chromium.launch === 'function', 'playwright loads from the tools dir');
    browser = await launchBrowser(env);
    ok(browser.isConnected(), 'connected');
    ok(/\d+\.\d+/.test(browser.version()), 'has a version');
  });

  if (browser === undefined) {
    return;
  }

  await check(
    'browser: newScenarioContext rejects a missing or empty UMD without leaking a context',
    async () => {
      const before = browser.contexts().length;
      for (const umd of [undefined, '', '   ', 5]) {
        await rejects(newScenarioContext(browser, { umd }), 'TypeError', `umd ${show(umd)}`);
      }
      await rejects(newScenarioContext(browser), 'TypeError', 'no options');
      eq(browser.contexts().length, before, 'contexts unchanged');
    }
  );

  await check('browser: the page viewport is 1280x800', async () => {
    await withScenario(async ({ page }) => {
      eq(page.viewportSize(), VIEWPORT, 'playwright viewport');
      eq(
        await page.evaluate(() => [window.innerWidth, window.innerHeight]),
        [1280, 800],
        'window size'
      );
      eq(VIEWPORT, { width: 1280, height: 800 }, 'exported constant');
    });
  });

  await check(
    'browser: the UMD is evaluated and the bridge is installed in the first document',
    async () => {
      await withScenario(async ({ page }) => {
        const state = await page.evaluate(() => ({
          api: typeof globalThis.WebAutomata?.installTaskBridge,
          bridge: typeof globalThis.__kriyaTaskBridge?.invoke,
          installs: globalThis.__stubInstalls,
          ready: globalThis.__kriyaTaskBridge.ready,
        }));
        eq(state.api, 'function', 'WebAutomata.installTaskBridge');
        eq(state.bridge, 'function', 'bridge global');
        eq(state.installs.length, 1, 'installTaskBridge called exactly once per document');
        eq(state.installs[0].isTop, true, 'called in the top frame');
        eq(state.ready, true, 'ready after load');
      });
    }
  );

  await check(
    'browser: the bridge is installed in the document after a link navigation',
    async () => {
      await withScenario(async ({ page }) => {
        const before = await documentIdOf(page);
        await Promise.all([page.waitForURL(/\/second/), page.click('#go')]);
        await page.waitForFunction(() => globalThis.__kriyaTaskBridge?.ready === true, undefined, {
          polling: 25,
        });
        const after = await documentIdOf(page);
        ok(before !== after, 'new document id');
        eq(
          (await page.evaluate(() => globalThis.__stubInstalls)).length,
          1,
          'one install in the new document'
        );
      });
    }
  );

  await check(
    'browser: the bridge is installed in the document after a form POST navigation',
    async () => {
      await withScenario(async ({ page }) => {
        const before = await documentIdOf(page);
        await Promise.all([page.waitForURL(/\/post/), page.click('#submit')]);
        await page.waitForFunction(() => globalThis.__kriyaTaskBridge?.ready === true, undefined, {
          polling: 25,
        });
        const after = await documentIdOf(page);
        ok(before !== after, 'new document id after POST');
        eq(await page.textContent('#info'), 'method=POST q=hello', 'the POST really happened');
        eq(
          (await page.evaluate(() => globalThis.__stubInstalls)).length,
          1,
          'one install in the POST result'
        );
        ok(
          pages.hits.some(hit => hit.method === 'POST' && hit.path === '/post'),
          'server saw the POST'
        );
      });
    }
  );

  await check(
    'browser: the init script runs in an iframe but only the top frame gets a bridge',
    async () => {
      await withScenario(async ({ page }) => {
        await page.waitForSelector('#frame');
        const child = page.frames().find(frame => frame !== page.mainFrame());
        ok(child !== undefined, 'child frame present');
        await child.waitForLoadState('load');
        const inFrame = await child.evaluate(() => ({
          installs: globalThis.__stubInstalls,
          bridge: typeof globalThis.__kriyaTaskBridge,
        }));
        eq(inFrame.installs.length, 1, 'init script ran in the iframe');
        eq(inFrame.installs[0].isTop, false, 'reported as a non-top frame');
        eq(inFrame.bridge, 'undefined', 'no bridge global in the iframe');
        eq(
          await page.evaluate(() => typeof globalThis.__kriyaTaskBridge.invoke),
          'function',
          'top bridge intact'
        );
      });
    }
  );

  await check('browser: a same-document pushState does not re-run the init script', async () => {
    await withScenario(async ({ page }) => {
      const before = await documentIdOf(page);
      await page.click('#spa');
      eq(await documentIdOf(page), before, 'same document id');
      eq((await page.evaluate(() => globalThis.__stubInstalls)).length, 1, 'still one install');
    });
  });

  await check(
    'browser: a UMD without installTaskBridge surfaces as a page error in diagnostics',
    async () => {
      await withScenario(
        async ({ diagnostics }) => {
          const { pageErrors } = diagnostics();
          ok(pageErrors.length > 0, 'a page error was collected');
          ok(/installTaskBridge/.test(pageErrors[0]), 'it names installTaskBridge');
        },
        { umd: BAD_UMD, waitReady: false }
      );
    }
  );

  await check('browser: diagnostics collect bounded console lines', async () => {
    await withScenario(
      async ({ page, diagnostics }) => {
        await page.waitForFunction(() => document.readyState === 'complete');
        const lines = diagnostics().console;
        ok(
          lines.some(line => line.text === 'diag-line'),
          'page console line captured'
        );
        ok(lines.length <= 200, 'bounded');
      },
      { startPath: '/diag' }
    );
  });

  await check(
    'browser: two scenarios run in isolated contexts (cookies, storage, documents)',
    async () => {
      const baseline = browser.contexts().length;
      const a = await newScenarioContext(browser, { umd: STUB_UMD });
      const b = await newScenarioContext(browser, { umd: STUB_UMD });
      try {
        ok(a.context !== b.context && a.page !== b.page, 'distinct context and page objects');
        eq(browser.contexts().length, baseline + 2, 'two live contexts');
        await a.page.goto(`${pages.origin}/cookie?v=A`);
        await b.page.goto(`${pages.origin}/`);
        eq(
          await b.page.evaluate(() => [document.cookie, localStorage.getItem('scn')]),
          ['', null],
          'B sees nothing from A'
        );
        await b.page.goto(`${pages.origin}/cookie?v=B`);
        await a.page.goto(`${pages.origin}/`);
        eq(
          await a.page.evaluate(() => [document.cookie, localStorage.getItem('scn')]),
          ['scn=A', 'A'],
          'A keeps its own'
        );
        await b.page.goto(`${pages.origin}/`);
        eq(
          await b.page.evaluate(() => [document.cookie, localStorage.getItem('scn')]),
          ['scn=B', 'B'],
          'B keeps its own'
        );
        const [idA, idB] = await Promise.all([documentIdOf(a.page), documentIdOf(b.page)]);
        ok(idA !== idB, 'different bridge documents');
        await a.close();
        eq(browser.contexts().length, baseline + 1, 'closing A closes only A');
        ok(!b.page.isClosed(), 'B page still open');
        eq(
          await b.page.evaluate(() => typeof globalThis.__kriyaTaskBridge.invoke),
          'function',
          'B bridge still works'
        );
      } finally {
        await a.close();
        await b.close();
      }
      eq(browser.contexts().length, baseline, 'both contexts gone after close');
    }
  );

  await check('browser: close() closes the page and context and is idempotent', async () => {
    const scenario = await newScenarioContext(browser, { umd: STUB_UMD });
    const { page, context } = scenario;
    await scenario.close();
    await scenario.close();
    ok(page.isClosed(), 'page closed');
    ok(!browser.contexts().includes(context), 'context closed');
  });

  await check(
    'browser: the init script is the UMD, a line break, then the install call',
    async () => {
      const seen = [];
      const fakeContext = {
        addInitScript: async script => {
          seen.push(script);
        },
        newPage: async () => ({ on: () => undefined, close: async () => undefined }),
        close: async () => undefined,
      };
      await newScenarioContext(
        { newContext: async () => fakeContext },
        { umd: 'globalThis.A = 1; // tail' }
      );
      eq(seen.length, 1, 'one init script');
      eq(
        seen[0],
        { content: 'globalThis.A = 1; // tail\n;WebAutomata.installTaskBridge();\n' },
        'content is exactly the UMD, a newline, then the install call'
      );
      await withScenario(
        async ({ page }) => {
          const state = await page.evaluate(() => ({
            bridge: typeof globalThis.__kriyaTaskBridge?.invoke,
            installs: (globalThis.__stubInstalls ?? []).length,
          }));
          eq(
            state,
            { bridge: 'function', installs: 1 },
            'a bundle ending in a line comment still installs'
          );
        },
        { umd: `${STUB_UMD}\n//# sourceMappingURL=index.umd.js.map` }
      );
    }
  );

  await check(
    'browser: a failure while building the context closes that context and rethrows',
    async () => {
      for (const failAt of ['addInitScript', 'newPage', 'on']) {
        const calls = [];
        const failure = new Error(`${failAt} failed`);
        const context = {
          addInitScript: async () => {
            if (failAt === 'addInitScript') {
              throw failure;
            }
          },
          newPage: async () => {
            if (failAt === 'newPage') {
              throw failure;
            }
            return {
              on: () => {
                if (failAt === 'on') {
                  throw failure;
                }
              },
              close: async () => undefined,
            };
          },
          close: async () => {
            calls.push('context.close');
          },
        };
        let caught;
        try {
          await newScenarioContext({ newContext: async () => context }, { umd: STUB_UMD });
        } catch (error) {
          caught = error;
        }
        ok(caught === failure, `${failAt}: the original error is rethrown`);
        eq(calls, ['context.close'], `${failAt}: the context is closed exactly once`);
      }
      const stubborn = {
        addInitScript: async () => {
          throw new Error('init failed');
        },
        newPage: async () => ({}),
        close: async () => {
          throw new Error('close failed too');
        },
      };
      const error = await rejects(
        newScenarioContext({ newContext: async () => stubborn }, { umd: STUB_UMD }),
        'Error',
        'close failure'
      );
      eq(error.message, 'init failed', 'a failing cleanup does not replace the original error');
    }
  );

  await check(
    'browser: no video or tracing is configured and close() runs each step once',
    async () => {
      const calls = [];
      let contextOptions;
      const context = new Proxy(
        {
          addInitScript: async () => undefined,
          newPage: async () => ({
            on: () => undefined,
            close: async () => {
              calls.push('page.close');
              throw new Error('page close failed');
            },
          }),
          close: async () => {
            calls.push('context.close');
          },
        },
        {
          get: (target, property) => {
            if (property === 'then') {
              return undefined;
            }
            if (!(property in target)) {
              throw new Error(`unexpected use of context.${String(property)}`);
            }
            return target[property];
          },
        }
      );
      const scenario = await newScenarioContext(
        {
          newContext: async options => {
            contextOptions = options;
            return context;
          },
        },
        { umd: STUB_UMD }
      );
      eq(
        contextOptions,
        { viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' },
        'only the viewport and service-worker blocking are configured'
      );
      await Promise.all([scenario.close(), scenario.close()]);
      await scenario.close();
      eq(calls, ['page.close', 'context.close'], 'page then context, once, a page failure ignored');
    }
  );

  await check('browser: diagnostics are bounded in count and in length', async () => {
    await withScenario(
      async ({ page, diagnostics }) => {
        await page.waitForFunction(() => globalThis.__noiseDone === true, undefined, {
          polling: 25,
        });
        await sleep(300);
        const { console: lines, pageErrors } = diagnostics();
        eq(lines.length, 200, 'console lines kept');
        eq(lines[0].text.length, 500, 'a 2000 character line is cut to 500');
        ok(lines[0].text.startsWith('long x'), 'cut from the end');
        eq(lines[1].text, 'noise 0', 'the earliest lines are the ones kept');
        eq(pageErrors.length, 200, 'page errors kept');
        ok(
          pageErrors.every(text => text.length <= 500),
          'page errors cut to 500'
        );
        ok(pageErrors[0].startsWith('err 0 '), 'in order');
        eq(diagnostics().console.length, 200, 'a second call sees the same bounded state');
        diagnostics().console.length = 0;
        eq(diagnostics().console.length, 200, 'diagnostics() returns copies');
      },
      { startPath: '/noisy', waitReady: false }
    );
  });

  await check(
    'browser: findChromium sorts the candidates itself and skips other layouts',
    async () => {
      const exe = 'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
      const present = new Set([
        '/cache',
        path.join('/cache', 'chromium-1300', 'chrome-mac-arm64', exe),
        path.join('/cache', 'chromium-1100', 'chrome-mac', exe),
      ]);
      const readdir = () => [
        'chromium-1300',
        'chromium_headless_shell-1000',
        'notes.txt',
        'chromium-1100',
      ];
      eq(
        findChromium({
          preferred: '/missing',
          root: '/cache',
          exists: file => present.has(file),
          readdir,
        }),
        path.join('/cache', 'chromium-1100', 'chrome-mac', exe),
        'lowest chromium-N first, intel layout accepted'
      );
      let listed = false;
      eq(
        findChromium({
          preferred: '/missing',
          root: '/nowhere',
          exists: () => false,
          readdir: () => {
            listed = true;
            return [];
          },
        }),
        undefined,
        'nothing installed'
      );
      eq(listed, false, 'a missing cache root is never listed');
    }
  );

  await check(
    'browser: the Playwright tools directory comes from BREEZE_GUIDE_TOOLS_DIR; empty means default',
    async () => {
      const toolsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kriya-tools-'));
      try {
        fs.writeFileSync(path.join(toolsDir, 'package.json'), '{"name":"fake-tools"}');
        fs.mkdirSync(path.join(toolsDir, 'node_modules', 'playwright'), { recursive: true });
        fs.writeFileSync(
          path.join(toolsDir, 'node_modules', 'playwright', 'index.js'),
          "module.exports = { chromium: { launch() {} }, marker: 'fake-tools' };"
        );
        const defaultFixture = path.join(toolsDir, 'default-playwright.cjs');
        fs.writeFileSync(
          defaultFixture,
          "module.exports = { chromium: { launch() {} }, marker: 'fake-default' };"
        );
        const probe = `
        import Module from 'node:module';
        import { loadPlaywright } from ${JSON.stringify(pathToFileURL(path.join(HERE, 'browser.mjs')).href)};
        const resolve = Module._resolveFilename;
        Module._resolveFilename = function(request, parent, ...rest) {
          if (request === 'playwright' && parent?.filename === '/tmp/amazon-guide/package.json') {
            return ${JSON.stringify(defaultFixture)};
          }
          return Reflect.apply(resolve, this, [request, parent, ...rest]);
        };
        const loaded = loadPlaywright({});
        process.stdout.write(typeof loaded.chromium.launch === 'function' ? (loaded.marker ?? 'real') : 'broken');
      `;
        const run = value => {
          const result = spawnSync(process.execPath, ['--input-type=module', '-e', probe], {
            encoding: 'utf8',
            timeout: 20000,
            env: { ...process.env, BREEZE_GUIDE_TOOLS_DIR: value },
          });
          return [result.status, result.stdout, result.stderr.split('\n')[0]];
        };
        eq(run(toolsDir), [0, 'fake-tools', ''], 'override directory is used');
        eq(
          run(''),
          [0, 'fake-default', ''],
          'an empty override resolves from the exact default tools directory'
        );
      } finally {
        fs.rmSync(toolsDir, { recursive: true, force: true });
      }
      const real = loadPlaywright({});
      eq(
        loadPlaywright({ playwright: 'not playwright' }),
        real,
        'a non-object injection is ignored'
      );
      eq(
        loadPlaywright({ playwright: { chromium: {} } }),
        real,
        'an injection without launch is ignored'
      );
    }
  );
}

async function runHostChecks() {
  section('host.mjs (fake page)');

  await check('host: the transport has the TaskTransport shape and is concurrent', async () => {
    const transport = createPlaywrightTransport({ page: fakePage() });
    eq(typeof transport.invoke, 'function', 'invoke');
    eq(transport.concurrent, true, 'concurrent');
    eq(typeof transport.location, 'function', 'location');
    eq(typeof transport.waitForDocument, 'function', 'waitForDocument');
  });

  await check('host: classifyEvaluateError maps Playwright rejection texts', async () => {
    const table = [
      [
        'page.evaluate: Execution context was destroyed, most likely because of a navigation.',
        'navigated',
      ],
      ['Frame was detached', 'navigated'],
      ['Navigation interrupted the evaluation', 'navigated'],
      ['page.evaluate: Target page, context or browser has been closed', 'closed'],
      ['Target closed', 'closed'],
      ['Timeout 30000ms exceeded.', 'timeout'],
      ['TypeError: something else', 'error'],
    ];
    for (const [text, reason] of table) {
      eq(classifyEvaluateError(new Error(text)), reason, text);
    }
    eq(classifyEvaluateError('Execution context was destroyed'), 'navigated', 'plain string');
    eq(classifyEvaluateError(undefined), 'error', 'undefined');
  });

  await check('host: every rejection class becomes a lost result and never rejects', async () => {
    const cases = [
      ['Execution context was destroyed, most likely because of a navigation.', 'navigated'],
      ['Frame was detached', 'navigated'],
      ['Target page, context or browser has been closed', 'closed'],
      ['weird failure', 'error'],
    ];
    for (const [text, reason] of cases) {
      const transport = createPlaywrightTransport({
        page: fakePage({ evaluate: () => Promise.reject(new Error(text)) }),
      });
      const result = await transport.invoke(envelope('observe'), callOf());
      eq([result.kind, result.reason], ['lost', reason], text);
    }
  });

  await check(
    'host: a synchronous throw from the page is a lost result, not a rejection',
    async () => {
      const transport = createPlaywrightTransport({
        page: fakePage({
          evaluate: () => {
            throw new Error(`sync boom ${HOST_SECRET}`);
          },
        }),
        redact: redactHostSecret,
      });
      const result = await transport.invoke(envelope('observe'), callOf());
      eq([result.kind, result.reason], ['lost', 'error'], 'mapped');
      ok(!result.message.includes(HOST_SECRET), 'message scrubbed');
    }
  );

  await check(
    'host: lost messages for navigated, closed and timeout are fixed strings',
    async () => {
      const cases = [
        [
          `Execution context was destroyed ${HOST_SECRET}`,
          'navigated',
          'the document was replaced during the call',
        ],
        [
          `Frame was detached ${HOST_SECRET}`,
          'navigated',
          'the document was replaced during the call',
        ],
        [
          `Target page, context or browser has been closed ${HOST_SECRET}`,
          'closed',
          'the page was closed',
        ],
      ];
      for (const [text, reason, message] of cases) {
        const transport = createPlaywrightTransport({
          page: fakePage({ evaluate: () => Promise.reject(new Error(text)) }),
        });
        const result = await transport.invoke(envelope('observe'), callOf());
        eq([result.reason, result.message], [reason, message], `${reason}: ${text.slice(0, 20)}`);
      }
      const hanging = createPlaywrightTransport({
        page: fakePage({ evaluate: () => new Promise(() => undefined) }),
      });
      const timedOut = await hanging.invoke(envelope('observe'), callOf(60));
      eq(
        [timedOut.reason, timedOut.message],
        ['timeout', 'the call timed out'],
        'timeout message is fixed'
      );
      const closedPage = createPlaywrightTransport({ page: fakePage({ isClosed: () => true }) });
      const closed = await closedPage.invoke(envelope('observe'), callOf());
      eq([closed.reason, closed.message], ['closed', 'the page was closed'], 'closed page');
    }
  );

  await check(
    'host: an error message is first line only, capped at 300 characters, and always a string',
    async () => {
      const lines = createPlaywrightTransport({
        page: fakePage({ evaluate: () => Promise.reject(new Error('line one\nline two secret')) }),
      });
      eq(
        (await lines.invoke(envelope('observe'), callOf())).message,
        'line one',
        'first line only'
      );
      const long = createPlaywrightTransport({
        page: fakePage({ evaluate: () => Promise.reject(new Error('a'.repeat(1000))) }),
      });
      eq((await long.invoke(envelope('observe'), callOf())).message, 'a'.repeat(300), 'capped');
      for (const redact of [() => 5, () => undefined, () => null, () => ({ text: 'x' })]) {
        const odd = createPlaywrightTransport({
          page: fakePage({ evaluate: () => Promise.reject(new Error('boom')) }),
          redact,
        });
        eq(
          (await odd.invoke(envelope('observe'), callOf())).message,
          '[message withheld]',
          'a redact result that is not a string withholds the message'
        );
      }
      const throwsOddly = createPlaywrightTransport({
        page: fakePage({ evaluate: () => Promise.reject({ message: 7 }) }),
      });
      const odd = await throwsOddly.invoke(envelope('observe'), callOf());
      eq(
        [odd.kind, odd.reason, typeof odd.message],
        ['lost', 'error', 'string'],
        'non-Error rejection'
      );
    }
  );

  await check(
    'host: redact may be a function or an object with scrub; a throwing redact withholds the message',
    async () => {
      const reject = () => Promise.reject(new Error(`boom ${HOST_SECRET}`));
      const viaObject = createPlaywrightTransport({
        page: fakePage({ evaluate: reject }),
        redact: { scrub: redactHostSecret },
      });
      const first = await viaObject.invoke(envelope('observe'), callOf());
      ok(
        !first.message.includes(HOST_SECRET) && first.message.includes(REDACTED),
        'scrub object applied'
      );
      const throwing = createPlaywrightTransport({
        page: fakePage({ evaluate: reject }),
        redact: () => {
          throw new Error('redactor failed');
        },
      });
      const second = await throwing.invoke(envelope('observe'), callOf());
      eq(second.message, '[message withheld]', 'withheld');
    }
  );

  await check('host: a malformed in-page answer is a lost error, never forwarded', async () => {
    for (const value of [
      undefined,
      {},
      { response: null },
      { response: 5 },
      { response: [] },
      null,
    ]) {
      const transport = createPlaywrightTransport({
        page: fakePage({ evaluate: async () => value }),
      });
      const result = await transport.invoke(envelope('observe'), callOf());
      eq([result.kind, result.reason], ['lost', 'error'], `value ${show(value)}`);
    }
    const good = createPlaywrightTransport({
      page: fakePage({ evaluate: async () => ({ response: { ok: true, value: 1 } }) }),
    });
    eq(
      (await good.invoke(envelope('observe'), callOf())).kind,
      'response',
      'a response object passes through'
    );
  });

  await check(
    'host: location survives a throwing page and reports an unparseable url',
    async () => {
      const throwing = createPlaywrightTransport({
        page: fakePage({
          url: () => {
            throw new Error('gone');
          },
        }),
      });
      eq((await throwing.location(callOf())).error.code, 'HOST_UNAVAILABLE', 'throwing url()');
      const garbage = createPlaywrightTransport({ page: fakePage({ url: () => 'not a url' }) });
      eq((await garbage.location(callOf())).ok, false, 'unparseable url');
      const blank = createPlaywrightTransport({ page: fakePage({ url: () => 'about:blank' }) });
      eq(
        (await blank.location(callOf())).value,
        { url: 'about:blank', origin: 'null' },
        'opaque origin'
      );
    }
  );

  await check('host: waitForDocument never rejects when the page throws', async () => {
    const transport = createPlaywrightTransport({
      page: fakePage({
        waitForFunction: () => {
          throw new Error('sync');
        },
      }),
    });
    eq(await transport.waitForDocument({ timeoutMs: 100 }), null, 'sync throw');
    const rejecting = createPlaywrightTransport({
      page: fakePage({ waitForFunction: () => Promise.reject(new Error('timeout')) }),
    });
    eq(await rejecting.waitForDocument({ timeoutMs: 100 }), null, 'rejection');
  });

  section('host.mjs (real Chromium and stub bridge)');

  await check('host: hello and observe go through the page bridge', async () => {
    await withScenario(async ({ page }) => {
      const transport = createPlaywrightTransport({ page });
      const hello = envelope('hello');
      const result = await transport.invoke(hello, callOf());
      eq(result.kind, 'response', 'hello kind');
      eq(
        [result.response.ok, result.response.protocol, result.response.callId],
        [true, 'kriya.task.v1', hello.callId],
        'envelope fields'
      );
      eq(result.response.documentId, await documentIdOf(page), 'live document id');
      eq(result.response.value.isTop, true, 'hello value');
      const observe = await transport.invoke(envelope('observe'), callOf());
      eq([observe.kind, observe.response.method], ['response', 'observe'], 'observe');
    });
  });

  await check('host: location comes from page.url() and never evaluates in the page', async () => {
    await withScenario(async ({ page }) => {
      await page.evaluate(() => {
        globalThis.__stubLie = true;
      });
      const transport = createPlaywrightTransport({ page });
      const lie = await transport.invoke(envelope('hello'), callOf());
      eq(
        lie.response.value.origin,
        'https://evil.example',
        'control: the page bridge lies about its origin'
      );
      const original = page.evaluate.bind(page);
      let evaluations = 0;
      page.evaluate = (...args) => {
        evaluations += 1;
        return original(...args);
      };
      const first = await transport.location(callOf());
      eq(
        first,
        { ok: true, value: { url: page.url(), origin: pages.origin } },
        'authoritative location'
      );
      await original(() => history.pushState({}, '', '/moved'));
      const second = await transport.location(callOf());
      eq(second.value.url, `${pages.origin}/moved`, 'tracks same-document changes');
      eq(evaluations, 0, 'no page.evaluate used for location');
      page.evaluate = original;
    });
  });

  await check('host: location of a closed page is a DOCUMENT_LOST error', async () => {
    await withScenario(async ({ page }) => {
      const transport = createPlaywrightTransport({ page });
      await page.close();
      const result = await transport.location(callOf());
      eq(
        [result.ok, result.error.code, result.error.retryable],
        [false, 'DOCUMENT_LOST', false],
        'closed page'
      );
    });
  });

  await withScenario(async ({ page }) => {
    const transport = createPlaywrightTransport({ page });
    const before = await documentIdOf(page);
    const started = performance.now();
    let lostResult;
    await check(
      'host: a click that navigates returns lost(navigated) and does not reject',
      async () => {
        lostResult = await transport.invoke(
          envelope('execute', { __stub: { click: '#go', hold: 8000 } }),
          callOf(10000)
        );
        eq([lostResult.kind, lostResult.reason], ['lost', 'navigated'], 'result');
        ok(
          typeof lostResult.message === 'string' && lostResult.message.length > 0,
          'has a message'
        );
        ok(
          performance.now() - started < 4000,
          'returned at the destruction, not at the call timeout'
        );
      }
    );
    let info;
    await check(
      'host: waitForDocument then confirms the new document (id, ready, authoritative url)',
      async () => {
        info = await transport.waitForDocument({ previousDocumentId: before, timeoutMs: 8000 });
        ok(info !== null, 'a document arrived');
        ok(info.documentId !== before && info.ready === true, 'different and ready');
        eq(info.url, page.url(), 'url from page.url()');
        ok(info.url.endsWith('/second?via=link'), 'the navigated page');
      }
    );
    await check(
      'host: a bridge hello on the new document matches the confirmed document',
      async () => {
        const hello = await transport.invoke(envelope('hello'), callOf());
        eq(hello.kind, 'response', 'hello answered');
        eq(hello.response.documentId, info.documentId, 'same document id');
        eq(hello.response.value.url, page.url(), 'bridge agrees with the controller');
      }
    );
  });

  await withScenario(async ({ page }) => {
    const transport = createPlaywrightTransport({ page });
    const before = await documentIdOf(page);
    await check(
      'host: a form POST navigation returns lost(navigated) and the next hello is confirmed',
      async () => {
        const lostResult = await transport.invoke(
          envelope('execute', { __stub: { click: '#submit', hold: 8000 } }),
          callOf(10000)
        );
        eq([lostResult.kind, lostResult.reason], ['lost', 'navigated'], 'result');
        const info = await transport.waitForDocument({
          previousDocumentId: before,
          timeoutMs: 8000,
        });
        ok(info !== null && info.documentId !== before, 'new document confirmed');
        const hello = await transport.invoke(envelope('hello'), callOf());
        eq(hello.response.documentId, info.documentId, 'hello matches');
        eq(await page.textContent('#info'), 'method=POST q=hello', 'the POST result is displayed');
      }
    );
  });

  await check('host: a same-document click returns the bridge response unchanged', async () => {
    await withScenario(async ({ page }) => {
      const transport = createPlaywrightTransport({ page });
      const before = await documentIdOf(page);
      const result = await transport.invoke(
        envelope('execute', { __stub: { click: '#spa' } }),
        callOf()
      );
      eq(result.kind, 'response', 'response');
      eq(result.response.value, { status: 'applied', effect: 'applied' }, 'outcome');
      eq(await documentIdOf(page), before, 'same document');
      eq(
        (await transport.location(callOf())).value.url,
        `${pages.origin}/spa`,
        'location follows pushState'
      );
    });
  });

  await check(
    'host: a slow navigation outliving the call timeout gives lost(timeout), then the document arrives',
    async () => {
      await withScenario(async ({ page }) => {
        const transport = createPlaywrightTransport({ page });
        const before = await documentIdOf(page);
        const started = performance.now();
        const result = await transport.invoke(
          envelope('execute', { __stub: { click: '#slowgo', hold: 8000 } }),
          callOf(300)
        );
        const waited = performance.now() - started;
        eq([result.kind, result.reason], ['lost', 'timeout'], 'result');
        ok(
          waited >= 250 && waited < 1100,
          `timeout fired near 300 ms, not at the navigation commit (${Math.round(waited)} ms)`
        );
        const info = await transport.waitForDocument({
          previousDocumentId: before,
          timeoutMs: 8000,
        });
        ok(info !== null && info.documentId !== before, 'new document confirmed');
        ok(info.url.endsWith('/slow'), 'the slow page');
        ok(performance.now() - started >= 1100, 'resolved only after the navigation committed');
      });
    }
  );

  await check(
    'host: a call timeout without navigation gives lost(timeout) and the transport stays usable',
    async () => {
      await withScenario(async ({ page }) => {
        const transport = createPlaywrightTransport({ page });
        const started = performance.now();
        const result = await transport.invoke(
          envelope('execute', { __stub: { hold: 4000 } }),
          callOf(250)
        );
        const waited = performance.now() - started;
        eq([result.kind, result.reason], ['lost', 'timeout'], 'result');
        ok(waited >= 200 && waited < 1500, `bounded wait (${Math.round(waited)} ms)`);
        const hello = await transport.invoke(envelope('hello'), callOf());
        eq(hello.kind, 'response', 'later call still answered');
      });
    }
  );

  await check(
    'host: waitForDocument returns null when no new hello arrives before the timeout',
    async () => {
      await withScenario(async ({ page }) => {
        const transport = createPlaywrightTransport({ page });
        const current = await documentIdOf(page);
        const started = performance.now();
        const info = await transport.waitForDocument({
          previousDocumentId: current,
          timeoutMs: 400,
        });
        const waited = performance.now() - started;
        eq(info, null, 'timeout result');
        ok(waited >= 350 && waited < 2500, `waited about the timeout (${Math.round(waited)} ms)`);
      });
    }
  );

  await check(
    'host: waitForDocument resolves at once for a ready document that differs from the previous one',
    async () => {
      await withScenario(async ({ page }) => {
        const transport = createPlaywrightTransport({ page });
        const started = performance.now();
        const info = await transport.waitForDocument({
          previousDocumentId: 'doc_other',
          timeoutMs: 5000,
        });
        eq(info.documentId, await documentIdOf(page), 'current document');
        ok(performance.now() - started < 1500, 'immediate');
        const anyDoc = await transport.waitForDocument({ timeoutMs: 5000 });
        eq(anyDoc.documentId, info.documentId, 'no previous id: any ready document');
      });
    }
  );

  await check(
    'host: waitForDocument honors an abort signal (during and before the wait)',
    async () => {
      await withScenario(async ({ page }) => {
        const transport = createPlaywrightTransport({ page });
        const current = await documentIdOf(page);
        const controller = new AbortController();
        const started = performance.now();
        const pending = transport.waitForDocument({
          previousDocumentId: current,
          timeoutMs: 6000,
          signal: controller.signal,
        });
        await sleep(100);
        controller.abort();
        eq(await pending, null, 'aborted during the wait');
        ok(performance.now() - started < 2000, 'prompt');
        eq(
          await transport.waitForDocument({
            previousDocumentId: current,
            timeoutMs: 6000,
            signal: controller.signal,
          }),
          null,
          'aborted before the wait'
        );
      });
    }
  );

  await check('host: waitForDocument on a closed page is null', async () => {
    await withScenario(async ({ page }) => {
      const transport = createPlaywrightTransport({ page });
      await page.close();
      eq(await transport.waitForDocument({ timeoutMs: 1000 }), null, 'closed page');
    });
  });

  await check(
    'host: a cancel reaches the page while its execute is pending and acknowledges before_commit',
    async () => {
      await withScenario(async ({ page }) => {
        const transport = createPlaywrightTransport({ page });
        const execute = envelope('execute', { __stub: { hold: 6000 } });
        const started = performance.now();
        const pending = transport.invoke(execute, callOf(10000));
        await page.waitForFunction(() => globalThis.__stubExecutions.started === 1, undefined, {
          polling: 25,
          timeout: 5000,
        });
        const ack = await transport.invoke(
          envelope('cancel', { targetCallId: execute.callId }),
          callOf(3000)
        );
        eq(ack.kind, 'response', 'cancel answered while execute pending');
        eq(ack.response.value, { found: true, phase: 'before_commit' }, 'ack');
        const outcome = await pending;
        eq(
          outcome.response.value,
          { status: 'failed', code: 'EXECUTION_CANCELLED', effect: 'none' },
          'execute outcome'
        );
        ok(performance.now() - started < 4000, 'execute ended at the cancel, not at its own hold');
      });
    }
  );

  await check(
    'host: a cancel after the mutation boundary acknowledges after_commit and the outcome is uncertain',
    async () => {
      await withScenario(async ({ page }) => {
        const transport = createPlaywrightTransport({ page });
        const execute = envelope('execute', { __stub: { click: '#spa', hold: 6000 } });
        const pending = transport.invoke(execute, callOf(10000));
        await page.waitForFunction(() => globalThis.__stubExecutions.started === 1, undefined, {
          polling: 25,
          timeout: 5000,
        });
        const ack = await transport.invoke(
          envelope('cancel', { targetCallId: execute.callId }),
          callOf(3000)
        );
        eq(ack.response.value, { found: true, phase: 'after_commit' }, 'ack');
        eq((await pending).response.value.effect, 'uncertain', 'effect');
      });
    }
  );

  await check('host: a cancel for a finished call acknowledges finished', async () => {
    await withScenario(async ({ page }) => {
      const transport = createPlaywrightTransport({ page });
      const execute = envelope('execute', { __stub: {} });
      await transport.invoke(execute, callOf());
      const ack = await transport.invoke(
        envelope('cancel', { targetCallId: execute.callId }),
        callOf()
      );
      eq(ack.response.value, { found: true, phase: 'finished' }, 'ack');
    });
  });

  await check(
    'host: a cancel that overtakes its execute leaves a tombstone and the execute never runs',
    async () => {
      await withScenario(async ({ page }) => {
        const transport = createPlaywrightTransport({ page });
        const execute = envelope('execute', { __stub: { click: '#spa' } });
        const ack = await transport.invoke(
          envelope('cancel', { targetCallId: execute.callId }),
          callOf()
        );
        eq(ack.response.value, { found: false, phase: 'unknown' }, 'unknown ack');
        const outcome = await transport.invoke(execute, callOf());
        eq(
          outcome.response.value,
          { status: 'failed', code: 'EXECUTION_CANCELLED', effect: 'none' },
          'cancelled outcome'
        );
        eq((await executionsOf(page)).started, 0, 'the executor never started');
        eq(new URL(page.url()).pathname, '/', 'the click never happened');
      });
    }
  );

  await check('host: envelopes sent back to back reach the page in call order', async () => {
    await withScenario(async ({ page }) => {
      const transport = createPlaywrightTransport({ page });
      await page.evaluate(() => {
        globalThis.__stubOrder.length = 0;
      });
      const sent = [
        envelope('hello'),
        envelope('observe'),
        envelope('hello'),
        envelope('observe'),
        envelope('hello'),
      ];
      await Promise.all(sent.map(item => transport.invoke(item, callOf())));
      const order = await page.evaluate(() => globalThis.__stubOrder.map(item => item.callId));
      eq(
        order,
        sent.map(item => item.callId),
        'arrival order'
      );
    });
  });

  await check('host: a page-side rejection is a scrubbed lost(error)', async () => {
    await withScenario(async ({ page }) => {
      const transport = createPlaywrightTransport({ page, redact: redactHostSecret });
      const result = await transport.invoke(
        envelope('observe', { __stub: { throw: `boom ${HOST_SECRET}` } }),
        callOf()
      );
      eq([result.kind, result.reason], ['lost', 'error'], 'mapped');
      ok(!result.message.includes(HOST_SECRET), 'secret scrubbed from the message');
      ok(result.message.includes(REDACTED), 'marker present');
      ok(!result.message.includes('\n') && result.message.length <= 300, 'first line, capped');
    });
  });

  await check('host: an in-page answer that is not an object is a lost error', async () => {
    await withScenario(async ({ page }) => {
      const transport = createPlaywrightTransport({ page });
      const result = await transport.invoke(
        envelope('release', { __stub: { malformed: true } }),
        callOf()
      );
      eq(
        [result.kind, result.reason, result.message],
        ['lost', 'error', 'malformed bridge response'],
        'result'
      );
    });
  });

  await check('host: a page without a bridge is a lost error, not a rejection', async () => {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.goto(`${pages.origin}/`);
      const transport = createPlaywrightTransport({ page });
      const result = await transport.invoke(envelope('hello'), callOf());
      eq(
        [result.kind, result.reason, result.message],
        ['lost', 'error', 'bridge not installed'],
        'result'
      );
      eq(await transport.waitForDocument({ timeoutMs: 300 }), null, 'no document without a bridge');
    } finally {
      await context.close();
    }
  });

  await check('host: invoke on a closed page is lost(closed)', async () => {
    await withScenario(async ({ page }) => {
      const transport = createPlaywrightTransport({ page });
      await page.close();
      const result = await transport.invoke(envelope('hello'), callOf());
      eq([result.kind, result.reason], ['lost', 'closed'], 'result');
    });
  });

  await check('host: a page closed during a pending call is lost(closed)', async () => {
    await withScenario(async ({ page }) => {
      const transport = createPlaywrightTransport({ page });
      const pending = transport.invoke(
        envelope('execute', { __stub: { hold: 6000 } }),
        callOf(10000)
      );
      await page.waitForFunction(() => globalThis.__stubExecutions.started === 1, undefined, {
        polling: 25,
        timeout: 5000,
      });
      await page.close();
      const result = await pending;
      eq([result.kind, result.reason], ['lost', 'closed'], 'result');
    });
  });

  await check(
    'host: an execute aborted before sending is not sent; a cancel is always sent',
    async () => {
      await withScenario(async ({ page }) => {
        const transport = createPlaywrightTransport({ page });
        const controller = new AbortController();
        controller.abort();
        const executed = await transport.invoke(
          envelope('execute', { __stub: { click: '#spa' } }),
          callOf(5000, controller.signal)
        );
        eq([executed.kind, executed.reason], ['lost', 'error'], 'execute withheld');
        eq((await executionsOf(page)).started, 0, 'nothing ran in the page');
        eq(new URL(page.url()).pathname, '/', 'page untouched');
        const ack = await transport.invoke(
          envelope('cancel', { targetCallId: 'req_unknown' }),
          callOf(5000, controller.signal)
        );
        eq(ack.kind, 'response', 'cancel delivered despite the aborted signal');
        const hello = await transport.invoke(envelope('hello'), callOf(5000, controller.signal));
        eq([hello.kind, hello.reason], ['lost', 'error'], 'other methods honor an aborted signal');
      });
    }
  );

  await check(
    'host: an abort while an observe waits stops the wait; an abort during execute does not',
    async () => {
      await withScenario(async ({ page }) => {
        const transport = createPlaywrightTransport({ page });
        const observeAbort = new AbortController();
        const started = performance.now();
        const observing = transport.invoke(
          envelope('observe', { __stub: { hold: 5000 } }),
          callOf(10000, observeAbort.signal)
        );
        await sleep(100);
        observeAbort.abort();
        const observed = await observing;
        eq(
          [observed.kind, observed.reason, observed.message],
          ['lost', 'error', 'aborted while waiting'],
          'observe'
        );
        ok(performance.now() - started < 2500, 'prompt');
        const executeAbort = new AbortController();
        const executing = transport.invoke(
          envelope('execute', { __stub: { hold: 500 } }),
          callOf(10000, executeAbort.signal)
        );
        await sleep(100);
        executeAbort.abort();
        const outcome = await executing;
        eq(outcome.kind, 'response', 'execute keeps waiting for the in-flight outcome');
        eq(outcome.response.value.status, 'applied', 'its real outcome');
      });
    }
  );

  await check(
    'host: nothing is logged, and trace lines carry no payload unless redactEnvelope is supplied',
    async () => {
      await withScenario(async ({ page }) => {
        const plainLines = [];
        const plain = createPlaywrightTransport({ page, onTrace: line => plainLines.push(line) });
        const redactedLines = [];
        const redacting = createPlaywrightTransport({
          page,
          onTrace: line => redactedLines.push(line),
          redactEnvelope: item => ({ ...item, payload: REDACTED }),
        });
        const secretPayload = { __stub: {}, fill: HOST_SECRET };
        const logged = await consoleCalls(async () => {
          await plain.invoke(envelope('execute', secretPayload), callOf());
          await redacting.invoke(envelope('execute', secretPayload), callOf());
          await plain.invoke(
            envelope('observe', { __stub: { throw: `page error ${HOST_SECRET}` } }),
            callOf()
          );
        });
        eq(logged, 0, 'console calls');
        eq(plainLines.length, 2, 'plain trace lines');
        ok(
          plainLines.every(line => !('envelope' in line)),
          'no envelope without redactEnvelope'
        );
        ok(
          !JSON.stringify(plainLines).includes(HOST_SECRET),
          'payload value absent from plain lines'
        );
        eq(plainLines[0].kind, 'response', 'line carries the outcome kind');
        eq(plainLines[1].reason, 'error', 'line carries the lost reason');
        ok(!('message' in plainLines[1]), 'a lost line carries the reason, never the page message');
        eq(redactedLines[0].envelope.payload, REDACTED, 'redacted envelope attached');
        ok(
          !JSON.stringify(redactedLines).includes(HOST_SECRET),
          'payload value absent from redacted lines'
        );
      });
    }
  );

  await check(
    'host: a throwing trace sink or redactEnvelope never changes the call result',
    async () => {
      await withScenario(async ({ page }) => {
        const sink = createPlaywrightTransport({
          page,
          onTrace: () => {
            throw new Error('sink');
          },
        });
        eq((await sink.invoke(envelope('hello'), callOf())).kind, 'response', 'throwing sink');
        const redactor = createPlaywrightTransport({
          page,
          onTrace: () => undefined,
          redactEnvelope: () => {
            throw new Error('redactor');
          },
        });
        eq(
          (await redactor.invoke(envelope('hello'), callOf())).kind,
          'response',
          'throwing redactEnvelope'
        );
      });
    }
  );

  await check(
    'host: hostile timeout values neither fire early, throw, nor print a warning',
    async () => {
      const before = processWarnings.length;
      const waitOptions = [];
      const page = fakePage({
        evaluate: async () => {
          await sleep(60);
          return { response: { ok: true } };
        },
        waitForFunction: async (_fn, _arg, options) => {
          waitOptions.push(options);
          return {
            jsonValue: async () => ({ documentId: 'doc_x' }),
            dispose: async () => undefined,
          };
        },
      });
      const transport = createPlaywrightTransport({ page });
      const hostile = [
        3e9,
        1e10,
        Number.MAX_SAFE_INTEGER,
        Infinity,
        Number.NaN,
        -1,
        0,
        '5',
        undefined,
      ];
      for (const timeoutMs of hostile) {
        const result = await transport.invoke(envelope('hello'), { timeoutMs });
        eq(result.kind, 'response', `invoke timeoutMs ${String(timeoutMs)}`);
        const info = await transport.waitForDocument({ timeoutMs });
        eq(info?.documentId, 'doc_x', `waitForDocument timeoutMs ${String(timeoutMs)}`);
      }
      eq((await transport.invoke(envelope('hello'))).kind, 'response', 'no call object at all');
      ok(
        waitOptions.every(
          options => options.timeout > 0 && options.timeout <= 2 ** 31 - 1 && options.polling === 25
        ),
        `wait options stay inside the timer range (${show(waitOptions.map(options => options.timeout))})`
      );
      await sleep(30);
      eq(processWarnings.slice(before), [], 'no process warning');
    }
  );

  await check(
    'host: waitForDocument asks the page for the documented condition and disposes the handle',
    async () => {
      const calls = [];
      let disposed = 0;
      const handleFor = value => ({
        jsonValue: async () => value,
        dispose: async () => {
          disposed += 1;
        },
      });
      let answer = { documentId: 'doc_next' };
      const page = fakePage({
        url: () => 'http://127.0.0.1:9/after?x=1',
        waitForFunction: async (fn, arg, options) => {
          calls.push({ fn, arg, options });
          return handleFor(answer);
        },
      });
      const transport = createPlaywrightTransport({ page });
      const info = await transport.waitForDocument({
        previousDocumentId: 'doc_prev',
        timeoutMs: 1234,
      });
      eq(
        info,
        { documentId: 'doc_next', url: 'http://127.0.0.1:9/after?x=1', ready: true },
        'confirmed document'
      );
      eq(calls[0].arg, { name: '__kriyaTaskBridge', previous: 'doc_prev' }, 'condition arguments');
      eq(calls[0].options, { timeout: 1234, polling: 25 }, 'timeout and 25 ms polling');
      eq(disposed, 1, 'handle disposed after a hit');
      await transport.waitForDocument({});
      eq(calls[1].options, { timeout: 15000, polling: 25 }, 'default wait');
      eq(calls[1].arg.previous, null, 'no previous id');
      for (const value of [null, false, {}, { documentId: '' }, { documentId: 5 }]) {
        answer = value;
        eq(await transport.waitForDocument({ timeoutMs: 50 }), null, `answer ${show(value)}`);
      }
      eq(disposed, 7, 'every handle disposed, hit or not');
      const custom = createPlaywrightTransport({ page, bridgeGlobal: '__otherBridge' });
      await custom.waitForDocument({});
      eq(calls.at(-1).arg.name, '__otherBridge', 'bridgeGlobal option reaches the page condition');
    }
  );

  await check(
    'host: waitForDocument waits for the bridge to be ready, not merely present',
    async () => {
      const scenario = await newScenarioContext(browser, { umd: STUB_UMD });
      try {
        const { page } = scenario;
        const transport = createPlaywrightTransport({ page });
        const blank = await page.evaluate(() => globalThis.__kriyaTaskBridge?.documentId ?? null);
        const started = performance.now();
        const navigation = page.goto(`${pages.origin}/slowload`, { waitUntil: 'commit' });
        const info = await transport.waitForDocument({
          previousDocumentId: blank ?? undefined,
          timeoutMs: 6000,
        });
        const waited = performance.now() - started;
        await navigation;
        ok(info !== null && info.documentId !== blank, 'the new document was confirmed');
        ok(
          waited >= 700,
          `waited for DOMContentLoaded behind a 900 ms script (${Math.round(waited)} ms)`
        );
        eq(await page.evaluate(() => globalThis.__kriyaTaskBridge.ready), true, 'ready by then');
      } finally {
        await scenario.close();
      }
    }
  );

  await check('host: waitForDocument with an already aborted signal returns at once', async () => {
    await withScenario(async ({ page }) => {
      const transport = createPlaywrightTransport({ page });
      const current = await documentIdOf(page);
      const controller = new AbortController();
      controller.abort();
      const started = performance.now();
      eq(
        await transport.waitForDocument({
          previousDocumentId: current,
          timeoutMs: 3000,
          signal: controller.signal,
        }),
        null,
        'null'
      );
      ok(performance.now() - started < 1000, 'without waiting for the timeout');
    });
  });

  await check(
    'host: a bridge-shaped global without a callable invoke is not a bridge',
    async () => {
      const context = await browser.newContext();
      try {
        await context.addInitScript(() => {
          globalThis.__kriyaTaskBridge = { ready: true, documentId: 'doc_fake', invoke: 'nope' };
        });
        const page = await context.newPage();
        await page.goto(`${pages.origin}/`);
        const transport = createPlaywrightTransport({ page });
        const result = await transport.invoke(envelope('hello'), callOf());
        eq(
          [result.kind, result.reason, result.message],
          ['lost', 'error', 'bridge not installed'],
          'result'
        );
      } finally {
        await context.close();
      }
    }
  );

  await check('host: hostile envelopes and calls never reject', async () => {
    const traces = [];
    const transport = createPlaywrightTransport({
      page: fakePage({ evaluate: () => Promise.reject(new Error('weird failure')) }),
      onTrace: line => traces.push(line),
      redactEnvelope: item => ({ method: item?.method }),
    });
    for (const [item, call] of [
      [undefined, undefined],
      [null, null],
      [{}, { timeoutMs: 'x', signal: 'not a signal' }],
      [{ method: 'execute' }, { signal: {} }],
      [{ method: 'observe', payload: { big: 'x'.repeat(10000) } }, undefined],
    ]) {
      const result = await transport.invoke(item, call);
      eq([result.kind, result.reason], ['lost', 'error'], `envelope ${show(item)}`);
    }
    eq(traces.length, 5, 'one trace line per call');
    const garbage = createPlaywrightTransport({ page: fakePage({ url: () => 42 }) });
    eq((await garbage.location(callOf())).ok, false, 'a non-string url is an error value');
  });

  await check(
    'host: abort listeners do not accumulate on a signal shared by many calls',
    async () => {
      const page = fakePage({
        evaluate: async () => ({ response: { ok: true } }),
        waitForFunction: async () => ({
          jsonValue: async () => ({ documentId: 'doc_x' }),
          dispose: async () => undefined,
        }),
      });
      const transport = createPlaywrightTransport({ page });
      const controller = new AbortController();
      const call = { timeoutMs: 2000, signal: controller.signal };
      const before = processWarnings.length;
      for (let index = 0; index < 25; index += 1) {
        for (const method of ['hello', 'observe', 'execute', 'cancel', 'release']) {
          await transport.invoke(envelope(method), call);
        }
        await transport.waitForDocument({ timeoutMs: 2000, signal: controller.signal });
      }
      eq(getEventListeners(controller.signal, 'abort').length, 0, 'abort listeners left behind');
      eq(processWarnings.slice(before), [], 'no MaxListenersExceededWarning');
    }
  );
}

// ---------------------------------------------------------------------------------------------
// section 3: import hygiene and source rules
// ---------------------------------------------------------------------------------------------

async function runModuleChecks() {
  section('modules');
  const files = ['browser.mjs', 'host.mjs', 'jev.mjs'];

  for (const file of files) {
    await check(
      `module: ${file} imports without output, global changes or lingering handles`,
      async () => {
        const url = pathToFileURL(path.join(HERE, file)).href;
        const script = `
        const before = new Set(Reflect.ownKeys(globalThis).map(String));
        await import(${JSON.stringify(url)});
        const added = Reflect.ownKeys(globalThis).map(String).filter(key => !before.has(key));
        if (added.length > 0) { process.stderr.write('globals added: ' + added.join(',')); process.exit(1); }
      `;
        const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
          encoding: 'utf8',
          timeout: 20000,
        });
        eq(
          [result.status, result.signal],
          [0, null],
          'exit status (a hang would be killed by the timeout)'
        );
        eq([result.stdout, result.stderr], ['', ''], 'no output');
      }
    );
  }

  await check(
    'module: finished calls leave no timer or handle behind (the process exits at once)',
    async () => {
      const script = `
      import { createPlaywrightTransport } from ${JSON.stringify(pathToFileURL(path.join(HERE, 'host.mjs')).href)};
      import { createRecordingHttp, createJevGate } from ${JSON.stringify(pathToFileURL(path.join(HERE, 'jev.mjs')).href)};
      const page = {
        isClosed: () => false,
        url: () => 'http://127.0.0.1:9/',
        evaluate: async () => ({ response: { ok: true } }),
        waitForFunction: async () => ({ jsonValue: async () => ({ documentId: 'doc_x' }), dispose: async () => undefined }),
      };
      const controller = new AbortController();
      const transport = createPlaywrightTransport({ page });
      for (const method of ['hello', 'observe', 'execute', 'cancel', 'release']) {
        await transport.invoke({ method, callId: 'req_1', payload: {} }, { timeoutMs: 600000, signal: controller.signal });
      }
      await transport.waitForDocument({ timeoutMs: 600000, signal: controller.signal });
      const http = createRecordingHttp({
        gate: createJevGate({ maxInFlight: 1 }),
        recorder: [],
        defaultTimeoutMs: 600000,
        send: async () => new Response('{"model":"jev-1"}', { status: 200 }),
      });
      await http('http://127.0.0.1:9/', { method: 'POST', headers: {}, credential: () => '', body: '{}', timeoutMs: 600000, signal: controller.signal });
      await http('http://127.0.0.1:9/', { method: 'POST', headers: {}, credential: () => '', body: '{}', timeoutMs: 600000 });
    `;
      const started = performance.now();
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
        encoding: 'utf8',
        timeout: 12000,
      });
      eq(
        [result.status, result.signal],
        [0, null],
        'exit status (a leaked 600 s timer would be killed)'
      );
      eq([result.stdout, result.stderr], ['', ''], 'no output');
      ok(performance.now() - started < 10000, 'exited promptly');
    }
  );

  const sources = Object.fromEntries(
    files.map(file => [file, fs.readFileSync(path.join(HERE, file), 'utf8')])
  );

  await check('module: no module imports from src/, dist/ or the repo package', async () => {
    for (const [file, text] of Object.entries(sources)) {
      const imports = [...text.matchAll(/(?:from|import\()\s*['"]([^'"]+)['"]/g)].map(
        match => match[1]
      );
      ok(
        imports.every(name => name.startsWith('node:') || name.startsWith('./')),
        `${file}: imports ${show(imports)}`
      );
      ok(!/\bsrc\/|\bdist\//.test(imports.join(' ')), `${file}: no src or dist import`);
    }
  });

  await check(
    'module: no console calls and no process.env key access in the harness modules',
    async () => {
      for (const [file, text] of Object.entries(sources)) {
        ok(!/\bconsole\./.test(text), `${file}: no console`);
        ok(!/TYPESAFE_API_KEY|JEV_API_KEY/.test(text), `${file}: never names the API key variable`);
      }
    }
  );

  await check(
    'module: credential() is called in exactly one place, the default fetch path',
    async () => {
      const code = sources['jev.mjs'].replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, '');
      const calls = [...code.matchAll(/\.credential\(\)/g)];
      eq(calls.length, 1, 'credential() call sites in jev.mjs');
      const start = code.indexOf('export async function defaultFetchSend');
      const end = code.indexOf('function sha256Hex');
      const index = calls[0].index;
      ok(index > start && index < end, 'the call is inside defaultFetchSend');
      ok(
        !/\.credential\b/.test(sources['host.mjs']) &&
          !/\.credential\b/.test(sources['browser.mjs']),
        'host and browser never touch it'
      );
    }
  );
}

// ---------------------------------------------------------------------------------------------

async function main() {
  pages = await startPageServer();
  try {
    await runJevChecks();
    await runBrowserChecks();
    if (browser !== undefined) {
      await runHostChecks();
    } else {
      console.log('SKIP host browser checks: no browser (already counted as a failure above)');
      total += 1;
      failed.push('host: browser checks skipped because Chromium did not start');
    }
    await runModuleChecks();
    await sleep(50);
    await check(
      'process: no Node warning was emitted by any module during the whole run',
      async () => {
        eq(processWarnings, [], 'warnings');
      }
    );
  } finally {
    await browser?.close().catch(() => undefined);
    await pages.close();
  }
  console.log(`\nChecks passed: ${passed}/${total}`);
  if (failed.length > 0) {
    console.log(`FAILED (${failed.length}):`);
    for (const name of failed) {
      console.log(`  - ${name}`);
    }
  }
  process.exitCode = failed.length === 0 ? 0 : 1;
}

main().catch(error => {
  console.log(`FATAL ${String(error?.message ?? error).split('\n')[0]}`);
  process.exitCode = 1;
});
