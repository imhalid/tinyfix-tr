import { buildContextFeatures, type ContextKind, type ContextModel, type TypoCandidateMeta } from "./context.ts";
import type { KnownMisspellings } from "./known.ts";
import { Lexicon } from "./lexicon.ts";
import { applySentenceRules } from "./sentence.ts";
import { turkishEditCost, type FuzzyMorphCandidate } from "./morphology/fuzzy.ts";
import {
  ALSO,
  COMPOUND_VERB_JOINS,
  FINITE,
  HONORIFIC_TITLES,
  JOIN_FIRST,
  JOIN_SECOND,
  JOINED_ETMEK_STEMS,
  MUSIC_AFTER,
  MUSIC_NOTES,
  NEVER_ALONE,
  NO_LOCATIVE_AFTER,
  QUESTION,
  SEPARATE_ETMEK_BARE_IMPERATIVE,
  SEPARATE_ETMEK_SHORT,
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
  isPlaceApostropheHead,
  isValidGenericApostrophe,
  isValidPlaceApostrophe,
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

/** Why an untouched word was flagged as a likely misspelling. */
export type FlagReason = "invalid" | "rare";

/** A suspicious word left untouched by auto-fix, with ranked suggestions (up to 5). */
export interface SpellFlag {
  start: number;
  end: number;
  original: string;
  suggestions: string[];
  reason: FlagReason;
}

/** Tells whether a lowercase form is a real Turkish word by its suffixes (src/morphology). */
export interface WordValidator {
  isWord(form: string): boolean;
  analyze?(form: string): readonly WordAnalysis[];
  priorCount?(form: string): number;
  fuzzySearch?(form: string, maxEdits?: number, maxResults?: number): readonly FuzzyMorphCandidate[];
}

/** contraction: a spoken-style contraction spelled out ("noldu" -> "ne oldu"), only when Settings.contractions is on. */
/** punct: sentence punctuation and capitals ("merhaba.ben" -> "Merhaba. Ben"), only when Settings.sentenceCase is on. */
export type CandidateKind = "marks" | "apostrophe" | "split" | "join" | "typo" | "known" | "context" | "contraction" | "punct";

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
  /**
   * Add a missing space after a sentence end and capitalize the first word of a sentence ("merhaba.ben" ->
   * "Merhaba. Ben"). Off in the bench settings so earlier measurements stay comparable; the package turns it on.
   */
  sentenceCase: boolean;
  /** Threshold for a slip-of-the-fingers fix when the typed word is unseen and the morphology layer rejects it. */
  typoInvalidThreshold: number;
  /** Extra cost for joining a word with a following "de/da" ("yerler de" -> "yerlerde"). */
  deDaJoinCost: number;
  /** A slip in the last this many letters of a word costs typoEndCost more: those letters are usually a suffix. */
  typoEndWindow: number;
  typoEndCost: number;
  /**
   * For an unseen word that Turkish rules reject: cost of reading a letter as an extra key when it is neither a duplicate
   * nor a keyboard neighbor ("ağldı" is a missed "a" in "ağladı", not a stray "ğ" in "aldı").
   */
  typoFarExtra: number;
  /** For an unseen invalid word: cost of one vowel typed for another ("nuler" -> "neler"); 0 turns it off. */
  typoVowelSwap: number;
  /**
   * For an unseen invalid word: a rare valid inflected form borrows this share of its stem's count ("arkadaşlarımla"
   * from "arkadaşlarım"), so long correct forms aren't lost for being rare as a whole; 0 turns it off.
   */
  typoStemShare: number;
  /** Minimum count for an adjacent-swap fix of an unseen-looking 3-letter word ("bka" -> "bak"). */
  shortSwapMinCount: number;
  /** Real words seen at least this often are judged by the context model when one is loaded. */
  contextWord: number;
  /** A count-based fix is dropped when the context model prefers what was typed by at least this much. */
  contextVeto: number;
  /** Minimum context-model margin over core's typo pick to switch to a competing valid typo candidate. */
  contextTypoOverride?: number;
  /** Minimum context-model margin between best and runner-up to resolve an ambiguous untouched typo. */
  contextTypoAmbigGap?: number;
  /** Minimum context-model margin over the invalid typed word to resolve an ambiguous untouched typo. */
  contextTypoAmbigVsTyped?: number;
  /** Minimum context-model margin over the invalid typed word to rescue a below-threshold typo candidate. */
  contextTypoRescue?: number;
  /** Per-regime additive offsets on top of `threshold.context`. */
  contextOffsets?: {
    marksAscii?: number;
    marksMarked?: number;
    marksMarkedOnMarked?: number;
    deDaSplit?: number;
    deDaJoin?: number;
    kiSplit?: number;
    kiJoin?: number;
    miSplit?: number;
    miJoin?: number;
  };
  /** In text that already uses Turkish letters, a word seen this often is taken as meant ("uç" stays "uç")... */
  knownMarked: number;
  /** ...unless the marked form is this much more common (log ratio): "cogu" is still "çoğu". */
  markedOverride: number;
  /** A name must be seen this often, mostly capitalized, before a suffix after it gets an apostrophe. */
  minName: number;
}

export const CAREFUL: Settings = {
  threshold: { marks: 2.5, apostrophe: 2.5, split: 2.5, join: 2.5, typo: 3, known: 1, context: 3, contraction: 1, punct: 1 },
  cost: { marks: 0.5, apostrophe: 0.5, split: 0.5, join: 0.5, typo: 2, known: 0, context: 0, contraction: 0, punct: 0 },
  ambiguity: 1,
  knownWord: 3,
  contractions: false,
  sentenceCase: false,
  typoInvalidThreshold: 1.5,
  deDaJoinCost: 0,
  typoEndWindow: 2,
  typoEndCost: 1,
  typoFarExtra: 3,
  typoVowelSwap: 1.2,
  typoStemShare: 0,
  shortSwapMinCount: 300,
  contextWord: 5,
  contextVeto: 6.0,
  contextTypoOverride: 1.2,
  contextTypoAmbigGap: 1.25,
  contextTypoAmbigVsTyped: 1.5,
  contextTypoRescue: 2.5,
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
  slipCost?: number;
}

type AddCandidate = (text: string, kind: CandidateKind, score: number, base?: number, threshold?: number, slipCost?: number) => void;

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
  /** True when the previous word started with an uppercase letter (including sentence start). */
  prevCapitalized?: boolean;
  /** True when the next word token is isolated (not glued to hyphens, digits, dots, etc.). */
  nextIsolated?: boolean;
  /** True when another word in the same sentence is unmistakably Turkish typed without marks. */
  sentenceHasAsciiTurkish?: boolean;
}

const VOICING_PAIRS = new Set(["dt", "td", "bp", "pb", "cç", "çc", "gk", "kg", "gğ", "ğg"]);
const VOWELS = new Set(["a", "e", "ı", "i", "o", "ö", "u", "ü"]);
const FINITE_VERB_MORPHEMES = new Set(["Prog1", "Prog2", "Past", "Narr", "Fut", "Aor", "Opt", "Desr", "Neces", "Imp"]);
/** Pronoun + "de" written as one word, with the verb person that proves it is the conjunction "de". */
const PRONOUN_DE: Record<string, string> = { bende: "A1sg", sende: "A2sg", bizde: "A1pl", sizde: "A2pl" };
const NON_FINITE_DERIVATIONS =new Set(["PastPart", "NarrPart", "FutPart", "PresPart", "AorPart", "Inf1", "Inf2", "Inf3"]);
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
/** Productive Turkish nominal suffixes allowed on attested OOV loanword/compound roots missing from Zemberek ("özgeçmişimi", "tripodlar"). */
const OOV_NOMINAL_SUFFIX =
  /^(?:l[ae]r(?:(?:[ıiuü]m(?:[ıiuü]z)?|[ıiuü]n(?:[ıiuü]z)?|[ıiuü])(?:n?[dt][ae]n?|n?[dt][ae]ki|n?[aeıiuü]|n[ıiuü]n|y?l[ae])?|[dt][ae]n?|[dt][ae]ki|[ıiuü]n|[aeıiuü]|l[ae])?|(?:[ıiuü]m(?:[ıiuü]z)?|[ıiuü]n(?:[ıiuü]z)?|s?[ıiuü])(?:n?[dt][ae]n?|n?[dt][ae]ki|n?[aeıiuü]|n[ıiuü]n|y?l[ae])?|[dt][ae]n?|[dt][ae]ki|n?[ıiuü]n|y?[aeıiuü]|y?l[ae]|l[ıiuü]k?)(?:[dt][ıiuü]r|y?[dt][ıiuü]|y?m[ıiuü]ş)?$/;
/** Latin/scientific taxonomic or clearly foreign suffix patterns that shouldn't be flagged when no close Turkish candidate exists. */
const FOREIGN_TAXONOMIC_SUFFIX =
  /(?:idae|aceae|inae|formes|ensis|oides|phyllus|flora|saurus|stoma|poda|comulus|ischer|lichkeit|hausen|shire|burgh|stadt|field|worth|ingham)$/;

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

const FOLD_TR: Record<string, string> = { ç: "c", ğ: "g", ı: "i", ö: "o", ş: "s", ü: "u", â: "a", î: "i", û: "u" };
const foldTr = (word: string) => word.replace(/[çğıöşüâîû]/g, (ch) => FOLD_TR[ch] ?? ch);
/** TDK SOMBAHCEMİ words that are always written joined and must never be split by the context model. */
const FIXED_KI_WORDS = new Set(["oysaki", "halbuki", "mademki", "meğerki", "illaki", "sanki", "belki", "çünkü"]);

export interface CorrectOptions {
  /**
   * [start, end) ranges whose Turkish letters were put there by autocorrect, not typed by the user. They don't count
   * as evidence that the user types with Turkish letters, so "hic bir sey" still gets "sey" fixed after "hiç" was.
   */
  autoMarked?: readonly (readonly [number, number])[];
  /**
   * Optional original typed tokens for spans already rewritten by an earlier core typing pass (e.g. "hber" -> "her"),
   * allowing the background context pass to re-evaluate the original typo once the full sentence is available.
   */
  priorTypoOriginals?: readonly { readonly start: number; readonly end: number; readonly original: string }[];
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

  /** True when a -ca/-ce/-ça/-çe stem is derived from a proper/nationality stem ("Danimarkaca", "Türkçe", "Hırvatça"). */
  private isDerivedLanguageStem(stem: string): boolean {
    if (stem.length < 5 || !/[cç][ae]$/.test(stem)) return false;
    const analyses = this.morphology?.analyze?.(stem);
    if (!analyses || analyses.length === 0) return false;
    return analyses.some(
      (analysis) =>
        analysis.morphemes.includes("Equ") &&
        analysis.stem !== stem &&
        this.lexicon.capitalShare(analysis.stem) >= 0.45,
    );
  }

  /** True when a stem is blocked from taking an apostrophe by TDK rules (respecting morphology for -ca/-ce names like "Karaca"). */
  private isBlockedApostropheStem(stem: string, allowPlaceHead = false): boolean {
    if (this.morphology !== undefined) {
      if (hasBlockedApostropheStem(stem, true, allowPlaceHead)) return true;
      return this.isDerivedLanguageStem(stem);
    }
    return hasBlockedApostropheStem(stem, false, allowPlaceHead);
  }

  /** True when a form has a bare Noun/Adj/Adv root analysis (used for separate Noun+etmek compound verb splits). */
  private isBareNominalRoot(word: string): boolean {
    const analyses = this.morphology?.analyze?.(word);
    if (!analyses || analyses.length === 0) return false;
    return analyses.some(
      (a) =>
        (a.pos === "Noun" || a.pos === "Adj" || a.pos === "Adv") &&
        (a.morphemes.length === 0 || (a.morphemes.length === 1 && a.morphemes[0] === "A3sg")),
    );
  }

  /** True when `word` is an inflected verb form of `auxStem` ("et", "ol", "geç", "vur", ...). */
  private isVerbFormOf(word: string, auxStem: string): boolean {
    const analyses = this.morphology?.analyze?.(word);
    if (!analyses || analyses.length === 0) return false;
    return analyses.some((a) => a.pos === "Verb" && a.stem === auxStem);
  }

