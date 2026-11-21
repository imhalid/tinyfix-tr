import type { Lexicon } from "./lexicon.ts";
import { isValidKnownParticleSuffix } from "./rules/turkish-rules.ts";

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

const MAX_SUFFIX = 6;
const SUFFIX = /^[a-zçğıöşü]+$/;

/**
 * Misspellings people make often enough to list: "herkez" -> "herkes", "birşey" -> "bir şey", "hiç bir" -> "hiçbir".
 * A rule also covers the wrong form with a suffix ("herkezin" -> "herkesin") when the fixed form with that suffix is
 * a word the lexicon has seen, so "yalnış" never reaches into "yalnızlık".
 */
export class KnownMisspellings {
  private readonly single = new Map<string, Rule>();
  private readonly byFirstWord = new Map<string, Rule[]>();
  private readonly stems: Rule[] = [];

  /** Lines of data/rules/known.tsv: wrong, right, wrong count, right count, section. */
  static fromTsv(text: string): KnownMisspellings {
    const known = new KnownMisspellings();
    for (const line of text.split("\n")) {
      if (!line || line.startsWith("#")) continue;
      const [wrong, right, , rightCount, section] = line.split("\t");
      if (!wrong || !right) continue;
      const rule = { wrong, right, rightCount: Number(rightCount), contraction: section?.trim() === "CONTRACTION" };
      const words = wrong.split(" ");
      if (words.length === 1) {
        known.single.set(wrong, rule);
        if (wrong.length >= 4) known.stems.push(rule);
      } else if (words.length === 2) {
        const list = known.byFirstWord.get(words[0]!) ?? [];
        list.push(rule);
        known.byFirstWord.set(words[0]!, list);
      }
    }
    known.stems.sort((first, second) => second.wrong.length - first.wrong.length);
    return known;
  }

  get size(): number {
    return this.single.size + [...this.byFirstWord.values()].reduce((sum, list) => sum + list.length, 0);
  }

  /** Fixes for a lowercased word, and for it with the next word when a two-word rule matches. */
  find(word: string, next: string | undefined, lexicon: Lexicon): KnownFix[] {
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
    }
    return fixes;
  }
}
