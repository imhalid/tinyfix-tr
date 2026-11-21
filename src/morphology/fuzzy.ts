/**
 * Fast, error-tolerant morphological search over Zemberek's StemIndex + Morphotactics FST.
 *
 * Finds morphologically valid Turkish words within 1 or 2 Damerau-Levenshtein edits (plus
 * arbitrary Turkish diacritic restoration) — including completely unseen inflected forms
 * like "düzenlemiyor" from "duzenblemiyor" or "duzenlemniyor", and double omissions like
 * "grkli" -> "gerekli" or "beketiyruz" -> "bekletiyoruz".
 *
 * Key performance techniques:
 * - Lazy compact mark-folded stem trie built in RAM from StemIndex (~10 ms, 0 bytes on disk).
 * - Banded Damerau-Levenshtein DP on a preallocated flat Uint8Array slab (zero heap allocations).
 * - Zero-remaining-edits exact mark-folded suffix fast path inside the FST.
 * - Lemma-frequency-prioritized stem ordering and bounded FST expansion + LRU result cache.
 */

import { areNearKeys, lowerTr } from "../turkish.ts";
import type { MorphologicalAnalyzer } from "./analyzer.ts";
import type { StemIndex } from "./dictionary.ts";
import {
  PA_CANNOT_TERMINATE,
  computeNextPhoneticAttrs,
  generateSurface,
  surfaceCacheKey,
} from "./phonetics.ts";
import type { MorphPrior } from "./prior.ts";
import type { MorphemeState, PathNode, StemTransition, SuffixTransition } from "./types.ts";

export interface FuzzyMorphCandidate {
  /** Morphologically valid lowercase Turkish word. */
  readonly word: string;
  /** Mark-folded Damerau-Levenshtein edit distance (0 = mark restoration only, 1 or 2 = edits). */
  readonly foldedEdits: number;
  /** Rich Turkish Q-keyboard + mark-loss edit cost. */
  readonly editCost: number;
}

const MAX_WORD_LEN = 48;
const MAX_FUZZY_CACHE = 4096;
const INF_DIST = 99;

const VOWELS = new Set(["a", "e", "ı", "i", "o", "ö", "u", "ü"]);
const VOICING_PAIRS = new Set(["dt", "td", "bp", "pb", "cç", "çc", "gk", "kg", "gğ", "ğg"]);
const MARK_RESTORE_PAIRS = new Set(["cç", "gğ", "iı", "oö", "sş", "uü"]);
const MARK_STRIP_PAIRS = new Set(["çc", "ğg", "ıi", "öo", "şs", "üu"]);
const TURKISH_MARKS = new Set(["ç", "ğ", "ı", "ö", "ş", "ü"]);

/** Maps lowercase Turkish characters (and circumflexes) to ASCII codes 0..25 (26 = other). */
const FOLD_CODE = new Uint8Array(65536).fill(26);
for (let c = 97; c <= 122; c++) FOLD_CODE[c] = c - 97; // a..z
FOLD_CODE["ç".charCodeAt(0)] = "c".charCodeAt(0) - 97;
FOLD_CODE["ğ".charCodeAt(0)] = "g".charCodeAt(0) - 97;
FOLD_CODE["ı".charCodeAt(0)] = "i".charCodeAt(0) - 97;
FOLD_CODE["ö".charCodeAt(0)] = "o".charCodeAt(0) - 97;
FOLD_CODE["ş".charCodeAt(0)] = "s".charCodeAt(0) - 97;
FOLD_CODE["ü".charCodeAt(0)] = "u".charCodeAt(0) - 97;
FOLD_CODE["â".charCodeAt(0)] = "a".charCodeAt(0) - 97;
FOLD_CODE["î".charCodeAt(0)] = "i".charCodeAt(0) - 97;
FOLD_CODE["û".charCodeAt(0)] = "u".charCodeAt(0) - 97;

