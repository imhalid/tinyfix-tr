/**
 * Fast forward FST search engine for Turkish morphological validation and analysis.
 * Adapted from Zemberek's RuleBasedAnalyzer.java (Apache 2.0), redesigned around:
 * - Zero-substring offset tracking (`pos`) into the normalized input string.
 * - Immutable singly-linked PathNodes (no per-step array copying).
 * - 64-entry per-transition phonetic surface/attribute caches.
 * - Longest-stem-first DFS with immediate short-circuit for `isWord()`.
 */

import { lowerTr } from "../turkish.ts";
import {
  PA_CANNOT_TERMINATE,
  computeNextPhoneticAttrs,
  generateSurface,
  hasCircumflex,
  normalizeCircumflex,
  surfaceCacheKey,
} from "./phonetics.ts";
import { MORPHEMES } from "./morphotactics.ts";
import type { StemIndex } from "./dictionary.ts";
import {
  RA_DUMMY,
  type DictionaryItem,
  type MorphAnalysis,
  type PathNode,
  type StemTransition,
  type SuffixTransition,
} from "./types.ts";

const MAX_REPEATING_STATE_COUNT = 3;
const MAX_SEARCH_DEPTH = 40;
const MAX_CACHE_ENTRIES = 65_536;

function exceedsStateRepeatLimit(node: PathNode, nextStateId: string): boolean {
  let count = 0;
  let cur: PathNode | null = node;
  while (cur !== null) {
    if (cur.state.id === nextStateId) {
      count++;
      if (count >= MAX_REPEATING_STATE_COUNT) return true;
    }
    cur = cur.prev;
  }
  return false;
}

function resolveSurfaceAndNextPhonetic(
  transition: SuffixTransition,
  phonetic: number,
): { surface: string; nextPhonetic: number } | null {
  const key = surfaceCacheKey(phonetic);
  let surface = transition.surfaceCache[key];
  if (surface === undefined) {
    const generated = generateSurface(transition.tokens, phonetic);
    transition.surfaceCache[key] = generated;
    if (generated !== null) {
      transition.nextPhoneticCache[key] = computeNextPhoneticAttrs(generated, phonetic, transition.lastToken);
    }
    surface = generated;
  }
  if (surface === null) return null;
  return { surface, nextPhonetic: transition.nextPhoneticCache[key] ?? 0 };
}

function matchesCircumflex(stemTransition: StemTransition, inputWithCircumflex: string): boolean {
  const stemLen = stemTransition.surface.length;
  let lemmaStem: string | null = null;

  for (let i = 0; i < inputWithCircumflex.length; i++) {
    const ch = inputWithCircumflex[i] ?? "";
    if (ch !== "â" && ch !== "î" && ch !== "û") continue;
    // Suffixes never carry circumflexes.
    if (i >= stemLen) return false;
    if (lemmaStem === null) {
      let item: DictionaryItem = stemTransition.item;
      if ((item.attributes & RA_DUMMY) !== 0 && item.referenceItem !== null) {
        item = item.referenceItem;
      }
      lemmaStem = item.primaryPos === "Verb" && (item.lemma.endsWith("mak") || item.lemma.endsWith("mek"))
        ? item.lemma.slice(0, -3)
        : item.lemma;
    }
    if (i >= lemmaStem.length || lemmaStem[i] !== ch) {
      return false;
    }
  }
  return true;
}

function makeInitialNode(stem: StemTransition, inputLength: number): PathNode {
  return {
    prev: null,
    stemTransition: stem,
    state: stem.to,
    surface: stem.surface,
    pos: stem.surface.length,
    inputLength,
    phonetic: stem.phonetic,
    depth: 0,
    hasSurface: false,
    hasDerivation: false,
    currentGroupHasSurface: false,
    lastDerivation: null,
  };
}

