import fs from 'node:fs';
import path from 'node:path';
import { isScannableSecret } from './sensitive.mjs';

export const REDACTED = '[REDACTED]';

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const TEXT_EXTENSIONS = new Set(['.json', '.txt', '.html', '.md', '.log', '.csv', '.js', '.mjs']);
const SCREENSHOT_TIMEOUT_MS = 5000;
const MAX_JSON_DEPTH = 80;

function assertSegment(value, label) {
  if (typeof value !== 'string' || !SEGMENT.test(value) || value.includes('..')) {
    throw new TypeError(`${label} must be a single safe path segment`);
  }
}

/** JSON.stringify that survives circular references, bigint and Error instances. */
export function safeStringify(value, space = 2) {
  const stack = [];
  const text = JSON.stringify(
    value,
    function replacer(key, current) {
      if (typeof current === 'bigint') {
        return current.toString();
      }
      if (current instanceof Error) {
        return { name: current.name, message: current.message };
      }
      if (current !== null && typeof current === 'object') {
        while (stack.length > 0 && stack[stack.length - 1] !== this) {
          stack.pop();
        }
        if (stack.includes(current) || stack.length > MAX_JSON_DEPTH) {
          return '[Circular]';
        }
        stack.push(current);
      }
      return current;
    },
    space
  );
  return text === undefined ? 'null' : text;
}

/**
 * Accepts [string], [{ label, value }] or { label: value }. Anything that is not a scannable string
 * (too short, too numeric-and-short, not a string) lands in `skipped` by label, never by value.
 */
export function normalizeSecrets(values) {
  const entries = [];
  if (Array.isArray(values)) {
    values.forEach((item, index) => {
      if (typeof item === 'string') {
        entries.push({ label: `secret-${index + 1}`, value: item });
      } else if (item !== null && typeof item === 'object') {
        entries.push({ label: String(item.label ?? `secret-${index + 1}`), value: item.value });
      }
    });
  } else if (values !== null && typeof values === 'object') {
    for (const [label, value] of Object.entries(values)) {
      entries.push({ label, value });
    }
  }
  const usable = [];
  const skipped = [];
  for (const entry of entries) {
    if (entry.value === undefined || entry.value === null || entry.value === '') {
      continue;
    }
    if (isScannableSecret(entry.value)) {
      usable.push({ label: entry.label, value: entry.value });
    } else {
      skipped.push(entry.label);
    }
  }
  return { usable, skipped };
}

const htmlEscape = text =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

