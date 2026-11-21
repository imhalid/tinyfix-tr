import type { ContextModel } from "./context.ts";
import type { KnownMisspellings } from "./known.ts";
import { Lexicon } from "./lexicon.ts";
import {
  ALSO,
  FINITE,
  JOIN_FIRST,
  JOIN_SECOND,
  MUSIC_AFTER,
  MUSIC_NOTES,
  NEVER_ALONE,
  NO_LOCATIVE_AFTER,
  QUESTION,
  SOMBAHCEMI_KI,
  STRONG_NO_LOCATIVE_AFTER,
  TE_TA_SKIP,
  TIME_NAMES_NO_START_APOSTROPHE,
  collapsedDoubledLocative,
  fixDisharmoniousApostropheSuffix,
  followsHarmony,
  harmonizeQuestionParticle,
  hasBlockedApostropheStem,
  isHarmoniousApostropheMarkChange,
  isValidGenericApostrophe,
  isVoicelessFinal,
  isAuxiliaryOl,
  matchAcronymApostrophe,
  sameHighVowels,
} from "./rules/turkish-rules.ts";
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
  stripMarksIn,
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
/** Morphological analysis shape returned by TurkishMorphology.analyze() (optional on WordValidator). */
export interface WordAnalysis {
  readonly stem: string;
  readonly pos: string;
  readonly morphemes: readonly string[];
}

/** Tells whether a lowercase form is a real Turkish word by its suffixes (src/morphology). */
export interface WordValidator {
  isWord(form: string): boolean;
  analyze?(form: string): readonly WordAnalysis[];
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
  base: number;
  joinsNext: boolean;
  threshold?: number;
}

type AddCandidate = (text: string, kind: CandidateKind, score: number, base?: number, threshold?: number) => void;

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
  /** Lowercased previous word when separated by a single space (using its corrected form if changed). */
  prevWord?: string;
  /** True when the previous word was a mid-sentence capitalized word (likely a proper name). */
  prevIsName?: boolean;
}

const TOKEN = new RegExp(`[${LETTERS}]+(?:['’][${LETTERS}]+)?|\\s+|.`, "gu");
const SENTENCE_END = new Set([".", "!", "?", ":", "\n"]);
const log = (count: number) => Math.log(count + 1);
const marginOf = (candidate: Candidate) => candidate.score - candidate.base;
/** A word typed without marks counts as evidence of an ASCII keyboard when its marked form is seen this often. */
const ASCII_EVIDENCE_COUNT = 50;
/** Morphemes indicating a stem is already plural, oblique-inflected or derived and must not take a new apostrophe. */
const BLOCKED_STEM_MORPHEMES = new Set([
  "A3pl", "Abl", "Loc", "Ins", "Equ", "Cop",
  "With", "Without", "Ness", "Agt", "Rel",
]);
/** 1st/2nd person nominal predicate endings blocked for zero-count unseen mark guesses ("alveolusun" -> "alveolüsün"). */
const NOMINAL_PERSONAL_AGREEMENT = new Set(["A1sg", "A2sg", "A1pl", "A2pl"]);

export function tokenize(text: string): Token[] {
  return [...text.matchAll(TOKEN)].map((match) => {
    const value = match[0];
    return { text: value, start: match.index, end: match.index + value.length, isWord: /^\p{L}/u.test(value) };
  });
}