function stepNode(
  prev: PathNode,
  transition: SuffixTransition,
  surface: string,
  nextPhonetic: number,
): PathNode {
  const isDeriv = transition.to.derivative;
  const hasSurf = surface.length > 0;
  return {
    prev,
    stemTransition: prev.stemTransition,
    state: transition.to,
    surface,
    pos: prev.pos + surface.length,
    inputLength: prev.inputLength,
    phonetic: nextPhonetic,
    depth: prev.depth + 1,
    hasSurface: prev.hasSurface || hasSurf,
    hasDerivation: prev.hasDerivation || isDeriv,
    currentGroupHasSurface: isDeriv ? false : prev.currentGroupHasSurface || hasSurf,
    lastDerivation: isDeriv ? transition.to : prev.lastDerivation,
  };
}

function pathToAnalysis(endNode: PathNode): MorphAnalysis {
  const chain: PathNode[] = [];
  let cur: PathNode | null = endNode;
  while (cur !== null) {
    chain.push(cur);
    cur = cur.prev;
  }

  let item = endNode.stemTransition.item;
  if ((item.attributes & RA_DUMMY) !== 0 && item.referenceItem !== null) {
    item = item.referenceItem;
  }

  const morphemes: string[] = [];
  // Skip index chain.length - 1 (the root state itself) and skip empty Pnon/Nom noise.
  for (let i = chain.length - 2; i >= 0; i--) {
    const node = chain[i];
    if (node === undefined) continue;
    const m = node.state.morpheme;
    if (m === MORPHEMES.nom || m === MORPHEMES.pnon) {
      continue;
    }
    morphemes.push(m.id);
  }

  return {
    stem: item.root,
    pos: item.primaryPos,
    morphemes,
  };
}

export class MorphologicalAnalyzer {
  private readonly stemIndex: StemIndex;
  private readonly wordCache: Map<string, boolean>;

  constructor(stemIndex: StemIndex) {
    this.stemIndex = stemIndex;
    this.wordCache = new Map<string, boolean>();
  }

  /** Exposes the underlying StemIndex for lazy fuzzy morphological search. */
  getStemIndex(): StemIndex {
    return this.stemIndex;
  }

  /**
   * Returns whether `form` is a valid Turkish word according to the loaded lexicon and morphotactics.
   * Uses a bounded cache for fast repeated lookups and longest-stem-first early-exit DFS when uncached.
   */
  isWord(form: string): boolean {
    if (form.length === 0) return false;
    const cachedRaw = this.wordCache.get(form);
    if (cachedRaw !== undefined) return cachedRaw;

    const lower = lowerTr(form);
    if (lower !== form) {
      const cachedLower = this.wordCache.get(lower);
      if (cachedLower !== undefined) {
        this.remember(form, cachedLower);
        return cachedLower;
      }
    }

    const valid = this.checkWordUncached(lower);
    this.remember(lower, valid);
    if (lower !== form) {
      this.remember(form, valid);
    }
    return valid;
  }

  /**
   * Returns all valid deduplicated morphological analyses for `form`.
   */
  analyze(form: string): MorphAnalysis[] {
    if (form.length === 0) return [];
    const lower = lowerTr(form);
    if (lower.length === 0) return [];

    const inputHasCircumflex = hasCircumflex(lower);
    const searchInput = inputHasCircumflex ? normalizeCircumflex(lower) : lower;
    const inputLen = searchInput.length;
    const maxLen = Math.min(inputLen, this.stemIndex.maxStemLength);

    const results: MorphAnalysis[] = [];
    const seenKeys = new Set<string>();
    const stack: PathNode[] = [];

    for (let len = 1; len <= maxLen; len++) {
      const entry = this.stemIndex.stems.get(searchInput.slice(0, len));
      if (entry === undefined) continue;
      if (Array.isArray(entry)) {
        for (let i = 0; i < entry.length; i++) {
          const st = entry[i];
          if (st !== undefined && (!inputHasCircumflex || matchesCircumflex(st, lower))) {
            stack.push(makeInitialNode(st, inputLen));
          }
        }
      } else if (!inputHasCircumflex || matchesCircumflex(entry, lower)) {
        stack.push(makeInitialNode(entry, inputLen));
      }
    }

    while (stack.length > 0) {
      const node = stack.pop();
      if (node === undefined) break;

      if (node.pos === inputLen && node.state.terminal && (node.phonetic & PA_CANNOT_TERMINATE) === 0) {
        const analysis = pathToAnalysis(node);
        const dedupKey = `${analysis.stem}|${analysis.pos}|${analysis.morphemes.join("+")}`;
        if (!seenKeys.has(dedupKey)) {
          seenKeys.add(dedupKey);
          results.push(analysis);
        }
      }

      if (node.depth >= MAX_SEARCH_DEPTH) continue;
      this.expandNode(node, searchInput, inputLen, stack);
    }

    return results;
  }