function charSubCost(typedCh: string, candCh: string, typedIndex: number): number {
  if (typedCh === candCh) return 0;
  const pair = typedCh + candCh;
  if (MARK_RESTORE_PAIRS.has(pair) || (typedIndex === 0 && typedCh === "ı" && candCh === "i")) {
    return 0.35;
  }
  if (MARK_STRIP_PAIRS.has(pair)) {
    return 1.25;
  }
  const lead = typedIndex === 0 ? 0.45 : 0;
  if (areNearKeys(typedCh, candCh)) return 0.8 + lead;
  if (VOWELS.has(typedCh) && VOWELS.has(candCh)) return 1.1 + lead;
  if (VOICING_PAIRS.has(pair)) return 1.25 + lead;
  return 1.8 + lead;
}

/**
 * Exact Turkish Q-keyboard + mark-loss + transposition edit cost between `typed` and `cand`.
 * Lower is closer; ~0.35 for a missing Turkish mark, ~0.6-0.95 for a single typo, ~1.2-1.8 for two errors.
 */
export function turkishEditCost(typed: string, cand: string): number {
  const m = typed.length;
  const n = cand.length;
  if (m === 0) return n;
  if (n === 0) return m;
  if (typed === cand) return 0;

  const stride = n + 1;
  const dp = new Float64Array((m + 1) * stride);
  for (let i = 1; i <= m; i++) {
    const ch = typed[i - 1]!;
    const prev = i > 1 ? typed[i - 2] : undefined;
    const next = i < m ? typed[i] : undefined;
    const isDup = ch === prev || ch === next;
    const isNear = (prev !== undefined && areNearKeys(ch, prev)) || (next !== undefined && areNearKeys(ch, next));
    const delCost = isDup ? 0.65 : isNear ? 0.85 : TURKISH_MARKS.has(ch) ? 2.4 : 1.9;
    dp[i * stride] = dp[(i - 1) * stride]! + delCost + (i === 1 ? 0.45 : 0);
  }
  for (let j = 1; j <= n; j++) {
    const ch = cand[j - 1]!;
    const isDup = j > 1 && ch === cand[j - 2];
    const insCost = isDup ? 0.65 : 0.95;
    dp[j] = dp[j - 1]! + insCost + (j === 1 ? 0.45 : 0);
  }

  for (let i = 1; i <= m; i++) {
    const tc = typed[i - 1]!;
    const tPrev = i > 1 ? typed[i - 2] : undefined;
    const tNext = i < m ? typed[i] : undefined;
    const isDupDel = tc === tPrev || tc === tNext;
    const isNearDel =
      (tPrev !== undefined && areNearKeys(tc, tPrev)) || (tNext !== undefined && areNearKeys(tc, tNext));
    const delCost = (isDupDel ? 0.65 : isNearDel ? 0.85 : TURKISH_MARKS.has(tc) ? 2.4 : 1.9) + (i === 1 ? 0.45 : 0);
    const rowOff = i * stride;
    const prevOff = (i - 1) * stride;

    for (let j = 1; j <= n; j++) {
      const cc = cand[j - 1]!;
      const sub = dp[prevOff + j - 1]! + charSubCost(tc, cc, i - 1);
      const del = dp[prevOff + j]! + delCost;

      // Insertion of cc into typed between typed[i-1] and typed[i] (missing letter in typed).
      const betweenConsonants =
        tNext !== undefined && !VOWELS.has(tc) && !VOWELS.has(tNext);
      const isDupIns = cc === tc || cc === tNext;
      const insBase = betweenConsonants && VOWELS.has(cc) ? 0.6 : isDupIns ? 0.65 : 0.95;
      const ins = dp[rowOff + j - 1]! + insBase;

      let best = sub < del ? (sub < ins ? sub : ins) : del < ins ? del : ins;

      // Adjacent transposition (also allowing mark restoration on the swapped letters).
      if (i >= 2 && j >= 2) {
        const tcPrev = typed[i - 2]!;
        const ccPrev = cand[j - 2]!;
        const c1 = charSubCost(tcPrev, cc, i - 2);
        const c2 = charSubCost(tc, ccPrev, i - 1);
        if (c1 <= 0.35 && c2 <= 0.35) {
          const trans = dp[(i - 2) * stride + j - 2]! + 0.7 + c1 + c2 + (i === 2 ? 0.35 : 0);
          if (trans < best) best = trans;
        }
      }

      dp[rowOff + j] = best;
    }
  }
  return dp[m * stride + n]!;
}

