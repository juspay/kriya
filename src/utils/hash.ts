import type {
  TaskDerivedIdFn,
  TaskHashStringFn,
  TaskHmacSha256HexFn,
  TaskSha256HexFn,
  TaskStableStringifyFn,
} from '@/types';

const FNV_OFFSET_BASIS = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;

/** FNV-1a 64 over UTF-16 code units. Change detection only, never a security decision. */
export const hashString: TaskHashStringFn = input => {
  const text = typeof input === 'string' ? input : '';
  let hash = FNV_OFFSET_BASIS;
  for (let index = 0; index < text.length; index += 1) {
    hash = BigInt.asUintN(64, (hash ^ BigInt(text.charCodeAt(index))) * FNV_PRIME);
  }
  return hash.toString(16).padStart(16, '0');
};

const SHA256_BLOCK_BYTES = 64;

const SHA256_ROUND_CONSTANTS = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const SHA256_INITIAL_STATE: readonly number[] = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
];

const rotateRight = (value: number, bits: number): number =>
  (value >>> bits) | (value << (32 - bits));

/** UTF-8 by hand: no TextEncoder, no Buffer. An unpaired surrogate becomes U+FFFD, like a real encoder. */
const encodeUtf8 = (text: string): Uint8Array => {
  const bytes = new Uint8Array(text.length * 3);
  let length = 0;
  for (let index = 0; index < text.length; index += 1) {
    let code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = index + 1 < text.length ? text.charCodeAt(index + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
        index += 1;
      } else {
        code = 0xfffd;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      code = 0xfffd;
    }
    if (code < 0x80) {
      bytes[length] = code;
      length += 1;
    } else if (code < 0x800) {
      bytes[length] = 0xc0 | (code >> 6);
      bytes[length + 1] = 0x80 | (code & 0x3f);
      length += 2;
    } else if (code < 0x10000) {
      bytes[length] = 0xe0 | (code >> 12);
      bytes[length + 1] = 0x80 | ((code >> 6) & 0x3f);
      bytes[length + 2] = 0x80 | (code & 0x3f);
      length += 3;
    } else {
      bytes[length] = 0xf0 | (code >> 18);
      bytes[length + 1] = 0x80 | ((code >> 12) & 0x3f);
      bytes[length + 2] = 0x80 | ((code >> 6) & 0x3f);
      bytes[length + 3] = 0x80 | (code & 0x3f);
      length += 4;
    }
  }
  return bytes.subarray(0, length);
};

const compressBlock = (
  state: Uint32Array,
  view: DataView,
  offset: number,
  schedule: Uint32Array
): void => {
  for (let index = 0; index < 16; index += 1) {
    schedule[index] = view.getUint32(offset + index * 4, false);
  }
  for (let index = 16; index < 64; index += 1) {
    const w15 = schedule[index - 15] ?? 0;
    const w2 = schedule[index - 2] ?? 0;
    const small0 = rotateRight(w15, 7) ^ rotateRight(w15, 18) ^ (w15 >>> 3);
    const small1 = rotateRight(w2, 17) ^ rotateRight(w2, 19) ^ (w2 >>> 10);
    schedule[index] =
      ((schedule[index - 16] ?? 0) + small0 + (schedule[index - 7] ?? 0) + small1) >>> 0;
  }
  let a = state[0] ?? 0;
  let b = state[1] ?? 0;
  let c = state[2] ?? 0;
  let d = state[3] ?? 0;
  let e = state[4] ?? 0;
  let f = state[5] ?? 0;
  let g = state[6] ?? 0;
  let h = state[7] ?? 0;
  for (let index = 0; index < 64; index += 1) {
    const big1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
    const choose = (e & f) ^ (~e & g);
    const temp1 =
      (h + big1 + choose + (SHA256_ROUND_CONSTANTS[index] ?? 0) + (schedule[index] ?? 0)) >>> 0;
    const big0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
    const majority = (a & b) ^ (a & c) ^ (b & c);
    const temp2 = (big0 + majority) >>> 0;
    h = g;
    g = f;
    f = e;
    e = (d + temp1) >>> 0;
    d = c;
    c = b;
    b = a;
    a = (temp1 + temp2) >>> 0;
  }
  state[0] = ((state[0] ?? 0) + a) >>> 0;
  state[1] = ((state[1] ?? 0) + b) >>> 0;
  state[2] = ((state[2] ?? 0) + c) >>> 0;
  state[3] = ((state[3] ?? 0) + d) >>> 0;
  state[4] = ((state[4] ?? 0) + e) >>> 0;
  state[5] = ((state[5] ?? 0) + f) >>> 0;
  state[6] = ((state[6] ?? 0) + g) >>> 0;
  state[7] = ((state[7] ?? 0) + h) >>> 0;
};

const sha256Bytes = (message: Uint8Array): Uint8Array => {
  const state = Uint32Array.from(SHA256_INITIAL_STATE);
  const schedule = new Uint32Array(64);
  const view = new DataView(message.buffer, message.byteOffset, message.byteLength);
  const fullBlocks = Math.floor(message.length / SHA256_BLOCK_BYTES);
  for (let block = 0; block < fullBlocks; block += 1) {
    compressBlock(state, view, block * SHA256_BLOCK_BYTES, schedule);
  }
  const consumed = fullBlocks * SHA256_BLOCK_BYTES;
  const remaining = message.length - consumed;
  const tailLength = remaining < 56 ? SHA256_BLOCK_BYTES : SHA256_BLOCK_BYTES * 2;
  const tail = new Uint8Array(tailLength);
  tail.set(message.subarray(consumed));
  tail[remaining] = 0x80;
  const tailView = new DataView(tail.buffer);
  const bitLength = message.length * 8;
  tailView.setUint32(tailLength - 8, Math.floor(bitLength / 0x100000000), false);
  tailView.setUint32(tailLength - 4, bitLength >>> 0, false);
  for (let offset = 0; offset < tailLength; offset += SHA256_BLOCK_BYTES) {
    compressBlock(state, tailView, offset, schedule);
  }
  const digest = new Uint8Array(32);
  const digestView = new DataView(digest.buffer);
  for (let index = 0; index < 8; index += 1) {
    digestView.setUint32(index * 4, state[index] ?? 0, false);
  }
  return digest;
};

