/**
 * The context model: scores how well a candidate span fits between the text on its left and right.
 *
 * Supports:
 *   - v3 Subword Transformer ONNX (`subwords [n, T]`, `sub_segments [n, T]`, `features [n, 26]`)
 *   - v2 Char-Conv ONNX (`tokens [n, 144]`, `segments [n, 144]`, `features [n, 18]`)
 *   - v1 Char-Conv ONNX & fake test runners (`tokens [n, 144]`, `segments [n, 144]`)
 *
 * Character encoding, subword tokenization, sequence packing, and 26-dim feature layout here
 * must match py/build_tokenizer.py, py/context_data.py, and py/context_arch.py exactly.
 */
import { CONTEXT_VOCAB_TEXT } from "./context-vocab.ts";
import type { Lexicon } from "./lexicon.ts";
import { hasTurkishMarks, isAllUpper, isUpperInitial, LETTERS, lowerTr } from "./turkish.ts";

export const LEFT = 80;
export const RIGHT = 40;
export const SPAN = 24;
export const SEQUENCE = LEFT + SPAN + RIGHT;

export const LEFT_SUB = 24;
export const SPAN_SUB = 8;
export const RIGHT_SUB = 20;
export const MAX_SUB_LEN = 64;

export const FEATURE_DIM = 26;
export const LEGACY_FEATURE_DIM = 18;

export type ContextKind = "marks" | "de_da" | "ki" | "mi" | "typo";

/** 0 is padding, 1 is any character not listed. */
export const ALPHABET = "abcçdefgğhıijklmnoöprsştuüvyzâîûqwxABCÇDEFGĞHIİJKLMNOÖPRSŞTUÜVYZÂÎÛQWX0 .,;:!?'\"()-";
const CHAR_ID = new Map([...ALPHABET].map((char, index) => [char, index + 2]));

const POSS_MORPHEMES = new Set(["P1sg", "P2sg", "P3sg", "P1pl", "P2pl", "P3pl"]);
const FINITE_MORPHEMES = new Set(["Prog1", "Prog2", "Past", "Narr", "Fut", "Aor", "Opt", "Desr", "Neces", "Imp"]);
const FUNC_POS = new Set(["Pron", "Conj", "Postp", "Det"]);

const WORD_PREFIX = "▁";
const SUB_PAD_ID = 0;
const SUB_UNK_ID = 1;
const SUB_CLS_ID = 2;
const SUB_CAP_ID = 4;
const SUB_ALLCAP_ID = 5;
const SUB_NUM_ID = 6;
const SUB_TOKEN_RE = new RegExp(`[${LETTERS}]+|[0-9]+|[^\\s]`, "g");

let vocabCache: { idOf: Map<string, number>; maxLen: number } | null = null;

function getSubwordVocab(): { idOf: Map<string, number>; maxLen: number } {
  if (vocabCache) return vocabCache;
  const lines = CONTEXT_VOCAB_TEXT.split("\n");
  const idOf = new Map<string, number>();
  let maxLen = 1;
  for (let i = 0; i < lines.length; i++) {
    const tok = lines[i]!;
    idOf.set(tok, i);
    if (!(tok.startsWith("<") && tok.endsWith(">")) && tok.length > maxLen) {
      maxLen = tok.length;
    }
  }
  vocabCache = { idOf, maxLen };
  return vocabCache;
}

function encodeSubwordPiece(low: string, wordStart: boolean, idOf: Map<string, number>, maxLen: number, out: number[]): void {
  const n = low.length;
  let pos = 0;
  while (pos < n) {
    if (pos === 0 && wordStart) {
      let end = Math.min(n, maxLen - 1);
      let found = -1;
      while (end > 0) {
        const tid = idOf.get(WORD_PREFIX + low.slice(0, end));
        if (tid !== undefined) {
          found = tid;
          break;
        }
        end--;
      }
      if (found !== -1) {
        out.push(found);
        pos = end;
      } else {
        out.push(SUB_UNK_ID);
        pos++;
      }
    } else {
      let end = Math.min(n, pos + maxLen);
      let found = -1;
      while (end > pos) {
        const tid = idOf.get(low.slice(pos, end));
        if (tid !== undefined) {
          found = tid;
          break;
        }
        end--;
      }
      if (found !== -1) {
        out.push(found);
        pos = end;
      } else {
        out.push(SUB_UNK_ID);
        pos++;
      }
    }
  }
}

