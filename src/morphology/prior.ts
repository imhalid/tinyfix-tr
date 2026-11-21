/**
 * Principled morphological generative prior for unseen or rare valid Turkish word forms:
 *   P_hat(form) = max_{a in analyze(form)} C_lemma(a.stem, a.pos) * P(a.morphemes | a.pos)
 *
 * Uses exact corpus-derived suffix chain probabilities with a smoothed morpheme-bigram backoff
 * for unseen/long suffix chains, and quantized per-lemma corpus counts embedded in AMR2 `morph.bin`.
 */

import type { DictionaryItem, MorphAnalysis, PrimaryPos } from "./types.ts";

const PRIOR_MAGIC_0 = 0x4d; // 'M'
const PRIOR_MAGIC_1 = 0x53; // 'S'
const PRIOR_MAGIC_2 = 0x54; // 'T'
const PRIOR_MAGIC_3 = 0x31; // '1'

const PRIMARY_POS_LIST: readonly PrimaryPos[] = [
  "Noun",
  "Adj",
  "Verb",
  "Pron",
  "Adv",
  "Conj",
  "Ques",
  "Postp",
  "Det",
  "Num",
  "Dup",
  "Interj",
  "Punc",
];
const PRIMARY_POS_INDEX = new Map<string, number>(PRIMARY_POS_LIST.map((p, i) => [p, i]));

const LEMMA_LOG_MAX = 17.0; // exp(17) ~ 24M
const PROB_NEG_LOG_MAX = 20.0; // exp(-20) ~ 2e-9
const UNSEEN_BIGRAM_PROB = 1e-4;

/** POS tags inside a morpheme sequence that mark a derivational POS boundary. */
const POS_BOUNDARY_MORPHEMES = new Set(["Noun", "Adj", "Verb", "Adv", "Pron"]);

function quantizeLemmaCount(count: number): number {
  if (count <= 0) return 0;
  const lg = Math.log(count + 1);
  return Math.max(1, Math.min(255, Math.round((lg / LEMMA_LOG_MAX) * 255)));
}

function dequantizeLemmaCount(q: number): number {
  if (q === 0) return 0;
  return Math.exp((q * LEMMA_LOG_MAX) / 255) - 1;
}

function quantizeProb(prob: number): number {
  if (prob <= 0) return 255;
  const nlp = -Math.log(prob);
  if (nlp <= 0) return 0;
  return Math.max(0, Math.min(255, Math.round((nlp / PROB_NEG_LOG_MAX) * 255)));
}

function dequantizeProb(q: number): number {
  return Math.exp((-q * PROB_NEG_LOG_MAX) / 255);
}

function derivationalDepth(morphemes: readonly string[]): number {
  let depth = 0;
  for (let i = 0; i < morphemes.length; i++) {
    if (POS_BOUNDARY_MORPHEMES.has(morphemes[i]!)) depth++;
  }
  return depth;
}

export interface MorphPriorData {
  readonly lemmaCounts: ReadonlyMap<string, number>;
  readonly chainProbs: ReadonlyMap<string, number>;
  readonly bigramProbs: ReadonlyMap<string, number>;
}

/**
 * Runtime morphological generative prior: estimates the expected corpus frequency of any
 * morphologically valid Turkish word from its lemma frequency and suffix-chain probability.
 */
export class MorphPrior {
  private readonly lemmaCounts: Map<string, number>;
  private readonly stemTotals: Map<string, number>;
  private readonly chainProbs: Map<string, number>;
  private readonly bigramProbs: Map<string, number>;

  constructor(data: MorphPriorData) {
    this.lemmaCounts = new Map(data.lemmaCounts);
    this.chainProbs = new Map(data.chainProbs);
    this.bigramProbs = new Map(data.bigramProbs);
    this.stemTotals = new Map<string, number>();
    for (const [key, val] of this.lemmaCounts) {
      const bar = key.indexOf("|");
      if (bar === -1) continue;
      const stem = key.slice(0, bar);
      this.stemTotals.set(stem, (this.stemTotals.get(stem) ?? 0) + val);
    }
  }

  /** Total corpus frequency of `(stem, pos)` with a conservative cross-POS fallback for homographs. */
  lemmaCount(stem: string, pos: string): number {
    const exact = this.lemmaCounts.get(`${stem}|${pos}`);
    if (exact !== undefined && exact > 0) return exact;
    const total = this.stemTotals.get(stem);
    return total !== undefined ? total * 0.2 : 0;
  }