const toHex = (bytes: Uint8Array): string => {
  let hex = '';
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index] ?? 0;
    hex += (byte >>> 4).toString(16) + (byte & 15).toString(16);
  }
  return hex;
};

const asText = (value: unknown): string => (typeof value === 'string' ? value : '');

/** SHA-256 over the UTF-8 bytes, in plain TypeScript so the synchronous seams run in Node and browsers alike. */
export const sha256Hex: TaskSha256HexFn = input => toHex(sha256Bytes(encodeUtf8(asText(input))));

/** HMAC-SHA-256 (RFC 2104): a key longer than the block is hashed first, a shorter one zero padded. */
export const hmacSha256Hex: TaskHmacSha256HexFn = (key, input) => {
  const rawKey = encodeUtf8(asText(key));
  const blockKey = new Uint8Array(SHA256_BLOCK_BYTES);
  blockKey.set(rawKey.length > SHA256_BLOCK_BYTES ? sha256Bytes(rawKey) : rawKey);
  const message = encodeUtf8(asText(input));
  const inner = new Uint8Array(SHA256_BLOCK_BYTES + message.length);
  const outer = new Uint8Array(SHA256_BLOCK_BYTES + 32);
  for (let index = 0; index < SHA256_BLOCK_BYTES; index += 1) {
    const keyByte = blockKey[index] ?? 0;
    inner[index] = keyByte ^ 0x36;
    outer[index] = keyByte ^ 0x5c;
  }
  inner.set(message, SHA256_BLOCK_BYTES);
  outer.set(sha256Bytes(inner), SHA256_BLOCK_BYTES);
  return toHex(sha256Bytes(outer));
};

export const derivedId: TaskDerivedIdFn = (prefix, seed) =>
  `${prefix}_${sha256Hex(seed).slice(0, 12)}`;

const CIRCULAR = '"[Circular]"';
const UNSERIALIZABLE = '"[Unserializable]"';
const TOO_DEEP = '"[MaxDepth]"';
const MAX_DEPTH = 500;

type Serialized = string | undefined;

const unbox = (value: object): unknown => {
  if (value instanceof Number || value instanceof String || value instanceof Boolean) {
    return value.valueOf();
  }
  return value;
};

const serializeArray = (list: readonly unknown[], ancestors: unknown[], depth: number): string => {
  const items: string[] = [];
  for (let index = 0; index < list.length; index += 1) {
    items.push(serialize(list[index], ancestors, depth + 1, false) ?? 'null');
  }
  return `[${items.join(',')}]`;
};

const serializeRecord = (
  record: Readonly<Record<string, unknown>>,
  ancestors: unknown[],
  depth: number
): string => {
  const parts: string[] = [];
  for (const key of Object.keys(record).sort()) {
    let child: unknown;
    try {
      child = record[key];
    } catch {
      continue;
    }
    const text = serialize(child, ancestors, depth + 1, false);
    if (text !== undefined) {
      parts.push(`${JSON.stringify(key)}:${text}`);
    }
  }
  return `{${parts.join(',')}}`;
};

const serializeObject = (
  value: object,
  ancestors: unknown[],
  depth: number,
  toJsonApplied: boolean
): Serialized => {
  if (depth > MAX_DEPTH) {
    return TOO_DEEP;
  }
  if (ancestors.includes(value)) {
    return CIRCULAR;
  }
  if (!toJsonApplied) {
    const candidate = (value as { readonly toJSON?: unknown }).toJSON;
    if (typeof candidate === 'function') {
      const replaced: unknown = candidate.call(value);
      return serialize(replaced, ancestors, depth, true);
    }
  }
  const unboxed = unbox(value);
  if (unboxed !== value) {
    return serialize(unboxed, ancestors, depth, true);
  }
  ancestors.push(value);
  try {
    return Array.isArray(value)
      ? serializeArray(value, ancestors, depth)
      : serializeRecord(value as Readonly<Record<string, unknown>>, ancestors, depth);
  } finally {
    ancestors.pop();
  }
};

const serialize = (
  value: unknown,
  ancestors: unknown[],
  depth: number,
  toJsonApplied: boolean
): Serialized => {
  if (value === null) {
    return 'null';
  }
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'number':
      return Number.isFinite(value) ? JSON.stringify(value) : 'null';
    case 'boolean':
      return value ? 'true' : 'false';
    case 'bigint':
      return JSON.stringify(value.toString());
    case 'object':
      try {
        return serializeObject(value, ancestors, depth, toJsonApplied);
      } catch {
        return UNSERIALIZABLE;
      }
    default:
      return undefined;
  }
};

/** Canonical JSON for digests and signatures: sorted keys, JSON semantics, cycles and depth bounded. */
export const stableStringify: TaskStableStringifyFn = value => {
  try {
    return serialize(value, [], 0, false) ?? 'null';
  } catch {
    return UNSERIALIZABLE;
  }
};
