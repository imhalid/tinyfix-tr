/**
 * Compact binary serialization (`AMR1`) for parsed Zemberek morphology dictionaries.
 * Browser-safe (standard TypedArrays + TextEncoder/TextDecoder only) and lossless:
 * decoding reconstructs the exact DictionaryItem[] produced by `parseDictionaries()`.
 */

import { normalizeCircumflex } from "./phonetics.ts";
import { decodeMorphPrior, encodeMorphPrior, type MorphPrior } from "./prior.ts";
import {
  RA_DUMMY,
  type DictionaryItem,
  type PrimaryPos,
  type SecondaryPos,
} from "./types.ts";

const MAGIC_0 = 0x41; // 'A'
const MAGIC_1 = 0x4d; // 'M'
const MAGIC_2 = 0x52; // 'R'
const MAGIC_3 = 0x31; // '1'
const FORMAT_VERSION_V1 = 1;
const FORMAT_VERSION_V2 = 2;

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

const SECONDARY_POS_LIST: readonly SecondaryPos[] = [
  "None",
  "ProperNoun",
  "Abbreviation",
  "Time",
  "PersonalPron",
  "DemonstrativePron",
  "QuantitivePron",
  "QuestionPron",
  "ReflexivePron",
  "Card",
  "Ord",
  "Dist",
  "PCDat",
  "PCAbl",
  "PCNom",
  "PCGen",
  "PCIns",
  "PCAcc",
];

const PRIMARY_POS_INDEX = new Map<PrimaryPos, number>(PRIMARY_POS_LIST.map((p, i) => [p, i]));
const SECONDARY_POS_INDEX = new Map<SecondaryPos, number>(SECONDARY_POS_LIST.map((p, i) => [p, i]));

const LEMMA_MODE_MASK = 0x03;
const LEMMA_MODE_ROOT = 0;
const LEMMA_MODE_VERB_MAK = 1;
const LEMMA_MODE_VERB_MEK = 2;
const LEMMA_MODE_EXPLICIT = 3;
const FLAG_HAS_PRON = 1 << 2;
const FLAG_HAS_REF = 1 << 3;
const FLAG_HAS_INDEX = 1 << 4;
const FLAG_HAS_KEY = 1 << 5;

function defaultItemKey(
  root: string,
  lemma: string,
  primaryPos: PrimaryPos,
  secondaryPos: SecondaryPos,
  attributes: number,
): string {
  if ((attributes & RA_DUMMY) !== 0) {
    return `${root}_Noun_CompoundRoot`;
  }
  const normLemma = normalizeCircumflex(lemma);
  return secondaryPos === "None" ? `${normLemma}_${primaryPos}` : `${normLemma}_${primaryPos}_${secondaryPos}`;
}

function writeVarint(out: number[], value: number): void {
  let v = value >>> 0;
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  out.push(v);
}

/**
 * Encodes parsed `DictionaryItem[]` into a compact, columnar, front-coded `AMR1` (or `AMR2` with prior) binary payload.
 */