  /** Corpus frequency of `stem` across all parts of speech (for prioritizing fuzzy stem search). */
  stemTotal(stem: string): number {
    return this.stemTotals.get(stem) ?? 0;
  }

  /** Probability `P(morphemes | pos)` using exact stored chain probability or morpheme-bigram backoff. */
  chainProb(pos: string, morphemes: readonly string[]): number {
    const key = `${pos}|${morphemes.join("+")}`;
    const exact = this.chainProbs.get(key);
    if (exact !== undefined) return exact;

    // Smoothed morpheme-bigram backoff for unseen/long suffix chains.
    let prob = 1.0;
    let prev = `^${pos}`;
    for (let i = 0; i < morphemes.length; i++) {
      const cur = morphemes[i]!;
      prob *= this.bigramProbs.get(`${prev}>${cur}`) ?? UNSEEN_BIGRAM_PROB;
      prev = cur;
    }
    prob *= this.bigramProbs.get(`${prev}>$`) ?? UNSEEN_BIGRAM_PROB;
    // Slight damping on backed-off chains so attested chains are preferred when tied.
    return prob * 0.5;
  }

  /**
   * Expected corpus count of a valid word form across its morphological analyses.
   * Returns 0 if `analyses` is empty.
   */
  expectedCount(analyses: readonly MorphAnalysis[]): number {
    if (analyses.length === 0) return 0;
    let best = 0;
    for (let i = 0; i < analyses.length; i++) {
      const a = analyses[i]!;
      const lc = this.lemmaCount(a.stem, a.pos);
      if (lc <= 0) continue;
      const est = lc * this.chainProb(a.pos, a.morphemes);
      if (est > best) best = est;
    }
    return best;
  }

  get chainSize(): number {
    return this.chainProbs.size;
  }

  get bigramSize(): number {
    return this.bigramProbs.size;
  }

  get lemmaSize(): number {
    return this.lemmaCounts.size;
  }

  /** Raw maps for binary serialization. */
  toData(): MorphPriorData {
    return {
      lemmaCounts: this.lemmaCounts,
      chainProbs: this.chainProbs,
      bigramProbs: this.bigramProbs,
    };
  }
}

interface AnalyzerLike {
  analyze(form: string): readonly MorphAnalysis[];
}

function collectCorpusStats(
  analyzer: AnalyzerLike,
  tsv: string,
  hasCapColumn: boolean,
  minCount: number,
): {
  posTotal: Map<string, number>;
  lemmaCount: Map<string, number>;
  chainCount: Map<string, number>;
  chainTypes: Map<string, number>;
  bigramCount: Map<string, number>;
  bigramCtx: Map<string, number>;
} {
  const posTotal = new Map<string, number>();
  const lemmaCount = new Map<string, number>();
  const chainCount = new Map<string, number>();
  const chainTypes = new Map<string, number>();
  const bigramCount = new Map<string, number>();
  const bigramCtx = new Map<string, number>();

  for (const line of tsv.split("\n")) {
    if (!line) continue;
    const parts = line.split("\t");
    const form = parts[0];
    if (!form || form.includes("'")) continue;
    const count = Number(parts[1]);
    if (!Number.isFinite(count) || count < minCount) continue;
    if (hasCapColumn) {
      const caps = Number(parts[2] ?? "0");
      if (caps / count >= 0.7) continue;
    }
    const analyses = analyzer.analyze(form);
    if (analyses.length === 0) continue;

    // Prefer analyses with minimum derivational depth so bare Adj ("eksik" []) and bare Noun ("eksik" ["A3sg"])
    // share weight fairly while deep spurious derivations are discounted.
    let minDeriv = Infinity;
    for (let i = 0; i < analyses.length; i++) {
      const d = derivationalDepth(analyses[i]!.morphemes);
      if (d < minDeriv) minDeriv = d;
    }
    const best = analyses.filter((a) => derivationalDepth(a.morphemes) === minDeriv);
    const w = count / best.length;

    for (let i = 0; i < best.length; i++) {
      const a = best[i]!;
      posTotal.set(a.pos, (posTotal.get(a.pos) ?? 0) + w);
      const lk = `${a.stem}|${a.pos}`;
      lemmaCount.set(lk, (lemmaCount.get(lk) ?? 0) + w);
      const ck = `${a.pos}|${a.morphemes.join("+")}`;
      chainCount.set(ck, (chainCount.get(ck) ?? 0) + w);
      chainTypes.set(ck, (chainTypes.get(ck) ?? 0) + 1);

      let prev = `^${a.pos}`;
      for (let m = 0; m < a.morphemes.length; m++) {
        const cur = a.morphemes[m]!;
        const bk = `${prev}>${cur}`;
        bigramCount.set(bk, (bigramCount.get(bk) ?? 0) + w);
        bigramCtx.set(prev, (bigramCtx.get(prev) ?? 0) + w);
        prev = cur;
      }
      const endKey = `${prev}>$`;
      bigramCount.set(endKey, (bigramCount.get(endKey) ?? 0) + w);
      bigramCtx.set(prev, (bigramCtx.get(prev) ?? 0) + w);
    }
  }

  return { posTotal, lemmaCount, chainCount, chainTypes, bigramCount, bigramCtx };
}

