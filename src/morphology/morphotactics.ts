/**
 * Turkish morphotactic state machine graph.
 * Adapted from Zemberek's TurkishMorphotactics.java and Conditions.java (Apache 2.0),
 * with precision-focused adjustments for formal Turkish spellchecking:
 * - Excludes colloquial vowel-dropped locative/ablative contractions (burda, içerde, ilerde...).
 * - Excludes attached question particles (mi) and attached conjunctions (de/da/ki).
 * - Adds productive -daş (>dAş) noun derivation and deyince/yiyince transitions.
 * - Restricts nominalization (Adj -> Zero -> Noun) on non-nominalizable function adjectives
 *   (nasıl, öyle, böyle, şöyle, her, herhangi, birkaç, birçok, birtakım, bazı, hiçbir, tüm, bütün)
 *   and blocks locative -da on "daha" so clitic errors (*nasılda, *öylemi, *dahada) are rejected.
 */

import { lowerTr } from "../turkish.ts";
import {
  PA_EXPECTS_CONSONANT,
  PA_EXPECTS_VOWEL,
  PA_LAST_CONSONANT,
  PA_LAST_LETTER_DROPPED,
  PA_LAST_VOWEL,
  PA_MODIFIED_PRONOUN,
  SURFACE_CACHE_SIZE,
  isVowel,
  tokenizeTemplate,
} from "./phonetics.ts";
import {
  RA_AORIST_A,
  RA_AORIST_I,
  RA_CAUSATIVE_T,
  RA_COMPOUND_P3SG,
  RA_COMPOUND_P3SG_ROOT,
  RA_FAMILY_MEMBER,
  RA_IMPLICIT_DATIVE,
  RA_IMPLICIT_P1SG,
  RA_IMPLICIT_P2SG,
  RA_IMPLICIT_PLURAL,
  RA_NOUN_CONS_INSERT_N,
  RA_NO_SUFFIX,
  RA_PASSIVE_IN,
  RA_RECIPROCAL,
  RA_REFLEXIVE,
  type Condition,
  type DictionaryItem,
  type Morpheme,
  type MorphemeState,
  type PathNode,
  type PrimaryPos,
  type SuffixTransition,
} from "./types.ts";

// --- Morpheme definitions ---

function morpheme(id: string, pos: PrimaryPos | null = null, derivational = false): Morpheme {
  return { id, pos, derivational };
}

export const MORPHEMES = {
  root: morpheme("Root"),
  noun: morpheme("Noun", "Noun"),
  adj: morpheme("Adj", "Adj"),
  verb: morpheme("Verb", "Verb"),
  pron: morpheme("Pron", "Pron"),
  adv: morpheme("Adv", "Adv"),
  conj: morpheme("Conj", "Conj"),
  ques: morpheme("Ques", "Ques"),
  postp: morpheme("Postp", "Postp"),
  det: morpheme("Det", "Det"),
  num: morpheme("Num", "Num"),
  dup: morpheme("Dup", "Dup"),
  interj: morpheme("Interj", "Interj"),

  // Person / Number agreement
  a1sg: morpheme("A1sg"),
  a2sg: morpheme("A2sg"),
  a3sg: morpheme("A3sg"),
  a1pl: morpheme("A1pl"),
  a2pl: morpheme("A2pl"),
  a3pl: morpheme("A3pl"),

  // Possessive
  pnon: morpheme("Pnon"),
  p1sg: morpheme("P1sg"),
  p2sg: morpheme("P2sg"),
  p3sg: morpheme("P3sg"),
  p1pl: morpheme("P1pl"),
  p2pl: morpheme("P2pl"),
  p3pl: morpheme("P3pl"),

  // Case
  nom: morpheme("Nom"),
  dat: morpheme("Dat"),
  acc: morpheme("Acc"),
  abl: morpheme("Abl"),
  loc: morpheme("Loc"),
  ins: morpheme("Ins"),
  gen: morpheme("Gen"),
  equ: morpheme("Equ"),

  // Derivational
  dim: morpheme("Dim", null, true),
  ness: morpheme("Ness", null, true),
  with: morpheme("With", null, true),
  without: morpheme("Without", null, true),
  related: morpheme("Related", null, true),
  justLike: morpheme("JustLike", null, true),
  rel: morpheme("Rel", null, true),
  agt: morpheme("Agt", null, true),
  dash: morpheme("Dash", null, true),
  become: morpheme("Become", null, true),
  acquire: morpheme("Acquire", null, true),
  ly: morpheme("Ly", null, true),
  caus: morpheme("Caus", null, true),
  recip: morpheme("Recip", null, true),
  reflex: morpheme("Reflex", null, true),
  able: morpheme("Able", null, true),
  pass: morpheme("Pass", null, true),
  inf1: morpheme("Inf1", null, true),
  inf2: morpheme("Inf2", null, true),
  inf3: morpheme("Inf3", null, true),
  actOf: morpheme("ActOf", null, true),
  pastPart: morpheme("PastPart", null, true),
  narrPart: morpheme("NarrPart", null, true),
  futPart: morpheme("FutPart", null, true),
  presPart: morpheme("PresPart", null, true),
  aorPart: morpheme("AorPart", null, true),
  notState: morpheme("NotState", null, true),
  feelLike: morpheme("FeelLike", null, true),
  everSince: morpheme("EverSince", null, true),
  repeat: morpheme("Repeat", null, true),
  almost: morpheme("Almost", null, true),
  hastily: morpheme("Hastily", null, true),
  stay: morpheme("Stay", null, true),
  start: morpheme("Start", null, true),
  asIf: morpheme("AsIf", null, true),
  while_: morpheme("While", null, true),
  when: morpheme("When", null, true),
  sinceDoingSo: morpheme("SinceDoingSo", null, true),
  asLongAs: morpheme("AsLongAs", null, true),
  byDoingSo: morpheme("ByDoingSo", null, true),
  adamantly: morpheme("Adamantly", null, true),
  afterDoingSo: morpheme("AfterDoingSo", null, true),
  withoutHavingDoneSo: morpheme("WithoutHavingDoneSo", null, true),
  withoutBeingAbleToHaveDoneSo: morpheme("WithoutBeingAbleToHaveDoneSo", null, true),
  zero: morpheme("Zero", null, true),

  // Verbal inflection
  cop: morpheme("Cop"),
  neg: morpheme("Neg"),
  unable: morpheme("Unable"),
  pres: morpheme("Pres"),
  past: morpheme("Past"),
  narr: morpheme("Narr"),
  cond: morpheme("Cond"),
  prog1: morpheme("Prog1"),
  prog2: morpheme("Prog2"),
  aor: morpheme("Aor"),
  fut: morpheme("Fut"),
  imp: morpheme("Imp"),
  opt: morpheme("Opt"),
  desr: morpheme("Desr"),
  neces: morpheme("Neces"),
} as const;

// --- Condition combinators ---

const hasTail: Condition = (p) => p.pos < p.inputLength;
const hasSurface: Condition = (p) => p.hasSurface;
const hasNoSurface: Condition = (p) => !p.hasSurface;
const currentGroupEmpty: Condition = (p) => !p.currentGroupHasSurface;

function hasAttr(mask: number): Condition {
  return (p) => (p.stemTransition.item.attributes & mask) !== 0;
}

function notHaveAttr(mask: number): Condition {
  return (p) => (p.stemTransition.item.attributes & mask) === 0;
}

function hasPhon(mask: number): Condition {
  return (p) => (p.phonetic & mask) !== 0;
}

function notHavePhon(mask: number): Condition {
  return (p) => (p.phonetic & mask) === 0;
}

function rootKeyIs(key: string): Condition {
  return (p) => p.stemTransition.item.key === key;
}

function rootKeyIsNot(key: string): Condition {
  return (p) => p.stemTransition.item.key !== key;
}

function rootKeyIn(keys: readonly string[]): Condition {
  const set = new Set(keys);
  return (p) => set.has(p.stemTransition.item.key);
}

function rootKeyNotIn(keys: readonly string[]): Condition {
  const set = new Set(keys);
  return (p) => !set.has(p.stemTransition.item.key);
}

function rootSurfaceIs(surface: string): Condition {
  return (p) => p.stemTransition.surface === surface;
}

function rootSurfaceIn(surfaces: readonly string[]): Condition {
  const set = new Set(surfaces);
  return (p) => set.has(p.stemTransition.surface);
}

function secondaryPosIs(pos: DictionaryItem["secondaryPos"]): Condition {
  return (p) => p.stemTransition.item.secondaryPos === pos;
}

function prevStateIs(state: MorphemeState): Condition {
  return (p) => p.prev !== null && p.prev.state === state;
}

function prevStateIsNot(state: MorphemeState): Condition {
  return (p) => p.prev === null || p.prev.state !== state;
}

function prevStateIn(states: readonly MorphemeState[]): Condition {
  const set = new Set(states);
  return (p) => p.prev !== null && set.has(p.prev.state);
}

function prevMorphemeIs(m: Morpheme): Condition {
  return (p) => p.prev !== null && p.prev.state.morpheme === m;
}

function prevMorphemeIsNot(m: Morpheme): Condition {
  return (p) => p.prev === null || p.prev.state.morpheme !== m;
}

function prevMorphemeIn(ms: readonly Morpheme[]): Condition {
  const set = new Set(ms);
  return (p) => p.prev !== null && set.has(p.prev.state.morpheme);
}

function lastDerivIs(state: MorphemeState): Condition {
  return (p) => p.lastDerivation === state;
}

function lastDerivIn(states: readonly MorphemeState[]): Condition {
  const set = new Set(states);
  return (p) => p.lastDerivation !== null && set.has(p.lastDerivation);
}

function containsMorpheme(...ms: Morpheme[]): Condition {
  if (ms.length === 1) {
    const target = ms[0];
    return (p) => {
      let cur: PathNode | null = p;
      while (cur !== null) {
        if (cur.state.morpheme === target) return true;
        cur = cur.prev;
      }
      return false;
    };
  }
  const set = new Set(ms);
  return (p) => {
    let cur: PathNode | null = p;
    while (cur !== null) {
      if (set.has(cur.state.morpheme)) return true;
      cur = cur.prev;
    }
    return false;
  };
}

function containsMorphemeSeq(...seq: Morpheme[]): Condition {
  const len = seq.length;
  const last = seq[len - 1];
  return (p) => {
    let cur: PathNode | null = p;
    while (cur !== null) {
      if (cur.state.morpheme === last) {
        let probe: PathNode | null = cur;
        let idx = len - 1;
        while (idx >= 0 && probe !== null && probe.state.morpheme === seq[idx]) {
          idx--;
          probe = probe.prev;
        }
        if (idx < 0) return true;
      }
      cur = cur.prev;
    }
    return false;
  };
}

function hasTailSeq(...seq: Morpheme[]): Condition {
  const len = seq.length;
  return (p) => {
    let cur: PathNode | null = p;
    for (let idx = len - 1; idx >= 0; idx--) {
      if (cur === null || cur.state.morpheme !== seq[idx]) return false;
      cur = cur.prev;
    }
    return true;
  };
}

function currentGroupContains(...states: MorphemeState[]): Condition {
  const set = new Set(states);
  return (p) => {
    let cur: PathNode | null = p;
    while (cur !== null && cur.prev !== null) {
      if (set.has(cur.state)) return true;
      if (cur.state.derivative) return false;
      cur = cur.prev;
    }
    return false;
  };
}

function prevGroupContains(...states: MorphemeState[]): Condition {
  const set = new Set(states);
  return (p) => {
    let cur: PathNode | null = p;
    while (cur !== null && !cur.state.derivative) {
      cur = cur.prev;
    }
    if (cur === null || cur.prev === null) return false;
    cur = cur.prev;
    while (cur !== null && cur.prev !== null) {
      if (set.has(cur.state)) return true;
      if (cur.state.derivative) return false;
      cur = cur.prev;
    }
    return false;
  };
}

function prevGroupContainsMorpheme(...ms: Morpheme[]): Condition {
  const set = new Set(ms);
  return (p) => {
    let cur: PathNode | null = p;
    while (cur !== null && !cur.state.derivative) {
      cur = cur.prev;
    }
    if (cur === null || cur.prev === null) return false;
    cur = cur.prev;
    while (cur !== null && cur.prev !== null) {
      if (set.has(cur.state.morpheme)) return true;
      if (cur.state.derivative) return false;
      cur = cur.prev;
    }
    return false;
  };
}

function and(...conds: Condition[]): Condition {
  return (p) => {
    for (let i = 0; i < conds.length; i++) {
      const c = conds[i];
      if (c !== undefined && !c(p)) return false;
    }
    return true;
  };
}

function or(...conds: Condition[]): Condition {
  return (p) => {
    for (let i = 0; i < conds.length; i++) {
      const c = conds[i];
      if (c !== undefined && c(p)) return true;
    }
    return false;
  };
}

function not(cond: Condition): Condition {
  return (p) => !cond(p);
}

// --- State and transition builders ---

function makeState(
  id: string,
  m: Morpheme,
  opts?: { terminal?: boolean; derivative?: boolean; posRoot?: boolean },
): MorphemeState {
  return {
    id,
    morpheme: m,
    terminal: opts?.terminal ?? false,
    derivative: opts?.derivative ?? false,
    posRoot: opts?.posRoot ?? false,
    outgoing: [],
  };
}

function computeForbiddenPhonetic(template: string): number {
  if (template.length === 0) return 0;
  const lower = lowerTr(template);
  const first = lower[0] ?? "";
  const firstCharVowel = isVowel(first);
  let forbidden = 0;
  if (first === ">" || !firstCharVowel) {
    forbidden = PA_EXPECTS_VOWEL;
  }
  const third = lower[2];
  if ((first === "+" && third !== undefined && isVowel(third)) || firstCharVowel) {
    forbidden = PA_EXPECTS_CONSONANT;
  }
  return forbidden;
}

function addTransition(
  from: MorphemeState,
  to: MorphemeState,
  template: string,
  condition: Condition | null = null,
): void {
  const tokens = tokenizeTemplate(template);
  const transition: SuffixTransition = {
    from,
    to,
    template,
    tokens,
    lastToken: tokens.length > 0 ? tokens[tokens.length - 1] : undefined,
    hasSurface: tokens.length > 0,
    condition,
    forbiddenPhonetic: computeForbiddenPhonetic(template),
    surfaceCache: new Array<string | null | undefined>(SURFACE_CACHE_SIZE),
    nextPhoneticCache: new Int32Array(SURFACE_CACHE_SIZE),
  };
  from.outgoing.push(transition);
}

function addEmpty(from: MorphemeState, to: MorphemeState, condition: Condition | null = null): void {
  addTransition(from, to, "", condition);
}

function copyOutgoing(target: MorphemeState, source: MorphemeState): void {
  for (const t of source.outgoing) {
    target.outgoing.push({
      from: target,
      to: t.to,
      template: t.template,
      tokens: t.tokens,
      lastToken: t.lastToken,
      hasSurface: t.hasSurface,
      condition: t.condition,
      forbiddenPhonetic: t.forbiddenPhonetic,
      surfaceCache: t.surfaceCache,
      nextPhoneticCache: t.nextPhoneticCache,
    });
  }
}

function removeTransitionsToMorpheme(state: MorphemeState, m: Morpheme): void {
  for (let i = state.outgoing.length - 1; i >= 0; i--) {
    if (state.outgoing[i]?.to.morpheme === m) {
      state.outgoing.splice(i, 1);
    }
  }
}

// Non-nominalizable closed-class function adjectives: they can take copula (nasılsın, öyleydi)
// via adjZeroDeriv -> nVerb_S, but should NOT take arbitrary noun case/possessive inflection
// (*nasılda, *öylemi, *herde, *birkaçta).
const NON_NOMINALIZABLE_ADJ_LEMMAS = new Set([
  "nasıl",
  "öyle",
  "böyle",
  "şöyle",
  "her",
  "herhangi",
  "birkaç",
  "birçok",
  "birtakım",
  "bazı",
  "hiçbir",
  "tüm",
  "bütün",
]);

