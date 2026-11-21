/**
 * Compact binary format (`ALX1`) for Turkish unigram + bigram lexicons.
 *
 * Design goals:
 * - Zero external dependencies, browser-safe (TypedArrays + DataView + TextEncoder/TextDecoder).
 * - Columnar 1-byte alphabet front-coding for fast direct binary search (~1 ms index init, ~27 µs/word, ~6 MB RAM).
 * - Exact small counts + 1-byte logarithmic quantization for larger counts (zero accuracy loss).
 * - Disjoint Split-CSR bigram tables keyed by unigram IDs (bySecond for frequent trailing particles, byFirst for rest).
 * - Optional Bloom filter tiers for rare protection-only forms (`count = 2, 3, ...`) so clean rare words stay protected
 *   without paying full string storage.
 */

const MAGIC_0 = 0x41; // 'A'
const MAGIC_1 = 0x4c; // 'L'
const MAGIC_2 = 0x58; // 'X'
const MAGIC_3 = 0x31; // '1'
const FORMAT_VERSION = 1;
const MAX_WORD_LEN = 128;

export interface BinaryUnigramInput {
  readonly form: string;
  readonly count: number;
  readonly capitalized: number;
}

export interface BinaryBigramInput {
  readonly first: string;
  readonly second: string;
  readonly count: number;
  /** True to store under the `bySecond` CSR partition (optimal for frequent trailing particles like de/da/ki/mi). */
  readonly groupBySecond?: boolean;
}

export interface BinaryBloomTierInput {
  readonly returnCount: number;
  readonly bitsPerItem: number;
  readonly words: readonly string[];
}

export interface EncodeBinaryLexiconOptions {
  readonly unigrams: readonly BinaryUnigramInput[];
  readonly bigrams: readonly BinaryBigramInput[];
  readonly bloomTiers?: readonly BinaryBloomTierInput[];
  readonly blockSize?: number;
  readonly exactCountMax?: number;
  readonly countBuckets?: number;
  readonly countMaxVal?: number;
  readonly capMax?: number;
}

interface CsrTable {
  readonly keys: Uint32Array;
  readonly offsets: Uint32Array;
  readonly values: Uint32Array;
  readonly counts: Uint8Array;
}

interface BloomTier {
  readonly returnCount: number;
  readonly kHashes: number;
  readonly wordCount: number;
  readonly nBits: number;
  readonly bits: Uint8Array;
}

function buildQuantTable(exactMax: number, buckets: number, maxVal: number): Uint32Array {
  const table = new Uint32Array(buckets);
  for (let i = 0; i < exactMax && i < buckets; i++) {
    table[i] = i;
  }
  const logBuckets = buckets - exactMax;
  if (logBuckets > 1 && exactMax > 0 && maxVal > exactMax) {
    const step = Math.log(maxVal / exactMax) / (logBuckets - 1);
    for (let i = 0; i < logBuckets; i++) {
      table[exactMax + i] = Math.round(exactMax * Math.exp(i * step));
    }
  } else if (logBuckets === 1) {
    table[exactMax] = exactMax;
  }
  return table;
}

function quantizeCount(count: number, exactMax: number, buckets: number, maxVal: number): number {
  if (count <= 0) return 0;
  if (count < exactMax) return count;
  const logBuckets = buckets - exactMax;
  if (logBuckets <= 1 || exactMax <= 0 || maxVal <= exactMax) return Math.min(buckets - 1, exactMax);
  const step = Math.log(maxVal / exactMax) / (logBuckets - 1);
  return Math.min(buckets - 1, exactMax + Math.round(Math.log(count / exactMax) / step));
}

function writeVarint(out: number[], value: number): void {
  let v = value >>> 0;
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  out.push(v);
}

