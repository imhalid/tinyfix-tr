/**
 * The context model: scores how well a candidate span fits between the characters on its left and right.
 * The character encoding and packing here must match py/context_data.py and py/train_context.py exactly.
 */

export const LEFT = 80;
export const RIGHT = 40;
export const SPAN = 24;
export const SEQUENCE = LEFT + SPAN + RIGHT;

/** 0 is padding, 1 is any character not listed. */
export const ALPHABET = "abcçdefgğhıijklmnoöprsştuüvyzâîûqwxABCÇDEFGĞHIİJKLMNOÖPRSŞTUÜVYZÂÎÛQWX0 .,;:!?'\"()-";
const CHAR_ID = new Map([...ALPHABET].map((char, index) => [char, index + 2]));

function ids(text: string): number[] {
  return [...text.replaceAll("’", "'").replace(/\d/g, "0")].map((char) => CHAR_ID.get(char) ?? 1);
}

/** One place in the text to judge: the words around it and the spans that could go there. */
export interface ContextQuery {
  left: string;
  right: string;
  /** The first candidate is what was typed. */
  candidates: string[];
}

/** Runs the network on packed sequences: tokens and segments are [n, SEQUENCE], returns n scores. */
export type RunModel = (tokens: BigInt64Array, segments: BigInt64Array, n: number) => Promise<Float32Array>;

/** Packs each candidate between its context: left (segment 1), candidate (2), right (3), no padding between. */
export function pack(queries: readonly ContextQuery[]): { tokens: BigInt64Array; segments: BigInt64Array; n: number } {
  const n = queries.reduce((sum, query) => sum + query.candidates.length, 0);
  const tokens = new BigInt64Array(n * SEQUENCE);
  const segments = new BigInt64Array(n * SEQUENCE);
  let row = 0;
  for (const query of queries) {
    const left = ids(query.left).slice(-LEFT);
    const right = ids(query.right).slice(0, RIGHT);
    for (const candidate of query.candidates) {
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
      row++;
    }
  }
  return { tokens, segments, n };
}

/** Scores every candidate of every query in one model run. */
export class ContextModel {
  private readonly run: RunModel;

  constructor(run: RunModel) {
    this.run = run;
  }

  async score(queries: readonly ContextQuery[]): Promise<number[][]> {
    if (queries.length === 0) return [];
    const { tokens, segments, n } = pack(queries);
    const flat = await this.run(tokens, segments, n);
    const out: number[][] = [];
    let index = 0;
    for (const query of queries) {
      out.push(Array.from(flat.subarray(index, index + query.candidates.length)));
      index += query.candidates.length;
    }
    return out;
  }
}