  /** True when `word` has a finite conjugated verb analysis (never part of an OOV noun compound). */
  private isFiniteVerb(word: string): boolean {
    const analyses = this.morphology?.analyze?.(word);
    if (!analyses || analyses.length === 0) return false;
    return analyses.some(
      (a) =>
        a.pos === "Verb" &&
        a.morphemes.some((m) => FINITE_VERB_MORPHEMES.has(m)) &&
        !a.morphemes.some((m) => NON_FINITE_DERIVATIONS.has(m)),
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

  private withSentenceRules(text: string, corrections: Correction[]): Correction[] {
    return applySentenceRules(
      text,
      corrections,
      (lower) => this.isRealWord(lower) || this.lexicon.exactCount(lower) >= 20,
      (lower, common) => this.known?.nameFor(lower, common ? 1500 : 0),
      (lower) => {
        const analyses = this.morphology?.analyze?.(lower);
        return analyses ? analyses.map((analysis) => lowerTr(analysis.stem)) : null;
      },
    );
  }

  /** Returns the corrected text and the list of changes made. */
  correct(text: string, options: CorrectOptions = {}): { text: string; corrections: Correction[] } {
    const { text: corrected, corrections } = this.runCorePass(text, options, false);
    return { text: corrected, corrections };
  }

  /**
   * Like correct(), but also flags every suspicious untouched word (rejected by morphology or very rare near a
   * much stronger valid word) with up to 5 ranked suggestions.
   */
  inspect(text: string, options: CorrectOptions = {}): { text: string; corrections: Correction[]; flags: SpellFlag[] } {
    return this.runCorePass(text, options, true);
  }

  private runCorePass(
    text: string,
    options: CorrectOptions,
    collectFlags: boolean,
  ): { text: string; corrections: Correction[]; flags: SpellFlag[] } {
    const tokens = tokenize(text);
    const corrections: Correction[] = [];
    const flags: SpellFlag[] = [];
    const evidence = stripMarksIn(text, options.autoMarked ?? []);
    const textHasMarks = hasTurkishMarks(evidence);
    const { asciiTyped, sentenceOf } = this.asciiEvidence(tokenize(evidence));
    let atSentenceStart = true;
    let prevWord: string | undefined;
    let prevIsName = false;
    let prevCapitalized = false;
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index]!;
      if (!token.isWord) {
        if (SENTENCE_END.has(token.text) || token.text.includes("\n")) atSentenceStart = true;
        else if (/\d/.test(token.text)) atSentenceStart = false;
        if (token.text !== " ") {
          prevWord = undefined;
          prevIsName = false;
          prevCapitalized = false;
        }
        continue;
      }
      const next = this.nextWord(tokens, index);
      const sentenceHasAsciiTurkish =
        !textHasMarks && asciiTyped.some((other) => other !== index && sentenceOf[other] === sentenceOf[index]);
      const context: WordContext = {
        atSentenceStart,
        textHasMarks:
          textHasMarks &&
          hasTurkishMarks(evidence.slice(0, token.start) + evidence.slice(token.end)) &&
          !asciiTyped.some((other) => other !== index && sentenceOf[other] === sentenceOf[index]),
        questionAhead: this.questionAhead(tokens, index),
        prevWord,
        prevIsName,
        prevCapitalized,
        nextIsolated: next ? this.isIsolated(tokens, next.index) : false,
        sentenceHasAsciiTurkish,
      };
      atSentenceStart = false;
      if (!this.isIsolated(tokens, index)) {
        prevWord = undefined;
        prevIsName = false;
        prevCapitalized = false;
        continue;
      }
      const fix = this.check(token.text, context, next?.token.text);
      if (!fix) {
        if (collectFlags) {
          const flag = this.detectFlag(token, context, next?.token.text);
          if (flag) flags.push(flag);
        }
        prevWord = lowerTr(token.text);
        prevIsName = !context.atSentenceStart && isUpperInitial(token.text);
        prevCapitalized = isUpperInitial(token.text);
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
      prevCapitalized = isUpperInitial(trailing);
      if (fix.joinsNext && next) index = next.index;
    }
    if (this.settings.sentenceCase) corrections.splice(0, corrections.length, ...this.withSentenceRules(text, corrections));
    let output = "";
    let cursor = 0;
    for (const correction of corrections) {
      output += text.slice(cursor, correction.start) + correction.replacement;
      cursor = correction.end;
    }
    return { text: output + text.slice(cursor), corrections, flags };
  }

  /**
   * Like correct(), but contested real-word ambiguities ("bende" / "ben de", "oldu" / "öldü", "sevgimi" / "sevgi mi")
   * and ambiguous/contested typo candidates ("yllar" -> "yıllar"/"yollar", "hber" -> "her"/"haber") are scored in
   * sentence context by the context model. Core behavior without a context model is unchanged.
   */
  async correctAsync(
    text: string,
    model: ContextModel,
    options: CorrectOptions = {},
  ): Promise<{ text: string; corrections: Correction[] }> {
    const { text: corrected, corrections } = await this.runAsyncPass(text, model, options, false);
    return { text: corrected, corrections };
  }

  /**
   * Like inspect(), using the context model both to resolve ambiguities and to re-rank flag suggestions in sentence context.
   */
  async inspectAsync(
    text: string,
    model: ContextModel,
    options: CorrectOptions = {},
  ): Promise<{ text: string; corrections: Correction[]; flags: SpellFlag[] }> {
    return this.runAsyncPass(text, model, options, true);
  }

  private async runAsyncPass(
    text: string,
    model: ContextModel,
    options: CorrectOptions,
    collectFlags: boolean,
  ): Promise<{ text: string; corrections: Correction[]; flags: SpellFlag[] }> {
    const tokens = tokenize(text);
    const evidence = stripMarksIn(text, options.autoMarked ?? []);
    const textHasMarks = hasTurkishMarks(evidence);
    const { asciiTyped, sentenceOf } = this.asciiEvidence(tokenize(evidence));
    const priorTypoByStart = new Map<number, { start: number; end: number; original: string }>();
    if (options.priorTypoOriginals) {
      for (const item of options.priorTypoOriginals) priorTypoByStart.set(item.start, item);
    }
    const decided: Correction[] = [];
    const pending: {
      start: number;
      end: number;
      typed: string;
      /** Text currently in `text.slice(start, end)` (differs from `typed` only for priorTypoOriginals). */
      surfaceOriginal: string;
      alternatives: string[];
      kind: ContextKind;
      direction: "marks" | "split" | "join" | "typo";
      typoMode?: "override" | "ambiguous" | "rescue";
      coreReplacement?: string;
      typoMeta?: TypoCandidateMeta[];
      asciiContext: boolean;
      typedHasMarks: boolean;
    }[] = [];
    let atSentenceStart = true;
    let prevWord: string | undefined;
    let prevIsName = false;
    let prevCapitalized = false;
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index]!;
      if (!token.isWord) {
        if (SENTENCE_END.has(token.text) || token.text.includes("\n")) atSentenceStart = true;
        else if (/\d/.test(token.text)) atSentenceStart = false;
        if (token.text !== " ") {
          prevWord = undefined;
          prevIsName = false;
          prevCapitalized = false;
        }
        continue;
      }
      const next = this.nextWord(tokens, index);
      const sentenceHasAsciiTurkish =
        !textHasMarks && asciiTyped.some((other) => other !== index && sentenceOf[other] === sentenceOf[index]);
      const context: WordContext = {
        atSentenceStart,
        textHasMarks:
          textHasMarks &&
          hasTurkishMarks(evidence.slice(0, token.start) + evidence.slice(token.end)) &&
          !asciiTyped.some((other) => other !== index && sentenceOf[other] === sentenceOf[index]),
        questionAhead: this.questionAhead(tokens, index),
        prevWord,
        prevIsName,
        prevCapitalized,
        nextIsolated: next ? this.isIsolated(tokens, next.index) : false,
        sentenceHasAsciiTurkish,
      };
      atSentenceStart = false;
      if (!this.isIsolated(tokens, index)) {
        prevWord = undefined;
        prevIsName = false;
        prevCapitalized = false;
        continue;
      }
      for (const option of this.contestedSpans(token, next?.token, context, tokens, index)) {
        pending.push({ ...option, surfaceOriginal: option.typed });
      }
      const fix = this.check(token.text, context, next?.token.text);
      const asciiContext = !context.textHasMarks || Boolean(context.sentenceHasAsciiTurkish);

      // Re-evaluate a word previously rewritten as a typo during live typing (pause-pass override).
      const priorTypo = priorTypoByStart.get(token.start);
      if (priorTypo && priorTypo.end === token.end && !fix) {
        const typoCands = this.typoCandidatesFor(priorTypo.original, context, next?.token.text, 7);
        if (typoCands.length >= 2) {
          const alts = typoCands.map((c) => (c.kind === "typo" ? matchCase(priorTypo.original, c.text) : keepCase(priorTypo.original, c.text)));
          if (alts.some((alt) => lowerTr(alt) === lowerTr(token.text))) {
            pending.push({
              start: token.start,
              end: token.end,
              typed: priorTypo.original,
              surfaceOriginal: token.text,
              alternatives: alts,
              kind: "typo",
              direction: "typo",
              typoMode: "override",
              coreReplacement: token.text,
              typoMeta: [
                { coreMargin: 0, slipCost: 0, isMarkVariant: false },
                ...typoCands.map((c) => ({ coreMargin: c.margin, slipCost: c.slipCost, isMarkVariant: c.isMarkVariant })),
              ],
              asciiContext,
              typedHasMarks: hasTurkishMarks(priorTypo.original),
            });
          }
        }
      }

      // Contested or rescued typo candidates for invalid/rare words.
      const typoCands = this.typoCandidatesFor(token.text, context, next?.token.text, 7);
      if (typoCands.length > 0) {
        const word = lowerTr(token.text);
        const typedCount = this.lexicon.count(word);
        const alts = typoCands.map((c) => (c.kind === "typo" ? matchCase(token.text, c.text) : keepCase(token.text, c.text)));
        const meta: TypoCandidateMeta[] = [
          { coreMargin: 0, slipCost: 0, isMarkVariant: false },
          ...typoCands.map((c) => ({ coreMargin: c.margin, slipCost: c.slipCost, isMarkVariant: c.isMarkVariant })),
        ];
        if (
          fix &&
          !fix.joinsNext &&
          typoCands.length >= 2 &&
          fix.kind === "typo" &&
          alts.some((alt) => lowerTr(alt) === lowerTr(fix.replacement))
        ) {
          pending.push({
            start: token.start,
            end: token.end,
            typed: token.text,
            surfaceOriginal: token.text,
            alternatives: alts,
            kind: "typo",
            direction: "typo",
            typoMode: "override",
            coreReplacement: fix.replacement,
            typoMeta: meta,
            asciiContext,
            typedHasMarks: hasTurkishMarks(word),
          });
        } else if (!fix) {
          const top = typoCands[0]!;
          if (typoCands.length >= 2 && (top.margin >= top.threshold || (typedCount === 0 && top.margin >= 0))) {
            pending.push({
              start: token.start,
              end: token.end,
              typed: token.text,
              surfaceOriginal: token.text,
              alternatives: alts,
              kind: "typo",
              direction: "typo",
              typoMode: "ambiguous",
              typoMeta: meta,
              asciiContext,
              typedHasMarks: hasTurkishMarks(word),
            });
          } else if (typedCount === 0 && token.text === word && top.margin >= -0.5) {
            pending.push({
              start: token.start,
              end: token.end,
              typed: token.text,
              surfaceOriginal: token.text,
              alternatives: alts,
              kind: "typo",
              direction: "typo",
              typoMode: "rescue",
              typoMeta: meta,
              asciiContext,
              typedHasMarks: hasTurkishMarks(word),
            });
          }
        }
      }

      if (!fix) {
        prevWord = lowerTr(token.text);
        prevIsName = !context.atSentenceStart && isUpperInitial(token.text);
        prevCapitalized = isUpperInitial(token.text);
        continue;
      }
      const end = fix.joinsNext && next ? next.token.end : token.end;
      decided.push({ start: token.start, end, original: text.slice(token.start, end), replacement: fix.replacement, kind: fix.kind, margin: fix.margin });
      const trailing = lastSpaceWord(fix.replacement);
      prevWord = lowerTr(trailing);
      prevIsName = !(context.atSentenceStart && !fix.replacement.includes(" ")) && isUpperInitial(trailing);
      prevCapitalized = isUpperInitial(trailing);
      if (fix.joinsNext && next) index = next.index;
    }

    // Build core-restored surrounding context so ASCII/multi-typo sentences give the context model clean neighbors.
    const contextSlice = (spanStart: number, spanEnd: number): { left: string; right: string } => {
      const leftFrom = Math.max(0, spanStart - 180);
      const rightTo = Math.min(text.length, spanEnd + 150);
      if (decided.length === 0) {
        return { left: text.slice(leftFrom, spanStart), right: text.slice(spanEnd, rightTo) };
      }
      let left = "";
      let cur = leftFrom;
      for (const d of decided) {
        if (d.end <= leftFrom) continue;
        if (d.start >= spanStart) break;
        if (d.start < cur || d.end > spanStart) continue;
        left += text.slice(cur, d.start) + d.replacement;
        cur = d.end;
      }
      left += text.slice(cur, spanStart);
      let right = "";
      cur = spanEnd;
      for (const d of decided) {
        if (d.end <= spanEnd) continue;
        if (d.start >= rightTo) break;
        if (d.start < cur || d.end > rightTo) continue;
        right += text.slice(cur, d.start) + d.replacement;
        cur = d.end;
      }
      right += text.slice(cur, rightTo);
      return { left, right };
    };

    const scores = await model.score(
      pending.map((option) => {
        const candidates = [option.typed, ...option.alternatives];
        const { left, right } = contextSlice(option.start, option.end);
        return {
          left,
          right,
          candidates,
          features: buildContextFeatures(
            candidates,
            option.kind,
            option.asciiContext,
            this.lexicon,
            this.morphology,
            option.typoMeta,
          ),
        };
      }),
    );
    const overlaps = (a: { start: number; end: number }, b: { start: number; end: number }) => a.start < b.end && b.start < a.end;

    const typoOverrideBar = this.settings.contextTypoOverride ?? 2.5;
    const typoAmbigGap = this.settings.contextTypoAmbigGap ?? 1.5;
    const typoAmbigVsTyped = this.settings.contextTypoAmbigVsTyped ?? 2.5;
    const typoRescueBar = this.settings.contextTypoRescue ?? 4.5;

    // 1. Keep core fixes, allowing (a) contextVeto on count-based join/split, and (b) high-confidence context switch
    //    between competing valid typo candidates (e.g. "hber": core "her" -> context "haber").
    const kept: Correction[] = [];
    for (const fix of decided) {
      if (fix.kind === "join" || fix.kind === "split") {
        const index = pending.findIndex(
          (option) =>
            option.kind !== "typo" &&
            option.start === fix.start &&
            option.end === fix.end &&
            option.alternatives.some((alt) => lowerTr(alt) === lowerTr(fix.replacement)),
        );
        if (index !== -1) {
          const row = scores[index]!;
          const option = pending[index]!;
          const alternative = option.alternatives.findIndex((alt) => lowerTr(alt) === lowerTr(fix.replacement));
          if (row[alternative + 1]! - row[0]! <= -this.settings.contextVeto) continue;
        }
        kept.push(fix);
        continue;
      }
      const overrideIdx = pending.findIndex(
        (option) => option.kind === "typo" && option.typoMode === "override" && option.start === fix.start && option.end === fix.end,
      );
      if (overrideIdx !== -1) {
        const option = pending[overrideIdx]!;
        const row = scores[overrideIdx]!;
        const coreAltIdx = option.alternatives.findIndex((alt) => lowerTr(alt) === lowerTr(fix.replacement));
        if (coreAltIdx !== -1) {
          let bestAlt = coreAltIdx;
          for (let i = 0; i < option.alternatives.length; i++) {
            if (row[i + 1]! > row[bestAlt + 1]!) bestAlt = i;
          }
          const delta = row[bestAlt + 1]! - row[coreAltIdx + 1]!;
          if (bestAlt !== coreAltIdx && delta >= typoOverrideBar) {
            kept.push({
              start: fix.start,
              end: fix.end,
              original: fix.original,
              replacement: option.alternatives[bestAlt]!,
              kind: "context",
              margin: delta,
            });
            continue;
          }
        }
      }
      kept.push(fix);
    }

