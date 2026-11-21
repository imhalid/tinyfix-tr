import type { Lexicon } from "./lexicon.ts";
import { stripMarksIn } from "./turkish.ts";
import { isValidKnownParticleSuffix } from "./rules/turkish-rules.ts";
import { CANONICAL_PHRASES, foldTurkish } from "./rules/proper-names.ts";

/** A known misspelling and its fix, checked against corpus counts by py/verify_lists.py. */
interface Rule {
  wrong: string;
  right: string;
  rightCount: number;
  /** A deliberate spoken-style form ("noldu", "burda"), fixed only when the writer asks for it. */
  contraction: boolean;
}

export interface KnownFix {
  text: string;
  /** How often the fix is seen, for comparing with what was typed. */
  count: number;
  /** True when the rule covers the next word too ("hiç bir" -> "hiçbir"). */
  joinsNext: boolean;
  /** True for spoken-style contractions ("noldu" -> "ne oldu"): see Rule.contraction. */
  contraction: boolean;
}

export interface NameEntry {
  readonly name: string;
  readonly count: number;
  /** True when suffixes on this proper name take NO apostrophe per TDK (languages, derivations, religions like "Türkçe", "Hinduizm"). */
  readonly noApos: boolean;
}

export interface PhraseEntry {
  readonly words: readonly string[];
  readonly displayWords: readonly string[];
  /** True when inflectional suffixes on the final word take an apostrophe (places, events, works); false for institutions. */
  readonly takesApos: boolean;
}

const MAX_SUFFIX = 6;
const SUFFIX = /^[a-zçğıöşü]+$/;

/**
 * Misspellings people make often enough to list: "herkez" -> "herkes", "birşey" -> "bir şey", "hiç bir" -> "hiçbir".
 * A rule also covers the wrong form with a suffix ("herkezin" -> "herkesin") when the fixed form with that suffix is
 * a word the lexicon has seen, so "yalnış" never reaches into "yalnızlık".
 *
 * Also stores proper-name tables appended into `known.tsv` for the browser bundle:
 *   NAME, ACRO, GIVEN, SURNAME, AMBIG, PHRASE_APOS, PHRASE_NOAPOS.
 */
export class KnownMisspellings {
  private readonly single = new Map<string, Rule>();
  private readonly byFirstWord = new Map<string, Rule[]>();
  /** Two-word rules with Turkish letters, keyed by the first word without them ("hic" for "hiç bir"). */
  private readonly byPlainFirstWord = new Map<string, Rule[]>();
  private readonly stems: Rule[] = [];
  /** Unconditional proper names always written with a capital ("ahmet" -> "Ahmet"). */
  private readonly names = new Map<string, NameEntry>();
  /** Unique ASCII-folded lookup for proper names with Turkish diacritics ("canakkale" -> "Çanakkale"). */
  private readonly asciiNames = new Map<string, NameEntry | null>();
  /** Unconditional all-caps acronyms ("tbmm" -> "TBMM", "nato" -> "NATO"). */
  private readonly acronyms = new Map<string, { upper: string; count: number }>();
  /** Unique ASCII-folded lookup for acronyms with diacritics ("itu" -> "İTÜ", "odtu" -> "ODTÜ"). */
  private readonly asciiAcronyms = new Map<string, { upper: string; count: number } | null>();
  /** Turkish given names (including ambiguous names like "deniz", "umut", "defne") for person-frame rules. */
  private readonly givenNames = new Map<string, string>();
  /** Turkish surnames (including ambiguous surnames like "çelik", "şahin", "kaya") for person-frame rules. */
  private readonly surnames = new Map<string, string>();
  /** Ambiguous names (both proper name and ordinary Turkish word) for contextual disambiguation. */
  private readonly ambigNames = new Map<string, string>();
  /** Multi-word proper phrases indexed by lowercased first word (longest first). */
  private readonly phrasesByFirst = new Map<string, PhraseEntry[]>();
  /** Multi-word proper phrases indexed by ASCII-folded first word (for ASCII-typed sentences). */
  private readonly phrasesByPlainFirst = new Map<string, PhraseEntry[]>();
  private hasCanonicalPhrases = false;