interface TrieNode {
  readonly keys: number[];
  readonly children: TrieNode[];
  stems: StemTransition[] | null;
}

interface ExactNode extends PathNode {
  readonly word: string;
  readonly derivCount: number;
}

interface FuzzyNode extends PathNode {
  readonly word: string;
  readonly row: Uint8Array;
  readonly prevRow: Uint8Array | null;
  readonly lastCode: number;
  readonly derivCount: number;
}

function resolveSurfaceAndNextPhonetic(
  tr: SuffixTransition,
  phonetic: number,
): { surface: string; nextPhonetic: number } | null {
  const key = surfaceCacheKey(phonetic);
  let surface = tr.surfaceCache[key];
  if (surface === undefined) {
    const generated = generateSurface(tr.tokens, phonetic);
    tr.surfaceCache[key] = generated;
    if (generated !== null) {
      tr.nextPhoneticCache[key] = computeNextPhoneticAttrs(generated, phonetic, tr.lastToken);
    }
    surface = generated;
  }
  if (surface === null) return null;
  return { surface, nextPhonetic: tr.nextPhoneticCache[key] ?? 0 };
}

function exceedsLocalRepeat(node: PathNode, stateId: string): boolean {
  let count = 0;
  let cur: PathNode | null = node;
  while (cur !== null) {
    if (cur.state.id === stateId) {
      count++;
      if (count >= 2) return true;
    }
    cur = cur.prev;
  }
  return false;
}

export class FuzzyMorphSearch {
  private readonly analyzer: MorphologicalAnalyzer;
  private readonly prior?: MorphPrior;
  private readonly root: TrieNode;
  private readonly dpSlab: Uint8Array;
  private readonly wordCodes = new Uint8Array(MAX_WORD_LEN);
  private readonly cache = new Map<string, readonly FuzzyMorphCandidate[]>();

  constructor(stemIndex: StemIndex, analyzer: MorphologicalAnalyzer, prior?: MorphPrior) {
    this.analyzer = analyzer;
    this.prior = prior;
    this.dpSlab = new Uint8Array((MAX_WORD_LEN + 6) * (MAX_WORD_LEN + 2));

    // Build compact mark-folded stem trie once (~10 ms).
    const root: TrieNode = { keys: [], children: [], stems: null };
    for (const [surface, entry] of stemIndex.stems) {
      if (surface.length === 0 || surface.length > MAX_WORD_LEN) continue;
      let node = root;
      let ok = true;
      for (let i = 0; i < surface.length; i++) {
        const code = FOLD_CODE[surface.charCodeAt(i)]!;
        if (code >= 26) {
          ok = false;
          break;
        }
        const keys = node.keys;
        let idx = -1;
        for (let k = 0; k < keys.length; k++) {
          if (keys[k] === code) {
            idx = k;
            break;
          }
        }
        if (idx === -1) {
          const next: TrieNode = { keys: [], children: [], stems: null };
          keys.push(code);
          node.children.push(next);
          node = next;
        } else {
          node = node.children[idx]!;
        }
      }
      if (!ok) continue;
      if (node.stems === null) node.stems = [];
      if (Array.isArray(entry)) {
        for (let i = 0; i < entry.length; i++) node.stems.push(entry[i]!);
      } else {
        node.stems.push(entry);
      }
    }
    this.root = root;
  }

