/**
 * Shared types and bitmask constants for the Turkish morphological analyzer.
 * Adapted from Zemberek's core/morphotactics data model (Apache 2.0).
 */

export type PrimaryPos =
  | "Noun"
  | "Adj"
  | "Verb"
  | "Pron"
  | "Adv"
  | "Conj"
  | "Ques"
  | "Postp"
  | "Det"
  | "Num"
  | "Dup"
  | "Interj"
  | "Punc";

export type SecondaryPos =
  | "None"
  | "ProperNoun"
  | "Abbreviation"
  | "Time"
  | "PersonalPron"
  | "DemonstrativePron"
  | "QuantitivePron"
  | "QuestionPron"
  | "ReflexivePron"
  | "Card"
  | "Ord"
  | "Dist"
  | "PCDat"
  | "PCAbl"
  | "PCNom"
  | "PCGen"
  | "PCIns"
  | "PCAcc";

// Root attribute bitmask flags (max 31 bits in signed 32-bit bitwise ops).
export const RA_NONE = 0;
export const RA_VOICING = 1 << 0;
export const RA_NO_VOICING = 1 << 1;
export const RA_VOICING_OPT = 1 << 2;
export const RA_INVERSE_HARMONY = 1 << 3;
export const RA_DOUBLING = 1 << 4;
export const RA_LAST_VOWEL_DROP = 1 << 5;
export const RA_COMPOUND_P3SG = 1 << 6;
export const RA_COMPOUND_P3SG_ROOT = 1 << 7;
export const RA_NO_SUFFIX = 1 << 8;
export const RA_PROGRESSIVE_VOWEL_DROP = 1 << 9;
export const RA_AORIST_I = 1 << 10;
export const RA_AORIST_A = 1 << 11;
export const RA_PASSIVE_IN = 1 << 12;
export const RA_CAUSATIVE_T = 1 << 13;
export const RA_IMPLICIT_PLURAL = 1 << 14;
export const RA_IMPLICIT_DATIVE = 1 << 15;
export const RA_IMPLICIT_P1SG = 1 << 16;
export const RA_IMPLICIT_P2SG = 1 << 17;
export const RA_FAMILY_MEMBER = 1 << 18;
export const RA_RECIPROCAL = 1 << 19;
export const RA_NON_RECIPROCAL = 1 << 20;
export const RA_REFLEXIVE = 1 << 21;
export const RA_DUMMY = 1 << 22;
export const RA_NOUN_CONS_INSERT_N = 1 << 23;
export const RA_EXT = 1 << 24;
export const RA_INFORMAL = 1 << 25;

export interface DictionaryItem {
  /** Lookup key without numeric homonym index, e.g. "ben_Pron_Pers", "dün_Noun_Time", "değil_Verb". */
  readonly key: string;
  /** Lowercased lemma preserving circumflexes (for circumflex verification). */
  readonly lemma: string;
  /** Normalized root surface without circumflexes and without -mak/-mek for verbs. */
  readonly root: string;
  /** Normalized pronunciation string (defaults to root). */
  readonly pronunciation: string;
  readonly primaryPos: PrimaryPos;
  readonly secondaryPos: SecondaryPos;
  readonly attributes: number;
  readonly index: number;
  /** Reference item for Dummy compound roots (e.g. "zeytinyağ" -> "zeytinyağı") or variants. */
  referenceItem: DictionaryItem | null;
}

export interface Morpheme {
  readonly id: string;
  readonly derivational: boolean;
  readonly pos: PrimaryPos | null;
}

export interface SuffixTemplateToken {
  readonly type: 0 | 1 | 2 | 3 | 4 | 5 | 6;
  readonly letter: string;
}

export interface PathNode {
  readonly prev: PathNode | null;
  readonly stemTransition: StemTransition;
  readonly state: MorphemeState;
  readonly surface: string;
  /** Current offset in the normalized search input. */
  readonly pos: number;
  /** Total length of the search input (for O(1) HAS_TAIL / HAS_NO_TAIL checks). */
  readonly inputLength: number;
  /** Current PhoneticAttribute bitmask. */
  readonly phonetic: number;
  readonly depth: number;
  readonly hasSurface: boolean;
  readonly hasDerivation: boolean;
  readonly currentGroupHasSurface: boolean;
  readonly lastDerivation: MorphemeState | null;
}

export type Condition = (path: PathNode) => boolean;

export interface SuffixTransition {
  readonly from: MorphemeState;
  readonly to: MorphemeState;
  readonly template: string;
  readonly tokens: readonly SuffixTemplateToken[];
  readonly lastToken: SuffixTemplateToken | undefined;
  readonly hasSurface: boolean;
  readonly condition: Condition | null;
  /** Pre-computed expectation mask: PA_EXPECTS_VOWEL or PA_EXPECTS_CONSONANT that must NOT be present. */
  readonly forbiddenPhonetic: number;
  /** 64-entry surface cache indexed by 6-bit phonetic harmony/voicing key (null = impossible). */
  readonly surfaceCache: (string | null | undefined)[];
  /** 64-entry next-phonetic-bitmask cache aligned with surfaceCache. */
  readonly nextPhoneticCache: Int32Array;
}

export interface MorphemeState {
  readonly id: string;
  readonly morpheme: Morpheme;
  readonly terminal: boolean;
  readonly derivative: boolean;
  readonly posRoot: boolean;
  readonly outgoing: SuffixTransition[];
}

export interface StemTransition {
  readonly surface: string;
  readonly item: DictionaryItem;
  readonly phonetic: number;
  readonly to: MorphemeState;
}

export interface MorphAnalysis {
  stem: string;
  pos: string;
  morphemes: string[];
}
