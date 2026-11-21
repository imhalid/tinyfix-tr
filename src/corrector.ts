import type { ContextModel } from "./context.ts";
import type { KnownMisspellings } from "./known.ts";
import { Lexicon } from "./lexicon.ts";
import {
  ALPHABET,
  LETTERS,
  areNearKeys,
  hasTurkishMarks,
  isAllUpper,
  isUpperInitial,
  lowerTr,
  markVariants,
  matchCase,
  upperTr,
} from "./turkish.ts";

/** One change to the text: replace [start, end) with replacement. */
export interface Correction {
  start: number;
  end: number;
  original: string;
  replacement: string;
  kind: CandidateKind;
  /** How much better the replacement fits than what was typed, in natural-log count units. */
  margin: number;
}

/**
 * marks: Turkish letters typed without their marks ("cok" for "çok").
 * apostrophe: a suffix on a name without its apostrophe ("Ankaraya").
 * split: two words written as one ("birşey", "geldinmi", "diyorki").
 * join: one word written as two ("hiç bir", "oysa ki", "ev de").
 * typo: a slip of the fingers that made a word that doesn't exist ("gelyorum").
 * known: a listed, corpus-checked misspelling ("herkez", "malesef", "hiç bir").
 * context: chosen by the context model between real words ("bende" / "ben de", "oldu" / "öldü").
 */
/** Tells whether a lowercase form is a real Turkish word by its suffixes (src/morphology). */
export interface WordValidator {
  isWord(form: string): boolean;
}

/** contraction: a spoken-style contraction spelled out ("noldu" -> "ne oldu"), only when Settings.contractions is on. */
export type CandidateKind = "marks" | "apostrophe" | "split" | "join" | "typo" | "known" | "context" | "contraction";

export interface Settings {
  /** Minimum margin per kind of change. Higher is more careful. */
  threshold: Record<CandidateKind, number>;
  /** Fixed cost of each kind of change, subtracted from the candidate's score. */
  cost: Record<CandidateKind, number>;
  /** The best candidate must beat the runner-up (a different text) by this much. */
  ambiguity: number;
  /** Words seen less often than this may be slips of the fingers. */
  knownWord: number;
  /**
   * Spell out spoken-style contractions ("noldu" -> "ne oldu", "burda" -> "burada"). Off by default: they are often
   * written on purpose. When off, such words are left exactly as typed, not taken for slips.
   */
  contractions: boolean;
  /** Threshold for a slip-of-the-fingers fix when the typed word is unseen and the morphology layer rejects it. */
  typoInvalidThreshold: number;
  /** Extra cost for joining a word with a following "de/da" ("yerler de" -> "yerlerde"). */
  deDaJoinCost: number;
  /** A slip in the last this many letters of a word costs typoEndCost more: those letters are usually a suffix. */
  typoEndWindow: number;
  typoEndCost: number;
  /** Real words seen at least this often are judged by the context model when one is loaded. */
  contextWord: number;
  /** A count-based fix is dropped when the context model prefers what was typed by at least this much. */
  contextVeto: number;
  /** In text that already uses Turkish letters, a word seen this often is taken as meant ("uç" stays "uç")... */
  knownMarked: number;
  /** ...unless the marked form is this much more common (log ratio): "cogu" is still "çoğu". */
  markedOverride: number;
  /** A name must be seen this often, mostly capitalized, before a suffix after it gets an apostrophe. */
  minName: number;
}

export const CAREFUL: Settings = {
  threshold: { marks: 2.5, apostrophe: 2.5, split: 2.5, join: 2.5, typo: 3, known: 1, context: 3, contraction: 1 },
  cost: { marks: 0.5, apostrophe: 0.5, split: 0.5, join: 0.5, typo: 2, known: 0, context: 0, contraction: 0 },
  ambiguity: 1,
  knownWord: 3,
  contractions: false,
  typoInvalidThreshold: 1.5,
  deDaJoinCost: 0,
  typoEndWindow: 2,
  typoEndCost: 1,
  contextWord: 5,
  contextVeto: 3,
  knownMarked: 20,
  markedOverride: 5.5,
  minName: 20,
};