  /**
   * Finds valid Turkish words within `maxEdits` (1 or 2) mark-folded Damerau-Levenshtein edits of `form`.
   * Results are verified via `analyzer.isWord()` and sorted by `editCost` ascending.
   */
  search(form: string, maxEdits = 1, maxResults = 40): readonly FuzzyMorphCandidate[] {
    const word = lowerTr(form);
    const L = word.length;
    if (L < 3 || L > MAX_WORD_LEN - 4) return [];

    const cacheKey = `${maxEdits}:${word}`;
    const cached = this.cache.get(cacheKey);
    if (cached !== undefined) return cached.length <= maxResults ? cached : cached.slice(0, maxResults);

    const wCodes = this.wordCodes;
    for (let i = 0; i < L; i++) {
      const code = FOLD_CODE[word.charCodeAt(i)]!;
      wCodes[i] = code;
    }

    const stride = L + 1;
    const slab = this.dpSlab;
    // Row 0: [0, 1, 2, ..., L]
    for (let j = 0; j <= L; j++) slab[j] = j;

    const stemHits: Array<{
      st: StemTransition;
      row: Uint8Array;
      prevRow: Uint8Array | null;
      lastCode: number;
      bestDist: number;
      lemmaScore: number;
    }> = [];

    const maxStemDepth = Math.min(L + maxEdits, MAX_WORD_LEN);

    const dfsTrie = (node: TrieNode, depth: number, lastCode: number): void => {
      const rowOff = depth * stride;
      if (node.stems !== null && depth >= 1) {
        const loJ = depth > maxEdits ? depth - maxEdits : 0;
        const hiJ = depth + maxEdits < L ? depth + maxEdits : L;
        let best = maxEdits + 1;
        for (let j = loJ; j <= hiJ; j++) {
          const v = slab[rowOff + j]!;
          if (v < best) best = v;
        }
        if (best <= maxEdits && (depth >= 2 || slab[rowOff + 1] === 0)) {
          const rowCopy = slab.slice(rowOff, rowOff + stride);
          const prevCopy = depth > 0 ? slab.slice((depth - 1) * stride, depth * stride) : null;
          const stems = node.stems;
          for (let i = 0; i < stems.length; i++) {
            const st = stems[i]!;
            const lemmaScore = this.prior ? this.prior.stemTotal(st.item.root) : 0;
            stemHits.push({
              st,
              row: rowCopy,
              prevRow: prevCopy,
              lastCode,
              bestDist: best,
              lemmaScore,
            });
          }
        }
      }

      if (depth >= maxStemDepth) return;
      const nextDepth = depth + 1;
      const nextOff = nextDepth * stride;
      const prevOff = (depth - 1) * stride;
      const loJ = nextDepth > maxEdits + 1 ? nextDepth - maxEdits - 1 : 1;
      const hiJ = nextDepth + maxEdits + 1 < L ? nextDepth + maxEdits + 1 : L;

      const keys = node.keys;
      const children = node.children;
      for (let k = 0; k < keys.length; k++) {
        const code = keys[k]!;
        // Initialize entire row to INF_DIST so out-of-band entries (especially row[L] on short stems)
        // never read stale zeros from earlier searches or unvisited cells.
        slab.fill(INF_DIST, nextOff, nextOff + stride);
        if (loJ === 1) slab[nextOff] = nextDepth;

        let minVal = nextDepth;
        for (let j = loJ; j <= hiJ; j++) {
          const sub = slab[rowOff + j - 1]! + (wCodes[j - 1] === code ? 0 : 1);
          const del = slab[rowOff + j]! + 1;
          const ins = slab[nextOff + j - 1]! + 1;
          let v = sub < del ? (sub < ins ? sub : ins) : del < ins ? del : ins;
          if (depth >= 1 && j >= 2 && wCodes[j - 1] === lastCode && wCodes[j - 2] === code) {
            const trans = slab[prevOff + j - 2]! + 1;
            if (trans < v) v = trans;
          }
          slab[nextOff + j] = v;
          if (v < minVal) minVal = v;
        }
        if (minVal <= maxEdits) {
          dfsTrie(children[k]!, nextDepth, code);
        }
      }
    };

    dfsTrie(this.root, 0, 26);

    // Explore smallest edit distance first, then longest stems first (prevents short 2-3 letter stems from starving real roots),
    // breaking ties by lemma frequency.
    stemHits.sort(
      (a, b) =>
        a.bestDist - b.bestDist ||
        b.st.surface.length - a.st.surface.length ||
        b.lemmaScore - a.lemmaScore,
    );

    const found = new Map<string, number>();
    const maxFstSteps = maxEdits <= 1 ? 1500 : 3500;
    const maxStepsPerStem = maxEdits <= 1 ? 160 : 220;
    const virtualInputLen = L + maxEdits + 1;
    let fstSteps = 0;

    // Fast exact mark-folded suffix expansion when remaining edit budget is 0.
    const expandExactFolded = (st: StemTransition, startPosInW: number, usedEdits: number, stemLimit: number): void => {
      const stack: ExactNode[] = [
        {
          prev: null,
          stemTransition: st,
          state: st.to,
          surface: st.surface,
          pos: startPosInW,
          inputLength: L,
          phonetic: st.phonetic,
          depth: 0,
          hasSurface: false,
          hasDerivation: false,
          currentGroupHasSurface: false,
          lastDerivation: null,
          word: st.surface,
          derivCount: 0,
        },
      ];
      while (stack.length > 0 && fstSteps < stemLimit) {
        const node = stack.pop()!;
        fstSteps++;
        if (node.pos === L && node.state.terminal && (node.phonetic & PA_CANNOT_TERMINATE) === 0) {
          const prev = found.get(node.word);
          if (prev === undefined || usedEdits < prev) found.set(node.word, usedEdits);
        }
        if (node.depth >= 14) continue;
        const remaining = L - node.pos;
        const outgoing = node.state.outgoing;
        const phonetic = node.phonetic;
        for (let i = 0; i < outgoing.length; i++) {
          const tr = outgoing[i]!;
          const isDeriv = tr.to.derivative;
          if (isDeriv && node.derivCount >= 2) continue;
          if (!tr.hasSurface) {
            if (tr.condition !== null && !tr.condition(node)) continue;
            if (node.depth > 4 && exceedsLocalRepeat(node, tr.to.id)) continue;
            stack.push({
              prev: node,
              stemTransition: node.stemTransition,
              state: tr.to,
              surface: "",
              pos: node.pos,
              inputLength: L,
              phonetic,
              depth: node.depth + 1,
              hasSurface: node.hasSurface,
              hasDerivation: node.hasDerivation || isDeriv,
              currentGroupHasSurface: isDeriv ? false : node.currentGroupHasSurface,
              lastDerivation: isDeriv ? tr.to : node.lastDerivation,
              word: node.word,
              derivCount: node.derivCount + (isDeriv ? 1 : 0),
            });
            continue;
          }
          if (remaining === 0 || (phonetic & tr.forbiddenPhonetic) !== 0) continue;
          const resolved = resolveSurfaceAndNextPhonetic(tr, phonetic);
          if (resolved === null) continue;
          const { surface, nextPhonetic } = resolved;
          const sLen = surface.length;
          if (sLen > remaining) continue;
          let matched = true;
          for (let k = 0; k < sLen; k++) {
            if (FOLD_CODE[surface.charCodeAt(k)] !== wCodes[node.pos + k]) {
              matched = false;
              break;
            }
          }
          if (!matched) continue;
          if (tr.condition !== null && !tr.condition(node)) continue;
          if (node.depth > 4 && exceedsLocalRepeat(node, tr.to.id)) continue;
          stack.push({
            prev: node,
            stemTransition: node.stemTransition,
            state: tr.to,
            surface,
            pos: node.pos + sLen,
            inputLength: L,
            phonetic: nextPhonetic,
            depth: node.depth + 1,
            hasSurface: true,
            hasDerivation: node.hasDerivation || isDeriv,
            currentGroupHasSurface: isDeriv ? false : true,
            lastDerivation: isDeriv ? tr.to : node.lastDerivation,
            word: node.word + surface,
            derivCount: node.derivCount + (isDeriv ? 1 : 0),
          });
        }
      }
    };

    const advanceOneCode = (
      prevRow: Uint8Array,
      prevPrevRow: Uint8Array | null,
      code: number,
      prevCode: number,
      candLen: number,
    ): Uint8Array | null => {
      const loJ = candLen > maxEdits + 1 ? candLen - maxEdits - 1 : 1;
      const hiJ = candLen + maxEdits + 1 < L ? candLen + maxEdits + 1 : L;
      // Fast pre-check before allocating: compute into scratch row first, copy only if minVal <= maxEdits.
      const scratch = slab;
      const scratchOff = (maxStemDepth + 2) * stride;
      scratch.fill(INF_DIST, scratchOff, scratchOff + stride);
      if (loJ === 1) scratch[scratchOff] = candLen;
      let minVal = candLen <= maxEdits ? candLen : INF_DIST;
      for (let j = loJ; j <= hiJ; j++) {
        const sub = prevRow[j - 1]! + (wCodes[j - 1] === code ? 0 : 1);
        const del = prevRow[j]! + 1;
        const ins = scratch[scratchOff + j - 1]! + 1;
        let v = sub < del ? (sub < ins ? sub : ins) : del < ins ? del : ins;
        if (prevPrevRow !== null && j >= 2 && prevCode < 26 && wCodes[j - 1] === prevCode && wCodes[j - 2] === code) {
          const trans = prevPrevRow[j - 2]! + 1;
          if (trans < v) v = trans;
        }
        scratch[scratchOff + j] = v;
        if (v < minVal) minVal = v;
      }
      return minVal <= maxEdits ? scratch.slice(scratchOff, scratchOff + stride) : null;
    };

    for (let h = 0; h < stemHits.length && fstSteps < maxFstSteps; h++) {
      const hit = stemHits[h]!;
      const st = hit.st;
      const stemLimit = Math.min(maxFstSteps, fstSteps + maxStepsPerStem);

      // Zero remaining edits: use ultra-fast exact mark-folded suffix expansion UNLESS a cross-boundary
      // transposition (stem's last char == next typed char, e.g. "kalem|lerimi" vs "kalel|merimi") is possible.
      if (hit.bestDist === maxEdits) {
        const sLen = st.surface.length;
        const loJ = sLen > maxEdits ? sLen - maxEdits : 0;
        const hiJ = sLen + maxEdits < L ? sLen + maxEdits : L;
        let canBoundarySwap = false;
        if (hit.prevRow !== null && hit.lastCode < 26) {
          for (let j = Math.max(1, loJ); j <= hiJ && j < L; j++) {
            if (hit.prevRow[j - 1]! < maxEdits && wCodes[j] === hit.lastCode) {
              canBoundarySwap = true;
              break;
            }
          }
        }
        if (!canBoundarySwap) {
          for (let j = loJ; j <= hiJ && fstSteps < stemLimit; j++) {
            if (hit.row[j] === maxEdits) {
              expandExactFolded(st, j, maxEdits, stemLimit);
            }
          }
          continue;
        }
      }

      // Remaining edit budget >= 1 (or cross-boundary transposition): run banded fuzzy FST DFS.
      const stack: FuzzyNode[] = [
        {
          prev: null,
          stemTransition: st,
          state: st.to,
          surface: st.surface,
          pos: st.surface.length,
          inputLength: virtualInputLen,
          phonetic: st.phonetic,
          depth: 0,
          hasSurface: false,
          hasDerivation: false,
          currentGroupHasSurface: false,
          lastDerivation: null,
          word: st.surface,
          row: hit.row,
          prevRow: hit.prevRow,
          lastCode: hit.lastCode,
          derivCount: 0,
        },
      ];

      while (stack.length > 0 && fstSteps < stemLimit) {
        const node = stack.pop()!;
        fstSteps++;

        const endDist = node.row[L]!;
        if (endDist <= maxEdits && node.state.terminal && (node.phonetic & PA_CANNOT_TERMINATE) === 0) {
          const prev = found.get(node.word);
          if (prev === undefined || endDist < prev) found.set(node.word, endDist);
        }

        if (node.depth >= 12) continue;
        const outgoing = node.state.outgoing;
        const phonetic = node.phonetic;

        for (let i = 0; i < outgoing.length; i++) {
          const tr = outgoing[i]!;
          const isDeriv = tr.to.derivative;
          if (isDeriv && node.derivCount >= 2) continue;

          if (!tr.hasSurface) {
            if (tr.condition !== null && !tr.condition(node)) continue;
            if (node.depth > 4 && exceedsLocalRepeat(node, tr.to.id)) continue;
            stack.push({
              prev: node,
              stemTransition: node.stemTransition,
              state: tr.to,
              surface: "",
              pos: node.pos,
              inputLength: virtualInputLen,
              phonetic,
              depth: node.depth + 1,
              hasSurface: node.hasSurface,
              hasDerivation: node.hasDerivation || isDeriv,
              currentGroupHasSurface: isDeriv ? false : node.currentGroupHasSurface,
              lastDerivation: isDeriv ? tr.to : node.lastDerivation,
              word: node.word,
              row: node.row,
              prevRow: node.prevRow,
              lastCode: node.lastCode,
              derivCount: node.derivCount + (isDeriv ? 1 : 0),
            });
            continue;
          }

          if ((phonetic & tr.forbiddenPhonetic) !== 0) continue;
          const resolved = resolveSurfaceAndNextPhonetic(tr, phonetic);
          if (resolved === null) continue;
          const { surface, nextPhonetic } = resolved;
          const newLen = node.word.length + surface.length;
          if (newLen > L + maxEdits) continue;

          let curRow = node.row;
          let curPrev = node.prevRow;
          let curCode = node.lastCode;
          let curLen = node.word.length;
          let ok = true;
          for (let k = 0; k < surface.length; k++) {
            const code = FOLD_CODE[surface.charCodeAt(k)]!;
            curLen++;
            const nextRow = advanceOneCode(curRow, curPrev, code, curCode, curLen);
            if (nextRow === null) {
              ok = false;
              break;
            }
            curPrev = curRow;
            curRow = nextRow;
            curCode = code;
          }
          if (!ok) continue;
          if (tr.condition !== null && !tr.condition(node)) continue;
          if (node.depth > 4 && exceedsLocalRepeat(node, tr.to.id)) continue;

          stack.push({
            prev: node,
            stemTransition: node.stemTransition,
            state: tr.to,
            surface,
            pos: newLen,
            inputLength: virtualInputLen,
            phonetic: nextPhonetic,
            depth: node.depth + 1,
            hasSurface: true,
            hasDerivation: node.hasDerivation || isDeriv,
            currentGroupHasSurface: isDeriv ? false : true,
            lastDerivation: isDeriv ? tr.to : node.lastDerivation,
            word: node.word + surface,
            row: curRow,
            prevRow: curPrev,
            lastCode: curCode,
            derivCount: node.derivCount + (isDeriv ? 1 : 0),
          });
        }
      }
    }

    // Verify every emitted candidate with exact analyzer.isWord() and compute rich Turkish edit cost.
    const verified: FuzzyMorphCandidate[] = [];
    for (const [cand, foldedEdits] of found) {
      if (cand === word || Math.abs(cand.length - L) > maxEdits) continue;
      if (!this.analyzer.isWord(cand)) continue;
      verified.push({ word: cand, foldedEdits, editCost: turkishEditCost(word, cand) });
    }
    verified.sort((a, b) => a.editCost - b.editCost || a.foldedEdits - b.foldedEdits);

    if (this.cache.size >= MAX_FUZZY_CACHE) this.cache.clear();
    this.cache.set(cacheKey, verified);
    return verified.length <= maxResults ? verified : verified.slice(0, maxResults);
  }
}