/**
 * Extracts lemma frequencies and register-balanced suffix-chain + morpheme-bigram probabilities
 * from `unigrams_conv.tsv` and (optionally) `subtitle_counts.tsv`.
 */
export function buildMorphPriorFromCorpora(
  analyzer: AnalyzerLike,
  unigramsConvTsv: string,
  subtitleTsv?: string,
  options: { minChainTypes?: number; minChainCount?: number; subtitleWeight?: number } = {},
): MorphPrior {
  const minChainTypes = options.minChainTypes ?? 3;
  const minChainCount = options.minChainCount ?? 40;
  const subWeight = subtitleTsv ? (options.subtitleWeight ?? 0.45) : 0;
  const convWeight = 1 - subWeight;

  const conv = collectCorpusStats(analyzer, unigramsConvTsv, true, 2);
  const sub = subtitleTsv ? collectCorpusStats(analyzer, subtitleTsv, false, 2) : null;

  // Lemma counts come from the combined lexicon corpus (unigrams_conv.tsv), matching exactCount() scale.
  const lemmaCounts = new Map<string, number>(conv.lemmaCount);
  if (sub) {
    // Include spoken lemmas missing or very rare in Wikipedia at a conservative scale.
    for (const [lk, sc] of sub.lemmaCount) {
      const existing = lemmaCounts.get(lk) ?? 0;
      if (sc > existing) {
        lemmaCounts.set(lk, Math.max(existing, sc * 0.5));
      }
    }
  }

  // Register-balanced suffix-chain probabilities P(chain | pos).
  const allChains = new Set<string>(conv.chainCount.keys());
  if (sub) {
    for (const k of sub.chainCount.keys()) allChains.add(k);
  }
  const chainProbs = new Map<string, number>();
  for (const ck of allChains) {
    const convTypes = conv.chainTypes.get(ck) ?? 0;
    const subTypes = sub?.chainTypes.get(ck) ?? 0;
    const convC = conv.chainCount.get(ck) ?? 0;
    const subC = sub?.chainCount.get(ck) ?? 0;
    if (convTypes + subTypes < minChainTypes || convC + subC < minChainCount) continue;

    const pos = ck.slice(0, ck.indexOf("|"));
    const pConv = convC / (conv.posTotal.get(pos) ?? 1);
    const pSub = sub ? subC / (sub.posTotal.get(pos) ?? 1) : pConv;
    const p = convWeight * pConv + subWeight * pSub;
    if (p > 0) chainProbs.set(ck, p);
  }

  // Register-balanced morpheme-bigram backoff probabilities P(next | prev).
  const allBigrams = new Set<string>(conv.bigramCount.keys());
  if (sub) {
    for (const k of sub.bigramCount.keys()) allBigrams.add(k);
  }
  const bigramProbs = new Map<string, number>();
  for (const bk of allBigrams) {
    const gt = bk.indexOf(">");
    const prev = bk.slice(0, gt);
    const cConv = conv.bigramCount.get(bk) ?? 0;
    const cSub = sub?.bigramCount.get(bk) ?? 0;
    if (cConv + cSub < 5) continue;
    const pConv = (cConv + 0.5) / ((conv.bigramCtx.get(prev) ?? 0) + 50);
    const pSub = sub ? (cSub + 0.5) / ((sub.bigramCtx.get(prev) ?? 0) + 50) : pConv;
    const p = convWeight * pConv + subWeight * pSub;
    if (p > 0) bigramProbs.set(bk, p);
  }

  return new MorphPrior({ lemmaCounts, chainProbs, bigramProbs });
}

