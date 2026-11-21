/**
 * The context model: scores how well a candidate span fits between the characters on its left and right.
 * The character encoding, sequence packing, and 18-dim feature vector here must match
 * py/context_data.py and py/train_context.py exactly.
 */
import type { Lexicon } from "./lexicon.ts";
import { hasTurkishMarks, lowerTr } from "./turkish.ts";

export const LEFT = 80;
export const RIGHT = 40;
export const SPAN = 24;
export const SEQUENCE = LEFT + SPAN + RIGHT;
export const FEATURE_DIM = 18;

export type ContextKind = "marks" | "de_da" | "ki" | "mi";
const KIND_INDEX: Record<ContextKind, number> = { marks: 0, de_da: 1, ki: 2, mi: 3 };

/** 0 is padding, 1 is any character not listed. */
export const ALPHABET = "abcçdefgğhıijklmnoöprsştuüvyzâîûqwxABCÇDEFGĞHIİJKLMNOÖPRSŞTUÜVYZÂÎÛQWX0 .,;:!?'\"()-";
const CHAR_ID = new Map([...ALPHABET].map((char, index) => [char, index + 2]));

const POSS_MORPHEMES = new Set(["P1sg", "P2sg", "P3sg", "P1pl", "P2pl", "P3pl"]);
const FINITE_MORPHEMES = new Set(["Prog1", "Prog2", "Past", "Narr", "Fut", "Aor", "Opt", "Desr", "Neces", "Imp"]);
const FUNC_POS = new Set(["Pron", "Conj", "Postp", "Det"]);

interface MorphAnalyzerLike {
  isWord(form: string): boolean;
  analyze?(form: string): readonly { readonly stem: string; readonly pos: string; readonly morphemes: readonly string[] }[];
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

/** Computes the 18-dim feature vector per candidate matching `py/context_data.py:build_features`. */
export function buildContextFeatures(
  candidates: readonly string[],
  kind: ContextKind,
  asciiContext: boolean,
  lexicon: Lexicon,
  morphology?: MorphAnalyzerLike,
): number[][] {
  const kindIdx = KIND_INDEX[kind];
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
    row[6 + kindIdx] = 1;
    for (let b = 0; b < 8; b++) {
      row[10 + b] = (bits >> b) & 1;
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
  /** Optional per-candidate scalar features (length FEATURE_DIM each) for Context Model v2. */
  features?: readonly (readonly number[])[];
}

/** Runs the network on packed sequences: tokens and segments are [n, SEQUENCE], optional features [n, FEATURE_DIM]; returns n scores. */
export type RunModel = (
  tokens: BigInt64Array,
  segments: BigInt64Array,
  n: number,
  features?: Float32Array,
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

/** Scores every candidate of every query in one model run. */
export class ContextModel {
  private readonly run: RunModel;

  constructor(run: RunModel) {
    this.run = run;
  }

  async score(queries: readonly ContextQuery[]): Promise<number[][]> {
    if (queries.length === 0) return [];
    const { tokens, segments, features, n } = pack(queries);
    const flat = await this.run(tokens, segments, n, features);
    const out: number[][] = [];
    let index = 0;
    for (const query of queries) {
      out.push(Array.from(flat.subarray(index, index + query.candidates.length)));
      index += query.candidates.length;
    }
    return out;
  }
}