  private remember(key: string, value: boolean): void {
    if (this.wordCache.size >= MAX_CACHE_ENTRIES) {
      this.wordCache.clear();
    }
    this.wordCache.set(key, value);
  }

  private checkWordUncached(lower: string): boolean {
    if (lower.length === 0) return false;
    const inputHasCircumflex = hasCircumflex(lower);
    const searchInput = inputHasCircumflex ? normalizeCircumflex(lower) : lower;
    const inputLen = searchInput.length;
    const maxLen = Math.min(inputLen, this.stemIndex.maxStemLength);

    const stack: PathNode[] = [];

    // Try longest stem prefixes first so uninflected / lightly-inflected words match immediately.
    for (let len = maxLen; len >= 1; len--) {
      const entry = this.stemIndex.stems.get(searchInput.slice(0, len));
      if (entry === undefined) continue;

      if (Array.isArray(entry)) {
        for (let i = 0; i < entry.length; i++) {
          const st = entry[i];
          if (st !== undefined && (!inputHasCircumflex || matchesCircumflex(st, lower))) {
            stack.push(makeInitialNode(st, inputLen));
          }
        }
      } else if (!inputHasCircumflex || matchesCircumflex(entry, lower)) {
        stack.push(makeInitialNode(entry, inputLen));
      }

      if (stack.length > 0 && this.dfsAccepts(stack, searchInput, inputLen)) {
        return true;
      }
    }

    return false;
  }

  private dfsAccepts(stack: PathNode[], searchInput: string, inputLen: number): boolean {
    while (stack.length > 0) {
      const node = stack.pop();
      if (node === undefined) break;

      if (node.pos === inputLen && node.state.terminal && (node.phonetic & PA_CANNOT_TERMINATE) === 0) {
        return true;
      }

      if (node.depth >= MAX_SEARCH_DEPTH) continue;
      this.expandNode(node, searchInput, inputLen, stack);
    }
    return false;
  }

  private expandNode(node: PathNode, searchInput: string, inputLen: number, stack: PathNode[]): void {
    const outgoing = node.state.outgoing;
    const remaining = inputLen - node.pos;
    const phonetic = node.phonetic;

    for (let i = 0; i < outgoing.length; i++) {
      const tr = outgoing[i];
      if (tr === undefined) continue;

      // Fast-path empty (epsilon) transitions.
      if (!tr.hasSurface) {
        if (tr.condition !== null && !tr.condition(node)) continue;
        if (node.depth > 8 && exceedsStateRepeatLimit(node, tr.to.id)) continue;
        stack.push(stepNode(node, tr, "", phonetic));
        continue;
      }

      if (remaining === 0) continue;

      // Fast bitmask check for vowel/consonant expectation before surface lookup.
      if ((phonetic & tr.forbiddenPhonetic) !== 0) continue;

      const resolved = resolveSurfaceAndNextPhonetic(tr, phonetic);
      if (resolved === null) continue;

      const { surface, nextPhonetic } = resolved;
      const surfLen = surface.length;
      if (surfLen > remaining) continue;
      if (surfLen > 0) {
        // Check first character before startsWith to reject mismatches in O(1).
        if (searchInput.charCodeAt(node.pos) !== surface.charCodeAt(0)) continue;
        if (surfLen > 1 && !searchInput.startsWith(surface, node.pos)) continue;
      }

      if (tr.condition !== null && !tr.condition(node)) continue;
      if (node.depth > 8 && exceedsStateRepeatLimit(node, tr.to.id)) continue;

      stack.push(stepNode(node, tr, surface, nextPhonetic));
    }
  }
}
