/** Loads the lexicon, listed misspellings and morphology the way the bench tools and tests use them. */
import { readFileSync } from "node:fs";
import { Corrector } from "../src/corrector.ts";
import { KnownMisspellings } from "../src/known.ts";
import { Lexicon } from "../src/lexicon.ts";
import { TurkishMorphology } from "../src/morphology/index.ts";

export const MORPHOLOGY_FILES = ["master-dictionary.dict", "non-tdk.dict", "informal.dict", "proper.dict"];

export function loadMorphology(): TurkishMorphology {
  return TurkishMorphology.fromDictionaries(MORPHOLOGY_FILES.map((name) => readFileSync(`data/morph/${name}`, "utf8")));
}

/** --lexicon wiki selects the Wikipedia-only lexicon; --no-morphology leaves the morphology layer out. */
export function createCorrector(args: readonly string[] = process.argv, minCount = 1, minPair = 5): Corrector {
  const wiki = args.includes("--lexicon") && args[args.indexOf("--lexicon") + 1] === "wiki";
  const lexicon = Lexicon.fromTsv(
    readFileSync(wiki ? "data/work/unigrams.tsv" : "data/work/unigrams_conv.tsv", "utf8"),
    readFileSync("data/work/bigrams.tsv", "utf8"),
    minCount,
    minPair,
  );
  const known = args.includes("--no-known") ? undefined : KnownMisspellings.fromTsv(readFileSync("data/rules/known.tsv", "utf8"));
  const morphology = args.includes("--no-morphology") ? undefined : loadMorphology();
  return new Corrector(lexicon, undefined, known, morphology);
}