export interface MorphotacticsGraph {
  readonly noun_S: MorphemeState;
  readonly nounCompoundRoot_S: MorphemeState;
  readonly nounSuRoot_S: MorphemeState;
  readonly nounProper_S: MorphemeState;
  readonly nounAbbrv_S: MorphemeState;
  readonly nounNoSuffix_S: MorphemeState;
  readonly adjectiveRoot_ST: MorphemeState;
  readonly adjNoSuffix_ST: MorphemeState;
  readonly numeralRoot_ST: MorphemeState;
  readonly nVerbDegil_S: MorphemeState;
  readonly pronPers_S: MorphemeState;
  readonly pronPers_Mod_S: MorphemeState;
  readonly pronDemons_S: MorphemeState;
  readonly pronQuant_S: MorphemeState;
  readonly pronQuantModified_S: MorphemeState;
  readonly pronQues_S: MorphemeState;
  readonly pronReflex_S: MorphemeState;
  readonly advRoot_ST: MorphemeState;
  readonly advForVerbDeriv_ST: MorphemeState;
  readonly conjRoot_ST: MorphemeState;
  readonly interjRoot_ST: MorphemeState;
  readonly detRoot_ST: MorphemeState;
  readonly dupRoot_ST: MorphemeState;
  readonly postpRoot_ST: MorphemeState;
  readonly verbRoot_S: MorphemeState;
  readonly verbRoot_VowelDrop_S: MorphemeState;
  readonly verbLastVowelDropModRoot_S: MorphemeState;
  readonly verbLastVowelDropUnmodRoot_S: MorphemeState;
  readonly vImplicitRecipRoot_S: MorphemeState;
  readonly vImplicitReflexRoot_S: MorphemeState;
  readonly vDeYeRoot_S: MorphemeState;
  readonly questionRoot_S: MorphemeState;
  readonly imekRoot_S: MorphemeState;
  getRootState(item: DictionaryItem, phonetic: number): MorphemeState;
}

let cachedGraph: MorphotacticsGraph | null = null;

/**
 * Returns the shared immutable Turkish morphotactics graph (singleton).
 */
