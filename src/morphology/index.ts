/**
 * Public entry point for the Turkish morphology module.
 * Checks whether a lowercased Turkish word form is valid according to Turkish phonology
 * and morphotactics, and exposes full morphological analyses for inspection and testing.
 */

import { MorphologicalAnalyzer } from "./analyzer.ts";
import { buildStemIndex, parseDictionaries } from "./dictionary.ts";
import { getMorphotacticsGraph } from "./morphotactics.ts";
import type { MorphAnalysis } from "./types.ts";

export type { MorphAnalysis };

export class TurkishMorphology {
  private readonly analyzer: MorphologicalAnalyzer;

  private constructor(analyzer: MorphologicalAnalyzer) {
    this.analyzer = analyzer;
  }

  /** Sözlük metinlerinden kurar (Zemberek .dict dosyalarının içeriği). */
  static fromDictionaries(texts: readonly string[]): TurkishMorphology {
    const graph = getMorphotacticsGraph();
    const items = parseDictionaries(texts);
    const stemIndex = buildStemIndex(items, graph);
    return new TurkishMorphology(new MorphologicalAnalyzer(stemIndex));
  }

  /** Küçük harfli Türkçe biçim (lowerTr ile) Türkçe ek kurallarına göre geçerli bir kelime mi? */
  isWord(form: string): boolean {
    return this.analyzer.isWord(form);
  }

  /** İnceleme ve test için: bulunan çözümlemeler (kök, tür, ek dizisi). */
  analyze(form: string): MorphAnalysis[] {
    return this.analyzer.analyze(form);
  }
}