export function encodeBinaryDictionary(items: readonly DictionaryItem[], prior?: MorphPrior): Uint8Array {
  const encoder = new TextEncoder();

  // Sort items by UTF-8 root bytes for optimal front-coding, preserving deterministic tie-breaking.
  const entries = items.map((item, origIdx) => ({
    item,
    origIdx,
    rootBytes: encoder.encode(item.root),
  }));
  entries.sort((a, b) => {
    const minLen = Math.min(a.rootBytes.length, b.rootBytes.length);
    for (let i = 0; i < minLen; i++) {
      const diff = a.rootBytes[i]! - b.rootBytes[i]!;
      if (diff !== 0) return diff;
    }
    if (a.rootBytes.length !== b.rootBytes.length) return a.rootBytes.length - b.rootBytes.length;
    return a.origIdx - b.origIdx;
  });

  const itemCount = entries.length;
  const newIndexOf = new Map<DictionaryItem, number>();
  for (let i = 0; i < itemCount; i++) {
    newIndexOf.set(entries[i]!.item, i);
  }

  // Build attribute bitmask palette (typically < 50 unique masks across ~31K items).
  const attrPalette: number[] = [];
  const attrToIdx = new Map<number, number>();
  for (let i = 0; i < itemCount; i++) {
    const attrs = entries[i]!.item.attributes >>> 0;
    if (!attrToIdx.has(attrs)) {
      attrToIdx.set(attrs, attrPalette.length);
      attrPalette.push(attrs);
    }
  }
  const wideAttr = attrPalette.length > 255;

  const prefixLens = new Uint8Array(itemCount);
  const suffixLens = new Uint8Array(itemCount);
  const rootStream: number[] = [];
  const posSec = new Uint8Array(itemCount);
  const attrCol = wideAttr ? new Uint8Array(itemCount * 2) : new Uint8Array(itemCount);
  const flagsCol = new Uint8Array(itemCount);
  const extras: number[] = [];

  let prevRoot = new Uint8Array(0);
  const secCount = SECONDARY_POS_LIST.length;

  for (let i = 0; i < itemCount; i++) {
    const { item, rootBytes } = entries[i]!;
    let prefix = 0;
    const maxPrefix = Math.min(prevRoot.length, rootBytes.length, 255);
    while (prefix < maxPrefix && prevRoot[prefix] === rootBytes[prefix]) {
      prefix++;
    }
    const suffix = rootBytes.length - prefix;
    if (suffix > 255) {
      throw new Error(`morph binary: root suffix exceeds 255 bytes ("${item.root}")`);
    }
    prefixLens[i] = prefix;
    suffixLens[i] = suffix;
    for (let j = prefix; j < rootBytes.length; j++) {
      rootStream.push(rootBytes[j]!);
    }
    prevRoot = rootBytes;

    const pIdx = PRIMARY_POS_INDEX.get(item.primaryPos);
    const sIdx = SECONDARY_POS_INDEX.get(item.secondaryPos);
    if (pIdx === undefined || sIdx === undefined) {
      throw new Error(`morph binary: unknown POS (${item.primaryPos}, ${item.secondaryPos})`);
    }
    posSec[i] = pIdx * secCount + sIdx;

    const aIdx = attrToIdx.get(item.attributes >>> 0)!;
    if (wideAttr) {
      attrCol[i * 2] = aIdx & 0xff;
      attrCol[i * 2 + 1] = (aIdx >>> 8) & 0xff;
    } else {
      attrCol[i] = aIdx;
    }

    let flags = 0;
    if (item.lemma === item.root) {
      flags |= LEMMA_MODE_ROOT;
    } else if (item.primaryPos === "Verb" && item.lemma === `${item.root}mak`) {
      flags |= LEMMA_MODE_VERB_MAK;
    } else if (item.primaryPos === "Verb" && item.lemma === `${item.root}mek`) {
      flags |= LEMMA_MODE_VERB_MEK;
    } else {
      flags |= LEMMA_MODE_EXPLICIT;
      const lemmaBytes = encoder.encode(item.lemma);
      writeVarint(extras, lemmaBytes.length);
      for (let j = 0; j < lemmaBytes.length; j++) extras.push(lemmaBytes[j]!);
    }

    if (item.pronunciation !== item.root) {
      flags |= FLAG_HAS_PRON;
      const pronBytes = encoder.encode(item.pronunciation);
      writeVarint(extras, pronBytes.length);
      for (let j = 0; j < pronBytes.length; j++) extras.push(pronBytes[j]!);
    }

    if (item.referenceItem !== null) {
      const refIdx = newIndexOf.get(item.referenceItem);
      if (refIdx !== undefined) {
        flags |= FLAG_HAS_REF;
        writeVarint(extras, refIdx);
      }
    }

    if (item.index !== 0) {
      flags |= FLAG_HAS_INDEX;
      writeVarint(extras, item.index);
    }

    const expectedKey = defaultItemKey(item.root, item.lemma, item.primaryPos, item.secondaryPos, item.attributes);
    if (item.key !== expectedKey) {
      flags |= FLAG_HAS_KEY;
      const keyBytes = encoder.encode(item.key);
      writeVarint(extras, keyBytes.length);
      for (let j = 0; j < keyBytes.length; j++) extras.push(keyBytes[j]!);
    }

    flagsCol[i] = flags;
  }

  const rootStreamBytes = new Uint8Array(rootStream);
  const extrasBytes = new Uint8Array(extras);
  const sortedItems = entries.map((e) => e.item);
  const priorBytes = prior ? encodeMorphPrior(prior, sortedItems) : null;
  const headerSize = 4 + 1 + 4 + 2 + attrPalette.length * 4 + 4 + 4;
  const totalSize =
    headerSize +
    prefixLens.byteLength +
    suffixLens.byteLength +
    rootStreamBytes.byteLength +
    posSec.byteLength +
    attrCol.byteLength +
    flagsCol.byteLength +
    extrasBytes.byteLength +
    (priorBytes ? priorBytes.byteLength : 0);

  const out = new Uint8Array(totalSize);
  const view = new DataView(out.buffer);
  let offset = 0;

  out[offset++] = MAGIC_0;
  out[offset++] = MAGIC_1;
  out[offset++] = MAGIC_2;
  out[offset++] = MAGIC_3;
  out[offset++] = priorBytes ? FORMAT_VERSION_V2 : FORMAT_VERSION_V1;

  view.setUint32(offset, itemCount, true);
  offset += 4;
  view.setUint16(offset, attrPalette.length, true);
  offset += 2;
  for (let i = 0; i < attrPalette.length; i++) {
    view.setUint32(offset, attrPalette[i]!, true);
    offset += 4;
  }
  view.setUint32(offset, rootStreamBytes.byteLength, true);
  offset += 4;
  view.setUint32(offset, extrasBytes.byteLength, true);
  offset += 4;

  const parts = priorBytes
    ? [prefixLens, suffixLens, rootStreamBytes, posSec, attrCol, flagsCol, extrasBytes, priorBytes]
    : [prefixLens, suffixLens, rootStreamBytes, posSec, attrCol, flagsCol, extrasBytes];
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }

  return out;
}

