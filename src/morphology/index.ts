/**
 * Public entry point for the Turkish morphology module.
 * Checks whether a lowercased Turkish word form is valid according to Turkish phonology
 * and morphotactics, exposes full morphological analyses, generative prior counts, and
 * error-tolerant fuzzy morphological candidate generation.
 */

import { MorphologicalAnalyzer } from "./analyzer.ts";
import { parseBinaryDictionaryWithPrior } from "./binary.ts";
import { buildStemIndex, parseDictionaries } from "./dictionary.ts";
import { FuzzyMorphSearch, turkishEditCost, type FuzzyMorphCandidate } from "./fuzzy.ts";
import { getMorphotacticsGraph } from "./morphotactics.ts";
import { MorphPrior } from "./prior.ts";
import type { MorphAnalysis } from "./types.ts";

export type { FuzzyMorphCandidate, MorphAnalysis };
export { MorphPrior, turkishEditCost };

const MAX_PRIOR_CACHE = 16_384;

export class TurkishMorphology {
  private readonly analyzer: MorphologicalAnalyzer;
  private readonly prior?: MorphPrior;
  private readonly priorCache = new Map<string, number>();
  private fuzzyEngine: FuzzyMorphSearch | null = null;

  private constructor(analyzer: MorphologicalAnalyzer, prior?: MorphPrior) {
    this.analyzer = analyzer;
    this.prior = prior;
  }

  /** Sözlük metinlerinden kurar (Zemberek .dict dosyalarının içeriği) ve isteğe bağlı öncül ekler. */
  static fromDictionaries(texts: readonly string[], prior?: MorphPrior): TurkishMorphology {
    const graph = getMorphotacticsGraph();
    const items = parseDictionaries(texts);
    const stemIndex = buildStemIndex(items, graph);
    return new TurkishMorphology(new MorphologicalAnalyzer(stemIndex), prior);
  }

  /** Sıkıştırılmış ikili sözlükten (AMR1/AMR2 `morph.bin`) kurar. */
  static fromBinary(bytes: Uint8Array): TurkishMorphology {
    const graph = getMorphotacticsGraph();
    const { items, prior } = parseBinaryDictionaryWithPrior(bytes);
    const stemIndex = buildStemIndex(items, graph);
    return new TurkishMorphology(new MorphologicalAnalyzer(stemIndex), prior);
  }

  /** Küçük harfli Türkçe biçim (lowerTr ile) Türkçe ek kurallarına göre geçerli bir kelime mi? */
  isWord(form: string): boolean {
    return this.analyzer.isWord(form);
  }

  /** İnceleme ve test için: bulunan çözümlemeler (kök, tür, ek dizisi). */
  analyze(form: string): MorphAnalysis[] {
    return this.analyzer.analyze(form);
  }

  /** Biçimbilimsel üretici öncül (kök sıklığı × ek dizisi olasılığı) yüklü mü? */
  get hasPrior(): boolean {
    return this.prior !== undefined;
  }

  /**
   * Geçerli bir Türkçe biçim için kök sıklığı ve ek dizisi olasılığından beklenen derlem sıklığı.
   * Öncül yüklü değilse veya kelime geçersizse 0 döndürür.
   */
  priorCount(form: string): number {
    if (!this.prior) return 0;
    const cached = this.priorCache.get(form);
    if (cached !== undefined) return cached;
    const analyses = this.analyzer.analyze(form);
    const est = this.prior.expectedCount(analyses);
    if (this.priorCache.size >= MAX_PRIOR_CACHE) this.priorCache.clear();
    this.priorCache.set(form, est);
    return est;
  }

  /** Belirli bir kök+tür çiftinin derlem toplam sıklığı. */
  lemmaCount(stem: string, pos: string): number {
    return this.prior?.lemmaCount(stem, pos) ?? 0;
  }

  /**
   * Hata toleranslı biçimbilim araması: Türkçe işaret kaybı + `maxEdits` (1 veya 2) düzenleme
   * uzaklığındaki geçerli Türkçe biçimleri (derlemde hiç görülmemiş olanlar dahil) bulur.
   */
  fuzzySearch(form: string, maxEdits = 1, maxResults = 40): readonly FuzzyMorphCandidate[] {
    if (this.fuzzyEngine === null) {
      this.fuzzyEngine = new FuzzyMorphSearch(this.analyzer.getStemIndex(), this.analyzer, this.prior);
    }
    return this.fuzzyEngine.search(form, maxEdits, maxResults);
  }
}
