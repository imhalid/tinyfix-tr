/**
 * Turkish phonological helpers, phonetic attribute bitmasks, and suffix template surface generation.
 * Adapted from Zemberek's TurkishAlphabet, AttributesHelper, and SurfaceTransition (Apache 2.0).
 */

import type { SuffixTemplateToken } from "./types.ts";

// Phonetic attribute bitmask flags.
export const PA_LAST_VOWEL = 1 << 0;
export const PA_LAST_CONSONANT = 1 << 1;
export const PA_VOWEL_FRONT = 1 << 2;
export const PA_VOWEL_BACK = 1 << 3;
export const PA_VOWEL_ROUND = 1 << 4;
export const PA_VOWEL_UNROUND = 1 << 5;
export const PA_LAST_VOICED = 1 << 6;
export const PA_LAST_VOICELESS = 1 << 7;
export const PA_LAST_VOICELESS_STOP = 1 << 8;
export const PA_FIRST_VOWEL = 1 << 9;
export const PA_FIRST_CONSONANT = 1 << 10;
export const PA_HAS_NO_VOWEL = 1 << 11;
export const PA_EXPECTS_VOWEL = 1 << 12;
export const PA_EXPECTS_CONSONANT = 1 << 13;
export const PA_CANNOT_TERMINATE = 1 << 14;
export const PA_LAST_LETTER_DROPPED = 1 << 15;
export const PA_MODIFIED_PRONOUN = 1 << 16;
export const PA_UNMODIFIED_PRONOUN = 1 << 17;

export const SURFACE_CACHE_SIZE = 64;

// Suffix template token kinds.
export const TOKEN_LETTER = 0 as const;
export const TOKEN_A_VOWEL = 1 as const;
export const TOKEN_I_VOWEL = 2 as const;
export const TOKEN_APPEND = 3 as const;
export const TOKEN_DEVOICE_FIRST = 4 as const;
export const TOKEN_LAST_VOICED = 5 as const;
export const TOKEN_LAST_NOT_VOICED = 6 as const;

const VOWELS = new Set(["a", "e", "ı", "i", "o", "ö", "u", "ü", "â", "î", "û"]);
const FRONT_VOWELS = new Set(["e", "i", "ö", "ü", "î"]);
const ROUNDED_VOWELS = new Set(["o", "ö", "u", "ü", "û"]);
const VOICELESS = new Set(["ç", "f", "h", "k", "p", "s", "ş", "t"]);
const VOICELESS_STOPS = new Set(["ç", "k", "p", "t"]);

const VOICE_MAP: Record<string, string> = {
  p: "b",
  ç: "c",
  t: "d",
  k: "ğ",
  g: "ğ",
};

const DEVOICE_MAP: Record<string, string> = {
  b: "p",
  c: "ç",
  d: "t",
  g: "k",
};

export function isVowel(ch: string): boolean {
  return VOWELS.has(ch);
}

export function isFrontVowel(ch: string): boolean {
  return FRONT_VOWELS.has(ch);
}

export function isRoundedVowel(ch: string): boolean {
  return ROUNDED_VOWELS.has(ch);
}

export function isVoiceless(ch: string): boolean {
  return VOICELESS.has(ch);
}

export function isVoicelessStop(ch: string): boolean {
  return VOICELESS_STOPS.has(ch);
}

export function voiceChar(ch: string): string {
  return VOICE_MAP[ch] ?? ch;
}

export function devoiceChar(ch: string): string {
  return DEVOICE_MAP[ch] ?? ch;
}

export function countVowels(word: string): number {
  let count = 0;
  for (let i = 0; i < word.length; i++) {
    const ch = word[i];
    if (ch !== undefined && VOWELS.has(ch)) {
      count++;
    }
  }
  return count;
}

export function containsVowel(word: string): boolean {
  for (let i = 0; i < word.length; i++) {
    const ch = word[i];
    if (ch !== undefined && VOWELS.has(ch)) {
      return true;
    }
  }
  return false;
}

export function hasCircumflex(word: string): boolean {
  for (let i = 0; i < word.length; i++) {
    const code = word.charCodeAt(i);
    // â (226), î (238), û (251)
    if (code === 226 || code === 238 || code === 251) {
      return true;
    }
  }
  return false;
}

