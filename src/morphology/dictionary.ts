/**
 * Zemberek .dict parser, Turkish root attribute inference, and stem transition generator.
 * Adapted from Zemberek's TextDictionaryLoader and StemTransitionsBase (Apache 2.0).
 */

import { lowerTr } from "../turkish.ts";
import {
  PA_CANNOT_TERMINATE,
  PA_EXPECTS_CONSONANT,
  PA_EXPECTS_VOWEL,
  PA_LAST_LETTER_DROPPED,
  PA_LAST_VOICED,
  PA_LAST_VOICELESS,
  PA_LAST_VOICELESS_STOP,
  PA_MODIFIED_PRONOUN,
  PA_UNMODIFIED_PRONOUN,
  PA_VOWEL_BACK,
  PA_VOWEL_FRONT,
  computePhoneticAttributes,
  containsVowel,
  countVowels,
  isVowel,
  isVoicelessStop,
  normalizeCircumflex,
  voiceChar,
} from "./phonetics.ts";
import type { MorphotacticsGraph } from "./morphotactics.ts";
import {
  RA_AORIST_A,
  RA_AORIST_I,
  RA_CAUSATIVE_T,
  RA_COMPOUND_P3SG,
  RA_COMPOUND_P3SG_ROOT,
  RA_DOUBLING,
  RA_DUMMY,
  RA_EXT,
  RA_FAMILY_MEMBER,
  RA_IMPLICIT_DATIVE,
  RA_IMPLICIT_P1SG,
  RA_IMPLICIT_P2SG,
  RA_IMPLICIT_PLURAL,
  RA_INFORMAL,
  RA_INVERSE_HARMONY,
  RA_LAST_VOWEL_DROP,
  RA_NONE,
  RA_NON_RECIPROCAL,
  RA_NOUN_CONS_INSERT_N,
  RA_NO_SUFFIX,
  RA_NO_VOICING,
  RA_PASSIVE_IN,
  RA_PROGRESSIVE_VOWEL_DROP,
  RA_RECIPROCAL,
  RA_REFLEXIVE,
  RA_VOICING,
  RA_VOICING_OPT,
  type DictionaryItem,
  type MorphemeState,
  type PrimaryPos,
  type SecondaryPos,
  type StemTransition,
} from "./types.ts";

const PRIMARY_POS_MAP: Record<string, PrimaryPos> = {
  Noun: "Noun",
  Adj: "Adj",
  Adjective: "Adj",
  Verb: "Verb",
  Pron: "Pron",
  Pronoun: "Pron",
  Adv: "Adv",
  Adverb: "Adv",
  Conj: "Conj",
  Conjunction: "Conj",
  Ques: "Ques",
  Question: "Ques",
  Postp: "Postp",
  PostPositive: "Postp",
  Det: "Det",
  Determiner: "Det",
  Num: "Num",
  Numeral: "Num",
  Dup: "Dup",
  Duplicator: "Dup",
  Interj: "Interj",
  Interjection: "Interj",
  Punc: "Punc",
  Punctuation: "Punc",
};

const SECONDARY_POS_MAP: Record<string, SecondaryPos> = {
  Prop: "ProperNoun",
  ProperNoun: "ProperNoun",
  Abbrv: "Abbreviation",
  Abbreviation: "Abbreviation",
  Time: "Time",
  Pers: "PersonalPron",
  PersonalPron: "PersonalPron",
  Demons: "DemonstrativePron",
  DemonstrativePron: "DemonstrativePron",
  Quant: "QuantitivePron",
  QuantitivePron: "QuantitivePron",
  Ques: "QuestionPron",
  QuestionPron: "QuestionPron",
  Reflex: "ReflexivePron",
  ReflexivePron: "ReflexivePron",
  Card: "Card",
  Ord: "Ord",
  Dist: "Dist",
  PCDat: "PCDat",
  PCAbl: "PCAbl",
  PCNom: "PCNom",
  PCGen: "PCGen",
  PCIns: "PCIns",
  PCAcc: "PCAcc",
};

