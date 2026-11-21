import { BinaryLexicon } from "./lexicon-binary.ts";

/** Word-form and word-pair counts from edited Turkish text. Forms are lowercased the Turkish way; "ankara'ya" keeps its apostrophe. */
export class Lexicon {
  private readonly counts = new Map<string, number>();
  private readonly capitalized = new Map<string, number>();
  private readonly pairs = new Map<string, number>();
  private binary: BinaryLexicon | null = null;

  /** unigrams: "form\tcount\tcapitalizedMidSentence" lines. bigrams: "first second\tcount" lines. */
  static fromTsv(unigrams: string, bigrams: string, minCount = 1, minPair = 1): Lexicon {
    const lexicon = new Lexicon();
    for (const line of unigrams.split("\n")) {
      if (!line) continue;
      const [form, count, caps] = line.split("\t");
      const value = Number(count);
      if (value < minCount) continue;
      lexicon.counts.set(form!, value);
      if (caps && caps !== "0") lexicon.capitalized.set(form!, Number(caps));
    }
    for (const line of bigrams.split("\n")) {
      if (!line) continue;
      const tab = line.lastIndexOf("\t");
      const value = Number(line.slice(tab + 1));
      if (value >= minPair) lexicon.pairs.set(line.slice(0, tab), value);
    }
    return lexicon;
  }

  /** Loads a compact `ALX1` binary lexicon (`lexicon.bin`) directly into memory without parsing TSV strings. */
  static fromBinary(bytes: Uint8Array): Lexicon {
    const lexicon = new Lexicon();
    lexicon.binary = new BinaryLexicon(bytes);
    return lexicon;
  }

  count(form: string): number {
    if (this.binary !== null) return this.binary.count(form);
    return this.counts.get(form) ?? 0;
  }

  /** Exact-table count only (skips protection-only Bloom filters in binary lexicons for target candidate lookups). */
  exactCount(form: string): number {
    if (this.binary !== null) return this.binary.exactCount(form);
    return this.counts.get(form) ?? 0;
  }

  pair(first: string, second: string): number {
    if (this.binary !== null) return this.binary.pair(first, second);
    return this.pairs.get(first + " " + second) ?? 0;
  }

  /** Share of occurrences written with a capital letter mid-sentence: near 1 for names like "ankara". */
  capitalShare(form: string): number {
    if (this.binary !== null) return this.binary.capitalShare(form);
    const count = this.count(form);
    return count === 0 ? 0 : (this.capitalized.get(form) ?? 0) / count;
  }

  get size(): number {
    if (this.binary !== null) return this.binary.size;
    return this.counts.size;
  }

  get pairCount(): number {
    if (this.binary !== null) return this.binary.pairCount;
    return this.pairs.size;
  }

  /** The lexicon as the two TSV texts it was loaded from, for measuring what a pruned copy would weigh. */
  toTsv(): { unigrams: string; bigrams: string } {
    if (this.binary !== null) return this.binary.toTsv();
    const unigrams = [...this.counts].map(([form, count]) => `${form}\t${count}\t${this.capitalized.get(form) ?? 0}`).join("\n");
    const bigrams = [...this.pairs].map(([pair, count]) => `${pair}\t${count}`).join("\n");
    return { unigrams, bigrams };
  }
}