    // 2. Where no core fix touches a span (or for priorTypoOriginals in pause-pass), apply confident context decisions.
    const offsets = this.settings.contextOffsets;
    const thresholdFor = (option: (typeof pending)[number]) => {
      const base = this.settings.threshold.context;
      if (!offsets) return base;
      if (option.kind === "marks") {
        if (option.asciiContext) return base + (offsets.marksAscii ?? 0);
        return base + (option.typedHasMarks ? (offsets.marksMarkedOnMarked ?? 3.0) : (offsets.marksMarked ?? 1.5));
      }
      if (option.kind === "de_da") return base + (option.direction === "split" ? (offsets.deDaSplit ?? 0) : (offsets.deDaJoin ?? 0));
      if (option.kind === "ki") return base + (option.direction === "split" ? (offsets.kiSplit ?? 0) : (offsets.kiJoin ?? 0));
      return base + (option.direction === "split" ? (offsets.miSplit ?? 0) : (offsets.miJoin ?? 0));
    };
    const judged: Correction[] = [];
    pending.forEach((option, index) => {
      if (decided.some((fix) => overlaps(fix, option))) return;
      const row = scores[index]!;
      if (option.kind === "typo") {
        if (option.typoMode === "override" && option.coreReplacement) {
          // Pause-pass override for a priorTypoOriginals span not touched in this pass.
          const coreAltIdx = option.alternatives.findIndex((alt) => lowerTr(alt) === lowerTr(option.coreReplacement!));
          if (coreAltIdx === -1) return;
          let bestAlt = coreAltIdx;
          for (let i = 0; i < option.alternatives.length; i++) {
            if (row[i + 1]! > row[bestAlt + 1]!) bestAlt = i;
          }
          const delta = row[bestAlt + 1]! - row[coreAltIdx + 1]!;
          if (bestAlt !== coreAltIdx && delta >= typoOverrideBar) {
            judged.push({
              start: option.start,
              end: option.end,
              original: option.surfaceOriginal,
              replacement: option.alternatives[bestAlt]!,
              kind: "context",
              margin: delta,
            });
          }
          return;
        }
        let best = 1;
        let second = -1;
        for (let i = 2; i < row.length; i++) {
          if (row[i]! > row[best]!) {
            second = best;
            best = i;
          } else if (second === -1 || row[i]! > row[second]!) {
            second = i;
          }
        }
        const vsTyped = row[best]! - row[0]!;
        const gap = second !== -1 ? row[best]! - row[second]! : Infinity;
        if (option.typoMode === "ambiguous") {
          if (vsTyped >= typoAmbigVsTyped && gap >= typoAmbigGap) {
            judged.push({
              start: option.start,
              end: option.end,
              original: option.surfaceOriginal,
              replacement: option.alternatives[best - 1]!,
              kind: "context",
              margin: Math.min(vsTyped, gap),
            });
          }
        } else if (option.typoMode === "rescue") {
          if (vsTyped >= typoRescueBar && gap >= typoAmbigGap) {
            judged.push({
              start: option.start,
              end: option.end,
              original: option.surfaceOriginal,
              replacement: option.alternatives[best - 1]!,
              kind: "context",
              margin: vsTyped,
            });
          }
        }
        return;
      }
      let best = 1;
      for (let i = 2; i < row.length; i++) if (row[i]! > row[best]!) best = i;
      const margin = row[best]! - row[0]!;
      if (margin >= thresholdFor(option)) {
        judged.push({ start: option.start, end: option.end, original: option.surfaceOriginal, replacement: option.alternatives[best - 1]!, kind: "context", margin });
      }
    });
    const all = [...kept, ...judged].sort((a, b) => a.start - b.start || b.margin - a.margin);
    const corrections: Correction[] = [];
    for (const fix of all) if (!corrections.some((done) => overlaps(done, fix))) corrections.push(fix);
    if (this.settings.sentenceCase) corrections.splice(0, corrections.length, ...this.withSentenceRules(text, corrections));
    let output = "";
    let cursor = 0;
    for (const correction of corrections) {
      output += text.slice(cursor, correction.start) + correction.replacement;
      cursor = correction.end;
    }
    const finalText = output + text.slice(cursor);
    if (!collectFlags) {
      return { text: finalText, corrections, flags: [] };
    }

