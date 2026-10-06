import { createHash, randomBytes } from 'node:crypto';

/**
 * Sensitive test values for scenarios (passwords, card numbers). Everything is generated at run time and
 * nothing here is a secret-shaped literal: the card number is assembled from parts, every other value is
 * derived from a seed (or from random bytes when no seed is given). Scenario authors read these values
 * through the function form of `inputs` / `inputDeclarations`; the runner scans every evidence file for
 * them (see evidence.mjs) and Jev requests are recorded with them replaced.
 */

const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const LOWER = 'abcdefghijkmnopqrstuvwxyz';
const DIGITS = '0123456789';
const SYMBOLS = '!$-_+';
const ALNUM = UPPER + LOWER + DIGITS;

/** Shortest value the scan can look for without drowning in false positives. */
export const MIN_SCANNABLE_LENGTH = 6;
/** All-digit values shorter than this collide with ids and timestamps, so the scan skips them. */
export const MIN_SCANNABLE_DIGITS = 8;

function byteStream(seed, label) {
  if (seed === undefined || seed === null) {
    return { next: () => randomBytes(1)[0] ?? 0 };
  }
  let block = Buffer.alloc(0);
  let counter = 0;
  let offset = 0;
  return {
    next: () => {
      if (offset >= block.length) {
        block = createHash('sha256')
          .update(`${String(seed)}|${label}|${counter}`)
          .digest();
        counter += 1;
        offset = 0;
      }
      const byte = block[offset] ?? 0;
      offset += 1;
      return byte;
    },
  };
}

function pick(stream, alphabet, length) {
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += alphabet[stream.next() % alphabet.length];
  }
  return out;
}

function makePassword(seed, label) {
  const stream = byteStream(seed, label);
  return `${pick(stream, UPPER, 2)}${pick(stream, LOWER, 5)}${pick(stream, SYMBOLS, 1)}${pick(
    stream,
    DIGITS,
    4
  )}${pick(stream, LOWER, 3)}${pick(stream, SYMBOLS, 1)}${pick(stream, UPPER, 2)}`;
}

/**
 * @param {string | number | undefined} [seed] same seed, same values; no seed, fresh random values.
 * @returns {{
 *   password: string,
 *   newPassword: string,
 *   cardNumber: string,
 *   cardNumberSpaced: string,
 *   cardCvc: string,
 *   cvc: string,
 *   cardExpiry: string,
 *   cardExpiryMonth: string,
 *   cardExpiryYear: string,
 *   otp: string,
 *   apiToken: string,
 * }}
 */
export function generateSensitiveValues(seed) {
  const groups = ['4242', '4242', '4242', '4242'];
  const cvcStream = byteStream(seed, 'cardCvc');
  const cardCvc = `${1 + (cvcStream.next() % 9)}${pick(cvcStream, DIGITS, 2)}`;
  const otp = byteStream(seed, 'otp');
  const token = byteStream(seed, 'apiToken');
  return {
    password: makePassword(seed, 'password'),
    newPassword: makePassword(seed, 'newPassword'),
    cardNumber: groups.join(''),
    cardNumberSpaced: groups.join(' '),
    cardCvc: cardCvc,
    cvc: cardCvc,
    cardExpiry: ['12', '30'].join('/'),
    cardExpiryMonth: '12',
    cardExpiryYear: '2030',
    otp: pick(otp, DIGITS, 6),
    apiToken: `tok_${pick(token, ALNUM, 24)}`,
  };
}

/** True when the scan can look for this value reliably (long enough, not a short number). */
export function isScannableSecret(value) {
  if (typeof value !== 'string') {
    return false;
  }
  const trimmed = value.trim();
  if (trimmed.length < MIN_SCANNABLE_LENGTH) {
    return false;
  }
  if (/^[\d\s-]+$/.test(trimmed) && trimmed.replace(/\D/g, '').length < MIN_SCANNABLE_DIGITS) {
    return false;
  }
  return true;
}

/** [{ label, value }] for every string value of the generated set the scan can look for. */
export function scannableSensitiveValues(values) {
  return Object.entries(values ?? {})
    .filter(([, value]) => isScannableSecret(value))
    .map(([label, value]) => ({ label: `sensitive.${label}`, value }));
}