/** Deterministic dual 32-bit FNV/Murmur-mixed hash over UTF-16 code units (zero allocations). */
function hashWord2(word: string): readonly [number, number] {
  let h1 = 0x811c9dc5 | 0;
  let h2 = 0x9e3779b9 | 0;
  for (let i = 0; i < word.length; i++) {
    const c = word.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ (c + i), 0x85ebca6b);
  }
  h1 ^= h1 >>> 16;
  h1 = Math.imul(h1, 0x85ebca6b);
  h1 ^= h1 >>> 13;
  h2 ^= h2 >>> 16;
  h2 = Math.imul(h2, 0xc2b2ae35);
  h2 ^= h2 >>> 16;
  return [h1 >>> 0, h2 >>> 0];
}

function bloomAdd(bits: Uint8Array, nBits: number, kHashes: number, word: string): void {
  const [h1, h2] = hashWord2(word);
  for (let i = 0; i < kHashes; i++) {
    const idx = ((h1 + Math.imul(i, h2)) >>> 0) % nBits;
    bits[idx >>> 3] = bits[idx >>> 3]! | (1 << (idx & 7));
  }
}

function bloomHas(bits: Uint8Array, nBits: number, kHashes: number, word: string): boolean {
  const [h1, h2] = hashWord2(word);
  for (let i = 0; i < kHashes; i++) {
    const idx = ((h1 + Math.imul(i, h2)) >>> 0) % nBits;
    if ((bits[idx >>> 3]! & (1 << (idx & 7))) === 0) return false;
  }
  return true;
}

function encodeCsrPartition(
  groups: Map<number, Array<[innerId: number, qCount: number]>>,
): { groupCount: number; pairCount: number; meta: Uint8Array; inner: Uint8Array; counts: Uint8Array } {
  const keys = [...groups.keys()].sort((a, b) => a - b);
  const meta: number[] = [];
  const inner: number[] = [];
  const counts: number[] = [];
  let prevKey = 0;

  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]!;
    writeVarint(meta, key - prevKey);
    prevKey = key;

    const list = groups.get(key)!;
    list.sort((a, b) => a[0] - b[0]);
    // Deduplicate identical inner IDs (keeping max count) just in case.
    let uniqueLen = 0;
    for (let j = 0; j < list.length; j++) {
      const entry = list[j]!;
      if (uniqueLen > 0 && list[uniqueLen - 1]![0] === entry[0]) {
        if (entry[1] > list[uniqueLen - 1]![1]) list[uniqueLen - 1]![1] = entry[1];
      } else {
        list[uniqueLen++] = entry;
      }
    }

    writeVarint(meta, uniqueLen);
    let prevVal = 0;
    for (let j = 0; j < uniqueLen; j++) {
      const [val, qc] = list[j]!;
      writeVarint(inner, val - prevVal);
      prevVal = val;
      counts.push(qc);
    }
  }

  return {
    groupCount: keys.length,
    pairCount: counts.length,
    meta: new Uint8Array(meta),
    inner: new Uint8Array(inner),
    counts: new Uint8Array(counts),
  };
}

function decodeCsrPartition(
  bytes: Uint8Array,
  startOffset: number,
  groupCount: number,
  pairCount: number,
  metaLen: number,
  innerLen: number,
): { table: CsrTable; nextOffset: number } {
  const keys = new Uint32Array(groupCount);
  const offsets = new Uint32Array(groupCount + 1);
  const values = new Uint32Array(pairCount);

  let mOff = startOffset;
  const metaEnd = startOffset + metaLen;
  let iOff = metaEnd;
  const innerEnd = metaEnd + innerLen;
  const counts = bytes.subarray(innerEnd, innerEnd + pairCount);

  let curKey = 0;
  let curPair = 0;
  for (let g = 0; g < groupCount; g++) {
    // Read delta key
    let dk = 0;
    let shift = 0;
    for (;;) {
      const b = bytes[mOff++]!;
      dk |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) break;
      shift += 7;
    }
    curKey += dk >>> 0;
    keys[g] = curKey;
    offsets[g] = curPair;

    // Read degree
    let deg = 0;
    shift = 0;
    for (;;) {
      const b = bytes[mOff++]!;
      deg |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) break;
      shift += 7;
    }
    deg >>>= 0;

    let curVal = 0;
    for (let j = 0; j < deg; j++) {
      let dv = 0;
      shift = 0;
      for (;;) {
        const b = bytes[iOff++]!;
        dv |= (b & 0x7f) << shift;
        if ((b & 0x80) === 0) break;
        shift += 7;
      }
      curVal += dv >>> 0;
      values[curPair++] = curVal;
    }
  }
  offsets[groupCount] = curPair;

  return {
    table: { keys, offsets, values, counts },
    nextOffset: innerEnd + pairCount,
  };
}