interface Candidate {
  text: string;
  kind: CandidateKind;
  score: number;
  joinsNext: boolean;
}

export interface Token {
  text: string;
  start: number;
  end: number;
  isWord: boolean;
}

/** What the corrector knows about where a word sits. */
export interface WordContext {
  atSentenceStart: boolean;
  /** The rest of the text uses Turkish letters, so the writer has them on the keyboard. */
  textHasMarks: boolean;
  /** A question mark comes later in the same sentence. */
  questionAhead: boolean;
}

const TOKEN = new RegExp(`[${LETTERS}]+(?:['’][${LETTERS}]+)?|\\s+|.`, "gu");
const SENTENCE_END = new Set([".", "!", "?", ":", "\n"]);
const log = (count: number) => Math.log(count + 1);
/** A word typed without marks counts as evidence of an ASCII keyboard when its marked form is seen this often. */
const ASCII_EVIDENCE_COUNT = 50;

/** Words that are written apart from the word before them and follow its vowels. */
const QUESTION = /^(m[iıuü])(y?[iıuü]m|s[iıuü]n|y?[iıuü]z|s[iıuü]n[iıuü]z|d[iıuü]r|d[iıuü]|ym[iıuü]ş|ys[ae]|yd[iıuü]|yken)?$/;
const ALSO = /^(d[ae])$/;
/**
 * Stems a locative can't attach to directly, so "-da/-de" after them must be the separate word "da/de":
 * possessive "-sı" ("arenası da", not "arenasında"), a locative ("zamanda da"), a genitive ("şarkısının da"),
 * and finite verbs or the copula ("geliyor da", "gitmiş de", "güzeldir de").
 */
const NO_LOCATIVE_AFTER = /(s[ıiuü]|[dt][ae]|n[ıiuü]n|yor|m[ıiuü]ş|[ae]c[ae]k|[dt][ıiuü]|[dt][ıiuü]r|[dt][ıiuü]k|s[ae]|m[ae]l[ıi])$/;
/** Finite verbs and the copula, which "ki" follows as a separate word ("diyor ki", "beceridir ki", "öyle ki"). */
const FINITE = /(yor|m[ıiuü]ş|[ae]c[ae]k|[dt][ıiuü]|[dt][ıiuü]r|[dt][ıiuü]k|[dt][ıiuü]m|[dt][ıiuü]n|m[ae]l[ıi]|s[ae]|[ae]r|[ıiuü]r|öyle|böyle|şöyle)$/;
/** Never stand alone: splitting these off a word is never a fix ("kmdir", "kitaplar"). */
const NEVER_ALONE = new Set(["dir", "dır", "dur", "dür", "tir", "tır", "tur", "tür", "ler", "lar", "dı", "di", "du", "dü", "ti", "tı", "tu", "tü", "in", "ın", "un", "ün", "e", "a", "i", "ı", "u", "ü", "le", "la"]);
/** Short words that people often write apart from a word they belong with ("hiç bir", "bir çok", "her hangi"). */
const JOIN_FIRST = new Set(["bir", "her", "hiç", "şu", "ya", "pek", "o", "bu", "ne", "hep", "kimi", "öbür", "birbiri", "halbu", "oysa", "madem", "sanki", "meğer"]);
/** Suffix-like words that belong on the word before when they're the locative or ablative ("ev de" for "evde"). */
const JOIN_SECOND = new Set(["de", "da", "te", "ta", "den", "dan", "ten", "tan", "ki", "deki", "daki"]);
/** Suffixes that take an apostrophe after a name: case endings, plural, copula, -ki, -li, with and without buffer letters. */
const NAME_SUFFIX = new RegExp(
  "^(" +
    [
      "y?[aeıiuü]", "y?[ıiuü]", "n?[ıiuü]n", "[dt][ae]", "[dt][ae]n", "[dt][ae]k[iı]", "y?l[ae]", "[dt][ıiuü]r",
      "n[ıiuü]n", "s[ıiuü]", "s[ıiuü]n[ıiuü]n", "[dt][ae]n[ıiuü]n",
      "y?[ıiuü]n", "y?d[ıiuü]", "[dt][ıiuü]", "m", "[ıiuü]m", "ymiş", "y?m[ıiuü]ş", "ya", "ye", "n[ae]", "n[ıiuü]", "n[dt][ae]n?",
    ].join("|") +
    ")$",
);