  /** Lines of data/rules/known.tsv: wrong, right, wrong count/flags, right count, section. */
  static fromTsv(text: string): KnownMisspellings {
    const known = new KnownMisspellings();
    let hasProperSections = false;
    for (const line of text.split("\n")) {
      if (!line || line.startsWith("#")) continue;
      const [wrong, right, col3, rightCount, sectionRaw] = line.split("\t");
      if (!wrong || !right) continue;
      const section = sectionRaw?.trim();
      if (section === "NAME") {
        hasProperSections = true;
        const noApos = col3?.includes("noapos") ?? false;
        const entry: NameEntry = { name: right, count: Number(rightCount) || 0, noApos };
        known.names.set(wrong, entry);
        const folded = foldTurkish(wrong);
        if (folded !== wrong) {
          const prev = known.asciiNames.get(folded);
          if (prev === undefined) known.asciiNames.set(folded, entry);
          else if (prev !== null && prev.name !== entry.name) known.asciiNames.set(folded, null);
        }
        continue;
      }
      if (section === "ACRO") {
        hasProperSections = true;
        const entry = { upper: right, count: Number(rightCount) || 0 };
        known.acronyms.set(wrong, entry);
        const folded = foldTurkish(wrong);
        if (folded !== wrong) {
          const prev = known.asciiAcronyms.get(folded);
          if (prev === undefined) known.asciiAcronyms.set(folded, entry);
          else if (prev !== null && prev.upper !== entry.upper) known.asciiAcronyms.set(folded, null);
        }
        continue;
      }
      if (section === "GIVEN") {
        hasProperSections = true;
        known.givenNames.set(wrong, right);
        continue;
      }
      if (section === "SURNAME") {
        hasProperSections = true;
        known.surnames.set(wrong, right);
        continue;
      }
      if (section === "AMBIG") {
        hasProperSections = true;
        known.ambigNames.set(wrong, right);
        continue;
      }
      if (section === "PHRASE_APOS" || section === "PHRASE_NOAPOS") {
        hasProperSections = true;
        known.addPhrase(wrong, right, section === "PHRASE_APOS");
        continue;
      }
      const rule = { wrong, right, rightCount: Number(rightCount), contraction: section === "CONTRACTION" };
      const words = wrong.split(" ");
      if (words.length === 1) {
        known.single.set(wrong, rule);
        if (wrong.length >= 4) known.stems.push(rule);
      } else if (words.length === 2) {
        const list = known.byFirstWord.get(words[0]!) ?? [];
        list.push(rule);
        known.byFirstWord.set(words[0]!, list);
        const plainFirst = plain(words[0]!);
        if (plain(wrong) !== wrong) {
          const plainList = known.byPlainFirstWord.get(plainFirst) ?? [];
          plainList.push(rule);
          known.byPlainFirstWord.set(plainFirst, plainList);
        }
      }
    }
    // Always register canonical TDK multi-word phrases when proper-name sections are present (or lazily via ensureCanonicalPhrases).
    if (hasProperSections) {
      known.ensureCanonicalPhrases();
    }
    known.stems.sort((first, second) => second.wrong.length - first.wrong.length);
    for (const list of known.phrasesByFirst.values()) {
      list.sort((a, b) => b.words.length - a.words.length);
    }
    for (const list of known.phrasesByPlainFirst.values()) {
      list.sort((a, b) => b.words.length - a.words.length);
    }
    return known;
  }

  private addPhrase(lowerPhrase: string, displayPhrase: string, takesApos: boolean): void {
    const words = lowerPhrase.split(" ");
    const displayWords = displayPhrase.split(" ");
    if (words.length < 2 || words.length !== displayWords.length) return;
    const first = words[0]!;
    const existing = this.phrasesByFirst.get(first);
    if (existing?.some((p) => p.words.length === words.length && p.words.every((w, i) => w === words[i]))) {
      return;
    }
    const entry: PhraseEntry = { words, displayWords, takesApos };
    if (existing) existing.push(entry);
    else this.phrasesByFirst.set(first, [entry]);

    const plainFirst = foldTurkish(first);
    if (foldTurkish(lowerPhrase) !== lowerPhrase) {
      const pList = this.phrasesByPlainFirst.get(plainFirst);
      if (pList) pList.push(entry);
      else this.phrasesByPlainFirst.set(plainFirst, [entry]);
    }
  }

  private ensureCanonicalPhrases(): void {
    if (this.hasCanonicalPhrases) return;
    this.hasCanonicalPhrases = true;
    for (const [display, takesApos] of CANONICAL_PHRASES) {
      this.addPhrase(
        display.replaceAll("I", "ı").replaceAll("İ", "i").toLowerCase(),
        display,
        takesApos,
      );
    }
  }

  /** The capitalized spelling of a proper name, from its lowercase form ("istanbul" -> "İstanbul"). */
  nameFor(lower: string, minCount = 0): string | undefined {
    const entry = this.names.get(lower);
    return entry && entry.count >= minCount ? entry.name : undefined;
  }

  /** Full metadata for a proper name, including whether TDK forbids apostrophes on it. */
  nameEntry(lower: string, minCount = 0): NameEntry | undefined {
    const entry = this.names.get(lower);
    return entry && entry.count >= minCount ? entry : undefined;
  }