const ROOT_ATTR_MAP: Record<string, number> = {
  Voicing: RA_VOICING,
  NoVoicing: RA_NO_VOICING,
  VoicingOpt: RA_VOICING_OPT,
  InverseHarmony: RA_INVERSE_HARMONY,
  Doubling: RA_DOUBLING,
  LastVowelDrop: RA_LAST_VOWEL_DROP,
  CompoundP3sg: RA_COMPOUND_P3SG,
  CompoundP3sgRoot: RA_COMPOUND_P3SG_ROOT,
  NoSuffix: RA_NO_SUFFIX,
  ProgressiveVowelDrop: RA_PROGRESSIVE_VOWEL_DROP,
  Aorist_I: RA_AORIST_I,
  Aorist_A: RA_AORIST_A,
  Passive_In: RA_PASSIVE_IN,
  Causative_t: RA_CAUSATIVE_T,
  ImplicitPlural: RA_IMPLICIT_PLURAL,
  ImplicitDative: RA_IMPLICIT_DATIVE,
  ImplicitP1sg: RA_IMPLICIT_P1SG,
  ImplicitP2sg: RA_IMPLICIT_P2SG,
  FamilyMember: RA_FAMILY_MEMBER,
  Reciprocal: RA_RECIPROCAL,
  NonReciprocal: RA_NON_RECIPROCAL,
  Reflexive: RA_REFLEXIVE,
  Dummy: RA_DUMMY,
  NounConsInsert_n: RA_NOUN_CONS_INSERT_N,
  Ext: RA_EXT,
  Informal: RA_INFORMAL,
};

/**
 * Known non-TDK entries and typos present inside Zemberek's master-dictionary.dict
 * (mostly from manually appended adverb/interjection blocks at the end of the file).
 * Excluded so the autocorrector does not treat common joined/colloquial misspellings as valid.
 */
const EXCLUDED_NON_TDK_LEMMAS = new Set([
  "afedersin",
  "afedersinin",
  "ardarda",
  "birara",
  "birarada",
  "çöğunlukla",
  "elele",
  "herbiri",
  "herzaman",
  "ilerde",
  "keşki",
  "kolkola",
  "yanısıra",
]);

function makeKey(rootLemma: string, primaryPos: PrimaryPos, secondaryPos: SecondaryPos): string {
  return secondaryPos === "None" ? `${rootLemma}_${primaryPos}` : `${rootLemma}_${primaryPos}_${secondaryPos}`;
}

function inferAttributes(
  root: string,
  primaryPos: PrimaryPos,
  secondaryPos: SecondaryPos,
  attrs: number,
): number {
  let out = attrs;
  const len = root.length;
  if (len === 0) return out;
  const last = root[len - 1] ?? "";
  const prev = len > 1 ? (root[len - 2] ?? "") : "";
  const vowels = countVowels(root);

  if (primaryPos === "Verb") {
    // Special verbs handled separately in StemTransitions / Morphotactics.
    if (root === "de" || root === "ye" || root === "i" || root === "değil") {
      return out;
    }

    // Progressive vowel drop: verb stems ending in a vowel (ara -> ar-ıyor, bekle -> bekl-iyor).
    if (isVowel(last)) {
      out |= RA_PROGRESSIVE_VOWEL_DROP;
    }

    // Aorist: default single-syllable -> -Ar, multi-syllable -> -Ir (unless explicitly tagged).
    if ((out & (RA_AORIST_A | RA_AORIST_I)) === 0) {
      if (vowels <= 1 && !isVowel(last)) {
        out |= RA_AORIST_A;
      } else {
        out |= RA_AORIST_I;
      }
    }

    // Passive: vowel-final or l-final stems take -In/-InIl; others take +nIl.
    if (isVowel(last) || last === "l") {
      out |= RA_PASSIVE_IN;
    }

    // Causative -t: vowel-final stems, or multi-syllable stems ending in r or l.
    if (isVowel(last) || (vowels > 1 && (last === "r" || last === "l"))) {
      out |= RA_CAUSATIVE_T;
    }

    return out;
  }

  // Non-verb automatic consonant voicing (kitap -> kitab, ağaç -> ağac, renk -> reng, psikolog -> psikoloğ).
  // Proper nouns and abbreviations do not soften in standard Turkish orthography unless explicitly tagged.
  if (
    (primaryPos === "Noun" || primaryPos === "Adj" || primaryPos === "Num" || primaryPos === "Pron") &&
    secondaryPos !== "ProperNoun" &&
    secondaryPos !== "Abbreviation" &&
    (out & (RA_VOICING | RA_NO_VOICING | RA_VOICING_OPT | RA_DOUBLING | RA_INVERSE_HARMONY | RA_NO_SUFFIX | RA_COMPOUND_P3SG)) === 0
  ) {
    const endsWithNk = len >= 2 && prev === "n" && last === "k";
    const endsWithVowelG = len >= 2 && isVowel(prev) && last === "g";
    if (endsWithNk) {
      out |= RA_VOICING;
    } else if (vowels > 1 && (isVoicelessStop(last) || endsWithVowelG)) {
      out |= RA_VOICING;
    }
  }

  return out;
}