export function tokenize(text: string): Token[] {
  return [...text.matchAll(TOKEN)].map((match) => {
    const value = match[0];
    return { text: value, start: match.index, end: match.index + value.length, isWord: /^\p{L}/u.test(value) };
  });
}

const BACK = new Set(["a", "ı", "o", "u", "â", "û"]);
const FRONT = new Set(["e", "i", "ö", "ü", "î"]);
const ROUND = new Set(["o", "u", "ö", "ü", "û"]);

function lastVowel(word: string): string | undefined {
  for (let index = word.length - 1; index >= 0; index--) {
    const char = word[index]!;
    if (BACK.has(char) || FRONT.has(char)) return char;
  }
  return undefined;
}

/** True when a two-way (e/a) or four-way (i/ı/u/ü) vowel follows the stem's last vowel. */
function followsHarmony(stem: string, vowel: string): boolean {
  const last = lastVowel(stem);
  if (!last) return true;
  const back = BACK.has(last);
  if (vowel === "a" || vowel === "e") return back === (vowel === "a");
  const round = ROUND.has(last);
  const want = back ? (round ? "u" : "ı") : round ? "ü" : "i";
  return vowel === want;
}

/** "misiniz", "mıydı" and "müsün" keep one high vowel throughout; "misın" doesn't exist. */
function sameHighVowels(particle: string): boolean {
  const high = [...particle].filter((char) => "ıiuü".includes(char));
  return high.every((char) => char === high[0]);
}