function lookupCsr(table: CsrTable, outerId: number, innerId: number): number {
  const keys = table.keys;
  let lo = 0;
  let hi = keys.length - 1;
  let group = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const k = keys[mid]!;
    if (k === outerId) {
      group = mid;
      break;
    }
    if (k < outerId) lo = mid + 1;
    else hi = mid - 1;
  }
  if (group === -1) return 0;

  let pLo = table.offsets[group]!;
  let pHi = table.offsets[group + 1]! - 1;
  const values = table.values;
  while (pLo <= pHi) {
    const mid = (pLo + pHi) >>> 1;
    const v = values[mid]!;
    if (v === innerId) return table.counts[mid]!;
    if (v < innerId) pLo = mid + 1;
    else pHi = mid - 1;
  }
  return 0;
}

/**
 * Encodes unigrams, bigrams, and optional Bloom tail filters into an `ALX1` binary payload.
 */
export function encodeBinaryLexicon(options: EncodeBinaryLexiconOptions): Uint8Array {
  const blockSize = options.blockSize ?? 64;
  const exactCountMax = options.exactCountMax ?? 80;
  const countBuckets = options.countBuckets ?? 256;
  const countMaxVal = options.countMaxVal ?? 3_000_000;
  const capMax = options.capMax ?? 50; // 51 levels (0..50 -> step 0.02, exact on 0.45..0.75!)

  // Collect exact alphabet from unigrams (sorted by UTF-16 code unit for deterministic encoding).
  const charSet = new Set<string>();
  for (let i = 0; i < options.unigrams.length; i++) {
    const form = options.unigrams[i]!.form;
    for (let j = 0; j < form.length; j++) {
      charSet.add(form[j]!);
    }
  }
  const alphabet = [...charSet].sort().join("");
  if (alphabet.length > 254) {
    throw new Error(`lexicon binary: alphabet too large (${alphabet.length} > 254)`);
  }
  const charToByte = new Map<string, number>();
  for (let i = 0; i < alphabet.length; i++) {
    charToByte.set(alphabet[i]!, i + 1);
  }

  // Encode & sort unigrams by 1-byte alphabet code order so binary search matches code order directly.
  const encoded = options.unigrams.map((u) => {
    const b = new Uint8Array(u.form.length);
    for (let i = 0; i < u.form.length; i++) {
      b[i] = charToByte.get(u.form[i]!)!;
    }
    return { form: u.form, bytes: b, count: u.count, capitalized: u.capitalized };
  });
  encoded.sort((a, b) => {
    const m = Math.min(a.bytes.length, b.bytes.length);
    for (let i = 0; i < m; i++) {
      const diff = a.bytes[i]! - b.bytes[i]!;
      if (diff !== 0) return diff;
    }
    return a.bytes.length - b.bytes.length;
  });

  const wordCount = encoded.length;
  const idOf = new Map<string, number>();
  const prefixLens = new Uint8Array(wordCount);
  const suffixLens = new Uint8Array(wordCount);
  const counts = new Uint8Array(wordCount);
  const caps = new Uint8Array(wordCount);
  let totalChars = 0;

  for (let i = 0; i < wordCount; i++) {
    const cur = encoded[i]!;
    idOf.set(cur.form, i);
    let prefix = 0;
    if (i % blockSize !== 0) {
      const prev = encoded[i - 1]!.bytes;
      const maxP = Math.min(prev.length, cur.bytes.length, 255);
      while (prefix < maxP && prev[prefix] === cur.bytes[prefix]) {
        prefix++;
      }
    }
    const suffix = cur.bytes.length - prefix;
    if (suffix > 255) {
      throw new Error(`lexicon binary: word suffix exceeds 255 chars ("${cur.form}")`);
    }
    prefixLens[i] = prefix;
    suffixLens[i] = suffix;
    totalChars += suffix;
    counts[i] = quantizeCount(cur.count, exactCountMax, countBuckets, countMaxVal);
    caps[i] =
      cur.capitalized <= 0 || cur.count <= 0
        ? 0
        : Math.min(capMax, Math.max(1, Math.round((capMax * cur.capitalized) / cur.count)));
  }

  const chars = new Uint8Array(totalChars);
  let charOff = 0;
  for (let i = 0; i < wordCount; i++) {
    const b = encoded[i]!.bytes;
    const p = prefixLens[i]!;
    for (let j = p; j < b.length; j++) {
      chars[charOff++] = b[j]!;
    }
  }

  // Partition bigrams into byFirst and bySecond CSR tables.
  const byFirstGroups = new Map<number, Array<[number, number]>>();
  const bySecondGroups = new Map<number, Array<[number, number]>>();
  for (let i = 0; i < options.bigrams.length; i++) {
    const bg = options.bigrams[i]!;
    const id1 = idOf.get(bg.first);
    const id2 = idOf.get(bg.second);
    if (id1 === undefined || id2 === undefined) continue;
    const qc = quantizeCount(bg.count, exactCountMax, countBuckets, countMaxVal);
    if (bg.groupBySecond) {
      let list = bySecondGroups.get(id2);
      if (!list) {
        list = [];
        bySecondGroups.set(id2, list);
      }
      list.push([id1, qc]);
    } else {
      let list = byFirstGroups.get(id1);
      if (!list) {
        list = [];
        byFirstGroups.set(id1, list);
      }
      list.push([id2, qc]);
    }
  }
  const csr1 = encodeCsrPartition(byFirstGroups);
  const csr2 = encodeCsrPartition(bySecondGroups);

  // Build Bloom filter tiers (ordered by descending returnCount so highest count matches first).
  const sortedTiers = [...(options.bloomTiers ?? [])]
    .filter((t) => t.words.length > 0)
    .sort((a, b) => b.returnCount - a.returnCount);
  const builtBlooms: BloomTier[] = sortedTiers.map((tier) => {
    const byteLen = Math.max(8, Math.ceil((tier.words.length * tier.bitsPerItem) / 8));
    const nBits = byteLen * 8;
    const kHashes = Math.max(4, Math.min(20, Math.round(tier.bitsPerItem * Math.LN2)));
    const bits = new Uint8Array(byteLen);
    for (let i = 0; i < tier.words.length; i++) {
      bloomAdd(bits, nBits, kHashes, tier.words[i]!);
    }
    return {
      returnCount: tier.returnCount,
      kHashes,
      wordCount: tier.words.length,
      nBits,
      bits,
    };
  });

  const alphabetBytes = new TextEncoder().encode(alphabet);
  // Header layout:
  // 4 magic + 1 ver + 1 blockSize + 1 exactCountMax + 2 countBuckets + 4 countMaxVal + 1 capMax
  // + 2 alphabetByteLen + alphabetBytes
  // + 4 wordCount + 4 charsByteLen
  // + 4*4 csr1 (groups, pairs, metaLen, innerLen)
  // + 4*4 csr2 (groups, pairs, metaLen, innerLen)
  // + 1 bloomCount + bloomCount * (1 returnCount + 1 kHashes + 4 wordCount + 4 byteLen)
  const headerLen = 16 + alphabetBytes.byteLength + 8 + 16 + 16 + 1 + builtBlooms.length * 10;
  const bodyParts: Uint8Array[] = [
    prefixLens,
    suffixLens,
    chars,
    counts,
    caps,
    csr1.meta,
    csr1.inner,
    csr1.counts,
    csr2.meta,
    csr2.inner,
    csr2.counts,
    ...builtBlooms.map((b) => b.bits),
  ];
  const bodyLen = bodyParts.reduce((sum, part) => sum + part.byteLength, 0);

  const out = new Uint8Array(headerLen + bodyLen);
  const view = new DataView(out.buffer);
  let off = 0;

  out[off++] = MAGIC_0;
  out[off++] = MAGIC_1;
  out[off++] = MAGIC_2;
  out[off++] = MAGIC_3;
  out[off++] = FORMAT_VERSION;
  out[off++] = blockSize;
  out[off++] = exactCountMax;
  view.setUint16(off, countBuckets, true);
  off += 2;
  view.setUint32(off, countMaxVal, true);
  off += 4;
  out[off++] = capMax;

  view.setUint16(off, alphabetBytes.byteLength, true);
  off += 2;
  out.set(alphabetBytes, off);
  off += alphabetBytes.byteLength;

  view.setUint32(off, wordCount, true);
  off += 4;
  view.setUint32(off, chars.byteLength, true);
  off += 4;

  view.setUint32(off, csr1.groupCount, true);
  off += 4;
  view.setUint32(off, csr1.pairCount, true);
  off += 4;
  view.setUint32(off, csr1.meta.byteLength, true);
  off += 4;
  view.setUint32(off, csr1.inner.byteLength, true);
  off += 4;

  view.setUint32(off, csr2.groupCount, true);
  off += 4;
  view.setUint32(off, csr2.pairCount, true);
  off += 4;
  view.setUint32(off, csr2.meta.byteLength, true);
  off += 4;
  view.setUint32(off, csr2.inner.byteLength, true);
  off += 4;

  out[off++] = builtBlooms.length;
  for (let i = 0; i < builtBlooms.length; i++) {
    const b = builtBlooms[i]!;
    out[off++] = b.returnCount;
    out[off++] = b.kHashes;
    view.setUint32(off, b.wordCount, true);
    off += 4;
    view.setUint32(off, b.bits.byteLength, true);
    off += 4;
  }

  for (let i = 0; i < bodyParts.length; i++) {
    const part = bodyParts[i]!;
    out.set(part, off);
    off += part.byteLength;
  }

  return out;
}