export function getMorphotacticsGraph(): MorphotacticsGraph {
  if (cachedGraph !== null) return cachedGraph;

  const M = MORPHEMES;

  // --- Noun states ---
  const noun_S = makeState("noun_S", M.noun, { posRoot: true });
  const nounCompoundRoot_S = makeState("nounCompoundRoot_S", M.noun, { posRoot: true });
  const nounSuRoot_S = makeState("nounSuRoot_S", M.noun, { posRoot: true });
  const nounInf1Root_S = makeState("nounInf1Root_S", M.noun, { posRoot: true });
  const nounActOfRoot_S = makeState("nounActOfRoot_S", M.noun, { posRoot: true });
  const nounProper_S = makeState("nounProper_S", M.noun, { posRoot: true });
  const nounAbbrv_S = makeState("nounAbbrv_S", M.noun, { posRoot: true });
  const nounNoSuffix_S = makeState("nounNoSuffix_S", M.noun, { posRoot: true });
  const nounA3sgNoSuffix_S = makeState("nounA3sgNoSuffix_S", M.a3sg);
  const nounPnonNoSuffix_S = makeState("nounPnonNoSuffix_S", M.pnon);
  const nounNomNoSuffix_ST = makeState("nounNomNoSuffix_ST", M.nom, { terminal: true });

  const a3sg_S = makeState("a3sg_S", M.a3sg);
  const a3sgSu_S = makeState("a3sgSu_S", M.a3sg);
  const a3sgCompound_S = makeState("a3sgCompound_S", M.a3sg);
  const a3sgInf1_S = makeState("a3sgInf1_S", M.a3sg);
  const a3sgActOf_S = makeState("a3sgActOf_S", M.a3sg);
  const a3pl_S = makeState("a3pl_S", M.a3pl);
  const a3plActOf_S = makeState("a3plActOf_S", M.a3pl);
  const a3plCompound_S = makeState("a3plCompound_S", M.a3pl);
  const a3plCompound2_S = makeState("a3plCompound2_S", M.a3pl);

  const pnon_S = makeState("pnon_S", M.pnon);
  const pnonCompound_S = makeState("pnonCompound_S", M.pnon);
  const pnonCompound2_S = makeState("pnonCompound2_S", M.pnon);
  const pnonInf1_S = makeState("pnonInf1_S", M.pnon);
  const pnonActOf_S = makeState("pnonActOf_S", M.pnon);
  const p1sg_S = makeState("p1sg_S", M.p1sg);
  const p2sg_S = makeState("p2sg_S", M.p2sg);
  const p3sg_S = makeState("p3sg_S", M.p3sg);
  const p1pl_S = makeState("p1pl_S", M.p1pl);
  const p2pl_S = makeState("p2pl_S", M.p2pl);
  const p3pl_S = makeState("p3pl_S", M.p3pl);

  const nom_ST = makeState("nom_ST", M.nom, { terminal: true });
  const nom_S = makeState("nom_S", M.nom);
  const dat_ST = makeState("dat_ST", M.dat, { terminal: true });
  const abl_ST = makeState("abl_ST", M.abl, { terminal: true });
  const loc_ST = makeState("loc_ST", M.loc, { terminal: true });
  const ins_ST = makeState("ins_ST", M.ins, { terminal: true });
  const acc_ST = makeState("acc_ST", M.acc, { terminal: true });
  const gen_ST = makeState("gen_ST", M.gen, { terminal: true });
  const equ_ST = makeState("equ_ST", M.equ, { terminal: true });

  const dim_S = makeState("dim_S", M.dim, { derivative: true });
  const ness_S = makeState("ness_S", M.ness, { derivative: true });
  const agt_S = makeState("agt_S", M.agt, { derivative: true });
  const dash_S = makeState("dash_S", M.dash, { derivative: true });
  const related_S = makeState("related_S", M.related, { derivative: true });
  const rel_S = makeState("rel_S", M.rel, { derivative: true });
  const relToPron_S = makeState("relToPron_S", M.rel, { derivative: true });
  const with_S = makeState("with_S", M.with, { derivative: true });
  const without_S = makeState("without_S", M.without, { derivative: true });
  const justLike_S = makeState("justLike_S", M.justLike, { derivative: true });
  const nounZeroDeriv_S = makeState("nounZeroDeriv_S", M.zero, { derivative: true });
  const become_S = makeState("become_S", M.become, { derivative: true });
  const acquire_S = makeState("acquire_S", M.acquire, { derivative: true });

  // --- Adjective states ---
  const adjectiveRoot_ST = makeState("adjectiveRoot_ST", M.adj, { terminal: true, posRoot: true });
  const adjNoSuffix_ST = makeState("adjNoSuffix_ST", M.adj, { terminal: true, posRoot: true });
  const adjAfterVerb_S = makeState("adjAfterVerb_S", M.adj, { posRoot: true });
  const adjAfterVerb_ST = makeState("adjAfterVerb_ST", M.adj, { terminal: true, posRoot: true });
  const adjZeroDeriv_S = makeState("adjZeroDeriv_S", M.zero, { derivative: true });

  const aPnon_ST = makeState("aPnon_ST", M.pnon, { terminal: true });
  const aP1sg_ST = makeState("aP1sg_ST", M.p1sg, { terminal: true });
  const aP2sg_ST = makeState("aP2sg_ST", M.p2sg, { terminal: true });
  const aP3sg_ST = makeState("aP3sg_ST", M.p3sg, { terminal: true });
  const aP1pl_ST = makeState("aP1pl_ST", M.p1pl, { terminal: true });
  const aP2pl_ST = makeState("aP2pl_ST", M.p2pl, { terminal: true });
  const aP3pl_ST = makeState("aP3pl_ST", M.p3pl, { terminal: true });

  const aLy_S = makeState("aLy_S", M.ly, { derivative: true });
  const aAsIf_S = makeState("aAsIf_S", M.asIf, { derivative: true });
  const aAgt_S = makeState("aAgt_S", M.agt, { derivative: true });

  const aorPartNegZero_S = makeState("aorPartNegZero_S", M.zero, { derivative: true });
  const aorPartNegNoun_S = makeState("aorPartNegNoun_S", M.noun, { posRoot: true });
  const aorPartNegA3sg_S = makeState("aorPartNegA3sg_S", M.a3sg);
  const aorPartNegPnon_S = makeState("aorPartNegPnon_S", M.pnon);
  const aorPartNegAbl_ST = makeState("aorPartNegAbl_ST", M.abl, { terminal: true });

  // --- Numeral states ---
  const numeralRoot_ST = makeState("numeralRoot_ST", M.num, { terminal: true, posRoot: true });
  const numZeroDeriv_S = makeState("numZeroDeriv_S", M.zero, { derivative: true });

  // --- Nominal predicate (ek-fiil) states ---
  const nVerb_S = makeState("nVerb_S", M.verb, { posRoot: true });
  const nVerbDegil_S = makeState("nVerbDegil_S", M.verb, { posRoot: true });
  const nPresent_S = makeState("nPresent_S", M.pres);
  const nPast_S = makeState("nPast_S", M.past);
  const nNarr_S = makeState("nNarr_S", M.narr);
  const nCond_S = makeState("nCond_S", M.cond);
  const nA1sg_ST = makeState("nA1sg_ST", M.a1sg, { terminal: true });
  const nA2sg_ST = makeState("nA2sg_ST", M.a2sg, { terminal: true });
  const nA1pl_ST = makeState("nA1pl_ST", M.a1pl, { terminal: true });
  const nA2pl_ST = makeState("nA2pl_ST", M.a2pl, { terminal: true });
  const nA3sg_ST = makeState("nA3sg_ST", M.a3sg, { terminal: true });
  const nA3sg_S = makeState("nA3sg_S", M.a3sg);
  const nA3pl_ST = makeState("nA3pl_ST", M.a3pl, { terminal: true });
  const nCop_ST = makeState("nCop_ST", M.cop, { terminal: true });
  const nCopBeforeA3pl_S = makeState("nCopBeforeA3pl_S", M.cop);
  const nNeg_S = makeState("nNeg_S", M.neg);

  // --- Pronoun states ---
  const pronPers_S = makeState("pronPers_S", M.pron, { posRoot: true });
  const pronPers_Mod_S = makeState("pronPers_Mod_S", M.pron, { posRoot: true });
  const pronDemons_S = makeState("pronDemons_S", M.pron, { posRoot: true });
  const pronQuant_S = makeState("pronQuant_S", M.pron, { posRoot: true });
  const pronQuantModified_S = makeState("pronQuantModified_S", M.pron, { posRoot: true });
  const pronQues_S = makeState("pronQues_S", M.pron, { posRoot: true });
  const pronReflex_S = makeState("pronReflex_S", M.pron, { posRoot: true });
  const pronAfterRel_S = makeState("pronAfterRel_S", M.pron, { posRoot: true });

  const pA1sg_S = makeState("pA1sg_S", M.a1sg);
  const pA2sg_S = makeState("pA2sg_S", M.a2sg);
  const pA1sgMod_S = makeState("pA1sgMod_S", M.a1sg);
  const pA2sgMod_S = makeState("pA2sgMod_S", M.a2sg);
  const pA3sg_S = makeState("pA3sg_S", M.a3sg);
  const pA3sgRel_S = makeState("pA3sgRel_S", M.a3sg);
  const pA1pl_S = makeState("pA1pl_S", M.a1pl);
  const pA2pl_S = makeState("pA2pl_S", M.a2pl);
  const pA3pl_S = makeState("pA3pl_S", M.a3pl);
  const pA3plRel_S = makeState("pA3plRel_S", M.a3pl);

  const pQuantA3sg_S = makeState("pQuantA3sg_S", M.a3sg);
  const pQuantA3pl_S = makeState("pQuantA3pl_S", M.a3pl);
  const pQuantModA3pl_S = makeState("pQuantModA3pl_S", M.a3pl);
  const pQuantA1pl_S = makeState("pQuantA1pl_S", M.a1pl);
  const pQuantA2pl_S = makeState("pQuantA2pl_S", M.a2pl);

  const pQuesA3sg_S = makeState("pQuesA3sg_S", M.a3sg);
  const pQuesA3pl_S = makeState("pQuesA3pl_S", M.a3pl);

  const pReflexA1sg_S = makeState("pReflexA1sg_S", M.a1sg);
  const pReflexA2sg_S = makeState("pReflexA2sg_S", M.a2sg);
  const pReflexA3sg_S = makeState("pReflexA3sg_S", M.a3sg);
  const pReflexA1pl_S = makeState("pReflexA1pl_S", M.a1pl);
  const pReflexA2pl_S = makeState("pReflexA2pl_S", M.a2pl);
  const pReflexA3pl_S = makeState("pReflexA3pl_S", M.a3pl);

  const pPnon_S = makeState("pPnon_S", M.pnon);
  const pPnonRel_S = makeState("pPnonRel_S", M.pnon);
  const pPnonMod_S = makeState("pPnonMod_S", M.pnon);
  const pP1sg_S = makeState("pP1sg_S", M.p1sg);
  const pP2sg_S = makeState("pP2sg_S", M.p2sg);
  const pP3sg_S = makeState("pP3sg_S", M.p3sg);
  const pP1pl_S = makeState("pP1pl_S", M.p1pl);
  const pP2pl_S = makeState("pP2pl_S", M.p2pl);
  const pP3pl_S = makeState("pP3pl_S", M.p3pl);

  const pNom_ST = makeState("pNom_ST", M.nom, { terminal: true });
  const pDat_ST = makeState("pDat_ST", M.dat, { terminal: true });
  const pAcc_ST = makeState("pAcc_ST", M.acc, { terminal: true });
  const pAbl_ST = makeState("pAbl_ST", M.abl, { terminal: true });
  const pLoc_ST = makeState("pLoc_ST", M.loc, { terminal: true });
  const pGen_ST = makeState("pGen_ST", M.gen, { terminal: true });
  const pIns_ST = makeState("pIns_ST", M.ins, { terminal: true });
  const pEqu_ST = makeState("pEqu_ST", M.equ, { terminal: true });
  const pronZeroDeriv_S = makeState("pronZeroDeriv_S", M.zero, { derivative: true });

  const pvVerbRoot_S = makeState("pvVerbRoot_S", M.verb, { posRoot: true });
  const pvPresent_S = makeState("pvPresent_S", M.pres);
  const pvPast_S = makeState("pvPast_S", M.past);
  const pvNarr_S = makeState("pvNarr_S", M.narr);
  const pvCond_S = makeState("pvCond_S", M.cond);
  const pvA1sg_ST = makeState("pvA1sg_ST", M.a1sg, { terminal: true });
  const pvA2sg_ST = makeState("pvA2sg_ST", M.a2sg, { terminal: true });
  const pvA3sg_ST = makeState("pvA3sg_ST", M.a3sg, { terminal: true });
  const pvA3sg_S = makeState("pvA3sg_S", M.a3sg);
  const pvA1pl_ST = makeState("pvA1pl_ST", M.a1pl, { terminal: true });
  const pvA2pl_ST = makeState("pvA2pl_ST", M.a2pl, { terminal: true });
  const pvA3pl_ST = makeState("pvA3pl_ST", M.a3pl, { terminal: true });
  const pvCopBeforeA3pl_S = makeState("pvCopBeforeA3pl_S", M.cop);
  const pvCop_ST = makeState("pvCop_ST", M.cop, { terminal: true });

  // --- Adverb / Closed class / Postpositive states ---
  const advRoot_ST = makeState("advRoot_ST", M.adv, { terminal: true, posRoot: true });
  const advNounRoot_ST = makeState("advNounRoot_ST", M.adv, { terminal: true, posRoot: true });
  const advForVerbDeriv_ST = makeState("advForVerbDeriv_ST", M.adv, { terminal: true, posRoot: true });
  const avNounAfterAdvRoot_S = makeState("avNounAfterAdvRoot_S", M.noun, { posRoot: true });
  const avA3sg_S = makeState("avA3sg_S", M.a3sg);
  const avPnon_S = makeState("avPnon_S", M.pnon);
  const avDat_ST = makeState("avDat_ST", M.dat, { terminal: true });
  const avZero_S = makeState("avZero_S", M.zero, { derivative: true });
  const avZeroToVerb_S = makeState("avZeroToVerb_S", M.zero, { derivative: true });

  const conjRoot_ST = makeState("conjRoot_ST", M.conj, { terminal: true, posRoot: true });
  const interjRoot_ST = makeState("interjRoot_ST", M.interj, { terminal: true, posRoot: true });
  const detRoot_ST = makeState("detRoot_ST", M.det, { terminal: true, posRoot: true });
  const dupRoot_ST = makeState("dupRoot_ST", M.dup, { terminal: true, posRoot: true });

  const postpRoot_ST = makeState("postpRoot_ST", M.postp, { terminal: true, posRoot: true });
  const postpZero_S = makeState("postpZero_S", M.zero, { derivative: true });
  const po2nRoot_S = makeState("po2nRoot_S", M.noun);
  const po2nA3sg_S = makeState("po2nA3sg_S", M.a3sg);
  const po2nA3pl_S = makeState("po2nA3pl_S", M.a3pl);
  const po2nP3sg_S = makeState("po2nP3sg_S", M.p3sg);
  const po2nP1sg_S = makeState("po2nP1sg_S", M.p1sg);
  const po2nP2sg_S = makeState("po2nP2sg_S", M.p2sg);
  const po2nP1pl_S = makeState("po2nP1pl_S", M.p1pl);
  const po2nP2pl_S = makeState("po2nP2pl_S", M.p2pl);
  const po2nPnon_S = makeState("po2nPnon_S", M.pnon);
  const po2nNom_ST = makeState("po2nNom_ST", M.nom, { terminal: true });
  const po2nDat_ST = makeState("po2nDat_ST", M.dat, { terminal: true });
  const po2nAbl_ST = makeState("po2nAbl_ST", M.abl, { terminal: true });
  const po2nLoc_ST = makeState("po2nLoc_ST", M.loc, { terminal: true });
  const po2nIns_ST = makeState("po2nIns_ST", M.ins, { terminal: true });
  const po2nAcc_ST = makeState("po2nAcc_ST", M.acc, { terminal: true });
  const po2nGen_ST = makeState("po2nGen_ST", M.gen, { terminal: true });
  const po2nEqu_ST = makeState("po2nEqu_ST", M.equ, { terminal: true });

  // --- Verb states ---
  const verbRoot_S = makeState("verbRoot_S", M.verb, { posRoot: true });
  const verbRoot_VowelDrop_S = makeState("verbRoot_VowelDrop_S", M.verb, { posRoot: true });
  const verbLastVowelDropModRoot_S = makeState("verbLastVowelDropModRoot_S", M.verb, { posRoot: true });
  const verbLastVowelDropUnmodRoot_S = makeState("verbLastVowelDropUnmodRoot_S", M.verb, { posRoot: true });
  const vDeYeRoot_S = makeState("vDeYeRoot_S", M.verb, { posRoot: true });

  const vA1sg_ST = makeState("vA1sg_ST", M.a1sg, { terminal: true });
  const vA2sg_ST = makeState("vA2sg_ST", M.a2sg, { terminal: true });
  const vA3sg_ST = makeState("vA3sg_ST", M.a3sg, { terminal: true });
  const vA1pl_ST = makeState("vA1pl_ST", M.a1pl, { terminal: true });
  const vA2pl_ST = makeState("vA2pl_ST", M.a2pl, { terminal: true });
  const vA3pl_ST = makeState("vA3pl_ST", M.a3pl, { terminal: true });

  const vPast_S = makeState("vPast_S", M.past);
  const vNarr_S = makeState("vNarr_S", M.narr);
  const vCond_S = makeState("vCond_S", M.cond);
  const vCondAfterPerson_ST = makeState("vCondAfterPerson_ST", M.cond, { terminal: true });
  const vPastAfterTense_S = makeState("vPastAfterTense_S", M.past);
  const vNarrAfterTense_S = makeState("vNarrAfterTense_S", M.narr);
  const vPastAfterTense_ST = makeState("vPastAfterTense_ST", M.past, { terminal: true });
  const vNarrAfterTense_ST = makeState("vNarrAfterTense_ST", M.narr, { terminal: true });
  const vCond_ST = makeState("vCond_ST", M.cond, { terminal: true });

  const vProgYor_S = makeState("vProgYor_S", M.prog1);
  const vProgMakta_S = makeState("vProgMakta_S", M.prog2);
  const vFut_S = makeState("vFut_S", M.fut);
  const vCop_ST = makeState("vCop_ST", M.cop, { terminal: true });
  const vCopBeforeA3pl_S = makeState("vCopBeforeA3pl_S", M.cop);

  const vNeg_S = makeState("vNeg_S", M.neg);
  const vUnable_S = makeState("vUnable_S", M.unable);
  const vNegProg1_S = makeState("vNegProg1_S", M.neg);
  const vUnableProg1_S = makeState("vUnableProg1_S", M.unable);

  const vImp_S = makeState("vImp_S", M.imp);
  const vImpYemekYi_S = makeState("vImpYemekYi_S", M.imp);
  const vImpYemekYe_S = makeState("vImpYemekYe_S", M.imp);

  const vCausT_S = makeState("vCausT_S", M.caus, { derivative: true });
  const vCausTır_S = makeState("vCausTır_S", M.caus, { derivative: true });
  const vRecip_S = makeState("vRecip_S", M.recip, { derivative: true });
  const vImplicitRecipRoot_S = makeState("vImplicitRecipRoot_S", M.verb, { posRoot: true });
  const vReflex_S = makeState("vReflex_S", M.reflex, { derivative: true });
  const vImplicitReflexRoot_S = makeState("vImplicitReflexRoot_S", M.verb, { posRoot: true });

  const vAor_S = makeState("vAor_S", M.aor);
  const vAorNeg_S = makeState("vAorNeg_S", M.aor);
  const vAorNegEmpty_S = makeState("vAorNegEmpty_S", M.aor);
  const vAorPartNeg_S = makeState("vAorPartNeg_S", M.aorPart, { derivative: true });
  const vAorPart_S = makeState("vAorPart_S", M.aorPart, { derivative: true });

  const vAble_S = makeState("vAble_S", M.able, { derivative: true });
  const vAbleNeg_S = makeState("vAbleNeg_S", M.able, { derivative: true });
  const vAbleNegDerivRoot_S = makeState("vAbleNegDerivRoot_S", M.verb, { posRoot: true });
  const vPass_S = makeState("vPass_S", M.pass, { derivative: true });

  const vOpt_S = makeState("vOpt_S", M.opt);
  const vDesr_S = makeState("vDesr_S", M.desr);
  const vNeces_S = makeState("vNeces_S", M.neces);

  const vInf1_S = makeState("vInf1_S", M.inf1, { derivative: true });
  const vInf2_S = makeState("vInf2_S", M.inf2, { derivative: true });
  const vInf3_S = makeState("vInf3_S", M.inf3, { derivative: true });
  const vAgt_S = makeState("vAgt_S", M.agt, { derivative: true });
  const vActOf_S = makeState("vActOf_S", M.actOf, { derivative: true });
  const vPastPart_S = makeState("vPastPart_S", M.pastPart, { derivative: true });
  const vFutPart_S = makeState("vFutPart_S", M.futPart, { derivative: true });
  const vPresPart_S = makeState("vPresPart_S", M.presPart, { derivative: true });
  const vNarrPart_S = makeState("vNarrPart_S", M.narrPart, { derivative: true });
  const vFeelLike_S = makeState("vFeelLike_S", M.feelLike, { derivative: true });
  const vNotState_S = makeState("vNotState_S", M.notState, { derivative: true });

  const vEverSince_S = makeState("vEverSince_S", M.everSince, { derivative: true });
  const vRepeat_S = makeState("vRepeat_S", M.repeat, { derivative: true });
  const vAlmost_S = makeState("vAlmost_S", M.almost, { derivative: true });
  const vHastily_S = makeState("vHastily_S", M.hastily, { derivative: true });
  const vStay_S = makeState("vStay_S", M.stay, { derivative: true });
  const vStart_S = makeState("vStart_S", M.start, { derivative: true });

  const vWhile_S = makeState("vWhile_S", M.while_, { derivative: true });
  const vWhen_S = makeState("vWhen_S", M.when, { derivative: true });
  const vAsIf_S = makeState("vAsIf_S", M.asIf, { derivative: true });
  const vSinceDoingSo_S = makeState("vSinceDoingSo_S", M.sinceDoingSo, { derivative: true });
  const vAsLongAs_S = makeState("vAsLongAs_S", M.asLongAs, { derivative: true });
  const vByDoingSo_S = makeState("vByDoingSo_S", M.byDoingSo, { derivative: true });
  const vAdamantly_S = makeState("vAdamantly_S", M.adamantly, { derivative: true });
  const vAfterDoing_S = makeState("vAfterDoing_S", M.afterDoingSo, { derivative: true });
  const vWithoutHavingDoneSo_S = makeState("vWithoutHavingDoneSo_S", M.withoutHavingDoneSo, { derivative: true });
  const vWithoutBeingAbleToHaveDoneSo_S = makeState(
    "vWithoutBeingAbleToHaveDoneSo_S",
    M.withoutBeingAbleToHaveDoneSo,
    { derivative: true },
  );

  // --- Standalone Question (mı/mi/mu/mü) states ---
  const questionRoot_S = makeState("questionRoot_S", M.ques, { posRoot: true });
  const qPresent_S = makeState("qPresent_S", M.pres);
  const qPast_S = makeState("qPast_S", M.past);
  const qNarr_S = makeState("qNarr_S", M.narr);
  const qA1sg_ST = makeState("qA1sg_ST", M.a1sg, { terminal: true });
  const qA2sg_ST = makeState("qA2sg_ST", M.a2sg, { terminal: true });
  const qA3sg_ST = makeState("qA3sg_ST", M.a3sg, { terminal: true });
  const qA1pl_ST = makeState("qA1pl_ST", M.a1pl, { terminal: true });
  const qA2pl_ST = makeState("qA2pl_ST", M.a2pl, { terminal: true });
  const qA3pl_ST = makeState("qA3pl_ST", M.a3pl, { terminal: true });
  const qCopBeforeA3pl_S = makeState("qCopBeforeA3pl_S", M.cop);
  const qCop_ST = makeState("qCop_ST", M.cop, { terminal: true });

  // --- Standalone Verb imek (idi, imiş, ise) states ---
  const imekRoot_S = makeState("imekRoot_S", M.verb, { posRoot: true });
  const imekPast_S = makeState("imekPast_S", M.past);
  const imekNarr_S = makeState("imekNarr_S", M.narr);
  const imekCond_S = makeState("imekCond_S", M.cond);
  const imekA1sg_ST = makeState("imekA1sg_ST", M.a1sg, { terminal: true });
  const imekA2sg_ST = makeState("imekA2sg_ST", M.a2sg, { terminal: true });
  const imekA3sg_ST = makeState("imekA3sg_ST", M.a3sg, { terminal: true });
  const imekA1pl_ST = makeState("imekA1pl_ST", M.a1pl, { terminal: true });
  const imekA2pl_ST = makeState("imekA2pl_ST", M.a2pl, { terminal: true });
  const imekA3pl_ST = makeState("imekA3pl_ST", M.a3pl, { terminal: true });
  const imekCop_ST = makeState("imekCop_ST", M.cop, { terminal: true });

  // =========================================================================
  // 1. Noun States
  // =========================================================================

  const isCompoundOrInsertN = hasAttr(RA_COMPOUND_P3SG | RA_NOUN_CONS_INSERT_N);
  const notCompoundOrInsertN = notHaveAttr(RA_COMPOUND_P3SG | RA_NOUN_CONS_INSERT_N);
  const rootIsAbbrv = secondaryPosIs("Abbreviation");
  const notFamily = notHaveAttr(RA_FAMILY_MEMBER);
  const possessionCond = and(notFamily, not(rootIsAbbrv));

  addEmpty(noun_S, a3sg_S, notHaveAttr(RA_IMPLICIT_PLURAL));
  addTransition(noun_S, a3pl_S, "lAr", and(notHaveAttr(RA_IMPLICIT_PLURAL), notHaveAttr(RA_COMPOUND_P3SG)));
  addEmpty(noun_S, a3pl_S, hasAttr(RA_IMPLICIT_PLURAL));

  // Compound P3sg roots (e.g. "zeytinyağ" from "zeytinyağı")
  addEmpty(nounCompoundRoot_S, a3sgCompound_S, hasAttr(RA_COMPOUND_P3SG_ROOT));
  addEmpty(a3sgCompound_S, pnonCompound_S);
  addTransition(a3sgCompound_S, p3pl_S, "lArI");

  const containsNess = containsMorpheme(M.ness);
  const notWithOrWithout = not(containsMorpheme(M.with, M.without));

  addEmpty(pnonCompound_S, nom_S);
  addTransition(nom_S, become_S, "lAş");
  addTransition(nom_S, acquire_S, "lAn");
  addTransition(nom_S, with_S, "lI", notWithOrWithout);
  addTransition(nom_S, without_S, "sIz", notWithOrWithout);
  addTransition(nom_S, ness_S, "lI~k", not(containsNess));
  addTransition(nom_S, ness_S, "lI!ğ", not(containsNess));
  addTransition(nom_S, agt_S, ">cI", not(containsMorpheme(M.agt)));
  addTransition(nom_S, dash_S, ">dAş", not(containsMorpheme(M.dash)));
  addTransition(nom_S, justLike_S, "+msI", not(containsMorpheme(M.justLike)));
  addTransition(nom_S, dim_S, ">cI~k", and(hasNoSurface, not(containsMorpheme(M.dim))));
  addTransition(nom_S, dim_S, ">cI!ğ", and(hasNoSurface, not(containsMorpheme(M.dim))));
  addTransition(nom_S, dim_S, "cAğIz", hasNoSurface);

  addTransition(nounCompoundRoot_S, a3plCompound_S, "lAr", hasAttr(RA_COMPOUND_P3SG_ROOT));
  addTransition(nounCompoundRoot_S, a3plCompound2_S, "lArI", hasAttr(RA_COMPOUND_P3SG_ROOT));
  addTransition(a3plCompound_S, p3sg_S, "I");
  addTransition(a3plCompound_S, p2sg_S, "In");
  addTransition(a3plCompound_S, p1sg_S, "Im");
  addTransition(a3plCompound_S, p1pl_S, "ImIz");
  addTransition(a3plCompound_S, p2pl_S, "InIz");
  addTransition(a3plCompound_S, p3pl_S, "I");
  addEmpty(a3plCompound2_S, pnonCompound2_S);
  addEmpty(pnonCompound2_S, nom_ST);

  // Regular A3sg -> Possessive
  addEmpty(a3sg_S, pnon_S, notFamily);
  addTransition(a3sg_S, p1sg_S, "Im", possessionCond);
  addTransition(a3sg_S, p2sg_S, "In", and(possessionCond, not(prevGroupContainsMorpheme(M.justLike))));
  addTransition(a3sg_S, p3sg_S, "+sI", and(possessionCond, notHaveAttr(RA_COMPOUND_P3SG)));
  addEmpty(a3sg_S, p3sg_S, hasAttr(RA_COMPOUND_P3SG));
  addTransition(a3sg_S, p1pl_S, "ImIz", possessionCond);
  addTransition(a3sg_S, p2pl_S, "InIz", and(possessionCond, not(prevGroupContainsMorpheme(M.justLike))));
  addTransition(a3sg_S, p3pl_S, "lArI", and(possessionCond, notHaveAttr(RA_COMPOUND_P3SG)));

  // Regular A3pl -> Possessive
  addEmpty(a3pl_S, pnon_S, notFamily);
  addTransition(a3pl_S, p1sg_S, "Im", possessionCond);
  addTransition(a3pl_S, p2sg_S, "In", possessionCond);
  addEmpty(a3pl_S, p1sg_S, hasAttr(RA_IMPLICIT_P1SG));
  addEmpty(a3pl_S, p2sg_S, hasAttr(RA_IMPLICIT_P2SG));
  addTransition(a3pl_S, p3sg_S, "I", possessionCond);
  addTransition(a3pl_S, p1pl_S, "ImIz", possessionCond);
  addTransition(a3pl_S, p2pl_S, "InIz", possessionCond);
  addTransition(a3pl_S, p3pl_S, "I", possessionCond);

  // Special "su" / "akarsu" roots
  addEmpty(nounSuRoot_S, a3sgSu_S);
  addTransition(nounSuRoot_S, a3pl_S, "lar");
  addEmpty(a3sgSu_S, pnon_S);
  addTransition(a3sgSu_S, p1sg_S, "yum");
  addTransition(a3sgSu_S, p2sg_S, "yun");
  addTransition(a3sgSu_S, p3sg_S, "yu");
  addTransition(a3sgSu_S, p1pl_S, "yumuz");
  addTransition(a3sgSu_S, p2pl_S, "yunuz");
  addTransition(a3sgSu_S, p3pl_S, "lArI");

  // Possessive -> Case
  const equCond = or(
    prevMorphemeIs(M.a3pl),
    not(containsMorpheme(M.adj, M.futPart, M.presPart, M.narrPart, M.pastPart)),
    containsMorphemeSeq(M.able, M.verb, M.pastPart),
  );
  const equWithPastPart = or(equCond, containsMorpheme(M.pastPart));

  addEmpty(pnon_S, nom_ST, notFamily);
  addTransition(pnon_S, dat_ST, "+yA", notCompoundOrInsertN);
  addTransition(pnon_S, abl_ST, ">dAn", notCompoundOrInsertN);
  // Prevent "daha + da" -> "*dahada" (clitic misspelling); "dahası" is lexicalized and "dahaki" uses nom_ST->rel_S.
  addTransition(pnon_S, loc_ST, ">dA", and(notCompoundOrInsertN, rootKeyIsNot("daha_Noun_Time")));
  addTransition(pnon_S, acc_ST, "+yI", notCompoundOrInsertN);
  addTransition(pnon_S, gen_ST, "+nIn", prevStateIsNot(a3sgSu_S));
  addTransition(pnon_S, gen_ST, "yIn", prevStateIs(a3sgSu_S));
  addTransition(pnon_S, equ_ST, ">cA", and(notCompoundOrInsertN, equCond));
  addTransition(pnon_S, ins_ST, "+ylA");

  addTransition(pnon_S, dat_ST, "+nA", isCompoundOrInsertN);
  addTransition(pnon_S, abl_ST, "+ndAn", isCompoundOrInsertN);
  addTransition(pnon_S, loc_ST, "+ndA", isCompoundOrInsertN);
  addTransition(pnon_S, equ_ST, "+ncA", and(isCompoundOrInsertN, equCond));
  addTransition(pnon_S, acc_ST, "+nI", isCompoundOrInsertN);
  addEmpty(pnon_S, dat_ST, hasAttr(RA_IMPLICIT_DATIVE));

  for (const ps of [p1sg_S, p2sg_S, p1pl_S, p2pl_S]) {
    addEmpty(ps, nom_ST);
    addTransition(ps, dat_ST, "A");
    addTransition(ps, loc_ST, "dA");
    addTransition(ps, abl_ST, "dAn");
    addTransition(ps, ins_ST, "lA");
    addTransition(ps, gen_ST, "In");
    addTransition(ps, equ_ST, "cA", equWithPastPart);
    addTransition(ps, acc_ST, "I");
  }

  addEmpty(p3sg_S, nom_ST);
  addTransition(p3sg_S, dat_ST, "nA");
  addTransition(p3sg_S, loc_ST, "ndA");
  addTransition(p3sg_S, abl_ST, "ndAn");
  addTransition(p3sg_S, ins_ST, "ylA");
  addTransition(p3sg_S, gen_ST, "nIn");
  addTransition(p3sg_S, equ_ST, "ncA", equWithPastPart);
  addTransition(p3sg_S, acc_ST, "nI");

  addEmpty(p3pl_S, nom_ST);
  addTransition(p3pl_S, dat_ST, "nA");
  addTransition(p3pl_S, loc_ST, "ndA");
  addTransition(p3pl_S, abl_ST, "ndAn");
  addTransition(p3pl_S, ins_ST, "ylA");
  addTransition(p3pl_S, gen_ST, "nIn");
  addTransition(p3pl_S, equ_ST, "+ncA");
  addTransition(p3pl_S, acc_ST, "nI");

  // Derivations from nom_ST
  const notAbbrv = not(rootIsAbbrv);
  const emptyAdjNounSeq = containsMorphemeSeq(M.adj, M.zero, M.noun, M.a3sg, M.pnon, M.nom);

  addTransition(nom_ST, dim_S, ">cI~k", and(hasNoSurface, notAbbrv));
  addTransition(nom_ST, dim_S, ">cI!ğ", and(hasNoSurface, notAbbrv));
  addTransition(nom_ST, dim_S, "cAğIz", and(hasNoSurface, notAbbrv));
  addEmpty(dim_S, noun_S);

  const nessCond = and(currentGroupEmpty, not(containsNess), not(emptyAdjNounSeq), notAbbrv);
  addTransition(nom_ST, ness_S, "lI~k", nessCond);
  addTransition(nom_ST, ness_S, "lI!ğ", nessCond);
  addEmpty(ness_S, noun_S);

  addTransition(nom_ST, agt_S, ">cI", and(currentGroupEmpty, not(containsMorpheme(M.adj, M.agt))));
  addEmpty(agt_S, noun_S);

  const verbDerivNoun = containsMorpheme(M.inf1, M.inf2, M.inf3, M.pastPart, M.futPart);
  addTransition(
    nom_ST,
    dash_S,
    ">dAş",
    and(
      currentGroupEmpty,
      not(containsMorpheme(M.dash, M.adj, M.with, M.without, M.ness, M.agt, M.dim)),
      not(verbDerivNoun),
      notAbbrv,
    ),
  );
  addEmpty(dash_S, noun_S);

  const noun2VerbCond = and(hasTail, not(and(currentGroupEmpty, lastDerivIs(adjZeroDeriv_S))));
  for (const cs of [nom_ST, dat_ST, abl_ST, loc_ST, ins_ST, gen_ST]) {
    addEmpty(cs, nounZeroDeriv_S, noun2VerbCond);
  }
  addEmpty(nounZeroDeriv_S, nVerb_S);

  addTransition(nom_ST, with_S, "lI", and(currentGroupEmpty, notWithOrWithout));
  addTransition(nom_ST, without_S, "sIz", and(currentGroupEmpty, not(containsMorpheme(M.with, M.without, M.inf1))));

  const justLikeCond = and(
    currentGroupEmpty,
    not(containsMorpheme(M.justLike, M.futPart, M.pastPart, M.presPart, M.adj)),
    notAbbrv,
  );
  addTransition(nom_ST, justLike_S, "+msI", justLikeCond);
  addTransition(nom_ST, justLike_S, "ImsI", and(notHavePhon(PA_LAST_VOWEL), justLikeCond));

  addTransition(
    nom_ST,
    related_S,
    "sAl",
    and(currentGroupEmpty, not(containsMorpheme(M.with, M.without, M.related)), notAbbrv),
  );

  addEmpty(with_S, adjectiveRoot_ST);
  addEmpty(without_S, adjectiveRoot_ST);
  addEmpty(related_S, adjectiveRoot_ST);
  addEmpty(justLike_S, adjectiveRoot_ST);

  // -ki (Rel)
  const notRelRepetition = not(hasTailSeq(M.rel, M.adj, M.zero, M.noun, M.a3sg, M.pnon, M.loc));
  addTransition(loc_ST, rel_S, "ki", notRelRepetition);
  addEmpty(rel_S, adjectiveRoot_ST);
  // Allow pronominal -ki after locative ("evdekini", "elindekine", "evdekinde", "evdekinden").
  addEmpty(rel_S, pronAfterRel_S, hasTail);

  const isTime = and(currentGroupEmpty, secondaryPosIs("Time"));
  const isDunGunBugun = rootKeyIn(["dün_Noun_Time", "gün_Noun_Time", "bugün_Noun_Time"]);
  const isDirKi = rootKeyIn(["ileri_Noun", "geri_Noun", "öte_Noun", "beri_Noun"]);
  addTransition(nom_ST, rel_S, "ki", and(isTime, not(isDunGunBugun)));
  addTransition(nom_ST, rel_S, "ki", and(currentGroupEmpty, isDirKi));
  addTransition(nom_ST, rel_S, "kü", and(isTime, isDunGunBugun));

  addTransition(gen_ST, relToPron_S, "ki");
  addEmpty(relToPron_S, pronAfterRel_S);

  const becomeAcquireCond = and(currentGroupEmpty, not(containsMorpheme(M.adj)), not(verbDerivNoun), notAbbrv);
  addTransition(nom_ST, become_S, "lAş", becomeAcquireCond);
  addEmpty(become_S, verbRoot_S);
  addTransition(nom_ST, acquire_S, "lAn", becomeAcquireCond);
  addEmpty(acquire_S, verbRoot_S);

  // Inf1 (-mAk) noun path
  addEmpty(nounInf1Root_S, a3sgInf1_S);
  addEmpty(a3sgInf1_S, pnonInf1_S);
  addEmpty(pnonInf1_S, nom_ST);
  addTransition(pnonInf1_S, abl_ST, "tAn");
  addTransition(pnonInf1_S, loc_ST, "tA");
  addTransition(pnonInf1_S, ins_ST, "lA");

  // ActOf (-mAcA) noun path
  addEmpty(nounActOfRoot_S, a3sgActOf_S);
  addTransition(nounActOfRoot_S, a3plActOf_S, "lar");
  addEmpty(a3sgActOf_S, pnonActOf_S);
  addEmpty(a3plActOf_S, pnonActOf_S);
  addEmpty(pnonActOf_S, nom_ST);

  // Proper nouns, abbreviations, and NoSuffix nouns
  addEmpty(nounProper_S, a3sg_S);
  addTransition(nounProper_S, a3pl_S, "lAr");
  addEmpty(nounAbbrv_S, a3sg_S);
  addTransition(nounAbbrv_S, a3pl_S, "lAr");
  addEmpty(nounNoSuffix_S, nounA3sgNoSuffix_S);
  addEmpty(nounA3sgNoSuffix_S, nounPnonNoSuffix_S);
  addEmpty(nounPnonNoSuffix_S, nounNomNoSuffix_ST);

  // =========================================================================
  // 2. Adjective States
  // =========================================================================

  const isNominalizableAdj: Condition = (p) =>
    !(p.stemTransition.item.primaryPos === "Adj" && NON_NOMINALIZABLE_ADJ_LEMMAS.has(p.stemTransition.item.root));

  addEmpty(adjectiveRoot_ST, adjZeroDeriv_S, hasTail);
  // After -ki (rel_S), nominal case/plural inflections go through pronAfterRel_S (evdekini, evdekiler),
  // preventing ungrammatical non-buffer forms like *evdekiyi, *evdekide.
  addEmpty(adjZeroDeriv_S, noun_S, and(isNominalizableAdj, not(hasTailSeq(M.rel, M.adj, M.zero))));
  addEmpty(adjZeroDeriv_S, nVerb_S);

  addTransition(adjectiveRoot_ST, aLy_S, ">cA");
  addEmpty(aLy_S, advRoot_ST);

  const notAdjDerivRepeat = not(containsMorpheme(M.asIf, M.ly, M.agt, M.with, M.justLike));
  addTransition(adjectiveRoot_ST, aAsIf_S, ">cA", notAdjDerivRepeat);
  addEmpty(aAsIf_S, adjectiveRoot_ST);

  addTransition(adjectiveRoot_ST, aAgt_S, ">cI", notAdjDerivRepeat);
  addEmpty(aAgt_S, noun_S);

  const adjJustLikeCond = and(currentGroupEmpty, not(containsMorpheme(M.justLike)));
  addTransition(adjectiveRoot_ST, justLike_S, "+msI", adjJustLikeCond);
  addTransition(adjectiveRoot_ST, justLike_S, "ImsI", and(notHavePhon(PA_LAST_VOWEL), adjJustLikeCond));

  addTransition(adjectiveRoot_ST, become_S, "lAş", currentGroupEmpty);
  addTransition(adjectiveRoot_ST, acquire_S, "lAn", currentGroupEmpty);

  const afterFutOrPastPart = prevMorphemeIn([M.futPart, M.pastPart]);
  addEmpty(adjAfterVerb_S, aPnon_ST, afterFutOrPastPart);
  addTransition(adjAfterVerb_S, aP1sg_ST, "Im", afterFutOrPastPart);
  addTransition(adjAfterVerb_S, aP2sg_ST, "In", afterFutOrPastPart);
  addTransition(adjAfterVerb_S, aP3sg_ST, "I", afterFutOrPastPart);
  addTransition(adjAfterVerb_S, aP1pl_ST, "ImIz", afterFutOrPastPart);
  addTransition(adjAfterVerb_S, aP2pl_ST, "InIz", afterFutOrPastPart);
  addTransition(adjAfterVerb_S, aP3pl_ST, "lArI", afterFutOrPastPart);

  addTransition(adjectiveRoot_ST, ness_S, "lI~k");
  addTransition(adjectiveRoot_ST, ness_S, "lI!ğ");

  addTransition(adjAfterVerb_ST, ness_S, "lI~k", prevMorphemeIs(M.aorPart));
  addTransition(adjAfterVerb_ST, ness_S, "lI!ğ", prevMorphemeIs(M.aorPart));

  // bilmezden, görmezden
  addEmpty(adjAfterVerb_ST, aorPartNegZero_S, prevStateIs(vAorPartNeg_S));
  addEmpty(aorPartNegZero_S, aorPartNegNoun_S);
  addEmpty(aorPartNegNoun_S, aorPartNegA3sg_S);
  addEmpty(aorPartNegA3sg_S, aorPartNegPnon_S);
  addTransition(aorPartNegPnon_S, aorPartNegAbl_ST, "dAn");

  // =========================================================================
  // 3. Numeral States
  // =========================================================================

  addTransition(numeralRoot_ST, ness_S, "lI~k");
  addTransition(numeralRoot_ST, ness_S, "lI!ğ");
  addEmpty(numeralRoot_ST, numZeroDeriv_S, hasTail);
  addEmpty(numZeroDeriv_S, noun_S);
  addEmpty(numZeroDeriv_S, nVerb_S);
  addTransition(numeralRoot_ST, justLike_S, "+msI", adjJustLikeCond);
  addTransition(numeralRoot_ST, justLike_S, "ImsI", and(notHavePhon(PA_LAST_VOWEL), adjJustLikeCond));

  // =========================================================================
  // 4. Nominal Predicate (Ek-Fiil) States
  // =========================================================================

  addEmpty(nVerb_S, nPresent_S);
  addTransition(nVerb_S, nPast_S, "+y>dI");
  addTransition(nVerb_S, nNarr_S, "+ymIş");
  addTransition(nVerb_S, nCond_S, "+ysA");
  addTransition(nVerb_S, vWhile_S, "+yken", not(hasTailSeq(M.narrPart, M.adj, M.zero, M.verb)));

  const isDegil = rootKeyIs("değil_Verb");
  addEmpty(nVerbDegil_S, nNeg_S, isDegil);
  copyOutgoing(nNeg_S, nVerb_S);

  const nVerbBlockedDeriv = or(
    containsMorpheme(M.inf1),
    and(
      containsMorpheme(M.inf2, M.inf3, M.pastPart, M.futPart, M.feelLike),
      not(prevGroupContains(loc_ST, abl_ST, ins_ST)),
    ),
  );
  const allowA1sg = and(notFamily, not(containsMorphemeSeq(M.p1sg, M.nom)), not(nVerbBlockedDeriv));
  const allowA2sg = and(notFamily, not(containsMorphemeSeq(M.p2sg, M.nom)), not(nVerbBlockedDeriv));
  const allowA3pl = and(
    notFamily,
    not(prevGroupContains(a3pl_S)),
    not(containsMorphemeSeq(M.p3pl, M.nom)),
    not(nVerbBlockedDeriv),
  );
  const allowA2pl = and(notFamily, not(containsMorphemeSeq(M.p2pl, M.nom)), not(nVerbBlockedDeriv));
  const allowA1pl = and(
    notFamily,
    not(containsMorphemeSeq(M.p1sg, M.nom)),
    not(containsMorphemeSeq(M.p1pl, M.nom)),
    not(nVerbBlockedDeriv),
  );

  addTransition(nPresent_S, nA1sg_ST, "+yIm", allowA1sg);
  addTransition(nPresent_S, nA2sg_ST, "sIn", allowA2sg);
  addEmpty(nPresent_S, nA3sg_S);
  addEmpty(nPresent_S, nA3sg_ST, isDegil);
  addTransition(
    nPresent_S,
    nA3pl_ST,
    "lAr",
    and(notHaveAttr(RA_COMPOUND_P3SG), not(prevGroupContainsMorpheme(M.inf1)), allowA3pl),
  );
  addTransition(nPresent_S, nA1pl_ST, "+yIz", allowA1pl);
  addTransition(nPresent_S, nA2pl_ST, "sInIz", allowA2pl);

  addTransition(nPast_S, nA1sg_ST, "m", allowA1sg);
  addTransition(nPast_S, nA2sg_ST, "n", allowA2sg);
  addTransition(nPast_S, nA1pl_ST, "k", allowA1pl);
  addTransition(nPast_S, nA2pl_ST, "InIz", allowA2pl);
  addTransition(nPast_S, nA3pl_ST, "lAr", and(notHaveAttr(RA_COMPOUND_P3SG), allowA3pl));
  addEmpty(nPast_S, nA3sg_ST);

  addTransition(nNarr_S, nA1sg_ST, "Im", allowA1sg);
  addTransition(nNarr_S, nA2sg_ST, "sIn", allowA2sg);
  addTransition(nNarr_S, nA1pl_ST, "Iz", allowA1pl);
  addTransition(nNarr_S, nA2pl_ST, "sInIz", allowA2pl);
  addTransition(nNarr_S, nA3pl_ST, "lAr", and(notHaveAttr(RA_COMPOUND_P3SG), allowA3pl));
  addEmpty(nNarr_S, nA3sg_ST);
  addTransition(nNarr_S, nCond_S, "sA");

  addTransition(nCond_S, nA1sg_ST, "m", allowA1sg);
  addTransition(nCond_S, nA2sg_ST, "n", allowA2sg);
  addTransition(nCond_S, nA1pl_ST, "k", allowA1pl);
  addTransition(nCond_S, nA2pl_ST, "nIz", allowA2pl);
  addEmpty(nCond_S, nA3sg_ST);
  addTransition(nCond_S, nA3pl_ST, "lAr");

  const nRejectNoCopula = not(currentGroupContains(nPast_S, nCond_S, nCopBeforeA3pl_S));
  addTransition(nA1sg_ST, nCop_ST, "dIr", nRejectNoCopula);
  addTransition(nA2sg_ST, nCop_ST, "dIr", nRejectNoCopula);
  addTransition(nA1pl_ST, nCop_ST, "dIr", nRejectNoCopula);
  addTransition(nA2pl_ST, nCop_ST, "dIr", nRejectNoCopula);
  addTransition(nA3sg_S, nCop_ST, ">dIr", nRejectNoCopula);
  addTransition(nA3pl_ST, nCop_ST, "dIr", nRejectNoCopula);

  const afterNarr = prevMorphemeIs(M.narr);
  for (const s of [nA3sg_ST, nA1sg_ST, nA2sg_ST, nA1pl_ST, nA2pl_ST, nA3pl_ST]) {
    addTransition(s, vAsIf_S, ">cAsInA", afterNarr);
  }

  const nA3plAfterCase = and(prevStateIs(nPresent_S), prevGroupContains(loc_ST, abl_ST, dat_ST, ins_ST));
  addTransition(nA3pl_ST, vPastAfterTense_ST, "dI", nA3plAfterCase);
  addTransition(nA3pl_ST, vNarrAfterTense_ST, "mIş", nA3plAfterCase);
  addTransition(nA3pl_ST, vCond_ST, "sA", nA3plAfterCase);
  addTransition(nA3pl_ST, vWhile_S, "ken", nA3plAfterCase);

  addTransition(nPresent_S, nCopBeforeA3pl_S, ">dIr");
  addTransition(nCopBeforeA3pl_S, nA3pl_ST, "lAr", and(notHaveAttr(RA_COMPOUND_P3SG), allowA3pl));

  // =========================================================================
  // 5. Pronoun States
  // =========================================================================

  const BEN = "ben_Pron_PersonalPron";
  const SEN = "sen_Pron_PersonalPron";
  const O_PERS = "o_Pron_PersonalPron";
  const BIZ = "biz_Pron_PersonalPron";
  const SIZ = "siz_Pron_PersonalPron";
  const FALAN = "falan_Pron_PersonalPron";
  const FALANCA = "falanca_Pron_PersonalPron";

  const BU = "bu_Pron_DemonstrativePron";
  const SU = "şu_Pron_DemonstrativePron";
  const O_DEMONS = "o_Pron_DemonstrativePron";

  const BIRBIRI = "birbiri_Pron_QuantitivePron";
  const BIRI = "biri_Pron_QuantitivePron";
  const BAZI = "bazı_Pron_QuantitivePron";
  const BIRCOGU = "birçoğu_Pron_QuantitivePron";
  const BIRKACI = "birkaçı_Pron_QuantitivePron";
  const BERIKI = "beriki_Pron_QuantitivePron";
  const COGU = "çoğu_Pron_QuantitivePron";
  const CUMLESI = "cümlesi_Pron_QuantitivePron";
  const HEP = "hep_Pron_QuantitivePron";
  const HERBIRI = "herbiri_Pron_QuantitivePron";
  const HERKES = "herkes_Pron_QuantitivePron";
  const HICBIRI = "hiçbiri_Pron_QuantitivePron";
  const HEPSI = "hepsi_Pron_QuantitivePron";
  const KIMI = "kimi_Pron_QuantitivePron";
  const KIMSE = "kimse_Pron_QuantitivePron";
  const OBURKU = "öbürkü_Pron_QuantitivePron";
  const OBURU = "öbürü_Pron_QuantitivePron";
  const TUMU = "tümü_Pron_QuantitivePron";
  const TOPU = "topu_Pron_QuantitivePron";
  const UMUM_QUANT = "umum_Pron_QuantitivePron";
  const UMUM_PLAIN = "umum_Pron";

  const NE = "ne_Pron_QuestionPron";
  const NERE = "nere_Pron_QuestionPron";
  const KIM = "kim_Pron_QuestionPron";
  const HANGI = "hangi_Pron_QuestionPron";
  const KENDI = "kendi_Pron_ReflexivePron";

  addEmpty(pronPers_S, pA1sg_S, rootKeyIs(BEN));
  addEmpty(pronPers_S, pA2sg_S, rootKeyIs(SEN));
  addEmpty(pronPers_S, pA3sg_S, rootKeyIn([O_PERS, FALAN, FALANCA]));
  addTransition(pronPers_S, pA3pl_S, "nlAr", rootKeyIs(O_PERS));
  addTransition(pronPers_S, pA3pl_S, "lAr", rootKeyIn([FALAN, FALANCA]));
  addEmpty(pronPers_S, pA1pl_S, rootKeyIs(BIZ));
  addTransition(pronPers_S, pA1pl_S, "lAr", rootKeyIs(BIZ));
  addEmpty(pronPers_S, pA2pl_S, rootKeyIs(SIZ));
  addTransition(pronPers_S, pA2pl_S, "lAr", rootKeyIs(SIZ));

  // Modified ben/sen -> ban-a, san-a
  addEmpty(pronPers_Mod_S, pA1sgMod_S, rootKeyIs(BEN));
  addEmpty(pronPers_Mod_S, pA2sgMod_S, rootKeyIs(SEN));
  addEmpty(pA1sgMod_S, pPnonMod_S);
  addEmpty(pA2sgMod_S, pPnonMod_S);
  addTransition(pPnonMod_S, pDat_ST, "A");

  for (const s of [pA1sg_S, pA2sg_S, pA3sg_S, pA1pl_S, pA2pl_S, pA3pl_S]) {
    addEmpty(s, pPnon_S);
  }

  // Noun -> Rel -> Pron (masanınki, evdekini, evdekiler)
  addEmpty(pronAfterRel_S, pA3sgRel_S);
  addTransition(pronAfterRel_S, pA3plRel_S, "lAr");
  addEmpty(pA3sgRel_S, pPnonRel_S);
  addEmpty(pA3plRel_S, pPnonRel_S);
  addEmpty(pPnonRel_S, pNom_ST);
  addTransition(pPnonRel_S, pDat_ST, "+nA");
  addTransition(pPnonRel_S, pAcc_ST, "+nI");
  addTransition(pPnonRel_S, pAbl_ST, "+ndAn");
  addTransition(pPnonRel_S, pLoc_ST, "+ndA");
  addTransition(pPnonRel_S, pIns_ST, "+ylA");
  addTransition(pPnonRel_S, pGen_ST, "+nIn");

  // Demonstrative pronouns (bu, şu, o)
  addEmpty(pronDemons_S, pA3sg_S);
  addTransition(pronDemons_S, pA3pl_S, "nlAr");

  // Quantitive pronouns
  addEmpty(
    pronQuant_S,
    pQuantA3sg_S,
    rootKeyNotIn([HERKES, UMUM_QUANT, UMUM_PLAIN, HEPSI, CUMLESI, HEP, TUMU, BIRKACI, TOPU]),
  );
  addTransition(
    pronQuant_S,
    pQuantA3pl_S,
    "lAr",
    rootKeyNotIn([HEP, HEPSI, BIRKACI, UMUM_QUANT, UMUM_PLAIN, CUMLESI, COGU, BIRCOGU, HERBIRI, TUMU, HICBIRI, TOPU, OBURU]),
  );
  addTransition(pronQuant_S, pQuantA1pl_S, "lAr", rootKeyIs(BAZI));
  addTransition(pronQuant_S, pQuantA2pl_S, "lAr", rootKeyIs(BAZI));
  addEmpty(
    pronQuant_S,
    pQuantA3pl_S,
    rootKeyIn([HERKES, UMUM_QUANT, UMUM_PLAIN, BIRKACI, HEPSI, CUMLESI, COGU, BIRCOGU, TUMU, TOPU]),
  );
  addEmpty(pronQuant_S, a3sg_S, rootKeyIs(KIMSE));
  addTransition(pronQuant_S, a3pl_S, "lAr", rootKeyIs(KIMSE));

  const quantPl12Roots = rootKeyIn([BIRI, BAZI, BIRBIRI, BIRKACI, HERBIRI, HEP, KIMI, COGU, BIRCOGU, TUMU, TOPU, HICBIRI]);
  addEmpty(pronQuant_S, pQuantA1pl_S, quantPl12Roots);
  addEmpty(pronQuant_S, pQuantA2pl_S, quantPl12Roots);

  addEmpty(pronQuantModified_S, pQuantModA3pl_S);
  addTransition(pQuantModA3pl_S, pP3pl_S, "lArI");

  const notModPron = notHavePhon(PA_MODIFIED_PRONOUN);
  const plainVowelPron = and(secondaryPosIs("None"), hasPhon(PA_LAST_VOWEL));
  addEmpty(
    pQuantA3sg_S,
    pP3sg_S,
    and(
      or(rootKeyIn([BIRI, BIRBIRI, KIMI, HERBIRI, HICBIRI, OBURU, OBURKU, BERIKI]), plainVowelPron),
      notModPron,
    ),
  );
  addTransition(
    pQuantA3sg_S,
    pP3sg_S,
    "sI",
    and(rootKeyIn([BIRI, BAZI, KIMI, BIRBIRI, HERBIRI, HICBIRI, OBURKU]), notModPron),
  );

  addTransition(pQuantA3pl_S, pP3pl_S, "I", rootKeyIn([BIRI, BAZI, BIRBIRI, KIMI, OBURKU, BERIKI]));
  addEmpty(pQuantA3pl_S, pP3pl_S, rootKeyIn([HEPSI, BIRKACI, CUMLESI, COGU, TUMU, TOPU, BIRCOGU]));
  addEmpty(pQuantA3pl_S, pPnon_S, rootKeyIn([HERKES, UMUM_QUANT, UMUM_PLAIN, OBURKU, BERIKI]));

  addTransition(pQuantA1pl_S, pP1pl_S, "ImIz");
  addTransition(pQuantA2pl_S, pP2pl_S, "InIz");

  // Question pronouns (kim, ne, nere, hangi)
  addEmpty(pronQues_S, pQuesA3sg_S);
  addTransition(pronQues_S, pQuesA3pl_S, "lAr");

  addEmpty(pQuesA3sg_S, pPnon_S);
  addTransition(pQuesA3sg_S, pP3sg_S, "+sI");
  addTransition(pQuesA3sg_S, pP1sg_S, "Im", rootKeyIsNot(NE));
  addTransition(pQuesA3sg_S, pP1sg_S, "yIm", rootKeyIs(NE));
  addTransition(pQuesA3sg_S, pP2sg_S, "In", rootKeyIsNot(NE));
  addTransition(pQuesA3sg_S, pP2sg_S, "yIn", rootKeyIs(NE));
  addTransition(pQuesA3sg_S, pP1pl_S, "ImIz", rootKeyIsNot(NE));
  addTransition(pQuesA3sg_S, pP1pl_S, "yImIz", rootKeyIs(NE));
  addTransition(pQuesA3sg_S, pP2pl_S, "InIz", rootKeyIsNot(NE));
  addTransition(pQuesA3sg_S, pP2pl_S, "yInIz", rootKeyIs(NE));

  addEmpty(pQuesA3pl_S, pPnon_S);
  addTransition(pQuesA3pl_S, pP3sg_S, "I");
  addTransition(pQuesA3pl_S, pP1sg_S, "Im");
  addTransition(pQuesA3pl_S, pP2sg_S, "In");
  addTransition(pQuesA3pl_S, pP1pl_S, "ImIz");
  addTransition(pQuesA3pl_S, pP2pl_S, "InIz");

  // Reflexive pronoun (kendi)
  addEmpty(pronReflex_S, pReflexA1sg_S);
  addEmpty(pronReflex_S, pReflexA2sg_S);
  addEmpty(pronReflex_S, pReflexA3sg_S);
  addEmpty(pronReflex_S, pReflexA1pl_S);
  addEmpty(pronReflex_S, pReflexA2pl_S);
  addEmpty(pronReflex_S, pReflexA3pl_S);

  addTransition(pReflexA1sg_S, pP1sg_S, "Im");
  addTransition(pReflexA2sg_S, pP2sg_S, "In");
  addTransition(pReflexA3sg_S, pP3sg_S, "+sI");
  addEmpty(pReflexA3sg_S, pP3sg_S);
  addTransition(pReflexA1pl_S, pP1pl_S, "ImIz");
  addTransition(pReflexA2pl_S, pP2pl_S, "InIz");
  addTransition(pReflexA3pl_S, pP3pl_S, "lArI");

  // Case transitions for pronouns
  const yKeys = [NE, NERE, FALAN, FALANCA, HEP, HERKES];
  const nGroup = rootKeyNotIn(yKeys);
  const yGroup = rootKeyIn(yKeys);

  addEmpty(pPnon_S, pNom_ST);
  addTransition(pPnon_S, pDat_ST, "+nA", rootKeyNotIn([BEN, SEN, NE, NERE, FALAN, FALANCA, HERKES]));
  addTransition(pPnon_S, pDat_ST, "+yA", yGroup);
  addTransition(pPnon_S, pAcc_ST, "+nI", nGroup);
  addTransition(pPnon_S, pAcc_ST, "+yI", yGroup);
  addTransition(pPnon_S, pLoc_ST, "+ndA", nGroup);
  addTransition(pPnon_S, pLoc_ST, ">dA", yGroup);
  addTransition(pPnon_S, pAbl_ST, "+ndAn", nGroup);
  addTransition(pPnon_S, pAbl_ST, ">dAn", yGroup);
  addTransition(pPnon_S, pGen_ST, "+nIn", and(nGroup, not(and(rootKeyIn([BIZ, BEN, SEN]), hasNoSurface))));
  addTransition(pPnon_S, pGen_ST, "im", and(rootKeyIn([BEN, BIZ]), hasNoSurface));
  addTransition(pPnon_S, pGen_ST, "in", and(rootKeyIs(SEN), hasNoSurface));
  addTransition(pPnon_S, pGen_ST, "+yIn", and(yGroup, rootKeyIsNot(BIZ)));
  addTransition(pPnon_S, pEqu_ST, ">cA");
  addTransition(pPnon_S, pIns_ST, "+ylA", yGroup);
  addTransition(pPnon_S, pIns_ST, "+nlA", nGroup);
  addTransition(pPnon_S, pIns_ST, "+nInlA", and(nGroup, rootKeyIn([BU, SU, O_PERS, O_DEMONS, SEN]), hasNoSurface));
  addTransition(pPnon_S, pIns_ST, "inle", and(rootKeyIs(SIZ), hasNoSurface));
  addTransition(pPnon_S, pIns_ST, "imle", and(rootKeyIn([BIZ, BEN]), hasNoSurface));

  const p1sgPronCond = rootKeyIn([KIM, BEN, NE, NERE, KENDI]);
  addEmpty(pP1sg_S, pNom_ST);
  addTransition(pP1sg_S, pDat_ST, "+nA", nGroup);
  addTransition(pP1sg_S, pAcc_ST, "+nI", nGroup);
  addTransition(pP1sg_S, pDat_ST, "+yA", yGroup);
  addTransition(pP1sg_S, pAcc_ST, "+yI", yGroup);
  addTransition(pP1sg_S, pLoc_ST, "+ndA", rootKeyIs(KENDI));
  addTransition(pP1sg_S, pAbl_ST, "+ndAn", rootKeyIs(KENDI));
  addTransition(pP1sg_S, pEqu_ST, "+ncA", rootKeyIs(KENDI));
  addTransition(pP1sg_S, pIns_ST, "+nlA", p1sgPronCond);
  addTransition(pP1sg_S, pGen_ST, "+nIn", p1sgPronCond);

  const p2sgPronCond = rootKeyIn([KIM, SEN, NE, NERE, KENDI]);
  addEmpty(pP2sg_S, pNom_ST);
  addTransition(pP2sg_S, pDat_ST, "+nA", nGroup);
  addTransition(pP2sg_S, pAcc_ST, "+nI", nGroup);
  addTransition(pP2sg_S, pDat_ST, "+yA", yGroup);
  addTransition(pP2sg_S, pAcc_ST, "+yI", yGroup);
  addTransition(pP2sg_S, pLoc_ST, "+ndA", rootKeyIs(KENDI));
  addTransition(pP2sg_S, pAbl_ST, "+ndAn", rootKeyIs(KENDI));
  addTransition(pP2sg_S, pEqu_ST, "+ncA", rootKeyIs(KENDI));
  addTransition(pP2sg_S, pIns_ST, "+nlA", p2sgPronCond);
  addTransition(pP2sg_S, pGen_ST, "+nIn", p2sgPronCond);

  const p3sgPronCond = or(
    rootKeyIn([KENDI, KIM, NE, NERE, O_PERS, BAZI, BIRI, BIRBIRI, HERBIRI, HEP, KIMI, HICBIRI, HANGI]),
    plainVowelPron,
  );
  addEmpty(pP3sg_S, pNom_ST);
  // After 3rd-person possessive (-sI/-I), all pronouns take buffer -n- (nesine, nesini, neresini, kendisine).
  addTransition(pP3sg_S, pDat_ST, "+nA");
  addTransition(pP3sg_S, pAcc_ST, "+nI");
  addTransition(pP3sg_S, pLoc_ST, "+ndA", p3sgPronCond);
  addTransition(pP3sg_S, pAbl_ST, "+ndAn", p3sgPronCond);
  addTransition(pP3sg_S, pGen_ST, "+nIn", p3sgPronCond);
  addTransition(pP3sg_S, pEqu_ST, "ncA", p3sgPronCond);
  addTransition(pP3sg_S, pIns_ST, "+ylA", p3sgPronCond);

  const hepCond = rootKeyIn([
    KENDI, KIM, NE, NERE, BIZ, SIZ, BIRI, BIRBIRI, BIRKACI, HERBIRI, HEP, KIMI, COGU, BIRCOGU,
    TUMU, TOPU, BAZI, HICBIRI, HANGI,
  ]);
  for (const ps of [pP1pl_S, pP2pl_S]) {
    addEmpty(ps, pNom_ST);
    addTransition(ps, pDat_ST, "+nA", nGroup);
    addTransition(ps, pAcc_ST, "+nI", nGroup);
    addTransition(ps, pDat_ST, "+yA", yGroup);
    addTransition(ps, pAcc_ST, "+yI", yGroup);
    addTransition(ps, pLoc_ST, "+ndA", hepCond);
    addTransition(ps, pAbl_ST, "+ndAn", hepCond);
    addTransition(ps, pGen_ST, "+nIn", hepCond);
    addTransition(ps, pEqu_ST, "+ncA", hepCond);
    addTransition(ps, pIns_ST, "+nlA", hepCond);
  }

  const hepsiCond = rootKeyIn([
    KENDI, KIM, NE, NERE, O_PERS, BAZI, BIRI, HERKES, UMUM_QUANT, UMUM_PLAIN, BIRKACI, HEPSI,
    CUMLESI, COGU, BIRCOGU, BIRBIRI, TUMU, KIMI, TOPU, HANGI,
  ]);
  addEmpty(pP3pl_S, pNom_ST);
  addTransition(pP3pl_S, pDat_ST, "+nA");
  addTransition(pP3pl_S, pAcc_ST, "+nI");
  addTransition(pP3pl_S, pLoc_ST, "+ndA", hepsiCond);
  addTransition(pP3pl_S, pAbl_ST, "+ndAn", hepsiCond);
  addTransition(pP3pl_S, pGen_ST, "+nIn", or(hepsiCond, rootKeyIn([SEN, SIZ])));
  addTransition(pP3pl_S, pEqu_ST, "+ncA", hepsiCond);
  addTransition(pP3pl_S, pIns_ST, "+ylA", hepsiCond);

  addTransition(pNom_ST, with_S, "+nlI", rootKeyIn([BU, SU, O_DEMONS, BEN, SEN, O_PERS, BIZ, SIZ]));
  addTransition(pNom_ST, with_S, "lI", rootKeyIs(NERE));
  addTransition(pNom_ST, with_S, "+ylI", rootKeyIs(NE));
  addTransition(pNom_ST, without_S, "+nsIz", rootKeyIn([NERE, BU, SU, O_DEMONS, BEN, SEN, O_PERS, BIZ, SIZ]));
  addTransition(pNom_ST, without_S, "+ysIz", rootKeyIs(NE));
  addTransition(pGen_ST, relToPron_S, "ki", rootKeyIn([NERE, BU, SU, O_DEMONS, NE, BEN, SEN, O_PERS, BIZ, SIZ, KIM, KENDI]));
  addTransition(pLoc_ST, rel_S, "ki", notRelRepetition);
  addTransition(pIns_ST, vWhile_S, "+yken");

  for (const ps of [pNom_ST, pDat_ST, pLoc_ST, pAbl_ST, pGen_ST, pIns_ST]) {
    addEmpty(ps, pronZeroDeriv_S, hasTail);
  }
  addEmpty(pronZeroDeriv_S, pvVerbRoot_S);

  // Verb after pronoun
  addEmpty(pvVerbRoot_S, pvPresent_S);
  addTransition(pvVerbRoot_S, vWhile_S, "+yken");
  addTransition(pvVerbRoot_S, pvPast_S, "+ydI");
  addTransition(pvVerbRoot_S, pvNarr_S, "+ymIş");
  addTransition(pvVerbRoot_S, pvCond_S, "+ysA");

  const pvAllowA1sg = not(prevGroupContains(pA1pl_S, pP1sg_S));
  const pvAllowA1pl = not(prevGroupContains(pA1sg_S, pA2sg_S, pP1sg_S, pP2sg_S));
  const pvAllowA2sg = not(prevGroupContains(pA2pl_S, pP2sg_S));
  const pvAllowA2pl = not(prevGroupContains(pA2sg_S, pP2pl_S));

  addTransition(pvPresent_S, pvA1sg_ST, "+yIm", pvAllowA1sg);
  addTransition(pvPresent_S, pvA2sg_ST, "sIn", pvAllowA2sg);
  addEmpty(pvPresent_S, pvA3sg_S);
  addTransition(pvPresent_S, pvA1pl_ST, "+yIz", pvAllowA1pl);
  addTransition(pvPresent_S, pvA2pl_ST, "sInIz");
  addTransition(pvPresent_S, pvA3pl_ST, "lAr", prevGroupContains(pLoc_ST));

  addTransition(pvPast_S, pvA1sg_ST, "m", pvAllowA1sg);
  addTransition(pvPast_S, pvA2sg_ST, "n", pvAllowA2sg);
  addTransition(pvPast_S, pvA1pl_ST, "k", pvAllowA1pl);
  addTransition(pvPast_S, pvA2pl_ST, "InIz");
  addTransition(pvPast_S, pvA3pl_ST, "lAr");
  addEmpty(pvPast_S, pvA3sg_ST);

  addTransition(pvNarr_S, pvA1sg_ST, "Im", pvAllowA1sg);
  addTransition(pvNarr_S, pvA2sg_ST, "sIn", pvAllowA2sg);
  addTransition(pvNarr_S, pvA1pl_ST, "Iz", pvAllowA1pl);
  addTransition(pvNarr_S, pvA2pl_ST, "sInIz");
  addTransition(pvNarr_S, pvA3pl_ST, "lAr");
  addEmpty(pvNarr_S, pvA3sg_ST);
  addTransition(pvNarr_S, pvCond_S, "sA");

  addTransition(pvCond_S, pvA1sg_ST, "m", pvAllowA1sg);
  addTransition(pvCond_S, pvA2sg_ST, "n", pvAllowA2sg);
  addTransition(pvCond_S, pvA1pl_ST, "k", pvAllowA1pl);
  addTransition(pvCond_S, pvA2pl_ST, "nIz", pvAllowA2pl);
  addEmpty(pvCond_S, pvA3sg_ST);
  addTransition(pvCond_S, pvA3pl_ST, "lAr");

  const pvRejectNoCopula = not(currentGroupContains(pvPast_S, pvCond_S, pvCopBeforeA3pl_S));
  addTransition(pvA1sg_ST, pvCop_ST, "dIr", pvRejectNoCopula);
  addTransition(pvA2sg_ST, pvCop_ST, "dIr", pvRejectNoCopula);
  addTransition(pvA1pl_ST, pvCop_ST, "dIr", pvRejectNoCopula);
  addTransition(pvA2pl_ST, pvCop_ST, "dIr", pvRejectNoCopula);
  addTransition(pvA3sg_S, pvCop_ST, ">dIr", pvRejectNoCopula);
  addTransition(pvA3pl_ST, pvCop_ST, "dIr", pvRejectNoCopula);

  const pvA3plAfterLoc = prevStateIs(pvPresent_S);
  addTransition(pvA3pl_ST, vPastAfterTense_ST, "dI", pvA3plAfterLoc);
  addTransition(pvA3pl_ST, vNarrAfterTense_ST, "mIş", pvA3plAfterLoc);
  addTransition(pvA3pl_ST, vCond_ST, "sA", pvA3plAfterLoc);
  addTransition(pvA3pl_ST, vWhile_S, "ken", pvA3plAfterLoc);

  addTransition(pvPresent_S, pvCopBeforeA3pl_S, ">dIr");
  addTransition(pvCopBeforeA3pl_S, pvA3pl_ST, "lAr");

  // =========================================================================
  // 6. Adverbs & Postpositives
  // =========================================================================

  addEmpty(advNounRoot_ST, avZero_S);
  addEmpty(avZero_S, avNounAfterAdvRoot_S);
  addEmpty(avNounAfterAdvRoot_S, avA3sg_S);
  addEmpty(avA3sg_S, avPnon_S);
  addTransition(avPnon_S, avDat_ST, "+yA");

  addEmpty(advForVerbDeriv_ST, avZeroToVerb_S);
  addEmpty(avZeroToVerb_S, nVerb_S);

  addEmpty(postpRoot_ST, postpZero_S, hasTail);
  addEmpty(postpZero_S, nVerb_S);

  const isGibi = rootKeyIn(["gibi_Postp_PCGen", "gibi_Postp_PCNom"]);
  const isGibiOrSonra = rootKeyIn(["gibi_Postp_PCGen", "gibi_Postp_PCNom", "sonra_Postp_PCAbl"]);
  addEmpty(postpZero_S, po2nRoot_S, isGibiOrSonra);
  addEmpty(po2nRoot_S, po2nA3sg_S);
  addTransition(po2nRoot_S, po2nA3pl_S, "lAr");

  addTransition(po2nA3sg_S, po2nP3sg_S, "+sI");
  addTransition(po2nA3sg_S, po2nP1sg_S, "m", isGibi);
  addTransition(po2nA3sg_S, po2nP2sg_S, "n", isGibi);
  addTransition(po2nA3sg_S, po2nP1pl_S, "miz", isGibi);
  addTransition(po2nA3sg_S, po2nP2pl_S, "niz", isGibi);

  addTransition(po2nA3pl_S, po2nP3sg_S, "+sI");
  addEmpty(po2nA3pl_S, po2nPnon_S);

  addEmpty(po2nP3sg_S, po2nNom_ST);
  addTransition(po2nP3sg_S, po2nDat_ST, "nA");
  addTransition(po2nP3sg_S, po2nLoc_ST, "ndA");
  addTransition(po2nP3sg_S, po2nAbl_ST, "ndAn");
  addTransition(po2nP3sg_S, po2nIns_ST, "ylA");
  addTransition(po2nP3sg_S, po2nGen_ST, "nIn");
  addTransition(po2nP3sg_S, po2nAcc_ST, "nI");

  addEmpty(po2nPnon_S, po2nNom_ST);
  addTransition(po2nPnon_S, po2nDat_ST, "A");
  addTransition(po2nPnon_S, po2nLoc_ST, "dA");
  addTransition(po2nPnon_S, po2nAbl_ST, "dAn");
  addTransition(po2nPnon_S, po2nIns_ST, "lA");
  addTransition(po2nPnon_S, po2nGen_ST, "In");
  addTransition(po2nPnon_S, po2nEqu_ST, "cA");
  addTransition(po2nPnon_S, po2nAcc_ST, "I");

  addTransition(po2nP1sg_S, po2nDat_ST, "e");
  addTransition(po2nP2sg_S, po2nDat_ST, "e");
  addTransition(po2nP1pl_S, po2nDat_ST, "e");
  addTransition(po2nP2pl_S, po2nDat_ST, "e");

  // =========================================================================
  // 7. Verbs
  // =========================================================================

  // Imperative
  addEmpty(verbRoot_S, vImp_S);
  addEmpty(vImp_S, vA2sg_ST);
  addTransition(vImp_S, vA2sg_ST, "sAnA");
  addTransition(vImp_S, vA3sg_ST, "sIn");
  addTransition(vImp_S, vA2pl_ST, "+yIn");
  addTransition(vImp_S, vA2pl_ST, "+yInIz");
  addTransition(vImp_S, vA2pl_ST, "sAnIzA");
  addTransition(vImp_S, vA3pl_ST, "sInlAr");

  // Causative (-t, ->dIr) with chaining (e.g. araştır-t, oku-t-tur, yap-tır-t)
  const noCausAfterCompound = not(
    lastDerivIn([vEverSince_S, vRepeat_S, vAlmost_S, vHastily_S, vStay_S, vStart_S]),
  );
  addTransition(
    verbRoot_S,
    vCausT_S,
    "t",
    and(
      or(hasAttr(RA_CAUSATIVE_T), lastDerivIs(vCausTır_S)),
      not(lastDerivIn([vCausT_S, vPass_S, vAble_S, become_S, acquire_S])),
      noCausAfterCompound,
    ),
  );
  addTransition(
    verbRoot_S,
    vCausTır_S,
    ">dIr",
    and(
      hasPhon(PA_LAST_CONSONANT),
      not(lastDerivIn([vCausTır_S, vPass_S, vAble_S])),
      noCausAfterCompound,
    ),
  );
  addEmpty(vCausT_S, verbRoot_S);
  addEmpty(vCausTır_S, verbRoot_S);

  // Progressive 1 (-Iyor)
  addTransition(verbRoot_S, vProgYor_S, "Iyor", notHavePhon(PA_LAST_VOWEL));
  addTransition(verbRoot_VowelDrop_S, vProgYor_S, "Iyor");
  addTransition(vProgYor_S, vA1sg_ST, "um");
  addTransition(vProgYor_S, vA2sg_ST, "sun");
  addEmpty(vProgYor_S, vA3sg_ST);
  addTransition(vProgYor_S, vA1pl_ST, "uz");
  addTransition(vProgYor_S, vA2pl_ST, "sunuz");
  addTransition(vProgYor_S, vA3pl_ST, "lar");
  addTransition(vProgYor_S, vCond_S, "sa");
  addTransition(vProgYor_S, vPastAfterTense_S, "du");
  addTransition(vProgYor_S, vNarrAfterTense_S, "muş");
  addTransition(vProgYor_S, vCopBeforeA3pl_S, "dur");
  addTransition(vProgYor_S, vWhile_S, "ken");

  // Progressive 2 (-mAktA)
  addTransition(verbRoot_S, vProgMakta_S, "mAktA");
  addTransition(vProgMakta_S, vA1sg_ST, "yIm");
  addTransition(vProgMakta_S, vA2sg_ST, "sIn");
  addEmpty(vProgMakta_S, vA3sg_ST);
  addTransition(vProgMakta_S, vA1pl_ST, "yIz");
  addTransition(vProgMakta_S, vA2pl_ST, "sInIz");
  addTransition(vProgMakta_S, vA3pl_ST, "lAr");
  addTransition(vProgMakta_S, vCond_S, "ysA");
  addTransition(vProgMakta_S, vPastAfterTense_S, "ydI");
  addTransition(vProgMakta_S, vNarrAfterTense_S, "ymIş");
  addTransition(vProgMakta_S, vCopBeforeA3pl_S, "dIr");
  addTransition(vProgMakta_S, vWhile_S, "yken");

  // Positive Aorist (-Ir / -Ar)
  const aorICond = or(hasAttr(RA_AORIST_I), hasSurface);
  const aorACond = and(hasAttr(RA_AORIST_A), hasNoSurface);
  addTransition(verbRoot_S, vAor_S, "Ir", aorICond);
  addTransition(verbRoot_S, vAor_S, "Ar", aorACond);
  addTransition(vAor_S, vA1sg_ST, "Im");
  addTransition(vAor_S, vA2sg_ST, "sIn");
  addEmpty(vAor_S, vA3sg_ST);
  addTransition(vAor_S, vA1pl_ST, "Iz");
  addTransition(vAor_S, vA2pl_ST, "sInIz");
  addTransition(vAor_S, vA3pl_ST, "lAr");
  addTransition(vAor_S, vPastAfterTense_S, "dI");
  addTransition(vAor_S, vNarrAfterTense_S, "mIş");
  addTransition(vAor_S, vCond_S, "sA");
  addTransition(vAor_S, vCopBeforeA3pl_S, "dIr");
  addTransition(vAor_S, vWhile_S, "ken");

  // Negative (-mA)
  addTransition(verbRoot_S, vNeg_S, "mA", prevMorphemeIsNot(M.able));
  addEmpty(vNeg_S, vImp_S);
  addTransition(vNeg_S, vPast_S, "dI");
  addTransition(vNeg_S, vFut_S, "yAcA~k");
  addTransition(vNeg_S, vFut_S, "yAcA!ğ");
  addTransition(vNeg_S, vNarr_S, "mIş");
  addTransition(vNeg_S, vProgMakta_S, "mAktA");
  addTransition(vNeg_S, vOpt_S, "yA");
  addTransition(vNeg_S, vDesr_S, "sA");
  addTransition(vNeg_S, vNeces_S, "mAlI");
  addTransition(vNeg_S, vInf1_S, "mAk");
  addTransition(vNeg_S, vInf2_S, "mA");
  addTransition(vNeg_S, vInf3_S, "yIş");
  addTransition(vNeg_S, vActOf_S, "mAcA");
  addTransition(vNeg_S, vPastPart_S, "dI~k");
  addTransition(vNeg_S, vPastPart_S, "dI!ğ");
  addTransition(vNeg_S, vFutPart_S, "yAcA~k");
  addTransition(vNeg_S, vFutPart_S, "yAcA!ğ");
  addTransition(vNeg_S, vPresPart_S, "yAn");
  addTransition(vNeg_S, vNarrPart_S, "mIş");
  addTransition(vNeg_S, vSinceDoingSo_S, "yAlI");
  addTransition(vNeg_S, vByDoingSo_S, "yArAk");
  addTransition(vNeg_S, vHastily_S, "yIver");
  addTransition(vNeg_S, vEverSince_S, "yAgör");
  addTransition(vNeg_S, vAfterDoing_S, "yIp");
  addTransition(vNeg_S, vWhen_S, "yIncA");
  addTransition(vNeg_S, vAsLongAs_S, "dIkçA");
  addTransition(vNeg_S, vNotState_S, "mAzlI~k");
  addTransition(vNeg_S, vNotState_S, "mAzlI!ğ");
  addTransition(vNeg_S, vFeelLike_S, "yAsI");
  addTransition(vNeg_S, vAorNeg_S, "z");
  addEmpty(vNeg_S, vAorNegEmpty_S);
  addTransition(vNeg_S, vAorPartNeg_S, "z");
  addTransition(vNeg_S, vAble_S, "yAbil");

  // Negative before -Iyor (-m + Iyor)
  addTransition(verbRoot_S, vNegProg1_S, "m");
  addTransition(vNegProg1_S, vProgYor_S, "Iyor");

  // Negative Aorist
  addTransition(vAorNeg_S, vA2sg_ST, "sIn");
  addEmpty(vAorNeg_S, vA3sg_ST);
  addTransition(vAorNeg_S, vA2pl_ST, "sInIz");
  addTransition(vAorNeg_S, vA3pl_ST, "lAr");
  addTransition(vAorNeg_S, vPastAfterTense_S, "dI");
  addTransition(vAorNeg_S, vNarrAfterTense_S, "mIş");
  addTransition(vAorNeg_S, vCond_S, "sA");
  addTransition(vAorNeg_S, vCopBeforeA3pl_S, "dIr");
  addTransition(vAorNeg_S, vWhile_S, "ken");

  addTransition(vAorNegEmpty_S, vA1sg_ST, "m");
  addTransition(vAorNegEmpty_S, vA1pl_ST, "yIz");
  addEmpty(vAorPartNeg_S, adjAfterVerb_ST);

  // Ability (+yAbil) & Unable (+yAmA, +yAm)
  addTransition(verbRoot_S, vAble_S, "+yAbil", not(lastDerivIs(vAble_S)));
  addEmpty(vAble_S, verbRoot_S);

  addEmpty(vAbleNeg_S, vAbleNegDerivRoot_S);
  addTransition(vAbleNegDerivRoot_S, vNeg_S, "mA");
  addTransition(vAbleNegDerivRoot_S, vNegProg1_S, "m");

  addTransition(verbRoot_S, vUnable_S, "+yAmA", prevMorphemeIsNot(M.able));
  copyOutgoing(vUnable_S, vNeg_S);
  addTransition(verbRoot_S, vUnableProg1_S, "+yAm");
  addTransition(vUnableProg1_S, vProgYor_S, "Iyor");

  // Verbal nouns, participles, and adjectives
  addTransition(verbRoot_S, vInf1_S, "mA~k");
  addEmpty(vInf1_S, nounInf1Root_S);

  addTransition(verbRoot_S, vInf2_S, "mA");
  addEmpty(vInf2_S, noun_S);

  addTransition(verbRoot_S, vInf3_S, "+yIş");
  addEmpty(vInf3_S, noun_S);

  addTransition(verbRoot_S, vAgt_S, "+yIcI");
  addEmpty(vAgt_S, noun_S);
  addEmpty(vAgt_S, adjAfterVerb_ST);

  addTransition(verbRoot_S, vActOf_S, "mAcA");
  addEmpty(vActOf_S, nounActOfRoot_S);

  addTransition(verbRoot_S, vPastPart_S, ">dI~k");
  addTransition(verbRoot_S, vPastPart_S, ">dI!ğ");
  addEmpty(vPastPart_S, noun_S);
  addEmpty(vPastPart_S, adjAfterVerb_S);

  addTransition(verbRoot_S, vFutPart_S, "+yAcA~k");
  addTransition(verbRoot_S, vFutPart_S, "+yAcA!ğ");
  addEmpty(vFutPart_S, noun_S, hasTail);
  addEmpty(vFutPart_S, adjAfterVerb_S);

  addTransition(verbRoot_S, vNarrPart_S, "mIş");
  addEmpty(vNarrPart_S, adjectiveRoot_ST);

  addTransition(verbRoot_S, vAorPart_S, "Ir", aorICond);
  addTransition(verbRoot_S, vAorPart_S, "Ar", aorACond);
  addEmpty(vAorPart_S, adjAfterVerb_ST);

  addTransition(verbRoot_S, vPresPart_S, "+yAn");
  addEmpty(vPresPart_S, noun_S, hasTail);
  addEmpty(vPresPart_S, adjAfterVerb_ST);

  addTransition(verbRoot_S, vFeelLike_S, "+yAsI");
  addEmpty(vFeelLike_S, noun_S, hasTail);
  addEmpty(vFeelLike_S, adjAfterVerb_ST);

  addTransition(verbRoot_S, vNotState_S, "mAzlI~k");
  addTransition(verbRoot_S, vNotState_S, "mAzlI!ğ");
  addEmpty(vNotState_S, noun_S);

  // Implicit Reciprocal & Reflexive
  addEmpty(vImplicitRecipRoot_S, vRecip_S);
  addEmpty(vRecip_S, verbRoot_S);
  addEmpty(vImplicitReflexRoot_S, vReflex_S);
  addEmpty(vReflex_S, verbRoot_S);

  // Passive (-In, -InIl, +nIl)
  const notPassOrAble = and(not(containsMorpheme(M.pass)), not(containsMorpheme(M.able)));
  const prevIsCaus = prevStateIn([vCausT_S, vCausTır_S]);
  const notAfterDerivStem = not(
    prevStateIn([vCausT_S, vCausTır_S, vEverSince_S, vRepeat_S, vAlmost_S, vHastily_S, vStay_S, vStart_S]),
  );
  addTransition(verbRoot_S, vPass_S, "In", and(hasAttr(RA_PASSIVE_IN), notPassOrAble, notAfterDerivStem));
  addTransition(verbRoot_S, vPass_S, "InIl", and(hasAttr(RA_PASSIVE_IN), notPassOrAble, notAfterDerivStem));
  addTransition(
    verbRoot_S,
    vPass_S,
    "+nIl",
    and(
      not(containsMorpheme(M.able)),
      or(prevIsCaus, and(notHaveAttr(RA_PASSIVE_IN), not(containsMorpheme(M.pass)))),
    ),
  );
  addEmpty(vPass_S, verbRoot_S);

  // Condition (-sA)
  addTransition(vCond_S, vA1sg_ST, "m");
  addTransition(vCond_S, vA2sg_ST, "n");
  addEmpty(vCond_S, vA3sg_ST);
  addTransition(vCond_S, vA1pl_ST, "k");
  addTransition(vCond_S, vA2pl_ST, "nIz");
  addTransition(vCond_S, vA3pl_ST, "lAr");

  // Past (>dI)
  addTransition(verbRoot_S, vPast_S, ">dI");
  addTransition(vPast_S, vA1sg_ST, "m");
  addTransition(vPast_S, vA2sg_ST, "n");
  addEmpty(vPast_S, vA3sg_ST);
  addTransition(vPast_S, vA1pl_ST, "k");
  addTransition(vPast_S, vA2pl_ST, "nIz");
  addTransition(vPast_S, vA3pl_ST, "lAr");
  addTransition(vPast_S, vCond_S, "ysA");

  // Narrative (-mIş)
  addTransition(verbRoot_S, vNarr_S, "mIş");
  addTransition(vNarr_S, vA1sg_ST, "Im");
  addTransition(vNarr_S, vA2sg_ST, "sIn");
  addEmpty(vNarr_S, vA3sg_ST);
  addTransition(vNarr_S, vA1pl_ST, "Iz");
  addTransition(vNarr_S, vA2pl_ST, "sInIz");
  addTransition(vNarr_S, vA3pl_ST, "lAr");
  addTransition(vNarr_S, vCond_S, "sA");
  addTransition(vNarr_S, vPastAfterTense_S, "tI");
  addTransition(vNarr_S, vCopBeforeA3pl_S, "tIr");
  addTransition(vNarr_S, vWhile_S, "ken");
  addTransition(vNarr_S, vNarrAfterTense_S, "mIş");

  // Past after tense
  addTransition(vPastAfterTense_S, vA1sg_ST, "m");
  addTransition(vPastAfterTense_S, vA2sg_ST, "n");
  addEmpty(vPastAfterTense_S, vA3sg_ST);
  addTransition(vPastAfterTense_S, vA1pl_ST, "k");
  addTransition(vPastAfterTense_S, vA2pl_ST, "nIz");
  addTransition(vPastAfterTense_S, vA3pl_ST, "lAr");

  // Narrative after tense
  addTransition(vNarrAfterTense_S, vA1sg_ST, "Im");
  addTransition(vNarrAfterTense_S, vA2sg_ST, "sIn");
  addEmpty(vNarrAfterTense_S, vA3sg_ST);
  addTransition(vNarrAfterTense_S, vA1pl_ST, "Iz");
  addTransition(vNarrAfterTense_S, vA2pl_ST, "sInIz");
  addTransition(vNarrAfterTense_S, vA3pl_ST, "lAr");
  addTransition(vNarrAfterTense_S, vWhile_S, "ken");
  addTransition(vNarrAfterTense_S, vCopBeforeA3pl_S, "tIr");

  // Future (+yAcA~k, +yAcA!ğ)
  addTransition(verbRoot_S, vFut_S, "+yAcA~k");
  addTransition(verbRoot_S, vFut_S, "+yAcA!ğ");
  addTransition(vFut_S, vA1sg_ST, "Im");
  addTransition(vFut_S, vA2sg_ST, "sIn");
  addEmpty(vFut_S, vA3sg_ST);
  addTransition(vFut_S, vA1pl_ST, "Iz");
  addTransition(vFut_S, vA2pl_ST, "sInIz");
  addTransition(vFut_S, vA3pl_ST, "lAr");
  addTransition(vFut_S, vCond_S, "sA");
  addTransition(vFut_S, vPastAfterTense_S, "tI");
  addTransition(vFut_S, vNarrAfterTense_S, "mIş");
  addTransition(vFut_S, vCopBeforeA3pl_S, "tIr");
  addTransition(vFut_S, vWhile_S, "ken");

  // Special irregular verbs: demek / yemek (de/di, ye/yi)
  const diYiCond = rootSurfaceIn(["di", "yi"]);
  const deYeCond = rootSurfaceIn(["de", "ye"]);
  const cMultiVerb = not(prevMorphemeIn([M.everSince, M.repeat, M.almost, M.hastily, M.stay, M.start]));

  addTransition(vDeYeRoot_S, vFut_S, "yece~k", diYiCond);
  addTransition(vDeYeRoot_S, vFut_S, "yece!ğ", diYiCond);
  addTransition(vDeYeRoot_S, vProgYor_S, "yor", diYiCond);
  addTransition(vDeYeRoot_S, vAble_S, "yebil", diYiCond);
  addTransition(vDeYeRoot_S, vAbleNeg_S, "ye", diYiCond);
  addTransition(vDeYeRoot_S, vInf3_S, "yiş", rootSurfaceIs("yi"));
  addTransition(vDeYeRoot_S, vFutPart_S, "yece~k", diYiCond);
  addTransition(vDeYeRoot_S, vFutPart_S, "yece!ğ", diYiCond);
  addTransition(vDeYeRoot_S, vPresPart_S, "yen", diYiCond);
  addTransition(vDeYeRoot_S, vEverSince_S, "yegel", and(diYiCond, cMultiVerb));
  addTransition(vDeYeRoot_S, vRepeat_S, "yedur", and(diYiCond, cMultiVerb));
  addTransition(vDeYeRoot_S, vRepeat_S, "yegör", and(diYiCond, cMultiVerb));
  addTransition(vDeYeRoot_S, vAlmost_S, "yeyaz", and(diYiCond, cMultiVerb));
  addTransition(vDeYeRoot_S, vStart_S, "yekoy", and(diYiCond, cMultiVerb));
  addTransition(vDeYeRoot_S, vHastily_S, "yiver", and(diYiCond, cMultiVerb));
  addTransition(vDeYeRoot_S, vSinceDoingSo_S, "yeli", diYiCond);
  addTransition(vDeYeRoot_S, vByDoingSo_S, "yerek", diYiCond);
  addTransition(vDeYeRoot_S, vFeelLike_S, "yesi", diYiCond);
  addTransition(vDeYeRoot_S, vAfterDoing_S, "yip", rootSurfaceIn(["de", "yi"]));
  addTransition(vDeYeRoot_S, vWhen_S, "yince", rootSurfaceIn(["de", "yi"]));
  addTransition(vDeYeRoot_S, vWithoutBeingAbleToHaveDoneSo_S, "yemeden", diYiCond);
  addTransition(vDeYeRoot_S, vOpt_S, "ye", diYiCond);

  addTransition(vDeYeRoot_S, vCausTır_S, "dir", deYeCond);
  addTransition(vDeYeRoot_S, vPass_S, "n", deYeCond);
  addTransition(vDeYeRoot_S, vPass_S, "nil", deYeCond);
  addTransition(vDeYeRoot_S, vPast_S, "di", deYeCond);
  addTransition(vDeYeRoot_S, vNarr_S, "miş", deYeCond);
  addTransition(vDeYeRoot_S, vAor_S, "r", deYeCond);
  addTransition(vDeYeRoot_S, vNeg_S, "me", deYeCond);
  addTransition(vDeYeRoot_S, vNegProg1_S, "m", deYeCond);
  addTransition(vDeYeRoot_S, vProgMakta_S, "mekte", deYeCond);
  addTransition(vDeYeRoot_S, vDesr_S, "se", deYeCond);
  addTransition(vDeYeRoot_S, vInf1_S, "mek", deYeCond);
  addTransition(vDeYeRoot_S, vInf2_S, "me", deYeCond);
  addTransition(vDeYeRoot_S, vInf3_S, "yiş", rootSurfaceIs("de"));
  addTransition(vDeYeRoot_S, vPastPart_S, "di~k", deYeCond);
  addTransition(vDeYeRoot_S, vPastPart_S, "di!ğ", deYeCond);
  addTransition(vDeYeRoot_S, vNarrPart_S, "miş", deYeCond);
  addTransition(vDeYeRoot_S, vAsLongAs_S, "dikçe", deYeCond);
  addTransition(vDeYeRoot_S, vWithoutHavingDoneSo_S, "meden", deYeCond);
  addTransition(vDeYeRoot_S, vWithoutHavingDoneSo_S, "meksizin", deYeCond);
  addTransition(vDeYeRoot_S, vNeces_S, "meli", deYeCond);
  addTransition(vDeYeRoot_S, vNotState_S, "mezli~k", deYeCond);
  addTransition(vDeYeRoot_S, vNotState_S, "mezli!ğ", deYeCond);
  addEmpty(vDeYeRoot_S, vImp_S, rootSurfaceIs("de"));
  addEmpty(vDeYeRoot_S, vImpYemekYe_S, rootSurfaceIs("ye"));
  addEmpty(vDeYeRoot_S, vImpYemekYi_S, rootSurfaceIs("yi"));

  addTransition(vImpYemekYi_S, vA2pl_ST, "yin");
  addTransition(vImpYemekYi_S, vA2pl_ST, "yiniz");
  addEmpty(vImpYemekYe_S, vA2sg_ST);
  addTransition(vImpYemekYe_S, vA2sg_ST, "sene");
  addTransition(vImpYemekYe_S, vA3sg_ST, "sin");
  addTransition(vImpYemekYe_S, vA2pl_ST, "senize");
  addTransition(vImpYemekYe_S, vA3pl_ST, "sinler");

  // Optative (+yA)
  addTransition(verbRoot_S, vOpt_S, "+yA");
  addTransition(vOpt_S, vA1sg_ST, "yIm");
  addTransition(vOpt_S, vA2sg_ST, "sIn");
  addEmpty(vOpt_S, vA3sg_ST);
  addTransition(vOpt_S, vA1pl_ST, "lIm");
  addTransition(vOpt_S, vA2pl_ST, "sInIz");
  addTransition(vOpt_S, vA3pl_ST, "lAr");
  addTransition(vOpt_S, vPastAfterTense_S, "ydI");
  addTransition(vOpt_S, vNarrAfterTense_S, "ymIş");

  // Desire (-sA)
  addTransition(verbRoot_S, vDesr_S, "sA");
  addTransition(vDesr_S, vA1sg_ST, "m");
  addTransition(vDesr_S, vA2sg_ST, "n");
  addEmpty(vDesr_S, vA3sg_ST);
  addTransition(vDesr_S, vA1pl_ST, "k");
  addTransition(vDesr_S, vA2pl_ST, "nIz");
  addTransition(vDesr_S, vA3pl_ST, "lAr");
  addTransition(vDesr_S, vPastAfterTense_S, "ydI");
  addTransition(vDesr_S, vNarrAfterTense_S, "ymIş");

  // Necessity (-mAlI)
  addTransition(verbRoot_S, vNeces_S, "mAlI");
  addTransition(vNeces_S, vA1sg_ST, "yIm");
  addTransition(vNeces_S, vA2sg_ST, "sIn");
  addEmpty(vNeces_S, vA3sg_ST);
  addTransition(vNeces_S, vA1pl_ST, "yIz");
  addTransition(vNeces_S, vA2pl_ST, "sInIz");
  addTransition(vNeces_S, vA3pl_ST, "lAr");
  addTransition(vNeces_S, vPastAfterTense_S, "ydI");
  addTransition(vNeces_S, vCond_S, "ysA");
  addTransition(vNeces_S, vNarrAfterTense_S, "ymIş");
  addTransition(vNeces_S, vCopBeforeA3pl_S, "dIr");
  addTransition(vNeces_S, vWhile_S, "yken");

  // A3pl before compound tense ("yapar-lar-dı"), Copula, and Past+Person+Cond ("geldinse")
  const prevNotPastNarrCond = not(prevStateIn([vPastAfterTense_S, vNarrAfterTense_S, vCond_S]));
  addTransition(vA3pl_ST, vPastAfterTense_ST, "dI", prevNotPastNarrCond);
  addTransition(vA3pl_ST, vNarrAfterTense_ST, "mIş", prevNotPastNarrCond);
  addTransition(vA3pl_ST, vCond_ST, "sA", prevNotPastNarrCond);

  const copWhileTenses = prevMorphemeIn([M.prog1, M.prog2, M.neces, M.fut, M.narr, M.aor]);
  addTransition(vA3pl_ST, vCop_ST, "dIr", copWhileTenses);
  addTransition(vA3pl_ST, vWhile_S, "ken", copWhileTenses);
  addTransition(vA1sg_ST, vCop_ST, "dIr", copWhileTenses);
  addTransition(vA2sg_ST, vCop_ST, "dIr", copWhileTenses);
  addTransition(vA3sg_ST, vCop_ST, ">dIr", copWhileTenses);
  addTransition(vA1pl_ST, vCop_ST, "dIr", copWhileTenses);
  addTransition(vA2pl_ST, vCop_ST, "dIr", copWhileTenses);
  addTransition(vCopBeforeA3pl_S, vA3pl_ST, "lAr");

  const prevPastNoCond = and(prevMorphemeIs(M.past), not(containsMorpheme(M.cond, M.desr)));
  addTransition(vA1sg_ST, vCondAfterPerson_ST, "sA", prevPastNoCond);
  addTransition(vA2sg_ST, vCondAfterPerson_ST, "sA", prevPastNoCond);
  addTransition(vA1pl_ST, vCondAfterPerson_ST, "sA", prevPastNoCond);
  addTransition(vA2pl_ST, vCondAfterPerson_ST, "sA", prevPastNoCond);

  // Compound auxiliary verb derivations
  addTransition(verbRoot_S, vEverSince_S, "+yAgel", cMultiVerb);
  addTransition(verbRoot_S, vRepeat_S, "+yAdur", cMultiVerb);
  addTransition(verbRoot_S, vRepeat_S, "+yAgör", cMultiVerb);
  addTransition(verbRoot_S, vAlmost_S, "+yAyaz", cMultiVerb);
  addTransition(verbRoot_S, vHastily_S, "+yIver", cMultiVerb);
  addTransition(verbRoot_S, vStay_S, "+yAkal", cMultiVerb);
  addTransition(verbRoot_S, vStart_S, "+yAkoy", cMultiVerb);

  for (const s of [vEverSince_S, vRepeat_S, vAlmost_S, vHastily_S, vStay_S, vStart_S]) {
    addEmpty(s, verbRoot_S);
  }

  // Adverbial verb derivations (converbs / zarf-fiiller)
  addTransition(vA3sg_ST, vAsIf_S, ">cAsInA", prevMorphemeIn([M.aor, M.narr]));
  addTransition(verbRoot_S, vWhen_S, "+yIncA");
  addTransition(verbRoot_S, vSinceDoingSo_S, "+yAlI");
  addTransition(verbRoot_S, vByDoingSo_S, "+yArAk");
  addTransition(verbRoot_S, vAdamantly_S, "+yAsIyA");
  addTransition(verbRoot_S, vAfterDoing_S, "+yIp");
  addTransition(verbRoot_S, vWithoutBeingAbleToHaveDoneSo_S, "+yAmAdAn");
  addTransition(verbRoot_S, vAsLongAs_S, ">dIkçA");
  addTransition(verbRoot_S, vWithoutHavingDoneSo_S, "mAdAn");
  addTransition(verbRoot_S, vWithoutHavingDoneSo_S, "mAksIzIn");

  for (const s of [
    vAsIf_S,
    vSinceDoingSo_S,
    vByDoingSo_S,
    vAdamantly_S,
    vAfterDoing_S,
    vWithoutBeingAbleToHaveDoneSo_S,
    vAsLongAs_S,
    vWithoutHavingDoneSo_S,
    vWhile_S,
  ]) {
    addEmpty(s, advRoot_ST);
  }
  addEmpty(vWhen_S, advNounRoot_ST);

  // Post-processing: LastVowelDrop verbs like kavurmak -> kavr-ul (and block kavur-ul)
  addTransition(verbLastVowelDropModRoot_S, vPass_S, "Il");
  copyOutgoing(verbLastVowelDropUnmodRoot_S, verbRoot_S);
  removeTransitionsToMorpheme(verbLastVowelDropUnmodRoot_S, M.pass);

  // =========================================================================
  // 8. Standalone Question (mı/mi/mu/mü) & imek (idi/imiş/ise)
  // =========================================================================

  addEmpty(questionRoot_S, qPresent_S);
  addTransition(questionRoot_S, qPast_S, "ydI");
  addTransition(questionRoot_S, qNarr_S, "ymIş");

  addTransition(qPresent_S, qA1sg_ST, "yIm");
  addTransition(qPresent_S, qA2sg_ST, "sIn");
  addEmpty(qPresent_S, qA3sg_ST);
  addTransition(qPresent_S, qA1pl_ST, "+yIz");
  addTransition(qPresent_S, qA2pl_ST, "sInIz");

  addTransition(qPast_S, qA1sg_ST, "m");
  addTransition(qPast_S, qA2sg_ST, "n");
  addTransition(qPast_S, qA1pl_ST, "k");
  addTransition(qPast_S, qA2pl_ST, "InIz");
  addTransition(qPast_S, qA3pl_ST, "lAr");
  addEmpty(qPast_S, qA3sg_ST);

  addTransition(qNarr_S, qA1sg_ST, "Im");
  addTransition(qNarr_S, qA2sg_ST, "sIn");
  addTransition(qNarr_S, qA1pl_ST, "Iz");
  addTransition(qNarr_S, qA2pl_ST, "sInIz");
  addTransition(qNarr_S, qA3pl_ST, "lAr");
  addEmpty(qNarr_S, qA3sg_ST);

  const qRejectNoCopula = not(currentGroupContains(qPast_S));
  addTransition(qA1sg_ST, qCop_ST, "dIr", qRejectNoCopula);
  addTransition(qA2sg_ST, qCop_ST, "dIr", qRejectNoCopula);
  addTransition(qA3sg_ST, qCop_ST, ">dIr", qRejectNoCopula);
  addTransition(qA1pl_ST, qCop_ST, "dIr", qRejectNoCopula);
  addTransition(qA2pl_ST, qCop_ST, "dIr", qRejectNoCopula);
  addTransition(qPresent_S, qCopBeforeA3pl_S, ">dIr");
  addTransition(qCopBeforeA3pl_S, qA3pl_ST, "lAr");

  // Verb imek
  addTransition(imekRoot_S, imekPast_S, "di");
  addTransition(imekRoot_S, imekNarr_S, "miş");
  addTransition(imekRoot_S, imekCond_S, "se");

  addTransition(imekPast_S, imekA1sg_ST, "m");
  addTransition(imekPast_S, imekA2sg_ST, "n");
  addEmpty(imekPast_S, imekA3sg_ST);
  addTransition(imekPast_S, imekA1pl_ST, "k");
  addTransition(imekPast_S, imekA2pl_ST, "niz");
  addTransition(imekPast_S, imekA3pl_ST, "ler");
  addTransition(imekPast_S, imekCond_S, "yse");

  addTransition(imekNarr_S, imekA1sg_ST, "im");
  addTransition(imekNarr_S, imekA2sg_ST, "sin");
  addEmpty(imekNarr_S, imekA3sg_ST);
  addTransition(imekNarr_S, imekA1pl_ST, "iz");
  addTransition(imekNarr_S, imekA2pl_ST, "siniz");
  addTransition(imekNarr_S, imekA3pl_ST, "ler");
  addTransition(imekNarr_S, imekCond_S, "se");

  addTransition(imekCond_S, imekA1sg_ST, "m");
  addTransition(imekCond_S, imekA2sg_ST, "n");
  addEmpty(imekCond_S, imekA3sg_ST);
  addTransition(imekCond_S, imekA1pl_ST, "k");
  addTransition(imekCond_S, imekA2pl_ST, "niz");
  addTransition(imekCond_S, imekA3pl_ST, "ler");

  const imekRejectNoCopula = not(currentGroupContains(imekPast_S));
  addTransition(imekA1sg_ST, imekCop_ST, "dir", imekRejectNoCopula);
  addTransition(imekA2sg_ST, imekCop_ST, "dir", imekRejectNoCopula);
  addTransition(imekA3sg_ST, imekCop_ST, "tir", imekRejectNoCopula);
  addTransition(imekA1pl_ST, imekCop_ST, "dir", imekRejectNoCopula);
  addTransition(imekA2pl_ST, imekCop_ST, "dir", imekRejectNoCopula);
  addTransition(imekA3pl_ST, imekCop_ST, "dir", imekRejectNoCopula);

  // =========================================================================
  // Root state routing
  // =========================================================================

  const specialRootStates = new Map<string, MorphemeState>([
    ["değil_Verb", nVerbDegil_S],
    ["imek_Verb", imekRoot_S],
    ["su_Noun", nounSuRoot_S],
    ["akarsu_Noun", nounSuRoot_S],
    ["öyle_Adv", advForVerbDeriv_ST],
    ["böyle_Adv", advForVerbDeriv_ST],
    ["şöyle_Adv", advForVerbDeriv_ST],
  ]);

  function getRootState(item: DictionaryItem, phonetic: number): MorphemeState {
    const special = specialRootStates.get(item.key);
    if (special !== undefined) return special;

    if ((phonetic & PA_LAST_LETTER_DROPPED) !== 0) {
      return verbRoot_VowelDrop_S;
    }
    if ((item.attributes & RA_RECIPROCAL) !== 0) {
      return vImplicitRecipRoot_S;
    }
    if ((item.attributes & RA_REFLEXIVE) !== 0) {
      return vImplicitReflexRoot_S;
    }

    switch (item.primaryPos) {
      case "Noun":
        if ((item.attributes & RA_NO_SUFFIX) !== 0) return nounNoSuffix_S;
        if (item.secondaryPos === "ProperNoun") return nounProper_S;
        if (item.secondaryPos === "Abbreviation") return nounAbbrv_S;
        if ((item.attributes & RA_COMPOUND_P3SG_ROOT) !== 0) return nounCompoundRoot_S;
        return noun_S;
      case "Adj":
        return (item.attributes & RA_NO_SUFFIX) !== 0 ? adjNoSuffix_ST : adjectiveRoot_ST;
      case "Pron":
        switch (item.secondaryPos) {
          case "PersonalPron":
            return pronPers_S;
          case "DemonstrativePron":
            return pronDemons_S;
          case "QuestionPron":
            return pronQues_S;
          case "ReflexivePron":
            return pronReflex_S;
          default:
            return pronQuant_S;
        }
      case "Adv":
        return advRoot_ST;
      case "Conj":
        return conjRoot_ST;
      case "Ques":
        return questionRoot_S;
      case "Interj":
        return interjRoot_ST;
      case "Verb":
        return verbRoot_S;
      case "Det":
        return detRoot_ST;
      case "Postp":
        return postpRoot_ST;
      case "Num":
        return numeralRoot_ST;
      case "Dup":
        return dupRoot_ST;
      default:
        return noun_S;
    }
  }

  cachedGraph = {
    noun_S,
    nounCompoundRoot_S,
    nounSuRoot_S,
    nounProper_S,
    nounAbbrv_S,
    nounNoSuffix_S,
    adjectiveRoot_ST,
    adjNoSuffix_ST,
    numeralRoot_ST,
    nVerbDegil_S,
    pronPers_S,
    pronPers_Mod_S,
    pronDemons_S,
    pronQuant_S,
    pronQuantModified_S,
    pronQues_S,
    pronReflex_S,
    advRoot_ST,
    advForVerbDeriv_ST,
    conjRoot_ST,
    interjRoot_ST,
    detRoot_ST,
    dupRoot_ST,
    postpRoot_ST,
    verbRoot_S,
    verbRoot_VowelDrop_S,
    verbLastVowelDropModRoot_S,
    verbLastVowelDropUnmodRoot_S,
    vImplicitRecipRoot_S,
    vImplicitReflexRoot_S,
    vDeYeRoot_S,
    questionRoot_S,
    imekRoot_S,
    getRootState,
  };

  return cachedGraph;
}