/** Copies the typed word's capital letters onto a replacement that only adds spaces, apostrophes or marks. */
function keepCase(typed: string, replacement: string): string {
  const plain = (text: string) => text.replace(/[ ']/g, "");
  if (plain(lowerTr(typed)).length !== plain(replacement).length) return matchCase(typed, replacement);
  const typedLetters = typed.replace(/[ '’]/g, "");
  let index = 0;
  let output = "";
  for (const char of replacement) {
    if (char === " " || char === "'") {
      output += char;
      continue;
    }
    const original = typedLetters[index++] ?? "";
    output += original !== lowerTr(original) ? upperTr(char) : char;
  }
  return output;
}

export class Corrector {
  private readonly lexicon: Lexicon;
  private readonly known?: KnownMisspellings;
  private readonly morphology?: WordValidator;
  settings: Settings;

  constructor(lexicon: Lexicon, settings: Settings = CAREFUL, known?: KnownMisspellings, morphology?: WordValidator) {
    this.lexicon = lexicon;
    this.settings = settings;
    this.known = known;
    this.morphology = morphology;
  }

  /** A word the lexicon has rarely or never seen, but that Turkish suffix rules accept ("getirsek", "kitabımı"). */
  private isRealWord(word: string): boolean {
    return this.morphology?.isWord(word) ?? false;
  }

  /** Returns the corrected text and the list of changes made. */
  correct(text: string): { text: string; corrections: Correction[] } {
    const tokens = tokenize(text);
    const corrections: Correction[] = [];
    const textHasMarks = hasTurkishMarks(text);
    const { asciiTyped, sentenceOf } = this.asciiEvidence(tokens);
    let atSentenceStart = true;
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index]!;
      if (!token.isWord) {
        if (SENTENCE_END.has(token.text) || token.text.includes("\n")) atSentenceStart = true;
        continue;
      }
      const next = this.nextWord(tokens, index);
      const context: WordContext = {
        atSentenceStart,
        textHasMarks:
          textHasMarks &&
          hasTurkishMarks(text.slice(0, token.start) + text.slice(token.end)) &&
          !asciiTyped.some((other) => other !== index && sentenceOf[other] === sentenceOf[index]),
        questionAhead: this.questionAhead(tokens, index),
      };
      atSentenceStart = false;
      if (!this.isIsolated(tokens, index)) continue;
      const fix = this.check(token.text, context, next?.token.text);
      if (!fix) continue;
      const end = fix.joinsNext && next ? next.token.end : token.end;
      corrections.push({
        start: token.start,
        end,
        original: text.slice(token.start, end),
        replacement: fix.replacement,
        kind: fix.kind,
        margin: fix.margin,
      });
      if (fix.joinsNext && next) index = next.index;
    }
    let output = "";
    let cursor = 0;
    for (const correction of corrections) {
      output += text.slice(cursor, correction.start) + correction.replacement;
      cursor = correction.end;
    }
    return { text: output + text.slice(cursor), corrections };
  }

  /**
   * Like correct(), but places where two real words compete ("bende" / "ben de", "oldu" / "öldü", "sevgimi" /
   * "sevgi mi") are decided by the context model instead of by counts alone. Everything else is decided as before.
   */
  async correctAsync(text: string, model: ContextModel): Promise<{ text: string; corrections: Correction[] }> {
    const tokens = tokenize(text);
    const textHasMarks = hasTurkishMarks(text);
    const { asciiTyped, sentenceOf } = this.asciiEvidence(tokens);
    const decided: Correction[] = [];
    const pending: { start: number; end: number; typed: string; alternatives: string[] }[] = [];
    let atSentenceStart = true;
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index]!;
      if (!token.isWord) {
        if (SENTENCE_END.has(token.text) || token.text.includes("\n")) atSentenceStart = true;
        continue;
      }
      const next = this.nextWord(tokens, index);
      const context: WordContext = {
        atSentenceStart,
        textHasMarks:
          textHasMarks &&
          hasTurkishMarks(text.slice(0, token.start) + text.slice(token.end)) &&
          !asciiTyped.some((other) => other !== index && sentenceOf[other] === sentenceOf[index]),
        questionAhead: this.questionAhead(tokens, index),
      };
      atSentenceStart = false;
      if (!this.isIsolated(tokens, index)) continue;
      for (const option of this.contestedSpans(token, next?.token, context)) pending.push(option);
      const fix = this.check(token.text, context, next?.token.text);
      if (!fix) continue;
      const end = fix.joinsNext && next ? next.token.end : token.end;
      decided.push({ start: token.start, end, original: text.slice(token.start, end), replacement: fix.replacement, kind: fix.kind, margin: fix.margin });
    }
    const scores = await model.score(
      pending.map((option) => ({
        left: text.slice(Math.max(0, option.start - 80), option.start),
        right: text.slice(option.end, option.end + 40),
        candidates: [option.typed, ...option.alternatives],
      })),
    );
    const overlaps = (a: { start: number; end: number }, b: { start: number; end: number }) => a.start < b.end && b.start < a.end;
    // A count-based fix stands unless it is one of the readings the model weighed for exactly that span and the model
    // clearly prefers what was typed ("yerler de" kept when the context says "the places too").
    const kept = decided.filter((fix) => {
      const index = pending.findIndex(
        (option) => option.start === fix.start && option.end === fix.end && option.alternatives.some((alt) => lowerTr(alt) === lowerTr(fix.replacement)),
      );
      if (index === -1) return true;
      const row = scores[index]!;
      const option = pending[index]!;
      const alternative = option.alternatives.findIndex((alt) => lowerTr(alt) === lowerTr(fix.replacement));
      return row[alternative + 1]! - row[0]! > -this.settings.contextVeto;
    });
    // Where no count-based fix touches a span, the model may change it when it is confident.
    const judged: Correction[] = [];
    pending.forEach((option, index) => {
      if (decided.some((fix) => overlaps(fix, option))) return;
      const row = scores[index]!;
      let best = 1;
      for (let i = 2; i < row.length; i++) if (row[i]! > row[best]!) best = i;
      const margin = row[best]! - row[0]!;
      if (margin >= this.settings.threshold.context) {
        judged.push({ start: option.start, end: option.end, original: option.typed, replacement: option.alternatives[best - 1]!, kind: "context", margin });
      }
    });
    const all = [...kept, ...judged].sort((a, b) => a.start - b.start || b.margin - a.margin);
    const corrections: Correction[] = [];
    for (const fix of all) if (!corrections.some((done) => overlaps(done, fix))) corrections.push(fix);
    let output = "";
    let cursor = 0;
    for (const correction of corrections) {
      output += text.slice(cursor, correction.start) + correction.replacement;
      cursor = correction.end;
    }
    return { text: output + text.slice(cursor), corrections };
  }

  /** Places where the typed span and another real-word reading compete, for the context model to judge. */
  private contestedSpans(
    token: Token,
    next: Token | undefined,
    context: WordContext,
  ): { start: number; end: number; typed: string; alternatives: string[] }[] {
    const typed = token.text;
    if (isAllUpper(typed) || typed.length < 2 || (isUpperInitial(typed) && !context.atSentenceStart)) return [];
    const word = lowerTr(typed);
    const known = (form: string) => this.lexicon.count(form) >= this.settings.contextWord;
    const spans: { start: number; end: number; typed: string; alternatives: string[] }[] = [];
    // "oldu" / "öldü", "uç" / "üç": real words that differ only in Turkish marks.
    if (known(word) && !word.includes("'") && typed === word) {
      const variants = markVariants(word)
        .filter(known)
        .sort((a, b) => this.lexicon.count(b) - this.lexicon.count(a))
        .slice(0, 3)
        .map((variant) => keepCase(typed, variant));
      if (variants.length > 0) spans.push({ start: token.start, end: token.end, typed, alternatives: variants });
    }
    // "bende" / "ben de", "evdeki" / "evde ki", "sevgimi" / "sevgi mi": a real word that could be two.
    // Same conditions as the training data (py/context_data.py): lowercase, at least 5 letters, a stem seen 5+ times.
    if (known(word) && word.length >= 5 && typed === word) {
      const ending = /(d[ae]|t[ae]|ki|m[ıiuü])$/.exec(word)?.[0];
      if (ending && known(word.slice(0, -2))) {
        spans.push({ start: token.start, end: token.end, typed, alternatives: [`${typed.slice(0, -2)} ${typed.slice(-2)}`] });
      }
    }
    // "ben de" / "bende", "evde ki" / "evdeki", "sevgi mi" / "sevgimi": two words that could be one.
    if (next && !isUpperInitial(next.text)) {
      const second = lowerTr(next.text);
      if ((["de", "da", "ki"].includes(second) || QUESTION.test(second)) && known(word + second)) {
        spans.push({ start: token.start, end: next.end, typed: `${typed} ${next.text}`, alternatives: [typed + next.text] });
      }
    }
    return spans;
  }

  /**
   * Words that were clearly typed without Turkish letters ("anlamadim", "sey"): unseen or nearly so as typed, but
   * common with marks. A sentence with one is treated as typed without Turkish letters, even when other words in the
   * text have them, so "hic" next to "anlamadim" still becomes "hiç".
   */
  private asciiEvidence(tokens: Token[]): { asciiTyped: number[]; sentenceOf: number[] } {
    const asciiTyped: number[] = [];
    const sentenceOf: number[] = [];
    let sentence = 0;
    tokens.forEach((token, index) => {
      if (!token.isWord) {
        if (SENTENCE_END.has(token.text) || token.text.includes("\n")) sentence++;
        sentenceOf[index] = sentence;
        return;
      }
      sentenceOf[index] = sentence;
      const word = lowerTr(token.text);
      if (hasTurkishMarks(word) || this.lexicon.count(word) >= this.settings.knownWord || this.isRealWord(word)) return;
      if (markVariants(word).some((variant) => this.lexicon.count(variant) >= ASCII_EVIDENCE_COUNT)) asciiTyped.push(index);
    });
    return { asciiTyped, sentenceOf };
  }

  /** The next word when only a single space separates it from this one. */
  private nextWord(tokens: Token[], index: number): { token: Token; index: number } | null {
    const space = tokens[index + 1];
    const word = tokens[index + 2];
    if (space?.text === " " && word?.isWord) return { token: word, index: index + 2 };
    return null;
  }

  private questionAhead(tokens: Token[], index: number): boolean {
    for (let ahead = index + 1; ahead < tokens.length; ahead++) {
      const text = tokens[ahead]!.text;
      if (text === "?") return true;
      if (SENTENCE_END.has(text) || text.includes("\n")) return false;
    }
    return false;
  }

  /** Words glued to "@", "/", digits or dots between letters are parts of addresses, handles or code. */
  private isIsolated(tokens: Token[], index: number): boolean {
    const before = tokens[index - 1]?.text ?? " ";
    const after = tokens[index + 1]?.text ?? " ";
    const afterNext = tokens[index + 2];
    if (/[@/#_\\\d-]/.test(before) || /[@/#_\\\d-]/.test(after)) return false;
    // Part of a word with letters Turkish doesn't use ("skrælingi", Cyrillic): not ours to judge.
    if (/\p{L}/u.test(before) || /\p{L}/u.test(after)) return false;
    if (after === "." && afterNext?.isWord) return false;
    return true;
  }

  /** Decides on one word, optionally joined with the next. Returns null to leave it alone. */
  check(
    typed: string,
    context: WordContext,
    nextTyped?: string,
  ): { replacement: string; kind: CandidateKind; margin: number; joinsNext: boolean } | null {
    if (isAllUpper(typed) || typed.length < 2) return null;
    const word = lowerTr(typed);
    const typedCount = this.lexicon.count(word);
    const typedScore = log(typedCount);
    const listed = this.knownFix(typed, word, context, nextTyped);
    if (listed === "keep") return null;
    if (listed) return listed;
    const candidates = this.candidates(word, typed, context, typedCount);

    let joinBase = 0;
    if (nextTyped && !isAllUpper(nextTyped) && isUpperInitial(nextTyped) === (isUpperInitial(typed) && !context.atSentenceStart)) {
      const joined = this.joinCandidate(word, lowerTr(nextTyped));
      if (joined) {
        candidates.push(joined);
        joinBase = log(this.lexicon.pair(word, lowerTr(nextTyped)));
      }
    }
    if (candidates.length === 0) return null;
    candidates.sort((first, second) => second.score - first.score);
    const best = candidates[0]!;
    const runnerUp = candidates.find((candidate) => candidate.text !== best.text);
    const base = best.joinsNext ? joinBase : typedScore;
    const margin = best.score - base;
    // A word nobody has seen that Turkish suffix rules also reject is almost surely a slip ("gelyorum"), so a fix for it
    // needs less of a margin.
    // Only for lowercase words: an unseen capitalized word is usually a name ("Kahireden" is "Kahire'den").
    const invalidTyped =
      best.kind === "typo" && this.morphology !== undefined && typedCount === 0 && typed === word && !this.isRealWord(word);
    const threshold = invalidTyped ? this.settings.typoInvalidThreshold : this.settings.threshold[best.kind];
    if (margin < threshold) return null;
    if (runnerUp && best.score - runnerUp.score < this.settings.ambiguity) return null;
    const original = best.joinsNext ? `${typed} ${nextTyped}` : typed;
    const replacement = best.kind === "typo" ? matchCase(typed, best.text) : keepCase(original, best.text);
    return { replacement, kind: best.kind, margin, joinsNext: best.joinsNext };
  }

  /** A listed misspelling wins over everything else when the fix is clearly more common than what was typed. */
  private knownFix(
    typed: string,
    word: string,
    context: WordContext,
    nextTyped: string | undefined,
  ): { replacement: string; kind: CandidateKind; margin: number; joinsNext: boolean } | "keep" | null {
    if (!this.known || (isUpperInitial(typed) && !context.atSentenceStart)) return null;
    const next = nextTyped && !isUpperInitial(nextTyped) ? lowerTr(nextTyped) : undefined;
    let best: { replacement: string; kind: CandidateKind; margin: number; joinsNext: boolean } | null = null;
    const fixes = this.known.find(word, next, this.lexicon);
    // With contractions off, a single word matching one ("noldu") stays as typed: no other rule may take it for a slip.
    if (!this.settings.contractions && fixes.some((fix) => fix.contraction && !fix.joinsNext)) return "keep";
    for (const fix of fixes) {
      if (fix.contraction && !this.settings.contractions) continue;
      const base = fix.joinsNext ? log(this.lexicon.pair(word, next!)) : log(this.lexicon.count(word));
      const margin = log(fix.count) - this.settings.cost.known - base;
      if (margin < this.settings.threshold.known || (best && best.margin >= margin)) continue;
      const original = fix.joinsNext ? `${typed} ${nextTyped}` : typed;
      best = { replacement: keepCase(original, fix.text), kind: fix.contraction ? "contraction" : "known", margin, joinsNext: fix.joinsNext };
    }
    return best;
  }

  private candidates(word: string, typed: string, context: WordContext, typedCount: number): Candidate[] {
    const { cost, knownWord, knownMarked, markedOverride } = this.settings;
    const found = new Map<string, Candidate>();
    const add = (text: string, kind: CandidateKind, score: number) => {
      if (!Number.isFinite(score) || text === word) return;
      const existing = found.get(text);
      if (!existing || existing.score < score) found.set(text, { text, kind, score, joinsNext: false });
    };
    const capitalized = isUpperInitial(typed);
    const isName = capitalized && !context.atSentenceStart;

    // A writer who types Turkish letters elsewhere meant a word they typed without them, if it's a real word.
    const strict = context.textHasMarks && typedCount >= knownMarked;
    const forms = [word, ...markVariants(word)];
    for (const form of forms) {
      const markCost = form === word ? 0 : cost.marks;
      if (form !== word) {
        const count = this.lexicon.count(form);
        const score = log(count) - cost.marks;
        if (count > 0 && (!strict || score - log(typedCount) >= markedOverride)) add(form, "marks", score);
        if (strict) continue;
      }
      // A real word is not split ("kitabımı" is not "kitabı mı", "öyküsüz" stays). Listed misspellings
      // ("birşey", "yada") are handled before this, so they still get fixed.
      if (!(form === word && typedCount < knownWord && this.isRealWord(word))) this.addSplits(form, context, markCost, add);
      if (isName && !form.includes("'")) this.addApostrophes(form, typedCount, markCost, add);
    }
    // Slips of the fingers are only considered for rare or unseen words that aren't names.
    // A rare form that Turkish suffix rules accept is a real word, not a slip ("getirsek" is not "getirmek").
    if (typedCount < knownWord && word.length >= 4 && !isName && !word.includes("'") && !this.isRealWord(word)) {
      for (const [text, slipCost] of this.oneEdit(word)) {
        const count = this.lexicon.count(text);
        if (count > 0) add(text, "typo", log(count) - cost.typo - slipCost);
      }
    }
    return [...found.values()];
  }

  /** "birsey" -> "bir şey" from how often the pair is seen; "geldinmi", "arenasıda", "diyorki" from the stem alone. */
  private addSplits(form: string, context: WordContext, markCost: number, add: (text: string, kind: CandidateKind, score: number) => void) {
    const { cost } = this.settings;
    for (let cut = 2; cut <= form.length - 2; cut++) {
      const first = form.slice(0, cut);
      const second = form.slice(cut);
      if (first.includes("'") || second.includes("'") || NEVER_ALONE.has(second)) continue;
      const pair = this.lexicon.pair(first, second);
      if (pair > 0) add(`${first} ${second}`, "split", log(pair) - cost.split - markCost);
      const stem = this.lexicon.count(first);
      if (stem === 0 || first.length < 3) continue;
      const question = QUESTION.exec(second);
      const particle =
        (question && followsHarmony(first, question[1]![1]!) && sameHighVowels(second) && (context.questionAhead || question[2] !== undefined)) ||
        (ALSO.test(second) && followsHarmony(first, second[1]!) && NO_LOCATIVE_AFTER.test(first)) ||
        (second === "ki" && FINITE.test(first));
      // A glued form that is itself a common word ("olduğumu", "istediğimi") is not split on the stem's count alone.
      const glued = this.lexicon.count(form);
      if (particle && glued < this.settings.knownMarked) add(`${first} ${second}`, "split", log(stem) - cost.split - markCost - 1);
    }
  }

  /** "Ankaraya" -> "Ankara'ya" when the form is seen, or when "ankara" is a name and "ya" a suffix that takes one. */
  private addApostrophes(form: string, typedCount: number, markCost: number, add: (text: string, kind: CandidateKind, score: number) => void) {
    const { cost, minName } = this.settings;
    for (let cut = 2; cut < form.length; cut++) {
      const stem = form.slice(0, cut);
      const suffix = form.slice(cut);
      const withMark = `${stem}'${suffix}`;
      const seen = this.lexicon.count(withMark);
      if (seen > 0) add(withMark, "apostrophe", log(seen) - cost.apostrophe - markCost);
      // The generic rule only applies to unseen forms of clear names. Institution and compound place names ending in a
      // possessive ("Cumhuriyetinde", "Bakanlığından") take no apostrophe, so stems ending in one are left alone.
      const stemCount = this.lexicon.count(stem);
      if (
        typedCount === 0 &&
        stemCount >= minName &&
        this.lexicon.capitalShare(stem) >= 0.8 &&
        NAME_SUFFIX.test(suffix) &&
        !/[^aeıioöuü](s?[ıiuü])$/.test(stem)
      ) {
        add(withMark, "apostrophe", log(stemCount) - cost.apostrophe - markCost - 1.5);
      }
    }
  }

  /** "hiç bir" -> "hiçbir", "oysa ki" -> "oysaki", "ev de" -> "evde". Compared with how often the two words appear apart. */
  private joinCandidate(word: string, next: string): Candidate | null {
    if (word.includes("'") || next.includes("'")) return null;
    if (!JOIN_FIRST.has(word) && !JOIN_SECOND.has(next)) return null;
    const joined = word + next;
    const count = this.lexicon.count(joined);
    if (count === 0) return null;
    // "de/da" after a word is far more often the conjunction in everyday writing than a misplaced locative, so
    // joining it needs a clearer case than other joins.
    const extra = ALSO.test(next) ? this.settings.deDaJoinCost : 0;
    return { text: joined, kind: "join", score: log(count) - this.settings.cost.join - extra, joinsNext: true };
  }

  /** Words one edit away, with a cost for edits that are unlikely on a Turkish Q keyboard. */
  private oneEdit(word: string): Map<string, number> {
    const edits = new Map<string, number>();
    const put = (text: string, slip: number, position: number) => {
      // Changing the end of a word often swaps one real suffix for another ("öyküsüz" is not "öyküsü", "benzeyene"
      // is not "benzeyen"), so edits there cost more.
      const atEnd = position >= word.length - this.settings.typoEndWindow ? this.settings.typoEndCost : 0;
      // The last letter of a longer word is almost always a person or case ending: "düşünmüştün" is not a slip for
      // "düşünmüştüm". Such edits are left to the listed misspellings.
      if (word.length >= 6 && position >= word.length - 1) return;
      const atStart = position === 0 ? 1.5 : 0;
      const total = slip + atEnd + atStart;
      if (text.length > 0 && (edits.get(text) ?? Infinity) > total) edits.set(text, total);
    };
    for (let i = 0; i <= word.length; i++) {
      const before = word.slice(0, i);
      const at = word[i];
      const after = word.slice(i + 1);
      if (at !== undefined) {
        put(before + after, 1, i); // an extra key
        const following = word[i + 1];
        if (following !== undefined) put(before + following + at + word.slice(i + 2), 0.8, i); // two keys swapped
      }
      for (const letter of ALPHABET) {
        if (at !== undefined && letter !== at) put(before + letter + after, areNearKeys(letter, at) ? 0.8 : 1.8, i); // wrong key
        const previous = word[i - 1];
        const near = previous !== undefined && (areNearKeys(letter, previous) || letter === previous);
        put(before + letter + word.slice(i), near ? 1 : 1.6, i); // a missed key
      }
    }
    edits.delete(word);
    return edits;
  }
}