interface PendingRef {
  readonly item: DictionaryItem;
  readonly refKey: string;
}

/**
 * Parses one or more Zemberek `.dict` text payloads into DictionaryItems.
 * Entries marked `A:Informal` or `A:Ext` (non-TDK noisy/colloquial spellings) and
 * `P:Punc` entries are skipped to preserve high spellchecking precision.
 */
export function parseDictionaries(texts: readonly string[]): DictionaryItem[] {
  const items: DictionaryItem[] = [];
  const byKey = new Map<string, DictionaryItem>();
  const pendingRefs: PendingRef[] = [];

  for (const text of texts) {
    let start = 0;
    const n = text.length;
    while (start <= n) {
      let end = text.indexOf("\n", start);
      if (end === -1) end = n;
      let lineEnd = end;
      if (lineEnd > start && text.charCodeAt(lineEnd - 1) === 13) {
        lineEnd--;
      }
      const rawLine = text.slice(start, lineEnd).trim();
      start = end + 1;

      if (rawLine.length === 0 || rawLine.charCodeAt(0) === 35 /* '#' */) {
        continue;
      }

      const bracketIdx = rawLine.indexOf("[");
      const rawLemma = (bracketIdx === -1 ? rawLine : rawLine.slice(0, bracketIdx)).trim();
      if (rawLemma.length === 0) continue;

      let primaryPos: PrimaryPos | null = null;
      let secondaryPos: SecondaryPos = "None";
      let attrs = RA_NONE;
      let rawPron = "";
      let rawRoots = "";
      let refSpec = "";
      let index = 0;

      if (bracketIdx !== -1) {
        const closeIdx = rawLine.lastIndexOf("]");
        const meta = closeIdx > bracketIdx ? rawLine.slice(bracketIdx + 1, closeIdx) : rawLine.slice(bracketIdx + 1);
        let segStart = 0;
        while (segStart <= meta.length) {
          let segEnd = meta.indexOf(";", segStart);
          if (segEnd === -1) segEnd = meta.length;
          const seg = meta.slice(segStart, segEnd).trim();
          segStart = segEnd + 1;
          if (seg.length === 0) continue;

          const colon = seg.indexOf(":");
          if (colon === -1) continue;
          const tag = seg.slice(0, colon).trim();
          const val = seg.slice(colon + 1).trim();

          if (tag === "P") {
            const comma = val.indexOf(",");
            if (comma === -1) {
              const p = PRIMARY_POS_MAP[val];
              if (p !== undefined) primaryPos = p;
            } else {
              const p1 = val.slice(0, comma).trim();
              const p2 = val.slice(comma + 1).trim();
              const mapped1 = PRIMARY_POS_MAP[p1];
              if (mapped1 !== undefined) primaryPos = mapped1;
              const mapped2 = SECONDARY_POS_MAP[p2];
              if (mapped2 !== undefined) secondaryPos = mapped2;
            }
          } else if (tag === "A") {
            let aStart = 0;
            while (aStart <= val.length) {
              let aEnd = val.indexOf(",", aStart);
              if (aEnd === -1) aEnd = val.length;
              const attrName = val.slice(aStart, aEnd).trim();
              aStart = aEnd + 1;
              if (attrName.length === 0) continue;
              const bit = ROOT_ATTR_MAP[attrName];
              if (bit !== undefined) attrs |= bit;
            }
          } else if (tag === "Pr" || tag === "pr") {
            rawPron = val;
          } else if (tag === "Roots") {
            rawRoots = val;
          } else if (tag === "Index") {
            const parsed = Number.parseInt(val, 10);
            if (!Number.isNaN(parsed)) index = parsed;
          } else if (tag === "Ref") {
            refSpec = val;
          }
        }
      }

      // Skip punctuation, informal spellings, and non-TDK [A:Ext] entries.
      if (primaryPos === "Punc" || (attrs & (RA_INFORMAL | RA_EXT)) !== 0) {
        continue;
      }

      const lowerLemma = lowerTr(rawLemma);
      const normLemma = normalizeCircumflex(lowerLemma);

      if (EXCLUDED_NON_TDK_LEMMAS.has(normLemma)) {
        continue;
      }

      // Default POS inference.
      if (primaryPos === null) {
        if (normLemma.length > 3 && (normLemma.endsWith("mak") || normLemma.endsWith("mek"))) {
          primaryPos = "Verb";
        } else {
          primaryPos = "Noun";
          const firstRaw = rawLemma[0] ?? "";
          if (firstRaw !== lowerTr(firstRaw)) {
            secondaryPos = "ProperNoun";
          }
        }
      }

      const root =
        primaryPos === "Verb" && normLemma.length > 3 && (normLemma.endsWith("mak") || normLemma.endsWith("mek"))
          ? normLemma.slice(0, -3)
          : normLemma;

      const pronunciation = rawPron.length > 0 ? normalizeCircumflex(lowerTr(rawPron)) : root;
      const inferredAttrs = inferAttributes(root, primaryPos, secondaryPos, attrs);
      const key = makeKey(normLemma, primaryPos, secondaryPos);

      const item: DictionaryItem = {
        key,
        lemma: lowerLemma,
        root,
        pronunciation,
        primaryPos,
        secondaryPos,
        attributes: inferredAttrs,
        index,
        referenceItem: null,
      };

      items.push(item);
      const lowerKey = lowerTr(key);
      if (index === 0 && !byKey.has(lowerKey)) {
        byKey.set(lowerKey, item);
      }
      if (refSpec.length > 0) {
        pendingRefs.push({ item, refKey: normalizeCircumflex(lowerTr(refSpec)) });
      }

      // Generate dummy CompoundP3sgRoot stem for compound nouns with Roots:r1-r2
      // (e.g. zeytinyağı [A:CompoundP3sg; Roots:zeytin-yağ] -> dummy root "zeytinyağ").
      if ((inferredAttrs & RA_COMPOUND_P3SG) !== 0 && rawRoots.length > 0 && primaryPos === "Noun") {
        const dashIdx = rawRoots.indexOf("-");
        if (dashIdx > 0 && dashIdx < rawRoots.length - 1) {
          const compoundRoot = normalizeCircumflex(
            lowerTr(rawRoots.slice(0, dashIdx) + rawRoots.slice(dashIdx + 1)),
          );
          if (compoundRoot.length > 0 && compoundRoot !== root) {
            const dummyItem: DictionaryItem = {
              key: `${compoundRoot}_Noun_CompoundRoot`,
              lemma: lowerLemma,
              root: compoundRoot,
              pronunciation: compoundRoot,
              primaryPos: "Noun",
              secondaryPos: "None",
              attributes: RA_COMPOUND_P3SG_ROOT | RA_DUMMY | (inferredAttrs & RA_INVERSE_HARMONY),
              index: 0,
              referenceItem: item,
            };
            items.push(dummyItem);
          }
        }
      }
    }
  }

  // Resolve Ref: links (e.g. non-dropped LastVowelDrop variants or circumflex variants).
  for (const { item, refKey } of pendingRefs) {
    const direct = byKey.get(refKey);
    if (direct !== undefined) {
      item.referenceItem = direct;
    } else {
      const posFallback = byKey.get(`${refKey}_${lowerTr(item.primaryPos)}`);
      if (posFallback !== undefined) {
        item.referenceItem = posFallback;
      }
    }
  }

  return items;
}