export function normalizeCircumflex(word: string): string {
  if (!hasCircumflex(word)) return word;
  let out = "";
  for (let i = 0; i < word.length; i++) {
    const ch = word[i] ?? "";
    if (ch === "â") out += "a";
    else if (ch === "î") out += "i";
    else if (ch === "û") out += "u";
    else out += ch;
  }
  return out;
}

/**
 * Packs the 6 phonetic bits that surface generation depends on into a 0..63 index.
 */
export function surfaceCacheKey(attrs: number): number {
  return (
    ((attrs & PA_LAST_VOWEL) !== 0 ? 1 : 0) |
    ((attrs & PA_VOWEL_BACK) !== 0 ? 2 : 0) |
    ((attrs & PA_VOWEL_FRONT) !== 0 ? 4 : 0) |
    ((attrs & PA_VOWEL_ROUND) !== 0 ? 8 : 0) |
    ((attrs & PA_VOWEL_UNROUND) !== 0 ? 16 : 0) |
    ((attrs & PA_LAST_VOICELESS) !== 0 ? 32 : 0)
  );
}

const VOWEL_HARMONY_MASK = PA_VOWEL_FRONT | PA_VOWEL_BACK | PA_VOWEL_ROUND | PA_VOWEL_UNROUND;

/**
 * Computes phonetic attributes for `seq`, transferring vowel harmony from `predecessorAttrs`
 * if `seq` contains no vowels (e.g. consonant-only suffixes like -m, -n, -k, -t, -z).
 */
export function computePhoneticAttributes(seq: string, predecessorAttrs = 0): number {
  if (seq.length === 0) {
    return predecessorAttrs;
  }

  let lastVowel = "";
  for (let i = seq.length - 1; i >= 0; i--) {
    const ch = seq[i];
    if (ch !== undefined && VOWELS.has(ch)) {
      lastVowel = ch;
      break;
    }
  }

  const first = seq[0] ?? "";
  const last = seq[seq.length - 1] ?? "";
  let attrs = 0;

  if (lastVowel.length > 0) {
    attrs |= VOWELS.has(last) ? PA_LAST_VOWEL : PA_LAST_CONSONANT;
    attrs |= FRONT_VOWELS.has(lastVowel) ? PA_VOWEL_FRONT : PA_VOWEL_BACK;
    attrs |= ROUNDED_VOWELS.has(lastVowel) ? PA_VOWEL_ROUND : PA_VOWEL_UNROUND;
    attrs |= VOWELS.has(first) ? PA_FIRST_VOWEL : PA_FIRST_CONSONANT;
  } else {
    // Transfer only vowel harmony attributes from predecessor; recompute consonant/voicing bits cleanly.
    attrs = (predecessorAttrs & VOWEL_HARMONY_MASK) | PA_LAST_CONSONANT | PA_FIRST_CONSONANT | PA_HAS_NO_VOWEL;
  }

  if (VOICELESS.has(last)) {
    attrs |= PA_LAST_VOICELESS;
    if (VOICELESS_STOPS.has(last)) {
      attrs |= PA_LAST_VOICELESS_STOP;
    }
  } else {
    attrs |= PA_LAST_VOICED;
  }

  return attrs;
}

/**
 * Tokenizes a Zemberek-style suffix template:
 * - `A`: low vowel harmony (a/e), elided at index 0 after a vowel
 * - `I`: high vowel harmony (ı/i/u/ü), elided at index 0 after a vowel
 * - `+x`: buffer letter `x`, emitted only when previous sound is a vowel
 * - `>x`: consonant assimilation (devoiced when previous sound is voiceless)
 * - `~x`: final unvoiced stop expecting a consonant next (e.g. -AcA~k, -dI~k, -lI~k)
 * - `!x`: final voiced stop expecting a vowel next and cannot terminate (e.g. -AcA!ğ, -dI!ğ)
 */