// Serializers escape only what their context needs: a text node keeps quotes, an attribute keeps < and >.
const htmlTextEscape = text =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const htmlAttributeEscape = text => text.replace(/&/g, '&amp;').replace(/"/g, '&quot;');

const lowerPercent = text => text.replace(/%[0-9A-F]{2}/g, match => match.toLowerCase());

/** Percent-encodings of `text`; a value that cannot be encoded (a lone surrogate) simply has none. */
function urlEncodings(text) {
  try {
    const component = encodeURIComponent(text);
    // WHATWG form encoding also escapes !'()~ and turns a space into +, which encodeURIComponent does not
    const form = new URLSearchParams({ v: text }).toString().slice(2);
    return [component, component.replace(/%20/g, '+'), form];
  } catch {
    return [];
  }
}

/**
 * Every way a value can show up in a file: exact, JSON-escaped (twice), URL-encoded (component and form,
 * upper and lower case), HTML-escaped (fully, as text, as an attribute), digit groups.
 */
export function secretVariants(raw) {
  const value = String(raw);
  const trimmed = value.trim();
  const found = new Map();
  const add = (text, kind) => {
    if (text.length >= 4 && !found.has(text)) {
      found.set(text, kind);
    }
  };
  add(value, 'exact');
  add(trimmed, 'exact');
  const jsonEscaped = JSON.stringify(trimmed).slice(1, -1);
  add(jsonEscaped, 'json');
  add(JSON.stringify(jsonEscaped).slice(1, -1), 'json');
  for (const encoded of urlEncodings(trimmed)) {
    add(encoded, 'url');
    add(lowerPercent(encoded), 'url');
  }
  add(htmlEscape(trimmed), 'html');
  add(htmlTextEscape(trimmed), 'html');
  add(htmlAttributeEscape(trimmed), 'html');
  if (/^[\d\s-]{8,}$/.test(trimmed)) {
    const digits = trimmed.replace(/\D/g, '');
    const groups = digits.match(/.{1,4}/g) ?? [];
    add(digits, 'digits');
    add(groups.join(' '), 'digits');
    add(groups.join('-'), 'digits');
  }
  return [...found].map(([text, kind]) => ({ text, kind }));
}

/** Replaces every variant of every secret, longest first. Non-strings pass through. */
export function redactSecrets(text, values) {
  if (typeof text !== 'string' || text.length === 0) {
    return text;
  }
  const { usable } = normalizeSecrets(values);
  const variants = usable.flatMap(secret => secretVariants(secret.value).map(item => item.text));
  variants.sort((a, b) => b.length - a.length);
  let out = text;
  for (const variant of new Set(variants)) {
    out = out.split(variant).join(REDACTED);
  }
  return out;
}

function walkFiles(dir) {
  const out = [];
  if (!fs.existsSync(dir)) {
    return out;
  }
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkFiles(full));
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Scans every file under `dir` (binary files included) for every variant of every value. A hit names the
 * file, the label of the value and the kind of variant, never the value itself. `scanned` is the number
 * of files looked at: a caller that gets 0 measured nothing.
 */
export function scanForSecrets(dir, values) {
  const { usable, skipped } = normalizeSecrets(values);
  const needles = usable.flatMap(secret =>
    secretVariants(secret.value).map(variant => ({
      label: secret.label,
      kind: variant.kind,
      bytes: Buffer.from(variant.text, 'utf8'),
    }))
  );
  const files = walkFiles(dir);
  const hits = [];
  const seen = new Set();
  for (const file of files) {
    const content = fs.readFileSync(file);
    for (const needle of needles) {
      if (content.includes(needle.bytes)) {
        const relative = path.relative(dir, file).split(path.sep).join('/');
        const key = `${relative}\u0000${needle.label}\u0000${needle.kind}`;
        if (!seen.has(key)) {
          seen.add(key);
          hits.push({ file: relative, label: needle.label, variant: needle.kind });
        }
      }
    }
  }
  return { hits, scanned: files.length, skipped, valuesChecked: usable.length };
}

/** Text files are rewritten with the secrets replaced; anything else that hit is deleted. */
function scrubHitFiles(dir, hits, values) {
  const scrubbed = [];
  const removed = [];
  for (const relative of new Set(hits.map(hit => hit.file))) {
    const full = path.join(dir, ...relative.split('/'));
    if (TEXT_EXTENSIONS.has(path.extname(full).toLowerCase())) {
      fs.writeFileSync(full, redactSecrets(fs.readFileSync(full, 'utf8'), values));
      scrubbed.push(relative);
    } else {
      fs.rmSync(full, { force: true });
      removed.push(relative);
    }
  }
  return { scrubbed, removed };
}

/**
 * Per-scenario evidence directory: <root>/<runId>/<scenarioId>/. It must be new or empty (a re-used run id
 * would mix stale failure files into a passing run). write() and screenshot() never escape it.
 * finalize(secrets) scans the whole directory; on a hit it rewrites the hit files without the secret (the
 * scan result still reports the hit, so the run fails) and never prints a value.
 */
export function createEvidenceWriter({ runId, scenarioId, root }) {
  assertSegment(runId, 'runId');
  assertSegment(scenarioId, 'scenarioId');
  if (typeof root !== 'string' || root.length === 0) {
    throw new TypeError('root must be a directory path');
  }
  const dir = path.join(path.resolve(root), runId, scenarioId);
  if (fs.existsSync(dir) && fs.readdirSync(dir).length > 0) {
    throw new Error(
      `evidence directory ${path.join(runId, scenarioId)} already holds files: evidence is never overwritten, pick a new run id`
    );
  }
  fs.mkdirSync(dir, { recursive: true });

  const resolveName = (name, extension) => {
    const segments = String(name).split('/');
    if (segments.length === 0 || !segments.every(segment => SEGMENT.test(segment))) {
      throw new TypeError('evidence name must be relative segments of [A-Za-z0-9._-]');
    }
    const last = segments.length - 1;
    if (extension && !segments[last].toLowerCase().endsWith(extension)) {
      segments[last] = `${segments[last]}${extension}`;
    }
    return { relative: segments.join('/'), full: path.join(dir, ...segments) };
  };

  const write = (name, data) => {
    const { full } = resolveName(name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    let content;
    if (typeof data === 'string' || data instanceof Uint8Array) {
      content = data;
    } else {
      content = `${safeStringify(data)}\n`;
    }
    fs.writeFileSync(full, content);
    return full;
  };

  const screenshot = async (page, name) => {
    let target;
    try {
      target = resolveName(`screenshots/${name}`, '.png');
      fs.mkdirSync(path.dirname(target.full), { recursive: true });
      await page.screenshot({ path: target.full, timeout: SCREENSHOT_TIMEOUT_MS });
      return { ok: true, path: target.full };
    } catch (error) {
      if (target !== undefined) {
        fs.rmSync(target.full, { force: true });
      }
      return {
        ok: false,
        reason: String(error?.message ?? error)
          .split('\n')[0]
          .slice(0, 160),
      };
    }
  };

  const exists = name => fs.existsSync(resolveName(name).full);

  const finalize = (secrets, options = {}) => {
    const scan = scanForSecrets(dir, secrets);
    const cleanup =
      scan.hits.length > 0 && options.scrub !== false
        ? scrubHitFiles(dir, scan.hits, secrets)
        : { scrubbed: [], removed: [] };
    return { ...scan, ...cleanup };
  };

  return { dir, write, screenshot, exists, finalize };
}