const MODIFIER_ATTR_MASK =
  RA_DOUBLING |
  RA_LAST_VOWEL_DROP |
  RA_PROGRESSIVE_VOWEL_DROP |
  RA_INVERSE_HARMONY |
  RA_VOICING |
  RA_COMPOUND_P3SG |
  RA_COMPOUND_P3SG_ROOT;

const SPECIAL_ROOT_KEYS = new Set([
  "ben_Pron_PersonalPron",
  "sen_Pron_PersonalPron",
  "demek_Verb",
  "yemek_Verb",
  "imek_Verb",
  "birbiri_Pron_QuantitivePron",
  "çoğu_Pron_QuantitivePron",
  "öbürü_Pron_QuantitivePron",
  "birçoğu_Pron_QuantitivePron",
]);

function isNonDroppedLastVowelDropVariant(item: DictionaryItem): boolean {
  const ref = item.referenceItem;
  return (
    ref !== null &&
    (ref.attributes & RA_LAST_VOWEL_DROP) !== 0 &&
    (item.attributes & RA_LAST_VOWEL_DROP) === 0 &&
    item.root === ref.root
  );
}

function generateSpecialRootTransitions(item: DictionaryItem, graph: MorphotacticsGraph): StemTransition[] {
  const origAttrs = computePhoneticAttributes(item.pronunciation);
  const unmodifiedState = graph.getRootState(item, origAttrs);

  switch (item.key) {
    case "ben_Pron_PersonalPron":
    case "sen_Pron_PersonalPron": {
      const modSurface = item.root === "ben" ? "ban" : "san";
      const orig: StemTransition = {
        surface: item.root,
        item,
        phonetic: origAttrs | PA_UNMODIFIED_PRONOUN,
        to: unmodifiedState,
      };
      const mod: StemTransition = {
        surface: modSurface,
        item,
        phonetic: computePhoneticAttributes(modSurface) | PA_MODIFIED_PRONOUN,
        to: graph.pronPers_Mod_S,
      };
      return [orig, mod];
    }

    case "demek_Verb":
    case "yemek_Verb": {
      const modSurface = item.root === "de" ? "di" : "yi";
      return [
        { surface: item.root, item, phonetic: origAttrs, to: graph.vDeYeRoot_S },
        { surface: modSurface, item, phonetic: computePhoneticAttributes(modSurface), to: graph.vDeYeRoot_S },
      ];
    }

    case "imek_Verb":
      return [{ surface: item.root, item, phonetic: origAttrs, to: graph.imekRoot_S }];

    case "birbiri_Pron_QuantitivePron":
    case "çoğu_Pron_QuantitivePron":
    case "öbürü_Pron_QuantitivePron":
    case "birçoğu_Pron_QuantitivePron": {
      let modSurface: string;
      if (item.root === "birbiri") modSurface = "birbir";
      else if (item.root === "çoğu") modSurface = "çok";
      else if (item.root === "öbürü") modSurface = "öbür";
      else modSurface = "birçok";
      return [
        {
          surface: item.root,
          item,
          phonetic: origAttrs | PA_UNMODIFIED_PRONOUN,
          to: graph.pronQuant_S,
        },
        {
          surface: modSurface,
          item,
          phonetic: computePhoneticAttributes(modSurface) | PA_MODIFIED_PRONOUN,
          to: graph.pronQuantModified_S,
        },
      ];
    }

    default:
      return [{ surface: item.root, item, phonetic: origAttrs, to: unmodifiedState }];
  }
}