    // Collect flags for every suspicious token left untouched by both core and context corrections.
    const rawFlags: Array<{
      flag: SpellFlag;
      meta: TypoCandidateMeta[];
      coreScores: number[];
      asciiContext: boolean;
    }> = [];
    let fAtStart = true;
    let fPrevWord: string | undefined;
    let fPrevIsName = false;
    let fPrevCapitalized = false;
    let corrIdx = 0;

    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index]!;
      if (!token.isWord) {
        if (SENTENCE_END.has(token.text) || token.text.includes("\n")) fAtStart = true;
        else if (/\d/.test(token.text)) fAtStart = false;
        if (token.text !== " ") {
          fPrevWord = undefined;
          fPrevIsName = false;
          fPrevCapitalized = false;
        }
        continue;
      }
      while (corrIdx < corrections.length && corrections[corrIdx]!.end <= token.start) corrIdx++;
      const overlappingCorr =
        corrIdx < corrections.length && overlaps(corrections[corrIdx]!, token) ? corrections[corrIdx]! : undefined;
      const next = this.nextWord(tokens, index);
      const sentenceHasAsciiTurkish =
        !textHasMarks && asciiTyped.some((other) => other !== index && sentenceOf[other] === sentenceOf[index]);
      const ctx: WordContext = {
        atSentenceStart: fAtStart,
        textHasMarks:
          textHasMarks &&
          hasTurkishMarks(evidence.slice(0, token.start) + evidence.slice(token.end)) &&
          !asciiTyped.some((other) => other !== index && sentenceOf[other] === sentenceOf[index]),
        questionAhead: this.questionAhead(tokens, index),
        prevWord: fPrevWord,
        prevIsName: fPrevIsName,
        prevCapitalized: fPrevCapitalized,
        nextIsolated: next ? this.isIsolated(tokens, next.index) : false,
        sentenceHasAsciiTurkish,
      };
      fAtStart = false;
      if (overlappingCorr) {
        const trailing = lastSpaceWord(overlappingCorr.replacement);
        fPrevWord = lowerTr(trailing);
        fPrevIsName = !(ctx.atSentenceStart && !overlappingCorr.replacement.includes(" ")) && isUpperInitial(trailing);
        fPrevCapitalized = isUpperInitial(trailing);
        continue;
      }
      if (!this.isIsolated(tokens, index)) {
        fPrevWord = undefined;
        fPrevIsName = false;
        fPrevCapitalized = false;
        continue;
      }
      const detected = this.detectFlagDetailed(token, ctx, next?.token.text);
      if (detected) {
        rawFlags.push({
          ...detected,
          asciiContext: !ctx.textHasMarks || Boolean(ctx.sentenceHasAsciiTurkish),
        });
      }
      fPrevWord = lowerTr(token.text);
      fPrevIsName = !ctx.atSentenceStart && isUpperInitial(token.text);
      fPrevCapitalized = isUpperInitial(token.text);
    }

    // Re-rank multi-suggestion flags in sentence context using a single batched context-model call.
    const rerankTargets = rawFlags.filter((entry) => entry.flag.suggestions.length >= 2);
    if (rerankTargets.length > 0) {
      // Build context slice using final `corrections` so neighboring core+context fixes are visible.
      const finalContextSlice = (spanStart: number, spanEnd: number): { left: string; right: string } => {
        const leftFrom = Math.max(0, spanStart - 180);
        const rightTo = Math.min(text.length, spanEnd + 150);
        if (corrections.length === 0) {
          return { left: text.slice(leftFrom, spanStart), right: text.slice(spanEnd, rightTo) };
        }
        let left = "";
        let cur = leftFrom;
        for (const d of corrections) {
          if (d.end <= leftFrom) continue;
          if (d.start >= spanStart) break;
          if (d.start < cur || d.end > spanStart) continue;
          left += text.slice(cur, d.start) + d.replacement;
          cur = d.end;
        }
        left += text.slice(cur, spanStart);
        let right = "";
        cur = spanEnd;
        for (const d of corrections) {
          if (d.end <= spanEnd) continue;
          if (d.start >= rightTo) break;
          if (d.start < cur || d.end > rightTo) continue;
          right += text.slice(cur, d.start) + d.replacement;
          cur = d.end;
        }
        right += text.slice(cur, rightTo);
        return { left, right };
      };

      // When re-ranking flag suggestions with the context model, expose the morphological generative prior for
      // unseen/rare valid candidates (e.g. "düzenlemiyor") so corpus sparsity doesn't bias feature slots 0..2.
      const priorAwareLexicon = {
        count: (form: string) => {
          const raw = this.lexicon.count(form);
          if (raw >= 20 || form.includes("'") || !this.isRealWord(form)) return raw;
          return Math.max(raw, Math.round(this.effectiveCount(form, "rank")));
        },
        pair: (a: string, b: string) => this.lexicon.pair(a, b),
      } as unknown as Lexicon;

      const flagScores = await model.score(
        rerankTargets.map((entry) => {
          const candidates = [entry.flag.original, ...entry.flag.suggestions];
          const { left, right } = finalContextSlice(entry.flag.start, entry.flag.end);
          return {
            left,
            right,
            candidates,
            features: buildContextFeatures(
              candidates,
              "typo",
              entry.asciiContext,
              priorAwareLexicon,
              this.morphology,
              entry.meta,
            ),
          };
        }),
      );

      for (let i = 0; i < rerankTargets.length; i++) {
        const entry = rerankTargets[i]!;
        const row = flagScores[i];
        if (!row || row.length !== entry.flag.suggestions.length + 1) continue;
        const ranked = entry.flag.suggestions.map((sugg, idx) => ({
          sugg,
          // Combine sentence context score with core linguistic/edit-cost score (including case-voice agreement).
          score: row[idx + 1]! + 0.65 * (entry.coreScores[idx] ?? 0),
        }));
        ranked.sort((a, b) => b.score - a.score);
        entry.flag.suggestions = ranked.map((r) => r.sugg);
      }
    }

    return { text: finalText, corrections, flags: rawFlags.map((entry) => entry.flag) };
  }

  /**
   * Returns morphologically valid typo/mark candidates (sorted by core score) for an invalid/rare word,
   * along with core margin, threshold, slip cost, and mark-variant flag.
   * Used by `correctAsync()` and Stage 2 training data generation.
   */
  typoCandidatesFor(
    typed: string,
    context: WordContext,
    nextTyped?: string,
    maxCandidates = 7,
  ): { text: string; kind: CandidateKind; margin: number; threshold: number; slipCost: number; isMarkVariant: boolean }[] {
    if (this.morphology === undefined || isAllUpper(typed) || typed.length < 4) return [];
    const word = lowerTr(typed);
    if (word.includes("'") || typed.slice(1) !== word.slice(1)) return [];
    if (isUpperInitial(typed) && !context.atSentenceStart) return [];
    if (this.isRealWord(word)) return [];
    const listed = this.knownFix(typed, word, context, nextTyped);
    if (listed !== null) return [];
    const typedCount = this.lexicon.count(word);
    const rareInvalidSlip = typed === word && typedCount < 50 && this.lexicon.capitalShare(word) < 0.5;
    if (typedCount >= this.settings.knownWord && !rareInvalidSlip) return [];

    const cands = this.candidates(word, typed, context, typedCount, nextTyped);
    const foldedWord = foldTr(word);
    const valid: { text: string; kind: CandidateKind; margin: number; threshold: number; slipCost: number; isMarkVariant: boolean }[] = [];
    for (const c of cands) {
      if (c.kind !== "typo" && c.kind !== "marks") continue;
      if (c.text.includes(" ") || !this.isRealWord(c.text) || this.lexicon.exactCount(c.text) < 1) continue;
      const invalidTyped = c.kind === "typo" && typedCount === 0 && typed === word;
      const threshold = c.threshold ?? (invalidTyped ? this.settings.typoInvalidThreshold : this.settings.threshold[c.kind]);
      valid.push({
        text: c.text,
        kind: c.kind,
        margin: marginOf(c),
        threshold,
        slipCost: c.slipCost ?? 0,
        isMarkVariant: foldTr(c.text) === foldedWord,
      });
    }
    valid.sort((a, b) => b.margin - a.margin);
    return valid.slice(0, maxCandidates);
  }

  /** Places where the typed span and another real-word reading compete, for the context model to judge. */
  private contestedSpans(
    token: Token,
    next: Token | undefined,
    context: WordContext,
    tokens?: readonly Token[],
    tokenIndex?: number,
  ): {
    start: number;
    end: number;
    typed: string;
    alternatives: string[];
    kind: ContextKind;
    direction: "marks" | "split" | "join";
    asciiContext: boolean;
    typedHasMarks: boolean;
  }[] {
    const typed = token.text;
    const word = lowerTr(typed);
    if (isAllUpper(typed) || typed.length < 2 || (isUpperInitial(typed) && !context.atSentenceStart) || typed.slice(1) !== word.slice(1)) {
      return [];
    }
    const known = (form: string) => this.lexicon.count(form) >= this.settings.contextWord;
    const asciiContext = !context.textHasMarks || Boolean(context.sentenceHasAsciiTurkish);
    const typedHasMarks = hasTurkishMarks(word);
    const nextLow = next ? lowerTr(next.text) : "";
    const spans: {
      start: number;
      end: number;
      typed: string;
      alternatives: string[];
      kind: ContextKind;
      direction: "marks" | "split" | "join";
      asciiContext: boolean;
      typedHasMarks: boolean;
    }[] = [];

    // "oldu" / "öldü", "uç" / "üç": real words that differ only in Turkish marks (question particle harmony is deterministic).
    if (known(word) && !word.includes("'") && !QUESTION.test(word)) {
      const variants = markVariants(word)
        .filter(known)
        .sort((a, b) => this.lexicon.count(b) - this.lexicon.count(a))
        .slice(0, 3)
        .map((variant) => keepCase(typed, variant));
      if (variants.length > 0) {
        spans.push({ start: token.start, end: token.end, typed, alternatives: variants, kind: "marks", direction: "marks", asciiContext, typedHasMarks });
      }
    }

    // "bende" / "ben de", "evde" / "ev de", "evdeki" / "evde ki", "sevgimi" / "sevgi mi":
    // a real word that could be two. Never split TDK-fixed SOMBAHCEMI words ("oysaki", "illaki"), never split locative
    // -te/-ta into conjunction de/da ("ekte" is never "ek de"), never split Xde before another "de/da" ("bende de"),
    // and only propose splitting -mi when a question mark lies ahead without an existing question particle.
    if (known(word) && word.length >= 4 && !word.includes("'")) {
      const stem = word.slice(0, -2);
      const tail = word.slice(-2);
      if ((tail === "de" || tail === "da") && nextLow !== "de" && nextLow !== "da" && known(stem) && followsHarmony(stem, tail[1]!)) {
        spans.push({
          start: token.start,
          end: token.end,
          typed,
          alternatives: [`${typed.slice(0, -2)} ${typed.slice(-2)}`],
          kind: "de_da",
          direction: "split",
          asciiContext: false,
          typedHasMarks,
        });
      } else if (tail === "ki" && !FIXED_KI_WORDS.has(word) && !SOMBAHCEMI_KI.has(stem) && known(stem)) {
        spans.push({
          start: token.start,
          end: token.end,
          typed,
          alternatives: [`${typed.slice(0, -2)} ${typed.slice(-2)}`],
          kind: "ki",
          direction: "split",
          asciiContext: false,
          typedHasMarks,
        });
      } else if (
        /^m[ıiuü]$/.test(tail) &&
        stem.length >= 3 &&
        known(stem) &&
        followsHarmony(stem, tail[1]!)
      ) {
        spans.push({
          start: token.start,
          end: token.end,
          typed,
          alternatives: [`${typed.slice(0, -2)} ${typed.slice(-2)}`],
          kind: "mi",
          direction: "split",
          asciiContext: false,
          typedHasMarks,
        });
      }
    }

    // "ben de" / "bende", "kitap da" / "kitapta", "evde ki" / "evdeki", "sevgi mi" / "sevgimi": two words that could be one.
    if (next && !isUpperInitial(next.text) && !isAllUpper(next.text) && !word.includes("'") && known(word)) {
      const second = nextLow;
      if (second === "de" || second === "da") {
        const gluedD = word + second;
        const gluedT = isVoicelessFinal(word) ? word + (second === "de" ? "te" : "ta") : "";
        const glued = known(gluedD) ? gluedD : gluedT && known(gluedT) ? gluedT : "";
        if (glued) {
          spans.push({
            start: token.start,
            end: next.end,
            typed: `${typed} ${next.text}`,
            alternatives: [keepCase(typed, glued)],
            kind: "de_da",
            direction: "join",
            asciiContext: false,
            typedHasMarks,
          });
        }
      } else if (second === "ki" && known(word + "ki")) {
        spans.push({
          start: token.start,
          end: next.end,
          typed: `${typed} ${next.text}`,
          alternatives: [typed + next.text],
          kind: "ki",
          direction: "join",
          asciiContext: false,
          typedHasMarks,
        });
      } else if (QUESTION.test(second) && !MUSIC_NOTES.has(word) && known(word + second)) {
        spans.push({
          start: token.start,
          end: next.end,
          typed: `${typed} ${next.text}`,
          alternatives: [typed + next.text],
          kind: "mi",
          direction: "join",
          asciiContext: false,
          typedHasMarks,
        });
      }
    }
    return spans;
  }

  /** True when a standalone question particle (mi/mı/mu/mü...) already appears later in the same sentence. */
  private questionParticleAhead(tokens: readonly Token[], index: number): boolean {
    for (let ahead = index + 1; ahead < tokens.length; ahead++) {
      const tok = tokens[ahead]!;
      if (!tok.isWord) {
        if (SENTENCE_END.has(tok.text) || tok.text.includes("\n")) return false;
        continue;
      }
      const low = lowerTr(tok.text);
      if (QUESTION.test(low)) return true;
    }
    return false;
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
    const pronoun = this.pronounAlso(typed, word, nextTyped);
    if (pronoun) return pronoun;
    const candidates = this.candidates(word, typed, context, typedCount, nextTyped);

    if (nextTyped && !isAllUpper(nextTyped) && !isUpperInitial(nextTyped) && !(isUpperInitial(typed) && !context.atSentenceStart)) {
      const joined = this.joinCandidate(word, lowerTr(nextTyped), typed, context.nextIsolated ?? true);
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

  /**
   * "bende geldim" -> "ben de geldim": a pronoun glued to "de" followed by a finite verb of the same person is the
   * conjunction, never the locative ("Kitap bende kaldı" keeps "bende": the verb there is third person).
   */
  private pronounAlso(
    typed: string,
    word: string,
    nextTyped: string | undefined,
  ): { replacement: string; kind: CandidateKind; margin: number; joinsNext: boolean } | null {
    const person = PRONOUN_DE[word];
    if (!person || !nextTyped || !this.morphology?.analyze || isUpperInitial(nextTyped) && !isUpperInitial(typed)) return null;
    const analyses = this.morphology.analyze(lowerTr(nextTyped));
    const finite = analyses.filter(
      (a) => a.pos === "Verb" && a.morphemes.some((m) => FINITE_VERB_MORPHEMES.has(m)) && !a.morphemes.includes("Zero"),
    );
    if (!finite.some((a) => a.morphemes.at(-1) === person)) return null;
    if (analyses.some((a) => a.morphemes.at(-1) === "A3sg" && a.morphemes.some((m) => FINITE_VERB_MORPHEMES.has(m)))) return null;
    return { replacement: `${typed.slice(0, -2)} ${typed.slice(-2)}`, kind: "split", margin: 5, joinsNext: false };
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
    const add: AddCandidate = (text, kind, score, base = typedScore, threshold, slipCost) => {
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
        found.set(text, { text, kind, score, base, joinsNext: false, threshold: keepBar ? existing.threshold : threshold, slipCost });
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
    const typedLowerCount = Math.round(typedCount * (1 - this.lexicon.capitalShare(word)));
    let morphParticleHit = false;
    let strongAsciiMarkHit = false;
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
          const onlyLeadingCapitalI =
            typed[0] === "I" && wordStem[0] === "ı" && formStem[0] === "i" && wordStem.slice(1) === formStem.slice(1);
          if (
            context.textHasMarks &&
            !sameApostropheStem &&
            !onlyLeadingCapitalI &&
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
          const formValid = this.morphology !== undefined && this.isRealWord(form);
          if (count > 0 && (!strict || score - typedScore >= override)) {
            const suffixOnlyApostrophe = hasApostrophe && typedCount === 0 && !strict && count >= 7 && sameApostropheStem;
            let threshold = suffixOnlyApostrophe ? Math.max(1.5, this.settings.threshold.marks - 1.0) : undefined;
            // In sentences proven to be typed in ASCII Turkish, an invalid lowercase form ("yuku", "super", "dali")
            // restoring to a valid Turkish word needs less log-frequency gap than in normal marked text.
            if (
              threshold === undefined &&
              !context.textHasMarks &&
              context.sentenceHasAsciiTurkish &&
              !realTyped
            ) {
              if (typed === word && formValid && word.length >= 3 && count >= 10) {
                threshold = Math.max(0.7, this.settings.threshold.marks - 1.8);
              } else if (typedCount === 0 && count >= 5 && (!capitalized || !hasApostrophe || sameApostropheStem || this.lexicon.capitalShare(form) >= 0.5)) {
                // Unseen word in an ASCII-typed Turkish sentence with an attested mark variant ("Gülruh", "Çapari", "Divanı'ndan").
                threshold = Math.max(1.2, this.settings.threshold.marks - 1.3);
              }
            }
            add(form, "marks", score, typedScore, threshold);
            // Lowercase-vs-lowercase count comparison when the typed lowercase word's corpus count is dominated by a
            // capitalized proper name ("egrisi", "dali", "makasi", "avi", "karin").
            if (!strict && typed === word && this.lexicon.capitalShare(word) >= 0.5 && formValid) {
              const candLower = Math.round(count * (1 - this.lexicon.capitalShare(form)));
              if (candLower >= 10) {
                add(form, "marks", log(candLower) - cost.marks, log(typedLowerCount), threshold);
              }
            }
            if (
              !context.textHasMarks &&
              !realTyped &&
              formValid &&
              score - typedScore >= (threshold ?? this.settings.threshold.marks)
            ) {
              strongAsciiMarkHit = true;
            }
          }
        }
        if (strict) continue;
      }
      // A real word is never heuristically particle-split (guarded inside addSplits via formIsReal),
      // but strongly attested bigram splits (pair >> typedCount, e.g. "ihtimalide" -> "ihtimali de") still apply.
      const hit = this.addSplits(form, context, markCost, isName, capitalized, add);
      if (form === word && hit) morphParticleHit = true;
      if (!form.includes("'")) {
        if (isName) {
          this.addApostrophes(
            form,
            word,
            typedCount,
            typedScore,
            markCost,
            false,
            context.prevIsName ?? false,
            context.prevCapitalized ?? false,
            context.prevWord,
            add,
          );
        } else if (capitalized && context.atSentenceStart) {
          this.addApostrophes(form, word, typedCount, typedScore, markCost, true, false, false, undefined, add);
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
      const uniqueThreshold = Math.max(1.5, this.settings.threshold.marks - 1.0);
      if (validVariants.length === 1) {
        const only = validVariants[0]!;
        const vCount = this.lexicon.count(only);
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
      } else if (typedCount === 0 && word.length >= 7 && validVariants.length > 1) {
        // When multiple theoretical morph variants exist ("ısınmadır" vs "ışınmadır", "eşleşmiyorsa" vs "esleşmiyorsa"),
        // pick the unique one actually attested in the lexicon (count >= 3).
        const seenValid = validVariants.filter((variant) => this.lexicon.count(variant) >= 3);
        if (seenValid.length === 1) {
          const only = seenValid[0]!;
          const vCount = this.lexicon.count(only);
          add(only, "marks", Math.max(log(vCount), 2.5) - cost.marks, typedScore, uniqueThreshold);
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

    // All-caps acronyms or mixed-case brands glued to a Turkish suffix ("HEXIMden" -> "HEXIM'den", "ABDde" -> "ABD'de", "MacOSdaki" -> "MacOS'daki").
    if (typedCount < 10 && !realTyped && !hasApostrophe) {
      const acronym = matchAcronymApostrophe(typed);
      if (acronym) {
        const prefixLower = lowerTr(acronym.prefix);
        if (
          this.lexicon.count(prefixLower) < 500 ||
          this.lexicon.capitalShare(prefixLower) >= 0.5 ||
          (this.morphology !== undefined && !this.isRealWord(prefixLower))
        ) {
          add(
            acronym.withMark,
            "apostrophe",
            Math.max(3.5, typedScore + this.settings.threshold.apostrophe + 0.6) - cost.apostrophe,
            typedScore,
          );
        }
      }
    }

    // Two-error / compound recoveries for unseen lowercase invalid words:
    // 1. Question particle + 1-edit slip ("biliyormusunm?" -> "biliyor musun?").
    // 2. Two glued words with optional missing Turkish marks ("yapmıyorsunanlamadim" -> "yapmıyorsun anlamadım").
    // Never compete with an already-passing single-word mark restoration ("muzikevinde" -> "müzikevinde").
    const hasInternalUpper = typed.slice(1) !== word.slice(1);
    const hasPassingMark = [...found.values()].some(
      (cand) => cand.kind === "marks" && marginOf(cand) >= (cand.threshold ?? this.settings.threshold.marks),
    );
    if (
      this.morphology !== undefined &&
      typedCount === 0 &&
      !realTyped &&
      !isName &&
      !hasApostrophe &&
      !hasInternalUpper &&
      !morphParticleHit &&
      !strongAsciiMarkHit &&
      !hasPassingMark
    ) {
      if (word.length >= 6) {
        this.addQuestionParticleTypoSplits(word, context, typedScore, add);
      }
      if (word.length >= 10) {
        this.addTwoWordGluedSplits(word, typedScore, add);
      }
    }

    // Short 3-letter typo recovery ("bne" -> "ben", "ane" -> "anne") under strict morphology + frequency guards.
    // Never compete with words that already have a valid Turkish mark variant ("goz" -> "göz", "guc" -> "güç").
    if (
      this.morphology !== undefined &&
      word.length === 3 &&
      !realTyped &&
      !isName &&
      !hasApostrophe &&
      !hasInternalUpper &&
      !morphParticleHit &&
      !strongAsciiMarkHit &&
      typedCount <= 120 &&
      (typed === word || (context.atSentenceStart && this.lexicon.capitalShare(word) < 0.5)) &&
      !variants.some((v) => this.lexicon.exactCount(v) >= 50 && this.isRealWord(v))
    ) {
      this.addShortWordTypos(word, context, typedCount, typedScore, typedLowerCount, nextTyped, add);
    }

    // Slips of the fingers are only considered for rare or unseen words that aren't names.
    // A rare form that Turkish suffix rules accept is a real word, not a slip ("getirsek" is not "getirmek").
    // Do not let single-edit typos hijack or tie a morphologically proven particle split ("boyunuda" -> "boyunu da")
    // or a clear mark restoration in an ASCII-typed sentence ("gecenleri" -> "geçenleri" vs "geceleri").
    // A lowercase word that Turkish rules reject and that is only seen as a rare misspelling in the corpus ("brada" 13
    // times, "burada" 33,000) is still a slip: it may be fixed, but only into a word seen 200 times as often.
    const rareInvalidSlip =
      this.morphology !== undefined && typed === word && typedCount < 50 && !realTyped && this.lexicon.capitalShare(word) < 0.5;
    if (
      (typedCount < knownWord || rareInvalidSlip) &&
      word.length >= 4 &&
      !isName &&
      !hasApostrophe &&
      !hasInternalUpper &&
      !realTyped &&
      !morphParticleHit &&
      !strongAsciiMarkHit
    ) {
      // Do not let single-edit typos mangle an unsplit harmonized question particle ("olurmu", "yaparmı", "varmı").
      const qMatch = /^(.{3,})(m[iıuü](?:y?[iıuü]m|s[iıuü]n|y?[iıuü]z|s[iıuü]n[iıuü]z|d[iıuü]r|d[iıuü]|ym[iıuü]ş|ys[ae]|yd[iıuü]|yken)?)$/.exec(word);
      const unsplitQuestion =
        qMatch !== null &&
        followsHarmony(qMatch[1]!, qMatch[2]![1]!) &&
        sameHighVowels(qMatch[2]!) &&
        this.isRealWord(qMatch[1]!) &&
        this.lexicon.count(qMatch[1]!) >= 5;
      if (!unsplitQuestion) {
        const unseenLowerInvalid = this.morphology !== undefined && typedCount === 0 && typed === word;
        const prevIsAcc = unseenLowerInvalid && context.prevWord ? this.isUnambiguousAccusative(context.prevWord) : false;
        for (const [text, slipCost] of this.oneEdit(word, unseenLowerInvalid)) {
          let count = this.lexicon.exactCount(text);
          if (unseenLowerInvalid && this.settings.typoStemShare > 0 && text.length >= 7 && this.isRealWord(text)) {
            count = Math.max(count, this.stemCount(text) * this.settings.typoStemShare);
          }
          const morphValid = this.morphology !== undefined && (count >= 1 ? this.isRealWord(text) : false);
          // For attested-but-rare valid forms (e.g. "gönderdim" obs=20, "beğendim" obs=24) in long unseen words,
          // allow a capped morphological prior boost (never boosting consonant->vowel substitutions like "göstermdn"->"göstermen").
          if (
            unseenLowerInvalid &&
            morphValid &&
            word.length >= 8 &&
            count >= 10 &&
            slipCost <= 1.25
          ) {
            count = Math.max(count, this.effectiveCount(text, "autofix"));
          }
          if (count < 1) continue;
          if (typedCount >= knownWord && (count < 200 * typedCount || !this.isRealWord(text))) continue;
          // Never rewrite a word into a vowelless interjection/abbreviation ("Hımm" -> "Hmm", "km", "vb").
          if (!/[aeıioöuüâîû]/.test(text)) continue;
          // A lowercase slip shouldn't rewrite into a mostly-capitalized proper name ("krate" -> "kate", "lmre" -> "emre").
          if (typed === word && this.lexicon.capitalShare(text) >= 0.6) continue;
          const morphPenalty = this.morphology !== undefined && !morphValid ? 1.5 : 0;
          const voicePenalty = prevIsAcc && morphValid && this.isPurelyPassiveVerb(text) ? 1.4 : 0;
          // For long unseen lowercase invalid words, a morphologically valid high-confidence keyboard edit
          // (swap, near-key sub/extra, or missed key) needs less frequency evidence ("gönderdim", "yoğunluklarında").
          let threshold: number | undefined;
          if (unseenLowerInvalid && morphValid && word.length >= 7 && slipCost <= 1.25 && count >= 20) {
            threshold = 0.6;
          }
          add(text, "typo", log(count) - cost.typo - slipCost - morphPenalty - voicePenalty, typedScore, threshold, slipCost);
        }
        // Principled generative-prior + mark-loss-plus-1-edit recovery for long unseen lowercase invalid words
        // ("duzenblemiyor" -> "düzenlemiyor", "kullandğımda" -> "kullandığımda", "puanlrım" -> "puanlarım").
        // Only fires when 1-edit lexicon search didn't already find a passing fix; strictly requires length >= 8,
        // non-substitution edit when combining with mark restoration (prevents "suhenin" -> "şubenin"), and capped prior
        // (prevents zero-count rare verb forms like "gerektin" from hijacking double omissions like "gerektn").
        if (unseenLowerInvalid && word.length >= 8 && this.morphology?.fuzzySearch) {
          const hasPassing1 = [...found.values()].some(
            (cand) => marginOf(cand) >= (cand.threshold ?? this.settings.threshold[cand.kind]),
          );
          if (!hasPassing1) {
            for (const f of this.morphology.fuzzySearch(word, 1, 15)) {
              if (f.editCost > 1.25) continue;
              if (this.lexicon.capitalShare(f.word) >= 0.6) continue;
              // If restoring Turkish marks AND editing a char, require length >= 9 and length change or transposition
              // (blocks 2-consonant substitutions like "suhenin" -> "şubenin" while keeping "duzenblemiyor" -> "düzenlemiyor").
              const marksChanged = foldTr(f.word) !== f.word && foldTr(word) !== f.word && f.word.length === word.length;
              if (marksChanged && f.editCost > 1.1) continue;
              const eff = this.effectiveCount(f.word, "autofix");
              if (eff < 20) continue;
              const voicePenalty = prevIsAcc && this.isPurelyPassiveVerb(f.word) ? 1.4 : 0;
              const threshold = word.length >= 9 && eff >= 28 ? 0.6 : 1.5;
              add(f.word, "typo", log(eff) - cost.typo - f.editCost - voicePenalty, typedScore, threshold, f.editCost);
            }
          }
        }
        // Cautious 2-vowel-drop recovery ("gelyorm" -> "geliyorum", "çalışıyrm" -> "çalışıyorum") when 1-edit finds nothing strong.
        if (unseenLowerInvalid && word.length >= 6) {
          const hasPassing = [...found.values()].some(
            (cand) => marginOf(cand) >= (cand.threshold ?? this.settings.threshold[cand.kind]),
          );
          if (!hasPassing) {
            this.addDoubleVowelDrops(word, typedScore, add);
          }
        }
      }
    }
    return [...found.values()];
  }

  /** Strict 3-letter typo recovery ("bne" -> "ben", "ane" -> "anne"): requires invalid stem, valid very frequent target. */
  private addShortWordTypos(
    word: string,
    context: WordContext,
    typedCount: number,
    typedScore: number,
    typedLowerCount: number,
    nextTyped: string | undefined,
    add: AddCandidate,
  ) {
    const nextLower = nextTyped && !isAllUpper(nextTyped) ? lowerTr(nextTyped) : undefined;
    // Protect attested foreign/phrase tokens ("van der", "de la", "los angeles").
    if (context.prevWord && this.lexicon.pair(context.prevWord, word) > 0) return;
    if (nextLower && this.lexicon.pair(word, nextLower) > 0) return;

    const edits = new Map<string, number>();
    const put = (cand: string, slip: number) => {
      if (cand !== word && (edits.get(cand) ?? Infinity) > slip) edits.set(cand, slip);
    };
    // Adjacent swaps ("bne" -> "ben")
    const swaps = new Set([word[1]! + word[0]! + word[2]!, word[0]! + word[2]! + word[1]!]);
    for (const swap of swaps) put(swap, 0.7);
    // Single letter insertions (doubled consonant like "ane" -> "anne" is cheapest; leading insert heavily penalized)
    for (let i = 0; i <= word.length; i++) {
      const before = word.slice(0, i);
      const after = word.slice(i);
      const prev = word[i - 1];
      const at = word[i];
      for (const letter of ALPHABET) {
        const isDouble = letter === prev || letter === at;
        const slip = i === 0 ? (isDouble ? 1.8 : 2.3) : isDouble ? 0.8 : 1.2;
        put(before + letter + after, slip);
      }
    }
    // Near-key substitutions only for completely unseen 3-letter words ("bwn" -> "ben", "vqr" -> "var")
    if (typedCount === 0) {
      for (let i = 0; i < word.length; i++) {
        const at = word[i]!;
        for (const letter of ALPHABET) {
          if (letter !== at && areNearKeys(letter, at)) {
            put(word.slice(0, i) + letter + word.slice(i + 1), i === 0 ? 2.0 : 1.0);
          }
        }
      }
    }

    const { cost } = this.settings;
    const base = Math.min(typedScore, log(typedLowerCount));
    for (const [cand, slip] of edits) {
      const count = this.lexicon.exactCount(cand);
      // A swap is the commonest 3-letter slip ("bka" -> "bak"): it needs less frequency evidence than an insertion.
      const minCount = swaps.has(cand) ? Math.min(1500, this.settings.shortSwapMinCount) : 1500;
      const ratio = swaps.has(cand) && this.settings.shortSwapMinCount < 1500 ? 20 : 50;
      if (count < minCount || count < typedCount * ratio) continue;
      if (this.lexicon.capitalShare(cand) >= 0.5 || !this.isRealWord(cand)) continue;
      const pairBonus =
        (context.prevWord && this.lexicon.pair(context.prevWord, cand) > 0) ||
        (nextLower && this.lexicon.pair(cand, nextLower) > 0)
          ? 0.8
          : 0;
      add(cand, "typo", log(count) - cost.typo - slip + pairBonus, base, 1.5);
    }
  }

  /** Recovers glued question particles with a 1-edit slip ("biliyormusunm?" -> "biliyor musun?"). */
  private addQuestionParticleTypoSplits(
    word: string,
    context: WordContext,
    typedScore: number,
    add: AddCandidate,
  ) {
    const { cost } = this.settings;
    for (let cut = 3; cut <= word.length - 3; cut++) {
      const first = word.slice(0, cut);
      const second = word.slice(cut);
      if (second[0] !== "m" || second.length < 3 || second.length > 10 || QUESTION.test(second)) continue;
      const firstCount = this.lexicon.exactCount(first);
      if (firstCount < 10 || this.lexicon.capitalShare(first) >= 0.5 || !this.isRealWord(first)) continue;
      // Direct 1-edit candidates on the question particle (without word-final suffix-deletion penalties).
      const qEdits = new Map<string, number>();
      const putQ = (cand: string, slip: number) => {
        if (cand.length >= 2 && (qEdits.get(cand) ?? Infinity) > slip) qEdits.set(cand, slip);
      };
      for (let i = 1; i < second.length; i++) {
        const at = second[i]!;
        const prev = second[i - 1];
        const next = second[i + 1];
        const nearExtra =
          (prev !== undefined && (at === prev || areNearKeys(at, prev))) ||
          (next !== undefined && (at === next || areNearKeys(at, next)));
        if (nearExtra) putQ(second.slice(0, i) + second.slice(i + 1), 0.9);
        if (next !== undefined) putQ(second.slice(0, i) + next + at + second.slice(i + 2), 0.7);
        for (const ch of "ıiuümnsyzdrke") {
          if (ch !== at && areNearKeys(ch, at)) putQ(second.slice(0, i) + ch + second.slice(i + 1), 0.9);
          putQ(second.slice(0, i) + ch + second.slice(i), 1.0);
        }
      }
      for (const [cand, slip] of qEdits) {
        const checks = [cand];
        if (!context.textHasMarks && !hasTurkishMarks(cand)) {
          for (const v of markVariants(cand, 16)) checks.push(v);
        }
        for (const q of checks) {
          if (
            QUESTION.test(q) &&
            sameHighVowels(q) &&
            followsHarmony(first, q[1]!) &&
            (context.questionAhead || q.length >= 4)
          ) {
            const markPen = q === cand ? 0 : cost.marks;
            add(`${first} ${q}`, "split", log(firstCount) - cost.split - slip - markPen, typedScore, 2.5);
          }
        }
      }
    }
  }

  /** Resolves one half of a long glued two-word error (optionally restoring missing Turkish marks). */
  private resolveGluedPart(part: string): { text: string; count: number; marked: boolean } | null {
    if (part.length < 4) return null;
    if (this.isRealWord(part)) {
      const count = this.lexicon.exactCount(part);
      if (count >= 100 && this.lexicon.capitalShare(part) < 0.45) {
        return { text: part, count, marked: false };
      }
    }
    let best: { text: string; count: number } | null = null;
    let secondBest = 0;
    for (const v of markVariants(part, 128)) {
      const c = this.lexicon.exactCount(v);
      if (c < 100 || this.lexicon.capitalShare(v) >= 0.45 || !this.isRealWord(v)) continue;
      if (!best || c > best.count) {
        if (best) secondBest = Math.max(secondBest, best.count);
        best = { text: v, count: c };
      } else {
        secondBest = Math.max(secondBest, c);
      }
    }
    if (best && (secondBest === 0 || best.count >= secondBest * 10)) {
      return { text: best.text, count: best.count, marked: true };
    }
    return null;
  }

  /** Splits two glued words (even with missing Turkish marks: "yapmıyorsunanlamadim" -> "yapmıyorsun anlamadım"). */
  private addTwoWordGluedSplits(word: string, typedScore: number, add: AddCandidate) {
    const { cost } = this.settings;
    for (let cut = 4; cut <= word.length - 4; cut++) {
      // A doubled tail is a repeated suffix ("değil-dirdir"), not a second word ("dırdır").
      const tail = word.slice(cut);
      if (tail.length % 2 === 0 && tail.slice(0, tail.length / 2) === tail.slice(tail.length / 2)) continue;
      const left = this.resolveGluedPart(word.slice(0, cut));
      if (!left) continue;
      const right = this.resolveGluedPart(word.slice(cut));
      if (!right) continue;
      // Require a finite verb on either side (never forms an OOV noun compound) or an attested bigram.
      if (!this.isFiniteVerb(left.text) && !this.isFiniteVerb(right.text) && this.lexicon.pair(left.text, right.text) < 5) {
        continue;
      }
      const markPen = (left.marked ? cost.marks : 0) + (right.marked ? cost.marks : 0);
      const score = Math.min(log(left.count), log(right.count)) - cost.split - markPen - 0.8;
      add(`${left.text} ${right.text}`, "split", score, typedScore, 2.5);
    }
  }

  /** Cautious 2-vowel-drop recovery between consonant clusters ("gelyorm" -> "geliyorum", "çalışıyrm" -> "çalışıyorum"). */
  private addDoubleVowelDrops(word: string, typedScore: number, add: AddCandidate) {
    const gaps: number[] = [];
    for (let i = 1; i < word.length; i++) {
      if (!VOWELS.has(word[i - 1]!) && !VOWELS.has(word[i]!)) gaps.push(i);
    }
    if (gaps.length < 2 || gaps.length > 5) return;
    const vowels = ["a", "e", "ı", "i", "o", "u", "ü"];
    const { cost } = this.settings;
    for (let a = 0; a < gaps.length; a++) {
      const p1 = gaps[a]!;
      for (let b = a + 1; b < gaps.length; b++) {
        const p2 = gaps[b]!;
        const s0 = word.slice(0, p1);
        const s1 = word.slice(p1, p2);
        const s2 = word.slice(p2);
        for (const v1 of vowels) {
          for (const v2 of vowels) {
            const cand = s0 + v1 + s1 + v2 + s2;
            const count = this.lexicon.exactCount(cand);
            if (count < 50 || this.lexicon.capitalShare(cand) >= 0.5 || !this.isRealWord(cand)) continue;
            add(cand, "typo", log(count) - cost.typo - 0.8, typedScore, 1.5, 0.8);
          }
        }
      }
    }
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
      if (second.includes("'") || NEVER_ALONE.has(second)) continue;
      const pair = this.lexicon.pair(first, second);
      const foreignProperSplit =
        isName && this.morphology !== undefined && (!this.isRealWord(first) || !this.isRealWord(second));
      if (pair > 0 && !foreignProperSplit) add(`${first} ${second}`, "split", log(pair) - cost.split - markCost);
      // Glued particles after an apostrophe-inflected proper name ("Çin'dirki", "Ankara'dada", "İstanbul'damı?").
      if (first.includes("'")) {
        if (glued === 0 && !formIsReal && this.lexicon.count(first) > 0) {
          const quoteIdx = first.indexOf("'");
          const suf = first.slice(quoteIdx + 1);
          if (second === "ki" && /^(?:[dt][ıiuü]r|y?d[ıiuü])$/.test(suf)) {
            add(`${first} ${second}`, "split", Math.max(log(this.lexicon.count(first)), 3.2) - cost.split - markCost);
          } else if (
            ALSO.test(second) &&
            followsHarmony(first, second[1]!) &&
            /^(?:[dt][ae]n?|n[ıiuü]n|y[aeıiuü]|y?l[ae])$/.test(suf)
          ) {
            add(`${first} ${second}`, "split", Math.max(log(this.lexicon.count(first)), 3.2) - cost.split - markCost);
          } else {
            const q = QUESTION.exec(second);
            if (q && followsHarmony(first, q[1]![1]!) && sameHighVowels(second) && (context.questionAhead || q[2] !== undefined)) {
              add(`${first} ${second}`, "split", Math.max(log(this.lexicon.count(first)), 3.2) - cost.split - markCost);
            }
          }
        }
        continue;
      }
      // TDK rule: Noun + etmek compound verbs without sound drop/doubling are always written separate
      // ("farkettim" -> "fark ettim", "terketti" -> "terk etti", "kabuledildi" -> "kabul edildi", "devamediyor" -> "devam ediyor").
      // Guarded by !formIsReal (so genuine joined verbs like "affettim", "hissettim", "kaybettim" are never touched).
      if (
        !formIsReal &&
        !isName &&
        !isProperAtStart &&
        this.morphology !== undefined &&
        (second.startsWith("et") || second.startsWith("ed")) &&
        !JOINED_ETMEK_STEMS.has(first) &&
        ((second.length >= 4 && (first.length >= 4 || SEPARATE_ETMEK_SHORT.has(first))) ||
          (second === "et" && SEPARATE_ETMEK_BARE_IMPERATIVE.has(first))) &&
        this.lexicon.count(first) >= 50 &&
        this.lexicon.capitalShare(first) < 0.5 &&
        this.isBareNominalRoot(first) &&
        this.isVerbFormOf(second, "et")
      ) {
        const base = log(glued);
        const targetScore = Math.max(log(this.lexicon.count(first)), base + this.settings.threshold.split + cost.split + 0.1);
        add(`${first} ${second}`, "split", targetScore - cost.split - markCost, base);
        morphParticleHit = true;
        continue;
      }
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
        if (capitalized && this.isDerivedLanguageStem(first)) continue;
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
          // Morphologically impossible verb/conditional + de/da glues ("üzülsede", "istemesede") with low corpus noise.
          const impossibleVerbGlue =
            glued > 0 &&
            glued < this.settings.knownMarked &&
            ((pair >= 5 && pair >= glued * 3) || (stem >= glued * 4 && /(?:s[ae]|yor|m[ıiuü]ş|[ae]c[ae]k)$/.test(first)));
          const threshold = impossibleVerbGlue ? Math.max(0.7, this.settings.threshold.split - 1.8) : undefined;
          add(`${first} ${second}`, "split", score, undefined, threshold);
          if (first.length >= 4) morphParticleHit = true;
        } else if ((stem > 0 && NO_LOCATIVE_AFTER.test(first)) || (this.morphology !== undefined && glued === 0 && first.length >= 8 && /l[ae]r[ıi]$/.test(first))) {
          const score =
            this.morphology !== undefined &&
            glued === 0 &&
            ((stem >= 3 && STRONG_NO_LOCATIVE_AFTER.test(first)) || (first.length >= 8 && /l[ae]r[ıi]$/.test(first)))
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
    prevIsName: boolean,
    prevCapitalized: boolean,
    prevWord: string | undefined,
    add: AddCandidate,
  ) {
    const { cost, minName } = this.settings;
    const hasMorph = this.morphology !== undefined;
    const formCount = form === word ? typedCount : this.lexicon.count(form);
    const typedCaps = Math.round(typedCount * this.lexicon.capitalShare(word));
    const realWord = this.isRealWord(word);
    for (let cut = 2; cut < form.length; cut++) {
      const stem = form.slice(0, cut);
      const suffix = form.slice(cut);
      const withMark = `${stem}'${suffix}`;
      const seen = this.lexicon.count(withMark);
      const placeHead = !atSentenceStart && prevCapitalized && isPlaceApostropheHead(stem, prevWord);
      let blockedCached: boolean | undefined;
      const isBlocked = () =>
        (blockedCached ??=
          this.isBlockedApostropheStem(stem, placeHead) ||
          (!placeHead && this.isInflectedApostropheStem(stem)));
      // TDK geographic/place/state P3sg head words preceded by a capitalized name ("Marmara Denizi'nin",
      // "Türkiye Cumhuriyeti'nin", "Kadıköy Mahallesi'nde", "Büyük Okyanus'ta", "Osmanlı Devleti'nin").
      // Institution head words ("Üniversitesi", "Partisi", "Kurumu") are excluded from PLACE_APOSTROPHE_HEADS.
      if (placeHead && markCost === 0 && suffix === word.slice(cut) && isValidPlaceApostrophe(stem, suffix)) {
        const markCap = seen > 0 ? this.lexicon.capitalShare(withMark) : 0;
        const seenCaps = Math.round(seen * markCap);
        if (seen >= 5 && markCap >= 0.65 && seenCaps >= typedCaps * 3) {
          add(
            withMark,
            "apostrophe",
            Math.max(log(seenCaps), log(typedCaps) + this.settings.threshold.apostrophe + 0.5) - cost.apostrophe,
            log(typedCaps),
            Math.max(1.5, this.settings.threshold.apostrophe - 1.0),
          );
          continue;
        }
        if (seen === 0 && typedCaps === 0) {
          add(withMark, "apostrophe", this.settings.threshold.apostrophe + 0.5, 0);
          continue;
        }
      }
      if (seen > 0) {
        const markCap = this.lexicon.capitalShare(withMark);
        const stemCap = this.lexicon.capitalShare(stem);
        if (atSentenceStart) {
          if (
            markCap >= 0.7 &&
            stemCap >= 0.55 &&
            !TIME_NAMES_NO_START_APOSTROPHE.has(stem) &&
            !isBlocked()
          ) {
            add(withMark, "apostrophe", log(seen) - cost.apostrophe - markCost, typedScore);
          }
          continue;
        }
        // Do not inject an apostrophe onto a blocked/inflected stem during mark restoration ("Odullerinde" -> "Ödüllerinde").
        if (markCost === 0 || !isBlocked()) {
          let threshold: number | undefined;
          // Unseen mid-sentence proper name with an attested high-cap apostrophe form ("Discord'u", "Arsenal'ı", "Karaca'dan").
          if (
            suffix === word.slice(cut) &&
            markCap >= 0.8 &&
            typedCount === 0 &&
            seen >= 7 &&
            !isBlocked()
          ) {
            threshold = Math.max(1.5, this.settings.threshold.apostrophe - 1.0);
          } else if (
            !realWord &&
            suffix === word.slice(cut) &&
            markCap >= 0.8 &&
            typedCount > 0 &&
            typedCount <= 5 &&
            seen >= 8 &&
            seen >= typedCount * 4 &&
            this.lexicon.count(stem) >= 20 &&
            stemCap >= 0.55 &&
            !isBlocked()
          ) {
            // Non-Turkish word with tiny typo count in corpus ("Malatyaspora" 5 vs "Malatyaspor'a" 96, "Hessin" 5 vs 64).
            threshold = Math.max(1.2, this.settings.threshold.apostrophe - 1.3);
          }
          add(withMark, "apostrophe", log(seen) - cost.apostrophe - markCost, typedScore, threshold);
        }
        // Mid-sentence, compare capitalized-mid-sentence counts too so a lowercase homograph ("elifin", "ekimde",
        // "aşilin") does not hide a clear proper-name apostrophe.
        const seenCaps = Math.round(seen * markCap);
        if (seenCaps >= 10 && seenCaps / seen >= 0.5 && stemCap >= 0.5 && !isBlocked()) {
          // Honorific titles after a mid-sentence proper name ("Aclan Bey'in", "Ayşe Hanım'a") take an apostrophe per TDK.
          const honorificThreshold =
            prevIsName && HONORIFIC_TITLES.has(stem) ? Math.max(1.2, this.settings.threshold.apostrophe - 1.3) : undefined;
          add(withMark, "apostrophe", log(seenCaps) - cost.apostrophe - markCost, log(typedCaps), honorificThreshold);
        }
      }
      if (atSentenceStart) continue;
      // The generic rule applies to unseen forms (or tiny Bloom-only non-word noise when attested) of clear names,
      // keeping the suffix as typed so a mark variant cannot compete with itself ("Weeknd'in" vs fake "Weeknd'ın").
      const effectiveUnseen = formCount === 0 || (formCount <= 2 && !realWord && seen >= 7);
      if (!effectiveUnseen || stem.length < 3 || suffix !== word.slice(cut)) continue;
      const stemCount = this.lexicon.count(stem);
      if (stemCount < 5 || !isValidGenericApostrophe(stem, suffix, hasMorph) || isBlocked()) continue;
      const share = this.lexicon.capitalShare(stem);
      if (stemCount >= minName) {
        if (suffix.length >= 2 && share >= 0.58) {
          add(withMark, "apostrophe", log(stemCount) - cost.apostrophe - markCost - 0.2, typedScore);
        } else if (suffix.length === 1 && share >= 0.75) {
          add(withMark, "apostrophe", log(stemCount) - cost.apostrophe - markCost - 1.2, typedScore);
        } else if (
          hasMorph &&
          !realWord &&
          !this.isRealWord(stem) &&
          stem.length >= 4 &&
          stemCount >= 25 &&
          share >= 0.2 &&
          suffix.length >= 3
        ) {
          // Unseen foreign/brand stem with lower cap share + unambiguous 3+ letter Turkish suffix ("Calypso'dan", "Fonte'nin", "Equestria'daki").
          add(withMark, "apostrophe", log(stemCount) - cost.apostrophe - markCost - 0.2, typedScore);
        }
      } else if (
        hasMorph &&
        formCount === 0 &&
        !realWord &&
        !this.isRealWord(stem) &&
        stem.length >= 4 &&
        share >= 0.55 &&
        suffix.length >= 2
      ) {
        // Rare foreign proper name (count 5..19, high cap share) with harmonized 2+ or 3+ letter Turkish suffix
        // ("Tevet'te", "Salayev'dir", "Tatikios'un", "Morgane'nın", "Tsvangirai'ye").
        const firstSuffixVowel = [...suffix].find((ch) => "aeıioöuü".includes(ch));
        if (suffix.length >= 3 || !firstSuffixVowel || followsHarmony(stem, firstSuffixVowel)) {
          add(withMark, "apostrophe", Math.max(log(stemCount), 3.2) - cost.apostrophe - markCost - 0.2, typedScore);
        }
      }
    }
  }

  /** "hiç bir" -> "hiçbir", "oysa ki" -> "oysaki", "ev de" -> "evde", "vaz geçtim" -> "vazgeçtim", "ann e" -> "anne". */
  private joinCandidate(word: string, next: string, typed = word, nextIsolated = true): Candidate | null {
    if (word.includes("'") || next.includes("'")) return null;
    // Misplaced space inside a single word ("ann e" -> "anne"): requires lowercase first token (protects proper
    // name "Ann"), at least one morphologically invalid part (protects "ne de", "o da"), and a frequent valid join.
    if (this.morphology !== undefined && typed === word && nextIsolated && !JOIN_SECOND.has(next) && !QUESTION.test(next)) {
      const wInvalid = !this.isRealWord(word);
      const nInvalid = !this.isRealWord(next);
      if ((wInvalid || (nInvalid && next.length >= 2)) && (next.length >= 2 || wInvalid)) {
        const joined = word + next;
        if (joined.length >= 4 && this.lexicon.capitalShare(joined) < 0.5 && this.isRealWord(joined)) {
          const count = this.lexicon.exactCount(joined);
          const pair = this.lexicon.pair(word, next);
          if (count >= 50 && count >= Math.max(pair, 1) * 50) {
            const wLower = Math.round(this.lexicon.count(word) * (1 - this.lexicon.capitalShare(word)));
            const nLower = Math.round(this.lexicon.count(next) * (1 - this.lexicon.capitalShare(next)));
            if ((!wInvalid || wLower * 5 < count) && (!nInvalid || nLower * 5 < count)) {
              return {
                text: joined,
                kind: "join",
                score: log(count) - this.settings.cost.join,
                base: log(pair),
                joinsNext: true,
                threshold: 2.5,
              };
            }
          }
        }
      }
    }
    // TDK joined compound verbs across all conjugations ("vaz geçtim" -> "vazgeçtim", "kayıp ettim" -> "kaybettim",
    // "his ediyorum" -> "hissediyorum", "baş vurdum" -> "başvurdum").
    const verbRules = COMPOUND_VERB_JOINS.get(word);
    if (verbRules && this.morphology !== undefined) {
      for (const rule of verbRules) {
        const startsAux =
          next.startsWith(rule.auxStem) || (rule.auxStem === "et" && next.startsWith("ed"));
        if (!startsAux || !this.isVerbFormOf(next, rule.auxStem)) continue;
        const joined = rule.prefix + next;
        if (!this.isRealWord(joined)) continue;
        const pair = this.lexicon.pair(word, next);
        if (rule.strictZeroPair ? pair > 0 : pair > 5) continue;
        const count = this.lexicon.count(joined);
        if (count === 0) continue;
        return {
          text: joined,
          kind: "join",
          score: Math.max(log(count), log(pair) + this.settings.threshold.join + 0.5) - this.settings.cost.join,
          base: log(pair),
          joinsNext: true,
        };
      }
    }
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

  /** Count of the longest shorter prefix (4+ letters) that is itself a seen real word: "arkadaşlarım" for "arkadaşlarımla". */
  private stemCount(text: string): number {
    for (let end = text.length - 1; end >= 4; end--) {
      const stem = text.slice(0, end);
      const count = this.lexicon.exactCount(stem);
      if (count > 0 && this.isRealWord(stem)) return count;
    }
    return 0;
  }

  /**
   * Empirical-Bayes effective frequency combining observed corpus count with the principled morphological
   * generative prior `C(lemma, pos) * P(morphemes | pos)` so unseen/rare valid inflections ("düzenlemiyor",
   * "kullandığımda") rank accurately without inflating bizarre stacked derivations.
   */
  private effectiveCount(cand: string, mode: "autofix" | "rank"): number {
    const obs = this.lexicon.exactCount(cand);
    const prior = this.morphology?.priorCount?.(cand) ?? 0;
    if (prior <= 0) return obs;
    if (mode === "rank") {
      const priorEst = 0.65 * Math.pow(prior, 0.78);
      return Math.max(obs, priorEst) + Math.min(obs, priorEst) * 0.25;
    }
    // Cap unseen-form prior in auto-fix so a corpus-absent inflection ("gerektin") cannot pretend to
    // have count 3,000, while strong unseen forms ("düzenlemiyor", "kullandığımda") still pass cleanly.
    const rawPrior = 0.5 * Math.pow(prior, 0.82);
    const cappedPrior = obs === 0 ? Math.min(45, rawPrior) : Math.min(120, rawPrior);
    return Math.max(obs, cappedPrior);
  }

  /** True when every morphological reading of `word` is accusative ("hatalarını", "arabayı", "kitabını"). */
  private isUnambiguousAccusative(word: string): boolean {
    const analyses = this.morphology?.analyze?.(word);
    if (!analyses || analyses.length === 0) return false;
    return analyses.every((a) => a.morphemes.includes("Acc"));
  }

  /** True when every finite verb reading of `word` is passive or intransitive -lAn ("düzenleniyor"). */
  private isPurelyPassiveVerb(word: string): boolean {
    const analyses = this.morphology?.analyze?.(word);
    if (!analyses || analyses.length === 0) return false;
    const finite = analyses.filter(
      (a) => a.pos === "Verb" || a.morphemes.some((m) => FINITE_VERB_MORPHEMES.has(m)),
    );
    if (finite.length === 0) return false;
    return finite.every((a) => a.morphemes.includes("Pass") || a.morphemes.includes("Acquire"));
  }

  /**
   * True when `word` is a productive, harmonized nominal inflection of a corpus-attested noun/loanword
   * root missing from Zemberek's static dictionary (e.g. "özgeçmişimi" = "özgeçmiş"+"imi", "tripodlar" = "tripod"+"lar").
   * Never activates for roots Zemberek already knows, so real Turkish root typos are never shielded.
   */
  private isAttestedOovInflection(word: string): boolean {
    if (this.morphology === undefined || word.length < 6) return false;
    for (let cut = word.length - 1; cut >= 4; cut--) {
      const root = word.slice(0, cut);
      const suffix = word.slice(cut);
      if (!OOV_NOMINAL_SUFFIX.test(suffix)) continue;
      if (this.lexicon.exactCount(root) < 12 || this.lexicon.capitalShare(root) >= 0.5) continue;
      if (this.isRealWord(root)) continue;
      // Check consonant assimilation & vowel harmony on suffix boundary.
      if (suffix.startsWith("d") && isVoicelessFinal(root)) continue;
      if (suffix.startsWith("t") && !isVoicelessFinal(root)) continue;
      const firstSuffixVowel = [...suffix].find((ch) => VOWELS.has(ch));
      if (firstSuffixVowel && !followsHarmony(root, firstSuffixVowel)) continue;
      // Also verify internal suffix vowels harmonize with each other (except invariant -ki).
      const checkCore = suffix.endsWith("ki") ? suffix.slice(0, -2) : suffix;
      let prevV = root;
      let harmOk = true;
      for (let i = 0; i < checkCore.length; i++) {
        const ch = checkCore[i]!;
        if (VOWELS.has(ch)) {
          if (!followsHarmony(prevV, ch)) {
            harmOk = false;
            break;
          }
          prevV = ch;
        }
      }
      if (harmOk) return true;
    }
    return false;
  }

  /** Detects whether an untouched token should be flagged, returning the SpellFlag or null. */
  private detectFlag(token: Token, context: WordContext, nextTyped?: string): SpellFlag | null {
    return this.detectFlagDetailed(token, context, nextTyped)?.flag ?? null;
  }

  /**
   * Procedural misspelling detector for words not auto-fixed by `check()`.
   * Separates `invalid` (rejected by morphology & unseen) from `rare` (rejected by morphology, very rare,
   * and close to a much stronger valid Turkish word) while protecting proper names, acronyms, foreign/scientific
   * words, apostrophe forms, contractions, and productive inflections of attested OOV nouns.
   */
  private detectFlagDetailed(
    token: Token,
    context: WordContext,
    nextTyped?: string,
  ): { flag: SpellFlag; meta: TypoCandidateMeta[]; coreScores: number[] } | null {
    const typed = token.text;
    if (isAllUpper(typed) || typed.length < 2) return null;
    const word = lowerTr(typed);
    if (word.includes("'")) return null;
    // Mixed/internal uppercase ("MacOS", "OpenAI", "HAProxy", "iPhone"): brand/code, not a spelling flag.
    if (typed.slice(1) !== word.slice(1)) return null;
    const capitalized = isUpperInitial(typed);
    // Mid-sentence capitalized words are proper names.
    if (capitalized && !context.atSentenceStart) return null;
    // Respect contractions: when contractions are off, known contractions stay untouched and unflagged.
    if (this.knownFix(typed, word, context, nextTyped) === "keep") return null;

    const hasMorph = this.morphology !== undefined;
    if (hasMorph && this.isRealWord(word)) return null;

    const typedCount = this.lexicon.count(word);
    // Common words in the corpus (modern loanwords, proper names, terms missing from Zemberek) are not flagged.
    if (typedCount >= 50) return null;
    const capShare = this.lexicon.capitalShare(word);
    // Capitalized sentence-start words that are mostly capitalized in the corpus are proper names.
    // Lowercase words whose corpus occurrences are capitalized proper names ("beek" vs "Beek", "sebz" vs "Sebz")
    // have very low lowercase count and ARE checked as rare typos!
    if (capitalized && typedCount >= 2 && capShare >= 0.45) return null;
    const typedLowerCount = Math.round(typedCount * (1 - capShare));
    // Without morphology, only flag completely unseen lowercase words that have strong lexicon suggestions.
    if (!hasMorph && (typedCount > 0 || capitalized)) return null;

    const ranked = this.rankedSuggestionsFor(typed, word, context, typedCount, nextTyped);
    const top = ranked[0];

    // Protect productive harmonized inflections of attested OOV nouns ("özgeçmişimi", "tripodlar", "stabilitesinden")
    // unless a very close high-frequency valid Turkish word competes.
    if (typedCount === 0 && hasMorph && this.isAttestedOovInflection(word)) {
      const strongComp = top !== undefined && top.morphValid && top.editCost <= 0.85 && top.effCount >= 50;
      if (!strongComp) return null;
    }

    if (typedCount === 0) {
      // Sentence-start capitalized words (Wikipedia / subtitles) are very often proper names ("Maniwaki", "Ruluka").
      // Flag them ONLY when there is a plausible valid Turkish candidate (e.g. "Hoxam" -> "Hocam", "Tikım" -> "Takım",
      // "Maalledek" -> "Mahalledeki"). Allow up to capShare < 0.8 for morph-valid forms of address ("Hocam").
      if (capitalized) {
        if (!top) return null;
        const plausibleAtStart =
          top.kind === "split" ||
          top.kind === "apostrophe" ||
          (top.morphValid &&
            this.lexicon.capitalShare(top.text) < 0.8 &&
            ((top.editCost <= 1.2 && top.effCount >= 1) ||
              (top.editCost <= 1.75 && top.effCount >= 5) ||
              (top.editCost <= 1.95 && top.effCount >= 50)));
        if (!plausibleAtStart) return null;
      } else {
        // Lowercase unseen word rejected by morphology: suppress foreign/scientific/Latin terms that have NO close
        // Turkish candidate ("scapiflora", "neurophyllus", "psychoanalytischer", "milicenton", "dârayî").
        // A word containing Turkish diacritics ("klasöwe" -> "klasöre") or within 1 edit of an attested Turkish word
        // is kept even when a typo hits q/w/x.
        const hasCloseTurkish =
          top !== undefined &&
          (top.kind === "split" ||
            top.kind === "marks" ||
            (top.morphValid &&
              ((top.editCost <= 1.75 && (top.effCount >= 0.5 || top.obsCount >= 1)) ||
                (top.editCost <= 1.9 && top.obsCount >= 15 && hasTurkishMarks(word)))));
        if (!hasCloseTurkish) {
          if (/[qwxâîû]/.test(word) || FOREIGN_TAXONOMIC_SUFFIX.test(word)) return null;
          if (ranked.length === 0) return null;
        }
      }

      const selected = ranked.slice(0, 5);
      const suggestions = selected.map((c) => c.display);
      const meta: TypoCandidateMeta[] = [
        { coreMargin: 0, slipCost: 0, isMarkVariant: false },
        ...selected.map((c) => ({
          coreMargin: c.rankScore,
          slipCost: c.editCost,
          isMarkVariant: c.isMarkVariant,
        })),
      ];
      return {
        flag: { start: token.start, end: token.end, original: typed, suggestions, reason: "invalid" },
        meta,
        coreScores: selected.map((c) => c.rankScore),
      };
    }

    // Rare-but-seen (0 < typedCount < 50) morph-rejected word: flag as "rare" only when very close to a
    // much stronger valid Turkish word ("bka" -> "bak", "aşam" -> "akşam", "gedi" -> "geldi", "beek" -> "bebek",
    // "sebz" -> "sebze", "Afedersiniz" -> "Affedersiniz").
    if (!top) return null;
    // Sentence-start capitalized words already seen in the lexicon (e.g. "Yaghi", "Şeyhhasan", "Kilittaşı") are
    // usually proper names/compounds; only flag them when a massive 1-edit Turkish word dominates ("Afedersiniz").
    if (capitalized) {
      const hugeAtStart =
        top.morphValid &&
        this.lexicon.capitalShare(top.text) < 0.5 &&
        top.editCost <= 0.85 &&
        top.effCount >= Math.max(500, typedCount * 200);
      if (!hugeAtStart) return null;
    } else {
      if (this.lexicon.capitalShare(top.text) >= 0.5) return null;
      const effectiveTyped = Math.max(typedLowerCount, 1);
      const isStrongSplit = top.kind === "split" && top.effCount >= Math.max(80, effectiveTyped * 20);
      const isCloseTypo = ranked.slice(0, 3).some(
        (cand) =>
          cand.morphValid &&
          this.lexicon.capitalShare(cand.text) < 0.5 &&
          ((cand.editCost <= 1.25 && cand.effCount >= Math.max(typedCount <= 3 ? 45 : 80, effectiveTyped * 18)) ||
            (typedCount <= 3 && cand.editCost <= 1.65 && cand.effCount >= 200)),
      );
      if (!isStrongSplit && !isCloseTypo) return null;
    }

    // Protect attested phrase tokens in bigrams ("van der", "de la") from rare flagging.
    const nextLower = nextTyped && !isAllUpper(nextTyped) ? lowerTr(nextTyped) : undefined;
    if (typedCount >= 5 && word.length <= 3) {
      if (context.prevWord && this.lexicon.pair(context.prevWord, word) > 0) return null;
      if (nextLower && this.lexicon.pair(word, nextLower) > 0) return null;
    }

    const selected = ranked.slice(0, 5);
    const suggestions = selected.map((c) => c.display);
    const meta: TypoCandidateMeta[] = [
      { coreMargin: 0, slipCost: 0, isMarkVariant: false },
      ...selected.map((c) => ({
        coreMargin: c.rankScore,
        slipCost: c.editCost,
        isMarkVariant: c.isMarkVariant,
      })),
    ];
    return {
      flag: { start: token.start, end: token.end, original: typed, suggestions, reason: "rare" },
      meta,
      coreScores: selected.map((c) => c.rankScore),
    };
  }

  /**
   * Builds and ranks up to 5 suggestions for a suspicious word using:
   * 1. Existing rule candidates (marks, splits, apostrophes, short typos, 1-edit lexicon typos, double vowel drops),
   * 2. Fast 1-edit mark-folded fuzzy morphological search (catches unseen valid forms + mark-loss + 1 typo),
   * 3. 2-edit mark-folded fuzzy morphological search when 1-edit doesn't yield strong candidates (double omissions / 2 typos),
   * 4. Principled scoring with empirical-Bayes morphological prior, Turkish keyboard edit cost, bigram support,
   *    and Turkish accusative-passive case-voice agreement.
   */
  private rankedSuggestionsFor(
    typed: string,
    word: string,
    context: WordContext,
    typedCount: number,
    nextTyped?: string,
  ): Array<{
    text: string;
    display: string;
    kind: CandidateKind;
    editCost: number;
    obsCount: number;
    effCount: number;
    morphValid: boolean;
    rankScore: number;
    isMarkVariant: boolean;
  }> {
    const foldedWord = foldTr(word);
    const nextLower = nextTyped && !isAllUpper(nextTyped) ? lowerTr(nextTyped) : undefined;
    const prevIsAcc = context.prevWord ? this.isUnambiguousAccusative(context.prevWord) : false;

    const pool = new Map<
      string,
      {
        text: string;
        kind: CandidateKind;
        editCost: number;
        foldedEdits: number;
        morphValid: boolean;
        obsCount: number;
        effCount: number;
      }
    >();

    const consider = (
      candText: string,
      kind: CandidateKind,
      editCost: number,
      knownMorphValid?: boolean,
      foldedEdits = 1,
    ) => {
      if (!candText || candText === word) return;
      const isMulti = candText.includes(" ");
      if (!isMulti) {
        if (!/[aeıioöuüâîû]/.test(candText)) return;
        if (typed === word && this.lexicon.capitalShare(candText) >= 0.65) return;
      }
      const existing = pool.get(candText);
      if (existing && existing.editCost <= editCost) {
        if (foldedEdits < existing.foldedEdits) existing.foldedEdits = foldedEdits;
        return;
      }

      const morphValid =
        knownMorphValid ??
        (isMulti
          ? candText.split(" ").every((p) => this.isRealWord(p) || QUESTION.test(p) || ALSO.test(p) || p === "ki")
          : this.morphology !== undefined && this.isRealWord(candText));
      let obsCount: number;
      let effCount: number;
      if (isMulti) {
        const [p1, p2] = candText.split(" ") as [string, string];
        const pairC = this.lexicon.pair(p1, p2);
        const minC = Math.min(this.lexicon.exactCount(p1), this.lexicon.exactCount(p2));
        obsCount = Math.max(pairC, minC);
        effCount = Math.max(pairC, Math.min(this.effectiveCount(p1, "rank"), Math.max(this.lexicon.count(p2), 50)));
      } else {
        obsCount = this.lexicon.exactCount(candText);
        effCount = morphValid ? this.effectiveCount(candText, "rank") : obsCount;
      }
      // Require either corpus attestation or morphological validity with non-trivial generative prior.
      if (obsCount < 1 && (!morphValid || (this.morphology?.priorCount && effCount < 0.03))) return;

      pool.set(candText, { text: candText, kind, editCost, foldedEdits, morphValid, obsCount, effCount });
    };

    // 1. Existing rule/lexicon candidates (marks, splits, apostrophes, short 3-letter typos, 1-edit lexicon typos).
    const existingCands = this.candidates(word, typed, context, typedCount, nextTyped);
    for (const c of existingCands) {
      if (c.joinsNext) continue;
      let ec: number;
      let fe = 1;
      if (c.kind === "split") ec = 0.85;
      else if (c.kind === "apostrophe") ec = 0.75;
      else {
        ec = turkishEditCost(word, c.text);
        if (foldTr(c.text) === foldedWord) fe = 0;
      }
      consider(c.text, c.kind, ec, undefined, fe);
    }

    // 2. Short 3-letter words: allow swaps, insertions, and near-key substitutions to valid Turkish words ("bka" -> "bak").
    if (word.length === 3 && this.morphology !== undefined) {
      for (const swap of [word[1]! + word[0]! + word[2]!, word[0]! + word[2]! + word[1]!]) {
        if (this.isRealWord(swap)) consider(swap, "typo", turkishEditCost(word, swap), true, 1);
      }
      for (let i = 0; i <= 3; i++) {
        const before = word.slice(0, i);
        const after = word.slice(i);
        for (const ch of ALPHABET) {
          const ins = before + ch + after;
          if (this.lexicon.exactCount(ins) >= 20 && this.isRealWord(ins)) {
            consider(ins, "typo", turkishEditCost(word, ins), true, 1);
          }
        }
      }
      for (let i = 0; i < 3; i++) {
        const at = word[i]!;
        for (const ch of ALPHABET) {
          if (ch !== at && (areNearKeys(ch, at) || (VOWELS.has(ch) && VOWELS.has(at)))) {
            const sub = word.slice(0, i) + ch + word.slice(i + 1);
            if (this.lexicon.exactCount(sub) >= 20 && this.isRealWord(sub)) {
              consider(sub, "typo", turkishEditCost(word, sub), true, 1);
            }
          }
        }
      }
    }

    // 3. Fast 1-edit mark-folded morphological search (handles unseen valid forms + mark-loss + 1 typo).
    if (this.morphology?.fuzzySearch && word.length >= 4 && word.length <= 28) {
      const fuzzy1 = this.morphology.fuzzySearch(word, 1, 30);
      for (const f of fuzzy1) {
        consider(f.word, f.foldedEdits === 0 ? "marks" : "typo", f.editCost, true, f.foldedEdits);
      }

      // 4. Escalate to 2-edit mark-folded morphological search when 1-edit doesn't produce a strong high-confidence
      //    candidate (or leaves a single candidate on medium words), catching double omissions like "grkli" -> "gerekli",
      //    "gerektn" -> "gerçekten", "frmuar" -> "fermuarı", "palıcanlar" -> "patlıcanları", "mahalemize" -> "mahallemizde".
      let veryStrongD1 = 0;
      let cleanTranspositionD1 = 0;
      for (const item of pool.values()) {
        if (item.morphValid && item.foldedEdits <= 1) {
          if (item.editCost <= 1.1 && item.effCount >= 120) veryStrongD1++;
          if (item.editCost <= 0.75 && item.effCount >= 1) cleanTranspositionD1++;
        }
      }
      if ((veryStrongD1 === 0 || (pool.size < 2 && cleanTranspositionD1 === 0)) && word.length >= 4 && word.length <= 18) {
        const fuzzy2 = this.morphology.fuzzySearch(word, 2, 40);
        for (const f of fuzzy2) {
          consider(f.word, "typo", f.editCost, true, f.foldedEdits);
        }
      }
    }

    // 5. Also include direct 1-edit lexicon matches for words with low count (e.g. non-Zemberek words like "caspius").
    if (word.length >= 4 && pool.size < 3) {
      for (const [cand, slip] of this.oneEdit(word, true)) {
        const c = this.lexicon.exactCount(cand);
        if (c >= 5) consider(cand, "typo", Math.min(slip, turkishEditCost(word, cand)), undefined, 1);
      }
    }

    const scored: Array<{
      text: string;
      display: string;
      kind: CandidateKind;
      editCost: number;
      obsCount: number;
      effCount: number;
      morphValid: boolean;
      rankScore: number;
      isMarkVariant: boolean;
    }> = [];

    for (const item of pool.values()) {
      const isMulti = item.text.includes(" ");
      let pairBonus = 0;
      if (!isMulti) {
        if (context.prevWord && this.lexicon.pair(context.prevWord, item.text) > 0) pairBonus += 1.2;
        if (nextLower && this.lexicon.pair(item.text, nextLower) > 0) pairBonus += 1.0;
      }
      const morphPenalty = item.morphValid ? 0 : -1.8;
      // Universal Turkish grammar: an unambiguously accusative direct object ("hatalarını") does not govern a
      // purely passive/intransitive verb ("düzenleniyor"), favoring active transitive readings ("düzenlemiyor").
      const voicePenalty = prevIsAcc && !isMulti && item.morphValid && this.isPurelyPassiveVerb(item.text) ? -1.6 : 0;
      // Bayes channel penalty: 1 keyboard edit is far likelier than 2 edits, so 1-edit transpositions/omissions
      // ("göndredim" -> "gönderdim", "kalelmerimi" -> "kalemlerimi") stay #1 over common 2-edit words while
      // genuine double omissions ("gerektn" -> "gerçekten") still surface cleanly.
      const extraEditPenalty = item.foldedEdits >= 2 ? 1.8 : 0;
      const rankScore = log(item.effCount) - 3.6 * item.editCost - extraEditPenalty + pairBonus + morphPenalty + voicePenalty;
      const display =
        item.kind === "typo" ? matchCase(typed, item.text) : keepCase(typed, item.text);
      scored.push({
        text: item.text,
        display,
        kind: item.kind,
        editCost: item.editCost,
        obsCount: item.obsCount,
        effCount: item.effCount,
        morphValid: item.morphValid,
        rankScore,
        isMarkVariant: !isMulti && foldTr(item.text) === foldedWord,
      });
    }

    scored.sort((a, b) => b.rankScore - a.rankScore || a.editCost - b.editCost);

    // Deduplicate by display string while keeping highest-ranked entry.
    const seenDisplay = new Set<string>();
    const deduped: typeof scored = [];
    for (const s of scored) {
      if (seenDisplay.has(s.display)) continue;
      seenDisplay.add(s.display);
      deduped.push(s);
    }
    return deduped;
  }

  /** Words one edit away, with a cost for edits that are unlikely on a Turkish Q keyboard. */
  private oneEdit(word: string, unseenLowerInvalid = false): Map<string, number> {
    const edits = new Map<string, number>();
    const endCost = unseenLowerInvalid ? Math.min(this.settings.typoEndCost, 0.5) : this.settings.typoEndCost;
    const put = (text: string, slip: number, position: number, finalDelPenalty = 0) => {
      // Changing the end of a word often swaps one real suffix for another ("öyküsüz" is not "öyküsü", "benzeyene"
      // is not "benzeyen"), so edits there cost more.
      const atEnd = position >= word.length - this.settings.typoEndWindow ? endCost : 0;
      // Without morphology (or for capitalized/seen words), block edits on the last letter of 6+ letter words.
      // With morphology on unseen lowercase invalid words, valid inflections are already excluded via !realTyped.
      if (!unseenLowerInvalid && word.length >= 6 && position >= word.length - 1) return;
      const atStart = position === 0 ? 1.5 : 0;
      const total = slip + atEnd + atStart + finalDelPenalty;
      if (text.length > 0 && (edits.get(text) ?? Infinity) > total) edits.set(text, total);
    };
    for (let i = 0; i <= word.length; i++) {
      const before = word.slice(0, i);
      const at = word[i];
      const after = word.slice(i + 1);
      const previous = word[i - 1];
      if (at !== undefined) {
        const following = word[i + 1];
        // An extra key is almost always a duplicate or keyboard neighbor of an adjacent key ("fat-finger").
        const nearExtra =
          (previous !== undefined && (at === previous || areNearKeys(at, previous))) ||
          (following !== undefined && (at === following || areNearKeys(at, following)));
        const isFinalNonDupDelete = i === word.length - 1 && at !== previous;
        // A Turkish letter is typed on purpose; in a word Turkish rules reject it is not a stray key ("çalşıyorum" is
        // a missed "ı" in "çalışıyorum", not an extra "ş" in "çalıyorum").
        const deliberate = unseenLowerInvalid && "çğışöü".includes(at) && at !== previous && at !== following;
        // Deleting a non-duplicate final character (especially a distant key like "m" after "r" in "geliyorm") risks
        // chopping a real person suffix ("geliyorm" -> "geliyor" instead of "geliyorum").
        const finalDelPen = isFinalNonDupDelete && word.length >= 6 ? (nearExtra ? 1.4 : 2.5) : 0;
        const farExtra = unseenLowerInvalid ? this.settings.typoFarExtra : 2.3;
        put(before + after, deliberate ? Math.max(farExtra, 5) : nearExtra ? 0.9 : farExtra, i, finalDelPen); // an extra key
        if (following !== undefined) put(before + following + at + word.slice(i + 2), 0.7, i); // two keys swapped
      }
      const betweenConsonants = previous !== undefined && at !== undefined && !VOWELS.has(previous) && !VOWELS.has(at);
      for (const letter of ALPHABET) {
        if (at !== undefined && letter !== at) {
          if (areNearKeys(letter, at)) put(before + letter + after, 0.8, i);
          else if (VOICING_PAIRS.has(at + letter)) put(before + letter + after, 1.8, i);
          else if (unseenLowerInvalid && this.settings.typoVowelSwap > 0 && VOWELS.has(at) && VOWELS.has(letter)) {
            put(before + letter + after, this.settings.typoVowelSwap, i);
          }
        }
        // Omitting a vowel inside a consonant cluster ("geliyorm", "yapabilirm", "gönderdm") is very common in Turkish.
        const insertSlip = betweenConsonants && VOWELS.has(letter) ? 0.6 : 1.0;
        put(before + letter + word.slice(i), insertSlip, i);
      }
    }
    edits.delete(word);
    return edits;
  }
}