  /** Unique ASCII-folded proper-name lookup ("canakkale" -> "Çanakkale"), excluding exact hits. */
  asciiNameEntry(foldedLower: string, minCount = 0): NameEntry | undefined {
    const entry = this.asciiNames.get(foldedLower);
    return entry && entry.count >= minCount ? entry : undefined;
  }

  /** All-caps acronym lookup ("tbmm" -> "TBMM"). */
  acronymFor(lower: string): string | undefined {
    return this.acronyms.get(lower)?.upper;
  }

  /** Unique ASCII-folded acronym lookup ("itu" -> "İTÜ"). */
  asciiAcronymFor(foldedLower: string): string | undefined {
    const entry = this.asciiAcronyms.get(foldedLower);
    return entry ? entry.upper : undefined;
  }

  /** Known Turkish given name (including ambiguous ones like "deniz", "umut", "defne"). */
  givenNameFor(lower: string): string | undefined {
    return this.givenNames.get(lower);
  }

  /** Known Turkish surname (including ambiguous ones like "çelik", "şahin", "kaya"). */
  surnameFor(lower: string): string | undefined {
    return this.surnames.get(lower);
  }

  /** Known ambiguous name (person/place/work word that is also a common Turkish noun). */
  ambigNameFor(lower: string): string | undefined {
    return this.ambigNames.get(lower);
  }

  /** Multi-word proper phrases starting with `firstLower` (or ASCII-folded when `allowPlain` is true). */
  phrasesStartingWith(firstLower: string, allowPlain = false): readonly PhraseEntry[] {
    const exact = this.phrasesByFirst.get(firstLower);
    if (!allowPlain) return exact ?? [];
    const plainList = this.phrasesByPlainFirst.get(foldTurkish(firstLower));
    if (!plainList) return exact ?? [];
    if (!exact) return plainList;
    return [...exact, ...plainList];
  }

  get hasProperData(): boolean {
    return this.names.size > 0;
  }

  get size(): number {
    return this.single.size + [...this.byFirstWord.values()].reduce((sum, list) => sum + list.length, 0);
  }

  /**
   * Fixes for a lowercased word, and for it with the next word when a two-word rule matches. With `typedPlain` (the
   * sentence is typed without Turkish letters) a two-word rule also matches its plain form: "hic bir" -> "hiçbir".
   */
  find(word: string, next: string | undefined, lexicon: Lexicon, typedPlain = false): KnownFix[] {
    const fixes: KnownFix[] = [];
    const exact = this.single.get(word);
    if (exact) fixes.push({ text: exact.right, count: exact.rightCount, joinsNext: false, contraction: exact.contraction });
    else {
      for (const rule of this.stems) {
        if (!word.startsWith(rule.wrong)) continue;
        const suffix = word.slice(rule.wrong.length);
        if (suffix.length > MAX_SUFFIX || !SUFFIX.test(suffix)) continue;
        if (!isValidKnownParticleSuffix(rule.right, suffix)) continue;
        const fixed = rule.right + suffix;
        const lastWord = fixed.split(" ").at(-1)!;
        const count = lexicon.count(lastWord);
        if (count > 0) {
          fixes.push({ text: fixed, count: Math.min(count, rule.rightCount), joinsNext: false, contraction: rule.contraction });
          break;
        }
      }
    }
    if (next) {
      for (const rule of this.byFirstWord.get(word) ?? []) {
        const second = rule.wrong.split(" ")[1]!;
        if (next === second) fixes.push({ text: rule.right, count: rule.rightCount, joinsNext: true, contraction: rule.contraction });
        else if (next.startsWith(second) && SUFFIX.test(next.slice(second.length)) && next.length - second.length <= MAX_SUFFIX) {
          const suffix = next.slice(second.length);
          if (!isValidKnownParticleSuffix(rule.right, suffix)) continue;
          const fixed = rule.right + suffix;
          const count = lexicon.count(fixed.split(" ").at(-1)!);
          if (count > 0) fixes.push({ text: fixed, count: Math.min(count, rule.rightCount), joinsNext: true, contraction: rule.contraction });
        }
      }
      if (typedPlain && fixes.every((fix) => !fix.joinsNext)) {
        for (const rule of this.byPlainFirstWord.get(word) ?? []) {
          if (plain(rule.wrong) === `${word} ${next}`) {
            fixes.push({ text: rule.right, count: rule.rightCount, joinsNext: true, contraction: rule.contraction });
          }
        }
      }
    }
    return fixes;
  }
}

/** The word without Turkish letters. */
function plain(text: string): string {
  return stripMarksIn(text, [[0, text.length]]);
}