/** Deterministic greedy longest-match Turkish subword tokenizer (bit-identical to py/build_tokenizer.py). */
export function encodeSubwords(text: string): number[] {
  const { idOf, maxLen } = getSubwordVocab();
  const norm = text.replaceAll("’", "'");
  const out: number[] = [];
  SUB_TOKEN_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SUB_TOKEN_RE.exec(norm)) !== null) {
    const tok = match[0];
    const ch0 = tok[0]!;
    if (ch0 >= "0" && ch0 <= "9") {
      out.push(SUB_NUM_ID);
      continue;
    }
    if (tok.length === 1 && !/\p{L}/u.test(ch0)) {
      out.push(idOf.get(ch0) ?? SUB_UNK_ID);
      continue;
    }
    const afterApos = match.index > 0 && norm[match.index - 1] === "'";
    const low = lowerTr(tok);
    if (!afterApos) {
      if (isAllUpper(tok)) {
        out.push(SUB_ALLCAP_ID);
      } else if (isUpperInitial(tok)) {
        out.push(SUB_CAP_ID);
      }
    }
    encodeSubwordPiece(low, !afterApos, idOf, maxLen, out);
  }
  return out;
}

interface MorphAnalyzerLike {
  isWord(form: string): boolean;
  analyze?(form: string): readonly { readonly stem: string; readonly pos: string; readonly morphemes: readonly string[] }[];
}

export interface TypoCandidateMeta {
  /** Core corrector score-base margin (0 for typed word). */
  coreMargin: number;
  /** Keyboard/edit cost from oneEdit (0 for typed word or pure mark variant). */
  slipCost: number;
  /** True when candidate differs from typed only in Turkish marks. */
  isMarkVariant?: boolean;
}

function ids(text: string): number[] {
  return [...text.replaceAll("’", "'").replace(/\d/g, "0")].map((char) => CHAR_ID.get(char) ?? 1);
}

/** Computes the 8-bit morphology feature mask matching `scripts/extract-morph-features.ts`. */
export function morphFeatureBits(word: string, morphology?: MorphAnalyzerLike): number {
  if (!morphology) return 0;
  const analyses = morphology.analyze?.(word);
  if (!analyses) return morphology.isWord(word) ? 1 : 0;
  if (analyses.length === 0) return 0;
  let bits = 1;
  for (const a of analyses) {
    if (a.pos === "Verb") bits |= 2;
    else if (a.pos === "Noun") bits |= 4;
    else if (a.pos === "Adj" || a.pos === "Adv") bits |= 8;
    else if (FUNC_POS.has(a.pos)) bits |= 16;
    for (const m of a.morphemes) {
      if (m === "Loc" || m === "Abl") bits |= 32;
      else if (POSS_MORPHEMES.has(m)) bits |= 64;
      else if (FINITE_MORPHEMES.has(m)) bits |= 128;
    }
  }
  return bits;
}