function lastSpaceWord(value: string): string {
  const space = value.lastIndexOf(" ");
  return space === -1 ? value : value.slice(space + 1);
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

export interface CorrectOptions {
  /**
   * [start, end) ranges whose Turkish letters were put there by autocorrect, not typed by the user. They don't count
   * as evidence that the user types with Turkish letters, so "hic bir sey" still gets "sey" fixed after "hiç" was.
   */
  autoMarked?: readonly (readonly [number, number])[];
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

  /** True when a stem takes both front locative and front ablative (filters accidental Dat collisions like "varit" -> "varde"). */
  private hasFrontLocative(stem: string): boolean {
    return (
      (this.isRealWord(stem + "de") && this.isRealWord(stem + "den")) ||
      (this.isRealWord(stem + "te") && this.isRealWord(stem + "ten"))
    );
  }

  /** True when a stem takes both back locative and back ablative. */
  private hasBackLocative(stem: string): boolean {
    return (
      (this.isRealWord(stem + "da") && this.isRealWord(stem + "dan")) ||
      (this.isRealWord(stem + "ta") && this.isRealWord(stem + "tan"))
    );
  }

  /**
   * True when morphology only parses a candidate apostrophe stem as an already-inflected or derived form
   * ("japonların", "yunanlardan", "ankaradan", "türkçeden"), never as an uninflected bare root.
   * Bare personal names that coincide with lowercase inflected words ("Emre", "Selin", "Güler") are preserved.
   */
  private isInflectedApostropheStem(stem: string): boolean {
    const analyses = this.morphology?.analyze?.(stem);
    if (!analyses || analyses.length === 0) return false;
    const hasBareRoot = analyses.some(
      (analysis) => analysis.morphemes.length === 0 || (analysis.morphemes.length === 1 && analysis.morphemes[0] === "A3sg"),
    );
    if (hasBareRoot) return false;
    return analyses.every((analysis) => {
      if (analysis.morphemes.some((morpheme) => BLOCKED_STEM_MORPHEMES.has(morpheme))) return true;
      if (analysis.stem !== stem && this.lexicon.capitalShare(analysis.stem) >= 0.45) return true;
      return false;
    });
  }

  /**
   * Extra morphological/lexical guard for unseen (count === 0) unique mark restorations on long lowercase words:
   * keeps genuine Turkish inflections ("yukleyince", "sisirmesinden", "dalgakiranlarla") while blocking Latin/foreign
   * terms that accidentally match nominal 1st/2nd person copula readings ("alveolusun" -> "alveolüsün").
   */
  private isSafeUnseenMarkVariant(word: string, candidate: string, context: WordContext): boolean {
    const analyses = this.morphology?.analyze?.(candidate);
    if (!analyses) return true;
    if (analyses.length === 0) return false;
    let hasNewConsonantMark = false;
    for (let i = 0; i < candidate.length; i++) {
      const ch = candidate[i];
      if (ch !== word[i] && (ch === "ç" || ch === "ğ" || ch === "ş")) {
        hasNewConsonantMark = true;
        break;
      }
    }
    return analyses.some((analysis) => {
      if (
        analysis.morphemes.includes("Zero") &&
        analysis.morphemes.some((morpheme) => NOMINAL_PERSONAL_AGREEMENT.has(morpheme))
      ) {
        return false;
      }
      const lemma = analysis.pos === "Verb" ? analysis.stem + (followsHarmony(analysis.stem, "a") ? "mak" : "mek") : analysis.stem;
      if (this.lexicon.count(lemma) < 5 || this.lexicon.capitalShare(lemma) >= 0.5) return false;
      const stemChanged = word.slice(0, analysis.stem.length) !== candidate.slice(0, analysis.stem.length);
      if (context.textHasMarks && analysis.pos !== "Verb" && !stemChanged && !hasNewConsonantMark) return false;
      return true;
    });
  }

  /** Returns the corrected text and the list of changes made. */
  correct(text: string, options: CorrectOptions = {}): { text: string; corrections: Correction[] } {
    const tokens = tokenize(text);
    const corrections: Correction[] = [];
    const evidence = stripMarksIn(text, options.autoMarked ?? []);
    const textHasMarks = hasTurkishMarks(evidence);
    const { asciiTyped, sentenceOf } = this.asciiEvidence(tokenize(evidence));
    let atSentenceStart = true;
    let prevWord: string | undefined;
    let prevIsName = false;
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index]!;
      if (!token.isWord) {
        if (SENTENCE_END.has(token.text) || token.text.includes("\n")) atSentenceStart = true;
        if (token.text !== " ") {
          prevWord = undefined;
          prevIsName = false;
        }
        continue;
      }
      const next = this.nextWord(tokens, index);
      const context: WordContext = {
        atSentenceStart,
        textHasMarks:
          textHasMarks &&
          hasTurkishMarks(evidence.slice(0, token.start) + evidence.slice(token.end)) &&
          !asciiTyped.some((other) => other !== index && sentenceOf[other] === sentenceOf[index]),
        questionAhead: this.questionAhead(tokens, index),
        prevWord,
        prevIsName,
      };
      atSentenceStart = false;
      if (!this.isIsolated(tokens, index)) {
        prevWord = undefined;
        prevIsName = false;
        continue;
      }
      const fix = this.check(token.text, context, next?.token.text);
      if (!fix) {
        prevWord = lowerTr(token.text);
        prevIsName = !context.atSentenceStart && isUpperInitial(token.text);
        continue;
      }
      const end = fix.joinsNext && next ? next.token.end : token.end;
      corrections.push({
        start: token.start,
        end,
        original: text.slice(token.start, end),
        replacement: fix.replacement,
        kind: fix.kind,
        margin: fix.margin,
      });
      const trailing = lastSpaceWord(fix.replacement);
      prevWord = lowerTr(trailing);
      prevIsName = !(context.atSentenceStart && !fix.replacement.includes(" ")) && isUpperInitial(trailing);
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
  async correctAsync(
    text: string,
    model: ContextModel,
    options: CorrectOptions = {},
  ): Promise<{ text: string; corrections: Correction[] }> {
    const tokens = tokenize(text);
    const evidence = stripMarksIn(text, options.autoMarked ?? []);
    const textHasMarks = hasTurkishMarks(evidence);
    const { asciiTyped, sentenceOf } = this.asciiEvidence(tokenize(evidence));
    const decided: Correction[] = [];
    const pending: { start: number; end: number; typed: string; alternatives: string[] }[] = [];
    let atSentenceStart = true;
    let prevWord: string | undefined;
    let prevIsName = false;
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index]!;
      if (!token.isWord) {
        if (SENTENCE_END.has(token.text) || token.text.includes("\n")) atSentenceStart = true;
        if (token.text !== " ") {
          prevWord = undefined;
          prevIsName = false;
        }
        continue;
      }
      const next = this.nextWord(tokens, index);
      const context: WordContext = {
        atSentenceStart,
        textHasMarks:
          textHasMarks &&
          hasTurkishMarks(evidence.slice(0, token.start) + evidence.slice(token.end)) &&
          !asciiTyped.some((other) => other !== index && sentenceOf[other] === sentenceOf[index]),
        questionAhead: this.questionAhead(tokens, index),
        prevWord,
        prevIsName,
      };
      atSentenceStart = false;
      if (!this.isIsolated(tokens, index)) {
        prevWord = undefined;
        prevIsName = false;
        continue;
      }
      for (const option of this.contestedSpans(token, next?.token, context)) pending.push(option);
      const fix = this.check(token.text, context, next?.token.text);
      if (!fix) {
        prevWord = lowerTr(token.text);
        prevIsName = !context.atSentenceStart && isUpperInitial(token.text);
        continue;
      }
      const end = fix.joinsNext && next ? next.token.end : token.end;
      decided.push({ start: token.start, end, original: text.slice(token.start, end), replacement: fix.replacement, kind: fix.kind, margin: fix.margin });
      const trailing = lastSpaceWord(fix.replacement);
      prevWord = lowerTr(trailing);
      prevIsName = !(context.atSentenceStart && !fix.replacement.includes(" ")) && isUpperInitial(trailing);
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
    const listed = this.knownFix(typed, word, context, nextTyped);
    if (listed === "keep") return null;
    if (listed) return listed;
    const candidates = this.candidates(word, typed, context, typedCount, nextTyped);

    if (nextTyped && !isAllUpper(nextTyped) && !isUpperInitial(nextTyped) && !(isUpperInitial(typed) && !context.atSentenceStart)) {
      const joined = this.joinCandidate(word, lowerTr(nextTyped));
      if (joined) candidates.push(joined);
    }
    if (candidates.length === 0) return null;
    candidates.sort((first, second) => marginOf(second) - marginOf(first));
    const best = candidates[0]!;
    const runnerUp = candidates.find((candidate) => candidate.text !== best.text);
    const margin = marginOf(best);
    // A word nobody has seen that Turkish suffix rules also reject is almost surely a slip ("gelyorum"), so a fix for it
    // needs less of a margin.
    // Only for lowercase words: an unseen capitalized word is usually a name ("Kahireden" is "Kahire'den").
    const invalidTyped =
      best.kind === "typo" && this.morphology !== undefined && typedCount === 0 && typed === word && !this.isRealWord(word);
    const threshold = best.threshold ?? (invalidTyped ? this.settings.typoInvalidThreshold : this.settings.threshold[best.kind]);
    if (margin < threshold) return null;
    if (runnerUp && margin - marginOf(runnerUp) < this.settings.ambiguity) return null;
    if (best.kind === "marks" && context.prevWord && isAuxiliaryOl(context.prevWord, word, best.text)) return null;
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
    const fixes = this.known.find(word, next, this.lexicon, !context.textHasMarks);
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

  private candidates(
    word: string,
    typed: string,
    context: WordContext,
    typedCount: number,
    nextTyped?: string,
  ): Candidate[] {
    const { cost, knownWord, knownMarked, markedOverride } = this.settings;
    const typedScore = log(typedCount);
    const found = new Map<string, Candidate>();
    const add: AddCandidate = (text, kind, score, base = typedScore, threshold) => {
      if (!Number.isFinite(score) || !Number.isFinite(base) || text === word) return;
      const existing = found.get(text);
      // The same fix may come from two rules with different bars (plain mark restoration and the lower bar for a
      // unique morphologically valid variant). Keep the best margin and the lower bar of the two, or the lower bar
      // is lost whenever the other rule saw the same candidate first ("duzeltmiyor" -> "düzeltmiyor").
      const sameKind = existing?.kind === kind;
      const bar = (candidate: { kind: CandidateKind; threshold?: number }) =>
        candidate.threshold ?? this.settings.threshold[candidate.kind];
      if (!existing || score - base > marginOf(existing)) {
        const keepBar = sameKind && existing && bar(existing) < bar({ kind, threshold });
        found.set(text, { text, kind, score, base, joinsNext: false, threshold: keepBar ? existing.threshold : threshold });
      } else if (sameKind && bar({ kind, threshold }) < bar(existing)) {
        existing.threshold = threshold;
      }
    };
    const capitalized = isUpperInitial(typed);
    const isName = capitalized && !context.atSentenceStart;
    const realTyped = this.isRealWord(word);
    const hasApostrophe = word.includes("'");
    const apostropheAt = hasApostrophe ? word.indexOf("'") : -1;
    const wordStem = hasApostrophe ? word.slice(0, apostropheAt) : "";
    const wordSuffix = hasApostrophe ? word.slice(apostropheAt + 1) : "";

    // In text that already uses Turkish marks, protect real Turkish words ("cabası", "oluyorduk", "basınız") with a
    // high override bar, while relaxing strict protection for low-count lowercase non-words ("yogurt", "yasam").
    const realMarked = context.textHasMarks && realTyped;
    const relaxStrict =
      this.morphology !== undefined &&
      typed === word &&
      !realTyped &&
      typedCount < 70 &&
      this.lexicon.capitalShare(word) < 0.55;
    const strict = context.textHasMarks && (realTyped || (typedCount >= knownMarked && !relaxStrict));
    const override = realMarked ? markedOverride + 0.5 : markedOverride;

    const variants = markVariants(word);
    const filterInvalidMarks =
      this.morphology !== undefined &&
      !isName &&
      !strict &&
      !realTyped &&
      !hasApostrophe &&
      variants.some((variant) => this.lexicon.count(variant) > 0 && this.isRealWord(variant));

    const forms = [word, ...variants];
    let morphParticleHit = false;
    for (const form of forms) {
      const markCost = form === word ? 0 : cost.marks;
      if (form !== word) {
        let blockMark = false;
        let sameApostropheStem = false;
        if (hasApostrophe) {
          const formQuote = form.indexOf("'");
          const formStem = form.slice(0, formQuote);
          const formSuffix = form.slice(formQuote + 1);
          sameApostropheStem = formStem === wordStem;
          if (
            context.textHasMarks &&
            !sameApostropheStem &&
            (this.lexicon.count(wordStem) >= knownMarked || this.isRealWord(wordStem))
          ) {
            blockMark = true;
          }
          if (!blockMark && formSuffix !== wordSuffix) {
            const isInverseStem =
              this.morphology !== undefined && this.hasFrontLocative(formStem) && !this.hasBackLocative(formStem);
            if (!isHarmoniousApostropheMarkChange(formStem, wordSuffix, formSuffix, isInverseStem)) {
              blockMark = true;
            }
          }
        }
        if (!blockMark && !(filterInvalidMarks && !this.isRealWord(form))) {
          const count = this.lexicon.count(form);
          const score = log(count) - cost.marks;
          if (count > 0 && (!strict || score - typedScore >= override)) {
            const suffixOnlyApostrophe = hasApostrophe && typedCount === 0 && !strict && count >= 7 && sameApostropheStem;
            const threshold = suffixOnlyApostrophe ? Math.max(1.5, this.settings.threshold.marks - 1.0) : undefined;
            add(form, "marks", score, typedScore, threshold);
          }
        }
        if (strict) continue;
      }
      // A real word is not split ("kitabımı" is not "kitabı mı", "öyküsüz" stays). Listed misspellings
      // ("birşey", "yada") are handled before this, so they still get fixed.
      if (!(form === word && typedCount < knownWord && realTyped)) {
        const hit = this.addSplits(form, context, markCost, isName, capitalized, add);
        if (form === word && hit) morphParticleHit = true;
      }
      if (!form.includes("'")) {
        if (isName) this.addApostrophes(form, word, typedCount, typedScore, markCost, false, add);
        else if (capitalized && context.atSentenceStart) {
          this.addApostrophes(form, word, typedCount, typedScore, markCost, true, add);
        }
      }
    }

    // Unique morphologically valid mark restoration for unseen/rare lowercase invalid words ("yukleyince", "ezilmisti", "gidecegiz").
    if (
      this.morphology !== undefined &&
      !capitalized &&
      !strict &&
      !realTyped &&
      !hasApostrophe &&
      typedCount < 5 &&
      word.length >= 6 &&
      variants.length <= 128
    ) {
      const validVariants = variants.filter((variant) => this.isRealWord(variant));
      if (validVariants.length === 1) {
        const only = validVariants[0]!;
        const vCount = this.lexicon.count(only);
        const uniqueThreshold = Math.max(1.5, this.settings.threshold.marks - 1.0);
        if (vCount > 0) {
          const score = typedCount === 0 ? Math.max(log(vCount), 2.5) - cost.marks : log(vCount) - cost.marks;
          add(only, "marks", score, typedScore, uniqueThreshold);
        } else if (
          typedCount === 0 &&
          word.length >= 8 &&
          !hasTurkishMarks(word) &&
          this.isSafeUnseenMarkVariant(word, only, context)
        ) {
          add(only, "marks", 2.5 - cost.marks, typedScore, uniqueThreshold);
        }
      }
    }

    // Unambiguous internal vowel disharmony inside an apostrophe suffix ("Ukrayna'sinda" -> "Ukrayna'sında").
    if (hasApostrophe && typedCount === 0 && !strict) {
      const fixedSuffix = fixDisharmoniousApostropheSuffix(word);
      if (fixedSuffix) {
        add(
          fixedSuffix,
          "marks",
          Math.max(log(this.lexicon.count(fixedSuffix)), 3.0) - cost.marks,
          typedScore,
          Math.max(1.5, this.settings.threshold.marks - 1.0),
        );
      }
    }

    // Standalone question particle harmony in ASCII-typed sentences ("var mi" -> "var mı", "gördü mu" -> "gördü mü").
    if (!context.textHasMarks && context.prevWord && !context.prevIsName && context.prevWord.length >= 2) {
      this.addQuestionHarmony(word, context, typedScore, nextTyped, add);
    }

    // All-caps acronyms glued to a Turkish suffix ("HEXIMden" -> "HEXIM'den", "KDAların" -> "KDA'ların", "TLSnin" -> "TLS'nin").
    if (typedCount === 0 && !realTyped && !hasApostrophe) {
      const acronym = matchAcronymApostrophe(typed);
      if (acronym) {
        const prefixLower = lowerTr(acronym.prefix);
        if (this.lexicon.count(prefixLower) < 500 || this.lexicon.capitalShare(prefixLower) >= 0.5) {
          add(acronym.withMark, "apostrophe", 3.5 - cost.apostrophe, typedScore);
        }
      }
    }

    // Slips of the fingers are only considered for rare or unseen words that aren't names.
    // A rare form that Turkish suffix rules accept is a real word, not a slip ("getirsek" is not "getirmek").
    // Do not let single-edit typos hijack or tie a morphologically proven particle split ("boyunuda" -> "boyunu da").
    if (typedCount < knownWord && word.length >= 4 && !isName && !hasApostrophe && !realTyped && !morphParticleHit) {
      for (const [text, slipCost] of this.oneEdit(word)) {
        const count = this.lexicon.count(text);
        if (count > 0) add(text, "typo", log(count) - cost.typo - slipCost);
      }
    }
    return [...found.values()];
  }

  /** Restores "mi/mu/misin/..." marks from the preceding word's vowels in ASCII-typed sentences. */
  private addQuestionHarmony(
    word: string,
    context: WordContext,
    typedScore: number,
    nextTyped: string | undefined,
    add: AddCandidate,
  ) {
    const prev = context.prevWord;
    if (!prev || MUSIC_NOTES.has(prev) || !QUESTION.test(word)) return;
    if (nextTyped && MUSIC_AFTER.has(lowerTr(nextTyped))) return;
    const prevValid = this.morphology !== undefined ? this.isRealWord(prev) : this.lexicon.count(prev) >= 5;
    if (!prevValid || this.lexicon.capitalShare(prev) >= 0.55) return;
    const frontLoc = this.hasFrontLocative(prev);
    const backLoc = this.hasBackLocative(prev);
    if (frontLoc && backLoc) return;
    const lexFront = this.lexicon.count(prev + "de") + this.lexicon.count(prev + "te");
    const lexBack = this.lexicon.count(prev + "da") + this.lexicon.count(prev + "ta");
    const isInverse = frontLoc || (this.morphology === undefined && lexFront >= 3 && lexFront > lexBack);
    const target = harmonizeQuestionParticle(word, prev, isInverse);
    if (!target) return;
    const typedPair = this.lexicon.pair(prev, word);
    const targetPair = this.lexicon.pair(prev, target);
    if (typedPair > 0 && typedPair >= targetPair) return;
    const hasClue = context.questionAhead || QUESTION.exec(word)?.[2] !== undefined || targetPair > 0;
    if (!hasClue) return;
    add(target, "marks", typedScore + Math.max(this.settings.threshold.marks, 3.0), typedScore);
  }

  /** "birsey" -> "bir şey" from how often the pair is seen; "geldinmi", "arenasıda", "diyorki" from grammar and stem. */
  private addSplits(
    form: string,
    context: WordContext,
    markCost: number,
    isName: boolean,
    capitalized: boolean,
    add: AddCandidate,
  ): boolean {
    const { cost } = this.settings;
    const glued = this.lexicon.count(form);
    const formIsReal = this.morphology !== undefined && this.isRealWord(form);
    const isProperAtStart = capitalized && this.lexicon.capitalShare(form) >= 0.5;
    let morphParticleHit = false;
    for (let cut = 2; cut <= form.length - 2; cut++) {
      const first = form.slice(0, cut);
      const second = form.slice(cut);
      if (first.includes("'") || second.includes("'") || NEVER_ALONE.has(second)) continue;
      const pair = this.lexicon.pair(first, second);
      if (pair > 0) add(`${first} ${second}`, "split", log(pair) - cost.split - markCost);
      // A morphologically valid word ("giyside", "güveninde", "kitabımı", "evdeki") is never particle-split.
      if (formIsReal || glued >= this.settings.knownMarked || first.length < 3) continue;
      const stem = this.lexicon.count(first);
      const morphProven = this.morphology !== undefined && this.isRealWord(first);

      const question = QUESTION.exec(second);
      if (question && followsHarmony(first, question[1]![1]!) && sameHighVowels(second)) {
        const hasQuestionClue = context.questionAhead || question[2] !== undefined;
        if (hasQuestionClue) {
          if (
            morphProven &&
            (stem > 0 || first.length >= 6) &&
            (!isName || this.lexicon.capitalShare(first) < 0.5) &&
            !isProperAtStart
          ) {
            const score = (glued === 0 ? Math.max(log(stem), 3.2) : log(stem)) - cost.split - markCost;
            add(`${first} ${second}`, "split", score);
            if (first.length >= 4) morphParticleHit = true;
          } else if (stem > 0 && !isName) {
            add(`${first} ${second}`, "split", log(stem) - cost.split - markCost - 1);
          }
        } else if (
          morphProven &&
          !isName &&
          !isProperAtStart &&
          first.length >= 4 &&
          glued < this.settings.knownWord &&
          stem > 0 &&
          this.lexicon.capitalShare(first) < 0.5
        ) {
          add(`${first} ${second}`, "split", log(stem) - cost.split - markCost);
          morphParticleHit = true;
        }
        continue;
      }

      if (ALSO.test(second) && followsHarmony(first, second[1]!) && !isName && !isProperAtStart) {
        const voicingTypo =
          this.morphology !== undefined &&
          isVoicelessFinal(first) &&
          this.isRealWord(first + (second === "de" ? "te" : "ta"));
        const inverseHarmonyTypo =
          this.morphology !== undefined &&
          second === "da" &&
          this.hasFrontLocative(first);
        const collapsed = collapsedDoubledLocative(first, second);
        const doubledLocativeTypo =
          collapsed !== null &&
          this.lexicon.count(collapsed) >= 20 &&
          this.lexicon.count(collapsed) >= Math.max(stem, 1) * 10 &&
          (this.morphology === undefined || this.isRealWord(collapsed));
        if (voicingTypo || inverseHarmonyTypo || doubledLocativeTypo) continue;
        if (morphProven && (stem > 0 || first.length >= 6)) {
          const score = (glued === 0 ? Math.max(log(stem), 3.2) : log(stem)) - cost.split - markCost;
          add(`${first} ${second}`, "split", score);
          if (first.length >= 4) morphParticleHit = true;
        } else if (stem > 0 && NO_LOCATIVE_AFTER.test(first)) {
          const score =
            this.morphology !== undefined && glued === 0 && stem >= 3 && STRONG_NO_LOCATIVE_AFTER.test(first)
              ? Math.max(log(stem), 3.2) - cost.split - markCost
              : log(stem) - cost.split - markCost - 1;
          add(`${first} ${second}`, "split", score);
        }
        continue;
      }

      if (second === "ki" && first.length >= 4 && !isName && !isProperAtStart) {
        if (morphProven && (stem > 0 || first.length >= 6)) {
          const score = (glued === 0 ? Math.max(log(stem), 3.2) : log(stem)) - cost.split - markCost;
          add(`${first} ${second}`, "split", score);
          morphParticleHit = true;
        } else if (stem > 0 && FINITE.test(first)) {
          add(`${first} ${second}`, "split", log(stem) - cost.split - markCost - 1);
        }
      }
    }
    return morphParticleHit;
  }

  /** "Ankaraya" -> "Ankara'ya" when the form is seen, or when "ankara" is a name and "ya" a suffix that takes one. */
  private addApostrophes(
    form: string,
    word: string,
    typedCount: number,
    typedScore: number,
    markCost: number,
    atSentenceStart: boolean,
    add: AddCandidate,
  ) {
    const { cost, minName } = this.settings;
    const formCount = form === word ? typedCount : this.lexicon.count(form);
    const typedCaps = Math.round(typedCount * this.lexicon.capitalShare(word));
    for (let cut = 2; cut < form.length; cut++) {
      const stem = form.slice(0, cut);
      const suffix = form.slice(cut);
      const withMark = `${stem}'${suffix}`;
      const seen = this.lexicon.count(withMark);
      if (seen > 0) {
        if (atSentenceStart) {
          if (
            this.lexicon.capitalShare(withMark) >= 0.7 &&
            this.lexicon.capitalShare(stem) >= 0.55 &&
            !TIME_NAMES_NO_START_APOSTROPHE.has(stem) &&
            !hasBlockedApostropheStem(stem) &&
            !this.isInflectedApostropheStem(stem)
          ) {
            add(withMark, "apostrophe", log(seen) - cost.apostrophe - markCost, typedScore);
          }
          continue;
        }
        add(withMark, "apostrophe", log(seen) - cost.apostrophe - markCost, typedScore);
        // Mid-sentence, compare capitalized-mid-sentence counts too so a lowercase homograph ("elifin", "ekimde",
        // "aşilin") does not hide a clear proper-name apostrophe.
        const seenCaps = Math.round(seen * this.lexicon.capitalShare(withMark));
        if (
          seenCaps >= 10 &&
          seenCaps / seen >= 0.5 &&
          this.lexicon.capitalShare(stem) >= 0.5 &&
          !hasBlockedApostropheStem(stem) &&
          !this.isInflectedApostropheStem(stem)
        ) {
          add(withMark, "apostrophe", log(seenCaps) - cost.apostrophe - markCost, log(typedCaps));
        }
      }
      if (atSentenceStart) continue;
      // The generic rule only applies to unseen forms of clear names, keeping the suffix as typed so a mark variant
      // of the suffix cannot compete with itself ("Weeknd'in" vs fake "Weeknd'ın").
      const stemCount = this.lexicon.count(stem);
      if (
        formCount === 0 &&
        stem.length >= 3 &&
        stemCount >= minName &&
        suffix === word.slice(cut) &&
        isValidGenericApostrophe(stem, suffix) &&
        !this.isInflectedApostropheStem(stem)
      ) {
        const share = this.lexicon.capitalShare(stem);
        if (suffix.length >= 2 && share >= 0.58) {
          add(withMark, "apostrophe", log(stemCount) - cost.apostrophe - markCost - 0.2, typedScore);
        } else if (suffix.length === 1 && share >= 0.75) {
          add(withMark, "apostrophe", log(stemCount) - cost.apostrophe - markCost - 1.2, typedScore);
        }
      }
    }
  }

  /** "hiç bir" -> "hiçbir", "oysa ki" -> "oysaki", "ev de" -> "evde". Compared with how often the two words appear apart. */
  private joinCandidate(word: string, next: string): Candidate | null {
    if (word.includes("'") || next.includes("'")) return null;
    if (word === "her" && next !== "hangi" && next !== "kes") return null;
    if (!JOIN_FIRST.has(word) && !JOIN_SECOND.has(next)) return null;
    const joined = word + next;
    const count = this.lexicon.count(joined);
    if (count === 0) return null;
    // Lowercase joins must not accidentally form a proper noun ("bu şehr" -> "buşehr", "o dile" -> "odile").
    if (this.lexicon.capitalShare(joined) >= 0.5) return null;
    const isSombahcemi = next === "ki" && SOMBAHCEMI_KI.has(word);
    // Do not join into a morphologically invalid word ("İkinizin de" -> "İkinizinde", "Her neyse" -> "Herneyse").
    if (this.morphology !== undefined && this.isRealWord(word) && !this.isRealWord(joined) && !isSombahcemi) return null;
    if (ALSO.test(next)) {
      if (isVoicelessFinal(word) || /(?:[ıiuü]n[ıiuü]z|[ıiuü]m[ıiuü]z)[ıiuü]n$/.test(word)) return null;
      if (this.morphology === undefined && !followsHarmony(word, next[1]!)) return null;
    }
    if ((next === "te" || next === "ta") && TE_TA_SKIP.has(word)) return null;
    const pair = this.lexicon.pair(word, next);
    // "de/da" after a word is far more often the conjunction in everyday writing than a misplaced locative, so
    // joining it needs a clearer case than other joins.
    const extra = ALSO.test(next) ? this.settings.deDaJoinCost : 0;
    let threshold: number | undefined;
    if (isSombahcemi && pair === 0) {
      threshold = Math.max(1.0, this.settings.threshold.join - 1.5);
    } else if (next === "ki" && /[dt][ae]$/.test(word) && pair <= 1 && (this.morphology === undefined || this.isRealWord(joined))) {
      threshold = Math.max(1.8, this.settings.threshold.join - 0.7);
    } else if ((next === "te" || next === "ta") && pair === 0 && (this.morphology !== undefined ? this.isRealWord(joined) : isVoicelessFinal(word))) {
      threshold = Math.max(2.0, this.settings.threshold.join - 0.5);
    }
    return {
      text: joined,
      kind: "join",
      score: log(count) - this.settings.cost.join - extra,
      base: log(pair),
      joinsNext: true,
      threshold,
    };
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