/**
 * Memory-compact, zero-string-allocation runtime lexicon backed directly by `ALX1` typed arrays.
 */
export class BinaryLexicon {
  private readonly blockSize: number;
  private readonly wordCount: number;
  private readonly totalFormCount: number;
  private readonly totalPairCount: number;
  private readonly capMax: number;
  private readonly quantTable: Uint32Array;
  private readonly alphabetSize: number;
  private readonly charToByte: Uint8Array;
  private readonly byteToChar: string[];
  private readonly prefixLens: Uint8Array;
  private readonly suffixLens: Uint8Array;
  private readonly chars: Uint8Array;
  private readonly counts: Uint8Array;
  private readonly caps: Uint8Array;
  private readonly blkCharOff: Uint32Array;
  private readonly bktLo: Int32Array;
  private readonly bktHi: Int32Array;
  private readonly byFirst: CsrTable;
  private readonly bySecond: CsrTable;
  private readonly blooms: readonly BloomTier[];
  private readonly queryBuf = new Uint8Array(MAX_WORD_LEN);
  private lastForm = "";
  private lastId = -2;

  constructor(bytes: Uint8Array) {
    if (
      bytes.byteLength < 57 ||
      bytes[0] !== MAGIC_0 ||
      bytes[1] !== MAGIC_1 ||
      bytes[2] !== MAGIC_2 ||
      bytes[3] !== MAGIC_3
    ) {
      throw new Error("autr: Geçersiz sözlük ikili başlığı (ALX1 bekleniyordu).");
    }
    const version = bytes[4]!;
    if (version !== FORMAT_VERSION) {
      throw new Error(`autr: Desteklenmeyen sözlük biçim sürümü: ${version}.`);
    }

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let off = 5;
    this.blockSize = bytes[off++]!;
    const exactCountMax = bytes[off++]!;
    const countBuckets = view.getUint16(off, true);
    off += 2;
    const countMaxVal = view.getUint32(off, true);
    off += 4;
    this.capMax = bytes[off++]!;
    this.quantTable = buildQuantTable(exactCountMax, countBuckets, countMaxVal);

    const alphabetByteLen = view.getUint16(off, true);
    off += 2;
    const alphabet = new TextDecoder("utf-8").decode(bytes.subarray(off, off + alphabetByteLen));
    off += alphabetByteLen;

    this.alphabetSize = alphabet.length + 1;
    this.charToByte = new Uint8Array(65536);
    this.byteToChar = new Array<string>(this.alphabetSize).fill("");
    for (let i = 0; i < alphabet.length; i++) {
      const ch = alphabet[i]!;
      this.charToByte[ch.charCodeAt(0)] = i + 1;
      this.byteToChar[i + 1] = ch;
    }

    this.wordCount = view.getUint32(off, true);
    off += 4;
    const charsByteLen = view.getUint32(off, true);
    off += 4;

    const csr1Groups = view.getUint32(off, true);
    off += 4;
    const csr1Pairs = view.getUint32(off, true);
    off += 4;
    const csr1MetaLen = view.getUint32(off, true);
    off += 4;
    const csr1InnerLen = view.getUint32(off, true);
    off += 4;

    const csr2Groups = view.getUint32(off, true);
    off += 4;
    const csr2Pairs = view.getUint32(off, true);
    off += 4;
    const csr2MetaLen = view.getUint32(off, true);
    off += 4;
    const csr2InnerLen = view.getUint32(off, true);
    off += 4;

    const bloomCount = bytes[off++]!;
    const bloomMeta: Array<{ returnCount: number; kHashes: number; wordCount: number; byteLen: number }> = [];
    for (let i = 0; i < bloomCount; i++) {
      const returnCount = bytes[off++]!;
      const kHashes = bytes[off++]!;
      const bloomWords = view.getUint32(off, true);
      off += 4;
      const byteLen = view.getUint32(off, true);
      off += 4;
      bloomMeta.push({ returnCount, kHashes, wordCount: bloomWords, byteLen });
    }

    const n = this.wordCount;
    this.prefixLens = bytes.subarray(off, off + n);
    off += n;
    this.suffixLens = bytes.subarray(off, off + n);
    off += n;
    this.chars = bytes.subarray(off, off + charsByteLen);
    off += charsByteLen;
    this.counts = bytes.subarray(off, off + n);
    off += n;
    this.caps = bytes.subarray(off, off + n);
    off += n;

    const d1 = decodeCsrPartition(bytes, off, csr1Groups, csr1Pairs, csr1MetaLen, csr1InnerLen);
    this.byFirst = d1.table;
    off = d1.nextOffset;

    const d2 = decodeCsrPartition(bytes, off, csr2Groups, csr2Pairs, csr2MetaLen, csr2InnerLen);
    this.bySecond = d2.table;
    off = d2.nextOffset;

    const blooms: BloomTier[] = [];
    let bloomWordTotal = 0;
    for (let i = 0; i < bloomMeta.length; i++) {
      const m = bloomMeta[i]!;
      const bits = bytes.subarray(off, off + m.byteLen);
      off += m.byteLen;
      blooms.push({
        returnCount: m.returnCount,
        kHashes: m.kHashes,
        wordCount: m.wordCount,
        nBits: m.byteLen * 8,
        bits,
      });
      bloomWordTotal += m.wordCount;
    }
    this.blooms = blooms;
    this.totalFormCount = n + bloomWordTotal;
    this.totalPairCount = csr1Pairs + csr2Pairs;

    // Build block offsets & 2-byte prefix bucket table in a single fast pass (~0.7 ms).
    const blkSize = this.blockSize;
    const nBlocks = n === 0 ? 0 : Math.ceil(n / blkSize);
    this.blkCharOff = new Uint32Array(nBlocks);
    const cSize = this.alphabetSize;
    const totalBuckets = cSize * cSize;
    const bucketStart = new Int32Array(totalBuckets).fill(-1);
    const bucketEnd = new Int32Array(totalBuckets).fill(-1);

    let charPos = 0;
    const sArr = this.suffixLens;
    const cArr = this.chars;
    for (let blk = 0; blk < nBlocks; blk++) {
      this.blkCharOff[blk] = charPos;
      const base = blk * blkSize;
      const end = base + blkSize < n ? base + blkSize : n;
      const len0 = sArr[base]!;
      const b0 = len0 > 0 ? cArr[charPos]! : 0;
      const b1 = len0 > 1 ? cArr[charPos + 1]! : 0;
      const bkt = b0 * cSize + b1;
      if (bucketStart[bkt] === -1) bucketStart[bkt] = blk;
      bucketEnd[bkt] = blk + 1;
      for (let i = base; i < end; i++) {
        charPos += sArr[i]!;
      }
    }

    this.bktLo = new Int32Array(totalBuckets);
    this.bktHi = new Int32Array(totalBuckets);
    let lastSeen = 0;
    for (let bkt = 0; bkt < totalBuckets; bkt++) {
      if (bucketStart[bkt] !== -1) {
        this.bktLo[bkt] = bucketStart[bkt]! > 0 ? bucketStart[bkt]! - 1 : 0;
        this.bktHi[bkt] = bucketEnd[bkt]!;
        lastSeen = bucketEnd[bkt]! - 1;
      } else {
        this.bktLo[bkt] = lastSeen;
        this.bktHi[bkt] = lastSeen + 1 < nBlocks ? lastSeen + 1 : nBlocks;
      }
    }
  }