/** Computes the 26-dim feature vector per candidate matching `py/context_data.py:build_features`. */
export function buildContextFeatures(
  candidates: readonly string[],
  kind: ContextKind,
  asciiContext: boolean,
  lexicon: Lexicon,
  morphology?: MorphAnalyzerLike,
  typoMeta?: readonly TypoCandidateMeta[],
): number[][] {
  const logCounts: number[] = [];
  const minLogs: number[] = [];
  for (const cand of candidates) {
    const low = lowerTr(cand);
    const space = low.indexOf(" ");
    if (space === -1) {
      const c = lexicon.count(low);
      const lc = Math.log(c + 1);
      logCounts.push(lc);
      minLogs.push(lc);
    } else {
      const first = low.slice(0, space);
      const second = low.slice(space + 1);
      const pairC = lexicon.pair(first, second);
      const minW = Math.min(lexicon.count(first), lexicon.count(second));
      logCounts.push(Math.log(pairC + 1));
      minLogs.push(Math.log(minW + 1));
    }
  }
  const maxLc = logCounts.length > 0 ? Math.max(...logCounts) : 0;
  const typedLow = candidates.length > 0 ? lowerTr(candidates[0]!) : "";
  let maxCoreMargin = -Infinity;
  if (kind === "typo" && typoMeta) {
    for (let i = 1; i < candidates.length; i++) {
      const m = typoMeta[i]?.coreMargin ?? -10;
      if (m > maxCoreMargin) maxCoreMargin = m;
    }
  }
  if (!Number.isFinite(maxCoreMargin)) maxCoreMargin = 0;

  return candidates.map((cand, idx) => {
    const row = new Array<number>(FEATURE_DIM).fill(0);
    const low = lowerTr(cand);
    const space = low.indexOf(" ");
    const head = space === -1 ? low : low.slice(0, space);
    const bits = morphFeatureBits(head, morphology);
    row[0] = logCounts[idx]! / 15;
    row[1] = (logCounts[idx]! - maxLc) / 10;
    row[2] = minLogs[idx]! / 15;
    row[3] = space !== -1 ? 1 : 0;
    row[4] = hasTurkishMarks(cand) ? 1 : 0;
    row[5] = asciiContext ? 1 : 0;
    if (kind === "marks") row[6] = 1;
    else if (kind === "de_da") row[7] = 1;
    else if (kind === "ki") row[8] = 1;
    else if (kind === "mi") row[9] = 1;
    for (let b = 0; b < 8; b++) {
      row[10 + b] = (bits >> b) & 1;
    }
    if (kind === "typo") {
      row[18] = 1;
      const meta = typoMeta?.[idx];
      if (meta && idx > 0) {
        row[19] = Math.max(-1.5, Math.min(1.5, meta.coreMargin / 10));
        row[20] = Math.max(-1.5, Math.min(0, (meta.coreMargin - maxCoreMargin) / 10));
        row[21] = Math.min(2.0, meta.slipCost / 5);
        row[22] = low.length > typedLow.length ? 1 : 0;
        row[23] = low.length < typedLow.length ? 1 : 0;
        row[24] = low.length === typedLow.length && low !== typedLow ? 1 : 0;
        row[25] = meta.isMarkVariant ? 1 : 0;
      }
    }
    return row;
  });
}

/** One place in the text to judge: the words around it and the spans that could go there. */
export interface ContextQuery {
  left: string;
  right: string;
  /** The first candidate is what was typed. */
  candidates: string[];
  /** Optional per-candidate scalar features (length FEATURE_DIM each). */
  features?: readonly (readonly number[])[];
}

export interface PackedSubwords {
  readonly subwords: BigInt64Array;
  readonly subSegments: BigInt64Array;
  readonly seqLen: number;
}

/** Runs the network on packed sequences: returns n scores. */
export type RunModel = (
  tokens: BigInt64Array,
  segments: BigInt64Array,
  n: number,
  features?: Float32Array,
  subwords?: PackedSubwords,
) => Promise<Float32Array>;

/** Packs each candidate between its context: left (segment 1), candidate (2), right (3), no padding between. */
export function pack(queries: readonly ContextQuery[]): {
  tokens: BigInt64Array;
  segments: BigInt64Array;
  features: Float32Array;
  n: number;
} {
  const n = queries.reduce((sum, query) => sum + query.candidates.length, 0);
  const tokens = new BigInt64Array(n * SEQUENCE);
  const segments = new BigInt64Array(n * SEQUENCE);
  const features = new Float32Array(n * FEATURE_DIM);
  let row = 0;
  for (const query of queries) {
    const left = ids(query.left).slice(-LEFT);
    const right = ids(query.right).slice(0, RIGHT);
    for (let candIdx = 0; candIdx < query.candidates.length; candIdx++) {
      const candidate = query.candidates[candIdx]!;
      const span = ids(candidate).slice(0, SPAN);
      let position = row * SEQUENCE;
      for (const [part, segment] of [
        [left, 1n],
        [span, 2n],
        [right, 3n],
      ] as const) {
        for (const id of part) {
          tokens[position] = BigInt(id);
          segments[position] = segment;
          position++;
        }
      }
      const feat = query.features?.[candIdx];
      if (feat) {
        const base = row * FEATURE_DIM;
        for (let f = 0; f < FEATURE_DIM && f < feat.length; f++) {
          features[base + f] = feat[f]!;
        }
      }
      row++;
    }
  }
  return { tokens, segments, features, n };
}