/**
 * Decodes an `AMR1` or `AMR2` binary morphology payload into exact `DictionaryItem[]` plus optional `MorphPrior`.
 */
export function parseBinaryDictionaryWithPrior(bytes: Uint8Array): { items: DictionaryItem[]; prior?: MorphPrior } {
  if (
    bytes.byteLength < 19 ||
    bytes[0] !== MAGIC_0 ||
    bytes[1] !== MAGIC_1 ||
    bytes[2] !== MAGIC_2 ||
    bytes[3] !== MAGIC_3
  ) {
    throw new Error("autr: Geçersiz biçimbilim ikili başlığı (AMR1 bekleniyordu).");
  }
  const version = bytes[4]!;
  if (version !== FORMAT_VERSION_V1 && version !== FORMAT_VERSION_V2) {
    throw new Error(`autr: Desteklenmeyen biçimbilim biçim sürümü: ${version}.`);
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 5;
  const itemCount = view.getUint32(offset, true);
  offset += 4;
  const attrPaletteLen = view.getUint16(offset, true);
  offset += 2;
  const attrPalette = new Int32Array(attrPaletteLen);
  for (let i = 0; i < attrPaletteLen; i++) {
    attrPalette[i] = view.getUint32(offset, true) | 0;
    offset += 4;
  }
  const rootsByteLen = view.getUint32(offset, true);
  offset += 4;
  const extrasByteLen = view.getUint32(offset, true);
  offset += 4;

  const wideAttr = attrPaletteLen > 255;
  const attrColLen = wideAttr ? itemCount * 2 : itemCount;

  const prefixLens = bytes.subarray(offset, offset + itemCount);
  offset += itemCount;
  const suffixLens = bytes.subarray(offset, offset + itemCount);
  offset += itemCount;
  const rootStream = bytes.subarray(offset, offset + rootsByteLen);
  offset += rootsByteLen;
  const posSec = bytes.subarray(offset, offset + itemCount);
  offset += itemCount;
  const attrCol = bytes.subarray(offset, offset + attrColLen);
  offset += attrColLen;
  const flagsCol = bytes.subarray(offset, offset + itemCount);
  offset += itemCount;
  const extras = bytes.subarray(offset, offset + extrasByteLen);
  const priorOffset = offset + extrasByteLen;

  const decoder = new TextDecoder("utf-8");
  const curRootBytes = new Uint8Array(256);
  const items: DictionaryItem[] = new Array(itemCount);
  const pendingRefs: Array<[itemIdx: number, refIdx: number]> = [];
  const secCount = SECONDARY_POS_LIST.length;

  let rootOff = 0;
  let extOff = 0;

  const readVarint = (): number => {
    let result = 0;
    let shift = 0;
    for (;;) {
      const b = extras[extOff++]!;
      result |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) return result >>> 0;
      shift += 7;
    }
  };

  const readString = (): string => {
    const len = readVarint();
    const s = decoder.decode(extras.subarray(extOff, extOff + len));
    extOff += len;
    return s;
  };

  for (let i = 0; i < itemCount; i++) {
    const p = prefixLens[i]!;
    const s = suffixLens[i]!;
    curRootBytes.set(rootStream.subarray(rootOff, rootOff + s), p);
    rootOff += s;
    const root = decoder.decode(curRootBytes.subarray(0, p + s));

    const ps = posSec[i]!;
    const primaryPos = PRIMARY_POS_LIST[Math.floor(ps / secCount)]!;
    const secondaryPos = SECONDARY_POS_LIST[ps % secCount]!;
    const aIdx = wideAttr ? attrCol[i * 2]! | (attrCol[i * 2 + 1]! << 8) : attrCol[i]!;
    const attributes = attrPalette[aIdx]!;
    const flags = flagsCol[i]!;

    const lemmaMode = flags & LEMMA_MODE_MASK;
    let lemma: string;
    if (lemmaMode === LEMMA_MODE_ROOT) lemma = root;
    else if (lemmaMode === LEMMA_MODE_VERB_MAK) lemma = `${root}mak`;
    else if (lemmaMode === LEMMA_MODE_VERB_MEK) lemma = `${root}mek`;
    else lemma = readString();

    const pronunciation = (flags & FLAG_HAS_PRON) !== 0 ? readString() : root;
    if ((flags & FLAG_HAS_REF) !== 0) {
      pendingRefs.push([i, readVarint()]);
    }
    const index = (flags & FLAG_HAS_INDEX) !== 0 ? readVarint() : 0;
    const key =
      (flags & FLAG_HAS_KEY) !== 0
        ? readString()
        : defaultItemKey(root, lemma, primaryPos, secondaryPos, attributes);

    items[i] = {
      key,
      lemma,
      root,
      pronunciation,
      primaryPos,
      secondaryPos,
      attributes,
      index,
      referenceItem: null,
    };
  }

  for (let i = 0; i < pendingRefs.length; i++) {
    const [itemIdx, refIdx] = pendingRefs[i]!;
    const item = items[itemIdx];
    const ref = items[refIdx];
    if (item !== undefined && ref !== undefined) {
      item.referenceItem = ref;
    }
  }

  const prior =
    version === FORMAT_VERSION_V2 && priorOffset < bytes.byteLength
      ? decodeMorphPrior(bytes, priorOffset, items)
      : undefined;

  return { items, prior };
}

/**
 * Decodes an `AMR1`/`AMR2` binary morphology payload back into exact `DictionaryItem[]`.
 */
export function parseBinaryDictionary(bytes: Uint8Array): DictionaryItem[] {
  return parseBinaryDictionaryWithPrior(bytes).items;
}