  get size(): number {
    return this.totalFormCount;
  }

  get exactSize(): number {
    return this.wordCount;
  }

  get pairCount(): number {
    return this.totalPairCount;
  }

  private findExactId(form: string): number {
    if (form === this.lastForm && this.lastId !== -2) return this.lastId;
    const qLen = form.length;
    if (qLen === 0 || qLen > MAX_WORD_LEN || this.wordCount === 0) {
      this.lastForm = form;
      this.lastId = -1;
      return -1;
    }

    const qBuf = this.queryBuf;
    const charMap = this.charToByte;
    for (let i = 0; i < qLen; i++) {
      const code = charMap[form.charCodeAt(i)]!;
      if (code === 0) {
        this.lastForm = form;
        this.lastId = -1;
        return -1;
      }
      qBuf[i] = code;
    }

    const b0 = qBuf[0]!;
    const b1 = qLen > 1 ? qBuf[1]! : 0;
    const bkt = b0 * this.alphabetSize + b1;
    let lo = this.bktLo[bkt]!;
    let hi = this.bktHi[bkt]! - 1;
    const blkSize = this.blockSize;
    const blkOff = this.blkCharOff;
    const sArr = this.suffixLens;
    const cArr = this.chars;

    let blk = lo;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const idx = mid * blkSize;
      const cOff = blkOff[mid]!;
      const hLen = sArr[idx]!;
      const m = hLen < qLen ? hLen : qLen;
      let cmp = 0;
      for (let j = 0; j < m; j++) {
        const diff = cArr[cOff + j]! - qBuf[j]!;
        if (diff !== 0) {
          cmp = diff;
          break;
        }
      }
      if (cmp === 0) cmp = hLen - qLen;
      if (cmp === 0) {
        this.lastForm = form;
        this.lastId = idx;
        return idx;
      }
      if (cmp < 0) {
        blk = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }

    const base = blk * blkSize;
    const end = base + blkSize < this.wordCount ? base + blkSize : this.wordCount;
    let pos = blkOff[blk]!;
    const len0 = sArr[base]!;
    let matched = 0;
    {
      const m = len0 < qLen ? len0 : qLen;
      while (matched < m && cArr[pos + matched] === qBuf[matched]) matched++;
      if (matched === len0 && len0 === qLen) {
        this.lastForm = form;
        this.lastId = base;
        return base;
      }
      // If entry 0 is already > query, query cannot exist in this block.
      if (matched < m) {
        if (cArr[pos + matched]! > qBuf[matched]!) {
          this.lastForm = form;
          this.lastId = -1;
          return -1;
        }
      } else if (len0 > qLen) {
        this.lastForm = form;
        this.lastId = -1;
        return -1;
      }
    }
    pos += len0;

    const pArr = this.prefixLens;
    for (let i = base + 1; i < end; i++) {
      const p = pArr[i]!;
      const s = sArr[i]!;
      if (p < matched) break;
      if (p === matched) {
        let j = 0;
        const rem = qLen - p;
        const m = s < rem ? s : rem;
        while (j < m && cArr[pos + j] === qBuf[p + j]) j++;
        matched = p + j;
        if (j === m) {
          if (s === rem) {
            this.lastForm = form;
            this.lastId = i;
            return i;
          }
          if (s > rem) break;
        } else if (cArr[pos + j]! > qBuf[p + j]!) {
          break;
        }
      }
      pos += s;
    }

    this.lastForm = form;
    this.lastId = -1;
    return -1;
  }

