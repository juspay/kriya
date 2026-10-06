/** @jest-environment node */
import { createHash, createHmac } from 'node:crypto';
import { derivedId, hashString, hmacSha256Hex, sha256Hex, stableStringify } from '@/utils/hash';
import type {
  TaskDerivedIdFn,
  TaskHashStringFn,
  TaskHmacSha256HexFn,
  TaskSha256HexFn,
  TaskStableStringifyFn,
} from '@/types';

// Compile-time conformance: every export is assignable to its seam type of agent.ts.
export const seamConformance: {
  readonly hashString: TaskHashStringFn;
  readonly sha256Hex: TaskSha256HexFn;
  readonly hmacSha256Hex: TaskHmacSha256HexFn;
  readonly derivedId: TaskDerivedIdFn;
  readonly stableStringify: TaskStableStringifyFn;
} = { hashString, sha256Hex, hmacSha256Hex, derivedId, stableStringify };

const referenceSha256 = (input: string): string =>
  createHash('sha256').update(input, 'utf8').digest('hex');

const referenceHmac = (key: string, input: string): string =>
  createHmac('sha256', Buffer.from(key, 'utf8')).update(input, 'utf8').digest('hex');

const referenceFnv = (input: string): string => {
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < input.length; index += 1) {
    hash = BigInt.asUintN(64, (hash ^ BigInt(input.charCodeAt(index))) * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, '0');
};

const seededRandom = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const NASTY_UNITS: readonly string[] = [
  'a',
  'Z',
  '0',
  ' ',
  '\n',
  '\u0000',
  '\u007f',
  '\u0080',
  '\u{e9}',
  '\u{20ac}',
  '\u{4e2d}',
  '\u{feff}',
  '\u{200b}',
  String.fromCodePoint(0x1f600),
  String.fromCodePoint(0x10ffff),
  String.fromCharCode(0xd800),
  String.fromCharCode(0xdbff),
  String.fromCharCode(0xdc00),
  String.fromCharCode(0xdfff),
];

const randomString = (random: () => number, length: number): string => {
  let out = '';
  for (let index = 0; index < length; index += 1) {
    out += NASTY_UNITS[Math.floor(random() * NASTY_UNITS.length)] ?? 'a';
  }
  return out;
};