export function tokenizeTemplate(template: string): SuffixTemplateToken[] {
  const tokens: SuffixTemplateToken[] = [];
  let i = 0;
  while (i < template.length) {
    const ch = template[i] ?? "";
    i++;
    if (ch === "+") {
      const next = template[i] ?? "";
      i++;
      if (next === "I") {
        tokens.push({ type: TOKEN_I_VOWEL, letter: "" });
      } else if (next === "A") {
        tokens.push({ type: TOKEN_A_VOWEL, letter: "" });
      } else {
        tokens.push({ type: TOKEN_APPEND, letter: next });
      }
    } else if (ch === ">") {
      const next = template[i] ?? "";
      i++;
      tokens.push({ type: TOKEN_DEVOICE_FIRST, letter: next });
    } else if (ch === "~") {
      const next = template[i] ?? "";
      i++;
      tokens.push({ type: TOKEN_LAST_VOICED, letter: next });
    } else if (ch === "!") {
      const next = template[i] ?? "";
      i++;
      tokens.push({ type: TOKEN_LAST_NOT_VOICED, letter: next });
    } else if (ch === "I") {
      tokens.push({ type: TOKEN_I_VOWEL, letter: "" });
    } else if (ch === "A") {
      tokens.push({ type: TOKEN_A_VOWEL, letter: "" });
    } else {
      tokens.push({ type: TOKEN_LETTER, letter: ch });
    }
  }
  return tokens;
}

/**
 * Generates the concrete Turkish surface string for a tokenized suffix template given
 * the predecessor's phonetic attributes bitmask. Returns `null` if vowel harmony cannot
 * be resolved (e.g. a vowelless root without pronunciation).
 */
export function generateSurface(
  tokens: readonly SuffixTemplateToken[],
  phoneticAttrs: number,
): string | null {
  let sb = "";
  let attrs = phoneticAttrs;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token === undefined) break;
    if (sb.length > 0) {
      attrs = computePhoneticAttributes(sb, phoneticAttrs);
    }
    switch (token.type) {
      case TOKEN_LETTER:
      case TOKEN_LAST_VOICED:
      case TOKEN_LAST_NOT_VOICED:
        sb += token.letter;
        break;

      case TOKEN_A_VOWEL:
        if (index === 0 && (phoneticAttrs & PA_LAST_VOWEL) !== 0) {
          break;
        }
        if ((attrs & PA_VOWEL_BACK) !== 0) {
          sb += "a";
        } else if ((attrs & PA_VOWEL_FRONT) !== 0) {
          sb += "e";
        } else {
          return null;
        }
        break;

      case TOKEN_I_VOWEL:
        if (index === 0 && (phoneticAttrs & PA_LAST_VOWEL) !== 0) {
          break;
        }
        if ((attrs & PA_VOWEL_FRONT) !== 0 && (attrs & PA_VOWEL_UNROUND) !== 0) {
          sb += "i";
        } else if ((attrs & PA_VOWEL_BACK) !== 0 && (attrs & PA_VOWEL_UNROUND) !== 0) {
          sb += "ı";
        } else if ((attrs & PA_VOWEL_BACK) !== 0 && (attrs & PA_VOWEL_ROUND) !== 0) {
          sb += "u";
        } else if ((attrs & PA_VOWEL_FRONT) !== 0 && (attrs & PA_VOWEL_ROUND) !== 0) {
          sb += "ü";
        } else {
          return null;
        }
        break;

      case TOKEN_APPEND:
        if ((attrs & PA_LAST_VOWEL) !== 0) {
          sb += token.letter;
        }
        break;

      case TOKEN_DEVOICE_FIRST: {
        const ch = (attrs & PA_LAST_VOICELESS) !== 0 ? devoiceChar(token.letter) : token.letter;
        sb += ch;
        break;
      }
    }
  }
  return sb;
}

/**
 * Computes the updated phonetic attributes bitmask after consuming `surface` for a suffix transition.
 */
export function computeNextPhoneticAttrs(
  surface: string,
  prevAttrs: number,
  lastToken: SuffixTemplateToken | undefined,
): number {
  let attrs = computePhoneticAttributes(surface, prevAttrs);
  attrs &= ~PA_CANNOT_TERMINATE;
  if (lastToken !== undefined) {
    if (lastToken.type === TOKEN_LAST_VOICED) {
      attrs |= PA_EXPECTS_CONSONANT;
    } else if (lastToken.type === TOKEN_LAST_NOT_VOICED) {
      attrs |= PA_EXPECTS_VOWEL | PA_CANNOT_TERMINATE;
    }
  }
  return attrs;
}
