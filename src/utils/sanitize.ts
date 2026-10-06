import { TASK_LIMITS } from '@/types';
import type { TaskSanitizeUntrustedTextFn } from '@/types';

const REPLACEMENT_CHARACTER = 0xfffd;

type CharacterClass = 'keep' | 'space' | 'drop';

const isSpace = (codePoint: number): boolean =>
  codePoint === 0x20 ||
  (codePoint >= 0x09 && codePoint <= 0x0d) ||
  codePoint === 0x85 ||
  codePoint === 0xa0 ||
  codePoint === 0x1680 ||
  (codePoint >= 0x2000 && codePoint <= 0x200a) ||
  codePoint === 0x2028 ||
  codePoint === 0x2029 ||
  codePoint === 0x202f ||
  codePoint === 0x205f ||
  codePoint === 0x2800 ||
  codePoint === 0x3000;

// C0 and C1 controls, bidi controls, zero-width and other invisible characters (including the tag block and
// the variation selectors that can smuggle hidden text, and the blank fillers some scripts reserve).
// Stripped without a space, so `pass<ZWSP>word` and `[t<ZWSP>1]` rejoin.
const isDropped = (codePoint: number): boolean =>
  codePoint < 0x20 ||
  (codePoint >= 0x7f && codePoint <= 0x9f) ||
  codePoint === 0xad ||
  codePoint === 0x034f ||
  codePoint === 0x061c ||
  codePoint === 0x115f ||
  codePoint === 0x1160 ||
  codePoint === 0x17b4 ||
  codePoint === 0x17b5 ||
  (codePoint >= 0x180b && codePoint <= 0x180e) ||
  (codePoint >= 0x200b && codePoint <= 0x200f) ||
  (codePoint >= 0x202a && codePoint <= 0x202e) ||
  (codePoint >= 0x2060 && codePoint <= 0x206f) ||
  codePoint === 0x3164 ||
  (codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
  codePoint === 0xfeff ||
  codePoint === 0xffa0 ||
  (codePoint >= 0xfff9 && codePoint <= 0xfffb) ||
  codePoint === 0xfffe ||
  codePoint === 0xffff ||
  (codePoint >= 0xe0000 && codePoint <= 0xe0fff);

const classify = (codePoint: number): CharacterClass => {
  if (isSpace(codePoint)) {
    return 'space';
  }
  return isDropped(codePoint) ? 'drop' : 'keep';
};

const isHighSurrogate = (unit: number): boolean => unit >= 0xd800 && unit <= 0xdbff;
const isLowSurrogate = (unit: number): boolean => unit >= 0xdc00 && unit <= 0xdfff;

const LOOKALIKE_ID = /\[([tc][0-9]+)\]/g;

const resolveLimit = (maxChars: number | undefined): number => {
  if (typeof maxChars !== 'number' || Number.isNaN(maxChars)) {
    return TASK_LIMITS.labelChars;
  }
  if (maxChars === Number.POSITIVE_INFINITY) {
    return maxChars;
  }
  return Math.max(0, Math.floor(maxChars));
};

const cutToCodePoints = (text: string, limit: number): string => {
  if (limit === Number.POSITIVE_INFINITY || text.length <= limit) {
    return text;
  }
  let index = 0;
  let count = 0;
  while (index < text.length && count < limit) {
    const pair =
      isHighSurrogate(text.charCodeAt(index)) &&
      index + 1 < text.length &&
      isLowSurrogate(text.charCodeAt(index + 1));
    index += pair ? 2 : 1;
    count += 1;
  }
  return text.slice(0, index);
};

const stripAndCollapse = (text: string): string => {
  let output = '';
  let pendingSpace = false;
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    let codePoint = unit;
    let character = text.charAt(index);
    if (isHighSurrogate(unit)) {
      const next = index + 1 < text.length ? text.charCodeAt(index + 1) : 0;
      if (isLowSurrogate(next)) {
        character = text.slice(index, index + 2);
        codePoint = 0x10000 + ((unit - 0xd800) << 10) + (next - 0xdc00);
        index += 1;
      } else {
        codePoint = REPLACEMENT_CHARACTER;
        character = String.fromCharCode(REPLACEMENT_CHARACTER);
      }
    } else if (isLowSurrogate(unit)) {
      codePoint = REPLACEMENT_CHARACTER;
      character = String.fromCharCode(REPLACEMENT_CHARACTER);
    }
    const kind = classify(codePoint);
    if (kind === 'drop') {
      continue;
    }
    if (kind === 'space') {
      pendingSpace = output.length > 0;
      continue;
    }
    if (pendingSpace) {
      output += ' ';
      pendingSpace = false;
    }
    output += character;
  }
  return output;
};

/**
 * Page text is data. This makes it inert for a model prompt: no control, bidi or invisible characters,
 * collapsed whitespace, no `[t12]` or `[c3]` that could pass for an id of this library, and a code point cap.
 * Idempotent, total, never throws.
 */
export const sanitizeUntrustedText: TaskSanitizeUntrustedTextFn = (text, maxChars) => {
  if (typeof text !== 'string') {
    return '';
  }
  const limit = resolveLimit(maxChars);
  if (limit === 0) {
    return '';
  }
  const neutralized = stripAndCollapse(text).replace(LOOKALIKE_ID, '($1)');
  const capped = cutToCodePoints(neutralized, limit);
  return capped.endsWith(' ') ? capped.slice(0, -1) : capped;
};