function generateStemTransitions(item: DictionaryItem, graph: MorphotacticsGraph): StemTransition[] {
  if (SPECIAL_ROOT_KEYS.has(item.key)) {
    return generateSpecialRootTransitions(item, graph);
  }

  if ((item.attributes & MODIFIER_ATTR_MASK) === 0) {
    let phonetic = computePhoneticAttributes(item.pronunciation);
    if (isNonDroppedLastVowelDropVariant(item)) {
      phonetic |= PA_EXPECTS_VOWEL | PA_CANNOT_TERMINATE;
    }
    return [
      {
        surface: item.root,
        item,
        phonetic,
        to: graph.getRootState(item, phonetic),
      },
    ];
  }

  let modifiedSeq = item.root;
  let originalAttrs = computePhoneticAttributes(item.pronunciation);
  let modifiedAttrs = originalAttrs;
  let unmodifiedRootState: MorphemeState | null = null;
  let modifiedRootState: MorphemeState | null = null;

  // Apply Voicing BEFORE Doubling (ret -> red -> redd, tıp -> tıb -> tıbb, zıt -> zıd -> zıdd).
  if ((item.attributes & RA_VOICING) !== 0 && modifiedSeq.length > 0) {
    const last = modifiedSeq[modifiedSeq.length - 1] ?? "";
    const voiced = modifiedSeq.endsWith("nk") ? "g" : voiceChar(last);
    if (voiced !== last) {
      modifiedSeq = modifiedSeq.slice(0, -1) + voiced;
      modifiedAttrs &= ~(PA_LAST_VOICELESS_STOP | PA_LAST_VOICELESS);
      modifiedAttrs |= PA_LAST_VOICED | PA_EXPECTS_VOWEL | PA_CANNOT_TERMINATE;
      originalAttrs |= PA_EXPECTS_CONSONANT;
    }
  }

  if ((item.attributes & RA_DOUBLING) !== 0 && modifiedSeq.length > 0) {
    const last = modifiedSeq[modifiedSeq.length - 1] ?? "";
    modifiedSeq = modifiedSeq + last;
    originalAttrs |= PA_EXPECTS_CONSONANT;
    modifiedAttrs |= PA_EXPECTS_VOWEL | PA_CANNOT_TERMINATE;
  }

  if ((item.attributes & RA_LAST_VOWEL_DROP) !== 0 && modifiedSeq.length >= 2) {
    const last = modifiedSeq[modifiedSeq.length - 1] ?? "";
    if (!isVowel(last)) {
      modifiedSeq = modifiedSeq.slice(0, -2) + last;
      if (item.primaryPos !== "Verb") {
        originalAttrs |= PA_EXPECTS_CONSONANT;
      } else {
        unmodifiedRootState = graph.verbLastVowelDropUnmodRoot_S;
        modifiedRootState = graph.verbLastVowelDropModRoot_S;
      }
      modifiedAttrs |= PA_EXPECTS_VOWEL | PA_CANNOT_TERMINATE;
    }
  }

  if ((item.attributes & RA_INVERSE_HARMONY) !== 0) {
    originalAttrs = (originalAttrs & ~PA_VOWEL_BACK) | PA_VOWEL_FRONT;
    modifiedAttrs = (modifiedAttrs & ~PA_VOWEL_BACK) | PA_VOWEL_FRONT;
  }

  if ((item.attributes & RA_PROGRESSIVE_VOWEL_DROP) !== 0 && modifiedSeq.length > 1) {
    modifiedSeq = modifiedSeq.slice(0, -1);
    if (containsVowel(modifiedSeq)) {
      modifiedAttrs = computePhoneticAttributes(modifiedSeq);
    }
    modifiedAttrs |= PA_LAST_LETTER_DROPPED;
  }

  const unmodState = unmodifiedRootState ?? graph.getRootState(item, originalAttrs);
  const modState = modifiedRootState ?? graph.getRootState(item, modifiedAttrs);

  const original: StemTransition = {
    surface: item.root,
    item,
    phonetic: originalAttrs,
    to: unmodState,
  };
  const modified: StemTransition = {
    surface: modifiedSeq,
    item,
    phonetic: modifiedAttrs,
    to: modState,
  };

  if (original.surface === modified.surface && original.phonetic === modified.phonetic && original.to === modified.to) {
    return [original];
  }
  if (isNonDroppedLastVowelDropVariant(item) && (item.attributes & RA_VOICING) !== 0) {
    return [modified];
  }
  return [original, modified];
}

export interface StemIndex {
  readonly stems: Map<string, StemTransition | StemTransition[]>;
  readonly maxStemLength: number;
}

/**
 * Generates all surface stem transitions for the parsed dictionary items and indexes
 * them in a compact Map (single transitions stored directly without wrapper arrays).
 */
export function buildStemIndex(items: readonly DictionaryItem[], graph: MorphotacticsGraph): StemIndex {
  const stems = new Map<string, StemTransition | StemTransition[]>();
  let maxStemLength = 0;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item === undefined || item.root.length === 0) continue;
    const transitions = generateStemTransitions(item, graph);
    for (let j = 0; j < transitions.length; j++) {
      const tr = transitions[j];
      if (tr === undefined || tr.surface.length === 0) continue;
      if (tr.surface.length > maxStemLength) {
        maxStemLength = tr.surface.length;
      }
      const existing = stems.get(tr.surface);
      if (existing === undefined) {
        stems.set(tr.surface, tr);
      } else if (Array.isArray(existing)) {
        existing.push(tr);
      } else {
        stems.set(tr.surface, [existing, tr]);
      }
    }
  }

  return { stems, maxStemLength };
}