/**
 * Serializes a `MorphPrior` into a compact `MST1` binary block aligned with sorted `DictionaryItem[]`.
 */
export function encodeMorphPrior(prior: MorphPrior, sortedItems: readonly DictionaryItem[]): Uint8Array {
  const data = prior.toData();
  const encoder = new TextEncoder();

  // 1. Per-item quantized lemma count (aligned to sortedItems index).
  const itemCount = sortedItems.length;
  const lemmaCol = new Uint8Array(itemCount);
  for (let i = 0; i < itemCount; i++) {
    const item = sortedItems[i]!;
    const count = data.lemmaCounts.get(`${item.root}|${item.primaryPos}`) ?? 0;
    lemmaCol[i] = quantizeLemmaCount(count);
  }

  // 2. Build shared symbol table for morpheme IDs, ^POS start tokens, and $ end token.
  const symToId = new Map<string, number>();
  const symList: string[] = [];
  const intern = (sym: string): number => {
    let id = symToId.get(sym);
    if (id === undefined) {
      id = symList.length;
      if (id > 255) throw new Error(`morph prior: symbol table overflow (${id} > 255)`);
      symToId.set(sym, id);
      symList.push(sym);
    }
    return id;
  };

  // Pre-sort chains deterministically for better compression.
  const chainEntries: Array<{ posIdx: number; mIds: number[]; qProb: number }> = [];
  for (const [key, prob] of [...data.chainProbs.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const bar = key.indexOf("|");
    const pos = key.slice(0, bar);
    const posIdx = PRIMARY_POS_INDEX.get(pos);
    if (posIdx === undefined) continue;
    const rest = key.slice(bar + 1);
    const morphs = rest.length === 0 ? [] : rest.split("+");
    if (morphs.length > 255) continue;
    const mIds = morphs.map(intern);
    chainEntries.push({ posIdx, mIds, qProb: quantizeProb(prob) });
  }

  const bigramEntries: Array<{ prevId: number; nextId: number; qProb: number }> = [];
  for (const [key, prob] of [...data.bigramProbs.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const gt = key.indexOf(">");
    const prev = key.slice(0, gt);
    const next = key.slice(gt + 1);
    bigramEntries.push({ prevId: intern(prev), nextId: intern(next), qProb: quantizeProb(prob) });
  }

  // Encode symbol table.
  const symBytesArr: number[] = [];
  for (const sym of symList) {
    const enc = encoder.encode(sym);
    symBytesArr.push(enc.byteLength);
    for (let j = 0; j < enc.byteLength; j++) symBytesArr.push(enc[j]!);
  }
  const symBytes = new Uint8Array(symBytesArr);

  // Encode chains.
  const chainBytesArr: number[] = [];
  for (const ch of chainEntries) {
    chainBytesArr.push(ch.posIdx, ch.mIds.length);
    for (let j = 0; j < ch.mIds.length; j++) chainBytesArr.push(ch.mIds[j]!);
    chainBytesArr.push(ch.qProb);
  }
  const chainBytes = new Uint8Array(chainBytesArr);

  // Encode bigrams.
  const bigramBytes = new Uint8Array(bigramEntries.length * 3);
  for (let i = 0; i < bigramEntries.length; i++) {
    const bg = bigramEntries[i]!;
    bigramBytes[i * 3] = bg.prevId;
    bigramBytes[i * 3 + 1] = bg.nextId;
    bigramBytes[i * 3 + 2] = bg.qProb;
  }

  // Layout: 4 magic ('MST1') + 2 symCount + 4 symByteLen + 4 chainCount + 4 chainByteLen + 4 bigramCount
  //       + lemmaCol (itemCount) + symBytes + chainBytes + bigramBytes
  const headerLen = 22;
  const totalLen = headerLen + lemmaCol.byteLength + symBytes.byteLength + chainBytes.byteLength + bigramBytes.byteLength;
  const out = new Uint8Array(totalLen);
  const view = new DataView(out.buffer);
  let off = 0;

  out[off++] = PRIOR_MAGIC_0;
  out[off++] = PRIOR_MAGIC_1;
  out[off++] = PRIOR_MAGIC_2;
  out[off++] = PRIOR_MAGIC_3;
  view.setUint16(off, symList.length, true);
  off += 2;
  view.setUint32(off, symBytes.byteLength, true);
  off += 4;
  view.setUint32(off, chainEntries.length, true);
  off += 4;
  view.setUint32(off, chainBytes.byteLength, true);
  off += 4;
  view.setUint32(off, bigramEntries.length, true);
  off += 4;

  out.set(lemmaCol, off);
  off += lemmaCol.byteLength;
  out.set(symBytes, off);
  off += symBytes.byteLength;
  out.set(chainBytes, off);
  off += chainBytes.byteLength;
  out.set(bigramBytes, off);

  return out;
}

/**
 * Decodes an `MST1` binary block starting at `startOffset` in `bytes`.
 */
export function decodeMorphPrior(
  bytes: Uint8Array,
  startOffset: number,
  sortedItems: readonly DictionaryItem[],
): MorphPrior {
  if (
    bytes.byteLength - startOffset < 22 ||
    bytes[startOffset] !== PRIOR_MAGIC_0 ||
    bytes[startOffset + 1] !== PRIOR_MAGIC_1 ||
    bytes[startOffset + 2] !== PRIOR_MAGIC_2 ||
    bytes[startOffset + 3] !== PRIOR_MAGIC_3
  ) {
    throw new Error("autr: Geçersiz biçimbilim öncül bloğu (MST1 bekleniyordu).");
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let off = startOffset + 4;
  const symCount = view.getUint16(off, true);
  off += 2;
  const symByteLen = view.getUint32(off, true);
  off += 4;
  const chainCount = view.getUint32(off, true);
  off += 4;
  const chainByteLen = view.getUint32(off, true);
  off += 4;
  const bigramCount = view.getUint32(off, true);
  off += 4;

  const itemCount = sortedItems.length;
  const lemmaCol = bytes.subarray(off, off + itemCount);
  off += itemCount;

  const decoder = new TextDecoder("utf-8");
  const symList = new Array<string>(symCount);
  let symPos = off;
  for (let i = 0; i < symCount; i++) {
    const len = bytes[symPos++]!;
    symList[i] = decoder.decode(bytes.subarray(symPos, symPos + len));
    symPos += len;
  }
  off += symByteLen;

  const chainEnd = off + chainByteLen;
  const chainProbs = new Map<string, number>();
  let cPos = off;
  for (let i = 0; i < chainCount && cPos < chainEnd; i++) {
    const posIdx = bytes[cPos++]!;
    const len = bytes[cPos++]!;
    const pos = PRIMARY_POS_LIST[posIdx]!;
    if (len === 0) {
      const qProb = bytes[cPos++]!;
      chainProbs.set(`${pos}|`, dequantizeProb(qProb));
    } else {
      const parts = new Array<string>(len);
      for (let j = 0; j < len; j++) parts[j] = symList[bytes[cPos++]!]!;
      const qProb = bytes[cPos++]!;
      chainProbs.set(`${pos}|${parts.join("+")}`, dequantizeProb(qProb));
    }
  }
  off = chainEnd;

  const bigramProbs = new Map<string, number>();
  for (let i = 0; i < bigramCount; i++) {
    const prev = symList[bytes[off++]!]!;
    const next = symList[bytes[off++]!]!;
    const qProb = bytes[off++]!;
    bigramProbs.set(`${prev}>${next}`, dequantizeProb(qProb));
  }

  const lemmaCounts = new Map<string, number>();
  for (let i = 0; i < itemCount; i++) {
    const q = lemmaCol[i]!;
    if (q === 0) continue;
    const item = sortedItems[i]!;
    const key = `${item.root}|${item.primaryPos}`;
    const val = dequantizeLemmaCount(q);
    const existing = lemmaCounts.get(key);
    if (existing === undefined || val > existing) {
      lemmaCounts.set(key, val);
    }
  }

  return new MorphPrior({ lemmaCounts, chainProbs, bigramProbs });
}