/** Packs each candidate into compact dynamic-length subword tensors: [CLS] + left(<=24) + cand(<=8) + right(<=20). */
export function packSubwords(queries: readonly ContextQuery[]): PackedSubwords & { features: Float32Array; n: number } {
  const n = queries.reduce((sum, query) => sum + query.candidates.length, 0);
  const encodedRows: { left: number[]; span: number[]; right: number[]; feat?: readonly number[] }[] = [];
  let maxLen = 4;
  for (const query of queries) {
    const leftAll = encodeSubwords(query.left);
    const left = leftAll.length > LEFT_SUB ? leftAll.slice(leftAll.length - LEFT_SUB) : leftAll;
    const rightAll = encodeSubwords(query.right);
    const right = rightAll.length > RIGHT_SUB ? rightAll.slice(0, RIGHT_SUB) : rightAll;
    for (let candIdx = 0; candIdx < query.candidates.length; candIdx++) {
      const spanAll = encodeSubwords(query.candidates[candIdx]!);
      const span = spanAll.length > SPAN_SUB ? spanAll.slice(0, SPAN_SUB) : spanAll;
      const total = 1 + left.length + span.length + right.length;
      if (total > maxLen) maxLen = total;
      encodedRows.push({ left, span, right, feat: query.features?.[candIdx] });
    }
  }
  const seqLen = Math.min(maxLen, MAX_SUB_LEN);
  const subwords = new BigInt64Array(n * seqLen);
  const subSegments = new BigInt64Array(n * seqLen);
  const features = new Float32Array(n * FEATURE_DIM);

  for (let row = 0; row < encodedRows.length; row++) {
    const { left, span, right, feat } = encodedRows[row]!;
    const base = row * seqLen;
    let pos = base;
    const limit = base + seqLen;
    subwords[pos] = BigInt(SUB_CLS_ID);
    subSegments[pos] = 1n;
    pos++;
    for (let i = 0; i < left.length && pos < limit; i++) {
      subwords[pos] = BigInt(left[i]!);
      subSegments[pos] = 1n;
      pos++;
    }
    for (let i = 0; i < span.length && pos < limit; i++) {
      subwords[pos] = BigInt(span[i]!);
      subSegments[pos] = 2n;
      pos++;
    }
    for (let i = 0; i < right.length && pos < limit; i++) {
      subwords[pos] = BigInt(right[i]!);
      subSegments[pos] = 3n;
      pos++;
    }
    while (pos < limit) {
      subwords[pos] = BigInt(SUB_PAD_ID);
      subSegments[pos] = 0n;
      pos++;
    }
    if (feat) {
      const fBase = row * FEATURE_DIM;
      for (let f = 0; f < FEATURE_DIM && f < feat.length; f++) {
        features[fBase + f] = feat[f]!;
      }
    }
  }
  return { subwords, subSegments, seqLen, features, n };
}

/** Slices 26-dim features down to 18-dim when running a legacy v2 ONNX model. */
export function sliceLegacyFeatures(features: Float32Array, n: number): Float32Array {
  const out = new Float32Array(n * LEGACY_FEATURE_DIM);
  for (let r = 0; r < n; r++) {
    out.set(features.subarray(r * FEATURE_DIM, r * FEATURE_DIM + LEGACY_FEATURE_DIM), r * LEGACY_FEATURE_DIM);
  }
  return out;
}

export interface ContextModelOptions {
  /** Skip legacy 144-char packing when the runner consumes only v3 subword tensors. */
  subwordsOnly?: boolean;
}

/** Scores every candidate of every query in one model run. */
export class ContextModel {
  private readonly run: RunModel;
  private readonly subwordsOnly: boolean;

  constructor(run: RunModel, options: ContextModelOptions = {}) {
    this.run = run;
    this.subwordsOnly = options.subwordsOnly ?? false;
  }

  async score(queries: readonly ContextQuery[]): Promise<number[][]> {
    if (queries.length === 0) return [];
    let flat: Float32Array;
    if (this.subwordsOnly) {
      const packed = packSubwords(queries);
      flat = await this.run(new BigInt64Array(0), new BigInt64Array(0), packed.n, packed.features, packed);
    } else {
      const { tokens, segments, features, n } = pack(queries);
      const sub = packSubwords(queries);
      flat = await this.run(tokens, segments, n, features, sub);
    }
    const out: number[][] = [];
    let index = 0;
    for (const query of queries) {
      out.push(Array.from(flat.subarray(index, index + query.candidates.length)));
      index += query.candidates.length;
    }
    return out;
  }
}