  count(form: string): number {
    const id = this.findExactId(form);
    if (id !== -1) return this.quantTable[this.counts[id]!]!;
    const blooms = this.blooms;
    for (let i = 0; i < blooms.length; i++) {
      const b = blooms[i]!;
      if (bloomHas(b.bits, b.nBits, b.kHashes, form)) return b.returnCount;
    }
    return 0;
  }

  capitalShare(form: string): number {
    const id = this.findExactId(form);
    if (id === -1 || this.capMax === 0) return 0;
    return this.caps[id]! / this.capMax;
  }

  pair(first: string, second: string): number {
    const id2 = this.findExactId(second);
    if (id2 === -1) return 0;
    const id1 = this.findExactId(first);
    if (id1 === -1) return 0;
    const q2 = lookupCsr(this.bySecond, id2, id1);
    if (q2 !== 0) return this.quantTable[q2]!;
    const q1 = lookupCsr(this.byFirst, id1, id2);
    return q1 !== 0 ? this.quantTable[q1]! : 0;
  }

  /** Reconstructs the exact-table entries as TSV (for debugging/diagnostics). */
  toTsv(): { unigrams: string; bigrams: string } {
    const words = new Array<string>(this.wordCount);
    const cur = new Uint8Array(MAX_WORD_LEN);
    let charPos = 0;
    const uLines: string[] = [];
    for (let i = 0; i < this.wordCount; i++) {
      const p = this.prefixLens[i]!;
      const s = this.suffixLens[i]!;
      for (let j = 0; j < s; j++) cur[p + j] = this.chars[charPos++]!;
      const len = p + s;
      let w = "";
      for (let j = 0; j < len; j++) w += this.byteToChar[cur[j]!]!;
      words[i] = w;
      const c = this.quantTable[this.counts[i]!]!;
      const cp = this.capMax === 0 ? 0 : Math.round((c * this.caps[i]!) / this.capMax);
      uLines.push(`${w}\t${c}\t${cp}`);
    }
    const bLines: string[] = [];
    for (let g = 0; g < this.byFirst.keys.length; g++) {
      const w1 = words[this.byFirst.keys[g]!]!;
      const start = this.byFirst.offsets[g]!;
      const end = this.byFirst.offsets[g + 1]!;
      for (let p = start; p < end; p++) {
        bLines.push(`${w1} ${words[this.byFirst.values[p]!]!}\t${this.quantTable[this.byFirst.counts[p]!]!}`);
      }
    }
    for (let g = 0; g < this.bySecond.keys.length; g++) {
      const w2 = words[this.bySecond.keys[g]!]!;
      const start = this.bySecond.offsets[g]!;
      const end = this.bySecond.offsets[g + 1]!;
      for (let p = start; p < end; p++) {
        bLines.push(`${words[this.bySecond.values[p]!]!} ${w2}\t${this.quantTable[this.bySecond.counts[p]!]!}`);
      }
    }
    return { unigrams: uLines.join("\n"), bigrams: bLines.join("\n") };
  }
}