describe('hashString (FNV-1a 64 over UTF-16 code units)', () => {
  it('returns 16 lowercase hex characters, zero padded', () => {
    for (const input of ['', 'a', 'hello world', '\u{1F600}', 'x'.repeat(5000)]) {
      expect(hashString(input)).toMatch(/^[0-9a-f]{16}$/);
    }
  });

  it('matches the published FNV-1a 64 test vectors', () => {
    expect(hashString('')).toBe('cbf29ce484222325');
    expect(hashString('a')).toBe('af63dc4c8601ec8c');
    expect(hashString('foobar')).toBe('85944171f73967e8');
  });

  it('hashes UTF-16 code units, not code points or bytes', () => {
    expect(hashString('\u{1F600}')).toBe('e5e45a0a241b88d8');
    expect(hashString('\u{1F600}')).toBe(referenceFnv('\u{1F600}'));
    expect(hashString(String.fromCharCode(0xd800))).toBe(referenceFnv(String.fromCharCode(0xd800)));
  });

  it('agrees with a reference implementation on random nasty strings', () => {
    const random = seededRandom(7);
    for (let index = 0; index < 300; index += 1) {
      const input = randomString(random, Math.floor(random() * 60));
      expect(hashString(input)).toBe(referenceFnv(input));
    }
  });

  it('is deterministic and order sensitive', () => {
    expect(hashString('abc')).toBe(hashString('abc'));
    expect(hashString('ab')).not.toBe(hashString('ba'));
    expect(hashString('a')).not.toBe(hashString('a '));
    expect(hashString('')).not.toBe(hashString('\u0000'));
  });

  it('has no collision on a 10k sample of distinct inputs', () => {
    const seen = new Set<string>();
    for (let index = 0; index < 10000; index += 1) {
      seen.add(hashString(`observation-${index}|${index * 7919}`));
    }
    expect(seen.size).toBe(10000);
  });

  it('is total on a non-string input', () => {
    expect(hashString(undefined as unknown as string)).toMatch(/^[0-9a-f]{16}$/);
    expect(hashString(null as unknown as string)).toMatch(/^[0-9a-f]{16}$/);
  });

  it('hashes a long text in linear time', () => {
    const started = Date.now();
    hashString('x'.repeat(100_000));
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

describe('sha256Hex', () => {
  it('matches the NIST known-answer vectors', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    );
    expect(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1'
    );
    expect(
      sha256Hex(
        'abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu'
      )
    ).toBe('cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1');
  });

  it('matches the one million "a" vector', () => {
    expect(sha256Hex('a'.repeat(1_000_000))).toBe(
      'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0'
    );
  });

  it('matches known answers for a 1000 character string and astral and BMP characters', () => {
    expect(sha256Hex('a'.repeat(1000))).toBe(
      '41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3'
    );
    const sequence = Array.from({ length: 1000 }, (_, index) =>
      String.fromCharCode(97 + (index % 26))
    ).join('');
    expect(sha256Hex(sequence)).toBe(
      '915e53a44c18b19bb06ba5b3f5fcaf1dc4651e8404c63425cfc6174e74659d87'
    );
    expect(sha256Hex('\u{1F600}')).toBe(
      'f0443a342c5ef54783a111b51ba56c938e474c32324d90c3a60c9c8e3a37e2d9'
    );
    expect(sha256Hex('\u{20ac}')).toBe(
      'c4cc90ed3d26f12d4b08a75140970a7904035c31cbb4515a83f19b9003c00d1d'
    );
  });

  it('agrees with node:crypto for every length from 0 to 300 (all padding boundaries)', () => {
    for (let length = 0; length <= 300; length += 1) {
      const input = String.fromCharCode(...Array.from({ length }, (_, i) => 33 + ((i * 7) % 90)));
      expect(sha256Hex(input)).toBe(referenceSha256(input));
    }
  });

  it('agrees with node:crypto at the 55, 56, 63, 64 and 65 byte boundaries of ASCII input', () => {
    for (const length of [54, 55, 56, 57, 62, 63, 64, 65, 119, 120, 121, 127, 128, 129]) {
      const input = 'k'.repeat(length);
      expect(sha256Hex(input)).toBe(referenceSha256(input));
    }
  });

  it('agrees with node:crypto at the same byte boundaries for multi-byte input', () => {
    for (const unit of ['\u{e9}', '\u{20ac}', '\u{1F600}']) {
      for (let count = 10; count <= 45; count += 1) {
        const input = unit.repeat(count);
        expect(sha256Hex(input)).toBe(referenceSha256(input));
      }
    }
  });

  it('encodes unpaired surrogates as U+FFFD, exactly like a UTF-8 encoder', () => {
    const high = String.fromCharCode(0xd800);
    const low = String.fromCharCode(0xdc00);
    const cases = [
      high,
      low,
      `${high}${high}`,
      `${low}${high}`,
      `a${high}b`,
      `a${low}b`,
      `${high}x${low}`,
      `${high}${low}`,
      `${high}${low}${high}`,
      `${String.fromCharCode(0xdbff)}${String.fromCharCode(0xdfff)}`,
    ];
    for (const input of cases) {
      expect(sha256Hex(input)).toBe(referenceSha256(input));
    }
    expect(sha256Hex(high)).toBe(sha256Hex('\u{fffd}'));
    expect(sha256Hex(`${high}${low}`)).toBe(sha256Hex('\u{10000}'));
  });

  it('agrees with node:crypto on random nasty strings and on long input', () => {
    const random = seededRandom(42);
    for (let index = 0; index < 200; index += 1) {
      const input = randomString(random, Math.floor(random() * 120));
      expect(sha256Hex(input)).toBe(referenceSha256(input));
    }
    const long = randomString(random, 150_000);
    expect(sha256Hex(long)).toBe(referenceSha256(long));
  });

  it('produces 64 lowercase hex characters and is deterministic', () => {
    expect(sha256Hex('x')).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256Hex('x')).toBe(sha256Hex('x'));
    expect(sha256Hex('x')).not.toBe(sha256Hex('y'));
  });

  it('does not depend on TextEncoder, Buffer or crypto being present', () => {
    const astralAndEuro = '\u{1F600}\u{20ac}';
    const expectedAstralAndEuro = referenceSha256(astralAndEuro);
    const expectedHmac = referenceHmac('Jefe', 'what do ya want for nothing?');
    const descriptors = ['TextEncoder', 'Buffer', 'crypto'].map(name => ({
      name,
      descriptor: Object.getOwnPropertyDescriptor(globalThis, name),
    }));
    let actualSha = '';
    let actualAbc = '';
    let actualHmac = '';
    try {
      for (const { name } of descriptors) {
        Object.defineProperty(globalThis, name, {
          value: undefined,
          configurable: true,
          writable: true,
        });
      }
      actualAbc = sha256Hex('abc');
      actualSha = sha256Hex(astralAndEuro);
      actualHmac = hmacSha256Hex('Jefe', 'what do ya want for nothing?');
    } finally {
      for (const { name, descriptor } of descriptors) {
        if (descriptor) {
          Object.defineProperty(globalThis, name, descriptor);
        } else {
          Reflect.deleteProperty(globalThis, name);
        }
      }
    }
    expect(actualAbc).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(actualSha).toBe(expectedAstralAndEuro);
    expect(actualHmac).toBe(expectedHmac);
  });

  it('is total on a non-string input', () => {
    expect(sha256Hex(undefined as unknown as string)).toBe(sha256Hex(''));
    expect(sha256Hex(null as unknown as string)).toBe(sha256Hex(''));
  });
});

describe('hmacSha256Hex', () => {
  it('matches RFC 4231 test case 1', () => {
    expect(hmacSha256Hex('\x0b'.repeat(20), 'Hi There')).toBe(
      'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7'
    );
  });

  it('matches RFC 4231 test case 2', () => {
    expect(hmacSha256Hex('Jefe', 'what do ya want for nothing?')).toBe(
      '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843'
    );
  });

  it('matches the empty key and empty message', () => {
    expect(hmacSha256Hex('', '')).toBe(
      'b613679a0814d9ec772f95d778c35fc5ff1697c493715653c6c712144292c5ad'
    );
  });

  it('agrees with node:crypto around the 64 byte block boundary of the key', () => {
    for (const keyLength of [1, 31, 32, 33, 63, 64, 65, 66, 100, 127, 128, 129, 1000]) {
      const key = 'k'.repeat(keyLength);
      expect(hmacSha256Hex(key, 'message')).toBe(referenceHmac(key, 'message'));
    }
  });

  it('hashes a key longer than the block size before use (keys of 65 bytes and 64 bytes differ)', () => {
    const long = 'k'.repeat(65);
    const exact = 'k'.repeat(64);
    expect(hmacSha256Hex(long, 'm')).not.toBe(hmacSha256Hex(exact, 'm'));
    expect(hmacSha256Hex(long, 'm')).toBe(referenceHmac(long, 'm'));
    expect(hmacSha256Hex(exact, 'm')).toBe(referenceHmac(exact, 'm'));
  });

  it('measures the key block in UTF-8 bytes, not characters', () => {
    const key = '\u{20ac}'.repeat(30);
    expect(Buffer.byteLength(key, 'utf8')).toBe(90);
    expect(hmacSha256Hex(key, 'data')).toBe(referenceHmac(key, 'data'));
    const astral = '\u{1F600}'.repeat(17);
    expect(Buffer.byteLength(astral, 'utf8')).toBe(68);
    expect(hmacSha256Hex(astral, 'data')).toBe(referenceHmac(astral, 'data'));
  });

  it('agrees with node:crypto on random keys and messages, including long messages', () => {
    const random = seededRandom(99);
    for (let index = 0; index < 150; index += 1) {
      const key = randomString(random, Math.floor(random() * 90));
      const message = randomString(random, Math.floor(random() * 200));
      expect(hmacSha256Hex(key, message)).toBe(referenceHmac(key, message));
    }
    const longMessage = randomString(random, 80_000);
    expect(hmacSha256Hex('key', longMessage)).toBe(referenceHmac('key', longMessage));
  });

  it('depends on both the key and the message', () => {
    expect(hmacSha256Hex('a', 'm')).not.toBe(hmacSha256Hex('b', 'm'));
    expect(hmacSha256Hex('a', 'm')).not.toBe(hmacSha256Hex('a', 'n'));
    expect(hmacSha256Hex('a', 'm')).toBe(hmacSha256Hex('a', 'm'));
  });

  it('is total on non-string inputs', () => {
    expect(hmacSha256Hex(undefined as unknown as string, undefined as unknown as string)).toBe(
      hmacSha256Hex('', '')
    );
  });
});

describe('derivedId', () => {
  it('is prefix underscore the first 12 hex of sha256 of the seed', () => {
    expect(derivedId('req', 'seed')).toBe(`req_${sha256Hex('seed').slice(0, 12)}`);
    expect(derivedId('req', 'seed')).toBe(`req_${referenceSha256('seed').slice(0, 12)}`);
    expect(derivedId('req', '')).toBe('req_e3b0c44298fc');
  });

  it('is deterministic, seed dependent and prefix dependent', () => {
    expect(derivedId('req', 'apr_1|exec')).toBe(derivedId('req', 'apr_1|exec'));
    expect(derivedId('req', 'apr_1|exec')).not.toBe(derivedId('req', 'apr_2|exec'));
    expect(derivedId('req', 'x')).not.toBe(derivedId('run', 'x'));
    expect(derivedId('req', 'x').slice(4)).toBe(derivedId('run', 'x').slice(4));
  });

  it('has the <prefix>_<12 hex> shape for every id prefix, never <word>-<hex>', () => {
    for (const prefix of ['run', 'ses', 'snap', 'doc', 'req', 'apr', 'ck', 'non'] as const) {
      const id = derivedId(prefix, 'seed');
      expect(id).toMatch(new RegExp(`^${prefix}_[0-9a-f]{12}$`));
      expect(id).not.toContain('-');
    }
  });
});

describe('stableStringify', () => {
  it('sorts object keys at every depth', () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: [{ z: 1, y: 2 }] } })).toBe(
      '{"a":{"c":[{"y":2,"z":1}],"d":2},"b":1}'
    );
  });

  it('is independent of key insertion order', () => {
    expect(stableStringify({ a: 1, b: 2, c: 3 })).toBe(stableStringify({ c: 3, a: 1, b: 2 }));
  });

  it('sorts by UTF-16 code unit, not by locale', () => {
    expect(stableStringify({ b: 1, B: 2, a: 3, '\u{e9}': 4, z: 5 })).toBe(
      '{"B":2,"a":3,"b":1,"z":5,"\u{e9}":4}'
    );
  });

  it('keeps array order', () => {
    expect(stableStringify([3, 1, 2, 'b', 'a'])).toBe('[3,1,2,"b","a"]');
  });

  it('drops undefined properties but keeps null', () => {
    expect(stableStringify({ a: undefined, b: null, c: 1 })).toBe('{"b":null,"c":1}');
    expect(stableStringify({ a: undefined })).toBe('{}');
  });

  it('prints undefined, functions and symbols inside arrays as null, like JSON', () => {
    expect(stableStringify([undefined, () => 1, Symbol('s'), 1])).toBe('[null,null,null,1]');
  });

  it('drops function and symbol properties', () => {
    expect(stableStringify({ f: () => 1, s: Symbol('x'), k: 1 })).toBe('{"k":1}');
  });

  it('always returns a string, also for top-level undefined, functions and symbols', () => {
    expect(stableStringify(undefined)).toBe('null');
    expect(stableStringify(() => 1)).toBe('null');
    expect(stableStringify(Symbol('x'))).toBe('null');
    expect(stableStringify(null)).toBe('null');
    expect(stableStringify('s')).toBe('"s"');
    expect(stableStringify(12)).toBe('12');
    expect(stableStringify(true)).toBe('true');
  });

  it('matches JSON.stringify of the key-sorted value for ordinary JSON', () => {
    const sorted = (value: unknown): unknown => {
      if (Array.isArray(value)) {
        return value.map(sorted);
      }
      if (value !== null && typeof value === 'object') {
        return Object.fromEntries(
          Object.keys(value)
            .sort()
            .map(key => [key, sorted((value as Record<string, unknown>)[key])])
        );
      }
      return value;
    };
    const random = seededRandom(5);
    const build = (depth: number): unknown => {
      const roll = random();
      if (depth > 3 || roll < 0.3) {
        return [1, -2.5, 'a"b\n', true, null, '\u{1F600}', 1e21, 0][Math.floor(random() * 8)];
      }
      if (roll < 0.6) {
        return Array.from({ length: Math.floor(random() * 4) }, () => build(depth + 1));
      }
      const out: Record<string, unknown> = {};
      for (let index = 0; index < Math.floor(random() * 5); index += 1) {
        out[`k${Math.floor(random() * 9)}`] = build(depth + 1);
      }
      return out;
    };
    for (let index = 0; index < 100; index += 1) {
      const value = build(0);
      expect(stableStringify(value)).toBe(JSON.stringify(sorted(value)));
    }
  });

  it('escapes strings like JSON, including unpaired surrogates', () => {
    expect(stableStringify('a"b\\c\n')).toBe(JSON.stringify('a"b\\c\n'));
    expect(stableStringify(String.fromCharCode(0xd800))).toBe(
      JSON.stringify(String.fromCharCode(0xd800))
    );
  });

  it('prints a self reference as "[Circular]"', () => {
    const node: Record<string, unknown> = { name: 'n' };
    node.self = node;
    expect(stableStringify(node)).toBe('{"name":"n","self":"[Circular]"}');
  });

  it('prints a mutual cycle and an array cycle as "[Circular]"', () => {
    const a: Record<string, unknown> = { id: 'a' };
    const b: Record<string, unknown> = { id: 'b', a };
    a.b = b;
    expect(stableStringify(a)).toBe('{"b":{"a":"[Circular]","id":"b"},"id":"a"}');
    const list: unknown[] = [1];
    list.push(list);
    expect(stableStringify(list)).toBe('[1,"[Circular]"]');
  });

  it('prints a shared, non cyclic reference in full each time', () => {
    const shared = { v: 1 };
    expect(stableStringify({ a: shared, b: shared, c: [shared, shared] })).toBe(
      '{"a":{"v":1},"b":{"v":1},"c":[{"v":1},{"v":1}]}'
    );
  });

  it('never throws on bigint, throwing getters, throwing toJSON, huge depth and odd numbers', () => {
    const throwing = {
      get boom(): string {
        throw new Error('getter');
      },
      ok: 1,
    };
    expect(() => stableStringify(throwing)).not.toThrow();
    expect(stableStringify(throwing)).toContain('"ok":1');
    const badJson = {
      toJSON(): string {
        throw new Error('toJSON');
      },
    };
    expect(() => stableStringify({ x: badJson })).not.toThrow();
    expect(typeof stableStringify(10n)).toBe('string');
    expect(stableStringify({ n: [NaN, Infinity, -Infinity, -0] })).toBe('{"n":[null,null,null,0]}');
    let deep: unknown = 'leaf';
    for (let index = 0; index < 20000; index += 1) {
      deep = [deep];
    }
    expect(() => stableStringify(deep)).not.toThrow();
    expect(typeof stableStringify(deep)).toBe('string');
  });

  it('honors toJSON like JSON.stringify (a Date prints as its ISO string)', () => {
    const date = new Date(Date.UTC(2020, 0, 2, 3, 4, 5));
    expect(stableStringify({ at: date })).toBe(`{"at":"${date.toISOString()}"}`);
  });

  it('keeps an own __proto__ key as data and does not touch prototypes', () => {
    const parsed: unknown = JSON.parse('{"__proto__":{"polluted":1},"a":1}');
    expect(stableStringify(parsed)).toBe('{"__proto__":{"polluted":1},"a":1}');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('does not mutate its input', () => {
    const input = Object.freeze({ b: Object.freeze([2, 1]), a: Object.freeze({ y: 1, x: 2 }) });
    expect(stableStringify(input)).toBe('{"a":{"x":2,"y":1},"b":[2,1]}');
    expect(Object.keys(input)).toEqual(['b', 'a']);
  });
});
