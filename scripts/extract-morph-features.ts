/**
 * Reads lowercased Turkish word forms (one per line) from stdin and prints
 * `<word>\t<bitmask>` (8-bit morphology feature mask matching `src/context.ts`)
 * for every word accepted by `TurkishMorphology.analyze()`.
 *
 * Bit layout (must stay identical to `morphFeatureBits` in `src/context.ts`):
 *   bit 0 (1):   morph_valid (analyses.length > 0)
 *   bit 1 (2):   pos_verb
 *   bit 2 (4):   pos_noun
 *   bit 3 (8):   pos_adj_adv
 *   bit 4 (16):  pos_pron_func (Pron/Conj/Postp/Det)
 *   bit 5 (32):  has_loc_abl (Loc/Abl)
 *   bit 6 (64):  has_poss (P1sg/P2sg/P3sg/P1pl/P2pl/P3pl)
 *   bit 7 (128): has_finite (Prog1/Prog2/Past/Narr/Fut/Aor/Opt/Desr/Neces/Imp)
 */
import { readFileSync } from "node:fs";
import { loadMorphology } from "../bench/setup.ts";

const POSS = new Set(["P1sg", "P2sg", "P3sg", "P1pl", "P2pl", "P3pl"]);
const FINITE = new Set(["Prog1", "Prog2", "Past", "Narr", "Fut", "Aor", "Opt", "Desr", "Neces", "Imp"]);
const FUNC_POS = new Set(["Pron", "Conj", "Postp", "Det"]);

const morphology = loadMorphology();
const input = readFileSync(0, "utf8");
const out: string[] = [];

for (const line of input.split("\n")) {
  const word = line.trim();
  if (!word) continue;
  const analyses = morphology.analyze(word);
  if (analyses.length === 0) continue;
  let bits = 1;
  for (const a of analyses) {
    if (a.pos === "Verb") bits |= 2;
    else if (a.pos === "Noun") bits |= 4;
    else if (a.pos === "Adj" || a.pos === "Adv") bits |= 8;
    else if (FUNC_POS.has(a.pos)) bits |= 16;
    for (const m of a.morphemes) {
      if (m === "Loc" || m === "Abl") bits |= 32;
      else if (POSS.has(m)) bits |= 64;
      else if (FINITE.has(m)) bits |= 128;
    }
  }
  out.push(`${word}\t${bits}`);
}

if (out.length > 0) {
  process.stdout.write(out.join("\n") + "\n");
}
